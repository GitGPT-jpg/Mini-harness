/**
 * 顶栏溢出菜单回归（issue #183，#162 的回归）。
 *
 * 背景：溢出菜单 portal 到 document.body 后，里面搬进来的是**整块宿主控件**
 * （Dropdown 的 .chip 触发器 + .dd-menu、BrowserControl 的 .chip），不是扁平
 * 菜单项。三处纯 CSS 约束守住它：
 *   1. 菜单项规则必须是直子选择器（`.plugin-topbar-menu > button`）—— 后代
 *      选择器（0,1,1）会盖掉 .chip（0,1,0）的 inline-flex/边框与 .dd-item
 *      （0,1,0）的 flex，触发器挤成 block，面板行失去两端对齐。
 *   1b. GitHub 外链（`> a.plugin-topbar-menu-link`）必须跟菜单项按钮同组，
 *      不再自成一款 —— 否则同一菜单里一行带图标、一行纯文本，看着像两个层级。
 *   2. 嵌套 .dd-menu 打开时 portal 必须放行横向溢出
 *     （`.plugin-topbar-menu.portal:has(.dd-menu){overflow:visible}`）——
 *      overflow-y:auto 会让 overflow-x 按规范算成 auto，而 .dd-menu
 *     （min-width:340px、right:0）在 320px 的 portal 里向左探出，
 *      滚动容器的可滚区在 LTR 下不向 inline-start 延伸，标题会被裁掉且
 *      滚也滚不出来（.dd-menu 只在 open 时进 DOM，门控平时不影响长列表内滚）。
 *
 * 本测试是**静态**体检：只读 styles.css 文本，毫秒级、零端口、零浏览器
 * （CI 必跑）。真浏览器行为对照见 tests/scratch/verify-183.mjs（一次性）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web", "src", "styles.css"), "utf8");

describe("顶栏溢出菜单（issue #183）", () => {
	it("菜单项规则只命中直接子节点，不许后代选择器盖住搬进来的宿主控件", () => {
		// 允许 `.plugin-topbar-menu > button`（可带 GitHub 链接行的组合选择器），
		// 禁止 `.plugin-topbar-menu button`。
		const unscoped = [...CSS.matchAll(/\.plugin-topbar-menu\s+(?!>)\s*button\b/g)].map((m) => m[0]);
		expect(unscoped).toEqual([]);
		expect(CSS).toMatch(/\.plugin-topbar-menu\s*>\s*button\s*[,{]/);
	});

	it("GitHub 外链与菜单项按钮同一套外观（同一选择器组，不再自成一款）", () => {
		// 链接行与 role=menuitem 的按钮同组：纯文本行、同样的内边距与 hover。
		const group = CSS.match(
			/\.plugin-topbar-menu\s*>\s*button\s*,\s*\.plugin-topbar-menu\s*>\s*a\.plugin-topbar-menu-link\s*\{([^}]*)\}/s,
		);
		expect(group).toBeTruthy();
		expect(group![1]).toMatch(/display:\s*block/);
		expect(group![1]).toMatch(/text-decoration:\s*none/);
		// 链接只出现在普通组 + hover 组里；多一处 = 又给自己开了一条规则（曾经是 flex+gap 图标行）
		const occurrences = [...CSS.matchAll(/\.plugin-topbar-menu\s*>\s*a\.plugin-topbar-menu-link/g)].length;
		expect(occurrences).toBe(2);
		expect(CSS).not.toMatch(/a\.plugin-topbar-menu-link[^{]*\{[^}]*display:\s*flex/s);
	});

	it("嵌套下拉打开时 portal 放行横向溢出（:has 门控 + overflow:visible）", () => {
		expect(CSS).toMatch(/\.plugin-topbar-menu\.portal\s*:\s*has\(\s*\.dd-menu\s*\)\s*\{[^}]*overflow\s*:\s*visible/s);
	});

	it("portal 里的 chip 在移动端断点与顶栏同高（portal 没有 .topbar 祖先）", () => {
		expect(CSS).toMatch(/\.plugin-topbar-menu\.portal\s+\.chip\s*\{[^}]*height/s);
	});

	it("菜单里的行与文字统一 12.5px（不再让 .tb-row 继承 body 的 14px）", () => {
		// portal 挂在 body 下，继承的是 body 的 14px；不写死就会让「编辑图标」这类
		// 菜单自绘扁平行（.tb-row）比搬进来的 chip 行大一号（真机实报）。
		const menu = CSS.match(/\.plugin-topbar-menu\s*\{([^}]*)\}/s);
		expect(menu).toBeTruthy();
		expect(menu![1]).toMatch(/font-size:\s*12\.5px/);
		const rows = CSS.match(/\.plugin-topbar-menu\.portal\s+:is\(\.tb-row[^{]*\{([^}]*)\}/s);
		expect(rows).toBeTruthy();
		expect(rows![1]).toMatch(/font-size:\s*12\.5px/);
	});

	it("菜单里的图标格包着的 svg 也要填满方盒", () => {
		// .plugin-icon-glyph 原本只装 emoji 字形（字号跟方盒走）；一旦里面塞 svg
		// （图标组件），1em 会比外面图标格的 15px 小一号，得显式撑满。
		expect(CSS).toMatch(
			/\.plugin-topbar-menu\.portal\s+\.plugin-icon-glyph\s+svg\s*\{[^}]*width:\s*100%[^}]*height:\s*100%/s,
		);
	});
});
