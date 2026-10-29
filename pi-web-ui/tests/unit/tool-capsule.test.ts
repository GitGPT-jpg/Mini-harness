// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { ToolCallBlock } from "../../web/src/components/ToolCallBlock.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { getToolInspectorState, closeToolInspector } from "../../web/src/tool-inspector-state.js";
import type { UiToolCallBlock, UiMessage } from "../../web/src/types.js";

let root: Root | null = null;

function mountTool(block: UiToolCallBlock, view: any, wrap = true) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(ToolCallBlock, {
					block,
					view,
					wrap,
				}),
			),
		);
	});
	return container;
}

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	closeToolInspector();
	delete document.documentElement.dataset.theme;
	vi.restoreAllMocks();
});

describe("工具微胶囊纯净轻量化与按需检查机制 (ToolCallCapsule)", () => {
	const sampleBlock: UiToolCallBlock = {
		type: "toolCall",
		id: "tc_123",
		name: "bash",
		argumentsText: JSON.stringify({ command: "git status" }),
	};

	const sampleView = {
		streaming: false,
		result: {
			id: "tr_123",
			role: "toolResult",
			toolCallId: "tc_123",
			content: [
				{
					type: "text",
					text: "On branch main\nChanges not staged for commit:\n  modified: large-file.ts\n".repeat(50),
				},
			],
		} as unknown as UiMessage,
	};

	it("常规桌面模式下展开时渲染完整工具卡片与输出正文", () => {
		const container = mountTool(sampleBlock, sampleView, true);
		const card = container.querySelector(".toolcall");
		expect(card).not.toBeNull();
		expect(card!.classList.contains("ok")).toBe(true);

		// 常规展开态下挂载正文与输出 pre
		expect(container.querySelector(".toolcall-body")).not.toBeNull();
		expect(container.querySelector(".toolcall-output")).not.toBeNull();
	});

	it("常规桌面模式下折叠态按需惰性挂载：折叠时不挂载输出 DOM，点击卡头才按需渲染", () => {
		const container = mountTool(sampleBlock, sampleView, false);
		const card = container.querySelector(".toolcall") as HTMLElement;
		expect(card).not.toBeNull();
		expect(card.classList.contains("ok")).toBe(true);

		// 折叠态下仅有单行卡头，正文零 DOM
		expect(container.querySelector(".toolcall-body")).toBeNull();
		expect(container.querySelector(".toolcall-output")).toBeNull();

		// 点击卡头切换展开
		const head = container.querySelector(".chead") as HTMLElement;
		expect(head).not.toBeNull();
		act(() => {
			head.click();
		});

		// 展开后按需挂载正文与输出
		expect(container.querySelector(".toolcall-body")).not.toBeNull();
		expect(container.querySelector(".toolcall-output")).not.toBeNull();
		expect(container.querySelector(".toolcall-output")?.textContent).toContain("On branch main");
	});

	it("Flow 极简行文模式下仅渲染纯净微胶囊外壳，不挂载任何输出正文 DOM", () => {
		document.documentElement.dataset.theme = "flow";
		const container = mountTool(sampleBlock, sampleView, true);
		const capsule = container.querySelector(".toolcall");
		expect(capsule).not.toBeNull();
		expect(capsule!.classList.contains("ok")).toBe(true);

		// 包含微胶囊外壳所必需的核心视觉要素
		expect(container.querySelector(".toolcall-name")?.textContent).toBe("bash");
		expect(container.querySelector(".toolcall-status")).not.toBeNull();

		// 纯净外壳：绝不挂载几十 KB 的输出 DOM 与内部大树
		expect(container.querySelector(".toolcall-body")).toBeNull();
		expect(container.querySelector(".toolcall-output")).toBeNull();
		expect(container.querySelector("pre.toolcall-output")).toBeNull();
		expect(container.querySelector(".toolcall-args")).toBeNull();
	});

	it("点击微胶囊时按需提取完整输出与参数，并唤起 ToolInspector 检查器", () => {
		document.documentElement.dataset.theme = "flow";
		const container = mountTool(sampleBlock, sampleView, true);
		const capsule = container.querySelector(".toolcall") as HTMLElement;
		expect(capsule).not.toBeNull();

		// 点击前检查器为空
		expect(getToolInspectorState()).toBeNull();

		// 点击微胶囊
		act(() => {
			capsule.click();
		});

		// 检查器被成功激活，且包含了完整的按需提取参数和输出
		const inspectorState = getToolInspectorState();
		expect(inspectorState).not.toBeNull();
		expect(inspectorState!.name).toBe("bash");
		expect(inspectorState!.rawOutput).toContain("On branch main");
		expect(inspectorState!.args).toBe(sampleBlock.argumentsText);
	});
});
