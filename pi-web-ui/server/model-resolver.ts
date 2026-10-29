/**
 * model-resolver.ts — 跨引擎通用模型与服务商凭据解析器。
 *
 * 职责：
 *   作为宿主级模型配置基础层的只读解析器，统一读取与解析：
 *   1. `<agentDir>/models.json`（自定义服务商、BaseURL、API 类型、模型列表与内置覆盖）
 *   2. `<agentDir>/auth.json`（持久化 API 密钥）
 *   3. `<agentDir>/provider-keys.json`（多密钥管理与当前激活密钥）
 *   4. 进程环境变量回退（如 ANTHROPIC_API_KEY, DEEPSEEK_API_KEY 等）
 *
 * 供 Claude Code CLI 驱动、DSH 引擎与 Pi 引擎统一调用，消除各引擎间的配置孤岛。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function defaultAgentDir(agentDir?: string): string {
	return agentDir && agentDir.trim()
		? agentDir.trim()
		: (process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
}

export interface ResolvedProviderCredential {
	providerId: string;
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
}

export interface CustomModelEntry {
	providerId: string;
	providerName?: string;
	modelId: string;
	name: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	vision?: boolean;
}

/** 剥离 JSON 字符串中的 // 和 /* *\/ 注释（保护字符串字面量内的 URL） */
export function stripJsonComments(src: string): string {
	let out = "";
	let inString = false;
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const next = src[i + 1];
		if (inString) {
			out += c;
			if (c === "\\") {
				out += next ?? "";
				i += 2;
				continue;
			}
			if (c === '"') inString = false;
			i++;
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
			i++;
			continue;
		}
		if (c === "/" && next === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && next === "*") {
			i += 2;
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

/** 读取并解析 models.json（容忍注释） */
export function readModelsJson(agentDir?: string): { providers: Record<string, Record<string, unknown>> } {
	const dir = defaultAgentDir(agentDir);
	const filePath = join(dir, "models.json");
	if (!existsSync(filePath)) return { providers: {} };
	try {
		const raw = readFileSync(filePath, "utf8");
		const parsed = JSON.parse(stripJsonComments(raw)) as {
			providers?: Record<string, Record<string, unknown>>;
		};
		return { providers: parsed?.providers ?? {} };
	} catch {
		return { providers: {} };
	}
}

/** 读取并解析 auth.json */
export function readAuthJson(agentDir?: string): Record<string, unknown> {
	const dir = defaultAgentDir(agentDir);
	const filePath = join(dir, "auth.json");
	if (!existsSync(filePath)) return {};
	try {
		const raw = readFileSync(filePath, "utf8");
		return (JSON.parse(raw) as Record<string, unknown>) ?? {};
	} catch {
		return {};
	}
}

/** 读取并解析 provider-keys.json */
export function readProviderKeysJson(agentDir?: string): Record<
	string,
	{
		activeKeyName: string | null;
		keys: Array<{ name: string; apiKey: string }>;
	}
> {
	const dir = defaultAgentDir(agentDir);
	const filePath = join(dir, "provider-keys.json");
	if (!existsSync(filePath)) return {};
	try {
		const raw = readFileSync(filePath, "utf8");
		return JSON.parse(raw) as Record<
			string,
			{
				activeKeyName: string | null;
				keys: Array<{ name: string; apiKey: string }>;
			}
		>;
	} catch {
		return {};
	}
}

/**
 * 为指定 provider 解析完整凭据（BaseURL、API Key、API 类型、自定义 Headers）。
 * 优先级：models.json 明确定义 > provider-keys.json 激活密钥 > auth.json > 环境变量。
 */
export function resolveProviderCredential(
	agentDir: string | undefined,
	providerId: string,
): ResolvedProviderCredential {
	const dir = defaultAgentDir(agentDir);
	const pid = providerId.trim();
	const { providers } = readModelsJson(dir);
	const prov = providers[pid];

	let baseUrl: string | undefined = typeof prov?.baseUrl === "string" ? prov.baseUrl.trim() : undefined;
	let apiKey: string | undefined = typeof prov?.apiKey === "string" ? prov.apiKey.trim() : undefined;
	const api: string | undefined = typeof prov?.api === "string" ? prov.api.trim() : undefined;
	const headers: Record<string, string> | undefined =
		prov?.headers && typeof prov.headers === "object" && !Array.isArray(prov.headers)
			? (prov.headers as Record<string, string>)
			: undefined;

	// 1. 若 models.json 未显式配置 apiKey，则从 provider-keys.json 取激活密钥
	if (!apiKey) {
		const multiKeys = readProviderKeysJson(dir);
		const entry = multiKeys[pid];
		if (entry?.keys && entry.keys.length > 0) {
			const active = entry.keys.find((k) => k.name === entry.activeKeyName);
			apiKey = active?.apiKey ?? entry.keys[0]?.apiKey;
		}
	}

	// 2. 若仍无 apiKey，回落到 auth.json
	if (!apiKey) {
		const auth = readAuthJson(dir);
		const authEntry = auth[pid];
		if (authEntry && typeof authEntry === "object" && "key" in authEntry) {
			const k = (authEntry as { key?: unknown }).key;
			if (typeof k === "string" && k.trim()) apiKey = k.trim();
		} else if (typeof authEntry === "string" && authEntry.trim()) {
			apiKey = authEntry.trim();
		}
	}

	// 3. 环境变量兜底
	if (!apiKey) {
		const normPid = pid.toLowerCase();
		if (normPid === "anthropic" || normPid.includes("claude")) {
			apiKey = process.env.ANTHROPIC_API_KEY?.trim();
		} else if (normPid === "deepseek") {
			apiKey = process.env.DEEPSEEK_API_KEY?.trim();
		} else if (normPid === "openai") {
			apiKey = process.env.OPENAI_API_KEY?.trim();
		} else if (normPid === "openrouter") {
			apiKey = process.env.OPENROUTER_API_KEY?.trim();
		} else if (normPid === "google" || normPid.includes("gemini")) {
			apiKey = process.env.GEMINI_API_KEY?.trim() ?? process.env.GOOGLE_API_KEY?.trim();
		}
	}

	if (!baseUrl) {
		const normPid = pid.toLowerCase();
		if (normPid === "anthropic" || normPid.includes("claude")) {
			baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
		} else if (normPid === "deepseek") {
			baseUrl = process.env.DEEPSEEK_BASE_URL?.trim();
		} else if (normPid === "openai") {
			baseUrl = process.env.OPENAI_BASE_URL?.trim();
		}
	}

	return {
		providerId: pid,
		baseUrl: baseUrl || undefined,
		apiKey: apiKey || undefined,
		api: api || undefined,
		headers,
	};
}

/**
 * 从 models.json 中列出所有自定义模型。
 * 可选 filter 谓词过滤 API 类型（如只挑 Claude 兼容的）。
 */
export function listCustomModelsFromConfig(
	agentDir?: string,
	filter?: (entry: { providerId: string; api?: string; baseUrl?: string; modelId?: string }) => boolean,
): CustomModelEntry[] {
	const dir = defaultAgentDir(agentDir);
	const { providers } = readModelsJson(dir);
	const results: CustomModelEntry[] = [];

	for (const [providerId, p] of Object.entries(providers)) {
		const api = typeof p.api === "string" ? p.api.trim() : undefined;
		const baseUrl = typeof p.baseUrl === "string" ? p.baseUrl.trim() : undefined;
		const providerName = typeof p.name === "string" ? p.name.trim() : undefined;

		if (Array.isArray(p.models)) {
			for (const m of p.models) {
				if (!m || typeof m !== "object") continue;
				const row = m as Record<string, unknown>;
				const modelId = typeof row.id === "string" ? row.id.trim() : "";
				if (!modelId) continue;

				if (filter && !filter({ providerId, api, baseUrl, modelId })) {
					continue;
				}

				const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : modelId;
				results.push({
					providerId,
					providerName,
					modelId,
					name,
					api,
					baseUrl,
					reasoning: Boolean(row.reasoning),
					vision: Array.isArray(row.input) ? row.input.includes("image") : undefined,
				});
			}
		}
	}

	return results;
}

/**
 * 标准模型通信协议类型定义：
 * - "openai-completions": OpenAI Chat Completions 规范 (/v1/chat/completions)
 * - "openai-responses": OpenAI Responses 规范
 * - "anthropic-messages": Anthropic Messages 规范 (/v1/messages)
 * - "google-generative-ai": Google Gemini 规范
 * - "ollama": Ollama 原生规范
 * - "bedrock": AWS Bedrock 规范
 */
export type KnownModelProtocol =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai"
	| "ollama"
	| "bedrock"
	| string;

/**
 * 依据实际指定的 api 字段（或官方内置 Provider/模型特征）解析真实通信协议类型。
 * 核心原则：优先遵循显式指定的 api 协议；未显式指定时，根据 providerId 与 modelId 特征合理推导默认协议。
 */
export function resolveModelProtocol(api?: string, providerId?: string, modelId?: string): KnownModelProtocol {
	const rawApi = (api ?? "").trim().toLowerCase();
	if (rawApi) {
		if (rawApi === "anthropic-messages" || rawApi === "anthropic") return "anthropic-messages";
		if (rawApi === "openai-completions" || rawApi === "openai") return "openai-completions";
		if (rawApi === "openai-responses") return "openai-responses";
		if (rawApi === "google-generative-ai" || rawApi === "gemini" || rawApi === "google") {
			return "google-generative-ai";
		}
		return rawApi;
	}

	const pid = (providerId ?? "").trim().toLowerCase();
	const mid = (modelId ?? "").trim().toLowerCase();

	// 若未显式配置 api，优先根据 providerId 的命名特征识别协议：
	if (
		pid.includes("openai") ||
		pid.includes("deepseek") ||
		pid.includes("groq") ||
		pid.includes("mistral") ||
		pid.includes("openrouter")
	) {
		return "openai-completions";
	}
	if (pid === "anthropic" || pid.includes("claude") || pid.includes("anthropic")) {
		return "anthropic-messages";
	}
	if (pid === "google" || pid === "gemini") {
		return "google-generative-ai";
	}
	if (pid === "ollama") return "ollama";
	if (pid === "bedrock") return "bedrock";

	// 再次依据 modelId 的前缀特征辅助推导默认协议：
	if (mid.startsWith("claude")) {
		return "anthropic-messages";
	}
	if (mid.startsWith("gemini")) {
		return "google-generative-ai";
	}

	// 其余绝大多数官方及自定义 Provider 均遵循 OpenAI 协议规范
	return "openai-completions";
}

/**
 * 严格按照实际的通信协议类型（Protocol Type）判断目标引擎是否支持。
 * 核心原则：按协议本身做过滤，严禁无依据随意过滤。
 *
 * 1. Pi 原生引擎：支持全部协议全集；
 * 2. DSH 引擎：仅支持 OpenAI 兼容协议（openai-completions / openai-responses），严格拒绝 Anthropic Messages 协议等；
 * 3. Claude Code 引擎：仅支持 Anthropic Messages 协议（无论模型名称叫什么，只要走 Anthropic 协议即可）；
 * 4. Durable 引擎：由 @earendil-works/pi-ai 驱动，支持主流开放标准协议（OpenAI, Anthropic, Google 等）。
 */
export function isProtocolSupportedByEngine(
	engine: string,
	api?: string,
	providerId?: string,
	modelId?: string,
): boolean {
	const normEngine = engine.toLowerCase().trim();
	const protocol = resolveModelProtocol(api, providerId, modelId);

	// 1. Pi 原生引擎支持全协议全集
	if (normEngine === "pi") {
		return true;
	}

	// 2. DSH 引擎：仅支持 OpenAI 兼容协议（openai-completions / openai-responses）
	//    严格不支持 Anthropic Messages 协议、Google Generative AI 协议等！
	if (normEngine === "dsh") {
		return protocol === "openai-completions" || protocol === "openai-responses";
	}

	// 3. Claude Code 引擎：仅支持 Anthropic Messages 协议
	if (normEngine === "claude") {
		return protocol === "anthropic-messages";
	}

	// 4. Durable 引擎：基于 @earendil-works/pi-ai，支持主流标准协议
	if (normEngine === "durable") {
		return (
			protocol === "openai-completions" ||
			protocol === "openai-responses" ||
			protocol === "anthropic-messages" ||
			protocol === "google-generative-ai"
		);
	}

	return true;
}

/**
 * 结构化入参的协议校验重载包装（兼容既有调用点）。
 */
export function isModelProtocolSupportedByEngine(
	engine: string,
	meta: {
		api?: string;
		providerId: string;
		modelId?: string;
	},
): boolean {
	return isProtocolSupportedByEngine(engine, meta.api, meta.providerId, meta.modelId);
}
