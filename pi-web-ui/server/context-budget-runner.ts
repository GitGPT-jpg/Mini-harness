/**
 * context-budget-runner — 多级分层上下文预算裁剪执行器。
 *
 * 当上下文达到预警水位（例如 70%）时，自动执行第一级（远期工具输出裁剪）和
 * 第二级（已完成步骤折叠），推迟触发全量 LLM 压缩，保留近期关键代码的细节。
 *
 * 从 agent-service.ts 抽出为独立模块。
 */
import { contextWindowOf, modelKeyOf } from "./agent-formatters.js";
import { effectiveSoftCap, softCapToReserve, DEFAULT_COMPACTION_RESERVE_TOKENS } from "./soft-cap.js";
import { pruneContextHierarchically } from "./context-budget.js";
import type { Conversation } from "./agent-service.js";

export interface ContextPruningResult {
	pruned: boolean;
	tokensSaved: number;
}

/**
 * 对指定对话执行分层上下文预算裁剪评估与就地修剪。
 */
export function executeContextBudgetPruning(
	conv: Conversation,
	settings: {
		softCapTokens?: number;
		softCapByModel?: Record<string, number>;
	},
): ContextPruningResult {
	if (!conv?.session) return { pruned: false, tokensSaved: 0 };
	try {
		const contextWindow = contextWindowOf(conv.session);
		if (!contextWindow || contextWindow <= 0) return { pruned: false, tokensSaved: 0 };
		const modelId = modelKeyOf(conv.session);
		const cap = effectiveSoftCap(settings.softCapTokens ?? 0, settings.softCapByModel, modelId);
		const reserve = softCapToReserve(contextWindow, cap) ?? DEFAULT_COMPACTION_RESERVE_TOKENS;

		const messages = conv.session.agent.state.messages;
		if (!messages || messages.length === 0) return { pruned: false, tokensSaved: 0 };

		const result = pruneContextHierarchically(messages, {
			contextWindow,
			reserveTokens: reserve,
			softCap: cap > 0 ? cap : null,
		});

		if (result.tier1.trimmedCount > 0 || result.tier2.foldedCount > 0) {
			conv.session.agent.state.messages = result.messages;
			const tokensSaved = result.tokensBefore - result.tokensAfter;
			return { pruned: true, tokensSaved };
		}
		return { pruned: false, tokensSaved: 0 };
	} catch {
		return { pruned: false, tokensSaved: 0 };
	}
}
