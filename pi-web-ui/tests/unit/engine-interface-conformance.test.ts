/**
 * engine-interface-conformance.test.ts
 *
 * 验证三大引擎（Pi 引擎 ClientSession、DSH 引擎 DshClientSession、Universal 引擎 UniversalSession）
 * 对 DispatchSession 平台核心接口的实现一致性与方法契约，防止功能在某引擎单体中意外遗漏。
 */

import { describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service";
import { DshClientSession } from "../../server/dsh/dsh-agent-service";
import { UniversalSession } from "../../server/universal/universal-session";

describe("引擎接口一致性门禁 (DispatchSession Interface Conformance)", () => {
	const CORE_PLATFORM_METHODS = [
		// 1. 模型与偏好管理
		"setModel",
		"setDefaultModel",
		"clearDefaultModel",
		"setThinking",

		// 2. 会话生命周期与草稿
		"saveDraft",
		"newChat",
		"switchSession",
		"switchConversation",
		"deleteSession",
		"renameSession",
		"renameConversation",
		"pinSession",
		"setConversationPinned",
		"searchSessions",
		"refreshSessions",

		// 3. 工具与提示词元数据（右键详情/提示词覆盖/折叠卡片展开）
		"getToolInfo",
		"getToolPrompt",
		"getCompactedMessages",

		// 4. 工作区与多根管理
		"setCwd",
		"setWorkspaceRoots",

		// 5. 状态同步与终端管理
		"flushSnapshot",
		"pushSettings",
	] as const;

	it("Pi 引擎 (ClientSession) 完整实现核心平台契约", () => {
		const proto = ClientSession.prototype as unknown as Record<string, unknown>;
		for (const method of CORE_PLATFORM_METHODS) {
			expect(typeof proto[method], `ClientSession 必须实现 ${method}`).toBe("function");
		}
	});

	it("DSH 引擎 (DshClientSession) 完整实现核心平台契约", () => {
		const proto = DshClientSession.prototype as unknown as Record<string, unknown>;
		for (const method of CORE_PLATFORM_METHODS) {
			expect(typeof proto[method], `DshClientSession 必须实现 ${method}`).toBe("function");
		}
	});

	it("Universal / Claude 引擎 (UniversalSession) 完整实现核心平台契约", () => {
		const proto = UniversalSession.prototype as unknown as Record<string, unknown>;
		for (const method of CORE_PLATFORM_METHODS) {
			expect(typeof proto[method], `UniversalSession 必须实现 ${method}`).toBe("function");
		}
	});

	it("沙盒全套生命周期在 UniversalSession 上具备统一实现", () => {
		const proto = UniversalSession.prototype as unknown as Record<string, unknown>;
		const sandboxMethods = [
			"createSandbox",
			"resetSandbox",
			"persistSandbox",
			"promoteSandbox",
			"diffSandbox",
			"applySandboxToSource",
			"destroySandbox",
		];
		for (const m of sandboxMethods) {
			expect(typeof proto[m], `UniversalSession 必须实现沙盒方法 ${m}`).toBe("function");
		}
	});

	it("Git 工作树管理在 UniversalSession 上具备统一实现", () => {
		const proto = UniversalSession.prototype as unknown as Record<string, unknown>;
		expect(typeof proto.switchWorktree, "UniversalSession 必须实现 switchWorktree").toBe("function");
		expect(typeof proto.removeWorktree, "UniversalSession 必须实现 removeWorktree").toBe("function");
	});

	it("会话回滚与分叉在 UniversalSession 上具备统一实现", () => {
		const proto = UniversalSession.prototype as unknown as Record<string, unknown>;
		expect(typeof proto.forkSession, "UniversalSession 必须实现 forkSession").toBe("function");
		expect(typeof proto.rollbackSession, "UniversalSession 必须实现 rollbackSession").toBe("function");
	});

	it("DSH 与 Universal 引擎均提供定制的会话展示名解析回调 (resolveSessionDisplayName)", () => {
		const dshProto = DshClientSession.prototype as any;
		expect(typeof dshProto.resolveSessionDisplayName, "DSH 必须提供 resolveSessionDisplayName 回调").toBe("function");

		// DSH 回调行为验证：优先显式自定义标题 > 首条提问 > 默认
		const dshMockSession = {
			defaultTitle: () => "新对话",
		};
		const dshName1 = dshProto.resolveSessionDisplayName.call(
			dshMockSession,
			"chat-1",
			"Dockerfile 解析",
			"@Dockerfile 这是啥",
		);
		expect(dshName1).toBe("Dockerfile 解析");

		const dshName2 = dshProto.resolveSessionDisplayName.call(dshMockSession, "chat-2", undefined, "@Dockerfile 这是啥");
		expect(dshName2).toBe("@Dockerfile 这是啥");

		const dshName3 = dshProto.resolveSessionDisplayName.call(dshMockSession, "chat-3", undefined, undefined);
		expect(dshName3).toBe("新对话");

		const universalProto = UniversalSession.prototype as any;
		expect(typeof universalProto.resolveSessionDisplayName, "Universal 必须提供 resolveSessionDisplayName 回调").toBe(
			"function",
		);

		const uniMockSession = { lang: "zh" };
		const uniName1 = universalProto.resolveSessionDisplayName.call(
			uniMockSession,
			{ title: "自定义标题" },
			"首条消息内容",
		);
		expect(uniName1).toBe("自定义标题");

		const uniName2 = universalProto.resolveSessionDisplayName.call(
			uniMockSession,
			{ title: "新对话" },
			"首条长文本内容这是一段非常长的主题描述超过三十个字符的内容测试超长文本",
		);
		expect(uniName2).toBe("首条长文本内容这是一段非常长的主题描述超过三十个字符的内容测…");
	});

	it("DSH 引擎重命名回调能同步内存标题、持久化至 stateStore 并触发刷新", async () => {
		const dshProto = DshClientSession.prototype as any;
		let savedCwd = "";
		let savedKey = "";
		let savedTitle = "";
		const conv = {
			id: "c-rename-1",
			sessionId: "web-test-sid-1",
			sessionFile: "C:/fake/path/session.jsonl",
			title: "旧标题",
		};
		const mockSession = {
			cwd: "E:/my-project",
			convs: new Map([["c-rename-1", conv]]),
			stateStore: {
				saveSessionTitle: vi.fn((cwd, key, title) => {
					savedCwd = cwd;
					savedKey = key;
					savedTitle = title;
				}),
				getSessionTitle: vi.fn((cwd, key) => (key === savedKey ? savedTitle : undefined)),
			},
			emitConversations: vi.fn(),
			flushSnapshot: vi.fn(),
			pushSessions: vi.fn(async () => {}),
		};

		// 执行重命名
		await dshProto.renameConversation.call(mockSession, "c-rename-1", "新的项目分析标题");

		// 验证：
		// 1. 内存会话标题更新
		expect(conv.title).toBe("新的项目分析标题");
		// 2. 状态持久化到 stateStore
		expect(mockSession.stateStore.saveSessionTitle).toHaveBeenCalled();
		expect(savedTitle).toBe("新的项目分析标题");
		expect(savedCwd).toBe("E:/my-project");
		// 3. 立即触发了快照推送、会话列表推送和历史列表推送
		expect(mockSession.emitConversations).toHaveBeenCalled();
		expect(mockSession.flushSnapshot).toHaveBeenCalled();
		expect(mockSession.pushSessions).toHaveBeenCalled();
	});

	it("Universal 引擎接入 MarkerService 并支持模型 [[conv:rename:...]] 内联重命名生效", async () => {
		const uniProto = UniversalSession.prototype as any;
		let savedStoreTitle = "";
		const conv = {
			id: "uconv-test-1",
			title: "未命名对话",
			messages: [],
			isEphemeral: false,
			updatedAt: 0,
		};
		const mockSession = {
			cwd: "E:/test-cwd",
			activeConvId: "uconv-test-1",
			conversations: new Map([["uconv-test-1", conv]]),
			store: {
				saveConversation: vi.fn((_cwd, c) => {
					savedStoreTitle = c.title;
				}),
			},
			stateStore: {
				saveSessionTitle: vi.fn(),
			},
			flushSnapshot: vi.fn(),
			refreshSessions: vi.fn(),
		};

		// 执行重命名
		await uniProto.renameConversation.call(mockSession, "uconv-test-1", "通过Marker重命名的标题");

		expect(conv.title).toBe("通过Marker重命名的标题");
		expect(savedStoreTitle).toBe("通过Marker重命名的标题");
		expect(mockSession.flushSnapshot).toHaveBeenCalled();
		expect(mockSession.refreshSessions).toHaveBeenCalled();
	});

	it("Universal 引擎完整实现高级扩展能力契约（命令、预设、技能与 SCM）", () => {
		const uniProto = UniversalSession.prototype as unknown as Record<string, unknown>;
		const UNIVERSAL_EXTENDED_METHODS = [
			// 1. 命令与技能管理
			"pushSlashCommands",
			"installSkill",
			"uninstallSkill",
			"fetchSkillMarket",
			"fetchSkillContent",
			"fetchMcpMarket",

			// 2. 预设生命周期与跨端共享
			"savePreset",
			"applyPreset",
			"deletePreset",
			"exportPreset",
			"importPreset",
			"importPresetFromUrl",
			"pushPresetCatalog",
			"sharePreset",

			// 3. 子代理模板管理
			"saveSubagentTemplate",
			"deleteSubagentTemplate",

			// 4. Git SCM AI 提交信息生成
			"scmGenCommitMessage",
		];

		for (const m of UNIVERSAL_EXTENDED_METHODS) {
			expect(typeof uniProto[m], `UniversalSession 必须实现高级方法 ${m}`).toBe("function");
		}
	});
});
