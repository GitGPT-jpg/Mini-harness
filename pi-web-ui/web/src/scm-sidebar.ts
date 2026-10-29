/**
 * Git 面板左栏（改动文件 / 提交历史）宽度的读取与夹取（issue #139）。
 *
 * 只放可单测的纯计算：拖拽位移 → 宽度夹取、localStorage 存档解析；量容器宽度、
 * 挂 pointer 事件、写存档留在 `components/SCMPanel.tsx`（与左/右主面板的
 * ResizeHandle 同一套手感：拖动改宽度、双击复位）。
 */

/** 默认宽度 —— 与「左栏固定 300px」时代的观感一致。 */
export const SCM_SIDEBAR_DEFAULT = 300;
/** 左栏最小宽度：再窄分支名 / 文件路径就没法看了。 */
export const SCM_SIDEBAR_MIN = 200;
/** 左栏最大宽度：宽屏下也不至于把 diff 区挤没。 */
export const SCM_SIDEBAR_MAX = 720;
/** diff 区至少要留下的宽度（拖到容器右边界时按它收敛）。 */
export const SCM_DIFF_MIN = 220;
/** 跨会话记忆的 localStorage 键。 */
export const SCM_SIDEBAR_WIDTH_KEY = "pi-web-ui:scm-sidebar-width";

/**
 * 把宽度夹到 [SCM_SIDEBAR_MIN, SCM_SIDEBAR_MAX]，并在量到容器宽度时给 diff 区
 * 留出 SCM_DIFF_MIN。容器窄到装不下两个最小值时以最小宽度为准（不退化成 0）。
 */
export function clampScmSidebarWidth(width: number, containerPx = 0): number {
	if (!Number.isFinite(width)) return SCM_SIDEBAR_DEFAULT;
	// 容器越窄，上限越低；但上限不得低于最小值，否则夹取区间为空。
	const upper = Math.max(
		SCM_SIDEBAR_MIN,
		Math.min(SCM_SIDEBAR_MAX, containerPx > 0 ? containerPx - SCM_DIFF_MIN : SCM_SIDEBAR_MAX),
	);
	return Math.min(upper, Math.max(SCM_SIDEBAR_MIN, Math.round(width)));
}

/** 解析 localStorage 存档：缺失 / 空串 / 坏值都回落默认宽度。 */
export function parseScmSidebarWidth(raw: string | null): number {
	if (raw === null || raw.trim() === "") return SCM_SIDEBAR_DEFAULT;
	return clampScmSidebarWidth(Number(raw));
}
