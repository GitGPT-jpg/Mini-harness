/**
 * bottombar-metrics-universal.test.ts — 通用 Agent 底座会话统计与底栏指标全链路单测。
 * 验证：底座优先规范化会话累计指标（Token、成本、缓存、上下文环），上层特定 Driver 遵循该规范。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UniversalSession } from "../../server/universal/universal-session.js";
import { UniversalSessionStore } from "../../server/universal/session-store.js";
import { ClaudeCodeDriver } from "../../server/universal/drivers/claude-code.js";
import type { ServerMessage, UiState } from "../../server/protocol.js";

describe("通用 Agent 底座会话统计与底栏指标适配", () => {
	let testAgentDir: string;
	let testDataDir: string;
	let store: UniversalSessionStore;

	beforeEach(() => {
		testAgentDir = mkdtempSync(join(tmpdir(), "pi-bottombar-test-agent-"));
		testDataDir = mkdtempSync(join(tmpdir(), "pi-bottombar-test-data-"));
		store = new UniversalSessionStore(testDataDir);
	});

	afterEach(() => {
		try {
			rmSync(testAgentDir, { recursive: true, force: true });
			rmSync(testDataDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("底座初始会话具备标准的 stats 结构（零值与空上下文，展示占位符 — 而非错误数值）", () => {
		const emitted: ServerMessage[] = [];
		const mockDriver = {
			id: "mock",
			name: "Mock Driver",
			createSession: async () => "sess-1",
			resumeSession: async () => {},
			getActiveSessionId: () => "sess-1",
			sendPrompt: async () => {},
			abort: async () => {},
			dispose: () => {},
		} as any;

		const session = new UniversalSession({
			clientId: "stats-init-client",
			cwd: process.cwd(),
			agentDir: testAgentDir,
			send: (msg) => emitted.push(msg),
			store,
			driver: mockDriver,
		});

		session.flushSnapshot(true);
		const snapshots = emitted.filter((m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot");
		const state: UiState = snapshots[snapshots.length - 1].state;

		// 验证底座标准化 stats 输出
		expect(state.stats).toBeDefined();
		expect(state.stats.totalMessages).toBe(0);
		expect(state.stats.tokens).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		});
		expect(state.stats.cost).toBe(0);
		expect(state.stats.contextUsage).toEqual({
			tokens: null,
			contextWindow: 200_000,
			percent: null,
		});

		session.dispose();
	});

	it("底座在执行多轮对话后，累加 Token、累计成本，并动态更新上下文环占用", async () => {
		const emitted: ServerMessage[] = [];
		let capturedSink: any = null;
		const mockDriver = {
			id: "mock",
			name: "Mock Driver",
			createSession: async () => "sess-1",
			resumeSession: async () => {},
			getActiveSessionId: () => "sess-1",
			sendPrompt: async (_prompt: string, _attach: any, sink: any) => {
				capturedSink = sink;
				sink.onTextDelta("回答");
			},
			abort: async () => {},
			dispose: () => {},
		} as any;

		const session = new UniversalSession({
			clientId: "multi-turn-stats-client",
			cwd: process.cwd(),
			agentDir: testAgentDir,
			send: (msg) => emitted.push(msg),
			store,
			driver: mockDriver,
		});

		// 第一轮对话
		await session.prompt("第一问");
		capturedSink.onTurnComplete({
			usage: {
				inputTokens: 1000,
				outputTokens: 200,
				cacheReadTokens: 500,
				cacheWriteTokens: 100,
				costUSD: 0.05,
			},
			costUSD: 0.05,
			model: "claude-3-7-sonnet-20250219",
		});

		session.flushSnapshot(true);
		let snapshots = emitted.filter((m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot");
		let state = snapshots[snapshots.length - 1].state;

		// 验证第一轮底座累计与上下文占用
		expect(state.stats.totalMessages).toBe(2); // 1 问 1 答
		expect(state.stats.tokens.input).toBe(1000);
		expect(state.stats.tokens.output).toBe(200);
		expect(state.stats.tokens.cacheRead).toBe(500);
		expect(state.stats.tokens.cacheWrite).toBe(100);
		expect(state.stats.tokens.total).toBe(1200);
		expect(state.stats.cost).toBe(0.05);

		// 上下文占用 = (1000 + 500 + 100) prompt + 200 output = 1800
		expect(state.stats.contextUsage.tokens).toBe(1800);
		expect(state.stats.contextUsage.contextWindow).toBe(200_000);
		expect(state.stats.contextUsage.percent).toBe(1);

		// 第二轮对话
		emitted.length = 0;
		await session.prompt("第二问");
		capturedSink.onTurnComplete({
			usage: {
				inputTokens: 2000,
				outputTokens: 300,
				cacheReadTokens: 1500,
				cacheWriteTokens: 0,
				costUSD: 0.08,
			},
			costUSD: 0.08,
			model: "claude-3-7-sonnet-20250219",
		});

		session.flushSnapshot(true);
		snapshots = emitted.filter((m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot");
		state = snapshots[snapshots.length - 1].state;

		// 验证多轮累加：成本 0.05 + 0.08 = 0.13
		expect(state.stats.totalMessages).toBe(4);
		expect(state.stats.tokens.input).toBe(3000);
		expect(state.stats.tokens.output).toBe(500);
		expect(state.stats.tokens.cacheRead).toBe(2000);
		expect(state.stats.tokens.total).toBe(3500);
		expect(state.stats.cost).toBeCloseTo(0.13, 5);

		// 最新上下文占用 = (2000 + 1500) prompt + 300 output = 3800
		expect(state.stats.contextUsage.tokens).toBe(3800);
		expect(state.stats.contextUsage.percent).toBe(2);

		session.dispose();
	});

	it("ClaudeCodeDriver 的真实 NDJSON result 事件正确解析出成本与 Token，并由底座吸收", async () => {
		const emitted: ServerMessage[] = [];
		const driver = new ClaudeCodeDriver(process.cwd(), { agentDir: testAgentDir });
		const session = new UniversalSession({
			clientId: "claude-ndjson-client",
			cwd: process.cwd(),
			agentDir: testAgentDir,
			send: (msg) => emitted.push(msg),
			store,
			driver,
		});

		await session.prompt("测试问题");

		// 模拟 Claude Code CLI 输出的真实 result 帧
		const activeTools = new Map<string, string>();
		const sink = (session as any)["sink"] || {
			onTextDelta: () => {},
			onThinkingDelta: () => {},
			onToolStart: () => {},
			onToolEnd: () => {},
			onTurnComplete: (meta: any) => (session as any).finalizeTurn(meta),
			onError: () => {},
		};

		// 模拟 CLI 返回带有 total_cost_usd 与 4 桶 usage 的 result 事件
		(driver as any).handleClaudeEvent(
			{
				type: "result",
				is_error: false,
				result: "执行完毕",
				total_cost_usd: 0.14285,
				usage: {
					input_tokens: 47500,
					output_tokens: 15,
					cache_read_input_tokens: 20000,
					cache_creation_input_tokens: 5000,
				},
				model: "claude-sonnet-4-6",
			},
			sink,
			activeTools,
		);

		session.flushSnapshot(true);
		const snapshots = emitted.filter((m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot");
		const state: UiState = snapshots[snapshots.length - 1].state;

		// 验证底栏指标全部有真实数据接入
		expect(state.stats.cost).toBeCloseTo(0.14285, 5);
		expect(state.stats.tokens.input).toBe(47500);
		expect(state.stats.tokens.output).toBe(15);
		expect(state.stats.tokens.cacheRead).toBe(20000);
		expect(state.stats.tokens.cacheWrite).toBe(5000);
		expect(state.stats.contextUsage.tokens).toBe(47500 + 15);
		expect(state.stats.contextUsage.percent).toBe(24);

		session.dispose();
	}, 15000);

	it("跨会话切换时，底栏统计数据独立隔离与恢复", async () => {
		const emitted: ServerMessage[] = [];
		let capturedSink: any = null;
		const mockDriver = {
			id: "mock",
			name: "Mock Driver",
			createSession: async () => `sess-${Date.now()}`,
			resumeSession: async () => {},
			getActiveSessionId: () => "sess-1",
			sendPrompt: async (_prompt: string, _attach: any, sink: any) => {
				capturedSink = sink;
			},
			abort: async () => {},
			dispose: () => {},
		} as any;

		const session = new UniversalSession({
			clientId: "switch-conv-stats-client",
			cwd: process.cwd(),
			agentDir: testAgentDir,
			send: (msg) => emitted.push(msg),
			store,
			driver: mockDriver,
		});

		// 会话 1
		await session.prompt("会话 1 问题");
		capturedSink.onTurnComplete({
			usage: { inputTokens: 500, outputTokens: 100, costUSD: 0.02 },
			costUSD: 0.02,
		});
		session.flushSnapshot(true);
		const conv1Id = (session as any).activeConvId;

		let state = emitted.filter((m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot").pop()!
			.state;
		expect(state.stats.cost).toBe(0.02);

		// 新建会话 2
		await session.newChat();
		session.flushSnapshot(true);
		state = emitted.filter((m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot").pop()!
			.state;
		// 新会话初始成本为 0
		expect(state.stats.cost).toBe(0);

		// 切回会话 1
		await session.switchConversation(conv1Id);
		session.flushSnapshot(true);
		state = emitted.filter((m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot").pop()!
			.state;
		// 会话 1 成本正确恢复为 0.02
		expect(state.stats.cost).toBe(0.02);

		session.dispose();
	});
});
