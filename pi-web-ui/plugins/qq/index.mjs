/**
 * plugins/qq/index.mjs
 * QQ Bot (腾讯开放平台 QQBot) integration for pi-web-ui.
 * Zero external dependencies (built-in fetch + node:crypto + native WebSocket).
 * Inspired by dsh-im & wechat-ilink: outbound WebSocket duplex chat (zero public IP),
 * structure-aware Markdown chunks, isolated multi-turn sessions,
 * access control whitelist, slash commands, model & thinkingLevel switches,
 * and workspace cwd binding.
 */

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { chunkMarkdownText } from "./markdown-chunks.mjs";

export const SECRET_CLIENT_SECRET = "qq.clientSecret";
const QQ_AUTH_URL = "https://bots.qq.com/app/getAppAccessToken";
const QQ_API_BASE = "https://api.sgroup.qq.com";

/** Strips internal system markers from assistant response text before delivery. */
export function stripInternalMarkers(text) {
	return String(text ?? "")
		.replace(/\[\[[A-Za-z][A-Za-z0-9_-]*:[^\]]*\]\]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** 校验工作目录合法性（防路径不存在或越界，Windows 下防 SystemRoot）。 */
export function checkCwdValid(cwd) {
	const trimmed = String(cwd ?? "").trim();
	if (!trimmed) return { ok: false, error: "工作目录不能为空" };
	let abs;
	try {
		abs =
			process.platform === "win32" && /^[A-Za-z]:$/.test(trimmed) ? `${trimmed.toUpperCase()}${sep}` : resolve(trimmed);
	} catch {
		return { ok: false, error: `工作目录路径非法：${trimmed}` };
	}
	try {
		if (!existsSync(abs) || !statSync(abs).isDirectory()) {
			return { ok: false, error: `目标项目不存在或不是目录：${trimmed}` };
		}
	} catch {
		return { ok: false, error: `无法访问目标项目：${trimmed}` };
	}
	if (process.platform === "win32") {
		const sysRoot = (process.env.SystemRoot || process.env.windir || "C:\\Windows")
			.replace(/\//g, "\\")
			.replace(/\\+$/, "");
		const norm = abs.replace(/\//g, "\\").replace(/\\+$/, "");
		const low = norm.toLowerCase();
		const rootLow = sysRoot.toLowerCase();
		if (low === rootLow || low.startsWith(`${rootLow}\\`)) {
			return { ok: false, error: `拒绝在系统目录执行：${abs}` };
		}
	}
	return { ok: true, abs };
}

/** Generates a stable, privacy-preserving accountId from QQ user OpenID or user ID and session seq. */
export function peerAccountId(userId, seq = 0, prefix = "qq") {
	const base = String(userId ?? "").trim();
	const raw = seq ? `${base}:${seq}` : base;
	if (!raw) return `${prefix}_default`;
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `${prefix}_${hash}`;
}

/** Extract text content and strip bot mention tags (<@!botId> or <@botId>) from QQ message. */
export function extractQqText(content = "", botId = "") {
	let text = String(content || "").trim();
	if (!text) return "";
	if (botId) {
		const regex = new RegExp(`<@!?${botId}>`, "g");
		text = text.replace(regex, "").trim();
	}
	return text.replace(/<@!\d+>/g, "").trim();
}

/**
 * Obtain QQBot Access Token from Tencent Open Platform.
 */
export async function getQqAccessToken(appId, clientSecret, { timeoutMs = 15000 } = {}) {
	if (!appId || !clientSecret) throw new Error("QQ AppID and ClientSecret are required.");
	const res = await fetch(QQ_AUTH_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json; charset=utf-8" },
		body: JSON.stringify({
			appId: String(appId).trim(),
			clientSecret: String(clientSecret).trim(),
		}),
		signal: AbortSignal.timeout(timeoutMs),
	});

	if (!res.ok) {
		throw new Error(`QQ Auth HTTP ${res.status}`);
	}

	const json = await res.json();
	if (!json.access_token) {
		throw new Error(json.msg || "Failed to obtain QQBot access token");
	}
	return {
		accessToken: json.access_token,
		expiresInSec: Number(json.expires_in) > 0 ? Number(json.expires_in) : 2 * 60 * 60,
	};
}

/**
 * QQ OpenAPI request helper.
 */
export async function qqApi(
	accessToken,
	method,
	path,
	payload = null,
	{ apiBase = QQ_API_BASE, timeoutMs = 15000 } = {},
) {
	const url = `${apiBase.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
	const headers = {
		Authorization: `QQBot ${accessToken}`,
		"Content-Type": "application/json; charset=utf-8",
		"User-Agent": "pi-web-ui-qqbot/0.1.0",
	};

	const res = await fetch(url, {
		method,
		headers,
		body: payload !== null ? JSON.stringify(payload) : undefined,
		signal: AbortSignal.timeout(timeoutMs),
	});

	if (!res.ok) {
		const errJson = await res.json().catch(() => ({}));
		throw new Error(errJson.message || `QQ HTTP ${res.status}`);
	}

	return await res.json().catch(() => ({}));
}

/**
 * QqBotBridge manages outbound WebSocket duplex exchange with Tencent QQ Open Platform.
 */
export class QqBotBridge {
	/**
	 * @param {object} options
	 * @param {any} options.host
	 * @param {() => any} options.getConfig
	 * @param {(level: string, msg: string) => void} [options.log]
	 */
	constructor({ host, getConfig, log } = {}) {
		this.host = host;
		this.getConfig = getConfig;
		this.log = log || ((level, msg) => console.log(`[qq-bot:${level}] ${msg}`));

		this.running = false;
		this.ws = null;
		this.heartbeatTimer = null;
		this.lastSequence = null;
		this.accessToken = "";
		this.tokenExpiresAt = 0;
		this.tokenRefreshInFlight = null;
		this.botUser = null;
		this.offRunEvent = null;

		this.seenMessageIds = new Set();
		this.pendingRuns = new Map();
		this.earlyRuns = new Map();
		this.inFlightConvs = new Set();
		this.lastInFlightStartedAt = 0;

		this.userWorkspaces = new Map();
		this.userModels = new Map();
		this.userThinkingLevels = new Map();
		this.userPlanMode = new Map();
		this.userActiveConvs = new Map(); // authorId -> conversationId (真实会话ID)
		this.peerSessionSeq = new Map();

		this.conversationBindings = new Map(); // convId -> { authorId, replyTarget, updatedAt }
		this.recentChats = []; // Array<{ conversationId, authorId, lastUserText, lastAssistantText, updatedAt }>
		this.webRunTexts = new Map(); // convId -> accumulatedText (电脑网页发起的双向同步累积)

		this.currentIntents = (1 << 30) | (1 << 25); // PUBLIC_GUILD_MESSAGES | GROUP_AND_C2C
		this.status = {
			enabled: false,
			connected: false,
			state: "idle", // 'idle' | 'connecting' | 'connected' | 'error'
			botUsername: "",
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

	getRecentChats() {
		return [...this.recentChats];
	}

	recordRecentChat(conversationId, authorId, { userText, assistantText } = {}) {
		if (!conversationId) return;
		// 严防非 QQ 会话写入：必须属于 QQ 绑定或当前排队任务
		if (!this.conversationBindings.has(conversationId) && !this.pendingRuns.has(conversationId)) {
			return;
		}
		const seq = this.peerSessionSeq.get(authorId) || 0;
		const pseudoOwner = `plugin:qq:${peerAccountId(authorId, seq)}`;
		let item = this.recentChats.find((c) => c.conversationId === conversationId);
		if (!item) {
			item = {
				conversationId,
				authorId: String(authorId || "qq_user"),
				ownerId: pseudoOwner,
				lastUserText: "",
				lastAssistantText: "",
				updatedAt: Date.now(),
			};
			this.recentChats.unshift(item);
		} else {
			this.recentChats = this.recentChats.filter((c) => c.conversationId !== conversationId);
			this.recentChats.unshift(item);
		}
		if (pseudoOwner) item.ownerId = pseudoOwner;
		if (userText !== undefined) item.lastUserText = String(userText).slice(0, 300);
		if (assistantText !== undefined) item.lastAssistantText = String(assistantText).slice(0, 300);
		item.updatedAt = Date.now();
		if (this.recentChats.length > 20) {
			this.recentChats = this.recentChats.slice(0, 20);
		}
		this.host?.broadcast?.({ type: "recent_chats", recentChats: this.getRecentChats() });
	}

	resolveWorkspace(authorId, cfg) {
		return String(this.userWorkspaces.get(authorId) || cfg?.workspace || this.host?.cwd || "").trim();
	}

	resolveModel(authorId, cfg) {
		return String(this.userModels.get(authorId) || cfg?.model || "").trim();
	}

	resolveThinkingLevel(authorId, cfg) {
		return String(this.userThinkingLevels.get(authorId) || cfg?.thinkingLevel || "").trim();
	}

	resolvePlanMode(authorId, cfg) {
		if (this.userPlanMode.has(authorId)) {
			return Boolean(this.userPlanMode.get(authorId));
		}
		return false;
	}

	async start() {
		if (this.running) return;
		this.running = true;
		this.status.enabled = true;
		this.status.state = "connecting";
		this.currentIntents = (1 << 30) | (1 << 25);

		const cfg = this.getConfig();
		if (!cfg.appId || !cfg.clientSecret) {
			this.status.state = "idle";
			this.status.lastError = "Missing QQ AppID or ClientSecret";
			return;
		}

		if (this.host.onRunEvent) {
			this.offRunEvent = this.host.onRunEvent((ev) => this.handleRunEvent(ev));
		}

		try {
			const auth = await getQqAccessToken(cfg.appId, cfg.clientSecret);
			this.accessToken = auth.accessToken;
			this.tokenExpiresAt = Date.now() + auth.expiresInSec * 1000;
			this.status.lastError = null;
			this.log("info", "QQBot access token obtained successfully");
		} catch (err) {
			this.status.state = "error";
			this.status.lastError = err.message;
			this.log("warn", `QQBot auth failed: ${err.message}`);
			return;
		}

		try {
			await this.connectGateway();
		} catch (err) {
			this.status.state = "error";
			this.status.lastError = err.message;
			this.log("warn", `QQ Gateway start failed: ${err.message}`);
		}
	}

	async stop() {
		this.running = false;
		this.status.enabled = false;
		this.status.connected = false;
		this.status.state = "idle";

		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}

		if (this.ws) {
			try {
				this.ws.close();
			} catch {}
			this.ws = null;
		}

		if (this.offRunEvent) {
			try {
				this.offRunEvent();
			} catch {}
			this.offRunEvent = null;
		}

		for (const run of this.pendingRuns.values()) {
			if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
		}
		this.pendingRuns.clear();
		this.earlyRuns.clear();

		this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
	}

	async ensureAccessToken() {
		const cfg = this.getConfig();
		const REFRESH_MARGIN_MS = 5 * 60 * 1000;
		if (this.accessToken && Date.now() < this.tokenExpiresAt - REFRESH_MARGIN_MS) {
			return this.accessToken;
		}
		if (!this.tokenRefreshInFlight) {
			this.tokenRefreshInFlight = (async () => {
				try {
					const auth = await getQqAccessToken(cfg.appId, cfg.clientSecret);
					this.accessToken = auth.accessToken;
					this.tokenExpiresAt = Date.now() + auth.expiresInSec * 1000;
				} catch (err) {
					this.log("warn", `QQBot token refresh failed: ${err.message}`);
				}
				return this.accessToken;
			})().finally(() => {
				this.tokenRefreshInFlight = null;
			});
		}
		return this.tokenRefreshInFlight;
	}

	async connectGateway() {
		const cfg = this.getConfig();
		const apiBase = cfg.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;

		let wssUrl;
		try {
			const token = await this.ensureAccessToken();
			const gw = await qqApi(token, "GET", "/gateway", null, { apiBase });
			wssUrl = gw?.url;
		} catch (err) {
			throw new Error(`Failed to obtain QQ Gateway URL: ${err.message}`);
		}

		if (!wssUrl) throw new Error("QQ /gateway returned empty URL");

		if (typeof globalThis.WebSocket === "undefined") {
			throw new Error("Node environment missing globalThis.WebSocket");
		}

		const ws = new globalThis.WebSocket(wssUrl);
		this.ws = ws;

		ws.onopen = () => {
			this.log("info", "QQBot WebSocket connection established");
		};

		ws.onmessage = (event) => {
			this.handleGatewayPayload(event.data);
		};

		ws.onerror = (err) => {
			this.status.lastError = err?.message || "WebSocket error";
			this.log("warn", `QQ Gateway error: ${this.status.lastError}`);
		};

		ws.onclose = (event) => {
			this.status.connected = false;
			if (this.heartbeatTimer) {
				clearInterval(this.heartbeatTimer);
				this.heartbeatTimer = null;
			}
			const code = event?.code;
			const reason = event?.reason || "";
			if (code === 4014 || code === 4903) {
				if (this.currentIntents !== 1 << 30) {
					this.currentIntents = 1 << 30;
					this.log?.("warn", `QQ Gateway reported ${code} (${reason}), falling back to base PUBLIC_GUILD_MESSAGES`);
				}
			}
			if (this.running) {
				this.status.state = "connecting";
				if (reason) this.status.lastError = `Gateway close ${code || ""}: ${reason}`;
				this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
				setTimeout(() => {
					if (this.running) this.connectGateway().catch(() => {});
				}, 5000);
			} else {
				this.status.state = "idle";
				this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
			}
		};
	}

	handleGatewayPayload(dataRaw) {
		let packet;
		try {
			const text = typeof dataRaw === "string" ? dataRaw : new TextDecoder().decode(dataRaw);
			packet = JSON.parse(text);
		} catch {
			return;
		}

		const { op, d, s, t } = packet;
		if (typeof s === "number") this.lastSequence = s;

		// Opcode 10: Hello -> start heartbeat and send Identify
		if (op === 10) {
			const interval = d?.heartbeat_interval || 30000;
			if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = setInterval(() => {
				if (this.ws && this.ws.readyState === 1) {
					this.ws.send(JSON.stringify({ op: 1, d: this.lastSequence }));
				}
			}, interval);

			const identifyPayload = {
				op: 2,
				d: {
					token: `QQBot ${this.accessToken}`,
					intents: this.currentIntents,
					properties: {
						$os: "linux",
						$browser: "pi-web-ui",
						$device: "pi-web-ui",
					},
				},
			};
			if (this.ws && this.ws.readyState === 1) {
				this.ws.send(JSON.stringify(identifyPayload));
			}
			return;
		}

		// Opcode 11: Heartbeat ACK
		if (op === 11) return;

		// Opcode 0: Dispatch
		if (op === 0) {
			if (t === "READY") {
				this.botUser = d?.user || {};
				this.status.botUsername = this.botUser.username || "QQBot";
				this.status.connected = true;
				this.status.state = "connected";
				this.status.lastError = null;
				this.log("info", `QQBot connected as ${this.status.botUsername} (ID: ${this.botUser.id})`);
				this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
			} else if (
				t === "AT_MESSAGE_CREATE" ||
				t === "DIRECT_MESSAGE_CREATE" ||
				t === "GROUP_AT_MESSAGE_CREATE" ||
				t === "C2C_MESSAGE_CREATE"
			) {
				this.onInboundMessage(d, t).catch((err) => {
					this.log("warn", `Inbound message handling error: ${err.message}`);
				});
			}
		}
	}

	async onInboundMessage(data, eventType) {
		if (!data) return;
		const messageId = data.id;
		if (messageId) {
			if (this.seenMessageIds.has(messageId)) return;
			this.seenMessageIds.add(messageId);
			if (this.seenMessageIds.size > 500) {
				const first = this.seenMessageIds.values().next().value;
				this.seenMessageIds.delete(first);
			}
		}

		// Extract author ID
		const authorId = data.author?.id || data.author?.user_openid || "";
		if (data.author?.bot) return;

		const botId = this.botUser?.id || "";
		const cleanText = extractQqText(data.content, botId);
		if (!cleanText) return;

		const cfg = this.getConfig();

		// Access control whitelist check
		const allowedUsers = Array.isArray(cfg.allowedUsers)
			? cfg.allowedUsers.map((u) => String(u).trim()).filter(Boolean)
			: [];
		if (allowedUsers.length > 0 && authorId && !allowedUsers.includes(String(authorId))) {
			this.log("info", `QQ user ${authorId} blocked by whitelist`);
			return;
		}

		this.status.messagesReceived++;
		this.status.lastMessageAt = Date.now();
		this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });

		const replyTarget = {
			eventType,
			channelId: data.channel_id,
			guildId: data.guild_id,
			groupOpenid: data.group_openid,
			userOpenid: data.author?.user_openid,
			msgId: messageId,
		};

		// Slash command handling (/help, /clear, /new, /status, /model, /thinking...)
		if (cleanText.startsWith("/") || /^\d+\/.+/.test(cleanText) || /^\d+$/.test(cleanText)) {
			const handled = await this.handleSlashCommand(cleanText, { authorId, replyTarget, cfg });
			if (handled) return;
		}

		await this.driveAuthor(authorId, cleanText, replyTarget);
	}

	async driveAuthor(authorId, cleanText, replyTarget) {
		const cfg = this.getConfig();
		const seq = this.peerSessionSeq.get(authorId) || 0;
		const accountId = peerAccountId(authorId, seq);

		let conversationId = `qq_${String(authorId).slice(-8)}_${seq}`;
		let bindCid = null;

		if (cfg.bindActive === true) {
			try {
				const active = this.host.getActiveConversation?.()?.conversationId;
				if (typeof active === "string" && active.trim()) {
					bindCid = active.trim();
					conversationId = bindCid;
				}
			} catch {}
		}

		const timeoutSec = Math.max(15, Number(cfg.replyTimeoutSec) || 90);
		const timeoutTimer = setTimeout(() => {
			const run = this.pendingRuns.get(conversationId);
			if (run && !run.noticed) {
				run.noticed = true;
				this.replyMessage(replyTarget, "⏳ 任务还在深度执行中，稍后把结果推给您…").catch(() => {});
			}
		}, timeoutSec * 1000);

		this.pendingRuns.set(conversationId, {
			authorId,
			replyTarget,
			accumulatedText: "",
			startedAt: Date.now(),
			timeoutTimer,
			noticed: false,
		});

		this.conversationBindings.set(conversationId, {
			authorId,
			replyTarget,
			updatedAt: Date.now(),
		});
		this.recordRecentChat(conversationId, authorId, { userText: cleanText });

		try {
			const workspace = this.resolveWorkspace(authorId, cfg);
			const model = this.resolveModel(authorId, cfg);
			const thinkingLevel = this.resolveThinkingLevel(authorId, cfg);
			const planMode = this.resolvePlanMode(authorId, cfg);

			const chatReq = {
				text: cleanText,
				accountId,
				conversationId,
			};
			if (workspace) chatReq.cwd = workspace;
			if (model) chatReq.model = model;
			if (thinkingLevel) chatReq.thinkingLevel = thinkingLevel;
			if (planMode) chatReq.planMode = true;

			const startedAt = Date.now();
			if (conversationId) this.inFlightConvs.add(conversationId);
			this.lastInFlightStartedAt = startedAt;

			const r = await this.host.chat(chatReq);
			if (r?.conversationId) {
				this.inFlightConvs.delete(r.conversationId);
				this.inFlightConvs.delete(conversationId);
				this.userActiveConvs.set(authorId, r.conversationId);
				if (r.conversationId !== conversationId) {
					const curRun = this.pendingRuns.get(conversationId);
					if (curRun) {
						curRun.canonicalId = r.conversationId;
						curRun.aliasId = conversationId;
						this.pendingRuns.set(r.conversationId, curRun);
					}
					const curBinding = this.conversationBindings.get(conversationId);
					if (curBinding) {
						this.conversationBindings.set(r.conversationId, curBinding);
					}
					// 关键修复：从 recentChats 中迁移旧的临时 conversationId，防止列表中同时出现两条相同的提问
					const oldIndex = this.recentChats.findIndex((c) => c.conversationId === conversationId);
					if (oldIndex >= 0) {
						this.recentChats[oldIndex].conversationId = r.conversationId;
						// 去重保障：避免重复
						this.recentChats = this.recentChats.filter(
							(c, i) => i === this.recentChats.findIndex((x) => x.conversationId === c.conversationId),
						);
						this.host?.broadcast?.({ type: "recent_chats", recentChats: this.getRecentChats() });
					} else {
						this.recordRecentChat(r.conversationId, authorId, { userText: cleanText });
					}
				}
			}
		} catch (err) {
			this.log("warn", `QQBot host.chat dispatch failed: ${err.message}`);
			const run = this.pendingRuns.get(conversationId);
			if (run?.timeoutTimer) clearTimeout(run.timeoutTimer);
			this.pendingRuns.delete(conversationId);
			this.conversationBindings.delete(conversationId);
			this.recentChats = this.recentChats.filter((c) => c.conversationId !== conversationId);
			this.host?.broadcast?.({ type: "recent_chats", recentChats: this.getRecentChats() });
			await this.replyMessage(replyTarget, `⚠️ 任务启动失败：${err.message}`).catch(() => {});
		}
	}

	async replyMessage(target, text, explicitSeq = null) {
		const cfg = this.getConfig();
		const apiBase = cfg.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;
		const token = await this.ensureAccessToken();

		// 同一 target 维护单调自增序号，绝不重复发送相同的 msg_seq 避免腾讯 304026 冲突
		if (!target.__nextSeq || typeof target.__nextSeq !== "number") {
			target.__nextSeq = 1;
		}
		const msgSeq = explicitSeq !== null ? explicitSeq : target.__nextSeq++;

		const payload = {
			content: text,
			msg_seq: msgSeq,
		};
		if (target.msgId) {
			payload.msg_id = target.msgId;
		}

		try {
			if (target.channelId) {
				await qqApi(token, "POST", `/channels/${target.channelId}/messages`, payload, { apiBase });
			} else if (target.groupOpenid) {
				await qqApi(token, "POST", `/v2/groups/${target.groupOpenid}/messages`, payload, { apiBase });
			} else if (target.userOpenid) {
				await qqApi(token, "POST", `/v2/users/${target.userOpenid}/messages`, payload, { apiBase });
			}
		} catch (err) {
			const errMsg = String(err?.message || "").toLowerCase();
			const isExpiredOrSeq =
				errMsg.includes("expire") ||
				errMsg.includes("timeout") ||
				errMsg.includes("304023") ||
				errMsg.includes("304024") ||
				errMsg.includes("304026") ||
				errMsg.includes("40040003") ||
				errMsg.includes("50006");

			// 遇到被动回复过期或 seq 冲突时降级重试：
			if (isExpiredOrSeq) {
				if (target.channelId) {
					// QQ 频道：去掉 msg_id/msg_seq 作为普通频道消息发送，100% 成功送达
					try {
						await qqApi(token, "POST", `/channels/${target.channelId}/messages`, { content: text }, { apiBase });
						this.log("info", "QQ channel passive reply expired, fallback to active channel message succeeded");
						return;
					} catch (fallbackErr) {
						this.log("warn", `QQ channel active fallback failed: ${fallbackErr.message}`);
					}
				} else if (target.groupOpenid || target.userOpenid) {
					// QQ 群/单聊：尝试作为主动消息重发
					try {
						const activePayload = { content: text };
						const path = target.groupOpenid
							? `/v2/groups/${target.groupOpenid}/messages`
							: `/v2/users/${target.userOpenid}/messages`;
						await qqApi(token, "POST", path, activePayload, { apiBase });
						this.log("info", "QQ group/c2c passive reply expired, fallback to active message succeeded");
						return;
					} catch (fallbackErr) {
						this.log("warn", `QQ group/c2c active fallback failed: ${fallbackErr.message}`);
					}
				}
			}
			throw err;
		}
	}

	async handleSlashCommand(cmdText, { authorId, replyTarget, cfg }) {
		const match = /^\/?([^\s]*)(?:\s+([\s\S]*))?$/.exec(cmdText.trim());
		if (!match) return false;

		let rawCmd = match[1].toLowerCase();
		const args = (match[2] ?? "").trim();

		const NUMBERED_COMMANDS = {
			1: "cwd",
			2: "new",
			3: "status",
			4: "model",
			5: "thinking",
			6: "plan",
			7: "compact",
			8: "stop",
			9: "reload",
			10: "help",
		};
		if (/^\d+\/.+/.test(rawCmd)) {
			rawCmd = rawCmd.split("/")[1] || rawCmd.split("/")[0];
		}
		const cmd = NUMBERED_COMMANDS[rawCmd] ?? rawCmd;

		switch (cmd) {
			case "":
			case "?":
			case "h":
			case "help":
			case "帮助": {
				const lines = [
					"🤖 **QQ 机器人帮助与快捷指令菜单**",
					"可直接发送 /序号（如 /1 或 /2 <提示词>）快捷操作：",
					"1/cwd : 查看或切换当前项目根目录",
					"2/new : 清空上下文开启全新会话 [提示词]",
					"3/status : 查看机器人运行状态与指标",
					"4/model : 查看或切换当前模型 [模型ID]",
					"5/thinking : 设置思考强度 <off|low|medium|high|max>",
					"6/plan : 开启或关闭计划模式 [on|off]",
					"7/compact : 压缩当前会话上下文 [说明]",
					"8/stop : 中止当前正在执行的任务",
					"9/reload : 重新加载扩展与配置",
					"10/help : 显示全部命令 (或发 /)",
				];
				await this.replyMessage(replyTarget, lines.join("\n")).catch(() => {});
				return true;
			}
			case "cwd":
			case "workspace": {
				if (!args) {
					const cur = this.resolveWorkspace(authorId, cfg) || "(跟随宿主当前项目)";
					const text = [
						`📂 当前项目根目录：${cur}`,
						"",
						"提示：",
						"• 发送 /cwd <目录绝对路径> 可切换根目录",
						"• 发送 /cwd default 可恢复跟随全局配置",
					].join("\n");
					await this.replyMessage(replyTarget, text).catch(() => {});
					return true;
				}
				if (["default", "默认", "clear", "reset"].includes(args.toLowerCase())) {
					this.userWorkspaces.delete(authorId);
					this.peerSessionSeq.set(authorId, (this.peerSessionSeq.get(authorId) || 0) + 1);
					const cur = this.resolveWorkspace(authorId, cfg) || "(跟随宿主当前项目)";
					await this.replyMessage(replyTarget, `📂 已恢复跟随全局根目录：${cur}\n✨ 已自动为您开启全新会话！`).catch(
						() => {},
					);
					return true;
				}
				const chk = checkCwdValid(args);
				if (!chk.ok) {
					await this.replyMessage(replyTarget, `⚠️ 切换失败：${chk.error}`).catch(() => {});
					return true;
				}
				this.userWorkspaces.set(authorId, chk.abs);
				this.peerSessionSeq.set(authorId, (this.peerSessionSeq.get(authorId) || 0) + 1);
				await this.replyMessage(
					replyTarget,
					`📂 已将项目根目录切换为：${chk.abs}\n✨ 已自动为您开启该目录下的全新会话！`,
				).catch(() => {});
				return true;
			}
			case "clear":
			case "new": {
				this.peerSessionSeq.set(authorId, (this.peerSessionSeq.get(authorId) || 0) + 1);
				for (const [convId, run] of this.pendingRuns.entries()) {
					if (run.authorId === authorId) {
						if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
						void this.host.abortRun?.(convId);
						this.pendingRuns.delete(convId);
					}
				}
				if (args) {
					await this.replyMessage(replyTarget, "✨ 已为您开启全新会话，正在执行指令…").catch(() => {});
					await this.driveAuthor(authorId, args, replyTarget);
					return true;
				}
				await this.replyMessage(replyTarget, "✨ 对话上下文已清空，已为您开启全新会话！").catch(() => {});
				return true;
			}
			case "status": {
				const s = this.status;
				const currentWs = this.resolveWorkspace(authorId, cfg) || "(跟随宿主当前项目)";
				const currentModel = this.resolveModel(authorId, cfg) || "(跟随全局默认)";
				const currentThinking = this.resolveThinkingLevel(authorId, cfg) || "(跟随全局设置)";
				const bindActive = cfg.bindActive === true ? "投递到网页活跃会话" : "独立无头会话";
				const planMode = this.resolvePlanMode(authorId, cfg) ? "已开启" : "未开启";
				let pendingCount = 0;
				for (const run of this.pendingRuns.values()) {
					if (run.authorId === authorId) pendingCount++;
				}
				const statusText = [
					"🟢 **QQ 机器人状态与运行指标**",
					"",
					`- 账号名称：${s.botUsername || "QQBot"} (ID: ${this.botUser?.id || "--"})`,
					`- 运行状态：${s.state === "connected" ? "在线 (WebSocket)" : s.state}`,
					`- 项目根目录：${currentWs}`,
					`- 当前模型：${currentModel}`,
					`- 思考强度：${currentThinking}`,
					`- 计划模式：${planMode}`,
					`- 投递模式：${bindActive}`,
					`- 已接收消息：${s.messagesReceived} 条`,
					`- 已回复消息：${s.messagesReplied} 条`,
					`- 进行中任务：${pendingCount} 个`,
				].join("\n");
				await this.replyMessage(replyTarget, statusText).catch(() => {});
				return true;
			}
			case "model": {
				if (!args) {
					const cur = this.resolveModel(authorId, cfg) || "(跟随全局默认)";
					const text = [
						`🤖 当前模型：${cur}`,
						"",
						"提示：",
						"• 发送 /model <模型ID> 可切换模型（如 /model deepseek/deepseek-chat）",
						"• 发送 /model default 可恢复跟随全局默认模型",
					].join("\n");
					await this.replyMessage(replyTarget, text).catch(() => {});
					return true;
				}
				if (["default", "默认", "clear", "reset"].includes(args.toLowerCase())) {
					this.userModels.delete(authorId);
					this.peerSessionSeq.set(authorId, (this.peerSessionSeq.get(authorId) || 0) + 1);
					await this.replyMessage(replyTarget, "🤖 已恢复跟随全局默认模型。\n✨ 已自动为您开启全新会话！").catch(
						() => {},
					);
					return true;
				}
				this.userModels.set(authorId, args);
				this.peerSessionSeq.set(authorId, (this.peerSessionSeq.get(authorId) || 0) + 1);
				await this.replyMessage(replyTarget, `🤖 已将模型切换为：${args}\n✨ 已自动为您开启该模型下的全新会话！`).catch(
					() => {},
				);
				return true;
			}
			case "thinking": {
				const ALIAS = {
					off: "off",
					minimal: "minimal",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: "max",
					关闭: "off",
					极简: "minimal",
					低: "low",
					中: "medium",
					高: "high",
					极高: "xhigh",
					最大: "max",
				};
				if (!args) {
					const cur = this.resolveThinkingLevel(authorId, cfg) || "(跟随全局设置)";
					const text = [
						`🧠 当前思考强度：${cur}`,
						"",
						"提示：",
						"• 发送 /thinking <档位> 可切换（off/minimal/low/medium/high/xhigh/max）",
						"• 发送 /thinking default 可恢复跟随全局设置",
					].join("\n");
					await this.replyMessage(replyTarget, text).catch(() => {});
					return true;
				}
				if (["default", "默认", "clear", "reset"].includes(args.toLowerCase())) {
					this.userThinkingLevels.delete(authorId);
					this.peerSessionSeq.set(authorId, (this.peerSessionSeq.get(authorId) || 0) + 1);
					await this.replyMessage(replyTarget, "🧠 已恢复跟随全局思考强度设置。\n✨ 已自动为您开启全新会话！").catch(
						() => {},
					);
					return true;
				}
				const mapped = ALIAS[args.toLowerCase()];
				if (!mapped) {
					await this.replyMessage(
						replyTarget,
						`⚠️ 无效的思考强度：${args}。可用档位：off / minimal / low / medium / high / xhigh / max`,
					).catch(() => {});
					return true;
				}
				this.userThinkingLevels.set(authorId, mapped);
				this.peerSessionSeq.set(authorId, (this.peerSessionSeq.get(authorId) || 0) + 1);
				await this.replyMessage(
					replyTarget,
					`🧠 已将思考强度设置为：${mapped}\n✨ 已自动为您开启该档位下的全新会话！`,
				).catch(() => {});
				return true;
			}
			case "plan": {
				const trimmed = args.toLowerCase();
				const cur = this.resolvePlanMode(authorId, cfg);
				const next = trimmed === "on" ? true : trimmed === "off" ? false : !cur;
				this.userPlanMode.set(authorId, next);
				await this.replyMessage(replyTarget, `📋 计划模式已${next ? "开启" : "关闭"}`).catch(() => {});
				return true;
			}
			case "compact": {
				const seq = this.peerSessionSeq.get(authorId) || 0;
				const convId = this.userActiveConvs.get(authorId) || `qq_${String(authorId).slice(-8)}_${seq}`;
				try {
					if (this.host.compactConversation) {
						await this.host.compactConversation(convId, args || undefined);
						await this.replyMessage(replyTarget, "🗜️ 已向 agent 触发会话压缩").catch(() => {});
					} else {
						await this.replyMessage(replyTarget, "⚠️ 当前宿主不支持手动触发会话压缩").catch(() => {});
					}
				} catch (err) {
					await this.replyMessage(replyTarget, `⚠️ 压缩失败：${err.message}`).catch(() => {});
				}
				return true;
			}
			case "stop": {
				let stopped = 0;
				for (const [convId, run] of this.pendingRuns.entries()) {
					if (run.authorId === authorId) {
						if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
						void this.host.abortRun?.(convId);
						this.pendingRuns.delete(convId);
						stopped++;
					}
				}
				if (stopped > 0) {
					await this.replyMessage(replyTarget, `⏹️ 已中止 ${stopped} 个正在执行的任务`).catch(() => {});
				} else {
					await this.replyMessage(replyTarget, "⏹️ 当前没有正在执行的任务").catch(() => {});
				}
				return true;
			}
			case "reload": {
				await this.replyMessage(replyTarget, "🔄 正在重新加载…").catch(() => {});
				return true;
			}
			default:
				return false;
		}
	}

	async handleRunEvent(ev) {
		const convId = ev.conversationId;
		if (!convId) return;

		// 关键安全守卫（与微信通道同级）：只有确定是由 QQ 机器人当前发起的调用、
		// 或已明确与 QQ 建立绑定关系的会话，才由本插件处理；
		// 严禁收录用户在电脑网页端自己手动发起的其他无关日常对话！
		const isPending = this.pendingRuns.has(convId);
		const isBound = this.conversationBindings.has(convId);
		const isInFlight = this.inFlightConvs.has(convId) || Date.now() - this.lastInFlightStartedAt < 5000;

		if (!isPending && !isBound && !isInFlight) {
			return; // 绝不让网页端普通对话进入 earlyRuns 或 recentChats！
		}

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
				} else if (this.conversationBindings.has(convId)) {
					const prev = this.webRunTexts.get(convId) || "";
					this.webRunTexts.set(convId, (prev ? "\n" : "") + content);
				} else {
					let early = this.earlyRuns.get(convId);
					if (!early) {
						early = { accumulatedText: "" };
						this.earlyRuns.set(convId, early);
					}
					early.accumulatedText += (early.accumulatedText ? "\n" : "") + content;
				}
			}
			return;
		}

		if (ev.type === "run_end") {
			const run = this.pendingRuns.get(convId) || this.earlyRuns.get(convId);
			if (run) {
				if (run.timeoutTimer) {
					clearTimeout(run.timeoutTimer);
				}
				this.pendingRuns.delete(convId);
				if (run.aliasId) {
					this.pendingRuns.delete(run.aliasId);
					this.conversationBindings.delete(run.aliasId);
				}
				if (run.canonicalId) {
					this.pendingRuns.delete(run.canonicalId);
				}
				this.earlyRuns.delete(convId);

				const rawText = run.accumulatedText || "";
				const cleanText = stripInternalMarkers(rawText);
				const finalText = cleanText || "✅ 任务已完成（无文本输出）。";

				const targetConvId = run.canonicalId || convId;
				this.recordRecentChat(targetConvId, run.authorId, { assistantText: finalText });

				const chunks = chunkMarkdownText(finalText, 3000);

				try {
					for (let i = 0; i < chunks.length; i++) {
						const seq = (run.replyTarget.__nextSeq = (run.replyTarget.__nextSeq || 0) + 1);
						await this.replyMessage(run.replyTarget, chunks[i], seq);
					}
					this.status.messagesReplied++;
					this.status.lastReplyAt = Date.now();
					this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
				} catch (err) {
					this.log("warn", `QQ reply delivery failed: ${err.message}`);
				}
				return;
			}

			// 电脑网页端发起的运行 -> 双向同步给 QQ
			const binding = this.conversationBindings.get(convId);
			if (binding && this.webRunTexts.has(convId)) {
				const webRaw = this.webRunTexts.get(convId) || "";
				this.webRunTexts.delete(convId);
				const cleanText = stripInternalMarkers(webRaw);
				if (!cleanText) return;

				this.recordRecentChat(convId, binding.authorId, { assistantText: cleanText });

				const cfg = this.getConfig();
				if (cfg.bindActive !== false && binding.replyTarget) {
					const syncText = `💻 [来自电脑网页端同步]\n${cleanText}`;
					const chunks = chunkMarkdownText(syncText, 3000);
					try {
						for (let i = 0; i < chunks.length; i++) {
							const seq = (binding.replyTarget.__nextSeq = (binding.replyTarget.__nextSeq || 0) + 1);
							await this.replyMessage(binding.replyTarget, chunks[i], seq);
						}
						this.status.messagesReplied++;
						this.status.lastReplyAt = Date.now();
						this.host?.broadcast?.({ type: "bot_status", status: this.getStatus() });
					} catch (err) {
						this.log("warn", `QQ web-to-bot sync delivery failed: ${err.message}`);
					}
				}
			}
		}
	}
}

/** Strip secrets from config before plaintext storage. */
export function stripSecretsFromConfig(cfg) {
	const c = { ...(cfg || {}) };
	delete c.clientSecret;
	delete c.hasClientSecret;
	return c;
}

/** Merge saved secrets into incoming config. */
export function mergeSavedSecrets(incoming, prev = {}, savedSecrets = {}) {
	const out = { ...(prev || {}), ...(incoming || {}) };
	const existingSecret = savedSecrets[SECRET_CLIENT_SECRET] || prev.clientSecret || "";

	if (incoming.clearClientSecret || !out.appId?.trim()) {
		out.clientSecret = "";
	} else if (typeof incoming.clientSecret === "string" && incoming.clientSecret.trim()) {
		out.clientSecret = incoming.clientSecret.trim();
	} else {
		out.clientSecret = existingSecret;
	}

	delete out.clearClientSecret;
	return out;
}

export default async function activate(host) {
	let localConfig = (await host.storage.get("config")) || {};
	const savedSecrets = (await host.secrets?.getAll?.()) || {};
	localConfig = mergeSavedSecrets(localConfig, {}, savedSecrets);

	const botBridge = new QqBotBridge({
		host,
		getConfig: () => localConfig,
		log: (lvl, msg) => host.log?.(lvl, msg),
	});

	if (localConfig.botEnabled && localConfig.appId && localConfig.clientSecret) {
		botBridge.start().catch((err) => {
			host.log?.("warn", `QQBot start note: ${err.message}`);
		});
	}

	// Register project right-click context menu action
	host.onUiAction?.("qq:set-workspace", (_itemId, _val, target) => {
		const path = target?.id !== undefined && target?.id !== null ? String(target.id).trim() : "";
		if (!path) return;
		const chk = checkCwdValid(path);
		if (chk.ok) {
			localConfig.workspace = chk.abs;
			void host.storage.set("config", stripSecretsFromConfig(localConfig));
			host.notify?.("info", `已将 QQ 机器人根目录设为：${chk.abs}`, `Set QQ bot workspace root to: ${chk.abs}`);
		}
	});

	// Register AI tool "qq" adhering strictly to tool-prompt-hygiene
	host.registerTool?.({
		name: "qq",
		description: "Send messages or notifications to QQ guild channels via Tencent QQBot Open API.",
		promptSnippet: "send messages to QQ channels",
		promptGuidelines: [
			"Confirm target channel_id and message text with the user once before action=send",
			"Use action=status to query bot connection status",
		],
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["send", "status"],
					description: "action to perform (send: send message; status: query connection status).",
				},
				channel_id: {
					type: "string",
					description: "send: target QQ guild channel ID.",
				},
				text: {
					type: "string",
					description: "send: text content to send.",
				},
			},
			required: ["action"],
		},
		async execute(args) {
			const action = String(args.action || "");
			switch (action) {
				case "send": {
					const channelId = args.channel_id?.trim() || localConfig.defaultChannelId?.trim();
					if (!channelId) throw new Error("channel_id is required.");
					if (!localConfig.appId || !localConfig.clientSecret) {
						throw new Error("QQBot AppID or ClientSecret is not configured.");
					}
					const token = await getQqAccessToken(localConfig.appId, localConfig.clientSecret).then((r) => r.accessToken);
					const apiBase = localConfig.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;
					const res = await qqApi(
						token,
						"POST",
						`/channels/${channelId}/messages`,
						{
							content: args.text || "",
						},
						{ apiBase },
					);
					return JSON.stringify(res, null, 2);
				}
				case "status": {
					return JSON.stringify(botBridge.getStatus(), null, 2);
				}
				default:
					throw new Error(`Unknown action: ${action}`);
			}
		},
	});

	// Handle UI client messages
	// 回包回显请求里的 __rid：宿主为「上行 send / 下行 onData」，
	// 客户端按 __rid 将回包精确配对到发起请求，保证 Promise 正常 resolve。
	host.onClientMessage?.(async (msg, replyRaw) => {
		const __rid = msg && msg.__rid;
		const reply = (payload) =>
			__rid === undefined
				? replyRaw(payload)
				: replyRaw(payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload, __rid } : payload);
		try {
			switch (msg.type) {
				case "get_state": {
					const secrets = (await host.secrets?.getAll?.()) || {};
					reply({
						type: "state",
						config: {
							appId: localConfig.appId || "",
							defaultChannelId: localConfig.defaultChannelId || "",
							workspace: localConfig.workspace || "",
							model: localConfig.model || "",
							thinkingLevel: localConfig.thinkingLevel || "",
							bindActive: Boolean(localConfig.bindActive),
							replyTimeoutSec: Number(localConfig.replyTimeoutSec) || 90,
							useSandbox: Boolean(localConfig.useSandbox),
							botEnabled: Boolean(localConfig.botEnabled),
							allowedUsers: localConfig.allowedUsers || [],
							hasClientSecret: Boolean(secrets[SECRET_CLIENT_SECRET] || localConfig.clientSecret),
						},
						botStatus: botBridge.getStatus(),
						recentChats: botBridge.getRecentChats(),
						hostCwd: String(host.cwd ?? "").trim(),
					});
					break;
				}

				case "set_workspace": {
					const ws = String(msg.workspace ?? "").trim();
					if (!ws) {
						localConfig.workspace = "";
					} else {
						const chk = checkCwdValid(ws);
						if (!chk.ok) {
							reply({ type: "set_workspace_done", success: false, message: chk.error });
							break;
						}
						localConfig.workspace = chk.abs;
					}
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					reply({ type: "set_workspace_done", success: true, workspace: localConfig.workspace });
					break;
				}

				case "save_config": {
					const incoming = msg.config || {};
					const secrets = (await host.secrets?.getAll?.()) || {};
					localConfig = mergeSavedSecrets(incoming, localConfig, secrets);

					if (host.secrets) {
						if (localConfig.clientSecret) {
							await host.secrets.set(SECRET_CLIENT_SECRET, localConfig.clientSecret);
						} else if (incoming.clearClientSecret) {
							await host.secrets.delete?.(SECRET_CLIENT_SECRET);
						}
					}

					await host.storage.set("config", stripSecretsFromConfig(localConfig));

					if (localConfig.botEnabled && localConfig.appId && localConfig.clientSecret) {
						await botBridge.stop().catch(() => {});
						await botBridge.start().catch(() => {});
					} else {
						await botBridge.stop().catch(() => {});
					}

					reply({ type: "save_config_done", success: true, botStatus: botBridge.getStatus() });
					break;
				}

				case "test_config": {
					const incoming = msg.config || {};
					const secrets = (await host.secrets?.getAll?.()) || {};
					const testCfg = mergeSavedSecrets(incoming, localConfig, secrets);

					if (!testCfg.appId || !testCfg.clientSecret) {
						reply({ type: "test_config_done", success: false, message: "未填入 AppID 或 ClientSecret" });
						break;
					}

					try {
						const token = await getQqAccessToken(testCfg.appId, testCfg.clientSecret).then((r) => r.accessToken);
						const apiBase = testCfg.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;
						const me = await qqApi(token, "GET", "/users/@me", null, { apiBase });
						reply({
							type: "test_config_done",
							success: true,
							message: `连接成功！已验证 QQ 机器人账号：${me.username || "QQBot"} (ID: ${me.id})`,
						});
					} catch (err) {
						reply({ type: "test_config_done", success: false, message: `连接失败: ${err.message}` });
					}
					break;
				}

				case "send_message": {
					const channelId = msg.channelId?.trim() || localConfig.defaultChannelId?.trim();
					if (!channelId) throw new Error("channelId is required.");
					if (!localConfig.appId || !localConfig.clientSecret) {
						throw new Error("QQBot AppID or ClientSecret is not configured.");
					}
					const token = await getQqAccessToken(localConfig.appId, localConfig.clientSecret).then((r) => r.accessToken);
					const apiBase = localConfig.useSandbox ? "https://sandbox.api.sgroup.qq.com" : QQ_API_BASE;
					const res = await qqApi(
						token,
						"POST",
						`/channels/${channelId}/messages`,
						{
							content: msg.text || "",
						},
						{ apiBase },
					);
					reply({ type: "send_done", success: true, res });
					break;
				}

				case "start_bot": {
					localConfig.botEnabled = true;
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					await botBridge.start();
					reply({ type: "bot_status", success: true, status: botBridge.getStatus() });
					break;
				}

				case "stop_bot": {
					localConfig.botEnabled = false;
					await host.storage.set("config", stripSecretsFromConfig(localConfig));
					await botBridge.stop();
					reply({ type: "bot_status", success: true, status: botBridge.getStatus() });
					break;
				}

				default:
					reply({ type: "error", success: false, message: `Unknown message type: ${msg.type}` });
					break;
			}
		} catch (err) {
			reply({ type: "error", success: false, message: err?.message || String(err) });
		}
	});

	return async () => {
		await botBridge.stop().catch(() => {});
	};
}
