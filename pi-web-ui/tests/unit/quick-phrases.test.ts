import { describe, expect, it } from "vitest";
import { QUICK_PHRASE_DEFAULTS } from "../../web/src/quick-phrases.js";

describe("QUICK_PHRASE_DEFAULTS", () => {
	it("各语言都有一套非空默认值，且符合服务端归一化约束", () => {
		for (const locale of Object.keys(QUICK_PHRASE_DEFAULTS) as (keyof typeof QUICK_PHRASE_DEFAULTS)[]) {
			const list = QUICK_PHRASE_DEFAULTS[locale];
			expect(list.length).toBeGreaterThan(0);
			expect(list.length).toBeLessThanOrEqual(30);
			for (const p of list) {
				expect(p.trim()).toBe(p);
				expect(p.length).toBeGreaterThan(0);
				expect(p.length).toBeLessThanOrEqual(200);
			}
			expect(new Set(list).size).toBe(list.length);
		}
	});
});
