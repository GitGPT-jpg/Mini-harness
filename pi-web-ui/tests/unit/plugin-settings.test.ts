/**
 * 插件声明式设置（manifest "settings" schema）单测：schema 解析校验、
 * 默认值合并、savePluginSettings 持久化 + 通知、host.getSettings 读取。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager, type PluginHost } from "../../server/plugins.js";

let dir: string;
let mgr: PluginManager;

function makePlugin(id: string, manifest: Record<string, unknown>): Promise<PluginHost> {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id, ...manifest }));
	writeFileSync(
		join(pdir, "index.mjs"),
		`export default { activate(h) { (globalThis.__hosts ??= {})["${id}"] = h; } };`,
	);
	return mgr.ensureLoaded().then(() => (globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts[id]!);
}

const SCHEMA_PLUGIN = {
	settings: [
		{ key: "pollSec", type: "number", label: "间隔", default: 60, min: 10, max: 600 },
		{ key: "notify", type: "boolean", label: "通知", default: true },
		{ key: "theme", type: "select", label: "主题", default: "dark", options: ["dark", "light"] },
		{ key: "name", type: "text", label: "名字", default: "demo" },
		{ key: "pass", type: "password", label: "口令", default: "" },
	],
};
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-settings-test-"));
	mgr = new PluginManager(dir, dir);
});

afterEach(() => {
	mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("schema 解析 + 默认值", () => {
	it("清单带 schema 与默认合并后的值", async () => {
		await makePlugin("cfg", SCHEMA_PLUGIN);
		const list = await mgr.list();
		const p = list.find((x) => x.id === "cfg")!;
		expect(p.settingsSchema?.length).toBe(5);
		expect(p.settingsValues).toEqual({ pollSec: 60, notify: true, theme: "dark", name: "demo", pass: "" });
		// 没装过 → storage.json 不存在
		expect(existsSync(join(dir, "plugins", "cfg", "storage.json"))).toBe(false);
	});

	it("坏字段被跳过（非法 type / 重复 key / 缺 key）", async () => {
		await makePlugin("bad", {
			settings: [
				{ key: "ok", type: "boolean", label: "OK" },
				{ key: "x", type: "unknown", label: "坏类型" },
				{ key: "ok", type: "text", label: "重复" },
				{ type: "text", label: "缺 key" },
			],
		});
		const list = await mgr.list();
		const p = list.find((x) => x.id === "bad")!;
		expect(p.settingsSchema?.map((f) => f.key)).toEqual(["ok"]);
	});
});

describe("optionsFrom（select 候选值由宿主动态提供）", () => {
	const DYNAMIC_PLUGIN = {
		settings: [
			{ key: "model", type: "select", optionsFrom: "models", label: "模型", default: "" },
			{ key: "thinking", optionsFrom: "thinkingLevels", label: "思考强度", default: "" },
			{ key: "bogus", type: "select", optionsFrom: "wat", label: "坏源", options: ["a"] },
		],
	};

	it("合法源透传到清单；非法源当没写（回落静态 options）；只给 optionsFrom 没给 type 视为 select", async () => {
		await makePlugin("dyn", DYNAMIC_PLUGIN);
		const list = await mgr.list();
		const p = list.find((x) => x.id === "dyn")!;
		expect(p.settingsSchema?.map((f) => [f.key, f.type, f.optionsFrom])).toEqual([
			["model", "select", "models"],
			["thinking", "select", "thinkingLevels"],
			["bogus", "select", undefined],
		]);
		expect(p.settingsValues).toEqual({ model: "", thinking: "", bogus: undefined });
	});

	it("动态字段不做候选值校验（清单在浏览器侧现算），落盘后回读一致", async () => {
		const h = await makePlugin("dyn", DYNAMIC_PLUGIN);
		expect(mgr.savePluginSettings("dyn", { model: "xai/grok-4", thinking: "high" }).error).toBeUndefined();
		expect(h.getSettings().model).toBe("xai/grok-4");
		expect(h.getSettings().thinking).toBe("high");
		// 换一个未在清单里的值也能存（模型被删掉/改过供应商时不该卡住）
		expect(mgr.savePluginSettings("dyn", { model: "gone/model" }).error).toBeUndefined();
		expect(h.getSettings().model).toBe("gone/model");
		// 每次保存都会写入整份 schema（与前端一次性提交整张表单同口径），
		// 所以只传 model 的那次会让 thinking 回落默认空串。
		expect(JSON.parse(readFileSync(join(dir, "plugins", "dyn", "storage.json"), "utf8")).settings).toEqual({
			model: "gone/model",
			thinking: "",
		});
		// 只做长度护栏（防手写 storage.json 塞垃圾）
		expect(mgr.savePluginSettings("dyn", { model: "x".repeat(300) }, () => "zh").error).toContain("过长");
		expect(h.getSettings().model).toBe("gone/model");
	});
});

describe("savePluginSettings", () => {
	it("校验 + 原子落盘 + 保留 storage.json 其它键", async () => {
		const h = await makePlugin("cfg", SCHEMA_PLUGIN);
		h.storage.set("custom", 42); // 插件自己的键
		const r = mgr.savePluginSettings("cfg", {
			pollSec: 120,
			notify: false,
			theme: "light",
			name: "prod",
			pass: "s3cret",
		});
		expect(r.error).toBeUndefined();
		const raw = JSON.parse(readFileSync(join(dir, "plugins", "cfg", "storage.json"), "utf8"));
		expect(raw.settings).toEqual({ pollSec: 120, notify: false, theme: "light", name: "prod", pass: "s3cret" });
		expect(raw.custom).toBe(42); // 插件数据不被覆盖
		// 重扫后默认值已被存值覆盖
		const list = await mgr.list();
		expect(list.find((x) => x.id === "cfg")?.settingsValues).toEqual({
			pollSec: 120,
			notify: false,
			theme: "light",
			name: "prod",
			pass: "s3cret",
		});
	});

	it("number 越界 / select 非法值被拒", async () => {
		await makePlugin("cfg", SCHEMA_PLUGIN);
		// issue #91：默认英文
		expect(mgr.savePluginSettings("cfg", { pollSec: 5 }).error).toContain("out of range");
		expect(mgr.savePluginSettings("cfg", { pollSec: 5 }, () => "zh").error).toContain("超出范围");
		expect(mgr.savePluginSettings("cfg", { pollSec: 9999 }, () => "zh").error).toContain("超出范围");
		expect(mgr.savePluginSettings("cfg", { theme: "neon" }, () => "zh").error).toContain("值非法");
		// 合法保存不受影响
		expect(mgr.savePluginSettings("cfg", { pollSec: 30 }).error).toBeUndefined();
	});

	it("未声明 schema 的插件保存被拒", async () => {
		await makePlugin("noschema", { permissions: ["tools"] });
		expect(mgr.savePluginSettings("noschema", { a: 1 }, () => "zh").error).toContain("没有声明式设置");
	});
});

describe("host.getSettings + onSettingsChanged", () => {
	it("getSettings 实时反映存值；onSettingsChanged 在保存后触发", async () => {
		const h = await makePlugin("cfg", SCHEMA_PLUGIN);
		expect(h.getSettings().pollSec).toBe(60); // 默认
		const received: unknown[] = [];
		const off = h.onSettingsChanged((v) => received.push(v));
		mgr.savePluginSettings("cfg", { pollSec: 90 });
		expect(received).toEqual([{ pollSec: 90, notify: true, theme: "dark", name: "demo", pass: "" }]);
		expect(h.getSettings().pollSec).toBe(90);
		off();
		mgr.savePluginSettings("cfg", { pollSec: 100 });
		expect(received).toHaveLength(1); // 注销后不再触发
	});
});

describe("secret 类型（P0-4 加密存、浏览器只见有无）", () => {
	const SECRET_PLUGIN = {
		settings: [
			{ key: "apiKey", type: "secret", label: "API 密钥" },
			{ key: "name", type: "text", label: "名字", default: "demo" },
		],
	};
	it("清单 settingsValues：secret 只给有无布尔，不给明文", async () => {
		await makePlugin("sec", SECRET_PLUGIN);
		const list = await mgr.list();
		expect(list.find((x) => x.id === "sec")!.settingsValues).toEqual({ apiKey: false, name: "demo" });
	});
	it("保存 secret → getSettings 给真值；磁盘无明文；空串不改", async () => {
		const h = await makePlugin("sec", SECRET_PLUGIN);
		expect(mgr.savePluginSettings("sec", { apiKey: "sk-live-123" }).error).toBeUndefined();
		expect(h.getSettings().apiKey).toBe("sk-live-123");
		// 浏览器侧仍是有无布尔
		const list = await mgr.list();
		expect(list.find((x) => x.id === "sec")!.settingsValues?.apiKey).toBe(true);
		// storage.json 里没有明文
		const raw = readFileSync(join(dir, "plugins", "sec", "storage.json"), "utf8");
		expect(raw).not.toContain("sk-live-123");
		expect(JSON.parse(raw).settings).toEqual({ name: "demo" });
		// 空串 = 不改
		expect(mgr.savePluginSettings("sec", { apiKey: "" }).error).toBeUndefined();
		expect(h.getSettings().apiKey).toBe("sk-live-123");
		// 覆盖
		expect(mgr.savePluginSettings("sec", { apiKey: "sk-new" }).error).toBeUndefined();
		expect(h.getSettings().apiKey).toBe("sk-new");
		// 超长拒绝
		expect(mgr.savePluginSettings("sec", { apiKey: "x".repeat(5000) }, () => "zh").error).toContain("过长");
		expect(h.getSettings().apiKey).toBe("sk-new");
	});
	it("onSettingsChanged 收到的 clean 含 secret 真值（插件可用，但不下发浏览器）", async () => {
		const h = await makePlugin("sec", SECRET_PLUGIN);
		const received: unknown[] = [];
		h.onSettingsChanged((v) => received.push(v));
		mgr.savePluginSettings("sec", { apiKey: "sk-abc" });
		expect(received).toEqual([{ apiKey: "sk-abc", name: "demo" }]);
	});
});
