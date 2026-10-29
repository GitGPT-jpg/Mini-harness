/**
 * 全局运行态单测：默认值、合并写入、无变化不通知、订阅/退订、重置。
 * 只测数据面（hook 需要 React 运行时，e2e 覆盖）。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	appSend,
	DEFAULT_APP_GLOBALS,
	DEFAULT_ENGINE_CAPABILITIES,
	getAppGlobals,
	resetAppGlobals,
	setAppGlobals,
	setAppSend,
	subscribeAppGlobals,
	type AppGlobals,
} from "../../web/src/app-globals.js";

afterEach(() => {
	resetAppGlobals();
	setAppSend(null);
});

describe("app-globals", () => {
	it("默认值：pi 引擎、非受管、未连接/未就绪、无工作目录、无 tabs / 版本号", () => {
		resetAppGlobals();
		expect(getAppGlobals()).toBe(DEFAULT_APP_GLOBALS);
		expect(getAppGlobals().engine).toBe("pi");
		expect(getAppGlobals().managed).toBe(false);
		expect(getAppGlobals().status).toBe("connecting");
		expect(getAppGlobals().ready).toBe(false);
		expect(getAppGlobals().cwd).toBe("");
		expect(getAppGlobals().tabs).toBeUndefined();
	});

	it("连接态与工作目录：逐字段变化才算变更（切项目只动 cwd）", () => {
		let hits = 0;
		const off = subscribeAppGlobals(() => hits++);
		setAppGlobals({ status: "open", ready: true, cwd: "/w/a" });
		const a = getAppGlobals();
		expect(hits).toBe(1);

		setAppGlobals({ cwd: "/w/b" }); // 切项目：ready/status 保持不变
		expect(getAppGlobals()).not.toBe(a);
		expect(getAppGlobals().ready).toBe(true);
		expect(getAppGlobals().cwd).toBe("/w/b");
		expect(hits).toBe(2);

		setAppGlobals({ cwd: "/w/b", ready: true }); // 同值重写：静默
		expect(hits).toBe(2);
		off();
	});

	it("合并写入：只覆盖传入字段，引用整体替换（useSyncExternalStore 靠它判定变化）", () => {
		setAppGlobals({ engine: "dsh", appVersion: "1.2.3" });
		const a = getAppGlobals();
		expect(a.engine).toBe("dsh");
		expect(a.appVersion).toBe("1.2.3");
		expect(a.managed).toBe(false);

		setAppGlobals({ managed: true });
		const b = getAppGlobals();
		expect(b).not.toBe(a);
		expect(b.engine).toBe("dsh"); // 未传的字段保留
		expect(b.managed).toBe(true);
	});

	it("字段无变化（含同内容的新数组）不替换引用、不通知 —— 重连重放 ready 不白刷一遍", () => {
		let hits = 0;
		const off = subscribeAppGlobals(() => hits++);

		setAppGlobals({ engine: "dsh", tabs: ["chat", "terminal"] });
		const a = getAppGlobals();
		expect(hits).toBe(1);

		setAppGlobals({ engine: "dsh", tabs: ["chat", "terminal"] }); // 等价的新数组
		expect(getAppGlobals()).toBe(a);
		expect(hits).toBe(1);

		setAppGlobals({ tabs: ["chat"] }); // 元素不同才算变化
		expect(getAppGlobals()).not.toBe(a);
		expect(hits).toBe(2);

		off();
		setAppGlobals({ engine: "pi" });
		expect(hits).toBe(2); // 退订后不再收到
	});

	it("引擎缺省回落到 pi（老服务端不发 engine 字段）", () => {
		setAppGlobals({ engine: "pi" });
		expect(getAppGlobals().engine).toBe("pi");
		// 同 use-chat 的 ready 处理：msg.engine 缺失时传 "pi"
		const ready: { engine?: string } = {};
		setAppGlobals({ engine: ready.engine ?? "pi" });
		expect(getAppGlobals().engine).toBe("pi");
	});

	it("完整 ready 载荷落地", () => {
		const patch: Partial<AppGlobals> = {
			engine: "dsh",
			managed: true,
			tabs: ["chat", "git"],
			appVersion: "0.77.0",
			serverVersion: "0.60.0",
		};
		setAppGlobals(patch);
		expect(getAppGlobals()).toEqual({ ...DEFAULT_APP_GLOBALS, ...patch });
	});

	it("reset 回到默认（测试隔离用）", () => {
		setAppGlobals({ engine: "dsh", managed: true });
		resetAppGlobals();
		expect(getAppGlobals()).toBe(DEFAULT_APP_GLOBALS);
	});

	it("引擎状态：updating / hasUpdate / latestVersion 变化必须落地（否则「正在更新」永远看不到）", () => {
		let hits = 0;
		const off = subscribeAppGlobals(() => hits++);
		const base = { id: "pi", installed: true, version: "1.0.0", packageName: "@earendil-works/pi-coding-agent" };
		setAppGlobals({ engines: [{ ...base }] });
		expect(hits).toBe(1);

		// 同版本、仅 updating 翻转：曾经被 sameEngines 的 4 字段白名单判为「没变」而丢弃
		setAppGlobals({ engines: [{ ...base, updating: true }] });
		expect(getAppGlobals().engines?.[0].updating).toBe(true);
		expect(hits).toBe(2);

		setAppGlobals({ engines: [{ ...base, latestVersion: "1.1.0", hasUpdate: true }] });
		expect(getAppGlobals().engines?.[0].hasUpdate).toBe(true);
		expect(hits).toBe(3);

		// 完全等价的新对象：不白刷
		setAppGlobals({ engines: [{ ...base, latestVersion: "1.1.0", hasUpdate: true }] });
		expect(hits).toBe(3);
		off();
	});

	it("能力声明：steer / ephemeralChat 也算字段（切换引擎后输入框行为不能沿用旧值）", () => {
		const caps = { ...DEFAULT_ENGINE_CAPABILITIES };
		setAppGlobals({ engineCapabilities: caps });
		expect(getAppGlobals().engineCapabilities.steer).toBe(true);

		setAppGlobals({ engineCapabilities: { ...caps, steer: false } });
		expect(getAppGlobals().engineCapabilities.steer).toBe(false);

		setAppGlobals({ engineCapabilities: { ...caps, steer: false, ephemeralChat: false } });
		expect(getAppGlobals().engineCapabilities.ephemeralChat).toBe(false);
	});
});

describe("appSend（全局发送器）", () => {
	it("未装配时返回 false（不是抛错）—— 与 send 未连接时的语义一致", () => {
		setAppSend(null);
		expect(appSend({ type: "get_state" })).toBe(false);
	});

	it("装配后原样转发，并回传实现的结果", () => {
		const seen: unknown[] = [];
		setAppSend((msg) => {
			seen.push(msg);
			return true;
		});
		expect(appSend({ type: "abort" })).toBe(true);
		expect(seen).toEqual([{ type: "abort" }]);

		setAppSend(() => false); // 连接已断：组件据此决定不清理草稿
		expect(appSend({ type: "abort" })).toBe(false);
	});
});
