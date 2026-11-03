/**
 * 能力模板（Capability Packs）最小实践回归：
 * - 注册表暴露三个服务端固化的语义模板（maximize / minimize / 布尔验证三个方向）。
 * - reference validator 真实跑出 HARNESS_METRIC，parseHarnessMetrics 正确提取主指标；
 *   cache-loss 的 loss_pct 必须是 ITPS 比值损耗（不是 miss rate/命中率）。
 * - 用各包声明的方向喂 pickBetterRound，能选出正确的最优轮次。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseHarnessMetrics, parseHarnessScenario, pickBetterRound } from "../../server/loop/metrics.js";
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
	it("注册表加载三个受服务端控制的能力模板，且不下发可执行命令", () => {
		const packs = listCapabilityPacks();
		expect(packs.map((p) => p.id).sort()).toEqual(["cache-loss", "inference-perf", "service-config-verify"]);

		const perf = resolvePack("inference-perf")!;
		expect(perf).toMatchObject({
			primaryMetric: "input_throughput",
			metricDirection: "maximize",
			kind: "development",
		});
		expect(perf).not.toHaveProperty("precheckCmd");
		expect(perf).not.toHaveProperty("validateCmd");
		expect(perf).not.toHaveProperty("artifactRoots");

		const verify = resolvePack("service-config-verify")!;
		expect(verify).toMatchObject({ primaryMetric: null, metricDirection: null, kind: "verification" });

		const loss = resolvePack("cache-loss")!;
		expect(loss).toMatchObject({
			primaryMetric: "loss_pct",
			metricDirection: "minimize",
			metricThreshold: { op: "lt", value: 20 },
			metricScenario: "ascache-on-vs-radix-off",
		});
		expect(loss.hardConstraints).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ metric: "cache_hit", op: "gte", value: 0.96 }),
				expect.objectContaining({ metric: "input_len", op: "gte", value: 81920 }),
				expect.objectContaining({ metric: "loss_std", op: "lte", value: 0.5 }),
			]),
		);
		expect(resolvePack("nope")).toBeNull();
	});

	itPy("reference validator 跑出 HARNESS_METRIC，且主指标可解析（input_throughput / loss_pct）", () => {
		const run = (script: string, args: string[]) =>
			spawnSync("python3", [path.join(REPO_ROOT, "packs", script), ...args], { encoding: "utf8" });

		const perf = run("inference-perf/validate.py", ["--validate", "--iterations", "1000"]);
		expect(perf.status).toBe(0);
		const perfM = parseHarnessMetrics(perf.stdout);
		expect(perfM).not.toBeNull();
		expect(typeof perfM!.input_throughput).toBe("number");
		expect(perfM!.input_throughput).toBeGreaterThan(0);

		const loss = run("cache-loss/validate.py", ["--validate"]);
		expect(loss.status).toBe(0);
		const lossM = parseHarnessMetrics(loss.stdout);
		expect(lossM).not.toBeNull();
		// 关键口径：loss_pct = (1 - 92000/100000)*100 = 8.0，而不是 miss rate。
		expect(lossM!.loss_pct).toBeCloseTo(8.0, 5);
		expect(lossM!.cache_hit).toBeCloseTo(0.97, 5);
		expect(lossM!.input_len).toBe(81920);
		expect(lossM!.loss_std).toBeLessThanOrEqual(0.5);
		expect(parseHarnessScenario(loss.stdout)).toBe("ascache-on-vs-radix-off");
	});

	it("pickBetterRound 按包声明的方向选最优轮次（maximize input_throughput / minimize loss_pct）", () => {
		const perf = resolvePack("inference-perf")!;
		expect(perf.primaryMetric).not.toBeNull();
		expect(perf.metricDirection).not.toBeNull();
		const perfTarget = { metric: perf.primaryMetric!, direction: perf.metricDirection! } as const;
		const p1 = { round: 1, verdict: "pass", commitSha: "a", metrics: { input_throughput: 90 }, at: "t1" };
		const p2 = { round: 2, verdict: "pass", commitSha: "b", metrics: { input_throughput: 120 }, at: "t2" };
		const pWithoutTarget = { round: 3, verdict: "pass", commitSha: "c", metrics: { latency_ms: 30 }, at: "t3" };
		expect(pickBetterRound(null, p1, perfTarget)?.round).toBe(1);
		expect(pickBetterRound({ ...p1, round: 1 }, p2, perfTarget)?.round).toBe(2); // 120 > 90
		expect(pickBetterRound(null, pWithoutTarget, perfTarget)).toBeNull();
		expect(pickBetterRound(p1, pWithoutTarget, perfTarget)?.round).toBe(1);

		const loss = resolvePack("cache-loss")!;
		expect(loss.primaryMetric).not.toBeNull();
		expect(loss.metricDirection).not.toBeNull();
		const lossTarget = { metric: loss.primaryMetric!, direction: loss.metricDirection! } as const;
		const c1 = { round: 1, verdict: "pass", commitSha: "c", metrics: { loss_pct: 13.8 }, at: "t1" };
		const c2 = { round: 2, verdict: "pass", commitSha: "d", metrics: { loss_pct: 15.0 }, at: "t2" };
		expect(pickBetterRound(c1, c2, lossTarget)?.round).toBe(1); // loss 13.8 < 15.0
	});
});
