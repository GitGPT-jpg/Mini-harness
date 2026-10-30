import { memo, type ReactNode } from "react";
import { FiX, FiArrowUpRight, FiSquare } from "react-icons/fi";
import type { GoalStatus } from "../types";
import { isZhLocale, useT, useI18n } from "../i18n";
import { appSend, useIsDsh } from "../app-globals";
import type { UiSlotEntry } from "../ui-slots";
import { renderMergedToolbar } from "../slot-toolbar";
import { useCockpitPopupOpen } from "../loop-cockpit";
import { TaskCapsule } from "./TaskModal";

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in, so the shallow-compared memo() below skips
 *  the goal bar entirely during streaming. */
interface Props {
	goal: GoalStatus;
	activeConversationId: string;
	/** `goalbar.actions` 槽位的最终条目（全量，含 hidden；宿主 chrome 按槽位顺序渲染）。
	 *  不传 = 未接线，回落默认顺序（与旧硬编码一致）。 */
	uiGoalbarActions?: UiSlotEntry[];
	/** 点击一条目标条动作：交回 App 分派（与顶栏 onUiAction 同通道）。 */
	onUiAction?: (item: UiSlotEntry) => void;
}

/** 目标条：LLM loop 进行中显示进度（调研向导 / 执行·审查轮次）；闲置时只剩输入框上沿的
 *  「新任务」胶囊（设目标在统一任务弹窗 TaskModal 里选「仅模型评审」）。 */
export const GoalBar = memo(function GoalBar({ goal, activeConversationId, uiGoalbarActions, onUiAction }: Props) {
	const t = useT();
	// 驾驶舱弹层（新任务 / 连接集群 / 任务台）打开时收起「新任务」胶囊。
	const popupOpen = useCockpitPopupOpen();
	const { locale } = useI18n();
	const goalDetail = !isZhLocale(locale) && goal.statusEn ? goal.statusEn : goal.status || "";
	const wizardDetail = !isZhLocale(locale) && goal.wizard?.statusEn ? goal.wizard.statusEn : goal.wizard?.status || "";
	// DSH：不接目标模式 2.0 的执行对话（没有执行模型可言，旧后端告警也不适用）。
	// engine 走全局（web/src/app-globals.ts），不再从 App 一路传下来。
	const isDsh = useIsDsh();
	// Goals belong to the conversation that created them. The server keeps the
	// status around while switching chats so returning to the owner restores the
	// goal, but never show another conversation's goal as active.
	const goalBelongsToActiveConversation = !goal.conversationId || goal.conversationId === activeConversationId;
	const active = goal.goal !== null && goalBelongsToActiveConversation;
	// 目标模式 2.0：委托执行者的对话 id（有它才能「一键打开执行对话」）。
	const execRole = goalBelongsToActiveConversation ? goal.roles?.executor : undefined;
	const execRoleConvId = execRole?.convId;
	// 执行者实时动态（轮次边界刷新）：跑什么工具 / 自述头；中英按 locale 二选一。
	const execActivity = execRole?.activity
		? !isZhLocale(locale) && execRole.activityEn
			? execRole.activityEn
			: execRole.activity
		: execRole?.streaming
			? "…"
			: undefined;
	// 轮次标签：有限预算显示 N/M，不限显示 N·不限（单次模式只显示 N）。
	const roundBudget = goal.locked && goal.maxRounds > 0 ? goal.maxRounds : 0;
	const roundLabel =
		roundBudget > 0
			? isZhLocale(locale)
				? // 走 i18n 词条：简中「第 N/M 轮」、繁中「第 N/M 輪」
					t("goalBarRound", { n: `${goal.round}/${roundBudget}` })
				: `Round ${goal.round}/${roundBudget}`
			: `${t("goalBarRound", { n: goal.round })}${goal.locked ? ` · ${t("goalBarUnlimitedShort")}` : ""}`;
	// 本目标累计用量（执行者 + 审查者，轮次边界累计）。
	const usageTotal = (goal.usage?.inputTokens ?? 0) + (goal.usage?.outputTokens ?? 0);
	const fmtTok = (n: number): string =>
		n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
	// 目标模式 2.0 加固：pi 引擎的新后端在**任何** goal_status 里都带 execModel
	// （makeGoalStatus 一定赋值）；旧后端（进程没重启）把未知字段丢掉，于是这里是
	// undefined。不静默：「新界面 + 旧后端」这种混合态必须当场说出来。
	const staleBackend = !isDsh && goal.execModel === undefined;

	// ---- 槽位合并：宿主 chrome 按 id 分区（折叠胶囊 / 活跃行），插件条目跟随同行；
	// 未接线时用默认顺序，hidden 由上层过滤（App 传全量）。 ----
	const GOAL_DEFAULT_ORDER = ["host:task-new", "host:goal-openrole", "host:goal-clear"];
	const allGoalEntries: UiSlotEntry[] =
		uiGoalbarActions === undefined
			? GOAL_DEFAULT_ORDER.map((id) => ({ id, source: "host" }) as UiSlotEntry)
			: uiGoalbarActions.filter((e) => !e.hidden);
	/** 取某行要画的条目：该行宿主 id，按槽位顺序。 */
	const goalZone = (ids: string[]): UiSlotEntry[] => {
		const set = new Set(ids);
		return allGoalEntries.filter((e) => set.has(e.id));
	};
	/** 布局页改名指定过文案（`labelExplicit`）→ 用那一条，否则内置 i18n 文案。 */
	const goalLabel = (id: string, fallback: string): string => {
		const e = allGoalEntries.find((x) => x.id === id);
		return e?.labelExplicit ? e.label : fallback;
	};
	const goalHostNodes: Record<string, ReactNode> = {
		"host:task-new": <TaskCapsule label={goalLabel("host:task-new", t("taskNew"))} />,
	};
	const wizardActive = (goal.wizard?.active ?? false) && goalBelongsToActiveConversation;

	if (wizardActive) {
		return (
			<div className={`goalbar goalbar-active ${wizardActive ? "wizard" : ""}`}>
				<div className="goalbar-active-row">
					<span className="goalbar-icon">
						<span className="goalbar-spin">🔍</span>
					</span>
					<span className="goalbar-text" title={goal.wizard?.draft ?? ""}>
						{t("goalWizardRunning")}: {goal.wizard?.draft}
					</span>
					<span className="goalbar-chip reviewing">
						{t("goalWizardStep", { n: (goal.wizard?.step ?? 0) + 1 })} / {goal.wizard?.maxSteps ?? 6}
					</span>
					<span className="goalbar-detail">{wizardDetail || t("goalBarReviewing")}</span>
					{renderMergedToolbar(
						goalZone(["host:goal-clear"]),
						{
							...goalHostNodes,
							"host:goal-clear": (
								<button
									type="button"
									className="goalbar-x"
									title={t("goalBarClear")}
									onClick={() => appSend({ type: "clear_goal" })}
								>
									<FiX />
								</button>
							),
						},
						onUiAction,
					)}
				</div>
			</div>
		);
	}

	if (active) {
		return (
			<div className={`goalbar goalbar-active ${goal.reviewing ? "reviewing" : ""}`}>
				<div className="goalbar-active-row">
					<span className="goalbar-icon">{goal.reviewing ? <span className="goalbar-spin">◌</span> : "🎯"}</span>
					<span className="goalbar-text" title={goal.goal ?? ""}>
						{goal.goal}
					</span>
					{goal.reviewing ? (
						<span className="goalbar-chip reviewing">
							{goal.phase === "executing" ? t("goalBarExecuting") : t("goalBarReviewing")} {roundLabel}
						</span>
					) : (
						<span
							className={`goalbar-chip ${goal.verdict === "pass" ? "pass" : goal.verdict === "fail" ? "fail" : goal.verdict === "blocked" ? "blocked" : ""}`}
						>
							{goal.verdict === "pass"
								? t("goalBarPassed")
								: goal.verdict === "fail"
									? t("goalBarFailed")
									: goal.verdict === "blocked"
										? t("goalBarBlocked")
										: `${t("goalBarRound", { n: goal.round || 1 })} · ${goal.locked ? t("goalBarLocked") : t("goalBarUnlocked")}`}
						</span>
					)}
					<span className="goalbar-detail">{goalDetail}</span>
					{execActivity && (
						<span className="goalbar-detail" title={execRole?.convId}>
							· {execActivity}
						</span>
					)}
					{usageTotal > 0 && (
						<span
							className="goalbar-detail"
							title={`${goal.usage?.inputTokens ?? 0} in / ${goal.usage?.outputTokens ?? 0} out`}
						>
							· {fmtTok(usageTotal)} tokens
						</span>
					)}
					{staleBackend && <span className="goalbar-stale">{t("goalBarStaleBackend")}</span>}
					{renderMergedToolbar(
						goalZone(["host:goal-openrole", "host:goal-clear"]),
						{
							...goalHostNodes,
							// 目标模式 2.0：委托执行下把「执行对话」一键打开（左栏同样可点）。
							"host:goal-openrole": execRoleConvId ? (
								<button
									type="button"
									className="goalbar-icon-btn"
									title={t("goalBarOpenExecTip")}
									onClick={() => appSend({ type: "switch_conversation", id: execRoleConvId })}
								>
									<FiArrowUpRight />
								</button>
							) : null,
							"host:goal-clear": (
								<button
									type="button"
									className={`goalbar-x${goal.reviewing ? " stopping" : ""}`}
									title={goalLabel("host:goal-clear", goal.reviewing ? t("goalBarStop") : t("goalBarClear"))}
									onClick={() => appSend({ type: "clear_goal" })}
								>
									{goal.reviewing ? <FiSquare /> : <FiX />}
								</button>
							),
						},
						onUiAction,
					)}
				</div>
			</div>
		);
	}

	// 闲置：输入框上沿正中只剩一枚「新任务」胶囊（点开统一任务弹窗）；驾驶舱弹层开着时收起。
	// 胶囊在布局页藏掉且无插件条目时整条不占位（布局页「恢复」可找回）。
	if (popupOpen) return null;
	// 折叠态**刻意不带 `.goalbar` 类**：那一套是「整条面板」的皮（边框/底色/
	// 圆角/内边距），主题还可能用 `.goalbar { border-top: … }` 画一条通栏细线 ——
	// 收起时它就是一条横跨整列的带子，正好横在最后一条消息上把它
	// 切断（用户实报「折叠时一整行遮挡底部消息」）。折叠态只是消息区与输入框
	// 之间的一枚小胶囊：自带一个 flex 行、整行水平居中、不多占高度。
	return (
		<div className="goalbar-collapsed">
			{renderMergedToolbar(goalZone(["host:task-new"]), goalHostNodes, onUiAction)}
		</div>
	);
});
