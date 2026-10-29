/**
 * subagent-handoff — 子代理对等直接交接消息格式化与历史记录工具。
 *
 * 负责：
 * - formatSubagentHandoffMessage: 格式化带角色与源 ID 的交接指令
 * - recordSubagentHandoff: 维护限制容量的交接历史时间戳队列
 *
 * 从 agent-service.ts 抽出为独立模块。
 */

export interface SubagentHandoffRecord {
	fromRunId: string;
	toRunId: string;
	timestamp: number;
}

/** 格式化对等交接注入给目标子代理的消息 */
export function formatSubagentHandoffMessage(fromType: string, fromRunId: string, payload: string): string {
	return `[Peer Hand-off from ${fromType} subagent (${fromRunId.slice(0, 8)})]:\n\n${payload}`;
}

/** 追加交接记录并维持最近 N 条的滑动窗口 */
export function recordSubagentHandoff(
	history: SubagentHandoffRecord[],
	record: SubagentHandoffRecord,
	maxHistory = 50,
): SubagentHandoffRecord[] {
	const next = [...history, record];
	return next.length > maxHistory ? next.slice(-maxHistory) : next;
}
