/**
 * Wire protocol types for the web frontend.
 *
 * ⚠️ 本文件不再手工维护协议类型：`export type *` 直接再导出唯一事实源
 * server/protocol.ts（纯类型，构建时整体擦除，不共享任何运行时代码）。
 * 协议改动只需改 server/protocol.ts，双端永远同步。
 * 之前的手工镜像已废弃——新增消息漏同步导致前端静默丢消息的坑从此不存在。
 *
 * 只放**前端本地**的类型（不属于 wire 协议的 UI 数据结构）在下方。
 */
export type * from "../../server/protocol";

// 本地类型引用到的协议类型（export type * 不会把名字带进本地作用域）
import type { FileEntry, PptxSlidePayload, PptxSlideImagePayload } from "../../server/protocol";
export type { FileEntry, PptxSlidePayload, PptxSlideImagePayload };

// ---------------------------------------------------------------------------
// 前端本地类型（server 不发送/接收这些结构本身，或仅作为消息字段的一部分）
// ---------------------------------------------------------------------------

/** 前端 WebSocket 连接状态。 */
export type ConnStatus = "connecting" | "open" | "closed";

export interface FileListing {
	path: string;
	parent: string | null;
	entries: FileEntry[];
	/**
	 * The directory had more entries than the platform cap (win32: 2000,
	 * posix: 500) — the list was cut short. UI shows a hint when true.
	 */
	truncated: boolean;
	/**
	 * true = 机器浏览模式（此电脑/盘符/工作区外绝对路径）：path/entries 为绝对
	 * wire 路径；false/缺省 = 工作区相对视图。
	 */
	absolute?: boolean;
}

/** Content of a workspace file fetched for the preview panel. */
export interface FileContent {
	path: string;
	name: string;
	/**
	 * Preview category: media kinds render via the /api/file HTTP endpoint
	 * (text stays empty); "none" means not previewable.
	 */
	kind: "image" | "video" | "audio" | "text" | "none";
	text: string;
	truncated: boolean;
	binary: boolean;
	lines: number;
	size: number;
	slides?: PptxSlidePayload[];
}

/** A tool FINISHED executing (payload of the tool_status ServerMessage). */
export interface ToolStatus {
	toolCallId: string;
	toolName: string;
	isError: boolean;
	/** Exit code when the tool result carries one (bash: parsed from error text). */
	exitCode?: number;
	/** tool_execution_start → tool_execution_end, in ms. */
	durationMs?: number;
}
