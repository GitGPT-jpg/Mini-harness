/**
 * D-12c 单元测试：
 * 1) 方向一：HARNESS_* 自主环境变量桥（syncHarnessEnv / readHarnessEnv）
 * 2) 方向二：HARNESS_METRIC 指标解析、bestRound 最优轮次追踪、L0 precheck 短路、经验卡片沉淀（distillLoopRun）
 */
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readHarnessEnv, syncHarnessEnv } from "../../server/harness-env.js";
import { parseHarnessMetrics, pickBetterRound } from "../../server/loop/metrics.js";

// extension.ts 在模块加载时读取 MINI_HARNESS_RUNTIME_ROOT 计算 ROOT（模块级 const）；
// distill.ts 静态依赖 extension.ts，因此必须在任何会（transitively）加载 extension 的 import 之前指到临时目录，
// 否则 createLoopRun 会写到真实的 ~/.mini-harness/runs（污染真实运行产物，在沙箱里还会 EPERM）。
process.env.MINI_HARNESS_RUNTIME_ROOT = mkdtempSync(join(tmpdir(), "loop-d12c-runs-"));

describe("HARNESS_* 自主环境变量桥（方向一）", () => {
	it("HARNESS_* 优先于 PI_WEB_*，未设置时兼容回退 PI_WEB_*", () => {
		const env: Record<string, string | undefined> = {
			HARNESS_PORT: "9898",
			PI_WEB_PORT: "8787",
			PI_WEB_CWD: "/legacy/work",
			HARNESS_TOKEN: "auto",
		};
		expect(readHarnessEnv("PORT", env)).toBe("9898");
		expect(readHarnessEnv("CWD", env)).toBe("/legacy/work");
		const synced = syncHarnessEnv(env);
		expect(synced).toEqual(["HARNESS_PORT", "HARNESS_TOKEN"]);
		expect(env.PI_WEB_PORT).toBe("9898");
		expect(env.PI_WEB_TOKEN).toBe("auto");
		expect(env.PI_WEB_CWD).toBe("/legacy/work");
	});
});

describe("HARNESS_METRIC 解析与 bestRound 追踪（方向二）", () => {
	it("解析 JSON 与 key=value 两种 HARNESS_METRIC 行，忽略非数值与无关输出", () => {
		const out = [
			"Running benchmark...",
			'HARNESS_METRIC: {"ttft_ms": 112.5, "tps": "88.4", "note": "ignored"}',
			"HARNESS_METRIC: loss_pct=14.2 cache_hit=0.96",
			"Done.",
		].join("\n");
		expect(parseHarnessMetrics(out)).toEqual({
			ttft_ms: 112.5,
			tps: 88.4,
			loss_pct: 14.2,
			cache_hit: 0.96,
		});
		expect(parseHarnessMetrics("no metric lines here")).toBeNull();
	});

	it("pickBetterRound：pass 永远优于 fail；同为 pass 时按吞吐/损耗选更优轮次", () => {
		const r1 = { round: 1, verdict: "fail", commitSha: "aaa111", metrics: { tps: 120 }, at: "t1" };
		const r2 = { round: 2, verdict: "pass", commitSha: "bbb222", metrics: { tps: 85 }, at: "t2" };
		const r3 = { round: 3, verdict: "pass", commitSha: "ccc333", metrics: { tps: 98 }, at: "t3" };
		const r4 = { round: 4, verdict: "pass", commitSha: "ddd444", metrics: { tps: 70 }, at: "t4" };

		let best = pickBetterRound(null, r1);
		expect(best?.round).toBe(1);
		best = pickBetterRound(best, r2);
		expect(best?.round).toBe(2);
		best = pickBetterRound(best, r3);
		expect(best?.round).toBe(3);
		best = pickBetterRound(best, r4);
		expect(best?.round).toBe(3); // 第 4 轮吞吐退化，保持第 3 轮为最优 Checkpoint
	});

	it("pickBetterRound：声明主指标 + minimize 时只认主指标，不误选吞吐更高的坏轮次", () => {
		// 目标是「降低 loss_pct」：即使某轮同时输出了更高的 tps，也只能按 loss_pct 选优。
		const target = { metric: "loss_pct", direction: "minimize" as const };
		const r1 = { round: 1, verdict: "pass", commitSha: "a", metrics: { loss_pct: 14.2, tps: 300 }, at: "t1" };
		const r2 = { round: 2, verdict: "pass", commitSha: "b", metrics: { loss_pct: 13.8, tps: 100 }, at: "t2" };
		const r3 = { round: 3, verdict: "pass", commitSha: "c", metrics: { loss_pct: 15.0, tps: 500 }, at: "t3" };

		let best = pickBetterRound(null, r1, target);
		expect(best?.round).toBe(1);
		best = pickBetterRound(best, r2, target);
		expect(best?.round).toBe(2); // loss 13.8 < 14.2
		best = pickBetterRound(best, r3, target);
		expect(best?.round).toBe(2); // loss 15.0 > 13.8，即便 tps 更高也不选
	});
});

describe("L0 precheck 短路与经验卡片沉淀（方向二）", () => {
	it("L0 precheck 失败时立即短路，不执行昂贵的 L1 validateCmd 与模型评审", async () => {
		const runsDir = mkdtempSync(join(tmpdir(), "loop-d12c-runs-"));
		process.env.MINI_HARNESS_RUNTIME_ROOT = runsDir;
		const { createLoopExtension, createLoopRun, loadLoopState, setLoopExecForTest } = await import("../../server/loop/extension.js");

		const execCmds: string[] = [];
		const tools = new Map<string, any>();
		const handlers = new Map<string, any[]>();
		const pi: any = {
			registerTool: (t: any) => tools.set(t.name, t),
			on: (ev: string, fn: any) => {
				if (!handlers.has(ev)) handlers.set(ev, []);
				handlers.get(ev)!.push(fn);
			},
			exec: async (_cmd: string, args: string[]) => {
				const joined = args.join(" ");
				execCmds.push(joined);
				if (joined.includes("syntax_fail")) return { code: 2, stdout: "", stderr: "SyntaxError: bad indent" };
				return { code: 0, stdout: "HARNESS_METRIC: tps=92.5", stderr: "" };
			},
			sendUserMessage: () => {},
		};
		createLoopExtension()(pi);
		// validator/precheck 走同一个 mock exec，避免 extension 用真实 runCommand 离开测试工作区。
		setLoopExecForTest(async (cmd: string, args: string[], opts?: { cwd?: string }) => {
			const r = await pi.exec(cmd, args, opts);
			return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? null, killed: false };
		});
		const sid = "sess-precheck-" + Date.now();
		const created = createLoopRun({
			sessionId: sid,
			cwd: runsDir,
			goal: "优化 prefill 吞吐",
			precheckCmd: "syntax_fail",
			validateCmd: "expensive_cluster_bench",
			useReviewer: false,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const ctx: any = { sessionManager: { getSessionId: () => sid }, cwd: runsDir };
		await tools.get("loop_done").execute("tc1", { summary: "done" }, undefined, undefined, ctx);
		await handlers.get("agent_end")![0]({}, ctx);

		expect(execCmds.some((c) => c.includes("syntax_fail"))).toBe(true);
		expect(execCmds.some((c) => c.includes("expensive_cluster_bench"))).toBe(false);
		const st = loadLoopState(created.runId)!;
		expect(st.history[0]?.precheckFailed).toBe(true);
		expect(st.lastEvidence).toContain("快速预检未通过");
	});

	it("distillLoopRun：把运行状态归档为结构化 Markdown 知识卡片", async () => {
		const { buildDistilledMarkdown, distillLoopRun } = await import("../../server/loop/distill.js");
		const dataDir = mkdtempSync(join(tmpdir(), "loop-distill-"));
		const fakeState: any = {
			runId: "20261030230000-abc123",
			goal: "将 80K cache 损耗压到 15% 以下",
			criteria: "loss_pct < 15 且精度无退化",
			workspace: "/work/infer-forge-harness",
			baseWorkspace: "/work/infer-forge-harness",
			precheckCmd: "python3 -m py_compile bench.py",
			validateCmd: "python3 validate.py",
			mode: "code",
			round: 2,
			maxRounds: 5,
			stage: "done",
			status: "done",
			acceptance: "passed",
			mainModel: { id: "glm-5.1", family: "zhipu" },
			plannerModel: { id: "deepseek-v3.2", family: "deepseek" },
			reviewerModel: { id: "qwen3-coder", family: "alibaba" },
			plan: "1. AST 插桩定位损耗 2. 异步流水重叠",
			summary: "合并 H2D 拷贝，损耗降至 13.8%",
			lastReview: { verdict: "pass", reasons: ["压测日志真实，损耗 13.8% < 15%"] },
			lastMetrics: { loss_pct: 13.8, cache_hit: 0.96 },
			bestRound: {
				round: 2,
				verdict: "pass",
				commitSha: "9f8e7d6c",
				metrics: { loss_pct: 13.8 },
				at: "2026-10-30T23:05:00Z",
			},
			history: [
				{ round: 1, verdict: "fail", code: 1, at: "2026-10-30T23:01:00Z", evidence: null, metrics: { loss_pct: 21.4 } },
				{
					round: 2,
					verdict: "pass",
					code: 0,
					at: "2026-10-30T23:05:00Z",
					evidence: null,
					metrics: { loss_pct: 13.8 },
					commitSha: "9f8e7d6c",
				},
			],
			createdAt: "2026-10-30T23:00:00Z",
			updatedAt: "2026-10-30T23:05:00Z",
		};
		const md = buildDistilledMarkdown(fakeState);
		expect(md).toContain("# 任务经验卡片 · 20261030230000-abc123");
		expect(md).toContain("loss_pct=13.8");
		expect(md).toContain("9f8e7d6c");
		const res = distillLoopRun(fakeState, dataDir);
		expect(existsSync(res.filePath)).toBe(true);
		expect(readFileSync(res.filePath, "utf8")).toContain("合并 H2D 拷贝");
	});
});
