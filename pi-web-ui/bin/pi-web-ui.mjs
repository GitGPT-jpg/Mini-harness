#!/usr/bin/env node
/**
 * pi-web-ui CLI.
 *
 *   pi-web-ui                              启动生产服务器（前台，Ctrl+C 停止，自动打开浏览器）
 *   pi-web-ui --engine dsh --port 9000 --cwd /path    同上，覆盖引擎/端口/工作目录/数据目录
 *   pi-web-ui --no-browser                 启动但不自动打开浏览器
 *   pi-web-ui --version | --help
 *   pi-web-ui server install [选项]         安装系统服务（开机自启）并启动
 *   pi-web-ui server shortcut [选项]        在桌面创建「一键启动」图标（启动服务并打开浏览器）
 *   pi-web-ui server uninstall [选项]       卸载系统服务（同时移除桌面图标）
 *   pi-web-ui server start|stop|restart|status [选项]
 *
 * 系统服务：
 *   - macOS   → launchd 用户代理，label 默认 com.xingshuyin.pi-web-ui
 *              （--name 自定义时 com.<name>.server），无需 sudo
 *   - Linux   → systemd 单元 <name>.service（/etc/systemd/system/，自动 sudo）
 *   - Windows → 登录自启 Run 键（HKCU，无需管理员）+ wscript 隐藏启动（无黑窗）；
 *              PowerShell 启动脚本 / VBS 启动器 / PID 文件生成在
 *              %APPDATA%\pi-web-ui\
 *
 * 环境变量（flag 优先，环境变量后备）：PI_WEB_PORT / PI_WEB_CWD / PI_WEB_DATA_DIR /
 * PI_WEB_ENGINE / PI_WEB_HOST / PI_CODING_AGENT_DIR；token 仅环境变量，不走命令行。
 */
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { get as httpGet } from "node:http";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	realpathSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

for (const [hKey, pKey] of [
	["HARNESS_PORT", "PI_WEB_PORT"],
	["HARNESS_HOST", "PI_WEB_HOST"],
	["HARNESS_CWD", "PI_WEB_CWD"],
	["HARNESS_DATA_DIR", "PI_WEB_DATA_DIR"],
	["HARNESS_ENGINE", "PI_WEB_ENGINE"],
	["HARNESS_TOKEN", "PI_WEB_TOKEN"],
	["HARNESS_SDK", "PI_WEB_SDK"],
	["HARNESS_SDK_DIR", "PI_WEB_SDK_DIR"],
	["HARNESS_AGENT_DIR", "PI_CODING_AGENT_DIR"],
]) {
	if (process.env[hKey] !== undefined && process.env[hKey] !== "") process.env[pKey] = process.env[hKey];
}
const BIN_DIR = dirname(fileURLToPath(import.meta.url));
/** <pkg>/dist/server/index.js — the actual server entry. */
const SERVER_ENTRY = join(BIN_DIR, "..", "dist", "server", "index.js");
/** 「机器上有更新的 pi 副本就跟随它」解析钩子（issue #260；#321 起默认启用）。
 *  必须早于任何 SDK 静态 import 加载 —— 所以每条启动路径都把它当 `--import` 传进去；
 *  PI_WEB_SDK=bundled 显式钉死自带副本（见 server/resolve-global-sdk.ts）。 */
const SDK_HOOK = join(BIN_DIR, "..", "dist", "server", "resolve-global-sdk.js");
/** dist 可能是旧构建（没有这个钩子文件）—— 只有文件在才注入：`--import <missing>` 会让
 *  CLI/服务直接起不来，那比少个开关严重得多。 */
const HAS_SDK_HOOK = existsSync(SDK_HOOK);
const NODE = process.execPath;
let pkg = { version: "0.0.0" };
try {
	pkg = JSON.parse(readFileSync(join(BIN_DIR, "..", "package.json"), "utf8"));
} catch {
	// version is best-effort — the server itself doesn't need it
}

/** Detect if the user prefers Chinese locale: POSIX env vars win, then Intl API fallback. */
function isZhLang() {
	const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
	if (env.startsWith("zh")) return true;
	if (!env) {
		try {
			return Intl.DateTimeFormat().resolvedOptions().locale.startsWith("zh");
		} catch {
			/* ignore */
		}
	}
	return false;
}

/** Resolved once: CLI messages below pick zh/en with `ZH ? zh : en` (only the chosen branch is evaluated). */
const ZH = isZhLang();

const HELP_ZH = `pi-web-ui v${pkg.version} — web chat for the pi coding agent

用法:
  pi-web-ui                               启动服务器（前台，Ctrl+C 停止，自动打开浏览器）
  pi-web-ui --engine dsh --port 9000 --cwd /path      启动并指定引擎 / 端口 / 工作目录 / 数据目录
  pi-web-ui --no-browser                  启动但不自动打开浏览器
  pi-web-ui server install [选项]         安装系统服务（开机自启）并启动
  pi-web-ui server shortcut [选项]        在桌面创建「一键启动」图标（启动服务并打开浏览器）
  pi-web-ui server uninstall [选项]       卸载系统服务（同时移除桌面图标）
  pi-web-ui server start|stop|restart|status [选项]
  pi-web-ui server quiesce [选项]          进入排空模式：拒绝新的对话/消息/编辑，存量运行继续跑完
  pi-web-ui server unquiesce [选项]        解除排空模式，恢复接收新工作
  pi-web-ui --version / --help

server 选项:
  --port <n>        端口（默认 8787，或 $PI_WEB_PORT）
  --cwd <dir>       工作目录（默认 $PI_WEB_CWD 或用户主目录；前台启动默认当前目录）
  --data-dir <dir>  会话数据目录（默认 <cwd>/.pi-web）
  --engine <pi|dsh> 智能体引擎（默认 $PI_WEB_ENGINE 或 pi）
  --host <addr>     监听地址（默认 $PI_WEB_HOST 或 127.0.0.1；0.0.0.0 供局域网/容器）
  --agent-dir <dir> pi 配置目录（默认 $PI_CODING_AGENT_DIR 或 ~/.pi/agent）
  --name <name>     服务名（默认 pi-web-ui；仅限字母/数字/-/_，字母或数字开头，
                    最长 64 字符。macOS 的 launchd label 为 com.xingshuyin.pi-web-ui，
                    自定义名时为 com.<name>.server）
  --print           只打印将生成的配置文件，不实际安装

平台: macOS → launchd 用户代理 · Linux → systemd · Windows → 登录自启 Run 键
      （HKCU 写入无需管理员；wscript 隐藏启动无黑窗；stop 停止，uninstall 移除）
快捷方式: Windows → 桌面 .lnk · macOS → 桌面 .command 启动器 · Linux → 桌面 .desktop 图标

环境变量（flag 优先，环境变量后备）:
  PI_WEB_PORT / PI_WEB_CWD / PI_WEB_DATA_DIR / PI_WEB_ENGINE / PI_WEB_HOST /
  PI_CODING_AGENT_DIR。
  鉴权口令 PI_WEB_TOKEN：仅环境变量（不走命令行）；Linux install 会写入 unit，--print 会显示口令。
  其他平台需手动加入服务配置。
`;

const HELP_EN = `pi-web-ui v${pkg.version} — web chat for the pi coding agent

Usage:
  pi-web-ui                               Start server (foreground, Ctrl+C to stop, auto-opens browser)
  pi-web-ui --engine dsh --port 9000 --cwd /path      Start with engine/port/cwd/data-dir overrides
  pi-web-ui --no-browser                   Start without auto-opening browser
  pi-web-ui server install [options]       Install system service (autostart on boot) and launch it
  pi-web-ui server shortcut [options]      Create desktop "one-click start" icon
  pi-web-ui server uninstall [options]     Uninstall system service (also removes desktop icon)
  pi-web-ui server start|stop|restart|status [options]
  pi-web-ui server quiesce [options]       Drain mode: reject new chats/messages/edits; let current runs finish
  pi-web-ui server unquiesce [options]     Exit drain mode, resume accepting new work
  pi-web-ui --version / --help

Server options:
  --port <n>        Port (default 8787, or $PI_WEB_PORT)
  --cwd <dir>       Working directory (default $PI_WEB_CWD or home dir; foreground uses current dir)
  --data-dir <dir>  Session data directory (default <cwd>/.pi-web)
  --engine <pi|dsh> Agent engine (default $PI_WEB_ENGINE or pi)
  --host <addr>     Listen address (default $PI_WEB_HOST or 127.0.0.1; 0.0.0.0 for LAN/containers)
  --agent-dir <dir> pi config directory (default $PI_CODING_AGENT_DIR or ~/.pi/agent)
  --name <name>     Service name (default pi-web-ui; alphanumeric, "-" and "_" only,
                    starting with a letter or digit, max 64 chars. macOS launchd label is
                    com.xingshuyin.pi-web-ui, or com.<name>.server for custom names)
  --print           Only print generated config files (no actual install)

Platforms: macOS → launchd user agent · Linux → systemd · Windows → Logon Run key
           (HKCU, no admin needed; wscript hidden launch, no black window)
Shortcuts: Windows → desktop .lnk · macOS → desktop .command · Linux → desktop .desktop

Environment variables (flag takes precedence, env var as fallback):
  PI_WEB_PORT / PI_WEB_CWD / PI_WEB_DATA_DIR / PI_WEB_ENGINE / PI_WEB_HOST /
  PI_CODING_AGENT_DIR
  Auth token PI_WEB_TOKEN: env var only (not on command line). Linux install persists it; --print reveals it.
  On other platforms, add it to the service config manually.
`;

const HELP = isZhLang() ? HELP_ZH : HELP_EN;

/** Minimum Node required by the pi SDK (its dist uses `import … with { type: "json" }`). */
const NODE_MIN = [22, 19, 0];
function checkNodeVersion() {
	const v = process.versions.node.split(".").map(Number);
	const tooOld =
		v[0] < NODE_MIN[0] ||
		(v[0] === NODE_MIN[0] && v[1] < NODE_MIN[1]) ||
		(v[0] === NODE_MIN[0] && v[1] === NODE_MIN[1] && v[2] < NODE_MIN[2]);
	if (tooOld) {
		const zh =
			`✖ pi-web-ui 需要 Node.js >= ${NODE_MIN.join(".")}（当前 ${process.versions.node}）。\n` +
			`  pi SDK 的代码使用了 import attributes（with）语法，旧版 Node 无法解析。\n` +
			`  请升级 Node：https://nodejs.org（或 nvm-windows / fnm）后重装：npm i -g pi-web-ui`;
		const en =
			`✖ pi-web-ui requires Node.js >= ${NODE_MIN.join(".")} (current: ${process.versions.node}).\n` +
			`  The pi SDK uses import attributes (\`with\` syntax) which older Node versions can't parse.\n` +
			`  Upgrade Node: https://nodejs.org then reinstall: npm i -g pi-web-ui`;
		console.error(isZhLang() ? zh : en);
		process.exit(1);
	}
}

function fail(msg) {
	console.error(`✖ ${msg}`);
	process.exit(1);
}

/** Run a command, inheriting stdio; exits on failure unless ignoreError. */
function run(cmd, args, { ignoreError = false, silent = false } = {}) {
	const res = spawnSync(cmd, args, {
		stdio: silent ? ["inherit", "ignore", "ignore"] : "inherit",
	});
	if (!ignoreError && res.status !== 0) process.exit(res.status ?? 1);
	return res;
}

/** Parse --flag value / --flag=value options; returns { opts, positionals }. */
function parseFlags(argv) {
	const opts = {
		port: undefined,
		cwd: undefined,
		dataDir: undefined,
		name: undefined,
		engine: undefined,
		host: undefined,
		agentDir: undefined,
		print: false,
		noBrowser: false,
		force: false,
		checkUpdates: false,
		rollback: undefined,
		dir: undefined,
		template: undefined,
		withTest: false,
		help: false,
	};
	const positionals = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const eq = a.indexOf("=");
		const key = eq >= 0 ? a.slice(0, eq) : a;
		const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
		const take = (flag) => {
			if (inline !== undefined) return inline;
			if (i + 1 < argv.length) {
				i++;
				return argv[i];
			}
			fail(ZH ? `缺少选项 ${flag} 的值` : `Option ${flag} is missing a value`);
		};
		switch (key) {
			case "--port":
				opts.port = take("--port");
				break;
			case "--cwd":
				opts.cwd = take("--cwd");
				break;
			case "--data-dir":
				opts.dataDir = take("--data-dir");
				break;
			case "--engine":
				opts.engine = take("--engine");
				break;
			case "--host":
				opts.host = take("--host");
				break;
			case "--agent-dir":
				opts.agentDir = take("--agent-dir");
				break;
			case "--name":
				opts.name = take("--name");
				break;
			case "--print":
				opts.print = true;
				break;
			case "--no-browser":
				opts.noBrowser = true;
				break;
			case "--force":
				opts.force = true;
				break;
			case "--build":
				opts.build = true;
				break;
			case "--no-build":
				opts.noBuild = true;
				break;
			case "--catalog":
				opts.catalog = take("--catalog");
				break;
			case "--replace":
				opts.replace = true;
				break;
			case "--check-updates":
				opts.checkUpdates = true;
				break;
			case "--rollback":
				opts.rollback = take("--rollback");
				break;
			case "--dir":
				opts.dir = take("--dir");
				break;
			case "--template":
				opts.template = take("--template");
				break;
			case "--with-test":
				opts.withTest = true;
				break;
			case "--help":
			case "-h":
				opts.help = true;
				break;
			default:
				if (key.startsWith("-")) fail(ZH ? `未知选项: ${key}` : `Unknown option: ${key}`);
				positionals.push(a);
		}
	}
	return { opts, positionals };
}

// ---------------------------------------------------------------------------
// 前台启动
// ---------------------------------------------------------------------------

/** Open a URL in the OS default browser; failures are ignored (best-effort). */
function openBrowser(url) {
	let res;
	if (isMac) {
		res = spawnSync("open", [url], { stdio: "ignore" });
	} else if (isWin) {
		res = spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
	} else {
		res = spawnSync("xdg-open", [url], { stdio: "ignore" });
	}
	// spawnSync 不抛异常：命令缺失（headless 服务器）时在返回对象里带 error 字段。
	if (res?.error) {
		if (res.error.code === "ENOENT") {
			console.warn(
				ZH
					? `[browser] 未找到打开器 (${res.error.path || "command not found"})，` +
							"headless 服务器可用 --no-browser 关闭自动打开"
					: `[browser] no opener found (${res.error.path || "command not found"}), ` +
							"headless servers can use --no-browser to disable auto-open",
			);
		} else {
			console.warn(ZH ? "[browser] 打开浏览器失败:" : "[browser] failed to open browser:", res.error.message);
		}
	}
}

/**
 * Poll `url` until the server answers (or ~15s pass), then open it in the
 * default browser. The foreground server runs in this process, so the first
 * HTTP response is the "listening" signal; if the server crashes meanwhile
 * (e.g. port already taken), the pending timers die with the process and
 * nothing is opened.
 */
function openBrowserWhenUp(url) {
	const deadline = Date.now() + 15_000;
	const attempt = () => {
		const req = httpGet(url, (res) => {
			res.resume();
			console.log(
				ZH
					? `  🌐 已自动打开浏览器：${url}（--no-browser 可关闭）`
					: `  🌐 Browser opened automatically: ${url} (--no-browser to disable)`,
			);
			openBrowser(url);
		});
		req.setTimeout(1000, () => {
			req.destroy();
			if (Date.now() < deadline) setTimeout(attempt, 150);
		});
		req.on("error", () => {
			if (Date.now() < deadline) setTimeout(attempt, 150);
		});
	};
	attempt();
}

async function startForeground(opts) {
	if (opts.port) process.env.PI_WEB_PORT = opts.port;
	if (opts.cwd) process.env.PI_WEB_CWD = resolve(opts.cwd);
	if (opts.dataDir) process.env.PI_WEB_DATA_DIR = resolve(opts.dataDir);
	if (opts.engine) {
		if (opts.engine !== "pi" && opts.engine !== "dsh")
			fail(ZH ? `无效引擎: ${opts.engine}（仅支持 pi / dsh）` : `Invalid engine: ${opts.engine} (pi and dsh only)`);
		process.env.PI_WEB_ENGINE = opts.engine;
	}
	if (opts.host) process.env.PI_WEB_HOST = opts.host;
	if (opts.agentDir) process.env.PI_CODING_AGENT_DIR = resolve(opts.agentDir);
	const url = `http://localhost:${effectivePort(opts)}`;
	if (HAS_SDK_HOOK) await import(pathToFileURL(SDK_HOOK).href);
	try {
		await import(pathToFileURL(SERVER_ENTRY).href);
	} catch (err) {
		if (
			err &&
			typeof err === "object" &&
			"code" in err &&
			err.code === "ERR_MODULE_NOT_FOUND" &&
			String(err.message).includes("@earendil-works/pi-coding-agent")
		) {
			console.error(
				ZH
					? `\n[pi-web-ui] 错误：未找到 @earendil-works/pi-coding-agent 核心依赖。\n` +
							`请先全局安装 pi CLI，然后重试：\n` +
							`  npm i -g @earendil-works/pi-coding-agent@latest\n` +
							`或在 pnpm 环境下：\n` +
							`  pnpm add -g @earendil-works/pi-coding-agent@latest\n`
					: `\n[pi-web-ui] Error: '@earendil-works/pi-coding-agent' core dependency not found.\n` +
							`Please install the pi CLI globally and try again:\n` +
							`  npm i -g @earendil-works/pi-coding-agent@latest\n` +
							`or with pnpm:\n` +
							`  pnpm add -g @earendil-works/pi-coding-agent@latest\n`,
			);
			process.exit(1);
		}
		throw err;
	}
	if (!opts.noBrowser) openBrowserWhenUp(url);
}

// ---------------------------------------------------------------------------
// 系统服务管理
// ---------------------------------------------------------------------------

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isWin = process.platform === "win32";

function uid() {
	try {
		return userInfo().uid;
	} catch {
		return process.getuid?.() ?? 501;
	}
}

/** launchd label / systemd unit name / Windows task name for a service name. */
function serviceLabel(name) {
	if (isMac) {
		return name === "pi-web-ui" ? "com.xingshuyin.pi-web-ui" : `com.${name}.server`;
	}
	return name;
}

function launchAgentPlist(name) {
	return join(homedir(), "Library", "LaunchAgents", `${serviceLabel(name)}.plist`);
}

function systemdUnitPath(name) {
	return `/etc/systemd/system/${name}.service`;
}

/** Windows: per-user config dir (%APPDATA%\pi-web-ui) holding the ps1/vbs launchers + pid file. */
function winServiceDir() {
	return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "pi-web-ui");
}

function winCmdPath(name) {
	return join(winServiceDir(), `${name}.cmd`);
}

function winPs1Path(name) {
	return join(winServiceDir(), `${name}.ps1`);
}

function winVbsPath(name) {
	return join(winServiceDir(), `${name}.vbs`);
}

function winTaskXmlPath(name) {
	return join(winServiceDir(), `${name}.xml`);
}

/** Windows log file (per service name — multiple services must not share one log). */
function winLogPath(name) {
	return join(homedir(), name === "pi-web-ui" ? "pi-web-ui.log" : `pi-web-ui-${name}.log`);
}

/** True when a scheduled task with this name exists (schtasks exits 0). */
function winTaskExists(name) {
	return spawnSync("schtasks", ["/Query", "/TN", name], { stdio: "ignore" }).status === 0;
}

/** Windows: per-user autostart registry key (HKCU — writable without admin). */
function winRunKeyName() {
	return "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
}

/** True when the per-user autostart Run key value exists. */
function winRunKeyInstalled(name) {
	return (
		spawnSync("reg", ["query", `HKCU\\${winRunKeyName()}`, "/v", name], {
			stdio: "ignore",
		}).status === 0
	);
}

/** Set the per-user autostart Run key value (no admin needed for HKCU). */
function winRunKeySet(name, value) {
	run("reg", ["add", `HKCU\\${winRunKeyName()}`, "/v", name, "/t", "REG_SZ", "/d", value, "/f"], { silent: true });
}

/** Remove the per-user autostart Run key value (missing key is a no-op). */
function winRunKeyDelete(name) {
	run("reg", ["delete", `HKCU\\${winRunKeyName()}`, "/v", name, "/f"], { ignoreError: true, silent: true });
}

// ---------------------------------------------------------------------------
// 桌面快捷方式（server shortcut）
// ---------------------------------------------------------------------------

const SHORTCUT_LNK_NAME = "pi-web-ui.lnk"; // Windows 桌面快捷方式
const SHORTCUT_MAC_NAME = "pi-web-ui.command"; // macOS 双击启动器
const SHORTCUT_LINUX_NAME = "pi-web-ui.desktop"; // Linux 桌面图标

/** 快捷方式图标（品牌 .ico，随包发布；.lnk / .desktop 指向它）。 */
const APP_ICO_NAME = "pi-web-ui-logo.ico"; // 复制到用户目录后的稳定文件名（避开 pi-web-ui.ico —— Windows 对该路径有损坏的图标缓存残留，见 issue #xxx）
const APP_ICO_SOURCE = join(BIN_DIR, "..", "web", "public", "icon.ico"); // 包内品牌图标源文件（10 帧多分辨率，DPI 密度帧保证桌面/任务栏各尺寸颜色不失真）
/** Branded SVG logo (source of truth: web/public/favicon.svg) — used on Linux. */
const APP_SVG_PACKAGE = join(BIN_DIR, "..", "web", "public", "favicon.svg");

/** Windows: per-user copy of the branded .ico (stable path for the .lnk icon). */
function winIcoPath() {
	return join(winServiceDir(), APP_ICO_NAME);
}

/** Full path to Windows PowerShell. Prefers pwsh.exe (PowerShell 7) when it is
 * resolvable on PATH: some machines ship Windows PowerShell 5.1 as a broken
 * stub whose launch fails silently, so probe for a working shell first and
 * fall back to the built-in path. */
function winPowershell() {
	const which = spawnSync("where.exe", ["pwsh.exe"], { encoding: "utf8" });
	if (which.status === 0) {
		const first = (which.stdout ?? "").trim().split(/\r?\n/)[0];
		if (first) return first;
	}
	return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** Full path to wscript.exe — a console-free host (no conhost window, so no black
 * console box ever appears in the taskbar on double-click). Used as the .lnk target;
 * it launches the .ps1 hidden via a thin VBS launcher. */
function winWscript() {
	return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
}

/**
 * The node binary the launcher scripts must bake in: the executable this
 * process itself runs on. Under Bun this resolves to bun, so a Bun-hosted
 * install never bakes in pi.exe.
 */
function resolveNode() {
	return process.execPath;
}

/**
 * Resolve the real node binary. fnm/volta/nvm shims (e.g. fnm_multishells)
 * point into temp dirs that vanish when the installing shell exits — the
 * baked-in launcher scripts must use the stable real path instead.
 * Also applies resolveNode() so Bun-hosted pi never bakes in pi.exe.
 */
function realNode() {
	try {
		return realpathSync(resolveNode());
	} catch {
		return resolveNode();
	}
}

/** Windows: launcher ps1 the desktop .lnk runs (hidden). */
function winShortcutPs1Path(name) {
	return join(winServiceDir(), `${name}-shortcut.ps1`);
}

/** Windows: launcher vbs the desktop .lnk actually runs (wscript.exe, console-free). */
function winShortcutVbsPath(name) {
	return join(winServiceDir(), `${name}-shortcut.vbs`);
}

/** Windows: PID file of a shortcut-started (no scheduled task) instance. */
function winPidFilePath(name) {
	return join(winServiceDir(), `${name}.pid`);
}

/** Read the recorded PID of a shortcut-started Windows instance. */
function winReadPid(name) {
	try {
		const pid = Number(readFileSync(winPidFilePath(name), "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/** True when a PID exists (signal 0; EPERM means exists but not ours). */
function pidAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM";
	}
}

/** Single-quote a string for embedding in a POSIX shell script. */
function shQuote(s) {
	return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/**
 * Windows shortcut launcher. Double-click the .lnk → this script runs hidden:
 * server already up → just open the browser; autostart service installed
 * (HKCU Run key + wscript/VBS launcher) → start it (manageable via `server
 * stop`); otherwise run the server in the foreground of this hidden window and
 * record its PID so `server stop` / `server uninstall` can terminate it too.
 */
function buildWinShortcutPs1(env, cwd, taskName, url, logPath, pidPath) {
	const sets = Object.entries(env)
		.map(([k, v]) => `$env:${k} = ${psQuote(v)}`)
		.join("\r\n");
	const node = realNode();
	return [
		"# Generated by: pi-web-ui server shortcut (rerun to change)",
		"# Runs hidden from the desktop shortcut: if the server is already up it",
		"# opens the browser; the autostart service (if installed) is started;",
		"# otherwise the server runs in the foreground of this hidden window and",
		"# its PID is recorded so `server stop` / `server uninstall` can stop it.",
		"$ErrorActionPreference = 'Continue'",
		`$url = ${psQuote(url)}`,
		`$health = ${psQuote(url + "/api/health")}`,
		`$svcName = ${psQuote(taskName)}`,
		`$pidFile = ${psQuote(pidPath)}`,
		`$log = ${psQuote(logPath)}`,
		"",
		"function Test-Up {",
		"  try { return (Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }",
		"}",
		"function Open-Browser { Start-Process $url | Out-Null }",
		"",
		"# 已在运行 → 直接打开浏览器",
		"if (Test-Up) { Open-Browser; exit 0 }",
		"",
		"# 已安装自启服务（HKCU Run 键 + wscript 隐藏启动）→ 走服务启动（server stop 可管理）",
		"$vbs = Join-Path $env:APPDATA ('pi-web-ui\\' + $svcName + '.vbs')",
		"if (Test-Path $vbs) {",
		"  wscript.exe $vbs",
		"  for ($i = 0; $i -lt 120; $i++) {",
		"    Start-Sleep -Milliseconds 250",
		"    if (Test-Up) { Open-Browser; exit 0 }",
		"  }",
		"  Write-Host ('✖ pi-web-ui 服务未在 30 秒内就绪，请查看日志: ' + $log)",
		"  exit 1",
		"}",
		"",
		"# 未安装服务 → 在本隐藏窗口中前台运行（记录 PID，server stop 可停止）",
		`$PID | Out-File -Encoding ascii $pidFile`,
		sets,
		`Set-Location ${psQuote(cwd)}`,
		"# 后台轮询，就绪后打开浏览器（与前台 node 并行）",
		"$job = Start-Job -ScriptBlock { param($u)",
		"  $h = $u + '/api/health'",
		"  for ($i = 0; $i -lt 120; $i++) {",
		"    Start-Sleep -Milliseconds 250",
		"    try { if ((Invoke-WebRequest -Uri $h -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { Start-Process $u | Out-Null; break } } catch {}",
		"  }",
		"} -ArgumentList $url",
		`& ${psQuote(node)} ${HAS_SDK_HOOK ? `--import ${psQuote(pathToFileURL(SDK_HOOK).href)} ` : ""}${psQuote(SERVER_ENTRY)} *>> $log`,
		"Remove-Item $pidFile -ErrorAction SilentlyContinue",
		"",
	].join("\r\n");
}

/**
 * Build the tiny VBS launcher that starts a .ps1 *without* creating any console
 * host: wscript.exe has no console, and WScript.Shell.Run(…, 0, False) launches
 * the child hidden and returns at once (0 = hidden window, False = don't wait).
 * Used by both the desktop .lnk and the logon autostart service. Note:
 * `powershell -WindowStyle Hidden` alone is unreliable when Windows itself
 * spawns the process (Task Scheduler) — the console window can still show;
 * this launcher never creates one at all.
 */
function buildWinHiddenVbs(ps1Path) {
	// 可执行文件必须带引号：winPowershell() 常返回 `C:\Program Files\PowerShell\7\pwsh.exe`，
	// 含空格且未加引号时 WScript.Shell.Run 找不到文件，直接报 80070002（系统找不到指定的文件）。
	const cmd = `"${winPowershell()}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1Path}"`;
	// VBScript 字符串没有 \" 转义（也没有 \uXXXX），内嵌引号必须写成 ""；
	// 不能用 JSON.stringify —— 它输出 \" 会在 VBScript 里提前结束字符串（语句未结束 800A0401），
	// 且会把非 ASCII 路径转成 \uXXXX 字面量（wscript 不识别，中文用户名直接变成乱码路径）。
	const vbsCmd = cmd.replace(/"/g, '""');
	return [
		"Option Explicit",
		"Dim sh, cmd",
		'Set sh = CreateObject("WScript.Shell")',
		`cmd = "${vbsCmd}"`,
		"sh.Run cmd, 0, False",
		"Set sh = Nothing",
		"",
	].join("\r\n");
}

/**
 * Create the Windows desktop .lnk via WScript.Shell COM (correct Desktop path
 * even with OneDrive redirection). Target is powershell.exe with
 * -WindowStyle Hidden so nothing flashes on double-click.
 */
function installWinShortcut(opts) {
	const { name, port, cwd, dataDir, engine, host, agentDir } = serviceOptions(opts);
	const env = serviceEnv(port, cwd, dataDir, engine, host, agentDir);
	// The server binds 127.0.0.1 by default; PowerShell 7's Invoke-WebRequest
	// resolves `localhost` to ::1 first and hangs until TimeoutSec when nothing
	// listens on IPv6, making the health probe misfire ("server not running").
	// Pin the probe (and the opened URL) to the IPv4 loopback the server uses.
	const url = `http://127.0.0.1:${port}`;
	const ps1Path = winShortcutPs1Path(name);
	const ps1 = buildWinShortcutPs1(env, cwd, name, url, winLogPath(name), winPidFilePath(name));
	if (opts.print) {
		console.log(`# ${ps1Path}\n${ps1}`);
		return;
	}
	mkdirSync(dirname(ps1Path), { recursive: true });
	writeFileSync(ps1Path, "\uFEFF" + ps1, "utf8"); // PS 5.1 需要 BOM
	// wscript host + VBS launcher: no console window / taskbar black box on double-click.
	const vbsPath = winShortcutVbsPath(name);
	writeFileSync(vbsPath, "\uFEFF" + buildWinHiddenVbs(ps1Path), "utf16le"); // wscript 只认 UTF-16/ANSI，UTF-8 BOM 会报“无效字符”，中文路径用 utf16le + BOM
	// 把品牌图标准备好：复制到用户目录（.lnk 图标指向稳定路径）
	if (existsSync(APP_ICO_SOURCE)) {
		copyFileSync(APP_ICO_SOURCE, winIcoPath());
	} else {
		console.log(
			ZH
				? `⚠ 未找到品牌图标 ${APP_ICO_SOURCE}，快捷方式将使用默认图标`
				: `⚠ Brand icon not found ${APP_ICO_SOURCE}, shortcut will use the default icon`,
		);
	}
	const powershell = winPowershell();
	const ps = [
		"$ErrorActionPreference = 'Stop'",
		"$ws = New-Object -ComObject WScript.Shell",
		"$desktop = [Environment]::GetFolderPath('Desktop')",
		`$lnk = $ws.CreateShortcut((Join-Path $desktop ${psQuote(SHORTCUT_LNK_NAME)}))`,
		`$lnk.TargetPath = ${psQuote(winWscript())}`,
		`$lnk.Arguments = ${psQuote(vbsPath)}`,
		`$lnk.WorkingDirectory = ${psQuote(cwd)}`,
		"$lnk.Description = 'pi-web-ui — 双击启动服务并打开浏览器'",
		`$lnk.IconLocation = ${psQuote(winIcoPath())} + ',0'`,
		"$lnk.Save()",
		`Write-Output (Join-Path $desktop ${psQuote(SHORTCUT_LNK_NAME)})`,
	].join("\r\n");
	const res = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], {
		encoding: "utf8",
	});
	if (res.status !== 0) {
		fail(
			ZH
				? `创建桌面快捷方式失败: ${(res.stderr || res.stdout || "").trim()}`
				: `Failed to create desktop shortcut: ${(res.stderr || res.stdout || "").trim()}`,
		);
	}
	const lnk = (res.stdout ?? "").trim();
	console.log(ZH ? `✅ 已创建桌面快捷方式: ${lnk}` : `✅ Desktop shortcut created: ${lnk}`);
	console.log(
		ZH
			? `   双击 : 服务未运行则启动（隐藏窗口，无黑窗），就绪后自动打开浏览器`
			: `   Launch    : double-click starts the service if not running (hidden window, no console), auto-opens browser when ready`,
	);
	console.log(
		ZH
			? `   停止 : pi-web-ui server stop（快捷方式启动的实例也会一并停止）`
			: `   Stop      : pi-web-ui server stop (also stops instances launched by the shortcut)`,
	);
	console.log(ZH ? `   端口 : ${port}` : `   Port      : ${port}`);
	console.log(ZH ? `   目录 : ${cwd}` : `   Directory : ${cwd}`);
}

/** macOS: double-clickable .command launcher (the .lnk equivalent). */
function buildMacShortcut(label, plist, url, env) {
	const exports = Object.entries(env)
		.map(([k, v]) => `export ${k}=${shQuote(v)}`)
		.join("\n");
	const node = realNode();
	return `#!/bin/bash
# pi-web-ui 启动器 — generated by: pi-web-ui server shortcut
# 双击运行：确保服务在运行，然后打开浏览器。
#   · 已安装 launchd 服务（登录自启）→ kickstart，图标主要用于「启动 + 打开」
#   · 未安装服务 → 在本终端前台运行（关闭窗口即停止）
LABEL=${shQuote(label)}
PLIST=${shQuote(plist)}
URL=${shQuote(url)}
LOG=/tmp/pi-web-ui-shortcut.log
NODE=${shQuote(node)}
ENTRY=${shQuote(SERVER_ENTRY)}
SDK_HOOK_ARG=${HAS_SDK_HOOK ? `${shQuote("--import")} ${shQuote(SDK_HOOK)} ` : ""}
${exports}

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart "gui/$(id -u)/$LABEL"
elif [ -f "$PLIST" ]; then
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
else
  # 未安装服务：在本终端前台运行服务器（关闭窗口即停止）
  "$NODE" $SDK_HOOK_ARG"$ENTRY" >>"$LOG" 2>&1 &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null' EXIT
fi

# 等服务就绪后打开浏览器（最多约 30 秒）
for i in $(seq 1 120); do
  curl -sf "$URL/api/health" >/dev/null 2>&1 && break
  sleep 0.25
done
open "$URL"
if [ -n "\${SERVER_PID:-}" ]; then wait "$SERVER_PID"; fi
`;
}

function installMacShortcut(opts) {
	const { name, port, cwd, dataDir, engine, host, agentDir } = serviceOptions(opts);
	const url = `http://localhost:${port}`;
	const script = buildMacShortcut(
		serviceLabel(name),
		launchAgentPlist(name),
		url,
		serviceEnv(port, cwd, dataDir, engine, host, agentDir),
	);
	const path = join(homedir(), "Desktop", SHORTCUT_MAC_NAME);
	if (opts.print) {
		console.log(`# ${path}\n${script}`);
		return;
	}
	writeFileSync(path, script);
	chmodSync(path, 0o755);
	console.log(ZH ? `✅ 已创建桌面启动器: ${path}` : `✅ Desktop launcher created: ${path}`);
	console.log(
		ZH
			? `   双击 : 确保服务运行并打开浏览器；未安装服务时在本终端前台运行`
			: `   Launch    : double-click ensures the service is running and opens browser; runs in foreground in this terminal if service not installed`,
	);
	console.log(
		ZH
			? `   说明 : macOS 没有 Windows 式快捷方式，这是等价的 .command 启动器；`
			: `   Notes     : macOS has no Windows-style shortcuts; this is the equivalent .command launcher;`,
	);
	console.log(
		ZH
			? `          launchd 服务登录自启，图标主要用于快速「启动 + 打开浏览器」`
			: `               launchd service auto-starts at login, icon mainly for quick “start + open browser”`,
	);
	console.log(ZH ? `   端口 : ${port}` : `   Port      : ${port}`);
	console.log(ZH ? `   目录 : ${cwd}` : `   Directory : ${cwd}`);
}

/** Linux: launcher script run by the .desktop icon. */
function buildLinuxStartScript(unitName, url) {
	const log = join(homedir(), ".local", "share", "pi-web-ui", "pi-web-ui.log");
	const node = realNode();
	return `#!/bin/bash
# pi-web-ui 启动器 — generated by: pi-web-ui server shortcut
# 双击运行：确保服务在运行，然后打开浏览器。
#   · systemd 单元已安装 → systemctl start（系统单元需要授权，失败则前台运行）
#   · 未安装 → 在本进程前台运行（终端关闭即停止）
LOG=${shQuote(log)}
URL=${shQuote(url)}
NODE=${shQuote(node)}
ENTRY=${shQuote(SERVER_ENTRY)}
SDK_HOOK_ARG=${HAS_SDK_HOOK ? `${shQuote("--import")} ${shQuote(SDK_HOOK)} ` : ""}
UNIT=${shQuote(unitName)}.service

if ! curl -sf "$URL/api/health" >/dev/null 2>&1; then
  systemctl start "$UNIT" 2>/dev/null || true
  if ! curl -sf "$URL/api/health" >/dev/null 2>&1; then
    mkdir -p "$(dirname "$LOG")"
    "$NODE" $SDK_HOOK_ARG"$ENTRY" >>"$LOG" 2>&1 &
    SERVER_PID=$!
    trap 'kill "$SERVER_PID" 2>/dev/null' EXIT
  fi
fi

for i in $(seq 1 120); do
  curl -sf "$URL/api/health" >/dev/null 2>&1 && break
  sleep 0.25
done
xdg-open "$URL" >/dev/null 2>&1 &
if [ -n "\${SERVER_PID:-}" ]; then wait "$SERVER_PID"; fi
`;
}

function installLinuxShortcut(opts) {
	const { name, port } = serviceOptions(opts);
	const url = `http://localhost:${port}`;
	const scriptDir = join(homedir(), ".local", "share", "pi-web-ui");
	const scriptPath = join(scriptDir, `${name}-start.sh`);
	const desktopPath = join(homedir(), "Desktop", SHORTCUT_LINUX_NAME);
	const icoPath = join(scriptDir, APP_ICO_NAME); // 备用；优先 SVG
	const svgPath = join(scriptDir, "pi-web-ui.svg");
	const script = buildLinuxStartScript(name, url);
	const desktopIcon = existsSync(APP_SVG_PACKAGE) ? svgPath : APP_ICO_NAME;
	const desktop = `[Desktop Entry]
Version=1.0
Type=Application
Name=pi-web-ui
Comment=启动 pi-web-ui 服务并打开浏览器
Exec=${shQuote(scriptPath)}
Icon=${shQuote(desktopIcon)}
Terminal=false
Categories=Network;WebBrowser;
`;
	if (opts.print) {
		console.log(`# ${scriptPath}\n${script}`);
		console.log(`# ${desktopPath}\n${desktop}`);
		return;
	}
	mkdirSync(scriptDir, { recursive: true });
	// 品牌图标（缺失时跳过，桌面自动回退默认图标）
	if (existsSync(APP_SVG_PACKAGE)) copyFileSync(APP_SVG_PACKAGE, svgPath);
	else if (existsSync(APP_ICO_SOURCE)) copyFileSync(APP_ICO_SOURCE, icoPath);
	writeFileSync(scriptPath, script);
	chmodSync(scriptPath, 0o755);
	writeFileSync(desktopPath, desktop);
	chmodSync(desktopPath, 0o755);
	// GNOME 需要标记可信才能双击运行
	run("gio", ["set", desktopPath, "metadata::trusted", "true"], {
		ignoreError: true,
		silent: true,
	});
	console.log(ZH ? `✅ 已创建桌面图标: ${desktopPath}` : `✅ Desktop icon created: ${desktopPath}`);
	console.log(
		ZH
			? `   GNOME 若提示「不受信任的应用程序」，右键选择 Allow Launching`
			: `   If GNOME prompts “untrusted application”, right-click and choose Allow Launching`,
	);
	console.log(ZH ? `   端口 : ${port}` : `   Port      : ${port}`);
	console.log(ZH ? `   目录 : ${cwd}` : `   Directory : ${cwd}`);
}

/** Remove desktop shortcut artifacts created by `server shortcut`. */
function removeShortcut(name) {
	if (isWin) {
		for (const f of [winShortcutPs1Path(name), winShortcutVbsPath(name), winPidFilePath(name), winIcoPath()]) {
			if (existsSync(f)) rmSync(f);
		}
		spawnSync(
			winPowershell(),
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				`$d=[Environment]::GetFolderPath('Desktop');$p=Join-Path $d ${psQuote(SHORTCUT_LNK_NAME)};if(Test-Path $p){Remove-Item $p -Force}`,
			],
			{ stdio: "ignore" },
		);
	} else if (isMac) {
		const p = join(homedir(), "Desktop", SHORTCUT_MAC_NAME);
		if (existsSync(p)) rmSync(p);
	} else if (isLinux) {
		const p = join(homedir(), "Desktop", SHORTCUT_LINUX_NAME);
		if (existsSync(p)) rmSync(p);
		rmSync(join(homedir(), ".local", "share", "pi-web-ui"), {
			recursive: true,
			force: true,
		});
	}
}

/** Single-quote a string for embedding in a generated PowerShell script. */
function psQuote(s) {
	return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * Build the PowerShell launcher the autostart service runs. Windows never sees
 * a console from it: the HKCU Run key launches wscript.exe → VBS → powershell
 * (hidden), so no black box can appear. The script sets the env, cd's to the
 * workspace, records its PID to <name>.pid (for `server stop`), then runs node
 * inside a watchdog loop — if node exits, it restarts after 10s (same
 * philosophy as launchd KeepAlive / systemd Restart=always). `server stop`
 * force-kills the recorded PID tree, which takes the loop down with it.
 */
function buildWinStartPs1(env, cwd, logPath, pidPath) {
	const sets = Object.entries(env)
		.map(([k, v]) => `$env:${k} = ${psQuote(v)}`)
		.join("\r\n");
	return [
		"# Generated by: pi-web-ui server install (rerun to change)",
		"# Runs the server with no console window (wscript+VBS launcher) and",
		"# restarts it if it crashes (watchdog, like launchd/systemd).",
		sets,
		`Set-Location ${psQuote(cwd)}`,
		`$PID | Out-File -Encoding ascii ${psQuote(pidPath)}`,
		"try {",
		"  while ($true) {",
		`    & ${psQuote(realNode())} ${HAS_SDK_HOOK ? `--import ${psQuote(pathToFileURL(SDK_HOOK).href)} ` : ""}${psQuote(SERVER_ENTRY)} *>> ${psQuote(logPath)}`,
		"    Start-Sleep 10",
		"  }",
		"} finally {",
		`  Remove-Item ${psQuote(pidPath)} -ErrorAction SilentlyContinue`,
		"}",
		"",
	].join("\r\n");
}

function esc(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Start the autostart service now: wscript runs the VBS hidden and exits at once. */
function launchWinService(vbsPath) {
	const child = spawn(winWscript(), [vbsPath], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	child.unref();
}

/**
 * PID 文件记录的是看门狗 PowerShell 的 $PID（winPowershell() 可能选 pwsh.exe），
 * node 是它的子进程 —— 这三者是本服务实例的合理映像名。taskkill /T /F 是树级强杀，
 * PID 若已退出被系统复用就会误杀无辜进程，所以杀前必须核对映像名。
 */
const WIN_SERVICE_IMAGE_RE = /^(powershell|pwsh|node)\.exe$/i;

/** tasklist 查询 PID 对应的进程映像名；查询失败/无此进程返回 null（无法核实）。 */
function winPidImageName(pid) {
	const res = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
	if (res.status !== 0) return null;
	const line = (res.stdout ?? "").split(/\r?\n/).find((l) => l.trim());
	if (!line) return null; // tasklist 的 "INFO: 无任务" 输出没有 CSV 行
	return (line.match(/^"([^"]+)"/) ?? [])[1] ?? null;
}

/** Kill a running Windows instance via its PID file (whole tree). */
function stopWinInstance(name) {
	const pid = winReadPid(name);
	if (pid) {
		if (pidAlive(pid)) {
			// PID 可能已退出并被系统复用给别的进程：杀前核对映像名，不符则警告并跳过，
			// 绝不 taskkill /T /F 盲杀。macOS/Linux 无按 PID 杀的路径（launchctl/systemctl
			// 按服务单元管理），只有 Windows 需要这道核对。
			const image = winPidImageName(pid);
			if (image === null) {
				console.warn(
					ZH
						? `⚠ 无法核实 PID ${pid} 的进程映像名（tasklist 不可用或进程已消失），跳过强制结束以防误杀`
						: `⚠ Cannot verify the image name of PID ${pid} (tasklist unavailable or process gone), skipping force-kill to avoid killing an unrelated process`,
				);
			} else if (!WIN_SERVICE_IMAGE_RE.test(image)) {
				console.warn(
					ZH
						? `⚠ PID ${pid} 现在是 ${image}，不是本服务的进程（PID 可能已被复用），跳过强制结束`
						: `⚠ PID ${pid} is now ${image}, not a pi-web-ui process (PID may have been reused), skipping force-kill`,
				);
			} else {
				run("taskkill", ["/PID", String(pid), "/T", "/F"], {
					ignoreError: true,
					silent: true,
				});
				// taskkill /F 异步生效：等到进程树真正退出（restart 需要避免端口竞争）
				const deadline = Date.now() + 5000;
				while (Date.now() < deadline && pidAlive(pid)) {
					spawnSync("ping", ["-n", "2", "127.0.0.1"], { stdio: "ignore" });
				}
			}
		}
		rmSync(winPidFilePath(name), { force: true });
	}
}

/** Build the launchd plist XML. */
function buildPlist(label, cwd, env) {
	const entries = Object.entries(env)
		.map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by: pi-web-ui server install (do not edit by hand — rerun to change) -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(label)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${esc(NODE)}</string>
${
	HAS_SDK_HOOK ? `    <string>--import</string>\n    <string>${esc(SDK_HOOK)}</string>\n` : ""
}    <string>${esc(SERVER_ENTRY)}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <!-- Restart if it crashes -->
  <key>KeepAlive</key>
  <true/>

  <key>WorkingDirectory</key>
  <string>${esc(cwd)}</string>

  <key>EnvironmentVariables</key>
  <dict>
${entries}
  </dict>

  <key>StandardOutPath</key>
  <string>/tmp/pi-web-ui.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/pi-web-ui.err</string>
</dict>
</plist>
`;
}

/** systemd quoted strings use C-style escapes; %% prevents specifier expansion. */
function systemdQuote(value) {
	return JSON.stringify(String(value)).replace(/%/g, "%%");
}

/**
 * systemd paths (WorkingDirectory=) must NOT be quoted: unlike Environment= and
 * ExecStart=, the path directives do not strip surrounding double quotes, so
 * WorkingDirectory="/home/me/work" makes systemd fail with "path is not absolute".
 * The whole (trimmed) value is the path, so inner spaces need no escaping —
 * only % has to be doubled to survive specifier expansion.
 */
function systemdPath(value) {
	return String(value).replace(/%/g, "%%");
}

/** Build the systemd unit file. */
function buildUnit(cwd, env) {
	const envLines = Object.entries(env)
		.map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`)
		.join("\n");
	const lowPort = Number(env.PI_WEB_PORT) > 0 && Number(env.PI_WEB_PORT) < 1024;
	const capabilities = lowPort
		? "CapabilityBoundingSet=CAP_NET_BIND_SERVICE\nAmbientCapabilities=CAP_NET_BIND_SERVICE\n"
		: "";
	return `# Generated by: pi-web-ui server install (do not edit by hand — rerun to change)
[Unit]
Description=pi-web-ui — web chat for the pi coding agent
After=network.target

[Service]
Type=simple
User=${process.env.SUDO_USER ?? userInfo().username}
WorkingDirectory=${systemdPath(cwd)}
${envLines}
${capabilities}ExecStart=${JSON.stringify(NODE)}${HAS_SDK_HOOK ? ` --import ${JSON.stringify(SDK_HOOK)}` : ""} ${JSON.stringify(SERVER_ENTRY)}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

/** If not root on Linux, re-exec the same server command through sudo. */
function ensureRootForSystemctl() {
	if (typeof process.getuid === "function" && process.getuid() === 0) return;
	// process.argv = [node, <bin>, "server", <action>, ...rest] — forward
	// everything after "server" so flags like --port/--cwd survive.
	const res = spawnSync("sudo", [NODE, fileURLToPath(import.meta.url), "server", ...process.argv.slice(3)], {
		stdio: "inherit",
	});
	process.exit(res.status ?? 1);
}

/** Resolve the effective HTTP port: --port > $PI_WEB_PORT > 8787. */
function effectivePort(opts) {
	return String(opts.port ?? process.env.PI_WEB_PORT ?? "8787");
}

/**
 * 服务名（--name）统一校验。name 会被原样拼进 systemd unit 文件名
 * (/etc/systemd/system/<name>.service)、Windows 启动脚本/PID 文件路径
 * (%APPDATA%\pi-web-ui\<name>.ps1) 与 HKCU Run 键值名 —— 不限字符集时，
 * 路径分隔符/引号/空格都能进这些拼接点（路径穿越或 unit 内容注入）。
 * 收紧为：字母或数字开头，仅字母/数字/-/_，最长 64 字符。
 */
function serviceName(opts) {
	const name = opts.name ?? "pi-web-ui";
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name))
		fail(
			ZH
				? `无效服务名 "${name}"（仅限字母/数字/-/_，字母或数字开头，最长 64 字符）`
				: `Invalid service name "${name}" (alphanumeric, "-" and "_" only; must start with a letter or digit; max 64 chars)`,
		);
	return name;
}

/** Shared option normalization for install. */
function serviceOptions(opts) {
	const name = serviceName(opts);
	const port = effectivePort(opts);
	if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
		fail(ZH ? `无效端口: ${port}` : `Invalid port: ${port}`);
	}
	// 服务默认工作区（issue #295）：安装命令的当前目录不可靠（例如 Windows 提权提示符
	// 默认在 C:\WINDOWS\system32），且直接拿用户主目录当 agent cwd 会让 SDK 的
	// resourceLoader.reload 等同步目录扫描落在 $HOME 上 —— 家目录下的 iCloud 占位符、
	// 外部/网络卷坏挂载会让 scandir/open 在内核里挂起，整个事件循环假死（hello 后永远
	// 收不到 ready）。默认落到干净的 ~/pi-web-ui 子目录（不存在即建）；显式 --cwd /
	// PI_WEB_CWD 保持原语义（不存在则报错）。前台启动仍默认当前目录。
	const explicitCwd = opts.cwd ?? process.env.PI_WEB_CWD;
	const cwd = resolve(explicitCwd ?? join(homedir(), "pi-web-ui"));
	if (explicitCwd) {
		if (!existsSync(cwd)) fail(ZH ? `工作目录不存在: ${cwd}` : `Working directory does not exist: ${cwd}`);
	} else if (!existsSync(cwd)) {
		mkdirSync(cwd, { recursive: true });
	}
	let dataDir;
	if (opts.dataDir) {
		dataDir = resolve(opts.dataDir);
	} else if (process.env.PI_WEB_DATA_DIR) {
		dataDir = resolve(process.env.PI_WEB_DATA_DIR);
	}
	// 引擎/监听地址/agent 配置目录：flag 优先，环境变量后备（token 不走命令行，仅环境变量）。
	const engine = opts.engine ?? process.env.PI_WEB_ENGINE ?? "pi";
	if (engine !== "pi" && engine !== "dsh")
		fail(ZH ? `无效引擎: ${engine}（仅支持 pi / dsh）` : `Invalid engine: ${engine} (pi and dsh only)`);
	const host = opts.host ?? process.env.PI_WEB_HOST;
	const agentDir = opts.agentDir ? resolve(opts.agentDir) : process.env.PI_CODING_AGENT_DIR;
	return { name, port, cwd, dataDir, engine, host, agentDir };
}

function serviceEnv(port, cwd, dataDir, engine, host, agentDir, service = {}) {
	const env = {
		PI_WEB_PORT: port,
		PI_WEB_CWD: cwd,
	};
	// 启动来源标记（见 server/launch-origin.ts）：只有真正被平台服务管理器托管的
	// 启动器才写。桌面快捷方式 / .command 在「未安装服务」时是前台跑（退出不回来），
	// 不能带这个标记，所以它们不传 service。已装好的老服务没有这两个变量，服务端
	// 仍能靠运行时判据（XPC_SERVICE_NAME / INVOCATION_ID / PID 文件）认出来。
	if (service.name) {
		env.PI_WEB_LAUNCHED_BY = "service";
		env.PI_WEB_SERVICE_NAME = service.name;
	}
	// Interactive Windows tasks inherit the user's PATH; only systemd/launchd
	// run with a minimal environment that needs an explicit PATH.
	if (!isWin) env.PATH = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
	// Same for the locale: launchd/systemd drop LANG/LC_ALL, and a C-locale
	// shell garbles multibyte input in the terminal (UTF-8 continuation
	// bytes 0x80–0x9F rendered as C1 control chars). Bake the installing
	// shell's locale into the service env so spawned terminals are UTF-8.
	if (!isWin && process.env.LANG) env.LANG = process.env.LANG;
	if (!isWin && process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL;
	if (dataDir) env.PI_WEB_DATA_DIR = dataDir;
	if (engine === "dsh") env.PI_WEB_ENGINE = "dsh"; // 仅非默认引擎才烘焙，保持服务单元简洁
	if (host) env.PI_WEB_HOST = host;
	if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
	return env;
}

function installLaunchd(opts) {
	const { name, port, cwd, dataDir, engine, host, agentDir } = serviceOptions(opts);
	const label = serviceLabel(name);
	const plist = launchAgentPlist(name);
	const content = buildPlist(label, cwd, serviceEnv(port, cwd, dataDir, engine, host, agentDir, { name }));
	if (opts.print) {
		console.log(`# ${plist}\n${content}`);
		return;
	}
	// Unload any existing instance (ignore "not loaded"), then (re)install.
	run("launchctl", ["bootout", `gui/${uid()}/${label}`], {
		ignoreError: true,
		silent: true,
	});
	mkdirSync(dirname(plist), { recursive: true });
	writeFileSync(plist, content);
	run("launchctl", ["bootstrap", `gui/${uid()}`, plist]);
	console.log(ZH ? `✅ 已安装并启动 launchd 服务 ${label}` : `✅ launchd service installed and started ${label}`);
	console.log(ZH ? `   端口 : ${port}` : `   Port      : ${port}`);
	console.log(ZH ? `   目录 : ${cwd}` : `   Directory : ${cwd}`);
	console.log(ZH ? `   访问 : http://localhost:${port}` : `   URL       : http://localhost:${port}`);
	console.log(
		ZH ? `   日志 : /tmp/pi-web-ui.log  /tmp/pi-web-ui.err` : `   Log       : /tmp/pi-web-ui.log  /tmp/pi-web-ui.err`,
	);
	console.log(
		ZH
			? `   管理 : pi-web-ui server status|restart|stop|uninstall`
			: `   Manage    : pi-web-ui server status|restart|stop|uninstall`,
	);
	console.log(
		ZH
			? `   提示 : pi-web-ui server shortcut 可在桌面创建「一键启动」图标`
			: `   Tip       : pi-web-ui server shortcut creates a “one-click launch” icon on the desktop`,
	);
}

/** Elevate only the privileged operation, not the CLI that captures the user's environment.
 * Unit contents travel through stdin, never argv (which may expose the token via ps). */
function runSystemdRoot(command, args, input) {
	const root = typeof process.getuid === "function" && process.getuid() === 0;
	const result = spawnSync(root ? command : "sudo", root ? args : ["--", command, ...args], {
		input,
		stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
	});
	if (result.error)
		fail(ZH ? `无法执行 ${command}: ${result.error.message}` : `Cannot run ${command}: ${result.error.message}`);
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function installSystemd(opts) {
	const { name, port, cwd, dataDir, engine, host, agentDir } = serviceOptions(opts);
	const env = serviceEnv(port, cwd, dataDir, engine, host, agentDir, { name });
	if (process.env.PI_WEB_TOKEN !== undefined) env.PI_WEB_TOKEN = process.env.PI_WEB_TOKEN;
	const content = buildUnit(cwd, env);
	const unitPath = systemdUnitPath(name);
	if (opts.print) {
		console.log(`# ${unitPath}\n${content}`);
		return;
	}
	// Generated units can contain credentials. install also corrects an existing unit's mode.
	// Stage through a temp file: `install /dev/stdin` fails on some hosts (WSL) with
	// ENXIO when stdin is a pipe rather than a tty.
	const staged = join(tmpdir(), `pi-web-ui-${name}-${process.pid}.service`);
	writeFileSync(staged, content, { mode: 0o600 });
	try {
		runSystemdRoot("install", ["-m", "600", staged, unitPath]);
	} finally {
		rmSync(staged, { force: true });
	}
	runSystemdRoot("systemctl", ["daemon-reload"]);
	runSystemdRoot("systemctl", ["enable", `${name}.service`]);
	// enable --now does not restart an already-active unit after configuration changes.
	runSystemdRoot("systemctl", ["restart", `${name}.service`]);
	console.log(
		ZH ? `✅ 已安装并启动 systemd 服务 ${name}.service` : `✅ systemd service installed and started ${name}.service`,
	);
	console.log(ZH ? `   端口 : ${port}` : `   Port      : ${port}`);
	console.log(ZH ? `   目录 : ${cwd}` : `   Directory : ${cwd}`);
	console.log(ZH ? `   访问 : http://localhost:${port}` : `   URL       : http://localhost:${port}`);
	console.log(ZH ? `   日志 : journalctl -u ${name}.service -f` : `   Log       : journalctl -u ${name}.service -f`);
	console.log(
		ZH
			? `   管理 : pi-web-ui server status|restart|stop|uninstall`
			: `   Manage    : pi-web-ui server status|restart|stop|uninstall`,
	);
	console.log(
		ZH
			? `   提示 : pi-web-ui server shortcut 可在桌面创建「一键启动」图标`
			: `   Tip       : pi-web-ui server shortcut creates a “one-click launch” icon on the desktop`,
	);
}

function uninstallLaunchd(opts) {
	const name = serviceName(opts);
	const label = serviceLabel(name);
	const plist = launchAgentPlist(name);
	run("launchctl", ["bootout", `gui/${uid()}/${label}`], {
		ignoreError: true,
		silent: true,
	});
	if (existsSync(plist)) rmSync(plist);
	removeShortcut(name);
	console.log(
		ZH
			? `🗑  已卸载 ${label}（plist 已删除，不再开机自启）`
			: `🗑  Uninstalled ${label} (plist deleted, no longer auto-starts at login)`,
	);
	console.log(ZH ? `🗑  已移除桌面快捷方式` : `🗑  Desktop shortcut removed`);
}

function uninstallSystemd(opts) {
	const name = serviceName(opts);
	ensureRootForSystemctl();
	run("systemctl", ["disable", "--now", `${name}.service`], {
		ignoreError: true,
	});
	const unitPath = systemdUnitPath(name);
	if (existsSync(unitPath)) rmSync(unitPath);
	run("systemctl", ["daemon-reload"]);
	removeShortcut(name);
	console.log(
		ZH
			? `🗑  已卸载 ${name}.service（不再开机自启）`
			: `🗑  Uninstalled ${name}.service (no longer auto-starts at login)`,
	);
	console.log(ZH ? `🗑  已移除桌面快捷方式` : `🗑  Desktop shortcut removed`);
}

function installWindows(opts) {
	const { name, port, cwd, dataDir, engine, host, agentDir } = serviceOptions(opts);
	const env = serviceEnv(port, cwd, dataDir, engine, host, agentDir, { name });
	const ps1Path = winPs1Path(name);
	const vbsPath = winVbsPath(name);
	const pidPath = winPidFilePath(name);
	const ps1 = buildWinStartPs1(env, cwd, winLogPath(name), pidPath);
	const vbs = buildWinHiddenVbs(ps1Path);
	// HKCU Run 键值：wscript.exe 以隐藏方式启动 VBS（无控制台，登录后自启）
	const runValue = `"${winWscript()}" "${vbsPath}"`;
	if (opts.print) {
		console.log(`# ${ps1Path}\n${ps1}`);
		console.log(`# ${vbsPath}\n${vbs}`);
		console.log(ZH ? `# 登录自启（HKCU Run 键，无需管理员）` : `# Login auto-start (HKCU Run key, no admin required)`);
		console.log(`  reg add "HKCU\\${winRunKeyName()}" /v ${name} /t REG_SZ /d "${runValue}" /f`);
		return;
	}
	mkdirSync(dirname(ps1Path), { recursive: true });
	// UTF-8 with BOM: Windows PowerShell 5.1 misreads BOM-less UTF-8 as ANSI.
	writeFileSync(ps1Path, "\uFEFF" + ps1, "utf8");
	// wscript host + VBS launcher: no console window / taskbar black box ever.
	writeFileSync(vbsPath, "\uFEFF" + vbs, "utf16le"); // wscript 只认 UTF-16/ANSI，UTF-8 BOM 会报“无效字符”
	// 迁移：移除旧版 .cmd 包装与历史计划任务（普通用户下 schtasks 无法创建，改为 Run 键）。
	if (existsSync(winCmdPath(name))) rmSync(winCmdPath(name));
	if (winTaskExists(name)) {
		run("schtasks", ["/End", "/TN", name], {
			ignoreError: true,
			silent: true,
		});
		// /End 异步生效：稍候再删任务，避免新实例与旧实例端口竞争
		spawnSync("ping", ["-n", "2", "127.0.0.1"], { stdio: "ignore" });
		run("schtasks", ["/Delete", "/TN", name, "/F"], {
			ignoreError: true,
			silent: true,
		});
	}
	winRunKeySet(name, runValue);
	launchWinService(vbsPath);
	console.log(
		ZH
			? `✅ 已安装并启动 ${name}（登录自启 · HKCU Run 键 · 无需管理员）`
			: `✅ Installed and started ${name} (login auto-start · HKCU Run key · no admin required)`,
	);
	console.log(ZH ? `   窗口 : wscript 隐藏启动，无黑窗` : `   Window    : wscript hidden launch, no console`);
	console.log(ZH ? `   端口 : ${port}` : `   Port      : ${port}`);
	console.log(ZH ? `   目录 : ${cwd}` : `   Directory : ${cwd}`);
	console.log(ZH ? `   访问 : http://localhost:${port}` : `   URL       : http://localhost:${port}`);
	console.log(ZH ? `   日志 : ${winLogPath(name)}` : `   Log       : ${winLogPath(name)}`);
	console.log(
		ZH
			? `   说明 : 崩溃后 10 秒自动重启（看门狗）；stop 停止，uninstall 移除`
			: `   Notes     : auto-restarts 10 s after crash (watchdog); stop to stop, uninstall to remove`,
	);
	console.log(
		ZH
			? `   管理 : pi-web-ui server status|restart|stop|uninstall`
			: `   Manage    : pi-web-ui server status|restart|stop|uninstall`,
	);
	console.log(
		ZH
			? `   提示 : pi-web-ui server shortcut 可在桌面创建「一键启动」图标`
			: `   Tip       : pi-web-ui server shortcut creates a “one-click launch” icon on the desktop`,
	);
}

function uninstallWindows(opts) {
	const name = serviceName(opts);
	winRunKeyDelete(name);
	// 历史计划任务（旧版本 install 可能注册过）
	if (winTaskExists(name)) {
		run("schtasks", ["/Delete", "/TN", name, "/F"], { ignoreError: true });
	}
	// 运行中的实例（服务或快捷方式启动，均记录 PID 文件）
	stopWinInstance(name);
	for (const f of [winCmdPath(name), winPs1Path(name), winVbsPath(name), winTaskXmlPath(name)]) {
		if (existsSync(f)) rmSync(f);
	}
	removeShortcut(name);
	console.log(
		ZH
			? `🗑  已卸载 ${name}（登录自启已移除，不再开机自启）`
			: `🗑  Uninstalled ${name} (login auto-start removed, no longer auto-starts at login)`,
	);
	console.log(ZH ? `🗑  已移除桌面快捷方式` : `🗑  Desktop shortcut removed`);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Local control socket (status / quiesce / unquiesce). The server listens on
// a mode-0600 Unix socket (POSIX) or a named pipe (Windows) under its data
// dir; same path rules as server/control-socket.ts so the CLI and server
// always agree without sharing code.
// ---------------------------------------------------------------------------

/** Resolve the control socket path for the given options. */
function controlPath(opts) {
	const dir = opts.dataDir
		? resolve(opts.dataDir)
		: process.env.PI_WEB_DATA_DIR
			? resolve(process.env.PI_WEB_DATA_DIR)
			: join(homedir(), ".pi-web");
	return isWin ? `\\\\.\\pipe\\pi-web-ui-${effectivePort(opts)}` : join(dir, "pi-web-ui.sock");
}

/** Send one control command to a RUNNING server; resolves null if unreachable. */
function controlCommand(opts, cmd) {
	const path = controlPath(opts);
	return new Promise((resolvePromise) => {
		const sock = createConnection(path);
		let done = false;
		const finish = (v) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			sock.destroy();
			resolvePromise(v);
		};
		const timer = setTimeout(() => finish(null), 3000);
		let buf = "";
		sock.on("connect", () => sock.write(JSON.stringify({ cmd }) + "\n"));
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				try {
					finish(JSON.parse(buf.slice(0, nl)));
				} catch {
					finish(null);
				}
			}
		});
		sock.on("error", () => finish(null));
		sock.on("close", () => finish(null));
	});
}

/** Append the live server status (via the control socket) to `server status`. */
async function printLiveStatus(opts) {
	const st = await controlCommand(opts, "status");
	if (!st || !st.ok) {
		console.log(
			ZH
				? "   (服务器未运行或控制通道不可达 — 启动后可查 server status 实时信息)"
				: "   (server not running or control channel unreachable — start it, then check server status for live info)",
		);
		return;
	}
	console.log(ZH ? "   --- 实时状态 (control socket) ---" : "   --- live status (control socket) ---");
	console.log(ZH ? `   版本 : ${st.version} · PID ${st.pid}` : `   Version   : ${st.version} · PID ${st.pid}`);
	console.log(ZH ? `   目录 : ${st.cwd}` : `   Directory : ${st.cwd}`);
	// 启动来源（server/launch-origin.ts）：有 supervisor = 这个进程退出后会被自动
	// 拉起（server restart / 更新面板的「重启服务」才有意义）。
	console.log(
		ZH
			? `   启动 : ${
					st.service
						? `pi-web-ui 服务（${st.service.supervisor} · ${st.service.name}）`
						: "前台 / 开发模式（无 supervisor，退出不自动重启）"
				}`
			: `   Started   : ${
					st.service
						? `pi-web-ui service (${st.service.supervisor} · ${st.service.name})`
						: "foreground / dev mode (no supervisor, exit does not auto-restart)"
				}`,
	);
	console.log(
		ZH
			? `   排空 : ${st.quiesced ? `是（自 ${new Date(st.quiescedSince).toLocaleString()}）` : "否"}`
			: `   Drain     : ${st.quiesced ? `yes (since ${new Date(st.quiescedSince).toLocaleString()})` : "no"}`,
	);
	console.log(
		ZH
			? `   连接 : ${st.connectedClients} 个浏览器 · ${st.activeConversations} 个运行中对话 · ${st.pendingMessages} 条排队消息`
			: `   Conns     : ${st.connectedClients} browser · ${st.activeConversations} active session · ${st.pendingMessages} queued messages`,
	);
}

/** `server quiesce|unquiesce` — toggle the admission gate on a RUNNING server. */
async function setQuiesce(opts, on) {
	const st = await controlCommand(opts, on ? "quiesce" : "unquiesce");
	if (!st || !st.ok) {
		fail(
			ZH
				? `服务器未运行或控制通道不可达（${controlPath(opts)}）`
				: `Server not running or control channel unreachable (${controlPath(opts)})`,
		);
	}
	console.log(
		on
			? ZH
				? "⏸  已进入排空模式（quiesce）：拒绝新的对话/消息/编辑，存量运行继续跑完。\n" +
					"    跑完后用 pi-web-ui server unquiesce 恢复。"
				: "⏸  Quiesce mode active: new conversations/messages/edits rejected; existing runs continue to completion.\n" +
					"    Use pi-web-ui server unquiesce to resume when done."
			: ZH
				? "▶  已解除排空模式（unquiesce）：恢复接收新的对话/消息/编辑。"
				: "▶  Unquiesced: now accepting new conversations/messages/edits.",
	);
}

function controlService(action, opts) {
	const name = serviceName(opts);

	if (isMac) {
		const label = serviceLabel(name);
		const target = `gui/${uid()}/${label}`;
		const loaded = () => spawnSync("launchctl", ["print", target], { stdio: "ignore" }).status === 0;

		if (action === "status") {
			if (loaded()) {
				const res = spawnSync("launchctl", ["print", target], {
					encoding: "utf8",
				});
				const state = (res.stdout.match(/state = (\w+)/) ?? [])[1] ?? "loaded";
				console.log(
					ZH ? `${label}: ${state}（已加载，开机自启中）` : `${label}: ${state} (loaded, auto-start enabled)`,
				);
			} else {
				console.log(
					ZH
						? `${label}: 未安装（运行 pi-web-ui server install 安装）`
						: `${label}: not installed (run pi-web-ui server install)`,
				);
			}
			return;
		}

		if (action === "start") {
			if (loaded()) {
				run("launchctl", ["kickstart", target]);
			} else {
				const plist = launchAgentPlist(name);
				if (!existsSync(plist)) {
					fail(
						ZH
							? `找不到 ${plist}，请先运行 pi-web-ui server install`
							: `Cannot find ${plist}, please run pi-web-ui server install first`,
					);
				}
				run("launchctl", ["bootstrap", `gui/${uid()}`, plist]);
			}
			console.log(ZH ? `✅ 已启动 ${label}` : `✅ Started ${label}`);
			return;
		}

		if (action === "restart") {
			if (!loaded())
				fail(
					ZH ? `${label} 未加载，请先 pi-web-ui server start` : `${label} not loaded, run pi-web-ui server start first`,
				);
			run("launchctl", ["kickstart", "-k", target]);
			console.log(ZH ? `✅ 已重启 ${label}` : `✅ Restarted ${label}`);
			return;
		}

		if (action === "stop") {
			run("launchctl", ["bootout", target], {
				ignoreError: true,
				silent: true,
			});
			console.log(
				ZH
					? `⏹  已停止 ${label}（已卸载，不再开机自启；start 恢复）`
					: `⏹  Stopped ${label} (uninstalled, auto-start removed; start to resume)`,
			);
			return;
		}

		fail(ZH ? `未知操作: ${action}` : `Unknown operation: ${action}`);
	}

	if (isLinux) {
		ensureRootForSystemctl();
		if (action === "status") {
			run("systemctl", ["status", `${name}.service`, "--no-pager"]);
			return;
		}
		run("systemctl", [action, `${name}.service`]);
		console.log(`✅ ${action} ${name}.service`);
		return;
	}

	if (isWin) {
		const installed = winRunKeyInstalled(name);
		const legacy = !installed && winTaskExists(name); // 旧版计划任务安装（未迁移）

		if (action === "status") {
			const pid = winReadPid(name);
			const instAlive = pid && pidAlive(pid);
			if (legacy) {
				console.log(
					ZH ? `${name}: 旧版计划任务安装（未迁移）` : `${name}: legacy scheduled task install (not migrated)`,
				);
				console.log(
					ZH
						? `   提示 : 重新执行 server install 可迁移到登录自启模式（删除任务，无需管理员）`
						: `   Hint      : re-run server install to migrate to login auto-start mode (removes task, no admin required)`,
				);
				if (instAlive) console.log(ZH ? `   实例 : 运行中 (PID ${pid})` : `   Instance  : running (PID ${pid})`);
				return;
			}
			if (!installed) {
				console.log(
					ZH
						? `${name}: 未安装（运行 pi-web-ui server install 安装）`
						: `${name}: not installed (run pi-web-ui server install)`,
				);
				if (instAlive)
					console.log(ZH ? `   快捷方式实例 : 运行中 (PID ${pid})` : `   Shortcut  : running (PID ${pid})`);
				return;
			}
			console.log(
				ZH
					? `${name}: 已安装（登录自启 · HKCU Run 键 · wscript 隐藏启动，无黑窗）`
					: `${name}: installed (login auto-start · HKCU Run key · wscript silent launch, no console window)`,
			);
			if (instAlive) {
				console.log(ZH ? `   运行状态 : 运行中 (PID ${pid})` : `   Status    : running (PID ${pid})`);
				console.log(ZH ? `   日志 : ${winLogPath(name)}` : `   Log       : ${winLogPath(name)}`);
			} else {
				console.log(
					ZH
						? `   运行状态 : 未运行（pi-web-ui server start 启动）`
						: `   Status    : not running (pi-web-ui server start to launch)`,
				);
			}
			return;
		}

		if (action === "start") {
			if (legacy) {
				run("schtasks", ["/Run", "/TN", name]);
				console.log(
					ZH
						? `✅ 已启动 ${name}（旧版计划任务，建议重新 server install 迁移）`
						: `✅ Started ${name} (legacy scheduled task, recommend re-running server install to migrate)`,
				);
				return;
			}
			if (!installed)
				fail(
					ZH
						? `${name} 不存在，请先运行 pi-web-ui server install`
						: `${name} does not exist, run pi-web-ui server install first`,
				);
			const pid = winReadPid(name);
			if (pid && pidAlive(pid)) {
				console.log(ZH ? `✅ ${name} 已在运行 (PID ${pid})` : `✅ ${name} already running (PID ${pid})`);
				return;
			}
			launchWinService(winVbsPath(name));
			console.log(ZH ? `✅ 已启动 ${name}` : `✅ Started ${name}`);
			return;
		}

		if (action === "restart") {
			if (legacy) {
				run("schtasks", ["/End", "/TN", name], {
					ignoreError: true,
					silent: true,
				});
				run("schtasks", ["/Run", "/TN", name]);
				console.log(
					ZH
						? `✅ 已重启 ${name}（旧版计划任务，建议重新 server install 迁移）`
						: `✅ Restarted ${name} (legacy scheduled task, recommend re-running server install to migrate)`,
				);
				return;
			}
			if (!installed)
				fail(
					ZH
						? `${name} 不存在，请先运行 pi-web-ui server install`
						: `${name} does not exist, run pi-web-ui server install first`,
				);
			stopWinInstance(name);
			launchWinService(winVbsPath(name));
			console.log(ZH ? `✅ 已重启 ${name}` : `✅ Restarted ${name}`);
			return;
		}

		if (action === "stop") {
			if (legacy) {
				run("schtasks", ["/End", "/TN", name], {
					ignoreError: true,
					silent: true,
				});
				stopWinInstance(name);
				console.log(
					ZH
						? `⏹  已停止 ${name}（旧版计划任务；重新 server install 可迁移到登录自启）`
						: `⏹  Stopped ${name} (legacy scheduled task; re-run server install to migrate to login auto-start)`,
				);
				return;
			}
			stopWinInstance(name);
			console.log(
				ZH
					? `⏹  已停止 ${name}（自启保留；uninstall 移除）`
					: `⏹  Stopped ${name} (auto-start preserved; uninstall to remove)`,
			);
			return;
		}

		fail(ZH ? `未知操作: ${action}` : `Unknown operation: ${action}`);
	}

	fail(
		ZH
			? `不支持的系统服务平台: ${process.platform}（仅 macOS / Linux / Windows）`
			: `Unsupported system service platform: ${process.platform} (macOS / Linux / Windows only)`,
	);
}

async function serverCmd(argv) {
	const { opts, positionals } = parseFlags(argv);
	if (opts.help) {
		console.log(HELP);
		return;
	}
	if (positionals.length === 0) {
		console.log(HELP);
		console.log(ZH ? "--- 当前服务状态 ---" : "--- Current service status ---");
		controlService("status", opts);
		return;
	}
	const action = positionals[0];
	if (positionals.length > 1)
		fail(
			ZH ? `多余的参数: ${positionals.slice(1).join(" ")}` : `Unexpected argument: ${positionals.slice(1).join(" ")}`,
		);
	switch (action) {
		case "shortcut": {
			if (isWin) {
				installWinShortcut(opts);
			} else if (isMac) {
				installMacShortcut(opts);
			} else if (isLinux) {
				installLinuxShortcut(opts);
			} else {
				fail(
					ZH ? `不支持的系统服务平台: ${process.platform}` : `Unsupported system service platform: ${process.platform}`,
				);
			}
			break;
		}
		case "install": {
			if (isMac) {
				installLaunchd(opts);
			} else if (isLinux) {
				installSystemd(opts);
			} else if (isWin) {
				installWindows(opts);
			} else {
				fail(
					ZH ? `不支持的系统服务平台: ${process.platform}` : `Unsupported system service platform: ${process.platform}`,
				);
			}
			break;
		}
		case "uninstall": {
			if (isMac) {
				uninstallLaunchd(opts);
			} else if (isLinux) {
				uninstallSystemd(opts);
			} else if (isWin) {
				uninstallWindows(opts);
			} else {
				fail(
					ZH ? `不支持的系统服务平台: ${process.platform}` : `Unsupported system service platform: ${process.platform}`,
				);
			}
			break;
		}
		case "start":
		case "stop":
		case "restart":
			controlService(action, opts);
			break;
		case "status":
			controlService("status", opts);
			await printLiveStatus(opts);
			break;
		case "quiesce":
			await setQuiesce(opts, true);
			break;
		case "unquiesce":
			await setQuiesce(opts, false);
			break;
		default:
			fail(
				ZH
					? `未知操作: ${action}（install / shortcut / uninstall / start / stop / restart / status / quiesce / unquiesce）`
					: `Unknown operation: ${action} (install / shortcut / uninstall / start / stop / restart / status / quiesce / unquiesce)`,
			);
	}
}

async function main() {
	checkNodeVersion();
	const argv = process.argv.slice(2);
	if (argv.length === 0) {
		await startForeground({});
		return;
	}
	const first = argv[0];
	if (first === "--version" || first === "-v") {
		console.log(pkg.version);
		return;
	}
	if (first === "--help" || first === "-h") {
		console.log(HELP);
		return;
	}
	if (first === "server") {
		await serverCmd(argv.slice(1));
		return;
	}
	// One-shot server with optional --port/--cwd/--data-dir overrides.
	const { opts, positionals } = parseFlags(argv);
	if (opts.help) {
		console.log(HELP);
		return;
	}
	if (positionals.length > 0)
		fail(
			ZH ? `未知命令: ${positionals[0]}（--help 查看用法）` : `Unknown command: ${positionals[0]} (--help for usage)`,
		);
	await startForeground(opts);
}

main().catch((err) => {
	console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
