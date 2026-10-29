import { describe, expect, it } from "vitest";
import { computeEarlierCount, mergeEarlierPage } from "../../web/src/history-window.js";
import type { UiMessage, UiState } from "../../web/src/types.js";

const m = (id: string): UiMessage => ({ id, role: "user", content: [] }) as UiMessage;

function ui(ids: string[], historyStart: number, historyTotal: number): UiState {
	return { conversationId: "c1", messages: ids.map(m), historyStart, historyTotal } as unknown as UiState;
}

describe("mergeEarlierPage", () => {
	it("接得上就前插，并推进窗口起点", () => {
		const merged = mergeEarlierPage(ui(["m10", "m11"], 10, 12), {
			messages: [m("m8"), m("m9")],
			historyStart: 8,
			historyTotal: 12,
		});
		expect(merged?.messages.map((x) => x.id)).toEqual(["m8", "m9", "m10", "m11"]);
		expect(merged?.historyStart).toBe(8);
		expect(merged?.historyTotal).toBe(12);
	});

	it("接缝对不上（错位）就丢弃整页", () => {
		const merged = mergeEarlierPage(ui(["m10", "m11"], 10, 12), {
			messages: [m("m5"), m("m6")],
			historyStart: 5,
			historyTotal: 12,
		});
		expect(merged).toBeNull();
	});

	it("总数变了（期间收到新消息/流式追加）依然正常保留前插并更新总数（issue #703）", () => {
		const merged = mergeEarlierPage(ui(["m10", "m11"], 10, 12), {
			messages: [m("m8"), m("m9")],
			historyStart: 8,
			historyTotal: 99,
		});
		expect(merged).not.toBeNull();
		expect(merged?.messages.map((x) => x.id)).toEqual(["m8", "m9", "m10", "m11"]);
		expect(merged?.historyStart).toBe(8);
		expect(merged?.historyTotal).toBe(99);
	});

	it("空页 = 已到最早：对齐计数，即使起点没变也返回（用于收起加载态）", () => {
		expect(mergeEarlierPage(ui(["m4"], 0, 5), { messages: [], historyStart: 0, historyTotal: 5 })).toBeNull();
		const aligned = mergeEarlierPage(ui(["m4"], 3, 5), { messages: [], historyStart: 0, historyTotal: 5 });
		expect(aligned?.historyStart).toBe(0);
	});

	it("老服务端（无窗口字段）视为起点 0，不接受任何更早页", () => {
		const legacy = { conversationId: "c1", messages: [m("a")] } as unknown as UiState;
		expect(mergeEarlierPage(legacy, { messages: [m("x")], historyStart: 0, historyTotal: 2 })).toBeNull();
	});
});

describe("computeEarlierCount", () => {
	it("关闭向上分页时：若服务端截留历史（historyStart > 0），正确返回截留条数", () => {
		const count = computeEarlierCount({
			isPagingActive: false,
			totalMessages: 300,
			visibleCount: 30,
			historyStart: 27,
		});
		expect(count).toBe(27);
	});

	it("关闭向上分页且无服务端截留时：返回 0", () => {
		const count = computeEarlierCount({
			isPagingActive: false,
			totalMessages: 50,
			visibleCount: 30,
			historyStart: 0,
		});
		expect(count).toBe(0);
	});

	it("开启向上分页时：本地未展示数 + 服务端截留数合并计算", () => {
		const count = computeEarlierCount({
			isPagingActive: true,
			totalMessages: 100,
			visibleCount: 30,
			historyStart: 20,
		});
		expect(count).toBe(70 + 20);
	});
});
