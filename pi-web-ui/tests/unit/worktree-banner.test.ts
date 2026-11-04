// @vitest-environment jsdom
/**
 * 首页关联工作树横幅（WorktreeBanner 状态二）：默认只列出当前任务的工作树和含未提交改动的工作树，
 * 其余收进「更多」，展开后仍能看到状态并切换；横幅本身不触发任何清理。测试树均为构造数据。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { WorktreeBanner } from "../../web/src/components/WorktreeBanner.js";
import { handleWorktreeMessage } from "../../server/dispatch-domain-handlers.js";
import type { DispatchSession } from "../../server/index.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { LinkedWorktreeEntry, WorktreeInfo } from "../../web/src/types.js";

const RUN = "20261104080713-acf34a";
const tree = (name: string, extra: Partial<LinkedWorktreeEntry> = {}): LinkedWorktreeEntry => ({
	path: `/repo-wt/${name}`,
	branch: name,
	isCurrent: false,
	isMain: false,
	isDirty: false,
	uncommittedCount: 0,
	aheadCount: 0,
	...extra,
});
const info = (linked: LinkedWorktreeEntry[], linkedMode = false): WorktreeInfo => ({
	isLinkedWorktree: linkedMode,
	currentPath: linkedMode ? linked[0]!.path : "/repo",
	branch: linkedMode ? linked[0]!.branch : "main",
	mainPath: "/repo",
	mainBranch: "main",
	linkedWorktrees: linked,
});
const TREES = [
	tree("feat/old-a"),
	tree("feat/dirty", { isDirty: true, uncommittedCount: 3 }),
	tree("feat/old-b", { aheadCount: 2 }),
	tree(`mini-harness/${RUN}`, { path: `/runs/${RUN}/worktree`, aheadCount: 1 }),
	tree("feat/old-c"),
	tree("feat/old-d"),
];

let root: Root | null = null;
const onSwitch = vi.fn();
const onRemove = vi.fn();

function render(worktree: WorktreeInfo, taskRunId: string | null) {
	localStorage.setItem("pi-web-ui:lang", "zh");
	if (!root) {
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	}
	act(() => {
		root!.render(
			createElement(LanguageProvider, null, createElement(WorktreeBanner, { worktree, taskRunId, onSwitch, onRemove })),
		);
	});
}
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const rows = (sel: string) =>
	Array.from(document.querySelectorAll(`${sel} .worktree-expand-row`)).map((r) => r.getAttribute("data-worktree-path"));
const click = (el: Element | null) =>
	act(() => {
		el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	sessionStorage.clear();
	onSwitch.mockReset();
	onRemove.mockReset();
});

describe("WorktreeBanner：首页只突出当前任务与异常", () => {
	it("默认只列出当前任务的工作树和含未提交改动的工作树，其余在「更多」里且仍能看状态、切换", () => {
		render(info(TREES), RUN);
		expect(rows(".worktree-focus")).toEqual([`/runs/${RUN}/worktree`, "/repo-wt/feat/dirty"]);
		expect($(".worktree-more")).toBeNull();
		const focus = $(".worktree-focus")!.textContent!;
		expect(focus).toContain("当前任务");
		expect(focus).toContain("3 处含修改");
		expect($(".worktree-banner-title")!.textContent).toContain("关联工作树（6）");
		expect($(".worktree-banner-title")!.textContent).toContain("1 个有未提交改动");
		const more = $(".worktree-more-toggle")!;
		expect(more.textContent).toBe("更多 (4)");
		click(more);
		expect(rows(".worktree-more")).toEqual([
			"/repo-wt/feat/old-a",
			"/repo-wt/feat/old-b",
			"/repo-wt/feat/old-c",
			"/repo-wt/feat/old-d",
		]);
		const oldB = document.querySelector('.worktree-more [data-worktree-path="/repo-wt/feat/old-b"]')!;
		expect(oldB.textContent).toContain("领先主分支 2 个提交");
		expect(oldB.textContent).toContain("无未提交改动");
		click(oldB.querySelector(".worktree-banner-btn:not(.danger)"));
		expect(onSwitch).toHaveBeenCalledWith("/repo-wt/feat/old-b");
		expect(onRemove).not.toHaveBeenCalled();
	});

	it("没有当前任务、也没有未提交改动：只留一行入口，展开后全部可切换", () => {
		const clean = TREES.filter((w) => !w.isDirty);
		render(info(clean), null);
		expect($(".worktree-banner.quiet")).not.toBeNull();
		expect($(".worktree-focus")).toBeNull();
		expect($(".worktree-banner-desc")!.textContent).toContain("可在「更多」里查看和切换");
		click($(".worktree-more-toggle"));
		expect(rows(".worktree-more")).toHaveLength(clean.length);
	});

	it("突出项超过 3 个时多出来的并入「更多」", () => {
		const dirty = ["a", "b", "c", "d"].map((n) => tree(`fix/${n}`, { isDirty: true, uncommittedCount: 1 }));
		render(info(dirty), null);
		expect(rows(".worktree-focus")).toHaveLength(3);
		expect($(".worktree-more-toggle")!.textContent).toBe("更多 (1)");
	});

	it("移除仍要确认；取消确认不发移除", () => {
		render(info(TREES), RUN);
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		click(document.querySelector(".worktree-focus .worktree-banner-btn.danger"));
		expect(confirm).toHaveBeenCalled();
		expect(onRemove).not.toHaveBeenCalled();
		confirm.mockRestore();
	});

	it("同一实例在子工作树与主仓库两种状态间切换不报 hooks 顺序错误", () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		render(info(TREES, true), RUN);
		expect($(".worktree-banner.linked")).not.toBeNull();
		render(info(TREES), RUN);
		expect($(".worktree-focus")).not.toBeNull();
		// 只看 React 的 hooks 顺序告警（act 环境提示与本用例无关）
		const hookErrors = errors.mock.calls.filter((c) => /hook/i.test(String(c[0])));
		expect(hookErrors).toEqual([]);
		errors.mockRestore();
	});
});

describe("横幅刷新：refresh_worktree", () => {
	it("分发到会话的 refreshWorktreeInfo（任务工作树被删除后由界面发起）", () => {
		const refreshWorktreeInfo = vi.fn(async () => {});
		const handled = handleWorktreeMessage({ type: "refresh_worktree" }, {
			refreshWorktreeInfo,
		} as unknown as DispatchSession);
		expect(handled).toBe(true);
		expect(refreshWorktreeInfo).toHaveBeenCalledTimes(1);
	});
});
