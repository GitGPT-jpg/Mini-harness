/// <reference lib="dom" />
/**
 * 工具定义说明弹窗的**模块级状态 store** + 两个纯函数（载荷 → 视图、请求去重键）。
 *
 * 为什么又是模块级 store（而不是把状态提到 App）：
 *  - 弹窗的触发点在**每一张工具卡**里（ToolCallBlock，消息列表里可能有几十张），
 *    渲染点却只该有一个（同一时刻只可能看一条工具定义）。
 *  - 若把 open 状态放在 ToolCallBlock 里，弹窗就得跟着卡片一起渲染 —— 卡片在
 *    消息流的滚动容器里（祖先有 transform/overflow），`position: fixed` 的弹窗会被
 *    裁掉；portal 到 body 又要每张卡都挂一份。收敛成一份全局状态后，弹窗挂在 App 上，
 *    卡片只负责「发一个打开请求」。
 *  - 与 context-menu-state.ts / composer-bridge.ts 同一套写法：模块级 cached +
 *    listener 集合 + `useSyncExternalStore`；`getToolInfoState()` 必须返回**稳定引用**
 *    （未打开恒为同一个 null），否则 useSyncExternalStore 会判定快照每次都在变而不停重渲染。
 *
 * 数据从哪来：打开时发 `get_tool_info`（服务端现取 SDK / DSH 运行时的工具定义），
 * 应答 `tool_info` 由 use-chat 交给 `receiveToolInfo`。**刻意不缓存**：定义里的
 * `active`（当前是否启用）会随设置面板的开关变化，缓存就得处理失效；本地往返只有毫秒级，
 * 每次现取最省心。
 */
import { useSyncExternalStore } from "react";
import { appSend } from "./app-globals";
import type { ServerMessage } from "./types";

/** `tool_info` 应答（wire 类型）。 */
export type ToolInfoPayload = Extract<ServerMessage, { type: "tool_info" }>;

/** 弹窗当前该显示什么：
 *  - `loading`     已发出请求、还没回来（本地往返，通常一闪而过）
 *  - `ready`       拿到定义
 *  - `missing`     引擎里没有这个工具（例如历史消息里已卸载的插件工具）
 *  - `unsupported` 当前引擎不支持枚举工具定义
 */
type ToolInfoStatus = "loading" | "ready" | "missing" | "unsupported";

/** 弹窗视图状态（= 请求名 + 状态 + 定义字段）。 */
export interface ToolInfoView {
	name: string;
	status: ToolInfoStatus;
	label?: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: unknown;
	parametersDropped?: boolean;
	active?: boolean;
	source?: string;
	scope?: string;
}

/**
 * 应答载荷 → 视图状态（纯函数，单测覆盖）。
 *
 * 优先级：引擎不支持 > 没找到 > 有定义。**unsupported 优先于 missing** ——
 * 「引擎不支持」与「工具名不存在」对用户的含义完全不同（前者不是他写错了）。
 */
export function toolInfoView(payload: ToolInfoPayload): ToolInfoView {
	const name = typeof payload.name === "string" ? payload.name : "";
	if (payload.unsupported === true) return { name, status: "unsupported" };
	if (payload.found !== true) return { name, status: "missing" };
	const view: ToolInfoView = { name, status: "ready" };
	if (payload.label) view.label = payload.label;
	if (payload.description) view.description = payload.description;
	if (payload.promptSnippet) view.promptSnippet = payload.promptSnippet;
	if (Array.isArray(payload.promptGuidelines) && payload.promptGuidelines.length > 0) {
		view.promptGuidelines = payload.promptGuidelines;
	}
	if (payload.parameters !== undefined) view.parameters = payload.parameters;
	if (payload.parametersDropped === true) view.parametersDropped = true;
	if (payload.active === true || payload.active === false) view.active = payload.active;
	if (payload.source) view.source = payload.source;
	if (payload.scope) view.scope = payload.scope;
	return view;
}

/* ------------------------------------------------------------------ */
/* 状态 store（模块级单例）                                              */
/* ------------------------------------------------------------------ */

/** 当前打开的弹窗；null = 没打开。**引用稳定**：只在 open/close/receive 时替换。 */
let cached: ToolInfoView | null = null;

const listeners = new Set<() => void>();

function notify(): void {
	for (const l of listeners) l();
}

/**
 * 打开某条工具的定义弹窗：立刻显示「读取中」，同时向服务端要定义。
 *
 * 工具名为空（脏数据）时什么都不做 —— 弹一个永远读不出来的空窗没有意义。
 */
export function openToolInfo(name: string): void {
	const toolName = (name ?? "").trim();
	if (!toolName) return;
	cached = { name: toolName, status: "loading" };
	notify();
	appSend({ type: "get_tool_info", name: toolName });
}

/** 关闭弹窗。已经关着时不通知（避免多余的渲染）。 */
export function closeToolInfo(): void {
	if (cached === null) return;
	cached = null;
	notify();
}

/**
 * 收到 `tool_info` 应答（由 use-chat 转发）。
 *
 * 只认**当前正在等的那条**：用户可能在请求飞行途中关掉弹窗或右键了另一条工具，
 * 此时迟到的应答不该把弹窗重新弹出来，也不该覆盖已切换到的另一条工具。
 */
export function receiveToolInfo(payload: ToolInfoPayload): void {
	if (cached === null || cached.name !== payload.name) return;
	cached = toolInfoView(payload);
	notify();
}

/** 订阅变更（React 组件请用 useToolInfoState）。返回退订函数。 */
export function subscribeToolInfo(cb: () => void): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

/** 当前视图（未打开 = null，恒为同一引用）。 */
export function getToolInfoState(): ToolInfoView | null {
	return cached;
}

/** 仅供单测：清空状态（不通知订阅者），避免用例之间互相串。 */
export function resetToolInfo(): void {
	cached = null;
}

/** React hook：组件里 `const info = useToolInfoState();` */
export function useToolInfoState(): ToolInfoView | null {
	return useSyncExternalStore(subscribeToolInfo, getToolInfoState, getToolInfoState);
}
