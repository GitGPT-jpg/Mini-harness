/* 浏览器 E2E（issue #146 完整版）：**「界面布局」页说的话，界面上真的兑现**。
 *
 * 这是 slot 框架的核心不变量：设置面板里看到的条目、勾选框、↑↓，与界面上真正渲染的东西
 * 必须一致 —— 两边跑的是同一个 `buildUiSlots()`。历史上最容易破的就是**宿主内置条目**：
 * 它们曾写死在组件 JSX 里，布局页给出勾选框却点了没反应（假承诺）。本测试专门盯这一点：
 *
 *   1. 插件 `ui.arrange` 隐藏宿主内置条目 → **界面真的少一个**（底栏「成本」）
 *   2. 插件贡献的底栏条目与宿主条目**同排**（宿主渲染，插件只声明）
 *   3. 插件贡献的右栏 tab 排在宿主「文件」tab 之后（同一份顺序）
 *   4. 布局页取消勾选宿主条目 → 界面消失；勾回来 → 回来
 *   5. 布局页 ↑ 调序 → 界面上真的换位置
 *   6. 藏起消息工具条全部条目（编辑重问＋整条复制三件套）后工具条整条不画
 *      （没有可渲染条目 ⇒ 不留空壳）
 *   7. 页面无 JS 报错
 *
 * 缺 Chrome 自动 SKIP。运行：npm run build && node tests/ui-layout-ui-test.mjs
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
const base = mkdtempSync(join(tmpdir(), "pi-uilayout-"));
const WORK = join(base, "work");
const DATA_DIR = join(base, "data");
const AGENT_DIR = join(base, "agent");
const PORT = 20000 + Math.floor(Math.random() * 8000);
mkdirSync(WORK, { recursive: true });
/** 工作区里的子目录：cwd 选择器「＋ 工作区根」要浏览到非主根目录才可用。 */
const SUB_DIR = "sub";
mkdirSync(join(WORK, SUB_DIR), { recursive: true });

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

// 假插件：一个底栏条目 + 一个右栏 tab + 一条 arrange（把宿主「成本」藏了）。
// 三个都在同一份 buildUiSlots 结果里，一次跑通「插件贡献」「宿主渲染」「插件整理宿主」。
const plugDir = join(DATA_DIR, "plugins", "layouttest");
mkdirSync(join(plugDir, "client"), { recursive: true });
writeFileSync(
	join(plugDir, "manifest.json"),
	JSON.stringify({
		name: "Layout Test",
		version: "0.0.1",
		view: true,
		permissions: ["ui"],
		ui: {
			bottombar: [
				{
					id: "b1",
					label: "B-ONE",
					labelEn: "B-ONE",
					hint: "底栏条目的悬浮提示",
					hintEn: "bottombar tooltip",
					kind: "action",
					action: "layouttest:b1",
				},
			],
			rightpanel: [{ id: "rp", label: "RP-TAB", labelEn: "RP-TAB", hint: "右栏 tab 的悬浮提示", kind: "view" }],
			// 第二条指向一个不存在的目标：用来验证 P0-1 的「布局诊断」（不再静默忽略）。
			arrange: [
				{ id: "host:cost", hide: true },
				{ id: "host:does-not-exist", hide: true },
			],
		},
	}),
);
writeFileSync(
	join(plugDir, "client", "entry.mjs"),
	`export default { mount(container) { container.textContent = "layouttest"; } };`,
);

/** 种一个历史会话：零 token 让消息列表里真的有消息（消息 hover 工具条才有得测）。 */
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
			JSON.stringify({
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: "2026-08-04T00:00:02.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "好的" }], timestamp: 1722700802000 },
			}),
		].join("\n") + "\n",
	);
	return file;
}
seedSession(WORK, "layout-seed", "布局不变量回归用的对话");

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

async function tap(page, locator) {
	await locator.waitFor({ state: "visible", timeout: 15000 });
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	if (!box) throw new Error("tap: 元素没有 bounding box");
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function until(fn, tries = 60, gapMs = 200) {
	for (let i = 0; i < tries; i++) {
		if (await fn()) return true;
		await sleep(gapMs);
	}
	return false;
}

/** 等页面安静（服务端刚 build 过时页面会自愈重载一次，见 PR #144）。 */
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

/** 打开设置面板并切到「界面布局」所在的「界面插件」页。 */
async function openLayoutPage(page) {
	// 顶栏直流内**一律不用原生 title**（title 会和 data-tip 的即时气泡叠成双提示，见
	// TopBar.tsx 的注释），所以按 data-tip 找；title 保留作旧构建的回落。
	const btn = page
		.locator(
			'button.chip[data-tip*="设置"], button.chip[data-tip*="Settings"], button[title*="设置"], button[title*="Settings"]',
		)
		.first();
	for (let attempt = 0; attempt < 6; attempt++) {
		if ((await page.locator(".settings-modal").count()) === 0) {
			await tap(page, btn).catch(() => {});
		}
		if (await until(async () => (await page.locator(".settings-modal").count()) > 0, 8, 250)) break;
		await page.waitForSelector(".chat-input, .inputbar, textarea", { timeout: 30000 }).catch(() => {});
	}
	await tap(page, page.locator(".settings-tab", { hasText: /界面布局|UI layout/ }).first());
	return until(async () => (await page.locator(".set-ui-slot").count()) > 0, 30, 250);
}

/** 关掉设置面板。 */
async function closeLayoutPage(page) {
	await tap(page, page.locator(".settings-modal .modal-close").first());
	return until(async () => (await page.locator(".settings-modal").count()) === 0, 20, 200);
}

/** 某个槽位分区里、文案匹配的那一行。 */
function layoutRow(page, slotText, rowText) {
	return page.locator(".set-ui-slot", { hasText: slotText }).first().locator(".set-row", { hasText: rowText }).first();
}

/** 底栏文本（整条）。 */
const footerText = (page) => page.locator(".statusbar").first().textContent();

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
			// 只挂额外会话根：不污染真用户的 ~/.pi，也不会触发「首次配置」向导（那层
			// modal-backdrop 会盖住整页）。
			PI_CODING_AGENT_SESSION_DIR: join(AGENT_DIR, "sessions"),
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	server.stdout.on("data", (d) => process.stdout.write(`[srv] ${d}`));
	server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));

	await waitServer();
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});

	await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(".chat-input, .inputbar, textarea", { timeout: 30000 });
	await settle(page);

	// ---- 1. 插件 arrange 藏掉宿主内置条目：底栏真的少一个 -------------------
	const footer = await footerText(page);
	check("底栏渲染出来了", !!footer);
	check("插件 arrange 隐藏 host:cost → 底栏不再显示成本", !/\$\d|\$0/.test(footer ?? ""), (footer ?? "").slice(0, 160));
	// 上下文/消息数等宿主条目仍在（隐藏只影响被点名的那一条）
	// 按条目 id 断言，不看文案：底栏徐标显示的是实时数值（「上下文」这个名字只在悬浮提示里）。
	check(
		"同槽位其它宿主条目不受影响（上下文用量还在）",
		(await page.locator(".statusbar .bar-item-ctx").count()) === 1 &&
			/\d/.test((await page.locator(".statusbar .bar-item-ctx").first().textContent()) ?? ""),
	);

	// ---- 2. 插件贡献的底栏条目与宿主条目同排 -------------------------------
	check("插件贡献的底栏条目渲染在宿主底栏里", (footer ?? "").includes("B-ONE"), (footer ?? "").slice(0, 200));
	check(
		"插件的 hint 落成底栏条目的 title（悬浮提示不会静默丢掉）",
		(await page.locator(".statusbar .status-action", { hasText: "B-ONE" }).first().getAttribute("title")) ===
			"底栏条目的悬浮提示",
	);

	// ---- 3. 插件贡献的右栏 tab 排在宿主「文件」tab 之后 --------------------
	const tabs = page.locator(".panel-right .slot-tabs-bar [role=tab]");
	check("右栏是 slot tab 容器", await until(async () => (await tabs.count()) > 0, 40, 250));
	const tabLabels = (await tabs.allTextContents()).map((s) => s.trim());
	check(
		"右栏 tab 顺序 = 布局顺序（宿主「文件」在前、插件 tab 在后）",
		tabLabels.length === 2 && /文件|Files/.test(tabLabels[0]) && tabLabels[1] === "RP-TAB",
		tabLabels.join(" | "),
	);
	check("插件的 hint 落成右栏 tab 的 title", (await tabs.nth(1).getAttribute("title")) === "右栏 tab 的悬浮提示");
	// 插件 tab 点得开、内容归插件
	await tap(page, tabs.nth(1));
	check(
		"插件 tab 的内容由插件渲染（PluginPage 挂载）",
		await until(
			async () => ((await page.locator(".plugin-page-host").first().textContent()) ?? "").includes("layouttest"),
			40,
			250,
		),
	);

	// ---- 4. 布局页取消勾选宿主条目 → 界面消失；勾回来 → 回来 ---------------
	check("界面布局页可打开", await openLayoutPage(page));
	// P0-1：插件把 arrange 指向不存在的条目 → 布局页顶部出现「布局诊断」横幅，
	// 说清是哪个插件的哪个目标没生效（不再静默丢弃）。
	const diag = page.locator(".set-ui-diag").first();
	check("布局诊断横幅出现（arrange 目标不存在不再静默）", (await diag.count()) > 0);
	if ((await diag.count()) > 0) {
		const diagText = (await diag.textContent()) ?? "";
		check(
			"诊断里点名了插件与目标 id",
			diagText.includes("layouttest") && diagText.includes("host:does-not-exist"),
			diagText.trim().slice(0, 120),
		);
	}
	const cwdRow = layoutRow(page, /底栏|Bottom bar/, /工作目录|Working directory/);
	check("布局页列出了底栏的「工作目录」条目", await until(async () => (await cwdRow.count()) > 0, 30, 250));
	check("初始状态底栏有工作目录按钮", (await page.locator(".statusbar .status-cwd").count()) === 1);
	await tap(page, cwdRow.locator('input[type="checkbox"]').first());
	check(
		"取消勾选后底栏的工作目录消失（宿主条目也听用户偏好）",
		await until(async () => (await page.locator(".statusbar .status-cwd").count()) === 0, 30, 250),
	);
	await tap(page, cwdRow.locator('input[type="checkbox"]').first());
	check(
		"勾回来后它又出现",
		await until(async () => (await page.locator(".statusbar .status-cwd").count()) === 1, 30, 250),
	);

	// ---- 5. 布局页 ↑ 调序 → 界面真的换位置 --------------------------------
	/** 底栏里「消息数」与「上下文」两个条目的先后（DOM 顺序）。按条目 id 定位 —— 底栏徐标
	 *  显示的是实时数值，文字里根本没有「上下文/消息」这两个词，靠文案找只会得到 -1。 */
	const orderOf = async () =>
		await page.evaluate(() => {
			const bar = document.querySelector(".statusbar");
			if (!bar) return "";
			const ids = Array.from(bar.querySelectorAll("[data-bar-item]")).map((n) => n.getAttribute("data-bar-item") ?? "");
			return `${ids.indexOf("host:ctx")}:${ids.indexOf("host:msg-count")}`;
		});
	const before = await orderOf();
	const msgRow = layoutRow(page, /底栏|Bottom bar/, /消息|Messages/);
	const upBtn = msgRow.locator("button", { hasText: "↑" }).first();
	await tap(page, upBtn);
	// 多按几次把「消息」挪到「上下文」前面（默认顺序是 上下文→消息）
	let moved = false;
	for (let i = 0; i < 3 && !moved; i++) {
		const now = await orderOf();
		const [ctxIdx, msgIdx] = now.split(":").map(Number);
		if (ctxIdx >= 0 && msgIdx >= 0 && msgIdx < ctxIdx) {
			moved = true;
			break;
		}
		await tap(page, upBtn);
	}
	const after = await orderOf();
	const [ctxA, msgA] = after.split(":").map(Number);
	check("布局页 ↑ 调序后界面真的换位置", ctxA >= 0 && msgA >= 0 && msgA < ctxA, `${before} → ${after}`);

	// ---- 5b. 顶栏：调序真的换位置 + 隐藏的菜单型条目落到溢出菜单里且能用 -------
	// 注意动作纪律：**设置面板开着时不要点顶栏**（modal-backdrop 盖住整页，鼠标事件全落到它身上，
	// 不是按钮坏了）。每次改完布局先关面板、断言界面、再开面板改下一处。
	/** 桌面工具组里两个 chip 的先后（DOM 顺序，按可见文案定位）。 */
	const desktopOrder = async (a, b) =>
		await page.evaluate(
			([ta, tb]) => {
				const nodes = Array.from(document.querySelectorAll(".topbar-flow .chip"));
				const idx = (t) => nodes.findIndex((n) => (n.textContent ?? "").includes(t));
				return `${idx(ta)}:${idx(tb)}`;
			},
			[a, b],
		);
	/** `a:b` 下标串里 a 真的在 b 前面（两个都找得到才算）。 */
	const isBefore = (pair) => {
		const [a, b] = pair.split(":").map(Number);
		return a >= 0 && b >= 0 && a < b;
	};
	const themeRow = layoutRow(page, /顶栏|Top bar/, /主题|Theme/);
	check("布局页列出了顶栏的「主题」条目", await until(async () => (await themeRow.count()) > 0, 30, 250));
	const soundRow = layoutRow(page, /顶栏|Top bar/, /声音|Sound/);
	check("布局页列出了顶栏的「声音」条目", await until(async () => (await soundRow.count()) > 0, 30, 250));
	// 声音/语言/主题/更新/GitHub/浏览器这六个内置条目在 BUILTIN_UI_ITEMS 里就是 `hidden: true`
	// （#146 的刻意设计：低频，且菜单里是完整面板）——默认落在「⋯」溢出菜单里，
	// 所以布局页里它们的勾选框**本来就是未勾的**。本段要验「调序 / 隐藏 / 溢出菜单里仍可用」，
	// 所以先把这两个**显示出来**再测（不然「取消勾选」实际是把它从隐藏变显示）。
	for (const row of [themeRow, soundRow]) {
		const box = row.locator('input[type="checkbox"]').first();
		if (!(await box.isChecked())) await tap(page, box);
	}
	check(
		"勾上后「主题」「声音」出现在主栏（这两个默认是隐藏的）",
		await until(async () => (await page.locator(".topbar-flow .chip", { hasText: /主题|Theme/ }).count()) > 0, 30, 250),
	);
	// 默认顺序：…声音(70) → 主题(82)。按 ↑ 把主题挪到声音前面 —— 每按一次就看一眼界面上的
	// 真实顺序（快照回合会让行重挂，偶尔会吞掉一次点击），必要时重按，最多 3 次。
	let orderAfter = await desktopOrder("主题", "声音");
	for (let i = 0; i < 3 && !isBefore(orderAfter); i++) {
		await tap(page, themeRow.locator("button", { hasText: "↑" }).first());
		orderAfter = await desktopOrder("主题", "声音");
	}
	check("关掉设置面板", await closeLayoutPage(page));
	const orderAfterClose = await desktopOrder("主题", "声音");
	check("顶栏 ↑ 调序后界面真的换位置（主题排到声音前面）", isBefore(orderAfterClose), orderAfterClose);

	// 隐藏「声音」：chip 从桌面组消失 → 它整块搬到「⋯」溢出菜单里，点了要能开面板
	check("再打开布局页", await openLayoutPage(page));
	check("布局页仍列出「声音」", await until(async () => (await soundRow.count()) > 0, 30, 250));
	await tap(page, soundRow.locator('input[type="checkbox"]').first());
	check("关掉设置面板（才能点顶栏）", await closeLayoutPage(page));
	check(
		"隐藏后顶栏的声音 chip 消失",
		await until(
			async () => (await page.locator(".topbar-flow .chip", { hasText: /声音|Sound/ }).count()) === 0,
			30,
			250,
		),
	);
	const moreBtn = page.locator(".plugin-topbar-more > button").first();
	check("顶栏「⋯」按钮出现（有隐藏条目）", (await moreBtn.count()) > 0);
	await tap(page, moreBtn);
	const soundInMenu = await until(
		async () => (await page.locator(".plugin-topbar-menu .chip", { hasText: /声音|Sound/ }).count()) > 0,
		20,
		200,
	);
	check("隐藏的声音整块出现在「⋯」溢出菜单里（不是死按钮）", soundInMenu);
	// issue #162 回归：菜单必须真的可见可点（portal 之前它在 DOM 里但被祖先 overflow 裁掉）。
	const menuHit = await page.evaluate(() => {
		const menu = document.querySelector(".plugin-topbar-menu");
		if (!menu) return "no-menu";
		const r = menu.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) return "zero-size";
		if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth)
			return "outside-viewport";
		const el = document.elementFromPoint(r.x + Math.min(r.width - 5, 12), r.y + Math.min(r.height - 5, 12));
		return menu.contains(el) ? "ok" : `clipped-by:${el ? (el.className ?? el.tagName) : "null"}`;
	});
	check("溢出菜单真的可见可点（不被祖先 overflow 裁剪）", menuHit === "ok", String(menuHit));
	if (soundInMenu) {
		await tap(page, page.locator(".plugin-topbar-menu .chip", { hasText: /声音|Sound/ }).first());
		check(
			"点它真能展开声音设置面板（搬过去也还能用）",
			await until(async () => (await page.locator(".plugin-topbar-menu .dd-menu").count()) > 0, 20, 200),
		);
		await page.keyboard.press("Escape");
		// issue #162：溢出菜单是 portal + 点外面/Esc 关闭。但 Esc 走的是快捷键栈：
		// 「分层关闭」——先收掉最内层的声音面板，再按一次才轮到溢出菜单（不一锅端外层）。
		check(
			"Esc 先收起内层声音面板",
			await until(async () => (await page.locator(".plugin-topbar-menu .dd-menu").count()) === 0, 20, 200),
		);
		check("分层关闭：溢出菜单此时仍开着", (await page.locator(".plugin-topbar-menu").count()) === 1);
		await page.keyboard.press("Escape");
		check(
			"再按一次 Esc 收起溢出菜单",
			await until(async () => (await page.locator(".plugin-topbar-menu").count()) === 0, 20, 200),
		);
	}
	// 放回去（把布局改回默认，别影响后面的断言）。若菜单还开着，再点一次 ⋯ 收起。
	if ((await page.locator(".plugin-topbar-menu").count()) > 0) await moreBtn.evaluate((el) => el.click());
	check("再打开布局页（恢复声音）", await openLayoutPage(page));
	await tap(page, soundRow.locator('input[type="checkbox"]').first());
	check("关掉设置面板", await closeLayoutPage(page));
	check(
		"勾回去后声音 chip 回到顶栏",
		await until(async () => (await page.locator(".topbar-flow .chip", { hasText: /声音|Sound/ }).count()) > 0, 30, 250),
	);

	// ---- 5c. 底栏 cwd 选择器也能把目录加成工作区根（第二条入口） -------------
	// 根选择器长在「文件」tab 里（SlotTabs 只挂当前选中项）：先把右栏切回文件 tab，
	// 否则它在插件 tab 下根本没挂载，断言会假红。
	const filesTab = page.locator(".panel-right .slot-tabs-bar [role=tab]").first();
	if ((await filesTab.count()) > 0) await tap(page, filesTab);
	// 工作区里先种一个子目录：cwd 选择器只能「浏览到非主工作区目录」之后才允许加根。
	await tap(page, page.locator(".statusbar .status-cwd").first());
	check("底栏 cwd 选择器打开", await until(async () => (await page.locator(".cwd-picker").count()) > 0, 20, 250));
	const enterBtn = page.locator(".cwd-picker .cwd-item", { hasText: SUB_DIR }).locator(".cwd-enter").first();
	const entered = await until(async () => (await enterBtn.count()) > 0, 20, 200);
	check(`选择器里能浏览到子目录（${SUB_DIR}）`, entered);
	const addRootBtn = page
		.locator(".cwd-picker .cwd-picker-head button", { hasText: /工作区根|workspace root/i })
		.first();
	if (entered) {
		check("浏览到主工作区时「＋ 工作区根」是禁用的（它就是主根）", !(await addRootBtn.isEnabled()));
		await tap(page, enterBtn);
		check("浏览到子目录后「＋ 工作区根」可用", await addRootBtn.isEnabled());
		await tap(page, addRootBtn);
		check(
			"点它后右栏出现根选择器（真的写进了 set_workspace_roots）",
			await until(async () => (await page.locator(".root-picker-trigger").count()) > 0, 40, 250),
		);
	}
	// 关掉选择器：它有全屏 backdrop，不关掉后面点左栏会全落到 backdrop 上。
	await tap(page, page.locator(".status-cwd-backdrop").first()).catch(() => {});
	await until(async () => (await page.locator(".cwd-picker").count()) === 0, 20, 200);
	check("cwd 选择器已关闭", (await page.locator(".cwd-picker").count()) === 0);
	// 收尾：把刚加的根移除，别影响后面的断言
	if ((await page.locator(".root-picker-trigger").count()) > 0) {
		await tap(page, page.locator(".root-picker-trigger").first());
		await tap(page, page.locator(".root-picker-menu .root-picker-remove").first());
		check(
			"移除后根选择器消失",
			await until(async () => (await page.locator(".root-picker-trigger").count()) === 0, 30, 250),
		);
	}

	// ---- 5d. 布局页改名 → 界面真的换文案（issue #555） ----------------------
	// 内置条目（顶栏按钮 / 底栏数值徐标）的文案一直是写死的 i18n 与实际数值：布局页给出
	// 改名框却改了没反应 = 假承诺。改名规则：名字型条目用用户文案顶掉内置文案；数值型
	// （上下文/成本/缓存/消息数…）名字插在数值前面（改名只换名字，不吞掉实时数据）。
	check("打开布局页（改名）", await openLayoutPage(page));
	const bottomRows = () =>
		page
			.locator(".set-ui-slot", { hasText: /底栏|Bottom bar/ })
			.first()
			.locator(".set-row");
	const topRows = () =>
		page
			.locator(".set-ui-slot", { hasText: /顶栏|Top bar/ })
			.first()
			.locator(".set-row");
	/** 先把行下标取好：行文案被改掉后就按文案找不到它了。 */
	const rowIndexOf = async (rows, re) => {
		const n = await rows().count();
		for (let i = 0; i < n; i++) {
			if (re.test((await rows().nth(i).textContent()) ?? "")) return i;
		}
		return -1;
	};
	const ctxIdx = await rowIndexOf(bottomRows, /上下文|Context/);
	const termIdx = await rowIndexOf(topRows, /^.*终端|Terminal/);
	check("布局页列出了底栏「上下文」与顶栏「终端」", ctxIdx >= 0 && termIdx >= 0, `ctx=${ctxIdx} term=${termIdx}`);
	const ctxFoot = page.locator(".statusbar .bar-item-ctx").first();
	check("改名前底栏上下文只有数值、没有名字", !((await ctxFoot.textContent()) ?? "").includes("CTX"));
	const rename = async (row, value) => {
		const input = row.locator("input.set-ui-label").first();
		await input.click();
		await input.fill(value);
		await input.press("Enter");
	};
	await rename(bottomRows().nth(ctxIdx), "MY-CTX");
	await rename(topRows().nth(termIdx), "MY-TERM");
	check("关掉设置面板（改名提交）", await closeLayoutPage(page));
	const ctxAfter = (await ctxFoot.textContent()) ?? "";
	check(
		"底栏改了名真的换文案（名字挂在数值前面）",
		await until(async () => ((await ctxFoot.textContent()) ?? "").includes("MY-CTX"), 30, 250),
		ctxAfter.slice(0, 60),
	);
	check(
		"改名不吞掉实时数值（名字后面还是 tokens 用量）",
		/\d/.test(ctxAfter) && /[/]/.test(ctxAfter),
		ctxAfter.slice(0, 60),
	);
	const termBtn = page.locator('[data-bar-item="host:terminal"]').first();
	check(
		"顶栏改了名真的换文案",
		await until(async () => ((await termBtn.textContent()) ?? "").includes("MY-TERM"), 30, 250),
	);
	check("改名后内置文案不再出现（不是叠着画）", !((await termBtn.textContent()) ?? "").includes("终端"));
	check("再打开布局页（验证改名留存）", await openLayoutPage(page));
	check(
		"改名后的文案真的存下来了（重开面板 = 原值，不是空框）",
		(await bottomRows().nth(ctxIdx).locator("input.set-ui-label").first().inputValue()) === "MY-CTX" &&
			(await topRows().nth(termIdx).locator("input.set-ui-label").first().inputValue()) === "MY-TERM",
	);
	// 清空 = 回到内置文案（改名框的语义：空串就是没意见），顺带验证名字不是一个单向开关。
	await rename(bottomRows().nth(ctxIdx), "");
	await rename(topRows().nth(termIdx), "");
	check("关掉设置面板（清空改名）", await closeLayoutPage(page));
	check(
		"清空后底栏回到内置数值（不带名字）",
		await until(async () => !((await ctxFoot.textContent()) ?? "").includes("MY-CTX"), 30, 250),
	);
	check(
		"清空后顶栏回到内置文案",
		await until(async () => !((await termBtn.textContent()) ?? "").includes("MY-TERM"), 30, 250),
	);

	// ---- 6. 藏起消息工具条全部条目后工具条整条不画 ------------------
	// 打开种进去的历史会话（零 token）
	const historyRow = page.locator(".panel-left .panel-sessions .session-item").first();
	check("左栏有历史会话可打开", await until(async () => (await historyRow.count()) > 0, 40, 250));
	await tap(page, historyRow);
	const msgRowEl = page.locator(".msg").first();
	check("消息列表渲染出来了", await until(async () => (await msgRowEl.count()) > 0, 50, 250));
	const actionsBefore = await page.locator(".msg-actions").count();
	check("hover 工具条默认存在（编辑重问是内置条目）", actionsBefore > 0, `${actionsBefore} 条`);

	check("再打开布局页", await openLayoutPage(page));
	const msgSlot = page.locator(".set-ui-slot", { hasText: /消息工具条|Message actions/ }).first();
	check("布局页列出了消息工具条分区", await until(async () => (await msgSlot.count()) > 0, 30, 250));
	// 分区条目 = 内置那批（重问 / 编辑重问 / 会话分叉 / 回滚 / 复制四件套 / 朗读）——
	// 数量随 catalog 增长（插件也能往这个槽位加），所以只锁「有内置条目列出」；
	// 真正的行为断言在下面：逐个取消勾选后整条工具条不再绘制。
	const msgBoxes = msgSlot.locator('.set-row input[type="checkbox"]');
	const msgBoxCount = await msgBoxes.count();
	check("消息工具条列出了可隐藏条目（≥5 条内置）", msgBoxCount >= 5, `${msgBoxCount} 个`);
	check(
		"分区里能勾到「编辑重问」",
		(await msgSlot.locator(".set-row", { hasText: /编辑重问|Edit & re-ask/ }).count()) > 0,
	);
	for (let k = 0; k < msgBoxCount; k++) {
		const box = msgBoxes.nth(k);
		if (await box.isChecked()) await tap(page, box);
	}
	check(
		"全部隐藏后消息工具条整条不画（没有可渲染条目不留空壳）",
		await until(async () => (await page.locator(".msg-actions").count()) === 0, 40, 250),
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
