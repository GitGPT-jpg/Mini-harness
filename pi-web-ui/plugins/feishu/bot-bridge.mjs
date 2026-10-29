/**
 * plugins/feishu/bot-bridge.mjs
 * Feishu (Lark) Bot duplex bridge for pi-web-ui.
 * Connects inbound Feishu messages (via outbound WebSocket / polling) to host.chat,
 * and delivers structure-aware Markdown responses back to Feishu chats.
 * Inspired by dsh-im architecture: zero inbound port opening, safe access control,
 * multi-turn conversation isolation, slash commands, and emoji feedback.
 */

import { createHash } from "node:crypto";
import { chunkMarkdownText } from "./markdown-chunks.mjs";

/** Strips internal system markers from assistant response text before delivery. */
export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Generates a stable, privacy-preserving accountId from sender's Open ID. */
export function peerAccountId(openId, prefix = "fs") {
	const raw = String(openId ?? "").trim();
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

/** Extract text content and mentions from Feishu inbound message payload. */
export function extractInboundText(contentRaw, msgType = "text") {
	let parsed = {};
	if (typeof contentRaw === "string") {
		try {
			parsed = JSON.parse(contentRaw);
		} catch {
			parsed = { text: contentRaw };
		}
	} else if (contentRaw && typeof contentRaw === "object") {
		parsed = contentRaw;
	}

	if (msgType === "text") {
		return String(parsed.text || "").trim();
	}

	if (msgType === "post") {
		const postBody = parsed.zh_cn || parsed.en_us || parsed.ja_jp || Object.values(parsed)[0] || {};
		const lines = [];
		const contentBlocks = Array.isArray(postBody.content) ? postBody.content : [];
		for (const row of contentBlocks) {
			if (!Array.isArray(row)) continue;
			const parts = [];
			for (const elem of row) {
				if (!elem) continue;
				if (elem.tag === "text") parts.push(elem.text || "");
				else if (elem.tag === "a") parts.push(elem.text ? `[${elem.text}](${elem.href || ""})` : elem.href || "");
				else if (elem.tag === "code_block") parts.push(`\n\`\`\`\n${elem.text || ""}\n\`\`\`\n`);
			}
			if (parts.length) lines.push(parts.join(""));
		}
		return lines.join("\n").trim();
	}

	return "";
}

/** Strips @mention tags (e.g. "@_user_1", "@BotName") from incoming text. */
export function stripMentions(text) {
	return String(text ?? "")
		.replace(/@\S+/g, "")
		.trim();
}

/**
 * FeishuBotBridge manages duplex message exchange between Feishu and pi-web-ui agent host.
 */
export class FeishuBotBridge {
	/**
	 * @param {object} options
	 * @param {any} options.host
	 * @param {() => any} options.getConfig
	 * @param {any} options.sendMessage
	 * @param {any} options.replyMessage
	 * @param {any} options.reactMessage
	 * @param {(level: string, msg: string) => void} [options.log]
	 */
	constructor({ host, getConfig, sendMessage, replyMessage, reactMessage, log }) {
		this.host = host;
		this.getConfig = getConfig;
		this.sendMessage = sendMessage;
		this.replyMessage = replyMessage;
		this.reactMessage = reactMessage;
		this.log = log || ((level, msg) => console.log(`[feishu-bot:${level}] ${msg}`));

		this.running = false;
		this.wsClient = null;
		this.pollTimer = null;
		this.offRunEvent = null;

		// Deduplication cache for message IDs (max 500)
		this.seenMessageIds = new Set();

		// Active runs tracking: conversationId -> run context
		this.pendingRuns = new Map();
		// Early arriving runs (microtask edge case protection)
		this.earlyRuns = new Map();

		// User to active conversationId mapping: openId -> conversationId
		this.userConversations = new Map();
		// User custom workspace root mapping: openId -> cwd path
		this.userWorkspaces = new Map();

		// Metrics and runtime status
		this.status = {
			enabled: false,
			connected: false,
			state: "idle", // 'idle' | 'connecting' | 'connected' | 'error'
			messagesReceived: 0,
			messagesReplied: 0,
			lastMessageAt: null,
			lastReplyAt: null,
			lastError: null,
		};
	}

	getStatus() {
		return { ...this.status };
	}

	/** Resolve active workspace directory for user or fallback to config/host cwd. */
	resolveWorkspace(openId, cfg) {
		return String(this.userWorkspaces.get(openId) || cfg?.workspace || this.host?.cwd || "").trim();
	}

	/** Start bot duplex bridge service. */
	async start() {
		if (this.running) return;
		this.running = true;
		this.status.enabled = true;
		this.status.state = "connecting";

		// Subscribe to host run events to stream/capture agent responses
		if (this.host.onRunEvent) {
			this.offRunEvent = this.host.onRunEvent((ev) => this.handleRunEvent(ev));
		}

		try {
			await this.connect();
		} catch (err) {
			this.status.state = "error";
			this.status.lastError = err.message;
			this.log("warn", `Bot connection start failed: ${err.message}`);
		}
	}

	/** Stop bot duplex bridge service. */
	async stop() {
		this.running = false;
		this.status.enabled = false;
		this.status.connected = false;
		this.status.state = "idle";

		if (this.wsClient) {
			try {
				this.wsClient.close();
			} catch {}
			this.wsClient = null;
		}

		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}

		if (this.offRunEvent) {
			try {
				this.offRunEvent();
			} catch {}
			this.offRunEvent = null;
		}
	}

	/**
	 * 加载官方 @larksuiteoapi/node-sdk。
	 * 飞书长连接的帧是二进制 protobuf（pbbp2.Frame），必须交给官方 SDK 解析——
	 * 旧实现把它当 JSON（TextDecoder + JSON.parse）并静默吞掉解析异常，所以永远
	 * 收不到 im.message.receive_v1。SDK 已 vendor 在插件 node_modules 下；若被插件
	 * 更新清掉，则请宿主（host.ensureDeps）npm 补装一次后重试。
	 */
	async loadSdk() {
		if (FeishuBotBridge._sdk) return FeishuBotBridge._sdk;
		const load = async () => {
			const mod = await import("@larksuiteoapi/node-sdk");
			// CJS bundle：node 下具名导出不一定齐全，兜底取 default
			return mod?.WSClient ? mod : (mod?.default ?? mod);
		};
		try {
			FeishuBotBridge._sdk = await load();
		} catch (err) {
			if (typeof this.host?.ensureDeps !== "function") throw err;
			this.log("info", "Feishu SDK 缺失，请宿主补装 @larksuiteoapi/node-sdk");
			await this.host.ensureDeps(["@larksuiteoapi/node-sdk"]);
			FeishuBotBridge._sdk = await load();
		}
		return FeishuBotBridge._sdk;
	}

	/** 配置里的 preset / baseUrl → SDK domain（枚举或私有化 URL 字符串）。 */
	resolveDomain(Lark, cfg) {
		const custom = String(cfg?.baseUrl ?? "").trim();
		if (custom && !/open\.(feishu\.cn|larksuite\.com)\/?$/i.test(custom)) return custom;
		if (cfg?.domain === "lark" || /larksuite\.com/i.test(custom)) {
			return Lark.Domain?.Lark ?? "https://open.larksuite.com";
		}
		return Lark.Domain?.Feishu ?? "https://open.feishu.cn";
	}

	/**
	 * 通过官方 SDK 建立飞书长连接（出站 WebSocket，无需公网 IP / 回调地址）。
	 * 事件由 EventDispatcher 分发；连接状态由 SDK 的 onReady/onError 等回调驱动，
	 * 面板上的「在线/离线」从此反映真实链路状态。
	 */
	async connect() {
		const cfg = this.getConfig();
		if (!cfg?.appId || !cfg?.appSecret) {
			this.status.state = "idle";
			this.status.lastError = "Missing Feishu App ID or App Secret";
			return;
		}

		const Lark = await this.loadSdk();
		if (typeof Lark?.WSClient !== "function" || typeof Lark?.EventDispatcher !== "function") {
			throw new Error("@larksuiteoapi/node-sdk 缺少 WSClient/EventDispatcher 导出");
		}

		const appId = cfg.appId.trim();
		if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
			// SDK 对 appId 格式有强校验，格式不符时它会直接 return（不报错），这里显式提示
			this.log("warn", `Feishu App ID 格式可疑：${appId}（SDK 期望 cli_ + 16 位十六进制）`);
		}

		const dispatcher = new Lark.EventDispatcher({}).register({
			"im.message.receive_v1": async (data) => {
				try {
					await this.onInboundMessage(data);
				} catch (err) {
					this.log("warn", `Inbound message handling error: ${err.message}`);
				}
			},
		});

		const fmt = (...a) =>
			a
				.map((x) =>
					typeof x === "string"
						? x
						: (() => {
								try {
									return JSON.stringify(x);
								} catch {
									return String(x);
								}
							})(),
				)
				.join(" ");

		const wsClient = new Lark.WSClient({
			appId,
			appSecret: cfg.appSecret.trim(),
			domain: this.resolveDomain(Lark, cfg),
			loggerLevel: Lark.LoggerLevel?.info,
			logger: {
				error: (...a) => this.log("error", `[lark.ws] ${fmt(...a)}`),
				warn: (...a) => this.log("warn", `[lark.ws] ${fmt(...a)}`),
				info: (...a) => this.log("info", `[lark.ws] ${fmt(...a)}`),
				debug: () => {},
				trace: () => {},
			},
			onReady: () => {
				this.status.connected = true;
				this.status.state = "connected";
				this.status.lastError = null;
				this.log("info", "Feishu 长连接已建立（官方 SDK）");
			},
			onReconnecting: () => {
				this.status.connected = false;
				this.status.state = "connecting";
			},
			onReconnected: () => {
				this.status.connected = true;
				this.status.state = "connected";
				this.status.lastError = null;
			},
			onError: (err) => {
				this.status.connected = false;
				this.status.state = "error";
				this.status.lastError = err?.message || String(err);
				this.log("warn", `Feishu 长连接错误: ${this.status.lastError}`);
			},
		});

		this.wsClient = wsClient;
		this.status.state = "connecting";

		try {
			// start() 只负责拉起连接（内部异步重连），不等待握手完成
			await wsClient.start({ eventDispatcher: dispatcher });
		} catch (err) {
			this.status.connected = false;
			this.status.state = "error";
			this.status.lastError = err?.message || String(err);
			throw err;
		}
	}

	/**
	 * Main inbound message processor.
	 * Invoked when an 'im.message.receive_v1' event arrives.
	 */
	async onInboundMessage(event) {
		if (!event || !event.message) return;
		const msg = event.message;
		const sender = event.sender || {};
		const messageId = msg.message_id;

		// Deduplicate
		if (messageId) {
			if (this.seenMessageIds.has(messageId)) return;
			this.seenMessageIds.add(messageId);
			if (this.seenMessageIds.size > 500) {
				const first = this.seenMessageIds.values().next().value;
				this.seenMessageIds.delete(first);
			}
		}

		// Only process user messages (skip bot loops)
		if (sender.sender_type && sender.sender_type !== "user") return;

		const openId = sender.sender_id?.open_id || sender.sender_id?.user_id || "";
		const chatId = msg.chat_id || "";
		const chatType = msg.chat_type || "p2p"; // 'p2p' or 'group'

		const cfg = this.getConfig();

		// Access Control: check allowed senders whitelist if configured
		const allowedSenders = Array.isArray(cfg.allowedSenders)
			? cfg.allowedSenders.map((s) => String(s).trim()).filter(Boolean)
			: [];
		if (allowedSenders.length > 0 && openId && !allowedSenders.includes(openId)) {
			this.replyMessage(cfg, {
				messageId,
				msgType: "text",
				text: "【访问受限】您当前不在该机器人的白名单中。请联系管理员在 Web 控制台「飞书配置 → 白名单」中添加您的 Open ID 即可开始对话。",
			}).catch(() => {});
			return;
		}

		// Group response mode check
		const groupResponseMode = cfg.groupResponseMode || "mention"; // 'mention' | 'all' | 'none'
		if (chatType === "group") {
			if (groupResponseMode === "none") return;
			if (groupResponseMode === "mention") {
				// Must contain bot mention
				const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
				const hasMention = mentions.length > 0;
				if (!hasMention) return;
			}
		}

		// Extract content
		const rawText = extractInboundText(msg.content, msg.message_type);
		const cleanText = stripMentions(rawText).trim();
		if (!cleanText) return;

		this.status.messagesReceived++;
		this.status.lastMessageAt = Date.now();

		// Handle slash commands (/help, /clear, /new, /status, /model)
		if (cleanText.startsWith("/")) {
			const handled = await this.handleSlashCommand(cleanText, { messageId, openId, chatId, cfg });
			if (handled) return;
		}

		// Provide immediate visual reaction (e.g. THUMBSUP / EYES)
		try {
			await this.reactMessage(cfg, messageId, "THUMBSUP");
		} catch {}

		// Prepare isolated agent session for this user
		const accountId = peerAccountId(openId);
		let conversationId = this.userConversations.get(openId);
		if (!conversationId) {
			conversationId = `fs_${openId.slice(-8)}_${Date.now().toString(36)}`;
			this.userConversations.set(openId, conversationId);
		}

		// Record pending run（先用本地临时 id 占位；host.chat 返回后改键成宿主会话 id）
		this.pendingRuns.set(conversationId, {
			messageId,
			chatId,
			openId,
			accumulatedText: "",
			startedAt: Date.now(),
		});

		// Dispatch to host.chat
		try {
			const workspace = this.resolveWorkspace(openId, cfg);
			const chatReq = {
				text: cleanText,
				accountId,
				conversationId,
			};
			if (workspace) chatReq.cwd = workspace;
			if (cfg.model) chatReq.model = cfg.model;
			if (cfg.thinkingLevel) chatReq.thinkingLevel = cfg.thinkingLevel;
			// 宿主 host.chat 是 fire-and-forget：运行结果经 onRunEvent(run_end) 按
			// 【宿主返回的】conversationId 关联。以前忽略回执、用本地编的 id 等事件，
			// 所以永远等不到 → 只回一个 👍 就没下文（也不报错）。
			const receipt = await this.host.chat(chatReq);
			const hostConvId = receipt && typeof receipt === "object" ? String(receipt.conversationId ?? "").trim() : "";
			if (hostConvId) {
				const pending = this.pendingRuns.get(conversationId);
				if (pending) {
					this.pendingRuns.delete(conversationId);
					const early = this.earlyRuns.get(hostConvId);
					if (early) {
						if (early.accumulatedText) {
							pending.accumulatedText = pending.accumulatedText
								? `${early.accumulatedText}\n${pending.accumulatedText}`
								: early.accumulatedText;
						}
						this.earlyRuns.delete(hostConvId);
						if (early.ended) {
							// 回执之前这轮就已经结束（极快/失败收尾）：直接补发
							await this.deliverReply(pending);
							this.userConversations.set(openId, hostConvId);
							this.log("info", `host.chat 已结束并补发 → conversationId=${hostConvId}`);
							return;
						}
					}
					this.pendingRuns.set(hostConvId, pending);
				}
				this.userConversations.set(openId, hostConvId);
				this.log("info", `host.chat 已投递 → conversationId=${hostConvId}`);
			}
		} catch (err) {
			this.log("warn", `host.chat dispatch failed: ${err.message}`);
			this.pendingRuns.delete(conversationId);
			await this.replyMessage(cfg, {
				messageId,
				msgType: "text",
				text: `任务启动失败：${err.message}`,
			}).catch(() => {});
		}
	}

	/** Handles slash commands without calling AI model. */
	async handleSlashCommand(cmdText, { messageId, openId, cfg }) {
		const parts = cmdText.trim().split(/\s+/);
		const cmd = parts[0].toLowerCase();

		switch (cmd) {
			case "/help": {
				const helpText = [
					"🤖 **pi-web-ui 飞书机器人帮助**",
					"",
					"- 直接发送文本即可与 AI 助手对话，支持多轮上下文",
					"- `/cwd` 或 `/workspace [路径]`：查看或切换当前项目根目录",
					"- `/clear` 或 `/new`：清空当前上下文，开启全新对话",
					"- `/status`：查看机器人运行状态与连接指标",
					"- `/model`：查看当前配置的 AI 模型",
					"- `/help`：展示本帮助信息",
				].join("\n");
				await this.replyMessage(cfg, {
					messageId,
					msgType: "interactive",
					title: "飞书机器人帮助",
					text: helpText,
					cardTemplate: "blue",
				});
				return true;
			}
			case "/cwd":
			case "/workspace": {
				const argPath = cmdText.replace(/^\/\S+/, "").trim();
				if (!argPath) {
					const currentWs = this.resolveWorkspace(openId, cfg) || "(默认跟随宿主当前项目)";
					await this.replyMessage(cfg, {
						messageId,
						msgType: "text",
						text: `📂 当前项目根目录：${currentWs}\n提示：发送 \`/cwd <目录绝对路径>\` 可切换项目根目录。`,
					});
					return true;
				}
				this.userWorkspaces.set(openId, argPath);
				const newId = `fs_${openId.slice(-8)}_${Date.now().toString(36)}`;
				this.userConversations.set(openId, newId);
				await this.replyMessage(cfg, {
					messageId,
					msgType: "text",
					text: `📂 已将项目根目录切换为：${argPath}\n✨ 已自动为您开启该目录下的全新会话！`,
				});
				return true;
			}
			case "/clear":
			case "/new": {
				// Reset conversation ID for user
				const newId = `fs_${openId.slice(-8)}_${Date.now().toString(36)}`;
				this.userConversations.set(openId, newId);
				await this.replyMessage(cfg, {
					messageId,
					msgType: "text",
					text: "✨ 对话上下文已清空，已为您开启全新会话！",
				});
				return true;
			}
			case "/status": {
				const s = this.status;
				const currentWs = this.resolveWorkspace(openId, cfg) || "(跟随当前项目)";
				const statusText = [
					`🟢 **连接状态**：${s.state === "connected" ? "已连接 (在线)" : s.state}`,
					`📂 **项目根目录**：${currentWs}`,
					`📥 **已接收消息**：${s.messagesReceived} 条`,
					`📤 **已回复消息**：${s.messagesReplied} 条`,
					`⏱️ **运行状态**：正常工作`,
				].join("\n");
				await this.replyMessage(cfg, {
					messageId,
					msgType: "interactive",
					title: "机器人运行状态",
					text: statusText,
					cardTemplate: "green",
				});
				return true;
			}
			case "/model": {
				const currentModel = cfg.model || "(默认跟随全局)";
				const currentThinking = cfg.thinkingLevel || "(跟随全局)";
				await this.replyMessage(cfg, {
					messageId,
					msgType: "text",
					text: `🤖 当前模型配置：\n- 模型 (Model)：${currentModel}\n- 思考强度 (Thinking)：${currentThinking}`,
				});
				return true;
			}
			default:
				return false;
		}
	}

	/** Handle run events from host agent runtime. */
	async handleRunEvent(ev) {
		const convId = ev.conversationId;
		if (!convId) return;

		// 1. Accumulate assistant message delta or text
		if (ev.type === "message" && ev.message) {
			const m = ev.message;
			let content = "";
			if (typeof m.content === "string") content = m.content;
			else if (Array.isArray(m.content)) {
				content = m.content
					.map((c) => (typeof c === "string" ? c : c.text || ""))
					.join("\n")
					.trim();
			}

			if (content && (m.role === "assistant" || m.author === "assistant")) {
				if (this.pendingRuns.has(convId)) {
					const r = this.pendingRuns.get(convId);
					r.accumulatedText += (r.accumulatedText ? "\n" : "") + content;
				} else {
					// Store early arrival
					let early = this.earlyRuns.get(convId);
					if (!early) {
						early = { accumulatedText: "", ended: false };
						this.earlyRuns.set(convId, early);
					}
					early.accumulatedText += (early.accumulatedText ? "\n" : "") + content;
				}
			}
			return;
		}

		// 2. Run completed
		if (ev.type === "run_end") {
			const run = this.pendingRuns.get(convId) || this.earlyRuns.get(convId);
			if (!run) {
				// run_end 先于 host.chat 回执到达：记「已结束」，回执到手时补发
				const early = this.earlyRuns.get(convId) || { accumulatedText: "", ended: false };
				early.ended = true;
				this.earlyRuns.set(convId, early);
				return;
			}
			this.pendingRuns.delete(convId);
			this.earlyRuns.delete(convId);
			await this.deliverReply(run);
		}
	}

	/** 把一次运行累积的文本分块回发到飞书（run_end，或「回执前已结束」的补发）。 */
	async deliverReply(run) {
		const cfg = this.getConfig();
		const rawText = run.accumulatedText || "";
		const cleanText = stripInternalMarkers(rawText);
		const finalText = cleanText || "✅ 任务已完成（无文本输出）。";

		// Use structure-aware chunking to protect code fences and respect Feishu char limits
		const chunks = chunkMarkdownText(finalText, 3800);

		try {
			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i];
				if (i === 0 && run.messageId) {
					// Reply to initial message
					await this.replyMessage(cfg, {
						messageId: run.messageId,
						msgType: "interactive",
						title: "AI 助手回复",
						text: chunk,
						cardTemplate: "blue",
						replyInThread: false,
					});
				} else {
					// Follow-up chunks sent to same chat
					await this.sendMessage(cfg, {
						receiveId: run.chatId,
						receiveIdType: "chat_id",
						msgType: "interactive",
						text: chunk,
						cardTemplate: "blue",
					});
				}
			}

			this.status.messagesReplied++;
			this.status.lastReplyAt = Date.now();

			// Add DONE reaction
			if (run.messageId) {
				try {
					await this.reactMessage(cfg, run.messageId, "DONE");
				} catch {}
			}
		} catch (err) {
			this.log("warn", `Feishu reply delivery failed: ${err.message}`);
		}
	}
}
