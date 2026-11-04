/**
 * bestRound 评审门禁 + 非法约束拒绝（Task A §11 / §13.4）：
 *  - 开启评审时，reviewer block 不得把本轮升为 bestRound（只进 observedBest 观察候选）；
 *  - reviewer pass 才把本轮升为 bestRound；
 *  - 非法 metricThreshold/op、硬约束字段在 createLoopRun 被拒绝并报出字段名（不静默丢弃）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

process.env.MINI_HARNESS_RUNTIME_ROOT = mkdtempSync(join(tmpdir(), "loop-bestround-"));
const ROOT = process.env.MINI_HARNESS_RUNTIME_ROOT;
const { setLoopExecForTest } = await import("../../server/loop/extension.js");

function makeHarness(reviewVerdict: "pass" | "block") {
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
		complete: async (model: { id: string }) => {
			if (model.id === "gpt-planner") return text("1. 写文件 2. 验证");
			return text(JSON.stringify({ verdict: reviewVerdict, reasons: [reviewVerdict === "pass" ? "ok" : "证据不足"] }));
		},
	};
	const tools = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const pi: any = {
		registerTool: (t: any) => tools.set(t.name, t),
		on: (ev: string, fn: any) => {
			if (!handlers.has(ev)) handlers.set(ev, []);
			handlers.get(ev)!.push(fn);
		},
		exec: async () => ({ code: 0, stdout: "HARNESS_METRIC: loss_pct=14.2", stderr: "" }),
		sendUserMessage: () => {},
	};
	// validator/precheck 走同一个 mock exec，避免 extension 用真实 runCommand 丢指标。
	setLoopExecForTest(async () => ({ stdout: "HARNESS_METRIC: loss_pct=14.2", stderr: "", code: 0, killed: false }));
	return { pi, tools, handlers, registry };
}

describe("bestRound 评审门禁（Task A §11）", () => {
	it("reviewer block：本轮不进 bestRound，只进 observedBest，run 迭代不判 done", async () => {
		const { createLoopExtension, createLoopRun, loadLoopState } = await import("../../server/loop/extension.js");
		const cwd = mkdtempSync(join(tmpdir(), "loop-br-block-"));
		const { pi, tools, handlers, registry } = makeHarness("block");
		createLoopExtension()(pi);
		const sid = "sess-br-block-" + Date.now();
		const created = createLoopRun({
			sessionId: sid,
			cwd,
			goal: "降 loss_pct",
			primaryMetric: "loss_pct",
			metricDirection: "minimize",
			metricThreshold: 20,
			metricThresholdOp: "lt",
			validateCmd: "true",
			useReviewer: true,
			maxRounds: 2,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const ctx: any = { sessionManager: { getSessionId: () => sid }, cwd, modelRegistry: registry, model: { provider: "oneapi", id: "deepseek-main" } };
		await handlers.get("before_agent_start")![0]({}, ctx); // 解析主/规划/评审模型，否则 runReview 会 skip
		await tools.get("loop_done").execute("tc", { summary: "done" }, undefined, undefined, ctx);
		await handlers.get("agent_end")![0]({}, ctx);
		const st = loadLoopState(created.runId)!;
		expect(st.lastReview?.verdict).toBe("block");
		expect(st.bestRound).toBeUndefined(); // 被否决，不得作为最佳有效版本
		expect(st.observedBest?.round).toBe(1); // 但作为观察候选记录
		expect(st.status).toBe("active");
		expect(st.acceptance).toBeNull();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("reviewer pass：本轮升为 bestRound 且判 done", async () => {
		const { createLoopExtension, createLoopRun, loadLoopState } = await import("../../server/loop/extension.js");
		const cwd = mkdtempSync(join(tmpdir(), "loop-br-pass-"));
		const { pi, tools, handlers, registry } = makeHarness("pass");
		createLoopExtension()(pi);
		const sid = "sess-br-pass-" + Date.now();
		const created = createLoopRun({
			sessionId: sid,
			cwd,
			goal: "降 loss_pct",
			primaryMetric: "loss_pct",
			metricDirection: "minimize",
			metricThreshold: 20,
			metricThresholdOp: "lt",
			validateCmd: "true",
			useReviewer: true,
			maxRounds: 2,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const ctx: any = { sessionManager: { getSessionId: () => sid }, cwd, modelRegistry: registry, model: { provider: "oneapi", id: "deepseek-main" } };
		await handlers.get("before_agent_start")![0]({}, ctx);
		await tools.get("loop_done").execute("tc", { summary: "done" }, undefined, undefined, ctx);
		await handlers.get("agent_end")![0]({}, ctx);
		const st = loadLoopState(created.runId)!;
		expect(st.status).toBe("done");
		expect(st.acceptance).toBe("passed");
		expect(st.bestRound?.round).toBe(1);
		rmSync(cwd, { recursive: true, force: true });
	});
});

describe("非法验收约束拒绝（Task A §13.4）", () => {
	it("阈值/运算符不成对、非法运算符、非法硬约束 → createLoopRun 拒绝并报字段名", async () => {
		const { createLoopRun } = await import("../../server/loop/extension.js");
		const cwd = mkdtempSync(join(tmpdir(), "loop-invalid-"));
		const base = { sessionId: "sess-inv-" + Date.now(), cwd, goal: "g" };

		const r1 = createLoopRun({ ...base, metricThreshold: 20 } as any);
		expect(r1.ok).toBe(false);
		expect((r1 as any).error).toContain("成对");

		const r2 = createLoopRun({ ...base, metricThreshold: 20, metricThresholdOp: "bad" as any } as any);
		expect(r2.ok).toBe(false);
		expect((r2 as any).error).toContain("metricThresholdOp");

		const r3 = createLoopRun({ ...base, hardConstraints: [{ name: "acc", metric: "precision", op: "eq" as any, value: 0.99 }] } as any);
		expect(r3.ok).toBe(false);
		expect((r3 as any).error).toContain("hardConstraints[0].op");

		const r4 = createLoopRun({ ...base, hardConstraints: [{ name: "acc", metric: "precision", op: "gte", value: Number.NaN }] } as any);
		expect(r4.ok).toBe(false);
		expect((r4 as any).error).toContain("hardConstraints[0].value");

		rmSync(cwd, { recursive: true, force: true });
	});

	it("合法硬约束照常启动（不误伤）", async () => {
		const { createLoopRun } = await import("../../server/loop/extension.js");
		const cwd = mkdtempSync(join(tmpdir(), "loop-valid-"));
		const created = createLoopRun({
			sessionId: "sess-valid-" + Date.now(),
			cwd,
			goal: "g",
			metricThreshold: 20,
			metricThresholdOp: "lt",
			hardConstraints: [{ name: "acc", metric: "precision", op: "gte", value: 0.99 }],
		});
		expect(created.ok).toBe(true);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("清理临时运行目录", () => rmSync(ROOT, { recursive: true, force: true }));
});
