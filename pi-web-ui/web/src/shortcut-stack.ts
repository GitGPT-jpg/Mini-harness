import { useEffect, useLayoutEffect, useRef } from "react";

type EscapeHandler = () => boolean | void;

// 存储注册的 handler 栈（后入栈的优先处理）
const escapeStack: EscapeHandler[] = [];
let listenerAttached = false;

function onKeyDown(e: KeyboardEvent) {
	if (e.key !== "Escape") return;
	if (escapeStack.length === 0) return;

	// 从栈顶往栈底检查，找到第一个消费它的 handler
	for (let i = escapeStack.length - 1; i >= 0; i--) {
		const handler = escapeStack[i];
		const consumed = handler();
		// 如果 handler 显式返回 false，表示放行给更下层；否则默认视为已消费
		if (consumed !== false) {
			e.preventDefault();
			e.stopPropagation();
			break;
		}
	}
}

function ensureListener() {
	if (!listenerAttached && typeof document !== "undefined") {
		document.addEventListener("keydown", onKeyDown, true);
		listenerAttached = true;
	}
}

function cleanupListener() {
	if (listenerAttached && escapeStack.length === 0 && typeof document !== "undefined") {
		document.removeEventListener("keydown", onKeyDown, true);
		listenerAttached = false;
	}
}

/**
 * 将一个 Escape 处理器压入栈顶。
 * 返回注销函数。后压入的 handler 优先响应 Esc。
 */
export function pushEscapeHandler(handler: EscapeHandler): () => void {
	escapeStack.push(handler);
	ensureListener();

	return () => {
		const idx = escapeStack.lastIndexOf(handler);
		if (idx >= 0) {
			escapeStack.splice(idx, 1);
		}
		cleanupListener();
	};
}

/** 仅供单元测试：重置栈状态 */
export function resetEscapeStack(): void {
	escapeStack.length = 0;
	cleanupListener();
}

/**
 * React Hook：注册当前组件的 Escape 响应。
 * 自动管理压栈与退栈，且内部走 ref，handler 闭包变化不会导致频繁重新压栈。
 *
 * @param onEscape 按 Esc 时的回调。返回 false 可放行给下一层，否则默认消费并阻止继续传播。
 * @param enabled 是否启用（默认 true）。
 */
export function useEscapeKey(onEscape: EscapeHandler, enabled = true): void {
	const handlerRef = useRef(onEscape);
	useLayoutEffect(() => {
		handlerRef.current = onEscape;
	});

	useEffect(() => {
		if (!enabled) return;
		return pushEscapeHandler(() => handlerRef.current());
	}, [enabled]);
}
