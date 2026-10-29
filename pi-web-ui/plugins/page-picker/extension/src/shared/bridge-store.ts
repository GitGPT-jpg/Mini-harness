/// <reference path="../chrome.d.ts" />
/**
 * 配对表的存储（`chrome.storage.local`）+ host 权限检查。
 *
 * 为什么是 local 而不是 sync（扩展的其它设置都在 sync）：host 权限是**本机**授予的，
 * 配对跟着权限走。同步到别的设备只会得到一份「那边没授权、调不通」的配对，
 * 用户还得自己删 —— 那不是同步，那是搬运垃圾。
 *
 * 读写都过 `normalizePairs`：存储可能被手改、被旧版本写过、被导出的 JSON 覆盖过。
 * 坏数据只会让某一对失效，绝不能让整条桥挂掉。
 */

import { normalizeAiPages, normalizePairs, normalizeRecent, rememberRecent, type AiPage, type BridgePair, type RecentOrigin } from "./bridge.js";

export const PAIRS_KEY = "bridgePairs";
/** 最近点过扩展图标的页面（配对候选）。 */
export const RECENT_KEY = "recentOrigins";
/** 被授权「让 AI 操作」的页面（`browser_page` 工具的目标）。 */
export const AI_PAGES_KEY = "aiPages";

/** 读配对表（读不到/脏数据 → 空表，绝不抛）。 */
export async function loadPairs(): Promise<BridgePair[]> {
	try {
		const raw = (await chrome.storage.local.get([PAIRS_KEY])) as Record<string, unknown> | undefined;
		return normalizePairs(raw?.[PAIRS_KEY]);
	} catch {
		return [];
	}
}

/** 写配对表（写入前也归一，保证存进去的就是读出来会得到的）。 */
export async function savePairs(pairs: BridgePair[]): Promise<void> {
	await chrome.storage.local.set({ [PAIRS_KEY]: normalizePairs(pairs) });
}

/**
 * 这个 match pattern 的 host 权限有没有。
 *
 * 拿不到 permissions API 的环境按「有」处理（老浏览器 / 测试替身）—— 这里只用来
 * 避免「没权限还去 tabs.query，被静默忽略后把请求转到无关页面上」这个坑，
 * 不该成为功能本身的前置条件。
 */
export async function hasOriginPermission(pattern: string): Promise<boolean> {
	const perms = chrome.permissions;
	if (!perms?.contains) return true;
	try {
		return await perms.contains({ origins: [pattern] });
	} catch {
		return true;
	}
}

/** 读配对候选（最近点过扩展图标的页面）。 */
export async function loadRecent(): Promise<RecentOrigin[]> {
	try {
		const raw = (await chrome.storage.local.get([RECENT_KEY])) as Record<string, unknown> | undefined;
		return normalizeRecent(raw?.[RECENT_KEY]);
	} catch {
		return [];
	}
}

/**
 * 记一次「用户在这个页面上点过扩展图标」。
 *
 * 调用点只有两处：点图标的入口（`handleAction`）与拾取浮条上的「与另一页配对…」。两者都是
 * **用户在某个页面上主动发起**的时刻 —— 正好也是 `activeTab` 让 url 可读的时刻。
 * 失败只是少一个候选，绝不打断当前动作（拾取器必须照注入）。
 */
export async function rememberOrigin(origin: unknown, title?: string): Promise<void> {
	try {
		const before = await loadRecent();
		const after = rememberRecent(before, origin, title ? { title } : {});
		await chrome.storage.local.set({ [RECENT_KEY]: after });
	} catch {
		/* 记不上就算了：它只是个下拉候选 */
	}
}

/** 读「已授权给 AI 操作」的页面列表。 */
export async function loadAiPages(): Promise<AiPage[]> {
	try {
		const raw = (await chrome.storage.local.get([AI_PAGES_KEY])) as Record<string, unknown> | undefined;
		return normalizeAiPages(raw?.[AI_PAGES_KEY]);
	} catch {
		return [];
	}
}

/** 写授权列表（写入前归一，保证存进去的就是读出来会得到的）。 */
export async function saveAiPages(pages: AiPage[]): Promise<void> {
	await chrome.storage.local.set({ [AI_PAGES_KEY]: normalizeAiPages(pages) });
}

/** 新增/更新一个授权页面（已存在就只更新标题与时间）。返回新列表。 */
export async function grantAiPage(origin: unknown, title?: string): Promise<AiPage[]> {
	const before = await loadAiPages();
	const name = (title ?? "").trim();
	const after = normalizeAiPages([
		{ origin, ...(name ? { title: name } : {}), at: new Date().toISOString() },
		...before,
	]);
	await saveAiPages(after);
	return after;
}

/** 撤销一个页面的授权（按 origin）。返回新列表。 */
export async function revokeAiPage(origin: unknown): Promise<AiPage[]> {
	const self = String(origin ?? "").trim();
	const after = (await loadAiPages()).filter((p) => p.origin !== self);
	await saveAiPages(after);
	return after;
}
