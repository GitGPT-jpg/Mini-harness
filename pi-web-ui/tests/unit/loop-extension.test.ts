/**
 * mini-harness Loop 扩展单测（mock 会话/模型/validator，不花模型钱）。
 *
 * 覆盖产品验收清单里的关键行为：
 *  - 启动成功链 / 失败迭代 / 最大轮数；
 *  - 停止后迟到回调不得把 stopped 翻成 done（epoch 代际守卫，回归 #4）；
 *  - 同 cwd 双会话不串任务（显式 sessionId 绑定，回归 #3）；
 *  - LLM loop 关闭 reviewer → self-declared 完成（回归 #5）；
 *  - LLM loop reviewer 否决 → 迭代；
 *  - taskId 显式关联（回归 #6）；
 *  - 执行异常可见（不吞错不伪装完成）。
 */
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// ROOT 在模块加载时读环境变量 —— 必须在 import 之前指到临时目录
const RUNS_ROOT = mkdtempSync(join(tmpdir(), "loop-ext-test-"));
process.env.MINI_HARNESS_RUNTIME_ROOT = RUNS_ROOT;
const { createLoopExtension } = await import("../../server/loop/extension.js");

type ToolEntry = { name: string; execute: (id: string, p: any, s: any, u: any, ctx: any) => Promise<any> };

interface Harness {
	pi: any;
	tools: Map<string, ToolEntry>;
	handlers: Map<string, Array<(e: any, ctx: any) => Promise<any>>>;
	sent: Array<{ text: string; opts: any }>;
	notices: string[];
	validator: { code: number; stdout?: string; stderr?: string };
	review: string; // reviewer complete 的返回（JSON 文本）
	execThrows: boolean;
	deferReview: boolean;
	resolveReview?: (v: string) => void;
}

function makeHarness(sessionId: string, opts: Partial<Harness> = {}): Harness & { ctx: any } {
	const h: Harness = {
		pi: undefined as any,
		tools: new Map(),
		handlers: new Map(),
		sent: [],
		notices: [],
		validator: { code: 0, stdout: "ok", stderr: "" },
		review: '{"verdict":"pass","reasons":["ok"]}',
		execThrows: false,
		deferReview: false,
		...opts,
	};
	const models = [
		{ provider: "oneapi", id: "deepseek-main" },
		{ provider: "oneapi", id: "gpt-planner" },
		{ provider: "oneapi", id: "glm-reviewer" },
	];
	const registry = {
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		getAll: () => models,
		getAvailable: () => models,
		complete: async (model: { id: string }) => {
			if (model.id === "gpt-planner") return { content: [{ type: "text", text: "1. 写文件 2. 验证" }] };
			if (h.deferReview)
				return new Promise<{ content: Array<{ type: string; text: string }> }>(
					(res) => (h.resolveReview = (v) => res({ content: [{ type: "text", text: v }] })),
				);
			return { content: [{ type: "text", text: h.review }] };
		},
	};
	h.pi = {
		registerTool: (t: any) => h.tools.set(t.name, t),
		on: (ev: string, fn: any) => {
			if (!h.handlers.has(ev)) h.handlers.set(ev, []);
			h.handlers.get(ev)!.push(fn);
		},
		exec: async () => {
			if (h.execThrows) throw new Error("exec boom");
			return { code: h.validator.code, stdout: h.validator.stdout ?? "", stderr: h.validator.stderr ?? "" };
		},
		sendUserMessage: (text: string, opts: any) => h.sent.push({ text, opts }),
	};
	const ctx = {
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry: registry,
		model: models[0],
		cwd: "/tmp/loop-test-work",
		ui: { notify: (m: string) => h.notices.push(m) },
	};
	createLoopExtension()(h.pi);
	// 注意：必须返回原对象（闭包捕获的就是它）——展开拷贝会让测试里的
	// h.validator / h.review / h.resolveReview 赋值改到副本上，闭包看不到。
	(h as any).ctx = ctx;
	return h as any;
}

function loadRun(runId: string): any {
	return JSON.parse(readFileSync(join(RUNS_ROOT, runId, "state.json"), "utf8"));
}
function journalEvents(runId: string): string[] {
	const p = join(RUNS_ROOT, runId, "journal.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l).event);
}

const SID = () => `sess-${Math.random().toString(36).slice(2, 8)}`;

describe("mini-harness loop extension", () => {
	it("启动成功链：start→plan→done→agent_end = done/pass（代码 loop）", async () => {
		const h = makeHarness(SID());
		const start = await h.tools
			.get("loop_start")!
			.execute("t", { goal: "g", validateCmd: "true", maxRounds: 3 }, undefined, undefined, h.ctx);
		const runId = start.details.runId;
		expect(loadRun(runId).sessionId).toBe(h.ctx.sessionManager.getSessionId());
		await h.tools.get("loop_plan")!.execute("t", { plan: "p" }, undefined, undefined, h.ctx);
		await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
		await h.handlers.get("agent_end")![0](undefined, h.ctx);
		const st = loadRun(runId);
		expect(st.status).toBe("done");
		expect(st.lastVerdict).toBe("pass");
		expect(st.lastCode).toBe(0);
		expect(h.sent.length).toBe(0); // 一次通过，无 followUp
	});

	it("失败迭代：validator 失败 → 第 2 轮 followUp 带证据；再通过 → done", async () => {
		const h = makeHarness(SID(), { validator: { code: 1, stdout: "", stderr: "boom" } });
		const start = await h.tools
			.get("loop_start")!
			.execute("t", { goal: "g", validateCmd: "true", maxRounds: 3 }, undefined, undefined, h.ctx);
		const runId = start.details.runId;
		await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
		await h.handlers.get("agent_end")![0](undefined, h.ctx);
		let st = loadRun(runId);
		expect(st.status).toBe("active");
		expect(st.round).toBe(2);
		expect(st.lastVerdict).toBe("fail");
		expect(h.sent.length).toBe(1);
		expect(h.sent[0].text).toContain("boom");
		// 第 2 轮修好
		h.validator = { code: 0, stdout: "ok", stderr: "" };
		await h.tools.get("loop_done")!.execute("t", { summary: "s2" }, undefined, undefined, h.ctx);
		await h.handlers.get("agent_end")![0](undefined, h.ctx);
		st = loadRun(runId);
		expect(st.status).toBe("done");
		expect(st.lastVerdict).toBe("pass");
	});

	it("最大轮数：maxRounds=1 且失败 → stopped/validate-fail，不再调度", async () => {
		const h = makeHarness(SID(), { validator: { code: 1, stdout: "", stderr: "bad" } });
		const start = await h.tools
			.get("loop_start")!
			.execute("t", { goal: "g", validateCmd: "true", maxRounds: 1 }, undefined, undefined, h.ctx);
		const runId = start.details.runId;
		await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
		await h.handlers.get("agent_end")![0](undefined, h.ctx);
		const st = loadRun(runId);
		expect(st.status).toBe("stopped");
		expect(st.stopReason).toBe("validate-fail");
		expect(st.epoch).toBe(1);
	});

	it("停止后迟到回调不得把 stopped 翻成 done（epoch 守卫，回归#4）", async () => {
		const h = makeHarness(SID(), { deferReview: true });
		const start = await h.tools
			.get("loop_start")!
			.execute("t", { goal: "g", validateCmd: "true", maxRounds: 3 }, undefined, undefined, h.ctx);
		const runId = start.details.runId;
		await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
		// agent_end 进入 reviewer（complete 挂起），期间用户停止
		const pending = h.handlers.get("agent_end")![0](undefined, h.ctx);
		await new Promise((r) => setTimeout(r, 30));
		await h.tools.get("loop_stop")!.execute("t", { reason: "user" }, undefined, undefined, h.ctx);
		expect(loadRun(runId).status).toBe("stopped");
		// 迟到的 reviewer 通过结论到达 —— 不得翻转 stopped
		h.resolveReview!('{"verdict":"pass","reasons":["late"]}');
		await pending;
		const st = loadRun(runId);
		expect(st.status).toBe("stopped");
		expect(st.stopReason).toBe("user");
		expect(journalEvents(runId)).toContain("late-callback-dropped");
	});

	it("同 cwd 双会话不串任务（显式 sessionId 绑定，回归#3）", async () => {
		const sidA = SID();
		const sidB = SID();
		const hA = makeHarness(sidA);
		const hB = makeHarness(sidB); // 同 cwd /tmp/loop-test-work
		const start = await hA.tools
			.get("loop_start")!
			.execute("t", { goal: "g", validateCmd: "true" }, undefined, undefined, hA.ctx);
		const runId = start.details.runId;
		// B 会话在同 cwd 下不得接管：工具层直接拒绝
		const planB = await hB.tools.get("loop_plan")!.execute("t", { plan: "p" }, undefined, undefined, hB.ctx);
		expect(planB.content[0].text).toContain("没有活跃运行");
		// B 的 agent_end 也不得推进 A 的 run
		await hB.handlers.get("agent_end")![0](undefined, hB.ctx);
		const st = loadRun(runId);
		expect(st.status).toBe("active");
		expect(st.sessionId).toBe(sidA);
		expect(hB.sent.length).toBe(0);
	});

	it("LLM loop 关闭 reviewer → self-declared 完成（回归#5）", async () => {
		const h = makeHarness(SID());
		const start = await h.tools
			.get("loop_start")!
			.execute("t", { goal: "g", mode: "llm", useReviewer: false, maxRounds: 3 }, undefined, undefined, h.ctx);
		const runId = start.details.runId;
		expect(loadRun(runId).mode).toBe("llm");
		await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
		await h.handlers.get("agent_end")![0](undefined, h.ctx);
		const st = loadRun(runId);
		expect(st.status).toBe("done");
		expect(st.lastVerdict).toBe("self-declared");
		expect(journalEvents(runId)).toContain("llm-self-declared");
	});

	it("LLM loop reviewer 否决 → 迭代；通过 → done", async () => {
		const h = makeHarness(SID(), { review: '{"verdict":"block","reasons":["证据不足"]}' });
		const start = await h.tools
			.get("loop_start")!
			.execute("t", { goal: "g", mode: "llm", maxRounds: 3 }, undefined, undefined, h.ctx);
		const runId = start.details.runId;
		await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
		await h.handlers.get("agent_end")![0](undefined, h.ctx);
		let st = loadRun(runId);
		expect(st.status).toBe("active");
		expect(st.round).toBe(2);
		expect(h.sent[0].text).toContain("证据不足");
		h.review = '{"verdict":"pass","reasons":["ok"]}';
		await h.tools.get("loop_done")!.execute("t", { summary: "s2" }, undefined, undefined, h.ctx);
		await h.handlers.get("agent_end")![0](undefined, h.ctx);
		st = loadRun(runId);
		expect(st.status).toBe("done");
		expect(st.lastReview.verdict).toBe("pass");
	});

	it("taskId 显式记录（回归#6）", async () => {
		const h = makeHarness(SID());
		const start = await h.tools
			.get("loop_start")!
			.execute("t", { goal: "g", validateCmd: "true", taskId: "batch-42" }, undefined, undefined, h.ctx);
		expect(start.details.taskId).toBe("batch-42");
		expect(loadRun(start.details.runId).taskId).toBe("batch-42");
	});

	it("执行异常可见：推进 followUp 时抛错 → runtime-error 停止（不吞错不伪装完成）", async () => {
		// validator exec 抛错会被 runValidation 收敛成 code=-1（= 验证失败，正常迭代）；
		// 真正的 runtime-error 路径是推进/落盘等意外异常 —— 用 sendUserMessage 抛错触发。
		const h = makeHarness(SID(), { validator: { code: 1, stdout: "", stderr: "bad" } });
		(h.pi as any).sendUserMessage = () => {
			throw new Error("send boom");
		};
		const start = await h.tools
			.get("loop_start")!
			.execute("t", { goal: "g", validateCmd: "true" }, undefined, undefined, h.ctx);
		const runId = start.details.runId;
		await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
		await h.handlers.get("agent_end")![0](undefined, h.ctx);
		const st = loadRun(runId);
		expect(st.status).toBe("stopped");
		expect(st.stopReason).toBe("runtime-error");
		expect(journalEvents(runId)).toContain("runtime-error");
	});

	it("reviewer 故障 → 降级 validator-only 完成（不阻塞）", async () => {
		const h = makeHarness(SID(), { review: "这不是 JSON" }); // reviewer 两次都输出非法 JSON → error
		const start = await h.tools
			.get("loop_start")!
			.execute("t", { goal: "g", validateCmd: "true" }, undefined, undefined, h.ctx);
		const runId = start.details.runId;
		await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
		await h.handlers.get("agent_end")![0](undefined, h.ctx);
		const st = loadRun(runId);
		expect(st.status).toBe("done"); // validator 已通过即达成
		expect(journalEvents(runId)).toContain("reviewer-degraded");
	});
});
