/**
 * MCP 服务器管理服务
 *
 * 负责 Pi 全局 (~/.pi/agent/mcp.json 或兼容 ~/.pi-web/mcp.json)
 * 与工作区项目级 (.pi/mcp.json) MCP 服务器配置的读写、合并与生命周期。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { McpScope, UiMcpServer, UiMcpToolInfo } from "./protocol.js";
import {
	getGlobalMcpPath,
	getProjectMcpPath,
	parseMcpConfig,
	type McpBridge,
	type McpServerSpec,
} from "./mcp-bridge.js";

export { getGlobalMcpPath, getProjectMcpPath };

/** 读取指定文件的 MCP 服务器配置 */
export function readMcpConfigFile(filePath: string): {
	servers: Record<string, McpServerSpec>;
	raw: Record<string, unknown> | null;
	legacy: boolean;
	exists: boolean;
} {
	if (!existsSync(filePath)) {
		return { servers: {}, raw: null, legacy: false, exists: false };
	}
	try {
		const text = readFileSync(filePath, "utf8");
		let raw: Record<string, unknown> | null = null;
		try {
			const parsed = JSON.parse(text);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				raw = parsed as Record<string, unknown>;
			}
		} catch {
			/* invalid json */
		}
		const legacy = !!raw && raw.servers !== undefined && raw.mcpServers === undefined;
		const parsedConfig = parseMcpConfig(text);
		return {
			servers: parsedConfig ? parsedConfig.servers : {},
			raw,
			legacy,
			exists: true,
		};
	} catch {
		return { servers: {}, raw: null, legacy: false, exists: true };
	}
}

/** 写入指定文件的 MCP 服务器配置（保留除服务器清单以外的其它字段） */
export function writeMcpConfigFile(
	filePath: string,
	servers: Record<string, McpServerSpec>,
	preferLegacy = false,
): void {
	mkdirSync(dirname(filePath), { recursive: true });
	let raw: Record<string, unknown> = {};
	if (existsSync(filePath)) {
		try {
			const text = readFileSync(filePath, "utf8");
			const parsed = JSON.parse(text);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				raw = parsed as Record<string, unknown>;
			}
		} catch {
			/* ignore corrupt file, rewrite cleanly */
		}
	}

	const legacy = raw.servers !== undefined && raw.mcpServers === undefined ? true : preferLegacy;
	const next = { ...raw };
	if (legacy) {
		delete next.mcpServers;
		next.servers = servers;
	} else {
		delete next.servers;
		next.mcpServers = servers;
	}

	writeFileSync(filePath, JSON.stringify(next, null, 2) + "\n", "utf8");
}

/** 校验 MCP 服务器名称合法性（字母、数字、下划线、短横线） */
export function isValidMcpServerName(name: string): boolean {
	return /^[a-zA-Z0-9_-]+$/.test(name.trim());
}

/** 汇总查询全局与项目级配置列表，并结合 McpBridge 运行时状态组装 UiMcpServer 数组 */
export function listAllMcpServers(opts: { agentDir?: string; cwd?: string; dataDir?: string; bridge?: McpBridge }): {
	servers: UiMcpServer[];
	globalPath: string;
	projectPath: string;
} {
	const globalPath = getGlobalMcpPath(opts.agentDir, opts.dataDir);
	const projectPath = getProjectMcpPath(opts.cwd);

	const globalCfg = readMcpConfigFile(globalPath);
	const projectCfg = readMcpConfigFile(projectPath);

	const result: UiMcpServer[] = [];

	// 全局服务器
	for (const [name, spec] of Object.entries(globalCfg.servers)) {
		const status = getRuntimeStatus(name, spec, opts.bridge);
		result.push({
			name,
			scope: "global",
			command: spec.command,
			args: spec.args,
			cwd: spec.cwd,
			env: spec.env,
			url: spec.url,
			headers: spec.headers,
			type: spec.type,
			timeout: spec.timeout,
			protocolVersion: spec.protocolVersion,
			enabled: spec.enabled !== false,
			description: spec.description,
			status: status.status,
			error: status.error,
			tools: status.tools,
		});
	}

	// 项目级服务器
	for (const [name, spec] of Object.entries(projectCfg.servers)) {
		const status = getRuntimeStatus(name, spec, opts.bridge);
		result.push({
			name,
			scope: "project",
			command: spec.command,
			args: spec.args,
			cwd: spec.cwd,
			env: spec.env,
			url: spec.url,
			headers: spec.headers,
			type: spec.type,
			timeout: spec.timeout,
			protocolVersion: spec.protocolVersion,
			enabled: spec.enabled !== false,
			description: spec.description,
			status: status.status,
			error: status.error,
			tools: status.tools,
		});
	}

	return { servers: result, globalPath, projectPath };
}

function getRuntimeStatus(
	name: string,
	spec: McpServerSpec,
	bridge?: McpBridge,
): { status: "running" | "stopped" | "error"; error?: string; tools: UiMcpToolInfo[] } {
	if (spec.enabled === false) {
		return { status: "stopped", tools: [] };
	}
	if (!bridge) {
		return { status: "stopped", tools: [] };
	}
	return bridge.getServerStatus(name);
}

/** 保存或更新 MCP 服务器 */
export function saveMcpServer(opts: {
	agentDir?: string;
	cwd?: string;
	dataDir?: string;
	server: UiMcpServer;
	prevName?: string;
	prevScope?: McpScope;
}): { ok: boolean; error?: string } {
	const name = opts.server.name.trim();
	if (!isValidMcpServerName(name)) {
		return { ok: false, error: "服务器名称仅允许包含英文字母、数字、下划线及中划线" };
	}

	const targetScope = opts.server.scope;
	const globalPath = getGlobalMcpPath(opts.agentDir, opts.dataDir);
	const projectPath = getProjectMcpPath(opts.cwd);
	const targetPath = targetScope === "global" ? globalPath : projectPath;

	// 若存在旧名称或作用域移动，从原作用域文件中移除
	if (opts.prevName && opts.prevScope) {
		const prevCleanName = opts.prevName.trim();
		if (prevCleanName !== name || opts.prevScope !== targetScope) {
			const oldPath = opts.prevScope === "global" ? globalPath : projectPath;
			const oldCfg = readMcpConfigFile(oldPath);
			if (oldCfg.servers[prevCleanName]) {
				delete oldCfg.servers[prevCleanName];
				writeMcpConfigFile(oldPath, oldCfg.servers, oldCfg.legacy);
			}
		}
	}

	const targetCfg = readMcpConfigFile(targetPath);
	const spec: McpServerSpec = {
		command: opts.server.command?.trim() || undefined,
		args: Array.isArray(opts.server.args) && opts.server.args.length > 0 ? opts.server.args.map(String) : undefined,
		cwd: opts.server.cwd?.trim() || undefined,
		env:
			opts.server.env && Object.keys(opts.server.env).length > 0
				? (opts.server.env as Record<string, string>)
				: undefined,
		url: opts.server.url?.trim() || undefined,
		headers:
			opts.server.headers && Object.keys(opts.server.headers).length > 0
				? (opts.server.headers as Record<string, string>)
				: undefined,
		type: opts.server.type,
		timeout: typeof opts.server.timeout === "number" ? opts.server.timeout : undefined,
		protocolVersion: opts.server.protocolVersion?.trim() || undefined,
		enabled: opts.server.enabled !== false,
		description: opts.server.description?.trim() || undefined,
	};

	targetCfg.servers[name] = spec;
	writeMcpConfigFile(targetPath, targetCfg.servers, targetCfg.legacy);
	return { ok: true };
}

/** 删除指定作用域下的 MCP 服务器 */
export function deleteMcpServer(opts: {
	agentDir?: string;
	cwd?: string;
	dataDir?: string;
	name: string;
	scope: McpScope;
}): { ok: boolean; error?: string } {
	const name = opts.name.trim();
	const globalPath = getGlobalMcpPath(opts.agentDir, opts.dataDir);
	const projectPath = getProjectMcpPath(opts.cwd);
	const targetPath = opts.scope === "global" ? globalPath : projectPath;

	const targetCfg = readMcpConfigFile(targetPath);
	if (!targetCfg.servers[name]) {
		return { ok: false, error: `服务器 ${name} 在 ${opts.scope === "global" ? "全局" : "项目"} 配置中不存在` };
	}

	delete targetCfg.servers[name];
	writeMcpConfigFile(targetPath, targetCfg.servers, targetCfg.legacy);
	return { ok: true };
}

/** 切换指定作用域下的 MCP 服务器启用/停用状态 */
export function toggleMcpServer(opts: {
	agentDir?: string;
	cwd?: string;
	dataDir?: string;
	name: string;
	scope: McpScope;
	enabled: boolean;
}): { ok: boolean; error?: string } {
	const name = opts.name.trim();
	const globalPath = getGlobalMcpPath(opts.agentDir, opts.dataDir);
	const projectPath = getProjectMcpPath(opts.cwd);
	const targetPath = opts.scope === "global" ? globalPath : projectPath;

	const targetCfg = readMcpConfigFile(targetPath);
	if (targetCfg.servers[name]) {
		targetCfg.servers[name].enabled = opts.enabled;
		writeMcpConfigFile(targetPath, targetCfg.servers, targetCfg.legacy);
		return { ok: true };
	}

	// 若在项目级切换全局服务器的启用状态（项目级覆盖）：写入仅带 enabled 的配置项
	if (opts.scope === "project") {
		const globalCfg = readMcpConfigFile(globalPath);
		if (globalCfg.servers[name]) {
			targetCfg.servers[name] = { enabled: opts.enabled };
			writeMcpConfigFile(targetPath, targetCfg.servers, targetCfg.legacy);
			return { ok: true };
		}
	}

	return { ok: false, error: `服务器 ${name} 不存在` };
}

/** 从 npm 包名、URL 或命令自动推导合法的 MCP 服务器名称 */
export function deriveMcpServerName(raw: string): string {
	let s = String(raw ?? "").trim();
	if (!s) return "";
	// 如果是 URL，提取 hostname
	if (/^https?:\/\//i.test(s)) {
		try {
			const u = new URL(s);
			s = u.hostname;
		} catch {
			/* ignore */
		}
	} else {
		// 去掉 npm 版本后缀（如 @scope/pkg@1.2.3 或 pkg@latest）
		const atIdx = s.lastIndexOf("@");
		if (atIdx > 0) {
			s = s.slice(0, atIdx);
		}
		// 若为 @scope/pkg，取斜杠后半段；若后半段只是 "mcp" 或 "server"（如 @playwright/mcp），取 scope
		if (s.startsWith("@") && s.includes("/")) {
			const [scopePart, pkgPart] = s.slice(1).split("/", 2);
			if (pkgPart && !/^(mcp|server|mcp-server)$/i.test(pkgPart)) {
				s = pkgPart;
			} else if (scopePart) {
				s = scopePart;
			}
		}
		// 剥离常见前后缀（保留非空主体）
		const stripped = s.replace(/^(mcp-server-|server-|mcp-)/i, "").replace(/(-mcp-server|-server|-mcp)$/i, "");
		if (stripped.trim()) {
			s = stripped.trim();
		}
	}
	return s
		.replace(/[^a-zA-Z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

/** 检查某个 MCP 是否已安装的返回结构 */
export interface McpCheckResult {
	/** 是否已在全局或项目中配置了匹配的 MCP 服务器 */
	installed: boolean;
	/** 匹配的主服务器当前是否处于 running 状态 */
	running: boolean;
	/** 匹配的主服务器是否已启用 */
	enabled: boolean;
	/** 最佳匹配的服务器详情（项目级优先于全局级） */
	server: UiMcpServer | null;
	/** 所有匹配的服务器列表 */
	matches: UiMcpServer[];
	/** 匹配服务器当前已握手的工具列表 */
	tools: UiMcpToolInfo[];
}

/**
 * 检查某个 MCP 服务器是否已安装（支持按服务器名称、npm 包名、命令或 URL 匹配）。
 */
export function checkMcpServer(opts: {
	agentDir?: string;
	cwd?: string;
	dataDir?: string;
	bridge?: McpBridge;
	query: string;
}): McpCheckResult {
	const q = String(opts.query ?? "").trim();
	if (!q) {
		return { installed: false, running: false, enabled: false, server: null, matches: [], tools: [] };
	}
	const qLower = q.toLowerCase();
	const derived = deriveMcpServerName(q).toLowerCase();
	const { servers } = listAllMcpServers(opts);

	// 按匹配度打分：精确名 > 忽略大小写名 > 推导短名相等 > package/args/url/command 包含
	const scored: Array<{ server: UiMcpServer; score: number }> = [];
	for (const srv of servers) {
		const nameLower = srv.name.toLowerCase();
		const cmdLower = (srv.command ?? "").toLowerCase();
		const argsLower = (srv.args ?? []).map((a) => String(a).toLowerCase());
		const urlLower = (srv.url ?? "").toLowerCase();
		let score = 0;
		if (srv.name === q) {
			score = 100;
		} else if (nameLower === qLower) {
			score = 90;
		} else if (derived && nameLower === derived) {
			score = 80;
		} else if (argsLower.some((a) => a === qLower || (derived && deriveMcpServerName(a).toLowerCase() === derived))) {
			score = 75;
		} else if (
			nameLower.includes(qLower) ||
			cmdLower.includes(qLower) ||
			urlLower.includes(qLower) ||
			argsLower.some((a) => a.includes(qLower))
		) {
			score = 50;
		}
		if (score > 0) {
			// 同分时项目级优先、running 优先
			if (srv.scope === "project") score += 2;
			if (srv.status === "running") score += 1;
			scored.push({ server: srv, score });
		}
	}

	scored.sort((a, b) => b.score - a.score);
	const matches = scored.map((x) => x.server);
	const primary = matches[0] ?? null;
	return {
		installed: matches.length > 0,
		running: primary ? primary.status === "running" : false,
		enabled: primary ? primary.enabled !== false : false,
		server: primary,
		matches,
		tools: primary?.tools ?? [],
	};
}

/** 便捷安装 MCP 服务器的规格（支持 package 快捷方式、stdio command 或 http url） */
export interface McpInstallSpec {
	/** 服务器名称（省略时从 package / url / command 自动推导） */
	name?: string;
	/** npm 包名快捷安装（如 "@modelcontextprotocol/server-filesystem"），自动转为 npx -y <package> ...args */
	package?: string;
	/** 启动命令（stdio 模式，如 "npx" / "uvx" / "node"） */
	command?: string;
	/** 命令参数（若同时提供 package，则追加在 npx -y <package> 之后） */
	args?: string[];
	/** 工作目录（stdio 模式） */
	cwd?: string;
	/** 环境变量 */
	env?: Record<string, string>;
	/** 远端 URL（http / streamable-http 模式） */
	url?: string;
	/** 远端 HTTP 请求头 */
	headers?: Record<string, string>;
	/** 传输类型 */
	type?: "stdio" | "http" | "streamable-http";
	/** 超时毫秒数 */
	timeout?: number;
	/** 描述 */
	description?: string;
	/** 同名服务器已存在时是否覆盖（默认拒绝，防止静默吃掉用户手工配置） */
	overwrite?: boolean;
	/** 写入作用域：默认 "project"（.pi/mcp.json），可选 "global" */
	scope?: McpScope;
	/** 是否启用（默认 true） */
	enabled?: boolean;
}

export interface McpInstallResult {
	ok: boolean;
	name?: string;
	scope?: McpScope;
	status?: "running" | "stopped" | "error";
	tools?: UiMcpToolInfo[];
	server?: UiMcpServer;
	error?: string;
}

/**
 * 便捷安装/配置一个 MCP 服务器并立即触发 McpBridge 热加载。
 */
export async function installMcpServer(opts: {
	agentDir?: string;
	cwd?: string;
	dataDir?: string;
	bridge?: McpBridge;
	spec: McpInstallSpec;
}): Promise<McpInstallResult> {
	const spec = opts.spec ?? {};
	const pkg = typeof spec.package === "string" ? spec.package.trim() : "";
	const rawCmd = typeof spec.command === "string" ? spec.command.trim() : "";
	const rawUrl = typeof spec.url === "string" ? spec.url.trim() : "";
	const extraArgs = Array.isArray(spec.args) ? spec.args.map(String) : [];

	let command = rawCmd || undefined;
	let args = extraArgs.length > 0 ? extraArgs : undefined;
	if (pkg) {
		command = command || "npx";
		args = command === "npx" ? ["-y", pkg, ...extraArgs] : [pkg, ...extraArgs];
	}

	if (!command && !rawUrl) {
		return {
			ok: false,
			error: "安装 MCP 服务器需提供 package（npm 包名）、command（启动命令）或 url（HTTP 地址）之一",
		};
	}

	const rawName =
		(typeof spec.name === "string" && spec.name.trim()) ||
		deriveMcpServerName(pkg || rawUrl || extraArgs[0] || command || "");
	if (!rawName || !isValidMcpServerName(rawName)) {
		return {
			ok: false,
			error: "无法推导出合法的服务器名称，请显式指定 name（仅允许英文字母、数字、下划线及中划线）",
		};
	}

	const scope: McpScope = spec.scope === "global" ? "global" : "project";
	// 重名保护：install 默认拒绝覆盖——promptGuidelines 里的"先 check"只是给模型
	// 的建议，不拦运行时；静默覆盖会吃掉用户手工配置的同名条目（含私有 token env）
	const existing = listAllMcpServers({ agentDir: opts.agentDir, cwd: opts.cwd, dataDir: opts.dataDir }).servers.find(
		(s) => s.name === rawName && s.scope === scope,
	);
	if (existing && spec.overwrite !== true) {
		return {
			ok: false,
			error: `已存在同名服务器「${rawName}」(${scope})——确认要覆盖请传 overwrite=true（将替换其命令/参数/环境变量）`,
		};
	}
	const uiServer: UiMcpServer = {
		name: rawName,
		scope,
		command,
		args,
		cwd: typeof spec.cwd === "string" && spec.cwd.trim() ? spec.cwd.trim() : undefined,
		env: spec.env && typeof spec.env === "object" ? spec.env : undefined,
		url: rawUrl || undefined,
		headers: spec.headers && typeof spec.headers === "object" ? spec.headers : undefined,
		type: spec.type ?? (rawUrl ? "streamable-http" : "stdio"),
		timeout: typeof spec.timeout === "number" ? spec.timeout : undefined,
		enabled: spec.enabled !== false,
		description: typeof spec.description === "string" && spec.description.trim() ? spec.description.trim() : undefined,
		status: "stopped",
		tools: [],
	};

	const saved = saveMcpServer({
		agentDir: opts.agentDir,
		cwd: opts.cwd,
		dataDir: opts.dataDir,
		server: uiServer,
	});
	if (!saved.ok) {
		return { ok: false, error: saved.error };
	}

	if (opts.bridge) {
		try {
			await opts.bridge.reload();
		} catch {
			/* bridge reload 内部已吞异常，兜底防御 */
		}
	}

	const after = listAllMcpServers({
		agentDir: opts.agentDir,
		cwd: opts.cwd,
		dataDir: opts.dataDir,
		bridge: opts.bridge,
	});
	const updated =
		after.servers.find((s) => s.name === rawName && s.scope === scope) ??
		after.servers.find((s) => s.name === rawName) ??
		uiServer;

	return {
		ok: true,
		name: rawName,
		scope,
		status: updated.status,
		tools: updated.tools,
		server: updated,
		...(updated.error ? { error: updated.error } : {}),
	};
}
