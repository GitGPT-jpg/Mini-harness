/**
 * durable-models.ts — Pi Durable 引擎的全局模型继承与提供商装配器。
 *
 * 职责：
 * 1. 继承全局模型事实源：从 SDK ModelRuntime 与 models.json 聚合全量可用模型；
 * 2. 装配 @earendil-works/pi-ai 的 models 容器，注入内置与自定义 Providers（带 API Key 与 BaseURL）；
 * 3. 解析用户选择的 activeModel，传递给 Durable Conversation 运行时。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	listCustomModelsFromConfig,
	readModelsJson,
	resolveProviderCredential,
	isProtocolSupportedByEngine,
} from "../model-resolver.js";
import { loadDurablePeerModule } from "./durable-loader.js";

export interface DurableModelInfo {
	id: string;
	name: string;
	provider: string;
	vision?: boolean;
	reasoning?: boolean;
}

/**
 * 聚合全局所有已鉴权、可用的模型名录（包括官方内置模型与用户自定义模型）。
 * 优先收录并前置展示 models.json 中的用户自定义服务商与模型。
 */
export async function listGlobalAvailableModels(cwd: string, agentDir?: string): Promise<DurableModelInfo[]> {
	const modelMap = new Map<string, DurableModelInfo>();

	// 1. 优先收录 models.json 中的用户自定义模型（本地代理/自定义端点通常为首选活动端点）
	try {
		const customModels = listCustomModelsFromConfig(agentDir, (entry) =>
			isProtocolSupportedByEngine("durable", entry.api, entry.providerId, entry.modelId),
		);
		for (const cm of customModels) {
			const fullId = `${cm.providerId}/${cm.modelId}`;
			if (!modelMap.has(fullId)) {
				modelMap.set(fullId, {
					id: fullId,
					name: cm.name || cm.modelId,
					provider: cm.providerId,
					vision: cm.vision ?? false,
					reasoning: cm.reasoning ?? false,
				});
			}
		}
	} catch {
		/* ignore */
	}

	// 2. 补充 SDK ModelRuntime 动态获取的官方与外部模型
	try {
		const piSdk = await import(/* webpackIgnore: true */ "@earendil-works/pi-coding-agent" as string).catch(() => null);

		if (piSdk && typeof piSdk.createAgentSessionServices === "function") {
			const services = await piSdk.createAgentSessionServices({ cwd, agentDir });
			const available = await services.modelRuntime.getAvailable();
			for (const m of available) {
				// 严格按照实际协议类型进行过滤（绝不按模型名字猜测）
				if (!isProtocolSupportedByEngine("durable", m.api, m.provider, m.id)) {
					continue;
				}
				const fullId = `${m.provider}/${m.id}`;
				if (!modelMap.has(fullId)) {
					modelMap.set(fullId, {
						id: fullId,
						name: (m.name || m.id).replace(/\s*\(new\)$/i, "").trim(),
						provider: m.provider,
						vision: m.input?.includes("image") ?? false,
						reasoning: m.reasoning,
					});
				}
			}
		}
	} catch {
		/* SDK model runtime load failed, fall back to models.json */
	}

	return Array.from(modelMap.values());
}

/**
 * 为 Pi Durable Harness 装配并初始化全局模型服务（@earendil-works/pi-ai Models 实例）。
 */
export async function setupDurableModels(agentDir?: string): Promise<any> {
	const aiModule = await loadDurablePeerModule("@earendil-works/pi-ai", "models").catch(() => null);

	if (!aiModule || typeof aiModule.createModels !== "function") {
		return {};
	}

	const models = aiModule.createModels();

	// 1. 尝试全量装载内置提供商（providers/all 包含 opencode-go、openrouter 等 42+ 个提供商）
	try {
		const allProvidersModule = await loadDurablePeerModule("@earendil-works/pi-ai", "providers/all").catch(() => null);
		if (allProvidersModule && typeof allProvidersModule.builtinProviders === "function") {
			const builtins = allProvidersModule.builtinProviders();
			for (const p of builtins) {
				if (typeof models.setProvider === "function") {
					models.setProvider(p);
				}
			}
		}
	} catch {
		/* ignore fallback to minimal builtins */
	}

	// 2. 兜底保障基础内置提供商
	const fallbackBuiltinIds = ["openai", "anthropic", "google", "mistral", "groq", "deepseek"];
	for (const pid of fallbackBuiltinIds) {
		if (models.providers && models.providers.has(pid)) continue;
		try {
			const providerModule = await loadDurablePeerModule("@earendil-works/pi-ai", `providers/${pid}`).catch(() => null);
			const providerFactory = providerModule?.[`${pid}Provider`] || providerModule?.default;
			if (typeof providerFactory === "function") {
				const instance = providerFactory();
				if (typeof models.setProvider === "function") {
					models.setProvider(instance);
				}
			}
		} catch {
			/* provider loading skipped */
		}
	}

	// 3. 动态加载 models.json 中的自定义服务商与模型
	try {
		const { providers: customProviders } = readModelsJson(agentDir);
		const oCompModule = await loadDurablePeerModule("@earendil-works/pi-ai", "api/openai-completions.lazy").catch(
			() => null,
		);
		const oRespModule = await loadDurablePeerModule("@earendil-works/pi-ai", "api/openai-responses.lazy").catch(
			() => null,
		);
		const aMsgModule = await loadDurablePeerModule("@earendil-works/pi-ai", "api/anthropic-messages.lazy").catch(
			() => null,
		);

		for (const [providerId, pConfig] of Object.entries(customProviders)) {
			if (!pConfig || typeof pConfig !== "object") continue;
			const cred = resolveProviderCredential(agentDir, providerId);
			const apiProtocol = (typeof (pConfig as any).api === "string" ? (pConfig as any).api : "").toLowerCase();

			let apiImpl: any = null;
			if (apiProtocol === "anthropic-messages" && aMsgModule?.anthropicMessagesApi) {
				apiImpl = aMsgModule.anthropicMessagesApi();
			} else if (apiProtocol === "openai-responses" && oRespModule?.openAIResponsesApi) {
				apiImpl = oRespModule.openAIResponsesApi();
			} else if (oCompModule?.openAICompletionsApi) {
				apiImpl = oCompModule.openAICompletionsApi();
			}

			if (apiImpl && typeof aiModule.createProvider === "function") {
				const rawModels = Array.isArray((pConfig as any).models) ? (pConfig as any).models : [];
				const customProvider = aiModule.createProvider({
					id: providerId,
					name: (pConfig as any).name || providerId,
					baseUrl: cred.baseUrl,
					headers: cred.headers,
					auth: {
						apiKey: {
							name: `${providerId} API key`,
							login: async () => ({ type: "api_key", key: cred.apiKey || "" }),
							resolve: async () => (cred.apiKey ? { auth: { apiKey: cred.apiKey }, source: "config" } : undefined),
						},
					},
					models: rawModels.map((m: any) => ({
						...m,
						provider: providerId,
						api: m.api || (pConfig as any).api || "openai-completions",
						baseUrl: cred.baseUrl,
						cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						type: "chat",
					})),
					api: apiImpl,
				});

				models.setProvider(customProvider);
			}
		}
	} catch {
		/* custom provider setup skipped */
	}

	// 4. 继承持久化动态模型缓存 (~/.pi/agent/models-store.json)
	try {
		const userAgentDir = agentDir || join(homedir(), ".pi", "agent");
		const storePath = join(userAgentDir, "models-store.json");
		if (existsSync(storePath)) {
			const store = JSON.parse(readFileSync(storePath, "utf8"));
			for (const [providerId, pData] of Object.entries(store)) {
				const p = typeof models.getProvider === "function" ? models.getProvider(providerId) : undefined;
				if (p && Array.isArray((pData as any)?.models)) {
					const extraModels: any[] = (pData as any).models;
					const origGetModels = typeof p.getModels === "function" ? p.getModels.bind(p) : null;
					const origGetAllModels = typeof p.getAllModels === "function" ? p.getAllModels.bind(p) : null;

					if (origGetModels) {
						p.getModels = () => {
							const list = origGetModels();
							const ids = new Set(list.map((m: any) => m.id));
							const added = extraModels
								.filter((m: any) => !ids.has(m.id))
								.map((m: any) => ({
									...m,
									cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								}));
							return [...list, ...added];
						};
					}
					if (origGetAllModels) {
						p.getAllModels = () => {
							const list = origGetAllModels();
							const ids = new Set(list.map((m: any) => m.id));
							const added = extraModels
								.filter((m: any) => !ids.has(m.id))
								.map((m: any) => ({
									...m,
									cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								}));
							return [...list, ...added];
						};
					}
				}
			}
		}
	} catch {
		/* dynamic models store read skipped */
	}

	// 5. 为所有已注册 Provider 注入凭证与 BaseURL
	try {
		if (models.providers && typeof models.providers.keys === "function") {
			for (const providerId of models.providers.keys()) {
				const cred = resolveProviderCredential(agentDir, providerId);
				if (cred.apiKey && models.credentials && typeof models.credentials.modify === "function") {
					await models.credentials
						.modify(providerId, async () => ({
							type: "api_key",
							key: cred.apiKey,
						}))
						.catch(() => {});
				}
				if (cred.baseUrl) {
					const p = models.getProvider(providerId);
					if (p) p.baseUrl = cred.baseUrl;
				}
				if (cred.headers) {
					const p = models.getProvider(providerId);
					if (p) p.headers = { ...p.headers, ...cred.headers };
				}
			}
		}
	} catch {
		/* credential hydration skipped */
	}

	return models;
}

/**
 * 将形如 "openai/gpt-4o" 或 "gpt-4o" 的模型标识解析为 Durable 引擎可识别的 provider 与 modelId。
 */
export function resolveDurableModelChoice(
	modelId?: string,
	fallbackList?: DurableModelInfo[],
	agentDir?: string,
): { provider: string; modelId: string } | undefined {
	if (!modelId || !modelId.trim() || modelId === "default") {
		if (fallbackList && fallbackList.length > 0) {
			// 1. 优先在 fallbackList 中寻找用户在 models.json 里明确配置的自定义端点模型
			const { providers: customConfig } = readModelsJson(agentDir);
			const customFirst = fallbackList.find((m) => Object.prototype.hasOwnProperty.call(customConfig, m.provider));
			if (customFirst) {
				return { provider: customFirst.provider, modelId: customFirst.id.replace(`${customFirst.provider}/`, "") };
			}

			// 2. 其次寻找具备有效 baseUrl 或独立 apiKey 的可用模型
			const configured = fallbackList.find((m) => {
				const cred = resolveProviderCredential(agentDir, m.provider);
				return Boolean(cred.baseUrl || cred.apiKey);
			});
			const chosen = configured ?? fallbackList[0];
			return { provider: chosen.provider, modelId: chosen.id.replace(`${chosen.provider}/`, "") };
		}
		return undefined;
	}

	const trimmed = modelId.trim();
	if (trimmed.includes("/")) {
		const slashIdx = trimmed.indexOf("/");
		return {
			provider: trimmed.slice(0, slashIdx),
			modelId: trimmed.slice(slashIdx + 1),
		};
	}

	// 若未带 provider 前缀，尝试在已知列表中寻找匹配项
	if (fallbackList) {
		const found = fallbackList.find((m) => m.id === trimmed || m.id.endsWith(`/${trimmed}`));
		if (found) {
			return {
				provider: found.provider,
				modelId: found.id.replace(`${found.provider}/`, ""),
			};
		}
	}

	return {
		provider: "openai",
		modelId: trimmed,
	};
}
