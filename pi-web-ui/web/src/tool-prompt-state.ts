/// <reference lib="dom" />
/**
 * 设置页「工具」区逐工具文案编辑器的**模块级状态 store**。
 *
 * 编辑器要知道两件事：该工具**出厂默认**的文案（description / promptSnippet /
 * promptGuidelines）和用户**当前设置**的覆盖（后者来自 settings_state）。默认值只有
 * 服务端知道（SDK 的工具定义），所以打开编辑器时发一次 `get_tool_prompt`，应答
 * `tool_prompt` 由 use-chat 转发给 `receiveToolPrompt`。
 *
 * 为什么不复用 tool-info-state：那条应答会弹「显示工具详细信息」弹窗，在设置页里
 * 弹它不合适（同一份定义却要两套消费行为，拆开更干净）。
 *
 * 写法与 tool-info-state.ts / context-menu-state.ts 一致：模块级缓存 + listener 集合 +
 * `useSyncExternalStore`；缓存按工具名存，`getSnapshot` 必须返回**稳定引用**。
 */
import { useSyncExternalStore } from "react";
import { appSend } from "./app-globals";
import type { ServerMessage, UiToolPromptOverride } from "./types";

/** `tool_prompt` 应答（wire 类型）。 */
export type ToolPromptPayload = Extract<ServerMessage, { type: "tool_prompt" }>;

/** 编辑器视图状态：读取中 / 拿到默认值 / 没这个工具 / 引擎不支持。 */
export interface ToolPromptView {
	name: string;
	status: "loading" | "ready" | "missing" | "unsupported";
	defaultDescription?: string;
	defaultPromptSnippet?: string;
	defaultPromptGuidelines?: string[];
	/** 服务端记录的用户覆盖（编辑器用它初始化草稿；缺省 = 没有覆盖）。 */
	override?: UiToolPromptOverride;
}

/** 应答载荷 → 视图（纯函数，单测覆盖）。 */
export function toolPromptView(payload: ToolPromptPayload): ToolPromptView {
	const name = typeof payload.name === "string" ? payload.name : "";
	if (payload.unsupported === true) return { name, status: "unsupported" };
	if (payload.found !== true) return { name, status: "missing" };
	const view: ToolPromptView = { name, status: "ready" };
	if (payload.defaultDescription) view.defaultDescription = payload.defaultDescription;
	if (payload.defaultPromptSnippet) view.defaultPromptSnippet = payload.defaultPromptSnippet;
	if (Array.isArray(payload.defaultPromptGuidelines) && payload.defaultPromptGuidelines.length > 0) {
		view.defaultPromptGuidelines = payload.defaultPromptGuidelines;
	}
	if (payload.override) view.override = payload.override;
	return view;
}

let cache: Record<string, ToolPromptView> = {};
const listeners = new Set<() => void>();

function notify(): void {
	for (const l of listeners) l();
}

/** 请求某工具的默认值 + 当前覆盖（已缓存则直接复用，避免每次开编辑器都往返一次）。 */
export function requestToolPrompt(name: string): void {
	const toolName = (name ?? "").trim();
	if (!toolName) return;
	if (cache[toolName] && cache[toolName].status !== "loading") return;
	cache = { ...cache, [toolName]: { name: toolName, status: "loading" } };
	notify();
	appSend({ type: "get_tool_prompt", name: toolName });
}

/** 收到 `tool_prompt` 应答（由 use-chat 转发）。只认请求过的工具，忽略迟到/陌生应答。 */
export function receiveToolPrompt(payload: ToolPromptPayload): void {
	const name = typeof payload.name === "string" ? payload.name : "";
	if (!name || !cache[name]) return;
	cache = { ...cache, [name]: toolPromptView(payload) };
	notify();
}

/** 保存后让缓存失效：下次打开该工具重新取（默认值不会变，但覆盖会变）。 */
export function invalidateToolPrompt(name: string): void {
	if (!cache[name]) return;
	const next = { ...cache };
	delete next[name];
	cache = next;
	notify();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** 订阅某工具文案的默认值视图（name 为空返回 null）。 */
export function useToolPromptView(name: string | null): ToolPromptView | null {
	return useSyncExternalStore(subscribe, () => (name ? (cache[name] ?? null) : null));
}
