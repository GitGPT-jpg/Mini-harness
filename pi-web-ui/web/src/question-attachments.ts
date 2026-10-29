/**
 * question-attachments — 编辑重问的「原附件恢复」收集纯函数。
 *
 * Web UI 的 prompt 会把附件作为独立的 custom "file" aside 卡片、紧跟在该条
 * 用户消息之后持久化；编辑重问时 fork 会裁掉这些 aside（它们在新分支上），
 * 所以编辑器需要这份清单来恢复。收集三类：
 *   · 粘贴/上传的图片（imageData）—— 从 aside 的 image 块取 base64（含视觉
 *     桥转写卡片的缩略图）；
 *   · 上传的文件（uploadPath）—— 服务端已把字节落在 uploads 目录，重发
 *     details.path 让服务端重读即可（不进快照、不重复 base64）；
 *   · 工作区路径附件（inline/reference/lines/folder）—— 相对路径在 fork 后
 *     仍有效，带 path+mode 重发走同一附件管线。
 *
 * 纯函数、零依赖。输入用宽类型（content: readonly unknown[]）+ 内部收窄，
 * 既不 import ./types（单测在 NodeNext 下会因扩展名缺失 shim 报 TS2835），
 * 也让任意 UiMessage 都能传入。
 */
import { readTextQuote } from "../../server/text-quote.js";

/** PromptAttachment 的结构化镜像（与 server/protocol.ts 一致）。 */
export interface EditPromptAttachment {
	path: string;
	mode?: "inline" | "reference" | "lines" | "page" | "conversation" | "quote";
	quote?: import("../../server/protocol.js").TextQuote;
	conversationId?: string;
	sessionPath?: string;
	lines?: { start: number; end: number };
	imageData?: string;
	fileData?: string;
	uploadPath?: string;
	mimeType?: string;
	name?: string;
	size?: number;
}

/** image 块（运行时收窄用）。 */
interface ImageBlock {
	type: "image";
	dataUrl?: string;
}

/** 从 image 块还原 imageData 附件（dataUrl → 纯 base64）；有图片块返回 true。 */
function pushImageAttachments(
	atts: EditPromptAttachment[],
	content: readonly unknown[],
	fallbackName?: string,
): boolean {
	let hasImage = false;
	for (const b of content) {
		const img = b as ImageBlock;
		if (img.type !== "image" || typeof img.dataUrl !== "string") continue;
		if (!img.dataUrl.startsWith("data:")) continue;
		const mm = img.dataUrl.match(/^data:([^;]*);base64,(.+)$/);
		if (!mm) continue;
		hasImage = true;
		atts.push({
			path: "",
			imageData: mm[2],
			mimeType: mm[1] || "image/png",
			name: fallbackName ?? `image.${(mm[1] || "image/png").split("/")[1] ?? "png"}`,
		});
	}
	return hasImage;
}

function parseFileCardAttachment(msg: { content: readonly unknown[]; details?: unknown }): EditPromptAttachment | null {
	const details = (msg.details ?? {}) as {
		quote?: import("../../server/protocol.js").TextQuote;
		mode?: string;
		name?: string;
		size?: number;
		path?: string;
		startLine?: number;
		endLine?: number;
		upload?: boolean;
	};
	if (details.mode === "quote") {
		const quote = readTextQuote(details.quote);
		if (quote) return { path: "", mode: "quote", quote };
		return null;
	}
	// 1) Image card (pasted/uploaded images incl. bridged thumbnails) —
	//    the raw base64 lives in the image blocks.
	const imgAtts: EditPromptAttachment[] = [];
	if (pushImageAttachments(imgAtts, msg.content, details.name)) return imgAtts[0] ?? null;
	// 2) Uploaded file (fileData) — re-send the server-generated upload
	//    path; the server re-reads the persisted bytes from disk.
	if (details.upload && details.path) {
		return {
			path: "",
			uploadPath: details.path,
			name: details.name ?? details.path,
			size: details.size,
		};
	}
	// 3) Granted web page (page-picker 的「引用到对话」)：`path` 是页面 origin、
	//    name 是标题；扩展的授权表与工作区无关，所以原样重发即可，服务端不读文件。
	if (details.mode === "page" && details.path) {
		return { path: details.path, mode: "page", name: details.name ?? details.path };
	}
	// 3b) Quoted conversation（对话引用 chip）：path 是 id/path 展示串，
	//     真引用走 conversationId/sessionPath；重发即重新读取最新转录。
	if (details.mode === "conversation") {
		const d = details as { conversationId?: unknown; sessionPath?: unknown };
		const conversationId = typeof d.conversationId === "string" && d.conversationId ? d.conversationId : undefined;
		const sessionPath = typeof d.sessionPath === "string" && d.sessionPath ? d.sessionPath : undefined;
		if (conversationId || sessionPath) {
			return {
				path: "",
				mode: "conversation",
				name: details.name ?? conversationId ?? sessionPath,
				...(conversationId ? { conversationId } : {}),
				...(sessionPath ? { sessionPath } : {}),
			};
		}
		return null;
	}
	// 4) Workspace-path attachment (reference / lines / folder)
	//    — the relative path stays valid on the new branch, so a path +
	//    mode spec is enough to re-attach it. A legacy "inline" mode (old
	//    sessions persisted before content injection was removed) is
	//    downgraded to a plain path reference.
	if (details.path && details.mode) {
		const mode = details.mode === "lines" ? "lines" : "reference";
		const att: EditPromptAttachment = { path: details.path, mode };
		if (details.mode === "lines" && typeof details.startLine === "number" && typeof details.endLine === "number") {
			att.lines = { start: details.startLine, end: details.endLine };
		}
		return att;
	}
	return null;
}

function attachmentDedupKey(att: EditPromptAttachment): string {
	if (att.mode === "quote" && att.quote) {
		return `quote:${att.quote.messageId ?? ""}:${att.quote.text}`;
	}
	if (att.mode === "conversation") {
		return `conv:${att.conversationId ?? ""}:${att.sessionPath ?? ""}:${att.name ?? ""}`;
	}
	if (att.mode === "page") {
		return `page:${att.path}`;
	}
	if (att.imageData) {
		return `img:${att.name ?? ""}:${att.imageData.length}:${att.imageData.slice(0, 64)}`;
	}
	if (att.uploadPath) {
		return `upload:${att.uploadPath}`;
	}
	if (att.path) {
		const lines = att.lines ? `${att.lines.start}-${att.lines.end}` : "";
		return `path:${att.mode ?? "ref"}:${att.path}:${lines}`;
	}
	return `unknown:${JSON.stringify(att)}`;
}

/** 剔除相同引用/附件（防止历史会话污染或多源重复收集时导致重复卡片）。 */
export function deduplicateAttachments(atts: readonly EditPromptAttachment[]): EditPromptAttachment[] {
	const seen = new Set<string>();
	const result: EditPromptAttachment[] = [];
	for (const a of atts) {
		const key = attachmentDedupKey(a);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(a);
	}
	return result;
}

export function collectQuestionAttachments(
	messages: readonly {
		id?: string;
		role: string;
		content: readonly unknown[];
		details?: unknown;
		customType?: string;
	}[],
): Map<string, EditPromptAttachment[]> {
	const m = new Map<string, EditPromptAttachment[]>();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "user" || !msg.id) continue;
		// Own image blocks first (sessions where prompt(images) put them into
		// the user content itself).
		const atts: EditPromptAttachment[] = [];
		pushImageAttachments(atts, msg.content);
		const quotes = (msg.details as { quotes?: unknown[] } | undefined)?.quotes;
		for (const value of Array.isArray(quotes) ? quotes : []) {
			const quote = readTextQuote(value);
			if (quote) atts.push({ path: "", mode: "quote", quote });
		}
		// Leading attachment cards sent before this user prompt (e.g. non-streaming attachments/quotes).
		const leadingAtts: EditPromptAttachment[] = [];
		for (let j = i - 1; j >= 0 && messages[j].role === "custom" && messages[j].customType === "file"; j--) {
			const att = parseFileCardAttachment(messages[j]);
			if (att) leadingAtts.unshift(att);
		}
		atts.push(...leadingAtts);

		// Then the attachment-card run that follows this question (stops at
		// any other message kind — assistant/toolResult/next user/etc.).
		for (
			let j = i + 1;
			j < messages.length && messages[j].role === "custom" && messages[j].customType === "file";
			j++
		) {
			const att = parseFileCardAttachment(messages[j]);
			if (att) atts.push(att);
		}
		const deduped = deduplicateAttachments(atts);
		if (deduped.length > 0) m.set(msg.id, deduped);
	}
	return m;
}
