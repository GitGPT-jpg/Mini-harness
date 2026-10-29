/** Pure classification of an onScroll event — no DOM, no refs. The onScroll
 *  handler in MessageList applies the returned actions. Semantics preserved
 *  verbatim from 5cd680b:
 *   - graceActive (programmatic snap window): do nothing — our own jumps must
 *     never be read as upward user intent.
 *   - Large negative jump (dSt <= -500): layout collapse clamp, not a gesture —
 *     no escape.
 *   - Moderate negative jump (-500 < dSt < -4):
 *       · dSh < 0  → layout shift above viewport, NOT user intent; keep the
 *         stick and re-assert the snap (only when currently stuck && !escaped).
 *       · dSh >= 0 → true user wheel-up (content height unchanged) → escape.
 *   - Otherwise (dSt >= -4): no-op from this classifier.
 *  NOTE: while graceActive the handler deliberately does NOT re-assert, so
 *  reassert stays false there — behavior identical to pre-refactor. */
export function classifyScroll(args: {
	dSt: number;
	dSh: number;
	escaped: boolean;
	graceActive: boolean;
	stuck: boolean;
}): { flipEscape: boolean; reassert: boolean } {
	const { dSt, dSh, escaped, graceActive, stuck } = args;
	if (graceActive) return { flipEscape: false, reassert: false };
	if (dSt >= -4 || dSt <= -500) return { flipEscape: false, reassert: false };
	if (dSh < 0) {
		// Layout shift, NOT user intent: keep the stick and re-assert the snap —
		// the bottom moved up, follow it.
		return { flipEscape: false, reassert: stuck && !escaped };
	}
	// True user wheel-up: scrollHeight unchanged → escape.
	return { flipEscape: true, reassert: false };
}

/**
 * 判定在滚动事件触发时是否采纳逃逸或重新吸底。
 *
 * 核心准则（根治长输出工具与流式正文把跟随掐断）：
 *   - 仅当真正存在用户向上物理手势（滚轮向上 / 触屏向上翻页 / 拖动滚动条向上 / 键盘向上）时，
 *     才采纳逃逸并释放跟随；
 *   - 当没有任何物理手势时，即使发生了负向位移（长工具卡片插入、代码高亮重排、
 *     占位符替换或浏览器 scrollTop clamp 导致 dSt < 0），也坚决拒绝逃逸，并在
 *     处于吸底状态时重新拉回底部（shouldReassert = true）。
 */
export function shouldEscapeOnScroll(args: {
	decisionFlipEscape: boolean;
	hasUserUpwardIntent: boolean;
	stuck: boolean;
	escaped: boolean;
}): { shouldEscape: boolean; shouldReassert: boolean } {
	const { decisionFlipEscape, hasUserUpwardIntent, stuck, escaped } = args;
	if (!decisionFlipEscape) {
		return { shouldEscape: false, shouldReassert: false };
	}
	if (hasUserUpwardIntent) {
		return { shouldEscape: true, shouldReassert: false };
	}
	// 无用户物理向上意图：纯渲染布局突变，在吸底态下拒绝逃逸，必须重新吸底
	return {
		shouldEscape: false,
		shouldReassert: stuck && !escaped,
	};
}
