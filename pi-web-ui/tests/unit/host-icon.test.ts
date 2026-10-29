/**
 * 宿主图标名表守卫：「图标编辑」面板按 `UiSlotEntry.icon` **名字**画预览图标
 * （web/src/host-icon.tsx）。名字表漏登记不会报错 —— 那条条目只会静默地只剩文字。
 * 所以新增/改名内置条目时，这条测试先失败。
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_UI_ITEMS } from "../../web/src/ui-slots.js";
import { HOST_ICON_NAMES } from "../../web/src/host-icon.js";

describe("host icon names", () => {
	it("BUILTIN_UI_ITEMS 里的每个 icon 名字都已登记预览图标", () => {
		const known = new Set(HOST_ICON_NAMES);
		// 字形（emoji）由 hostEntryIcon 直接画，不需要登记；需要登记的是拉丁词表名（"settings"、
		// "gauge" …）—— 它们不登记就会只垒一个空图标槽。
		const missing = BUILTIN_UI_ITEMS.map((item) => item.icon).filter(
			(icon): icon is string => typeof icon === "string" && /[a-z]/i.test(icon) && !known.has(icon),
		);
		expect([...new Set(missing)]).toEqual([]);
	});

	it("名字表不含空串（脏值会画成空白节点）", () => {
		expect(HOST_ICON_NAMES.every((n) => n.length > 0)).toBe(true);
	});
});
