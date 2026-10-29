/// <reference lib="dom" />
/**
 * present-settings.ts —— present_files 卡片的纯前端偏好（localStorage，不经服务端）。
 *
 * 只有一个开关：**自动打开预览弹窗**（默认关）。AI 可以在条目上标 `focus: true`
 * （「这个文件你该看一眼」），开着这个开关时卡片一次渲染就替用户把预览弹窗打开。
 * 默认关是因为「模型觉得你该看」不等于「你想被打断」——弹窗是抢焦点的动作。
 *
 * 为什么存 localStorage 而不是 ClientSettings：这是纯 UI 打断策略，与
 * chat-width-settings.ts（宽屏聊天列）同一档；进 ClientSettings 要在
 * client-state / settings-service / DSH 侧镜像三处同步，代价与收益不成比例。
 *
 * 自动打开的两道闸（纯函数，可单测）：
 *   1. 只对「刚发生」的卡片生效（resultTimestamp 距今 maxAgeMs 内）——翻旧会话、
 *      窗口化惰性挂载不会突然弹一堆窗；
 *   2. 每个 toolCallId 只开一次（sessionStorage 镜像，刷新页面不重复弹）。
 */

import { useSyncExternalStore } from "react";
import { shouldAutoOpenPresent } from "./present-items";

const PRESENT_SETTINGS_KEY = "pi-web-ui:present-auto-open";
/** 「刚发生」的时间窗：AI 展示完到浏览器渲染出来的正常延迟远小于这个数。 */
const PRESENT_AUTO_OPEN_MAX_AGE_MS = 30_000;
/** sessionStorage 里去重表的键。 */
const PRESENT_AUTO_OPEN_SEEN_KEY = "pi-web-ui:present-auto-opened";
/** 去重表最多记这么多条（防长会话 sessionStorage 无限增长）。 */
const SEEN_CAP = 200;

/** 读取开关（localStorage 不可用 / 数据损坏 → 默认关）。 */
function loadPresentAutoOpen(): boolean {
	try {
		return localStorage.getItem(PRESENT_SETTINGS_KEY) === "1";
	} catch {
		return false;
	}
}

/** 保存并广播（localStorage 不可写时静默忽略）。 */
export function savePresentAutoOpen(on: boolean): void {
	try {
		localStorage.setItem(PRESENT_SETTINGS_KEY, on ? "1" : "0");
	} catch {
		/* ignore */
	}
	cached = on;
	emit();
}

// ---- 订阅：单例 listener 集合（同 chat-width-settings.ts）。 ------------------

const listeners = new Set<() => void>();

function emit(): void {
	for (const l of listeners) l();
}

function subscribe(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

let cached: boolean | null = null;

function getSnapshot(): boolean {
	if (cached === null) cached = loadPresentAutoOpen();
	return cached;
}

/** 自动打开预览弹窗是否开启（设置面板切换后即时生效，无需刷新）。 */
export function usePresentAutoOpen(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot);
}

// ---- 已自动打开过的卡片（sessionStorage 去重表） -----------------------------

/** 读去重表（损坏/不可用 → 空表）。 */
function loadAutoOpenedIds(): string[] {
	try {
		const raw = sessionStorage.getItem(PRESENT_AUTO_OPEN_SEEN_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

/** 记一个已自动打开的 toolCallId（返回 false 表示之前已经打开过 → 本次不要再开）。 */
function markAutoOpened(toolCallId: string): boolean {
	if (!toolCallId) return false;
	const seen = loadAutoOpenedIds();
	if (seen.includes(toolCallId)) return false;
	const next = [...seen, toolCallId].slice(-SEEN_CAP);
	try {
		sessionStorage.setItem(PRESENT_AUTO_OPEN_SEEN_KEY, JSON.stringify(next));
	} catch {
		/* ignore */
	}
	return true;
}

/**
 * 这张卡片现在该不该自动打开预览弹窗（在效果里调用，副作用只有去重表一处）。
 * 三个条件全部满足才开：开关开着、卡片刚发生、这个 toolCallId 没开过。
 */
export function takeAutoOpen(toolCallId: string, resultTimestamp: number | undefined, now = Date.now()): boolean {
	if (
		!shouldAutoOpenPresent({
			enabled: loadPresentAutoOpen(),
			seen: false,
			timestamp: resultTimestamp,
			now,
			maxAgeMs: PRESENT_AUTO_OPEN_MAX_AGE_MS,
		})
	) {
		return false;
	}
	return markAutoOpened(toolCallId);
}
