/**
 * 统一任务入口（D-12-4）浏览器用例：输入框上沿一枚「新任务」胶囊 + 统一任务弹窗（TaskModal）。
 * Verifies:
 * 1. Idle state renders `.goalbar-collapsed` (absolute above composer) with exactly ONE capsule
 *    `.loop-capsule.task`; no `.loop-capsule.llm/.code`, no inline goal editor, no `.bar-item-loop`.
 * 2. Clicking the capsule opens `.cockpit-modal.task-modal` and hides `.goalbar-collapsed` while open.
 * 3. Modal has presets, `#task-goal`, `#task-criteria`, three acceptance radios (default code-review),
 *    planner/reviewer selects, and `<details class="cockpit-adv">` with `#task-cmd/#task-roots/#task-rounds`.
 * 4. Acceptance options toggle fields: code-only hides the reviewer select; model-review-only hides
 *    check command / artifact roots, shows executor model + 「帮我细化」.
 * 5. Start stays disabled until `#task-goal` is filled; a preset fills goal + criteria.
 * 6. Cancel and Escape both close the modal and restore the single capsule.
 * 7. No uncaught page errors.
 * Zero-token: never clicks Start / 帮我细化 (those would reach a model).
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

const visible = async (page, sel) =>
	(await page.locator(sel).count()) > 0 && (await page.locator(sel).first().isVisible());

async function run() {
	const port = 8921;
	await freePort(port);
	await startServer(port);
	const browser = await chromium.launch({ executablePath: CHROME, headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
	const pageErrors = [];
	page.on("pageerror", (err) => pageErrors.push(String(err?.message ?? err)));
	await page.addInitScript(() => localStorage.setItem("pi-web-ui:lang", "zh"));
	await page.goto(`http://localhost:${port}`);
	await page.waitForSelector(".goalbar-collapsed", { timeout: 20000 });
	await page.waitForSelector(".boot-wait", { state: "detached", timeout: 20000 }).catch(() => {});
	await sleep(1200);
	// 1. Idle = one 「新任务」 capsule inside .goalbar-collapsed floating above the composer.
	const collapsed = page.locator(".goalbar-collapsed");
	const collapsedPos = await collapsed.evaluate((el) => getComputedStyle(el).position);
	check("idle goalbar-collapsed floats (absolute)", collapsedPos === "absolute", collapsedPos);
	const capsule = page.locator(".goalbar-collapsed .loop-capsule.task");
	check(
		"exactly one 新任务 capsule",
		(await page.locator(".loop-capsule").count()) === 1 && (await capsule.count()) === 1,
	);
	check("capsule label is 新任务", (await capsule.innerText()).trim() === "新任务");
	check(
		"no old LLM loop / code loop capsules or inline goal editor",
		(await page.locator(".loop-capsule.llm, .loop-capsule.code, .goalbar-input").count()) === 0,
	);
	check("bottom bar has no loop item while idle", (await page.locator(".bar-item-loop").count()) === 0);

	// 2. Click capsule → TaskModal opens; capsule row hidden while open.
	await capsule.click();
	await page.waitForSelector(".cockpit-modal.task-modal", { timeout: 8000 });
	check("clicking capsule opens the task modal", true);
	check("capsule hidden while the task modal is open", (await page.locator(".goalbar-collapsed").count()) === 0);

	// 3. Fields: presets, goal, criteria, three acceptance radios (default code-review), models, advanced.
	const modal = page.locator(".task-modal");
	const startBtn = modal.locator(".cockpit-row .btn.primary");
	const radio = (v) => modal.locator(`input[name="task-accept"][value="${v}"]`);
	check(
		"presets + goal + criteria present",
		(await modal.locator(".cockpit-preset").count()) >= 3 &&
			(await page.locator("#task-goal").count()) === 1 &&
			(await page.locator("#task-criteria").count()) === 1,
	);
	const radioValues = await modal.locator('input[name="task-accept"]').evaluateAll((els) => els.map((e) => e.value));
	check("three acceptance options", radioValues.join(",") === "code-review,code,llm", radioValues.join(","));
	check("default acceptance = 代码验证 + 模型评审", await radio("code-review").isChecked());
	check(
		"code-review shows planner + reviewer selects",
		(await visible(page, "#task-planner")) && (await visible(page, "#task-reviewer")),
	);
	await modal.locator("details.cockpit-adv summary").click();
	check(
		"advanced (#task-cmd, #task-roots, #task-rounds) visible for code-review",
		(await visible(page, "#task-cmd")) && (await visible(page, "#task-roots")) && (await visible(page, "#task-rounds")),
	);
	check("no 帮我细化 for code-review", (await modal.locator(".task-refine").count()) === 0);

	// 4. Acceptance toggles.
	await radio("code").check();
	check("仅代码验证 hides the reviewer select", (await page.locator("#task-reviewer").count()) === 0);
	check(
		"仅代码验证 keeps planner + check command",
		(await visible(page, "#task-planner")) && (await visible(page, "#task-cmd")),
	);
	await radio("llm").check();
	check(
		"仅模型评审 hides check command + artifact roots",
		(await page.locator("#task-cmd").count()) === 0 && (await page.locator("#task-roots").count()) === 0,
	);
	check(
		"仅模型评审 shows executor model, rounds and 帮我细化",
		(await visible(page, "#task-exec")) &&
			(await visible(page, "#task-rounds")) &&
			(await visible(page, ".task-refine")),
	);
	check("帮我细化 disabled until goal typed", await modal.locator(".task-refine").isDisabled());
	await radio("code-review").check();
	check("back to code-review restores the reviewer select", await visible(page, "#task-reviewer"));

	// 5. Start gating + preset fill.
	check("start disabled until goal typed", await startBtn.isDisabled());
	await page.locator("#task-goal").fill("修复单元测试并验证通过");
	check("start enabled after goal typed", !(await startBtn.isDisabled()));
	await page.locator("#task-goal").fill("");
	check("start disabled again when goal cleared", await startBtn.isDisabled());
	await modal.locator(".cockpit-preset").nth(1).click();
	check(
		"preset fills goal + criteria",
		(await page.locator("#task-goal").inputValue()).length > 0 &&
			(await page.locator("#task-criteria").inputValue()).length > 0 &&
			!(await startBtn.isDisabled()),
	);

	// 6. Cancel restores the capsule; Escape does too.
	await modal.locator(".cockpit-row .btn:not(.primary):not(.task-refine)").click();
	await page.waitForSelector(".goalbar-collapsed .loop-capsule.task", { timeout: 8000 });
	check("cancel closes the modal and restores the capsule", (await page.locator(".task-modal").count()) === 0);
	await page.locator(".goalbar-collapsed .loop-capsule.task").click();
	await page.waitForSelector(".cockpit-modal.task-modal", { timeout: 8000 });
	await page.keyboard.press("Escape");
	await page.waitForSelector(".goalbar-collapsed .loop-capsule.task", { timeout: 8000 });
	check("Escape closes the modal and restores the capsule", (await page.locator(".task-modal").count()) === 0);

	// 7. No uncaught page errors.
	check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

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
