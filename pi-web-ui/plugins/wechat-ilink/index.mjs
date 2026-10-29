/**
 * wechat-ilink 服务端入口 —— 微信通道（ilink 协议）。
 *
 * 协议与腾讯 openclaw-weixin 同源（其 docs/protocol_zh_CN.md，MIT）：
 *   扫码登录（get_bot_qrcode → 轮询 get_qrcode_status）→ 出站长轮询
 *   getupdates 收消息 → host.chat 投给 agent → run_end 经 sendmessage 回包。
 * 全程出站 HTTPS，无需公网 IP / 开端口。
 *
 * v1 范围：单账号、文本双工；媒体只占位；默认只回私聊；每个已配对微信用户独立伪客户端/独立会话。
 * bot_token 存 host.secrets（AES-256-GCM，拷机解不开）；游标/配对存 storage。
 */

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

const API_DEFAULT = "https://ilinkai.weixin.qq.com";
const APP_ID = "bot";
/** 二维码状态轮询间隔。 */
const QR_POLL_MS = 2000;
/** getupdates 服务端长轮询约 35s，客户端掐 65s 超时。 */
const POLL_FETCH_MS = 65000;
/** 普通接口超时。 */
const API_FETCH_MS = 20000;
/** errcode/ret -14 = 会话受限，暂停 1 小时（照抄协议文档的客户端行为）。 */
const PAUSE_MS = 3600_000;
/** 网络错误退避：5s 起，最大 60s。 */
const BACKOFF_MIN_MS = 5000;
const BACKOFF_MAX_MS = 60000;
/** 收件箱内存环上限 / 待配对上限 / run 关联上限。 */
const INBOX_CAP = 100;
const PENDING_PEER_CAP = 50;
const PENDING_RUN_CAP = 50;
/** peerLastAt（peer 最近来消息时刻）上限：陌生 peer 会无界增长，FIFO 淘汰最旧的。 */
const PEER_LASTAT_CAP = 500;
/** 回包文本上限。 */
const REPLY_CAP = 4000;
/** 陌生人配对提示节流：每 peer 每小时最多一条。 */
const PAIR_TIP_MS = 3600_000;

function cut(s, cap) {
	s = String(s ?? "");
	return s.length <= cap ? s : `${s.slice(0, cap)}\n… [truncated]`;
}

/** "0.1.0" → 0x00MMNNPP 十进制串（协议要求的 ClientVersion 编码）。 */
export function encodeClientVersion(v) {
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ""));
	if (!m) return "0";
	// 0x00MMNNPP：major<<16 | minor<<8 | patch（首字节恒 0）。
	const n = ((Number(m[1]) & 0xff) << 16) | ((Number(m[2]) & 0xff) << 8) | (Number(m[3]) & 0xff);
	return String(n >>> 0);
}

/** 随机 uint32 十进制串再 base64（X-WECHAT-UIN）。 */
function randUin() {
	const n = Math.floor(Math.random() * 4294967296);
	return Buffer.from(String(n), "utf8").toString("base64");
}

function uuid() {
	return (
		globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
	);
}

async function fetchJson(url, { method = "POST", headers = {}, body, timeoutMs = API_FETCH_MS } = {}) {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: ac.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

/** 剥离 pi-web-ui 内部控制标记（例如 [[plan:...]]、[[todo:...]]、[[conv:...]]、[[notify:...]] 等）。 */
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

/** 按微信 peer 与会话序号生成稳定、无敏感明文且合规的 accountId（隔离每个微信用户的伪客户端与会话）。 */
export function peerAccountId(peer, seq = 0) {
	const base = String(peer ?? "").trim();
	const raw = seq ? `${base}:${seq}` : base;
	if (!raw) return "wx_default";
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	return `wx_${hash}`;
}

/** UiMessage → 纯文本（assistant 回包累积用，自动清理内部 marker）。 */
export function assistantTextOf(msg) {
	if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return "";
	const raw = msg.content
		.filter((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim())
		.map((b) => b.text)
		.join("\n");
	return stripInternalMarkers(raw);
}

/** 入站 item_list → 文本（文本直取，媒体占位，未知键嗅探）。 */
export function inboundTextOf(itemList) {
	const parts = [];
	for (const it of itemList ?? []) {
		if (!it || typeof it !== "object") continue;
		const keys = Object.keys(it);
		let handled = false;
		for (const k of keys) {
			const v = it[k];
			if (v && typeof v === "object" && typeof v.text === "string" && /text/i.test(k)) {
				if (v.text.trim()) parts.push(v.text);
				handled = true;
				break;
			}
		}
		if (handled) continue;
		const blob = JSON.stringify(it).toLowerCase();
		if (blob.includes("image")) parts.push("[图片]");
		else if (blob.includes("voice") || blob.includes("audio") || blob.includes("silk")) parts.push("[语音]");
		else if (blob.includes("video")) parts.push("[视频]");
		else if (blob.includes("file")) parts.push("[文件]");
		else parts.push("[不支持的消息类型]");
	}
	return parts.join("\n").trim();
}

/** ilink API 裸客户端（token 经 getToken 回调取，轮换/登出即时生效）。 */
export function createIlink({ base, version, getToken }) {
	const appHeaders = () => ({
		"Content-Type": "application/json",
		"iLink-App-Id": APP_ID,
		"iLink-App-ClientVersion": encodeClientVersion(version),
	});
	const authHeaders = () => ({
		...appHeaders(),
		AuthorizationType: "ilink_bot_token",
		Authorization: `Bearer ${getToken() ?? ""}`,
		"X-WECHAT-UIN": randUin(),
	});
	const baseInfo = () => ({ channel_version: String(version ?? ""), bot_agent: "pi-web-ui" });
	return {
		/** 取码：只带应用头 + AuthorizationType/UIN，不带 Authorization/base_info。 */
		async getQr(localTokens) {
			const r = await fetchJson(`${base}/ilink/bot/get_bot_qrcode?bot_type=3`, {
				headers: { ...appHeaders(), AuthorizationType: "ilink_bot_token", "X-WECHAT-UIN": randUin() },
				body: { local_token_list: (localTokens ?? []).filter(Boolean).slice(0, 10) },
			});
			return r;
		},
		async qrStatus(qrcode, verifyCode) {
			let u = `${base}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
			if (verifyCode) u += `&verify_code=${encodeURIComponent(verifyCode)}`;
			// 二维码轮询只发应用头（协议文档的客户端行为）。
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), API_FETCH_MS);
			try {
				const res = await fetch(u, { headers: appHeaders(), signal: ac.signal });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return await res.json();
			} finally {
				clearTimeout(timer);
			}
		},
		async getUpdates(buf) {
			return fetchJson(`${base}/ilink/bot/getupdates`, {
				headers: authHeaders(),
				body: { get_updates_buf: buf || "", base_info: baseInfo() },
				timeoutMs: POLL_FETCH_MS,
			});
		},
		async sendMessage({ to, text, contextToken }) {
			const makeBody = (ctxToken) => ({
				msg: {
					from_user_id: "",
					to_user_id: to,
					client_id: uuid(),
					message_type: 2,
					message_state: 2,
					...(ctxToken ? { context_token: ctxToken } : {}),
					item_list: [{ type: 1, text_item: { text: String(text ?? "") } }],
				},
				base_info: baseInfo(),
			});
			const r = await fetchJson(`${base}/ilink/bot/sendmessage`, {
				headers: authHeaders(),
				body: makeBody(contextToken),
			});
			if (r && typeof r.ret === "number" && r.ret !== 0) {
				// 若因 context_token 超时失效导致回复失败，去掉 context_token 降级主动重试一次
				if (contextToken) {
					try {
						const fallback = await fetchJson(`${base}/ilink/bot/sendmessage`, {
							headers: authHeaders(),
							body: makeBody(undefined),
						});
						if (fallback && (fallback.ret === 0 || fallback.ret === undefined)) {
							return fallback;
						}
					} catch {}
				}
				throw new Error(`sendmessage ret=${r.ret} ${r.errmsg ?? ""}`.trim());
			}
			return r;
		},
		async typingTicket(userId, contextToken) {
			const r = await fetchJson(`${base}/ilink/bot/getconfig`, {
				headers: authHeaders(),
				body: {
					ilink_user_id: userId,
					...(contextToken ? { context_token: contextToken } : {}),
					base_info: baseInfo(),
				},
			});
			return r?.typing_ticket;
		},
		async sendTyping(userId, ticket, on) {
			if (!ticket) return;
			try {
				await fetchJson(`${base}/ilink/bot/sendtyping`, {
					headers: authHeaders(),
					body: { ilink_user_id: userId, typing_ticket: ticket, status: on ? 1 : 2, base_info: baseInfo() },
				});
			} catch {
				/* 输入提示尽力而为 */
			}
		},
		async notify(path) {
			try {
				await fetchJson(`${base}/ilink/bot/msg/${path}`, {
					headers: authHeaders(),
					body: { base_info: baseInfo() },
				});
			} catch {
				/* 生命周期通知尽力而为 */
			}
		},
	};
}

export default {
	activate(host) {
		const VERSION = "0.1.0";
		let cfg = {};
		try {
			cfg = host.getSettings?.() ?? {};
		} catch {
			cfg = {};
		}
		const settings = () => cfg;
		const offSettings = host.onSettingsChanged?.((v) => {
			cfg = v ?? {};
			applyAiTool();
			pushState();
		});

		const store = host.storage;
		const secrets = host.secrets;
		const TOKEN_KEY = "bot_token";

		const st = {
			disposed: false,
			/** 登录态：{ base }；token 在 secrets 里。 */
			base: API_DEFAULT,
			botId: "",
			loginAt: 0,
			/** 取码态：{ qrcode, image }。 */
			qr: null,
			qrTimer: null,
			qrStop: false,
			/** 轮询态。 */
			polling: false,
			pollAbort: null,
			pausedUntil: 0,
			backoffMs: BACKOFF_MIN_MS,
			lastPollAt: 0,
			lastError: "",
			inbox: [],
			peerCtx: {},
			peerLastAt: {},
			allowedPeers: [],
			pendingPeers: [],
			pairTipAt: {},
			/** 统计指标 */
			messagesReceived: 0,
			messagesReplied: 0,
			/** 用户独立工作空间：peer → string */
			userWorkspaces: {},
			/** 用户独立模型配置：peer → string */
			userModels: {},
			/** 用户独立思考强度配置：peer → string */
			userThinkingLevels: {},
			/** 用户独立计划模式：peer → boolean */
			userPlanMode: {},
			/** 用户独立会话序号（/clear /new 递增）：peer → number */
			peerSessionSeq: {},
			/** conversationId → { to, ctx, timer, noticed }。 */
			pendingRuns: new Map(),
			/** conversationId → 已累积的 assistant 文本。 */
			runText: new Map(),
			toolOff: null,
			bgTask: null,
		};

		// ---- 持久化 ------------------------------------------------------
		function load() {
			try {
				const acct = store.get("account", {});
				st.base = typeof acct.base === "string" && acct.base ? acct.base : API_DEFAULT;
				st.botId = typeof acct.botId === "string" ? acct.botId : "";
				st.loginAt = typeof acct.loginAt === "number" ? acct.loginAt : 0;
				st.allowedPeers = Array.isArray(store.get("allowedPeers", [])) ? store.get("allowedPeers", []) : [];
				st.pendingPeers = Array.isArray(store.get("pendingPeers", [])) ? store.get("pendingPeers", []) : [];
				st.peerCtx = store.get("peerCtx", {}) ?? {};
				const stats = store.get("stats", {});
				st.messagesReceived = typeof stats.messagesReceived === "number" ? stats.messagesReceived : 0;
				st.messagesReplied = typeof stats.messagesReplied === "number" ? stats.messagesReplied : 0;
				st.userWorkspaces = store.get("userWorkspaces", {}) ?? {};
				st.userModels = store.get("userModels", {}) ?? {};
				st.userThinkingLevels = store.get("userThinkingLevels", {}) ?? {};
				st.userPlanMode = store.get("userPlanMode", {}) ?? {};
				st.peerSessionSeq = store.get("peerSessionSeq", {}) ?? {};
			} catch (err) {
				host.log("load state failed:", err?.message ?? err);
			}
		}
		function save() {
			try {
				store.set("account", { base: st.base, botId: st.botId, loginAt: st.loginAt });
				store.set("allowedPeers", st.allowedPeers.slice(0, 200));
				store.set("pendingPeers", st.pendingPeers.slice(0, PENDING_PEER_CAP));
				const ctx = {};
				for (const [k, v] of Object.entries(st.peerCtx).slice(-200)) ctx[k] = v;
				store.set("peerCtx", ctx);
				store.set("stats", { messagesReceived: st.messagesReceived, messagesReplied: st.messagesReplied });
				store.set("userWorkspaces", st.userWorkspaces);
				store.set("userModels", st.userModels);
				store.set("userThinkingLevels", st.userThinkingLevels);
				store.set("userPlanMode", st.userPlanMode);
				store.set("peerSessionSeq", st.peerSessionSeq);
			} catch (err) {
				host.log("save state failed:", err?.message ?? err);
			}
		}
		const getToken = () => {
			try {
				return secrets?.get?.(TOKEN_KEY) ?? undefined;
			} catch {
				return undefined;
			}
		};
		const isLoggedIn = () => !!getToken();
		const ilink = () => createIlink({ base: st.base, version: VERSION, getToken });
		const getWorkspace = () => String(settings().workspace ?? "").trim();
		const getHostCwd = () => {
			try {
				return String(host.cwd ?? "").trim();
			} catch {
				return "";
			}
		};
		const resolveWorkspace = (peer) => {
			const uws = st.userWorkspaces[peer];
			if (uws && typeof uws === "string") return uws;
			return getWorkspace() || getHostCwd();
		};
		const resolveModel = (peer) => {
			const um = st.userModels[peer];
			if (um && typeof um === "string") return um;
			return String(settings().model ?? "").trim();
		};
		const resolveThinkingLevel = (peer) => {
			const ut = st.userThinkingLevels[peer];
			if (ut && typeof ut === "string") return ut;
			return String(settings().thinkingLevel ?? "").trim();
		};
		function setWorkspace(rawPath) {
			const clean = String(rawPath ?? "")
				.trim()
				.slice(0, 1024);
			cfg = { ...cfg, workspace: clean };
			try {
				const prev = store.get("settings", {});
				const baseObj = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
				store.set("settings", { ...baseObj, workspace: clean });
			} catch (err) {
				host.log("save workspace failed:", err?.message ?? err);
			}
			host.notify(
				"info",
				clean ? `微信通道根目录已设为：${clean}` : "微信通道根目录已清空（跟随当前项目）",
				clean ? `WeChat workspace root set to: ${clean}` : "WeChat workspace root cleared (follows current project)",
			);
			pushState();
		}

		function setModel(model, thinkingLevel) {
			const cleanModel = String(model ?? "")
				.trim()
				.slice(0, 256);
			const cleanThinking = String(thinkingLevel ?? "")
				.trim()
				.slice(0, 64);
			cfg = { ...cfg, model: cleanModel, thinkingLevel: cleanThinking };
			try {
				const prev = store.get("settings", {});
				const baseObj = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
				store.set("settings", { ...baseObj, model: cleanModel, thinkingLevel: cleanThinking });
			} catch (err) {
				host.log("save model failed:", err?.message ?? err);
			}
			host.notify(
				"info",
				cleanModel ? `微信通道模型已设为：${cleanModel}` : "微信通道模型已设为跟随全局",
				cleanModel ? `WeChat model set to: ${cleanModel}` : "WeChat model set to follow global",
			);
			pushState();
		}

		function setBindActive(bindActive) {
			const active = Boolean(bindActive);
			cfg = { ...cfg, bindActive: active };
			try {
				const prev = store.get("settings", {});
				const baseObj = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
				store.set("settings", { ...baseObj, bindActive: active });
			} catch (err) {
				host.log("save bindActive failed:", err?.message ?? err);
			}
			host.notify(
				"info",
				active ? "已开启电脑手机消息同步（投递到网页当前会话）" : "已切换为独立无头会话",
				active ? "WeChat synced with active conversation" : "WeChat uses isolated headless session",
			);
			pushState();
		}

		// ---- 视图状态 ------------------------------------------------------
		function snapshot() {
			return {
				kind: "state",
				loggedIn: isLoggedIn(),
				botId: st.botId,
				loginAt: st.loginAt,
				polling: st.polling,
				paused: Date.now() < st.pausedUntil,
				lastPollAt: st.lastPollAt,
				lastError: st.lastError,
				qr: st.qr,
				allowedPeers: [...st.allowedPeers],
				pendingPeers: [...st.pendingPeers],
				inbox: st.inbox.slice(-30),
				pendingRuns: st.pendingRuns.size,
				workspace: getWorkspace(),
				hostCwd: getHostCwd(),
				model: String(settings().model ?? "").trim(),
				thinkingLevel: String(settings().thinkingLevel ?? "").trim(),
				bindActive: settings().bindActive === true,
				messagesReceived: st.messagesReceived,
				messagesReplied: st.messagesReplied,
			};
		}
		function pushState(to) {
			const p = snapshot();
			if (to) host.sendTo(to, p);
			else host.broadcast(p);
		}
		function pushInbox(entry) {
			st.inbox.push(entry);
			while (st.inbox.length > INBOX_CAP) st.inbox.shift();
			host.broadcast({ kind: "inbox", entry });
		}

		// ---- 配对 ----------------------------------------------------------
		function allowList() {
			return String(settings().allowFrom ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		}
		function isAllowed(peer) {
			const list = allowList();
			if (list.includes("*") || list.includes(peer)) return true;
			return st.allowedPeers.includes(peer);
		}
		function addPending(peer) {
			if (st.pendingPeers.includes(peer) || st.allowedPeers.includes(peer)) return;
			st.pendingPeers.unshift(peer);
			while (st.pendingPeers.length > PENDING_PEER_CAP) st.pendingPeers.pop();
			save();
			host.notify(
				"warning",
				`微信待配对：${peer}（在 💬 视图里允许/拒绝）`,
				`WeChat pairing pending: ${peer} (allow/deny in the 💬 view)`,
			);
			pushState();
		}

		// ---- 发送 ----------------------------------------------------------
		async function sendText(to, text, contextToken) {
			const client = ilink();
			let ticket;
			if (settings().typing !== false) {
				try {
					ticket = await client.typingTicket(to, contextToken);
					await client.sendTyping(to, ticket, true);
				} catch {
					/* 降级直发 */
				}
			}
			try {
				await client.sendMessage({ to, text, contextToken });
				st.messagesReplied++;
				save();
			} finally {
				if (ticket) await client.sendTyping(to, ticket, false);
			}
			pushInbox({ dir: "out", peer: to, text: cut(text, 500), at: Date.now() });
		}

		async function sendPairSuccess(peer) {
			const text = [
				"🎉 配对成功！直接发送消息即可对话。",
				"",
				"常用快捷操作（发送 / 查看全部）：",
				"1/cwd : 查看或切换当前项目根目录",
				"2/new : 清空上下文开启全新会话 [提示]",
				"8/stop : 中止当前正在执行的任务",
				"10/help : 显示全部命令 (或发 /)",
			].join("\n");
			await sendText(peer, text, st.peerCtx[peer]);
		}

		// ---- 驱动 agent ------------------------------------------------------
		const EARLY_RUN_CAP = 30;
		const EARLY_RUN_TTL_MS = 60_000;
		/** conversationId → { text: string, ended: boolean, at: number }（承接 host.chat 返回前提前到达的事件）。 */
		const earlyRuns = new Map();
		const inFlightConvs = new Map();
		let lastInFlightStartedAt = 0;

		function trimEarlyRuns() {
			const now = Date.now();
			for (const [id, rec] of earlyRuns) {
				if (now - rec.at > EARLY_RUN_TTL_MS) earlyRuns.delete(id);
			}
			while (earlyRuns.size >= EARLY_RUN_CAP) {
				const oldest = earlyRuns.keys().next().value;
				earlyRuns.delete(oldest);
			}
		}

		function trackRun(conversationId, to, contextToken, startedAt = 0) {
			while (st.pendingRuns.size >= PENDING_RUN_CAP) {
				const oldest = st.pendingRuns.keys().next().value;
				dropRun(oldest);
			}

			// issue #345：检查在 host.chat() 结果返回前是否已提前收到运行事件
			const early = earlyRuns.get(conversationId);
			if (early && (!startedAt || early.at >= startedAt - 500)) {
				earlyRuns.delete(conversationId);
				if (early.text) {
					st.runText.set(conversationId, early.text);
				}
				if (early.ended) {
					const clean = stripInternalMarkers(st.runText.get(conversationId) ?? "");
					const body = clean || "任务完成（无文本输出）。";
					dropRun(conversationId);
					const out = body.length > REPLY_CAP ? `${body.slice(0, REPLY_CAP)}\n…（超长截断）` : body;
					sendText(to, out, contextToken).catch((err) => host.log("reply failed:", err?.message ?? err));
					return;
				}
			} else {
				earlyRuns.delete(conversationId);
			}

			const timeoutMs = Math.min(900, Math.max(30, Number(settings().replyTimeoutSec ?? 180))) * 1000;
			const timer = setTimeout(() => {
				const p = st.pendingRuns.get(conversationId);
				if (!p || p.noticed) return;
				p.noticed = true;
				sendText(to, "还在执行，稍后把结果推给你。", contextToken).catch((err) =>
					host.log("timeout notice failed:", err?.message ?? err),
				);
			}, timeoutMs);
			st.pendingRuns.set(conversationId, { to, ctx: contextToken, timer, noticed: false, startedAt });
		}
		function dropRun(conversationId) {
			const p = st.pendingRuns.get(conversationId);
			if (p) clearTimeout(p.timer);
			st.pendingRuns.delete(conversationId);
			st.runText.delete(conversationId);
			earlyRuns.delete(conversationId);
			inFlightConvs.delete(conversationId);
		}

		async function drivePeer(peer, text, contextToken) {
			const label = `微信:${peer}`;
			// issue #226：透传宿主 host.chat 四件套（工作空间/模型/思考强度/绑定网页会话）。
			// issue #345：按微信用户 ID 与会话序号隔离 accountId，避免全员共享同一伪客户端与无头会话。
			const seq = st.peerSessionSeq[peer] || 0;
			const req = { text: `[${label}] ${text}`, accountId: peerAccountId(peer, seq) };
			const workspace = resolveWorkspace(peer);
			if (workspace) req.cwd = workspace;
			const model = resolveModel(peer);
			if (model) req.model = model;
			const thinkingLevel = resolveThinkingLevel(peer);
			if (thinkingLevel) req.thinkingLevel = thinkingLevel;

			let bindCid = null;
			if (settings().bindActive === true) {
				try {
					const cid = host.getActiveConversation?.()?.conversationId;
					if (typeof cid === "string" && cid.trim()) {
						bindCid = cid.trim();
						req.conversationId = bindCid;
						// 在投递前先彻底清空该会话历史残留的 runText 和 earlyRuns，杜绝跨轮叠加
						dropRun(bindCid);
					}
				} catch {
					/* 无打开对话则走无头，不阻断 */
				}
			}

			const startedAt = Date.now();
			if (bindCid) inFlightConvs.set(bindCid, startedAt);
			lastInFlightStartedAt = startedAt;

			try {
				const r = await host.chat(req);
				if (r?.conversationId) {
					inFlightConvs.delete(r.conversationId);
					st.runText.delete(r.conversationId);
					trackRun(r.conversationId, peer, contextToken, startedAt);
				}
			} catch (err) {
				if (bindCid) inFlightConvs.delete(bindCid);
				host.log("host.chat failed:", err?.message ?? err);
				sendText(peer, `执行失败：${err?.message ?? err}`, contextToken).catch(() => {});
			}
		}

		const offRun = host.onRunEvent((ev) => {
			try {
				const convId = ev.conversationId;
				if (!convId) return;

				if (st.pendingRuns.has(convId)) {
					if (ev.type === "message" && ev.message) {
						const t = assistantTextOf(ev.message);
						if (t) {
							const prev = st.runText.get(convId) ?? "";
							st.runText.set(convId, cut(`${prev}\n${t}`.trim(), REPLY_CAP + 200));
						}
						return;
					}
					if (ev.type !== "run_end") return;
					const p = st.pendingRuns.get(convId);
					if (!p) return;
					const raw = (st.runText.get(convId) ?? "").trim();
					const clean = stripInternalMarkers(raw);
					const body = clean || "任务完成（无文本输出）。";
					dropRun(convId); // 先取值再清（dropRun 会删 runText）。
					const out = body.length > REPLY_CAP ? `${body.slice(0, REPLY_CAP)}\n…（超长截断）` : body;
					sendText(p.to, out, p.ctx).catch((err) => host.log("reply failed:", err?.message ?? err));
					return;
				}

				// issue #345：若 convId 暂未在 pendingRuns 登记（host.chat 的 Promise 还在微任务中）
				// 关键安全守卫：只有确定是微信当前正在发起的调用会话，才作为 earlyRuns 收集；
				// 绝不收录网页端自身手动发起的其他会话事件！
				const isRelevant = inFlightConvs.has(convId) || Date.now() - lastInFlightStartedAt < 5000;
				if (!isRelevant) return;

				if (ev.type === "message" && ev.message) {
					const t = assistantTextOf(ev.message);
					if (t) {
						trimEarlyRuns();
						let rec = earlyRuns.get(convId);
						if (!rec) {
							rec = { text: "", ended: false, at: Date.now() };
							earlyRuns.set(convId, rec);
						}
						rec.text = cut(`${rec.text}\n${t}`.trim(), REPLY_CAP + 200);
						rec.at = Date.now();
					}
					return;
				}
				if (ev.type === "run_end") {
					trimEarlyRuns();
					let rec = earlyRuns.get(convId);
					if (!rec) {
						rec = { text: "", ended: true, at: Date.now() };
						earlyRuns.set(convId, rec);
					} else {
						rec.ended = true;
						rec.at = Date.now();
					}
				}
			} catch (err) {
				host.log("run event failed:", err?.message ?? err);
			}
		});

		// ---- 斜杠快捷指令 ----------------------------------------------------
		const CORE_NUMBERED_COMMANDS = {
			1: "cwd",
			一: "cwd",
			2: "new",
			二: "new",
			3: "status",
			三: "status",
			4: "model",
			四: "model",
			5: "thinking",
			五: "thinking",
			6: "plan",
			六: "plan",
			7: "compact",
			七: "compact",
			8: "stop",
			八: "stop",
			9: "reload",
			九: "reload",
			10: "help",
			十: "help",
		};

		async function handleSlashCommand(cmdText, { peer, ctx }) {
			const normalized = String(cmdText ?? "")
				.trim()
				.replace(/^／/, "/");

			// 兼容 "1/cwd"、"2/new" 等无前导斜杠但带数字序号的格式
			let raw = normalized;
			if (/^\d+\/[a-zA-Z]/.test(raw)) {
				raw = "/" + raw;
			}
			if (!raw.startsWith("/")) return false;

			const match = /^\/([^\s]*)(?:\s+([\s\S]*))?$/.exec(raw);
			if (!match) return false;

			let rawCmd = match[1].toLowerCase();
			const args = (match[2] ?? "").trim();

			// 兼容形如 "1/cwd" 的命令片段，提取出 "cwd" 或 "1"
			if (/^\d+\/.+/.test(rawCmd)) {
				rawCmd = rawCmd.split("/")[1] || rawCmd.split("/")[0];
			}

			// 获取系统中已注册的插件命令
			const pluginCmds = (host.getPluginCommands?.() ?? []).filter(
				(c) => c && c.name && !CORE_NUMBERED_COMMANDS[c.name],
			);
			const pluginCmdMap = new Map();
			pluginCmds.forEach((c, idx) => {
				const numKey = String(11 + idx);
				pluginCmdMap.set(numKey, c.name.toLowerCase());
			});

			const cmd = CORE_NUMBERED_COMMANDS[rawCmd] ?? pluginCmdMap.get(rawCmd) ?? rawCmd;

			switch (cmd) {
				case "":
				case "?":
				case "h":
				case "help":
				case "帮助": {
					const lines = [
						"可直接发送 /序号（如 /1 或 /2 <提示>）快捷操作：",
						"1/cwd : 查看或切换当前项目根目录",
						"2/new : 清空上下文开启全新会话 [提示]",
						"3/status : 查看通道运行状态与指标",
						"4/model : 查看或切换当前模型 [名称]",
						"5/thinking : 设置思考强度 <off|low|high|max>",
						"6/plan : 开启或关闭计划模式 [on|off]",
						"7/compact : 压缩当前会话上下文 [说明]",
						"8/stop : 中止当前正在执行的任务",
						"9/reload : 重新加载扩展与配置",
						"10/help : 显示全部命令 (或发 /)",
					];
					if (pluginCmds.length > 0) {
						pluginCmds.forEach((c, idx) => {
							const num = 11 + idx;
							const hint = c.argumentHint ? ` ${c.argumentHint}` : "";
							lines.push(`${num}/${c.name} : ${c.description || "插件命令"}${hint}`);
						});
					}
					await sendText(peer, lines.join("\n"), ctx).catch((err) =>
						host.log("reply slash failed:", err?.message ?? err),
					);
					return true;
				}
				case "cwd":
				case "workspace": {
					if (!args) {
						const currentWs = resolveWorkspace(peer) || "(跟随宿主当前项目)";
						const text = [
							`📂 当前项目根目录：${currentWs}`,
							"",
							"提示：",
							"• 发送 /cwd <目录绝对路径> 可切换根目录",
							"• 发送 /cwd default 可恢复跟随全局配置",
						].join("\n");
						await sendText(peer, text, ctx).catch((err) => host.log("reply slash failed:", err?.message ?? err));
						return true;
					}
					if (["default", "默认", "clear", "reset"].includes(args.toLowerCase())) {
						delete st.userWorkspaces[peer];
						st.peerSessionSeq[peer] = (st.peerSessionSeq[peer] || 0) + 1;
						save();
						const currentWs = resolveWorkspace(peer) || "(跟随宿主当前项目)";
						await sendText(peer, `📂 已恢复跟随全局根目录：${currentWs}\n✨ 已自动为您开启全新会话！`, ctx).catch(
							(err) => host.log("reply slash failed:", err?.message ?? err),
						);
						return true;
					}
					const chk = checkCwdValid(args);
					if (!chk.ok) {
						await sendText(peer, `⚠️ 切换失败：${chk.error}`, ctx).catch((err) =>
							host.log("reply slash failed:", err?.message ?? err),
						);
						return true;
					}
					st.userWorkspaces[peer] = chk.abs;
					st.peerSessionSeq[peer] = (st.peerSessionSeq[peer] || 0) + 1;
					save();
					await sendText(peer, `📂 已将项目根目录切换为：${chk.abs}\n✨ 已自动为您开启该目录下的全新会话！`, ctx).catch(
						(err) => host.log("reply slash failed:", err?.message ?? err),
					);
					return true;
				}
				case "clear":
				case "new": {
					st.peerSessionSeq[peer] = (st.peerSessionSeq[peer] || 0) + 1;
					save();
					for (const [convId, run] of st.pendingRuns.entries()) {
						if (run.to === peer) {
							void host.abortRun?.(convId);
							dropRun(convId);
						}
					}
					if (args) {
						await sendText(peer, "✨ 已为您开启全新会话，正在执行指令…", ctx).catch((err) =>
							host.log("reply slash failed:", err?.message ?? err),
						);
						await drivePeer(peer, args, ctx);
						return true;
					}
					await sendText(peer, "✨ 对话上下文已清空，已为您开启全新会话！", ctx).catch((err) =>
						host.log("reply slash failed:", err?.message ?? err),
					);
					return true;
				}
				case "status": {
					let stateStr = "已停止";
					if (st.polling) {
						if (Date.now() < st.pausedUntil) {
							const mins = Math.max(1, Math.ceil((st.pausedUntil - Date.now()) / 60000));
							stateStr = `暂停中 (会话受限，约 ${mins} 分钟后恢复)`;
						} else {
							stateStr = "在线 (长轮询中)";
						}
					} else if (isLoggedIn()) {
						stateStr = "已登录 (未轮询)";
					}
					const currentWs = resolveWorkspace(peer) || "(跟随宿主当前项目)";
					const currentModel = resolveModel(peer) || "(跟随全局默认)";
					const currentThinking = String(settings().thinkingLevel ?? "").trim() || "(跟随全局设置)";
					const bindActive = settings().bindActive === true ? "投递到网页活跃会话" : "独立无头会话";
					const statusText = [
						"🟢 微信通道运行状态",
						"",
						`• 账号 ID：${st.botId || "(未命名)"}`,
						`• 通道状态：${stateStr}`,
						`• 项目根目录：${currentWs}`,
						`• 当前模型：${currentModel}`,
						`• 思考强度：${currentThinking}`,
						`• 投递模式：${bindActive}`,
						`• 已接收消息：${st.messagesReceived} 条`,
						`• 已回复消息：${st.messagesReplied} 条`,
						`• 进行中任务：${st.pendingRuns.size} 个`,
						st.loginAt ? `• 登录时间：${new Date(st.loginAt).toLocaleString()}` : "",
					]
						.filter(Boolean)
						.join("\n");
					await sendText(peer, statusText, ctx).catch((err) => host.log("reply slash failed:", err?.message ?? err));
					return true;
				}
				case "model": {
					if (!args) {
						const currentModel = resolveModel(peer) || "(跟随全局默认)";
						const text = [
							`🤖 当前模型：${currentModel}`,
							"",
							"提示：",
							"• 发送 /model <模型ID> 可切换微信通道模型（如 /model deepseek/deepseek-chat）",
							"• 发送 /model default 可恢复跟随全局配置",
						].join("\n");
						await sendText(peer, text, ctx).catch((err) => host.log("reply slash failed:", err?.message ?? err));
						return true;
					}
					if (["default", "默认", "clear", "reset"].includes(args.toLowerCase())) {
						delete st.userModels[peer];
						st.peerSessionSeq[peer] = (st.peerSessionSeq[peer] || 0) + 1;
						save();
						await sendText(peer, "🤖 已恢复跟随全局默认模型。\n✨ 已自动为您开启全新会话！", ctx).catch((err) =>
							host.log("reply slash failed:", err?.message ?? err),
						);
						return true;
					}
					st.userModels[peer] = args;
					st.peerSessionSeq[peer] = (st.peerSessionSeq[peer] || 0) + 1;
					save();
					await sendText(peer, `🤖 已将模型切换为：${args}\n✨ 已自动为您开启该模型下的全新会话！`, ctx).catch((err) =>
						host.log("reply slash failed:", err?.message ?? err),
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
						const cur = resolveThinkingLevel(peer) || "(跟随全局设置)";
						const text = [
							`🧠 当前思考强度：${cur}`,
							"",
							"提示：",
							"• 发送 /thinking <档位> 可切换（off/minimal/low/medium/high/xhigh/max）",
							"• 发送 /thinking default 可恢复跟随全局设置",
						].join("\n");
						await sendText(peer, text, ctx).catch((err) => host.log("reply slash failed:", err?.message ?? err));
						return true;
					}
					if (["default", "默认", "clear", "reset"].includes(args.toLowerCase())) {
						delete st.userThinkingLevels[peer];
						st.peerSessionSeq[peer] = (st.peerSessionSeq[peer] || 0) + 1;
						save();
						await sendText(peer, "🧠 已恢复跟随全局思考强度设置。\n✨ 已自动为您开启全新会话！", ctx).catch((err) =>
							host.log("reply slash failed:", err?.message ?? err),
						);
						return true;
					}
					const mapped = ALIAS[args.toLowerCase()];
					if (!mapped) {
						await sendText(
							peer,
							`⚠️ 无效的思考强度：${args}。可用档位：off / minimal / low / medium / high / xhigh / max`,
							ctx,
						).catch((err) => host.log("reply slash failed:", err?.message ?? err));
						return true;
					}
					st.userThinkingLevels[peer] = mapped;
					st.peerSessionSeq[peer] = (st.peerSessionSeq[peer] || 0) + 1;
					save();
					await sendText(peer, `🧠 已将思考强度设置为：${mapped}\n✨ 已自动为您开启该档位下的全新会话！`, ctx).catch(
						(err) => host.log("reply slash failed:", err?.message ?? err),
					);
					return true;
				}
				case "plan": {
					const trimmed = args.toLowerCase();
					const cur = Boolean(st.userPlanMode[peer]);
					const next = trimmed === "on" ? true : trimmed === "off" ? false : !cur;
					st.userPlanMode[peer] = next;
					save();
					const msg = next
						? "📋 计划模式已开启：AI 仅生成计划方案，不实施写操作。"
						: "📋 计划模式已关闭：恢复正常模式。";
					await sendText(peer, msg, ctx).catch((err) => host.log("reply slash failed:", err?.message ?? err));
					return true;
				}
				case "compact": {
					await sendText(peer, "🗜️ 正在请求压缩当前会话上下文…", ctx).catch((err) =>
						host.log("reply slash failed:", err?.message ?? err),
					);
					void drivePeer(peer, `/compact ${args}`.trim(), ctx);
					return true;
				}
				case "reload": {
					try {
						await host.reload?.();
						await sendText(peer, "🔄 已重新加载扩展、技能与提示模板。", ctx).catch(() => {});
					} catch (err) {
						await sendText(peer, `⚠️ 重载失败：${err?.message ?? err}`, ctx).catch(() => {});
					}
					return true;
				}
				case "stop":
				case "abort": {
					let stopped = 0;
					for (const [convId, run] of st.pendingRuns.entries()) {
						if (run.to === peer) {
							void host.abortRun?.(convId);
							dropRun(convId);
							stopped++;
						}
					}
					const msg = stopped > 0 ? "⏹️ 已中止当前正在执行的任务。" : "当前没有正在执行的任务。";
					await sendText(peer, msg, ctx).catch((err) => host.log("reply slash failed:", err?.message ?? err));
					return true;
				}
				default: {
					// 尝试执行第三方插件命令（如 /todo, /note, /remind 等）
					if (host.execCommand) {
						try {
							const execRes = await host.execCommand(cmd, args, {
								clientId: `plugin:wechat-ilink:${peerAccountId(peer)}`,
							});
							if (execRes?.ok && typeof execRes.result === "string" && execRes.result.trim()) {
								await sendText(peer, execRes.result.trim(), ctx).catch((err) =>
									host.log("reply plugin cmd failed:", err?.message ?? err),
								);
								return true;
							}
						} catch {
							/* 忽略并回退 */
						}
					}
					return false;
				}
			}
		}

		// ---- 入站 ----------------------------------------------------------
		/** 记 peer 最近来消息时刻：Map 增长有界（上限 PEER_LASTAT_CAP，FIFO 淘汰最旧的），
		 *  与 pendingPeers/peerCtx 的既有上限风格一致，防陌生 peer 无限堆积。 */
		function touchPeerLastAt(peer, at) {
			st.peerLastAt[peer] = at;
			const keys = Object.keys(st.peerLastAt);
			if (keys.length <= PEER_LASTAT_CAP) return;
			for (const k of keys.slice(0, keys.length - PEER_LASTAT_CAP)) delete st.peerLastAt[k];
		}

		async function handleInbound(m) {
			try {
				if (!m || typeof m !== "object") return;
				if (m.message_type !== 1) return; // 只要用户消息
				const peer = String(m.from_user_id ?? "");
				if (!peer) return;
				if (m.group_id && settings().respondGroups !== true) return; // 默认不回群
				const ctx = typeof m.context_token === "string" ? m.context_token : undefined;
				if (ctx) {
					st.peerCtx[peer] = ctx;
					save();
				}
				const text = inboundTextOf(m.item_list);
				touchPeerLastAt(peer, Date.now());
				pushInbox({ dir: "in", peer, text: cut(text || "(空消息)", 500), at: Date.now() });
				if (!text) return;
				st.messagesReceived++;
				save();
				if (!isAllowed(peer)) {
					addPending(peer);
					const last = st.pairTipAt[peer] ?? 0;
					if (Date.now() - last > PAIR_TIP_MS) {
						st.pairTipAt[peer] = Date.now();
						sendText(peer, "已收到，请先在网页端 💬 视图完成配对后再对话。", ctx).catch(() => {});
					}
					return;
				}

				// Slash command handling (/help, /clear, /new, /status, /cwd, /workspace, /model, /stop, /abort)
				const clean = text.trim();
				if (clean.startsWith("/") || clean.startsWith("／") || /^\d+\/[a-zA-Z]/.test(clean)) {
					const handled = await handleSlashCommand(clean, { peer, ctx });
					if (handled) return;
				}

				if (settings().autoDrive === false) return; // 只收不执行
				await drivePeer(peer, text, ctx);
			} catch (err) {
				host.log("inbound failed:", err?.message ?? err);
			}
		}

		// ---- 长轮询 ----------------------------------------------------------
		async function pollOnce() {
			const client = ilink();
			const buf = store.get("cursor", "") ?? "";
			const r = await client.getUpdates(typeof buf === "string" ? buf : "");
			const code = Number(r?.ret ?? r?.errcode ?? 0);
			if (code === -14) {
				st.pausedUntil = Date.now() + PAUSE_MS;
				st.lastError = "会话受限（-14），暂停 1 小时";
				host.log(st.lastError);
				pushState();
				return;
			}
			if (typeof r?.get_updates_buf === "string" && r.get_updates_buf) {
				store.set("cursor", r.get_updates_buf);
			}
			st.lastPollAt = Date.now();
			st.lastError = "";
			for (const m of r?.msgs ?? []) await handleInbound(m);
		}

		async function pollLoop() {
			st.backoffMs = BACKOFF_MIN_MS;
			while (!st.disposed && st.polling && isLoggedIn()) {
				if (Date.now() < st.pausedUntil) {
					await new Promise((r) => setTimeout(r, 5000));
					continue;
				}
				try {
					await pollOnce();
					st.backoffMs = BACKOFF_MIN_MS;
				} catch (err) {
					st.lastError = String(err?.message ?? err);
					host.log("poll failed:", st.lastError, `(${st.backoffMs}ms 后重试)`);
					await new Promise((r) => setTimeout(r, st.backoffMs));
					st.backoffMs = Math.min(BACKOFF_MAX_MS, st.backoffMs * 2);
				}
			}
		}

		function startPoll() {
			if (st.polling || st.disposed || !isLoggedIn()) return;
			st.polling = true;
			st.bgTask?.update({ status: "轮询中" });
			void ilink().notify("notifystart");
			void pollLoop().finally(() => {
				st.polling = false;
				st.bgTask?.update({ status: "已停止" });
				pushState();
			});
			pushState();
		}
		function stopPoll() {
			st.polling = false;
		}

		// ---- 登录 ------------------------------------------------------------
		async function startLogin() {
			if (st.disposed) return;
			// 已有码（未过期）：重推一次，让视图立刻有反馈而不是“点了没反应”。
			if (st.qrTimer || st.qr) {
				pushState();
				return;
			}
			st.qrStop = false;
			try {
				const prev = getToken();
				const r = await ilink().getQr(prev ? [prev] : []);
				if (!r?.qrcode) throw new Error("取码失败（无 qrcode）");
				st.qr = { qrcode: r.qrcode, image: r.qrcode_img_content ?? "" };
				pushState();
				const tick = async () => {
					if (st.disposed || st.qrStop) return;
					try {
						const s = await ilink().qrStatus(st.qr.qrcode);
						const status = String(s?.status ?? "wait");
						if (status === "confirmed" && s?.bot_token) {
							// 凭据落盘失败必须单独处理：以前这里抛错会被外层 catch 记成
							// “qr status failed”无限重试，登录永远完成不了。
							try {
								secrets?.set?.(TOKEN_KEY, String(s.bot_token));
								if ((secrets?.get?.(TOKEN_KEY) ?? null) !== String(s.bot_token)) {
									throw new Error("机密回读不一致");
								}
							} catch (err) {
								host.log("save login token failed:", err?.message ?? err);
								host.notify(
									"error",
									`微信扫码成功，但登录凭据存不住：${err?.message ?? err}（请升级 pi-web-ui 到已修复机密密钥的版本后重试）`,
									`WeChat scan succeeded but the login token could not be stored: ${err?.message ?? err}`,
								);
								cancelLogin();
								return;
							}
							if (s.baseurl) st.base = String(s.baseurl);
							st.botId = String(s.ilink_bot_id ?? "");
							st.loginAt = Date.now();
							save();
							st.qr = null;
							st.qrTimer = null;
							host.notify("info", "微信登录成功，开始接收消息", "WeChat login succeeded");
							pushState();
							startPoll();
							return;
						}
						if (status === "expired" || status === "verify_code_blocked") {
							st.qr = null;
							st.qrTimer = null;
							host.notify("warning", "微信二维码已过期，请重新点登录", "WeChat QR code expired, please retry");
							pushState();
							return;
						}
						// wait / scaned / need_verifycode 等：继续轮询（验证码场景 v1 只提示重扫）。
						if (status === "need_verifycode") {
							host.log("登录需要手机验证码，请在手机上确认后继续等待");
						}
					} catch (err) {
						host.log("qr status failed:", err?.message ?? err);
					}
					if (!st.disposed && !st.qrStop && st.qr) {
						st.qrTimer = setTimeout(tick, QR_POLL_MS);
					}
				};
				st.qrTimer = setTimeout(tick, QR_POLL_MS);
			} catch (err) {
				st.qr = null;
				st.qrTimer = null;
				host.notify("error", `微信取码失败：${err?.message ?? err}`, `WeChat QR failed: ${err?.message ?? err}`);
				pushState();
			}
		}
		function cancelLogin() {
			st.qrStop = true;
			if (st.qrTimer) clearTimeout(st.qrTimer);
			st.qrTimer = null;
			st.qr = null;
			pushState();
		}
		async function logout() {
			cancelLogin();
			stopPoll();
			try {
				await ilink().notify("notifystop");
			} catch {
				/* 忽略 */
			}
			try {
				secrets?.delete?.(TOKEN_KEY);
			} catch {
				/* 忽略 */
			}
			st.botId = "";
			st.loginAt = 0;
			try {
				store.set("cursor", "");
			} catch {
				/* 忽略 */
			}
			host.notify("info", "微信已登出", "WeChat logged out");
			pushState();
		}

		// ---- AI 工具 ----------------------------------------------------------
		function applyAiTool() {
			if (st.toolOff) {
				try {
					st.toolOff();
				} catch {
					/* 忽略 */
				}
				st.toolOff = null;
			}
			if (settings().aiSend === false || !isLoggedIn()) return;
			try {
				st.toolOff = host.registerAgentTool({
					name: "wechat_send",
					label: "发微信消息",
					description: "Send a text message over the WeChat channel (only to users who have been paired).",
					parameters: {
						type: "object",
						properties: {
							to: { type: "string", description: "WeChat user ID (visible in the view's inbox)" },
							text: { type: "string", description: "Message text" },
						},
						required: ["to", "text"],
					},
					async execute(_id, params) {
						const to = String(params?.to ?? "").trim();
						const text = String(params?.text ?? "").trim();
						if (!to || !text) throw new Error("wechat_send 需要 to + text");
						if (!isAllowed(to)) throw new Error(`未配对用户：${to}（先在 💬 视图允许）`);
						await sendText(to, cut(stripInternalMarkers(text), REPLY_CAP), st.peerCtx[to]);
						return `已发送给 ${to}`;
					},
				});
			} catch (err) {
				host.log("register wechat_send failed:", err?.message ?? err);
			}
		}

		// ---- 视图协议 ----------------------------------------------------------
		const offMsg = host.onMessage((payload, from) => {
			const msg = payload ?? {};
			try {
				switch (msg.action) {
					case "state":
						pushState(from);
						break;
					case "login":
						void startLogin();
						break;
					case "login_cancel":
						cancelLogin();
						break;
					case "logout":
						void logout().then(() => applyAiTool());
						break;
					case "allow": {
						const peer = String(msg.peer ?? "").trim();
						const isNew = peer && !st.allowedPeers.includes(peer);
						if (isNew) {
							st.allowedPeers.push(peer);
							sendPairSuccess(peer).catch((err) => host.log("pair welcome failed:", err?.message ?? err));
						}
						st.pendingPeers = st.pendingPeers.filter((p) => p !== peer);
						save();
						host.notify("info", `微信已配对：${peer}`, `WeChat paired: ${peer}`);
						pushState();
						break;
					}
					case "deny": {
						const peer = String(msg.peer ?? "").trim();
						st.pendingPeers = st.pendingPeers.filter((p) => p !== peer);
						save();
						pushState();
						break;
					}
					case "set_workspace": {
						setWorkspace(msg.workspace);
						break;
					}
					case "set_model": {
						setModel(msg.model, msg.thinkingLevel);
						break;
					}
					case "set_bind_active": {
						setBindActive(msg.bindActive);
						break;
					}
					case "send": {
						const peer = String(msg.peer ?? "").trim();
						const text = String(msg.text ?? "").trim();
						if (!peer || !text) break;
						if (!isAllowed(peer)) {
							if (from) host.sendTo(from, { kind: "error", error: `未配对用户：${peer}` });
							break;
						}
						sendText(peer, cut(text, REPLY_CAP), st.peerCtx[peer]).catch((err) => {
							if (from) host.sendTo(from, { kind: "error", error: String(err?.message ?? err) });
						});
						break;
					}
					default:
						break;
				}
			} catch (err) {
				host.log("message failed:", err?.message ?? err);
			}
		});

		const offAttach = host.onAttach((clientId) => {
			try {
				pushState(clientId);
			} catch (err) {
				host.log("attach push failed:", err?.message ?? err);
			}
		});
		const offCwd = host.onCwdChange?.(() => {
			try {
				pushState();
			} catch {
				/* 忽略 */
			}
		});

		// ---- 启动 --------------------------------------------------------------
		load();
		st.bgTask = host.registerBackgroundTask({
			id: "wechat-poll",
			label: "💬 微信通道",
			status: isLoggedIn() ? "已登录" : "未登录",
			stop: () => {
				stopPoll();
				st.bgTask?.update({ status: "已停止" });
				pushState();
			},
		});
		applyAiTool();
		if (isLoggedIn()) startPoll();
		host.log(`activated (ilink ${st.base}; loggedIn=${isLoggedIn()})`);

		return () => {
			st.disposed = true;
			cancelLogin();
			stopPoll();
			try {
				void ilink().notify("notifystop");
			} catch {
				/* 忽略 */
			}
			offRun();
			offMsg();
			offAttach();
			if (offCwd) {
				try {
					offCwd();
				} catch {
					/* 忽略 */
				}
			}
			if (offSettings) {
				try {
					offSettings();
				} catch {
					/* 忽略 */
				}
			}
			if (st.toolOff) {
				try {
					st.toolOff();
				} catch {
					/* 忽略 */
				}
			}
			for (const id of [...st.pendingRuns.keys()]) dropRun(id);
			earlyRuns.clear();
			st.bgTask?.unregister();
		};
	},
};
