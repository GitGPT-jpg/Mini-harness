/**
 * 会话快照的「选哪个会话」策略（issue #542，纯函数，零宿主/零 SDK 依赖）。
 *
 * 单客户端内选会话的口径拆成纯函数：agent-service 只负责取数据、这里负责
 * 判定（可单测）。内置定时任务（chatFromScheduler）经
 * `ClientSession.readConversationForScheduler` 用它取运行状态。
 */

/** 判定选会话所需的最小会话形状（`Conversation` 结构上满足）。 */
export interface ConversationShape {
	isSubagent: boolean;
	lastActiveAt: number;
}

/** 单客户端内选会话：给了 `active` 就优先认它（= 该标签页正在看的对话），
 *  否则退回归属本客户端的「最近活跃」会话；`includeSubagents=false`（缺省）时
 *  跳过子代理对话。找不到任何符合条件的会话 → null（调用方据此回落）。
 *
 *  `conversations` 只遍历一遍（Map.values() 直传，不额外建数组）。 */
export function pickClientConversation<T extends ConversationShape>(
	conversations: Iterable<T>,
	opts: { active?: T | undefined; includeSubagents?: boolean } = {},
): T | null {
	const include = opts.includeSubagents === true;
	const active = opts.active;
	if (active && (include || !active.isSubagent)) return active;
	let best: T | null = null;
	for (const c of conversations) {
		if (!include && c.isSubagent) continue;
		if (!best || c.lastActiveAt > best.lastActiveAt) best = c;
	}
	return best;
}
