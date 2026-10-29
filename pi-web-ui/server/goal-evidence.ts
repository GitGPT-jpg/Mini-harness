/**
 * 目标审查的「执行证据」摘要（issue #543 §1，纯函数，无宿主/会话依赖）。
 *
 * 委托执行下「执行者」与「审查者」是两条会话：审查者（主对话）的输入原本只有目标、
 * 轮次、执行者本轮自述和计划看板 —— 执行者实际跑过哪些命令、输出的尾部是什么，一概
 * 不在输入里。远程部署类目标于是只能靠猜，或者让审查者自己重跑一遍。
 *
 * 这里把执行者会话里最近的工具事件（`bashExecution` 的命令与输出 / `toolResult` 的
 * 工具名、参数提示与结果尾部）压成一段可直接进审查提示词的文本。只读消息数组、
 * 只看尾部、全程封顶，避免把审查回合的上下文撑爆。
 *
 * 消息形状与 `lastToolNameOfSession` / `extractErrorSnippetFromSession` 同源：
 * - `{role:"bashExecution", command, output, exitCode}`（`!` 命令与持久 shell 的转录）
 * - `{role:"toolResult", toolName, toolCallId, isError, content:[{type:"text", text}]}`
 * - `{role:"assistant", content:[{type:"toolCall", toolCallId, name, args}]}`（取参数提示用）
 */

import { checkBashCommandDanger } from "./approval-rules.js";

/** 单条证据：工具名 + 一行参数提示 + 输出尾部 + 失败标记。 */
export interface EvidenceEntry {
	tool: string;
	/** 一行参数提示（bash 是命令，其余工具取 path/command/query 等首字段）。 */
	hint: string;
	/** 输出尾部（已按单条预算截断；空输出不占位）。 */
	tail?: string;
	/** 失败特征：`toolResult.isError` 或 bash 非 0 退出码。 */
	error?: boolean;
}

export interface EvidenceOptions {
	/** 最多取多少条工具事件（默认 8，从最新往前取）。 */
	maxEntries?: number;
	/** 单条输出尾部最多多少字符（默认 400）。 */
	maxTailChars?: number;
	/** 整段最多多少字符（默认 6000，超出丢最早的事件并标注）。 */
	maxTotalChars?: number;
	/** 只看最近多少条消息（默认 200：超长会话不做整表扫描）。 */
	window?: number;
}

const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_MAX_TAIL_CHARS = 400;
const DEFAULT_MAX_TOTAL_CHARS = 6000;
const DEFAULT_WINDOW = 200;

/** 参数提示里优先取用的字段（顺序即优先级：命令 > 路径 > 查询）。 */
const HINT_KEYS = ["command", "path", "file_path", "filePath", "pattern", "query", "url", "name"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

/** 压成一行并封顶（提示是给人/模型扫的，不做换行）。 */
/** 高危命中前缀：同一命令里的多处命中逐条列出（去重标签，#578）。 */
function dangerPrefix(hits: { label: string }[]): string {
	if (hits.length === 0) return "";
	const labels = [...new Set(hits.map((h) => h.label))];
	return `⚠️ [${labels.join(" / ")}] `;
}

function oneLine(v: unknown, max = 120): string {
	if (typeof v !== "string") return "";
	const s = v.trim().replace(/\s+/g, " ");
	if (!s) return "";
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 输出尾部（尾部才是错误所在）；超出预算时留一个省略号标记。 */
function tailOf(v: unknown, max: number): string {
	if (typeof v !== "string") return "";
	const s = v.trim();
	if (!s) return "";
	return s.length > max ? `…${s.slice(-max)}` : s;
}

/** toolResult 的正文（content 文本块拼接；兼容纯字符串的简化形态）。 */
function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c) => (isRecord(c) && typeof c.text === "string" ? c.text : ""))
		.filter(Boolean)
		.join("\n");
}

/**
 * 执行者会话消息 → 证据条目（从最新往前取，返回时按时间正序）。
 * 非数组 / 形状不认识 → 空数组（旧 host / 空会话照常工作）。
 */
export function collectToolEvidence(messages: unknown, opts: EvidenceOptions = {}): EvidenceEntry[] {
	if (!Array.isArray(messages) || messages.length === 0) return [];
	const maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES);
	const maxTail = Math.max(40, opts.maxTailChars ?? DEFAULT_MAX_TAIL_CHARS);
	const window = Math.max(1, opts.window ?? DEFAULT_WINDOW);
	const recent = messages.slice(-window);

	// toolResult 不带参数：先按 toolCallId 建索引，才能给出「跑了什么」的提示。
	const calls = new Map<string, { name: string; hint: string }>();
	for (const m of recent) {
		if (!isRecord(m) || m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of m.content) {
			if (!isRecord(b) || b.type !== "toolCall") continue;
			const id = typeof b.toolCallId === "string" ? b.toolCallId : typeof b.id === "string" ? b.id : "";
			if (!id) continue;
			const args = isRecord(b.args) ? b.args : undefined;
			let hint = "";
			if (args) {
				for (const k of HINT_KEYS) {
					hint = oneLine(args[k]);
					if (hint) break;
				}
			}
			calls.set(id, { name: typeof b.name === "string" ? b.name : "", hint });
		}
	}

	const out: EvidenceEntry[] = [];
	for (let i = recent.length - 1; i >= 0 && out.length < maxEntries; i--) {
		const m = recent[i];
		if (!isRecord(m)) continue;
		if (m.role === "bashExecution") {
			const cmd = typeof m.command === "string" ? m.command : "";
			const dangerHits = checkBashCommandDanger(cmd);
			const prefix = dangerPrefix(dangerHits);
			out.push({
				tool: "bash",
				hint: `${prefix}${oneLine(m.command)}`,
				tail: tailOf(m.output, maxTail),
				error: typeof m.exitCode === "number" && m.exitCode !== 0,
			});
			continue;
		}
		if (m.role !== "toolResult") continue;
		const id = typeof m.toolCallId === "string" ? m.toolCallId : "";
		const call = id ? calls.get(id) : undefined;
		const toolName = typeof m.toolName === "string" ? m.toolName.trim() : "";
		const effectiveTool = toolName || call?.name || "tool";
		let hint = call?.hint ?? "";
		if (effectiveTool === "bash" && hint) {
			const dangerHits = checkBashCommandDanger(hint);
			if (dangerHits.length > 0) {
				hint = `${dangerPrefix(dangerHits)}${hint}`;
			}
		}
		out.push({
			tool: effectiveTool,
			hint,
			tail: tailOf(resultText(m.content), maxTail),
			error: m.isError === true,
		});
	}
	out.reverse();
	return out;
}

/**
 * 证据条目 → 可直接注入审查提示词的文本块（纯文本，不带标题：标题由提示词模板按语言给）。
 * 空条目返回空串（调用方据此跳过整段，不注入空标题）。
 */
export function formatEvidenceDigest(entries: EvidenceEntry[], opts: EvidenceOptions = {}): string {
	if (entries.length === 0) return "";
	const maxTotal = Math.max(200, opts.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS);
	const bodies: string[] = [];
	let used = 0;
	let omitted = 0;
	// 从最新往前堆，预算用完即止 —— 丢的永远是最早的（审查关心「刚才跑了什么」）。
	// 编号留到最终顺序确定后再加（否则反向堆出来的编号与显示顺序相反）。
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!;
		const head = `${e.tool}${e.error ? " (failed)" : ""}${e.hint ? `: ${e.hint}` : ""}`;
		const body = e.tail ? `${head}\n   out: ${e.tail}` : head;
		if (used + body.length + 4 > maxTotal) {
			omitted = i + 1;
			break;
		}
		bodies.push(body);
		used += body.length + 4; // +4 = 「N. 」编号占位
	}
	bodies.reverse();
	const blocks = bodies.map((b, idx) => `${idx + 1}. ${b}`);
	const head = omitted > 0 ? `(${omitted} earlier event(s) omitted for brevity)\n` : "";
	return head + blocks.join("\n");
}

/** 会话 → 原始消息数组（与 `lastToolNameOfSession` 同口径；读不到即空数组）。 */
export function sessionMessagesOf(session: unknown): unknown[] {
	try {
		const s = session as { messages?: unknown; agent?: { state?: { messages?: unknown } } } | undefined;
		const msgs = s?.messages ?? s?.agent?.state?.messages;
		return Array.isArray(msgs) ? msgs : [];
	} catch {
		return [];
	}
}

/** 一步到位：会话消息 → 证据文本（空会话/空证据返回空串）。 */
export function buildEvidenceDigest(messages: unknown, opts: EvidenceOptions = {}): string {
	return formatEvidenceDigest(collectToolEvidence(messages, opts), opts);
}
