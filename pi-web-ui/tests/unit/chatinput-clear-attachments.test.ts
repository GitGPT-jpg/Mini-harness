// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { ChatInput } from "../../web/src/components/ChatInput.js";
import { TemplateProvider } from "../../web/src/components/PromptTemplates.js";
import { resetAppGlobals, setAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { LanguageProvider } from "../../web/src/i18n.js";

/**
 * 附件行「全部移除」（jsdom）：≥2 条才出现；点一下调 onClearAttachments，
 * 并把正文里对应的 @提及 一并删掉（普通文字保留）。
 */

type Att = { path: string; name: string; mode?: "reference"; imageData?: string; key?: string };

let root: Root | null = null;

function mount(attachments: Att[], onClearAttachments?: () => void) {
	// jsdom 没有 ResizeObserver（附件行挂载时 ChatInput 用它量行高）。
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	setAppGlobals({ ready: true });
	setAppSend(() => true);
	try {
		localStorage.setItem("pi-web-ui:lang", "zh");
	} catch {
		/* ignore */
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(TemplateProvider, {
					currentModelId: null,
					children: createElement(ChatInput, {
						sessionId: "sess-clear",
						streaming: false,
						messages: [],
						slashCommands: [],
						modelState: null,
						models: [],
						modelsLoading: false,
						attachments,
						onRemoveAttachment: () => {},
						onClearAttachments,
						onAddImageFiles: () => {},
						onAddLocalFiles: () => {},
						onNotice: () => {},
						onSent: () => {},
						onManageModels: () => {},
						providerKeys: {},
						quickPhrases: [],
						quickPhrasesEnabled: false,
					}),
				}),
			),
		);
	});
	return container;
}

function typeText(container: HTMLElement, value: string) {
	const ta = container.querySelector("textarea") as HTMLTextAreaElement;
	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
	act(() => {
		setter.call(ta, value);
		ta.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

const TWO: Att[] = [
	{ path: "src/a.ts", name: "a.ts", mode: "reference" },
	{ path: "", name: "shot.png", imageData: "data:image/png;base64,AA", key: "img-1" },
];

afterEach(() => {
	resetAppGlobals();
	setAppSend(null);
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("ChatInput 附件「全部移除」", () => {
	it("只有 1 条附件时不显示", () => {
		const c = mount([TWO[0]], () => {});
		expect(c.querySelector(".attach-clear")).toBeNull();
	});

	it("未传 onClearAttachments 时不显示", () => {
		const c = mount(TWO);
		expect(c.querySelector(".attach-clear")).toBeNull();
	});

	it("≥2 条时显示，点击清空附件并删掉正文里的 @提及", () => {
		const onClear = vi.fn();
		const c = mount(TWO, onClear);
		typeText(c, "看一下 @src/a.ts 这个文件");

		const btn = c.querySelector(".attach-clear") as HTMLButtonElement;
		expect(btn).not.toBeNull();
		act(() => {
			btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(onClear).toHaveBeenCalledTimes(1);
		expect((c.querySelector("textarea") as HTMLTextAreaElement).value).toBe("看一下 这个文件");
	});
});
