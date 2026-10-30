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
 *  - 执行异常可见（不吞错不伪装完成）；
 *  - D-12-1 完成态可信度：评审出错不算完成（review-error）、仅代码验证 / 模型自述的 acceptance、
 *    按代码验证收下、重试评审（epoch+1，旧代次回调丢弃）；
 *  - D-12-2 结构化启动：createLoopRun 落盘、before_agent_start 模型准备 / 家族冲突、
 *    loop_start 不重复建 run；运行列表（collectRuns）的新字段与旧 state.json 兼容。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// ROOT 在模块加载时读环境变量 —— 必须在 import 之前指到临时目录
const RUNS_ROOT = mkdtempSync(join(tmpdir(), "loop-ext-test-"));
process.env.MINI_HARNESS_RUNTIME_ROOT = RUNS_ROOT;
const ext = await import("../../server/loop/extension.js");
const {
	createLoopExtension,
	setLoopEventReporter,
	markLoopRequestPending,
	takePendingLoopRequest,
	createLoopRun,
	acceptRunValidatorOnly,
	reactivateForReview,
	stopRunExternal,
	listRuns,
	loadLoopState,
} = ext;
const CWD = "/tmp/loop-test-work";

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
	/** deferReview 时每次 reviewer 调用的 resolve（按调用顺序；resolveReview 恒指向最新一个）。 */
	reviewResolvers: Array<(v: string) => void>;
	/** planner 调用挂起（测「模型准备期间被停止不得复活」）。 */
	deferPlanner: boolean;
	resolvePlanner?: (v: string) => void;
	/** pi.exec 调用记录（断言 worktree 有没有被提交）。 */
	execCalls: Array<{ cmd: string; args: string[] }>;
	/** 模型调用记录（断言规划 / 评审提示词带上验收标准）。 */
	modelCalls: Array<{ id: string; text: string }>;
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
		reviewResolvers: [],
		deferPlanner: false,
		execCalls: [],
		modelCalls: [],
		...opts,
	};
	const models = [
		{ provider: "oneapi", id: "deepseek-main" },
		{ provider: "oneapi", id: "gpt-planner" },
		{ provider: "oneapi", id: "glm-reviewer" },
	];
	const text = (v: string) => ({ content: [{ type: "text", text: v }] });
	const registry = {
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		getAll: () => models,
		getAvailable: () => models,
		complete: async (model: { id: string }, context: any) => {
			h.modelCalls.push({ id: model.id, text: String(context?.messages?.[0]?.content?.[0]?.text ?? "") });
			if (model.id === "gpt-planner") {
				if (h.deferPlanner) return new Promise((res) => (h.resolvePlanner = (v: string) => res(text(v))));
				return text("1. 写文件 2. 验证");
			}
			if (h.deferReview)
				return new Promise((res) => {
					const r = (v: string) => res(text(v));
					h.reviewResolvers.push(r);
					h.resolveReview = r;
				});
			return text(h.review);
		},
	};
	h.pi = {
		registerTool: (t: any) => h.tools.set(t.name, t),
		on: (ev: string, fn: any) => {
			if (!h.handlers.has(ev)) h.handlers.set(ev, []);
			h.handlers.get(ev)!.push(fn);
		},
		exec: async (cmd: string, args: string[]) => {
			h.execCalls.push({ cmd, args });
			if (h.execThrows) throw new Error("exec boom");
			return { code: h.validator.code, stdout: h.validator.stdout ?? "", stderr: h.validator.stderr ?? "" };
		},
		sendUserMessage: (text: string, opts: any) => h.sent.push({ text, opts }),
	};
	const ctx = {
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry: registry,
		model: models[0],
		cwd: CWD,
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
/** 直接改落盘状态（模拟 worktree 运行等），扩展每次调用都重读磁盘。 */
function patchRun(runId: string, patch: Record<string, unknown>) {
	writeFileSync(join(RUNS_ROOT, runId, "state.json"), JSON.stringify({ ...loadRun(runId), ...patch }, null, 2));
}
function journalRecords(runId: string): any[] {
	const p = join(RUNS_ROOT, runId, "journal.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
}
function journalEvents(runId: string): string[] {
	return journalRecords(runId).map((r) => r.event);
}
async function waitFor(cond: () => boolean, ms = 2000) {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) throw new Error("waitFor timeout");
		await new Promise((r) => setTimeout(r, 5));
	}
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
		expect(st.acceptance).toBe("passed"); // 代码验证 + 模型评审都过
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
		expect(st.acceptance).toBe("self-declared");
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
		expect(st.acceptance).toBe("passed");
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

	it("代码 loop：validator 过、reviewer 出错 → stopped/review-error，不算完成、不提交 worktree（D-12-1）", async () => {
		const h = makeHarness(SID(), { review: "这不是 JSON" }); // reviewer 两次都输出非法 JSON → error
		const start = await h.tools
			.get("loop_start")!
			.execute("t", { goal: "g", validateCmd: "true" }, undefined, undefined, h.ctx);
		const runId = start.details.runId;
		patchRun(runId, { worktreeDir: "/tmp/loop-test-wt", worktreeBranch: `mini-harness/${runId}` }); // 模拟 worktree 运行
		await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
		await h.handlers.get("agent_end")![0](undefined, h.ctx);
		const st = loadRun(runId);
		expect(st).toMatchObject({ status: "stopped", stage: "review-error", stopReason: "reviewer-error", epoch: 1 });
		expect(st.acceptance).toBeNull();
		expect(st.lastVerdict).toBe("pass"); // validator 的结论保留
		expect(st.lastReview.verdict).toBe("error");
		expect(st.lastReview.reasons[0]).toContain("JSON");
		expect(st.worktreeCommitted).toBe(false);
		expect(h.execCalls.some((c) => c.cmd === "git" && c.args.includes("add"))).toBe(false);
		const events = journalEvents(runId);
		expect(events).toContain("reviewer-error");
		expect(events).not.toContain("validate-pass");
		expect(h.notices.some((n) => n.includes("模型评审出错"))).toBe(true);
	});

	it("代码 loop：reviewer 通过 → done/passed，并提交 worktree（worktreeCommitted=true）", async () => {
		const h = makeHarness(SID());
		const start = await h.tools
			.get("loop_start")!
			.execute("t", { goal: "g", validateCmd: "true" }, undefined, undefined, h.ctx);
		const runId = start.details.runId;
		patchRun(runId, { worktreeDir: "/tmp/loop-test-wt", worktreeBranch: `mini-harness/${runId}` });
		await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
		await h.handlers.get("agent_end")![0](undefined, h.ctx);
		const st = loadRun(runId);
		expect(st).toMatchObject({ status: "done", acceptance: "passed" });
		expect(st.lastReview.verdict).toBe("pass");
		expect(h.execCalls.some((c) => c.cmd === "git" && c.args.includes("add"))).toBe(true);
		// 完成后的提交只核代次（status 已是 done）：不能再被当成迟到回调丢掉
		expect(st.worktreeCommitted).toBe(true);
		const events = journalRecords(runId).map((r) => r.event);
		expect(events).toContain("worktree-commit");
		expect(events).not.toContain("late-callback-dropped");
	});

	it("按代码验证收下：worktree 照样提交到独立分支", async () => {
		const wt = mkdtempSync(join(tmpdir(), "loop-accept-wt-"));
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", wt, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "t");
		writeFileSync(join(wt, "a.txt"), "x");
		const h = makeHarness(SID(), { review: "这不是 JSON" });
		const start = await h.tools
			.get("loop_start")!
			.execute("t", { goal: "g", validateCmd: "true" }, undefined, undefined, h.ctx);
		const runId = start.details.runId;
		patchRun(runId, { worktreeDir: wt, worktreeBranch: `mini-harness/${runId}` });
		await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
		await h.handlers.get("agent_end")![0](undefined, h.ctx);
		expect(loadRun(runId)).toMatchObject({ stopReason: "reviewer-error", worktreeCommitted: false });
		expect(acceptRunValidatorOnly(runId)).toEqual({ ok: true });
		expect(loadRun(runId)).toMatchObject({
			status: "done",
			acceptance: "passed-validator-only",
			worktreeCommitted: true,
		});
		expect(git("log", "--format=%s")).toContain(`mini-harness run ${runId}`);
		rmSync(wt, { recursive: true, force: true });
	});

	it("代码 loop：没开评审（skip）→ done/passed-validator-only", async () => {
		const h = makeHarness(SID());
		const start = await h.tools
			.get("loop_start")!
			.execute("t", { goal: "g", validateCmd: "true", useReviewer: false }, undefined, undefined, h.ctx);
		const runId = start.details.runId;
		expect(loadRun(runId)).toMatchObject({ useReviewer: false, reviewerModel: null });
		await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
		await h.handlers.get("agent_end")![0](undefined, h.ctx);
		const st = loadRun(runId);
		expect(st).toMatchObject({ status: "done", lastVerdict: "pass", acceptance: "passed-validator-only" });
		expect(st.lastReview.verdict).toBe("skip");
		expect(h.modelCalls.some((c) => c.id === "glm-reviewer")).toBe(false);
		expect(h.notices.some((n) => n.includes("仅代码验证"))).toBe(true);
	});

	it("run-state 事件：每次状态落盘都上报（事件驱动替代轮询）", async () => {
		const events: any[] = [];
		setLoopEventReporter((e) => events.push(e));
		try {
			const h = makeHarness(SID());
			await h.tools.get("loop_start")!.execute("t", { goal: "g", validateCmd: "true" }, undefined, undefined, h.ctx);
			await h.tools.get("loop_plan")!.execute("t", { plan: "p" }, undefined, undefined, h.ctx);
			await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
			await h.handlers.get("agent_end")![0](undefined, h.ctx);
			const states = events.filter((e) => e.type === "run-state").map((e) => e.st.stage);
			expect(states.length).toBeGreaterThanOrEqual(4); // intake → run → validate → done
			expect(states[states.length - 1]).toBe("done");
		} finally {
			setLoopEventReporter(null);
		}
	});

	it("request-failed：模型没调 loop_start 的回合结束 → 明确失败事件（回归#1）", async () => {
		const sid = SID();
		const events: any[] = [];
		setLoopEventReporter((e) => events.push(e));
		try {
			const h = makeHarness(sid);
			markLoopRequestPending(sid, "task-42", "写 DONE");
			// 模型整个回合都没调 loop_start，直接 agent_end
			await h.handlers.get("agent_end")![0](undefined, h.ctx);
			const failed = events.find((e) => e.type === "request-failed");
			expect(failed).toBeTruthy();
			expect(failed.taskId).toBe("task-42");
			expect(failed.goal).toBe("写 DONE");
			expect(failed.reason).toContain("loop_start");
			// 挂起请求已被消费：再次 agent_end 不会重复上报
			await h.handlers.get("agent_end")![0](undefined, h.ctx);
			expect(events.filter((e) => e.type === "request-failed").length).toBe(1);
		} finally {
			setLoopEventReporter(null);
		}
	});

	it("loop_start 成功即消费挂起请求（不误报 request-failed）", async () => {
		const sid = SID();
		const events: any[] = [];
		setLoopEventReporter((e) => events.push(e));
		try {
			const h = makeHarness(sid);
			markLoopRequestPending(sid, "task-43", "g");
			await h.tools.get("loop_start")!.execute("t", { goal: "g", validateCmd: "true" }, undefined, undefined, h.ctx);
			await h.handlers.get("agent_end")![0](undefined, h.ctx);
			expect(events.filter((e) => e.type === "request-failed").length).toBe(0);
			expect(events.some((e) => e.type === "run-state")).toBe(true);
			expect(takePendingLoopRequest(sid)).toBeNull(); // 已被消费
		} finally {
			setLoopEventReporter(null);
		}
	});
});

describe("D-12：评审掉线的两条路 / 服务端结构化启动", () => {
	it("acceptRunValidatorOnly：只收 stopped + reviewer-error + 代码验证 pass 的 run → done/passed-validator-only", async () => {
		const h = makeHarness(SID(), { review: "这不是 JSON" });
		const start = await h.tools
			.get("loop_start")!
			.execute("t", { goal: "g", validateCmd: "true" }, undefined, undefined, h.ctx);
		const runId = start.details.runId;
		expect(acceptRunValidatorOnly(runId).ok).toBe(false); // 还在跑
		await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
		await h.handlers.get("agent_end")![0](undefined, h.ctx);
		expect(loadRun(runId).stopReason).toBe("reviewer-error");
		expect(acceptRunValidatorOnly(runId)).toEqual({ ok: true });
		const st = loadRun(runId);
		expect(st).toMatchObject({ status: "done", stage: "done", acceptance: "passed-validator-only" });
		expect(st.stopReason).toBeUndefined();
		expect(st.lastReview.verdict).toBe("error"); // 评审出错的证据保留
		expect(journalRecords(runId).find((r) => r.event === "accepted-validator-only")?.by).toBe("user");
		expect(acceptRunValidatorOnly(runId).ok).toBe(false); // 已完成，不能再收

		// 用户停止的 run 不能收
		const h2 = makeHarness(SID());
		const s2 = await h2.tools
			.get("loop_start")!
			.execute("t", { goal: "g", validateCmd: "true" }, undefined, undefined, h2.ctx);
		expect(stopRunExternal(s2.details.runId).ok).toBe(true);
		expect(acceptRunValidatorOnly(s2.details.runId).ok).toBe(false);

		// LLM 模式评审出错（没有代码验证，lastVerdict=error）不能收
		const h3 = makeHarness(SID(), { review: "这不是 JSON" });
		const s3 = await h3.tools.get("loop_start")!.execute("t", { goal: "g", mode: "llm" }, undefined, undefined, h3.ctx);
		await h3.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h3.ctx);
		await h3.handlers.get("agent_end")![0](undefined, h3.ctx);
		expect(loadRun(s3.details.runId)).toMatchObject({ status: "stopped", stopReason: "reviewer-error" });
		expect(acceptRunValidatorOnly(s3.details.runId).ok).toBe(false);
		expect(acceptRunValidatorOnly("19990101000000-zzzzzz").ok).toBe(false);
	});

	it("重试评审：reviewer-error 的 run 重新激活到 validate（epoch+1），旧代次的在途回调被丢弃", async () => {
		const h = makeHarness(SID(), { deferReview: true });
		const start = await h.tools
			.get("loop_start")!
			.execute("t", { goal: "g", validateCmd: "true", maxRounds: 3 }, undefined, undefined, h.ctx);
		const runId = start.details.runId;
		await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
		// 两路评审同时在途：模型手动 loop_validate（A）+ 回合结束 agent_end（B）
		const pA = h.tools.get("loop_validate")!.execute("t", {}, undefined, undefined, h.ctx);
		await waitFor(() => h.reviewResolvers.length === 1);
		const pB = h.handlers.get("agent_end")![0](undefined, h.ctx);
		await waitFor(() => h.reviewResolvers.length === 2);
		// B 先回来，两次都不是 JSON → 评审出错停下
		h.reviewResolvers[1]("不是 JSON");
		await waitFor(() => h.reviewResolvers.length === 3);
		h.reviewResolvers[2]("还不是 JSON");
		await pB;
		let st = loadRun(runId);
		expect(st).toMatchObject({ status: "stopped", stage: "review-error", stopReason: "reviewer-error" });
		const stoppedEpoch = st.epoch;

		const r = reactivateForReview(runId);
		expect(r.ok).toBe(true);
		st = loadRun(runId);
		expect(st).toMatchObject({ status: "active", stage: "validate", validatedRound: 0, epoch: stoppedEpoch + 1 });
		expect(st.stopReason).toBeUndefined();
		expect(journalEvents(runId)).toContain("retry-review");
		expect(reactivateForReview(runId).ok).toBe(false); // 只有 reviewer-error 的 run 能重试

		// A（旧代次）迟到的「通过」不得把重新激活的 run 直接判完成
		h.reviewResolvers[0]('{"verdict":"pass","reasons":["late"]}');
		await pA;
		st = loadRun(runId);
		expect(st).toMatchObject({ status: "active", stage: "validate", acceptance: null });
		expect(journalEvents(runId)).toContain("late-callback-dropped");

		// 重新验收（模型没调 loop_validate 时回合结束的 agent_end 补跑）：这次评审通过
		h.deferReview = false;
		await h.handlers.get("agent_end")![0](undefined, h.ctx);
		expect(loadRun(runId)).toMatchObject({ status: "done", acceptance: "passed" });
	});

	it("createLoopRun：落盘 setupPending + sessionId 绑定；同会话第二个拒绝；空 goal / 空 sessionId 拒绝", () => {
		const sid = SID();
		const events: any[] = [];
		setLoopEventReporter((e) => events.push(e));
		try {
			const nonGit = mkdtempSync(join(tmpdir(), "loop-ext-nongit-"));
			const r1: any = createLoopRun({
				sessionId: sid,
				cwd: nonGit,
				goal: "  写 DONE  ",
				criteria: "DONE 文件存在",
				useReviewer: false,
				plannerModel: "gpt-planner",
				maxRounds: 99,
				worktree: true, // 不是 git 仓库：照旧在原工作区执行
			});
			expect(r1.ok).toBe(true);
			const st = loadRun(r1.runId);
			expect(st).toMatchObject({
				sessionId: sid,
				goal: "写 DONE",
				stage: "intake",
				status: "active",
				setupPending: true,
				useReviewer: false,
				criteria: "DONE 文件存在",
				plannerSpec: "gpt-planner",
				acceptance: null,
				maxRounds: 20,
				epoch: 0,
				mainModel: null,
				worktreeDir: null,
			});
			expect(st.workspace).toBe(st.baseWorkspace);
			expect(journalRecords(r1.runId)[0]).toMatchObject({ event: "start", source: "server" });
			expect(events.some((e) => e.type === "run-state" && e.st.runId === r1.runId)).toBe(true);

			const r2: any = createLoopRun({ sessionId: sid, cwd: CWD, goal: "另一个目标" });
			expect(r2.ok).toBe(false);
			expect(r2.error).toContain(r1.runId);
			expect(createLoopRun({ sessionId: SID(), cwd: CWD, goal: "   " }).ok).toBe(false);
			expect(createLoopRun({ sessionId: "", cwd: CWD, goal: "g" }).ok).toBe(false);
			expect(listRuns().filter((r) => r.sessionId === sid).length).toBe(1);
		} finally {
			setLoopEventReporter(null);
		}
	});

	it("before_agent_start：服务端建的 run 开跑前做模型准备 → 清 setupPending、stage=plan、plannerOutput 落盘", async () => {
		const sid = SID();
		const h = makeHarness(sid);
		const r: any = createLoopRun({
			sessionId: sid,
			cwd: CWD,
			goal: "g",
			criteria: "验收标准-XYZ",
			validateCmd: "true",
		});
		const res = await h.handlers.get("before_agent_start")![0]({}, h.ctx);
		const st = loadRun(r.runId);
		expect(st).toMatchObject({ setupPending: false, stage: "plan", status: "active" });
		expect(st.plannerOutput).toContain("写文件");
		expect(st.mainModel.id).toBe("deepseek-main");
		expect(st.plannerModel.id).toBe("gpt-planner");
		expect(st.reviewerModel.id).toBe("glm-reviewer");
		expect(res.message.content).toContain(r.runId);
		expect(res.message.content).toContain("验收标准-XYZ");
		expect(h.modelCalls.find((c) => c.id === "gpt-planner")?.text).toContain("验收标准-XYZ");
		// 之后的回合不再重复准备
		await h.handlers.get("before_agent_start")![0]({}, h.ctx);
		expect(h.modelCalls.filter((c) => c.id === "gpt-planner").length).toBe(1);
		// 走完一轮：评审提示词也带验收标准
		await h.tools.get("loop_plan")!.execute("t", { plan: "p" }, undefined, undefined, h.ctx);
		await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
		await h.handlers.get("agent_end")![0](undefined, h.ctx);
		expect(loadRun(r.runId)).toMatchObject({ status: "done", acceptance: "passed" });
		expect(h.modelCalls.find((c) => c.id === "glm-reviewer")?.text).toContain("验收标准-XYZ");
	});

	it("before_agent_start：家族冲突 → stopped/setup-error，注入「没启动起来」状态块", async () => {
		const sid = SID();
		const h = makeHarness(sid);
		const r: any = createLoopRun({ sessionId: sid, cwd: CWD, goal: "g", plannerModel: "oneapi/deepseek-main" });
		const res = await h.handlers.get("before_agent_start")![0]({}, h.ctx);
		const st = loadRun(r.runId);
		expect(st).toMatchObject({ status: "stopped", stopReason: "setup-error", setupPending: false, epoch: 1 });
		expect(st.setupError).toContain("家族冲突");
		expect(journalEvents(r.runId)).toContain("setup-error");
		expect(res.message.content).toContain("没有启动起来");
		expect(h.notices.some((n) => n.includes("没启动起来"))).toBe(true);
		expect(h.modelCalls.length).toBe(0); // 没调规划模型
	});

	it("before_agent_start：模型准备期间被停止 → 迟到的规划结果不得复活 run（epoch 守卫）", async () => {
		const sid = SID();
		const h = makeHarness(sid, { deferPlanner: true });
		const r: any = createLoopRun({ sessionId: sid, cwd: CWD, goal: "g" });
		const pending = h.handlers.get("before_agent_start")![0]({}, h.ctx);
		await waitFor(() => !!h.resolvePlanner);
		expect(stopRunExternal(r.runId).ok).toBe(true);
		h.resolvePlanner!("迟到的计划");
		const res = await pending;
		const st = loadRun(r.runId);
		expect(st).toMatchObject({ status: "stopped", stopReason: "user-stop", plannerOutput: "" });
		expect(journalEvents(r.runId)).toContain("late-callback-dropped");
		expect(res.message.content).toContain("没有启动起来");
	});

	it("loop_start：同会话已有活跃 run → 返回该 run，不重复创建", async () => {
		const sid = SID();
		const h = makeHarness(sid);
		const r: any = createLoopRun({ sessionId: sid, cwd: CWD, goal: "g", validateCmd: "true" });
		await h.handlers.get("before_agent_start")![0]({}, h.ctx);
		const res = await h.tools
			.get("loop_start")!
			.execute("t", { goal: "另一个目标", validateCmd: "true" }, undefined, undefined, h.ctx);
		expect(res.details).toMatchObject({ runId: r.runId, existing: true });
		expect(res.content[0].text).toContain("不要再调用 loop_start");
		expect(listRuns().filter((x) => x.sessionId === sid).length).toBe(1);
	});

	it("collectRunDetail：返回各轮评审报告与 validator 日志、journal 时间线、diff；不存在的 run 返回 null（D-12-3）", async () => {
		const { collectRunDetail } = await import("../../server/loop/routes.js");
		const h = makeHarness(SID());
		const start = await h.tools
			.get("loop_start")!
			.execute("t", { goal: "让测试通过", validateCmd: "true" }, undefined, undefined, h.ctx);
		const runId = start.details.runId;
		await h.tools.get("loop_done")!.execute("t", { summary: "改了 a.py" }, undefined, undefined, h.ctx);
		await h.handlers.get("agent_end")![0](undefined, h.ctx);
		const d = collectRunDetail(runId)!;
		expect(d).toMatchObject({ runId, goal: "让测试通过", mode: "code", status: "done", acceptance: "passed" });
		expect(d.summary).toBe("改了 a.py");
		expect(d.validator).toMatchObject({ cmd: "true", verdict: "pass" });
		expect(d.review).toMatchObject({ enabled: true, verdict: "pass" });
		expect(d.history.length).toBeGreaterThan(0);
		const r1 = d.rounds.find((r) => r.round === 1)!;
		expect(r1.review).toContain("# mini-harness 运行报告");
		expect(r1.logs.length).toBeGreaterThan(0);
		expect(d.journal.map((j) => j.event)).toEqual(expect.arrayContaining(["start", "done-claimed", "validate-pass"]));
		expect(collectRunDetail("19990101000000-zzzzzz")).toBeNull();
	});

	it("collectRuns：带上 mode/stopReason/acceptance/review/reviewerEnabled/createdAt；旧 state.json 照常读", async () => {
		const { collectRuns } = await import("../../server/loop/routes.js");
		// 评审否决到上限：7 条长理由 → 截成 5 条、每条 ≤300 字
		const reasons = Array.from({ length: 7 }, (_, i) => `理由${i}-` + "x".repeat(400));
		const h1 = makeHarness(SID(), { review: JSON.stringify({ verdict: "block", reasons }) });
		const s1 = await h1.tools
			.get("loop_start")!
			.execute("t", { goal: "g", validateCmd: "true", maxRounds: 1 }, undefined, undefined, h1.ctx);
		await h1.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h1.ctx);
		await h1.handlers.get("agent_end")![0](undefined, h1.ctx);
		// 没开评审、完成
		const h2 = makeHarness(SID());
		const s2 = await h2.tools
			.get("loop_start")!
			.execute("t", { goal: "g", validateCmd: "true", useReviewer: false }, undefined, undefined, h2.ctx);
		await h2.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h2.ctx);
		await h2.handlers.get("agent_end")![0](undefined, h2.ctx);
		// D-12 之前的旧 state.json：没有 acceptance / useReviewer
		const oldId = "20250101000000-abcdef";
		mkdirSync(join(RUNS_ROOT, oldId), { recursive: true });
		const oldState = {
			runId: oldId,
			goal: "旧任务",
			mode: "code",
			stage: "done",
			status: "done",
			round: 1,
			maxRounds: 3,
			lastVerdict: "pass",
			sessionId: "old-session",
			reviewerModel: { provider: "oneapi", id: "glm-reviewer", family: "zhipu" },
			createdAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T00:00:00.000Z",
		};
		writeFileSync(join(RUNS_ROOT, oldId, "state.json"), JSON.stringify(oldState));

		const runs = collectRuns(true);
		const b1 = runs.find((x) => x.runId === s1.details.runId)!;
		expect(b1).toMatchObject({ mode: "code", status: "stopped", stopReason: "reviewer-block", acceptance: null });
		expect(b1).toMatchObject({ reviewVerdict: "block", reviewerEnabled: true });
		expect(b1.reviewReasons).toHaveLength(5);
		expect(b1.reviewReasons.every((x) => x.length <= 300)).toBe(true);
		expect(typeof b1.createdAt).toBe("string");
		const b2 = runs.find((x) => x.runId === s2.details.runId)!;
		expect(b2).toMatchObject({ status: "done", acceptance: "passed-validator-only", stopReason: null });
		expect(b2).toMatchObject({ reviewVerdict: "skip", reviewReasons: [], reviewerEnabled: false });
		const old = runs.find((x) => x.runId === oldId)!;
		expect(old).toMatchObject({ acceptance: null, reviewerEnabled: true, reviewVerdict: null, reviewReasons: [] });
		expect(old.createdAt).toBe("2025-01-01T00:00:00.000Z");
		expect(loadLoopState(oldId)).toMatchObject({ acceptance: null, useReviewer: true });
	});
});
