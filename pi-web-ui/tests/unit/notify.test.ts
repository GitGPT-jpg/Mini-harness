/**
 * 桌面通知纯函数单测（web/src/notify.ts）。
 *
 * 重点锁「抑制条件」：什么时候允许静默吞掉一条通知。
 * 这里的判据全部来自 Windows 实测（Win11 + Edge/Chrome，2026-09）：
 * 窗口最小化后 `document.hasFocus()` 仍是 true、`visibilityState` 仍是
 * "visible"，连 blur/visibilitychange 都不发 —— 只有原生窗口矩形会变
 * （screenX/screenY 飞到屏幕外的「最小化坐标」、outerWidth/Height 塌成标题栏）。
 * 之前「只看焦点」和「焦点 + 可见」两版都在最小化场景下把通知全吞了。
 */
import { describe, expect, it } from "vitest";
import {
	idleSinceLastActivityMs,
	isCollapsedWindow,
	isWindowsPlatform,
	markActivity,
	notifyBlockReason,
	notificationsSupported,
	NOTIFY_IDLE_GRACE_MS,
	shouldSuppressNotify,
	type PresenceSignals,
} from "../../web/src/notify.js";

const presence = (patch: Partial<PresenceSignals> = {}): PresenceSignals => ({
	hasFocus: true,
	visibility: "visible",
	minimized: false,
	idleMs: 0,
	windows: false,
	...patch,
});

describe("isCollapsedWindow", () => {
	it("Windows 实测的最小化矩形 → 判定为最小化", () => {
		// Edge：screenX/Y = -21334，outerW/H 塌成 108×20。
		expect(isCollapsedWindow({ screenX: -21334, screenY: -21333, outerWidth: 108, outerHeight: 20 })).toBe(true);
		// Chrome：Win32 最小化坐标 -32000。
		expect(isCollapsedWindow({ screenX: -32000, screenY: -32000, outerWidth: 160, outerHeight: 28 })).toBe(true);
	});

	it("普通窗口（包括屏幕左侧的多显示器布局）不算最小化", () => {
		expect(isCollapsedWindow({ screenX: 10, screenY: 10, outerWidth: 1296, outerHeight: 808 })).toBe(false);
		// 三台 4K 往左堆叠 ≈ -11520，阈值 -10000 以内不能误判成最小化。
		expect(isCollapsedWindow({ screenX: -5760, screenY: 0, outerWidth: 1296, outerHeight: 808 })).toBe(false);
		expect(isCollapsedWindow({ screenX: 0, screenY: -2160, outerWidth: 1296, outerHeight: 808 })).toBe(false);
	});

	it("只有高度塌陷、坐标缺失时也不得抛错（按未最小化处理）", () => {
		expect(isCollapsedWindow({ screenX: NaN, screenY: NaN, outerWidth: 600, outerHeight: 400 })).toBe(false);
	});

	it("量不到窗口的环境（headless 报 0×0）不算最小化", () => {
		expect(isCollapsedWindow({ screenX: 0, screenY: 0, outerWidth: 0, outerHeight: 0 })).toBe(false);
	});
});

describe("shouldSuppressNotify", () => {
	it("最小化（Windows 上焦点/可见性都在骗人）→ 必须通知", () => {
		// 核心回归：这条组合就是最小化窗口的真实快照。
		expect(shouldSuppressNotify(presence({ minimized: true, windows: true }))).toBe(false);
	});

	it("页面不可见（后台标签 / 遮挡）→ 通知", () => {
		expect(shouldSuppressNotify(presence({ visibility: "hidden" }))).toBe(false);
	});

	it("失去焦点（切到别的应用）→ 通知", () => {
		expect(shouldSuppressNotify(presence({ hasFocus: false }))).toBe(false);
	});

	it("有焦点 + 可见 + 刚操作过 = 用户正在看，吞掉通知（改由提示音负责）", () => {
		expect(shouldSuppressNotify(presence({ windows: true, idleMs: 3000 }))).toBe(true);
	});

	it("Windows：长时间没操作页面 → 不再相信「有焦点」，照常通知", () => {
		expect(shouldSuppressNotify(presence({ windows: true, idleMs: NOTIFY_IDLE_GRACE_MS + 1 }))).toBe(false);
	});

	it("非 Windows：焦点/可见性可信，空闲多久都按「在看」处理（不改变原有行为）", () => {
		expect(shouldSuppressNotify(presence({ windows: false, idleMs: 60 * 60 * 1000 }))).toBe(true);
	});

	it("未知/缺失的可见性状态按「不可见」处理（宁可多提醒也不静默）", () => {
		expect(shouldSuppressNotify(presence({ visibility: "prerender" }))).toBe(false);
		expect(shouldSuppressNotify(presence({ visibility: "" }))).toBe(false);
	});
});

describe("用户活动计时", () => {
	it("markActivity 会把空闲计时清零（feed 给 Windows 的兜底判据）", () => {
		markActivity();
		expect(idleSinceLastActivityMs()).toBeLessThan(200);
	});
});

describe("notifyBlockReason", () => {
	it("非浏览器环境（无 window）→ 判为不支持，而不是安全上下文问题", () => {
		// node 单测环境没有 window / Notification。
		expect(notificationsSupported()).toBe(false);
		expect(notifyBlockReason()).toBe("unsupported");
	});
});

describe("isWindowsPlatform", () => {
	it("node 环境无 navigator → false（不误报平台提示）", () => {
		expect(isWindowsPlatform()).toBe(false);
	});
});
