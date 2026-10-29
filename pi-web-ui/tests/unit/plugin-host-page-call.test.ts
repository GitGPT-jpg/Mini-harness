// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_HOST_API_VERSION, createPluginHostApi } from "../../web/src/plugin-host";

/**
 * 宿主桥的 `pageCall`：**模型的动作从这里进浏览器扩展**。
 *
 * 三条纪律（都是「不能让模型白等」）：
 * 1. 桥不在（扩展没装 / 没启用 / 本页地址没绑）→ 立刻给一句能照做的错，不要一直等；
 * 2. 桥在 → 把 op/args/目标原样交给它，成功后把结果回传；
 * 3. 桥抛错（页面没授权、动作失败）→ 把原因**原样**回传（它会变成模型看到的工具失败）。
 */

function api(overrides: { bridgeWaitMs?: number } = {}) {
	return createPluginHostApi({
		send: () => true,
		isReady: () => true,
		setView: () => {},
		getCwd: () => "",
		// pageCall 不碰多根/会话，这里只补足 deps 形状（避免与真契约漂移）。
		getWorkspaceRoots: () => [],
		listSessions: () => [],
		getConversationId: () => null,
		isConversationBlank: () => true,
		bridgeWaitMs: overrides.bridgeWaitMs ?? 5,
	});
}

/** 装一个假的扩展桥（真桥是 page-picker 注入到页面主世界的 window.__piBridge）。 */
function installBridge(impl?: (req: unknown) => Promise<unknown>): unknown[] {
	const calls: unknown[] = [];
	(globalThis as unknown as Record<string, unknown>).__piBridge = {
		call: vi.fn(async (req: unknown) => {
			calls.push(req);
			if (impl) return await impl(req);
			return { title: "页面标题" };
		}),
	};
	return calls;
}

afterEach(() => {
	delete (globalThis as unknown as Record<string, unknown>).__piBridge;
});

describe("pageCall（模型 → 浏览器扩展）", () => {
	it("宿主 API 版本号跟着能力走（插件靠它判断有没有这个能力）", () => {
		expect(api().version).toBe(PLUGIN_HOST_API_VERSION);
		expect(PLUGIN_HOST_API_VERSION).toBeGreaterThanOrEqual(3);
	});

	it("没有桥 → 立刻给一句能照做的错（不等到天荒地老）", async () => {
		const res = await api({ bridgeWaitMs: 5 }).pageCall({ op: "read" });
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error).toContain("page-picker"); // 点名扩展
			expect(res.error).toContain("刷新"); // 给下一步
		}
	});

	it("桥在 → op / args / 目标 / 超时原样交过去，结果回传", async () => {
		const calls = installBridge();
		const res = await api().pageCall({
			op: "read",
			args: { what: "title" },
			target: "http://localhost:5173",
			timeoutMs: 8000,
		});
		expect(res).toEqual({ ok: true, result: { title: "页面标题" } });
		// 桥的参数名是 to（target 是工具/协议侧的叫法）
		expect(calls[0]).toEqual({ op: "read", args: { what: "title" }, to: "http://localhost:5173", timeoutMs: 8000 });
	});

	it("省略可选参数时不带空字段（桥那边按 undefined 判断「用哪个页面」）", async () => {
		const calls = installBridge();
		await api().pageCall({ op: "pages" });
		expect(calls[0]).toEqual({ op: "pages" });
	});

	it("动作没返回值 → {ok:true}（不是 {ok:true, result:undefined} 让上层自己想）", async () => {
		installBridge(async () => undefined);
		expect(await api().pageCall({ op: "click", args: { selector: "#a" } })).toEqual({ ok: true });
	});

	it("桥抛错（页面没授权 / 动作失败）→ 原因原样回传，不抛给调用方", async () => {
		installBridge(async () => {
			throw new Error("页面（http://localhost:5173）没打开 —— 先把它开在一个标签页里");
		});
		const res = await api().pageCall({ op: "read" });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("没打开");
	});

	it("空 op → 直接拒（连桥都不去找）", async () => {
		const calls = installBridge();
		const res = await api().pageCall({ op: "   " });
		expect(res.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});
});
