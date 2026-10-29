import { describe, expect, it } from "vitest";
import { messageMarkdown, messagePlainText, stripMarkdown, textBlocks } from "../../web/src/copy-text.js";

describe("textBlocks", () => {
	it("只取 text 块并保持顺序", () => {
		expect(
			textBlocks([
				{ type: "text", text: "a" },
				{ type: "thinking", text: "no" },
				{ type: "text", text: "b" },
				{ type: "text", text: "" },
			]),
		).toEqual(["a", "b"]);
	});
});

describe("messageMarkdown", () => {
	it("多文本块按空行拼接", () => {
		expect(
			messageMarkdown([
				{ type: "text", text: "# T" },
				{ type: "text", text: "`x`" },
			]),
		).toBe("# T\n\n`x`");
	});
});

describe("stripMarkdown", () => {
	it("标题/加粗/链接/图片只去标记留内容", () => {
		expect(stripMarkdown("# 标题")).toBe("标题");
		expect(stripMarkdown("**加粗**与*斜体*")).toBe("加粗与斜体");
		expect(stripMarkdown("[pi](https://x)")).toBe("pi");
		expect(stripMarkdown("![alt](u.png)")).toBe("alt");
	});
	it("代码围栏去 fence 留代码，行内代码去反引号", () => {
		expect(stripMarkdown("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
		expect(stripMarkdown("运行 `npm test` 看结果")).toBe("运行 npm test 看结果");
	});
	it("引用/列表/任务列表去前缀", () => {
		expect(stripMarkdown("> 引用\n- 第一项\n1. 第二项\n- [x] 做完")).toBe("引用\n第一项\n第二项\n做完");
	});
	it("表格转空格行", () => {
		const table = "| a | b |\n|---|---|\n| 1 | 2 |";
		expect(stripMarkdown(table)).toBe("a b\n1 2");
	});
	it("多余空行压缩", () => {
		expect(stripMarkdown("a\n\n\n\nb")).toBe("a\n\nb");
	});
});

describe("messagePlainText", () => {
	it("整条聚合后再剥标记", () => {
		expect(messagePlainText([{ type: "text", text: "# T\n\n**b**" }])).toBe("T\n\nb");
	});
});
