/* 浏览器 E2E：插件声明式设置里的 select 字段（含宿主数据源 optionsFrom）在真浏览器里的行为。
 *
 * 覆盖（零 token，本地假插件 + 假模型配置，不联网）：
 *   - 静态 `options` 的 select 照常渲染候选项
 *   - `optionsFrom: "models"` 的 select 列出**已配置鉴权**的模型（provider/id），且首项 = 跟随全局默认
 *   - `optionsFrom: "thinkingLevels"` 的 select 列出 SDK 全部档位（文案走 i18n），首项 = 跟随全局默认
 *   - 改选后保存 → 服务端 storage.json 落盘的是选中值（空值 = 空串）
 *   - 页面无 JS 报错
 *
 * 缺 Chrome 自动 SKIP（与 plugin-settings-page-test / fence-render-test 同约定）。运行：
 *   npm run build && node tests/plugin-settings-select-ui-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { freePort } from "./lib/port-utils.mjs";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-setselect-ui-"));
const WORK = join(base, "work");
const DATA_DIR = join(base, "data");
const AGENT_DIR = join(base, "agent");
const PORT = 20000 + Math.floor(Math.random() * 8000);
for (const d of [WORK, DATA_DIR, AGENT_DIR]) mkdirSync(d, { recursive: true });

// 假 agent 配置：一个配置过鉴权的供应商 + 两个模型 → 模型下拉应列出它们。
writeFileSync(join(AGENT_DIR, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "main-key" } }));
writeFileSync(
	join(AGENT_DIR, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:9",
				apiKey: "main-key",
				models: [{ id: "mock-a" }, { id: "mock-b" }],
			},
		},
	}),
);

let passed = 0;
const check = (name, cond, extra) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
		process.exitCode = 1;
	}
};

// 假插件：三种 select 各一个（静态 / 模型 / 思考强度），字段标签带 T- 前缀便于定位。
const pdir = join(DATA_DIR, "plugins", "dds");
mkdirSync(pdir, { recursive: true });
writeFileSync(
	join(pdir, "manifest.json"),
	JSON.stringify({
		name: "Dropdown Test",
		version: "0.0.1",
		settings: [
			{ key: "theme", type: "select", label: "T-Theme", default: "dark", options: ["dark", "light"] },
			{ key: "model", type: "select", optionsFrom: "models", label: "T-Model", default: "" },
			{ key: "thinking", type: "select", optionsFrom: "thinkingLevels", label: "T-Think", default: "" },
		],
	}),
);
writeFileSync(join(pdir, "index.mjs"), "export default { activate() {} };\n");

let server;
let browser;

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

/** 点一个元素：headless 下 locator.click() 在顶栏/弹窗里偶发不达 —— 派发真实鼠标事件。 */
async function tap(page, locator) {
	await locator.waitFor({ state: "visible", timeout: 15000 });
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	if (!box) throw new Error("tap: 元素没有 bounding box");
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function openSettings(page) {
	// 顶栏设置按钮：宿主条目走 data-tip（设置/Settings），旧版可能只有 title，一并兼容。
	const btn = page.locator('button.chip[data-tip*="设置"], button[title*="设置"], button[title*="Settings"]').first();
	for (let attempt = 0; attempt < 6; attempt++) {
		if ((await page.locator(".settings-modal").count()) > 0) return true;
		await tap(page, btn).catch(() => {});
		for (let i = 0; i < 15; i++) {
			if ((await page.locator(".settings-modal").count()) > 0) return true;
			await sleep(200);
		}
		await page.waitForSelector(".chat-input, .inputbar, textarea", { timeout: 30000 }).catch(() => {});
	}
	return false;
}

async function until(fn, tries = 60, gapMs = 200) {
	for (let i = 0; i < tries; i++) {
		if (await fn()) return true;
		await sleep(gapMs);
	}
	return false;
}

async function settle(page, quietMs = 2500) {
	let last = Date.now();
	const onNav = (f) => {
		if (f === page.mainFrame()) last = Date.now();
	};
	page.on("framenavigated", onNav);
	try {
		for (let i = 0; i < 80; i++) {
			if (Date.now() - last >= quietMs) break;
			await sleep(250);
		}
	} finally {
		page.off("framenavigated", onNav);
	}
	await page.waitForSelector(".chat-input, .inputbar, textarea", { timeout: 30000 });
}

/** 某个字段（按标签文案定位）的 select 的候选值/文案。 */
async function optionsOf(page, labelText) {
	const select = page.locator(".plugin-settings-field", { hasText: labelText }).locator("select").first();
	await select.waitFor({ state: "attached", timeout: 15000 });
	return {
		values: await select.locator("option").evaluateAll((els) => els.map((e) => e.value)),
		labels: await select.locator("option").allTextContents(),
	};
}

async function main() {
	if (!CHROME_PATH) {
		console.log("⏭ SKIP：未找到 Chrome（设 PI_WEB_CHROME 或安装 Chrome/playwright chromium）");
		return;
	}
	server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
		cwd: REPO,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_CWD: WORK,
			PI_WEB_DATA_DIR: DATA_DIR,
			PI_CODING_AGENT_DIR: AGENT_DIR,
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
	server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));

	await waitServer();
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});

	await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(".chat-input, .inputbar, textarea", { timeout: 30000 });
	await settle(page);

	check("设置面板打开", await openSettings(page));
	await page.waitForSelector(".settings-tab", { timeout: 10000 });
	await tap(page, page.locator(".settings-tab", { hasText: /界面插件|UI plugins/ }).first());
	// 默认落在「插件市场」子页：切到「插件列表」（已安装）才看得到本地插件与它的设置表单。
	// 子页顺序固定（市场、已安装），按序号点不受语言影响。
	await tap(page, page.locator(".set-subtab").nth(1));
	check(
		"界面插件配置默认折叠（表单未渲染且存在展开按钮）",
		await until(
			async () =>
				(await page.locator(".plugin-settings-form").count()) === 0 &&
				(await page.locator(".set-settings-row .set-diag-toggle").count()) > 0,
			40,
			250,
		),
	);
	await tap(page, page.locator(".set-settings-row .set-diag-toggle").first());
	check(
		"点击展开后，渲染出声明式设置表单",
		await until(async () => (await page.locator(".plugin-settings-form").count()) > 0, 40, 250),
	);

	// ---- 静态 options：原样渲染，不塞空值 ---------------------------------
	const theme = await optionsOf(page, "T-Theme");
	check("静态 select 只有 manifest 声明的候选项", theme.values.join(",") === "dark,light", theme.values);

	// ---- optionsFrom: models：已配置鉴权的模型 + 首项「跟随全局默认」 --------
	const model = await optionsOf(page, "T-Model");
	const modelLabels = model.labels.map((s) => s.trim());
	check("模型下拉首项 = 跟随全局默认（空值）", model.values[0] === "" && modelLabels[0] !== "", {
		values: model.values,
		labels: modelLabels,
	});
	check(
		"模型下拉列出已配置鉴权的模型（provider/id）",
		model.values.includes("main/mock-a") && model.values.includes("main/mock-b"),
		model.values,
	);
	check("模型下拉不重复、无空壳项", new Set(model.values).size === model.values.length, model.values);

	// ---- optionsFrom: thinkingLevels：SDK 全档位（i18n 文案） --------------
	const think = await optionsOf(page, "T-Think");
	check(
		"思考强度下拉 = 空值 + SDK 全部档位",
		think.values.join(",") === ",off,minimal,low,medium,high,xhigh,max",
		think.values,
	);
	check(
		"档位文案走 i18n（不是裸 off/minimal）",
		think.labels.slice(1).every((s) => s.trim() && !/^(off|minimal|low|medium|high|xhigh|max)$/.test(s.trim())),
		think.labels,
	);

	// ---- 选中 → 保存 → 落盘 -------------------------------------------------
	const form = page.locator(".plugin-settings-form").filter({ hasText: "T-Model" }).first();
	await page
		.locator(".plugin-settings-field", { hasText: "T-Model" })
		.locator("select")
		.first()
		.selectOption("main/mock-b");
	await page.locator(".plugin-settings-field", { hasText: "T-Think" }).locator("select").first().selectOption("high");
	const saveBtn = form.locator(".plugin-settings-save").first();
	check("改选后保存按钮可用（脏判定生效）", await saveBtn.isEnabled());
	await tap(page, saveBtn);

	const storage = join(pdir, "storage.json");
	const saved = await until(
		() => {
			try {
				const s = JSON.parse(readFileSync(storage, "utf8")).settings;
				return s?.model === "main/mock-b" && s?.thinking === "high";
			} catch {
				return false;
			}
		},
		40,
		250,
	);
	check(
		"保存后 storage.json 落的是下拉选中的值",
		saved,
		(() => {
			try {
				return JSON.parse(readFileSync(storage, "utf8")).settings;
			} catch {
				return null;
			}
		})(),
	);

	check("页面没有 JS 报错", errors.filter((e) => !/favicon|net::ERR/.test(e)).length === 0);
	if (errors.length)
		console.log(
			"console errors:",
			errors.slice(0, 5).map((e) => e.slice(0, 200)),
		);
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
	freePort(PORT);
	rmSync(base, { recursive: true, force: true });
	await sleep(300);
	process.exit(process.exitCode ?? 0);
}
