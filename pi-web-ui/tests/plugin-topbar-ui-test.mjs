/* 浏览器 E2E（issue #146 + #152）：插件顶栏条目与「设置面板内后台安装」在真浏览器里的行为。
 *
 * 覆盖（零 token，本地假插件，不联网）：
 *   - manifest `ui.topbar` 声明的按钮渲染在宿主顶栏（旧的顶层 `manifest.topbar` 已不再解析）
 *   - 点击 → 宿主按需加载插件 client bundle → 插件接管的动作命中（onUiAction / 旧名 onTopbarAction）
 *   - 设置面板「界面插件」页出现「界面布局」管理段（隐藏/排序）
 *   - 插件市场出现「源码构建」（--build）勾选项
 *   - 卸载走后台作业：客户端发出 plugin_job、服务端回 start/log/done(ok)，
 *     **设置面板全程不关**（issue #152 的核心诉求），卸载完成后插件从列表消失
 *   - 页面无 JS 报错
 *
 * 缺 Chrome 自动 SKIP（与 fence-render-test 同约定）。运行：
 *   npm run build && node tests/plugin-topbar-ui-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-topbar-ui-"));
const WORK = join(base, "work");
const DATA_DIR = join(base, "data");
const PORT = 20000 + Math.floor(Math.random() * 8000);
mkdirSync(WORK, { recursive: true });

let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

// 假插件：view:false（不会被视图加载器提前加载）+ 一个 topbar 条目（动作要插件自己接管）
const pdir = join(DATA_DIR, "plugins", "toptest");
mkdirSync(join(pdir, "client"), { recursive: true });
writeFileSync(
	join(pdir, "manifest.json"),
	JSON.stringify({
		name: "Top Test",
		version: "0.0.1",
		view: false,
		// UI 贡献需要能力声明（issue #146：host.ui 门控）
		permissions: ["ui"],
		ui: {
			topbar: [
				{ id: "ping", label: "Ping Me", kind: "action", action: "toptest:ping" },
				{ id: "hidden-one", label: "Hidden One", kind: "action", action: "toptest:ping", hidden: true },
			],
		},
	}),
);
writeFileSync(
	join(pdir, "client", "entry.mjs"),
	`window.__piWebUiHost?.onTopbarAction?.("toptest:ping", () => { document.title = "TOPBAR-ACTION-OK"; });
export default { mount(container) { container.textContent = "toptest"; } };
`,
);

let server;
let browser;
let passedChecks = 0;

async function waitServer() {
	for (let i = 0; i < 120; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/api/health`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error("server did not start");
}

async function main() {
	if (!CHROME_PATH) {
		console.log("⏭ SKIP：未找到 Chrome（设 PI_WEB_CHROME 或安装 Chrome/playwright chromium）");
		return;
	}
	server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
		cwd: REPO,
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_CWD: WORK, PI_WEB_DATA_DIR: DATA_DIR },
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
	server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));

	await waitServer();
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	// 宽视口：顶栏「放不下的自动进 ⋯」（#162）按**实测宽度**从尾部丢条目，
	// 默认 1280×720 下这个插件条目会落进溢出菜单，而本用例要验的正是
	// 「插件声明的按钮渲染在宿主顶栏」。
	const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
	const errors = [];
	const jobFrames = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});
	page.on("websocket", (ws) => {
		ws.on("framesent", (f) => {
			const s = String(f.payload);
			if (s.includes('"type":"plugin_job"')) jobFrames.push({ dir: "out", s });
		});
		ws.on("framereceived", (f) => {
			const s = String(f.payload);
			if (s.includes('"type":"plugin_job"')) jobFrames.push({ dir: "in", s: s.slice(0, 400) });
		});
	});

	await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
	// 只认这个插件自己的按钮：`.plugin-topbar-item` 也被「⋯」溢出按钮复用，
	// `.first()` 会拿到「⋯」（文字不是 Ping Me）而误判。
	const pluginBtn = page.locator(".plugin-topbar-item", { hasText: "Ping Me" }).first();
	await pluginBtn.waitFor({ timeout: 20000 }).catch(() => {});
	const label = await pluginBtn.textContent().catch(() => "");
	check("插件声明的顶栏按钮渲染在宿主顶栏", (label ?? "").includes("Ping Me"));

	// 点击 → 宿主按需加载 plugin bundle（view:false 没被预加载）→ 动作被插件接管
	await pluginBtn.click();
	let actionOk = false;
	for (let i = 0; i < 60; i++) {
		if ((await page.title()) === "TOPBAR-ACTION-OK") {
			actionOk = true;
			break;
		}
		await sleep(100);
	}
	check("点击后插件接管的动作被执行（按需加载 client bundle）", actionOk);

	// 设置面板：顶栏条目管理段 + 源码构建开关
	// 顶栏直流内不用原生 title（用 data-tip），title 只作旧构建回落。
	const settingsBtn = page
		.locator(
			'button.chip[data-tip*="设置"], button.chip[data-tip*="Settings"], button[title*="设置"], button[title*="Settings"]',
		)
		.first();
	if (await settingsBtn.count()) await settingsBtn.click();
	await sleep(800);
	// 按页签选择器点（`getByText` 可能命中页内文案而不是左侧导航的页签，点了不切页）。
	const pluginsTab = page.locator(".settings-tab", { hasText: /界面插件|UI plugins/ }).first();
	if (await pluginsTab.count()) await pluginsTab.click();
	await sleep(600);
	check("设置面板出现「界面布局」管理段", (await page.getByText("界面布局", { exact: false }).count()) > 0);
	// 「源码构建」勾选项属于**市场**栏（默认子页签），所以要在切到「插件列表」之前断言。
	check("插件市场出现「源码构建」勾选项", (await page.getByText("源码构建", { exact: false }).count()) > 0);
	// 「界面插件」页有子页签：**插件市场**（默认）/ **插件列表**；插件行的更新/卸载按钮在「插件列表」那一栏。
	const installedSub = page.locator(".set-subtab", { hasText: /插件列表|Plugin list/ }).first();
	if (await installedSub.count()) await installedSub.click();
	await sleep(600);

	// 卸载走后台作业：面板不关、服务端回 start→log→done(ok)
	const uninstallBtn = page.locator('button[title*="卸载"], button[title*="Uninstall"]').first();
	check("插件列表有卸载按钮", (await uninstallBtn.count()) > 0);
	if (await uninstallBtn.count()) {
		await uninstallBtn.click();
		await sleep(250);
		const confirm = page.locator("button.set-uninstall.confirm").first();
		check("卸载走两步确认", (await confirm.count()) > 0);
		if (await confirm.count()) await confirm.click();
		let done = false;
		for (let i = 0; i < 100; i++) {
			done = jobFrames.some((f) => f.dir === "in" && f.s.includes('"phase":"done"') && f.s.includes('"ok":true'));
			if (done) break;
			await sleep(200);
		}
		const sentInstall = jobFrames.some((f) => f.dir === "out" && f.s.includes('"action":"uninstall"'));
		check("卸载走后台作业（客户端发 plugin_job，服务端回 done:ok）", sentInstall && done);
		check("设置面板全程没有关闭", (await page.getByText("界面插件", { exact: true }).count()) > 0);
		let gone = false;
		for (let i = 0; i < 40; i++) {
			// 卸载成功后列表里不再有这台插件（= 结果可见）
			if ((await page.getByText("Top Test", { exact: false }).count()) === 0) {
				gone = true;
				break;
			}
			await sleep(200);
		}
		check("卸载结果可见（插件从列表消失）", gone);
	}

	check("页面没有 JS 报错", errors.filter((e) => !/favicon|net::ERR/.test(e)).length === 0);
	if (errors.length)
		console.log(
			"console errors:",
			errors.slice(0, 5).map((e) => e.slice(0, 200)),
		);
	passedChecks = passed;
	console.log(`\n${passed} checks passed`);
}

try {
	await main();
} catch (err) {
	console.error("test error:", err);
	process.exitCode = 1;
} finally {
	try {
		await browser?.close();
	} catch {
		/* ignore */
	}
	if (server?.pid) {
		try {
			process.kill(-server.pid, "SIGKILL");
		} catch {
			try {
				server.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		}
	}
	rmSync(base, { recursive: true, force: true });
	await sleep(300);
	process.exit(process.exitCode ?? 0);
}
