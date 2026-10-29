/**
 * `mcp.json` 热加载 —— 改完文件即生效，不必再重启 pi-web-ui。
 *
 * 为什么是「盯文件」而不是加协议消息 / 设置面板按钮：`mcp.json` 是用文本编辑器手改的
 * 外部文件（README 一直写着「改完要重启」），没有任何 UI 参与保存；监视文件是唯一不需要
 * 新增协议字段与多语言文案的形态（对照 `reload_models_config`：它有设置面板按钮，所以走协议）。
 *
 * 三条不变量（都有回归用例）：
 *  1. **内容没变就不动任何子进程**：指纹按「规范化后的服务器集合」算（服务器顺序无关、
 *     只看影响行为的字段）—— 编辑器保存、重排键、改缩进都不触发重启；
 *  2. **配置写坏不停掉在跑的服务器**：JSON 解析失败只记日志 + 提示一次，绝不碰现有实例
 *     （保存过程中的半写状态很常见）；
 *  3. **删掉文件 = 清空配置**：与「坏配置」区分开 —— 用户删掉 `mcp.json` 是有意关掉全部
 *     MCP 服务器，照常应用。
 */
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import {
	getGlobalMcpPath,
	getProjectMcpPath,
	mcpServerSnapshot,
	parseMcpConfig,
	type McpReloadSummary,
	type McpServerSpec,
} from "./mcp-bridge.js";

/** 一次「文件 → 运行时」应用的结果。 */
export type McpReloadOutcome =
	| "reloaded" // 配置变了，已换入
	| "unchanged" // 与上次应用的内容一致，什么都没做
	| "invalid"; // 解析失败，保留在跑的服务器

export interface McpHotReloadDeps {
	dataDir: string;
	agentDir?: string;
	cwd?: string;
	/** 应用新配置（`McpBridge.reload`）：每个服务器的启动失败由它自己消化，不该向这里抛。 */
	reload: () => Promise<McpReloadSummary>;
	/** 工具集合变化后推入已有会话（`service.applyPluginAgentTools`）——「工具列表热刷新」那一半。 */
	onToolsChanged?: () => void;
	/** 面向用户的通知条：坏配置与加载完成都要让人看见，不只是打在服务端日志里。 */
	onNotice?: (level: "info" | "warning", text: string, textEn: string) => void;
	log?: (...a: unknown[]) => void;
	/** 事件防抖（编辑器保存常触发多次）。 */
	debounceMs?: number;
	/** `fs.watch` 不可用时（目录不存在 / 网络盘 / 容器）的轮询间隔。 */
	pollIntervalMs?: number;
}

export interface McpHotReload {
	/** 读文件 → 比对指纹 → 必要时热替换。可直接调用（测试 / 手动重载）。 */
	apply(): Promise<McpReloadOutcome>;
	/** 播种指纹（启动时 `McpBridge.load()` 已按同一份文件启动过）并开始监视。 */
	start(): void;
	dispose(): void;
}

/** 规范化指纹：只含影响行为的字段、服务器顺序无关 —— 「内容变了吗」的判据。 */
function fingerprint(servers: Record<string, McpServerSpec>): string {
	const names = Object.keys(servers).sort();
	return JSON.stringify(names.map((n) => [n, mcpServerSnapshot(servers[n])]));
}

export function createMcpHotReload(deps: McpHotReloadDeps): McpHotReload {
	const globalFile = getGlobalMcpPath(deps.agentDir, deps.dataDir);
	const projectFile = deps.cwd ? getProjectMcpPath(deps.cwd) : undefined;
	const legacyFile = join(deps.dataDir, "mcp.json");

	const log = deps.log ?? (() => {});
	const debounceMs = deps.debounceMs ?? 300;
	const pollIntervalMs = deps.pollIntervalMs ?? 2000;
	/** 上次应用到运行时的内容指纹；null = 还没播种。 */
	let applied: string | null = null;
	let debounce: NodeJS.Timeout | null = null;
	let poller: NodeJS.Timeout | null = null;
	let watchers: FSWatcher[] = [];

	function readOneFile(file: string): { fp: string; servers: Record<string, McpServerSpec> | null } {
		let raw: string;
		try {
			raw = readFileSync(file, "utf8");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException | null)?.code;
			if (code === "ENOENT") return { fp: "empty", servers: {} };
			log(`[mcp] ${file} 读取失败（${code ?? String(err)}），按坏配置处理：保留在跑的 MCP 服务器`);
			return { fp: `unreadable:${code ?? "unknown"}`, servers: null };
		}
		const parsed = parseMcpConfig(raw);
		if (!parsed) return { fp: `invalid:${raw}`, servers: null };
		return { fp: `ok:${fingerprint(parsed.servers)}`, servers: parsed.servers };
	}

	/** 读全部配置文件（全局 + 项目）并合并指纹 */
	function readOnce(): { fp: string; servers: Record<string, McpServerSpec> | null } {
		const g = readOneFile(globalFile);
		let globalServers = g.servers;
		let gFp = g.fp;
		// 与 mcp-bridge 的启动加载同口径：全局文件**不存在或存在但 0 个服务器**都
		// 回退 dataDir legacy 配置。只判「文件不存在」时，「全局空配置 + legacy 有
		// 服务」的部署里启动用 legacy 起服务、热加载却跳过 legacy——改 legacy 的
		// 增删在重启前永不生效。
		const globalHasNoServers = g.servers !== null && Object.keys(g.servers).length === 0;
		if ((g.fp === "empty" || globalHasNoServers) && legacyFile !== globalFile) {
			const leg = readOneFile(legacyFile);
			if (leg.servers) {
				globalServers = leg.servers;
				gFp = leg.fp;
			} else if (leg.fp.startsWith("unreadable:") || leg.fp.startsWith("invalid:")) {
				return leg;
			}
		} else if (!g.servers && (g.fp.startsWith("unreadable:") || g.fp.startsWith("invalid:"))) {
			return g;
		}

		let pFp = "none";
		let projServers: Record<string, McpServerSpec> | null = {};
		if (projectFile) {
			const p = readOneFile(projectFile);
			if (!p.servers && (p.fp.startsWith("unreadable:") || p.fp.startsWith("invalid:"))) {
				return p;
			}
			projServers = p.servers;
			pFp = p.fp;
		}

		const merged: Record<string, McpServerSpec> = { ...globalServers };
		for (const [name, ps] of Object.entries(projServers || {})) {
			if (!ps.command && !ps.url && ps.enabled !== undefined && merged[name]) {
				merged[name] = { ...merged[name], enabled: ps.enabled };
			} else {
				merged[name] = ps;
			}
		}

		return {
			fp: `g:${gFp}|p:${pFp}`,
			servers: merged,
		};
	}

	async function apply(): Promise<McpReloadOutcome> {
		const { fp, servers } = readOnce();
		if (fp === applied) return "unchanged";
		// 先记账再动手：同一个坏文件不反复刷屏，配置没再变也不重试。
		applied = fp;
		if (!servers) {
			log("[mcp] mcp.json 解析失败，保留在跑的 MCP 服务器");
			deps.onNotice?.(
				"warning",
				"mcp.json 解析/读取失败，已保留当前 MCP 服务器（恢复可读后会自动重载）",
				"Failed to parse/read mcp.json — keeping the running MCP servers (it reloads automatically once readable)",
			);
			return "invalid";
		}
		const summary = await deps.reload();
		deps.onToolsChanged?.();
		log(
			`[mcp] 配置已热加载：${summary.servers} 个服务器 / ${summary.tools} 个工具` +
				`（沿用 ${summary.kept}、启动 ${summary.started}、关闭 ${summary.stopped}、失败 ${summary.failed}）`,
		);
		deps.onNotice?.(
			"info",
			`mcp.json 已热加载：${summary.servers} 个服务器 / ${summary.tools} 个工具`,
			`mcp.json reloaded: ${summary.servers} server(s) / ${summary.tools} tool(s)`,
		);
		return "reloaded";
	}

	function run(): void {
		void apply().catch((err) => log("[mcp] 热加载失败：", err instanceof Error ? err.message : err));
	}

	function schedule(): void {
		if (debounce) return;
		debounce = setTimeout(() => {
			debounce = null;
			run();
		}, debounceMs);
	}

	/** fs.watch 用不了（目录还不存在、网络盘、容器）→ 回落到轮询：单文件不值得上更重的机制。 */
	function fallBackToPolling(): void {
		for (const w of watchers) {
			try {
				w.close();
			} catch {}
		}
		watchers = [];
		if (poller) return;
		log(`[mcp] 目录监视不可用，mcp.json 热加载回落到 ${pollIntervalMs}ms 轮询`);
		poller = setInterval(run, pollIntervalMs);
		poller.unref();
	}

	function start(): void {
		if (watchers.length > 0 || poller) return;
		// 播种：启动时 load() 已按同一份文件启动过服务器，别在第一个事件里白重载一次。
		applied = readOnce().fp;

		const dirsToWatch = new Set<string>();
		dirsToWatch.add(deps.dataDir);
		if (globalFile) dirsToWatch.add(dirname(globalFile));
		if (projectFile) dirsToWatch.add(dirname(projectFile));

		for (const dir of dirsToWatch) {
			try {
				const w = watch(dir, { persistent: false }, (_event, filename) => {
					if (typeof filename === "string" && filename && filename !== "mcp.json") return;
					schedule();
				});
				w.on("error", () => fallBackToPolling());
				watchers.push(w);
			} catch {
				fallBackToPolling();
			}
		}
	}

	function dispose(): void {
		if (debounce) clearTimeout(debounce);
		debounce = null;
		if (poller) clearInterval(poller);
		poller = null;
		for (const w of watchers) {
			try {
				w.close();
			} catch {}
		}
		watchers = [];
	}

	return { apply, start, dispose };
}
