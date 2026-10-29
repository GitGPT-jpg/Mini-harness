/**
 * tests/unit/dingtalk-features.test.ts
 * Tests for DingTalk (钉钉) plugin:
 * - Pure signature, URL signing and message builders
 * - Bot duplex bridge logic: whitelist, slash commands, chat dispatch, and run_end reply
 */

import { describe, expect, it, vi } from "vitest";
import {
	buildDingtalkMessage,
	buildSignedWebhookUrl,
	DingtalkBotBridge,
	peerAccountId,
	signDingtalkWebhook,
	stripInternalMarkers,
} from "../../plugins/dingtalk/index.mjs";

describe("钉钉纯函数工具测试", () => {
	it("signDingtalkWebhook 计算合法的 HMAC-SHA256 签名，空密钥返回空", () => {
		expect(signDingtalkWebhook(1700000000, "")).toBe("");
		expect(signDingtalkWebhook(1700000000, null)).toBe("");

		const sig = signDingtalkWebhook(1700000000, "SEC12345678");
		expect(sig).toBeTruthy();
		expect(typeof sig).toBe("string");
		expect(signDingtalkWebhook(1700000000, "SEC12345678")).toBe(sig);
	});

	it("buildSignedWebhookUrl 拼接 timestamp 与 sign 参数", () => {
		const raw = "https://oapi.dingtalk.com/robot/send?access_token=xxx";
		const signed = buildSignedWebhookUrl(raw, "SECsecret");
		expect(signed).toContain("timestamp=");
		expect(signed).toContain("sign=");
	});

	it("buildDingtalkMessage 生成符合钉钉开放平台标准的载荷", () => {
		// 1. text
		const textMsg = buildDingtalkMessage({ msgType: "text", text: "测试消息" });
		expect(textMsg.msgtype).toBe("text");
		expect(textMsg.text!.content).toBe("测试消息");

		// 2. markdown
		const mdMsg = buildDingtalkMessage({ msgType: "markdown", title: "通报", text: "正文内容" });
		expect(mdMsg.msgtype).toBe("markdown");
		expect(mdMsg.markdown!.title).toBe("通报");
		expect(mdMsg.markdown!.text).toContain("正文内容");
	});

	it("peerAccountId 生成稳定的 dt_ 前缀脱敏标识", () => {
		const id1 = peerAccountId("staff_001");
		const id2 = peerAccountId("staff_001");
		expect(id1).toBe(id2);
		expect(id1.startsWith("dt_")).toBe(true);
		expect(peerAccountId("")).toBe("dt_default");
	});

	it("stripInternalMarkers 剥离内部系统标记", () => {
		const raw = "任务完成[[plan:abc]][[conv:123]]。\n\n正常正文";
		expect(stripInternalMarkers(raw)).toBe("任务完成。\n\n正常正文");
	});
});

describe("DingtalkBotBridge 双工逻辑测试", () => {
	it("白名单拦截：未在白名单中的员工消息被拒并回复提示", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn();
		const bridge = new DingtalkBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({
				allowedSenders: ["staff_admin"],
			}),
		});

		await bridge.onInboundMessage({
			msgId: "msg_1",
			senderStaffId: "staff_guest",
			sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=123",
			text: { content: "你好" },
		});

		expect(chatSpy).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://oapi.dingtalk.com/robot/sendBySession?session=123",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("访问受限"),
			}),
		);

		vi.unstubAllGlobals();
	});

	it("斜杠命令 /help 直接回包，不消耗模型", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });
		vi.stubGlobal("fetch", fetchMock);

		const chatSpy = vi.fn();
		const bridge = new DingtalkBotBridge({
			host: { chat: chatSpy },
			getConfig: () => ({}),
		});

		await bridge.onInboundMessage({
			msgId: "msg_2",
			senderStaffId: "staff_01",
			sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=abc",
			text: { content: "/help" },
		});

		expect(chatSpy).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://oapi.dingtalk.com/robot/sendBySession?session=abc",
			expect.objectContaining({
				body: expect.stringContaining("钉钉机器人帮助"),
			}),
		);

		vi.unstubAllGlobals();
	});

	it("正常消息驱动 host.chat，并在 run_end 时推送 Markdown 回复", async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ errcode: 0 }) });
		vi.stubGlobal("fetch", fetchMock);

		let runHandler: ((ev: any) => void) | null = null;
		const chatSpy = vi.fn().mockResolvedValue({ conversationId: "conv_dt_1" });

		const bridge = new DingtalkBotBridge({
			host: {
				chat: chatSpy,
				onRunEvent: (fn: any) => {
					runHandler = fn;
					return () => {};
				},
			},
			getConfig: () => ({}),
		});

		await bridge.start();

		await bridge.onInboundMessage({
			msgId: "msg_3",
			senderStaffId: "staff_02",
			sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=xyz",
			text: { content: "请写一段代码" },
		});

		expect(chatSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "请写一段代码",
				accountId: expect.stringMatching(/^dt_/),
			}),
		);

		const convId = chatSpy.mock.calls[0][0].conversationId;

		// 模拟流式增量与结束
		runHandler!({
			conversationId: convId,
			type: "message",
			message: {
				role: "assistant",
				content: "```js\nconsole.log('DingTalk');\n```[[plan:xyz]]",
			},
		});

		await runHandler!({
			conversationId: convId,
			type: "run_end",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"https://oapi.dingtalk.com/robot/sendBySession?session=xyz",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("console.log('DingTalk')"),
			}),
		);

		await bridge.stop();
		vi.unstubAllGlobals();
	});
});
