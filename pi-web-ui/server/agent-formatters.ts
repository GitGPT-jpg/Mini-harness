/**
 * agent-formatters — 会话、消息、工具结果格式化与摘要辅助函数。
 *
 * 负责：
 * - conversationTitle: 提取会话标题（首条用户消息摘要）
 * - contentFingerprint: 消息快照序列化缓存的低成本指纹
 * - extractAssistantTextFromContent / extractPartialText: 提取助手消息纯文本
 * - modelKeyOf / contextWindowOf: 模型键值与上下文窗口大小提取
 * - firstSentence: 工具描述首句提取
 *
 * 从 agent-service.ts 抽出为独立模块。
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "./serialize.js";
import { writeAtomicSync } from "./atomic-file.js";

/** Cap on simultaneously open NON-subagent conversations of ONE project（可通过 PI_WEB_MAX_OPEN_CONVERSATIONS 覆盖） */
export const MAX_OPEN_CONVERSATIONS = 8;
/** 同时运行（非终态）的子代理默认并发上限（按客户端计，含嵌套派生的孙子辈；可通过 PI_WEB_MAX_SUBAGENTS 覆盖，#589）。 */
export const MAX_SUBAGENTS = 16;

/** 读取当前生效的子代理并发上限（支持 PI_WEB_MAX_SUBAGENTS 环境变量覆盖，默认 16，最小 1）。 */
export function getMaxSubagents(): number {
	const raw = Number(process.env.PI_WEB_MAX_SUBAGENTS);
	if (Number.isFinite(raw) && raw > 0) {
		return Math.max(1, Math.floor(raw));
	}
	return MAX_SUBAGENTS;
}

/** 读取当前生效的对话并发上限（支持 PI_WEB_MAX_OPEN_CONVERSATIONS 环境变量覆盖，默认 8，最小 1）。 */
export function getMaxOpenConversations(): number {
	const raw = Number(process.env.PI_WEB_MAX_OPEN_CONVERSATIONS);
	if (Number.isFinite(raw) && raw > 0) {
		return Math.max(1, Math.floor(raw));
	}
	return MAX_OPEN_CONVERSATIONS;
}
/** SubagentSnapshot.prompt 下发上限：存的是全量 prompt，快照里只带前 N 字符。 */
export const SUBAGENT_PROMPT_SNAPSHOT_CAP = 2000;
export const DEFAULT_CONV_TITLE = "新对话";

/** 转录整文件重写的原子落盘：先写同目录临时文件再 rename。 */
export function atomicWriteFileSync(file: string, data: string): void {
	writeAtomicSync(file, data);
}

/** First user text in a session, truncated for the conversation list. */
export function conversationTitle(session: AgentSession): string {
	try {
		const named = session.sessionManager.getSessionName();
		if (named && named.trim()) return named.trim();
	} catch {
		// best-effort — fall through to first-message title
	}
	try {
		for (const m of session.agent.state.messages) {
			if (m.role !== "user") continue;
			const content = m.content as unknown;
			let text = "";
			if (typeof content === "string") {
				text = content;
			} else if (Array.isArray(content)) {
				for (const p of content) {
					if (
						p &&
						typeof p === "object" &&
						(p as { type?: unknown }).type === "text" &&
						typeof (p as { text?: unknown }).text === "string"
					) {
						text = (p as { text: string }).text;
						break;
					}
				}
			}
			const trimmed = text.trim().replace(/\s+/g, " ");
			if (trimmed.length > 0) {
				return trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed;
			}
		}
	} catch {
		// best-effort
	}
	return DEFAULT_CONV_TITLE;
}

/**
 * Cheap per-message discriminator for the serialization cache key. Persisted
 * message content never changes, so this is stable across snapshots, while
 * several same-role messages created within one millisecond (attachment
 * asides) get distinct keys.
 */
export function contentFingerprint(m: AgentMessage): string {
	const summary = (m as unknown as { summary?: string }).summary;
	if (typeof summary === "string" && summary.length > 0) {
		let h = 5381;
		for (let i = 0; i < summary.length && i < 512; i++) {
			h = ((h << 5) + h + summary.charCodeAt(i)) >>> 0;
		}
		return `sum:${h.toString(36)}:${summary.length}`;
	}
	const content = (m as unknown as { content?: unknown }).content;
	if (!Array.isArray(content) || content.length === 0) return "empty";
	const first = content[0] as {
		type?: string;
		text?: string;
		thinking?: string;
		data?: string;
		id?: string;
		name?: string;
	};
	if (first?.type === "image") {
		return `img:${(first.data ?? "").length}`;
	}
	if (first?.type === "toolCall") {
		if (typeof first?.id === "string" && first.id.length > 0) return `tc:${first.id}`;
		return `tc:${first?.name ?? ""}`;
	}
	// Ported from fork fix(cache): type-aware contentFingerprint (949a8bd):
	// thinking-first blocks hash their thinking text (they carry no .text —
	// else all collide as txt:45h:0). Per-type prefix keeps old txt: keys stable.
	const tag = first?.type === "thinking" ? "thk" : "txt";
	const s =
		tag === "thk"
			? typeof first?.thinking === "string"
				? first.thinking
				: ""
			: typeof first?.text === "string"
				? first.text
				: "";
	// djb2 — fast enough to run per snapshot, distinct enough for asides.
	let h = 5381;
	for (let i = 0; i < s.length && i < 512; i++) {
		h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
	}
	return `${tag}:${h.toString(36)}:${s.length}`;
}

export function extractPartialText(partial: unknown): string | null {
	const content = (partial as { content?: unknown } | null | undefined)?.content;
	if (Array.isArray(content)) {
		const text = content
			.map((c) => ((c as { type?: string; text?: string })?.type === "text" ? (c as { text: string }).text : ""))
			.join("");
		return text.length > 0 ? text : null;
	}
	return null;
}

export function extractAssistantTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(c): c is { type: string; text: string } =>
				(c as { type?: string }).type === "text" && typeof (c as { text?: string }).text === "string",
		)
		.map((c) => c.text)
		.join("\n");
}

/** 描述首句（延迟加载目录里没 promptSnippet 时的回落摘要）。 */
export function firstSentence(description: string | undefined): string {
	const text = (description ?? "").trim();
	if (!text) return "";
	const cut = text.split(/\n|[.。](?=\s|$)/)[0]?.trim() ?? "";
	const head = cut || text;
	return head.length > 160 ? `${head.slice(0, 160)}…` : head;
}

/** 会话当前模型的 "provider/id"（无模型时 null；软上限按模型覆盖用，issue #229）。 */
export function modelKeyOf(session: { model?: { provider?: unknown; id?: unknown } | null }): string | null {
	const m = session?.model;
	if (!m || typeof m.provider !== "string" || typeof m.id !== "string") return null;
	return `${m.provider}/${m.id}`;
}

/** 会话当前模型的上下文窗口（未知时 0）。
 *  live 统计与模型定义取较大值：换模型前的快照（128000 缺省窗口常见）
 *  不能盖住已经装上的更大配置窗口，否则软上限会被判成非法并回退到 16K reserve。 */
export function contextWindowOf(session: {
	getSessionStats?: () => { contextUsage?: { contextWindow?: unknown } | null };
	model?: { contextWindow?: unknown } | null;
}): number {
	let live = 0;
	try {
		const raw = session?.getSessionStats?.()?.contextUsage?.contextWindow;
		if (typeof raw === "number" && raw > 0) live = Math.floor(raw);
	} catch {
		// 会话未就绪 → 只用模型定义。
	}
	const def = session?.model?.contextWindow;
	const modelWindow = typeof def === "number" && def > 0 ? Math.floor(def) : 0;
	return Math.max(live, modelWindow);
}
