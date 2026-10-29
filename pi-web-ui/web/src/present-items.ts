/**
 * present-items.ts —— present_files 卡片的纯函数面（无 React、无 fs，可单测）。
 *
 * 卡片数据有**两个来源**，必须合成一份：
 *   1. 工具参数的 JSON 文本（`toolCall.argumentsText`）—— 永远存在，且随会话
 *      文件持久化，是「有哪些条目、叫什么、标没标 focus」的唯一可靠来源；
 *   2. 工具结果 details（服务端探测出来的 kind/size/excerpt/abs）—— 更准更丰富，
 *      但可能缺失（老快照、超过 serialize 的体积闸门被整丢）。
 * 所以：缺 details 时卡片照样出（kind = "unknown"，预览按钮照给，由预览弹窗
 * 自己判能不能渲染），有 details 时按路径合并、以 details 为准。
 *
 * 服务端探测的 `path` 是模型写的相对路径、`abs` 是线形绝对路径；API/协议调用
 * （/api/file、file_reveal、file_open_default）统一用后者，并把它作为 React key。
 *
 * 单测：tests/unit/present-items.test.ts
 */

/** 服务端 PresentKind 的前端镜像 + "unknown"（details 缺失/被丢时的兜底）。 */
export type PresentKind =
	"image" | "video" | "audio" | "markdown" | "html" | "pdf" | "text" | "binary" | "dir" | "missing" | "unknown";

const KINDS: ReadonlySet<string> = new Set([
	"image",
	"video",
	"audio",
	"markdown",
	"html",
	"pdf",
	"text",
	"binary",
	"dir",
	"missing",
]);

/** 工具参数里的一个条目（模型原样给的）。 */
interface PresentArgItem {
	path: string;
	caption?: string;
	focus?: boolean;
}

/** 解析后的工具参数。 */
export interface PresentArgs {
	title?: string;
	note?: string;
	items: PresentArgItem[];
}

/** 卡片真正渲染的一行。 */
export interface PresentCardItem {
	/** 模型写的路径（卡片上显示这个，最贴近用户的心智）。 */
	path: string;
	/** 协议/API 用的路径：有 details 就用线形绝对路径，否则退回模型写的路径。 */
	target: string;
	name: string;
	kind: PresentKind;
	caption?: string;
	focus: boolean;
	size?: number;
	/** 修改时间（epoch ms）：卡片上作为悬浮提示显示「这东西多新」。 */
	mtime?: number;
	excerpt?: string;
	excerptTruncated?: boolean;
}

/** 路径归一（比对 details 与参数用）：反斜杠折正斜杠 + 去首尾空白 + 去尾斜杠。 */
function normPresentPath(p: string): string {
	const w = String(p ?? "")
		.trim()
		.replace(/\\/g, "/");
	return w.length > 1 ? w.replace(/\/+$/, "") : w;
}

/** 取 basename（协议里路径一律 "/" 分隔）。 */
export function presentBaseName(p: string): string {
	const segs = normPresentPath(p).split("/");
	const last = segs[segs.length - 1] ?? "";
	return last || String(p ?? "");
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * 解析 toolCall.argumentsText（模型给的工具参数）。
 *
 * 宽容三件事：JSON 解析失败（流式半截参数）→ null；缺 title/note → 缺省；
 * 条目是裸字符串（模型偷懒写 ["a.png"]）→ 当成只有 path 的条目。
 * items 为空/非数组 → null（调用方回落原文展示）。
 */
export function parsePresentArgs(argumentsText: string | undefined): PresentArgs | null {
	if (!argumentsText) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(argumentsText);
	} catch {
		return null;
	}
	const obj = asRecord(raw);
	if (!obj) return null;
	const rawItems = Array.isArray(obj.items) ? obj.items : [];
	const items: PresentArgItem[] = [];
	for (const entry of rawItems) {
		if (typeof entry === "string") {
			const path = entry.trim();
			if (path) items.push({ path });
			continue;
		}
		const rec = asRecord(entry);
		const path = rec ? str(rec.path) : undefined;
		if (!path) continue;
		const item: PresentArgItem = { path };
		const caption = str(rec?.caption);
		if (caption) item.caption = caption;
		if (rec?.focus === true) item.focus = true;
		items.push(item);
	}
	if (items.length === 0) return null;
	const out: PresentArgs = { items };
	const title = str(obj.title);
	if (title) out.title = title;
	const note = str(obj.note);
	if (note) out.note = note;
	return out;
}

/**
 * 合并参数与工具结果 details → 卡片数据。按归一化路径配对（服务端保持顺序，
 * 配对不上时按序号兜底），details 缺字段一律回落到参数/空值。
 */
export function presentCardItems(args: PresentArgs, details: unknown): PresentCardItem[] {
	const det = asRecord(details);
	const rows = Array.isArray(det?.items) ? det.items.map(asRecord) : [];
	const byPath = new Map<string, Record<string, unknown>>();
	for (const row of rows) {
		if (!row) continue;
		const key = normPresentPath(String(row.path ?? row.abs ?? ""));
		if (key && !byPath.has(key)) byPath.set(key, row);
	}
	return args.items.map((item, i) => {
		const row = byPath.get(normPresentPath(item.path)) ?? rows[i] ?? null;
		const kind = str(row?.kind);
		const card: PresentCardItem = {
			path: item.path,
			target: str(row?.abs) ?? item.path,
			name: presentBaseName(str(row?.name) ?? item.path),
			kind: kind && KINDS.has(kind) ? (kind as PresentKind) : "unknown",
			focus: item.focus === true,
		};
		if (item.caption) card.caption = item.caption;
		if (typeof row?.size === "number" && Number.isFinite(row.size)) card.size = row.size;
		if (typeof row?.mtime === "number" && Number.isFinite(row.mtime)) card.mtime = row.mtime;
		const excerpt = str(row?.excerpt);
		if (excerpt) card.excerpt = excerpt;
		if (row?.excerptTruncated === true) card.excerptTruncated = true;
		return card;
	});
}

/** 卡片标题：优先模型给的，缺省用「N 个文件」之类的兜底由组件出文案。 */
export function presentTitle(args: PresentArgs, details: unknown): string | undefined {
	const det = asRecord(details);
	return str(det?.title) ?? args.title;
}

/** 卡片说明（markdown 富渲染）。 */
export function presentNote(args: PresentArgs, details: unknown): string | undefined {
	const det = asRecord(details);
	return str(det?.note) ?? args.note;
}

/** 能内联在对话里直接播/看吗（详情见组件：image <img> / video / audio）。 */
export function inlineMediaKind(kind: PresentKind): "image" | "video" | "audio" | null {
	return kind === "image" || kind === "video" || kind === "audio" ? kind : null;
}

/**
 * 能不能用文件预览弹窗打开。目录与不存在的路径不给；"unknown"（details 缺失）
 * 照给——预览弹窗会自己拉内容并显示「不支持预览」，这比卡片上什么都不给好。
 */
export function previewablePresentKind(kind: PresentKind): boolean {
	return kind !== "dir" && kind !== "missing";
}

/** 卡片行的类型图标。 */
export function presentKindIcon(kind: PresentKind): string {
	switch (kind) {
		case "image":
			return "🖼";
		case "video":
			return "🎬";
		case "audio":
			return "🎵";
		case "markdown":
			return "📝";
		case "html":
			return "🌐";
		case "pdf":
			return "📕";
		case "text":
			return "📄";
		case "dir":
			return "📁";
		case "missing":
			return "⚠";
		default:
			return "📦";
	}
}

/** 体积文案（与右栏/预览弹窗同口径的粗略版本，保留一位小数只在需要时）。 */
export function formatPresentSize(bytes: number | undefined): string | undefined {
	if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 第一个被标了 focus 的条目（没有则 undefined）。 */
export function focusPresentItem(items: PresentCardItem[]): PresentCardItem | undefined {
	return items.find((i) => i.focus && previewablePresentKind(i.kind));
}

/**
 * 自动打开预览弹窗的判定（纯函数）：开关开着、条目被标了 focus、卡片是「刚发生」
 * 的（时间窗内），三者全中才开。翻旧会话/窗口化惰性挂载时 timestamp 远在过去，
 * 因此不会突然弹窗。timestamp 缺失（极端老数据）时视为不新，不开。
 */
export function shouldAutoOpenPresent(o: {
	enabled: boolean;
	seen: boolean;
	timestamp?: number;
	now: number;
	maxAgeMs: number;
}): boolean {
	if (!o.enabled || o.seen) return false;
	if (typeof o.timestamp !== "number" || !Number.isFinite(o.timestamp)) return false;
	const age = o.now - o.timestamp;
	return age >= 0 && age <= o.maxAgeMs;
}
