/**
 * session-search — 会话转录文件扫描、搜索匹配与锚点收集工具。
 *
 * 负责：
 * - piSessionsRoot: 解析 pi 引擎的会话根目录环境变量
 * - isInsideSessionsDir: 校验路径是否在会话目录下，防止任意文件逃逸
 * - sessionMatchesMetadata / messageSearchText: 会话元数据与转录文本检索
 * - collectSessionAnchors: 扫描消息文本中的查询命中锚点
 * - readCwdFromSessionHeader: 轻量探测转录首行 cwd
 *
 * 从 agent-service.ts 抽出为独立模块。
 */
import { readFileSync, statSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { MessageAnchor } from "./protocol.js";

/** 转录全文扫描/整读的大小上限（16MB，与 readHistorySession 一致）：
 *  超限文件同步 readFileSync 会卡事件循环数百毫秒起，搜索不值得。 */
export const MAX_TRANSCRIPT_SCAN_BYTES = 16 * 1024 * 1024;

/** 转录全文进入内存/缓存的字符上限（256K 字符）：全文只服务搜索的命中判定
 *  （issue #440 拆分后按需加载），封顶保证单条 worst case 内存可控（缓存 256 条
 *  × 256K 字符 ≈ 64MB 上界，且只在搜索活动期间存在）。
 *  影响面：超长转录在截断点之后的内容不参与「是否命中」判定；命中后的消息级
 *  定位（collectSessionAnchors）仍扫全文件，不受此上限影响。 */
export const MAX_SEARCH_TEXT_CHARS = 256 * 1024;

/** 会话元数据快速匹配（列表初筛）：仅比对 session.name、会话文件名与第一条消息。
 *  显示名、当前项目内的文件名片段、首条消息。
 *  转录全文匹配不在这里：全文单条可达 MB 级，不再随列表缓存常驻（issue #440），
 *  由 filterSessionsForSearch 按需加载后判定（口径不变：user 与 assistant 消息文本）。 */
export function sessionMatchesMetadata(q: string, s: SessionInfo): boolean {
	if (s.name && s.name.toLowerCase().includes(q)) return true;
	if (basename(s.path).toLowerCase().includes(q)) return true;
	if (s.firstMessage.toLowerCase().includes(q)) return true;
	return false;
}

/** 抽取一条 AgentMessage 的可搜索文本（user/assistant 的 text 块；
 *  镜像 SDK buildSessionInfo 的 allMessagesText 范围，保证搜索与定位一致）。 */
export function messageSearchText(m: { content?: unknown }): string {
	const c = m.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	const parts: string[] = [];
	for (const b of c) {
		if (!b || typeof b !== "object") continue;
		const blk = b as { type?: unknown; text?: unknown };
		if (blk.type === "text" && typeof blk.text === "string") parts.push(blk.text);
	}
	return parts.join("\n");
}

/** 扫描一个会话转录文件，收集文本命中查询的消息锚点（role + timestamp，
 *  按转录顺序，最多 cap 个）。仅 user/assistant 消息参与，与搜索范围一致。
 *  超过大小上限的转录直接跳过（stat 先行，不整读）—— 全局搜索逐会话同步
 *  扫描，无上限时一个大转录就能冻住整个事件循环。 */
export function collectSessionAnchors(filePath: string, q: string, cap = 10): MessageAnchor[] {
	const anchors: MessageAnchor[] = [];
	if (!q) return anchors;
	try {
		if (statSync(filePath).size > MAX_TRANSCRIPT_SCAN_BYTES) return anchors;
		const lines = readFileSync(filePath, "utf8").split("\n");
		for (const line of lines) {
			if (!line.trim()) continue;
			let e: {
				type?: unknown;
				message?: { role?: unknown; timestamp?: unknown; content?: unknown };
			};
			try {
				e = JSON.parse(line);
			} catch {
				continue;
			}
			if (e?.type !== "message") continue;
			const m = e.message;
			if (!m) continue;
			if (m.role !== "user" && m.role !== "assistant") continue;
			if (typeof m.timestamp !== "number") continue;
			const text = messageSearchText(m);
			if (!text || !text.toLowerCase().includes(q)) continue;
			anchors.push({ role: m.role, timestamp: m.timestamp });
			if (anchors.length >= cap) break;
		}
	} catch {
		// 单个转录损坏不影响其余会话
	}
	return anchors;
}

/**
 * pi 的会话存储根目录。设置了 `PI_CODING_AGENT_SESSION_DIR` 时，pi 将 transcript
 * 以**扁平布局**直接写在根目录顶层（`<root>/<timestamp>_<uuid>.jsonl`，所属 cwd 是
 * 文件内字段）；未设置时走 SDK 默认的 `<agentDir>/sessions/--<cwd>--/` 每-cwd
 * 子目录布局（此时必须**不传** sessionDir，让 SDK 落回默认路径）。
 *
 * 注意：未设置 env 时**不要**回退返回 `join(getAgentDir(), "sessions")`——那样会把
 * 根目录强塞给 SDK `list()/listAll()`，它们只会扫根目录**顶层** jsonl，默认子目录布局
 * 下顶层为空，历史对话/最近项目会全丢（回归风险，已在 0.84.4 实证）。
 */
export function piSessionsRoot(): string | undefined {
	return process.env.PI_CODING_AGENT_SESSION_DIR || undefined;
}

/** Guardrail: only transcripts under a sessions root may be opened/deleted/renamed
 *  — never arbitrary files. Two roots count as “a sessions root”, and they must stay
 *  the **same two** the history list reads from (`loadSessionInfos` →
 *  `SessionManager.list(cwd, piSessionsRoot())`):
 *
 *   1. `<agentDir>/sessions/`（SDK 默认的每-cwd 子目录布局）
 *   2. `PI_CODING_AGENT_SESSION_DIR`（扁平「额外会话根」，设了就以它为准扫盘）
 *
 *  只认第 1 条会让设了该变量的用户「历史列得出来、却点不开/删不掉/改不了名」
 *  （列表与打开两边口径不一致）。守卫的意图是「不许开任意文件」，不是「只许开
 *  默认目录下的文件」，所以放宽到两个根仍然成立。
 *  Shared by deleteSession/renameSession/switchSession so the open path cannot
 *  escape the confinement the write paths already enforce. */
export function isInsideSessionsDir(agentDir: string, targetPath: string): boolean {
	const abs = resolve(targetPath);
	const roots = [resolve(agentDir, "sessions")];
	const extra = piSessionsRoot();
	if (extra) roots.push(resolve(extra));
	return roots.some((root) => abs.startsWith(root + sep));
}

/**
 * 从会话文件首行读取 cwd（轻量探测，最多读取 2KB，绝不完整解析整个 jsonl 消息历史）。
 */
export async function readCwdFromSessionHeader(filePath: string): Promise<string | null> {
	let handle: fsPromises.FileHandle | undefined;
	try {
		handle = await fsPromises.open(filePath, "r");
		const buf = Buffer.alloc(2048);
		const { bytesRead } = await handle.read(buf, 0, 2048, 0);
		const text = buf.toString("utf8", 0, bytesRead);
		const nl = text.indexOf("\n");
		const firstLine = nl !== -1 ? text.slice(0, nl) : text;
		if (!firstLine.trim()) return null;
		const parsed = JSON.parse(firstLine);
		return typeof parsed.cwd === "string" && parsed.cwd.trim() ? parsed.cwd : null;
	} catch {
		return null;
	} finally {
		if (handle) await handle.close().catch(() => {});
	}
}
