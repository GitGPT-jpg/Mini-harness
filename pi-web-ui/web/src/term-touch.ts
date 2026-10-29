/**
 * 手机端终端触摸滚动手势判定（纯函数，便于单测）。
 *
 * 背景（issue #218）：xterm 6.0.0 有触摸滚动回归（上游 xtermjs/xterm.js#5489，
 * 6.0.0 引入 #5096 后 `src/browser/**` 下零 touch 处理），手指在终端区域
 * 上下拖动没有任何反应。手机上没有 PgUp/PgDn，面板里也没有翻页按钮，
 * 一屏之后的历史输出完全看不到。
 *
 * 本地兜底策略（issue 里方案 C）：把单指竖直拖动合成 `WheelEvent` 派发到
 * `.xterm-viewport`，直接复用 xterm 自己的滚轮链路（含 scrollSensitivity、
 * alt 缓冲 / TUI 鼠标协议三路分发），改动最小。
 *
 * ⚠️ xterm 上游已在 #5685 把触摸滚动做进内核（6.1.0-beta.304 起含
 * `_handleTouchScrollAsWheel` 等符号）。升级到带该修复的正式版后即可
 * 删掉本文件 + TermXterm 里合成事件的那段监听。
 */

/** 开始劫持为滚动之前，手指竖向位移至少要超过的像素数（轻点/长按选择不受影响）。 */
export const TOUCH_SCROLL_THRESHOLD_PX = 10;

/**
 * 竖直手势 vs 水平手势的 dominance 系数：|dy| 必须超过 |dx| 的该倍数
 * 才算竖直滚动。横向拖动让给选择/其他手势，不劫持。
 */
export const TOUCH_SCROLL_AXIS_RATIO = 1.2;

/**
 * 该手势是否应被劫持为滚动（从手势起点算起的总位移）。
 * 阈值之内一律不劫持，保证轻点、长按选择、双击不受影响。
 */
export function shouldStartTouchScroll(totalDx: number, totalDy: number): boolean {
	return (
		Math.abs(totalDy) > TOUCH_SCROLL_THRESHOLD_PX && Math.abs(totalDy) > Math.abs(totalDx) * TOUCH_SCROLL_AXIS_RATIO
	);
}

/**
 * 本次 move 应合成的 wheel deltaY（DOM wheel 约定：deltaY > 0 = 向新内容滚）。
 * 手指跟着内容走（`scrollTop -= translationY`，与上游 #5685 同语义）：
 * 手指向下拖（translationY > 0，内容跟着往下）→ 看到更旧的输出 → wheel 为负。
 */
export function touchWheelDeltaY(lastClientY: number, curClientY: number): number {
	return lastClientY - curClientY;
}
