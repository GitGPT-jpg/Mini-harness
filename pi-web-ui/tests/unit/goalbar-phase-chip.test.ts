// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { GoalBar } from "../../web/src/components/GoalBar.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { GoalStatus } from "../../web/src/types.js";

/**
 * 目标条活跃芯片按循环相位显示：执行阶段写「执行中…」，审查阶段写「审查中…」。
 *
 * 之前芯片只看 `reviewing` 布尔值 —— 整个委托循环期间它恒为 true，
 * 于是执行者在干活时目标条也写着「审查中…」，与同一行的 detail「执行中（第 N 轮）…」
 * 自相矛盾。协议里的 `phase` 字段是有意为此准备的，前端一直没用。
 */

let root: Root | null = null;

function mount(goal: Partial<GoalStatus>) {
	// 中文断言：jsdom 的 navigator.languages 默认英文，用存储键钉死 zh。
	window.localStorage.setItem("pi-web-ui:lang", "zh");
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const full = {
		conversationId: "c-1",
		goal: "把 README 补全",
		reviewModel: null,
		maxRounds: 0,
		locked: true,
		execModel: null,
		reviewing: true,
		round: 2,
		status: "",
		verdict: "pending",
		wizard: { active: false },
		...goal,
	} as unknown as GoalStatus;
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(GoalBar, {
					goal: full,
					models: [],
					modelsLoading: false,
					activeConversationId: "c-1",
				} as unknown as Parameters<typeof GoalBar>[0]),
			),
		);
	});
	return container;
}

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("目标条活跃芯片跟随 phase", () => {
	it("phase=executing → 显示「执行中… 第 2 轮」", () => {
		const container = mount({ phase: "executing" });
		const chip = container.querySelector(".goalbar-chip.reviewing");
		expect(chip).not.toBeNull();
		expect(chip!.textContent).toContain("执行中…");
		expect(chip!.textContent).toContain("第 2 轮");
		expect(chip!.textContent).not.toContain("审查中");
	});

	it("phase=reviewing → 显示「审查中… 第 2 轮」", () => {
		const container = mount({ phase: "reviewing" });
		const chip = container.querySelector(".goalbar-chip.reviewing");
		expect(chip).not.toBeNull();
		expect(chip!.textContent).toContain("审查中…");
	});

	it("phase 缺席（旧后端）→ 回落「审查中…」（行为不变）", () => {
		const container = mount({ phase: undefined });
		const chip = container.querySelector(".goalbar-chip.reviewing");
		expect(chip).not.toBeNull();
		expect(chip!.textContent).toContain("审查中…");
	});
});

describe("目标条轮次预算 / 执行者动态 / 用量", () => {
	it("有限预算 → 芯片显示 N/M", () => {
		const container = mount({ phase: "executing", maxRounds: 5, locked: true, round: 2 });
		const chip = container.querySelector(".goalbar-chip.reviewing")!;
		expect(chip.textContent).toContain("第 2/5 轮");
	});

	it("不限轮 → 芯片显示 N·不限", () => {
		const container = mount({ phase: "executing", maxRounds: 0, locked: true, round: 2 });
		const chip = container.querySelector(".goalbar-chip.reviewing")!;
		expect(chip.textContent).toContain("第 2 轮");
		expect(chip.textContent).toContain("不限");
	});

	it("执行者动态进 detail 行", () => {
		const container = mount({
			phase: "executing",
			roles: { executor: { convId: "c-exec", spawned: true, streaming: true, activity: "edit 运行中" } },
		});
		const details = [...container.querySelectorAll(".goalbar-detail")].map((e) => e.textContent ?? "");
		expect(details.some((t) => t.includes("edit 运行中"))).toBe(true);
	});

	it("累计用量进 detail 行（k 格式化，title 给精确值）", () => {
		const container = mount({ phase: "reviewing", usage: { inputTokens: 1500, outputTokens: 300 } });
		const el = [...container.querySelectorAll(".goalbar-detail")].find((e) =>
			(e.textContent ?? "").includes("tokens"),
		)!;
		expect(el).toBeTruthy();
		expect(el!.textContent).toContain("1.8k tokens");
		expect(el!.getAttribute("title")).toContain("1500");
	});
});
