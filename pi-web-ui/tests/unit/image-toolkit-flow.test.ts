// @vitest-environment jsdom
/**
 * image-toolkit 图片流转与一体化布局单测 —— 真实 DOM 环境。
 *
 * 覆盖：
 *   1. workspace.readImage 返回 ArrayBuffer 且可被 Uint8Array 消费；
 *   2. util.basename 正确解析路径文件名；
 *   3. AI 生图 → 工具箱处理流转：onOpenInToolkit 正常拉取、建队列项、切回编辑模式；
 *   4. 工具箱 → AI 生图流转：useAsGenReference 导出加工后的画幅并存回临时参考图、投递参考图并切至生图模式；
 *   5. 一体化 Studio 导航：四模态平滑双向切换（edit / gen / svc / cfg），不丢顶栏、不陷死；
 *   6. 右侧参数面板动作区四层分级结构完整（hero / flow / batch / history）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ws from "../../plugins/image-toolkit/client/workspace.mjs";
import { basename, el } from "../../plugins/image-toolkit/client/util.mjs";
import view from "../../plugins/image-toolkit/client/entry.mjs";

function dummyPngBytes() {
	return new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
		0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
	]);
}

describe("image-toolkit 图片流转核心基础", () => {
	it("ws.readImage 正常导出并返回 ArrayBuffer", async () => {
		const fakePng = dummyPngBytes();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				blob: async () => new Blob([fakePng], { type: "image/png" }),
			}),
		);

		expect(typeof ws.readImage).toBe("function");
		const buf = await ws.readImage("pics/sample.png");
		expect(buf instanceof ArrayBuffer).toBe(true);
		const u8 = new Uint8Array(buf);
		expect(u8[0]).toBe(0x89);
		expect(u8[1]).toBe(0x50);
		expect(u8[2]).toBe(0x4e);
		expect(u8[3]).toBe(0x47);
	});

	it("basename 处理各种斜杠和边界路径", () => {
		expect(basename("generated/foo.png")).toBe("foo.png");
		expect(basename("generated\\bar.jpg")).toBe("bar.jpg");
		expect(basename("baz.webp")).toBe("baz.webp");
		expect(basename("")).toBe("image");
		expect(basename(null as any)).toBe("image");
	});

	it("el() 能够正确支持 style 对象与字符串声明", () => {
		const nodeObj = el("div", { style: { display: "none", width: "100px" } });
		expect(nodeObj.style.display).toBe("none");
		expect(nodeObj.style.width).toBe("100px");

		const nodeStr = el("div", { style: "display: flex; height: 50px;" });
		expect(nodeStr.style.display).toBe("flex");
		expect(nodeStr.style.height).toBe("50px");
	});
});

describe("image-toolkit 视图外壳与一体化布局", () => {
	let container: HTMLElement;
	const cleanups: Array<() => void> = [];

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async (url: string) => {
				const s = String(url);
				if (s.includes("/ws/settings")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({ settings: { defaultFormat: "keep", quality: 0.82 } }),
					};
				}
				if (s.includes("/gen/config") || s.includes("/config")) {
					return {
						ok: true,
						status: 200,
						text: async () =>
							JSON.stringify({
								cwd: "E:/ws",
								config: { services: [], outputDir: "generated" },
								shapes: [],
								presets: [],
								jobs: [],
							}),
					};
				}
				if (s.includes("/gen/jobs") || s.includes("/jobs")) {
					return {
						ok: true,
						status: 200,
						text: async () => JSON.stringify({ jobs: [] }),
					};
				}
				if (s.includes("/ws/image")) {
					return {
						ok: true,
						status: 200,
						blob: async () => new Blob([dummyPngBytes()], { type: "image/png" }),
					};
				}
				return { ok: true, status: 200, text: async () => "{}" };
			}),
		);
	});

	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
		container.remove();
		vi.unstubAllGlobals();
	});

	it("初始化渲染一体化 Studio 顶栏与四模态导航", async () => {
		const cleanup = view.mount(container, { onData: () => () => {} } as any);
		if (cleanup) cleanups.push(cleanup);

		// 顶栏常驻
		const top = container.querySelector(".igt-top");
		expect(top).toBeTruthy();

		// 统一导航
		const navTabs = [...container.querySelectorAll(".igt-nav-tab")];
		expect(navTabs.length).toBe(4);
		const modes = navTabs.map((t) => t.getAttribute("data-mode"));
		expect(modes).toEqual(["edit", "gen", "svc", "cfg"]);

		// 默认处于图片处理 (edit) 模式
		expect(navTabs[0].classList.contains("on")).toBe(true);
		const main = container.querySelector(".igt-main") as HTMLElement;
		const genWrap = container.querySelector(".igt-gen-wrap") as HTMLElement;
		expect(main.style.display).toBe("flex");
		expect(genWrap.style.display).toBe("none");

		// 右侧参数面板动作区分层结构
		const actions = container.querySelector(".igt-actions");
		expect(actions).toBeTruthy();
		expect(actions!.querySelector(".igt-act-hero-row")).toBeTruthy();
		expect(actions!.querySelector(".igt-act-flow-row")).toBeTruthy();
		expect(actions!.querySelector(".igt-act-batch-row")).toBeTruthy();
		expect(actions!.querySelector(".igt-act-history-row")).toBeTruthy();

		// 验证流转按钮「用作生图参考图」存在
		const useAsRefBtn = actions!.querySelector(".igt-btn-flow");
		expect(useAsRefBtn).toBeTruthy();
	});

	it("点击 Studio 顶栏可在编辑模式与生图模式之间自由双向切换，绝不陷死", async () => {
		const cleanup = view.mount(container, { onData: () => () => {} } as any);
		if (cleanup) cleanups.push(cleanup);

		const navTabs = [...container.querySelectorAll(".igt-nav-tab")] as HTMLButtonElement[];
		const [editTab, genTab, svcTab, cfgTab] = navTabs;
		const main = container.querySelector(".igt-main") as HTMLElement;
		const genWrap = container.querySelector(".igt-gen-wrap") as HTMLElement;

		// 初始状态
		expect(main.style.display).toBe("flex");
		expect(genWrap.style.display).toBe("none");

		// 切到 AI 生图
		genTab.click();
		expect(main.style.display).toBe("none");
		expect(genWrap.style.display).toBe("flex");
		expect(genTab.classList.contains("on")).toBe(true);
		expect(editTab.classList.contains("on")).toBe(false);

		// 切到服务商管理
		svcTab.click();
		expect(main.style.display).toBe("none");
		expect(genWrap.style.display).toBe("flex");
		expect(svcTab.classList.contains("on")).toBe(true);

		// 切到设置
		cfgTab.click();
		expect(main.style.display).toBe("none");
		expect(genWrap.style.display).toBe("flex");
		expect(cfgTab.classList.contains("on")).toBe(true);

		// 随时一键切回图片处理 (edit)
		editTab.click();
		expect(main.style.display).toBe("flex");
		expect(genWrap.style.display).toBe("none");
		expect(editTab.classList.contains("on")).toBe(true);
		expect(cfgTab.classList.contains("on")).toBe(false);
	});

	it("图片流转：在 AI 生图页面点击「在图片工具箱处理」能顺利读取图片并切换到编辑状态", async () => {
		// Mock 图片解码环境与 Canvas 渲染环境
		vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 200, height: 150, close: vi.fn() }));
		HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
			drawImage: vi.fn(),
			getImageData: vi.fn().mockReturnValue({ data: new Uint8Array(400) }),
			putImageData: vi.fn(),
			clearRect: vi.fn(),
			fillRect: vi.fn(),
			save: vi.fn(),
			restore: vi.fn(),
			translate: vi.fn(),
			rotate: vi.fn(),
			scale: vi.fn(),
			beginPath: vi.fn(),
			closePath: vi.fn(),
			clip: vi.fn(),
			rect: vi.fn(),
			arc: vi.fn(),
			stroke: vi.fn(),
			fill: vi.fn(),
		}) as any;
		HTMLCanvasElement.prototype.toBlob = function (callback) {
			callback(new Blob([dummyPngBytes()], { type: "image/png" }));
		};

		// 模拟返回已生成的任务
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async (url: string) => {
				const s = String(url);
				if (s.includes("/ws/settings")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({ settings: { defaultFormat: "keep", quality: 0.82 } }),
					};
				}
				if (s.includes("/gen/config") || s.includes("/config")) {
					return {
						ok: true,
						status: 200,
						text: async () =>
							JSON.stringify({
								cwd: "E:/ws",
								config: {
									services: [{ id: "mock-svc", name: "Mock Service", enabled: true, models: ["m1"], sizes: ["1:1"] }],
									outputDir: "generated",
								},
								shapes: [],
								presets: [],
								jobs: [
									{
										id: "job-1",
										status: "done",
										prompt: "a cute robot",
										serviceId: "mock-svc",
										model: "m1",
										files: [{ path: "generated/robot.png", bytes: 1024, mime: "image/png" }],
									},
								],
							}),
					};
				}
				if (s.includes("/gen/jobs") || s.includes("/jobs")) {
					return {
						ok: true,
						status: 200,
						text: async () =>
							JSON.stringify({
								jobs: [
									{
										id: "job-1",
										status: "done",
										prompt: "a cute robot",
										serviceId: "mock-svc",
										model: "m1",
										files: [{ path: "generated/robot.png", bytes: 1024, mime: "image/png" }],
									},
								],
							}),
					};
				}
				if (s.includes("/ws/image")) {
					return {
						ok: true,
						status: 200,
						blob: async () => new Blob([dummyPngBytes()], { type: "image/png" }),
					};
				}
				if (s.includes("/ws/save")) {
					return {
						ok: true,
						status: 200,
						text: async () => JSON.stringify({ ok: true, path: "temp/ref-robot.png" }),
					};
				}
				return { ok: true, status: 200, text: async () => "{}" };
			}),
		);

		const cleanup = view.mount(container, { onData: () => () => {} } as any);
		if (cleanup) cleanups.push(cleanup);

		const navTabs = [...container.querySelectorAll(".igt-nav-tab")] as HTMLButtonElement[];
		const [editTab, genTab] = navTabs;
		const main = container.querySelector(".igt-main") as HTMLElement;
		const genWrap = container.querySelector(".igt-gen-wrap") as HTMLElement;

		// 1. 切换到生图页面
		genTab.click();
		expect(genWrap.style.display).toBe("flex");
		expect(main.style.display).toBe("none");

		// 等待异步加载渲染任务卡
		for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 20));

		// 检查生图卡片存在
		const editInToolkitBtn = [...genWrap.querySelectorAll("button")].find(
			(b) => b.textContent?.includes("进入处理") || b.textContent?.includes("Edit in Toolkit"),
		);
		expect(editInToolkitBtn).toBeTruthy();

		// 2. 点击「进入处理」：触发图片流转进入图片工具箱
		const readSpy = vi.spyOn(ws, "readImage");
		editInToolkitBtn!.click();

		// 等待读取与添加队列完成
		await new Promise((r) => setTimeout(r, 60));

		// 验证调用了 ws.readImage 并成功切回了编辑模式
		expect(readSpy).toHaveBeenCalledWith("generated/robot.png");
		expect(main.style.display).toBe("flex");
		expect(genWrap.style.display).toBe("none");
		expect(editTab.classList.contains("on")).toBe(true);

		// 验证队列里已出现该图片
		const queueItems = container.querySelectorAll(".igt-qitem");
		expect(queueItems.length).toBe(1);
		expect(container.textContent).toContain("robot.png");

		// 3. 反向流转：在编辑模式中点击「用作生图参考图」，流转回 AI 生图
		const saveSpy = vi.spyOn(ws, "saveImage");
		const useAsRefBtn = container.querySelector(".igt-btn-flow") as HTMLButtonElement;
		expect(useAsRefBtn).toBeTruthy();

		useAsRefBtn.click();
		await new Promise((r) => setTimeout(r, 60));

		// 验证切回了 AI 生图模式
		expect(main.style.display).toBe("none");
		expect(genWrap.style.display).toBe("flex");
		expect(genTab.classList.contains("on")).toBe(true);

		// 验证参考图芯片在生图 dock 中已展示
		expect(genWrap.textContent).toContain("robot.png");
	});
});
