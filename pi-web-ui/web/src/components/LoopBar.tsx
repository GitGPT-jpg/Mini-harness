import { memo, useEffect, useState } from "react";
import { FiCode, FiRepeat, FiSquare } from "react-icons/fi";
import type { LoopUiState } from "../types";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { formatLoopElapsed, loopStageText } from "./BarItem";
import { openCodeLoop, useCockpitPopupOpen } from "../loop-cockpit";

/** 代码 loop 的状态条：运行中是「阶段 · 轮次 · 耗时 + 停止」（epoch 停止 = 在途与迟到回调
 *  全部失效），终态一行结果 + 重试（重开启动弹窗并带回 goal）。启动表单是 CodeLoopModal。
 *  Props 刻意收窄，token 流式期间浅比较直接跳过重渲染。 */

interface Props {
	loop: LoopUiState | null;
	/** 目标模式开着时入口胶囊画在目标条折叠行里，这里不再重复画。 */
	goalModeEnabled: boolean;
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
	const roundLabel =
		loop?.round !== undefined ? (loop.maxRounds ? `${loop.round}/${loop.maxRounds}` : `${loop.round}`) : "";

	// —— 运行中：紧凑状态条（阶段 · 轮次 · 耗时 + 停止）——
	if (active) {
		return (
			<div className="goalbar">
				<div className="goalbar-row">
					<span className="goalbar-icon">
						<FiRepeat />
					</span>
					<span className="goalbar-detail" title={loop?.goal ?? ""}>
						{loop?.kind === "pending"
							? t("loopStatusStarting")
							: `${loopStageText(t, loop?.stage)}${roundLabel ? ` · ${roundLabel}` : ""} · ${elapsed}`}
					</span>
					<span className="goalbar-detail">· {loop?.mode === "llm" ? t("loopBarModeLlm") : t("loopBarModeCode")}</span>
					<button
						type="button"
						className="goalbar-x stopping"
						title={t("loopStop")}
						onClick={() => appSend({ type: "loop_stop", runId: loop?.runId })}
					>
						<FiSquare />
					</button>
				</div>
			</div>
		);
	}

	// —— 终态（done/stopped/request-failed）：一行结果 + 一键重试 ——
	if (
		loop &&
		(loop.kind === "request-failed" || (loop.kind === "run" && (loop.status === "done" || loop.status === "stopped")))
	) {
		const failed = loop.kind === "request-failed";
		const done = !failed && loop.status === "done";
		const tail = failed
			? `${t("loopStatusFailed")}${loop.reason ? `：${loop.reason}` : ""}`
			: done
				? `${t("loopStatusDone")}${loop.lastVerdict ? ` · ${loop.lastVerdict === "pass" ? t("loopVerdictPass") : t("loopVerdictFail")}` : ""} · ${roundLabel} · ${elapsed}`
				: `${t("loopStatusStopped")}${loop.stopReason ? `：${loop.stopReason}` : ""} · ${roundLabel} · ${elapsed}`;
		return (
			<div className="goalbar">
				<div className="goalbar-row">
					<span className="goalbar-icon">
						<FiRepeat />
					</span>
					<span className="goalbar-detail" title={loop.goal}>
						{failed ? "✗ " : done ? "✓ " : "⏹ "}
						{tail}
					</span>
					<button
						type="button"
						className="goalbar-btn action"
						title={t("loopRetry")}
						onClick={() => openCodeLoop(loop.goal)}
					>
						{t("loopRetry")}
					</button>
				</div>
			</div>
		);
	}

	// —— 闲置：代码 loop 入口胶囊与 LLM loop 胶囊成对居中，画在目标条折叠行里（GoalBar）；
	//    目标模式关掉时目标条不渲染，这里补一枚同款胶囊，入口不丢。弹窗打开时隐藏。 ——
	if (goalModeEnabled || popupOpen) return null;
	return (
		<div className="goalbar-collapsed loopbar-collapsed-solo">
			<button
				type="button"
				className="goalbar-hint loop-capsule code"
				title={t("codeLoopPillTip")}
				onClick={() => openCodeLoop()}
			>
				<FiCode /> <span>{t("loopBarTitle")}</span>
			</button>
		</div>
	);
});
