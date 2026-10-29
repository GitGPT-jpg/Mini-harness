import { describe, expect, it } from "vitest";
import { mockThemeProxy, WebUIContext } from "../../server/webui-context.js";
import type { ServerMessage } from "../../server/protocol.js";

/** Mimic pi SDK wrapUIPromptContext: `{ ...ui, select: wrapped }` copies own
 *  properties only. Class prototype methods would vanish here. */
function wrapLikeSdk(ui: WebUIContext) {
	return {
		...ui,
		select: ui.select,
	};
}

describe("WebUIContext SDK wrap", () => {
	it("setStatus and notify remain functions after object spread", () => {
		const ui = new WebUIContext(() => {});
		const wrapped = wrapLikeSdk(ui);
		expect(typeof wrapped.setStatus).toBe("function");
		expect(typeof wrapped.notify).toBe("function");
	});

	it("spread copy still emits statuses and notice", () => {
		const msgs: ServerMessage[] = [];
		const ui = new WebUIContext((msg) => msgs.push(msg));
		const wrapped = wrapLikeSdk(ui);

		wrapped.setStatus("0-claude-max", "🧠 5h 19%");
		wrapped.notify("hello", "info");

		expect(msgs).toContainEqual({
			type: "statuses",
			statuses: [{ key: "0-claude-max", text: "🧠 5h 19%" }],
		});
		expect(msgs).toContainEqual({
			type: "notice",
			level: "info",
			text: "hello",
		});
	});
});

describe("WebUIContext.headless (subagent sessions)", () => {
	it("cancels dialogs right away instead of waiting for a browser", async () => {
		// 没有浏览器应答：挂 Promise 会让扩展永久 await（PR #128 回归点）。
		const ui = WebUIContext.headless();
		await expect(ui.select("pick", ["a"])).resolves.toBeNull();
		await expect(ui.confirm("sure?", "m")).resolves.toBeNull();
		await expect(ui.input("name")).resolves.toBeNull();
	});

	it("drops every UI message (no cross-talk with the main conversation)", () => {
		// 先盯「挂浏览器的上下文照常发」，再盯「headless 一条都不发」。
		const attached: ServerMessage[] = [];
		const live = new WebUIContext((msg) => attached.push(msg));
		const ui = WebUIContext.headless();
		for (const ctx of [live, ui]) {
			ctx.setStatus("probe", "on");
			ctx.notify("hello", "info");
			ctx.setWidget("probe", ["line"]);
		}
		expect(attached.length).toBeGreaterThan(0);
		expect(live.snapshot()).not.toEqual([]);
		expect(ui.snapshot()).toEqual([]);
	});

	it("never builds widget components (nothing would ever dispose them)", () => {
		const ui = WebUIContext.headless();
		let built = 0;
		const factory = (() => {
			built++;
			return { render: () => ["probe"] };
		}) as unknown as Parameters<WebUIContext["setWidget"]>[1];
		ui.setWidget("probe", factory);
		expect(built).toBe(0);
		expect(ui.snapshot()).toEqual([]);
	});
});

describe("WebUIContext.hasWidgets (conditional 2s poll)", () => {
	it("is false when empty, true after mount, false after unmount/dispose", () => {
		const ui = new WebUIContext(() => {});
		expect(ui.hasWidgets()).toBe(false);
		ui.setWidget("a", ["line"]);
		expect(ui.hasWidgets()).toBe(true);
		ui.setWidget("a", undefined);
		expect(ui.hasWidgets()).toBe(false);
		ui.setDynamicWidget("b", () => ["line"]);
		expect(ui.hasWidgets()).toBe(true);
		ui.dispose();
		expect(ui.hasWidgets()).toBe(false);
	});

	it("refresh with no widgets emits nothing", () => {
		const msgs: ServerMessage[] = [];
		const ui = new WebUIContext((msg) => msgs.push(msg));
		msgs.length = 0;
		ui.refresh();
		expect(msgs).toEqual([]);
	});
});

describe("mockThemeProxy (TUI theme shim used in the browser)", () => {
	// 主题代理的文本永远是**最后一个**参数：`decorate(text)` 与 `color(token, text)` 两种形态都有。
	// 若通用兜底假设文本固定在第二位，单参数装饰器会把包住的正文整段丢成空串
	// （实测：扩展 @lanlance/pi-recap 的 `※ recap:` 行在网页端只剩前缀）。
	const theme = mockThemeProxy as unknown as Record<string, (...args: unknown[]) => string>;

	it("keeps text through every single-arg decorator", () => {
		for (const name of ["bold", "italic", "underline", "inverse", "strikethrough"]) {
			expect(theme[name]("正文")).toBe("正文");
		}
	});

	it("keeps text through the two-arg color helpers", () => {
		expect(theme.fg("accent", "正文")).toBe("正文");
		expect(theme.bg("panel", "正文")).toBe("正文");
	});

	it("unknown theme methods still fall back to the last string argument", () => {
		expect(theme.someFutureDecorator("正文")).toBe("正文");
		expect(theme.someFutureDecorator("accent", "正文")).toBe("正文");
	});
});

describe("mockThemeProxy 返回装饰函数的方法（0.103 审计，#592 同类遗漏）", () => {
	const theme = mockThemeProxy as unknown as Record<string, (...args: unknown[]) => unknown>;

	it("getThinkingBorderColor / getBashModeBorderColor 返回函数而非字符串", () => {
		const border = (theme.getThinkingBorderColor as (level: string) => (s: string) => string)("medium");
		expect(typeof border).toBe("function");
		expect(border("正文")).toBe("正文");
		const bashBorder = (theme.getBashModeBorderColor as () => (s: string) => string)();
		expect(typeof bashBorder).toBe("function");
		expect(bashBorder("命令")).toBe("命令");
	});
});
