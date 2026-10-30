/**
 * Dual-capsule loop entry + LLM loop editor + CodeLoopModal UI test.
 * Verifies:
 * 1. Idle state renders `.goalbar-collapsed` (absolute above composer) with two
 *    non-overlapping capsules: `.loop-capsule.llm` ("LLM loop") and `.loop-capsule.code` ("代码 loop").
 * 2. Bottom bar has no `.bar-item-loop` while idle.
 * 3. Clicking `.loop-capsule.llm` expands `.goalbar` with `.goalbar-input` and start/plan buttons;
 *    start button stays disabled until a goal is typed; collapsing returns to dual capsules.
 * 4. Clicking `.loop-capsule.code` opens `CodeLoopModal` (`.cockpit-modal.code-loop-modal`),
 *    hides `.goalbar-collapsed`, and provides presets, `#cl-goal`, `#cl-criteria`,
 *    `#cl-planner`, `#cl-reviewer`, and `<details class="cockpit-adv">` (`#cl-cmd`, `#cl-roots`, `#cl-rounds`).
 * 5. Start button in `CodeLoopModal` stays disabled until `#cl-goal` is filled, then enables;
 *    Cancel closes the modal and restores the dual capsules.
 * No model calls.
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp, freePort } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
// fileURLToPath: URL.pathname 在 Windows 下是 /E:/... 形式，直接当 cwd 会失败
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

/* eslint-env node */

const CHROME = CHROME_PATH;
const PROJ = REPO_ROOT;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

let server = null;
async function startServer(port) {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: PROJ,
		env: {
			...process.env,
			PI_WEB_PORT: String(port),
			PI_WEB_DATA_DIR: mkdtempSync(join(tmpdir(), "pi-web-loopbar-")),
			PI_WEB_CWD: PROJ,
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		try {
			if (!(await portUp(port))) throw new Error("port not up");
			return;
		} catch {
			/* retry */
		}
	}
	throw new Error("server did not start");
}

async function run() {
	const port = 8921;
	await freePort(port);
	await startServer(port);
	const browser = await chromium.launch({ executablePath: CHROME, headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	await page.goto(`http://localhost:${port}`);
	await page.waitForSelector(".goalbar-collapsed", { timeout: 20000 });
	await page.waitForSelector(".boot-wait", { state: "detached", timeout: 20000 }).catch(() => {});
	await sleep(1200);

	// 1. Idle = dual capsules inside .goalbar-collapsed floating above composer.
	const collapsed = page.locator(".goalbar-collapsed");
	const collapsedPos = await collapsed.evaluate((el) => getComputedStyle(el).position);
	check("idle goalbar-collapsed floats (absolute)", collapsedPos === "absolute", collapsedPos);

	const llmCapsule = page.locator(".goalbar-collapsed .loop-capsule.llm");
	const codeCapsule = page.locator(".goalbar-collapsed .loop-capsule.code");
	check(
		"both LLM loop and code loop capsules rendered",
		(await llmCapsule.count()) === 1 && (await codeCapsule.count()) === 1,
	);

	// 2. Two capsules must not overlap horizontally.
	const g = await llmCapsule.boundingBox();
	const l = await codeCapsule.boundingBox();
	const overlap = g && l && !(g.x + g.width <= l.x || l.x + l.width <= g.x);
	check(
		"LLM loop and code loop capsules do not overlap",
		Boolean(g && l && !overlap),
		`llm=[${g?.x},${g?.width}] code=[${l?.x},${l?.width}]`,
	);

	// 3. No host:loop bottom-bar item while idle (renders only with loop state).
	check("bottom bar has no loop item while idle", (await page.locator(".bar-item-loop").count()) === 0);

	// 4. Click LLM loop capsule → expands .goalbar editor; start button disabled until goal typed.
	await llmCapsule.click();
	await page.waitForSelector(".goalbar .goalbar-input", { timeout: 8000 });
	check("clicking LLM loop capsule opens goalbar editor", true);

	const goalStartBtn = page.locator(".goalbar .goalbar-btn.action").first();
	check("LLM loop start disabled until goal typed", (await goalStartBtn.isDisabled()) === true);
	const goalInput = page.locator(".goalbar .goalbar-input");
	await goalInput.fill("验证目标输入");
	check("LLM loop start enabled after goal typed", (await goalStartBtn.isDisabled()) === false);
	await goalInput.fill("");

	// Collapse back to dual capsules (`host:goal-collapse` is the 2nd `.goalbar-icon-btn` after lock).
	const collapseBtn = page.locator(".goalbar .goalbar-row .goalbar-icon-btn").nth(1);
	await collapseBtn.click();
	await page.waitForSelector(".goalbar-collapsed .loop-capsule.code", { timeout: 8000 });

	// 5. Click code loop capsule → opens CodeLoopModal and hides bottom capsules while open.
	await page.locator(".goalbar-collapsed .loop-capsule.code").click();
	await page.waitForSelector(".cockpit-modal.code-loop-modal", { timeout: 8000 });
	check("clicking code loop capsule opens CodeLoopModal", true);
	check(
		"bottom loop capsules hidden while CodeLoopModal is open",
		(await page.locator(".goalbar-collapsed").count()) === 0,
	);

	// 6. CodeLoopModal fields: presets, goal, criteria, planner/reviewer selects, advanced details, start/cancel.
	const modalStartBtn = page.locator(".code-loop-modal .cockpit-row .btn.primary");
	check("code loop start disabled until goal typed", (await modalStartBtn.isDisabled()) === true);
	check(
		"presets + goal + criteria + planner/reviewer present",
		(await page.locator(".code-loop-modal .cockpit-preset").count()) >= 3 &&
			(await page.locator("#cl-goal").count()) === 1 &&
			(await page.locator("#cl-criteria").count()) === 1 &&
			(await page.locator("#cl-planner").count()) === 1 &&
			(await page.locator("#cl-reviewer").count()) === 1,
	);

	// Open advanced <details> and check #cl-cmd, #cl-roots, #cl-rounds.
	await page.locator(".code-loop-modal details.cockpit-adv summary").click();
	check(
		"advanced options (#cl-cmd, #cl-roots, #cl-rounds) present",
		(await page.locator("#cl-cmd").count()) === 1 &&
			(await page.locator("#cl-roots").count()) === 1 &&
			(await page.locator("#cl-rounds").count()) === 1,
	);

	await page.locator("#cl-goal").fill("修复单元测试并验证通过");
	check("code loop start enabled after goal typed", (await modalStartBtn.isDisabled()) === false);

	// Cancel closes modal and restores dual capsules.
	const cancelBtn = page.locator(".code-loop-modal .cockpit-row .btn:not(.primary)");
	await cancelBtn.click();
	await page.waitForSelector(".goalbar-collapsed .loop-capsule.code", { timeout: 8000 });
	check("canceling CodeLoopModal restores dual capsules", (await page.locator(".code-loop-modal").count()) === 0);

	await browser.close();
	server?.kill();
	console.log(failures === 0 ? "PASS loop-bar-test" : `FAIL loop-bar-test (${failures})`);
	process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
	console.error("loop-bar-test crashed:", err);
	server?.kill();
	process.exit(1);
});
