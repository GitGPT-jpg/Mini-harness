/**
 * `desktop/external-url.ts` allowlist 单测：放行 `http/https/mailto/tel`，
 * 拦截 `file/javascript/data/ftp/自定义协议/非法串`。
 */
import { describe, expect, it } from "vitest";
import { isAllowedExternalUrl } from "../../desktop/external-url.js";

describe("isAllowedExternalUrl", () => {
	it("放行 http/https（含大写 scheme）", () => {
		expect(isAllowedExternalUrl("http://example.com/a")).toBe(true);
		expect(isAllowedExternalUrl("https://example.com/a?b=1#x")).toBe(true);
		expect(isAllowedExternalUrl("HTTP://EXAMPLE.COM/")).toBe(true);
		expect(isAllowedExternalUrl("  https://example.com/  ")).toBe(true);
	});

	it("放行 Markdown 已当外链的 mailto/tel", () => {
		expect(isAllowedExternalUrl("mailto:a@b.com")).toBe(true);
		expect(isAllowedExternalUrl("tel:+18001234567")).toBe(true);
	});

	it("拦截危险 scheme", () => {
		expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);
		expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
		expect(isAllowedExternalUrl("data:text/html,<h1>x</h1>")).toBe(false);
		expect(isAllowedExternalUrl("ftp://example.com/a")).toBe(false);
		expect(isAllowedExternalUrl("myapp://open?x=1")).toBe(false);
	});

	it("空串与非法串一律拦截", () => {
		expect(isAllowedExternalUrl("")).toBe(false);
		expect(isAllowedExternalUrl("   ")).toBe(false);
		expect(isAllowedExternalUrl("not a url")).toBe(false);
	});
});
