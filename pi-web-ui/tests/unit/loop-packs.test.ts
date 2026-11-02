/**
 * 能力模板（Capability Packs）最小实践回归：
 * - 注册表只暴露两个服务端固化的语义模板（maximize / minimize 两个方向）。
 * - 两个 reference validator 真实跑出 HARNESS_METRIC，parseHarnessMetrics 正确提取主指标。
 * - 用各包声明的方向喂 pickBetterRound，能选出正确的最优轮次。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseHarnessMetrics, pickBetterRound } from "../../server/loop/metrics.js";
import { listCapabilityPacks, resolvePack } from "../../server/loop/packs.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

const hasPy = (() => {
	try {
		return spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;
	} catch {
		return false;
	}
})();
const itPy = hasPy ? it : it.skip;

describe("mini-harness capability packs", () => {
	it("注册表加载两个受服务端控制的能力模板，且不下发可执行命令", () => {
		const packs = listCapabilityPacks();
		expect(packs.map((p) => p.id).sort()).toEqual(["cache-loss", "inference-perf"]);
		const perf = resolvePack("inference-perf")!;
		expect(perf).toMatchObject({
			primaryMetric: "tps",
			metricDirection: "maximize",
		});
		expect(perf).not.toHaveProperty("precheckCmd");
		expect(perf).not.toHaveProperty("validateCmd");
		expect(perf).not.toHaveProperty("artifactRoots");
		const loss = resolvePack("cache-loss")!;
		expect(loss).toMatchObject({
			primaryMetric: "loss_pct",
			metricDirection: "minimize",
		});
		expect(resolvePack("nope")).toBeNull();
	});

	itPy("reference validator 跑出 HARNESS_METRIC，且主指标可解析（tps / loss_pct）", () => {
		const run = (script: string, args: string[]) =>
			spawnSync("python3", [path.join(REPO_ROOT, "packs", script), ...args], { encoding: "utf8" });

		const perf = run("inference-perf/validate.py", ["--validate", "--iterations", "1000"]);
		expect(perf.status).toBe(0);
		const perfM = parseHarnessMetrics(perf.stdout);
		expect(perfM).not.toBeNull();
		expect(typeof perfM!.tps).toBe("number");
		expect(perfM!.tps).toBeGreaterThan(0);

		const loss = run("cache-loss/validate.py", ["--validate"]);
		expect(loss.status).toBe(0);
		const lossM = parseHarnessMetrics(loss.stdout);
		expect(lossM).not.toBeNull();
		expect(typeof lossM!.loss_pct).toBe("number");
		expect(lossM!.loss_pct).toBeGreaterThan(0);
	});

	it("pickBetterRound 按包声明的方向选最优轮次（maximize tps / minimize loss_pct）", () => {
		const perf = resolvePack("inference-perf")!;
		const perfTarget = { metric: perf.primaryMetric, direction: perf.metricDirection } as const;
		const p1 = { round: 1, verdict: "pass", commitSha: "a", metrics: { tps: 90 }, at: "t1" };
		const p2 = { round: 2, verdict: "pass", commitSha: "b", metrics: { tps: 120 }, at: "t2" };
		const pWithoutTarget = { round: 3, verdict: "pass", commitSha: "c", metrics: { latency_ms: 30 }, at: "t3" };
		expect(pickBetterRound(null, p1, perfTarget)?.round).toBe(1);
		expect(pickBetterRound({ ...p1, round: 1 }, p2, perfTarget)?.round).toBe(2); // tps 120 > 90
		expect(pickBetterRound(null, pWithoutTarget, perfTarget)).toBeNull();
		expect(pickBetterRound(p1, pWithoutTarget, perfTarget)?.round).toBe(1);

		const loss = resolvePack("cache-loss")!;
		const lossTarget = { metric: loss.primaryMetric, direction: loss.metricDirection } as const;
		const c1 = { round: 1, verdict: "pass", commitSha: "c", metrics: { loss_pct: 13.8 }, at: "t1" };
		const c2 = { round: 2, verdict: "pass", commitSha: "d", metrics: { loss_pct: 15.0 }, at: "t2" };
		expect(pickBetterRound(c1, c2, lossTarget)?.round).toBe(1); // loss 13.8 < 15.0
	});
});
