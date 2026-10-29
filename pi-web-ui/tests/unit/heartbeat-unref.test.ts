/**
 * Heartbeat unref 回归：全局 heartbeat interval 必须 unref，否则它 alone
 * 就能吊住 event loop，空闲进程无法自然退出（shutdown watchdog 被迫强制退出）。
 * 静态断言：只读 server/index.ts 文本，毫秒级、零端口。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INDEX = join(ROOT, "server", "index.ts");

describe("heartbeat unref", () => {
	it("heartbeatTimer 存在且已 unref（空闲不吊住进程）", () => {
		const src = readFileSync(INDEX, "utf8");
		expect(src).toContain("const heartbeatTimer = setInterval(");
		expect(src).toMatch(/heartbeatTimer\.unref\?\.\(\)/);
	});

	it("shutdown 路径仍 clearInterval(heartbeatTimer)", () => {
		const src = readFileSync(INDEX, "utf8");
		expect(src).toContain("clearInterval(heartbeatTimer)");
	});
});
