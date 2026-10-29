// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { setAppSend } from "../../web/src/app-globals.js";
import { ModelConfigModal } from "../../web/src/components/ModelConfigModal.js";
import { PiSetupModal } from "../../web/src/components/PiSetupModal.js";
import { LanguageProvider } from "../../web/src/i18n.js";

let root: Root | null = null;

type ModalProps = Parameters<typeof ModelConfigModal>[0];

function mount(overrides: Partial<ModalProps> = {}) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const sent: unknown[] = [];
	setAppSend((message) => {
		sent.push(message);
		return true;
	});
	root = createRoot(container);
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(ModelConfigModal, {
					providers: [],
					providerStatus: [
						{
							id: "openai-codex",
							name: "OpenAI Codex",
							configured: false,
							supportsApiKey: false,
							supportsOAuth: true,
							oauthName: "OpenAI ChatGPT",
							usingOAuth: false,
						},
					],
					providerKeys: {},
					providerOAuthFlows: [],
					providerOAuthResults: {},
					onClose: () => {},
					...overrides,
				}),
			),
		);
	});
	return { container, sent };
}

afterEach(() => {
	setAppSend(null);
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	document.body.innerHTML = "";
});

describe("ModelConfigModal OAuth provider", () => {
	it("仅 OAuth 的服务商隐藏密钥表单并提供登录按钮", () => {
		const { container, sent } = mount();

		expect(container.querySelector('input[type="password"]')).toBeNull();
		const login = container.querySelector('[data-provider-oauth-login="openai-codex"]') as HTMLButtonElement | null;
		expect(login).not.toBeNull();
		act(() => login!.click());
		expect(sent).toContainEqual({ type: "provider_oauth_start", provider: "openai-codex" });
	});

	it("把登录方式选择与流程标识一并回复服务端", () => {
		const { container, sent } = mount({
			providerOAuthFlows: [
				{
					flowId: "flow-1",
					provider: "openai-codex",
					promptId: "prompt-1",
					prompt: {
						type: "select",
						message: "Select login method",
						options: [
							{ id: "browser", label: "Browser login" },
							{ id: "device_code", label: "Device code login" },
						],
					},
				},
			],
		});

		const option = container.querySelector('[data-oauth-option="device_code"]') as HTMLButtonElement | null;
		expect(option).not.toBeNull();
		act(() => option!.click());
		expect(sent).toContainEqual({
			type: "provider_oauth_reply",
			flowId: "flow-1",
			promptId: "prompt-1",
			value: "device_code",
		});
	});

	it("展示设备验证码和验证地址，并允许取消当前流程", () => {
		const { container, sent } = mount({
			providerOAuthFlows: [
				{
					flowId: "flow-2",
					provider: "openai-codex",
					event: {
						type: "device_code",
						userCode: "ABCD-EFGH",
						verificationUri: "https://example.test/device",
						expiresInSeconds: 900,
					},
				},
			],
		});

		expect(container.querySelector("[data-oauth-device-code]")?.textContent).toContain("ABCD-EFGH");
		expect((container.querySelector("[data-oauth-verification-url]") as HTMLAnchorElement | null)?.href).toBe(
			"https://example.test/device",
		);
		const cancel = container.querySelector('[data-oauth-cancel="flow-2"]') as HTMLButtonElement | null;
		expect(cancel).not.toBeNull();
		act(() => cancel!.click());
		expect(sent).toContainEqual({ type: "provider_oauth_cancel", flowId: "flow-2" });
	});

	it("提交手动回调地址时保留流程和提示标识", () => {
		const { container, sent } = mount({
			providerOAuthFlows: [
				{
					flowId: "flow-3",
					provider: "openai-codex",
					promptId: "prompt-3",
					prompt: {
						type: "manual_code",
						message: "Paste the callback URL",
						placeholder: "http://localhost/callback",
					},
				},
			],
		});

		const input = container.querySelector("[data-oauth-prompt-input]") as HTMLInputElement | null;
		expect(input?.placeholder).toBe("http://localhost/callback");
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
				input,
				"http://localhost/callback?code=ok",
			);
			input!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const submit = container.querySelector("[data-oauth-prompt-submit]") as HTMLButtonElement | null;
		expect(submit).not.toBeNull();
		act(() => submit!.click());
		expect(sent).toContainEqual({
			type: "provider_oauth_reply",
			flowId: "flow-3",
			promptId: "prompt-3",
			value: "http://localhost/callback?code=ok",
		});
	});

	it("OAuth 登出失败时保留登录状态并显示错误", () => {
		const { container } = mount({
			providerStatus: [
				{
					id: "openai-codex",
					name: "OpenAI Codex",
					configured: true,
					source: "stored",
					supportsApiKey: false,
					supportsOAuth: true,
					oauthName: "OpenAI ChatGPT",
					usingOAuth: true,
				},
			],
			providerOAuthResults: { "openai-codex": { ok: false, error: "logout failed" } },
		});

		expect(container.querySelector(".provider-oauth-error")?.textContent).toBe("logout failed");
		expect(container.querySelector('[data-provider-oauth-logout="openai-codex"]')).not.toBeNull();
	});
});

describe("PiSetupModal OAuth provider", () => {
	it("首次设置选择 Codex 时显示 ChatGPT 登录而非密钥输入", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const sent: unknown[] = [];
		setAppSend((message) => {
			sent.push(message);
			return true;
		});
		root = createRoot(container);
		act(() => {
			root!.render(
				createElement(
					LanguageProvider,
					null,
					createElement(PiSetupModal, {
						piConfigured: false,
						piAgentInstalled: true,
						providers: [
							{
								id: "openai-codex",
								name: "OpenAI Codex",
								configured: false,
								supportsApiKey: false,
								supportsOAuth: true,
								oauthName: "OpenAI ChatGPT",
								usingOAuth: false,
							},
						],
						providerOAuthFlows: [],
						providerOAuthResults: {},
						installResult: null,
						onClose: () => {},
					}),
				),
			);
		});

		expect(container.querySelector('input[type="password"]')).toBeNull();
		const login = container.querySelector('[data-provider-oauth-login="openai-codex"]') as HTMLButtonElement | null;
		expect(login).not.toBeNull();
		act(() => login!.click());
		expect(sent).toContainEqual({ type: "provider_oauth_start", provider: "openai-codex" });
	});
});
