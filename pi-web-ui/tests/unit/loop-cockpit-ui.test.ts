// @vitest-environment jsdom
/**
 * 驾驶舱 Loop 入口：输入框上沿成对居中的「LLM loop / 代码 loop」两枚胶囊。
 * - 目标条折叠态同一行画两枚（LLM loop 展开目标编辑器，代码 loop 打开启动弹窗）；
 * - 任一驾驶舱弹层（代码 loop / 连接集群 / 任务台）打开时两枚都收起，关掉再回来；
 * - 目标模式关掉（目标条不渲染）时 LoopBar 补一枚代码 loop 胶囊，入口不丢。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { GoalBar } from "../../web/src/components/GoalBar.js";
import { LoopBar } from "../../web/src/components/LoopBar.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { closeCluster, closeCodeLoop, closeTaskDesk, openCluster, openTaskDesk } from "../../web/src/loop-cockpit.js";
import type { GoalStatus, ModelInfo } from "../../web/src/types.js";

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

let root: Root | null = null;

function mount(node: ReturnType<typeof createElement>): HTMLElement {
	localStorage.setItem("pi-web-ui:lang", "zh");
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(createElement(LanguageProvider, null, node));
	});
	return container;
}

const goalBar = () =>
	createElement(GoalBar, { goal, models: [] as ModelInfo[], modelsLoading: false, activeConversationId: "c1" });

const capsules = (c: HTMLElement) =>
	Array.from(c.querySelectorAll(".goalbar-collapsed .loop-capsule")).map((b) => b.textContent?.trim());

afterEach(() => {
	act(() => {
		root?.unmount();
		closeCodeLoop();
		closeCluster();
		closeTaskDesk();
	});
	root = null;
	document.body.innerHTML = "";
});

describe("LLM loop / 代码 loop 胶囊", () => {
	it("目标条折叠态同一行画两枚胶囊", () => {
		const c = mount(goalBar());
		expect(capsules(c)).toEqual(["LLM loop", "代码 loop"]);
		expect(c.querySelector(".loop-capsule.llm")?.getAttribute("title")).toContain("由 AI 自己判断是否完成");
	});

	it("任一驾驶舱弹层打开时收起，关掉恢复", () => {
		const c = mount(goalBar());
		act(() => openCluster());
		expect(capsules(c)).toEqual([]);
		act(() => closeCluster());
		expect(capsules(c)).toHaveLength(2);
		act(() => openTaskDesk());
		expect(capsules(c)).toEqual([]);
		act(() => closeTaskDesk());
		// 点代码 loop 胶囊 = 打开启动弹窗 → 胶囊随即收起
		act(() => {
			c.querySelector(".loop-capsule.code")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(capsules(c)).toEqual([]);
	});

	it("LLM loop 胶囊展开目标编辑器：帮我细化 / 评审模型 / 代码 loop 入口与说明行", () => {
		const c = mount(
			createElement(GoalBar, {
				goal,
				models: [] as ModelInfo[],
				modelsLoading: false,
				activeConversationId: "c1",
				mainModel: { id: "glm-4.6", name: "GLM-4.6", provider: "oneapi" },
			}),
		);
		act(() => {
			c.querySelector(".loop-capsule.llm")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		const text = c.textContent ?? "";
		expect(text).toContain("帮我细化");
		expect(text).toContain("评审模型:GLM-4.6");
		expect(c.querySelector(".goalbar-codeloop")).not.toBeNull();
		// 执行模型跟随主对话 = 自己审自己
		expect(c.querySelector(".goalbar-loop-hint.warn")).not.toBeNull();
	});

	it("目标模式关掉时 LoopBar 补一枚代码 loop 胶囊；开着时不重复画", () => {
		const off = mount(createElement(LoopBar, { loop: null, goalModeEnabled: false }));
		expect(Array.from(off.querySelectorAll(".loop-capsule")).map((b) => b.textContent?.trim())).toEqual(["代码 loop"]);
		act(() => root?.unmount());
		const on = mount(createElement(LoopBar, { loop: null, goalModeEnabled: true }));
		expect(on.querySelectorAll(".loop-capsule")).toHaveLength(0);
	});
});
