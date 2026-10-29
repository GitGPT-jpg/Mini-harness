// @vitest-environment jsdom
/**
 * 布局页改名落到目标条（issue #555 的同一类「假承诺」）：目标条的按钮文字一直是写死的
 * t("goalBarSet")/t("planActionBtn")/…，用户在设置里改名字，界面上必须真的换。
 * 名字走 `UiSlotEntry.labelExplicit`（用户改名 / 插件 arrange.label）才让位；没置旗时
 * 渲染结果必须与旧版逐字节一致（否则内置条目的本地化会被 entry.label 抢掉）。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { GoalBar } from "../../web/src/components/GoalBar.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { GoalStatus, ModelInfo } from "../../web/src/types.js";
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

/** goalbar.actions 槽位条目（与 buildUiSlots 的落成形状一致；labelExplicit 由改名/arrange 置位）。 */
const entries = (overrides: Record<string, Partial<UiSlotEntry>> = {}): UiSlotEntry[] =>
	["host:goal-pill", "host:goal-set", "host:goal-wizard", "host:goal-plan"].map((id) => ({
		id,
		slot: "goalbar.actions" as const,
		source: "host" as const,
		label: id,
		kind: "action" as const,
		order: 10,
		align: "start" as const,
		hidden: false,
		userOverrides: [],
		arrangedBy: [],
		...overrides[id],
	}));

function render(uiGoalbarActions: UiSlotEntry[], expand = false) {
	localStorage.setItem("pi-web-ui:lang", "zh");
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(GoalBar, {
					goal,
					models: [] as ModelInfo[],
					modelsLoading: false,
					activeConversationId: "c1",
					uiGoalbarActions,
				}),
			),
		);
	});
	if (expand) {
		// 折叠态只画那枚药丸；点开才是编辑器（host:goal-set / wizard / plan… 的那一行）。
		const pill = container.querySelector("button.goalbar-hint");
		act(() => {
			pill?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
	}
	return { container, root };
}

describe("目标条内置条目改名落地", () => {
	it("没置 labelExplicit：照旧画内置 i18n 文案（entry.label 不抢本地化）", () => {
		const { container, root } = render(entries({ "host:goal-set": { label: "MY-GOAL" } }), true);
		expect(container.textContent).toContain("提炼");
		expect(container.textContent).not.toContain("MY-GOAL");
		act(() => root.unmount());
		container.remove();
	});

	it("布局页改名 / 插件 arrange 指定（labelExplicit）→ 按钮文字真的换", () => {
		const { container, root } = render(
			entries({
				"host:goal-set": { label: "MY-SET", labelExplicit: true, userOverrides: ["label"] },
				"host:goal-plan": { label: "MY-PLAN", labelExplicit: true, arrangedBy: ["layouttest"] },
			}),
			true,
		);
		expect(container.textContent).toContain("MY-SET");
		expect(container.textContent).toContain("MY-PLAN");
		act(() => root.unmount());
		container.remove();
	});

	it("折叠态药丸（host:goal-pill）同样让位", () => {
		const { container, root } = render(entries({ "host:goal-pill": { label: "MY-PILL", labelExplicit: true } }));
		expect(container.textContent).toContain("MY-PILL");
		act(() => root.unmount());
		container.remove();
	});
});
