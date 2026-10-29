/**
 * tool-inspector-state 单测（web/src/tool-inspector-state.ts）：
 * 覆盖工具执行详情与思考流检查器弹窗的模块级 store 及 isFlowMode 判定。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	closeToolInspector,
	getToolInspectorState,
	isFlowMode,
	openToolInspector,
	subscribeToolInspector,
} from "../../web/src/tool-inspector-state.js";

afterEach(() => {
	closeToolInspector();
});

describe("tool-inspector-state store", () => {
	it("初始状态为 null", () => {
		expect(getToolInspectorState()).toBeNull();
	});

	it("openToolInspector 设置状态并触发订阅回调", () => {
		let notified = 0;
		const unsub = subscribeToolInspector(() => {
			notified++;
		});

		openToolInspector({
			isThinking: false,
			name: "bash",
			title: "bash()",
			status: "已完成",
			statusClass: "ok",
			args: '{"command":"ls"}',
			output: "file.txt",
		});

		expect(notified).toBe(1);
		const s = getToolInspectorState();
		expect(s).not.toBeNull();
		expect(s?.name).toBe("bash");
		expect(s?.status).toBe("已完成");
		expect(s?.isThinking).toBe(false);

		unsub();
	});

	it("closeToolInspector 重置状态为 null 并通知订阅者", () => {
		openToolInspector({
			isThinking: true,
			title: "思考过程",
			output: "深度思考内容...",
		});
		expect(getToolInspectorState()).not.toBeNull();

		let notified = 0;
		const unsub = subscribeToolInspector(() => {
			notified++;
		});

		closeToolInspector();
		expect(getToolInspectorState()).toBeNull();
		expect(notified).toBe(1);

		// 幂等关闭不重复触发通知
		closeToolInspector();
		expect(notified).toBe(1);

		unsub();
	});
});

describe("isFlowMode 极简行文模式检测", () => {
	afterEach(() => {
		if (typeof document !== "undefined") {
			delete document.documentElement.dataset.theme;
			const link = document.getElementById("theme-stylesheet");
			link?.remove();
		}
	});

	it("在 dataset.theme 匹配 flow 相关主题时返回 true", () => {
		if (typeof document === "undefined") return;

		document.documentElement.dataset.theme = "flow";
		expect(isFlowMode()).toBe(true);

		document.documentElement.dataset.theme = "flow-light";
		expect(isFlowMode()).toBe(true);

		document.documentElement.dataset.theme = "wallpaper-flow";
		expect(isFlowMode()).toBe(true);

		document.documentElement.dataset.theme = "dark";
		expect(isFlowMode()).toBe(false);
	});

	it("在 theme-stylesheet 包含 flow 时返回 true", () => {
		if (typeof document === "undefined") return;

		delete document.documentElement.dataset.theme;
		const link = document.createElement("link");
		link.id = "theme-stylesheet";
		link.href = "/themes/flow.css";
		document.head.appendChild(link);

		expect(isFlowMode()).toBe(true);
	});
});
