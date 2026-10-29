/**
 * Unknown inbound WS message-type counter —— 独立成模块是为了可单测
 * （`server/index.ts` 起 WS + SDK，不适合在单测里 import）。
 *
 * 背景：`dispatch` 的 `switch (msg.type)` 的 `default:` 分支原来是空的，
 * 版本错位（旧前端/新服务端）或插件发错 type 时静默丢弃，只能抓包排查。
 * 这里只做计数 + 节流 warn，不改变任何已知类型的行为。
 */

/** 同一 type 两次 warn 之间最小间隔（防刷屏），可单测覆盖。 */
export const UNKNOWN_WS_WARN_INTERVAL_MS = 60_000;

/** 未知 type 种类上限：type 字符串远端可控，无上限则内存无界增长。
 *  超限后的新 type 不再建 key，只进溢出计数。 */
export const MAX_UNKNOWN_WS_TYPES = 500;

const counts = new Map<string, number>();
const lastWarnAt = new Map<string, number>();
let overflowed = 0;

/**
 * 记录一次未知 type，计数永远 +1；同一 type 在 `UNKNOWN_WS_WARN_INTERVAL_MS`
 * 内只返回一次 `warn: true`（调用方决定是否 `console.warn`）。
 */
export function recordUnknownWsType(type: string, now: number = Date.now()): { count: number; warn: boolean } {
	if (!counts.has(type) && counts.size >= MAX_UNKNOWN_WS_TYPES) {
		overflowed++;
		return { count: overflowed, warn: false };
	}
	const count = (counts.get(type) ?? 0) + 1;
	counts.set(type, count);
	const last = lastWarnAt.get(type) ?? -Infinity;
	if (now - last >= UNKNOWN_WS_WARN_INTERVAL_MS) {
		lastWarnAt.set(type, now);
		return { count, warn: true };
	}
	return { count, warn: false };
}

/** 只读快照（排障用，返回拷贝，调用方改不动内部表）。 */
export function unknownWsCounts(): ReadonlyMap<string, number> {
	return new Map(counts);
}

/** 单测隔离用。 */
export function resetUnknownWsTypes(): void {
	counts.clear();
	lastWarnAt.clear();
	overflowed = 0;
}
