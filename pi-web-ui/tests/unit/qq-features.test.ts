/**
 * tests/unit/qq-features.test.ts
 * Tests for QQ Bot plugin:
 * - Pure helpers (marker stripping, accountId hashing, mention stripping)
 * - QqBotBridge duplex flow (whitelist, slash commands, chat dispatch, and run_end reply)
 */

import { describe, expect, it, vi } from "vitest";
import activate, {
	checkCwdValid,
	extractQqText,
	peerAccountId,
	QqBotBridge,
	stripInternalMarkers,
} from "../../plugins/qq/index.mjs";

describe("QQ 纯函数与辅助方法测试", () => {
	it("stripInternalMarkers 剥离内部标记与清理空行", () => {
		const raw = "这是回答[[plan:123]]中间内容[[conv:xyz]]结尾。\n\n\n新行";
		expect(stripInternalMarkers(raw)).toBe("这是回答中间内容结尾。\n\n新行");
	});

	it("peerAccountId 生成稳定的 qq_ 前缀脱敏 ID", () => {
		const id1 = peerAccountId("OPENID_123456");
		const id2 = peerAccountId("OPENID_123456");
		expect(id1).toBe(id2);
		expect(id1.startsWith("qq_")).toBe(true);
		expect(peerAccountId("")).toBe("qq_default");
	});

	it("extractQqText 剥离机器人 <@!botId> 与 <@botId> 标签", () => {
		const text1 = "<@!10203040> 帮我写一个快速排序算法";
		expect(extractQqText(text1, "10203040")).toBe("帮我写一个快速排序算法");

		const text2 = "<@10203040> 帮我写一个函数";
		expect(extractQqText(text2, "10203040")).toBe("帮我写一个函数");
	});
});

describe("QqBotBridge 双工逻辑测试", () => {
	it("白名单模式：不在白名单内的用户会被拒绝，不触发 host.chat", async () => {
		const chatSpy = vi.fn();
		const bridge = new QqBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				appId: "102030",
				clientSecret: "mock_secret",
				allowedUsers: ["ALLOWED_USER_1"],
			}),
		});

		await bridge.onInboundMessage(
			{
				id: "msg_qq_1",
				channel_id: "c_123",
				author: { id: "STRANGER_USER", bot: false },
				content: "你好",
			},
			"AT_MESSAGE_CREATE",
		);

		expect(chatSpy).not.toHaveBeenCalled();
	});

	it("斜杠命令 /help 应当直接回复帮助说明，不触发 host.chat", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: "m_reply_1" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn();
		const bridge = new QqBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				appId: "102030",
				clientSecret: "mock_secret",
			}),
		});

		await bridge.onInboundMessage(
			{
				id: "msg_qq_2",
				channel_id: "c_123",
				author: { id: "ALLOWED_USER_1", bot: false },
				content: "/help",
			},
			"AT_MESSAGE_CREATE",
		);

		expect(chatSpy).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/channels/c_123/messages"),
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("QQ 机器人帮助"),
			}),
		);

		vi.unstubAllGlobals();
	});

	it("正常入站消息派发到 host.chat，并在 run_end 时回复 Markdown", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ access_token: "mock_qq_token", id: "m_reply_2" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_qq_1" });

		const bridge = new QqBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({
				appId: "102030",
				clientSecret: "mock_secret",
			}),
		});

		await bridge.start();

		await bridge.onInboundMessage(
			{
				id: "msg_qq_3",
				channel_id: "c_123",
				author: { id: "ALLOWED_USER_1", bot: false },
				content: "帮我写一个函数",
			},
			"AT_MESSAGE_CREATE",
		);

		expect(chatSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "帮我写一个函数",
				accountId: expect.stringMatching(/^qq_/),
			}),
		);

		const convId = chatSpy.mock.calls[0][0].conversationId;

		runHandler!({
			conversationId: convId,
			type: "message",
			message: {
				role: "assistant",
				content: "```typescript\nfunction test() {}\n```[[plan:qq]]",
			},
		});

		await runHandler!({
			conversationId: convId,
			type: "run_end",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/channels/c_123/messages"),
			expect.objectContaining({
				body: expect.stringContaining("function test()"),
			}),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});

	it("长回复按 3000 字分块后，replyMessage 调用时的 msg_seq 严格从 1 递增", async () => {
		const replySpy = vi.fn().mockResolvedValue({});
		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_qq_long" });

		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ access_token: "mock_qq_token" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const bridge = new QqBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({
				appId: "102030",
				clientSecret: "mock_secret",
			}),
		});

		bridge.replyMessage = replySpy;
		await bridge.start();

		await bridge.onInboundMessage(
			{
				id: "msg_qq_4",
				channel_id: "c_123",
				author: { id: "ALLOWED_USER_1", bot: false },
				content: "请生成长文本",
			},
			"AT_MESSAGE_CREATE",
		);

		const convId = chatSpy.mock.calls[0][0].conversationId;

		// 构造超过 3000 字的长回复，使其切为至少 2 块
		const longReply = "A".repeat(3500);
		runHandler!({
			conversationId: convId,
			type: "message",
			message: {
				role: "assistant",
				content: longReply,
			},
		});

		await runHandler!({
			conversationId: convId,
			type: "run_end",
		});

		expect(replySpy).toHaveBeenCalledTimes(2);
		expect(replySpy.mock.calls[0][2]).toBe(1);
		expect(replySpy.mock.calls[1][2]).toBe(2);

		await bridge.stop();
		vi.unstubAllGlobals();
	});

	it("ensureAccessToken：未到期直接复用，到期惰性刷新", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ access_token: "token_v2", expires_in: 7200 }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const bridge = new QqBotBridge({
			host: { chat: vi.fn() },
			getConfig: () => ({ appId: "102030", clientSecret: "mock_secret" }),
		});

		// 初始状态：持有还有很长时间过期的 token
		bridge.accessToken = "token_v1";
		bridge.tokenExpiresAt = Date.now() + 7200 * 1000;

		// 未到期调用：直接复用，不发起网络请求
		const t1 = await bridge.ensureAccessToken();
		expect(t1).toBe("token_v1");
		expect(fetchMock).not.toHaveBeenCalled();

		// 模拟 token 进入 5 分钟刷新余量区间
		bridge.tokenExpiresAt = Date.now() + 60 * 1000;

		const t2 = await bridge.ensureAccessToken();
		expect(t2).toBe("token_v2");
		expect(bridge.accessToken).toBe("token_v2");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await bridge.stop();
		vi.unstubAllGlobals();
	});

	it("onClientMessage 请求-响应配对：回显 __rid 并正确分发 get_state 与 test_config", async () => {
		let clientHandler: ((msg: any, reply: (payload: any) => void) => Promise<void>) | null = null;
		const mockStorage = new Map<string, any>();
		const mockHost = {
			storage: {
				get: async (k: string) => mockStorage.get(k),
				set: async (k: string, v: any) => mockStorage.set(k, v),
			},
			secrets: {
				getAll: async () => ({}),
			},
			onClientMessage: (fn: any) => {
				clientHandler = fn;
			},
			registerTool: vi.fn(),
		};

		await activate(mockHost as any);
		expect(clientHandler).toBeDefined();

		// 测试 get_state 带 __rid
		let replyData: any = null;
		await clientHandler!({ type: "get_state", __rid: "qq-req-1" }, (res: any) => {
			replyData = res;
		});

		expect(replyData).toBeDefined();
		expect(replyData.__rid).toBe("qq-req-1");
		expect(replyData.type).toBe("state");

		// 测试 test_config 缺少密钥时报错并保留 __rid
		let testReply: any = null;
		await clientHandler!(
			{
				type: "test_config",
				__rid: "qq-req-2",
				config: { appId: "1905849155", clientSecret: "" },
			},
			(res: any) => {
				testReply = res;
			},
		);

		expect(testReply).toBeDefined();
		expect(testReply.__rid).toBe("qq-req-2");
		expect(testReply.success).toBe(false);
		expect(testReply.message).toContain("未填入 AppID 或 ClientSecret");
	});

	it("checkCwdValid 能够正确拦截非法或不存在的路径", () => {
		expect(checkCwdValid("").ok).toBe(false);
		expect(checkCwdValid("Z:/non_existent_path_xyz_123").ok).toBe(false);
		expect(checkCwdValid(process.cwd()).ok).toBe(true);
	});

	it("QQ 斜杠命令支持 /4 model 与 /5 thinking 切换，并自增代次透传给 host.chat", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: "m_reply_cmd" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_qq_m" });
		const bridge = new QqBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({ appId: "102030", clientSecret: "mock_secret" }),
		});

		// 1. 发送 /4 model deepseek/deepseek-chat
		await bridge.onInboundMessage(
			{
				id: "msg_cmd_1",
				channel_id: "c_123",
				author: { id: "USER_A", bot: false },
				content: "/4 deepseek/deepseek-chat",
			},
			"AT_MESSAGE_CREATE",
		);

		expect(bridge.userModels.get("USER_A")).toBe("deepseek/deepseek-chat");

		// 2. 发送 /5 thinking high
		await bridge.onInboundMessage(
			{
				id: "msg_cmd_2",
				channel_id: "c_123",
				author: { id: "USER_A", bot: false },
				content: "/5 high",
			},
			"AT_MESSAGE_CREATE",
		);

		expect(bridge.userThinkingLevels.get("USER_A")).toBe("high");

		// 3. 用户发送普通消息，验证 chatSpy 接收到了 model 与 thinkingLevel
		await bridge.onInboundMessage(
			{
				id: "msg_cmd_3",
				channel_id: "c_123",
				author: { id: "USER_A", bot: false },
				content: "写一个二分查找",
			},
			"AT_MESSAGE_CREATE",
		);

		expect(chatSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "deepseek/deepseek-chat",
				thinkingLevel: "high",
				text: expect.stringContaining("写一个二分查找"),
			}),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});

	it("双向同步：电脑网页端在 QQ 关联会话中的回复，能自动同步推送回 QQ 目标", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: "m_reply_sync" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_qq_sync" });

		const bridge = new QqBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({
				appId: "102030",
				clientSecret: "mock_secret",
				bindActive: true,
			}),
		});

		await bridge.start();

		// 1. QQ 端发一条消息建立绑定，并完成第一轮对话
		await bridge.onInboundMessage(
			{
				id: "msg_in_1",
				channel_id: "c_sync_1",
				author: { id: "USER_SYNC", bot: false },
				content: "同步测试提问",
			},
			"AT_MESSAGE_CREATE",
		);

		// 第一轮 run 完成，从 pendingRuns 中出队
		await runHandler!({
			conversationId: "conv_qq_sync",
			type: "run_end",
		});

		const chats = bridge.getRecentChats();
		expect(chats.length).toBeGreaterThan(0);
		expect(chats[0].lastUserText).toBe("同步测试提问");

		// 2. 此时会话已建立绑定。模拟电脑网页端在该会话中发起了新对话（非 pendingRuns 来源）
		runHandler!({
			conversationId: "conv_qq_sync",
			type: "message",
			message: {
				role: "assistant",
				content: "这是电脑网页端生成的回答内容",
			},
		});

		await runHandler!({
			conversationId: "conv_qq_sync",
			type: "run_end",
		});

		// 3. 验证触发了向 QQ 频道的推送，且内容带有电脑端同步标识
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/channels/c_sync_1/messages"),
			expect.objectContaining({
				body: expect.stringContaining("来自电脑网页端同步"),
			}),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});

	it("发送单斜杠 / 应当直接回复快捷指令菜单，不触发 host.chat", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: "m_reply_menu" }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn();
		const bridge = new QqBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({ appId: "102030", clientSecret: "mock_secret" }),
		});

		await bridge.onInboundMessage(
			{
				id: "msg_slash_only",
				channel_id: "c_123",
				author: { id: "USER_SLASH", bot: false },
				content: "/",
			},
			"AT_MESSAGE_CREATE",
		);

		expect(chatSpy).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/channels/c_123/messages"),
			expect.objectContaining({
				body: expect.stringContaining("QQ 机器人帮助与快捷指令菜单"),
			}),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});

	it("安全隔离守卫：电脑网页端自身发起的其他日常对话，绝不会被错误收录到 QQ 最近互动中", async () => {
		const chatSpy = vi.fn();
		let runHandler: ((ev: any) => void) | null = null;
		const bridge = new QqBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({ appId: "102030", clientSecret: "mock_secret" }),
		});

		await bridge.start();

		// 模拟用户在网页端自己的会话 (如 c14, c15) 产生事件
		runHandler!({
			conversationId: "conv_unrelated_web_chat_1",
			type: "message",
			message: {
				role: "assistant",
				content: "这是用户在网页端自己写代码的对话内容，与 QQ 无关",
			},
		});

		await runHandler!({
			conversationId: "conv_unrelated_web_chat_1",
			type: "run_end",
		});

		// 校验：recentChats 绝不包含这条无关对话
		const chats = bridge.getRecentChats();
		expect(chats.find((c) => c.conversationId === "conv_unrelated_web_chat_1")).toBeUndefined();
		expect(chats.length).toBe(0);

		await bridge.stop();
	});

	it("提问进入后若宿主分配了真实会话 ID（与初始临时 ID 不同），recentChats 应当迁移且仅有 1 条记录", async () => {
		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "c5" });
		const bridge = new QqBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
				broadcast: vi.fn(),
			},
			getConfig: () => ({ appId: "102030", clientSecret: "mock_secret" }),
		});

		await bridge.start();

		// 用户发问 "今日新闻"
		await bridge.onInboundMessage(
			{
				id: "msg_in_single",
				channel_id: "c_news",
				author: { id: "E009F0BF1B068C38C46CF14EA50FCCA3", bot: false },
				content: "今日新闻",
			},
			"AT_MESSAGE_CREATE",
		);

		const chats = bridge.getRecentChats();
		// 严防双记录：无论运行中还是结束后，必须只有 1 条记录，且会话 ID 是真实返回的 c5
		expect(chats.length).toBe(1);
		expect(chats[0].conversationId).toBe("c5");
		expect(chats[0].lastUserText).toBe("今日新闻");
		expect(bridge.userActiveConvs.get("E009F0BF1B068C38C46CF14EA50FCCA3")).toBe("c5");

		// 运行结束
		await runHandler!({
			conversationId: "c5",
			type: "run_end",
		});

		// 结束后 pendingRuns 完全清理
		const tempId = `qq_${"E009F0BF1B068C38C46CF14EA50FCCA3".slice(-8)}_0`;
		expect(bridge.pendingRuns.has(tempId)).toBe(false);
		expect(bridge.pendingRuns.has("c5")).toBe(false);

		const chatsAfter = bridge.getRecentChats();
		expect(chatsAfter.length).toBe(1);
		expect(chatsAfter[0].conversationId).toBe("c5");

		await bridge.stop();
	});
});
