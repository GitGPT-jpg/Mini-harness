/**
 * plugins/bili-scroll/lib/dm.mjs
 * B站 私信：读会话 / 读消息 / 发消息
 *
 * 核心设计：
 * 1. 只读、纯代码轮询，平时不花 token；
 * 2. 识别普通文本与视频分享卡片（msg_type=7/8 自动解析 bvid/jump_url）；
 * 3. 只有主人发来新消息时才唤醒模型或执行回复；
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";

export function loadCred(stateDir) {
	const f = join(stateDir, "bili_credential.json");
	if (!existsSync(f)) return null;
	try {
		const c = JSON.parse(readFileSync(f, "utf8"));
		return c?.sessdata ? c : null;
	} catch {
		return null;
	}
}

function headers(cred) {
	return {
		"User-Agent": UA,
		Referer: "https://message.bilibili.com/",
		Origin: "https://message.bilibili.com",
		Cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3 || ""}`,
	};
}

async function jget(url, cred) {
	const r = await fetch(url, { headers: headers(cred) });
	const j = await r.json().catch(() => null);
	if (!j || j.code !== 0) throw new Error(`HTTP ${r.status} code=${j?.code} msg=${j?.message || ""}`);
	return j.data || {};
}

/** 会话列表：[{ uid, unread, lastTs, preview }] */
export async function listSessions(cred) {
	const d = await jget(
		"https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&Build=0&mobi_app=web",
		cred,
	);
	const list = d.session_list || [];
	return list
		.map((s) => {
			let preview = "";
			try {
				const c = s.last_msg?.content ? JSON.parse(s.last_msg.content) : null;
				preview = String(c?.content || c?.text || "").slice(0, 80);
			} catch {
				// 非 JSON 留空
			}
			return {
				uid: Number(s.talker_id) || 0,
				unread: Number(s.unread_count) || 0,
				lastTs: Number(s.last_msg?.timestamp) || 0,
				preview,
			};
		})
		.filter((x) => x.uid > 0);
}

/** 读某个会话最近的 n 条：[{ key, ts, fromMe, kind, text, bvid }] */
export async function fetchMsgs(cred, talkerId, size = 10) {
	const url =
		`https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?talker_id=${Number(talkerId)}` +
		`&session_type=1&size=${Math.max(1, Math.min(50, size))}&build=0&mobi_app=web`;
	const d = await jget(url, cred);
	const list = (d.messages || []).slice().reverse(); // 接口是倒序的
	return list.map((m) => {
		const mt = Number(m.msg_type) || 1;
		let text = "";
		let isCard = false;
		let bvid = "";
		try {
			const c = JSON.parse(m.content || "{}");
			if ((mt === 7 || mt === 8) && (c.jump_url || c.bvid || c.author || c.title)) {
				isCard = true;
				bvid = String(c.bvid || "") || (String(c.jump_url || "").match(/BV[0-9A-Za-z]{10}/) || [])[0] || "";
				const title = String(c.title || c.headline || c.desc || "").slice(0, 80);
				const who = String(c.author || "").slice(0, 30);
				text = "[分享视频] " + (title || "(无标题)") + (who ? " / " + who : "") + (bvid ? " " + bvid : "");
			} else {
				text = String(c.content || c.text || "");
				const bvMatch = text.match(/BV[0-9A-Za-z]{10}/);
				if (bvMatch) bvid = bvMatch[0];
			}
		} catch {
			text = String(m.content || "");
		}
		if (!text) text = "[非文字消息]";
		return {
			key: String(m.msg_key || m.msg_seqno || m.timestamp),
			ts: Number(m.timestamp) || 0,
			fromMe: Number(m.sender_uid) === Number(cred.dedeuserid),
			kind: isCard ? mt : 1,
			text: text.slice(0, 500),
			bvid,
		};
	});
}

/** 我自己的 uid（凭证里有） */
export function myUid(cred) {
	return Number(cred?.dedeuserid) || 0;
}
