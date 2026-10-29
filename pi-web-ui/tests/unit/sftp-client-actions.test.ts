// @vitest-environment jsdom
/**
 * sftp 插件「文件树右键菜单 → 上传」的客户端回归 —— 走真实 bundle + jsdom + 假 fetch，零端口零子进程。
 *
 * 现场问题（#601）：manifest 的 `ui["contextmenu.file"]` 声明了 `sftp:upload-file` /
 * `sftp:upload-dir`，但客户端 bundle **从来没注册过任何 host.onUiAction** —— 点下去宿主
 * 找不到接管者，只会弹一句「插件没有接管这个动作（可能版本不匹配）」。同一个坑还有底栏
 * 那个带 `sftp:open` 动作的徽标（点了同样没人接）。现在界面上只留顶栏一个入口，
 * 右键菜单这两条动作必须真的有人接，且接得**对**：
 *
 *   - 动作 = 打开面板 + 把这次上传交给面板跑（与面板按钮同一条路径，进度就地可见）；
 *   - 面板还没挂载（宿主按需加载 bundle 后立刻回调）时请求先排队，mount 完再消费；
 *   - 机器浏览给的绝对路径只有确实在工作区内才折算成相对路径，工作区外**必须拒绝**
 *     （服务端 /transfer 只认工作区内的相对路径：硬塞进去只会得到莫名的「本地不存在」，
 *     POSIX 上还会被当成远端路径）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type Handler = (itemId: string, value?: string, target?: { id: string; kind?: string; label?: string }) => void;
type Post = { path: string; body: Record<string, unknown> };

const handlers = new Map<string, Handler>();
const views: string[] = [];
const posts: Post[] = [];
const CWD = "E:/proj";

/** 宿主动作桥必须在 bundle 求值前就位（它在模块顶层注册 handler）。 */
function installBridge() {
	(globalThis.window as unknown as { __piWebUiHost?: unknown }).__piWebUiHost = {
		version: 11,
		setView: (v: string) => views.push(v),
		onUiAction: (name: string, fn: Handler) => {
			handlers.set(name, fn);
			return () => handlers.delete(name);
		},
	};
}

installBridge();
const bundle = (await import("../../plugins/sftp/client/entry.mjs")).default as {
	mount: (c: HTMLElement) => () => void;
};

/** 假 fetch：按路径分发，顺带记下所有 POST body。 */
function stubFetch() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
			const u = String(url);
			const send = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) });
			if (u.includes("/transfer")) {
				posts.push({ path: u, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
				return send({
					result: { done: { upload: 1, download: 0, trashRemote: 0, trashLocal: 0 }, failed: [] },
					plan: null,
				});
			}
			if (u.includes("/ignore-toggle")) {
				posts.push({ path: u, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
				return send({ ok: true, action: "added" });
			}
			if (u.includes("/remote")) return send({ dir: "/home/test", entries: [] });
			return send({
				cwd: CWD,
				configPath: ".pi/sftp.json",
				localPath: ".pi/sftp.local.json",
				trashPath: ".pi/sftp-trash",
				active: "mock",
				connection: { name: "mock", host: "127.0.0.1", port: 22, remotePath: "/home/test", ready: true },
				profiles: [{ name: "mock", ready: true }],
				settings: {},
				warnings: [],
				plaintext: [],
				dep: { status: "ready" },
				pool: [],
				job: { running: false },
				lastPlan: null,
				vscodeImportAvailable: false,
				secrets: ["my-existing-secret"],
			});
		}),
	);
}

/** 让已 resolve 的 promise 链跑完（refresh → drain → transfer）。 */
const flush = async () => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

let cleanup: (() => void) | undefined;
let container: HTMLElement;

function mount() {
	container = document.createElement("div");
	document.body.appendChild(container);
	cleanup = bundle.mount(container);
	return container;
}

afterEach(() => {
	cleanup?.();
	cleanup = undefined;
	views.length = 0;
	posts.length = 0;
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

const fire = (action: string, target: { id: string; kind?: string; label?: string }) =>
	handlers.get(action)?.(action, undefined, target);

describe("sftp 右键菜单上传与下载动作", () => {
	it("全部六条上传、下载及忽略动作都真的被客户端接管", () => {
		expect([...handlers.keys()].sort()).toEqual([
			"sftp:download-dir",
			"sftp:download-file",
			"sftp:ignore-item",
			"sftp:unignore-item",
			"sftp:upload-dir",
			"sftp:upload-file",
		]);
	});

	it("面板还没挂载：先打开面板并排队，mount 完立刻跑", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		fire("sftp:upload-file", { id: "src/new.txt", kind: "file", label: "new.txt" });
		// 回调先到：面板已切、请求还在排队，一个字节都还没传
		expect(views).toEqual(["plugin:sftp"]);
		expect(posts).toHaveLength(0);

		const el = mount();
		await flush();
		expect(posts).toHaveLength(1);
		expect(posts[0]?.body).toMatchObject({ direction: "up", path: "src/new.txt" });
		// 进度就写在面板里（与面板自己的按钮同一条路径）
		expect(el.textContent ?? "").toContain("new.txt");
		expect(el.textContent ?? "").toContain("已上传 1 个文件");
	});

	it("面板已挂载：直接跑，且上传目录同样是 scope=tree 的口径（服务端按 stat 判）", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		mount();
		await flush();
		fire("sftp:upload-dir", { id: "web/dist", kind: "dir", label: "dist" });
		await flush();
		expect(posts).toHaveLength(1);
		expect(posts[0]?.body).toMatchObject({ direction: "up", path: "web/dist" });
	});

	it("机器浏览的绝对路径：在工作区内折算成相对路径", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		mount();
		await flush();
		fire("sftp:upload-file", { id: "E:/proj/src/a.ts", kind: "file", label: "a.ts" });
		await flush();
		expect(posts).toHaveLength(1);
		expect(posts[0]?.body).toMatchObject({ path: "src/a.ts" });
	});

	it("工作区外的绝对路径：拒绝并给明确原因，绝不硬塞给服务端", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		const el = mount();
		await flush();
		fire("sftp:upload-file", { id: "E:/other/secret.txt", kind: "file", label: "secret.txt" });
		await flush();
		expect(posts).toHaveLength(0);
		expect(el.textContent ?? "").toContain("只能同步工作区内的文件");
	});

	it("POSIX 绝对路径（Linux 上会被服务端当成远端路径）同样被拦下", async () => {
		document.documentElement.lang = "en";
		stubFetch();
		const el = mount();
		await flush();
		fire("sftp:upload-dir", { id: "/etc", kind: "dir", label: "etc" });
		await flush();
		expect(posts).toHaveLength(0);
		expect(el.textContent ?? "").toContain("Only files inside the workspace");
	});

	it("右键文件列表空白处（代表当前目录，id: ''）：上传与下载整目录", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		mount();
		await flush();

		// 空白处上传当前目录
		fire("sftp:upload-dir", { id: "", kind: "list", label: "根目录" });
		await flush();
		expect(posts).toHaveLength(1);
		expect(posts[0]?.body).toMatchObject({ direction: "up", path: "" });

		// 空白处从远端下载同步当前目录
		fire("sftp:download-dir", { id: "", kind: "list", label: "根目录" });
		await flush();
		expect(posts).toHaveLength(2);
		expect(posts[1]?.body).toMatchObject({ direction: "down", path: "" });
	});

	it("右键文件/目录添加到忽略与从忽略移除", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		mount();
		await flush();

		fire("sftp:ignore-item", { id: "dist", kind: "dir", label: "dist" });
		await flush();
		expect(posts).toHaveLength(1);
		expect(posts[0]?.path).toContain("/ignore-toggle");
		expect(posts[0]?.body).toMatchObject({ path: "dist", mode: "add" });

		fire("sftp:unignore-item", { id: "dist", kind: "dir", label: "dist" });
		await flush();
		expect(posts).toHaveLength(2);
		expect(posts[1]?.path).toContain("/ignore-toggle");
		expect(posts[1]?.body).toMatchObject({ path: "dist", mode: "remove" });
	});
});

describe("sftp 密码帮助问号与使用说明", () => {
	it("密码标签旁渲染问号按钮，带有提示与无障碍说明", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		const c = mount();
		await flush();

		const btnHelp = c.querySelector<HTMLButtonElement>(".btn-help-pass");
		expect(btnHelp).not.toBeNull();
		expect(btnHelp?.textContent?.trim()).toBe("?");
		expect(btnHelp?.title).toContain("密码与 ${secret:名} 变量使用说明");
		expect(btnHelp?.getAttribute("aria-label")).toContain("密码与变量引用说明");

		const card = c.querySelector<HTMLElement>(".pass-help-card");
		expect(card).not.toBeNull();
		expect(card?.classList.contains("hidden")).toBe(true);
	});

	it("点击问号按钮可展开和折叠说明面板，且有关闭按钮", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		const c = mount();
		await flush();

		const btnHelp = c.querySelector<HTMLButtonElement>(".btn-help-pass");
		const card = c.querySelector<HTMLElement>(".pass-help-card");
		const btnClose = c.querySelector<HTMLButtonElement>(".btn-close-help");

		// 点击问号展开
		btnHelp?.click();
		expect(card?.classList.contains("hidden")).toBe(false);
		expect(btnHelp?.classList.contains("active")).toBe(true);
		expect(card?.textContent).toContain("直接输入明文");
		expect(card?.textContent).toContain("${secret:名}");

		// 点击关闭按钮收起
		btnClose?.click();
		expect(card?.classList.contains("hidden")).toBe(true);
		expect(btnHelp?.classList.contains("active")).toBe(false);

		// 再次点击问号展开，再点一次问号收起
		btnHelp?.click();
		expect(card?.classList.contains("hidden")).toBe(false);
		btnHelp?.click();
		expect(card?.classList.contains("hidden")).toBe(true);
	});

	it("写入加密机密后，引用自动填入密码输入框并高亮提示", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		const c = mount();
		await flush();

		const promptMock = vi
			.spyOn(globalThis, "prompt")
			.mockImplementationOnce(() => "prod-pw")
			.mockImplementationOnce(() => "supersecret123");

		const origFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
				const u = String(url);
				if (u.includes("/secret")) {
					return {
						ok: true,
						json: async () => ({ ok: true, data: { name: "prod-pw", ref: "${secret:prod-pw}" } }),
					};
				}
				return origFetch(url, init);
			}),
		);

		const btnSecret = c.querySelector<HTMLButtonElement>(".btn-secret");
		btnSecret?.click();
		await flush();

		const passInput = c.querySelector<HTMLInputElement>(".f-pass");
		expect(passInput?.value).toBe("${secret:prod-pw}");

		const okMsg = c.querySelector<HTMLElement>(".msg.ok");
		expect(okMsg?.textContent).toContain("${secret:prod-pw}");
		promptMock.mockRestore();
	});

	it("认证方式选择加密机密时，显示机密名和值输入框并隐藏明文密码行", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		const c = mount();
		await flush();

		const authSelect = c.querySelector<HTMLSelectElement>(".f-auth");
		expect(authSelect).toBeTruthy();

		// 默认或选加密机密
		authSelect!.value = "secret";
		authSelect!.dispatchEvent(new Event("change"));

		const secretNameWrap = c.querySelector<HTMLElement>(".lbl-secret-name");
		const secretValWrap = c.querySelector<HTMLElement>(".lbl-secret-val");
		const passRow = c.querySelector<HTMLElement>(".lbl-pass");
		const keyRow = c.querySelector<HTMLElement>(".l-keypath");

		expect(secretNameWrap?.classList.contains("hidden")).toBe(false);
		expect(secretValWrap?.classList.contains("hidden")).toBe(false);
		expect(passRow?.classList.contains("hidden")).toBe(true);
		expect(keyRow?.classList.contains("hidden")).toBe(true);

		// 显式下拉菜单与快捷标签
		const secretSelect = c.querySelector<HTMLSelectElement>(".f-secret-select");
		expect(secretSelect).toBeTruthy();
		expect(secretSelect?.innerHTML).toContain("my-existing-secret");

		// 从下拉菜单选择已有机密
		secretSelect!.value = "my-existing-secret";
		secretSelect!.dispatchEvent(new Event("change"));

		const nameInput = c.querySelector<HTMLInputElement>(".f-secret-name");
		expect(nameInput?.value).toBe("my-existing-secret");

		const statusEl = c.querySelector<HTMLElement>(".secret-name-status");
		expect(statusEl?.textContent).toContain("已有同名机密");

		// 快捷药丸徽章点击
		const chipBtn = c.querySelector<HTMLButtonElement>(".sfx-chip-btn");
		expect(chipBtn?.getAttribute("data-sec")).toBe("my-existing-secret");
		expect(chipBtn?.classList.contains("active")).toBe(true);
	});

	it("检测是否已创建过同名机密：已有同名机密提示直接复用，新机密提示保存时创建", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		const c = mount();
		await flush();

		const authSelect = c.querySelector<HTMLSelectElement>(".f-auth")!;
		authSelect.value = "secret";
		authSelect.dispatchEvent(new Event("change"));

		const nameInput = c.querySelector<HTMLInputElement>(".f-secret-name")!;
		const valInput = c.querySelector<HTMLInputElement>(".f-secret-val")!;
		const statusEl = c.querySelector<HTMLElement>(".secret-name-status")!;

		// 输入已存在的同名机密
		nameInput.value = "my-existing-secret";
		nameInput.dispatchEvent(new Event("input"));

		expect(statusEl.textContent).toContain("已有同名机密");
		expect(valInput.placeholder).toContain("留空直接复用");

		// 输入不存在的新机密名
		nameInput.value = "brand-new-secret";
		nameInput.dispatchEvent(new Event("input"));

		expect(statusEl.textContent).toContain("新机密");
		expect(valInput.placeholder).toContain("输入密码/机密值");
	});

	it("保存已有同名机密时直接复用，无需输入机密值也无需重复调用 /secret", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		const c = mount();
		await flush();

		let secretApiCalled = false;
		let savedPatch: any = null;

		const origFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
				const u = String(url);
				if (u.includes("/secret")) {
					secretApiCalled = true;
					return { ok: true, json: async () => ({ ok: true, data: { name: "my-existing-secret" } }) };
				}
				if (u.includes("/profile")) {
					savedPatch = JSON.parse(String(init?.body ?? "{}"));
					return { ok: true, json: async () => ({ ok: true, data: { name: "mock" } }) };
				}
				return origFetch(url, init);
			}),
		);

		const authSelect = c.querySelector<HTMLSelectElement>(".f-auth")!;
		authSelect.value = "secret";
		authSelect.dispatchEvent(new Event("change"));

		const nameInput = c.querySelector<HTMLInputElement>(".f-secret-name")!;
		const valInput = c.querySelector<HTMLInputElement>(".f-secret-val")!;
		nameInput.value = "my-existing-secret";
		nameInput.dispatchEvent(new Event("input"));
		valInput.value = ""; // 留空直接复用

		const btnSave = c.querySelector<HTMLButtonElement>(".btn-save")!;
		btnSave.click();
		await flush();

		expect(secretApiCalled).toBe(false); // 无需调 /secret
		expect(savedPatch?.patch?.password).toBe("${secret:my-existing-secret}");
	});

	it("保存新机密时，若填写了机密值则自动调用 /secret 创建并关联", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		const c = mount();
		await flush();

		let secretCallBody: any = null;
		let savedPatch: any = null;

		const origFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
				const u = String(url);
				if (u.includes("/secret")) {
					secretCallBody = JSON.parse(String(init?.body ?? "{}"));
					return {
						ok: true,
						json: async () => ({
							ok: true,
							data: {
								name: secretCallBody.name,
								ref: `\${secret:${secretCallBody.name}}`,
								secrets: ["my-existing-secret", secretCallBody.name],
							},
						}),
					};
				}
				if (u.includes("/profile")) {
					savedPatch = JSON.parse(String(init?.body ?? "{}"));
					return { ok: true, json: async () => ({ ok: true, data: { name: "mock" } }) };
				}
				return origFetch(url, init);
			}),
		);

		const authSelect = c.querySelector<HTMLSelectElement>(".f-auth")!;
		authSelect.value = "secret";
		authSelect.dispatchEvent(new Event("change"));

		const nameInput = c.querySelector<HTMLInputElement>(".f-secret-name")!;
		const valInput = c.querySelector<HTMLInputElement>(".f-secret-val")!;
		nameInput.value = "auto-created-secret";
		nameInput.dispatchEvent(new Event("input"));
		valInput.value = "super-safe-password-999";

		const btnSave = c.querySelector<HTMLButtonElement>(".btn-save")!;
		btnSave.click();
		await flush();

		expect(secretCallBody).toEqual({ name: "auto-created-secret", value: "super-safe-password-999" });
		expect(savedPatch?.patch?.password).toBe("${secret:auto-created-secret}");
		expect(valInput.value).toBe(""); // 保存后机密值自动清空
	});

	it("新机密但未填写机密值时，点击保存阻止提交并报错提示", async () => {
		document.documentElement.lang = "zh";
		stubFetch();
		const c = mount();
		await flush();

		const authSelect = c.querySelector<HTMLSelectElement>(".f-auth")!;
		authSelect.value = "secret";
		authSelect.dispatchEvent(new Event("change"));

		const nameInput = c.querySelector<HTMLInputElement>(".f-secret-name")!;
		const valInput = c.querySelector<HTMLInputElement>(".f-secret-val")!;
		nameInput.value = "non-existent-secret";
		nameInput.dispatchEvent(new Event("input"));
		valInput.value = "";

		const btnSave = c.querySelector<HTMLButtonElement>(".btn-save")!;
		btnSave.click();
		await flush();

		const errMsg = c.querySelector<HTMLElement>(".msg.err");
		expect(errMsg?.textContent).toContain("尚不存在，请填写机密值");
	});

	it("即使后端未下发 secrets 字段，也能从连接凭据与本地记忆中聚合已建机密并展示在下拉框中", async () => {
		document.documentElement.lang = "zh";

		// 模拟旧版本后端（完全没有 secrets 字段）
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				const u = String(url);
				if (u.includes("/remote"))
					return { ok: true, json: async () => ({ ok: true, data: { dir: "/", entries: [] } }) };
				return {
					ok: true,
					json: async () => ({
						ok: true,
						data: {
							cwd: CWD,
							configPath: ".pi/sftp.json",
							active: "mock",
							connection: {
								name: "mock",
								host: "127.0.0.1",
								port: 22,
								remotePath: "/home/test",
								ready: true,
								auth: { method: "password", password: "secret:legacy-secret" },
							},
							profiles: [{ name: "mock", ready: true, auth: { method: "password", password: "secret:legacy-secret" } }],
							// 没有 secrets 字段！
						},
					}),
				};
			}),
		);

		const c = mount();
		await flush();

		const authSelect = c.querySelector<HTMLSelectElement>(".f-auth")!;
		expect(authSelect.value).toBe("secret");

		// legacy-secret 应该自动被提取并出现在下拉框中
		const select = c.querySelector<HTMLSelectElement>(".f-secret-select");
		expect(select?.innerHTML).toContain("legacy-secret");

		const nameInput = c.querySelector<HTMLInputElement>(".f-secret-name");
		expect(nameInput?.value).toBe("legacy-secret");

		const statusEl = c.querySelector<HTMLElement>(".secret-name-status");
		expect(statusEl?.textContent).toContain("已有同名机密");
	});
});
