/**
 * Harness 自主环境变量桥（D-12c 方向一：去 pi-web-ui 化与全自主能力）。
 *
 * 优先级：显式 HARNESS_* > 兼容 PI_WEB_*。
 * 进程启动时调用 syncHarnessEnv()，将所有已设置的 HARNESS_* 同步回填到未设置的 PI_WEB_*，
 * 使底层所有模块（端口、工作区、数据目录、Token、SDK 选择、超时、工具懒加载等）
 * 无缝支持 HARNESS_* 命名空间，同时 100% 保持存量脚本与测试的向后兼容。
 */

export const HARNESS_ENV_PAIRS: ReadonlyArray<readonly [harnessKey: string, legacyKey: string]> = [
	["HARNESS_PORT", "PI_WEB_PORT"],
	["HARNESS_HOST", "PI_WEB_HOST"],
	["HARNESS_CWD", "PI_WEB_CWD"],
	["HARNESS_DATA_DIR", "PI_WEB_DATA_DIR"],
	["HARNESS_ENGINE", "PI_WEB_ENGINE"],
	["HARNESS_TOKEN", "PI_WEB_TOKEN"],
	["HARNESS_SDK", "PI_WEB_SDK"],
	["HARNESS_SDK_DIR", "PI_WEB_SDK_DIR"],
	["HARNESS_AGENT_DIR", "PI_CODING_AGENT_DIR"],
	["HARNESS_ALLOW_HOSTS", "PI_WEB_ALLOW_HOSTS"],
	["HARNESS_ALLOW_ORIGINS", "PI_WEB_ALLOW_ORIGINS"],
	["HARNESS_HISTORY_WINDOW", "PI_WEB_HISTORY_WINDOW"],
	["HARNESS_TOOL_TIMEOUT_MS", "PI_WEB_TOOL_TIMEOUT_MS"],
	["HARNESS_TOOL_LAZY_LOADING", "PI_WEB_TOOL_LAZY_LOADING"],
	["HARNESS_SHELL", "PI_WEB_SHELL"],
	["HARNESS_DEV_CACHE", "PI_WEB_DEV_CACHE"],
	["HARNESS_MAX_SUBAGENTS", "PI_WEB_MAX_SUBAGENTS"],
	["HARNESS_MAX_OPEN_CONVERSATIONS", "PI_WEB_MAX_OPEN_CONVERSATIONS"],
];

/**
 * 读取配置项：优先读 HARNESS_<suffix>，回落到 PI_WEB_<suffix>。
 */
export function readHarnessEnv(
	suffix: string,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	const h = env[`HARNESS_${suffix}`];
	if (h !== undefined && h !== "") return h;
	return env[`PI_WEB_${suffix}`];
}

/**
 * 将 env 中的 HARNESS_* 同步镜像到对应的 PI_WEB_*（当 HARNESS_* 非空时以 HARNESS_* 为准）。
 * 返回本次被 HARNESS_* 激活的键列表（供诊断/测试断言）。
 */
export function syncHarnessEnv(env: Record<string, string | undefined> = process.env): string[] {
	const synced: string[] = [];
	for (const [hKey, pKey] of HARNESS_ENV_PAIRS) {
		const hv = env[hKey];
		if (hv !== undefined && hv !== "") {
			env[pKey] = hv;
			synced.push(hKey);
		}
	}
	return synced;
}
