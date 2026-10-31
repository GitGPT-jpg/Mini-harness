#!/usr/bin/env node
/**
 * harness / mini-harness CLI — 训推引擎组 Harness 独立命令行入口（D-12c 方向一）。
 *
 * 支持全套 HARNESS_* 环境变量（HARNESS_PORT / HARNESS_CWD / HARNESS_DATA_DIR /
 * HARNESS_HOST / HARNESS_TOKEN / HARNESS_SDK / HARNESS_AGENT_DIR 等），
 * 自动桥接并复用 CLI 主入口。
 */
const PAIRS = [
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
];
for (const [hKey, pKey] of PAIRS) {
	if (process.env[hKey] !== undefined && process.env[hKey] !== "") {
		process.env[pKey] = process.env[hKey];
	}
}
await import("./pi-web-ui.mjs");
