/* 侧边停靠栏（SideDock）的**竖向三段**回归（issue：侧边按钮也要能指定靠上/靠下/居中）。
 *
 * 停靠栏默认是空的（BUILTIN_UI_ITEMS 没有条目落在 sidebar.left / sidebar.right），用户经
 * 布局偏好把内置条目挪进来：设置 → 界面布局的「位置」「对齐」下拉、顶栏条目右键「移到左侧悬浮 /
 * 右侧悬浮」写的都是同一份 `uiLayout.slots` + `uiLayout.align`。本测试直接种这份偏好，把三个
 * 内置顶栏条目分别以 start / center / end 挪进左、右停靠栏。
 *
 * 盯三条不变量（都是渲染几何，单测测不到）：
 *   1. `entry.align` 在左右停靠栏里读作**竖轴**：start 在上、center 正中、end 在下，
 *      且三颗药丸的竖向次序与设置页说的段一致（每段里就是被挪进来的那个内置条目）；
 *   2. 药丸是**内容高**的贴边小药丸 —— 弹性格子被拉满整列，但药丸不许跟着被拉高
 *      （曾经一圈 1 个图标拓成一整条竖色块）；
 *   3. 折叠按钮只在**悬浮浮层**里出现（流内模式停靠栏只占一条窄边，收起省不下宽度还多
 *      一次点击）；悬浮模式折叠后只剩一个 22×22 的小按钮，再点即展开。
 *
 * 缺 Chrome 自动 SKIP。运行：npm run build && node tests/side-dock-align-ui-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { freePort } from "./lib/port-utils.mjs";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-dock-"));
const WORK = join(base, "work");
const DATA_DIR = join(base, "data");
const AGENT_DIR = join(base, "agent");
mkdirSync(WORK, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });
const PORT = 21000 + Math.floor(Math.random() * 3000);

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

if (!CHROME_PATH) {
	console.log("SKIP: 未找到 Chrome（设 PI_WEB_CHROME 指定）");
	process.exit(0);
}

// 挪进停靠栏的内置条目（顺序 = start / center / end）。都是普通动作 / 视图按钮：避开
// host:settings（必留顶栏的入口）与按运行能力隐藏的 host:new-sandbox / host:new-ephemeral-chat。
const DOCK_ITEMS = {
	"sidebar.left": ["host:search", "host:task-desk", "host:tasks"],
	"sidebar.right": ["host:new-chat", "host:open-project", "host:terminal"],
};
const ALIGNS = ["start", "center", "end"];

/** 停靠栏形态是全局设置（client-state.json）：两轮各起一次服务，免得靠 UI 点开关。
 *  条目落点（slots）与段（align）一起种进同一份 uiLayout。 */
function seedPrefs(sideDockFloat) {
	const slots = {};
	const align = {};
	for (const [slot, ids] of Object.entries(DOCK_ITEMS)) {
		ids.forEach((id, i) => {
			slots[id] = slot;
			align[id] = ALIGNS[i];
		});
	}
	writeFileSync(
		join(DATA_DIR, "client-state.json"),
		JSON.stringify({ __settings__: { projects: [], settings: { uiLayout: { sideDockFloat, slots, align } } } }),
	);
}

let server;
let browser;

async function startServer() {
	server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
		cwd: REPO,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_CWD: WORK,
			PI_WEB_DATA_DIR: DATA_DIR,
			// 只挂额外会话根：不污染真用户的 ~/.pi，也不会触发「首次配置」向导。
			PI_CODING_AGENT_SESSION_DIR: join(AGENT_DIR, "sessions"),
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	server.stdout.on("data", () => {});
	server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
	for (let i = 0; i < 160; i++) {
		try {
			if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error("server did not start");
}

function killServer() {
	if (!server?.pid) return;
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		try {
			server.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}
	server = undefined;
}

/** 停靠栏的静态几何（在页面里跑）。 */
const geoScript = () => {
	const rect = (el) => {
		const r = el.getBoundingClientRect();
		return { top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width) };
	};
	const dock = document.querySelector(".side-dock-left");
	const dump = (sel) =>
		[...document.querySelectorAll(sel)].map((s) => ({ ...rect(s), pe: getComputedStyle(s).pointerEvents }));
	/** 每颗药丸里条目的 id（按竖向次序），用来核对「哪个内置条目落在哪一段」。 */
	const segIds = (sel) =>
		[...document.querySelectorAll(sel)].map((s) =>
			[...s.querySelectorAll("[data-bar-item]")].map((n) => n.getAttribute("data-bar-item")).join(","),
		);
	return {
		dockCls: dock.className,
		dock: rect(dock),
		slots: dump(".side-dock-left .side-dock-slot"),
		segs: dump(".side-dock-left .side-dock-seg"),
		rightSegs: dump(".side-dock-right .side-dock-seg"),
		leftIds: segIds(".side-dock-left .side-dock-seg"),
		rightIds: segIds(".side-dock-right .side-dock-seg"),
		collapseButtons: document.querySelectorAll(".side-dock-collapse-btn").length,
		toggleButtons: document.querySelectorAll(".side-dock-toggle-btn").length,
	};
};

async function openPage() {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});
	await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(".side-dock-left .side-dock-seg", { timeout: 60000 });
	await sleep(2000);
	return { page, errors };
}

async function main() {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });

	// ── 流内模式（默认）──────────────────────────────────────────────
	console.log("\n§1 流内：align 读作竖轴（靠上 / 居中 / 靠下）");
	seedPrefs(false);
	await startServer();
	{
		const { page, errors } = await openPage();
		const g = await page.evaluate(geoScript);
		check(
			"左停靠栏画了三颗药丸（布局偏好挪进来的三个内置条目按 start/center/end 都渲染）",
			g.segs.length === 3,
			`segs=${g.segs.length}`,
		);
		check("右停靠栏同口径", g.rightSegs.length === 3, `segs=${g.rightSegs.length}`);
		check(
			"每段就是挪进来的那个内置条目（靠上 → 居中 → 靠下）",
			g.leftIds.join("|") === DOCK_ITEMS["sidebar.left"].join("|") &&
				g.rightIds.join("|") === DOCK_ITEMS["sidebar.right"].join("|"),
			`left=${g.leftIds.join("|")} right=${g.rightIds.join("|")}`,
		);
		const [top, mid, bot] = g.segs;
		check("竖向次序 = 靠上 → 居中 → 靠下", top.top < mid.top && mid.bottom < bot.bottom);
		check("靠上那颗贴着停靠栏顶端", Math.abs(top.top - (g.dock.top + 6)) <= 2, `top=${top.top} dockTop=${g.dock.top}`);
		check(
			"靠下那颗贴着停靠栏底端",
			Math.abs(bot.bottom - (g.dock.bottom - 6)) <= 2,
			`bottom=${bot.bottom} dockBottom=${g.dock.bottom}`,
		);
		check(
			"居中那颗落在停靠栏竖向正中（±2px）",
			Math.abs((mid.top + mid.bottom) / 2 - (g.dock.top + g.dock.bottom) / 2) <= 2,
			`mid=${(mid.top + mid.bottom) / 2} dock=${(g.dock.top + g.dock.bottom) / 2}`,
		);
		check(
			"药丸是内容高，没被弹性格子拉满整条",
			g.segs.every((s) => s.bottom - s.top < 120),
			g.segs.map((s) => s.bottom - s.top).join("/"),
		);
		check("弹性格子撑满整列（三段的边界首尾相接）", Math.abs(g.slots.at(-1).bottom - (g.dock.bottom - 6)) <= 2);
		check("流内模式没有折叠按钮", g.collapseButtons === 0 && g.toggleButtons === 0);
		check("页面无 JS 报错", errors.length === 0, errors.join(" | "));
		await page.close();
	}
	killServer();
	await sleep(400);

	// ── 悬浮模式 ────────────────────────────────────────────────────
	console.log("\n§2 悬浮：折叠按钮只在这里出现，空白处不吃点击");
	seedPrefs(true);
	await startServer();
	{
		const { page, errors } = await openPage();
		const g = await page.evaluate(geoScript);
		check("切到悬浮浮层（.side-dock-float）", /\bside-dock-float\b/.test(g.dockCls), g.dockCls);
		check(
			"浮层有高度但不满屏（靠上/靠下才看得出来）",
			g.dock.bottom - g.dock.top > 200 && g.dock.bottom - g.dock.top < 900,
		);
		check(
			"弹性格子（空白区）不吃点击，药丸自己吃",
			g.slots.every((s) => s.pe === "none") && g.segs.every((s) => s.pe === "auto"),
		);
		check("悬浮模式有折叠按钮", g.collapseButtons === 2, `count=${g.collapseButtons}`);

		const collapse = page.locator(".side-dock-left .side-dock-collapse-btn");
		const box = await collapse.boundingBox();
		await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
		await sleep(600);
		const collapsed = await page.evaluate(() => {
			const btn = document.querySelector(".side-dock-left .side-dock-toggle-btn");
			if (!btn) return null;
			const r = btn.getBoundingClientRect();
			const dock = document.querySelector(".side-dock-left").getBoundingClientRect();
			return {
				w: Math.round(r.width),
				h: Math.round(r.height),
				dockH: Math.round(dock.height),
				segs: document.querySelectorAll(".side-dock-left .side-dock-seg").length,
			};
		});
		check("收起后只剩一个展开按钮", collapsed !== null && collapsed.segs === 0, JSON.stringify(collapsed));
		check(
			"展开按钮是小的（22×22），收起态不再占一整条",
			collapsed?.w === 22 && collapsed?.h === 22 && collapsed.dockH <= 40,
			JSON.stringify(collapsed),
		);

		const toggle = page.locator(".side-dock-left .side-dock-toggle-btn");
		const tbox = await toggle.boundingBox();
		await page.mouse.click(tbox.x + tbox.width / 2, tbox.y + tbox.height / 2);
		let segsBack = 0;
		for (let i = 0; i < 20; i++) {
			segsBack = await page.locator(".side-dock-left .side-dock-seg").count();
			if (segsBack === 3) break;
			await sleep(200);
		}
		check("点展开按钮回到三颗药丸", segsBack === 3, `segs=${segsBack}`);
		check("页面无 JS 报错", errors.length === 0, errors.join(" | "));
		await page.close();
	}
	killServer();

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
	killServer();
	freePort(PORT);
	rmSync(base, { recursive: true, force: true });
	await sleep(300);
	process.exit(process.exitCode ?? 0);
}
