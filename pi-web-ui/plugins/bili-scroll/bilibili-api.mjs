/**
 * plugins/bili-scroll/bilibili-api.mjs
 * 纯 JS 实现的 Bilibili 官方 API 客户端
 * 无需 Python / uv 依赖，支持 Wbi 签名、扫码登录、搜索、详情、字幕提取、热门榜单、评论与收藏夹操作
 */

import crypto from "node:crypto";
import { DEFAULT_UA } from "./credentials.mjs?v=2.0.1";

const MIXIN_KEY_ENC_TAB = [
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
	13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
	44, 52,
];

function getMixinKey(orig) {
	let s = "";
	for (const n of MIXIN_KEY_ENC_TAB) {
		if (orig[n]) s += orig[n];
	}
	return s.slice(0, 32);
}

function encWbi(params, imgKey, subKey) {
	const mixinKey = getMixinKey(imgKey + subKey);
	const currTime = Math.round(Date.now() / 1000);
	const newParams = { ...params, wts: currTime };
	const sortedKeys = Object.keys(newParams).sort();
	const query = [];
	for (const k of sortedKeys) {
		const val = String(newParams[k] ?? "").replace(/[!'()*]/g, "");
		query.push(`${encodeURIComponent(k)}=${encodeURIComponent(val)}`);
	}
	const queryString = query.join("&");
	const wbiSign = crypto
		.createHash("md5")
		.update(queryString + mixinKey)
		.digest("hex");
	return `${queryString}&w_rid=${wbiSign}`;
}

function cleanHtmlTags(str) {
	if (!str) return "";
	return String(str)
		.replace(/<em class="keyword">/g, "")
		.replace(/<\/em>/g, "")
		.replace(/<[^>]+>/g, "")
		.trim();
}

function formatDuration(seconds) {
	if (typeof seconds === "string" && seconds.includes(":")) return seconds;
	const sec = Math.max(0, Number(seconds) || 0);
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatTime(sec) {
	const total = Math.floor(Number(sec) || 0);
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export class BilibiliApiClient {
	constructor(credentialManager) {
		this.cred = credentialManager;
		this.wbiCache = null;
		this.wbiExpiry = 0;
	}

	async getWbiKeys() {
		const now = Date.now();
		if (this.wbiCache && now < this.wbiExpiry) {
			return this.wbiCache;
		}
		try {
			const res = await fetch("https://api.bilibili.com/x/web-interface/nav", {
				headers: this.cred.getHeaders(),
			});
			const json = await res.json();
			const imgUrl = json.data?.wbi_img?.img_url || "";
			const subUrl = json.data?.wbi_img?.sub_url || "";
			const imgKey = imgUrl.slice(imgUrl.lastIndexOf("/") + 1, imgUrl.lastIndexOf("."));
			const subKey = subUrl.slice(subUrl.lastIndexOf("/") + 1, subUrl.lastIndexOf("."));
			if (imgKey && subKey) {
				this.wbiCache = { imgKey, subKey };
				this.wbiExpiry = now + 12 * 3600 * 1000;
				return this.wbiCache;
			}
		} catch {
			// fallback default keys
		}
		return {
			imgKey: "7cd084941338484aae1ad9425b84077c",
			subKey: "4932caff0ff746eab6f01bf08b70ac45",
		};
	}

	// ── 扫码登录 ──
	async startLogin() {
		const res = await fetch(
			"https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header",
			{ headers: this.cred.getHeaders() },
		);
		const json = await res.json();
		if (json.code !== 0 || !json.data?.qrcode_key) {
			throw new Error(json.message || "获取登录二维码失败");
		}
		return {
			key: json.data.qrcode_key,
			url: json.data.url,
		};
	}

	async pollLogin(key) {
		const pollUrl = `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`;
		const res = await fetch(pollUrl, {
			headers: this.cred.getHeaders(),
			redirect: "manual",
		});
		let json = {};
		try {
			json = await res.json();
		} catch {
			// ignore empty body
		}
		const code = json.data?.code;
		if (code === 0) {
			// 从 Set-Cookie 提取凭据
			const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
			const jar = {};
			for (const raw of setCookies) {
				const first = String(raw).split(";")[0] || "";
				const eq = first.indexOf("=");
				if (eq <= 0) continue;
				const k = first.slice(0, eq).trim();
				const v = first.slice(eq + 1).trim();
				if (k === "SESSDATA") jar.sessdata = v;
				if (k === "bili_jct") jar.bili_jct = v;
				if (k === "DedeUserID") jar.dedeuserid = v;
				if (k === "buvid3") jar.buvid3 = v;
			}
			if (json.data?.refresh_token) {
				jar.refresh_token = json.data.refresh_token;
			}
			if (!jar.buvid3) {
				try {
					const spiRes = await fetch("https://api.bilibili.com/x/frontend/finger/spi", {
						headers: this.cred.getHeaders(),
					});
					const spiJson = await spiRes.json();
					if (spiJson.data?.b_3) jar.buvid3 = spiJson.data.b_3;
				} catch {
					// ignore
				}
			}
			if (jar.sessdata) {
				this.cred.save(jar);
				return { state: "ok", code: 0, message: "登录成功" };
			}
			return { state: "unknown", code: 0, message: "响应未携带有效 SESSDATA" };
		}
		const map = { 86101: "waiting", 86090: "scanned", 86038: "expired" };
		return {
			state: map[code] || "unknown",
			code,
			message: json.message || json.data?.message || "",
		};
	}

	// ── 搜索视频 ──
	async searchVideos(keyword, { page = 1, pageSize = 10, order = "totalrank" } = {}) {
		const { imgKey, subKey } = await this.getWbiKeys();
		const params = {
			keyword: String(keyword || "").trim(),
			search_type: "video",
			page: Math.max(1, Number(page) || 1),
			page_size: Math.max(1, Math.min(Number(pageSize) || 10, 50)),
			order: String(order || "totalrank"),
		};
		const query = encWbi(params, imgKey, subKey);
		const url = `https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`;
		const res = await fetch(url, { headers: this.cred.getHeaders() });
		const json = await res.json();
		if (json.code !== 0) {
			throw new Error(json.message || `搜索失败 (code: ${json.code})`);
		}
		const list = json.data?.result || [];
		return list.map((item) => ({
			bvid: item.bvid,
			aid: item.aid,
			title: cleanHtmlTags(item.title),
			author: item.author,
			mid: item.mid,
			play: item.play,
			danmaku: item.video_review || item.danmaku,
			pubdate: item.pubdate,
			pubdateStr: item.pubdate ? new Date(item.pubdate * 1000).toLocaleString() : "",
			duration: formatDuration(item.duration),
			pic: item.pic?.startsWith("//") ? `https:${item.pic}` : item.pic,
			description: cleanHtmlTags(item.description),
			url: `https://www.bilibili.com/video/${item.bvid}`,
		}));
	}

	// ── 视频详情 ──
	async getVideoInfo(bvid) {
		const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
		let res = await fetch(url, { headers: this.cred.getHeaders() }).catch(() => null);
		let json = res ? await res.json().catch(() => ({ code: -1 })) : { code: -1 };
		if (json.code !== 0) {
			const cleanHeaders = { "User-Agent": DEFAULT_UA, Referer: "https://www.bilibili.com" };
			res = await fetch(url, { headers: cleanHeaders }).catch(() => null);
			json = res ? await res.json().catch(() => ({ code: -1 })) : { code: -1 };
		}
		if (json.code !== 0) {
			throw new Error(json.message || `获取视频详情失败 (code: ${json.code})`);
		}
		const d = json.data;
		return {
			bvid: d.bvid,
			aid: d.aid,
			cid: d.cid,
			title: d.title,
			desc: d.desc,
			pic: d.pic,
			pubdate: d.pubdate,
			pubdateStr: d.pubdate ? new Date(d.pubdate * 1000).toLocaleString() : "",
			duration: d.duration,
			durationStr: formatDuration(d.duration),
			owner: {
				mid: d.owner?.mid,
				name: d.owner?.name,
				face: d.owner?.face,
			},
			stat: {
				view: d.stat?.view,
				danmaku: d.stat?.danmaku,
				reply: d.stat?.reply,
				favorite: d.stat?.favorite,
				coin: d.stat?.coin,
				share: d.stat?.share,
				like: d.stat?.like,
			},
			pages: (d.pages || []).map((p) => ({
				cid: p.cid,
				page: p.page,
				part: p.part,
				duration: p.duration,
				durationStr: formatDuration(p.duration),
			})),
			url: `https://www.bilibili.com/video/${d.bvid}`,
		};
	}

	// ── 获取视频字幕（AI 字幕/UP 字幕） ──
	async getVideoSubtitle(bvid, cidParam = 0) {
		let cid = Number(cidParam);
		let aid = 0;
		let title = "";
		let desc = "";
		let ownerName = "";

		try {
			const info = await this.getVideoInfo(bvid);
			aid = info.aid;
			title = info.title;
			desc = info.desc;
			ownerName = info.owner?.name;
			if (!cid) cid = info.cid || info.pages?.[0]?.cid || 0;
		} catch (err) {
			return {
				ok: false,
				bvid,
				error: `无法获取视频信息: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		if (!cid) {
			return { ok: false, bvid, error: "未找到有效的 cid" };
		}

		// 1. 尝试从 x/player/wbi/v2 拉取字幕
		try {
			const { imgKey, subKey } = await this.getWbiKeys();
			const query = encWbi({ aid, cid, bvid }, imgKey, subKey);
			const pRes = await fetch(`https://api.bilibili.com/x/player/wbi/v2?${query}`, {
				headers: this.cred.getHeaders(),
			});
			const pJson = await pRes.json();
			const subtitles = pJson.data?.subtitle?.subtitles || [];

			if (subtitles.length > 0) {
				let target = subtitles.find(
					(s) => s.lan === "ai-zh" || s.lan === "zh-CN" || s.lan === "zh" || s.lan?.startsWith("zh"),
				);
				if (!target) target = subtitles[0];

				let subUrl = target.subtitle_url || "";
				if (subUrl.startsWith("//")) subUrl = `https:${subUrl}`;

				const subDataRes = await fetch(subUrl, { headers: this.cred.getHeaders() });
				const subData = await subDataRes.json();
				const body = subData.body || [];

				const lines = [];
				const rawTexts = [];
				for (const item of body) {
					const text = String(item.content || "").trim();
					if (!text) continue;
					const start = formatTime(item.from || 0);
					lines.push(`[${start}] ${text}`);
					rawTexts.push(text);
				}

				return {
					ok: true,
					bvid,
					aid,
					cid,
					title,
					ownerName,
					hasSubtitle: true,
					source: "subtitle_track",
					language: target.lan_doc || target.lan,
					segmentsCount: lines.length,
					timestampedText: lines.join("\n"),
					fullText: rawTexts.join(" "),
				};
			}
		} catch {
			// 继续回退
		}

		// 2. 尝试从 B 站官方 AI 总结提取要点 (Conclusion API)
		try {
			const cUrl = `https://api.bilibili.com/x/web-interface/view/conclusion/get?bvid=${encodeURIComponent(bvid)}&cid=${cid}`;
			const cRes = await fetch(cUrl, { headers: this.cred.getHeaders() });
			const cJson = await cRes.json();
			if (cJson.code === 0 && cJson.data?.model_result) {
				const mr = cJson.data.model_result;
				const summary = mr.summary || "";
				const outline = (mr.outline || [])
					.map((part) => {
						const points = (part.part_outline || [])
							.map((p) => `  - [${formatTime(p.timestamp)}] ${p.content}`)
							.join("\n");
						return `### ${part.title}\n${points}`;
					})
					.join("\n\n");

				return {
					ok: true,
					bvid,
					aid,
					cid,
					title,
					ownerName,
					hasSubtitle: false,
					source: "ai_conclusion",
					summary,
					outline,
					fullText: `【AI智能总结】\n${summary}\n\n【核心大纲】\n${outline}`,
				};
			}
		} catch {
			// 继续回退
		}

		// 3. 无字幕且无 AI 总结时，回退提供完整视频简介
		return {
			ok: true,
			bvid,
			aid,
			cid,
			title,
			ownerName,
			hasSubtitle: false,
			source: "description_fallback",
			fullText: desc ? `【视频简介】\n${desc}` : "该视频暂无字幕与详细简介",
			hint: "该视频无公开 AI 字幕，已回退为视频简介",
		};
	}

	// ── 热门视频 ──
	async getPopularVideos({ pn = 1, ps = 20 } = {}) {
		const url = `https://api.bilibili.com/x/web-interface/popular?pn=${Math.max(1, Number(pn) || 1)}&ps=${Math.max(1, Math.min(Number(ps) || 20, 50))}`;
		const res = await fetch(url, { headers: this.cred.getHeaders() });
		const json = await res.json();
		if (json.code !== 0) throw new Error(json.message || `获取热门视频失败 (code: ${json.code})`);
		return (json.data?.list || []).map((item) => ({
			bvid: item.bvid,
			aid: item.aid,
			title: item.title,
			author: item.owner?.name,
			mid: item.owner?.mid,
			play: item.stat?.view,
			danmaku: item.stat?.danmaku,
			like: item.stat?.like,
			duration: formatDuration(item.duration),
			pic: item.pic,
			rcmdReason: item.rcmd_reason?.content || "",
			url: `https://www.bilibili.com/video/${item.bvid}`,
		}));
	}

	// ── 排行榜 ──
	async getRankVideos({ rid = 0, type = "all" } = {}) {
		const url = `https://api.bilibili.com/x/web-interface/ranking/v2?rid=${Number(rid) || 0}&type=${encodeURIComponent(type || "all")}`;
		const res = await fetch(url, { headers: this.cred.getHeaders() });
		const json = await res.json();
		if (json.code !== 0) throw new Error(json.message || `获取排行榜失败 (code: ${json.code})`);
		return (json.data?.list || []).map((item) => ({
			bvid: item.bvid,
			aid: item.aid,
			title: item.title,
			author: item.owner?.name,
			mid: item.owner?.mid,
			play: item.stat?.view,
			danmaku: item.stat?.danmaku,
			pts: item.pts,
			duration: formatDuration(item.duration),
			pic: item.pic,
			url: `https://www.bilibili.com/video/${item.bvid}`,
		}));
	}

	/**
	 * 解析视频 bvid 对应的数值型 aid
	 * 优先走官方详情 API；若遭遇风控/限流，自动回退到视频网页 HTML 静态解析
	 */
	async resolveAid(bvid) {
		const cleanBvid = String(bvid || "").trim();
		if (!cleanBvid) throw new Error("缺少有效的视频 bvid");

		// 1. 优先通过 getVideoInfo 获取
		try {
			const info = await this.getVideoInfo(cleanBvid);
			if (info?.aid) return Number(info.aid);
		} catch {
			// fall through to backup extraction
		}

		// 2. 强力容灾回退：直接访问视频网页 HTML 匹配 aid（绕过 API 接口偶发的 -412 风控）
		try {
			const pageUrl = `https://www.bilibili.com/video/${encodeURIComponent(cleanBvid)}`;
			const pageRes = await fetch(pageUrl, {
				headers: { "User-Agent": DEFAULT_UA, Referer: "https://www.bilibili.com/" },
			}).catch(() => null);
			if (pageRes && pageRes.ok) {
				const html = await pageRes.text();
				const m = html.match(/"aid":\s*(\d+)/);
				if (m && m[1]) return Number(m[1]);
			}
		} catch {
			// ignore
		}

		throw new Error(`无法获取视频 ${cleanBvid} 的 aid`);
	}

	// ── 视频评论 ──
	async getVideoComments(bvid, { page = 1, pageSize = 20, sort = 1 } = {}) {
		let aid = 0;
		try {
			aid = await this.resolveAid(bvid);
		} catch (err) {
			throw new Error(`获取视频 aid 失败: ${err instanceof Error ? err.message : String(err)}`);
		}

		const url = `https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=${Number(sort) || 1}&pn=${Math.max(1, Number(page) || 1)}&ps=${Math.max(1, Math.min(Number(pageSize) || 20, 50))}`;
		const res = await fetch(url, { headers: this.cred.getHeaders() });
		const json = await res.json();
		if (json.code !== 0) throw new Error(json.message || `获取评论失败 (code: ${json.code})`);

		const replies = json.data?.replies || [];
		return replies.map((r) => ({
			rpid: r.rpid,
			mid: r.mid,
			uname: r.member?.uname,
			avatar: r.member?.avatar,
			like: r.like,
			rcount: r.rcount,
			message: r.content?.message,
			pubdateStr: r.ctime ? new Date(r.ctime * 1000).toLocaleString() : "",
		}));
	}

	// ── 发表评论/回复 ──
	async replyVideo(bvid, message, { rpid = 0, root = 0, parent = 0 } = {}) {
		const cred = this.cred.load();
		if (!cred || !cred.sessdata || !cred.bili_jct) {
			throw new Error("发表评论需要先扫码登录获取凭证 (SESSDATA & bili_jct)");
		}
		let aid = 0;
		try {
			aid = await this.resolveAid(bvid);
		} catch (err) {
			throw new Error(`获取视频 aid 失败: ${err instanceof Error ? err.message : String(err)}`);
		}

		const body = new URLSearchParams();
		body.append("type", "1");
		body.append("oid", String(aid));
		body.append("message", String(message || "").trim());
		body.append("csrf", cred.bili_jct);
		if (rpid || root) {
			body.append("root", String(root || rpid));
			body.append("parent", String(parent || rpid));
		}

		const res = await fetch("https://api.bilibili.com/x/v2/reply/add", {
			method: "POST",
			headers: {
				...this.cred.getHeaders({ "Content-Type": "application/x-www-form-urlencoded" }),
			},
			body: body.toString(),
		});
		const json = await res.json();
		if (json.code !== 0) {
			throw new Error(json.message || `发表评论失败 (code: ${json.code})`);
		}
		return {
			ok: true,
			rpid: json.data?.rpid,
			message: "评论已成功发出",
		};
	}

	// ── 发送私信 ──
	async sendMessage(receiverUid, text) {
		const cred = this.cred.load();
		if (!cred || !cred.sessdata || !cred.bili_jct) {
			throw new Error("发送私信需要先扫码登录获取凭证 (SESSDATA & bili_jct)");
		}
		const cleanText = String(text || "").trim();
		if (!cleanText) throw new Error("私信内容不能为空");
		if (cleanText.length > 500) {
			throw new Error(`私信超过 500 字符限制 (当前 ${cleanText.length} 字)，请精简后再发`);
		}

		const senderUid = Number(cred.dedeuserid) || 0;
		const targetUid = Number(receiverUid);
		if (!targetUid) throw new Error("无效的接收者 UID");

		const body = new URLSearchParams();
		body.append("msg[sender_uid]", String(senderUid));
		body.append("msg[receiver_id]", String(targetUid));
		body.append("msg[receiver_type]", "1");
		body.append("msg[msg_type]", "1");
		body.append("msg[msg_status]", "0");
		body.append("msg[content]", JSON.stringify({ content: cleanText }));
		body.append("msg[timestamp]", String(Math.floor(Date.now() / 1000)));
		body.append("msg[new_face_version]", "0");
		body.append("msg[dev_id]", cred.buvid3 || "");
		body.append("csrf", cred.bili_jct);
		body.append("csrf_token", cred.bili_jct);

		const res = await fetch("https://api.vc.bilibili.com/web_im/v1/web_im/send_msg", {
			method: "POST",
			headers: this.cred.getHeaders({
				"Content-Type": "application/x-www-form-urlencoded",
				Referer: "https://message.bilibili.com/",
				Origin: "https://message.bilibili.com",
			}),
			body: body.toString(),
		});
		const json = await res.json();
		if (json.code !== 0) {
			throw new Error(json.message || `发送私信失败 (code: ${json.code})`);
		}
		return {
			ok: true,
			data: json.data,
			message: `私信已成功发送至 UID: ${targetUid}`,
		};
	}

	// ── 获取视频的相关推荐视频（AI 漫游跳板） ──
	async getRelatedVideos(bvid) {
		if (!bvid) return [];
		const url = `https://api.bilibili.com/x/web-interface/archive/related?bvid=${encodeURIComponent(bvid)}`;
		const res = await fetch(url, { headers: this.cred.getHeaders() });
		const json = await res.json();
		if (json.code !== 0) return [];
		const list = json.data || [];
		return list.map((item) => ({
			bvid: item.bvid,
			aid: item.aid,
			title: cleanHtmlTags(item.title),
			author: item.owner?.name,
			mid: item.owner?.mid,
			play: item.stat?.view,
			danmaku: item.stat?.danmaku,
			duration: formatDuration(item.duration),
			pic: item.pic?.startsWith("//") ? `https:${item.pic}` : item.pic,
			description: cleanHtmlTags(item.desc),
			url: `https://www.bilibili.com/video/${item.bvid}`,
			fromBvid: bvid,
		}));
	}

	// ── 获取 UP 主近期投稿（顺藤摸瓜漫游） ──
	async getUpVideos(mid, ps = 10) {
		if (!mid) return [];
		const url = `https://api.bilibili.com/x/space/wbi/arc/search?mid=${encodeURIComponent(mid)}&ps=${Math.max(1, Math.min(Number(ps) || 10, 30))}&pn=1`;
		try {
			const res = await fetch(url, { headers: this.cred.getHeaders() });
			const json = await res.json();
			if (json.code !== 0) return [];
			const list = json.data?.list?.vlist || [];
			return list.map((item) => ({
				bvid: item.bvid,
				aid: item.aid,
				title: cleanHtmlTags(item.title),
				author: item.author,
				mid: item.mid,
				play: item.play,
				duration: formatDuration(item.length),
				pic: item.pic?.startsWith("//") ? `https:${item.pic}` : item.pic,
				description: cleanHtmlTags(item.description),
				url: `https://www.bilibili.com/video/${item.bvid}`,
			}));
		} catch {
			return [];
		}
	}

	// ── 封面获取代理（防盗链） ──
	async getCoverProxy(bvid) {
		if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return null;
		try {
			const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
				signal: AbortSignal.timeout(8000),
				headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.bilibili.com/" },
			});
			if (!viewRes.ok) return null;
			const viewJson = await viewRes.json();
			const picUrl = viewJson?.data?.pic || "";
			if (!picUrl) return null;

			const imgRes = await fetch(picUrl, {
				signal: AbortSignal.timeout(10000),
				headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.bilibili.com/" },
			});
			if (!imgRes.ok) return null;
			const buf = Buffer.from(await imgRes.arrayBuffer());
			const type = imgRes.headers.get("content-type") || "image/jpeg";
			return { buf, type };
		} catch {
			return null;
		}
	}
}
