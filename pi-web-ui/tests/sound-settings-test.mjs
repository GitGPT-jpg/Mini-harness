/* Sound settings UI test: boots the compiled server, opens the built UI, and
 * exercises the sound notification configuration dropdown:
 *
 *   1. the dropdown opens with master + per-event toggles + volume
 *   2. toggling an event and changing volume persists to localStorage
 *   3. a reload restores the persisted settings
 *   4. "试听" plays a cue without throwing (no page errors)
 *   5. the desktop/PWA notification switch rendered in the same dropdown never
 *      claims "on" when it could not be enabled (permission denied / API
 *      withheld) and persists what it does show
 *
 * No model calls needed — this is pure UI + persistence.
 * Run:  npm run build && node sound-settings-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { freePort } from "./lib/port-utils.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// fileURLToPath (not URL.pathname): on Windows ".pathname" yields "/E:/..." and
// both spawn's cwd and the script argument resolve to a non-existent path.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 30000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-snd-"));
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
		// posix: kill the whole detached group; win32: negative PIDs are not a
		// thing there, so fall back to the cross-platform port cleanup.
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

async function openSoundMenu(page) {
	await page.locator('.topbar button[data-tip="设置"], .topbar .chip:has-text("设置")').first().click();
	await page.waitForSelector(".settings-modal", {
		state: "visible",
		timeout: 5000,
	});
	await page.locator(".settings-tab", { hasText: "声音与语音" }).click();
	await page.waitForSelector(".sound-menu", {
		state: "visible",
		timeout: 5000,
	});
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
	await page.waitForSelector(".topbar", { timeout: 5000 });
	console.log("app booted");

	// -- dropdown structure ---------------------------------------------------
	await openSoundMenu(page);
	// 5 sound rows (master + 4 events) + 1 desktop-notification row below them.
	const soundPanel = page.locator(".sound-menu").first();
	const rows = await soundPanel.locator(".sound-row").count();
	check("sound panel shows master + event rows", rows >= 5);
	// The desktop-notification block below the sound rows is itself a
	// .sound-menu (shared layout), so scope every sound-panel query with
	// :not(.notify-menu) — a bare .sound-menu matches two elements now.
	check(
		"event rows labelled",
		(await page.locator(".sound-menu:not(.notify-menu)").textContent())?.includes("问卷弹出") &&
			(await page.locator(".sound-menu:not(.notify-menu)").textContent())?.includes("回复结束") &&
			(await page.locator(".sound-menu:not(.notify-menu)").textContent())?.includes("出错"),
	);
	check("volume slider present", (await page.locator(".sound-volume input[type=range]").count()) === 1);
	check("default volume is 100", (await page.locator(".sound-vol-num").textContent())?.includes("100"));

	// -- master switch gates the rows ----------------------------------------
	// Scoped to the sound panel: the desktop-notification block below it also
	// has a .sound-master row, so a bare ".sound-master" selector is ambiguous.
	const soundMaster = page.locator(".sound-menu").first().locator(".sound-master input[type=checkbox]");
	const startRow = page.locator(".sound-row", { hasText: "回复开始" });
	const startCheckbox = startRow.locator('input[type="checkbox"]');
	check("start cue default off", (await startCheckbox.isChecked()) === false);
	await soundMaster.uncheck();
	check(
		"rows disabled when master off",
		(await startCheckbox.isDisabled()) === true && (await page.locator(".sound-preview").first().isDisabled()) === true,
	);
	await soundMaster.check();

	// -- toggle an event + set volume ----------------------------------------
	await startCheckbox.check();
	check("start cue enabled", await startCheckbox.isChecked());

	const range = page.locator(".sound-volume input[type=range]");
	await range.evaluate((el) => {
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
		setter.call(el, "30");
		el.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await sleep(200);
	check("volume label updates", (await page.locator(".sound-vol-num").textContent())?.includes("30"));

	// -- 试听 must not throw --------------------------------------------------
	await startRow.locator(".sound-preview").click();
	await sleep(300);
	check("preview plays without errors", consoleErrors.length === 0);

	// -- desktop (PWA) notification switch -----------------------------------
	// Same dropdown, below the sound rows. Two invariants must hold whatever
	// the platform (Windows included): the switch is usable only when the
	// browser actually exposes the Notification API (which it refuses to do on
	// a non-localhost http origin), and it never shows "on" unless the setting
	// really was persisted — a switch that lies is worse than no switch.
	const notifyBox = page.locator(".notify-menu .sound-row input[type=checkbox]");
	check("notify block rendered in the dropdown", (await notifyBox.count()) === 1);
	check("notify block explains itself", (await page.locator(".notify-menu .sound-hint").count()) >= 1);
	const notifyApi = await page.evaluate(() => "Notification" in window);
	check("notify switch disabled iff the browser withholds the API", (await notifyBox.isDisabled()) === !notifyApi);

	let notifyOn = false;
	if (notifyApi) {
		await notifyBox.check();
		await sleep(200);
		notifyOn = await notifyBox.isChecked();
		const stored = await page.evaluate(() => {
			const raw = localStorage.getItem("pi-web-notify");
			return { enabled: raw ? JSON.parse(raw).enabled === true : false, permission: Notification.permission };
		});
		check("notify switch state matches what it persisted", notifyOn === stored.enabled);
		check("notify switch on ⇒ permission granted", !notifyOn || stored.permission === "granted");

		// 「发送测试通知」面板默认关闭（web/src/components/NotifyToggle.tsx 的
		// SHOW_NOTIFY_TEST_PANEL），所以它不该出现在 UI 里。（排障时把它打开，
		// 它会显示通道 / 浏览器是否持有这条通知 / 判定依据。）
		check("diagnostic test panel is hidden by default", (await page.locator(".notify-actions").count()) === 0);
	}

	// -- persistence across reload -------------------------------------------
	await page.reload();
	await page.waitForSelector(".topbar", { timeout: 15000 });
	await openSoundMenu(page);
	check(
		"start cue persisted after reload",
		await page.locator(".sound-row", { hasText: "回复开始" }).locator('input[type="checkbox"]').isChecked(),
	);
	check("volume persisted after reload", (await page.locator(".sound-vol-num").textContent())?.includes("30"));
	check("notify switch persisted after reload", (await notifyBox.isChecked()) === notifyOn);

	if (consoleErrors.length > 0) {
		console.log("console errors:", consoleErrors.slice(0, 5));
	}
	console.log(`\n${passed} checks passed`);
	await browser.close();
	process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
	console.error("test crashed:", err);
	process.exit(1);
});
