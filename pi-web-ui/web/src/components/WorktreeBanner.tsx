/**
 * web/src/components/WorktreeBanner.tsx
 *
 * 顶部 Git 工作树（Worktree）状态横幅：
 * 1. 状态一：当前工作区正处于某个子工作树（Linked Worktree）内：
 *    - 强视觉提示当前分支与关联主仓库；
 *    - 一键切回主仓库 (main)；
 *    - 一键清理/销毁工作树。
 * 2. 状态二：当前在主仓库，名下有关联工作树：
 *    - 默认只列出当前任务的工作树（分支 mini-harness/<runId>）和含未提交改动的工作树；
 *    - 其余收进「更多」，展开后仍可查看状态（未提交改动 / 领先提交数）并切换过去。
 */

import React, { useState, useEffect } from "react";
import type { LinkedWorktreeEntry, WorktreeInfo } from "../types";
import { useT } from "../i18n";
import { FiX } from "react-icons/fi";

export interface WorktreeBannerProps {
	worktree: WorktreeInfo;
	/** 当前对话的代码任务 runId：它的工作树在首页突出显示。 */
	taskRunId?: string | null;
	onSwitch: (path: string) => void;
	onRemove: (path: string, force?: boolean) => void;
}

/** 首页直接列出的工作树上限，超出的并入「更多」。 */
const FOCUS_MAX = 3;

const getFolderName = (p: string) => {
	const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
	return parts[parts.length - 1] || p;
};

/** 任务工作树：分支 mini-harness/<runId>，目录 <runsRoot>/<runId>/worktree。 */
export function isTaskWorktree(w: LinkedWorktreeEntry, runId: string | null | undefined): boolean {
	if (!runId) return false;
	return w.branch === `mini-harness/${runId}` || w.path.replace(/\\/g, "/").endsWith(`/${runId}/worktree`);
}

const readDismissed = (key: string, sig: string) => {
	try {
		return sessionStorage.getItem(key) === sig;
	} catch {
		return false;
	}
};

export const WorktreeBanner: React.FC<WorktreeBannerProps> = ({ worktree, taskRunId, onSwitch, onRemove }) => {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const linked = worktree.linkedWorktrees || [];
	const linkedSig = linked
		.map((w) => `${w.path}:${w.branch ?? ""}:${w.isDirty}`)
		.sort()
		.join(";");
	const dismissKey = `pi-worktree-dismiss:${worktree.mainPath}`;
	const [isDismissed, setIsDismissed] = useState(() => readDismissed(dismissKey, linkedSig));
	useEffect(() => {
		setIsDismissed(readDismissed(dismissKey, linkedSig));
	}, [dismissKey, linkedSig]);

	// 状态一：当前工作区就是子工作树
	if (worktree.isLinkedWorktree) {
		const branchName = worktree.branch || getFolderName(worktree.currentPath);
		return (
			<div className="worktree-banner linked" role="region" aria-label={branchName}>
				<div className="worktree-banner-info">
					<span className="worktree-banner-title">
						🌿 {t("worktreeBannerActiveTitle", { branch: branchName })}
						<span className="lp-worktree-badge linked">{t("worktreeBadgeLinked")}</span>
					</span>
					<span className="worktree-banner-desc">
						{t("worktreeBannerActiveDesc", {
							main: worktree.mainPath,
							mainBranch: worktree.mainBranch || "main",
						})}
					</span>
				</div>
				<div className="worktree-banner-actions">
					<button
						type="button"
						className="worktree-banner-btn primary"
						title={t("worktreeActionSwitchMainTip")}
						onClick={() => onSwitch(worktree.mainPath)}
					>
						⬅️ {t("worktreeActionSwitchMain")}
					</button>
					<button
						type="button"
						className="worktree-banner-btn danger"
						title={t("worktreeActionRemoveTip")}
						onClick={() => {
							if (window.confirm(t("worktreeActionRemoveConfirm", { path: branchName }))) {
								onRemove(worktree.currentPath);
							}
						}}
					>
						🗑️ {t("worktreeActionRemove")}
					</button>
				</div>
			</div>
		);
	}

	// 状态二：当前在主仓库，名下有关联工作树
	if (linked.length === 0 || isDismissed) {
		return null;
	}

	const handleDismiss = () => {
		setIsDismissed(true);
		try {
			sessionStorage.setItem(dismissKey, linkedSig);
		} catch {
			// ignore
		}
	};

	// 首页只突出当前任务的工作树和含未提交改动的工作树，其余收进「更多」
	const isTask = (w: LinkedWorktreeEntry) => isTaskWorktree(w, taskRunId);
	const focus = [...linked.filter(isTask), ...linked.filter((w) => w.isDirty && !isTask(w))];
	const shown = focus.slice(0, FOCUS_MAX);
	const rest = linked.filter((w) => !shown.includes(w));
	const dirtyCount = linked.filter((w) => w.isDirty).length;

	const row = (wt: LinkedWorktreeEntry) => {
		const name = wt.branch || getFolderName(wt.path);
		return (
			<div key={wt.path} className="worktree-expand-row" data-worktree-path={wt.path}>
				<span className="worktree-expand-name" title={wt.path}>
					<span className="worktree-expand-label">{name}</span>
					{isTask(wt) && <span className="lp-worktree-badge task">{t("worktreeTagTask")}</span>}
					{wt.isDirty ? (
						<span className="lp-worktree-badge dirty">
							{t("worktreeBadgeDirtyCount", { count: wt.uncommittedCount || 1 })}
						</span>
					) : (
						<span className="lp-worktree-badge plain">{t("worktreeTagClean")}</span>
					)}
					{!!wt.aheadCount && (
						<span className="lp-worktree-badge plain">{t("worktreeTagAhead", { count: wt.aheadCount })}</span>
					)}
				</span>
				<div className="worktree-expand-actions">
					<button
						type="button"
						className="worktree-banner-btn"
						title={t("worktreeActionSwitchToTip", { name })}
						onClick={() => onSwitch(wt.path)}
					>
						➡️ {t("worktreeActionSwitch")}
					</button>
					<button
						type="button"
						className="worktree-banner-btn danger"
						title={t("worktreeActionRemoveTip")}
						aria-label={t("worktreeActionRemove")}
						onClick={() => {
							if (window.confirm(t("worktreeActionRemoveConfirm", { path: name }))) {
								onRemove(wt.path);
							}
						}}
					>
						🗑️
					</button>
				</div>
			</div>
		);
	};

	return (
		<div className={`worktree-banner ${dirtyCount > 0 ? "notice" : "quiet"}`} role="region" aria-label="Git Worktrees">
			<div className="worktree-banner-info">
				<span className="worktree-banner-title">
					{dirtyCount > 0 ? "⚠️" : "🌿"} {t("worktreeBannerLinkedTitle", { count: linked.length })}
					{dirtyCount > 0 && (
						<span className="lp-worktree-badge dirty">{t("worktreeDirtyTrees", { count: dirtyCount })}</span>
					)}
				</span>
				{shown.length === 0 && <span className="worktree-banner-desc">{t("worktreeBannerNoFocus")}</span>}
			</div>
			<div className="worktree-banner-actions">
				{rest.length > 0 && (
					<button
						type="button"
						className="worktree-banner-btn worktree-more-toggle"
						aria-expanded={expanded}
						onClick={() => setExpanded(!expanded)}
					>
						{expanded ? t("worktreeActionCollapse") : t("worktreeActionMore", { count: rest.length })}
					</button>
				)}
				<button
					type="button"
					className="worktree-banner-close"
					title={t("worktreeActionDismissTip")}
					aria-label={t("worktreeActionDismiss")}
					onClick={handleDismiss}
				>
					<FiX aria-hidden />
				</button>
			</div>
			{shown.length > 0 && <div className="worktree-banner-expand worktree-focus">{shown.map(row)}</div>}
			{expanded && rest.length > 0 && <div className="worktree-banner-expand worktree-more">{rest.map(row)}</div>}
		</div>
	);
};
