/**
 * tests/unit/feishu-bot.test.ts
 * Verifies Feishu bot duplex bridge:
 * - Access control (whitelist / group mention mode)
 * - Slash command handling (/help, /clear, /status)
 * - Inbound event dispatch to host.chat
 * - Outbound Markdown chunk delivery on run_end
 */

import { describe, expect, it, vi } from "vitest";
import {
	extractInboundText,
	FeishuBotBridge,
	peerAccountId,
	stripInternalMarkers,
	stripMentions,
} from "../../plugins/feishu/bot-bridge.mjs";

describe("Feishu Bot 纯函数与辅助方法测试", () => {
	it("stripInternalMarkers 剥离内部系统标记与规范换行", () => {
		const raw = "这是正常的回答[[plan:123]]继续内容[[conv:abc]]。\n\n\n结尾";
		const cleaned = stripInternalMarkers(raw);
		expect(cleaned).toBe("这是正常的回答继续内容。\n\n结尾");
	});

	it("peerAccountId 生成稳定的脱敏 accountId", () => {
		const id1 = peerAccountId("ou_123456");
		const id2 = peerAccountId("ou_123456");
		expect(id1).toBe(id2);
		expect(id1.startsWith("fs_")).toBe(true);

		const defaultId = peerAccountId("");
		expect(defaultId).toBe("fs_default");
	});

	it("stripMentions 剥离 @mention 标签", () => {
		const input = "@_user_1 请帮我写一个快速排序 @BotName 谢谢";
		const output = stripMentions(input);
		expect(output).toBe("请帮我写一个快速排序  谢谢");
	});

	it("extractInboundText 能够正确提取 text 与 post 内容", () => {
		// 1. text
		expect(extractInboundText(JSON.stringify({ text: "你好机器人" }), "text")).toBe("你好机器人");

		// 2. post
		const post = {
			zh_cn: {
				content: [[{ tag: "text", text: "第一行" }], [{ tag: "text", text: "第二行" }]],
			},
		};
		expect(extractInboundText(JSON.stringify(post), "post")).toBe("第一行\n第二行");
	});
});

describe("FeishuBotBridge 双工通信流程测试", () => {
	it("斜杠命令 /help 应当直接回复帮助卡片，不触发 host.chat", async () => {
		const chatSpy = vi.fn();
		const replySpy = vi.fn().mockResolvedValue({ success: true });

		const bridge = new FeishuBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({ appId: "cli_123", appSecret: "sec_123" }),
			sendMessage: vi.fn(),
			replyMessage: replySpy,
			reactMessage: vi.fn(),
		} as any);

		await bridge.onInboundMessage({
			message: {
				message_id: "om_1",
				chat_id: "oc_1",
				message_type: "text",
				content: JSON.stringify({ text: "/help" }),
			},
			sender: {
				sender_type: "user",
				sender_id: { open_id: "ou_user1" },
			},
		});

		expect(chatSpy).not.toHaveBeenCalled();
		expect(replySpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				messageId: "om_1",
				msgType: "interactive",
				title: "飞书机器人帮助",
			}),
		);
	});

	it("白名单模式：不在白名单内的用户会被拒绝并收到提示信息", async () => {
		const chatSpy = vi.fn();
		const replySpy = vi.fn().mockResolvedValue({ success: true });

		const bridge = new FeishuBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				appId: "cli_123",
				appSecret: "sec_123",
				allowedSenders: ["ou_allowed_boss"],
			}),
			sendMessage: vi.fn(),
			replyMessage: replySpy,
			reactMessage: vi.fn(),
		} as any);

		await bridge.onInboundMessage({
			message: {
				message_id: "om_2",
				chat_id: "oc_1",
				message_type: "text",
				content: JSON.stringify({ text: "请帮我查一下数据" }),
			},
			sender: {
				sender_type: "user",
				sender_id: { open_id: "ou_stranger" },
			},
		});

		expect(chatSpy).not.toHaveBeenCalled();
		expect(replySpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				messageId: "om_2",
				text: expect.stringContaining("访问受限"),
			}),
		);
	});

	it("正常入站消息派发到 host.chat，并在 run_end 时回发 AI 回复", async () => {
		let registeredRunHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_test_1" });
		const replySpy = vi.fn().mockResolvedValue({ success: true });
		const reactSpy = vi.fn().mockResolvedValue({ success: true });

		const bridge = new FeishuBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					registeredRunHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({ appId: "cli_123", appSecret: "sec_123" }),
			sendMessage: vi.fn(),
			replyMessage: replySpy,
			reactMessage: reactSpy,
		} as any);

		await bridge.start();

		// 模拟用户发送提问
		await bridge.onInboundMessage({
			message: {
				message_id: "om_3",
				chat_id: "oc_1",
				message_type: "text",
				content: JSON.stringify({ text: "你好！" }),
			},
			sender: {
				sender_type: "user",
				sender_id: { open_id: "ou_user1" },
			},
		});

		expect(chatSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "你好！",
				accountId: expect.stringMatching(/^fs_/),
			}),
		);
		expect(reactSpy).toHaveBeenCalledWith(expect.anything(), "om_3", "THUMBSUP");

		// 获取派发后的会话 ID（宿主返回给插件并关联到 pendingRuns 的 conversationId）
		const convId = (await chatSpy.mock.results[0].value).conversationId;

		// 模拟模型输出消息增量
		registeredRunHandler!({
			conversationId: convId,
			type: "message",
			message: {
				role: "assistant",
				content: "你好！我是你的 AI 助手。[[plan:test]]",
			},
		});

		// 模拟会话完成
		await registeredRunHandler!({
			conversationId: convId,
			type: "run_end",
		});

		// 校验回包被清洗且正确回复
		expect(replySpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				messageId: "om_3",
				text: "你好！我是你的 AI 助手。",
			}),
		);

		await bridge.stop();
	});

	it("支持配置默认项目根目录 workspace 以及通过 /cwd 指令动态切换工作目录并透传给 host.chat", async () => {
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_cwd_1" });
		const replySpy = vi.fn().mockResolvedValue({ success: true });

		const bridge = new FeishuBotBridge({
			host: {
				cwd: "E:/default-host-cwd",
				chat: chatSpy,
				onRunEvent: () => () => {},
			},
			getConfig: () => ({
				appId: "cli_123",
				appSecret: "sec_123",
				workspace: "E:/configured-workspace",
			}),
			sendMessage: vi.fn(),
			replyMessage: replySpy,
			reactMessage: vi.fn(),
		});

		await bridge.start();

		// 1. 发送 /cwd 查看当前项目根目录
		await bridge.onInboundMessage({
			message: {
				message_id: "om_cwd_1",
				chat_id: "oc_1",
				message_type: "text",
				content: JSON.stringify({ text: "/cwd" }),
			},
			sender: {
				sender_type: "user",
				sender_id: { open_id: "ou_user1" },
			},
		});
		expect(chatSpy).not.toHaveBeenCalled();
		expect(replySpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				messageId: "om_cwd_1",
				text: expect.stringContaining("E:/configured-workspace"),
			}),
		);

		// 2. 发送 /cwd E:/custom-user-project 切换项目根目录
		await bridge.onInboundMessage({
			message: {
				message_id: "om_cwd_2",
				chat_id: "oc_1",
				message_type: "text",
				content: JSON.stringify({ text: "/cwd E:/custom-user-project" }),
			},
			sender: {
				sender_type: "user",
				sender_id: { open_id: "ou_user1" },
			},
		});
		expect(replySpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				messageId: "om_cwd_2",
				text: expect.stringContaining("E:/custom-user-project"),
			}),
		);

		// 3. 发送正常消息，校验 host.chat 收到了切换后的 cwd
		await bridge.onInboundMessage({
			message: {
				message_id: "om_cwd_3",
				chat_id: "oc_1",
				message_type: "text",
				content: JSON.stringify({ text: "请列出当前目录下的文件" }),
			},
			sender: {
				sender_type: "user",
				sender_id: { open_id: "ou_user1" },
			},
		});
		expect(chatSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "请列出当前目录下的文件",
				cwd: "E:/custom-user-project",
			}),
		);

		await bridge.stop();
	});

	it("飞书 WS 双工失败时如实置 state: error，不再假装已连接空转", async () => {
		const bridge = new FeishuBotBridge({
			host: { chat: vi.fn(), ensureDeps: vi.fn() },
			getConfig: () => ({ appId: "cli_123", appSecret: "sec_123" }),
		} as any);

		await bridge.start();

		const status = bridge.getStatus();
		expect(status.connected).toBe(false);
		expect(status.state).toBe("error");
		expect(status.lastError).toBeTruthy();

		await bridge.stop();
	});
});
