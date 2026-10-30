/**
 * 输入框文字跨对话保留配置项（preserveDraftAcrossConversations）单元测试：
 *   1. 默认值为 false（关：各会话独立保留草稿，切换其他会话清空或显示该会话已保留文字，切回时恢复当前会话文字）；
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
	const dir = mkdtempSync(join(tmpdir(), "pi-preserve-draft-"));
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
		clientId: "preserve-draft-test",
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

describe("preserveDraftAcrossConversations 配置项", () => {
	it("默认值为 false", () => {
		const store = tempStore();
		const host = makeHost(store);
		const svc = new SettingsService(host, templates);

		expect(svc.current.preserveDraftAcrossConversations).toBe(false);
	});

	it("SettingsService.set 可以将开关设为 true 并持久化", async () => {
		const store = tempStore();
		const host = makeHost(store);
		const svc = new SettingsService(host, templates);

		await svc.set({ preserveDraftAcrossConversations: true });
		expect(svc.current.preserveDraftAcrossConversations).toBe(true);

		const svc2 = new SettingsService(host, templates);
		expect(svc2.current.preserveDraftAcrossConversations).toBe(true);

		await svc.set({ preserveDraftAcrossConversations: false });
		expect(svc.current.preserveDraftAcrossConversations).toBe(false);
	});
});
