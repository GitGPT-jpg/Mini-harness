/// <reference lib="dom" />
/**
 * 宽屏聊天列开关（纯前端 localStorage，不经过 server）。
 *
 * - 默认关闭：中央列保持 860px 上限。
 * - 开启后：`.main` 挂 `wide-chat`，所有 860px 上限的消息/输入/附件元素
 *   改为铺满列宽（左右各留 260px 内边距，与问题导航栏同宽）。
 * - normalize/load 为纯函数，可单测（tests/unit/chat-width-settings.test.ts）。
 */

import { useSyncExternalStore } from "react";

const CHAT_WIDTH_SETTINGS_KEY = "pi-web-ui:wide-chat";

interface ChatWidthSettings {
	/** 中央列是否铺满宽度（false = 保持 860px 上限） */
	wide: boolean;
}

export const DEFAULT_CHAT_WIDTH_SETTINGS: ChatWidthSettings = { wide: false };

/** 规整设置值：非对象 / 字段类型错误一律回退默认值。 */
export function normalizeChatWidthSettings(raw: unknown): ChatWidthSettings {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_CHAT_WIDTH_SETTINGS };
	const o = raw as Record<string, unknown>;
	return {
		wide: typeof o.wide === "boolean" ? o.wide : DEFAULT_CHAT_WIDTH_SETTINGS.wide,
	};
}

/** 读取持久化的开关（localStorage 不可用 / 数据损坏时回退默认关闭）。 */
function loadChatWidthSettings(): ChatWidthSettings {
	try {
		const raw = localStorage.getItem(CHAT_WIDTH_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_CHAT_WIDTH_SETTINGS };
		return normalizeChatWidthSettings(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_CHAT_WIDTH_SETTINGS };
	}
}

/** 保存并广播变更（localStorage 不可写时静默忽略）。 */
export function saveChatWidthSettings(s: ChatWidthSettings): void {
	const norm = normalizeChatWidthSettings(s);
	try {
		localStorage.setItem(CHAT_WIDTH_SETTINGS_KEY, JSON.stringify(norm));
	} catch {
		/* ignore */
	}
	cached = norm;
	for (const l of listeners) l();
}

// ---- 订阅：单例 listener 集合。----------------------------------------------

let cached: ChatWidthSettings | null = null;
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

function getSnapshot(): boolean {
	if (!cached) cached = loadChatWidthSettings();
	return cached.wide;
}

/** 中央列当前是否铺满宽度（设置面板切换后即时生效，无需刷新）。 */
export function useWideChat(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot);
}

// ---- 隐藏聊天中的模型名字行（紧凑对话流）------------------------------------

const HIDE_MODEL_ROW_SETTINGS_KEY = "pi-web-ui:hide-model-row";

export interface HideModelRowSettings {
	/** 是否隐藏聊天中的模型名字行（助手消息顶栏 .msg-meta），使对话流更紧凑 */
	hide: boolean;
}

export const DEFAULT_HIDE_MODEL_ROW_SETTINGS: HideModelRowSettings = { hide: false };

/** 规整隐藏模型名字行设置：非对象 / 字段类型错误一律回退默认关闭。 */
export function normalizeHideModelRowSettings(raw: unknown): HideModelRowSettings {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_HIDE_MODEL_ROW_SETTINGS };
	const o = raw as Record<string, unknown>;
	return {
		hide: typeof o.hide === "boolean" ? o.hide : DEFAULT_HIDE_MODEL_ROW_SETTINGS.hide,
	};
}

function loadHideModelRowSettings(): HideModelRowSettings {
	try {
		const raw = localStorage.getItem(HIDE_MODEL_ROW_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_HIDE_MODEL_ROW_SETTINGS };
		return normalizeHideModelRowSettings(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_HIDE_MODEL_ROW_SETTINGS };
	}
}

export function saveHideModelRowSettings(s: HideModelRowSettings): void {
	const norm = normalizeHideModelRowSettings(s);
	try {
		localStorage.setItem(HIDE_MODEL_ROW_SETTINGS_KEY, JSON.stringify(norm));
	} catch {
		/* ignore */
	}
	cachedHideModelRow = norm;
	for (const l of hideModelRowListeners) l();
}

let cachedHideModelRow: HideModelRowSettings | null = null;
const hideModelRowListeners = new Set<() => void>();

function subscribeHideModelRow(onStoreChange: () => void): () => void {
	hideModelRowListeners.add(onStoreChange);
	return () => {
		hideModelRowListeners.delete(onStoreChange);
	};
}

function getHideModelRowSnapshot(): boolean {
	if (!cachedHideModelRow) cachedHideModelRow = loadHideModelRowSettings();
	return cachedHideModelRow.hide;
}

/** 当前是否隐藏聊天中的模型名字行（设置面板切换后即时生效，无需刷新）。 */
export function useHideModelRow(): boolean {
	return useSyncExternalStore(subscribeHideModelRow, getHideModelRowSnapshot);
}
