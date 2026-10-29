/**
 * prompt-assembler — 提示词渲染判定、上下文 Token 估算与定稿 Usage 探测纯函数。
 *
 * 负责：
 * - estimateNonSystemTokens: 估算非系统消息与正在流式的助手内容的 token 占用
 * - hasSettledAssistantUsage: 判定会话中是否已有定稿的助手 usage（input/output/totalTokens）
 * - shouldRenderMainCompose: 判定当前预设/覆盖/工具开关是否需要渲染自定义系统提示词
 *
 * 从 agent-service.ts 抽出为独立模块。
 */
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "./serialize.js";
import {
	DEFAULT_PROMPT_TEMPLATE,
	renderPromptTemplate,
	resolveSectionTexts,
	type PromptComposerInputs,
} from "./prompt-composer.js";

/**
 * 会话是否已获得定稿的助手模型 usage（决定是使用真实的 usage 还是估算值）。
 */
export function hasSettledAssistantUsage(messages: unknown[]): boolean {
	if (!Array.isArray(messages)) return false;
	try {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i] as {
				role?: unknown;
				usage?: { input?: number; totalTokens?: number; output?: number };
			} | null;
			if (m && m.role === "assistant" && m.usage) {
				const u = m.usage;
				if ((u.input ?? 0) > 0 || (u.totalTokens ?? 0) > 0 || (u.output ?? 0) > 0) {
					return true;
				}
			}
		}
	} catch {
		// fallback
	}
	return false;
}

/**
 * 估算会话中所有非系统消息（用户消息、工具调用/结果、自定义消息以及正在流式的助手内容）的 Token 开销。
 * 用于在尚未获得定稿 LLM usage 时，配合精准的 baseTokens 给出平滑、真实的上下文预估，
 * 杜绝 SDK 内部全量遍历粗估系统提示词与 baseTokens 双重叠加导致首轮突增翻倍。
 */
export function estimateNonSystemTokens(messages: unknown[], streamingMessage?: unknown): number {
	let total = 0;
	if (!Array.isArray(messages)) return total;
	try {
		for (const m of messages) {
			if ((m as { role?: string })?.role !== "system") {
				total += estimateTokens(m as AgentMessage);
			}
		}
		if (streamingMessage) {
			total += estimateTokens(streamingMessage as AgentMessage);
		}
	} catch {
		// best-effort
	}
	return total;
}

/**
 * 判定当前设置与预设是否属于定制模式，需要渲染独立系统提示词而非依赖 SDK 默认装配。
 */
export function shouldRenderMainCompose(opts: {
	promptTemplate?: string;
	promptOverrides?: Record<string, string>;
	preset?: string;
	disabledToolCount: number;
	isLazy?: boolean;
	hasSkills?: boolean;
	hasSkillsFullText?: boolean;
}): boolean {
	const tpl = (opts.promptTemplate ?? "").trim();
	const ovs = opts.promptOverrides ?? {};
	const hasOverride = Object.values(ovs).some((v) => typeof v === "string" && v.trim());
	const preset = opts.preset ?? "standard";
	return (
		!!tpl ||
		hasOverride ||
		preset !== "standard" ||
		opts.disabledToolCount > 0 ||
		opts.isLazy === true ||
		opts.hasSkills === true ||
		opts.hasSkillsFullText === true
	);
}

/**
 * 渲染组合模板。非定制状态返回 undefined 让 SDK 内部装配。
 */
export function renderMainCompose(
	inputs: PromptComposerInputs,
	opts: {
		promptTemplate?: string;
		promptOverrides?: Record<string, string>;
		preset?: string;
		disabledToolCount: number;
		isLazy?: boolean;
		hasSkills?: boolean;
		hasSkillsFullText?: boolean;
	},
): string | undefined {
	if (!shouldRenderMainCompose(opts)) return undefined;
	const texts = resolveSectionTexts(inputs);
	const tpl = (opts.promptTemplate ?? "").trim();
	const ovs = opts.promptOverrides ?? {};
	const hasOverride = Object.values(ovs).some((v) => typeof v === "string" && v.trim());
	return renderPromptTemplate(tpl || DEFAULT_PROMPT_TEMPLATE, texts, hasOverride ? ovs : undefined);
}
