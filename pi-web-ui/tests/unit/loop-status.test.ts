// @vitest-environment jsdom
/**
 * 人话状态（D-12-3）：web/src/loop-status.ts 把一个 run 变成「一句短状态 + 色调 + 建议动作」，
 * LoopBar / 任务台 / 任务详情共用。这里逐个覆盖服务端会产出的每种组合，三种输入形状
 * （快照 LoopUiState、任务台 LoopRunBrief、详情 LoopRunDetail）都直接喂进去；另测详情面板的
 * 两行验收结论、「重试 / 用同一目标重新开始」的预填，以及「按代码验证收下」的可用条件。
 */
import { describe, expect, it } from "vitest";
import { en, zh, type Translate } from "../../web/src/i18n.js";
import {
	canAcceptValidatorOnly,
	loopRoundText,
	loopStatus,
	retryAcceptanceOf,
	retryPrefillOf,
	reviewerLine,
	validatorLine,
	type LoopStatus,
	type LoopStatusInput,
	type LoopStatusKind,
} from "../../web/src/loop-status.js";
import type { LoopUiState } from "../../web/src/types.js";
import type { LoopRunBrief, LoopRunDetail } from "../../server/loop/routes.js";

/** 与 LanguageProvider 同一套占位符替换（{name} → 值）。 */
const makeT =
	(dict: Record<string, string>): Translate =>
	(key, vars) => {
		let s = dict[key as string] ?? String(key);
		for (const [k, v] of Object.entries(vars ?? {})) s = s.replaceAll(`{${k}}`, String(v));
		return s;
	};
const tz = makeT(zh);
const te = makeT(en);

const st = (run: LoopStatusInput, t: Translate = tz): LoopStatus => loopStatus(run, t);
const active = (stage: string, extra: Partial<LoopStatusInput> = {}): LoopStatusInput => ({
	kind: "run",
	status: "active",
	stage,
	round: 2,
	maxRounds: 5,
	...extra,
});
const stopped = (stopReason: string | null, extra: Partial<LoopStatusInput> = {}): LoopStatusInput => ({
	kind: "run",
	status: "stopped",
	stage: "stopped",
	round: 3,
	maxRounds: 5,
	stopReason,
	...extra,
});
const done = (acceptance: string | null | undefined): LoopStatusInput => ({
	kind: "run",
	status: "done",
	stage: "done",
	round: 2,
	maxRounds: 5,
	acceptance,
});

/** 每条用例：输入 → 期望的 kind / 整行文字 / 色调 / 建议动作 / 是否还在跑。 */
const CASES: Array<{
	name: string;
	run: LoopStatusInput;
	kind: LoopStatusKind;
	text: string;
	tone: LoopStatus["tone"];
	action: LoopStatus["action"];
	active?: boolean;
}> = [
	{
		name: "pending",
		run: { kind: "pending" },
		kind: "starting",
		text: "正在启动",
		tone: "busy",
		action: "none",
		active: true,
	},
	{
		name: "request-failed 带原因",
		run: { kind: "request-failed", reason: "同会话已有活跃 run" },
		kind: "not-started",
		text: "没启动起来：同会话已有活跃 run",
		tone: "bad",
		action: "restart",
	},
	{
		name: "request-failed 没原因",
		run: { kind: "request-failed", reason: "" },
		kind: "not-started",
		text: "没启动起来",
		tone: "bad",
		action: "restart",
	},
	{
		name: "active + setupPending（服务端刚建 run）",
		run: active("intake", { setupPending: true, round: 1 }),
		kind: "preparing",
		text: "正在准备",
		tone: "busy",
		action: "none",
		active: true,
	},
	{
		name: "active + intake（任务台行没有 setupPending 字段）",
		run: active("intake"),
		kind: "preparing",
		text: "正在准备",
		tone: "busy",
		action: "none",
		active: true,
	},
	{
		name: "active + plan",
		run: active("plan", { round: 1 }),
		kind: "planning",
		text: "正在规划 · 第 1/5 轮",
		tone: "busy",
		action: "none",
		active: true,
	},
	{
		name: "active + run",
		run: active("run"),
		kind: "working",
		text: "正在干活 · 第 2/5 轮",
		tone: "busy",
		action: "none",
		active: true,
	},
	{
		name: "active + validate",
		run: active("validate", { round: 3 }),
		kind: "checking",
		text: "正在验收 · 第 3/5 轮",
		tone: "busy",
		action: "none",
		active: true,
	},
	{
		name: "active + review",
		run: active("review"),
		kind: "checking",
		text: "正在验收 · 第 2/5 轮",
		tone: "busy",
		action: "none",
		active: true,
	},
	{
		name: "active + 未知阶段 → 按干活算",
		run: active("whatever"),
		kind: "working",
		text: "正在干活 · 第 2/5 轮",
		tone: "busy",
		action: "none",
		active: true,
	},
	{
		name: "active 没有轮数上限",
		run: active("run", { maxRounds: 0 }),
		kind: "working",
		text: "正在干活 · 第 2 轮",
		tone: "busy",
		action: "none",
		active: true,
	},
	{
		name: "active 还没开始数轮",
		run: active("run", { round: 0 }),
		kind: "working",
		text: "正在干活",
		tone: "busy",
		action: "none",
		active: true,
	},
	{
		name: "done + passed",
		run: done("passed"),
		kind: "done",
		text: "交卷了 · 查看成果",
		tone: "ok",
		action: "view-result",
	},
	{
		name: "done + passed-validator-only",
		run: done("passed-validator-only"),
		kind: "done-validator-only",
		text: "交卷了（仅代码验证） · 查看成果",
		tone: "warn",
		action: "view-result",
	},
	{
		name: "done + self-declared",
		run: done("self-declared"),
		kind: "done-self-declared",
		text: "交卷了（模型自述） · 查看成果",
		tone: "warn",
		action: "view-result",
	},
	{
		name: "done + 没有 acceptance（D-12 之前的旧 run）",
		run: done(undefined),
		kind: "done",
		text: "交卷了 · 查看成果",
		tone: "ok",
		action: "view-result",
	},
	{
		name: "stopped + reviewer-error",
		run: stopped("reviewer-error", { stage: "review-error" }),
		kind: "reviewer-error",
		text: "裁判掉线了 · 等待重试",
		tone: "warn",
		action: "retry-review",
	},
	{
		name: "stopped + validate-fail",
		run: stopped("validate-fail"),
		kind: "not-passed",
		text: "还没过关 · 查看失败证据",
		tone: "bad",
		action: "view-evidence",
	},
	{
		name: "stopped + max-rounds（LLM 模式到上限）",
		run: stopped("max-rounds"),
		kind: "not-passed",
		text: "还没过关 · 查看失败证据",
		tone: "bad",
		action: "view-evidence",
	},
	{
		name: "stopped + reviewer-block",
		run: stopped("reviewer-block"),
		kind: "review-blocked",
		text: "评审没通过 · 查看理由",
		tone: "bad",
		action: "view-reasons",
	},
	{
		name: "stopped + user-stop",
		run: stopped("user-stop"),
		kind: "user-stop",
		text: "已停止",
		tone: "idle",
		action: "restart",
	},
	{
		name: "stopped 没有原因",
		run: stopped(null),
		kind: "user-stop",
		text: "已停止",
		tone: "idle",
		action: "restart",
	},
	{
		name: "stopped + runtime-error",
		run: stopped("runtime-error"),
		kind: "runtime-error",
		text: "运行出错 · 查看记录",
		tone: "bad",
		action: "view-log",
	},
	{
		name: "stopped + no-validator",
		run: stopped("no-validator"),
		kind: "no-validator",
		text: "缺少验收脚本",
		tone: "bad",
		action: "restart",
	},
	{
		name: "stopped + setup-error 带原因（快照 / 详情）",
		run: stopped("setup-error", { setupError: "规划与评审同属 glm 家族" }),
		kind: "not-started",
		text: "没启动起来：规划与评审同属 glm 家族",
		tone: "bad",
		action: "restart",
	},
	{
		name: "stopped + setup-error 没原因（任务台行不带 setupError）",
		run: stopped("setup-error"),
		kind: "not-started",
		text: "没启动起来",
		tone: "bad",
		action: "restart",
	},
	{
		name: "stopped + 模型 loop_stop 自带的原因",
		run: stopped("测试环境不可用"),
		kind: "stopped-other",
		text: "已停止：测试环境不可用",
		tone: "idle",
		action: "restart",
	},
	{
		name: "缺 status 的异常记录按停下处理",
		run: { kind: "run", stopReason: "validate-fail" },
		kind: "not-passed",
		text: "还没过关 · 查看失败证据",
		tone: "bad",
		action: "view-evidence",
	},
];

describe("loopStatus：人话状态全表（中文）", () => {
	it.each(CASES)("$name → $text", (c) => {
		const s = st(c.run);
		expect(s.kind).toBe(c.kind);
		expect(s.text).toBe(c.text);
		expect(s.tone).toBe(c.tone);
		expect(s.action).toBe(c.action);
		expect(s.active).toBe(c.active ?? false);
		// text = label · hint（hint 为空就只有 label）
		expect(s.text).toBe(s.hint ? `${s.label} · ${s.hint}` : s.label);
	});

	it("全表覆盖了每一种 kind", () => {
		const all: LoopStatusKind[] = [
			"starting",
			"preparing",
			"planning",
			"working",
			"checking",
			"done",
			"done-validator-only",
			"done-self-declared",
			"reviewer-error",
			"not-passed",
			"review-blocked",
			"user-stop",
			"stopped-other",
			"runtime-error",
			"no-validator",
			"not-started",
		];
		expect(new Set(CASES.map((c) => c.kind))).toEqual(new Set(all));
	});

	it("中英文都没有漏填的占位符", () => {
		for (const c of CASES) {
			for (const t of [tz, te]) expect(st(c.run, t).text).not.toMatch(/[{}]/);
		}
	});

	it("长原因折成一行并截断（状态行单行省略，完整原因在详情里）", () => {
		const long = `第一行\n第二行   ${"很长的原因".repeat(40)}`;
		const s = st(stopped("setup-error", { setupError: long }));
		expect(s.text.startsWith("没启动起来：第一行 第二行 ")).toBe(true);
		expect(s.text.endsWith("…")).toBe(true);
		expect(s.text.length).toBeLessThan(140);
		const other = st(stopped("x".repeat(200)));
		expect(other.text.length).toBeLessThan(80);
		expect(other.text.endsWith("…")).toBe(true);
	});
});

describe("loopStatus：英文", () => {
	it.each([
		[active("run"), "Working · Round 2/5"],
		[active("intake", { setupPending: true }), "Preparing"],
		[done("passed"), "Done · View result"],
		[done("passed-validator-only"), "Done (code check only) · View result"],
		[done("self-declared"), "Done (model's own word) · View result"],
		[stopped("reviewer-error"), "Reviewer dropped out · Waiting for a retry"],
		[stopped("validate-fail"), "Not passing yet · View failure evidence"],
		[stopped("reviewer-block"), "Review rejected · View reasons"],
		[stopped("runtime-error"), "Run error · View log"],
		[stopped("no-validator"), "No check script"],
		[stopped("user-stop"), "Stopped"],
		[{ kind: "request-failed", reason: "busy" } as LoopStatusInput, "Didn't start: busy"],
	])("%j → %s", (run, text) => {
		expect(st(run, te).text).toBe(text);
	});
});

describe("loopStatus：三种输入形状直接可用", () => {
	it("快照 LoopUiState", () => {
		const loop: LoopUiState = {
			kind: "run",
			taskId: null,
			goal: "修复单测",
			runId: "20261030121500-bbb222",
			mode: "code",
			stage: "review-error",
			round: 1,
			maxRounds: 5,
			status: "stopped",
			stopReason: "reviewer-error",
			lastVerdict: "pass",
			acceptance: null,
			review: { verdict: "error", reasons: ["timeout"] },
			reviewerEnabled: true,
			setupPending: false,
			createdAt: "2026-10-30T12:15:00.000Z",
		};
		expect(st(loop).text).toBe("裁判掉线了 · 等待重试");
	});

	it("任务台 LoopRunBrief", () => {
		const row: LoopRunBrief = {
			runId: "20261030120000-aaa111",
			stage: "done",
			round: 2,
			maxRounds: 5,
			status: "done",
			lastVerdict: "pass",
			goal: "创建 result.txt",
			project: "demo",
			models: { main: null, planner: null, reviewer: null },
			updatedAt: null,
			mode: "code",
			stopReason: null,
			acceptance: "passed",
			reviewVerdict: "pass",
			reviewReasons: [],
			reviewerEnabled: true,
			createdAt: null,
		};
		expect(st(row).text).toBe("交卷了 · 查看成果");
	});

	it("详情 LoopRunDetail", () => {
		const detail = {
			runId: "20261030120000-ccc333",
			goal: "g",
			criteria: null,
			mode: "code",
			status: "stopped",
			stage: "stopped",
			round: 1,
			maxRounds: 3,
			stopReason: "setup-error",
			acceptance: null,
			setupError: "没有可用的规划模型",
		} satisfies Partial<LoopRunDetail>;
		expect(st(detail).text).toBe("没启动起来：没有可用的规划模型");
	});
});

describe("loopRoundText", () => {
	it("有上限 N/M，无上限 N，没开始数轮为空", () => {
		expect(loopRoundText(tz, { round: 2, maxRounds: 5 })).toBe("第 2/5 轮");
		expect(loopRoundText(tz, { round: 2, maxRounds: 0 })).toBe("第 2 轮");
		expect(loopRoundText(tz, { round: 0, maxRounds: 5 })).toBe("");
		expect(loopRoundText(te, { round: 4, maxRounds: 5 })).toBe("Round 4/5");
	});
});

describe("详情面板两行验收结论", () => {
	it("代码验证：通过 / 未通过（exit N）/ 未通过 / 未运行 / 不适用（LLM 模式）", () => {
		expect(validatorLine({ mode: "code", validator: { verdict: "pass", code: 0 } }, tz)).toEqual({
			text: "通过",
			tone: "ok",
		});
		expect(validatorLine({ mode: "code", validator: { verdict: "fail", code: 2 } }, tz)).toEqual({
			text: "未通过（exit 2）",
			tone: "bad",
		});
		expect(validatorLine({ mode: "code", validator: { verdict: "fail", code: null } }, tz).text).toBe("未通过");
		expect(validatorLine({ mode: "code", validator: { verdict: null, code: null } }, tz)).toEqual({
			text: "未运行",
			tone: "idle",
		});
		expect(validatorLine({ mode: "code" }, tz).text).toBe("未运行");
		// LLM 模式的 lastVerdict 来自评审，不能当代码验证读
		expect(validatorLine({ mode: "llm", validator: { verdict: "pass", code: null } }, tz)).toEqual({
			text: "不适用（LLM 模式）",
			tone: "idle",
		});
		expect(validatorLine({ mode: "code", validator: { verdict: "fail", code: 1 } }, te).text).toBe("Failed (exit 1)");
	});

	it("模型评审：通过 / 否决 / 掉线（出错）/ 未开启 / 未运行", () => {
		expect(reviewerLine({ review: { enabled: true, verdict: "pass" } }, tz)).toEqual({ text: "通过", tone: "ok" });
		expect(reviewerLine({ review: { enabled: true, verdict: "block" } }, tz)).toEqual({ text: "否决", tone: "bad" });
		expect(reviewerLine({ review: { enabled: true, verdict: "error" } }, tz)).toEqual({
			text: "掉线（出错）",
			tone: "warn",
		});
		expect(reviewerLine({ review: { enabled: true, verdict: "skip" } }, tz).text).toBe("未开启");
		expect(reviewerLine({ review: { enabled: false, verdict: null } }, tz).text).toBe("未开启");
		expect(reviewerLine({ review: { enabled: true, verdict: null } }, tz).text).toBe("未运行");
		expect(reviewerLine({}, tz).text).toBe("未运行");
		expect(reviewerLine({ review: { enabled: true, verdict: "error" } }, te).text).toBe("Dropped out (error)");
	});
});

describe("重试 / 用同一目标重新开始的预填", () => {
	it("验收方式：LLM 模式 → 仅模型评审；没开评审 → 仅代码验证；其余 → 代码验证 + 模型评审", () => {
		expect(retryAcceptanceOf({ mode: "llm", reviewerEnabled: false })).toBe("llm");
		expect(retryAcceptanceOf({ mode: "code", reviewerEnabled: false })).toBe("code");
		expect(retryAcceptanceOf({ mode: "code", reviewerEnabled: true })).toBe("code-review");
		expect(retryAcceptanceOf({})).toBe("code-review");
	});

	it("带回目标、验收标准（没有就空串）与验收方式", () => {
		expect(retryPrefillOf({ goal: "g", criteria: "c", mode: "code", reviewerEnabled: false })).toEqual({
			goal: "g",
			criteria: "c",
			acceptance: "code",
		});
		expect(retryPrefillOf({ goal: "g", criteria: null })).toEqual({
			goal: "g",
			criteria: "",
			acceptance: "code-review",
		});
	});
});

describe("按代码验证收下的可用条件（与服务端 acceptRunValidatorOnly 同口径）", () => {
	const base = { status: "stopped", stopReason: "reviewer-error", mode: "code", lastVerdict: "pass" };
	it("代码模式、评审掉线、代码验证已过 → 可以", () => {
		expect(canAcceptValidatorOnly(base)).toBe(true);
	});
	it.each([
		["LLM 模式", { mode: "llm" }],
		["代码验证没过", { lastVerdict: "fail" }],
		["不是评审掉线", { stopReason: "validate-fail" }],
		["已经收下了", { status: "done" }],
	])("%s → 不行", (_name, patch) => {
		expect(canAcceptValidatorOnly({ ...base, ...patch })).toBe(false);
	});
});
