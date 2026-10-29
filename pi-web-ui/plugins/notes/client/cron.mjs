/**
 * 5 字段 cron 的解析与「下次触发」计算 —— 纯函数，服务端与浏览器共用。
 *
 * 为什么放 client/ 而不是插件根目录：宿主只把插件的 `client/` 子树暴露给浏览器
 * （`/plugins/<id>/client/*`，见 server/index.ts），服务端代码可以 import 任意相对
 * 路径，反向不行 —— 所以「两边都要用」的纯逻辑一律住在 client/ 下。
 *
 * 语法与宿主 `server/plugin-schedule.ts` 同口径（那是 host.schedule 的解释器，
 * 真到点由它负责；这里只做「我们生成的 spec 是否合法 + 界面上显示下次什么时候」）：
 *   `*` / `*\/n` / `a-b` / `a-b/n` / `a,b,c` / 单数字；月/周支持英文名；
 *   日-周按标准 cron 的 OR 语义（两侧都受限时取并集）。时间一律按**服务器本地时区**。
 */

const MONTH_NAMES = {
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	may: 5,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	oct: 10,
	nov: 11,
	dec: 12,
};
const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** 单字段 → 升序去重数组；非法回 null。 */
export function parseCronField(raw, min, max, names) {
	const src = String(raw ?? "")
		.trim()
		.toLowerCase();
	if (!src) return null;
	const out = new Set();
	const num = (tok) => {
		const t = String(tok ?? "").trim();
		if (!t) return null;
		if (names && t in names) return names[t];
		if (!/^\d+$/.test(t)) return null;
		let n = Number(t);
		if (n === 7 && min === 0 && max === 6) n = 0; // 周日的 7 写法
		if (!Number.isInteger(n) || n < min || n > max) return null;
		return n;
	};
	for (const part of src.split(",")) {
		const p = part.trim();
		if (!p) return null;
		const step = p.split("/");
		if (step.length === 2) {
			const every = num(step[1]);
			if (every === null || every <= 0) return null;
			let lo = min;
			let hi = max;
			if (step[0] !== "" && step[0] !== "*") {
				const range = step[0].split("-");
				if (range.length > 2) return null;
				const a = num(range[0]);
				if (a === null) return null;
				lo = a;
				if (range.length === 2) {
					const b = num(range[1]);
					if (b === null || b < a) return null;
					hi = b;
				}
			}
			for (let v = lo; v <= hi; v += every) out.add(v);
			continue;
		}
		if (step.length > 2) return null;
		if (p === "*") {
			for (let v = min; v <= max; v++) out.add(v);
			continue;
		}
		if (p.includes("-")) {
			const range = p.split("-");
			if (range.length !== 2) return null;
			const a = num(range[0]);
			const b = num(range[1]);
			if (a === null || b === null || b < a) return null;
			for (let v = a; v <= b; v++) out.add(v);
			continue;
		}
		const n = num(p);
		if (n === null) return null;
		out.add(n);
	}
	if (out.size === 0) return null;
	return [...out].sort((a, b) => a - b);
}

/** 5 字段 cron（分 时 日 月 周）→ parts；非法回 null。 */
export function parseCron(spec) {
	const fields = String(spec ?? "")
		.trim()
		.split(/\s+/);
	if (fields.length !== 5) return null;
	const minute = parseCronField(fields[0], 0, 59);
	const hour = parseCronField(fields[1], 0, 23);
	const dom = parseCronField(fields[2], 1, 31);
	const month = parseCronField(fields[3], 1, 12, MONTH_NAMES);
	const dow = parseCronField(fields[4], 0, 6, DOW_NAMES);
	if (!minute || !hour || !dom || !month || !dow) return null;
	return { minute, hour, dom, month, dow };
}

function isFull(values, min, max) {
	return values.length === max - min + 1;
}

/**
 * 下一次触发毫秒时间戳（严格晚于 fromMs，按分钟粒度）；找不到（例如 2 月 31 日）
 * 回 null。做法是**按天推进 + 当天内按时/分升序试**，最多扫 800 天（跨年 spec 也够）。
 */
export function nextCronFire(parts, fromMs) {
	const p = typeof parts === "string" ? parseCron(parts) : parts;
	if (!p) return null;
	const from = Number(fromMs);
	if (!Number.isFinite(from)) return null;
	const startMs = Math.floor(from / 60000) * 60000 + 60000;
	const base = new Date(startMs);
	const hours = p.hour;
	const minutes = p.minute;
	const domRestricted = !isFull(p.dom, 1, 31);
	const dowRestricted = !isFull(p.dow, 0, 6);
	const domSet = new Set(p.dom);
	const dowSet = new Set(p.dow);
	const monthSet = new Set(p.month);
	for (let day = 0; day < 800; day++) {
		const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + day);
		if (!monthSet.has(d.getMonth() + 1)) continue;
		const domHit = domSet.has(d.getDate());
		const dowHit = dowSet.has(d.getDay());
		// 标准 cron 的 OR 语义：只有两侧都受限时才取并集，一侧为 * 时另一侧说了算。
		const dayHit = domRestricted && dowRestricted ? domHit || dowHit : domHit && dowHit;
		if (!dayHit) continue;
		for (const h of hours) {
			for (const m of minutes) {
				const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
				if (at >= startMs) return at;
			}
		}
	}
	return null;
}

/** schedule → 纯文字描述（导出 Markdown 用；界面走 i18n 文案，不用这个）。 */
export function scheduleText(schedule) {
	const s = schedule && typeof schedule === "object" ? schedule : null;
	if (!s) return "（无效）";
	switch (s.type) {
		case "once":
			return `一次性 ${String(s.at ?? "").replace("T", " ")}`;
		case "daily":
			return `每天 ${s.time}`;
		case "weekly":
			return `每周 ${(Array.isArray(s.dow) ? s.dow : []).map((d) => "日一二三四五六"[d] ?? d).join("")} ${s.time}`;
		case "monthly":
			return `每月 ${s.dom} 日 ${s.time}`;
		case "every":
			return everyText(s.minutes);
		case "cron":
			return `cron ${s.spec}`;
		default:
			return "（无效）";
	}
}

/** 间隔分钟数 → 「每 N 分钟 / 每 N 小时 / 每 N 天」。 */
export function everyText(minutes) {
	const n = Number(minutes);
	if (!Number.isFinite(n) || n <= 0) return "（无效）";
	if (n < 60) return `每 ${n} 分钟`;
	if (n % 1440 === 0) return `每 ${n / 1440} 天`;
	if (n % 60 === 0) return `每 ${n / 60} 小时`;
	return `每 ${Math.floor(n / 60)} 小时 ${n % 60} 分`;
}

/** 带缓存的 nextCronFire（界面每帧都要显示「下次」；同 spec 同分钟复用）。 */
const fireCache = new Map();
export function nextFire(spec, fromMs = Date.now()) {
	const key = `${spec}|${Math.floor(fromMs / 60000)}`;
	if (fireCache.has(key)) return fireCache.get(key);
	const at = nextCronFire(parseCron(spec), fromMs);
	// 缓存不能无限长（每次 spec 改动都会生成新 key）：超过 500 条就整体清掉再放。
	if (fireCache.size > 500) fireCache.clear();
	fireCache.set(key, at);
	return at;
}

/** "HH:MM" → {h, m}；非法回 null。 */
export function parseHM(raw) {
	const m = /^\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*$/.exec(String(raw ?? ""));
	if (!m) return null;
	const h = Number(m[1]);
	const mi = Number(m[2]);
	if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
	return { h, m: mi };
}

/** 两个数字补零成两位。 */
const pad2 = (n) => String(n).padStart(2, "0");

/**
 * 「每隔 N 分钟」的允许范围：1 分钟 .. 7 天（10080）。
 *
 * **不再限制成 cron 能表达的档位**（60 的因数 / 整小时）：本插件的到点判定用的是自己
 * 落盘的 `nextDue`（见 store.mjs 的 nextDueStamp），不依赖 cron —— 所以「每 90 分钟」
 * 这种既非因数又非整小时的间隔也能真的按 90 分钟走。cron 只在还能表达时用于导出/展示
 * （`scheduleToCron` 认不出就回 null，展示走 `scheduleText`）。
 */
export const MIN_EVERY_MINUTES = 1;
export const MAX_EVERY_MINUTES = 10_080;

/** 该档位是否是合法的「间隔」分钟数。 */
export function isSupportedEvery(minutes) {
	const n = Number(minutes);
	return Number.isInteger(n) && n >= MIN_EVERY_MINUTES && n <= MAX_EVERY_MINUTES;
}

/**
 * 提醒的 schedule 对象 → 5 字段 cron 字符串；不合法回 null。
 *
 * schedule 形状（见 store.mjs 的 normalizeSchedule）：
 *   { type: "once",    at: "2026-05-05T09:00" }       一次性
 *   { type: "daily",   time: "09:00" }                每天
 *   { type: "weekly",  time: "18:00", dow: [1,5] }    每周几（0=周日）
 *   { type: "monthly", time: "09:00", dom: 15 }       每月 N 号
 *   { type: "every",   minutes: 30 }                  每 N 分钟（1..59，或 60 的整数倍→按小时）
 *   { type: "cron",    spec: "0 9 * * *" }            直接写 cron
 */
export function scheduleToCron(schedule) {
	const s = schedule && typeof schedule === "object" ? schedule : null;
	if (!s) return null;
	switch (s.type) {
		case "once": {
			const at = new Date(String(s.at ?? ""));
			if (Number.isNaN(at.getTime())) return null;
			return `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`;
		}
		case "daily": {
			const hm = parseHM(s.time);
			if (!hm) return null;
			return `${hm.m} ${hm.h} * * *`;
		}
		case "weekly": {
			const hm = parseHM(s.time);
			if (!hm) return null;
			const dows = (Array.isArray(s.dow) ? s.dow : [])
				.map((x) => Number(x))
				.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6);
			if (!dows.length) return null;
			return `${hm.m} ${hm.h} * * ${[...new Set(dows)].sort().join(",")}`;
		}
		case "monthly": {
			const hm = parseHM(s.time);
			if (!hm) return null;
			const dom = Number(s.dom);
			if (!Number.isInteger(dom) || dom < 1 || dom > 31) return null;
			return `${hm.m} ${hm.h} ${dom} * *`;
		}
		case "every": {
			// 只是「能不能顺手写成 cron」的展示问题（导出用）；排期一律走 nextDue，与它无关
			const n = Number(s.minutes);
			if (!isSupportedEvery(n)) return null;
			if (60 % n === 0 && n < 60) return `*/${n} * * * *`;
			if (n >= 60 && n % 60 === 0 && n / 60 <= 24) {
				const hours = n / 60;
				return hours === 24 ? "0 0 * * *" : hours === 1 ? "0 * * * *" : `0 */${hours} * * *`;
			}
			return null;
		}
		case "cron":
			return parseCron(s.spec) ? String(s.spec).trim().replace(/\s+/g, " ") : null;
		default:
			return null;
	}
}

/**
 * schedule 的「下次触发」毫秒时间戳；**一年内没有下一次**（cron 到期日不存在，如 2 月 31 日）回 null。
 *
 * `every` 走真正的间隔语义（`fromMs + N 分钟`），不经 cron —— 所以 90 分钟这种
 * cron 表达不了的间隔也能正确排。其余类型走 cron 计算。
 */
export function nextScheduleFire(schedule, fromMs = Date.now()) {
	const s = schedule && typeof schedule === "object" ? schedule : null;
	if (!s) return null;
	if (s.type === "every") {
		if (!isSupportedEvery(s.minutes)) return null;
		return Number(fromMs) + Number(s.minutes) * 60_000;
	}
	const spec = scheduleToCron(s);
	if (!spec) return null;
	return nextFire(spec, fromMs);
}

/**
 * 把 schedule 在 [fromMs, toMs) 内的所有触发时刻列出来（月视图日历用；上限 limit 条）。
 * `every` 按间隔步进，其余按 cron 逐次推进 —— 日历上「每天 9 点吃药」这种才画得出来。
 */
export function occurrencesBetween(schedule, fromMs, toMs, limit = 200) {
	const s = schedule && typeof schedule === "object" ? schedule : null;
	const from = Number(fromMs);
	const to = Number(toMs);
	if (!s || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
	const out = [];
	// 间隔型：从 from 起按步长走（from 被当作相位锚点 = 「从这一刻起每隔 N 分钟」）
	if (s.type === "every") {
		if (!isSupportedEvery(s.minutes)) return [];
		const step = Number(s.minutes) * 60_000;
		for (let t = from; t < to && out.length < limit; t += step) out.push(t);
		return out;
	}
	// cron 型：逐次推进（-1ms 是为了把正好落在 from 的那一次也算进来）
	let cursor = from - 1;
	for (let i = 0; i < limit; i++) {
		const at = nextScheduleFire(s, cursor);
		if (at === null || at >= to) break;
		out.push(at);
		cursor = at;
	}
	return out;
}

/** 秒级时间戳 → "YYYY-MM-DDTHH:MM"（datetime-local / 我们的 ISO 口径，本地时区）。 */
export function toLocalInput(ms) {
	const d = new Date(Number(ms) || 0);
	if (Number.isNaN(d.getTime())) return "";
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "YYYY-MM-DDTHH:MM"（或任何 Date 认得的串）→ 毫秒；非法回 null。 */
export function fromLocalInput(raw) {
	const s = String(raw ?? "").trim();
	if (!s) return null;
	// 裸 "2026-05-05" 按当天 09:00 处理（用户只写了日期时的合理默认）。
	const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T09:00:00`) : new Date(s);
	return Number.isNaN(d.getTime()) ? null : d.getTime();
}
