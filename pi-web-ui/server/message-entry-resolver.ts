/**
 * message-entry-resolver — 渲染态消息 ID 与 SessionManager 底层 Entry 节点的映射解析器。
 *
 * 负责：
 * - resolveUserMessageEntryId: 将前端渲染的消息 ID（u-<timestamp>-<seq>）映射回 SessionEntry ID
 * - resolveConversationMessageEntry: 将任何前端消息 ID（u-*, a-*, t-*, b-*, c-* 或原始 entry id）
 *   解析回当前分支上下文中的原始 SessionEntry。
 *
 * 从 agent-service.ts 抽出为独立模块。
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { findEntryByUiId, type UiIdEntryLike, type AgentMessage } from "./serialize.js";

/**
 * 将前端渲染的用户消息 ID（u-<timestamp>-<seq>）解析为底层 SessionEntry 的唯一 ID。
 * seq 用于解决同一毫秒内发出的多条用户消息（例如附件 aside 消息）。
 */
export function resolveUserMessageEntryId(
	contextEntries: Iterable<{ type?: string; message?: unknown; id: string }>,
	messageId: string,
): string | null {
	const m = /^u-(\d+)(?:-(\d+))?$/.exec(messageId);
	if (!m) return null;
	const ts = Number(m[1]);
	const seq = m[2] ? Number(m[2]) : 1;
	let count = 0;

	for (const entry of contextEntries) {
		if (entry.type !== "message") continue;
		const msg = (entry as unknown as { message?: AgentMessage }).message;
		if (!msg || msg.role !== "user" || msg.timestamp !== ts) continue;
		count += 1;
		if (count === seq) return entry.id;
	}
	return null;
}

/**
 * 将任意渲染的消息 ID 解析为当前会话分支的 SessionEntry 节点。
 * 优先在上下文条目中比对 UI ID，未命中时通过 fallback 查整棵历史树。
 */
export function resolveConversationMessageEntry(
	contextEntries: SessionEntry[],
	messageId: string,
	seqOf: (m: AgentMessage) => number,
	fallbackGetEntry?: (id: string) => SessionEntry | null | undefined,
): SessionEntry | null {
	const found = findEntryByUiId(contextEntries as (UiIdEntryLike & SessionEntry)[], messageId, seqOf);
	return found ?? fallbackGetEntry?.(messageId) ?? null;
}
