import { describe, expect, it } from "vitest";
import { esc, apiBase, formatBytes, withTimeout, uuid, normalizeRel, hostApi } from "../../plugin-sdk/client-utils.mjs";

describe("plugin-sdk client-utils", () => {
	it("esc: 安全转义 HTML 特殊字符", () => {
		expect(esc("<script>alert('xss') & \"test\"</script>")).toBe(
			"&lt;script&gt;alert(&#39;xss&#39;) &amp; &quot;test&quot;&lt;/script&gt;",
		);
		expect(esc(null)).toBe("");
		expect(esc(undefined)).toBe("");
		expect(esc(123)).toBe("123");
	});

	it("apiBase: 拼接插件路由基路径", () => {
		expect(apiBase("my-plugin")).toBe("/plugins-api/my-plugin");
	});

	it("formatBytes: 字节大小格式化", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
		expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe("2.5 GB");
		expect(formatBytes(-10)).toBe("");
		expect(formatBytes("invalid")).toBe("");
	});

	it("withTimeout: 正确超时或返回", async () => {
		const fast = withTimeout(Promise.resolve("ok"), 100);
		await expect(fast).resolves.toBe("ok");

		const slow = new Promise((resolve) => setTimeout(resolve, 200));
		await expect(withTimeout(slow, 50, "timed out")).rejects.toThrow("timed out");
	});

	it("uuid: 生成有效 UUID 格式", () => {
		const id = uuid();
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
	});

	it("normalizeRel: 归一化相对路径", () => {
		expect(normalizeRel("foo\\bar")).toBe("foo/bar");
		expect(normalizeRel("./foo/bar/")).toBe("foo/bar");
		expect(normalizeRel("/foo/bar")).toBe("foo/bar");
	});

	it("hostApi: 非浏览器环境安全返回 null", () => {
		expect(hostApi()).toBeNull();
	});
});
