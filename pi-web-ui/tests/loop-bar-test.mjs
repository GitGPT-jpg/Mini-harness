/**
 * Loop bar — idle pill + editor UI test.
 * Verifies the idle state is a compact pill at the RIGHT end (not overlapping
 * the centered goal pill), clicking opens the editor (goal / mode / validate
 * cmd / max rounds / reviewer), the start button stays disabled until a goal
 * is typed, and the bottom-bar host:loop item is absent while no loop runs.
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
	await page.waitForSelector(".loopbar-collapsed", { timeout: 20000 });
	// 等 state 到达、布局稳定（boot 态药丸浮在顶部 y≈160，state 到达后落到底部；
	// 不等稳定就点会点在位移前的坐标上，编辑器打不开）。
	await page.waitForSelector(".boot-wait", { state: "detached", timeout: 20000 }).catch(() => {});
	await sleep(1200);

	// 1. Idle = compact pill at the right end, floating (absolute, above composer).
	const pill = page.locator(".loopbar-collapsed");
	const pillPos = await pill.evaluate((el) => getComputedStyle(el).position);
	check("idle loop pill floats (absolute)", pillPos === "absolute", pillPos);

	// 2. Goal pill (centered) and loop pill (right) must not overlap.
	const goalPill = page.locator(".goalbar-collapsed .goalbar-hint");
	const loopPill = page.locator(".loopbar-collapsed .goalbar-hint");
	if ((await goalPill.count()) > 0) {
		const g = await goalPill.boundingBox();
		const l = await loopPill.boundingBox();
		const overlap = g && l && !(g.x + g.width < l.x || l.x + l.width < g.x);
		check("goal pill and loop pill do not overlap", !overlap, `goal=[${g?.x},${g?.width}] loop=[${l?.x},${l?.width}]`);
	} else {
		check("goal pill present alongside loop pill", false, "goalbar-collapsed pill not found");
	}

	// 3. No host:loop bottom-bar item while idle (renders only with loop state).
	check("bottom bar has no loop item while idle", (await page.locator(".bar-item-loop").count()) === 0);

	// 4. Click the pill → editor opens inside the loop slot.
	await loopPill.click();
	await page.waitForSelector(".goalbar-slot .goalbar-input", { timeout: 8000 });
	check("clicking loop pill opens editor", true);

	// 5. Editor fields: goal input + mode toggles + validate cmd + max rounds + reviewer.
	const startBtn = page.locator(".goalbar-slot .goalbar-btn", { hasText: /启动|Start/ }).first();
	check("start disabled until goal typed", (await startBtn.isDisabled()) === true);
	const goalInput = page.locator(".goalbar-slot .goalbar-input");
	await goalInput.fill("创建 done.txt");
	check("start enabled after goal typed", (await startBtn.isDisabled()) === false);
	const codeBtn = page.locator(".goalbar-slot .goalbar-btn", { hasText: /代码|Code/ }).first();
	const llmBtn = page.locator(".goalbar-slot .goalbar-btn", { hasText: "LLM" }).first();
	check("mode toggles (code/llm) present", (await codeBtn.count()) > 0 && (await llmBtn.count()) > 0);
	const labels = await page.locator(".goalbar-slot .goalbar-round").allInnerTexts();
	const labelText = labels.join(" | ");
	check(
		"validate cmd + max rounds + reviewer options present",
		/验证命令|Validate/.test(labelText) && /轮数上限|Max rounds/.test(labelText) && /Reviewer/.test(labelText),
		labelText,
	);

	// 6. Switch mode to LLM — active style moves between the two toggles.
	await llmBtn.click();
	await sleep(200);
	const llmActive = await llmBtn.getAttribute("class");
	const codeActive = await codeBtn.getAttribute("class");
	check(
		"llm mode toggles active class",
		(llmActive || "").includes("action") && !(codeActive || "").includes("action"),
	);

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
