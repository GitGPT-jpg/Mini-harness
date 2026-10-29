import { describe, expect, it } from "vitest";
import {
	resolveModelProtocol,
	isProtocolSupportedByEngine,
	isModelProtocolSupportedByEngine,
} from "../../server/model-resolver.js";

describe("多引擎实际协议类型（Protocol-Based）针对性过滤规范", () => {
	it("resolveModelProtocol 准确解析实际协议，绝不依据名字猜测", () => {
		// 显式指定 api 协议
		expect(resolveModelProtocol("openai-completions")).toBe("openai-completions");
		expect(resolveModelProtocol("openai-responses")).toBe("openai-responses");
		expect(resolveModelProtocol("anthropic-messages")).toBe("anthropic-messages");
		expect(resolveModelProtocol("google-generative-ai")).toBe("google-generative-ai");

		// 缺省 api 时依据内置 Provider 原生出厂协议推断
		expect(resolveModelProtocol(undefined, "anthropic")).toBe("anthropic-messages");
		expect(resolveModelProtocol(undefined, "google")).toBe("google-generative-ai");
		expect(resolveModelProtocol(undefined, "deepseek")).toBe("openai-completions");
		expect(resolveModelProtocol(undefined, "openai")).toBe("openai-completions");
		expect(resolveModelProtocol(undefined, "custom-provider")).toBe("openai-completions");
	});

	it("DSH 引擎：按实际协议过滤（放行 OpenAI 兼容协议，严打 Anthropic 协议）", () => {
		// 1. 核心关键用例：名字叫 claude-3-7-sonnet，但协议是 openai-completions（网关转接）
		//    由于 DSH 只认 OpenAI 协议，这必须被允许放行！证明绝非粗暴匹配 claude 关键字。
		expect(isProtocolSupportedByEngine("dsh", "openai-completions", "my-gateway")).toBe(true);
		expect(
			isModelProtocolSupportedByEngine("dsh", {
				api: "openai-completions",
				providerId: "oneapi-proxy",
				modelId: "claude-3-7-sonnet",
			}),
		).toBe(true);

		// 2. 核心关键用例：名字叫 deepseek-chat，但协议是 anthropic-messages（Anthropic 格式网关）
		//    DSH 根本无法处理 Anthropic 请求体，必须坚决拦截！证明绝非只看 deepseek 名字就放行。
		expect(isProtocolSupportedByEngine("dsh", "anthropic-messages", "deepseek-anthropic-gw")).toBe(false);
		expect(
			isModelProtocolSupportedByEngine("dsh", {
				api: "anthropic-messages",
				providerId: "deepseek-proxy",
				modelId: "deepseek-chat",
			}),
		).toBe(false);

		// 3. 原生 Anthropic 官方 Provider（缺省 api 但协议为 anthropic-messages）必须拦截
		expect(isProtocolSupportedByEngine("dsh", undefined, "anthropic")).toBe(false);

		// 4. 原生 Google Generative AI 协议必须拦截
		expect(isProtocolSupportedByEngine("dsh", "google-generative-ai", "google")).toBe(false);
		expect(isProtocolSupportedByEngine("dsh", undefined, "google")).toBe(false);

		// 5. OpenAI Completions / Responses 协议必须放行
		expect(isProtocolSupportedByEngine("dsh", "openai-completions", "deepseek")).toBe(true);
		expect(isProtocolSupportedByEngine("dsh", "openai-responses", "openai")).toBe(true);
		expect(isProtocolSupportedByEngine("dsh", undefined, "deepseek")).toBe(true);
	});

	it("Claude Code 引擎：严格只认 Anthropic Messages 协议", () => {
		// 1. 名字叫 llama-3 或 deepseek，只要协议是 anthropic-messages（Claude 兼容代理），即可使用
		expect(isProtocolSupportedByEngine("claude", "anthropic-messages", "local-proxy")).toBe(true);
		expect(
			isModelProtocolSupportedByEngine("claude", {
				api: "anthropic-messages",
				providerId: "custom-proxy",
				modelId: "deepseek-r1-via-claude-api",
			}),
		).toBe(true);

		// 2. 名字叫 claude-3-5-sonnet，但协议是 openai-completions，Claude Code 驱动无法处理，必须拦截！
		expect(isProtocolSupportedByEngine("claude", "openai-completions", "oneapi")).toBe(false);
		expect(
			isModelProtocolSupportedByEngine("claude", {
				api: "openai-completions",
				providerId: "oneapi",
				modelId: "claude-3-5-sonnet",
			}),
		).toBe(false);

		// 3. 官方 Anthropic Provider 正常放行
		expect(isProtocolSupportedByEngine("claude", undefined, "anthropic")).toBe(true);
	});

	it("Pi Durable 引擎与 Pi 原生引擎支持主流标准协议全集", () => {
		// Pi 原生引擎全协议放行
		expect(isProtocolSupportedByEngine("pi", "openai-completions")).toBe(true);
		expect(isProtocolSupportedByEngine("pi", "anthropic-messages")).toBe(true);
		expect(isProtocolSupportedByEngine("pi", "google-generative-ai")).toBe(true);

		// Durable 引擎放行 pi-ai 支持的标准主流协议
		expect(isProtocolSupportedByEngine("durable", "openai-completions")).toBe(true);
		expect(isProtocolSupportedByEngine("durable", "openai-responses")).toBe(true);
		expect(isProtocolSupportedByEngine("durable", "anthropic-messages")).toBe(true);
		expect(isProtocolSupportedByEngine("durable", "google-generative-ai")).toBe(true);
	});
});
