/* 浏览器 E2E：notes 插件的浮窗/提醒链路（真 Chrome + 真服务端，零 token）。
 *
 * 覆盖（这是客户端 bundle 唯一的真浏览器验证；单测只覆盖纯逻辑与假宿主）：
 *   - 顶栏图钉按钮 → 可拖拽浮窗出现；拖动改位置、刷新后位置与开合状态保留
 *     （后者靠 manifest `preload:true`：view:false 的插件默认不预加载 bundle）
 *   - 快速捕获：待办（含「明天 18:00 #工作」解析）、提醒（「每天 9:00 」解析）、笔记（落库）
 *   - 最小化成小贴片、展开回来；没有独立视图（无 ⤢、无 .plugin-view）
 *   - 月视图日历在**浮窗**里：42 格、重复提醒天天画、翻月、正文区裁剪不撑破面板
 *   - 提醒到点：服务端触发 → 长轮询把浏览器叫醒 → 客户端确认（fireCount=1、单次提醒自停、
 *     待送达队列被清空）—— 也就是说「服务端到点 → 浏览器弹提示」这条链路真的通
 *   - 设置是覆盖层：盖住正文与底栏、不压缩正文、「语言」标签不被挤成竖排、✕ 能关
 *   - 浮窗里改条目写回库（待办编辑器切换重复档）
 *   - 插件热重载（plugins_reload）后旧实例被拆干净：页面里只剩一个浮窗（不会多出一条长轮询），
 *     且顶栏按钮仍能开合浮窗（动作处理器已重注册）
 *   - 页面无 JS 报错
 *
 * 缺 Chrome 自动 SKIP（与其它浏览器 E2E 同约定，不入 run-smoke）。运行：
 *   npm run build && node tests/notes-ui-test.mjs
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { CHROME_PATH } from "./lib/chrome.mjs";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-notes-ui-"));
const WORK = join(base, "work");
const DATA_DIR = join(base, "data");
const PORT = 24000 + Math.floor(Math.random() * 3000);
const BASE = `http://localhost:${PORT}`;
mkdirSync(WORK, { recursive: true });
mkdirSync(join(DATA_DIR, "plugins"), { recursive: true });
cpSync(join(REPO, "plugins", "notes"), join(DATA_DIR, "plugins", "notes"), { recursive: true });

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

let server = null;
let browser = null;

async function waitServer() {
	for (let i = 0; i < 120; i++) {
		try {
			if ((await fetch(`${BASE}/api/health`)).ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error("server did not start");
}

async function store() {
	const r = await fetch(`${BASE}/plugins-api/notes/store`);
	return (await r.json()).store;
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
	server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
	await waitServer();

	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});

	await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
	// 顶栏插件条目（📌 笔记）
	const topbarBtn = page.locator(".plugin-topbar-item", { hasText: "笔记" }).first();
	await topbarBtn.waitFor({ timeout: 20000 });
	check("顶栏出现笔记按钮", await topbarBtn.isVisible());
	// 关掉顶栏文字后只剩图标 —— 图标必须在、且是内联 SVG（不能是空 span，否则用户只看到一个点）
	const iconInfo = await topbarBtn.evaluate((el) => {
		const svg = el.querySelector("svg");
		const r = svg?.getBoundingClientRect();
		const ds = [...(svg?.querySelectorAll("path") ?? [])].map((p) => p.getAttribute("d") ?? "");
		return {
			hasSvg: !!svg,
			w: r ? Math.round(r.width) : 0,
			h: r ? Math.round(r.height) : 0,
			// 精装记事簿：书脊 + 3 条横线（不是图钉，也不是日历打勾）
			isBook: ds.some((d) => d.startsWith("M4 19.5v-15")),
		};
	});
	check("按钮内联 SVG 图标（14px 级仍然可辨）", iconInfo.hasSvg && iconInfo.w >= 10 && iconInfo.h >= 10);
	check("图标是「精装记事簿」那版（与浮窗头部同一枚）", iconInfo.isBook);

	// -- 开浮窗 -------------------------------------------------------------------
	await topbarBtn.click();
	await page.waitForSelector(".nt-panel", { timeout: 10000 });
	check("点击后浮窗出现且置顶可拖拽", await page.locator(".nt-panel").isVisible());
	check(
		"浮窗带拖拽把手与缩放柄",
		(await page.locator(".nt-panel-head").count()) === 1 && (await page.locator(".nt-grip").count()) === 1,
	);

	// -- 只有两个 Tab：笔记与日历 ---------------------------------------------------
	const tabs = await page.locator(".nt-panel .nt-tab").allInnerTexts();
	check(
		"Tab 栏只保留「笔记」和「日历」两个选项卡",
		tabs.length === 2 && tabs.includes("笔记") && tabs.includes("日历"),
	);

	// -- 快速捕获笔记：直接记录文字、无标题、自动提取标签 ----------------------------
	const composer = page.locator(".nt-panel .nt-composer-text").first();
	await composer.fill("交周报 #工作\n这是一段详细记录。");
	await composer.press("Control+Enter");
	await page.waitForSelector('.nt-panel .nt-card:has-text("交周报")', { timeout: 8000 });
	const noteCard = page.locator(".nt-panel .nt-card").first();
	const noteCardText = await noteCard.innerText();
	check("无标题速记：直接写文字 Ctrl+Enter 落入列表", noteCardText.includes("交周报"));
	check("#工作 被解析成标签", noteCardText.includes("#工作"));

	// -- 笔记额外设置提醒：选择提醒档位并保存 -----------------------------------------
	await composer.fill("明天交方案");
	await page.locator('.nt-panel .nt-composer-tools button:has-text("设提醒")').first().click();
	await page.waitForSelector(".nt-pop-menu", { timeout: 5000 });
	await page.locator('.nt-pop-menu .nt-pop-item:has-text("明天 09:00")').first().click();
	await sleep(200);
	check("选择时间后输入框下方出现提醒药丸胶囊", (await page.locator(".nt-panel .nt-rem-chip").count()) >= 1);
	await composer.press("Control+Enter");
	await page.waitForSelector('.nt-panel .nt-card:has-text("明天交方案")', { timeout: 8000 });
	const remCard = page.locator('.nt-panel .nt-card:has-text("明天交方案")').first();
	check("保存后笔记卡片展示提醒状态胶囊", (await remCard.locator(".nt-rem-chip").count()) >= 1);

	// -- 就地快速编辑（Inline Edit）：点击 ✏️ 原位修改正文与提醒 --------------------
	await remCard.locator('button[title*="编辑"]').first().click();
	await page.waitForSelector(".nt-panel .nt-card-edit-area", { timeout: 5000 });
	check(
		"点击 ✏️ 卡片原位变成就地编辑区（无需跳出或换栏）",
		(await page.locator(".nt-panel .nt-card.nt-editing").count()) === 1,
	);
	const editArea = page.locator(".nt-panel .nt-card-edit-area").first();
	await editArea.fill("明天交方案（已更新补充材料）\n- [ ] 打印签字");
	await editArea.press("Control+Enter");
	await sleep(600);
	check("就地编辑 Ctrl+Enter 保存后恢复卡片展示", (await page.locator(".nt-panel .nt-card.nt-editing").count()) === 0);
	let s = await store();
	check(
		"就地编辑正文落库",
		s.notes.some((n) => n.body.includes("补充材料")),
	);

	// -- 删除：点击变为打勾按钮，再次点击确认删除 -----------------------------------
	const targetCard = page.locator('.nt-panel .nt-card:has-text("补充材料")').first();
	const delBtn = targetCard.locator("button.nt-del").first();
	await delBtn.click();
	await sleep(200);
	const checkText = await delBtn.innerText();
	const isConfirming =
		(await delBtn.evaluate((el) => el.classList.contains("nt-del-confirm"))) && checkText.includes("✓");
	check("点击删除按钮后变为打勾按钮（二次确认态）", isConfirming);
	await delBtn.click();
	await sleep(600);
	check(
		"再次点击打勾按钮后卡片被成功删除",
		(await page.locator('.nt-panel .nt-card:has-text("补充材料")').count()) === 0,
	);
	s = await store();
	check("删除笔记成功落库（库中不再存在）", !s.notes.some((n) => n.body.includes("补充材料")));

	// -- 提醒到点：服务端 → 长轮询 → 浏览器确认 ----------------------------------------
	const at = new Date(Date.now() + 6000);
	const pad = (n) => String(n).padStart(2, "0");
	const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
	await fetch(`${BASE}/plugins-api/notes/op`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ op: "reminder.save", item: { text: "喝水", schedule: { type: "once", at: stamp } } }),
	});
	let fired = null;
	for (let i = 0; i < 40; i++) {
		await sleep(1000);
		s = await store();
		fired = s.reminders.find((r) => r.text === "喝水");
		if (fired?.fireCount >= 1) break;
	}
	check("一次性提醒到点被触发（fireCount=1）", fired?.fireCount >= 1);
	check("一次性提醒触发后自动停用", fired?.enabled === false);
	check("浏览器收到并确认了提醒（待送达队列清空）", s.meta.pending.length === 0);

	// -- 浮窗里「点开编辑 → 切 tab」不能变成全空面板 ---------------------------------
	await page.locator('.nt-panel .nt-card:has-text("交周报") button[title*="编辑"]').first().click();
	await sleep(300);
	check("浮窗里点编辑进入就地编辑态", (await page.locator(".nt-panel .nt-card.nt-editing").count()) === 1);
	await page.locator(".nt-panel .nt-tab", { hasText: "日历" }).first().click();
	await sleep(300);
	await page.locator(".nt-panel .nt-tab", { hasText: "笔记" }).first().click();
	await sleep(300);
	const rowsAfterTabSwitch = await page.locator(".nt-panel .nt-card").count();
	const stillEditing = await page.locator(".nt-panel .nt-card.nt-editing").count();
	check("切 tab 后列表回来、编辑态退出（不出现全空面板）", rowsAfterTabSwitch > 0 && stillEditing === 0);

	// -- 勾一个通知开关不能重建面板（否则正在打的字会丢） ---------------------------------
	const noteQuick = page.locator(".nt-panel .nt-composer-text").first();
	await noteQuick.fill("切语言前的草稿");
	let langSelCount = 0;
	await page.locator(".nt-panel-head .nt-pill-hide").first().click(); // ⚙
	await sleep(300);
	langSelCount = await page.locator(".nt-panel .nt-settings select").count();
	await page.locator(".nt-panel .nt-settings .nt-checkline input").first().click(); // 站内通知条开关
	await sleep(300);
	check("浮窗设置能开（开关 + 语言下拉）", langSelCount > 0);
	check("切换偏好不会重建浮窗（输入框里的字还在）", (await noteQuick.inputValue()) === "切语言前的草稿");
	await page.locator(".nt-panel-head .nt-pill-hide").first().click(); // 收起设置

	// -- 最小化 ---------------------------------------------------------------
	await page.locator(".nt-panel-head button[title*='收起']").first().click();
	await sleep(200);
	check("最小化成小贴片（数量角标）", (await page.locator(".nt-panel.nt-pill").count()) === 1);
	check("小贴片显示待处理数量", /\d/.test(await page.locator(".nt-pill-count").first().innerText()));
	await page.locator(".nt-panel-head button[title*='展开']").first().click();
	await sleep(300);
	check("展开回浮窗（正文回来）", (await page.locator(".nt-panel.nt-pill").count()) === 0);

	// -- 没有独立视图 tab / 没有「打开完整视图」按钮（浮窗就是全部界面） ---------------
	check("浮窗头部只有 ⚙ ▾ ✕ 三个按钮（不再有 ⤢）", (await page.locator(".nt-panel-head button").count()) === 3);
	check("插件不再有独立视图（页面里没有 .plugin-view）", (await page.locator(".plugin-view").count()) === 0);

	// -- 月视图日历（重复提醒要画在当月每一天） --------------------------------------
	await fetch(`${BASE}/plugins-api/notes/op`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			op: "reminder.save",
			item: { text: "吃药", schedule: { type: "daily", time: "09:00" }, enabled: true },
		}),
	});
	await page.locator(".nt-panel .nt-tab", { hasText: "日历" }).first().click();
	await sleep(600);
	const cells = await page.locator(".nt-panel .nt-cal-cell").count();
	const chips = await page.locator(".nt-panel .nt-cal-chip").count();
	const calText = await page.locator(".nt-panel .nt-cal-detail").first().innerText();
	check("日历画出 6×7 = 42 天格子", cells === 42);
	check("重复提醒在当月多天都有条目（chip 数 > 5）", chips > 5);
	check("日历下方给出选中日的清单", /\d{4}-\d{2}-\d{2}/.test(calText));
	// 窄窗裁剪回归：曾经的 .nt-body{display:block} 让列表按内容撑高（实测 600px），
	// 日历会画到底栏、设置层上去；正文区必须自己收缩成可滚动的一块。
	const clip = await page.evaluate(() => {
		const list = document.querySelector(".nt-panel .nt-list");
		const foot = document.querySelector(".nt-panel .nt-foot");
		if (!list || !foot) return null;
		return {
			listBottom: list.getBoundingClientRect().bottom,
			footTop: foot.getBoundingClientRect().top,
			scrollable: list.scrollHeight > list.clientHeight,
		};
	});
	check("浮窗正文区被裁剪（列表底 ≤ 底栏顶）", !!clip && clip.listBottom <= clip.footTop + 1);
	check("内容超出时正文区自己滚（不是把面板撑破）", clip?.scrollable === true);
	// 点另一天 → 详情跟着换
	const dayIndex = await page.evaluate(() => {
		const all = [...document.querySelectorAll(".nt-panel .nt-cal-cell")];
		return all.findIndex((c) => !c.classList.contains("nt-today") && !c.classList.contains("nt-out"));
	});
	await page.locator(".nt-panel .nt-cal-cell").nth(dayIndex).click();
	await sleep(400);
	const selText = await page.locator(".nt-panel .nt-cal-detail").first().innerText();
	check("点别的日期会切到那一天的清单", selText !== calText);
	// 下个月按钮
	const titleBefore = await page.locator(".nt-panel .nt-cal-title").first().innerText();
	await page.locator('.nt-panel .nt-cal-head button[title*="下个月"]').first().click();
	await sleep(400);
	const titleAfter = await page.locator(".nt-panel .nt-cal-title").first().innerText();
	check("能翻到下个月", titleAfter !== titleBefore && (await page.locator(".nt-panel .nt-cal-cell").count()) === 42);

	// -- 设置：盖在正文之上的覆盖层（不再把正文挤成一条缝） ---------------------------
	await page.locator('.nt-panel-head button[title*="设置"]').first().click();
	await sleep(300);
	const settingsText = await page.locator(".nt-panel .nt-settings").first().innerText();
	check(
		"⚙ 打开设置（四个开关 + 语言 + 导入导出都在，且在窗口内可见）",
		["站内通知条", "桌面通知", "提示音", "语言"].every((x) => settingsText.includes(x)) &&
			settingsText.includes("导出") &&
			settingsText.includes("导入"),
	);
	const overlay = await page.evaluate(() => {
		const pop = document.querySelector(".nt-settings-pop");
		const list = document.querySelector(".nt-panel .nt-list");
		const foot = document.querySelector(".nt-panel .nt-foot");
		if (!pop || !foot) return null;
		const pr = pop.getBoundingClientRect();
		const fr = foot.getBoundingClientRect();
		return {
			on: pop.classList.contains("on"),
			coversFoot: pr.bottom >= fr.bottom - 1 && pr.top <= fr.top,
			listHeight: list ? list.getBoundingClientRect().height : 0,
		};
	});
	check("设置是覆盖层（盖住正文与底栏）", overlay?.on === true && overlay.coversFoot === true);
	check("开设置不压缩正文（列表高度没被挤成一条缝）", (overlay?.listHeight ?? 0) > 80);
	// 「语言」标签曾经被 .nt-select{width:100%} 挤成竖排两个字
	const langLabelH = await page.evaluate(() => {
		const span = [...document.querySelectorAll(".nt-settings .nt-checkline > span")].find((s) =>
			s.textContent.includes("语言"),
		);
		return span ? span.getBoundingClientRect().height : 0;
	});
	check("设置里「语言」标签不被压成两行", langLabelH > 0 && langLabelH < 24);
	await page.locator(".nt-settings-head button").first().click();
	await sleep(200);
	check("设置覆盖层的 ✕ 能关掉", (await page.locator(".nt-settings-pop.on").count()) === 0);

	// -- 浮窗里改一条：点击置顶写回库 ---------------------------------------------
	await page.locator('.nt-panel .nt-card:has-text("交周报") button[title*="置顶"]').first().click();
	await sleep(600);
	s = await store();
	check("笔记卡片点击置顶写回库（pinned=true）", s.notes.find((n) => n.body.includes("交周报"))?.pinned === true);

	// -- 插件热重载后旧实例必须收干净（否则会多出一个浮窗 + 第二条长轮询） -----------------
	const reloadSock = new WebSocket(`ws://localhost:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		reloadSock.on("open", () => resolve());
		reloadSock.on("error", reject);
	});
	reloadSock.send(JSON.stringify({ type: "plugins_reload" }));
	await sleep(4000);
	const panels = await page.locator(".nt-panel").count();
	check("热重载后只剩一个浮窗（旧实例已拆干净）", panels === 1);
	// 预加载（manifest preload）：热重载后新 bundle 的顶栏动作照旧能开合浮窗
	await page.locator(".plugin-topbar-item", { hasText: "笔记" }).first().click();
	await sleep(600);
	check("热重载后顶栏按钮仍能开合浮窗（动作处理器已重注册）", (await page.locator(".nt-panel").count()) === 1);
	reloadSock.close();

	await sleep(300);
	const realErrors = errors.filter((e) => !/favicon|ResizeObserver loop/i.test(e));
	check("页面无 JS 报错", realErrors.length === 0);
	if (realErrors.length) console.log(realErrors.slice(0, 6).join("\n"));

	console.log(`\n${process.exitCode ? "✗ 有失败项" : "all ok"}（${passed} checks）`);
}

try {
	await main();
} catch (err) {
	console.error(`✗ ${err?.stack ?? err}`);
	process.exitCode = 1;
} finally {
	try {
		await browser?.close();
	} catch {
		/* ignore */
	}
	if (server?.pid) {
		try {
			process.kill(-server.pid, "SIGTERM");
		} catch {
			try {
				process.kill(server.pid, "SIGTERM");
			} catch {
				/* ignore */
			}
		}
	}
	await sleep(600);
	rmSync(base, { recursive: true, force: true });
}
