/**
 * server/http-proxy.ts
 *
 * Propagates HTTP proxy settings from ~/.pi/agent/settings.json and environment
 * variables (HTTP_PROXY / HTTPS_PROXY / ALL_PROXY) to process.env and sets up
 * undici's global dispatcher with EnvHttpProxyAgent, ensuring that Node's
 * native fetch() and SDK HTTP calls route through the configured proxy.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type * as UndiciType from "undici";

export interface ProxyConfig {
	httpProxy?: string;
	envHttpProxy?: string;
	envHttpsProxy?: string;
	envAllProxy?: string;
}

/** Read proxy settings from settings.json and environment. */
export function resolveProxySettings(agentDir: string): ProxyConfig {
	let httpProxy: string | undefined;
	const settingsPath = join(agentDir, "settings.json");
	if (existsSync(settingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as { httpProxy?: unknown };
			if (typeof parsed.httpProxy === "string" && parsed.httpProxy.trim()) {
				httpProxy = parsed.httpProxy.trim();
			}
		} catch {
			/* ignore parse error */
		}
	}

	return {
		httpProxy,
		envHttpProxy: process.env.HTTP_PROXY,
		envHttpsProxy: process.env.HTTPS_PROXY,
		envAllProxy: process.env.ALL_PROXY,
	};
}

/**
 * Initialize HTTP proxy support:
 * 1. If httpProxy is present in settings.json and env is not set, populate HTTP_PROXY and HTTPS_PROXY.
 * 2. If any proxy is configured (settings or env), set up undici's global dispatcher with EnvHttpProxyAgent
 *    so that global fetch() uses the proxy.
 */
export function initHttpProxy(agentDir: string): { active: boolean; proxyUrl?: string } {
	const config = resolveProxySettings(agentDir);

	if (config.httpProxy) {
		process.env.HTTP_PROXY ??= config.httpProxy;
		process.env.HTTPS_PROXY ??= config.httpProxy;
	}

	const effectiveProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
	if (!effectiveProxy) {
		return { active: false };
	}

	try {
		// Lazy-load undici so a missing optional dep never crashes server startup;
		// proxy simply stays inactive with a warning.
		let undici: typeof UndiciType;
		try {
			undici = createRequire(import.meta.url)("undici") as typeof UndiciType;
		} catch (err) {
			console.warn("[proxy] undici not installed, HTTP proxy support disabled:", err);
			return { active: false, proxyUrl: effectiveProxy };
		}
		const dispatcher = withUndiciErrorListener(
			new undici.EnvHttpProxyAgent({
				allowH2: false,
				proxyTunnel: true,
				bodyTimeout: 300_000,
				headersTimeout: 300_000,
			}),
		);
		undici.setGlobalDispatcher(dispatcher);
		undici.install?.();
		return { active: true, proxyUrl: effectiveProxy };
	} catch (err) {
		console.warn("[proxy] Failed to configure global undici proxy dispatcher:", err);
		return { active: false, proxyUrl: effectiveProxy };
	}
}

function withUndiciErrorListener(dispatcher: unknown): UndiciType.Dispatcher {
	if (dispatcher instanceof EventEmitter) {
		dispatcher.on("error", () => {});
	}
	return dispatcher as UndiciType.Dispatcher;
}
