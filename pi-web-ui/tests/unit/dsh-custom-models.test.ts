/**
 * dsh-custom-models.test.ts — DSH 引擎自定义端点模型接入与凭据动态注入单测。
 *
 * 覆盖：
 * 1. models.json 自定义模型与 DSH 官方内置模型在 listModels() 中合并；
 * 2. DshClientSession.setModel() 解除硬编码限制，支持切换到第三方模型并联动状态；
 * 3. DshRuntime 启动与初始化时，根据当前激活模型动态解析并注入 BaseURL、API Key 及 bare model ID。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshClientSession } from "../../server/dsh/dsh-agent-service.js";
import { DshRuntime } from "../../server/dsh/dsh-client.js";
import type { ServerMessage } from "../../server/protocol.js";

describe("DSH 引擎自定义端点模型接入", () => {
	let testAgentDir: string;
	let testDataDir: string;

	beforeEach(() => {
		testAgentDir = mkdtempSync(join(tmpdir(), "dsh-custom-models-agent-"));
		testDataDir = mkdtempSync(join(tmpdir(), "dsh-custom-models-data-"));
	});

	afterEach(() => {
		try {
			rmSync(testAgentDir, { recursive: true, force: true });
			rmSync(testDataDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("listModels 能够将 models.json 中的第三方自定义模型与 DSH 官方模型完整合并", async () => {
		// 在 agentDir 中写入类似 antigravity-openai 的配置
		writeFileSync(
			join(testAgentDir, "models.json"),
			JSON.stringify({
				providers: {
					"antigravity-openai": {
						name: "Antigravity 反代中转",
						baseUrl: "http://127.0.0.1:8045/v1",
						apiKey: "sk-antigravity-secret",
						models: [
							{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", reasoning: true },
							{ id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet (反代)", reasoning: false },
						],
					},
				},
			}),
			"utf8",
		);

		const emitted: ServerMessage[] = [];
		const mockRuntime = {
			listModels: vi.fn(async () => ({ models: [] })),
			restart: vi.fn(async () => {}),
		};

		const session = Object.assign(Object.create(DshClientSession.prototype), {
			agentDir: testAgentDir,
			dataDir: testDataDir,
			runtime: mockRuntime,
			dynamicModels: new Set<string>(),
			customModelsMap: new Map(),
			emit: (msg: ServerMessage) => emitted.push(msg),
		});

		await DshClientSession.prototype.listModels.call(session);

		const modelsMsg = emitted.find((m): m is Extract<ServerMessage, { type: "models" }> => m.type === "models");
		expect(modelsMsg).toBeDefined();
		const models = modelsMsg!.models;

		// 1. 包含 DSH 官方模型
		expect(models.some((m) => m.id === "deepseek/deepseek-v4-flash")).toBe(true);
		expect(models.some((m) => m.id === "deepseek/deepseek-v4-flash-vision-exp" && m.vision === true)).toBe(true);

		// 2. 包含 models.json 中的自定义模型
		const gemini = models.find((m) => m.id === "antigravity-openai/gemini-3.8-flash");
		expect(gemini).toBeDefined();
		expect(gemini?.name).toBe("Gemini 3.8 Flash");
		expect(gemini?.provider).toBe("antigravity-openai");
		expect(gemini?.reasoning).toBe(true);
		expect(gemini?.vision).toBe(false);

		const claude = models.find((m) => m.id === "antigravity-openai/claude-3-7-sonnet");
		expect(claude).toBeDefined();
		expect(claude?.name).toBe("Claude 3.7 Sonnet (反代)");
		expect(claude?.provider).toBe("antigravity-openai");
	});

	it("setModel 支持切换到自定义端点模型，解除硬编码限制并触发正确的运行时重启", async () => {
		writeFileSync(
			join(testAgentDir, "models.json"),
			JSON.stringify({
				providers: {
					"antigravity-openai": {
						baseUrl: "http://127.0.0.1:8045/v1",
						apiKey: "sk-antigravity-secret",
						models: [{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }],
					},
				},
			}),
			"utf8",
		);

		const emitted: ServerMessage[] = [];
		const mockRestart = vi.fn(async () => {});
		const mockFlushSnapshot = vi.fn();
		const mockSaveProjectModel = vi.fn();

		const session = Object.assign(Object.create(DshClientSession.prototype), {
			agentDir: testAgentDir,
			dataDir: testDataDir,
			clientId: "test-client",
			cwd: "E:/test-cwd",
			model: "deepseek-v4-flash",
			modelProvider: "deepseek",
			modelDisplayName: "DeepSeek V4 Flash",
			modelVision: false,
			dynamicModels: new Set<string>(),
			customModelsMap: new Map(),
			convs: new Map(),
			runtime: { restart: mockRestart },
			stateStore: { saveProjectModel: mockSaveProjectModel },
			emit: (msg: ServerMessage) => emitted.push(msg),
			flushSnapshot: mockFlushSnapshot,
		});

		// 1. 先列出模型以填充缓存
		await DshClientSession.prototype.listModels.call(session);

		// 2. 切换到自定义端点模型
		await DshClientSession.prototype.setModel.call(session, "antigravity-openai/gemini-3.8-flash");

		// 验证状态更新与项目模型持久化
		expect(session.model).toBe("gemini-3.8-flash");
		expect(session.modelProvider).toBe("antigravity-openai");
		expect(session.modelDisplayName).toBe("Gemini 3.8 Flash");
		expect(mockSaveProjectModel).toHaveBeenCalledWith(
			"test-client",
			"E:/test-cwd",
			"antigravity-openai/gemini-3.8-flash",
			"dsh",
		);

		// 验证调用了 runtime.restart("gemini-3.8-flash", "antigravity-openai")
		expect(mockRestart).toHaveBeenCalledWith("gemini-3.8-flash", "antigravity-openai");
		expect(mockFlushSnapshot).toHaveBeenCalledWith(true);

		const notice = emitted.find(
			(m): m is Extract<ServerMessage, { type: "notice" }> => m.type === "notice" && m.level === "info",
		);
		expect(notice?.text).toContain("Gemini 3.8 Flash");
	});

	it("setModel 支持切换回 DSH 官方模型（包括 bare ID 与 canonical ID）", async () => {
		const mockRestart = vi.fn(async () => {});
		const mockSaveProjectModel = vi.fn();
		const session = Object.assign(Object.create(DshClientSession.prototype), {
			agentDir: testAgentDir,
			dataDir: testDataDir,
			clientId: "test-client",
			cwd: "E:/test-cwd",
			model: "gemini-3.8-flash",
			modelProvider: "antigravity-openai",
			modelDisplayName: "Gemini 3.8 Flash",
			modelVision: false,
			dynamicModels: new Set<string>(),
			customModelsMap: new Map(),
			convs: new Map(),
			runtime: { restart: mockRestart },
			stateStore: { saveProjectModel: mockSaveProjectModel },
			emit: vi.fn(),
			flushSnapshot: vi.fn(),
		});

		await DshClientSession.prototype.listModels.call(session);

		// 1. 用 bare ID 切换到 vision 模型
		await DshClientSession.prototype.setModel.call(session, "deepseek-v4-flash-vision-exp");
		expect(session.model).toBe("deepseek-v4-flash-vision-exp");
		expect(session.modelProvider).toBe("deepseek");
		expect(session.modelVision).toBe(true);
		expect(mockRestart).toHaveBeenCalledWith("deepseek-v4-flash-vision-exp", "deepseek");

		// 2. 用 canonical ID 切换到 pro 模型
		await DshClientSession.prototype.setModel.call(session, "deepseek/deepseek-v4-pro");
		expect(session.model).toBe("deepseek-v4-pro");
		expect(session.modelProvider).toBe("deepseek");
		expect(session.modelVision).toBe(false);
		expect(mockRestart).toHaveBeenCalledWith("deepseek-v4-pro", "deepseek");
	});

	it("DshRuntime 在以自定义模型启动时，正确解析并注入 DEEPSEEK_BASE_URL、DEEPSEEK_API_KEY 与 bare model ID", async () => {
		writeFileSync(
			join(testAgentDir, "models.json"),
			JSON.stringify({
				providers: {
					"antigravity-openai": {
						baseUrl: "http://127.0.0.1:8045/v1",
						apiKey: "sk-antigravity-secret",
						models: [{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }],
					},
				},
			}),
			"utf8",
		);

		const runtime = new DshRuntime({
			cwd: process.cwd(),
			agentDir: testAgentDir,
			model: "antigravity-openai/gemini-3.8-flash",
		});

		// 验证构造函数自动解析 provider 与 model
		expect(runtime.model).toBe("antigravity-openai/gemini-3.8-flash");
		expect(runtime.modelProvider).toBe("antigravity-openai");

		// 1. 验证 resolveRuntimeConfig 正确解析自定义端点
		const config = runtime.resolveRuntimeConfig();
		expect(config.activeProvider).toBe("antigravity-openai");
		expect(config.bareModelId).toBe("gemini-3.8-flash");
		expect(config.env.DEEPSEEK_BASE_URL).toBe("http://127.0.0.1:8045/v1");
		expect(config.env.DEEPSEEK_API_KEY).toBe("sk-antigravity-secret");

		// 2. 验证 restart 时切换模型后环境与配置同步更新
		await runtime.restart("deepseek/deepseek-v4-pro");
		const proConfig = runtime.resolveRuntimeConfig();
		expect(proConfig.activeProvider).toBe("deepseek");
		expect(proConfig.bareModelId).toBe("deepseek-v4-pro");
	});
});
