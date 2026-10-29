import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelAdminService, type ModelAdminHost } from "../../server/model-admin.js";
import type { ServerMessage } from "../../server/protocol.js";

let agentDir = "";

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-web-ui-oauth-"));
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

function makeHost(runtime: ModelRuntime) {
	const messages: ServerMessage[] = [];
	const host = {
		agentDir,
		emit: (message: ServerMessage) => messages.push(message),
		flushSnapshot: () => {},
		isDisposed: () => false,
		modelRuntime: () => runtime,
		invalidatePiConfig: () => {},
		pushModels: async () => {},
	} satisfies ModelAdminHost;
	return { host, messages };
}

describe("ModelAdminService OAuth provider capabilities", () => {
	it("向 Web 客户端标明 openai-codex 仅支持 OAuth", async () => {
		const runtime = {
			getProviders: () => [
				{
					id: "openai-codex",
					name: "OpenAI Codex",
					auth: { oauth: { name: "OpenAI ChatGPT" } },
				},
			],
			getProviderAuthStatus: () => ({ configured: false }),
			isUsingOAuth: () => false,
		} as unknown as ModelRuntime;
		const { host, messages } = makeHost(runtime);

		await new ModelAdminService(host).listProviders();

		expect(messages).toContainEqual({
			type: "providers_status",
			providers: [
				{
					id: "openai-codex",
					name: "OpenAI Codex",
					configured: false,
					source: undefined,
					supportsApiKey: false,
					supportsOAuth: true,
					oauthName: "OpenAI ChatGPT",
					usingOAuth: false,
				},
			],
		});
	});
});

describe("ModelAdminService OAuth interaction bridge", () => {
	it("按流程和提示标识转发交互，且不把 OAuth 凭据发给浏览器", async () => {
		const runtime = {
			getProvider: (providerId: string) =>
				providerId === "openai-codex"
					? { id: providerId, name: "OpenAI Codex", auth: { oauth: { name: "OpenAI ChatGPT" } } }
					: undefined,
			getProviders: () => [{ id: "openai-codex", name: "OpenAI Codex", auth: { oauth: { name: "OpenAI ChatGPT" } } }],
			getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
			isUsingOAuth: () => true,
			login: async (_providerId: string, _type: "oauth", interaction: Parameters<ModelRuntime["login"]>[2]) => {
				const method = await interaction.prompt({
					type: "select",
					message: "Select login method",
					options: [
						{ id: "browser", label: "Browser login" },
						{ id: "device_code", label: "Device code login" },
					],
				});
				if (method !== "device_code") throw new Error("unexpected login method");
				interaction.notify({
					type: "device_code",
					userCode: "ABCD-EFGH",
					verificationUri: "https://example.test/device",
					expiresInSeconds: 900,
				});
				return {
					type: "oauth" as const,
					access: "access-secret",
					refresh: "refresh-secret",
					expires: Date.now() + 3_600_000,
				};
			},
		} as unknown as ModelRuntime;
		const { host, messages } = makeHost(runtime);
		const service = new ModelAdminService(host) as ModelAdminService & {
			startProviderOAuth(providerId: string): string | null;
			replyProviderOAuth(flowId: string, promptId: string, value: string): void;
		};

		expect(service.startProviderOAuth).toBeTypeOf("function");
		const flowId = service.startProviderOAuth("openai-codex");
		expect(flowId).toEqual(expect.any(String));
		await vi.waitFor(() => {
			expect(messages.some((message) => message.type === "provider_oauth_prompt")).toBe(true);
		});
		const promptMessage = messages.find((message) => message.type === "provider_oauth_prompt") as unknown as {
			flowId: string;
			promptId: string;
			prompt: { type: string; options: { id: string }[] };
		};
		expect(promptMessage).toMatchObject({
			flowId,
			prompt: { type: "select", options: [{ id: "browser" }, { id: "device_code" }] },
		});

		service.replyProviderOAuth(flowId!, promptMessage.promptId, "device_code");

		await vi.waitFor(() => {
			expect(messages.some((message) => message.type === "provider_oauth_result")).toBe(true);
		});
		expect(messages).toContainEqual({
			type: "provider_oauth_event",
			flowId,
			provider: "openai-codex",
			event: {
				type: "device_code",
				userCode: "ABCD-EFGH",
				verificationUri: "https://example.test/device",
				expiresInSeconds: 900,
			},
		});
		expect(messages).toContainEqual({
			type: "provider_oauth_result",
			flowId,
			provider: "openai-codex",
			ok: true,
		});
		expect(JSON.stringify(messages)).not.toContain("access-secret");
		expect(JSON.stringify(messages)).not.toContain("refresh-secret");
	});

	it("取消指定流程并把结果标记为 cancelled", async () => {
		const runtime = {
			getProvider: () => ({
				id: "openai-codex",
				name: "OpenAI Codex",
				auth: { oauth: { name: "OpenAI ChatGPT" } },
			}),
			login: async (_providerId: string, _type: "oauth", interaction: Parameters<ModelRuntime["login"]>[2]) => {
				await interaction.prompt({ type: "text", message: "Waiting for input" });
				throw new Error("prompt unexpectedly resolved");
			},
		} as unknown as ModelRuntime;
		const { host, messages } = makeHost(runtime);
		const service = new ModelAdminService(host) as ModelAdminService & {
			startProviderOAuth(providerId: string): string | null;
			cancelProviderOAuth(flowId: string): void;
		};

		const flowId = service.startProviderOAuth("openai-codex");
		await vi.waitFor(() => {
			expect(messages.some((message) => message.type === "provider_oauth_prompt")).toBe(true);
		});
		expect(service.cancelProviderOAuth).toBeTypeOf("function");
		service.cancelProviderOAuth(flowId!);

		await vi.waitFor(() => {
			expect(messages).toContainEqual({
				type: "provider_oauth_result",
				flowId,
				provider: "openai-codex",
				ok: false,
				cancelled: true,
			});
		});
	});

	it("重新连接时重推仍在等待的公开提示状态", async () => {
		const runtime = {
			getProvider: () => ({
				id: "openai-codex",
				name: "OpenAI Codex",
				auth: { oauth: { name: "OpenAI ChatGPT" } },
			}),
			login: async (_providerId: string, _type: "oauth", interaction: Parameters<ModelRuntime["login"]>[2]) => {
				await interaction.prompt({ type: "manual_code", message: "Paste callback", placeholder: "http://localhost" });
				throw new Error("test flow completed");
			},
		} as unknown as ModelRuntime;
		const { host, messages } = makeHost(runtime);
		const service = new ModelAdminService(host) as ModelAdminService & {
			startProviderOAuth(providerId: string): string | null;
			listProviderOAuthFlows(): void;
			cancelProviderOAuth(flowId: string): void;
		};

		const flowId = service.startProviderOAuth("openai-codex");
		await vi.waitFor(() => {
			expect(messages.some((message) => message.type === "provider_oauth_prompt")).toBe(true);
		});
		const prompt = messages.find((message) => message.type === "provider_oauth_prompt") as unknown as {
			promptId: string;
		};
		messages.length = 0;

		expect(service.listProviderOAuthFlows).toBeTypeOf("function");
		service.listProviderOAuthFlows();

		expect(messages).toContainEqual({
			type: "provider_oauth_flows",
			flows: [
				{
					flowId,
					provider: "openai-codex",
					promptId: prompt.promptId,
					prompt: { type: "manual_code", message: "Paste callback", placeholder: "http://localhost" },
				},
			],
		});
		service.cancelProviderOAuth(flowId!);
	});

	it("释放服务时中止等待中的流程且不再发送完成消息", async () => {
		const runtime = {
			getProvider: () => ({
				id: "openai-codex",
				name: "OpenAI Codex",
				auth: { oauth: { name: "OpenAI ChatGPT" } },
			}),
			login: async (_providerId: string, _type: "oauth", interaction: Parameters<ModelRuntime["login"]>[2]) => {
				await interaction.prompt({ type: "text", message: "Waiting for input" });
				throw new Error("prompt unexpectedly resolved");
			},
		} as unknown as ModelRuntime;
		const { host, messages } = makeHost(runtime);
		const service = new ModelAdminService(host) as ModelAdminService & {
			startProviderOAuth(providerId: string): string | null;
			listProviderOAuthFlows(): void;
			dispose(): void;
		};

		service.startProviderOAuth("openai-codex");
		await vi.waitFor(() => {
			expect(messages.some((message) => message.type === "provider_oauth_prompt")).toBe(true);
		});
		messages.length = 0;

		expect(service.dispose).toBeTypeOf("function");
		service.dispose();
		await Promise.resolve();
		service.listProviderOAuthFlows();

		expect(messages).toEqual([{ type: "provider_oauth_flows", flows: [] }]);
	});

	it("释放服务后忽略 SDK 延迟发出的交互提示", async () => {
		const runtime = {
			getProvider: () => ({
				id: "openai-codex",
				name: "OpenAI Codex",
				auth: { oauth: { name: "OpenAI ChatGPT" } },
			}),
			login: async (_providerId: string, _type: "oauth", interaction: Parameters<ModelRuntime["login"]>[2]) => {
				await Promise.resolve();
				await interaction.prompt({ type: "text", message: "Late prompt" });
				throw new Error("prompt unexpectedly resolved");
			},
		} as unknown as ModelRuntime;
		const { host, messages } = makeHost(runtime);
		const service = new ModelAdminService(host);

		service.startProviderOAuth("openai-codex");
		service.dispose();
		messages.length = 0;
		await Promise.resolve();
		await Promise.resolve();

		expect(messages).toEqual([]);
	});

	it("OAuth 登录成功后保留已存密钥但清除活动密钥和项目偏好", async () => {
		writeFileSync(
			join(agentDir, "provider-keys.json"),
			JSON.stringify({
				"openai-codex": {
					activeKeyName: "旧密钥",
					keys: [{ name: "旧密钥", apiKey: "unused-key" }],
				},
			}),
		);
		const runtime = {
			getProvider: () => ({
				id: "openai-codex",
				name: "OpenAI Codex",
				auth: { oauth: { name: "OpenAI ChatGPT" } },
			}),
			getProviders: () => [{ id: "openai-codex", name: "OpenAI Codex", auth: { oauth: { name: "OpenAI ChatGPT" } } }],
			getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
			isUsingOAuth: () => true,
			login: async () => ({
				type: "oauth" as const,
				access: "access-secret",
				refresh: "refresh-secret",
				expires: Date.now() + 3_600_000,
			}),
		} as unknown as ModelRuntime;
		const { host, messages } = makeHost(runtime);
		const onOAuthActivated = vi.fn();
		(host as ModelAdminHost & { onOAuthActivated?: (provider: string) => void }).onOAuthActivated = onOAuthActivated;
		const service = new ModelAdminService(host);

		service.startProviderOAuth("openai-codex");
		await vi.waitFor(() => {
			expect(messages.some((message) => message.type === "provider_oauth_result")).toBe(true);
		});

		const stored = JSON.parse(readFileSync(join(agentDir, "provider-keys.json"), "utf8")) as {
			"openai-codex": { activeKeyName: string | null; keys: { name: string; apiKey: string }[] };
		};
		expect(stored["openai-codex"]).toEqual({
			activeKeyName: null,
			keys: [{ name: "旧密钥", apiKey: "unused-key" }],
		});
		expect(onOAuthActivated).toHaveBeenCalledWith("openai-codex");
	});

	it("通过 SDK logout 登出 OAuth 并重推未登录状态", async () => {
		let usingOAuth = true;
		const provider = {
			id: "openai-codex",
			name: "OpenAI Codex",
			auth: { oauth: { name: "OpenAI ChatGPT" } },
		};
		const runtime = {
			getProvider: () => provider,
			getProviders: () => [provider],
			getProviderAuthStatus: () => ({ configured: usingOAuth, source: usingOAuth ? "stored" : undefined }),
			isUsingOAuth: () => usingOAuth,
			logout: async () => {
				usingOAuth = false;
			},
		} as unknown as ModelRuntime;
		const { host, messages } = makeHost(runtime);
		const service = new ModelAdminService(host) as ModelAdminService & {
			logoutProviderOAuth(providerId: string): Promise<void>;
		};

		expect(service.logoutProviderOAuth).toBeTypeOf("function");
		await service.logoutProviderOAuth("openai-codex");

		expect(messages).toContainEqual({ type: "provider_oauth_logout_result", provider: "openai-codex", ok: true });
		expect(messages).toContainEqual({
			type: "providers_status",
			providers: [
				{
					id: "openai-codex",
					name: "OpenAI Codex",
					configured: false,
					source: undefined,
					supportsApiKey: false,
					supportsOAuth: true,
					oauthName: "OpenAI ChatGPT",
					usingOAuth: false,
				},
			],
		});
	});

	it("清除 API Key 不得删除当前 OAuth 凭据", async () => {
		const credential = {
			type: "oauth",
			access: "access-secret",
			refresh: "refresh-secret",
			expires: 4_102_444_800_000,
		};
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": credential }));
		const runtime = {
			isUsingOAuth: () => true,
			removeRuntimeApiKey: async () => {},
			refresh: async () => {},
		} as unknown as ModelRuntime;
		const { host } = makeHost(runtime);

		await new ModelAdminService(host).clearProviderApiKey("openai-codex");

		const stored = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
		expect(stored["openai-codex"]).toEqual(credential);
	});
});
