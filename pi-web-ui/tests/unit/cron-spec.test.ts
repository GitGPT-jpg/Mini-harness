/**
 * cron 解析（server/cron-spec.ts）单测：字段/整式解析与下次触发都是纯函数。
 * 内置定时任务（scheduler-tasks.ts）与 schedule 工具共用这一套解析。
 */
import { describe, expect, it } from "vitest";
import { parseCronField, parseCronSpec, nextCronFire } from "../../server/cron-spec.js";

describe("parseCronField", () => {
	it("星/步长/范围/列表/单值", () => {
		expect(parseCronField("*", 0, 59)).toHaveLength(60);
		expect(parseCronField("*/15", 0, 59)).toEqual([0, 15, 30, 45]);
		expect(parseCronField("1-5", 0, 59)).toEqual([1, 2, 3, 4, 5]);
		expect(parseCronField("1-10/3", 0, 59)).toEqual([1, 4, 7, 10]);
		expect(parseCronField("5,10,5", 0, 59)).toEqual([5, 10]);
		expect(parseCronField("7", 0, 59)).toEqual([7]); // 分钟字段 7 合法（7→0 只在周字段）
		expect(parseCronField("60", 0, 59)).toBeNull(); // 越界
	});
	it("非法形状回 null", () => {
		expect(parseCronField("", 0, 59)).toBeNull();
		expect(parseCronField("*/0", 0, 59)).toBeNull();
		expect(parseCronField("5-2", 0, 59)).toBeNull();
		expect(parseCronField("abc", 0, 59)).toBeNull();
		expect(parseCronField("1,2,", 0, 59)).toBeNull();
	});
	it("英文名 + 周日 7 视作 0", () => {
		expect(parseCronField("mon", 0, 6, { mon: 1 })).toEqual([1]);
		expect(parseCronField("7", 0, 6)).toEqual([0]);
		expect(parseCronField("jan", 1, 12, { jan: 1 })).toEqual([1]);
	});
});

describe("parseCronSpec", () => {
	it("5 字段合法，老 */N 子集照常工作", () => {
		expect(parseCronSpec("*/5 * * * *")?.minute).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
		expect(parseCronSpec("0 9 * * *")?.hour).toEqual([9]);
		expect(parseCronSpec("30 8 * * mon-fri")?.dow).toEqual([1, 2, 3, 4, 5]);
	});
	it("非法回 null（4 字段/越界/坏 token）", () => {
		expect(parseCronSpec("* * * *")).toBeNull();
		expect(parseCronSpec("61 * * * *")).toBeNull();
		expect(parseCronSpec("* * * * * *")).toBeNull();
		expect(parseCronSpec("0 9 * * nonsense")).toBeNull();
	});
});

describe("nextCronFire（本地时区构造，跨 TZ 稳定）", () => {
	// 2026-09-20 是周日，用本地零部件构造，断言不依赖机器时区。
	const sunday1030 = new Date(2026, 8, 20, 10, 30, 0).getTime();
	it("每天 9 点：周日 10:30 → 周一 09:00", () => {
		const parts = parseCronSpec("0 9 * * *")!;
		expect(nextCronFire(parts, sunday1030)).toBe(new Date(2026, 8, 21, 9, 0, 0).getTime());
	});
	it("整点边界不取当前分钟（严格下一分钟起扫）", () => {
		const monday9 = new Date(2026, 8, 21, 9, 0, 0).getTime();
		const parts = parseCronSpec("0 9 * * *")!;
		expect(nextCronFire(parts, monday9)).toBe(new Date(2026, 8, 22, 9, 0, 0).getTime());
	});
	it("日-周 OR 语义：每月 1 号或周一都触发", () => {
		const parts = parseCronSpec("0 9 1 * mon")!;
		// 周一 2026-09-21 09:00（既是周一，前一个触发点是它）
		expect(nextCronFire(parts, sunday1030)).toBe(new Date(2026, 8, 21, 9, 0, 0).getTime());
		// 2026-10-01 是周四（每月 1 号命中）
		const sept30 = new Date(2026, 8, 30, 10, 0, 0).getTime();
		expect(nextCronFire(parts, sept30)).toBe(new Date(2026, 9, 1, 9, 0, 0).getTime());
	});
	it("分钟步长：10:30 → 10:35", () => {
		const parts = parseCronSpec("*/5 * * * *")!;
		expect(nextCronFire(parts, sunday1030)).toBe(new Date(2026, 8, 20, 10, 35, 0).getTime());
	});
});

describe("远期 cron 的安全引爆（回归：setTimeout 24.8 天溢出 → 死循环）", () => {
	it("一年内没有下一次 → null（不再回「366 天后的哨兵值」）", () => {
		const from = new Date(2026, 8, 20, 10, 30, 0).getTime();
		expect(nextCronFire(parseCronSpec("0 0 31 2 *")!, from)).toBeNull(); // 2 月没有 31 号
		expect(nextCronFire(parseCronSpec("0 0 30 2 *")!, from)).toBeNull(); // 2 月没有 30 号
		// 每年 1 月 1 日这种「下次很远但真的存在」的仍然要给真实时间
		expect(nextCronFire(parseCronSpec("0 9 1 1 *")!, from)).toBe(new Date(2027, 0, 1, 9, 0, 0).getTime());
	});
});
