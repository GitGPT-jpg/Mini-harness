/**
 * dsh-universal-driver.test.ts — DSH 驱动接入 Universal Agent 底座单测。
 *
 * 覆盖：
 * 1. DshAgentDriver 标识符与特性能力声明（Capabilities）；
 * 2. 会话创建、恢复与激活状态维护；
 * 3. listModels 与 setModel（官方模型 + models.json 自定义端点模型）；
 * 4. sendPrompt 期间 DSH JSON-RPC 事件向 Universal sink 的事件映射（Thinking / Text / Tool / TurnComplete / AskUser）；
 * 5. UniversalSession 与 DshAgentDriver 的全链路装配。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshAgentDriver } from "../../server/universal/drivers/dsh-driver.js";
import { UniversalSession } from "../../server/universal/universal-session.js";
import { UniversalSessionStore } from "../../server/universal/session-store.js";
import type { AgentEventSink, AgentTurnMeta } from "../../server/universal/driver-base.js";
import type { ServerMessage, UiState } from "../../server/protocol.js";

describe("DshAgentDriver 通用底座驱动", () => {
	let testAgentDir: string;
	let testDataDir: string;

	beforeEach(() => {
		testAgentDir = mkdtempSync(join(tmpdir(), "dsh-driver-agent-"));
		testDataDir = mkdtempSync(join(tmpdir(), "dsh-driver-data-"));
	});

	afterEach(() => {
		try {
			rmSync(testAgentDir, { recursive: true, force: true });
			rmSync(testDataDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("DshAgentDriver 具备正确的标识与完整能力声明", () => {
		const driver = new DshAgentDriver(process.cwd(), {
			agentDir: testAgentDir,
			dataDir: testDataDir,
		});

		expect(driver.id).toBe("dsh");
		expect(driver.name).toBe("DeepSeek Harness");
		expect(driver.capabilities).toEqual({
			supportsTreeFork: false,
			supportsHistoryEdit: false,
			supportsToolPromptOverride: false,
			supportsModelSwitch: true,
			supportsThinkingLevels: true,
			supportsAskUser: true,
		});

		driver.dispose();
	});

	it("会话创建与恢复正确维护 activeSessionId", async () => {
		const driver = new DshAgentDriver(process.cwd(), {
			agentDir: testAgentDir,
			dataDir: testDataDir,
		});

		expect(driver.getActiveSessionId()).toBeNull();

		const sess1 = await driver.createSession();
		expect(sess1).toMatch(/^web-/);
		expect(driver.getActiveSessionId()).toBe(sess1);

		await driver.resumeSession("web-custom-123");
		expect(driver.getActiveSessionId()).toBe("web-custom-123");

		driver.dispose();
	});

	it("listModels 与 setModel 支持官方模型与 models.json 自定义端点模型", async () => {
		writeFileSync(
			join(testAgentDir, "models.json"),
			JSON.stringify({
				providers: {
					"antigravity-openai": {
						name: "Antigravity Gateway",
						baseUrl: "http://127.0.0.1:8045/v1",
						apiKey: "sk-antigravity",
						models: [{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }],
					},
				},
			}),
			"utf8",
		);

		const mockRuntime = {
			alive: true,
			start: vi.fn(async () => {}),
			listModels: vi.fn(async () => ({ models: [{ id: "deepseek-v4-custom", name: "Custom DeepSeek" }] })),
			restart: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
			kill: vi.fn(async () => {}),
			onNotification: vi.fn(),
		} as any;

		const driver = new DshAgentDriver(process.cwd(), {
			agentDir: testAgentDir,
			dataDir: testDataDir,
			runtime: mockRuntime,
		});

		const models = await driver.listModels();
		// 1. 官方模型
		expect(models.some((m) => m.id === "deepseek/deepseek-v4-flash")).toBe(true);
		// 2. 运行时动态发现模型
		expect(models.some((m) => m.id === "deepseek/deepseek-v4-custom")).toBe(true);
		// 3. models.json 自定义端点模型
		expect(models.some((m) => m.id === "antigravity-openai/gemini-3.8-flash")).toBe(true);

		// 切换到自定义端点模型
		await driver.setModel("antigravity-openai/gemini-3.8-flash");
		expect(mockRuntime.restart).toHaveBeenCalledWith("gemini-3.8-flash", "antigravity-openai");

		// 切换回官方模型
		await driver.setModel("deepseek/deepseek-v4-pro");
		expect(mockRuntime.restart).toHaveBeenCalledWith("deepseek-v4-pro", "deepseek");

		driver.dispose();
	});

	it("sendPrompt 能够将 DSH 运行时的 Thinking、Text、Tool 调用与 Usage 映射到 sink", async () => {
		let registeredNotificationHandler: ((method: string, params: unknown) => void) | null = null;
		const mockPrompt = vi.fn(async (_sessId: string, _blocks: unknown[]) => {
			// 模拟 DSH 运行时推送的一整套事件
			if (registeredNotificationHandler) {
				// 1. Thinking 思考过程
				registeredNotificationHandler("session.event", {
					event: {
						type: "assistant/chunk",
						data: { chunk: { type: "reasoning-delta", text: "正在分析需求..." } },
					},
				});
				// 2. 正文流式增量
				registeredNotificationHandler("session.event", {
					event: {
						type: "assistant/chunk",
						data: { chunk: { type: "text-delta", text: "这是测试回复" } },
					},
				});
				// 3. 工具调用
				registeredNotificationHandler("session.event", {
					event: {
						type: "tool/call",
						data: { id: "call_1", name: "bash", args: { command: "ls" } },
					},
				});
				// 4. 工具回执
				registeredNotificationHandler("session.event", {
					event: {
						type: "tool/result",
						data: { id: "call_1", result: "file1.txt\nfile2.txt", isError: false },
					},
				});
				// 5. 本轮结束与 Usage 统计
				registeredNotificationHandler("session.event", {
					event: {
						type: "assistant/message",
						data: {
							message: {
								usage: {
									inputTokens: 100,
									outputTokens: 50,
									cacheReadTokens: 200,
									cacheWriteTokens: 0,
								},
							},
						},
					},
				});
			}
			return "msg_123";
		});

		const mockRuntime = {
			alive: true,
			start: vi.fn(async () => {}),
			prompt: mockPrompt,
			attachmentSave: vi.fn(async () => ({ ref: { attachmentId: "att_1", mediaType: "image/png" } })),
			kill: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
			onNotification: vi.fn((fn) => {
				registeredNotificationHandler = fn;
			}),
		} as any;

		const driver = new DshAgentDriver(process.cwd(), {
			agentDir: testAgentDir,
			dataDir: testDataDir,
			runtime: mockRuntime,
		});

		const thinkingDeltas: string[] = [];
		const textDeltas: string[] = [];
		const toolStarts: any[] = [];
		const toolEnds: any[] = [];
		let turnMeta: AgentTurnMeta | undefined;

		const sink: AgentEventSink = {
			onThinkingDelta: (d) => thinkingDeltas.push(d),
			onTextDelta: (d) => textDeltas.push(d),
			onToolStart: (id, name, args) => toolStarts.push({ id, name, args }),
			onToolEnd: (id, res) => toolEnds.push({ id, res }),
			onTurnComplete: (meta) => {
				turnMeta = meta;
			},
			onError: vi.fn(),
		};

		await driver.sendPrompt("你好", undefined, sink);

		expect(thinkingDeltas).toEqual(["正在分析需求..."]);
		expect(textDeltas).toEqual(["这是测试回复"]);
		expect(toolStarts).toEqual([{ id: "call_1", name: "bash", args: { command: "ls" } }]);
		expect(toolEnds).toEqual([{ id: "call_1", res: { output: "file1.txt\nfile2.txt", error: undefined } }]);
		expect(turnMeta).toBeDefined();
		expect(turnMeta?.usage).toEqual({
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 200,
			cacheWriteTokens: 0,
		});

		driver.dispose();
	});

	it("UniversalSession 装配 DshAgentDriver 时，初始化 DSH 默认模型与思考强度", async () => {
		const emitted: ServerMessage[] = [];
		const store = new UniversalSessionStore(testDataDir);

		const mockRuntime = {
			alive: true,
			start: vi.fn(async () => {}),
			listModels: vi.fn(async () => ({ models: [] })),
			restart: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
			kill: vi.fn(async () => {}),
			onNotification: vi.fn(),
		} as any;

		const driver = new DshAgentDriver(process.cwd(), {
			agentDir: testAgentDir,
			dataDir: testDataDir,
			runtime: mockRuntime,
		});

		const session = new UniversalSession({
			clientId: "dsh-universal-client",
			cwd: process.cwd(),
			agentDir: testAgentDir,
			send: (msg) => emitted.push(msg),
			store,
			driver,
		});

		// 触发快照与模型列表
		session.flushSnapshot(true);
		await session.listModels();

		const snapshots = emitted.filter((m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot");
		expect(snapshots.length).toBeGreaterThan(0);

		const latestState: UiState = snapshots[snapshots.length - 1].state;
		expect(latestState.model).toBeDefined();
		expect(latestState.model?.id).toBe("deepseek-v4-flash");
		expect(latestState.model?.provider).toBe("deepseek");
		expect(latestState.thinkingLevel).toBe("high");

		session.dispose();
	});
});
