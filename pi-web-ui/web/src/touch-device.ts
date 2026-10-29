/**
 * 触屏优先设备判定 —— 决定输入框里「回车」是发送还是换行。
 *
 * 手机/平板（软键盘）没有物理 Shift，回车必须换行，发送走界面上的按钮；
 * 但**不能只看 `(pointer: coarse)`**：Windows 触屏笔记本 / 二合一的主指针经常
 * 被判为 coarse，它们有物理键盘，回车必须发送（否则表现为「回车只换行、发不出去」）。
 *
 * 因此要求「粗指针 + 无 hover（典型软键盘设备）」且不是桌面操作系统：
 *   - Windows / ChromeOS → 一律按桌面处理（有物理键盘）；
 *   - Linux 桌面同理（Android 的 UA 里也带 Linux，需排除）；
 *   - iPad 的 UA 冒充 Macintosh，靠 maxTouchPoints > 1 区分真触屏。
 *
 * 纯函数 + 环境注入，便于单测（见 tests/unit/touch-device.test.ts）。
 */
export interface TouchEnv {
	/** 形如 `matchMedia(q).matches` 的查询函数（浏览器里传 window.matchMedia）。 */
	query?: (media: string) => boolean;
	userAgent?: string;
	maxTouchPoints?: number;
}

/** 该环境是否为「触屏优先」设备（软键盘设备）。 */
export function isTouchFirstDevice(env: TouchEnv): boolean {
	const q = env.query;
	if (!q) return false;
	// 桌面鼠标/触控板设备：主指针精细或 hover 可用 —— 一律按桌面处理。
	if (!q("(pointer: coarse)")) return false;
	if (!q("(hover: none)")) return false;
	const ua = env.userAgent ?? "";
	if (/Windows|CrOS/i.test(ua)) return false;
	if (/Linux/i.test(ua) && !/Android/i.test(ua)) return false;
	if (/Macintosh/i.test(ua) && (env.maxTouchPoints ?? 0) <= 1) return false;
	return true;
}

/** 读取当前浏览器环境并判定（非浏览器环境返回 false）。 */
export function detectTouchFirstDevice(): boolean {
	if (typeof window === "undefined" || typeof navigator === "undefined") return false;
	if (typeof window.matchMedia !== "function") return false;
	return isTouchFirstDevice({
		query: (media) => window.matchMedia(media).matches,
		userAgent: navigator.userAgent,
		maxTouchPoints: navigator.maxTouchPoints,
	});
}
