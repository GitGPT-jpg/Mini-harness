/**
 * Task 2 / Task 3 端到端门禁测试（mock exec，快速）：
 *  - validator exit 0 但缺主指标 / 违反阈值 → 不判 done，以 metric-gate 停下（maxRounds 耗尽）。
 *  - 验收期间工作区发生变化 → 结果不可信，以 workspace-changed-during-validation 停下，
 *    不进 bestRound、不判完成。
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 必须在 import extension 之前指到临时目录（extension 模块级 ROOT 常量）。
process.env.MINI_HARNESS_RUNTIME_ROOT = mkdtempSync(join(tmpdir(), "loop-gate-runs-"));

function makePi(execImpl: (cmd: string, args: string[]) => any) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const pi: any = {
		registerTool: (t: any) => tools.set(t.name, t),
		on: (ev: string, fn: any) => {
			if (!handlers.has(ev)) handlers.set(ev, []);
			handlers.get(ev)!.push(fn);
		},
		exec: execImpl,
		sendUserMessage: () => {},
	};
	return { pi, tools, handlers };
}

/** validator/precheck 走同一个 mock exec，避免 extension 用真实 runCommand 离开测试工作区。 */
async function bindLoopExec(pi: any): Promise<void> {
	const { setLoopExecForTest } = await import("../../server/loop/extension.js");
	setLoopExecForTest(async (cmd: string, args: string[], opts?: { cwd?: string }) => {
		const r = await pi.exec(cmd, args, opts);
		return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? null, killed: false };
	});
}

describe("指标门禁端到端（Task 2）", () => {
	it("validator exit 0 但缺主指标 → 不判 done，bestRound 为空，以 metric-gate 停下", async () => {
		const { createLoopExtension, createLoopRun, loadLoopState } = await import("../../server/loop/extension.js");
		const cwd = mkdtempSync(join(tmpdir(), "loop-gate-missing-"));
		const { pi, tools, handlers } = makePi(async () => ({ code: 0, stdout: "HARNESS_METRIC: tps=100", stderr: "" }));
		createLoopExtension()(pi);
		await bindLoopExec(pi);
		const sid = "sess-missing-" + Date.now();
		const created = createLoopRun({
			sessionId: sid,
			cwd,
			goal: "把 loss_pct 降到 20 以下",
			primaryMetric: "loss_pct",
			metricDirection: "minimize",
			metricThreshold: 20,
			metricThresholdOp: "lt",
			validateCmd: "true",
			useReviewer: false,
			maxRounds: 1,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const ctx: any = { sessionManager: { getSessionId: () => sid }, cwd };
		await tools.get("loop_done").execute("tc", { summary: "done" }, undefined, undefined, ctx);
		await handlers.get("agent_end")![0]({}, ctx);
		const st = loadLoopState(created.runId)!;
		expect(st.status).toBe("stopped");
		expect(st.stopReason).toBe("metric-gate");
		expect(st.acceptance).toBeNull();
		expect(st.lastMetricGate?.ok).toBe(false);
		expect(st.lastMetricGate?.missingPrimary).toBe(true);
		expect(st.bestRound).toBeUndefined();
		expect(st.history[0].metricGateOk).toBe(false);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("validator exit 0 且报出主指标但违反阈值 → 同样 metric-gate，不判 done", async () => {
		const { createLoopExtension, createLoopRun, loadLoopState } = await import("../../server/loop/extension.js");
		const cwd = mkdtempSync(join(tmpdir(), "loop-gate-thresh-"));
		const { pi, tools, handlers } = makePi(async () => ({ code: 0, stdout: "HARNESS_METRIC: loss_pct=25", stderr: "" }));
		createLoopExtension()(pi);
		await bindLoopExec(pi);
		const sid = "sess-thresh-" + Date.now();
		const created = createLoopRun({
			sessionId: sid,
			cwd,
			goal: "把 loss_pct 降到 20 以下",
			primaryMetric: "loss_pct",
			metricDirection: "minimize",
			metricThreshold: 20,
			metricThresholdOp: "lt",
			validateCmd: "true",
			useReviewer: false,
			maxRounds: 1,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const ctx: any = { sessionManager: { getSessionId: () => sid }, cwd };
		await tools.get("loop_done").execute("tc", { summary: "done" }, undefined, undefined, ctx);
		await handlers.get("agent_end")![0]({}, ctx);
		const st = loadLoopState(created.runId)!;
		expect(st.status).toBe("stopped");
		expect(st.stopReason).toBe("metric-gate");
		expect(st.lastMetricGate?.ok).toBe(false);
		expect(st.lastMetricGate?.violations.length).toBe(1);
		rmSync(cwd, { recursive: true, force: true });
	});
});

describe("验收前后代码指纹（Task 3）", () => {
	it("验收期间工作区被并发改动 → 结果不可信，停下且不进 bestRound", async () => {
		const { createLoopExtension, createLoopRun, loadLoopState } = await import("../../server/loop/extension.js");
		const repo = mkdtempSync(join(tmpdir(), "loop-gate-fp-"));
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "t");
		writeFileSync(join(repo, "a.txt"), "v0");
		git("add", "-A");
		git("commit", "-qm", "baseline");

		// mock exec 在验收期间并发改动工作区（模拟另一个窗口 / 进程在改），然后才返回 pass。
		const { pi, tools, handlers } = makePi(async () => {
			writeFileSync(join(repo, "concurrent.txt"), "changed during validation");
			return { code: 0, stdout: "ok", stderr: "" };
		});
		createLoopExtension()(pi);
		await bindLoopExec(pi);
		const sid = "sess-fp-" + Date.now();
		const created = createLoopRun({
			sessionId: sid,
			cwd: repo,
			goal: "验证代码指纹绑定",
			validateCmd: "true",
			useReviewer: false,
			maxRounds: 1,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const ctx: any = { sessionManager: { getSessionId: () => sid }, cwd: repo };
		await tools.get("loop_done").execute("tc", { summary: "done" }, undefined, undefined, ctx);
		await handlers.get("agent_end")![0]({}, ctx);
		const st = loadLoopState(created.runId)!;
		expect(st.status).toBe("stopped");
		expect(st.stopReason).toBe("workspace-changed-during-validation");
		expect(st.history[0].workspaceChangedDuringValidation).toBe(true);
		expect(st.history[0].snapshotRef).toBeTruthy(); // 仍记录验收前 candidate-A 身份
		expect(st.bestRound).toBeUndefined(); // 不可信，不选为最优
		expect(st.acceptance).toBeNull();
		rmSync(repo, { recursive: true, force: true });
	});
});
