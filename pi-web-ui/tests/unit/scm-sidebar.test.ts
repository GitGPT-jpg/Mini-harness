/**
 * Git 面板左栏宽度（issue #139）纯函数：夹取 + localStorage 存档解析。
 * 拖动 / 持久化本身在 SCMPanel 里（浏览器 E2E 见 tests/scm-test.mjs）。
 */
import { describe, expect, it } from "vitest";
import {
	clampScmSidebarWidth,
	parseScmSidebarWidth,
	SCM_DIFF_MIN,
	SCM_SIDEBAR_DEFAULT,
	SCM_SIDEBAR_MAX,
	SCM_SIDEBAR_MIN,
} from "../../web/src/scm-sidebar.js";

describe("clampScmSidebarWidth", () => {
	it("区间内原样保留（四舍五入到整数像素）", () => {
		expect(clampScmSidebarWidth(320)).toBe(320);
		expect(clampScmSidebarWidth(320.4)).toBe(320);
		expect(clampScmSidebarWidth(320.6)).toBe(321);
	});

	it("低于 / 高于上限 → 夹到区间端点", () => {
		expect(clampScmSidebarWidth(-50)).toBe(SCM_SIDEBAR_MIN);
		expect(clampScmSidebarWidth(0)).toBe(SCM_SIDEBAR_MIN);
		expect(clampScmSidebarWidth(99999)).toBe(SCM_SIDEBAR_MAX);
	});

	it("NaN / Infinity → 默认宽度", () => {
		expect(clampScmSidebarWidth(Number.NaN)).toBe(SCM_SIDEBAR_DEFAULT);
		expect(clampScmSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SCM_SIDEBAR_DEFAULT);
	});

	it("量到容器宽度时给 diff 区留出 SCM_DIFF_MIN", () => {
		expect(clampScmSidebarWidth(700, 900)).toBe(900 - SCM_DIFF_MIN);
		// 容器够宽 → 仍是 SCM_SIDEBAR_MAX 封顶
		expect(clampScmSidebarWidth(9999, 2000)).toBe(SCM_SIDEBAR_MAX);
		// 容器窄到装不下「最小值 + diff 最小值」→ 以最小值兜底，不退化成 0
		expect(clampScmSidebarWidth(700, 300)).toBe(SCM_SIDEBAR_MIN);
	});

	it("容器宽度未知（0 / 负数）时只按静态上限夹取", () => {
		expect(clampScmSidebarWidth(9999, 0)).toBe(SCM_SIDEBAR_MAX);
		expect(clampScmSidebarWidth(500, -10)).toBe(500);
	});
});

describe("parseScmSidebarWidth", () => {
	it("没有存档 / 空串 → 默认宽度", () => {
		expect(parseScmSidebarWidth(null)).toBe(SCM_SIDEBAR_DEFAULT);
		expect(parseScmSidebarWidth("")).toBe(SCM_SIDEBAR_DEFAULT);
		expect(parseScmSidebarWidth("   ")).toBe(SCM_SIDEBAR_DEFAULT);
	});

	it("坏值（非数字）→ 默认宽度", () => {
		expect(parseScmSidebarWidth("宽一点")).toBe(SCM_SIDEBAR_DEFAULT);
		expect(parseScmSidebarWidth("NaN")).toBe(SCM_SIDEBAR_DEFAULT);
	});

	it("越界存档 → 夹到区间内", () => {
		expect(parseScmSidebarWidth("12")).toBe(SCM_SIDEBAR_MIN);
		expect(parseScmSidebarWidth("100000")).toBe(SCM_SIDEBAR_MAX);
	});

	it("合法存档原样读出", () => {
		expect(parseScmSidebarWidth("420")).toBe(420);
	});
});
