/**
 * tool-prompt-overrides.ts —— 工具**模型可见文案**的用户覆盖（纯归一化 + 会话打补丁）。
 *
 * 每个工具的文案有三个面（见 AGENTS.md「工具提示词三处职责分离」）：
 *  1. `description`      —— 进 tool schema，模型据此判断「这是什么、有什么副作用」；
 *  2. `promptSnippet`    —— 进系统提示词 Available tools 列表（`- name: snippet`）；
 *  3. `promptGuidelines` —— 进系统提示词 Guidelines 段（何时用/顺序/禁止）。
 * 这三处过去全部写死在代码/SDK/插件里，设置页只能开关工具、不能改文案。本模块让用户
 * 可以**逐工具**覆盖任意一项（留空 = 用默认）。
 *
 * 为什么打补丁而不是在注册时替换定义：SDK 的工具注册表由
 * `[...扩展注册, ...customTools]` + 内置定义合并而成（`_refreshToolRegistry()`），
 * 覆盖面必须落在**合并之后**的注册表上才覆盖得到全部来源（核心内置/本项目工具/插件/MCP）。
 * 手法与 `tool-overrides.ts` / `plugins.ts` 相同：改 SDK 私有字段；字段名一变即返回
 * null，调用方按「覆盖没装上」降级（模型仍看到默认文案，不会更差）。
 *
 * 打哪三个补丁：
 *  - `_toolRegistry`（name → 已包装的 AgentTool）：改 `.description`。运行时
 *    `_preparePromptAndToolLoadout()` 就从这个表取工具塞进 `agent.state.tools`，
 *    所以下一轮的 tool schema 立即带上覆盖文案（会话中途改也会重新声明工具）。
 *  - `_toolPromptSnippets` / `_toolPromptGuidelines`：SDK 内部组装系统提示词时读这两个
 *    表；web-ui 自己重渲染提示词时也会读（见 agent-service 的 compose 循环）。
 *  **默认值从 `_toolDefinitions` 取**（本模块从不改它，永远是出厂定义）——这样反复
 *  apply（清空覆盖、插件 sync 后重放）都能准确回到默认，不会层层叠字。
 *
 * 本模块不 import SDK / node：只依赖 `./protocol.js` 的 wire 类型，浏览器端也能复用
 * 归一化函数（`web/src/types.ts` 是 protocol 的 shim）。
 */
import type { UiToolPromptOverride } from "./protocol.js";

/** 覆盖表（工具名 → 覆盖内容）。 */
export type ToolPromptOverrideMap = Record<string, UiToolPromptOverride>;

/** 各字段上限：与 `tool-info.ts` 的下发上限同口径，防扩展/手抖写疯。 */
export const TOOL_PROMPT_DESCRIPTION_CAP = 8_000;
export const TOOL_PROMPT_SNIPPET_CAP = 8_000;
/** promptGuidelines 合计字数上限（多条要点共享）。 */
export const TOOL_PROMPT_GUIDELINE_CAP = 8_000;
/** promptGuidelines 条数上限。 */
export const TOOL_PROMPT_GUIDELINE_MAX = 50;
/** 覆盖项数上限（一个工作区正常几十个工具；防脏存档无限膨胀）。 */
export const TOOL_PROMPT_OVERRIDE_MAX = 500;

function trimmedString(v: unknown, cap: number): string | undefined {
	if (typeof v !== "string") return undefined;
	const s = v.trim();
	if (!s) return undefined;
	return s.length > cap ? s.slice(0, cap) : s;
}

/**
 * 归一化单条覆盖：只保留非空字段；全空 → null（= 没有覆盖）。
 * 空串/空白/非字符串一律当「没设置」，与 `promptOverrides` 的口径一致。
 */
export function normalizeToolPromptOverride(v: unknown): UiToolPromptOverride | null {
	if (!v || typeof v !== "object") return null;
	const src = v as { description?: unknown; promptSnippet?: unknown; promptGuidelines?: unknown };
	const out: UiToolPromptOverride = {};
	const description = trimmedString(src.description, TOOL_PROMPT_DESCRIPTION_CAP);
	if (description) out.description = description;
	const promptSnippet = trimmedString(src.promptSnippet, TOOL_PROMPT_SNIPPET_CAP);
	if (promptSnippet) out.promptSnippet = promptSnippet;
	if (Array.isArray(src.promptGuidelines)) {
		const guidelines: string[] = [];
		let total = 0;
		for (const g of src.promptGuidelines) {
			const text = trimmedString(g, TOOL_PROMPT_GUIDELINE_CAP);
			if (!text) continue;
			if (guidelines.length >= TOOL_PROMPT_GUIDELINE_MAX) break;
			if (total + text.length > TOOL_PROMPT_GUIDELINE_CAP) break;
			guidelines.push(text);
			total += text.length;
		}
		if (guidelines.length > 0) out.promptGuidelines = guidelines;
	}
	return Object.keys(out).length > 0 ? out : null;
}

/** 归一化整张覆盖表：丢掉空项/空对象/非字符串键；超出上限的条目截断。
 *  当传入 knownTools 时，只取当前系统已知可用的工具配置，丢弃未知或不可用工具，防后期漂移或脏数据。 */
export function normalizeToolPromptOverrides(
	v: unknown,
	knownTools?: readonly string[] | Set<string>,
): ToolPromptOverrideMap {
	if (!v || typeof v !== "object" || Array.isArray(v)) return {};
	const out: ToolPromptOverrideMap = {};
	let count = 0;
	const isKnown = (key: string) => {
		if (!knownTools) return true;
		if (knownTools instanceof Set) return knownTools.has(key);
		return (knownTools as readonly string[]).includes(key);
	};
	for (const [name, raw] of Object.entries(v as Record<string, unknown>)) {
		const key = name.trim();
		if (!key || !isKnown(key)) continue;
		const ov = normalizeToolPromptOverride(raw);
		if (!ov) continue;
		if (count >= TOOL_PROMPT_OVERRIDE_MAX) break;
		out[key] = ov;
		count++;
	}
	return out;
}

/** 取某工具的有效覆盖（没有 → null）。 */
export function toolPromptOverrideOf(
	map: ToolPromptOverrideMap | undefined,
	name: string,
): UiToolPromptOverride | null {
	const ov = map?.[name];
	return ov && Object.keys(ov).length > 0 ? ov : null;
}

/** 工具定义的**默认**文案（SDK `_toolDefinitions` 里的出厂值；本模块从不改它）。 */
export interface DefaultToolPrompt {
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
}

/** 叠加覆盖后的有效文案（覆盖字段优先，缺省回落默认）。 */
export function effectiveToolPrompt(
	base: DefaultToolPrompt | undefined,
	override: UiToolPromptOverride | null,
): DefaultToolPrompt {
	if (!override) return { ...base };
	const out: DefaultToolPrompt = { ...base };
	if (override.description) out.description = override.description;
	if (override.promptSnippet) out.promptSnippet = override.promptSnippet;
	if (override.promptGuidelines) out.promptGuidelines = [...override.promptGuidelines];
	return out;
}

/* ------------------------------------------------------------------ */
/* 会话打补丁                                                          */
/* ------------------------------------------------------------------ */

/** 已包装的工具（`wrapToolDefinition` 的产物）：本模块只认要改的 `description`。 */
interface WrappedToolLike {
	name?: string;
	description?: string;
}

/** 会话的 SDK 私有面（结构子集）：字段名一变即视为不支持，返回 null 降级。 */
export interface ToolPromptSessionLike {
	_toolRegistry?: Map<string, WrappedToolLike>;
	_toolPromptSnippets?: Map<string, string>;
	_toolPromptGuidelines?: Map<string, string[]>;
	_toolDefinitions?: Map<string, { definition?: DefaultToolPrompt }>;
	/** 补齐补丁后用当前活跃集重建系统提示词选项（见下）。 */
	getActiveToolNames?: () => string[];
	setActiveToolsByName?: (names: string[]) => void;
}

/**
 * 把覆盖表打进会话：返回被覆盖的工具名；会话结构不符（SDK 改私有字段名）返回 null。
 *
 * 幂等：每次都用 `_toolDefinitions` 的默认值重算，清空覆盖后再次 apply 会准确复原。
 * 调用点见 `agent-service.ts` 的 `applyToolGating()`（会话创建/设置变更/插件 sync 后统一重放）。
 */
export function applyToolPromptOverrides(
	session: ToolPromptSessionLike | undefined | null,
	overrides: ToolPromptOverrideMap | undefined,
): string[] | null {
	const s = session;
	const registry = s?._toolRegistry;
	const definitions = s?._toolDefinitions;
	if (!s || !(registry instanceof Map) || !(definitions instanceof Map)) return null;
	const snippets = s._toolPromptSnippets;
	const guidelines = s._toolPromptGuidelines;
	const applied: string[] = [];
	for (const [name, tool] of registry) {
		if (!tool || typeof tool !== "object") continue;
		const base = definitions.get(name)?.definition;
		if (!base) continue;
		const override = toolPromptOverrideOf(overrides, name);
		// description：模型可见的 tool schema 主描述。
		if (typeof base.description === "string") {
			const next = override?.description ?? base.description;
			if (tool.description !== next) tool.description = next;
		}
		// promptSnippet：系统提示词 Available tools 列表。
		if (snippets instanceof Map) {
			const next = override?.promptSnippet ?? base.promptSnippet;
			if (typeof next === "string" && next.trim()) snippets.set(name, next);
			else snippets.delete(name);
		}
		// promptGuidelines：系统提示词 Guidelines 段。
		if (guidelines instanceof Map) {
			const next = override?.promptGuidelines ?? base.promptGuidelines;
			if (Array.isArray(next) && next.length > 0) guidelines.set(name, [...next]);
			else guidelines.delete(name);
		}
		if (override) applied.push(name);
	}
	// 上面的 snippet/guidelines 补丁改的是 SDK 内部表，而 `_baseSystemPromptOptions`
	// 是在 `setActiveToolsByName()` 里**快照**这两个表的 —— 不重建的话，当 web-ui 自己
	// 不重渲染提示词（完全默认态）时模型会拿到旧 snippet。用当前活跃集重放一次即可
	// （同时把带新 description 的包装工具重新装进 `agent.state.tools`）。
	if (typeof s.getActiveToolNames === "function" && typeof s.setActiveToolsByName === "function") {
		try {
			s.setActiveToolsByName(s.getActiveToolNames());
		} catch {
			// 活跃集校验失败不该让覆盖整体失效：跳过重建，只当提示词快照未刷新。
		}
	}
	return applied;
}
