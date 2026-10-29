// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { BarItem } from "../../web/src/components/BarItem.js";
import {
	formatCostDisplay,
	getCostCurrencySymbol,
	registerCostFormatter,
	setCostCurrencySymbol,
} from "../../web/src/cost-format.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { UiSlotEntry } from "../../web/src/ui-slots.js";
import type { ChatState } from "../../web/src/use-chat.js";

const costEntry: UiSlotEntry = {
	id: "host:cost",
	slot: "bottombar",
	source: "host",
	label: "花费",
	kind: "badge",
	order: 12,
	align: "start",
	hidden: false,
	userOverrides: [],
	arrangedBy: [],
};

const chatStub = {
	status: "open",
	ready: true,
	engine: "pi",
	state: {
		cwd: "/workspace/my-project",
		isStreaming: false,
		stats: {
			cost: 0.025,
			totalMessages: 3,
			tokens: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, total: 200 },
		},
		queue: { steering: [], followUp: [] },
	},
	bgServers: [],
	statuses: [],
	terminals: [],
	update: null,
	updatesAll: [],
} as unknown as ChatState;

describe("cost-format (#607)", () => {
	afterEach(() => {
		setCostCurrencySymbol(null);
		registerCostFormatter(null);
	});

	it("defaults to $ symbol and standard 4-digit trimmed format", () => {
		expect(getCostCurrencySymbol()).toBe("$");
		expect(formatCostDisplay(0.025)).toEqual({ symbol: "$", value: "0.025" });
		expect(formatCostDisplay(0.00001)).toEqual({ symbol: "$", value: "<0.0001" });
	});

	it("allows configuring custom currency symbol (e.g. ¥) and updates BarItem host:cost reactively", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		act(() => {
			root.render(
				createElement(
					LanguageProvider,
					null,
					createElement(BarItem, { entry: costEntry, bar: "bottom", chat: chatStub, view: "chat" }),
				),
			);
		});

		expect(container.querySelector(".bar-item-char")?.textContent).toBe("$");
		expect(container.querySelector(".bar-item-text")?.textContent).toBe("0.025");

		act(() => {
			setCostCurrencySymbol("¥");
		});
		expect(container.querySelector(".bar-item-char")?.textContent).toBe("¥");
		expect(container.querySelector(".bar-item-text")?.textContent).toBe("0.025");

		act(() => root.unmount());
		container.remove();
	});

	it("allows plugins to register a custom cost formatter (string or parts) and restores default on unregister", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		act(() => {
			root.render(
				createElement(
					LanguageProvider,
					null,
					createElement(BarItem, { entry: costEntry, bar: "bottom", chat: chatStub, view: "chat" }),
				),
			);
		});

		let unregister: () => void = () => {};
		act(() => {
			unregister = registerCostFormatter((usd) => `¥${(usd * 7.2).toFixed(3)}`);
		});
		expect(container.querySelector(".bar-item-char")?.textContent).toBe("¥");
		expect(container.querySelector(".bar-item-text")?.textContent).toBe("0.180");

		act(() => {
			unregister();
		});
		expect(container.querySelector(".bar-item-char")?.textContent).toBe("$");
		expect(container.querySelector(".bar-item-text")?.textContent).toBe("0.025");

		act(() => root.unmount());
		container.remove();
	});
});
