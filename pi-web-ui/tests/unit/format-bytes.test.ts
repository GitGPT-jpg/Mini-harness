import { describe, expect, it } from "vitest";
import { formatBytes, formatSize } from "../../web/src/format-bytes.js";

describe("format-bytes", () => {
	it("formatSize: 格式化 B / KB / MB", () => {
		expect(formatSize(undefined)).toBe("");
		expect(formatSize(null)).toBe("");
		expect(formatSize(500)).toBe("500 B");
		expect(formatSize(1024)).toBe("1 KB");
		expect(formatSize(2048)).toBe("2 KB");
		expect(formatSize(1024 * 1024)).toBe("1.0 MB");
		expect(formatSize(1024 * 1024 * 2.5)).toBe("2.5 MB");
	});

	it("formatBytes: 格式化带小数的 KB / MB / GB", () => {
		expect(formatBytes(undefined)).toBe("");
		expect(formatBytes(null)).toBe("");
		expect(formatBytes(500)).toBe("500 B");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(1024 * 1024 * 1.5)).toBe("1.5 MB");
		expect(formatBytes(1024 * 1024 * 1024 * 2)).toBe("2.0 GB");
	});
});
