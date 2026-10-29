// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactPage, openExtensionOptions, pageCitation, queryBrowserControl } from "../../web/src/browser-control";

/**
 * pi-web-ui 侧的「浏览器操作」入口靠这两个函数拿到状态、并把用户送到扩展设置页。
 *
 * 关键纪律：**永远 resolve、永远给出人能照做的下一步** ——
 * 用户看到的状态面板是他们唯一能发现这个能力的地方，这里抛错或返回空状态等于功能消失。
 */

type PageCall = (opts: {
	op: string;
	timeoutMs?: number;
}) => Promise<{ ok: boolean; result?: unknown; error?: string }>;

/** 装一个假宿主桥（真桥是 page-picker 注入的 window.__piWebUiHost）。 */
function installHost(pageCall: PageCall): ReturnType<typeof vi.fn> {
	const fn = vi.fn(pageCall);
	(globalThis as unknown as Record<string, unknown>).__piWebUiHost = { pageCall: fn };
	return fn;
}

afterEach(() => {
	delete (globalThis as unknown as Record<string, unknown>).__piWebUiHost;
	delete (window as unknown as Record<string, unknown>).piDesktop;
});

describe("queryBrowserControl", () => {
	it("没有宿主桥（扩展没装/没启用/本页没绑地址）→ available:false + 一句怎么做", async () => {
		const status = await queryBrowserControl();
		expect(status.available).toBe(false);
		expect(status.pages).toEqual([]);
		expect(status.error).toContain("page-picker"); // 点名要装什么
		expect(status.error).toContain("刷新"); // 给下一步
	});

	it("桥在但扩展报错 → 把原因原样带出来（不吞掉）", async () => {
		installHost(async () => ({ ok: false, error: "页面桥只能从 http/https 页面上发起" }));
		const status = await queryBrowserControl();
		expect(status).toEqual({ available: false, pages: [], error: "页面桥只能从 http/https 页面上发起" });
	});

	it("桥抛异常也 resolve（面板要能显示“查不到”，不是白屏）", async () => {
		installHost(async () => {
			throw new Error("Extension context invalidated");
		});
		const status = await queryBrowserControl();
		expect(status.available).toBe(false);
		expect(String(status.error)).toContain("Extension context invalidated");
	});

	it("正常状态：授权页面、两个开关都解析出来", async () => {
		const pageCall = installHost(async () => ({
			ok: true,
			result: {
				installed: true,
				aiControl: true,
				allowEval: false,
				pages: [{ origin: "http://localhost:5173", title: "我的开发站", open: true }],
				optionsUrl: "chrome-extension://abc/options.html",
			},
		}));
		const status = await queryBrowserControl();
		expect(pageCall).toHaveBeenCalledWith({ op: "status", timeoutMs: 5000 });
		expect(status).toEqual({
			available: true,
			aiControl: true,
			allowEval: false,
			pages: [{ origin: "http://localhost:5173", title: "我的开发站", open: true }],
		});
	});

	it("桌面壳（Electron）→ desktop:true + 直接给结论，不碰宿主桥（桥在也没用）", async () => {
		(window as unknown as Record<string, unknown>).piDesktop = { isDesktop: true };
		// 即使宿主桥在（桌面壳里 __piWebUiHost 是存在的），也不该去等页面桥
		installHost(async () => {
			throw new Error("should not be called in desktop shell");
		});
		const status = await queryBrowserControl();
		expect(status.available).toBe(false);
		expect(status.desktop).toBe(true);
		expect(status.pages).toEqual([]);
		expect(status.error).toContain("桌面版");
	});

	it("返回体脏（pages 不是数组）→ 当成没有页面，不炸", async () => {
		installHost(async () => ({ ok: true, result: { installed: true, pages: "nope" } }));
		const status = await queryBrowserControl();
		expect(status.available).toBe(true);
		expect(status.pages).toEqual([]);
	});
});

describe("openExtensionOptions", () => {
	it("请扩展打开它自己的设置页（网页不能自己导航过去）", async () => {
		const pageCall = installHost(async () => ({ ok: true, result: { opened: true } }));
		await expect(openExtensionOptions()).resolves.toBe(true);
		expect(pageCall).toHaveBeenCalledWith({ op: "openOptions", timeoutMs: 5000 });
	});

	it("桥不在 / 扩展拒绝 → false（面板据此提示用户手动去扩展）", async () => {
		await expect(openExtensionOptions()).resolves.toBe(false);
		installHost(async () => ({ ok: false, error: "打不开" }));
		await expect(openExtensionOptions()).resolves.toBe(false);
	});
});

describe("compactPage / pageCitation（顶栏单页紧凑态 + 网页引用 chip）", () => {
	const a = { origin: "https://a.example", title: "A 页", open: true };
	const b = { origin: "https://b.example", title: "B 页", open: false };

	it("只有一个已授权页面 → 顶栏按钮直接变成它", () => {
		expect(compactPage([a])).toEqual(a);
	});

	it("没授权 / 多个页面 → 不进入紧凑态（保持「浏览器操作 · N」+ 面板）", () => {
		expect(compactPage([])).toBeNull();
		expect(compactPage([a, b])).toBeNull();
	});

	it("引用附件：path 用 origin（不是完整 URL）、name 用标题、key 用于去重", () => {
		expect(pageCitation(a)).toEqual({
			path: "https://a.example",
			name: "A 页",
			mode: "page",
			key: "page:https://a.example",
		});
	});

	it("没有标题（或全是空白）→ 退化成 origin，chip 上不会空着", () => {
		expect(pageCitation({ origin: "https://a.example" }).name).toBe("https://a.example");
		expect(pageCitation({ origin: "https://a.example", title: "   " }).name).toBe("https://a.example");
	});
});
