/// <reference lib="dom" />
/**
 * compacted-history-state.ts — 被折叠历史消息的按需加载状态 store（issue #398）。
 *
 * 采用模块级 store + useSyncExternalStore 驱动：
 * - 每个 compactionMessageId 独立维护一份请求状态与缓存（支持多次压缩卡片各自查看）；
 * - 首次展开时按需通过 WS 发送 get_compacted_messages；
 * - 收到 compacted_messages_result 应答后缓存在内存中，避免重复请求；
 * - getSnapshot 保证引用稳定，防止 React 渲染颠簸。
 */

import { useSyncExternalStore } from "react";
import { appSend } from "./app-globals";
import type { ServerMessage, UiMessage } from "./types";

type CompactedMessagesPayload = Extract<ServerMessage, { type: "compacted_messages_result" }>;

type CompactedHistoryStatus = "idle" | "loading" | "ready" | "error";

interface CompactedHistoryState {
	status: CompactedHistoryStatus;
	messages: UiMessage[];
	error?: string;
}

const IDLE_STATE: CompactedHistoryState = Object.freeze({
	status: "idle",
	messages: [],
});

/** key: compactionMessageId -> state */
const cache = new Map<string, CompactedHistoryState>();
const listeners = new Set<() => void>();

/** 展开历史缓存上限（LRU 淘汰，防无界内存泄漏，issue #465）。 */
const MAX_COMPACTED_CACHE = 16;

function pruneCache(): void {
	while (cache.size > MAX_COMPACTED_CACHE) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

function notify(): void {
	for (const l of listeners) l();
}

/** 触发拉取某个压缩卡片所折叠的历史消息。 */
export function fetchCompactedHistory(compactionMessageId: string, conversationId?: string): void {
	const id = (compactionMessageId ?? "").trim();
	if (!id) return;

	const existing = cache.get(id);
	if (existing && (existing.status === "loading" || existing.status === "ready")) {
		return;
	}

	cache.set(id, {
		status: "loading",
		messages: existing?.messages ?? [],
	});
	pruneCache();
	notify();

	appSend({
		type: "get_compacted_messages",
		compactionMessageId: id,
		conversationId,
	});
}

/** 收到服务端的历史消息应答。由 use-chat 分发。 */
export function receiveCompactedMessages(payload: CompactedMessagesPayload): void {
	const id = payload.compactionMessageId;
	if (!id) return;

	if (payload.error) {
		cache.set(id, {
			status: "error",
			messages: [],
			error: payload.error,
		});
	} else {
		cache.set(id, {
			status: "ready",
			messages: payload.messages ?? [],
		});
	}
	pruneCache();
	notify();
}

/** 获取某个压缩卡片当前的折叠历史状态（未请求时返回固定的 IDLE_STATE 引用）。 */
function getCompactedHistoryState(compactionMessageId: string): CompactedHistoryState {
	const hit = cache.get(compactionMessageId);
	if (!hit) return IDLE_STATE;
	// 刷新 LRU 顺序
	cache.delete(compactionMessageId);
	cache.set(compactionMessageId, hit);
	return hit;
}

/** 订阅变更。返回取消订阅函数。 */
function subscribeCompactedHistory(cb: () => void): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

/** React hook：订阅某个压缩卡片的历史折叠消息。 */
export function useCompactedHistory(compactionMessageId: string): CompactedHistoryState {
	return useSyncExternalStore(
		subscribeCompactedHistory,
		() => getCompactedHistoryState(compactionMessageId),
		() => IDLE_STATE,
	);
}
