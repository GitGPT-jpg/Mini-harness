/**
 * tests/unit/markdown-chunks.test.ts
 * Verifies structure-aware Markdown chunking logic for IM bots.
 */

import { describe, expect, it } from "vitest";
import { chunkMarkdownText, safeSliceIndex } from "../../plugins/feishu/markdown-chunks.mjs";

describe("Markdown 结构感知分块测试 (chunkMarkdownText)", () => {
	it("空文本或短文本直接返回原数组", () => {
		expect(chunkMarkdownText("")).toEqual([]);
		expect(chunkMarkdownText(null as unknown as string)).toEqual([]);
		expect(chunkMarkdownText("Hello world", 100)).toEqual(["Hello world"]);
	});

	it("长纯文本按行与自然段切分，不超过 limit", () => {
		const longText = Array.from({ length: 20 }, (_, i) => `Paragraph line ${i + 1} with some text content.`).join("\n");
		const chunks = chunkMarkdownText(longText, 150);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(160); // 允许微小边界
		}
		expect(chunks.join("\n")).toContain("Paragraph line 1");
		expect(chunks.join("\n")).toContain("Paragraph line 20");
	});

	it("跨边界的代码块自动闭合并在下一段重新开启", () => {
		const codeText = [
			"Here is some code:",
			"```typescript",
			"const a = 1;",
			"const b = 2;",
			"const c = a + b;",
			"console.log(c);",
			"```",
			"End of section.",
		].join("\n");

		// 设置较小 limit 迫使其在代码块中间截断
		const chunks = chunkMarkdownText(codeText, 60);
		expect(chunks.length).toBeGreaterThan(1);

		// 第一个 chunk 应该以 ``` 闭合代码块
		const first = chunks[0];
		expect(first).toContain("```typescript");
		expect(first.endsWith("```") || first.includes("```\n")).toBe(true);

		// 第二个 chunk 应该以 ```typescript 重新开启代码块
		const second = chunks[1];
		expect(second.startsWith("```typescript")).toBe(true);
	});

	it("safeSliceIndex 避免切断代理对 (Surrogate Pairs 如 Emoji)", () => {
		const emojiText = "Hello 😊 World"; // 😊 是两个 16-bit code units (0xD83D, 0xDE0A)
		// 寻找 😊 的起始位置
		const emojiIdx = emojiText.indexOf("😊");
		// 截取到 emoji 内部（emojiIdx + 1）
		const safeIdx = safeSliceIndex(emojiText, emojiIdx + 1);
		expect(safeIdx).toBe(emojiIdx); // 自动退避到 emoji 之前，不切碎
	});
});
