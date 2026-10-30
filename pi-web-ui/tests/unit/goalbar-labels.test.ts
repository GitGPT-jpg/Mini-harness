// @vitest-environment jsdom
/**
 * 布局页改名落到目标条（issue #555 的同一类「假承诺」）：目标条的按钮文字一直是写死的
 * t("taskNew")/t("goalBarClear")/…，用户在设置里改名字，界面上必须真的换。
 * 名字走 `UiSlotEntry.labelExplicit`（用户改名 / 插件 arrange.label）才让位；没置旗时
 * 渲染结果必须与旧版逐字节一致（否则内置条目的本地化会被 entry.label 抢掉）。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { GoalBar } from "../../web/src/components/GoalBar.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { GoalStatus } from "../../web/src/types.js";
import type { UiSlotEntry } from "../../web/src/ui-slots.js";

const goal = {
	conversationId: "c1",
	goal: null,
	reviewModel: null,
	maxRounds: 3,
	locked: false,
	reviewing: false,
	round: 0,
	status: "",
	verdict: "pending",
	wizard: null,
} as unknown as GoalStatus;

/** goalbar.actions 槽位条目（与 buildUiSlots 的落成形状一致；labelExplicit 由布局页改名置位）。 */
const entries = (overrides: Record<string, Partial<UiSlotEntry>> = {}): UiSlotEntry[] =>
	["host:task-new", "host:goal-openrole", "host:goal-clear"].map((id) => ({
		id,
		slot: "goalbar.actions" as const,
		source: "host" as const,
		label: id,
		kind: "action" as const,
		order: 10,
		align: "start" as const,
		hidden: false,
		userOverrides: [],
		...overrides[id],
	}));

function render(uiGoalbarActions: UiSlotEntry[]) {
	localStorage.setItem("pi-web-ui:lang", "zh");
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(GoalBar, { goal, activeConversationId: "c1", uiGoalbarActions }),
			),
		);
	});
	return { container, root };
}

describe("目标条内置条目改名落地", () => {
	it("没置 labelExplicit：照旧画内置 i18n 文案（entry.label 不抢本地化）", () => {
		const { container, root } = render(entries({ "host:task-new": { label: "MY-TASK" } }));
		expect(container.textContent).toContain("新任务");
		expect(container.textContent).not.toContain("MY-TASK");
		act(() => root.unmount());
		container.remove();
	});

	it("布局页改名（labelExplicit）→ 「新任务」胶囊文字真的换", () => {
		const { container, root } = render(
			entries({ "host:task-new": { label: "MY-TASK", labelExplicit: true, userOverrides: ["label"] } }),
		);
		expect(container.textContent).toContain("MY-TASK");
		act(() => root.unmount());
		container.remove();
	});

	it("布局页藏掉「新任务」→ 折叠行整条不画胶囊", () => {
		const { container, root } = render(entries({ "host:task-new": { hidden: true } }));
		expect(container.querySelector(".loop-capsule")).toBeNull();
		act(() => root.unmount());
		container.remove();
	});
});
