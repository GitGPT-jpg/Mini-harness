/* 浏览器 E2E（issue #146 完整版）：**右键菜单槽位**在真浏览器里的行为（T1 的回归网）。
 *
 * 背景：右栏文件树 / 左栏会话原先各自弹一套本地 `.ctx-menu`，改成 slot 槽位后由 App 里
 * 唯一的 `ContextMenu` 渲染。这类「实现从组件里搬走」的重构最容易默默丢掉功能
 * （历史上就这么退化过：上传文件 / 打开为项目 的处理器没接上），所以这里把**每一条内置
 * 条目点下去**、看它到底干没干活，而不是只断言菜单渲染出来了。
 *
 * 覆盖：
 *   - 目录行右键 → 上传到文件夹 / 以项目打开 / 添加为工作区根（三条内置条目）
 *   - 文件行右键 → 上传到当前目录（**没有**以项目打开与加根：它们只对目录有意义）
 *   - 列表空白处右键 → 上传到当前目录（同样没有以项目打开）
 *   - 「以项目打开」真的切工作目录（底栏 cwd 跟着变）
 *   - 「添加为工作区根」真的写出 set_workspace_roots → 右栏出现根选择器；
 *     选择器能切换根、能移除根（移除后选择器消失）
 *   - 左栏会话右键：历史会话行 / 运行中对话行 / 区域空白处三类目标各自该有的条目
 *     （空白处没有「强行关闭对话」，对话行有且是两段确认）
 *   - 页面无 JS 报错
 *
 * 缺 Chrome 自动 SKIP（与 plugin-settings-page-test 同约定）。运行：
 *   npm run build && node tests/context-menu-ui-test.mjs
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
const base = mkdtempSync(join(tmpdir(), "pi-ctxmenu-ui-"));
const WORK = join(base, "work");
const SUB = join(WORK, "subproject");
const FILE = join(WORK, "readme.txt");
// 上传源必须是工作区里不存在的新名字：readme.txt 已在工作区根，上传它只会得到「已存在」回执。
const UPLOAD_SRC = join(base, "incoming", "upload-me.txt");
const DATA_DIR = join(base, "data");
const AGENT_DIR = join(base, "agent");
const PORT = 20000 + Math.floor(Math.random() * 8000);
mkdirSync(SUB, { recursive: true });
writeFileSync(FILE, "hello\n");
writeFileSync(join(SUB, "inside.txt"), "sub\n");
mkdirSync(join(base, "incoming"), { recursive: true });
writeFileSync(UPLOAD_SRC, "upload\n");

/**
 * 种一个历史会话（格式与 pi CLI/TUI 相同，见 left-panel-delete-test.mjs）。
 * 零 token 把「运行中的对话」造出来的唯一办法：用 switch_session 打开它，对话就有内容了
 * （#140 的展示口径：当前对话 + 已有内容 = 进运行列表），于是会话右键菜单的三类目标
 * （历史行 / 运行行 / 区域空白）都能在无模型的情况下验到。
 */
function seedSession(cwd, id, text) {
	// PI_CODING_AGENT_SESSION_DIR 是「额外会话根」：SDK 的 SessionManager.list(cwd, root)
	// 会把该目录下的 *.jsonl **直接**当会话列出来（不递归子目录），所以这里平铺种。
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
seedSession(WORK, "ctxmenu-seed", "右键菜单回归用的对话");

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

/** 点一个元素：headless 下 `locator.click()` 在顶栏/弹层上偶发不达（悬停位移），
 *  按坐标派发真实鼠标事件才是用户行为（见 plugin-settings-page-test 的同一坑）。 */
async function tap(page, locator) {
	await locator.waitFor({ state: "visible", timeout: 15000 });
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	if (!box) throw new Error("tap: 元素没有 bounding box");
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** 右键某个元素（真实鼠标右键：菜单是 contextmenu 事件打开的）。 */
async function rightClick(page, locator) {
	await locator.waitFor({ state: "visible", timeout: 15000 });
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	if (!box) throw new Error("rightClick: 元素没有 bounding box");
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
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

/** 打开的菜单里的条目文案。 */
const menuItems = (page) => page.locator(".ctx-menu .ctx-menu-item, .ctx-menu .ctx-item");
async function menuTexts(page) {
	return (await menuItems(page).allTextContents()).map((s) => s.trim());
}
/** 菜单里有没有某条（按子串）。 */
async function hasMenuItem(page, text) {
	return (await menuTexts(page)).some((t) => t.includes(text));
}
/** 点菜单里的某条（按可见文案）。 */
async function clickMenuItem(page, text) {
	const item = menuItems(page).filter({ hasText: text }).first();
	await tap(page, item);
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
			// 只挂一个**额外的会话根**（pi CLI/TUI 那个根的等价物）：种进去的历史会话只影响本测试
			// （不污染真用户的 ~/.pi）。刻意**不**动 PI_CODING_AGENT_DIR —— 空 agent 目录会让
			// 应用弹出「首次配置」向导，那层 modal-backdrop 会盖住整个界面，右键全落到它身上。
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

	// 右栏（文件树）在桌面端默认展开；若被收起再点顶栏「文件列表」（**不能**用
	// title*="文件" —— 全局搜索的提示文案里也有「文件」，会点开搜索弹窗盖住整个页面）。
	const dirRow = page.locator('.panel-right .file-item.dir[data-path="subproject"]').first();
	if (!(await until(async () => (await dirRow.count()) > 0, 8, 250))) {
		await tap(
			page,
			page
				.locator(
					'button.panel-toggle[aria-label*="文件列表"], button.panel-toggle[aria-label*="Files"], button[title*="文件列表"], button[title*="Files"]',
				)
				.first(),
		);
	}
	check("右栏文件树列出了子目录", await until(async () => (await dirRow.count()) > 0, 40, 250));

	// ---- 目录行右键：三条内置条目 -------------------------------------------
	// 真实鼠标右键（contextmenu 是浏览器行为，DOM 里 synthetic click 触发不到）
	await page.evaluate(
		"window.__ctx=[]; window.addEventListener('contextmenu', e => window.__ctx.push((e.target && e.target.className) || 'x'), true)",
	);
	await rightClick(page, dirRow);
	const ctxInfo = await page.evaluate(
		"JSON.stringify({ev: window.__ctx, menu: document.querySelectorAll('.ctx-menu').length, backdrop: document.querySelectorAll('.modal-backdrop').length})",
	);
	if (process.env.CTX_DEBUG) console.log("DEBUG", ctxInfo);
	check(
		"目录行右键弹出**全局**右键菜单（.ctx-menu）",
		await until(async () => (await page.locator(".ctx-menu").count()) > 0, 20, 150),
		ctxInfo,
	);
	const dirTexts = await menuTexts(page);
	check(
		"菜单含「上传到文件夹」",
		dirTexts.some((t) => t.includes("上传文件到此文件夹")),
		dirTexts.join(" | "),
	);
	check(
		"菜单含「以项目打开」",
		dirTexts.some((t) => t.includes("以项目打开")),
	);
	check(
		"菜单含「添加为工作区根」",
		dirTexts.some((t) => t.includes("添加为工作区根")),
	);

	// ---- 「添加为工作区根」→ 右栏出现根选择器 --------------------------------
	await clickMenuItem(page, "添加为工作区根");
	check("菜单点后关闭", await until(async () => (await page.locator(".ctx-menu").count()) === 0, 20, 150));
	const rootPicker = page.locator(".root-picker-trigger").first();
	check("加根后右栏出现根选择器", await until(async () => (await rootPicker.count()) > 0, 40, 250));

	// 选择器里能看到主根 + 新根，且能切过去（crumbs 显示该根路径）
	await tap(page, rootPicker);
	const pickerRows = page.locator(".root-picker-menu .root-picker-row");
	check("选择器列出主根 + 1 个额外根", (await pickerRows.count()) === 2, `${await pickerRows.count()} 行`);
	const extraRow = pickerRows.filter({ hasText: "subproject" }).first();
	check("额外根行显示的是绝对路径", ((await extraRow.textContent()) ?? "").includes("subproject"));
	await tap(page, extraRow.locator(".root-picker-item").first());
	const browsed = await until(
		async () => ((await page.locator(".panel-crumbs").first().textContent()) ?? "").includes("subproject"),
		40,
		250,
	);
	check("选中额外根后文件树切到该根（crumbs 显示它的路径）", browsed);
	check(
		"切到根后列出的是根下面的内容（inside.txt）",
		await until(
			async () => (await page.locator('.panel-right .file-item[data-path*="inside.txt"]').count()) > 0,
			40,
			250,
		),
	);

	// ---- 移除根 → 选择器消失、树回到主根 ------------------------------------
	await tap(page, rootPicker);
	await tap(page, page.locator(".root-picker-menu .root-picker-remove").first());
	check(
		"移除根后选择器消失",
		await until(async () => (await page.locator(".root-picker-trigger").count()) === 0, 40, 250),
	);
	check(
		"移除后文件树回到主工作区（重新看到 subproject）",
		await until(
			async () => (await page.locator('.panel-right .file-item.dir[data-path="subproject"]').count()) > 0,
			40,
			250,
		),
	);

	// ---- 文件行右键：不含目录专属条目 --------------------------------------
	const fileRow = page.locator('.panel-right .file-item.file[data-path="readme.txt"]').first();
	check("文件树列出了文件行", await until(async () => (await fileRow.count()) > 0, 40, 250));
	await rightClick(page, fileRow);
	check("文件行右键弹出菜单", await until(async () => (await page.locator(".ctx-menu").count()) > 0, 20, 150));
	const fileTexts = await menuTexts(page);
	check(
		"文件行菜单是「上传到当前目录」",
		fileTexts.some((t) => t.includes("上传文件到当前目录")),
		fileTexts.join(" | "),
	);
	check("文件行没有「以项目打开」", !fileTexts.some((t) => t.includes("以项目打开")));
	check("文件行没有「添加为工作区根」", !fileTexts.some((t) => t.includes("添加为工作区根")));
	await page.keyboard.press("Escape");

	// ---- 列表空白处右键：只有「上传到当前目录」，且上传真的落到当前目录 ------
	const body = page.locator(".panel-right .panel-body").first();
	const bodyBox = await body.boundingBox();
	await page.mouse.click(bodyBox.x + bodyBox.width - 20, bodyBox.y + bodyBox.height - 20, { button: "right" });
	check("列表空白处右键弹出菜单", await until(async () => (await page.locator(".ctx-menu").count()) > 0, 20, 150));
	const blankTexts = await menuTexts(page);
	check(
		"空白处菜单含「上传到当前目录」",
		blankTexts.some((t) => t.includes("上传文件到当前目录")),
		blankTexts.join(" | "),
	);
	check(
		"空白处菜单没有「以项目打开」/「添加为工作区根」",
		!blankTexts.some((t) => t.includes("以项目打开") || t.includes("添加为工作区根")),
	);

	// 「上传到当前目录」= 打开隐藏的文件选择器：选一个真文件，服务端应回「已上传」类 notice
	const chooser = page.waitForEvent("filechooser", { timeout: 8000 }).catch(() => null);
	await clickMenuItem(page, "上传文件到当前目录");
	const fc = await chooser;
	check("点「上传到当前目录」打开了文件选择器", !!fc);
	if (fc) {
		await fc.setFiles(UPLOAD_SRC);
		const uploaded = await until(
			async () =>
				(await page
					.locator(".notice, .toast")
					.filter({ hasText: /上传|uploaded/i })
					.count()) > 0,
			40,
			250,
		);
		check("上传后界面给出回执（功能真的接上了）", uploaded);
	}

	// ---- 左栏：会话右键（contextmenu.session 槽位） ------------------------
	// 左栏桌面端默认展开（收起时才有点开它的 ☰，见 TopBar 的 panel-toggle）。
	const leftPanel = page.locator(".panel-left").first();
	check("左栏可见", await until(async () => (await leftPanel.count()) > 0, 30, 250));

	// 历史会话行：右键 → 有「关闭已结束子代理」，**没有**「强行关闭对话」（作用于单条运行中对话）
	const historyRow = leftPanel.locator(".panel-sessions .lp-row").first();
	check("左栏列出种进去的历史会话", await until(async () => (await historyRow.count()) > 0, 40, 250));
	await rightClick(page, historyRow);
	check("历史会话行右键弹出菜单", await until(async () => (await page.locator(".ctx-menu").count()) > 0, 20, 150));
	let leftTexts = await menuTexts(page);
	check(
		"历史行菜单含「关闭已结束子代理」",
		leftTexts.some((t) => t.includes("已结束子代理")),
		leftTexts.join(" | "),
	);
	check("历史行菜单没有「强行关闭对话」", !leftTexts.some((t) => t.includes("强行关闭")), leftTexts.join(" | "));
	await page.keyboard.press("Escape");

	// 打开这条历史会话（零 token：switch_session 不调模型），它就进了「运行的对话」
	await tap(page, leftPanel.locator(".panel-sessions .session-item").first());
	const runningSection = leftPanel.locator(".lp-section-convs").first();
	check("打开会话后「运行的对话」区出现", await until(async () => (await runningSection.count()) > 0, 50, 250));

	// 运行中对话行：右键 → 有「强行关闭对话」，且是两段确认（第一次点只换文案，不真关）
	const runningRow = runningSection.locator(".lp-row").first();
	if (await runningSection.count()) {
		await rightClick(page, runningRow);
		const openedRow = await until(async () => (await page.locator(".ctx-menu").count()) > 0, 20, 150);
		check("运行中对话行右键弹出菜单", openedRow);
		if (openedRow) {
			leftTexts = await menuTexts(page);
			check(
				"对话行菜单含「强行关闭对话」",
				leftTexts.some((t) => t.includes("强行关闭对话")),
				leftTexts.join(" | "),
			);
			await clickMenuItem(page, "强行关闭对话");
			const armed = await until(async () => await hasMenuItem(page, "确认强行关闭"), 20, 150);
			check("第一次点只进入确认态（菜单不关、文案换成确认）", armed && (await page.locator(".ctx-menu").count()) > 0);
			await page.keyboard.press("Escape");
		}
	}

	// 区域空白处：同样有「关闭已结束子代理」，但没有「强行关闭对话」（作用范围是整个区域）
	await rightClick(page, runningSection);
	const openedSection = await until(async () => (await page.locator(".ctx-menu").count()) > 0, 20, 150);
	check("运行对话区右键弹出菜单", openedSection);
	if (openedSection) {
		leftTexts = await menuTexts(page);
		check(
			"区域菜单含「关闭已结束子代理」",
			leftTexts.some((t) => t.includes("已结束子代理")),
			leftTexts.join(" | "),
		);
		check("区域菜单没有「强行关闭对话」", !leftTexts.some((t) => t.includes("强行关闭")));
		await page.keyboard.press("Escape");
	}

	// ---- 「以项目打开」真的切工作目录 --------------------------------------
	await rightClick(page, dirRow);
	await clickMenuItem(page, "以项目打开");
	const cwdChanged = await until(
		async () => ((await page.locator(".statusbar .status-cwd").first().textContent()) ?? "").includes("subproject"),
		50,
		250,
	);
	check("「以项目打开」切换了工作目录（底栏 cwd 显示 subproject）", cwdChanged);
	// 切回来后文件树回到主工作区
	await until(
		async () => (await page.locator('.panel-right .file-item.dir[data-path="subproject"]').count()) > 0,
		50,
		250,
	);

	// ---- 界面布局的不变量：隐藏内置「文件」tab → 右栏真的空了（设置与界面一致） ----
	// 这是 #146 的核心不变量（设置面板里看到的 == 界面上生效的）：文件 tab 也**不能**
	// 免疫用户偏好，否则布局页那个勾选框就是个摆设。
	await tap(
		page,
		page
			.locator(
				'button.chip[data-tip*="设置"], button.chip[data-tip*="Settings"], button[title*="设置"], button[title*="Settings"]',
			)
			.first(),
	);
	const modalOpen = await until(async () => (await page.locator(".settings-modal").count()) > 0, 30, 250);
	check("设置面板打开", modalOpen);
	if (modalOpen) {
		await tap(page, page.locator(".settings-tab", { hasText: /界面布局|UI layout/ }).first());
		const panelsSlot = page.locator(".set-ui-slot", { hasText: /右侧面板|Right panel/ }).first();
		const filesRow = panelsSlot.locator(".set-row", { hasText: /文件列表|Files/ }).first();
		const listed = await until(async () => (await filesRow.count()) > 0, 30, 250);
		check("布局页列出了右栏的「文件列表」条目", listed);
		if (listed) {
			await tap(page, filesRow.locator('input[type="checkbox"]').first());
			const hidden = await until(async () => (await page.locator(".panel-right .panel-body").count()) === 0, 30, 250);
			check("取消勾选后右栏的文件树消失（用户偏好对内置 tab 同样生效）", hidden);
			await tap(page, filesRow.locator('input[type="checkbox"]').first());
			const back = await until(async () => (await page.locator(".panel-right .panel-body").count()) > 0, 30, 250);
			check("勾回去后文件树回来", back);
		}
		await tap(page, page.locator(".settings-modal .modal-close").first());
		await until(async () => (await page.locator(".settings-modal").count()) === 0, 20, 200);
	}

	// ---- 隐藏的内置顶栏入口仍能在「⋯」溢出菜单里点到（不是死按钮） -----------
	// 布局页把「后台任务」隐藏 → 主栏的按钮消失、它落到溢出菜单；点它必须真的打开面板。
	// 这条的不变量：隐藏 ≠ 失去入口（插件能整理宿主 UI，但锁不死用户）。
	if (modalOpen) {
		await tap(
			page,
			page
				.locator(
					'button.chip[data-tip*="设置"], button.chip[data-tip*="Settings"], button[title*="设置"], button[title*="Settings"]',
				)
				.first(),
		);
		if (await until(async () => (await page.locator(".settings-modal").count()) > 0, 30, 250)) {
			await tap(page, page.locator(".settings-tab", { hasText: /界面布局|UI layout/ }).first());
			const topbarSlot = page.locator(".set-ui-slot", { hasText: /顶栏|Top bar/ }).first();
			const tasksRow = topbarSlot.locator(".set-row", { hasText: /后台任务|Background tasks/ }).first();
			if (await until(async () => (await tasksRow.count()) > 0, 30, 250)) {
				await tap(page, tasksRow.locator('input[type="checkbox"]').first());
				await tap(page, page.locator(".settings-modal .modal-close").first());
				await until(async () => (await page.locator(".settings-modal").count()) === 0, 20, 200);
				const mainGone = (await page.locator("button.bg-task-chip").count()) === 0;
				check("隐藏后主栏的后台任务按钮消失", mainGone);
				await tap(page, page.locator(".plugin-topbar-more > button").first());
				const inOverflow = await until(
					async () =>
						(await page
							.locator(".plugin-topbar-menu")
							.filter({ hasText: /后台任务|Background tasks/ })
							.count()) > 0,
					20,
					200,
				);
				check("隐藏后它出现在「⋯」溢出菜单里", inOverflow);
				// 菜单型宿主条目（如「后台任务」）在溢出菜单里是**整块搬过来的 chip**（包在
				// `.plugin-topbar-menu-keep` 里，没有 `role=menuitem`）——动作类才有 role。两者都要能点到。
				await tap(
					page,
					page
						.locator(".plugin-topbar-menu .plugin-topbar-menu-keep, .plugin-topbar-menu [role=menuitem]")
						.filter({ hasText: /后台任务|Background tasks/ })
						.first(),
				);
				const tasksOpen = await until(
					async () => (await page.getByText(/后台任务|Background tasks/).count()) > 0,
					20,
					200,
				);
				check("点溢出菜单里的它能真的打开面板（不是死按钮）", tasksOpen);
			}
		}
	}

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
