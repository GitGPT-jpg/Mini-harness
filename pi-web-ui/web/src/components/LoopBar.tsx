import { memo, useEffect, useState } from "react";
import { FiRepeat, FiSquare } from "react-icons/fi";
import type { LoopUiState } from "../types";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { formatLoopElapsed } from "./BarItem";
import { openRunDetail, openTaskModal, useCockpitPopupOpen } from "../loop-cockpit";
import { canAcceptValidatorOnly, loopRoundText, loopStatus, retryPrefillOf, type LoopStatusKind } from "../loop-status";
import { TaskCapsule } from "./TaskModal";

/** 代码 loop 的状态条：运行中是「人话状态 · 轮次 · 耗时 + 停止」（epoch 停止 = 在途与迟到回调
 *  全部失效），终态一行结果 + 动作（评审掉线：重试评审 / 按代码验证收下；其余：重试 = 重开新任务
 *  弹窗并带回目标、验收标准与验收方式）。状态文字可点，打开任务详情（RunDetailModal）。
 *  人话状态统一由 loop-status.ts 产出。启动表单是 TaskModal。
 *  Props 刻意收窄，token 流式期间浅比较直接跳过重渲染。 */

interface Props {
	loop: LoopUiState | null;
	/** 目标模式开着时「新任务」胶囊画在目标条折叠行里，这里不再重复画。 */
	goalModeEnabled: boolean;
}

/** 终态行首的小符号：交卷 ✓ / 裁判掉线 ⚠ / 用户停的 ⏹ / 其余没过或出错 ✗。 */
function terminalMark(kind: LoopStatusKind): string {
	if (kind === "done" || kind === "done-validator-only" || kind === "done-self-declared") return "✓";
	if (kind === "reviewer-error") return "⚠";
	if (kind === "user-stop" || kind === "stopped-other") return "⏹";
	return "✗";
}

export const LoopBar = memo(function LoopBar({ loop, goalModeEnabled }: Props) {
	const t = useT();
	const popupOpen = useCockpitPopupOpen();
	// active（pending 或 active run）时秒级 tick 刷耗时
	const active = loop?.kind === "pending" || (loop?.kind === "run" && loop.status === "active");
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [active]);

	const elapsed = loop ? formatLoopElapsed(now - new Date(loop.createdAt).getTime()) : "";
	const runId = loop?.kind === "run" ? loop.runId : undefined;
	const detailTip = loop ? `${t("loopOpenDetail")}\n${loop.goal}` : "";

	// —— 运行中：紧凑状态条（人话状态 · 轮次 · 耗时 + 停止）——
	if (loop && active) {
		const st = loopStatus(loop, t);
		const text = `${st.text} · ${elapsed}`;
		return (
			<div className={`goalbar loopbar-card tone-${st.tone} is-active`}>
				<div className="goalbar-row">
					<span className="goalbar-icon">
						<FiRepeat />
					</span>
					{runId ? (
						<button
							type="button"
							className={`loopbar-status tone-${st.tone}`}
							title={detailTip}
							onClick={() => openRunDetail(runId)}
						>
							{text}
						</button>
					) : (
						<span className={`loopbar-status tone-${st.tone}`} title={loop.goal}>
							{text}
						</span>
					)}
					<span className="goalbar-detail">· {loop.mode === "llm" ? t("loopBarModeLlm") : t("loopBarModeCode")}</span>
					<button
						type="button"
						className="goalbar-x stopping"
						title={t("loopStop")}
						onClick={() => appSend({ type: "loop_stop", runId })}
					>
						<FiSquare />
					</button>
				</div>
			</div>
		);
	}

	// —— 终态（done/stopped/request-failed）：一行结果（可点开详情）+ 动作 ——
	if (
		loop &&
		(loop.kind === "request-failed" || (loop.kind === "run" && (loop.status === "done" || loop.status === "stopped")))
	) {
		const st = loopStatus(loop, t);
		const label = `${terminalMark(st.kind)} ${st.text}`;
		const suffix = loop.kind === "request-failed" ? "" : [loopRoundText(t, loop), elapsed].filter(Boolean).join(" · ");
		const reviewerDown = st.kind === "reviewer-error" && !!runId;
		return (
			<div className={`goalbar loopbar-card tone-${st.tone} is-terminal`}>
				<div className="goalbar-row">
					<span className="goalbar-icon">
						<FiRepeat />
					</span>
					{runId ? (
						<button
							type="button"
							className={`loopbar-status tone-${st.tone}`}
							title={detailTip}
							onClick={() => openRunDetail(runId)}
						>
							{label}
						</button>
					) : (
						<span className={`loopbar-status tone-${st.tone}`} title={loop.goal}>
							{label}
						</span>
					)}
					{suffix && <span className="goalbar-detail">· {suffix}</span>}
					{reviewerDown ? (
						<>
							<button
								type="button"
								className="goalbar-btn action"
								title={t("loopRetryReviewTip")}
								onClick={() => appSend({ type: "loop_resume", runId })}
							>
								{t("loopRetryReview")}
							</button>
							{canAcceptValidatorOnly(loop) && (
								<button
									type="button"
									className="goalbar-btn subtle"
									title={t("loopAcceptCodeTip")}
									onClick={() => appSend({ type: "loop_accept", runId })}
								>
									{t("loopAcceptCode")}
								</button>
							)}
						</>
					) : (
						<button
							type="button"
							className="goalbar-btn action"
							title={t("loopRetry")}
							onClick={() => openTaskModal(retryPrefillOf(loop))}
						>
							{t("loopRetry")}
						</button>
					)}
				</div>
			</div>
		);
	}

	// —— 闲置：「新任务」胶囊（复用 TaskCapsule，渲染在输入框上沿）。
	if (goalModeEnabled || popupOpen) return null;
	return (
		<div className="goalbar-collapsed loopbar-collapsed-solo">
			<TaskCapsule />
		</div>
	);
});
