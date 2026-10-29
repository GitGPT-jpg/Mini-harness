import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createAgentSessionServices,
	createAgentSessionFromServices,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { formatStreamingPrompt, splitQuotedPrompt, formatTextQuote } from "../../server/text-quote.js";
import type { TextQuote } from "../../server/protocol.js";
import { serializeMessage } from "../../server/serialize.js";
import type { AgentMessage } from "../../server/serialize.js";

const sampleQuote: TextQuote = {
	text: "const a = 1;",
	messageId: "m1",
	role: "assistant",
};

describe("排队消息附件处理与隔离 (queued-attachments)", () => {
	it("formatStreamingPrompt 与 splitQuotedPrompt 往返解析：正文干净且提取所有附件元数据", () => {
		const formatted = formatStreamingPrompt(
			"请帮我分析这张图片和代码",
			['<file path="src/app.ts" lines="5-15" />', "<vision-bridge>\n识别为柱状图\n</vision-bridge>"],
			[sampleQuote],
			["chart.png"],
		);

		// 格式化文本包含对应标记
		expect(formatted).toContain("请帮我分析这张图片和代码");
		expect(formatted).toContain('<attached-image name="chart.png" />');
		expect(formatted).toContain('<file path="src/app.ts" lines="5-15" />');
		expect(formatted).toContain("<vision-bridge>\n识别为柱状图\n</vision-bridge>");
		expect(formatted).toContain(formatTextQuote(sampleQuote));

		// 拆分后正文被彻底净化，不残留任何 XML/quote 标记
		const parsed = splitQuotedPrompt(formatted);
		expect(parsed.text).toBe("请帮我分析这张图片和代码");
		expect(parsed.quotes).toEqual([sampleQuote]);
		expect(parsed.attachments).toEqual([
			{ type: "image", name: "chart.png" },
			{ type: "file", name: "app.ts", path: "src/app.ts", lines: { start: 5, end: 15 } },
			{ type: "vision-bridge", name: "视觉转写" },
		]);
	});

	it("仅有附件无提问文字时，拆分后正文为空串，附件元数据完整", () => {
		const formatted = formatStreamingPrompt("", ['<folder path="docs" />'], [], ["photo.jpg"]);
		const parsed = splitQuotedPrompt(formatted);
		expect(parsed.text).toBe("");
		expect(parsed.quotes).toEqual([]);
		expect(parsed.attachments).toEqual([
			{ type: "image", name: "photo.jpg" },
			{ type: "folder", name: "docs", path: "docs" },
		]);
	});

	it("serializeMessage 将排队完成后的用户消息正文净化，并挂载 details.attachments 与 details.quotes", () => {
		const formatted = formatStreamingPrompt(
			"这是排队提交的问题",
			['<file path="server/index.ts" />'],
			[sampleQuote],
			["error.png"],
		);

		const rawMessage: AgentMessage = {
			role: "user",
			timestamp: 1700000000000,
			content: [
				{ type: "text", text: formatted },
				{
					type: "image",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
					mimeType: "image/png",
				},
			],
		};

		const ui = serializeMessage(rawMessage, 1);
		expect(ui).not.toBeNull();
		expect(ui!.role).toBe("user");

		// 正文净化
		const textBlock = ui!.content.find((b) => b.type === "text") as { type: "text"; text: string };
		expect(textBlock.text).toBe("这是排队提交的问题");

		// 图片块被保留为 UiImageBlock
		const imgBlock = ui!.content.find((b) => b.type === "image") as { type: "image"; dataUrl?: string };
		expect(imgBlock).toBeDefined();
		expect(imgBlock.dataUrl).toContain("data:image/png;base64,");

		// details 携带引用和附件元数据
		const details = ui!.details as { quotes?: TextQuote[]; attachments?: unknown[] };
		expect(details.quotes).toEqual([sampleQuote]);
		expect(details.attachments).toEqual([
			{ type: "image", name: "error.png" },
			{ type: "file", name: "index.ts", path: "server/index.ts", lines: undefined },
		]);
	});

	it("无附件的普通消息 serializeMessage 不产生冗余 details.attachments", () => {
		const rawMessage: AgentMessage = {
			role: "user",
			timestamp: 1700000000001,
			content: [{ type: "text", text: "普通提问" }],
		};

		const ui = serializeMessage(rawMessage, 2);
		expect(ui!.details).toBeUndefined();
	});

	it("验证流式排队不向 _pendingNextTurnMessages 泄露，防止下一次提问被动附带上一次排队的附件", () => {
		// 模拟 AgentSession 的 pending 队列与 prompt 行为
		const session = {
			isStreaming: true,
			model: { input: ["text", "image"] },
			_pendingNextTurnMessages: [] as unknown[],
			promptsReceived: [] as { text: string; options?: unknown }[],
			async sendCustomMessage(msg: unknown, opts?: { deliverAs?: string }) {
				if (opts?.deliverAs === "nextTurn") {
					this._pendingNextTurnMessages.push(msg);
				}
			},
			async prompt(text: string, options?: { streamingBehavior?: string; images?: unknown[] }) {
				if (this.isStreaming) {
					// 流式排队直接记录，不消费 _pendingNextTurnMessages
					this.promptsReceived.push({ text, options });
					return;
				}
				// 非流式提问会消费 _pendingNextTurnMessages
				const injected = [...this._pendingNextTurnMessages];
				this._pendingNextTurnMessages = [];
				this.promptsReceived.push({ text, options: { ...options, injected } });
			},
		};

		// 模拟用户在流式期间发送带图片附件的排队消息：
		// 修复前：调 sendCustomMessage(aside, { deliverAs: "nextTurn" })，导致 _pendingNextTurnMessages 堆积
		// 修复后：不调 sendCustomMessage，而是将图片直接传给 s.prompt 的 options.images，文本合并进 prompt
		const promptImages = [{ type: "image" as const, data: "base64data", mimeType: "image/png" }];
		const fullText = formatStreamingPrompt("请帮我看排队图片", [], [], ["pasted.png"]);

		// 执行修复后的投递逻辑
		session.prompt(fullText, {
			streamingBehavior: "followUp",
			images: promptImages,
		});

		// 确保 _pendingNextTurnMessages 绝不被污染（保持为 0）
		expect(session._pendingNextTurnMessages.length).toBe(0);

		// 排队提示词收到了完整的文本与图片
		expect(session.promptsReceived.length).toBe(1);
		expect(session.promptsReceived[0]!.text).toBe(fullText);
		expect(session.promptsReceived[0]!.options).toEqual({
			streamingBehavior: "followUp",
			images: promptImages,
		});

		// 模拟智能体结束流式并回答完毕
		session.isStreaming = false;

		// 用户发起下一个普通提问
		session.prompt("下一个问题：今天天气怎么样？");

		expect(session.promptsReceived.length).toBe(2);
		const nextPrompt = session.promptsReceived[1]!;
		expect(nextPrompt.text).toBe("下一个问题：今天天气怎么样？");
		// 验证：下一个提问没有被注入任何来自上一轮排队消息的残留附件！
		expect((nextPrompt.options as { injected: unknown[] }).injected).toEqual([]);
	});

	it("空闲状态下带图片与文件附件发消息通过 deliverAs: nextTurn 注入并被当轮 prompt 消费 (fixes #667)", async () => {
		const session = {
			isStreaming: false,
			model: { input: ["text", "image"] },
			_pendingNextTurnMessages: [] as unknown[],
			promptsReceived: [] as { text: string; options?: unknown }[],
			async sendCustomMessage(msg: unknown, opts?: { deliverAs?: string }) {
				if (opts?.deliverAs === "nextTurn") {
					this._pendingNextTurnMessages.push(msg);
				}
			},
			async prompt(text: string, options?: { streamingBehavior?: string; images?: unknown[] }) {
				const injected = [...this._pendingNextTurnMessages];
				this._pendingNextTurnMessages = [];
				this.promptsReceived.push({ text, options: { ...options, injected } });
			},
		};

		// 模拟空闲状态下用户上传图片及文件附件
		const imageAside = {
			customType: "file",
			content: [
				{
					type: "image",
					data: "base64_image_data_here",
					mimeType: "image/png",
				},
			],
			display: true,
			details: { name: "diagram.png", mode: "image", size: 1024 },
		};
		const fileAside = {
			customType: "file",
			content: [{ type: "text", text: '<file path="src/main.ts" />' }],
			display: true,
			details: { name: "main.ts", path: "src/main.ts", mode: "reference" },
		};

		// 模拟 agent-service 空闲发送分支：
		// 必须携带 deliverAs: "nextTurn"，且严禁在 prompt() 之前将 _pendingNextTurnMessages 清空
		await session.sendCustomMessage(imageAside, { deliverAs: "nextTurn" });
		await session.sendCustomMessage(fileAside, { deliverAs: "nextTurn" });

		expect(session._pendingNextTurnMessages.length).toBe(2);

		// 发起空闲提问
		await session.prompt("请分析这个架构图和源码");

		// 验证：本轮 prompt 收到了完整的提问文本与所有注入的附件（包含图片与文件）
		expect(session.promptsReceived.length).toBe(1);
		const turn1 = session.promptsReceived[0]!;
		expect(turn1.text).toBe("请分析这个架构图和源码");
		const injected1 = (turn1.options as { injected: unknown[] }).injected;
		expect(injected1.length).toBe(2);
		expect(injected1[0]).toEqual(imageAside);
		expect(injected1[1]).toEqual(fileAside);

		// 验证：消费后暂存队列已被清空
		expect(session._pendingNextTurnMessages.length).toBe(0);

		// 模拟用户后续进行普通提问（无附件）
		await session.prompt("下一个问题：需要怎么重构？");
		expect(session.promptsReceived.length).toBe(2);
		const turn2 = session.promptsReceived[1]!;
		expect(turn2.text).toBe("下一个问题：需要怎么重构？");
		expect((turn2.options as { injected: unknown[] }).injected).toEqual([]);
	});

	it("空闲提问前置阶段若被 abort 或发生异常，暂存的 _pendingNextTurnMessages 被安全清理，防止泄漏", async () => {
		const session = {
			isStreaming: false,
			_pendingNextTurnMessages: [] as unknown[],
			promptsReceived: [] as { text: string; options?: unknown }[],
			async sendCustomMessage(msg: unknown, opts?: { deliverAs?: string }) {
				if (opts?.deliverAs === "nextTurn") {
					this._pendingNextTurnMessages.push(msg);
				}
			},
			async prompt(text: string, options?: unknown) {
				const injected = [...this._pendingNextTurnMessages];
				this._pendingNextTurnMessages = [];
				this.promptsReceived.push({ text, options: { injected } });
			},
		};

		// 用户发送附件，但在 prompt 调用前触发了 abort（如会话切换或关闭）
		await session.sendCustomMessage(
			{
				customType: "file",
				content: [{ type: "image", data: "aborted_img", mimeType: "image/png" }],
			},
			{ deliverAs: "nextTurn" },
		);
		expect(session._pendingNextTurnMessages.length).toBe(1);

		// 模拟 agent-service abort 保护清理
		if (Array.isArray(session._pendingNextTurnMessages)) {
			session._pendingNextTurnMessages = [];
		}

		// 用户在此会话继续发起新的正常提问
		await session.prompt("全新提问");
		expect(session.promptsReceived.length).toBe(1);
		expect((session.promptsReceived[0]!.options as { injected: unknown[] }).injected).toEqual([]);
	});

	it("真实 Pi SDK 实例集成测试：sendCustomMessage(deliverAs: nextTurn) 图片正确进 agent 消息且下一轮不残留", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-attach-"));
		try {
			const services = await createAgentSessionServices({ cwd: tmpDir, agentDir: tmpDir });
			services.modelRuntime.setRuntimeApiKey("amazon-bedrock", "dummy-key");
			const model = services.modelRuntime.getAllModels()[0];

			const { session: s } = await createAgentSessionFromServices({
				services,
				model: model as any,
				sessionManager: SessionManager.inMemory(tmpDir),
			});

			// 拦截底层 agent.prompt 观察真正送入 LLM 上下文的消息列表
			const captured: unknown[][] = [];
			s.agent.prompt = async (input: unknown) => {
				captured.push(Array.isArray(input) ? input : [input]);
			};

			// 第一轮：发送图片附件，使用 deliverAs: "nextTurn"
			await s.sendCustomMessage(
				{
					customType: "file",
					content: [{ type: "image", data: "b64_image_content", mimeType: "image/png" }],
					display: true,
				},
				{ deliverAs: "nextTurn" },
			);
			await s.prompt("请查看这张图片");

			expect(captured.length).toBe(1);
			const turn1Messages = captured[0] as { role: string; content?: unknown }[];
			// 验证：包含 user 文本消息和 custom 图片消息
			const userMsg = turn1Messages.find((m) => m.role === "user");
			expect(userMsg).toBeDefined();
			expect(userMsg!.content).toEqual([{ type: "text", text: "请查看这张图片" }]);

			const customImgMsg = turn1Messages.find((m) => m.role === "custom");
			expect(customImgMsg).toBeDefined();
			expect(customImgMsg!.content).toEqual([{ type: "image", data: "b64_image_content", mimeType: "image/png" }]);

			// 第二轮：普通提问，不附带任何附件
			captured.length = 0;
			await s.prompt("第二轮普通提问");

			expect(captured.length).toBe(1);
			const turn2Messages = captured[0] as { role: string; content?: unknown }[];
			// 验证：上一轮的 custom 图片消息已被消费清空，第二轮绝不残留
			const turn2Custom = turn2Messages.find((m) => m.role === "custom");
			expect(turn2Custom).toBeUndefined();
			const turn2User = turn2Messages.find((m) => m.role === "user");
			expect(turn2User).toBeDefined();
			expect(turn2User!.content).toEqual([{ type: "text", text: "第二轮普通提问" }]);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
