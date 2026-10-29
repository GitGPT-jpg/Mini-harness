import { describe, expect, it } from "vitest";
import { isTouchFirstDevice, type TouchEnv } from "../../web/src/touch-device.js";

/**
 * 回车语义 = f(设备类型)：触屏优先设备回车换行，其余回车发送。
 *
 * 回归重点：Windows 触屏笔记本 / 二合一的主指针常被判成 `(pointer: coarse)`，
 * 但它们有物理键盘，回车必须发送 —— 只看 coarse 会让这些用户“回车只换行、
 * 发不出去”（用户实测反馈）。
 */
const env = (pointer: "coarse" | "fine", hover: "none" | "hover", userAgent: string, maxTouchPoints = 0): TouchEnv => ({
	query: (media) =>
		media === "(pointer: coarse)" ? pointer === "coarse" : media === "(hover: none)" ? hover === "none" : false,
	userAgent,
	maxTouchPoints,
});

const IPHONE =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const ANDROID =
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const WIN =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAC =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CROS =
	"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

describe("touch-first device detection", () => {
	it("手机/平板（粗指针 + 无 hover）走换行语义", () => {
		expect(isTouchFirstDevice(env("coarse", "none", IPHONE, 5))).toBe(true);
		expect(isTouchFirstDevice(env("coarse", "none", ANDROID, 5))).toBe(true);
		expect(isTouchFirstDevice(env("coarse", "none", IPAD, 5))).toBe(true);
	});

	it("Windows 触屏设备（粗指针）仍然按桌面处理：回车发送", () => {
		// 用户实测：Windows 二合一被判 coarse，回车只换行 → 必须排除 Windows。
		expect(isTouchFirstDevice(env("coarse", "none", WIN, 10))).toBe(false);
		expect(isTouchFirstDevice(env("coarse", "hover", WIN, 10))).toBe(false);
	});

	it("桌面系统（鼠标/触控板）不换行", () => {
		expect(isTouchFirstDevice(env("fine", "hover", MAC, 0))).toBe(false);
		expect(isTouchFirstDevice(env("fine", "hover", WIN, 0))).toBe(false);
		expect(isTouchFirstDevice(env("coarse", "hover", LINUX, 0))).toBe(false);
		expect(isTouchFirstDevice(env("coarse", "none", LINUX, 0))).toBe(false); // Linux 桌面
		expect(isTouchFirstDevice(env("coarse", "none", CROS, 0))).toBe(false); // Chromebook 有键盘
	});

	it("iPad 伪装成 Macintosh 时靠 maxTouchPoints 区分", () => {
		expect(isTouchFirstDevice(env("coarse", "none", MAC, 0))).toBe(false); // 真 Mac
		expect(isTouchFirstDevice(env("coarse", "none", MAC, 5))).toBe(true); // iPad
	});

	it("拿不到 matchMedia 的环境一律按桌面（可发送）", () => {
		expect(isTouchFirstDevice({ userAgent: IPHONE })).toBe(false);
	});
});
