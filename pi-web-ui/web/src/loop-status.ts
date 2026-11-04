/**
 * 代码 loop 的「人话状态」（D-12-3）：把一个 run 变成一句短状态 + 色调 + 建议动作。
 *
 * 输入可以是快照里的 LoopUiState、任务台的 LoopRunBrief，也可以是详情接口的 LoopRunDetail
 * （三者字段同名，这里只读交集）。LoopBar、任务台、详情面板共用这一个口径，文案不各写各的。
 * 详情面板的两行验收结论（代码验证 / 模型评审）与「用同一目标重新开始」的预填也在这里，
 * 都是纯函数，单测见 tests/unit/loop-status.test.ts。
 */
import type { Translate } from "./i18n";
import type { TaskAcceptance, TaskPrefill } from "./loop-cockpit";

/** LoopUiState / LoopRunBrief / LoopRunDetail 的公共字段（都可缺省）。 */
export interface LoopStatusInput {
	kind?: "pending" | "run" | "request-failed";
	status?: string | null;
	stage?: string | null;
	round?: number | null;
	maxRounds?: number | null;
	stopReason?: string | null;
	stopRequestedAt?: string | null;
	stopConfirmedAt?: string | null;
	acceptance?: string | null;
	setupPending?: boolean | null;
	setupError?: string | null;
	/** request-failed 的失败原因。 */
	reason?: string | null;
}

/** busy = 进行中；ok = 两道验收都过；warn = 交卷但验收打了折扣 / 等用户处理；bad = 没过或出错；idle = 用户停的。 */
export type LoopTone = "busy" | "ok" | "warn" | "bad" | "idle";

/** 建议用户下一步做什么（文案里的「查看成果 / 查看失败证据 / …」就是它）。 */
export type LoopStatusAction =
	"none" | "view-result" | "retry-review" | "view-evidence" | "view-reasons" | "view-log" | "restart";

export type LoopStatusKind =
	| "starting"
	| "stopping"
	| "preparing"
	| "planning"
	| "working"
	| "checking"
	| "done"
	| "done-validator-only"
	| "done-self-declared"
	| "reviewer-error"
	| "not-passed"
	| "review-blocked"
	| "user-stop"
	| "stopped-other"
	| "runtime-error"
	| "no-validator"
	| "not-started";

export interface LoopStatus {
	kind: LoopStatusKind;
	/** 主句：「交卷了（仅代码验证）」「正在干活」。 */
	label: string;
	/** 补充：轮次或建议动作（「第 2/5 轮」「查看成果」），可能为空。 */
	hint: string;
	/** 一行展示用：`label · hint`。 */
	text: string;
	tone: LoopTone;
	action: LoopStatusAction;
	/** 还在跑（pending / active）。 */
	active: boolean;
}

/** 原因只留一行、限长：状态行是单行省略，详情面板另有完整原因。 */
function brief(s: string | null | undefined, max: number): string {
	const one = String(s ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** 「第 N/M 轮」（没有上限就只写 N；还没开始数轮就不写）。 */
export function loopRoundText(t: Translate, run: Pick<LoopStatusInput, "round" | "maxRounds">): string {
	const n = run.round ?? 0;
	if (!n) return "";
	return t("goalBarRound", { n: run.maxRounds ? `${n}/${run.maxRounds}` : `${n}` });
}

function notStarted(t: Translate, reason: string | null | undefined): string {
	const why = brief(reason, 120);
	return why ? t("loopStNotStartedWhy", { reason: why }) : t("loopStNotStarted");
}

export function loopStatus(run: LoopStatusInput, t: Translate): LoopStatus {
	const make = (
		kind: LoopStatusKind,
		label: string,
		hint: string,
		tone: LoopTone,
		action: LoopStatusAction,
		active = false,
	): LoopStatus => ({ kind, label, hint, text: hint ? `${label} · ${hint}` : label, tone, action, active });

	if (run.kind === "request-failed") return make("not-started", notStarted(t, run.reason), "", "bad", "restart");
	if (run.kind === "pending") return make("starting", t("loopStStarting"), "", "busy", "none", true);

	const status = run.status ?? "";
	if (run.stage === "stopping" || (run.stopRequestedAt && !run.stopConfirmedAt)) {
		return make("stopping", t("loopStStopping"), t("loopStViewEvidence"), "warn", "view-evidence", true);
	}
	if (status === "active") {
		// 服务端刚建 run、还没做完模型准备（家族解析 + 规划）
		if (run.setupPending || run.stage === "intake")
			return make("preparing", t("loopStPreparing"), "", "busy", "none", true);
		const round = loopRoundText(t, run);
		if (run.stage === "plan") return make("planning", t("loopStPlanning"), round, "busy", "none", true);
		if (run.stage === "validate" || run.stage === "review")
			return make("checking", t("loopStChecking"), round, "busy", "none", true);
		return make("working", t("loopStWorking"), round, "busy", "none", true);
	}

	if (status === "done") {
		const hint = t("loopStViewResult");
		if (run.acceptance === "passed-validator-only")
			return make("done-validator-only", t("loopStDoneValidatorOnly"), hint, "warn", "view-result");
		if (run.acceptance === "self-declared")
			return make("done-self-declared", t("loopStDoneSelfDeclared"), hint, "warn", "view-result");
		// passed，或 D-12 之前的旧 run（没有 acceptance 字段）
		return make("done", t("loopStDone"), hint, "ok", "view-result");
	}

	// 其余都按停下处理（stopped，或缺 status 的异常记录）
	const reason = run.stopReason ?? "";
	switch (reason) {
		case "reviewer-error":
			return make("reviewer-error", t("loopStReviewerDown"), t("loopStWaitRetry"), "warn", "retry-review");
		case "validate-fail":
		case "max-rounds":
			return make("not-passed", t("loopStNotPassed"), t("loopStViewEvidence"), "bad", "view-evidence");
		case "reviewer-block":
			return make("review-blocked", t("loopStReviewBlocked"), t("loopStViewReasons"), "bad", "view-reasons");
		case "runtime-error":
			return make("runtime-error", t("loopStRuntimeError"), t("loopStViewLog"), "bad", "view-log");
		case "no-validator":
			return make("no-validator", t("loopStNoValidator"), "", "bad", "restart");
		case "setup-error":
			return make("not-started", notStarted(t, run.setupError), "", "bad", "restart");
		case "":
		case "user-stop":
			return make("user-stop", t("loopStStopped"), "", "idle", "restart");
		default:
			// 模型调 loop_stop 时可以自带原因：原样带上，别吞掉
			return make("stopped-other", t("loopStStoppedWhy", { reason: brief(reason, 60) }), "", "idle", "restart");
	}
}

/** 一行验收结论：文字 + 色调（详情面板「代码验证：…」「模型评审：…」）。 */
export interface AcceptanceLine {
	text: string;
	tone: LoopTone;
}

/** 代码验证那一行：通过 / 未通过（exit N）/ 未运行 / 不适用（LLM 模式）。 */
export function validatorLine(
	run: { mode?: string | null; validator?: { verdict?: string | null; code?: number | null } | null },
	t: Translate,
): AcceptanceLine {
	if (run.mode === "llm") return { text: t("runDetailNotApplicable"), tone: "idle" };
	const v = run.validator?.verdict ?? null;
	if (v === "pass") return { text: t("runDetailPass"), tone: "ok" };
	if (v === "fail") {
		const code = run.validator?.code;
		return {
			text: typeof code === "number" ? t("runDetailFailExit", { code }) : t("runDetailFail"),
			tone: "bad",
		};
	}
	return { text: t("runDetailNotRun"), tone: "idle" };
}

/** 模型评审那一行：通过 / 否决 / 掉线（出错）/ 未开启 / 未运行（开着但还没评）。 */
export function reviewerLine(
	run: { review?: { enabled?: boolean | null; verdict?: string | null } | null },
	t: Translate,
): AcceptanceLine {
	const v = run.review?.verdict ?? null;
	if (v === "pass") return { text: t("runDetailPass"), tone: "ok" };
	if (v === "block") return { text: t("runDetailBlocked"), tone: "bad" };
	if (v === "error") return { text: t("runDetailReviewerError"), tone: "warn" };
	// skip = 没开评审或没有可用评审模型
	if (v === "skip" || run.review?.enabled === false) return { text: t("runDetailReviewerOff"), tone: "idle" };
	return { text: t("runDetailNotRun"), tone: "idle" };
}

/** 「重试 / 用同一目标重新开始」带回的验收方式：LLM 模式 → 仅模型评审；没开评审 → 仅代码验证。 */
export function retryAcceptanceOf(run: { mode?: string | null; reviewerEnabled?: boolean | null }): TaskAcceptance {
	if (run.mode === "llm") return "llm";
	return run.reviewerEnabled === false ? "code" : "code-review";
}

/** 打开新任务弹窗的预填：同一目标、同一验收标准、对应的验收方式。 */
export function retryPrefillOf(run: {
	goal: string;
	criteria?: string | null;
	mode?: string | null;
	reviewerEnabled?: boolean | null;
}): TaskPrefill {
	return { goal: run.goal, criteria: run.criteria ?? "", acceptance: retryAcceptanceOf(run) };
}

/** 评审掉线后能不能「按代码验证收下」：代码模式、代码验证已通过（服务端同一口径）。 */
export function canAcceptValidatorOnly(run: {
	status?: string | null;
	stopReason?: string | null;
	mode?: string | null;
	lastVerdict?: string | null;
}): boolean {
	return (
		run.status === "stopped" && run.stopReason === "reviewer-error" && run.mode !== "llm" && run.lastVerdict === "pass"
	);
}

/** 隔夜恢复只读徽标（unit → 短文案 + 色调）；没有恢复信息（旧 state）时返回 null。 */
export function recoveryBadgeOf(
	recovery: { unit?: string | null } | null | undefined,
	t: Translate,
): { label: string; tone: LoopTone } | null {
	const unit = recovery?.unit ?? null;
	if (!unit) return null;
	switch (unit) {
		case "running":
			return { label: t("recoveryRunning"), tone: "busy" };
		case "completed-valid":
			return { label: t("recoveryCompleted"), tone: "ok" };
		case "failed-retryable":
			return { label: t("recoveryFailed"), tone: "warn" };
		case "cancelled":
			return { label: t("recoveryCancelled"), tone: "idle" };
		case "unknown":
		default:
			return { label: t("recoveryUnknown"), tone: "warn" };
	}
}
