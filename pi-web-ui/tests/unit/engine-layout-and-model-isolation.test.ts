import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";
import { UniversalSession } from "../../server/universal/universal-session.js";
import { UniversalSessionStore } from "../../server/universal/session-store.js";
import { MockAgentDriver } from "../../server/universal/drivers/mock-driver.js";
import type { ServerMessage } from "../../server/protocol.js";

describe("engine layout sharing, history transition and model isolation", () => {
	let testDir: string;
	let stateStore: ClientStateStore;
	let universalStore: UniversalSessionStore;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-engine-test-"));
		stateStore = new ClientStateStore(testDir);
		universalStore = new UniversalSessionStore(testDir);
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			/* ignore cleanup errors */
		}
	});

	describe("per-engine model isolation in ClientStateStore", () => {
		it("isolates project model memory per engine on the same workspace", () => {
			const clientId = "client-alpha";
			const cwd = join(testDir, "workspace-1");

			// 分别为 pi, dsh, claude 保存不同的模型
			stateStore.saveProjectModel(clientId, cwd, "anthropic/claude-3-7-sonnet", "pi");
			stateStore.saveProjectModel(clientId, cwd, "deepseek/deepseek-chat", "dsh");
			stateStore.saveProjectModel(clientId, cwd, "claude-code/claude-3-5-sonnet", "claude");

			// 读出时各归各，绝不互相覆盖
			expect(stateStore.getProjectModel(clientId, cwd, "pi")).toBe("anthropic/claude-3-7-sonnet");
			expect(stateStore.getProjectModel(clientId, cwd, "dsh")).toBe("deepseek/deepseek-chat");
			expect(stateStore.getProjectModel(clientId, cwd, "claude")).toBe("claude-code/claude-3-5-sonnet");
		});

		it("isolates default model per engine while preserving pi legacy fallback", () => {
			stateStore.saveDefaultModel("anthropic/claude-3-7-sonnet", "pi");
			stateStore.saveDefaultModel("deepseek/deepseek-reasoner", "dsh");
			stateStore.saveDefaultModel("claude-code/claude-3-7-sonnet", "claude");

			expect(stateStore.getDefaultModel("pi")).toBe("anthropic/claude-3-7-sonnet");
			expect(stateStore.getDefaultModel("dsh")).toBe("deepseek/deepseek-reasoner");
			expect(stateStore.getDefaultModel("claude")).toBe("claude-code/claude-3-7-sonnet");

			// 无 engine 参数时回落到 pi 默认
			expect(stateStore.getDefaultModel()).toBe("anthropic/claude-3-7-sonnet");
		});
	});

	describe("claude engine (UniversalSession) UI layout and settings push", () => {
		it("pushes settings_state with saved uiLayout on attachSink", () => {
			const clientId = "client-claude-test";
			const cwd = join(testDir, "workspace-claude");

			// 预设用户的自定义 UI 布局
			stateStore.saveSettings(clientId, {
				uiLayout: {
					hidden: ["host:brand"],
					slots: { "host:engine": "topbar.primary" },
				},
			});

			const messages: ServerMessage[] = [];
			const session = new UniversalSession({
				clientId,
				cwd,
				dataDir: testDir,
				send: (msg) => messages.push(msg),
				store: universalStore,
				stateStore,
				driver: new MockAgentDriver(cwd),
				engine: "claude",
			});

			// 新客户端接入 attachSink 时必须推 pushSettings()
			const sinkMsgs: ServerMessage[] = [];
			session.attachSink((msg) => sinkMsgs.push(msg));

			const settingsMsg = sinkMsgs.find((m) => m.type === "settings_state");
			expect(settingsMsg).toBeDefined();
			if (settingsMsg && settingsMsg.type === "settings_state") {
				expect(settingsMsg.settings.uiLayout?.hidden).toContain("host:brand");
				expect(settingsMsg.settings.uiLayout?.slots?.["host:engine"]).toBe("topbar.primary");
			}

			session.dispose();
		});

		it("switchSession emits done transition_progress and snapshot contains sessionFile", async () => {
			const clientId = "client-claude-switch";
			const cwd = join(testDir, "workspace-claude");

			const messages: ServerMessage[] = [];
			const session = new UniversalSession({
				clientId,
				cwd,
				dataDir: testDir,
				send: (msg) => messages.push(msg),
				store: universalStore,
				stateStore,
				driver: new MockAgentDriver(cwd),
				engine: "claude",
			});

			// 先获取初始快照
			session.flushSnapshot();
			const snapshot = messages.find((m) => m.type === "snapshot");
			expect(snapshot).toBeDefined();
			if (snapshot && snapshot.type === "snapshot") {
				expect(snapshot.state.sessionFile).toBeDefined();
				expect(snapshot.state.sessionFile).toBe(snapshot.state.sessionId);
			}

			// 创建新对话以产生另一个可切换的历史会话
			await session.newChat();

			// 切换回前一个会话
			const historyId = (snapshot as any).state.sessionId;
			messages.length = 0;
			await session.switchSession(historyId);

			// 必须收到 transition_progress phase="done" 且 progress=100
			const transitionDone = messages.find((m) => m.type === "transition_progress" && (m as any).phase === "done");
			expect(transitionDone).toBeDefined();
			expect((transitionDone as any).progress).toBe(100);

			session.dispose();
		});

		it("automatically renames conversation and pushes conversations/sessions on first prompt", async () => {
			const clientId = "client-claude-rename";
			const cwd = join(testDir, "workspace-claude");

			const messages: ServerMessage[] = [];
			const session = new UniversalSession({
				clientId,
				cwd,
				dataDir: testDir,
				send: (msg) => messages.push(msg),
				store: universalStore,
				stateStore,
				driver: new MockAgentDriver(cwd),
				engine: "claude",
			});

			messages.length = 0;
			// 发送首条提问（例如 "你好"）
			await session.prompt("你好");

			// 必须收到 conversations 广播，且其 active 对话 title 更新为 "你好"
			const convMsg = messages.find((m) => m.type === "conversations");
			expect(convMsg).toBeDefined();
			if (convMsg && convMsg.type === "conversations") {
				const activeConv = convMsg.conversations.find((c) => c.id === convMsg.activeId);
				expect(activeConv).toBeDefined();
				expect(activeConv?.title).toBe("你好");
			}

			// 必须收到 sessions 广播，且 displayName / name 均为 "你好"，不再是默认的 "新对话"
			const sessMsg = messages.find((m) => m.type === "sessions");
			expect(sessMsg).toBeDefined();
			if (sessMsg && sessMsg.type === "sessions") {
				const current = sessMsg.sessions[0];
				expect(current).toBeDefined();
				expect(current?.name).toBe("你好");
				expect(current?.displayName).toBe("你好");
			}

			session.dispose();
		});
	});
});
