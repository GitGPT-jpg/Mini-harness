/* page-picker 扩展「真浏览器 + 真扩展」E2E：**装真扩展**跑一遍投递与绑定。
 *
 * 为什么需要它（0.2.0 的真实事故）：`tabs.query` 的 url 过滤必须是合法 match pattern，
 * 而我们曾把「裸 origin」当成模式之一传进去 —— 真 Chrome/Edge 直接抛
 * `Invalid url pattern 'http://localhost:8787'`，被 catch 成「没找到打开的 pi-web-ui 页面」。
 * `page-picker-test.mjs` 用的是**假 chrome**（不校验模式），所以整条链全绿也放过了它 ——
 * 只有真扩展 + 真 chrome.* 才能发现这类问题。
 *
 * 为什么不加载真扩展就装不了（Chromium 137 起 --load-extension 被移除）：**实测 Edge 152
 * 的 headless 仍然认这个开关**，所以这里用 Edge 跑；没有 Edge / 开关失效时**自动 SKIP**
 * （不是失败）—— 它是额外保险，不是唯一防线（单测里的假 chrome 也会校验 match pattern）。
 *
 * Run: npm run build:extension && npm run build && node tests/page-picker-edge-ext-test.mjs
 * 覆盖跳过：PI_WEB_EDGE=/path/to/msedge
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXT_DIR = join(REPO_ROOT, "plugins", "page-picker", "extension");
const PICKER_BUNDLE = join(EXT_DIR, "dist", "picker.js");
const BIND_BUNDLE = join(EXT_DIR, "dist", "bind.js");

const EDGE_CANDIDATES = [
	process.env.PI_WEB_EDGE,
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/usr/bin/microsoft-edge",
	join(homedir(), "AppData/Local/Microsoft/Edge/Application/msedge.exe"),
].filter(Boolean);
const EDGE = EDGE_CANDIDATES.find((p) => existsSync(p));

const PORT = 8960 + Math.floor(Math.random() * 30);
const FIXTURE_PORT = 9440 + Math.floor(Math.random() * 30);
const BASE = `http://localhost:${PORT}`;

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

if (!EDGE) {
	console.log("… SKIP：没找到 Edge（设 PI_WEB_EDGE 可指定路径）");
	process.exit(0);
}
if (!existsSync(PICKER_BUNDLE) || !existsSync(BIND_BUNDLE)) {
	console.log("✗ 缺 dist/picker.js / dist/bind.js —— 先跑 npm run build:extension");
	process.exit(1);
}

const FIXTURE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>夹具页</title></head>
<body><main id="app"><section id="card" class="card"><h3>卡片标题</h3><p>正文</p></section></main></body></html>`;

const fixture = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end(FIXTURE_HTML);
});
await new Promise((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));

// ------------------------------------------------------------------ 真 pi-web-ui
const base = mkdtempSync(join(tmpdir(), "piweb-edgeext-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fastfail: { type: "api_key", key: "dummy" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			fastfail: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1",
				apiKey: "dummy",
				models: [{ id: "f", name: "F" }],
			},
		},
	}),
);
const server = spawn("node", ["dist/server/index.js"], {
	cwd: REPO_ROOT,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: workdir,
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: "ignore",
});
let up = false;
for (let i = 0; i < 80; i++) {
	try {
		if ((await fetch(`${BASE}/api/health`)).ok) {
			up = true;
			break;
		}
	} catch {}
	await sleep(250);
}
if (!up) {
	console.log("✗ pi-web-ui 没起来");
	fixture.close();
	server.kill();
	process.exit(1);
}

// ------------------------------------------------------------------ 真 Edge + 真扩展
const userDataDir = mkdtempSync(join(tmpdir(), "edge-ext-"));
const ctx = await chromium.launchPersistentContext(userDataDir, {
	executablePath: EDGE,
	headless: true,
	args: [
		`--disable-extensions-except=${EXT_DIR}`,
		`--load-extension=${EXT_DIR}`,
		"--enable-unsafe-extension-debugging",
		"--no-first-run",
		"--no-default-browser-check",
	],
});

const findSw = async (ms) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const sw = ctx.serviceWorkers().find((s) => s.url().startsWith("chrome-extension://"));
		if (sw) return sw;
		await sleep(300);
	}
	return null;
};

const sw = await findSw(8000);
if (!sw) {
	console.log("… SKIP：这个 Edge 不接受 --load-extension（装不上真扩展就测不了）");
	await ctx.close();
	fixture.close();
	server.kill();
	process.exit(0);
}
console.log("✓ 真扩展已加载：", sw.url().replace(/\/dist\/background\.js$/, ""));

const piPage = await ctx.newPage();
await piPage.goto(BASE, { waitUntil: "domcontentloaded" });
await piPage.waitForSelector(".inputbox textarea", { timeout: 30000 });

const fxPage = await ctx.newPage();
await fxPage.goto(`http://127.0.0.1:${FIXTURE_PORT}/`, { waitUntil: "domcontentloaded" });

/** 在扩展 SW 里找标签页（按 URL 包含关系）。 */
const tabIdOf = (needle) =>
	sw.evaluate(async (n) => {
		const tabs = await chrome.tabs.query({});
		return tabs.find((t) => t.url?.includes(n))?.id ?? null;
	}, needle);

const piTabId = await tabIdOf(`:${PORT}/`);
const fxTabId = await tabIdOf(`:${FIXTURE_PORT}/`);
check("两个标签页都在（真 tabs.query）", piTabId != null && fxTabId != null, `pi=${piTabId} fx=${fxTabId}`);

// 0) 这一条就是 0.2.0 漏掉的那个坑：裸 origin 不是合法 match pattern
const patternCheck = await sw.evaluate(
	async ([port]) => {
		const out = {};
		try {
			await chrome.tabs.query({ url: [`http://localhost:${port}/*`, `http://localhost:${port}`] });
			out.bare = "没抛（这个版本居然容忍裸 origin）";
		} catch (e) {
			out.bare = String(e.message);
		}
		const ok = await chrome.tabs.query({ url: [`http://localhost:${port}/*`] });
		out.originOnly = `ok(${ok.length})`;
		return out;
	},
	[PORT],
);
check(
	"裸 origin 会被真浏览器拒绝（所以代码里只能用 origin 模式查询）",
	patternCheck.bare.includes("Invalid url pattern"),
	patternCheck.bare,
);
check("origin 级模式能查到页面", patternCheck.originOnly.includes("ok("), patternCheck.originOnly);

// 1) 绑定服务地址（等同用户在选项页/浮条上做的那一步）
await sw.evaluate(async (url) => {
	await chrome.storage.sync.set({ serverUrl: url });
}, BASE);

// 2) 真投递：真 picker.js 注入夹具页 → 拾取 → 添加到对话 → 真 pi-web-ui 输入框
const injected = await sw.evaluate(
	async ([tabId]) => {
		try {
			await chrome.scripting.executeScript({ target: { tabId }, files: ["dist/picker.js"] });
			return "ok";
		} catch (e) {
			return `throw: ${e.message}`;
		}
	},
	[fxTabId],
);
check("真扩展把拾取器注入到开发页", injected === "ok", injected);
await fxPage.waitForSelector("#pi-page-picker-host", { timeout: 5000 });

await fxPage.click("#card");
await fxPage.keyboard.press("Control+Enter");
const landed = await piPage
	.waitForFunction(() => document.querySelector(".inputbox textarea")?.value.includes("### 网页元素拾取"), null, {
		timeout: 10000,
	})
	.then(() => true)
	.catch(() => false);
const composerText = await piPage.inputValue(".inputbox textarea");
check(
	"**真扩展的全链路**：拾取 → 投递 → Markdown 落进 pi-web-ui 输入框",
	landed && composerText.includes("#card"),
	JSON.stringify(composerText.slice(0, 60)),
);
check(
	"投递成功时没有走「复制兜底」（说明真的找到了那个标签页）",
	!composerText.includes("没找到打开的 pi-web-ui 页面"),
);

// 3) 绑定浮条：pi-web-ui 页面上真的会弹，且能落盘
await piPage.evaluate(() => {
	window.chrome ??= { runtime: { sendMessage: async () => null } };
});
await sw.evaluate(
	async ([tabId]) => {
		await chrome.scripting.executeScript({ target: { tabId }, files: ["dist/bind.js"] });
	},
	[piTabId],
);
await piPage.waitForTimeout(500);
const bar = await piPage.evaluate(() => {
	const host = document.getElementById("pi-page-picker-bind-host");
	const card = host?.shadowRoot?.querySelector(".card");
	return { present: Boolean(card), hidden: card?.classList.contains("hidden") ?? true, text: card?.textContent ?? "" };
});
check("真扩展在 pi-web-ui 页面上弹出绑定浮条（自己认得出页面）", bar.present && !bar.hidden, bar.text.slice(0, 50));

// 3b) 设置页的「发送什么」多选（真浏览器渲染 + 真 storage）
const optionsUrl = `${sw.url().split("/dist/")[0]}/options.html`;
const optPage = await ctx.newPage();
await optPage.goto(optionsUrl, { waitUntil: "domcontentloaded" });
await optPage.waitForSelector("#sectionList input[type=checkbox]", { timeout: 5000 });
const boxes = await optPage.$$eval("#sectionList input[type=checkbox]", (els) => els.map((e) => e.id));
check("设置页渲染出 8 个内容项开关 + 预设下拉", boxes.length === 8, boxes.join(","));
const presetCount = await optPage.$$eval("#preset option", (els) => els.length);
check("预设下拉含 6 个预设 + 自定义", presetCount === 7, `${presetCount} 项`);
// 取消勾「HTML 骨架」→ 真 storage 里 sections 少一项
await optPage.uncheck("#sec-skeleton");
await optPage.waitForTimeout(400);
const storedSections = await sw.evaluate(async () => (await chrome.storage.sync.get(null)).sections);
check(
	"取消勾选真的写进 storage（不再采集骨架）",
	Array.isArray(storedSections) && !storedSections.includes("skeleton"),
	JSON.stringify(storedSections),
);
// 选预设「只排查样式」→ 勾选项跟着变
await optPage.selectOption("#preset", "styles");
await optPage.waitForTimeout(400);
const afterPreset = await sw.evaluate(async () => (await chrome.storage.sync.get(null)).sections);
check(
	"选预设「只排查样式」→ 只剩 选择器/命中 CSS/计算样式",
	JSON.stringify(afterPreset) === JSON.stringify(["selector", "rules", "styles"]),
	JSON.stringify(afterPreset),
);
await optPage.close();

// 3c) 页面桥：真扩展 + 真 executeScript（函数真被搬进 MAIN world）+ 两个真实 origin
//
// 这一节补的是「单测/假 chrome 永远测不到」的那一段：chrome.scripting.executeScript
// 把函数 toString 后注入页面以后，它到底能不能活（引用模块作用域就会 ReferenceError）、
// 跨 origin 的 postMessage 链路通不通、tabs.onUpdated 的自动注入时机对不对。
//
// 用的是**两个普通页面**：浏览器里那个 pi-web-ui 页面是「宿主」（见 3e），它不走配对表 ——
// 配对是「两个网页互调」那条路，宿主走的是 AI 授权表。
const fixtureOrigin = `http://127.0.0.1:${FIXTURE_PORT}`;
const plainOrigin = `http://localhost:${FIXTURE_PORT}`; // 同一个夹具站，不同 origin

// 3c-0：配对表为空 → 谁都不注入（桥默认关闭）
await fxPage.reload({ waitUntil: "domcontentloaded" });
await fxPage.waitForTimeout(900);
check(
	"配对表为空时一个字节都不注入（桥默认关闭）",
	(await fxPage.evaluate(() => typeof globalThis.__piBridge)) === "undefined",
);

// 3c-1：配一对 → 重载两个页面 → 触发真的 tabs.onUpdated → worker 自己把桥装上
await sw.evaluate(
	async (list) => {
		await chrome.storage.local.set({ bridgePairs: list });
	},
	[{ a: fixtureOrigin, b: plainOrigin, enabled: true, createdAt: "e2e" }],
);
const plainPage = await ctx.newPage();
await plainPage.goto(`${plainOrigin}/`, { waitUntil: "domcontentloaded" });
await Promise.all([
	fxPage.reload({ waitUntil: "domcontentloaded" }),
	plainPage.reload({ waitUntil: "domcontentloaded" }),
]);
await fxPage.waitForTimeout(1600);

const bridgeState = (page) =>
	page.evaluate(() => ({
		has: typeof globalThis.__piBridge === "object" && globalThis.__piBridge !== null,
		peers: globalThis.__piBridge?.peers ?? null,
		version: globalThis.__piBridge?.version ?? null,
	}));
const onFx = await bridgeState(fxPage);
const onPlain = await bridgeState(plainPage);
check(
	"**真扩展把页面桥装进了两个配对页面**（MAIN world 注入 + 跨 origin）",
	onFx.has && onPlain.has,
	JSON.stringify([onFx, onPlain]),
);
check(
	"页面侧能查到自己的对端（拿到的就是另一个 origin）",
	onFx.peers?.[0] === plainOrigin && onPlain.peers?.[0] === fixtureOrigin,
	JSON.stringify([onFx.peers, onPlain.peers]),
);

await fxPage.evaluate(() => {
	window.__piBridge.on("orders", () => [{ id: 1, amount: 88 }]);
});
const bridgedRead = await plainPage.evaluate(async () => {
	try {
		return { ok: true, value: await window.__piBridge.call({ op: "orders" }) };
	} catch (err) {
		return { ok: false, error: String(err?.message ?? err) };
	}
});
check(
	"**真扩展下一个页面读到了另一个页面的数据**（跨 origin + 跨标签页走完全链）",
	bridgedRead.ok && bridgedRead.value?.[0]?.amount === 88,
	JSON.stringify(bridgedRead),
);

await plainPage.evaluate(() => {
	window.__piBridge.on("title", () => document.title);
});
const bridgedBack = await fxPage.evaluate(async () => {
	try {
		return { ok: true, value: await window.__piBridge.call({ op: "title" }) };
	} catch (err) {
		return { ok: false, error: String(err?.message ?? err) };
	}
});
check("反向也行（配对是对称的）", bridgedBack.ok && typeof bridgedBack.value === "string", JSON.stringify(bridgedBack));

// 3d) 配对候选（地址不用手打）：真 storage.local + 真 options.html
//
// 用户抱怨的就是这里：两个 origin 靠手打（协议 + 域名 + 端口，还要归一对）最容易被放弃。
// 现在「点过扩展图标的页面」会进候选，从浮条跳过来时本端还会自动预填。
await sw.evaluate(async (origin) => {
	await chrome.storage.local.set({ recentOrigins: [{ origin, title: "夹具页", at: "2026-01-02T00:00:00.000Z" }] });
}, fixtureOrigin);
const pairPage = await ctx.newPage();
await pairPage.goto(`${optionsUrl}?pair=${encodeURIComponent(fixtureOrigin)}`, { waitUntil: "domcontentloaded" });
// datalist 里的 <option> 永远不可见（waitForSelector 会一直等）→ 等个数
await pairPage.waitForFunction(() => document.querySelectorAll("#piOrigins option").length > 0, null, {
	timeout: 5000,
});
await pairPage.waitForTimeout(400); // 等 initBridgePanel 的深链预填跑完
const pairState = await pairPage.evaluate(() => ({
	a: document.getElementById("pairA").value,
	options: Array.from(document.querySelectorAll("#piOrigins option")).map((o) => o.value),
	focused: document.activeElement?.id ?? "",
}));
check(
	"**设置页预填本端（从浮条跳过来）+ 候选下拉里有那个页面** —— 手打地址这一步没了",
	pairState.a === fixtureOrigin && pairState.options.includes(fixtureOrigin) && pairState.focused === "pairB",
	JSON.stringify(pairState),
);
await pairPage.close();

// 3e) AI 操作页面：**真扩展 + 真 executeScript + 真页面**
//
// 这一节跑的才是模型真实走的那条路：浏览器里的 pi-web-ui 页面是默认调用方（宿主），
// 只需授权目标页。内置动作（read/click/eval）由扩展注入 MAIN world 后在那里执行 ——
// 单测跑的是 jsdom，这里跑的是真的浏览器。
await sw.evaluate(async (origin) => {
	await chrome.storage.local.set({ aiPages: [{ origin, title: "夹具页", at: "2026-01-03T00:00:00.000Z" }] });
}, fixtureOrigin);
await Promise.all([piPage.reload({ waitUntil: "domcontentloaded" }), fxPage.reload({ waitUntil: "domcontentloaded" })]);
await piPage.waitForTimeout(1800); // 等 tabs.onUpdated → 注入 content script → arm → MAIN 桥

/** 从宿主页（pi-web-ui）发起一个页面动作 —— 等价于模型调 browser_page 后的链路。 */
const aiCall = (op, args) =>
	piPage.evaluate(
		async ([action, payload, target]) => {
			try {
				return { ok: true, value: await window.__piBridge.call({ op: action, args: payload, to: target }) };
			} catch (err) {
				return { ok: false, error: String(err?.message ?? err) };
			}
		},
		[op, args, fixtureOrigin],
	);

const aiRead = await aiCall("read", { what: "title" });
check(
	"**AI 读到了目标页面的标题**（宿主 → 授权页，真 executeScript + MAIN world 内置动作）",
	aiRead.ok && String(aiRead.value?.title ?? "").includes("夹具页"),
	JSON.stringify(aiRead),
);

// 再走一遍**真实的 web 应用那一环**：use-chat 收到 page_request 后调的就是它。
// 上面那条直调 __piBridge 验的是扩展，这条验的是「页面 → 宿主桥 → 扩展」那一段真能跑。
const hostVersion = await piPage.evaluate(() => globalThis.__piWebUiHost?.version ?? 0);
check("宿主 API 版本 ≥ 3（有 pageCall 能力）", hostVersion >= 3, String(hostVersion));
const viaHost = await piPage.evaluate(async (target) => {
	const host = globalThis.__piWebUiHost;
	if (!host || typeof host.pageCall !== "function") return { ok: false, error: "宿主桥没有 pageCall" };
	return await host.pageCall({ op: "read", args: { what: "title" }, target, timeoutMs: 5000 });
}, fixtureOrigin);
check(
	"**经宿主桥 pageCall 跑通**（模型那条链路上的那一环：page_request → pageCall → 扩展）",
	viaHost.ok && String(viaHost.result?.title ?? "").includes("夹具页"),
	JSON.stringify(viaHost),
);

// 状态接口 + “帮用户打开设置页”：pi-web-ui 那个入口靠这两个（网页不能自己导航到 chrome-extension://）
const statusCall = await piPage.evaluate(
	async () => await globalThis.__piWebUiHost.pageCall({ op: "status", timeoutMs: 5000 }),
);
check(
	"status 报出授权页面与开关（pi-web-ui 入口的数据源）",
	statusCall.ok && statusCall.result?.installed === true && statusCall.result?.pages?.length === 1,
	JSON.stringify(statusCall),
);
const pagesBefore = ctx.pages().length;
const opened = await piPage.evaluate(
	async () => await globalThis.__piWebUiHost.pageCall({ op: "openOptions", timeoutMs: 5000 }),
);
await piPage.waitForTimeout(900);
check(
	"openOptions 让扩展真的开出一个设置页（网页自己开不了 chrome-extension://）",
	opened.ok && ctx.pages().length > pagesBefore,
	`pages=${pagesBefore}->${ctx.pages().length}`,
);
// 截图（AI 的眼睛）：真扩展 + 真 captureVisibleTab
//
// headless 下浏览器可能给不出可见区域（返回空白/报错），所以**链路与开关**必须断言，
// 「截出来的图有多大」只在真截到时校验 —— 环境限制不该让整条 E2E 变红。
const shotCall = await piPage.evaluate(
	async (target) =>
		await globalThis.__piWebUiHost.pageCall({ op: "shot", target, args: { maxEdge: 640 }, timeoutMs: 20000 }),
	fixtureOrigin,
);
if (shotCall.ok) {
	const image = shotCall.result?.image ?? {};
	check(
		"**shot 返回一张 JPEG data URL**（base64，可直接给模型看）",
		String(image.dataUrl ?? "").startsWith("data:image/jpeg;base64,"),
		String(image.dataUrl ?? "").slice(0, 40),
	);
	check(
		"shot 遵守 maxEdge（长边不超过要求）",
		Number(image.width) <= 640 && Number(image.height) <= 640,
		`${image.width}x${image.height}`,
	);
} else {
	check(
		"没给截图权限时 → 明确要求授权（headless 里点不了授权弹窗，属预期）",
		/权限|截不到/.test(String(shotCall.error ?? "")),
		String(shotCall.error),
	);
}

await sw.evaluate(async () => {
	const cur = await chrome.storage.sync.get(null);
	await chrome.storage.sync.set({ ...cur, allowShot: false });
});
const shotOff = await piPage.evaluate(
	async (target) => await globalThis.__piWebUiHost.pageCall({ op: "shot", target, timeoutMs: 5000 }),
	fixtureOrigin,
);
check(
	"**关掉截图开关 → 拒绝并说清去哪开**（截图是可开关的能力）",
	shotOff.ok === false && /截图/.test(String(shotOff.error ?? "")),
	String(shotOff.error),
);
await sw.evaluate(async () => {
	const cur = await chrome.storage.sync.get(null);
	await chrome.storage.sync.set({ ...cur, allowShot: true });
});

// 入口本身：用户能不能在 pi-web-ui 上“发现”这个能力（上一版的缺口就在这里）
const chip = await piPage.evaluate(() => document.querySelector(".browser-control")?.textContent ?? null);
check("顶栏渲染出「浏览器操作」入口", chip !== null && chip.includes("浏览器操作"), String(chip));
const panelText = await piPage.evaluate(async () => {
	document.querySelector(".browser-control")?.click();
	await new Promise((r) => setTimeout(r, 400));
	return document.querySelector(".browser-control-modal")?.textContent ?? null;
});
check(
	"**点开面板能看到状态 + 授权入口 + 可照抄的例子**（不用去翻文档）",
	panelText !== null && panelText.includes("已授权的页面") && panelText.includes("打开扩展设置页"),
	String(panelText).slice(0, 80),
);
await piPage.keyboard.press("Escape");

// 关掉那个新开出来的设置页（不影响后续场景）
for (const p of ctx.pages()) if (p !== piPage && p !== fxPage && p !== plainPage) await p.close();

// 真点击：目标页自己的监听器必须收到（这才是“操作”，不是改个变量）
await fxPage.evaluate(() => {
	globalThis.__clicks = 0;
	document.getElementById("card")?.addEventListener("click", () => {
		globalThis.__clicks += 1;
	});
});
const aiClick = await aiCall("click", { selector: "#card" });
const clicked = await fxPage.evaluate(() => globalThis.__clicks);
check(
	"**AI 点了目标页面的元素**（页面的监听器真的收到一次）",
	aiClick.ok && clicked === 1,
	`click=${JSON.stringify(aiClick)} clicks=${clicked}`,
);

const aiEvalDenied = await aiCall("eval", { code: "1 + 1" });
check(
	"eval 默认关（真扩展下也一样）：拒且说清怎么开",
	!aiEvalDenied.ok && /eval/.test(aiEvalDenied.error ?? ""),
	aiEvalDenied.error,
);

await sw.evaluate(async () => {
	const cur = await chrome.storage.sync.get(null);
	await chrome.storage.sync.set({ ...cur, allowEval: true });
});
const aiEval = await aiCall("eval", { code: "[1,2,3].length" });
check("设置里打开后 eval 放行，且在目标页面里真执行", aiEval.ok && aiEval.value?.value === 3, JSON.stringify(aiEval));

const aiDenied = await aiCall("rm-rf", {});
check(
	"白名单外的动作 → 拒（模型不能指使扩展干别的）",
	!aiDenied.ok && /不支持的动作/.test(aiDenied.error ?? ""),
	aiDenied.error,
);

// 4) 非 pi-web-ui 页面上浮条要自己退场（background 探测失败时也不能「什么都没发生」）
const beforePick = await fxPage.evaluate(() => Boolean(document.getElementById("pi-page-picker-host")));
await sw.evaluate(
	async ([tabId]) => {
		await chrome.scripting.executeScript({ target: { tabId }, files: ["dist/bind.js"] });
	},
	[fxTabId],
);
await fxPage.waitForTimeout(800);
const afterBindOnFixture = await fxPage.evaluate(() => ({
	bar: Boolean(document.getElementById("pi-page-picker-bind-host")),
	picker: Boolean(document.getElementById("pi-page-picker-host")),
}));
check("夹具页上浮条自己退场", !afterBindOnFixture.bar, JSON.stringify(afterBindOnFixture));
check(
	"退场后由 worker 补注入拾取器（点图标永不静默）",
	afterBindOnFixture.picker || beforePick,
	JSON.stringify(afterBindOnFixture),
);

await ctx.close();
fixture.close();
server.kill();
console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
