import { describe, expect, it } from "vitest";
import { applyHeadTail } from "../../server/terminals.js";

/** head/tail 截断后的省略注记跟随服务端语言（issue #91）：zh 出中文，其余
 *  （含宿主未上报语言时的默认值）出英文；第三语言由语言包 serverStrings 覆盖，
 *  缺 key 自动回落英文。工具 definition 走 bilingual 内联双语，与本文件无关。 */
describe("applyHeadTail 的语言", () => {
	it("zh 保留中文注记", () => {
		expect(applyHeadTail("a\nb\nc", undefined, 1, "zh")).toBe("…（前 2 行已省略）\nc");
		expect(applyHeadTail("a\nb\nc", 1, undefined, "zh")).toBe("a\n…（后 2 行已省略）");
	});

	it("en 出英文注记；第三语言回落英文", () => {
		expect(applyHeadTail("a\nb\nc", undefined, 1, "en")).toBe("…[2 lines omitted above]…\nc");
		expect(applyHeadTail("a\nb\nc", 1, undefined, "en")).toBe("a\n…[2 lines omitted below]…");
		expect(applyHeadTail("a\nb\nc", undefined, 1, "ja")).toBe("…[2 lines omitted above]…\nc");
	});

	it("缺省 lang = 英文（客户端未上报语言）", () => {
		expect(applyHeadTail("a\nb\nc", 1, undefined)).toBe("a\n…[2 lines omitted below]…");
	});

	it("head + tail 同给：注记行不参与第二次截取", () => {
		expect(applyHeadTail("a\nb\nc\nd\ne", 3, 2, "en")).toBe(
			"…[1 lines omitted above]…\nb\nc\n…[2 lines omitted below]…",
		);
	});
});
