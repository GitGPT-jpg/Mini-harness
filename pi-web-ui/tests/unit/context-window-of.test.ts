import { describe, expect, it } from "vitest";
import { contextWindowOf } from "../../server/agent-formatters.js";

describe("contextWindowOf", () => {
	it("live 快照比模型定义小的时候，用模型定义", () => {
		expect(
			contextWindowOf({
				getSessionStats: () => ({ contextUsage: { contextWindow: 128_000 } }),
				model: { contextWindow: 1_000_000 },
			}),
		).toBe(1_000_000);
	});

	it("模型定义缺失时仍用 live 快照", () => {
		expect(
			contextWindowOf({
				getSessionStats: () => ({ contextUsage: { contextWindow: 262_144 } }),
				model: {},
			}),
		).toBe(262_144);
	});

	it("两边都没有时返回 0", () => {
		expect(contextWindowOf({})).toBe(0);
	});
});
