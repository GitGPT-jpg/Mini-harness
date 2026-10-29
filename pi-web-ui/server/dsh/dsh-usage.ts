/**
 * dsh-usage.ts — DSH 的 token 用量 → 底栏统计口径（纯函数，零依赖，可单测）。
 *
 * DSH `TokenUsage`（模型调用级，见 @deepseek-ai/dsh-llm）的三个**输入桶互斥**：
 *   inputTokens       未命中 prompt cache 的输入
 *   cacheReadTokens   命中 prompt cache 的输入（DeepSeek 从 prompt_tokens 里减出来）
 *   cacheWriteTokens  写入 / 刷新 cache 的输入
 *   outputTokens      本次输出
 * 所以「最近一次请求的输入 = 三桶相加」，而底栏缓存命中率（web/src/cache-stats.ts 的
 * cacheMetrics）正是按 miss/read/write 归一算的 — 两边口径一致。
 *
 * 两条投递路径共用这里的映射：
 *   - 老运行时（0.1.1-rc.2）：usage 是持久 `assistant/chunk` 事件（逐 chunk 推）
 *   - 新运行时（0.1.1-rc.2 之后）：usage 随持久 `assistant/message.usage` 落一次，另有
 *     `agent/assistant-stream` 直播帧（wrapper 转成 `assistant.stream` 通知）
 * 字段形状两边一致，故收成一个纯函数（单测 tests/unit/dsh-usage.test.ts）。
 */

/** UiState.stats.tokens 的四桶（与 pi 引擎同口径：input 是「未缓存」那部分）。 */
export interface DshTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** footer / stats 用的「当前上下文占用」形状（UiState.contextUsage 的子集）。 */
export interface DshContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/** 非负整数兜底：缺字段 / 非法值（NaN、负、Infinity）一律算 0。 */
function count(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

/**
 * 一次模型调用的 DSH usage → 四桶统计。
 *
 * @param usage - `assistant/chunk.usage` / `assistant/message.usage`（结构子集）。
 * @returns 四桶；非对象（缺 usage）→ null，调用方据此保留旧统计不动。
 */
export function normalizeDshUsage(usage: unknown): DshTokens | null {
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
	const u = usage as {
		inputTokens?: unknown;
		outputTokens?: unknown;
		cacheReadTokens?: unknown;
		cacheWriteTokens?: unknown;
	};
	return {
		input: count(u.inputTokens),
		output: count(u.outputTokens),
		cacheRead: count(u.cacheReadTokens),
		cacheWrite: count(u.cacheWriteTokens),
	};
}

/** 最近一次请求的 prompt token 数（三个输入桶互斥 → 相加）。 */
export function dshPromptTokens(tokens: DshTokens): number {
	return tokens.input + tokens.cacheRead + tokens.cacheWrite;
}

/**
 * 当前上下文占用 = 最近一次请求的 prompt + 该次输出（下一步请求会把它带上）。
 * 还没拿到任何 usage（新对话 / 回放无 usage）→ tokens/percent 为 null，前端显示
 * `—`（与 pi 引擎一致，而不是骗人的 `0 / 1.0M`）。
 */
export function dshContextUsage(tokens: DshTokens | null, contextWindow: number): DshContextUsage {
	if (!tokens) return { tokens: null, contextWindow, percent: null };
	const used = dshPromptTokens(tokens) + tokens.output;
	if (!(contextWindow > 0)) return { tokens: used, contextWindow, percent: null };
	return { tokens: used, contextWindow, percent: Math.min(100, (used / contextWindow) * 100) };
}

/**
 * 从会话日志（JSONL 回放 / 事件流）里取**最后一次** usage，供切回历史会话时底栏
 * 立刻有上下文与缓存命中数字。
 *
 * 同时认两种形状：新运行时的 `assistant/message.usage`，老运行时的
 * `assistant/chunk` 里的 `{type:"usage", usage}`。按日志顺序取最后一条（日志即 seq 序）。
 */
export function lastUsageFromEvents(
	events: readonly { type: string; data?: Record<string, unknown> }[],
): DshTokens | null {
	let found: DshTokens | null = null;
	for (const ev of events) {
		const data = ev.data ?? {};
		if (ev.type === "assistant/message") {
			const usage = normalizeDshUsage(data.usage);
			if (usage) found = usage;
		} else if (ev.type === "assistant/chunk") {
			const chunk = data.chunk as { type?: unknown; usage?: unknown } | undefined;
			if (chunk?.type === "usage") {
				const usage = normalizeDshUsage(chunk.usage);
				if (usage) found = usage;
			}
		}
	}
	return found;
}
