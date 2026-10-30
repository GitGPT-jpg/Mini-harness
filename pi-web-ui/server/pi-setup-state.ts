/**
 * 「pi 是否已配置好」里 models.json 那一路的判定（首次配置弹窗据此决定弹不弹）。
 *
 * 只算**自带凭据**的服务商（内联非空 apiKey）。只声明了 baseUrl / 模型目录、密钥要用户
 * 自己填进 auth.json 的服务商（例如 setup.sh 种入的 Baidu One API）不算配置好 —— 否则
 * 新装的机器上首次配置弹窗永远不出现，用户第一句话就撞鉴权错误。
 */
export function modelsConfigHasCredentials(conf: unknown): boolean {
	const providers = (conf as { providers?: unknown } | null)?.providers;
	if (!providers || typeof providers !== "object") return false;
	return Object.values(providers as Record<string, unknown>).some((p) => {
		const key = (p as { apiKey?: unknown } | null)?.apiKey;
		return typeof key === "string" && key.trim().length > 0;
	});
}
