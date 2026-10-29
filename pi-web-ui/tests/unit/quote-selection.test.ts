// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readQuoteSelection } from "../../web/src/quote-selection.js";

afterEach(() => {
	window.getSelection()?.removeAllRanges();
	document.body.innerHTML = "";
});

function fixture() {
	document.body.innerHTML = `<div class="messages"><div class="msg" data-msg-id="a1" data-role="assistant"><div class="msg-meta">pi</div><div class="msg-text"><pre><code>  const value = 1;\n第二行</code></pre><p>后续段落</p><button>复制</button></div></div><div class="msg" data-msg-id="u1" data-role="user"><div class="msg-text">另一条消息</div><textarea>输入内容</textarea></div></div><p id="outside">外部内容</p>`;
	return document.querySelector<HTMLElement>(".messages")!;
}
function select(start: Node, end = start) {
	const range = document.createRange();
	range.setStart(start, 0);
	range.setEnd(end, end.textContent!.length);
	const selection = window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
	return selection;
}

describe("聊天文字选区", () => {
	it("保留代码缩进与换行，记录消息和会话来源", () => {
		const root = fixture();
		const selection = select(root.querySelector("code")!.firstChild!);
		expect(readQuoteSelection(root, selection, "s1")).toEqual({
			text: "  const value = 1;\n第二行",
			messageId: "a1",
			role: "assistant",
			sessionId: "s1",
		});
	});
	it("允许同一消息跨段落选区", () => {
		const root = fixture();
		const selection = select(root.querySelector("code")!.firstChild!, root.querySelector("p")!.firstChild!);
		expect(readQuoteSelection(root, selection)?.text).toContain("后续段落");
	});
	it("拒绝跨消息选区", () => {
		const root = fixture();
		const selection = select(
			root.querySelector("code")!.firstChild!,
			root.querySelector('[data-msg-id="u1"] .msg-text')!.firstChild!,
		);
		expect(readQuoteSelection(root, selection)).toBeNull();
	});
	it.each([".msg-meta", "button", "textarea", "#outside"])("忽略非内容区域 %s", (selector) => {
		const root = fixture();
		expect(readQuoteSelection(root, select(document.querySelector(selector)!.firstChild!))).toBeNull();
	});
	it("选区包含复制按钮时不引用操作文案", () => {
		const root = fixture();
		expect(
			readQuoteSelection(
				root,
				select(root.querySelector("code")!.firstChild!, root.querySelector("button")!.firstChild!),
			),
		).toBeNull();
	});
	it("空选区不显示引用入口", () => {
		const root = fixture();
		expect(readQuoteSelection(root, window.getSelection())).toBeNull();
	});
});
