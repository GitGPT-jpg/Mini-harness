/**
 * 首次配置弹窗的 models.json 判定：只有目录、没有凭据的服务商（setup.sh 种入的 oneapi）
 * 不算「已配置」，否则新装机器永远不弹「填 API Key」。
 */
import { describe, expect, it } from "vitest";
import { modelsConfigHasCredentials } from "../../server/pi-setup-state.js";

describe("modelsConfigHasCredentials", () => {
	it("种入的 oneapi（baseUrl + 模型目录，无 apiKey）不算配置好", () => {
		expect(
			modelsConfigHasCredentials({
				providers: { oneapi: { baseUrl: "https://oneapi-comate.baidu-int.com/v1", models: [{ id: "glm-4.6" }] } },
			}),
		).toBe(false);
	});

	it("内联非空 apiKey 的服务商算配置好", () => {
		expect(modelsConfigHasCredentials({ providers: { local: { apiKey: "sk-x", models: [] } } })).toBe(true);
		expect(modelsConfigHasCredentials({ providers: { a: { apiKey: "  " }, b: { apiKey: "k" } } })).toBe(true);
	});

	it("空 / 畸形配置不算", () => {
		expect(modelsConfigHasCredentials(null)).toBe(false);
		expect(modelsConfigHasCredentials({})).toBe(false);
		expect(modelsConfigHasCredentials({ providers: [] })).toBe(false);
		expect(modelsConfigHasCredentials({ providers: { x: null, y: { apiKey: "" } } })).toBe(false);
	});
});
