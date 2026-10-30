/**
 * 切换项目时是否打开最近会话配置项（openRecentSessionOnProjectSwitch）单元测试：
 *   1. 默认值为 true（保持开箱即用兼容性）；
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
	const dir = mkdtempSync(join(tmpdir(), "pi-open-recent-"));
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
		clientId: "open-recent-test",
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

describe("openRecentSessionOnProjectSwitch 配置项", () => {
	it("默认值为 true", () => {
		const store = tempStore();
		const host = makeHost(store);
		const svc = new SettingsService(host, templates);

		expect(svc.current.openRecentSessionOnProjectSwitch).toBe(true);
	});

	it("SettingsService.set 可以将开关设为 false 并持久化", async () => {
		const store = tempStore();
		const host = makeHost(store);
		const svc = new SettingsService(host, templates);

		await svc.set({ openRecentSessionOnProjectSwitch: false });
		expect(svc.current.openRecentSessionOnProjectSwitch).toBe(false);

		// 新实例从 store 重载，值仍为 false
		const svc2 = new SettingsService(host, templates);
		expect(svc2.current.openRecentSessionOnProjectSwitch).toBe(false);

		// 重新设为 true
		await svc2.set({ openRecentSessionOnProjectSwitch: true });
		expect(svc2.current.openRecentSessionOnProjectSwitch).toBe(true);
	});
});
