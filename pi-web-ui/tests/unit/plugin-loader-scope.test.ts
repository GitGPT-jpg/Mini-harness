/**
 * 插件 bundle 的**加载作用域**（issue #268）。
 *
 * `plugin-host.ts` 的 `pluginScope` 是模块级变量，而 `plugin-loader.ts` 用
 * `Promise.all` 并发加载各插件 bundle。两个 bundle 的求值交错时，后启动的那个会把
 * 全局作用域改成自己的 id —— 前一个插件在模块顶层 / 异步回调里调
 * `host.onUiAction("notes:toggle")` 时，注册键就变成 `<别的插件>:notes:toggle`；
 * 宿主派发时 `notes:notes:toggle` 与裸名都查不到，于是 kind="action" 的条目一点
 * 就弹「插件没有接管这个动作」。
 *
 * 这里锁三件事：
 *   1. 并发加载（createScopedImporter）不会串台；
 *   2. 单个插件加载失败不会卡住后面的插件（闸门不能变成死锁）；
 *   3. 真实调用点确实走了这个导入器（静态检查，防退回直接 import）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createScopedImporter } from "../../web/src/plugin-loader";
import { createPluginHostApi, triggerPluginUiAction } from "../../web/src/plugin-host";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 最小宿主 API：只要 onUiAction 能注册、能被宿主派发到就够。 */
function hostApi() {
	return createPluginHostApi({
		send: () => true,
		isReady: () => true,
		setView: () => {},
		getCwd: () => "",
		getWorkspaceRoots: () => [],
		listSessions: () => [],
		getConversationId: () => null,
		isConversationBlank: () => false,
		pollMs: 2,
		timeoutMs: 200,
	});
}

describe("插件 bundle 加载作用域（#268）", () => {
	it("并发加载时每个插件的注册都落在自己的命名空间", async () => {
		const api = hostApi();
		const called: string[] = [];
		// 交错顺序刻意做成「A 的模块体先就绪、B 后设作用域但更慢返回」——
		// 这正是无闸门时会把 A 的注册绑到 B 名下的时序。
		const importFn = async (url: string) => {
			if (url === "a") {
				await sleep(5);
				api.onUiAction("toggle-a", () => called.push("a"));
			} else {
				await sleep(30);
				api.onUiAction("toggle-b", () => called.push("b"));
			}
			return { default: { mount: () => {} } };
		};
		const importPluginBundle = createScopedImporter(importFn);
		await Promise.all([importPluginBundle("scopeA", "a"), importPluginBundle("scopeB", "b")]);

		// 派发不带 loadBundle：命中就立即返回，未命中也不会去轮询 1.5s。
		expect(await triggerPluginUiAction("scopeA", "toggle-a", "item")).toBe(true);
		expect(await triggerPluginUiAction("scopeB", "toggle-b", "item")).toBe(true);
		expect(called).toEqual(["a", "b"]);
	});

	it("两个插件注册同名 action 时互不串台", async () => {
		const api = hostApi();
		const importFn = async (url: string) => {
			await sleep(url === "same-a" ? 5 : 30);
			// 同名 action：只有落在自己命名空间下才不会互相顶掉。
			api.onUiAction("same-toggle", () => {});
			return { default: { mount: () => {} } };
		};
		const importPluginBundle = createScopedImporter(importFn);
		await Promise.all([importPluginBundle("sameA", "same-a"), importPluginBundle("sameB", "same-b")]);

		expect(await triggerPluginUiAction("sameA", "same-toggle", "item")).toBe(true);
		expect(await triggerPluginUiAction("sameB", "same-toggle", "item")).toBe(true);
	});

	it("一个插件加载失败不会卡住后面的插件", async () => {
		const api = hostApi();
		const importFn = async (url: string) => {
			if (url === "boom") throw new Error("bundle 下载失败");
			api.onUiAction("after-toggle", () => {});
			return { default: { mount: () => {} } };
		};
		const importPluginBundle = createScopedImporter(importFn);
		await expect(importPluginBundle("boomPlugin", "boom")).rejects.toThrow("bundle 下载失败");
		// 闸门必须已经放行（否则这次会一直挂到测试超时）。
		await importPluginBundle("afterPlugin", "after");
		expect(await triggerPluginUiAction("afterPlugin", "after-toggle", "item")).toBe(true);
	});

	it("真实加载路径走的是带闸门的导入器（静态检查）", () => {
		const src = readFileSync(fileURLToPath(new URL("../../web/src/plugin-loader.ts", import.meta.url)), "utf8");
		expect(src).toContain("importPluginBundle(p.id, pluginEntryUrl(p.id, epoch))");
		// 除了 createScopedImporter 内部那一次，不应再有绕过作用域的动态 import。
		const directImports = src.split("\n").filter((l) => l.includes("import(/* @vite-ignore */"));
		expect(directImports).toHaveLength(1);
	});
});
