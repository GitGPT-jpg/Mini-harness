import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BASE64_CHARS, MAX_UPLOAD_BYTES, WS_MAX_PAYLOAD_BYTES } from "../../server/files-service.js";

describe("ws/upload cap alignment", () => {
	it("100MB cap 对应的 base64 上限", () => {
		expect(MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
		expect(MAX_UPLOAD_BASE64_CHARS).toBe(Math.ceil(MAX_UPLOAD_BYTES / 3) * 4);
		expect(MAX_UPLOAD_BASE64_CHARS).toBe(139810136);
	});
	it("WS maxPayload 与上传 cap 对齐（非 256MB）", () => {
		expect(WS_MAX_PAYLOAD_BYTES).toBe(MAX_UPLOAD_BASE64_CHARS + 1024 * 1024);
		expect(WS_MAX_PAYLOAD_BYTES).toBeLessThan(256 * 1024 * 1024);
		expect(WS_MAX_PAYLOAD_BYTES).toBeGreaterThan(MAX_UPLOAD_BASE64_CHARS);
	});
});
