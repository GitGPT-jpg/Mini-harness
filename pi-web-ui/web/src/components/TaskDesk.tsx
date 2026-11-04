import { memo, useEffect, useState, type KeyboardEvent } from "react";
import { FiList } from "react-icons/fi";
import type { GoalStatus } from "../types";
import { isZhLocale, useI18n, useT } from "../i18n";
import { appSend } from "../app-globals";
import { closeTaskDesk, mhGet, mhPost, openRunDetail, useCockpit } from "../loop-cockpit";
import { loopStatus, recoveryBadgeOf, type LoopTone } from "../loop-status";
import { Modal } from "./Modal";

/** GET /api/mini-harness/runs 的一行（server/loop/routes.ts 的 LoopRunBrief，这里只取用到的字段）。 */
interface RunBrief {
	runId: string;
	stage: string;
	round: number;
	maxRounds: number;
	status: string;
	lastVerdict: string | null;
	goal: string;
	project: string;
	updatedAt: string | null;
	mode?: "code" | "llm";
	stopReason?: string | null;
	acceptance?: string | null;
	recovery?: { unit?: string | null } | null;
}

/** 运行行左边那条色线：沿用任务台已有的三种（进行中紫 / 通过绿 / 出错红），另加一档黄。 */
const ROW_TONE: Record<LoopTone, string> = { busy: "run", ok: "ok", warn: "warn", bad: "err", idle: "" };

/** LLM loop 永久目录的一行（server/goal-history-log.ts 的 GoalLogRecord）。 */
interface GoalRecord {
	id: string;
	at: string;
	goal: string;
	kind: string;
	round: number;
	verdict: string;
}

/** 执行者工具调用时间线的一条（server/loop/routes.ts 的 ToolEvent）。 */
interface ToolEvent {
	id: string;
	name: string;
	arg: string;
	status: "running" | "done" | "error";
	ms: number | null;
	out: string;
}

type Phase = "idle" | "surveying" | "executing" | "reviewing" | "done" | "blocked" | "paused";

function phaseOf(g: GoalStatus, wizardActive: boolean): Phase {
	if (g.paused || g.phase === "paused") return "paused";
	if (wizardActive) return "surveying";
	if (g.phase === "reviewing") return "reviewing";
	if (g.phase === "executing") return "executing";
	if (g.verdict === "pass") return "done";
	if (g.phase === "blocked" || g.verdict === "blocked" || g.verdict === "fail") return "blocked";
	return "idle";
}

const STEP_INDEX: Record<Phase, number> = {
	idle: -1,
	paused: -1,
	surveying: 0,
	executing: 1,
	reviewing: 2,
	done: 3,
	blocked: 3,
};

interface Props {
	goal: GoalStatus;
	activeConversationId: string;
}

/** Loop 任务台：右侧抽屉。当前 LLM loop 的进度 / 执行者工具调用时间线 / 暂停·继续·停止，
 *  以及 LLM loop 永久目录与代码 loop 运行列表（都可删除；代码 loop 的行点开 = 任务详情）。打开时才轮询。 */
export const TaskDesk = memo(function TaskDesk({ goal, activeConversationId }: Props) {
	const open = useCockpit("taskDeskOpen");
	const runsVersion = useCockpit("runsVersion");
	const t = useT();
	const { locale } = useI18n();
	const [runs, setRuns] = useState<RunBrief[] | null>(null);
	const [goals, setGoals] = useState<GoalRecord[] | null>(null);
	const [events, setEvents] = useState<ToolEvent[] | null>(null);
	const [reload, setReload] = useState(0);

	const mine = !goal.conversationId || goal.conversationId === activeConversationId;
	const wizardActive = mine && (goal.wizard?.active ?? false);
	const hasGoal = mine && (goal.goal !== null || wizardActive);
	const sessionId = mine ? (goal.roles?.executor?.sessionId ?? null) : null;

	useEffect(() => {
		if (!open) return;
		let alive = true;
		const load = async () => {
			const [r, g] = await Promise.all([
				mhGet<{ runs: RunBrief[] }>("runs?history=1"),
				mhGet<{ goals: GoalRecord[] }>("goals"),
			]);
			if (!alive) return;
			setRuns(r?.runs ?? []);
			setGoals(g?.goals ?? []);
		};
		void load();
		const id = setInterval(() => {
			if (!document.hidden) void load();
		}, 3000);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [open, reload, runsVersion]);

	useEffect(() => {
		if (!open || !sessionId) {
			setEvents(null);
			return;
		}
		let alive = true;
		const load = async () => {
			const j = await mhGet<{ events: ToolEvent[] }>(`task?session=${encodeURIComponent(sessionId)}`);
			if (alive && j) setEvents(j.events ?? []);
		};
		void load();
		const id = setInterval(() => {
			if (!document.hidden) void load();
		}, 1500);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [open, sessionId]);

	if (!open) return null;

	const del = async (path: string, body: unknown, confirmText: string) => {
		if (!window.confirm(confirmText)) return;
		await mhPost(path, body);
		setReload((n) => n + 1);
	};
	const status = !isZhLocale(locale) && goal.statusEn ? goal.statusEn : goal.status || "";
	const phase = phaseOf(goal, wizardActive);
	const paused = phase === "paused";
	const canPause = paused || phase === "executing" || phase === "reviewing";
	const stepIdx = STEP_INDEX[phase];
	const steps = [t("taskDeskStepSurvey"), t("taskDeskStepExec"), t("taskDeskStepReview"), t("taskDeskStepDone")];
	const activeRuns = (runs ?? []).filter((r) => r.status === "active").length;
	const verdictText = (v: string | null) =>
		v === "pass" ? t("loopVerdictPass") : v === "fail" ? t("loopVerdictFail") : "—";

	return (
		<Modal
			className="task-desk"
			backdropClassName="task-desk-backdrop"
			onClose={closeTaskDesk}
			title={t("taskDeskTitle")}
			icon={<FiList />}
		>
			<div className="task-desk-body">
				<div className="task-desk-sec">{t("taskDeskCatalog")}</div>
				<div className="task-desk-cat">
					<div className="task-desk-cat-item" data-on={hasGoal ? "1" : undefined}>
						<b>LLM loop</b>
						<span>{hasGoal ? status || phase : t("taskDeskNoGoal")}</span>
					</div>
					<div className="task-desk-cat-item" data-on={activeRuns > 0 ? "1" : undefined}>
						<b>{t("loopBarTitle")}</b>
						<span>
							{runs === null
								? t("taskDeskLoading")
								: runs.length
									? t("taskDeskRunsSummary", { active: activeRuns, total: runs.length })
									: t("taskDeskNoRuns")}
						</span>
					</div>
				</div>

				{hasGoal && (
					<>
						<div className="task-desk-goal">{goal.goal ?? goal.wizard?.draft ?? ""}</div>
						<div className="task-desk-meta">
							<span className="task-desk-chip">{status || phase}</span>
							<span className="task-desk-chip">
								{t("taskDeskRounds", {
									n: `${goal.round || 0}/${goal.locked && goal.maxRounds > 0 ? goal.maxRounds : t("goalBarUnlimitedShort")}`,
								})}
							</span>
							{goal.execModel && (
								<span className="task-desk-chip">
									{t("taskDeskExec", { m: goal.execModel.split("/").pop() ?? "" })}
								</span>
							)}
						</div>
						<div className="task-desk-steps">
							{steps.map((s, i) => (
								<div key={s} className={`task-desk-step${stepIdx > i ? " done" : stepIdx === i ? " on" : ""}`}>
									{s}
								</div>
							))}
						</div>
						<div className="task-desk-sec">
							<span>{t("taskDeskToolCalls")}</span>
							{events && events.length > 0 && <span>{t("taskDeskCount", { n: events.length })}</span>}
						</div>
						{events && events.length > 0 ? (
							events
								.slice()
								.reverse()
								.map((e) => (
									<div
										key={e.id}
										className={`task-desk-ev ${e.status === "running" ? "run" : e.status === "error" ? "err" : "ok"}`}
									>
										<span className="nm">{e.name}</span> <span className="ar">{e.arg}</span>
										<div className="out">
											{e.status === "running"
												? t("taskDeskRunning")
												: e.status === "error"
													? t("taskDeskToolFailed")
													: `${t("taskDeskToolDone")}${e.ms !== null ? ` · ${e.ms}ms` : ""}`}
											{e.out ? ` · ${e.out.slice(0, 140)}` : ""}
										</div>
									</div>
								))
						) : (
							<div className="task-desk-empty">{t("taskDeskWaiting")}</div>
						)}
					</>
				)}

				<div className="task-desk-sec">{t("taskDeskGoalHistory")}</div>
				{goals === null ? (
					<div className="task-desk-empty">{t("taskDeskLoading")}</div>
				) : goals.length === 0 ? (
					<div className="task-desk-empty">{t("taskDeskNoGoalHistory")}</div>
				) : (
					goals.map((g) => {
						const finished = g.kind.startsWith("finished");
						return (
							<div key={g.id} className={`task-desk-ev ${finished ? "ok" : "run"}`}>
								<button
									type="button"
									className="task-desk-del"
									onClick={() => void del("goals/delete", { id: g.id }, t("taskDeskDeleteGoalConfirm"))}
								>
									{t("taskDeskDelete")}
								</button>
								<span className="nm">{g.goal.slice(0, 70)}</span>
								<div className="out">
									{finished ? verdictText(g.verdict) : t("taskDeskInProgress")} ·{" "}
									{String(g.at).replace("T", " ").slice(5, 16)} · {t("goalBarRound", { n: g.round || 0 })}
								</div>
							</div>
						);
					})
				)}

				<div className="task-desk-sec">{t("taskDeskCodeRuns")}</div>
				{runs === null ? (
					<div className="task-desk-empty">{t("taskDeskLoading")}</div>
				) : runs.length === 0 ? (
					<div className="task-desk-empty">{t("taskDeskNone")}</div>
				) : (
					runs.map((r) => {
						const st = loopStatus(r, t);
						const rec = recoveryBadgeOf(r.recovery, t);
						const openDetail = () => openRunDetail(r.runId);
						const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
							if (e.target !== e.currentTarget) return;
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								openDetail();
							}
						};
						return (
							<div
								key={r.runId}
								className={`task-desk-ev task-desk-run ${ROW_TONE[st.tone]}`}
								data-run-id={r.runId}
								role="button"
								tabIndex={0}
								title={`${t("loopOpenDetail")}\n${r.goal}`}
								onClick={openDetail}
								onKeyDown={onKey}
							>
								<button
									type="button"
									className="task-desk-del"
									onClick={(e) => {
										e.stopPropagation();
										// 与任务详情共用删除确认：说明会移除什么、停止待确认 / 工作树有未提交改动时拦下
										openRunDetail(r.runId, "delete");
									}}
								>
									{t("taskDeskDelete")}
								</button>
								<span className="nm">{r.goal.slice(0, 70) || r.runId}</span>
								<div className={`task-desk-run-status tone-${st.tone}`}>{st.text}</div>
								{rec && (
									<div className={`task-desk-recovery tone-${rec.tone}`} title={r.recovery?.unit ?? ""}>
										{rec.label}
									</div>
								)}
								<div className="out">
									{[r.project, r.updatedAt ? String(r.updatedAt).replace("T", " ").slice(5, 16) : ""]
										.filter(Boolean)
										.join(" · ")}
								</div>
							</div>
						);
					})
				)}
			</div>
			{hasGoal && !wizardActive && goal.goal && (
				<div className="task-desk-acts">
					{canPause && (
						<button
							type="button"
							className="btn primary"
							onClick={() => appSend({ type: paused ? "resume_goal" : "pause_goal" })}
						>
							{paused ? t("taskDeskResume") : t("taskDeskPause")}
						</button>
					)}
					<button
						type="button"
						className="btn sm danger"
						onClick={() => {
							if (window.confirm(t("taskDeskStopConfirm"))) appSend({ type: "clear_goal" });
						}}
					>
						{t("taskDeskStop")}
					</button>
				</div>
			)}
		</Modal>
	);
});
