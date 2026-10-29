/**
 * 全局默认模型服务端单测：存取 + 清除 + key 记忆跟随 + 删除改指。
 * 不起 server、不碰网络，纯 ClientStateStore 状态。
 *
 * 语义回顾（contract）：新项目回落链 = 项目记忆 projectModels[cwd]
 *  > 全局默认 defaultModel（__settings__ 键，全客户端共享）
 *  > SDK 默认。key 记忆同理（projectProviderKeys > defaultProviderKeys）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientStateStore } from "../../server/client-state.js";

let dir: string;
let store: ClientStateStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "default-model-test-"));
	store = new ClientStateStore(join(dir, "client-state.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("全局默认模型", () => {
	it("初始未设置", () => {
		expect(store.getDefaultModel()).toBeUndefined();
		expect(store.getDefaultProviderKey("anthropic")).toBeUndefined();
	});

	it("设置/读取/清除", () => {
		store.saveDefaultModel("anthropic/claude-sonnet-5");
		expect(store.getDefaultModel()).toBe("anthropic/claude-sonnet-5");
		// 覆盖
		store.saveDefaultModel("openai/gpt-5");
		expect(store.getDefaultModel()).toBe("openai/gpt-5");
		// 清除连带 key 记忆
		store.saveDefaultProviderKey("openai", "密钥 1");
		store.clearDefaultModel();
		expect(store.getDefaultModel()).toBeUndefined();
		expect(store.getDefaultProviderKey("openai")).toBeUndefined();
	});

	it("key 记忆随全局默认一起记", () => {
		store.saveDefaultModel("anthropic/claude-sonnet-5");
		store.saveDefaultProviderKey("anthropic", "密钥 2");
		expect(store.getDefaultProviderKey("anthropic")).toBe("密钥 2");
		// 别的 provider 不受影响
		expect(store.getDefaultProviderKey("openai")).toBeUndefined();
	});

	it("项目记忆与全局默认互不干扰", () => {
		store.saveProjectModel("tab1", "/proj/a", "openai/gpt-5");
		store.saveDefaultModel("anthropic/claude-sonnet-5");
		expect(store.getProjectModel("tab1", "/proj/a")).toBe("openai/gpt-5");
		expect(store.getDefaultModel()).toBe("anthropic/claude-sonnet-5");
		// 删项目记忆不碰全局
		store.deleteProjectModel("tab1", "/proj/a");
		expect(store.getProjectModel("tab1", "/proj/a")).toBeUndefined();
		expect(store.getDefaultModel()).toBe("anthropic/claude-sonnet-5");
	});

	it("跨实例持久化（重启不丢）", () => {
		store.saveDefaultModel("anthropic/claude-sonnet-5");
		store.saveDefaultProviderKey("anthropic", "密钥 1");
		const reopened = new ClientStateStore(join(dir, "client-state.json"));
		expect(reopened.getDefaultModel()).toBe("anthropic/claude-sonnet-5");
		expect(reopened.getDefaultProviderKey("anthropic")).toBe("密钥 1");
	});
});

describe("全局默认 key 删除跟随", () => {
	it("被删的 key 指到接替者", () => {
		store.saveDefaultProviderKey("openai", "密钥 1");
		store.repointDeletedKeyInDefault("openai", "密钥 1", "密钥 2");
		expect(store.getDefaultProviderKey("openai")).toBe("密钥 2");
	});

	it("无接替则删引用", () => {
		store.saveDefaultProviderKey("openai", "密钥 1");
		store.repointDeletedKeyInDefault("openai", "密钥 1", null);
		expect(store.getDefaultProviderKey("openai")).toBeUndefined();
	});

	it("名字对不上时不碰", () => {
		store.saveDefaultProviderKey("openai", "密钥 1");
		store.repointDeletedKeyInDefault("openai", "密钥 X", "密钥 2");
		expect(store.getDefaultProviderKey("openai")).toBe("密钥 1");
		store.repointDeletedKeyInDefault("anthropic", "密钥 1", "密钥 2");
		expect(store.getDefaultProviderKey("openai")).toBe("密钥 1");
	});
});
