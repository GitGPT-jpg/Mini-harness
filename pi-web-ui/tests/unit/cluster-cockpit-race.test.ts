// @vitest-environment jsdom
/**
 * 前端集群状态的过期结果防护（web/src/loop-cockpit.ts）：导入/清除之前发出的探测晚返回时，
 * 不得覆盖变更后的状态；同一服务实例里旧代次的结果也不得覆盖新代次。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

type Pending = { url: string; resolve: (body: unknown, ok?: boolean) => void };

function mockFetch(): Pending[] {
	const pending: Pending[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(
			(url: string) =>
				new Promise((done) => {
					pending.push({
						url: String(url),
						resolve: (body, ok = true) => done({ ok, json: async () => body } as Response),
					});
				}),
		),
	);
	return pending;
}

const status = (over: Record<string, unknown>) => ({
	configured: true,
	connected: true,
	code: "ok",
	message: "",
	source: "env",
	instance: "i1",
	generation: 1,
	...over,
});

async function load() {
	vi.resetModules();
	return import("../../web/src/loop-cockpit");
}

/** 最小 renderHook：把 hook 挂进一个真实 React 根，读它最新一次渲染的返回值。 */
function renderHook<T>(hook: () => T): { current: () => T; unmount: () => void } {
	let value: T;
	const el = document.createElement("div");
	const root: Root = createRoot(el);
	function Probe() {
		value = hook();
		return null;
	}
	act(() => root.render(createElement(Probe)));
	return { current: () => value, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("loop-cockpit 集群状态防过期", () => {
	it("A 探测晚返回、B 已导入：最终是 B 的结果；清除后旧探测才成功也不覆盖", async () => {
		const pending = mockFetch();
		const mod = await load();
		const hook = renderHook(() => mod.useCockpit("cluster"));
		const a = mod.refreshCluster();
		const b = mod.mutateCluster("cluster", { kubeconfig: "x" });
		pending[1].resolve(status({ source: "app", generation: 2 }));
		await act(async () => {
			await b;
		});
		pending[0].resolve(status({ source: "env", generation: 1, connected: true }));
		await a;
		expect(hook.current()).toMatchObject({ source: "app", generation: 2 });

		const c = mod.refreshCluster(true);
		const d = mod.mutateCluster("cluster/clear", {});
		pending[3].resolve({
			ok: true,
			...status({ source: "none", code: "not-configured", configured: false, connected: false, generation: 3 }),
		});
		await d;
		pending[2].resolve(status({ source: "app", generation: 2 }));
		await c;
		expect(hook.current()).toMatchObject({ source: "none", generation: 3 });
		expect(pending[2].url).toContain("cluster?refresh=1");
		hook.unmount();
	});

	it("同一实例旧代次不覆盖新代次；服务重启（instance 变了）后的新结果照常接受", async () => {
		const pending = mockFetch();
		const mod = await load();
		const hook = renderHook(() => mod.useCockpit("cluster"));
		const first = mod.refreshCluster();
		pending[0].resolve(status({ generation: 5 }));
		await first;
		const stale = mod.refreshCluster();
		pending[1].resolve(status({ generation: 4, source: "default" }));
		await stale;
		expect(hook.current()).toMatchObject({ generation: 5, source: "env" });
		const restarted = mod.refreshCluster();
		pending[2].resolve(status({ instance: "i2", generation: 1, source: "default" }));
		await restarted;
		expect(hook.current()).toMatchObject({ instance: "i2", source: "default" });
		hook.unmount();
	});
});
