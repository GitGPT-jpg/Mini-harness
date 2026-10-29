/**
 * tool-info.ts — 工具**定义说明**的归一化（纯模块，零 node 依赖）。
 *
 * 用途：工具卡右键菜单 → 「显示工具详细信息」→ 客户端发 `get_tool_info`，
 * 服务端从引擎取该工具的定义（描述 + 参数 schema + 系统提示词片段）后经本模块
 * 归一化成 wire 载荷回给前端。
 *
 * 为什么不进快照：定义是**静态大对象**（一个工具的 TypeBox schema 动辄几百字节到几 KB），
 * 而快照每 60ms 节流推一次 —— 把几十个工具的定义塞进去等于每次推送都重传一遍。
 * 用户点开弹窗的频率极低，按需取一次最省（同一理由见 serialize.ts 对 details 的封顶）。
 *
 * 归一化规则（单测覆盖）：
 *  - 空白/空串一律丢掉（前端不必写 `?? ""` 的分支）；
 *  - description 超长截断（`…` 结尾），promptGuidelines 逐条丢弃空白项、总量封顶；
 *  - parameters 是 JSON Schema：`JSON.stringify` 超上限就**整丢**并置 `parametersDropped`
 *    （与 toolResult.details 同口径 —— 截断后的 JSON 不可解析，前端还得写容错）；
 *  - 取不到定义 → `found: false`（前端显示「未找到工具定义」，例如历史消息里的插件工具
 *    已经随插件卸载）；引擎压根不支持枚举 → `unsupported: true`。
 */
import type { ServerMessage } from "./protocol.js";

/** parameters（JSON Schema）的体积上限：超过就整丢。 */
export const TOOL_PARAMETERS_CAP = 64_000;
/** description 的字数上限（SDK 里的工具描述很少超过几百字，这里防的是扩展写疯）。 */
export const TOOL_DESCRIPTION_CAP = 8_000;
/** promptGuidelines 合计字数上限（进系统提示词的要点，正常都很短）。 */
export const TOOL_GUIDELINES_CAP = 8_000;

/** 引擎侧一条工具定义的**原始**形状（pi 的 ToolInfo / DSH tools/list 的并集，
 *  只取本模块用得到的字段；缺失一律容忍）。 */
export interface RawToolDefinition {
	name?: unknown;
	label?: unknown;
	description?: unknown;
	promptSnippet?: unknown;
	promptGuidelines?: unknown;
	parameters?: unknown;
	/** 该工具当前是否启用（pi 侧由 getActiveToolNames 求得，DSH 侧不给）。 */
	active?: unknown;
	/** SDK SourceInfo：{ source, scope, path, origin }。 */
	sourceInfo?: unknown;
}

/** `tool_info` 应答载荷（ServerMessage 里那一条的字段，不含 type）。 */
export type ToolInfoPayload = Omit<Extract<ServerMessage, { type: "tool_info" }>, "type">;

function str(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	const s = v.trim();
	return s ? s : undefined;
}

/** 超长截断（`…` 结尾，与前端 truncateText 同款标记）。 */
function cut(s: string, cap: number): string {
	return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

/** 参数 schema 是否可下发（能序列化且不超上限）。 */
function parametersWithinCap(params: unknown): boolean {
	if (params === undefined || params === null) return false;
	try {
		const text = JSON.stringify(params);
		return typeof text === "string" && text.length <= TOOL_PARAMETERS_CAP;
	} catch {
		// 循环引用 / BigInt 等序列化不了的值：当成「没有 schema」。
		return false;
	}
}

/**
 * 归一化一条工具定义 → wire 载荷。
 *
 * @param name 请求里的工具名（**永远以它为准**：定义里的 name 缺失时前端仍要能显示标题）。
 * @param raw  引擎给的定义；undefined/null = 没找到。
 */
export function normalizeToolInfo(name: string, raw?: RawToolDefinition | null): ToolInfoPayload {
	const toolName = str(name) ?? "";
	if (!raw || typeof raw !== "object") return { name: toolName, found: false };

	const payload: ToolInfoPayload = { name: toolName, found: true };

	const label = str(raw.label);
	if (label) payload.label = cut(label, 200);
	const description = str(raw.description);
	if (description) payload.description = cut(description, TOOL_DESCRIPTION_CAP);
	const snippet = str(raw.promptSnippet);
	if (snippet) payload.promptSnippet = cut(snippet, TOOL_DESCRIPTION_CAP);

	if (Array.isArray(raw.promptGuidelines)) {
		const guidelines: string[] = [];
		let total = 0;
		for (const g of raw.promptGuidelines) {
			const text = str(g);
			if (!text) continue;
			if (total + text.length > TOOL_GUIDELINES_CAP) break;
			guidelines.push(text);
			total += text.length;
		}
		if (guidelines.length > 0) payload.promptGuidelines = guidelines;
	}

	if (raw.parameters !== undefined && raw.parameters !== null) {
		if (parametersWithinCap(raw.parameters)) payload.parameters = raw.parameters;
		else payload.parametersDropped = true;
	}

	if (raw.active === true) payload.active = true;
	else if (raw.active === false) payload.active = false;

	const info = raw.sourceInfo;
	if (info && typeof info === "object") {
		const source = str((info as { source?: unknown }).source);
		if (source) payload.source = source;
		const scope = str((info as { scope?: unknown }).scope);
		if (scope) payload.scope = scope;
	}

	return payload;
}

/** 当前引擎不支持枚举工具定义时的应答（前端据此显示「当前引擎不支持」而不是「未找到」）。 */
export function unsupportedToolInfo(name: string): ToolInfoPayload {
	return { name: str(name) ?? "", found: false, unsupported: true };
}
