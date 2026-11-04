/**
 * Task 2 指标门禁 / 最优轮次择优 单元测试：
 *  - evaluateMetricGate：exit 0 不等于指标达标；主指标在场 + 阈值 + 硬约束 + 场景门禁。
 *  - pickBetterRound：声明主指标后，候选轮缺主指标永不成为最优（即便 pass）。
 *  - parseHarnessScenario：场景标记解析。
 */
import { describe, expect, it } from "vitest";
import { evaluateMetricGate, parseHarnessScenario, pickBetterRound } from "../../server/loop/metrics.js";

describe("evaluateMetricGate：指标门禁", () => {
	it("无主指标且无硬约束（普通功能性任务）→ 恒通过", () => {
		const g = evaluateMetricGate(null, null, { tps: 100 }, null);
		expect(g.ok).toBe(true);
		expect(g.missingPrimary).toBe(false);
		expect(g.violations).toEqual([]);
	});

	it("主指标在场且满足阈值 → 通过", () => {
		const target = { metric: "loss_pct", direction: "minimize" as const, threshold: { op: "lt" as const, value: 20 } };
		const g = evaluateMetricGate(target, null, { loss_pct: 13.8 }, null);
		expect(g.ok).toBe(true);
		expect(g.reasons).toEqual([]);
	});

	it("缺主指标（validator 只输出 tps，没输出 loss_pct）→ missingPrimary，不通过", () => {
		const target = { metric: "loss_pct", direction: "minimize" as const, threshold: { op: "lt" as const, value: 20 } };
		const g = evaluateMetricGate(target, null, { tps: 500 }, null);
		expect(g.ok).toBe(false);
		expect(g.missingPrimary).toBe(true);
		expect(g.reasons.join("")).toContain("缺少主指标");
	});

	it("主指标数值非法（缺失 / null）→ 视为缺少主指标", () => {
		const target = { metric: "loss_pct", direction: "minimize" as const };
		expect(evaluateMetricGate(target, null, {}, null).missingPrimary).toBe(true);
		expect(evaluateMetricGate(target, null, null, null).missingPrimary).toBe(true);
	});

	it("主指标违反阈值 → 违规，不通过", () => {
		const target = { metric: "loss_pct", direction: "minimize" as const, threshold: { op: "lt" as const, value: 20 } };
		const g = evaluateMetricGate(target, null, { loss_pct: 25 }, null);
		expect(g.ok).toBe(false);
		expect(g.violations.length).toBe(1);
		expect(g.reasons.join("")).toContain("未达目标阈值");
	});

	it("硬约束：输入长度不满足 → 违规；满足 → 通过", () => {
		const c = [{ name: "输入长度", metric: "input_len", op: "gte" as const, value: 60000 }];
		expect(evaluateMetricGate(null, c, { input_len: 60000 }, null).ok).toBe(true);
		const g = evaluateMetricGate(null, c, { input_len: 50000 }, null);
		expect(g.ok).toBe(false);
		expect(g.reasons.join("")).toContain("输入长度");
	});

	it("硬约束缺证据（指标未输出）→ 违规", () => {
		const c = [{ name: "精度无退化", metric: "acc_drop", op: "lte" as const, value: 0.01 }];
		const g = evaluateMetricGate(null, c, { loss_pct: 13.8 }, null);
		expect(g.ok).toBe(false);
		expect(g.reasons.join("")).toContain("精度无退化");
	});

	it("场景：声明必要场景但 validator 未报出 → scenarioMismatch，不通过", () => {
		const target = { metric: "loss_pct", direction: "minimize" as const, scenario: "ascache-on-vs-radix-off" };
		const g = evaluateMetricGate(target, null, { loss_pct: 13.8 }, "radix-off");
		expect(g.ok).toBe(false);
		expect(g.scenarioMismatch).toBe(true);
	});

	it("场景匹配 → 通过；未声明单位 → unitUnconfirmed（仅记录，不阻塞）", () => {
		const target = { metric: "loss_pct", direction: "minimize" as const, scenario: "ascache-on" };
		const g = evaluateMetricGate(target, null, { loss_pct: 13.8 }, "ascache-on");
		expect(g.ok).toBe(true);
		expect(g.unitUnconfirmed).toBe(true);
	});
});

describe("pickBetterRound：声明主指标后候选轮缺主指标", () => {
	it("pass 但缺主指标的候选轮，不得压过已有带主指标的失败轮", () => {
		const target = { metric: "loss_pct", direction: "minimize" as const };
		const cur = { round: 1, verdict: "fail", commitSha: "aaa", metrics: { loss_pct: 14.2 }, at: "t1" };
		const cand = { round: 2, verdict: "pass", commitSha: "bbb", metrics: { tps: 500 }, at: "t2" };
		const best = pickBetterRound(cur, cand, target);
		expect(best?.round).toBe(1);
		expect(best?.metrics?.loss_pct).toBe(14.2);
	});

	it("首轮 pass 缺主指标 → 不记录为最优", () => {
		const target = { metric: "loss_pct", direction: "minimize" as const };
		const cand = { round: 1, verdict: "pass", commitSha: "a", metrics: { tps: 500 }, at: "t1" };
		expect(pickBetterRound(null, cand, target)).toBeNull();
	});

	it("已有最优缺主指标，候选轮补出主指标 → 胜出", () => {
		const target = { metric: "loss_pct", direction: "minimize" as const };
		const cur = { round: 1, verdict: "pass", commitSha: "a", metrics: { tps: 500 }, at: "t1" };
		const cand = { round: 2, verdict: "fail", commitSha: "b", metrics: { loss_pct: 18.0 }, at: "t2" };
		expect(pickBetterRound(cur, cand, target)?.round).toBe(2);
	});
});

describe("parseHarnessScenario：场景标记", () => {
	it("解析 HARNESS_SCENARIO 行，无则 null", () => {
		expect(parseHarnessScenario("HARNESS_SCENARIO: ascache-on-vs-radix-off\nDone")).toBe("ascache-on-vs-radix-off");
		expect(parseHarnessScenario("no scenario")).toBeNull();
	});
});
