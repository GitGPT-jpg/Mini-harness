/* i18n smoke test: boots the compiled server, opens the built UI, verifies the
 * language switcher defaults to Chinese and switches to English.
 * Run:  npm run build && node i18n-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { freePort } from "./lib/port-utils.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// fileURLToPath（不是 URL.pathname）：Windows 上 ".pathname" 得到 "/E:/..."，
// spawn 的 cwd 与脚本参数都不存在 → ENOENT，测试根本起不来。
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 30000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-ui-"));
process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;

const server = spawn(process.execPath, [join(ROOT, "dist", "server", "index.js")], {
	cwd: ROOT,
	stdio: ["ignore", "pipe", "pipe"],
	detached: process.platform !== "win32",
});
server.on("error", (e) => console.error("[srv spawn error]", e));
server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
process.on("exit", () => {
	try {
		// win32 没有负数 PID 的进程组，退回按端口清理。
		if (process.platform === "win32") freePort(PORT);
		else process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

async function waitServer() {
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	throw new Error("server did not start");
}

async function main() {
	await waitServer();
	const browser = await chromium.launch({
		executablePath: CHROME_PATH,
	});
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const consoleErrors = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	page.on("pageerror", (e) => consoleErrors.push(String(e)));

	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".boot-wait", { state: "hidden", timeout: 60000 });
	console.log("app booted");
	const dismissModalIfOpen = async () => {
		try {
			const closeBtn = page.locator(".setup-modal .modal-close, .modal-close").first();
			if (await closeBtn.isVisible({ timeout: 2500 })) {
				await closeBtn.click();
				await page.waitForSelector(".modal-backdrop", { state: "hidden", timeout: 3000 });
				await sleep(200);
			}
		} catch {
			/* modal not shown */
		}
	};

	// -- default language is Chinese -----------------------------------------
	await page.waitForSelector(".brand-logo", { timeout: 5000 });
	await dismissModalIfOpen();
	const zhNewChat = await page.locator(".lp-new-chat-action").getAttribute("aria-label");
	check(`default UI is Chinese ("新对话")`, zhNewChat?.includes("新对话"));
	const langDropdownZh = page.locator(".topbar-flow .dropdown").filter({ hasText: "中" });
	const zhLangChip = await langDropdownZh.locator(".chip-sub").textContent();
	check(`language chip shows "中"`, zhLangChip?.includes("中"));

	// -- switch to English ----------------------------------------------------
	await langDropdownZh.locator("button.chip").click();
	await page.waitForSelector(".dd-item:has-text('English')", { timeout: 3000 });
	await page.locator(".dd-item:has-text('English')").click();
	await sleep(400);

	const enNewChat = await page.locator(".lp-new-chat-action").getAttribute("aria-label");
	check(`UI switched to English ("New chat")`, enNewChat?.includes("New chat"));
	const enTab = await page.locator('.topbar-flow [role="tab"] span').first().textContent();
	check(`view tab shows "Chat"`, enTab?.includes("Chat"));

	// model dropdown header translated
	await page.locator(".composer-tools .dropdown").first().locator("button.chip").click();
	await page.waitForSelector(".dd-header", { timeout: 3000 });
	const ddHeader = await page.locator(".dd-header").first().textContent();
	check(`model dropdown header is "Available models"`, ddHeader?.includes("Available models"));
	await page.keyboard.press("Escape");

	// -- persistence: reload keeps English ------------------------------------
	await page.reload();
	await page.waitForSelector(".topbar", { timeout: 15000 });
	await sleep(500);
	await dismissModalIfOpen();
	const enAfterReload = await page.locator(".lp-new-chat-action").getAttribute("aria-label");
	check(`English persists across reload`, enAfterReload?.includes("New chat"));

	// -- switch back to Chinese -----------------------------------------------
	const langDropdownEn = page.locator(".topbar-flow .dropdown").filter({ hasText: "EN" });
	await langDropdownEn.locator("button.chip").click();
	await page.waitForSelector(".dd-item:has-text('中文')", { timeout: 3000 });
	await page.locator(".dd-item:has-text('中文')").first().click();
	await sleep(400);
	const zhAgain = await page.locator(".lp-new-chat-action").getAttribute("aria-label");
	check(`switched back to Chinese`, zhAgain?.includes("新对话"));

	const errs = consoleErrors.filter((e) => !e.includes("favicon") && !e.includes("ResizeObserver"));
	check(`no console errors (${errs.length})`, errs.length === 0);

	await browser.close();
	console.log(`\n${passed} checks passed`);
	process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
