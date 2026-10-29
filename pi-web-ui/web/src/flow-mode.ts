/**
 * 主题能力探测：正文与胶囊要不要连成「字级输入流」。
 *
 * 渲染层不认主题 id（`flow` / `flow-light` / `wallpaper-flow` 三个主题共用一个基底，
 * 用户还可能自制主题复用它），所以由主题样式表**声明能力**：
 *
 *     :root { --flow-inline-stream: 1; }
 *
 * 极简行文基底（`themes/bases/flow-base.css`）里就有这一条；没有声明的主题一律
 * 走原来的逐消息块级排版。声明式探测的好处：主题切换（<link> 换表 + 派发
 * THEME_CHANGE_EVENT）后自适应，不需要在前端维护主题白名单。
 */
import { useEffect, useState } from "react";
import { THEME_CHANGE_EVENT } from "./theme";

const MARKER = "--flow-inline-stream";

/** 当前主题是否要求「正文 + 胶囊」连成一条行内流。 */
export function isFlowStreamTheme(): boolean {
	if (typeof window === "undefined" || typeof document === "undefined") return false;
	const value = getComputedStyle(document.documentElement).getPropertyValue(MARKER).trim();
	return value === "1" || value === "true";
}

/** 订阅式版本：主题切换后自动重算（主题 <link> 的 onload 会派发 THEME_CHANGE_EVENT）。 */
export function useFlowStreamMode(): boolean {
	const [on, setOn] = useState(isFlowStreamTheme);
	useEffect(() => {
		const sync = () => setOn(isFlowStreamTheme());
		sync();
		window.addEventListener(THEME_CHANGE_EVENT, sync);
		return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
	}, []);
	return on;
}
