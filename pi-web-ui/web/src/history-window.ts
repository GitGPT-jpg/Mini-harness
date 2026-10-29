/**
 * history-window — 服务端历史窗口「往前翻页」的前端合并规则（纯函数，零 React 依赖）。
 *
 * 服务端（`server/message-window.ts`）把 `snapshot.messages` 裁成尾部窗口，更早的一段
 * 由 `load_earlier_messages` 按需返回（`earlier_messages`）。这里只负责把这一页**前插**
 * 到本地消息数组，并守住两条不变量：
 *
 *   1. **必须接得上**：`historyStart + messages.length === 当前窗口起点`。接不上说明两边
 *      已错位（多开标签页、对话被重开过、服务端 LRU 把缓存清了），此时宁可丢弃这一页，
 *      等下一次全量快照重建基线——错位拼接会让消息顺序错乱，比少一段历史严重得多。
 *   2. **空页也要认**：`messages: []` 是「已经到最早了」的正规回执，要把起点/总数对齐，
 *      前端据此收起加载态。
 */
import type { UiMessage, UiState } from "./types";

/** 一页更早历史的回执形状（对应 wire 的 `earlier_messages`）。 */
export interface EarlierPage {
	messages: UiMessage[];
	historyStart: number;
	historyTotal: number;
}

/**
 * 合并一页更早历史；返回 `null` = 该页不可用（错位或空转），调用方保持原状态。
 */
export function mergeEarlierPage(ui: UiState, page: EarlierPage): UiState | null {
	const curStart = ui.historyStart ?? 0;
	const curTotal = ui.historyTotal ?? ui.messages.length;
	if (page.messages.length === 0) {
		if (page.historyStart === curStart && page.historyTotal === curTotal) return null;
		return { ...ui, historyStart: page.historyStart, historyTotal: page.historyTotal };
	}
	// 接缝校验：这一页的末尾必须正好接在当前窗口的第一条之前
	if (page.historyStart + page.messages.length !== curStart) return null;
	// 总数更新：流式生成或在途新消息会增加总数，保留已返回消息并同步最新总数，
	// 绝不因总数更新而丢弃整页导致服务端游标前移后历史永久不可达（issue #703）
	return {
		...ui,
		messages: [...page.messages, ...ui.messages],
		historyStart: page.historyStart,
		historyTotal: page.historyTotal,
	};
}

/**
 * 计算未展现的更早历史条数：
 * - 开启本地向上分页时：未展示的本地消息数 + 服务端窗口截留数；
 * - 关闭本地向上分页时：服务端窗口截留数（如首屏截断的 300 条以外的历史）。
 */
export function computeEarlierCount(opts: {
	isPagingActive: boolean;
	totalMessages: number;
	visibleCount: number;
	historyStart?: number;
}): number {
	const serverEarlier = Math.max(0, opts.historyStart ?? 0);
	if (!opts.isPagingActive) {
		return serverEarlier;
	}
	const localEarlier = Math.max(0, opts.totalMessages - Math.min(opts.totalMessages, opts.visibleCount));
	return localEarlier + serverEarlier;
}
