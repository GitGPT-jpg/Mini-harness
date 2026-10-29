import { describe, expect, it } from "vitest";
import { formatDuration } from "../../web/src/components/ToolCallBlock.js";

describe("formatDuration", () => {
	it("非法/空值回退空串", () => {
		expect(formatDuration(undefined)).toBe("");
		expect(formatDuration(-1)).toBe("");
		expect(formatDuration(Number.NaN)).toBe("");
		expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("");
	});

	it("毫秒级（< 1000ms）格式化", () => {
		expect(formatDuration(0)).toBe("0ms");
		expect(formatDuration(1)).toBe("1ms");
		expect(formatDuration(45)).toBe("45ms");
		expect(formatDuration(350.4)).toBe("350ms");
		expect(formatDuration(999)).toBe("999ms");
	});

	it("秒级（1s ~ 59.9s）格式化", () => {
		expect(formatDuration(1000)).toBe("1.0s");
		expect(formatDuration(1200)).toBe("1.2s");
		expect(formatDuration(1250)).toBe("1.3s");
		expect(formatDuration(15000)).toBe("15.0s");
		expect(formatDuration(59940)).toBe("59.9s");
	});

	it("分钟级（>= 60s）格式化", () => {
		expect(formatDuration(60000)).toBe("1m 00s");
		expect(formatDuration(65000)).toBe("1m 05s");
		expect(formatDuration(125000)).toBe("2m 05s");
		expect(formatDuration(3600000)).toBe("60m 00s");
	});
});
