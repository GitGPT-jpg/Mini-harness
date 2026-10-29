import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

type ClickOutsideTarget = RefObject<HTMLElement | null> | HTMLElement | null | undefined;

interface UseClickOutsideOptions {
	/** 是否启用监听（默认 true）。 */
	enabled?: boolean;
	/**
	 * 可选：额外需要忽略的元素（点击它们不算外部，不触发回调）。
	 * 例如：触发按钮、配套的工具浮层等。
	 */
	ignore?: ClickOutsideTarget | ClickOutsideTarget[];
}

/**
 * 通用外部点击检测 Hook。
 *
 * 解决痛点：
 * 1. 【移动端支持】：同时监听 `mousedown` 与 `touchstart`，触屏设备上点外部也能正常响应；
 * 2. 【闭包安全】：onClickOutside 走 ref，闭包更新不会引起 document 事件频繁拆装；
 * 3. 【多目标支持】：支持传入单个或多个 ignore 元素，防止点触发器时触发外部关闭。
 */
export function useClickOutside(
	targetRef: RefObject<HTMLElement | null>,
	onClickOutside: (e: MouseEvent | TouchEvent) => void,
	options: UseClickOutsideOptions = {},
): void {
	const { enabled = true, ignore } = options;

	const callbackRef = useRef(onClickOutside);
	useLayoutEffect(() => {
		callbackRef.current = onClickOutside;
	});

	useEffect(() => {
		if (!enabled) return;

		const isTargetOrChild = (target: Node, elementOrRef: ClickOutsideTarget): boolean => {
			if (!elementOrRef) return false;
			const el = "current" in elementOrRef ? elementOrRef.current : elementOrRef;
			return el ? el.contains(target) : false;
		};

		const handleEvent = (e: MouseEvent | TouchEvent) => {
			const target = e.target;
			if (!(target instanceof Node)) return;

			// 如果点在目标元素内部，忽略
			if (targetRef.current?.contains(target)) return;

			// 如果点在被忽略的元素内部，忽略
			if (ignore) {
				const ignores = Array.isArray(ignore) ? ignore : [ignore];
				if (ignores.some((ig) => isTargetOrChild(target, ig))) {
					return;
				}
			}

			callbackRef.current(e);
		};

		document.addEventListener("mousedown", handleEvent);
		document.addEventListener("touchstart", handleEvent);

		return () => {
			document.removeEventListener("mousedown", handleEvent);
			document.removeEventListener("touchstart", handleEvent);
		};
	}, [enabled, targetRef, ignore]);
}
