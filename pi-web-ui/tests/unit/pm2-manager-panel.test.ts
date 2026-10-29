// @vitest-environment jsdom
/**
 * pm2-manager 面板（client/entry.mjs）首帧守卫 —— 走真实 bundle + jsdom + 假 fetch，零端口零子进程。
 *
 * 现场问题：点开宿主「后台任务」面板时，进程管家那块**总会先闪一下「未检测到 pm2」黄条**
 * （还有「pm2 当前没有托管任何应用」），因为 bundle 的初始 state 是写死的 `installed:false`，
 * 而 `/status` 要走一趟 HTTP（服务端还会顺手 spawn 一次 `pm2 jlist`）。这个闪烁既误导又扎眼。
 *
 * 口径：**首次 /status 回来之前不下任何结论** —— 只显示中性的「正在检测 pm2 环境…」占位；
 * 拿到真实状态后该显示黄条就显示黄条（真没装时不能永远藏着）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import pm2Panel from "../../plugins/pm2-manager/client/entry.mjs";

type Payload = Record<string, unknown>;

/** 手动控制 resolve 时机的假 fetch：模拟 /status 的往返延迟。 */
function deferredFetch() {
	let resolve!: (payload: Payload) => void;
	const calls: string[] = [];
	const fetchStub = vi.fn((url: string) => {
		calls.push(String(url));
		return new Promise((res) => {
			resolve = (payload: Payload) => res(/** @type {any} */ { ok: true, json: async () => payload });
		});
	});
	vi.stubGlobal("fetch", fetchStub);
	return { calls, reply: (payload: Payload) => resolve(payload) };
}

/** 让已 resolve 的 promise 链跑完（refresh → render）。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

let cleanup: (() => void) | undefined;

function mountPanel() {
	const container = document.createElement("div");
	document.body.appendChild(container);
	cleanup = pm2Panel.mount(container) as () => void;
	return container;
}

afterEach(() => {
	cleanup?.();
	cleanup = undefined;
	(pm2Panel as { _resetCache?: () => void })._resetCache?.();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("pm2-manager 面板首帧", () => {
	it("首帧不下结论：/status 未回来前不闪「未检测到 pm2」/「没有应用」", async () => {
		document.documentElement.lang = "zh";
		const { reply } = deferredFetch();
		const container = mountPanel();

		// 首帧（同步渲染）：只有中性的检测中占位。
		const first = container.textContent ?? "";
		expect(first).not.toContain("未检测到");
		expect(first).not.toContain("当前没有托管任何应用");
		expect(first).toContain("正在检测");

		// /status 回来（真没装）→ 该出现的黄条照样出现，不能永远藏着。
		reply({ ok: true, installed: false, version: "", apps: [], error: "", platform: "win32" });
		await flush();
		const after = container.textContent ?? "";
		expect(after).toContain("未检测到");
		expect(after).not.toContain("正在检测");
	});

	it("已装 pm2：首帧同样不闪黄条，回来后直接显示版本与应用表", async () => {
		document.documentElement.lang = "zh";
		const { reply } = deferredFetch();
		const container = mountPanel();
		expect(container.textContent ?? "").not.toContain("未检测到");

		reply({
			ok: true,
			installed: true,
			version: "5.4.2",
			apps: [{ name: "api", status: "online", cpu: 1, memory: 1024, restarts: 0, startedAt: Date.now() }],
			error: "",
			platform: "win32",
		});
		await flush();
		const after = container.textContent ?? "";
		expect(after).toContain("pm2 5.4.2");
		expect(after).toContain("api");
		expect(after).not.toContain("未检测到");
		expect(after).not.toContain("正在检测");
	});

	it("请求失败或网络异常时不误报「未检测到 pm2」", async () => {
		document.documentElement.lang = "zh";
		const fetchStub = vi.fn(() => Promise.reject(new Error("Network Error")));
		vi.stubGlobal("fetch", fetchStub);

		const container = mountPanel();
		await flush();
		const text = container.textContent ?? "";
		expect(text).not.toContain("未检测到");
		expect(text).toContain("Network Error");
	});

	it("二次打开复用已知状态缓存：首帧直接呈现真实结构，零占位零闪烁", async () => {
		document.documentElement.lang = "zh";
		const { reply } = deferredFetch();
		const container1 = mountPanel();

		// 首次打开并完成探测
		reply({
			ok: true,
			installed: true,
			version: "5.4.2",
			apps: [{ name: "web", status: "online", cpu: 2, memory: 2048, restarts: 0, startedAt: Date.now() }],
			error: "",
			platform: "win32",
		});
		await flush();
		expect(container1.textContent ?? "").toContain("pm2 5.4.2");

		// 关闭面板
		cleanup?.();
		cleanup = undefined;
		document.body.innerHTML = "";

		// 二次打开（重新 deferredFetch 模拟延迟）
		deferredFetch();
		const container2 = mountPanel();
		const firstFrame = container2.textContent ?? "";

		// 首帧无需等 /status 返回，直接呈现已知版本与应用，绝无「正在检测…」，更无「未检测到」
		expect(firstFrame).toContain("pm2 5.4.2");
		expect(firstFrame).toContain("web");
		expect(firstFrame).not.toContain("正在检测");
		expect(firstFrame).not.toContain("未检测到");
	});
});
