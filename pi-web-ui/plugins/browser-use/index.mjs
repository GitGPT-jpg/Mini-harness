/**
 * browser-use/index.mjs — 常驻 Chrome 自动化插件 (DrissionPage)
 *
 * 为 AI 注册 `browser_use` 原生工具：
 * - 自动拉起或连接常驻 Chrome（默认端口 9333，独立 user-data 目录防止冲突）；
 * - 闲置超时自动关闭（默认 15 分钟无操作自动退出释放内存，可在插件设置中自定义）；
 * - 多标签页管理：tabs / switch / close / open / new；
 * - 页面快照：精简提取人类可见的交互元素（带有序号及属性，极省 Token）；
 * - 动作控制：click / input / select / check / type / press / scroll / wait / js / shot / quit。
 */

import { exec, execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(PLUGIN_DIR, "scripts", "dp_browser.py");
const DEFAULT_PORT = 9333;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_IDLE_MINUTES = 15;

function decode(buf) {
	const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ""));
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		try {
			return new TextDecoder("gbk").decode(bytes);
		} catch {
			return bytes.toString("latin1");
		}
	}
}

function resolvePython() {
	const isWin = process.platform === "win32";
	// 1. 插件内置虚拟环境
	const venvPy = join(PLUGIN_DIR, ".venv", isWin ? "Scripts/python.exe" : "bin/python");
	if (existsSync(venvPy)) return venvPy;
	// 2. 外部环境变量或默认 python
	if (process.env.PYTHON_PATH && existsSync(process.env.PYTHON_PATH)) {
		return process.env.PYTHON_PATH;
	}
	return isWin ? "python.exe" : "python3";
}

function checkPortAlive(port = DEFAULT_PORT, timeoutMs = 1500) {
	return new Promise((resolve) => {
		const socket = createConnection({ port, host: "127.0.0.1" });
		let settled = false;
		const finish = (alive) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(alive);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));
	});
}

async function forceKillPort(port = DEFAULT_PORT) {
	// 端口会拼进 shell 命令（netstat/fuser/lsof），先做白名单校验防注入。
	const portStr = String(port ?? "");
	if (!/^\d{1,5}$/.test(portStr)) return;
	const portNum = Number(portStr);
	if (portNum < 1 || portNum > 65535) return;
	port = portNum;
	try {
		if (process.platform === "win32") {
			const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
			const lines = stdout.split(/\r?\n/).filter((l) => l.includes(`:${port}`) && l.includes("LISTENING"));
			for (const line of lines) {
				const parts = line.trim().split(/\s+/);
				const pid = parts[parts.length - 1];
				if (pid && /^\d+$/.test(pid) && pid !== "0" && pid !== String(process.pid)) {
					try {
						await execAsync(`taskkill /F /PID ${pid}`);
					} catch {
						// ignore
					}
				}
			}
		} else {
			await execAsync(`fuser -k -n tcp ${port} 2>/dev/null || lsof -ti :${port} | xargs kill -9 2>/dev/null || true`);
		}
	} catch {
		// ignore
	}
}

function runPythonScript(pyExecutable, scriptArgs, { env = {}, timeout = DEFAULT_TIMEOUT_MS, signal } = {}) {
	return new Promise((resolve, reject) => {
		const childEnv = {
			...process.env,
			PYTHONIOENCODING: "utf-8",
			...env,
		};
		execFile(
			pyExecutable,
			[SCRIPT_PATH, ...scriptArgs],
			{
				encoding: "buffer",
				timeout,
				windowsHide: true,
				signal,
				env: childEnv,
				maxBuffer: 10 * 1024 * 1024,
			},
			(err, stdout, stderr) => {
				const stdoutText = decode(stdout).trim();
				const stderrText = decode(stderr).trim();
				if (err) {
					if (stdoutText.startsWith("{")) {
						try {
							const parsed = JSON.parse(stdoutText);
							if (!parsed.ok) {
								resolve(parsed);
								return;
							}
						} catch {
							// fallback to reject
						}
					}
					const tail = stderrText ? `（${stderrText.slice(-300)}）` : "";
					reject(new Error(`browser_use 运行失败：${err.message}${tail}`));
					return;
				}
				if (!stdoutText) {
					if (stderrText) {
						reject(new Error(`browser_use 无返回内容：${stderrText.slice(-300)}`));
					} else {
						resolve({ ok: true });
					}
					return;
				}
				const startIdx = stdoutText.lastIndexOf("\n{");
				const jsonCandidate = startIdx >= 0 ? stdoutText.slice(startIdx + 1) : stdoutText;
				try {
					resolve(JSON.parse(jsonCandidate));
				} catch {
					resolve({ ok: true, raw: stdoutText });
				}
			},
		);
	});
}

function formatSnapshotText(data) {
	const lines = [];
	const p = data.page || {};
	lines.push(`页面: ${p.title || "(无标题)"}`);
	lines.push(`URL: ${p.url || ""}`);
	if (p.scrollY !== undefined) {
		lines.push(`滚动位置: ${p.scrollY}px / 文档高度: ${p.documentHeight || 0}px`);
	}
	lines.push(`交互元素摘要: ${data.summary || "(无)"}`);
	lines.push("");

	const elements = data.elements || [];
	if (elements.length === 0) {
		lines.push("（当前页面未探测到可见交互元素）");
	} else {
		lines.push(`=== 可交互元素列表 (共 ${elements.length} 个) ===`);
		for (const el of elements) {
			const parts = [`[${el.i}]`, `[${el.tag}${el.type ? `:${el.type}` : ""}]`];
			if (el.text) parts.push(JSON.stringify(el.text));
			if (el.placeholder) parts.push(`placeholder=${JSON.stringify(el.placeholder)}`);
			if (el.value !== null && el.value !== undefined) parts.push(`value=${JSON.stringify(el.value)}`);
			if (el.checked !== null && el.checked !== undefined) parts.push(`checked=${el.checked}`);
			if (el.id) parts.push(`#${el.id}`);
			if (el.name) parts.push(`name=${el.name}`);
			if (el.role) parts.push(`role=${el.role}`);
			if (el.aria) parts.push(`aria=${JSON.stringify(el.aria)}`);
			if (el.href) parts.push(`href=${JSON.stringify(el.href)}`);
			if (el.label) parts.push(`label=${JSON.stringify(el.label)}`);
			lines.push(parts.join(" "));
		}
	}

	if (!data.interactive_only) {
		const headings = data.headings || [];
		if (headings.length > 0) {
			lines.push("");
			lines.push(`=== 页面标题 ===`);
			for (const h of headings.slice(0, 30)) {
				lines.push(`${"#".repeat(h.level || 1)} ${h.text}`);
			}
		}
		const paragraphs = data.paragraphs || [];
		if (paragraphs.length > 0) {
			lines.push("");
			lines.push(`=== 正文摘录 ===`);
			for (const para of paragraphs.slice(0, 20)) {
				lines.push(para.text);
			}
		}
	}
	lines.push("");
	lines.push("提示: 下一步可调用 click(target: 序号/文本/选择器) 或 input(target, text) 进行交互。");
	return lines.join("\n");
}

function formatTabsText(tabs) {
	if (!tabs || tabs.length === 0) return "当前无打开的标签页。";
	const lines = [`当前打开的标签页 (共 ${tabs.length} 个):`];
	for (const t of tabs) {
		const marker = t.current ? "* " : "  ";
		lines.push(`${marker}[${t.i}] ${t.title || "(无标题)"} (${t.url || "about:blank"})`);
	}
	return lines.join("\n");
}

function formatSearchResultsText(resp) {
	const parts = [];
	const engineLabel = resp.engine || "bing";
	const pageLabel = resp.page && resp.page > 1 ? ` · 第${resp.page}页` : "";
	const fallbackInfo = resp.fallback_from ? ` (由 ${resp.fallback_from} 自动降级回退)` : "";
	const timeFilterLabel = resp.time_range
		? ` · 时效:${{ day: "过去24小时", week: "过去1周", month: "过去1个月", year: "过去1年" }[resp.time_range] || resp.time_range}`
		: "";
	parts.push(`🔍 搜索关键词: "${resp.query}" [${engineLabel}${pageLabel}${timeFilterLabel}${fallbackInfo}]`);

	if (resp.instant_answer) {
		parts.push(`\n💡 快速直达答案:\n${resp.instant_answer}\n`);
	}

	if (resp.top_content && resp.top_content.content) {
		const topTitle = resp.top_content.title ? ` [${resp.top_content.title}]` : "";
		parts.push(`\n📖 权威首条正文精选${topTitle} (${resp.top_content.url}):\n${resp.top_content.content}\n`);
	}

	const results = resp.results || [];
	if (results.length === 0) {
		parts.push(`未找到有效自然搜索结果。建议调整关键词或指定其他搜索引擎（如 google / baidu）。`);
	} else {
		parts.push(`\n共找到 ${results.length} 条自然搜索结果:`);
		results.forEach((item, idx) => {
			const badge = item.isOfficial ? "🏷️ [官网/权威] " : "";
			const dateStr = item.date ? ` (${item.date})` : "";
			parts.push(`\n[${idx + 1}] ${badge}${item.title}${dateStr}`);
			parts.push(`    URL: ${item.url}`);
			if (item.site) parts.push(`    来源: ${item.site}`);
			if (item.snippet) parts.push(`    摘要: ${item.snippet}`);
		});
	}

	const related = resp.related_queries || [];
	if (related.length > 0) {
		parts.push(`\n💡 相关搜索建议: ${related.join(" · ")}`);
	}

	return parts.join("\n");
}

const TOOL_GUIDELINES = [
	"Use snapshot (or interactiveOnly: true) to inspect visible elements and their numerical IDs before clicking or typing.",
	"Click target can be a numerical index from snapshot (e.g. '3'), CSS selector ('#submit'), or text ('Sign in').",
	"Browser persists across calls; use tabs/switch to inspect or switch between tabs instead of reopening URLs.",
];

const SEARCH_GUIDELINES = [
	"Use browser_search when you need real-time web information, fresh documentation, or technical error solutions.",
	"Default engine is bing; switch to google for global tech, or baidu for Chinese local topics.",
	"Use clean URLs from results to inspect full pages with browser_use or read when detailed content is needed.",
];

export function activate(host) {
	const userDataDir = join(host.dataDir, "browser-use-chrome-data");
	mkdirSync(userDataDir, { recursive: true });

	// 空闲自动关闭管理与无头模式设置
	let browserActive = false;
	let lastActivityTime = Date.now();
	let idleTimer = null;
	let idleTimeoutMinutes = DEFAULT_IDLE_MINUTES;
	let headlessMode = true; // 默认采用无头模式
	let defaultEngine = "auto";
	let fastSearch = true;
	let searchTabIsolation = true;

	try {
		const stored = host.storage?.get?.("settings");
		if (typeof stored?.idleTimeoutMinutes === "number") {
			idleTimeoutMinutes = Math.max(0, Math.floor(stored.idleTimeoutMinutes));
		}
		if (typeof stored?.headless === "boolean") {
			headlessMode = stored.headless;
		}
		if (typeof stored?.defaultEngine === "string" && stored.defaultEngine) {
			defaultEngine = stored.defaultEngine;
		}
		if (typeof stored?.fastSearch === "boolean") {
			fastSearch = stored.fastSearch;
		}
		if (typeof stored?.searchTabIsolation === "boolean") {
			searchTabIsolation = stored.searchTabIsolation;
		}
	} catch {
		// ignore
	}

	function buildBrowserEnv() {
		return {
			DP_BROWSER_PORT: String(DEFAULT_PORT),
			DP_USER_DATA: userDataDir,
			DP_HEADLESS: headlessMode ? "1" : "0",
			DP_DEFAULT_ENGINE: defaultEngine,
			DP_FAST_SEARCH: fastSearch ? "1" : "0",
			DP_SEARCH_ISOLATION: searchTabIsolation ? "1" : "0",
		};
	}

	function stopIdleTimer() {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
	}

	// 后台任务面板登记 (Background Tasks)
	let bgTaskHandle = null;

	function syncBackgroundTask(tabCount) {
		const labelText = `🌐 常驻 Chrome (${headlessMode ? "无头静默" : "实体窗口"})`;
		const statusText = `端口 ${DEFAULT_PORT}${typeof tabCount === "number" ? ` · ${tabCount} 个标签页` : " · 运行中"}`;
		if (!bgTaskHandle) {
			bgTaskHandle = host.registerBackgroundTask?.({
				id: "browser-instance",
				label: labelText,
				status: statusText,
				intervalMs: 3000,
				maxFailures: 2,
				check: async () => {
					return await checkPortAlive(DEFAULT_PORT);
				},
				onDead: () => {
					browserActive = false;
					stopIdleTimer();
					bgTaskHandle = null;
					host.log?.("info", "[browser-use] 检测到常驻 Chrome 已关闭，已自动移除后台任务记录。");
				},
				stop: async () => {
					await quitBrowser();
				},
			});
		} else {
			bgTaskHandle.update?.({
				label: labelText,
				status: statusText,
			});
		}
	}

	function removeBackgroundTask() {
		if (bgTaskHandle) {
			bgTaskHandle.unregister?.();
			bgTaskHandle = null;
		}
	}

	async function quitBrowser() {
		browserActive = false;
		stopIdleTimer();
		removeBackgroundTask();
		try {
			const py = resolvePython();
			const env = buildBrowserEnv();
			await runPythonScript(py, ["quit"], { env, timeout: 5_000 });
		} catch {
			// ignore
		}

		// 精确强力释放端口（防止卡死或僵尸进程遗留）
		const stillAlive = await checkPortAlive(DEFAULT_PORT, 600);
		if (stillAlive) {
			await forceKillPort(DEFAULT_PORT);
		}
	}

	async function closeBrowserDueToIdle() {
		if (!browserActive) return;
		await quitBrowser();
		host.log?.("info", `[browser-use] 浏览器闲置已达 ${idleTimeoutMinutes} 分钟，已自动关闭以释放内存。`);
	}

	function armIdleTimer() {
		stopIdleTimer();
		if (idleTimeoutMinutes <= 0 || !browserActive) {
			return; // 0 表示永不自动关闭
		}
		const timeoutMs = idleTimeoutMinutes * 60 * 1000;
		const elapsed = Date.now() - lastActivityTime;
		const remaining = Math.max(1000, timeoutMs - elapsed);

		idleTimer = setTimeout(async () => {
			const now = Date.now();
			if (now - lastActivityTime >= timeoutMs) {
				await closeBrowserDueToIdle();
			} else {
				armIdleTimer();
			}
		}, remaining);

		if (typeof idleTimer?.unref === "function") {
			idleTimer.unref();
		}
	}

	function recordActivity(tabCount) {
		browserActive = true;
		lastActivityTime = Date.now();
		armIdleTimer();
		syncBackgroundTask(tabCount);
	}

	const offSettings = host.onSettingsChanged?.((values) => {
		if (values) {
			if (typeof values.idleTimeoutMinutes === "number") {
				idleTimeoutMinutes = Math.max(0, Math.floor(values.idleTimeoutMinutes));
				armIdleTimer();
			}
			if (typeof values.headless === "boolean" && values.headless !== headlessMode) {
				headlessMode = values.headless;
				if (browserActive) {
					quitBrowser().catch(() => {});
				}
			}
			if (typeof values.defaultEngine === "string" && values.defaultEngine) {
				defaultEngine = values.defaultEngine;
			}
			if (typeof values.fastSearch === "boolean") {
				fastSearch = values.fastSearch;
			}
			if (typeof values.searchTabIsolation === "boolean") {
				searchTabIsolation = values.searchTabIsolation;
			}
		}
	});

	const tool = {
		name: "browser_use",
		label: "Browser Use",
		description:
			"Control a persistent Chrome browser via DrissionPage (port 9333). Actions: open/new tab, list tabs, switch tab, close tab, snapshot human-visible elements, click, input, select dropdown, check/uncheck, type, press key, hover, scroll, wait, execute JS, screenshot, and quit. State (cookies, logins, tabs) persists across commands.",
		promptSnippet: "automate a persistent Chrome browser (tabs, snapshot, click, type)",
		promptGuidelines: TOOL_GUIDELINES,
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"open",
						"new",
						"search",
						"read_page",
						"tabs",
						"switch",
						"close",
						"snapshot",
						"click",
						"input",
						"select",
						"check",
						"uncheck",
						"type",
						"press",
						"hover",
						"scroll",
						"wait",
						"js",
						"jsx",
						"screenshot",
						"quit",
					],
					description: "Browser action to execute.",
				},
				url: { type: "string", description: "URL to open or navigate to (auto-prefixes https://)." },
				query: { type: "string", description: "Search query string when action is 'search'." },
				engine: {
					type: "string",
					enum: ["auto", "bing", "sogou", "so", "baidu", "google", "duckduckgo", "brave", "yahoo"],
					description: "Search engine when action is 'search' (default: auto).",
				},
				timeRange: {
					type: "string",
					enum: ["all", "day", "week", "month", "year"],
					description: "Optional freshness limit for search action.",
				},
				page: {
					type: "number",
					description: "Target page index when action is 'search' (default: 1).",
				},
				limit: {
					type: "number",
					description: "Max natural results to return when searching (1-20, default: 8).",
				},
				fetchTopContent: {
					type: "boolean",
					description: "Extract content of the top result during search.",
				},
				fallback: {
					type: "boolean",
					description: "Allow engine fallback on failure (default: true).",
				},
				officialOnly: {
					type: "boolean",
					description: "Only keep authoritative sources.",
				},
				maxChars: {
					type: "number",
					description: "Max chars for read_page (default: 5000).",
				},
				target: {
					type: "string",
					description:
						"Element locator (snapshot index like '3', CSS selector like '#q', text like 'Sign in') or tab target for switch.",
				},
				text: { type: "string", description: "Text to enter (for input/type actions)." },
				key: { type: "string", description: "Key or combination to press (e.g. 'Enter', 'ctrl+a', 'Escape')." },
				option: { type: "string", description: "Option text, value, or index for dropdown select." },
				interactiveOnly: {
					type: "boolean",
					description: "If true, snapshot returns only interactive elements with IDs.",
				},
				byJs: { type: "boolean", description: "If true, click uses JavaScript click." },
				scroll: {
					type: "string",
					description: "Scroll argument: 'top', 'bottom', 'up', 'down', or pixels (e.g. '600').",
				},
				code: { type: "string", description: "JavaScript code or expression to execute in page context." },
				seconds: { type: "number", description: "Seconds to sleep or wait." },
				path: { type: "string", description: "File path for screenshot." },
				fullPage: { type: "boolean", description: "Whether screenshot captures full scrollable page." },
			},
			required: ["action"],
		},
		async execute(_id, params, signal) {
			const p = params ?? {};
			const action = p.action;
			const scriptArgs = [];

			switch (action) {
				case "open":
					if (!p.url) throw new Error("open 动作需要提供 url 参数");
					scriptArgs.push("open", p.url);
					break;
				case "new":
					if (!p.url) throw new Error("new 动作需要提供 url 参数");
					scriptArgs.push("new", p.url);
					break;
				case "search": {
					const q = p.query || p.text;
					if (!q) throw new Error("search 动作需要提供 query 关键词");
					scriptArgs.push("search", String(q));
					if (p.engine) scriptArgs.push("--engine", String(p.engine));
					if (p.timeRange) scriptArgs.push("--time-range", String(p.timeRange));
					if (p.page && p.page > 1) scriptArgs.push("--page", String(p.page));
					if (p.fetchTopContent) scriptArgs.push("--fetch-top");
					if (p.limit) scriptArgs.push("--limit", String(p.limit));
					if (p.officialOnly) scriptArgs.push("--official-only");
					if (p.fallback === false) scriptArgs.push("--no-fallback");
					break;
				}
				case "read_page":
					scriptArgs.push("read_page");
					if (p.url) scriptArgs.push(p.url);
					if (p.maxChars) scriptArgs.push(String(p.maxChars));
					break;
				case "tabs":
					scriptArgs.push("tabs");
					break;
				case "switch":
					if (!p.target) throw new Error("switch 动作需要提供 target 参数 (序号/ID/网址或标题片段)");
					scriptArgs.push("switch", String(p.target));
					break;
				case "close":
					scriptArgs.push("close");
					if (p.target) scriptArgs.push(String(p.target));
					break;
				case "snapshot":
					scriptArgs.push("snapshot");
					if (p.interactiveOnly) scriptArgs.push("-i");
					break;
				case "click":
					if (!p.target) throw new Error("click 动作需要提供 target (快照序号 / 文本 / 选择器)");
					scriptArgs.push("click");
					if (p.byJs) scriptArgs.push("--js");
					scriptArgs.push(String(p.target));
					break;
				case "input":
					if (!p.target) throw new Error("input 动作需要提供 target 定位参数");
					scriptArgs.push("input", String(p.target), p.text ?? "");
					break;
				case "select":
					if (!p.target || !p.option) throw new Error("select 动作需要提供 target 和 option 参数");
					scriptArgs.push("select", String(p.target), String(p.option));
					break;
				case "check":
					if (!p.target) throw new Error("check 动作需要提供 target 定位参数");
					scriptArgs.push("check", String(p.target));
					break;
				case "uncheck":
					if (!p.target) throw new Error("uncheck 动作需要提供 target 定位参数");
					scriptArgs.push("uncheck", String(p.target));
					break;
				case "type":
					if (!p.text) throw new Error("type 动作需要提供 text 参数");
					scriptArgs.push("type", String(p.text));
					break;
				case "press":
					if (!p.key) throw new Error("press 动作需要提供 key 按键参数 (如 Enter / ctrl+a)");
					scriptArgs.push("press", String(p.key));
					break;
				case "hover":
					if (!p.target) throw new Error("hover 动作需要提供 target 定位参数");
					scriptArgs.push("hover", String(p.target));
					break;
				case "scroll":
					scriptArgs.push("scroll", p.scroll || "down");
					break;
				case "wait":
					scriptArgs.push("wait", String(p.seconds || 1));
					break;
				case "js":
					if (!p.code) throw new Error("js 动作需要提供 code 参数");
					scriptArgs.push("js", p.code);
					break;
				case "jsx":
					if (!p.code) throw new Error("jsx 动作需要提供 code 参数 (表达式)");
					scriptArgs.push("jsx", p.code);
					break;
				case "screenshot":
					scriptArgs.push("screenshot");
					if (p.path) scriptArgs.push(p.path);
					if (p.fullPage) scriptArgs.push("--full");
					break;
				case "quit":
					scriptArgs.push("quit");
					break;
				default:
					throw new Error(`未知 action: ${action}`);
			}

			const py = resolvePython();
			const env = buildBrowserEnv();

			const resp = await runPythonScript(py, scriptArgs, { env, signal });
			if (!resp.ok) {
				const errMsg = resp.error || "未知错误";
				const hintMsg = resp.hint ? `\n提示: ${resp.hint}` : "";
				throw new Error(`[browser_use] ${errMsg}${hintMsg}`);
			}

			// 更新活跃状态、后台任务卡片与空闲定时器
			if (action === "quit") {
				browserActive = false;
				stopIdleTimer();
				removeBackgroundTask();
			} else {
				const tabCount =
					typeof resp.tabs === "number" ? resp.tabs : Array.isArray(resp.tabs) ? resp.tabs.length : undefined;
				recordActivity(tabCount);
			}

			let outputText = "";
			if (action === "search") {
				outputText = formatSearchResultsText(resp);
			} else if (action === "read_page") {
				outputText = `📖 页面正文: "${resp.title || ""}"\nURL: ${resp.url || ""}\n(总计约 ${resp.total_chars || 0} 字符${resp.truncated ? "，已按预算截断" : ""})\n\n${resp.content || ""}`;
			} else if (action === "snapshot") {
				outputText = formatSnapshotText(resp);
			} else if (action === "tabs") {
				outputText = formatTabsText(resp.tabs);
			} else if (action === "screenshot") {
				outputText = `截图已保存: ${resp.path}${resp.full_page ? " (完整长截图)" : ""}`;
			} else if (action === "open" || action === "new" || action === "switch") {
				outputText = `[${action}] 已打开页面: "${resp.title || ""}"\nURL: ${resp.url || ""}\n(当前标签页总数: ${resp.tabs || 1})`;
			} else if (action === "click") {
				outputText = `[click] 成功点击 "${resp.target}"\n当前页面: "${resp.title || ""}" (${resp.url || ""})`;
			} else if (action === "input") {
				outputText = `[input] 成功向 "${resp.target}" 输入 ${resp.len || 0} 个字符`;
			} else if (action === "press") {
				outputText = `[press] 已触发按键: ${resp.keys}`;
			} else {
				outputText = JSON.stringify(resp, null, 2);
			}

			// details 字段硬限制 ≤64KB
			const detailsSafe = {
				ok: true,
				action,
				url: resp.url,
				title: resp.title,
				count: resp.count,
				page: resp.page,
				time_range: resp.time_range,
				related_queries: resp.related_queries,
				top_content: resp.top_content
					? {
							title: resp.top_content.title,
							url: resp.top_content.url,
							snippet: resp.top_content.content ? resp.top_content.content.slice(0, 500) : undefined,
						}
					: undefined,
				results: action === "search" ? (resp.results || []).slice(0, 8) : undefined,
			};

			return {
				content: [{ type: "text", text: outputText }],
				details: detailsSafe,
			};
		},
	};

	const searchTool = {
		name: "browser_search",
		label: "Browser Search",
		description:
			"Search the web using a real headless Chrome instance with ad-filtering and direct SERP extraction. Returns structured natural results and instant answers across Bing, Sogou, 360, Baidu, Google, DuckDuckGo, Brave, and Yahoo.",
		promptSnippet: "search the web via real browser with ad filtering and fast SERP extraction",
		promptGuidelines: SEARCH_GUIDELINES,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Search keywords or advanced search query.",
				},
				engine: {
					type: "string",
					enum: ["auto", "bing", "sogou", "so", "baidu", "google", "duckduckgo", "brave", "yahoo"],
					description: "Search engine to use (default: auto).",
				},
				timeRange: {
					type: "string",
					enum: ["all", "day", "week", "month", "year"],
					description: "Time scope limit: 'day' (past 24h), 'week', 'month', or 'year'.",
				},
				page: {
					type: "number",
					description: "Result page number to inspect (1-20, default: 1).",
				},
				limit: {
					type: "number",
					description: "Maximum number of natural search results to return (1-20, default: 8).",
				},
				fetchTopContent: {
					type: "boolean",
					description: "Fetch pure markdown text excerpt of the top match.",
				},
				fallback: {
					type: "boolean",
					description: "Auto-retry alternative search engines on captcha or error.",
				},
				officialOnly: {
					type: "boolean",
					description: "Prefer verified domain results.",
				},
			},
			required: ["query"],
		},
		async execute(_id, params, signal) {
			const p = params ?? {};
			if (!p.query) throw new Error("browser_search 需要提供 query 关键词");

			const scriptArgs = ["search", String(p.query)];
			if (p.engine) scriptArgs.push("--engine", String(p.engine));
			if (p.timeRange) scriptArgs.push("--time-range", String(p.timeRange));
			if (p.page && p.page > 1) scriptArgs.push("--page", String(p.page));
			if (p.fetchTopContent) scriptArgs.push("--fetch-top");
			if (p.limit) scriptArgs.push("--limit", String(p.limit));
			if (p.officialOnly) scriptArgs.push("--official-only");
			if (p.fallback === false) scriptArgs.push("--no-fallback");

			const py = resolvePython();
			const env = buildBrowserEnv();

			const resp = await runPythonScript(py, scriptArgs, { env, signal });
			if (!resp.ok) {
				const errMsg = resp.error || "未知搜索错误";
				const hintMsg = resp.hint ? `\n提示: ${resp.hint}` : "";
				throw new Error(`[browser_search] ${errMsg}${hintMsg}`);
			}

			const tabCount =
				typeof resp.tabs === "number" ? resp.tabs : Array.isArray(resp.tabs) ? resp.tabs.length : undefined;
			recordActivity(tabCount);

			const outputText = formatSearchResultsText(resp);
			const detailsSafe = {
				ok: true,
				action: "search",
				query: resp.query,
				engine: resp.engine,
				fallback_from: resp.fallback_from,
				page: resp.page,
				time_range: resp.time_range,
				related_queries: resp.related_queries,
				top_content: resp.top_content
					? {
							title: resp.top_content.title,
							url: resp.top_content.url,
							snippet: resp.top_content.content ? resp.top_content.content.slice(0, 500) : undefined,
						}
					: undefined,
				count: resp.count,
				results: (resp.results || []).slice(0, 8),
			};

			return {
				content: [{ type: "text", text: outputText }],
				details: detailsSafe,
			};
		},
	};

	const unregUse = host.registerAgentTool(tool);
	const unregSearch = host.registerAgentTool(searchTool);

	return async function deactivate() {
		// 卸载插件时把常驻 Chrome 一并关掉：否则反注册只是摘掉工具面，
		// 9333 端口上带着登录态的浏览器进程会永远残留（僵尸 + 凭据面）。
		stopIdleTimer();
		try {
			await quitBrowser();
		} catch {
			// 关闭失败不阻塞插件卸载
		}
		removeBackgroundTask();
		offSettings?.();
		unregUse?.();
		unregSearch?.();
	};
}

export default {
	activate,
};
