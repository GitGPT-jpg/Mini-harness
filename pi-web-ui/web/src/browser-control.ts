/**
 * 「AI 操作浏览器页面」在 pi-web-ui 这边的入口与状态源。
 *
 * 为什么需要它：能力做完了（`browser_page` 工具 + 扩展的授权表），但**用户那边一片空白** ——
 * 不知道有这个能力、不知道去哪开通、不知道能说什么。而这个能力的开关与授权都在浏览器扩展里，
 * 网页侧能做的只有三件事：**报告状态、把人送到扩展设置页、给出可照抄的用法**。
 *
 * 状态从哪来：宿主桥 → 扩展的 `status` 动作（见 plugins/page-picker/README.md）。
 * 扩展没装/没启用/本页没绑地址时，桥就不在 → 这里给出 `available:false` + 一句能照做的错。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { DraftAttachment } from "./composer-draft";
import { isDesktopShell } from "./desktop";

/**
 * page-picker 扩展 zip 的稳定下载地址（GitHub Release 的 latest 别名，打 tag 时 CI
 * 自动更新，见 plugins/page-picker/README.md 的「下载直接装」）。
 */
export const PAGE_PICKER_ZIP_URL =
	"https://github.com/xing-shuyin/pi-web-ui/releases/latest/download/page-picker-extension.zip";

/** 一个被授权给 AI 的页面（扩展侧的授权列表 + 它现在开没开）。 */
export interface BrowserControlPage {
	origin: string;
	title: string;
	open: boolean;
}

export interface BrowserControlStatus {
	/** 扩展在线、宿主桥可用（false 时 `error` 说明原因）。 */
	available: boolean;
	/** 桌面壳（Electron）里永远连不上扩展：面板据此换一套文案，不再引导用户装扩展。
	 *  平时（网页版）不出现这个字段（单测里 toEqual 精确匹配，别默认 false）。 */
	desktop?: boolean;
	/** 「允许 AI 操作页面」总开关。 */
	aiControl?: boolean;
	/** 「允许执行任意 JS（eval）」开关。 */
	allowEval?: boolean;
	pages: BrowserControlPage[];
	error?: string;
}

/** 宿主桥的最小面（扩展注入在页面主世界；只用到 pageCall）。 */
interface HostBridge {
	pageCall?: (opts: {
		op: string;
		args?: Record<string, unknown>;
		target?: string;
		timeoutMs?: number;
	}) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

const host = (): HostBridge["pageCall"] | undefined =>
	(window as unknown as { __piWebUiHost?: HostBridge }).__piWebUiHost?.pageCall?.bind(
		(window as unknown as { __piWebUiHost?: HostBridge }).__piWebUiHost,
	);

/** 最近一次问到的状态缓存（`@` 提及同步读 + 后台节流刷新，见 pokeBrowserControl）。
 *  只缓存成功结果：失败不断崖清空旧列表（授权页不会因一次查询抖动就消失）。 */
let lastBrowserControl: BrowserControlStatus | null = null;
let lastBrowserControlAt = 0;

/** 同步读已授权页面（缓存未命中即空数组，调用方顺手 poke 后台刷新）。 */
export function getLastBrowserControlPages(): BrowserControlPage[] {
	return lastBrowserControl?.available === true ? (lastBrowserControl.pages ?? []) : [];
}

/** 后台刷新一次状态（距上次不足 5s 即跳过；结果只进缓存，不抛错）。 */
export function pokeBrowserControl(): void {
	if (Date.now() - lastBrowserControlAt < 5000) return;
	void queryBrowserControl().catch(() => {});
}

/** 问一次状态（扩展不在线时返回可读的失败，不抛）。 */
export async function queryBrowserControl(): Promise<BrowserControlStatus> {
	// 桌面壳里没有 Chrome 扩展运行时，page-picker 永远装不上 —— 别走下面的
	// pageCall（宿主桥在桌面壳里是存在的，会白等 3 秒桥超时），直接给结论。
	if (isDesktopShell()) {
		return {
			available: false,
			pages: [],
			desktop: true,
			error: "桌面版不支持浏览器操作：窗口里没有 Chrome 扩展运行时，请改用系统浏览器打开同一个地址（网页版）",
		};
	}
	const pageCall = host();
	if (!pageCall) {
		return {
			available: false,
			pages: [],
			error: "宿主页面桥不可用：这个 pi-web-ui 页面还没装上扩展桥（装/启用 page-picker 后刷新本页）",
		};
	}
	try {
		const res = await pageCall({ op: "status", timeoutMs: 5000 });
		if (!res.ok) return { available: false, pages: [], error: res.error ?? "扩展没有返回状态" };
		const value = (res.result ?? {}) as Record<string, unknown>;
		const next: BrowserControlStatus = {
			available: value.installed === true,
			aiControl: value.aiControl === true,
			allowEval: value.allowEval === true,
			pages: Array.isArray(value.pages) ? (value.pages as BrowserControlPage[]) : [],
		};
		// 成功结果进缓存（`@` 提及同步读它；失败不清旧值，见 getLastBrowserControlPages）。
		if (next.available) {
			lastBrowserControl = next;
			lastBrowserControlAt = Date.now();
		}
		return next;
	} catch (err) {
		return { available: false, pages: [], error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * 单页紧凑态：只有一个已授权页面时，顶栏按钮直接显示它、点击即引用到对话
 * （用户的原话：输入网址太麻烦）。返回 null = 多个页面，走「浏览器操作 · N」+ 面板。
 */
export function compactPage(pages: BrowserControlPage[]): BrowserControlPage | null {
	return pages.length === 1 ? pages[0] : null;
}

/**
 * 把一个已授权页面转成待发的「网页引用」附件 chip。
 *
 * 语义要点：`path` 放的是 **origin**（不是当前完整 URL）——扩展按 origin 授权、
 * `browser_page` 的 `target` 也是 origin，放完整 URL 反而对不上；`name` 带标题，
 * 服务端拿它当卡片名（它不读文件，只给模型一句 target 提示）。
 */
export function pageCitation(page: { origin: string; title?: string }): DraftAttachment {
	return {
		path: page.origin,
		name: page.title?.trim() || page.origin,
		mode: "page",
		key: `page:${page.origin}`,
	};
}

/**
 * 请扩展打开它自己的设置页（授权与开关都在那里）。
 *
 * 为什么不让页面直接 `window.open("chrome-extension://…")`：浏览器的安全策略会直接拦掉
 * 非扩展页面往 `chrome-extension://` 的导航 —— 只能让扩展自己去开。
 */
export async function openExtensionOptions(): Promise<boolean> {
	const pageCall = host();
	if (!pageCall) return false;
	try {
		const res = await pageCall({ op: "openOptions", timeoutMs: 5000 });
		return res.ok === true;
	} catch {
		return false;
	}
}

/**
 * 状态 hook：挂载时查一次、之后定期刷新，另外在「刚打开页面、桥还没注入」时补一次。
 *
 * 补那一次很关键：页面加载与扩展注入桥是两条并行的异步，首次查询常常赶在桥之前，
 * 不补的话用户要等一整个轮询周期才看到真实状态。
 */
export function useBrowserControl(pollMs = 45000): {
	status: BrowserControlStatus | null;
	refresh: () => void;
} {
	const [status, setStatus] = useState<BrowserControlStatus | null>(null);
	const alive = useRef(true);

	const run = useCallback(async (retryIfOffline: boolean) => {
		const next = await queryBrowserControl();
		if (!alive.current) return;
		setStatus(next);
		if (retryIfOffline && !next.available) {
			// 页面刚加载 / 扩展刚重启：1.5s 后再问一次（不做无限重试，状态面板本身就是入口）
			setTimeout(() => {
				if (alive.current) void run(false);
			}, 1500);
		}
	}, []);

	useEffect(() => {
		alive.current = true;
		void run(true);
		const timer = setInterval(() => void run(false), Math.max(5000, pollMs));
		return () => {
			alive.current = false;
			clearInterval(timer);
		};
	}, [run, pollMs]);

	return { status, refresh: () => void run(true) };
}
