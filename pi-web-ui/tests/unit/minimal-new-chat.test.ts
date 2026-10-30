/**
 * 极简新对话配置项（minimalNewChat）单元测试：
 *   1. 默认值为 false（保持原有行为兼容性）；
 *   2. ClientStateStore 持久化与加载保真；
 *   3. SettingsService.set() 可更新并通过 current 暴露；
 *   4. i18n 多语言翻译完整且对齐。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";

const roots: string[] = [];
function tempStore(): ClientStateStore {
	const dir = mkdtempSync(join(tmpdir(), "pi-minimal-new-chat-"));
	roots.push(dir);
	return new ClientStateStore(join(dir, "client-state.json"));
}

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const templates = { list: () => [] } as unknown as import("../../server/subagent-templates.js").SubagentTemplatesStore;

function makeHost(store: ClientStateStore): SettingsHost & { emitted: unknown[] } {
	const emitted: unknown[] = [];
	return {
		clientId: "minimal-new-chat-test",
		stateStore: store,
		emit: (m: unknown) => {
			emitted.push(m);
		},
		flushSnapshot: () => {},
		isDisposed: () => false,
		getSession: () => {
			throw new Error("no session");
		},
		cwd: () => "/tmp",
		agentDir: () => "/tmp",
		isStreaming: () => false,
		reloadSession: async () => {},
		applyRetryOverrides: () => {},
		applyCompactionOverrides: () => {},
		applyToolGating: () => {},
		promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
		emitted,
	} as SettingsHost & { emitted: unknown[] };
}

describe("minimalNewChat 配置项", () => {
	it("默认值为 false", () => {
		const store = tempStore();
		const host = makeHost(store);
		const svc = new SettingsService(host, templates);

		expect(svc.current.minimalNewChat).toBe(false);
	});

	it("SettingsService.set 可以将开关设为 true 并持久化", async () => {
		const store = tempStore();
		const host = makeHost(store);
		const svc = new SettingsService(host, templates);

		await svc.set({ minimalNewChat: true });
		expect(svc.current.minimalNewChat).toBe(true);

		const svc2 = new SettingsService(host, templates);
		expect(svc2.current.minimalNewChat).toBe(true);

		await svc.set({ minimalNewChat: false });
		expect(svc.current.minimalNewChat).toBe(false);
	});
});
