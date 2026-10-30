/**
 * cron 解析（内置定时任务 scheduler-tasks.ts 与 schedule 工具共用，纯函数）。
 *
 * 全 5 字段 cron（分 时 日 月 周）：`"*"` / `"*\/n"` / `"a-b"` / `"a-b/n"` /
 * `"a,b,c"` / 单数字；月/周支持英文名（jan/dec 不分大小写，sun..sat，7 视作 0）。
 * 日-周按标准 cron OR 语义（都受限取并集，一侧 `*` 时另一侧说了算）。
 * 时间一律按**服务器本地时区**算（文档写死，不做 TZ 配置）。
 */

export interface CronParts {
	minute: number[];
	hour: number[];
	dom: number[];
	month: number[];
	dow: number[];
}

const MONTH_NAMES: Record<string, number> = {
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
const DOW_NAMES: Record<string, number> = {
	sun: 0,
	mon: 1,
	tue: 2,
	wed: 3,
	thu: 4,
	fri: 5,
	sat: 6,
};

/** 单字段解析 → 升序去重数组；非法回 null。纯函数，单测覆盖。 */
export function parseCronField(raw: string, min: number, max: number, names?: Record<string, number>): number[] | null {
	const src = String(raw ?? "")
		.trim()
		.toLowerCase();
	if (!src) return null;
	const out = new Set<number>();
	const num = (tok: string): number | null => {
		const t = tok.trim();
		if (!t) return null;
		if (names && t in names) return names[t]!;
		if (!/^\d+$/.test(t)) return null;
		let n = Number(t);
		if (n === 7 && min === 0 && max === 6) n = 0; // 周日的 7 写法
		if (!Number.isInteger(n) || n < min || n > max) return null;
		return n;
	};
	for (const part of src.split(",")) {
		const p = part.trim();
		if (!p) return null;
		// 步长：*/n 或 a-b/n（a 缺省 min，b 缺省 max）。
		const step = p.split("/");
		if (step.length === 2) {
			const every = num(step[1]!);
			if (every === null || every <= 0) return null;
			let lo = min;
			let hi = max;
			if (step[0] !== "" && step[0] !== "*") {
				const range = step[0]!.split("-");
				if (range.length > 2) return null;
				const a = num(range[0]!);
				if (a === null) return null;
				lo = a;
				if (range.length === 2) {
					const b = num(range[1]!);
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
			const a = num(range[0]!);
			const b = num(range[1]!);
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

/** 5 字段 cron 解析；非法回 null。纯函数，单测覆盖。 */
export function parseCronSpec(spec: string): CronParts | null {
	const fields = String(spec ?? "")
		.trim()
		.split(/\s+/);
	if (fields.length !== 5) return null;
	const minute = parseCronField(fields[0]!, 0, 59);
	const hour = parseCronField(fields[1]!, 0, 23);
	const dom = parseCronField(fields[2]!, 1, 31);
	const month = parseCronField(fields[3]!, 1, 12, MONTH_NAMES);
	const dow = parseCronField(fields[4]!, 0, 6, DOW_NAMES);
	if (!minute || !hour || !dom || !month || !dow) return null;
	return { minute, hour, dom, month, dow };
}

function isFull(values: number[], min: number, max: number): boolean {
	return values.length === max - min + 1;
}

/**
 * 下一次触发毫秒时间戳（从 fromMs 的下一分钟开始扫，上限约一年）；**一年内没有下一次回 null**
 * （例如 `0 0 31 2 *` 这种永远不存在的日子）。
 *
 * 为什么不是回一个「一年后的哨兵值」：调用方若拿它做 `setTimeout(next - now)`，
 * 而 Node 的 setTimeout 延迟超过 2^31-1ms（≈24.8 天）会**溢出成 1ms** —— 哨兵值配上溢出
 * 就是「1ms 后触发 → 再排下一次」的死循环。回 null 之后，调用方能明确区分「还有很久」
 * 与「永远不会发生」。纯函数，单测覆盖。
 */
export function nextCronFire(parts: CronParts, fromMs: number): number | null {
	const minuteSet = new Set(parts.minute);
	const hourSet = new Set(parts.hour);
	const monthSet = new Set(parts.month);
	const domRestricted = !isFull(parts.dom, 1, 31);
	const dowRestricted = !isFull(parts.dow, 0, 6);
	const domSet = new Set(parts.dom);
	const dowSet = new Set(parts.dow);
	let t = Math.floor(Number(fromMs) / 60000) * 60000 + 60000;
	const limit = t + 366 * 24 * 60 * 60000;
	for (; t <= limit; t += 60000) {
		const d = new Date(t);
		if (!monthSet.has(d.getMonth() + 1)) continue;
		const domHit = domSet.has(d.getDate());
		const dowHit = dowSet.has(d.getDay());
		// 标准 OR 语义：都受限取并集；一侧通配时另一侧说了算；都不受限天天跑。
		const dayHit =
			domRestricted && dowRestricted ? domHit || dowHit : domRestricted ? domHit : dowRestricted ? dowHit : true;
		if (!dayHit) continue;
		if (!hourSet.has(d.getHours())) continue;
		if (!minuteSet.has(d.getMinutes())) continue;
		return t;
	}
	return null;
}
