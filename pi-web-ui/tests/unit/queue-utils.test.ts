import { describe, expect, it } from "vitest";
import { removeFirstOccurrence, removeQueuedByIndexOrText } from "../../server/queue-utils.js";

describe("removeFirstOccurrence", () => {
	it("移除唯一匹配项", () => {
		expect(removeFirstOccurrence(["a", "b", "c"], "b")).toEqual(["a", "c"]);
	});

	it("重复文本只移除第一条（✕ 对应一条消息）", () => {
		expect(removeFirstOccurrence(["dup", "x", "dup"], "dup")).toEqual(["x", "dup"]);
		expect(removeFirstOccurrence(["dup", "dup"], "dup")).toEqual(["dup"]);
	});

	it("找不到时原样返回（拷贝，不是同一引用）", () => {
		const list = ["a", "b"];
		const out = removeFirstOccurrence(list, "zzz");
		expect(out).toEqual(["a", "b"]);
		expect(out).not.toBe(list);
	});

	it("空列表与空字符串", () => {
		expect(removeFirstOccurrence([], "a")).toEqual([]);
		expect(removeFirstOccurrence(["", "a"], "")).toEqual(["a"]);
	});

	it("不修改入参", () => {
		const list = ["a", "b", "a"];
		removeFirstOccurrence(list, "a");
		expect(list).toEqual(["a", "b", "a"]);
	});

	it("保持其余项顺序（重新入队依赖原顺序）", () => {
		expect(removeFirstOccurrence(["1", "2", "3", "4"], "3")).toEqual(["1", "2", "4"]);
	});
});

describe("removeQueuedByIndexOrText", () => {
	it("重复文本按气泡下标移除第二条（点第二个 ✕ 不删第一个）", () => {
		expect(removeQueuedByIndexOrText(["dup", "x", "dup"], "dup", 2)).toEqual(["dup", "x"]);
		expect(removeQueuedByIndexOrText(["dup", "dup"], "dup", 1)).toEqual(["dup"]);
	});

	it("下标 0 移除第一条", () => {
		expect(removeQueuedByIndexOrText(["dup", "x", "dup"], "dup", 0)).toEqual(["x", "dup"]);
	});

	it("不传下标回落到第一处文本匹配（旧客户端）", () => {
		expect(removeQueuedByIndexOrText(["dup", "x", "dup"], "dup")).toEqual(["x", "dup"]);
		expect(removeQueuedByIndexOrText(["dup", "x", "dup"], "dup", undefined)).toEqual(["x", "dup"]);
	});

	it("下标越界/负数/非整数回落到文本匹配", () => {
		expect(removeQueuedByIndexOrText(["dup", "x", "dup"], "dup", 5)).toEqual(["x", "dup"]);
		expect(removeQueuedByIndexOrText(["dup", "x", "dup"], "dup", -1)).toEqual(["x", "dup"]);
		expect(removeQueuedByIndexOrText(["dup", "x", "dup"], "dup", 1.5)).toEqual(["x", "dup"]);
	});

	it("下标处文本已变化（队列在点击后移位）回落到文本匹配", () => {
		// 点击时第二个气泡是 "dup"，执行时该位置已变成 "new"（有条消息刚送达）。
		expect(removeQueuedByIndexOrText(["gone", "new"], "dup", 1)).toEqual(["gone", "new"]);
		expect(removeQueuedByIndexOrText(["dup", "new", "dup"], "dup", 1)).toEqual(["new", "dup"]);
	});

	it("文本不存在时原样返回（拷贝）", () => {
		const list = ["a", "b"];
		const out = removeQueuedByIndexOrText(list, "zzz", 0);
		expect(out).toEqual(["a", "b"]);
		expect(out).not.toBe(list);
	});

	it("不修改入参", () => {
		const list = ["dup", "x", "dup"];
		removeQueuedByIndexOrText(list, "dup", 2);
		expect(list).toEqual(["dup", "x", "dup"]);
	});
});
