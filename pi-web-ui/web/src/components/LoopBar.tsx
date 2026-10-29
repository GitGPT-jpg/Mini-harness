import { memo, useEffect, useState } from "react";
import { FiRepeat, FiSquare, FiChevronUp } from "react-icons/fi";
import type { LoopUiState } from "../types";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { formatLoopElapsed, loopStageText } from "./BarItem";

/** 紧凑 Loop 入口：闲置时是输入框上方居中的一枚小药丸（与 GoalBar 同视觉语言），
 *  点击展开一行式启动器（goal / 模式 / 验证命令 / 轮数上限 / Reviewer）；
 *  运行中变成「阶段 · 轮次 · 耗时 + 停止」状态条（epoch 停止 = 在途与迟到回调全部失效）。
 *  Props 刻意收窄（只传 loop），token 流式期间浅比较直接跳过重渲染。 */

interface Props {
	loop: LoopUiState | null;
}

export const LoopBar = memo(function LoopBar({ loop }: Props) {
	const t = useT();
	const [open, setOpen] = useState(false);
	// 编辑器草稿
	const [text, setText] = useState("");
	const [mode, setMode] = useState<"code" | "llm">("code");
	const [validateCmd, setValidateCmd] = useState("");
	const [maxRounds, setMaxRounds] = useState(0);
	const [useReviewer, setUseReviewer] = useState(true);
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
						onClick={() => {
							setText(loop.goal);
							setOpen(true);
						}}
					>
						{t("loopRetry")}
					</button>
				</div>
			</div>
		);
	}

	// —— 闲置折叠：右端小药丸（居中让给目标药丸，见 .loopbar-collapsed） ——
	if (!open) {
		return (
			<div className="loopbar-collapsed">
				<button type="button" className="goalbar-hint" title={t("loopBarPlaceholder")} onClick={() => setOpen(true)}>
					<FiRepeat /> <span>{t("loopBarTitle")}</span>
				</button>
			</div>
		);
	}

	// —— 展开编辑器：goal / 模式 / 验证命令 / 轮数 / Reviewer ——
	const start = () => {
		const goal = text.trim();
		if (!goal) return;
		appSend({
			type: "loop_start_request",
			goal,
			mode,
			...(validateCmd.trim() ? { validateCmd: validateCmd.trim() } : {}),
			...(maxRounds > 0 ? { maxRounds } : {}),
			...(mode === "code" && !useReviewer ? { useReviewer: false } : {}),
		});
		setText("");
		setOpen(false);
	};

	return (
		<div className="goalbar">
			<div className="goalbar-row">
				<span className="goalbar-icon">
					<FiRepeat />
				</span>
				<input
					className="goalbar-input"
					autoFocus
					value={text}
					placeholder={t("loopBarPlaceholder")}
					title={t("loopBarPlaceholder")}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") start();
					}}
				/>
				<button
					type="button"
					className={"goalbar-btn" + (mode === "code" ? " action" : "")}
					title={t("loopBarModeCode")}
					onClick={() => setMode("code")}
				>
					{t("loopBarModeCode")}
				</button>
				<button
					type="button"
					className={"goalbar-btn" + (mode === "llm" ? " action" : "")}
					title={t("loopBarModeLlm")}
					onClick={() => setMode("llm")}
				>
					{t("loopBarModeLlm")}
				</button>
				<button type="button" className="goalbar-btn" disabled={!text.trim()} onClick={start}>
					{t("loopBarStart")}
				</button>
				<button type="button" className="goalbar-icon-btn" title={t("cancel")} onClick={() => setOpen(false)}>
					<FiChevronUp />
				</button>
			</div>
			<div className="goalbar-opts">
				<label className="goalbar-round" title={t("loopBarValidateCmd")}>
					<span>{t("loopBarValidateCmd")}</span>
					<input
						type="text"
						value={validateCmd}
						placeholder="npm test"
						onChange={(e) => setValidateCmd(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") start();
						}}
					/>
				</label>
				<label className="goalbar-round" title={t("loopBarMaxRounds")}>
					<span>{t("loopBarMaxRounds")}</span>
					<input
						type="number"
						min={0}
						step={1}
						value={maxRounds}
						placeholder={t("goalBarUnlimitedShort")}
						onChange={(e) => {
							const v = parseInt(e.target.value, 10);
							setMaxRounds(Number.isNaN(v) || v < 0 ? 0 : v);
						}}
					/>
				</label>
				<label className="goalbar-round" title={t("loopBarUseReviewer")}>
					<input type="checkbox" checked={useReviewer} onChange={(e) => setUseReviewer(e.target.checked)} />
					<span>{t("loopBarUseReviewer")}</span>
				</label>
			</div>
		</div>
	);
});
