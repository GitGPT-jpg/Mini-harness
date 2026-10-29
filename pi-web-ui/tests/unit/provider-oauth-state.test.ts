import { describe, expect, it } from "vitest";
import { initialProviderOAuthState, reduceProviderOAuthState } from "../../web/src/provider-oauth-state.js";

describe("provider OAuth client state", () => {
	it("按开始、提示、事件和完成消息推进同一登录流程", () => {
		let state = initialProviderOAuthState();
		state = reduceProviderOAuthState(state, {
			type: "provider_oauth_started",
			flowId: "flow-1",
			provider: "openai-codex",
		});
		state = reduceProviderOAuthState(state, {
			type: "provider_oauth_prompt",
			flowId: "flow-1",
			provider: "openai-codex",
			promptId: "prompt-1",
			prompt: {
				type: "select",
				message: "Select login method",
				options: [{ id: "device_code", label: "Device code" }],
			},
		});
		expect(state.flows[0]).toMatchObject({ flowId: "flow-1", promptId: "prompt-1" });

		state = reduceProviderOAuthState(state, {
			type: "provider_oauth_event",
			flowId: "flow-1",
			provider: "openai-codex",
			event: { type: "device_code", userCode: "ABCD", verificationUri: "https://example.test" },
		});
		expect(state.flows[0]).toEqual({
			flowId: "flow-1",
			provider: "openai-codex",
			event: { type: "device_code", userCode: "ABCD", verificationUri: "https://example.test" },
		});

		state = reduceProviderOAuthState(state, {
			type: "provider_oauth_result",
			flowId: "flow-1",
			provider: "openai-codex",
			ok: false,
			error: "login failed",
		});
		expect(state.flows).toEqual([]);
		expect(state.results["openai-codex"]).toEqual({ ok: false, error: "login failed" });
	});

	it("用服务端快照恢复仍在运行的流程", () => {
		const state = reduceProviderOAuthState(initialProviderOAuthState(), {
			type: "provider_oauth_flows",
			flows: [{ flowId: "flow-2", provider: "openai-codex", event: { type: "progress", message: "Waiting" } }],
		});

		expect(state.flows).toEqual([
			{ flowId: "flow-2", provider: "openai-codex", event: { type: "progress", message: "Waiting" } },
		]);
	});
});
