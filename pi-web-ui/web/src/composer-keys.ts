/// <reference lib="dom" />
/**
 * composer-keys.ts —— 输入框回车键语义偏好与按键行为解析（issue #664）。
 *
 * 两种模式：
 *   - "enter": 回车发送，Shift+Enter 换行（桌面传统行为）；
 *   - "mod-enter": 回车换行，Ctrl/Cmd+Enter 发送（触屏默认或长文习惯）。
 *
 * 优先级契约：
 *   1. 用户显式偏好优先（保存在 localStorage 键 "pi-web-send-key"）；
 *   2. 未设置（null）时回退到设备判定：触屏优先设备回退 "mod-enter"，桌面回退 "enter"；
 *   3. 判定结果为纯函数，不依赖 DOM，方便单测（tests/unit/composer-keys.test.ts）。
 */

import { useSyncExternalStore } from "react";
import { detectTouchFirstDevice } from "./touch-device";

export type SendKey = "enter" | "mod-enter";

export type EnterAction = "send" | "newline" | "ignore";

export const SEND_KEY_STORAGE_KEY = "pi-web-send-key";

export interface ResolveEnterActionParams {
	key: string;
	shiftKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
	isTouch?: boolean;
	pref?: SendKey | null;
}

/**
 * 解析实际生效的发送快捷键模式。
 * 规则：显式设置 > 触屏自动判定（触屏默认 mod-enter，桌面默认 enter）。
 */
export function resolveEffectiveSendKey(pref: SendKey | null | undefined, isTouch: boolean): SendKey {
	if (pref === "enter" || pref === "mod-enter") return pref;
	return isTouch ? "mod-enter" : "enter";
}

/**
 * 纯函数：根据当前按键信息与生效配置，判定回车语义应触发的动作：
 *   - "send": 阻止默认行为并触发 submit()
 *   - "newline": 不阻止默认行为，普通换行
 *   - "ignore": 非 Enter 按键，不处理
 */
export function resolveEnterAction(params: ResolveEnterActionParams): EnterAction {
	if (params.key !== "Enter") return "ignore";

	const mode = resolveEffectiveSendKey(params.pref, Boolean(params.isTouch));
	if (mode === "enter") {
		// enter 模式下：Shift+Enter 为换行，其余发送
		if (params.shiftKey) return "newline";
		return "send";
	}
	// mod-enter 模式下：Ctrl/Cmd+Enter（且不含 Shift）为发送，其余一律换行
	if ((params.ctrlKey || params.metaKey) && !params.shiftKey) {
		return "send";
	}
	return "newline";
}

/** 读取 localStorage 中用户显式配置的偏好（未配置或格式非法返回 null）。 */
export function loadSendKeyPref(): SendKey | null {
	try {
		const raw = localStorage.getItem(SEND_KEY_STORAGE_KEY);
		if (raw === "enter" || raw === "mod-enter") return raw;
		return null;
	} catch {
		return null;
	}
}

/** 保存偏好到 localStorage 并广播给外部订阅者。 */
export function saveSendKeyPref(pref: SendKey): void {
	try {
		localStorage.setItem(SEND_KEY_STORAGE_KEY, pref);
	} catch {
		/* ignore */
	}
	cached = pref;
	for (const l of listeners) l();
}

// ---- 响应式订阅（useSyncExternalStore） ---------------------------------------

let cached: SendKey | null = null;
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

function getSnapshot(): SendKey | null {
	if (cached === null) cached = loadSendKeyPref();
	return cached;
}

/** 响应式订阅显式偏好（未配置时返回 null）。 */
export function useSendKeyPref(): SendKey | null {
	return useSyncExternalStore(subscribe, getSnapshot);
}

/** 响应式获取当前实际生效的发送按键模式（缺省自动结合设备类型）。 */
export function useEffectiveSendKey(isTouch: boolean = detectTouchFirstDevice()): SendKey {
	const pref = useSendKeyPref();
	return resolveEffectiveSendKey(pref, isTouch);
}

/** 测试辅助：清空缓存和监听器。 */
export function _resetSendKeyCacheForTest(): void {
	cached = null;
	listeners.clear();
}
