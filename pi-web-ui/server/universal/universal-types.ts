/**
 * universal-types.ts — 通用 Agent 会话与状态类型定义。
 */

import type { UiMessage } from "../protocol.js";
import type { SubagentState } from "../subagents.js";
import type { SubagentTemplate } from "../subagent-templates.js";

/** 会话级累计指标与上下文占用（用于驱动底栏上下文环、Token 计数、缓存命中率与累计成本） */
export interface UniversalConversationStats {
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage: {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	};
}

/** 线性通用会话结构 */
export interface UniversalConversation {
	/** 内部对话唯一 ID（如 uconv-1712345678-abc） */
	id: string;
	/** 标题（显示在左侧会话列表） */
	title: string;
	/** 外部驱动持有的会话 ID（例如 Claude Code 的 session_id） */
	driverSessionId?: string;
	/** 创建时间戳 (ms) */
	createdAt: number;
	/** 更新时间戳 (ms) */
	updatedAt: number;
	/** 会话历史消息（严格线性追加，无树状分叉） */
	messages: UiMessage[];
	/** 是否置顶 */
	pinned?: boolean;
	/** 是否为临时会话（不主动落盘，转正前仅常驻内存） */
	isEphemeral?: boolean;
	/** 累计 Token、成本与上下文占用统计 */
	stats?: UniversalConversationStats;

	/** 是否为派生的轻量子代理会话 */
	isSubagent?: boolean;
	/** 子代理类型 / 角色（如 explore, implement, review 等） */
	subagentType?: string;
	/** 子代理任务初始 Prompt */
	subagentPrompt?: string;
	/** 派发该子代理的父对话 ID */
	subagentParentId?: string;
	/** 子代理当前运行态 */
	subagentState?: SubagentState;
	/** 是否正在流式生成 */
	subagentStreaming?: boolean;
	/** 错误信息（若失败） */
	subagentError?: string;
	/** 是否被中止（用户或 AI 停止） */
	subagentCanceled?: boolean;
	/** 子代理使用的模板 */
	subagentTemplate?: SubagentTemplate;
	/** 子代理使用的模型 */
	subagentModel?: string;
	/** 跨代理协作交接的目标 ID 列表 */
	subagentHandoffTo?: string[];
	/** 跨代理协作交接的来源 ID 列表 */
	subagentHandoffFrom?: string[];
}

/** 驱动执行过程中的活跃上下文状态 */
export interface ActiveTurnState {
	userMessageId: string;
	assistantMessageId: string;
	thinkingText: string;
	assistantText: string;
	/** 正在运行中的工具调用 blocks */
	activeToolCalls: Map<
		string,
		{
			id: string;
			name: string;
			argumentsText: string;
			startTime: number;
		}
	>;
}
