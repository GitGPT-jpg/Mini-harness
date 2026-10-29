/* 浏览器 E2E（issue #290）：左栏「另一处」行**左键点击**的两段确认过户。
 *
 * 背景：#145 把「另一处」行做成只读行（无 onClick），于是 #291 里那批残骸行
 * 用户点不动也关不掉。这里给可过户的行（有 owner + convId）补上左键点击：
 * 第一次点进入确认态（行内文案变「确认过户到当前页面？」+ .confirm 底色），
 * 第二次点才真发 take_over_conversation。本测试用真浏览器验这条交互，
 * 并确认过户后该行真的从「另一处」消失、变成本页自有对话。
 *
 * 造数据（零 token）：种一条历史会话；页面 A 点开它 → A 持有该对话（运行列表自有行）；
 * 页面 B（独立 context = 独立 clientId，sessionStorage 隔离）就能看到它作为 elsewhere 行。
 *
 * 缺 Chrome 自动 SKIP（与 context-menu-ui-test 同约定）。运行：
 *   npm run build && node tests/elsewhere-click-takeover-ui-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { freePort } from "./lib/port-utils.mjs";

if (!CHROME_PATH) {
	console.log("SKIP: 未找到 Chrome（设 PI_WEB_CHROME 可指定路径）");
	process.exit(0);
}

const REPO = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-elsewhere-click-"));
const WORK = join(base, "work");
const DATA_DIR = join(base, "data");
const AGENT_DIR = join(base, "agent");
const PORT = 20000 + Math.floor(Math.random() * 8000);
freePort(PORT);
mkdirSync(WORK, { recursive: true });

/** 种一条历史会话（格式与 pi CLI/TUI 相同）。 */
function seedSession(cwd, id, text) {
	const dir = join(AGENT_DIR, "sessions");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-08-04T00-00-00-000Z_${id}.jsonl`);
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-04T00:00:00.000Z", cwd }),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-08-04T00:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text }], timestamp: 1722700801000 },
			}),
		].join("\n") + "\n",
	);
	return file;
}
seedSession(WORK, "elsewhere-click-seed", "点击过户回归用的对话");
// 隔离的 agent 目录得先有 auth/models，否则首启弹「首次配置」挡住界面（零 token）。
writeFileSync(join(AGENT_DIR, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(AGENT_DIR, "models.json"),
	JSON.stringify(
		{
			providers: {
				mock: {
					name: "Mock",
					api: "openai-completions",
					baseUrl: "http://127.0.0.1:9/v1",
					apiKey: "sk-mock",
					models: [{ id: "ui-click-mock", name: "Mock" }],
				},
			},
		},
		null,
		2,
	),
);

let passed = 0;
const check = (name, cond, extra = "") => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ""}`);
	} else {
		console.log(`  ✗ FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
		process.exitCode = 1;
	}
};

let server;
let browser;

async function waitServer() {
	for (let i = 0; i < 120; i++) {
		try {
			if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error("server did not start");
}

async function until(fn, tries = 60, gapMs = 200) {
	for (let i = 0; i < tries; i++) {
		if (await fn()) return true;
		await sleep(gapMs);
	}
	return false;
}

/** 等页面安静（服务端刚 build 过时页面会自愈重载一次）。 */
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
}

/** 点一个元素：headless 下 locator.click() 偶发不达，按坐标派发真实鼠标事件。 */
async function tap(page, locator) {
	await locator.waitFor({ state: "visible", timeout: 15000 });
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	if (!box) throw new Error("tap: 元素没有 bounding box");
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** 打开一页（独立 context → 独立 sessionStorage → 独立 clientId）。 */
async function openPage(context) {
	const page = await context.newPage();
	await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(".chat-input, .inputbar, textarea", { timeout: 30000 });
	await settle(page);
	return page;
}

try {
	server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
		cwd: REPO,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: DATA_DIR,
			PI_WEB_CWD: WORK,
			PI_CODING_AGENT_DIR: AGENT_DIR,
			// 扁平「额外会话根」：种子会话直接以 *.jsonl 平铺在那里就会被列出。
			PI_CODING_AGENT_SESSION_DIR: join(AGENT_DIR, "sessions"),
			PI_WEB_TOKEN: "",
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
	server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));

	await waitServer();
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });

	// ---- 页面 A：持有那条会话（点开历史会话 → 进「运行的对话」）-------------
	const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const pageA = await openPage(ctxA);
	const errorsA = [];
	pageA.on("pageerror", (e) => errorsA.push(String(e)));
	const leftA = pageA.locator(".panel-left").first();
	const histRow = leftA.locator(".panel-sessions .session-item").first();
	check("A：历史会话行可见", await until(async () => (await histRow.count()) > 0, 50, 250));
	await tap(pageA, histRow);
	check(
		"A：打开后「运行的对话」出现自有行",
		await until(async () => (await leftA.locator(".lp-section-convs .lp-row").count()) > 0, 50, 250),
	);

	// ---- 页面 B：应看到该对话作为「另一处」行 -----------------------------
	const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const pageB = await openPage(ctxB);
	const errorsB = [];
	pageB.on("pageerror", (e) => errorsB.push(String(e)));
	const leftB = pageB.locator(".panel-left").first();
	const elsewhereRow = leftB.locator(".session-item.elsewhere-item").first();
	check(
		"B：看到「另一处」行",
		await until(async () => (await elsewhereRow.count()) > 0, 60, 250),
		await leftB
			.locator(".panel-left, .panel-left")
			.first()
			.innerText()
			.catch(() => ""),
	);

	// 该行是可点击的 button（#290 修复点：修复前是 div，点不动）。
	const tagName = await elsewhereRow.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
	check("「另一处」行是 button（可点击）", tagName === "button", `tag=${tagName}`);

	const titleBefore = (await elsewhereRow.getAttribute("title")) ?? "";
	// 第一次点：进入确认态（不搬迁）。
	await tap(pageB, elsewhereRow);
	const confirmed = await until(
		async () => (await leftB.locator(".session-item.elsewhere-item.confirm").count()) > 0,
		20,
		150,
	);
	check("第一次点击进入确认态（.confirm）", confirmed);
	check(
		"确认态文案变成「确认过户到当前页面？」",
		await until(async () => (await elsewhereRow.innerText()).includes("确认过户"), 20, 150),
	);
	// 可选：给人工看效果留一张图（PI_WEB_SHOT=1 时）。
	if (process.env.PI_WEB_SHOT) {
		await leftB.screenshot({ path: join(REPO, "tests", "scratch", "elsewhere-confirm.png") }).catch(() => {});
	}
	check("确认态 title 换成确认提示", ((await elsewhereRow.getAttribute("title")) ?? "") !== titleBefore);

	// 再点一次：真过户 → 该行从「另一处」消失，变成 B 的自有对话。
	await tap(pageB, elsewhereRow);
	const movedToSelf = await until(
		async () =>
			(await leftB.locator(".session-item.elsewhere-item").count()) === 0 &&
			(await leftB.locator(".lp-section-convs .session-item:not(.elsewhere-item)").count()) > 0,
		60,
		250,
	);
	check("第二次点击完成过户（elsewhere 行消失、变成本页自有对话）", movedToSelf);

	check("A：页面无 JS 报错", errorsA.length === 0, errorsA.join(" | "));
	check("B：页面无 JS 报错", errorsB.length === 0, errorsB.join(" | "));

	console.log(`\n${passed} check(s) passed`);
} catch (err) {
	console.error(`FAIL: ${err.stack || err}`);
	process.exitCode = 1;
} finally {
	try {
		await browser?.close();
	} catch {
		/* ignore */
	}
	try {
		if (server?.pid) process.kill(-server.pid);
	} catch {
		try {
			server?.kill();
		} catch {
			/* ignore */
		}
	}
	await sleep(300);
}
