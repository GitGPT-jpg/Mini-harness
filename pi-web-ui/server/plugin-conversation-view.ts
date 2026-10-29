/**
 * 插件会话快照的「选哪个会话」策略（issue #542，纯函数，零宿主/零 SDK 依赖）。
 *
 * 背景：`host.getActiveConversation()` 原来只认「全局 lastActiveAt 最大者」，
 * 于是两个标签页各看一个对话时，插件读到的是另一个标签页的会话；子代理跑起来
 * 比用户正在看的对话还勤，也会把父对话挤出快照。这里把选会话的两条口径拆成
 * 纯函数，让 agent-service 只负责取数据、这里负责判定（可单测）。
 *
 * 另外附一个模型变更事件去重键：`host.onClientModelChanged` 只在模型真的换了
 * 的时候发一次（重复点同一个模型、重连重放 set_model 都不该重复触发订阅者）。
 */

/** 判定选会话所需的最小会话形状（`Conversation` 结构上满足）。 */
export interface PluginConversationShape {
	isSubagent: boolean;
	lastActiveAt: number;
}

/** 单客户端内选会话：给了 `active` 就优先认它（= 该标签页正在看的对话），
 *  否则退回归属本客户端的「最近活跃」会话；`includeSubagents=false`（缺省）时
 *  跳过子代理对话。找不到任何符合条件的会话 → null（调用方据此回落）。
 *
 *  `conversations` 只遍历一遍（Map.values() 直传，不额外建数组）。 */
export function pickClientConversation<T extends PluginConversationShape>(
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

/** 跨客户端回落：最近活跃的**非子代理**会话（`at` 最大者）。
 *  缺省语义（不传 clientId / clientId 不认识）走这条 —— 与 #542 之前的行为
 *  一致，只多一条「子代理不算数」。 */
export function pickLatestClientSnapshot<T extends { isSubagent: boolean; at: number }>(
	snapshots: Iterable<T | null | undefined>,
): T | null {
	let best: T | null = null;
	for (const s of snapshots) {
		if (!s || s.isSubagent) continue;
		if (!best || s.at > best.at) best = s;
	}
	return best;
}

/** 模型变更事件的去重键：同一客户端、同一对话、同一模型 = 同一件事。 */
export function modelChangeKey(snap: { clientId: string; conversationId: string; model?: string }): string {
	return `${snap.clientId}\u0000${snap.conversationId}\u0000${snap.model ?? ""}`;
}
