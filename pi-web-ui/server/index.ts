/**
 * pi-web-ui server entry.
 *
 * - Serves the built frontend (web/dist) in production; in dev, Vite serves it
 *   on :5173 and proxies /ws to this server.
 * - Exposes /api/health and a WebSocket endpoint at /ws carrying the chat
 *   protocol defined in protocol.ts.
 *
 * Env:
 *   PI_WEB_PORT     HTTP port (default 8787)
 *   PI_WEB_CWD      workspace the agent operates in (default: process.cwd())
 *   PI_WEB_DATA_DIR where per-client UI state is stored (client-state.json,
 *   default: <home>/.pi-web). Chat sessions are NOT stored here — they live
 *   in the pi agent's global TUI session dir (~/.pi/agent/sessions/--<cwd>--/)
 *   via the SDK default, so this web UI, the dev instance, and the pi CLI/TUI
 *   all share one conversation list per project.
 *   PI_CODING_AGENT_DIR  pi config dir (auth/models/skills) — passed to the SDK
 */
// MUST be imported before the SDK is loaded so on-disk patches apply cleanly.
import "./patch-remote-catalog.js";
import "./patch-turn-end-boundary.js";
import { syncHarnessEnv } from "./harness-env.js";
syncHarnessEnv();
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import { basename, delimiter, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import compression from "compression";
import { WebSocket, WebSocketServer } from "ws";
import { VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import { sdkCopies, sdkOriginNote } from "./sdk-origin.js";
import { PROTOCOL_VERSION } from "./protocol-version.js";
import { AgentService, workspacePath, QuiesceRejectedError } from "./agent-service.js";
import { ClientStateStore } from "./client-state.js";
import { WS_MAX_PAYLOAD_BYTES, isAbsoluteWirePath, wireToAbs } from "./files-service.js";
import { httpHostAllowed } from "./host-guard.js";
import { registerFileTransferRoutes } from "./file-transfer-routes.js";
import { initAttachmentStore, readAttachment } from "./attachment-store.js";
import { isAudioFile, previewKind } from "./text-sniff.js";
import { isOfficeFile, OFFICE_MAX_FILE_BYTES, unzipFiles } from "./office-parse.js";
import { startControlServer } from "./control-socket.js";
import { scheduleUploadCleanup } from "./uploads.js";
import { configureGoalLog } from "./goal-history-log.js";
import { registerLoopRoutes } from "./loop/routes.js";
import { ensureWindowsBash, windowsBashDir } from "./ensure-bash.js";
import { listThemes, readThemeCss, resolveThemeFile } from "./themes.js";
import { isManaged, managedRefusal } from "./managed.js";
import { launchOrigin, toServiceInfo } from "./launch-origin.js";
import { parseTabs, tabsRefusal } from "./tabs.js";
import { recordUnknownWsType } from "./ws-unknown-types.js";
import { MessageWindowTap, readMessageWindowConfig } from "./message-window.js";
import { validateClientId } from "./ws-client-id.js";
import { PendingCommandQueue } from "./ws-pending-queue.js";
import {
	installPack,
	isKnownPack,
	listPacks,
	loadServerStrings,
	readPackFile,
	removePack,
	resolveSystemDefaultLocale,
	unloadServerStrings,
} from "./locales.js";
import { createHostMetricsSampler } from "./host-metrics.js";
import { SchedulerStore } from "./scheduler-tasks.js";
import { initHttpProxy } from "./http-proxy.js";
import { globalLspPool } from "./lsp-tool.js";
import { buildPiWebTokenCookie, decodeCookieToken, isTlsRequest } from "./auth-cookie.js";
import { getAppVersion, getPkgRoot } from "./pkg-info.js";
import {
	handleFileMessage,
	handleWorktreeMessage,
	handleBgServerMessage,
	handlePresetAndDshMessage,
	handleModelAndProviderMessage,
	handleTerminalMessage,
	handleSessionLifecycleMessage,
	handlePlanAndGoalMessage,
	handleScheduleMessage,
	handleSettingsMessage,
	handleInteractiveResponseMessage,
} from "./dispatch-domain-handlers.js";
import type {
	ClientMessage,
	UiApprovalRule,
	UiLayoutPrefs,
	CommandDef,
	PromptAttachment,
	ServerMessage,
	UiServiceInfo,
	UiSubagentTemplate,
	AgentEngineCapabilities,
} from "./protocol.js";

/** Strip npm-injected env (`npm start` exports `npm_config_*` / `npm_package_*` /
 *  `npm_lifecycle_*` into every child). Anything this server spawns — shells,
 *  `pi update` — would otherwise inherit `npm_config_allow_scripts`, which npm
 *  maps to its env config layer and rejects in project-scoped installs
 *  (EALLOWSCRIPTS). The unit keeps `npm ci && npm run build && npm start`;
 *  this is the single scrub point so no wrapper is needed. */
for (const k of Object.keys(process.env)) {
	if (
		k === "npm_config_allow_scripts" ||
		k.startsWith("npm_config_") ||
		k.startsWith("npm_package_") ||
		k.startsWith("npm_lifecycle_")
	) {
		delete (process.env as Record<string, string | undefined>)[k];
	}
}

/** 从 CLI 参数中取 flag 值：支持 --flag value 与 --flag=value 两种写法。
 *  让 `node dist/server/index.js --host 0.0.0.0 --port 9000` 这类直接启动也能生效，
 *  而不只是经由 bin/pi-web-ui.mjs 的 env 转发。bin 仍是主入口，此处仅作兜底。 */
function cliFlag(name: string): string | undefined {
	const eq = `${name}=`;
	for (let i = 2; i < process.argv.length; i++) {
		const a = process.argv[i];
		if (a === name && i + 1 < process.argv.length) return process.argv[i + 1];
		if (a.startsWith(eq)) return a.slice(eq.length);
	}
	return undefined;
}

const PORT = Number(cliFlag("--port") ?? process.env.PI_WEB_PORT ?? 8787);
// #506：直启路径与 bin 层对齐做端口校验——`--port abc` / `PI_WEB_PORT=abc` 之前会
// listen(NaN) 被 Node 当 0 绑到随机端口，且日志打印 http://localhost:NaN。
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
	console.error(`无效端口: ${cliFlag("--port") ?? process.env.PI_WEB_PORT} (--port / PI_WEB_PORT)`);
	console.error(`Invalid port: ${cliFlag("--port") ?? process.env.PI_WEB_PORT} (--port / PI_WEB_PORT)`);
	process.exit(1);
}
const CWD = resolve(cliFlag("--cwd") ?? process.env.PI_WEB_CWD ?? process.cwd());
const DATA_DIR = resolve(cliFlag("--data-dir") ?? process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web"));
// The data dir is where the control socket, client state, themes and
// uploads live, but nothing guarantees it exists on a first run (a fresh
// `server install` never creates it). The control socket binds at startup —
// before any store gets a chance to mkdir its own subdirectory — and bind()
// into a missing directory fails with EACCES, silently disabling the whole
// control channel (status/quiesce) for that process. Create it up front.
try {
	mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
	console.warn(`[data] 无法创建数据目录 ${DATA_DIR}: ${(err as Error).message}`);
}
try {
	mkdirSync(CWD, { recursive: true });
} catch (err) {
	console.warn(`[cwd] 无法创建工作区目录 ${CWD}: ${(err as Error).message}`);
}
// issue #295：工作区直接就是家目录时，SDK 初始化期的同步目录扫描会落在 $HOME 上
// （iCloud 占位符/外部卷坏挂载 → scandir/open 内核挂起 → 事件循环假死，hello 后无
// ready）。新装服务默认已是 ~/pi-web-ui（见 bin/pi-web-ui.mjs serviceOptions）；
// 老服务若仍指着家目录，在此提示一次，`server install` 重装即迁移。
try {
	if (resolve(CWD) === resolve(homedir())) {
		console.warn(
			`[ws] 工作区为用户主目录 ${CWD}：目录扫描可能因外部卷/同步盘挂载而长时间阻塞，` +
				`建议用 \`pi-web-ui server install --cwd <项目目录>\` 重装迁移。`,
		);
	}
} catch {
	/* 路径比较失败不影响启动 */
}
// Dev-no-cache setting read without a ClientStateStore instance (the index.html
// route runs before any client attaches). Reads the same global settings blob.
function readDevNoCacheSetting(): boolean | undefined {
	try {
		const raw = readFileSync(join(DATA_DIR, "client-state.json"), "utf8");
		const all = JSON.parse(raw) as Record<string, { settings?: { devNoCache?: unknown } }>;
		const v = all["__settings__"]?.settings?.devNoCache;
		return typeof v === "boolean" ? v : undefined;
	} catch {
		return undefined;
	}
}

/** Bind address. Default is loopback ONLY — the service is a local personal
 *  tool and should not be reachable from the network unless explicitly asked
 *  (e.g. PI_WEB_HOST=0.0.0.0 for LAN access / Docker port mapping). */
const HOST = cliFlag("--host") ?? process.env.PI_WEB_HOST ?? "127.0.0.1";
/** Optional strict hostname allowlist (comma-separated) — only used when set.
 *  Origin / Host same-authority matching happens regardless. */
const ALLOW_HOSTS = (process.env.PI_WEB_ALLOW_HOSTS ?? "")
	.split(",")
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);
/** Optional extra Origins allowed through the same-authority check (comma-
 *  separated, e.g. reverse-proxy setups where the browser origin differs
 *  from the Host the backend sees). */
const ALLOW_ORIGINS = (process.env.PI_WEB_ALLOW_ORIGINS ?? "")
	.split(",")
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);
/** 可选共享口令（PI_WEB_TOKEN）：设置后所有 HTTP/WS 请求必须携带——
 *  Authorization: Bearer / X-PI-Token 头、?token= 查询参数或 pi_web_token cookie
 *  任一匹配即可；供 0.0.0.0 / 反代等暴露场景兜底，未设置则行为不变。
 *  PI_WEB_TOKEN=auto：口令落在 <DATA_DIR>/pi-web-token（没有就生成 24 字节随机 hex，权限
 *  0600），桌面启动器读同一个文件拼 ?token= 打开页面（驾驶舱 start-hardened.sh 默认用它）。 */
function resolveAuthToken(): string {
	const raw = process.env.PI_WEB_TOKEN?.trim() ?? "";
	if (raw.toLowerCase() !== "auto") return raw;
	const file = join(DATA_DIR, "pi-web-token");
	try {
		const existing = readFileSync(file, "utf8").trim();
		if (existing) return existing;
	} catch {
		// 首次启动：没有口令文件，下面生成
	}
	const token = randomBytes(24).toString("hex");
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(file, token, { mode: 0o600 });
	return token;
}
const AUTH_TOKEN = resolveAuthToken();
/** 语言包下载根（语言包仓库的 raw 文件地址；版本 tag 优先、main 兜底，见 locales.ts）。 */
const LOCALE_BASE_URL =
	process.env.PI_WEB_LOCALE_BASE_URL?.trim() || "https://raw.githubusercontent.com/xing-shuyin/pi-web-ui";
/**
 * 本包版本 —— 下载语言包时优先取同版本 tag，保证 key 对齐。
 *
 * Read on first use, not here. `resolvePkgRoot()` is hoisted, but it reads
 * `here`, which is a `const` declared further down: calling it at module-init
 * time throws on the temporal dead zone, the catch swallows it, and the
 * version was silently "" — so the language packs never used the version tag
 * and always fell back to `main`. Reading it lazily costs one branch and
 * gives the real number.
 */
function appVersion(): string {
	return getAppVersion();
}
/** On-disk web-build id: the main JS bundle hash from the built index.html.
 *  Changes on every rebuild — stale pages compare and reload themselves.
 *  Declared near use (below webDist), not here: webDist is a const further
 *  down and calling this at module-init time would hit its dead zone. */
let buildIdCache: string | null = null;
function buildId(): string {
	if (buildIdCache === null) {
		try {
			const html = readFileSync(join(webDistPath(), "index.html"), "utf8");
			buildIdCache = html.match(/\/assets\/index-([A-Za-z0-9_-]+)\.js/)?.[1] ?? "";
		} catch {
			buildIdCache = "";
		}
	}
	return buildIdCache;
}
// Root of the SDK default per-project session dirs — chat transcripts live in
// <SESSION_DIR_ROOT>/--<cwd>--/, shared with the pi CLI/TUI (getAgentDir
// honors PI_CODING_AGENT_DIR).
const SESSION_DIR_ROOT = join(getAgentDir(), "sessions");

// Propagate pi agent's httpProxy setting and environment proxies to undici/fetch
const proxyInfo = initHttpProxy(getAgentDir());
if (proxyInfo.active) {
	console.log(`[proxy] Outbound HTTP proxy enabled: ${proxyInfo.proxyUrl}`);
}

// Windows 轻量 bash 兜底：把 <home>/.pi-web/bin 前置到 PATH（SDK 的 bash 工具经
// findBashOnPath 会找到其中的 bash.exe），并在无 Git Bash 时后台下载 busybox-w32。
// 终端面板的 shell 探测链也已包含该目录（见 terminals.ts resolveShell）。
if (process.platform === "win32") {
	process.env.PATH = `${windowsBashDir()}${delimiter}${process.env.PATH ?? ""}`;
	void ensureWindowsBash();
}

const app = express();
// Host 白名单（防 DNS rebinding，审查 #352）：无 token 部署下 HTTP 路由此前
// 不校验 Host，恶意网页让自己的域名解析到 127.0.0.1 即可打满全部 API。
// 显式白名单走 PI_WEB_ALLOW_HOSTS（与 WS 侧同 env）；设置了 PI_WEB_TOKEN 则
// 由 token 鉴权兜底，不再限制 Host。WS 升级侧同规则见 originAllowed()。
app.use((req, res, next) => {
	const hostHeader = req.headers.host;
	if (
		typeof hostHeader === "string" &&
		!httpHostAllowed(hostHeader, { allowHosts: ALLOW_HOSTS, hasAuthToken: Boolean(AUTH_TOKEN) })
	) {
		res.status(403).end("host not allowed");
		return;
	}
	next();
});
app.use(express.json({ limit: "10mb" }));

/** 从请求中提取候选 token：头 / 查询参数 / cookie（浏览器导航场景靠 cookie 续命）。 */
function requestTokens(req: { headers: IncomingMessage["headers"]; url?: string }): string[] {
	const out: string[] = [];
	const auth = req.headers.authorization;
	if (typeof auth === "string" && auth.startsWith("Bearer ")) out.push(auth.slice(7).trim());
	const header = req.headers["x-pi-token"];
	if (typeof header === "string") out.push(header.trim());
	try {
		const q = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
		if (q) out.push(q.trim());
	} catch {
		/* ignore malformed url */
	}
	const cookie = req.headers.cookie;
	if (typeof cookie === "string") {
		for (const part of cookie.split(";")) {
			const [k, ...rest] = part.trim().split("=");
			if (k !== "pi_web_token") continue;
			// 我们下发的是 encodeURIComponent 后的值（issue #261），而手写 / 旧客户端的
			// 明文 cookie 也可能出现（`=` 在值里合法，按首个 = 切分）；两种候选都进池子。
			const raw = rest.join("=").trim();
			if (!raw) continue;
			out.push(raw);
			const decoded = decodeCookieToken(raw);
			if (decoded !== raw) out.push(decoded);
		}
	}
	return out.filter(Boolean);
}

/** 口令比较用常时时间：先哈希到定长再 timingSafeEqual（长度差异被摘要抹平），
 *  消除逐字节短路比较的时序侧信道（审查 #352：纵深防御，远程可利用性低）。 */
function sameSecret(candidate: string): boolean {
	const a = createHash("sha256").update(candidate).digest();
	const b = createHash("sha256").update(AUTH_TOKEN).digest();
	return timingSafeEqual(a, b);
}

function tokenOk(req: Parameters<typeof requestTokens>[0]): boolean {
	return requestTokens(req).some(sameSecret);
}

/** 请求携带的 pi_web_token cookie 的**口令值**（未带/损坏时为空串）。
 *  已解码：下发时是 `encodeURIComponent` 过的（issue #261），所以这里拿到的是
 *  可直接与 `AUTH_TOKEN` 比较的原文。 */
function cookieToken(req: { headers: IncomingMessage["headers"] }): string {
	const cookie = req.headers.cookie;
	if (typeof cookie !== "string") return "";
	for (const part of cookie.split(";")) {
		const [k, ...rest] = part.trim().split("=");
		if (k === "pi_web_token") return decodeCookieToken(rest.join("=").trim());
	}
	return "";
}

/** Express 5 命名通配 `*splat` 的取值：单段是字符串，多段是字符串数组
 *  （issue #225：直接 String() 会把多段用逗号拼成 "a,b.mjs"，嵌套文件预览
 *  全 404）。统一拼回 "/" 即得 Express 4 语义；下游既有的越界/包含校验
 *  （workspacePath）不变。 */
function splatParam(req: { params: unknown }): string {
	const v = (req.params as unknown as Record<string, string | string[] | undefined>).splat;
	if (Array.isArray(v)) return v.join("/");
	return String(v ?? "");
}

if (AUTH_TOKEN) {
	// /api/health 保持开放：无敏感信息，容器/监控探针需要它。
	// 但绝不能因命中 /api/health 就反射下发真实 token cookie（安全漏洞：issue #45）。
	// 页签图标同样放行：Safari（WebKit IconLoader）取 favicon 时不带 cookie，鉴权会让它
	// 401、页签没有图标。只放行公开品牌图；正则不允许子路径，不能借 /icons/ 前缀穿越。
	const PUBLIC_ICON_PATH = /^\/(?:favicon\.(?:png|svg)|icon\.ico|icons\/[\w.-]+\.png)$/;
	app.use((req, res, next) => {
		const ok = tokenOk(req);
		const cookie = cookieToken(req);
		// 浏览器经 ?token= 首次进入后下发 HttpOnly cookie，后续导航/资源请求免带参数。
		// 重要：只要请求携带着有效 token（query/header/cookie 任一匹配）就把 cookie 刷新为
		// 当前 AUTH_TOKEN——服务端重启改了 PI_WEB_TOKEN 后，旧 cookie 经一次正确的
		// ?token= 进入即被重新同步，无需用户清缓存（issue #71）。
		// Secure 只在 TLS 连接上加：常加会让明文 HTTP（默认 loopback）收不到 cookie。
		const secure = isTlsRequest(req);
		if (ok) {
			// cookieToken 已解码成原文（issue #261），所以直接和原始口令比 ——
			// 以前拿 `encodeURIComponent(AUTH_TOKEN)` 比，含 `=` / 非 ASCII 的口令
			// 永远不相等（于是每个请求都重发 cookie，且带 cookie 的请求反而 401）。
			if (!sameSecret(cookie)) {
				res.setHeader("Set-Cookie", buildPiWebTokenCookie(encodeURIComponent(AUTH_TOKEN), 31536000, secure));
			}
		} else if (cookie) {
			// 请求带的 cookie 已是失效旧值（服务端口令已更换）——立即让其过期，
			// 避免浏览器被残留 cookie 卡死一年（本来也不该再信任它鉴权）。
			// Secure 与非 Secure 在浏览器里是两个独立 cookie：只清一种会因种植时的
			// 协议不同而残留，所以两种属性组合各发一遍（HTTP 下 Secure 那条被忽略，无害）。
			res.setHeader("Set-Cookie", [buildPiWebTokenCookie("", 0, false), buildPiWebTokenCookie("", 0, true)]);
		}
		if (req.path === "/api/health" || PUBLIC_ICON_PATH.test(req.path) || ok) {
			next();
			return;
		}
		res
			.status(401)
			.send(
				cookie
					? "unauthorized: PI_WEB_TOKEN required — 服务端口令已变更？已清除旧 token cookie，请用当前 ?token= 重新进入"
					: "unauthorized: PI_WEB_TOKEN required (?token=…)",
			);
	});
}

/** 共享客户端持久化存储：双引擎（pi + dsh）共用同一份内存缓存与落盘通道，避免互相覆盖。 */
const sharedStateStore = new ClientStateStore(join(DATA_DIR, "client-state.json"));

/** 精简发行版只保留 pi 引擎。 */
let currentDefaultEngine: EngineId = "pi";

function resolveClientEngine(_clientId: string): EngineId {
	return "pi";
}

/** PI_WEB_MANAGED=1: this instance is updated by whoever deploys it. */
const MANAGED = isManaged();
/** Who started this process: a platform service manager (launchd / systemd /
 *  Windows watchdog — i.e. `pi-web-ui server start|install`) or nothing
 *  (foreground / dev / Docker). Decides whether the UPDATE panel offers
 *  "restart service" and what quitting means (see scheduleQuit). */
const ORIGIN = launchOrigin();
/** 下发给浏览器的服务信息（null = 没有 supervisor）。 */
const SERVICE_INFO = toServiceInfo(ORIGIN);
/** PI_WEB_TABS: the tabs this instance offers. null = all of them, as before. */
const TABS = parseTabs();

registerFileTransferRoutes(app, (clientId) => service.get(clientId)?.cwd);
// Loop 任务台 / 代码 loop 表单 / 连接集群（/api/mini-harness/*，token 鉴权由上方中间件覆盖）。
configureGoalLog(DATA_DIR);
registerLoopRoutes(app, { dataDir: DATA_DIR, agentDir: getAgentDir() });

app.get("/api/health", (_req, res) => {
	// 审查 #352：该端点对未鉴权开放（监控探针需要），故只保留版本/引擎与 SDK
	// 副本诊断信息，不再暴露 cwd（工作区路径披露）与 pid（指纹/信息收集面）。
	res.json({
		ok: true,
		piVersion: VERSION,
		// issue #260：服务实际加载的是自带副本，不是全局 pi CLI 那份。这里把两份都报出来，
		// 用户就不用猜「为什么升了全局 SDK 不生效」。（纯新增字段，piVersion 语义不变。）
		piSdkCopies: sdkCopies(),
		engine: currentDefaultEngine,
	});
});

/**
 * 基于 SHA-256 内容寻址的附件静态服务：
 * 永久强缓存（immutable），支持图片和文件读取。
 */
app.get("/api/attachment/:hash", async (req, res) => {
	try {
		const hash = String(req.params.hash ?? "").trim();
		const hit = await readAttachment(hash);
		if (!hit) {
			res.status(404).end("attachment not found");
			return;
		}
		res.setHeader("Content-Type", hit.mimeType);
		res.setHeader("Content-Length", hit.buffer.length);
		res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
		if (hit.mimeType === "image/svg+xml") {
			// SVG 以文档形态打开（顶层导航/iframe）时内嵌 <script> 会在本应用
			// origin 执行——附件内容可来自剪贴板/工作区文件，等同存储型 XSS
			// （审查 #352 P0-1）。sandbox CSP 让文档形态降级到不透明 origin；
			// <img> 引用不受影响（子资源响应的 CSP 不作用于引用页，且
			// SVG-as-image 本就不执行脚本）。
			res.setHeader("Content-Security-Policy", "sandbox");
			res.setHeader("X-Content-Type-Options", "nosniff");
		}
		res.end(hit.buffer);
	} catch (err) {
		res.status(500).end((err as Error).message);
	}
});

/**
 * Harness 发行版收紧「整机浏览」：绝对 wire 路径只放行工作区根、loop 运行产物目录
 * （~/.mini-harness，产物按约定落在源码仓库之外）与系统临时目录，其余一律 403。
 * 上游允许经 /api/file、/api/office-media、/api/preview/__abs__ 读任意文件。
 */
const ABS_READ_ROOTS = [join(homedir(), ".mini-harness"), resolve(tmpdir())];
function absReadAllowed(abs: string, workspaceRoot: string): boolean {
	return [resolve(workspaceRoot), ...ABS_READ_ROOTS].some((r) => abs === r || abs.startsWith(r + sep));
}

/**
 * Stream a workspace file over HTTP.
 *
 * Media preview (no download param): only image/video kinds are served —
 * text goes over the WebSocket, and exe/jar/etc. are never exposed here.
 * Audio files (isAudioFile: browser-playable containers only) are allowed too
 * so present_files cards and the preview dialog can inline-play them.
 * express's sendFile handles Range requests, so video/audio seeking works.
 *
 * Download (?download=1): any file kind is served with
 * Content-Disposition: attachment so the browser saves it instead of
 * rendering. Path is validated against the workspace root either way.
 */
app.get("/api/file", async (req, res) => {
	try {
		const raw = typeof req.query.path === "string" ? req.query.path : "";
		// Resolve against the requesting client's workspace (the opened
		// project), not the server's startup cwd — they can differ when the
		// client switched projects or restored a previous workspace. Fall
		// back to the server cwd for requests without a known client.
		const cid = typeof req.query.clientId === "string" ? req.query.clientId : "";
		const cs = cid ? service.get(cid) : undefined;
		const root = cs?.cwd ?? CWD;
		const absWire = isAbsoluteWirePath(raw);
		let abs: string;
		if (absWire) {
			abs = wireToAbs(raw);
			if (!absReadAllowed(abs, root)) {
				res.status(403).end("absolute path not allowed");
				return;
			}
		} else {
			const wp = workspacePath(root, raw);
			if (!wp) {
				res.status(400).end("path outside workspace");
				return;
			}
			abs = wp.abs;
		}
		const name = basename(abs);
		const kind = previewKind(name);
		const isDownload = req.query.download === "1";
		// HTML files preview through a sandboxed <iframe> in the file modal
		// (FilePreview.tsx). They are text as far as previewKind goes, so
		// allowlist them explicitly here.
		const lower = name.toLowerCase();
		const isHtmlPreview = lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".xhtml");
		const isAudioPreview = isAudioFile(name);
		if (!isDownload && kind !== "image" && kind !== "video" && !isHtmlPreview && !isAudioPreview) {
			res.status(400).end("not a previewable media file");
			return;
		}
		const st = await stat(abs);
		if (!st.isFile()) {
			res.status(400).end("not a file");
			return;
		}
		if (isDownload) {
			// res.download sets Content-Disposition: attachment and RFC 5987
			// filename* encoding for non-ASCII names.
			// dotfiles: allow — issue #223：Express 5 的 send 默认 dotfiles=ignore，
			// 工作区/数据目录常位于隐藏目录下（如 ~/.pi-web），绝对路径含点号段会被判 404。
			// 路径已由上方的 workspacePath / absReadAllowed 做 containment 校验，放行安全。
			res.download(abs, name, { dotfiles: "allow" });
		} else {
			if (isHtmlPreview) {
				// Sandbox even a top-level navigation to this URL: a workspace
				// HTML file must never get our origin (it could otherwise read
				// the token cookie). The modal iframe carries its own sandbox
				// attribute as well (defense in depth).
				//
				// ?allowJs=1 is the explicit per-file opt-in from the preview
				// modal ("启用脚本"): scripts run, but still in an opaque
				// origin — no DOM/cookie/storage access to our app, no forms,
				// no top-navigation. NEVER add allow-same-origin here.
				const allowJs = req.query.allowJs === "1";
				res.setHeader("Content-Security-Policy", allowJs ? "sandbox allow-scripts" : "sandbox");
				res.setHeader("X-Content-Type-Options", "nosniff");
			} else if (lower.endsWith(".svg")) {
				// 与 /api/attachment 同理：SVG 文档形态的 <script> 沙箱化
				// （审查 #352 P0-1），<img> 内嵌用法不受影响。
				res.setHeader("Content-Security-Policy", "sandbox");
				res.setHeader("X-Content-Type-Options", "nosniff");
			}
			res.sendFile(abs, { dotfiles: "allow" });
		}
	} catch {
		res.status(404).end("not found");
	}
});

/**
 * PPTX 等 Office 内部媒体流式下发路由。
 *   /api/office-media?path=<workspace-rel-path>&media=<image-name>&clientId=…
 */
app.get("/api/office-media", async (req, res) => {
	try {
		const rawPath = typeof req.query.path === "string" ? req.query.path : "";
		const media = typeof req.query.media === "string" ? req.query.media : "";
		if (!rawPath || !media) {
			res.status(400).end("missing path or media");
			return;
		}
		if (!/^image\d+\.(png|jpe?g|webp|gif|svg|bmp)$/i.test(media)) {
			res.status(400).end("invalid media name");
			return;
		}
		const cid = typeof req.query.clientId === "string" ? req.query.clientId : "";
		const cs = cid ? service.get(cid) : undefined;
		const root = cs?.cwd ?? CWD;
		const absWire = isAbsoluteWirePath(rawPath);
		let abs: string;
		if (absWire) {
			abs = wireToAbs(rawPath);
			if (!absReadAllowed(abs, root)) {
				res.status(403).end("absolute path not allowed");
				return;
			}
		} else {
			const wp = workspacePath(root, rawPath);
			if (!wp) {
				res.status(400).end("path outside workspace");
				return;
			}
			abs = wp.abs;
		}
		if (!isOfficeFile(abs)) {
			res.status(400).end("not an office file");
			return;
		}
		const st = await stat(abs);
		if (!st.isFile() || st.size > OFFICE_MAX_FILE_BYTES) {
			res.status(400).end("file not found or too large");
			return;
		}
		const data = await readFile(abs);
		const zipFiles = unzipFiles(data, [`ppt/media/${media}`]);
		const imgBuf = zipFiles.get(`ppt/media/${media}`);
		if (!imgBuf) {
			res.status(404).end("media not found");
			return;
		}
		const ext = media.split(".").pop()?.toLowerCase() ?? "";
		const mimeMap: Record<string, string> = {
			png: "image/png",
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			webp: "image/webp",
			gif: "image/gif",
			svg: "image/svg+xml",
			bmp: "image/bmp",
		};
		res.setHeader("Content-Type", mimeMap[ext] || "application/octet-stream");
		res.setHeader("Cache-Control", "public, max-age=86400, immutable");
		res.send(imgBuf);
	} catch {
		res.status(404).end("not found");
	}
});

/**
 * Directory-mapped preview: serves a workspace file at a URL that mirrors its
 * directory location, so an HTML preview's RELATIVE subresources
 * (<link href="../web/src/styles.css">, <img src="./x.png">, <script
 * src="./app.js">, …) resolve and load with normal browser semantics. The
 * iframe document URL itself carries the file's directory — no HTML rewriting.
 *
 *   /api/preview/<workspace-rel-path>?clientId=…[&allowJs=1]
 *   /api/preview/__abs__/<absolute-wire-path>?clientId=…[&allowJs=1]
 *   (each path segment URI-encoded; ".." is normalized by the browser before
 *   the request is sent, workspace containment is still re-checked here)
 *
 * Same footing as /api/file: workspace containment enforced, HTML documents
 * get a sandboxed CSP (?allowJs=1 relaxes scripts only — never same-origin),
 * everything else streams with its real content type.
 */
app.get("/api/preview/*splat", async (req, res) => {
	try {
		// 多段路径的 splat 是数组（见 splatParam），拼回 "/" 后才是线形路径。
		const captured = splatParam(req);
		const ABS_MARKER = "__abs__/";
		const cid = typeof req.query.clientId === "string" ? req.query.clientId : "";
		const cs = cid ? service.get(cid) : undefined;
		const root = cs?.cwd ?? CWD;
		// Express decodes %XX in the wildcard, so this is back to the wire
		// form (filenames never contain "/", so per-segment encoding from
		// the client round-trips exactly).
		let abs: string;
		if (captured === "__abs__" || captured.startsWith(ABS_MARKER)) {
			// Machine browsing: absolute wire path ("C:/..." / "/...").
			const wire = captured.slice(ABS_MARKER.length);
			if (!isAbsoluteWirePath(wire)) {
				res.status(400).end("bad absolute preview path");
				return;
			}
			abs = wireToAbs(wire);
			if (!absReadAllowed(abs, root)) {
				res.status(403).end("absolute path not allowed");
				return;
			}
		} else {
			const wp = workspacePath(root, captured);
			if (!wp) {
				res.status(400).end("path outside workspace");
				return;
			}
			abs = wp.abs;
		}
		const name = basename(abs);
		const st = await stat(abs);
		if (!st.isFile()) {
			res.status(400).end("not a file");
			return;
		}
		res.setHeader("X-Content-Type-Options", "nosniff");
		const lower = name.toLowerCase();
		if (lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".xhtml")) {
			const allowJs = req.query.allowJs === "1";
			res.setHeader("Content-Security-Policy", allowJs ? "sandbox allow-scripts" : "sandbox");
		} else if (lower.endsWith(".svg")) {
			// 与 /api/attachment 同理：SVG 文档形态的 <script> 沙箱化（审查 #352 P0-1）。
			res.setHeader("Content-Security-Policy", "sandbox");
		}
		res.sendFile(abs, { dotfiles: "allow" });
	} catch {
		res.status(404).end("not found");
	}
});

// Production: serve the built frontend from web/dist. Resolve relative to this
// module so it works when installed as a package (global/npx/Docker), not just
// from the repo root. In dev, Vite serves the UI on :5173 and proxies /ws.
// Resolve the package root robustly: dev runs from <repo>/server (tsx), prod
// from <pkg>/dist/server — the ancestor that actually has package.json wins.
function resolvePkgRoot(): string {
	return getPkgRoot();
}
const pkgRoot = resolvePkgRoot();
// Theme CSS files: complete standalone stylesheets. Builtin themes ship in
// <pkg>/themes (npm files whitelist); user themes can be dropped into
// <dataDir>/themes and are served alongside (user wins on id collision).
const BUILTIN_THEMES_DIR = join(pkgRoot, "themes");
const USER_THEMES_DIR = join(DATA_DIR, "themes");

app.get("/api/themes", (_req, res) => {
	res.json({ themes: listThemes(BUILTIN_THEMES_DIR, USER_THEMES_DIR) });
});
// 语言包：核心只随包发布中英，其余按需下载到 <dataDir>/locales/<code>.json。
// 手工放进去的同名 JSON 也会被识别（离线安装）。PI_WEB_TOKEN 鉴权自动覆盖。
/**
 * PI_WEB_LOCALE / system locale — the language a first visit falls back to.
 *
 * It is a fallback, not an override: an explicit choice, and then the
 * browser's own languages, come first (web/src/pick-locale.ts). It rides on
 * /api/locales because the client already asks for that at boot, so naming a
 * default costs no extra request.
 */
const DEFAULT_LOCALE = resolveSystemDefaultLocale();

app.get("/api/locales", (_req, res) => {
	res.json({ packs: listPacks(DATA_DIR), defaultLocale: DEFAULT_LOCALE });
});
app.get("/api/locales/:code", (req, res) => {
	const code = String(req.params.code ?? "");
	if (!isKnownPack(code)) {
		res.status(404).end("unknown locale");
		return;
	}
	const pack = readPackFile(DATA_DIR, code);
	if (!pack) {
		res.status(404).end("locale not installed");
		return;
	}
	res.setHeader("Cache-Control", "no-cache");
	res.json(pack);
});
app.post("/api/locales/:code/install", async (req, res) => {
	const code = String(req.params.code ?? "");
	if (!isKnownPack(code)) {
		res.status(400).json({ error: `unknown locale: ${code}` });
		return;
	}
	try {
		const meta = await installPack(DATA_DIR, code, { baseUrl: LOCALE_BASE_URL, version: appVersion() });
		// 新包可能自带 serverStrings（issue #91 v2）——重扫注册，无表则跳过。
		loadServerStrings(DATA_DIR);
		res.json({ ok: true, ...meta });
	} catch (e) {
		res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
	}
});
app.delete("/api/locales/:code", (req, res) => {
	const code = String(req.params.code ?? "");
	if (!isKnownPack(code)) {
		res.status(404).end("unknown locale");
		return;
	}
	if (!removePack(DATA_DIR, code)) {
		res.status(404).end("locale not installed");
		return;
	}
	unloadServerStrings(code);
	res.json({ ok: true });
});
// Serve theme base stylesheets directly if requested (e.g. /themes/bases/flow-base.css).
app.get("/themes/bases/:name.css", (req, res) => {
	if (!/^[A-Za-z0-9_-]+$/.test(req.params.name)) {
		res.status(404).end("base not found");
		return;
	}
	const baseFile = join(BUILTIN_THEMES_DIR, "bases", `${req.params.name}.css`);
	if (!existsSync(baseFile) || !statSync(baseFile).isFile()) {
		res.status(404).end("base not found");
		return;
	}
	res.setHeader("Content-Type", "text/css; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache");
	res.sendFile(baseFile);
});

// Serve a theme's full CSS file so the frontend can swap the whole stylesheet.
// Supports server-side @import inlining for shared theme bases (e.g. bases/flow-base.css).
// Registered before the SPA catch-all below (otherwise it'd return index.html).
app.get("/themes/:id.css", (req, res) => {
	const file = resolveThemeFile(BUILTIN_THEMES_DIR, USER_THEMES_DIR, req.params.id);
	if (!file) {
		res.status(404).end("theme not found");
		return;
	}
	res.setHeader("Content-Type", "text/css; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache");
	const css = readThemeCss(file);
	res.send(css);
});

/** Set in the env of the replacement child spawned by a self-update restart. */
const RESTART_CHILD_ENV = "PI_WEB_RESTART_CHILD";
const webDist = join(pkgRoot, "web", "dist");
/** webDist accessor for buildId() (declared above webDist's const). */
function webDistPath(): string {
	return webDist;
}
if (existsSync(webDist)) {
	// gzip/deflate 响应压缩：前端 bundle ~1MB，局域网/反代场景传输量降到 ~1/4；
	// 对 API JSON 同样生效，WS 升级不受影响
	app.use(compression());
	app.use(
		express.static(webDist, {
			// Vite 产物文件名带内容 hash，可永久强缓存——业务发版后 hash 变化自然失效，
			// index.html 由下方 catch-all 处理（sendFile 不走这里）
			setHeaders(res, filePath) {
				if (filePath.includes(`${sep}assets${sep}`)) {
					res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
				}
			},
		}),
	);
	// 缺失的静态文件必须 404（不能落进下面的 SPA catch-all）：缺少的 hash 产物若
	// 回 index.html（200），浏览器会把 HTML 当 JS/CSS 执行失败黑屏，SW 还会把
	// 它按 200 缓进 STATIC_CACHE，之后即使文件恢复也要清缓存才能好。
	app.use((req, res, next) => {
		const p = req.path;
		if (
			p.startsWith("/assets/") ||
			p.startsWith("/icons/") ||
			p === "/favicon.svg" ||
			p === "/favicon.png" ||
			p === "/icon.ico" ||
			p === "/manifest.webmanifest"
		) {
			res.status(404).end();
			return;
		}
		next();
	});
	app.get(/^\/(?!api\/|ws).*/, (_req, res) => {
		// Callback form: a failed stat here (npm i -g is mid-replacement of the
		// package dir) responds 503 instead of crashing the request pipeline
		// with an unhandled ENOENT stack trace.
		// Dev caching (settings → message display → devNoCache): index.html pins
		// hashed asset URLs — a cached copy keeps pointing at stale bundles
		// after a rebuild+restart. Default follows the install: ON from source
		// (.git next to the package root), OFF for installs. PI_WEB_DEV_CACHE=0/1
		// overrides either way.
		const devCache = process.env.PI_WEB_DEV_CACHE;
		const fromSource = existsSync(join(pkgRoot, ".git"));
		const envDefault = devCache !== undefined ? devCache !== "0" : fromSource;
		const stored = readDevNoCacheSetting();
		const noStore = stored ?? envDefault;
		res.setHeader("Cache-Control", noStore ? "no-store" : "public, max-age=0");
		// dotfiles: allow — issue #223：nvm 等安装路径本身在隐藏目录下（如 ~/.nvm/…），同上需放行。
		res.sendFile(join(webDist, "index.html"), { dotfiles: "allow" }, (err) => {
			if (err && !res.headersSent) {
				res.status(503).send("正在更新 训推引擎组 Harness，请稍后刷新…");
			}
		});
	});
} else if (process.env[RESTART_CHILD_ENV]) {
	// Auto-restart replacement of a self-update whose npm install did not
	// complete (Windows: locked files / rollback can leave the global package
	// without web/dist). Fail loudly with a repair hint instead of serving a
	// UI-less 404 with no explanation.
	console.error(
		"✖ 更新后的安装不完整（缺少 web/dist/index.html）。\n" + "  请手动执行 npm i -g pi-web-ui@latest 修复后重新启动。",
	);
	process.exit(1);
}

const httpServer = createServer(app);
const wss = new WebSocketServer({
	noServer: true,
	// 右键上传走单帧 base64（100MB 文件 → ~133MB 文本）：上限与
	// files-service 的上传 cap 对齐（base64 上限 + 1MB 包络余量），
	// 超限帧由 ws 层直接拒收，不进 handler 再分配 Buffer。
	maxPayload: WS_MAX_PAYLOAD_BYTES,
	// Per-message deflate: big-session snapshots serialize to multi-MB JSON
	// strings; wire-level compression cuts that several-fold. threshold keeps
	// tiny messages (notices/heartbeats) uncompressed to save CPU.
	perMessageDeflate: { threshold: 16 * 1024 },
});

// ---------------------------------------------------------------------------
// Origin / Host admission for WebSocket upgrades.
//
// Browsers attach an Origin header; non-browser clients (curl, ws scripts)
// usually don't — they're admitted by the network layer / reverse proxy.
// Rules (checked in order):
//   4. No Origin header → admit (non-browser client).
//   5. Anything else → 403 + close.
//
// Dev-mode note: the Vite dev server (:5173) proxies /ws to the backend on
// :8788, so their authorities differ — the dev:server script sets
// PI_WEB_ALLOW_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 for that.
// LAN / reverse-proxy setups add their own origin the same way.
// ---------------------------------------------------------------------------

/** "host" or "host:port" → { hostname, port }. */
function parseAuthority(a: string): { hostname: string; port: string } {
	try {
		const u = new URL(`http://${a}`);
		return { hostname: u.hostname.toLowerCase(), port: u.port || "80" };
	} catch {
		return { hostname: "", port: "" };
	}
}

function originAllowed(req: IncomingMessage): boolean {
	const hostHeader = req.headers.host ?? "";
	// Host 白名单与 HTTP 侧同规则（审查 #352）：rebinding 下 Origin 会与
	// 攻击者 Host 自比相等，必须先把非本机/私网的 Host 挡掉。
	if (!httpHostAllowed(hostHeader, { allowHosts: ALLOW_HOSTS, hasAuthToken: Boolean(AUTH_TOKEN) })) {
		return false;
	}
	const host = parseAuthority(hostHeader.toLowerCase());
	if (ALLOW_HOSTS.length > 0 && !ALLOW_HOSTS.includes(host.hostname)) {
		return false;
	}
	const origin = req.headers.origin;
	if (!origin) return true; // non-browser client
	const o = origin.toLowerCase();
	if (ALLOW_ORIGINS.includes(o)) return true;
	if (o === "null") return false; // file:// pages etc. are not trusted
	const ori = parseAuthority(o.replace(/^[a-z]+:\/\//, ""));
	if (ori.hostname === host.hostname && ori.port === host.port) return true;
	// Browsers treat host:port pairs on the SAME host as different origins —
	// do not accept them. (Dev-mode proxying is handled by PI_WEB_ALLOW_ORIGINS
	// set in the dev:server script; LAN/reverse-proxy setups add their origin.)
	return false;
}

httpServer.on("upgrade", (req, socket, head) => {
	let pathname = "/";
	try {
		pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	} catch {
		/* fall through to the path check below */
	}
	if (pathname !== "/ws") {
		socket.destroy();
		return;
	}
	if (!originAllowed(req)) {
		// Reject cross-origin browser pages outright. The browser sees a failed
		// WS connect; the page's own reconnect loop then backs off and retries.
		socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
		socket.destroy();
		return;
	}
	if (AUTH_TOKEN && !tokenOk(req)) {
		socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
		socket.destroy();
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		wss.emit("connection", ws, req);
	});
});

// Heartbeat: lets clients detect half-open connections (server killed without
// closing sockets, sleep/wake, network partitions). Also broadcasts lightweight
// server host metrics (CPU and memory usage) sampled every ~2s.
const HEARTBEAT_INTERVAL_MS = 2_000;
/** 全局广播与心跳推送背压阈值（256KB）：socket 积压时丢弃广播消息，防用户态无界堆积（issue #460）。 */
const BROADCAST_BACKPRESSURE_MAX_BYTES = 262_144;

interface TrackedWebSocket extends WebSocket {
	isAlive?: boolean;
	missedPings?: number;
	pingSentAt?: number;
	latencyMs?: number;
}

const sampleHostMetrics = createHostMetricsSampler();

const heartbeatTimer = setInterval(() => {
	let message: ServerMessage = { type: "heartbeat" };
	try {
		message = { type: "heartbeat", hostMetrics: sampleHostMetrics() };
	} catch {
		// 继续发送普通心跳，下一轮重试采样。
	}

	if (wss.clients.size > 0) {
		const payload = JSON.stringify(message);
		for (const ws of wss.clients) {
			if (ws.readyState !== WebSocket.OPEN) continue;
			const tracked = ws as TrackedWebSocket;

			// 半开连接死连接回收（issue #460）：连续无活动/无 pong 则 terminate
			if (tracked.isAlive === false) {
				tracked.missedPings = (tracked.missedPings || 0) + 1;
				if (tracked.missedPings >= 3) {
					try {
						ws.terminate?.();
					} catch {}
					continue;
				}
			} else {
				tracked.missedPings = 0;
			}
			const prevLatencyMs = tracked.latencyMs;
			tracked.isAlive = false;
			tracked.pingSentAt = performance.now();
			try {
				ws.ping();
			} catch {
				try {
					ws.terminate?.();
				} catch {}
				continue;
			}

			// 广播背压：缓冲积压严重时跳过心跳推送
			if (ws.bufferedAmount <= BROADCAST_BACKPRESSURE_MAX_BYTES) {
				try {
					if (typeof prevLatencyMs === "number" && Number.isFinite(prevLatencyMs)) {
						ws.send(JSON.stringify({ ...message, latencyMs: prevLatencyMs }));
					} else {
						ws.send(payload);
					}
				} catch {}
			}
		}
	}
}, HEARTBEAT_INTERVAL_MS);
// Unref'd so it never blocks exit: heartbeat alone must not hold the event loop open.
heartbeatTimer.unref?.();

// 引擎分发：统一走 pi 引擎（精简发行版已移除 dsh 引擎）。
import type { EngineId } from "./protocol.js";

/** dispatch 表所需的方法契约（pi 的 ClientSession 与 dsh 的 DshClientSession
 *  都结构兼容；dsh 引擎对不支持的功能做简化实现）。 */

/** TerminalManager 的 dispatch 面（两个引擎共用同一实现类）。 */
export interface TerminalManagerLike {
	create(
		id: string,
		cwd: string,
		cols: number,
		rows: number,
		fallbackCwd: string,
		title?: string,
		opts?: { forceBash?: boolean; locale?: string },
	): void;
	input(id: string, data: string): void;
	resize(id: string, cols: number, rows: number): void;
	kill(id: string): void;
	rename(id: string, title: string): void;
	runCommand(id: string, command: CommandDef, cols: number, rows: number, fallbackCwd: string): void;
}

export interface DispatchSession {
	cwd: string;
	prompt(text: string, attachments?: PromptAttachment[], queue?: boolean): Promise<void>;
	/** Remove one queued prompt (steer/followUp) — the ✕ on a pending bubble.
	 *  `index` is the bubble position (identity); omitted = text fallback. */
	removeQueued(kind: "steer" | "followUp", text: string, index?: number): void;
	/** Save the unsent composer draft for the given session (pi engine only;
	 *  DSH sessions don't implement it — dispatch uses `?.` so it's skipped there). */
	saveDraft?(sessionId: string, text: string, ts: number): void;
	abort(): Promise<void>;
	abortBash(): Promise<void>;
	/** 手动重试上次失败的模型调用（自动重试次数用完、已停止标红后）。 */
	retryLast(): Promise<void>;
	killBackgroundServer(port?: number): Promise<boolean>;
	killAllBackgroundServers(): Promise<string[]>;
	listBgServers(): Promise<void>;
	/** 钉住 / 取消钉住一个后台实例（自动清理跳过钉住的）。 */
	setBackgroundKeep(port: number, keep: boolean): boolean;
	/** 手动「立即清理」：按当前策略阈值清一次遗留实例，返回被清的端口。 */
	cleanBackgroundLeftovers(minutesOverride?: number): Promise<number[]>;
	/** 返回值语义见 SlashHost.newChat：布尔值 = 是否落在一个可接收首条的空白
	 *  新对话（/new <prompt> 用）。此处只管转发，返回值被丢弃，故允许 void。
	 *  preset = DSH Agent 预设（pi 引擎忽略）。 */
	newChat(preset?: string, ephemeral?: boolean): Promise<boolean | void>;
	editMessage(messageId: string, text: string, attachments?: PromptAttachment[]): Promise<void>;
	forkSession?(messageId: string, position?: "before" | "at", targetConvId?: string): Promise<void>;
	flushSnapshot(forceFull?: boolean): void;
	pushSlashCommands(): Promise<void>;
	/** 取一条工具的**定义说明** → `tool_info`（工具卡右键 → 「显示工具详细信息」）。
	 *  pi 与 dsh 都实现了；缺失时 dispatch 回 `unsupported`（不静默 —— 否则点开弹窗
	 *  会永远停在「读取中」）。 */
	getToolInfo?(name: string): void | Promise<void>;
	/** 取一条工具的「出厂默认 + 当前覆盖」→ `tool_prompt`（设置页逐工具编辑文案）。
	 *  缺失时 dispatch 回 `found: false`（引擎不支持 / 旧服务端）。 */
	getToolPrompt?(name: string): void | Promise<void>;
	/** 查询被某个压缩卡片折叠的历史消息（按需惰性加载，issue #398）。 */
	getCompactedMessages?(compactionMessageId: string, targetConvId?: string): void | Promise<void>;
	refreshSessions(): Promise<void>;
	pushProjects(): Promise<void>;
	removeProject(path: string): Promise<void>;
	createSandbox?(opts: { name?: string; sourcePath?: string; ephemeral?: boolean }): Promise<void>;
	resetSandbox?(path?: string): Promise<void>;
	persistSandbox?(path?: string): Promise<void>;
	promoteSandbox?(targetPath: string, path?: string, switchToTarget?: boolean): Promise<void>;
	diffSandbox?(path?: string): Promise<void>;
	applySandboxToSource?(path?: string): Promise<void>;
	destroySandbox?(path: string): Promise<void>;
	switchWorktree?(path: string): Promise<void>;
	removeWorktree?(path: string, force?: boolean): Promise<void>;
	deleteSession(path: string): Promise<void>;
	renameSession(path: string, name: string): Promise<void>;
	renameConversation(id: string, name: string): Promise<void>;
	dismissConversation(id: string, withFinishedSubagents?: boolean, force?: boolean): Promise<void>;
	dismissFinishedSubagents(parentId?: string): Promise<void>;
	persistConversation?(id: string): Promise<void>;
	setConversationPinned?(id: string, pinned: boolean): Promise<void>;
	pinSession?(path: string, pinned: boolean): Promise<void>;
	updatePlanStep?(stepId: string, patch: Partial<import("./protocol.js").PlanStep>, conversationId?: string): void;
	deletePlanStep?(stepId: string, conversationId?: string): void;
	addPlanStep?(step: import("./protocol.js").PlanStep, afterStepId?: string, conversationId?: string): void;
	planCleanHandoff?(steps: import("./protocol.js").PlanStep[], promptText: string): Promise<void>;
	switchSession(path: string, sessionId?: string): Promise<void>;
	switchConversation(id: string): Promise<void>;
	searchFiles(query: string, reqId: number): Promise<void>;
	searchSessions(query: string, reqId: number): Promise<void>;
	readFile(path: string): Promise<void>;
	writeFile(path: string, text: string): Promise<void>;
	revealEntry(path: string): Promise<void>;
	openDefaultEntry(path: string): Promise<void>;
	listModels(): Promise<void>;
	setModel(modelId: string): Promise<void>;
	/** 全局默认模型（pi 引擎专有；DSH 无此概念，实现缺失时 dispatch 侧 `?.` 忽略）。 */
	setDefaultModel?(modelId: string): Promise<void>;
	clearDefaultModel?(): void;
	setThinking(level: string): void;
	setCwd(path: string): Promise<void>;
	/** 设置当前项目的额外工作区根（宿主侧多根，见 protocol 的 set_workspace_roots）。 */
	setWorkspaceRoots(roots?: string[]): Promise<void>;
	completePath(path: string): Promise<void>;
	makeDir(path: string, setAsCwd?: boolean): Promise<void>;
	checkUpdate(): Promise<void>;
	checkUpdatesAll(force?: boolean): Promise<void>;
	resolveDialog(id: number, value: string | boolean | null): void;
	handleTuiOverlayInput?(id: number, data: string): void;
	handleTuiOverlayResize?(id: number, cols: number, rows: number): void;
	handleTuiOverlayCancel?(id: number): void;
	installPiAgent(): Promise<void>;
	setProviderApiKey(provider: string, apiKey: string): Promise<void>;
	clearProviderApiKey(provider: string): Promise<void>;
	startProviderOAuth(provider: string): void;
	replyProviderOAuth(flowId: string, promptId: string, value: string): void;
	cancelProviderOAuth(flowId: string): void;
	listProviderOAuthFlows(): void;
	logoutProviderOAuth(provider: string): Promise<void>;
	listModelsConfig(): Promise<void>;
	reloadModelsConfig(): Promise<void>;
	saveModelConfig(providerId: string, config: unknown): Promise<void>;
	deleteModelConfig(providerId: string): Promise<void>;
	listProviders(): Promise<void>;
	listProviderKeys(): void;
	addProviderKey(provider: string, apiKey: string, name?: string): Promise<void>;
	activateProviderKey(provider: string, keyName: string): Promise<void>;
	removeProviderKey(provider: string, keyName: string): Promise<void>;
	fetchModelsList(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		providerId?: string,
	): Promise<void>;
	testModelConnection?(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		providerId?: string,
	): Promise<void>;
	refreshProviderModels(providerId: string, reqId: number): Promise<void>;
	refreshBuiltinModels(reqId: number): Promise<void>;
	appendBuiltinModel(providerId: string, model: unknown, reqId: number): Promise<void>;
	cloneProvider(provider: string, reqId: number): Promise<void>;
	enrichModels(reqId: number, ids: string[], hints?: Record<string, string>): Promise<void>;
	abortEnrichModels(reqId?: number): void;
	getTerminalManager(conversationId?: string): TerminalManagerLike | undefined;
	getTerminalCwd(conversationId?: string): string;
	listCommands(): Promise<void>;
	saveCommands(commands: CommandDef[]): Promise<void>;
	setGoal(
		goal: string,
		opts?: {
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
			/** 目标模式 2.0：执行者模型（DSH 引擎不接委托执行，忽略）。 */
			execModel?: string;
		},
	): Promise<void>;
	clearGoal(): Promise<void>;
	pauseGoal(): Promise<void>;
	resumeGoal(): Promise<void>;
	startGoalWizard(text: string, opts?: { wizardModel?: string; maxRounds?: number; locked?: boolean }): Promise<void>;
	setGoalPrefs(opts?: {
		reviewModel?: string;
		maxRounds?: number;
		locked?: boolean;
		execModel?: string;
	}): Promise<void>;
	startLoop?(msg: {
		goal: string;
		precheckCmd?: string;
		validateCmd?: string;
		mode?: "code" | "llm";
		maxRounds?: number;
		plannerModel?: string;
		reviewerModel?: string;
		useReviewer?: boolean;
		worktree?: boolean;
		taskId?: string;
		criteria?: string;
		artifactRoots?: string[];
	}): Promise<void>;
	stopLoop?(runId?: string): Promise<void>;
	resumeLoop?(runId: string): Promise<void>;
	acceptLoop?(runId: string): Promise<void>;
	pushSettings(): void;
	setSettings(partial: {
		promptMode?: "append" | "replace";
		customSystemPrompt?: string;
		promptTemplate?: string;
		promptOverrides?: Record<string, string>;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		/** 宿主 UI 布局偏好（内置条目的隐藏/排序/分组；纯 UI，per-client）。 */
		uiLayout?: UiLayoutPrefs;
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		terminalBashMaxForegroundMs?: number;
		editSoftEnabled?: boolean;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		toolImagesEnabled?: boolean;
		keepRecentMessages?: number;
		showForkedParentSessions?: boolean;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: "append" | "replace";
		visionBridgePrompt?: string;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
	}): Promise<void>;
	reloadExtensions(): Promise<void>;
	/** DSH engine only: Agent 预设名录刷新/空白切换/默认设置。 */
	refreshAgentPresets?(): Promise<void>;
	selectAgentPreset?(preset: string): Promise<void>;
	setDefaultAgentPreset?(preset: string): Promise<void>;
	/** DSH engine only: 权限预设热切换/新会话默认（三档）。 */
	setPermissionPreset?(preset: string): Promise<void>;
	setDefaultPermissionPreset?(preset: string): Promise<void>;
	/** DSH engine only: answer a model ask_user_question dialog. */
	answerQuestion?(
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
		cancelReason?: string,
	): Promise<void>;
	forkSession?(messageId: string, position?: "before" | "at", conversationId?: string): Promise<void>;
	rollbackSession?(messageId: string, conversationId?: string, restoreWorkspace?: boolean): Promise<void>;
	resolveToolApproval?(
		id: string,
		decision: "approve" | "deny" | "edit",
		editedParams?: unknown,
		reason?: string,
		/** "category" = 顺带记住本对话的该同类档位；"all" = 本对话后续全部允许。 */
		scope?: "once" | "category" | "all",
	): boolean;
	/** 设置当前对话的审批放行策略（设置面板撤销区；纯内存态）。 */
	setApprovalPolicy?(partial: { conversationId?: string; allowAll?: boolean; categories?: string[] }): void;
	updatePlan?(steps: import("./protocol.js").PlanStep[], activeStepId?: string | null, conversationId?: string): void;
	/** 切换计划模式（只规划不实施）：会话级，热生效。 */
	setPlanMode?(enabled: boolean, conversationId?: string): Promise<void>;
	/** 切换审查者模式（自动委派）：会话级，默认关。DSH 实现里直接拒（无工具闸门）。 */
	setDelegateMode?(enabled: boolean, conversationId?: string): Promise<void>;
	installSkill?(name: string, scope: "global" | "project", content: string): Promise<void>;
	uninstallSkill?(name: string, scope: "global" | "project"): Promise<void>;
	/** Upsert 一个子代理模板（全局共享）。 */
	saveSubagentTemplate(template: UiSubagentTemplate): Promise<void>;
	saveApprovalRule?(rule: UiApprovalRule): Promise<void>;
	saveApprovalRules?(rules: UiApprovalRule[]): Promise<void>;
	deleteApprovalRule?(id: string): Promise<void>;
	resetBuiltinApprovalRule?(id: string): Promise<void>;
	/** 当前客户端的服务端语言（issue #91 v2：归一化 UI 代码，zh/EN/ja/…）。 */
	getLang(): string;
	/** Browser UI locale report (hello.locale / set_locale) — persist per
	 *  client and refresh lang-aware prompts (streaming-safe). */
	setLocale(locale: string): Promise<void>;
	/** 删除一个子代理模板。 */
	deleteSubagentTemplate(name: string): Promise<void>;
	emitNotice(level: "info" | "warning" | "error", text: string, textEn?: string): void;
	activeConversations(): number;
	pendingMessages(): number;
}

/** 引擎无关的服务接口（index.ts attach 流程所需）。 */
export interface EngineService {
	attach(clientId: string, send: (msg: ServerMessage) => void): Promise<DispatchSession>;
	detach(clientId: string, send: (msg: ServerMessage) => void): void;
	get(clientId: string): DispatchSession | undefined;
	disposeAll(): Promise<void>;
	/** Snapshot still-streaming conversations for post-restart resume (pi
	 *  engine records them; dsh engine no-ops). Called from graceful
	 *  shutdown and the restart_service handler. */
	recordInterruptedRuns(): void;
	noteSocketOpen(): void;
	noteSocketClose(): void;
	isQuiesced(): boolean;
	quiesce(): void;
	unquiesce(): void;
	quiesceInfo(): { quiesced: boolean; quiescedSince?: number };
	serviceStatus(): {
		pid: number;
		version: string;
		cwd: string;
		quiesced: boolean;
		quiescedSince?: number;
		connectedClients: number;
		activeConversations: number;
		pendingMessages: number;
		service: UiServiceInfo | null;
	};
	activeConversations(): number;
	pendingMessages(): number;
	/** 当前底座能力声明（Capabilities） */
	getCapabilities?(): AgentEngineCapabilities;
	/** Browser UI locale report (hello.locale / set_locale) — persist per
	 *  client and refresh lang-aware prompts (streaming-safe). */
	setLocale(clientId: string, locale: string): Promise<void>;
	/** 手动过户（pi 引擎实现；DSH 未实现 → dispatch 回落提示）。 */
	takeOverConversation?(targetId: string, ownerId: string, convId: string): Promise<void>;
	/** 跨页作答预告 + 答案转交（pi 引擎实现；DSH 未实现 → dispatch 回落提示）。 */
	peekElsewhereQuestion?(targetId: string, ownerId: string, convId: string): Promise<void>;
	answerElsewhereQuestion?(
		targetId: string,
		ownerId: string,
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
	): Promise<void>;
	onQuit?: (() => boolean) | undefined;
}

let piServiceInstance: AgentService | null = null;
let wireEngineHooks: ((svc: EngineService) => void) | null = null;
let sharedSocketCount = 0;
let sharedQuiesced = false;

function activeEngines(): EngineService[] {
	const list: EngineService[] = [];
	if (piServiceInstance) list.push(piServiceInstance);
	return list;
}

function ensureEngine(_engine: EngineId): EngineService {
	if (!piServiceInstance) {
		piServiceInstance = new AgentService(CWD, sharedStateStore);
		for (let i = 0; i < sharedSocketCount; i++) piServiceInstance.noteSocketOpen();
		if (sharedQuiesced) piServiceInstance.quiesce();
		wireEngineHooks?.(piServiceInstance);
	}
	return piServiceInstance;
}

// 启动时预热默认引擎实例
ensureEngine(currentDefaultEngine);

const service: EngineService = {
	attach(clientId, send) {
		return ensureEngine(resolveClientEngine(clientId)).attach(clientId, send);
	},
	detach(clientId, send) {
		for (const s of activeEngines()) s.detach(clientId, send);
	},
	get(clientId) {
		if (!clientId) return undefined;
		for (const s of activeEngines()) {
			const cs = s.get(clientId);
			if (cs) return cs;
		}
		return undefined;
	},
	async disposeAll() {
		await Promise.all(activeEngines().map((s) => s.disposeAll()));
	},
	recordInterruptedRuns() {
		for (const s of activeEngines()) s.recordInterruptedRuns();
	},
	noteSocketOpen() {
		sharedSocketCount++;
		for (const s of activeEngines()) s.noteSocketOpen();
	},
	noteSocketClose() {
		sharedSocketCount = Math.max(0, sharedSocketCount - 1);
		for (const s of activeEngines()) s.noteSocketClose();
	},
	isQuiesced() {
		return sharedQuiesced || activeEngines().some((s) => s.isQuiesced());
	},
	quiesce() {
		sharedQuiesced = true;
		for (const s of activeEngines()) s.quiesce();
	},
	unquiesce() {
		sharedQuiesced = false;
		for (const s of activeEngines()) s.unquiesce();
	},
	quiesceInfo() {
		for (const s of activeEngines()) {
			const info = s.quiesceInfo();
			if (info.quiesced) return info;
		}
		return { quiesced: false };
	},
	serviceStatus() {
		const primary = ensureEngine(currentDefaultEngine);
		const base = primary.serviceStatus();
		let active = 0;
		let pending = 0;
		for (const s of activeEngines()) {
			active += s.activeConversations();
			pending += s.pendingMessages();
		}
		return {
			...base,
			activeConversations: active,
			pendingMessages: pending,
		};
	},
	activeConversations() {
		let n = 0;
		for (const s of activeEngines()) n += s.activeConversations();
		return n;
	},
	pendingMessages() {
		let n = 0;
		for (const s of activeEngines()) n += s.pendingMessages();
		return n;
	},
	setLocale(clientId, locale) {
		return ensureEngine(resolveClientEngine(clientId)).setLocale(clientId, locale);
	},
	takeOverConversation(targetId, ownerId, convId) {
		const targetSvc = ensureEngine(resolveClientEngine(targetId));
		if (typeof targetSvc.takeOverConversation === "function") {
			return targetSvc.takeOverConversation(targetId, ownerId, convId);
		}
		return Promise.resolve();
	},
	peekElsewhereQuestion(targetId, ownerId, convId) {
		const targetSvc = ensureEngine(resolveClientEngine(targetId));
		if (typeof targetSvc.peekElsewhereQuestion === "function") {
			return targetSvc.peekElsewhereQuestion(targetId, ownerId, convId);
		}
		return Promise.resolve();
	},
	answerElsewhereQuestion(targetId, ownerId, id, answers, cancelled) {
		const targetSvc = ensureEngine(resolveClientEngine(targetId));
		if (typeof targetSvc.answerElsewhereQuestion === "function") {
			return targetSvc.answerElsewhereQuestion(targetId, ownerId, id, answers, cancelled);
		}
		return Promise.resolve();
	},
};

// Server-string tables (issue #91 v2): packs' `serverStrings` sections feed
// pick() lookup for non-zh/en UI languages (missing key → English fallback).
initAttachmentStore(DATA_DIR);
loadServerStrings(DATA_DIR);
// 内置定时任务（issue #184）：全局 <dataDir>/scheduler-tasks.json，TTL 与
// client-state 同级；Agent 工具建的任务优先唤醒发起对话（issue #193：
// wakeConversation steer 投递，不切用户当前对话），原对话不在先回落同项目
// 活跃对话（issue #231：视口兜底＋自动重绑定＋明确降级提示），都没有才无头伪
// 客户端（chatFromScheduler）；单次任务触发后自动删除。DSH 引擎无这俩方法时
// executor 回 not-supported（历史里记失败，不炸进程）。
const scheduler = new SchedulerStore(DATA_DIR, {
	executor: async (task) => {
		let result: { ok: boolean; conversationId?: string; error?: string };
		try {
			const svc = ensureEngine("pi") as unknown as {
				chatFromScheduler?: (t: {
					id: string;
					cwd: string;
					prompt: string;
					model?: string;
					thinkingLevel?: string;
				}) => Promise<{ ok: boolean; conversationId?: string; error?: string }>;
				wakeConversation?: (
					id: string,
					text: string,
					opts?: { sessionFile?: string; cwd?: string },
				) => Promise<{
					ok: boolean;
					conversationId?: string;
					sessionFile?: string;
					clientId?: string;
					busy?: boolean;
					error?: string;
				}>;
				wakeViewportInCwd?: (
					cwd: string,
					text: string,
				) => Promise<{
					ok: boolean;
					conversationId?: string;
					sessionFile?: string;
					clientId?: string;
					busy?: boolean;
					error?: string;
				}>;
			};
			if (typeof svc.chatFromScheduler !== "function" && typeof svc.wakeConversation !== "function") {
				result = { ok: false, error: "当前引擎不支持定时任务（仅标准 pi 引擎）" };
			} else {
				const runHeadless = (): Promise<{ ok: boolean; conversationId?: string; error?: string }> =>
					svc.chatFromScheduler!({
						id: task.id,
						cwd: task.cwd,
						prompt: task.prompt,
						model: task.model,
						thinkingLevel: task.thinkingLevel,
					});
				const target = String(task.conversationId ?? "").trim();
				const taskFile = String((task as { sessionFile?: unknown }).sessionFile ?? "").trim();
				const text = `[定时任务 ${task.name}] ${task.prompt}`;
				if (!target && !taskFile) {
					// 面板建的任务：创建时就没绑对话，保持无头语义（不抢占用户视口）。
					result = await runHeadless();
				} else if (typeof svc.wakeConversation === "function") {
					// 原绑定对话还在（含压缩/重启后按会话文件重认）→ steer 唤醒，报告落原对话。
					let w: {
						ok: boolean;
						conversationId?: string;
						sessionFile?: string;
						busy?: boolean;
						error?: string;
					};
					try {
						w = await svc.wakeConversation(target, text, { sessionFile: taskFile, cwd: task.cwd });
					} catch (err) {
						w = { ok: false, error: (err as Error).message };
					}
					if (w.ok) {
						// 会话继承（issue #231）：压缩/重启后同文件对话换了新 id → 任务跟过去，
						// 下次触发直达，不再误判 closed/gone。单次任务随后自删，免一次写盘。
						if (!task.oneShot) {
							try {
								if (w.conversationId && w.conversationId !== target)
									scheduler.rebind(task.id, { conversationId: w.conversationId });
								if (w.sessionFile && w.sessionFile !== taskFile)
									scheduler.rebind(task.id, { sessionFile: w.sessionFile });
							} catch {
								// 重绑失败不影响本次已投递的唤醒
							}
						}
						result = { ok: true, conversationId: w.conversationId };
					} else if (typeof svc.wakeViewportInCwd === "function") {
						// 活跃视口兜底（issue #231）：原句柄断开（切走释放/过户改名/重启），
						// 只要同项目还有用户正看着的对话，报告落那里 —— 不静默吞结果。
						const fallbackText = `[定时任务 ${task.name}｜原对话不在，已转到本窗口继续] ${task.prompt}`;
						let f: {
							ok: boolean;
							conversationId?: string;
							sessionFile?: string;
							busy?: boolean;
							error?: string;
						};
						try {
							f = await svc.wakeViewportInCwd(task.cwd, fallbackText);
						} catch (err) {
							f = { ok: false, error: (err as Error).message };
						}
						if (f.ok) {
							if (!task.oneShot) {
								try {
									scheduler.rebind(task.id, {
										conversationId: f.conversationId ?? "",
										sessionFile: f.sessionFile ?? "",
									});
								} catch {
									// 重绑失败不影响本次已投递的唤醒
								}
							}
							pushNoticeToAll(
								"info",
								`定时任务「${task.name}」原对话不在，已转到同项目的活跃对话继续（原绑定 ${target || "（未知）"}）。报告直接落在当前对话。`,
								`Scheduled task "${task.name}" moved to the project's active conversation (was ${target || "unknown"}). The report lands in the current chat.`,
							);
							result = { ok: true, conversationId: f.conversationId };
						} else {
							// 降级可见性（issue #231）：必须无头时明确广播去向，不静默。
							pushNoticeToAll(
								"warning",
								`定时任务「${task.name}」原对话不在、同项目也无存活对话，已转后台执行（无头）。报告在后台任务面板的调度历史中查看。`,
								`Scheduled task "${task.name}" found no live conversation and runs headless; see its report in the background-tasks panel history.`,
							);
							result = await runHeadless();
						}
					} else {
						result = await runHeadless();
					}
				} else {
					result = await runHeadless();
				}
			}
		} catch (err) {
			result = { ok: false, error: (err as Error).message };
		}
		// 单次任务：触发一次后自动删除（历史随任务一起走，成败已由上面的 notify 播报）。
		if (task.oneShot) {
			try {
				scheduler.remove(task.id);
			} catch {
				// 删除失败不影响已记录的执行结果
			}
		}
		return result;
	},
	onChange: () => pushSchedulerTasks(),
	notify: (level, text, textEn) => pushNoticeToAll(level, text, textEn ?? text),
	// issue #291：任务删除（含单次任务跑完自删）后回收其伪客户端，
	// 否则 scheduler:<taskId> 会话会永久占据其他客户端的 elsewhere 列表。
	onTaskRemoved: (taskId) => {
		const svc = piServiceInstance as unknown as { releaseSchedulerClient?: (id: string) => void } | null;
		try {
			svc?.releaseSchedulerClient?.(taskId);
		} catch {
			// 回收失败不影响任务删除
		}
	},
});
scheduler.start();
/** 把调度器任务列表推给所有在线客户端（设置面板展示 + 变更后刷新）。 */
function pushSchedulerTasks(): void {
	try {
		const payload = JSON.stringify({ type: "scheduler_tasks", tasks: scheduler.list() });
		for (const client of wss.clients) {
			if (client.readyState !== WebSocket.OPEN) continue;
			if (client.bufferedAmount > BROADCAST_BACKPRESSURE_MAX_BYTES) continue;
			try {
				client.send(payload);
			} catch {
				/* 死连接：index.ts 自己会清理 */
			}
		}
	} catch {
		/* 序列化失败不影响调度 */
	}
}

/** 广播通知条给全部在线客户端（全局事件，不属于某个 ClientSession）。 */
function pushNoticeToAll(level: "info" | "warning" | "error", text: string, textEn: string): void {
	const payload = JSON.stringify({ type: "notice", level, text, textEn });
	for (const client of wss.clients) {
		if (client.readyState !== WebSocket.OPEN) continue;
		if (client.bufferedAmount > BROADCAST_BACKPRESSURE_MAX_BYTES) continue;
		try {
			client.send(payload);
		} catch {
			/* 死连接：index.ts 自己会清理 */
		}
	}
}

// 宿主钩子统一挂载器：无论引擎在启动时预热还是运行期按需懒加载，都一致注入全部回调。
wireEngineHooks = (svc: EngineService) => {
	svc.onQuit = scheduleQuit;
	if ("schedulerStore" in svc) {
		(svc as unknown as { schedulerStore: typeof scheduler }).schedulerStore = scheduler;
	}
};
for (const s of activeEngines()) wireEngineHooks(s);

// ---------------------------------------------------------------------------
// Self-update
// ---------------------------------------------------------------------------
// In-app updates now run `npm i -g pi-web-ui@latest` in a visible terminal
// tab (frontend-initiated); after it finishes the user restarts via
// `pi-web-ui server restart`. The PI_WEB_RESTART_CHILD port-wait handshake
// below stays: an externally orchestrated replacement child still needs it.

function scheduleQuit(): boolean {
	const isLaunchd = process.platform === "darwin" && process.ppid === 1;
	const isSystemd = process.platform === "linux" && !!process.env.INVOCATION_ID;
	// Windows `server install` runs the server under the powershell watchdog
	// launcher (`while ($true) { node …; Start-Sleep 10 }`) — exiting brings it
	// back within ~10s, same contract as launchd/systemd (see launch-origin.ts).
	const isWinWatchdog = ORIGIN.supervisor === "windows-watchdog";
	const inDocker = existsSync("/.dockerenv");
	if (isLaunchd || isSystemd || isWinWatchdog || inDocker) {
		setTimeout(() => {
			console.log("pi-web-ui:quit — shutting down (supervisor will restart)…");
			if (isSystemd) process.exit(3);
			void shutdown();
		}, 300);
		return true;
	}
	setTimeout(() => {
		console.log("pi-web-ui:quit — shutting down (restart to reload)…");
		void shutdown();
	}, 300);
	return true;
}
service.onQuit = scheduleQuit;

/** 背压相对倍数：socket 未发送积压超过「最近一份 snapshot 大小 × 此倍数」时丢弃
 *  （issue #11 及其评论区的自适应建议）。固定 1MB 阈值在长会话下单份 snapshot 可达
 *  ~10MB——连半份都没发完就丢，前端频繁跳帧；短会话又太迟钝。相对阈值语义稳定在
 *  「缓冲堆了约 N 份快照」，不随会话长短漂移。 */
const SNAPSHOT_BACKPRESSURE_FACTOR = 3;
/** 背压绝对下限：低于此积压永不丢快照（小会话的相对阈值只有几 KB，会被
 *  正常的消息突发误伤，见 send() 内注释）。 */
const SNAPSHOT_BACKPRESSURE_MIN_BYTES = 262_144;
/** 背压丢弃后的延迟重发间隔。 */
const SNAPSHOT_RETRY_MS = 250;
/** issue #295：attach（会话初始化）超过此时长未完成，先给浏览器一句可见提示，
 *  避免界面永久停在「正在连接」而用户不知发生了什么。attach 本体继续等（不取消），
 *  完成后照常走快照流程。 */
const ATTACH_SLOW_NOTICE_MS = 8_000;

/**
 * Multi-tab serialization sharing: emit() hands the SAME message object to
 * every socket of a client, but each send() used to JSON.stringify it
 * separately — N open tabs serialized the same multi-MB snapshot N times per
 * push. Keyed by object identity (WeakMap): a new snapshot is a new object,
 * so the cache self-invalidates and never grows.
 */
const serializedCache = new WeakMap<ServerMessage, string>();
function serializeShared(msg: ServerMessage): string {
	let s = serializedCache.get(msg);
	if (s === undefined) {
		s = JSON.stringify(msg);
		serializedCache.set(msg, s);
	}
	return s;
}

wss.on("connection", (ws) => {
	const tracked = ws as TrackedWebSocket;
	tracked.isAlive = true;
	tracked.missedPings = 0;
	ws.on("pong", () => {
		tracked.isAlive = true;
		tracked.missedPings = 0;
		if (typeof tracked.pingSentAt === "number") {
			tracked.latencyMs = Math.max(0, Math.round(performance.now() - tracked.pingSentAt));
		}
	});
	tracked.pingSentAt = performance.now();
	try {
		ws.ping();
	} catch {
		/* ignore */
	}

	// Count attached sockets (the control socket reports REAL sockets, not
	// cached client-session objects).
	service.noteSocketOpen();
	let clientId: string | null = null;
	let closed = false;
	/** 最近一份全量 snapshot 的估算字节数（UTF-16 ×2），供背压相对阈值用（issue #11）。 */
	let lastSnapshotBytes = 0;
	/** Commands received while the session is still being created — replayed after attach.
	 *  带上限（256 条）：attach 挂死/失败保活期间队列不再无界增长，超限丢最旧并告警。 */
	const pending = new PendingCommandQueue();
	/** attach 完成（含首快照）前一律排队（见 hello 分支的重放）：
	 *  ready 先行后，ready 只代表传输通，首快照还没好，直接分发会撞 rev 链断裂。 */
	let attachDone = false;
	/** attach 代际（#699）：hello/switch 每次发起 attach 前 +1，慢 attach 落定时代际过期则只 detach 清理，绝不 flush/replay。 */
	let attachGen = 0;
	/** 背压丢快照后的延迟重发定时器（去重：一次只排一个）。 */
	let snapshotRetryTimer: ReturnType<typeof setTimeout> | null = null;

	// 协议层错误（非法帧/未 masked 帧等）：不注册 handler 会作为 uncaught
	// exception 打崩整个进程（issue #11 附带发现）。记日志并按坏连接关闭。
	ws.on("error", (err) => {
		console.error(`[ws] socket error${clientId ? ` (${clientId})` : ""}:`, err.message);
		try {
			ws.close();
		} catch {
			/* already closing */
		}
	});

	/** 引擎→浏览器的**唯一发送漏斗**：历史消息窗口化（按需加载）在它前面一层，
	 *  见下方 `send`。四个引擎（pi / DSH / claude / durable）都走这条漏斗，引擎侧零改动。 */
	const sendRaw = (msg: ServerMessage): void => {
		if (closed || ws.readyState !== WebSocket.OPEN) return;
		// 发送背压（issue #11）：socket 消费不过来时（前端慢/网络差），堆里会堆积
		// 每份可达 ~10MB 的全量 snapshot 字符串，低内存主机直接 OOM。snapshot 是全量
		// 幂等的且稍后必有更新的一份，可以安全丢弃——在序列化之前丢，连
		// stringify 的分配都省掉。ready/notice/error/tool_delta 等消息必须送达。
		// 阈值相对化（评论区建议）：用「最近一份 snapshot 的字节数 × 倍数」做基准，
		// 首份无基准不丢（首次必达）。wire.length 是 UTF-16 字符数，×2 估算字节。
		// 下限保护（小会话误伤修复）：小会话一份 snapshot 才 ~1KB，相对阈值只有几
		// KB——前面一批 settings_state/slash_commands 的正常突发就能把 bufferedAmount
		// 抬过阈值，把紧随其后的 snapshot_delta 静默丢掉；而丢弃后若无后续事件就
		// 再也没有快照，客户端永远停在旧状态（前端靠 rev 缺口 get_state 自愈，
		// 协议测试则直接卡死）。绝对下限保证小会话永不触发背压。
		if (
			(msg.type === "snapshot" || msg.type === "snapshot_delta") &&
			lastSnapshotBytes > 0 &&
			ws.bufferedAmount > Math.max(SNAPSHOT_BACKPRESSURE_MIN_BYTES, SNAPSHOT_BACKPRESSURE_FACTOR * lastSnapshotBytes)
		) {
			const wasFull = msg.type === "snapshot";
			// 真正的慢客户端：丢弃是安全的，但不能「丢完就没了」——安排一次延迟
			// 重发，等缓冲排空后快照最终必达（否则若此后再无事件，客户端将永久
			// 停留在旧快照）。重发仍走 flushSnapshot：缓冲未排空则再次顺延；
			// 若被丢弃的是全量快照（snapshot），重发必须强制 forceFull 保证客户端能拿到完整基线。
			if (!snapshotRetryTimer) {
				snapshotRetryTimer = setTimeout(() => {
					snapshotRetryTimer = null;
					service.get(clientId ?? "")?.flushSnapshot(wasFull);
				}, SNAPSHOT_RETRY_MS);
			}
			return;
		}
		const wire = serializeShared(msg);
		if (msg.type === "snapshot") lastSnapshotBytes = wire.length * 2;
		ws.send(wire);
	};

	/** 本连接的历史窗口状态（每标签页一份，见 server/message-window.ts）。
	 *  `send` 必须包在 `sendRaw` **外面**：窗口先裁消息，再算背压字节数——否则
	 *  背压阈值还在按未裁剪的 10MB 量级估。 */
	const windowTap = new MessageWindowTap(sendRaw, readMessageWindowConfig(process.env));
	const send = (msg: ServerMessage): void => windowTap.accept(msg);

	const dispatch = (msg: ClientMessage): void => {
		if (!clientId) {
			pending.push(msg);
			return;
		}

		const cs = service.get(clientId);
		if (!cs || !attachDone) {
			// Session not ready yet (hello processing) — hold the command.
			pending.push(msg);
			return;
		}
		// 历史窗口按需加载：连接级窗口化直接服务（四个引擎通吃，不依赖引擎实现）。
		// 放在引擎分发之前：它不是引擎能力，窗口化关闭时静默无回执（前端保持现状）。
		if (msg.type === "load_earlier_messages") {
			windowTap.loadEarlier(msg.count, msg.all, msg.conversationId);
			return;
		}
		// Managed instances do not install software on themselves, and tabs this
		// instance does not offer stay closed. Both refusals live here, on the
		// server, because hiding them in the client would still leave the message
		// reachable to anything that can open the socket. See managed.ts / tabs.ts.
		const refusal = managedRefusal(msg.type, MANAGED) ?? tabsRefusal(msg.type, TABS);
		if (refusal) {
			send({ type: "notice", level: "error", text: refusal });
			return;
		}
		try {
			if (handleFileMessage(msg, cs)) return;
			if (handleWorktreeMessage(msg, cs)) return;
			if (handleBgServerMessage(msg, cs)) return;
			if (handlePresetAndDshMessage(msg, cs)) return;
			if (handleModelAndProviderMessage(msg, cs)) return;
			if (handleTerminalMessage(msg, cs)) return;
			if (handleSessionLifecycleMessage(msg, cs)) return;
			if (handlePlanAndGoalMessage(msg, cs)) return;
			if (handleScheduleMessage(msg, scheduler, send)) return;
			if (handleSettingsMessage(msg, cs)) return;
			if (handleInteractiveResponseMessage(msg, cs, service, clientId, send)) return;

			switch (msg.type) {
				case "prompt": {
					const hasAttach = Boolean(msg.attachments && msg.attachments.length > 0);
					if (!msg.text?.trim() && !hasAttach) {
						send({
							type: "notice",
							level: "warning",
							text: "发送已忽略：提示词为空且未附带文件或上下文引用。",
							textEn: "Prompt ignored: text is empty and no attachments were provided.",
						});
						break;
					}
					void cs.prompt(msg.text, msg.attachments, msg.queue);
					break;
				}
				case "queue_remove":
					// #491：removeQueued 是 async——dispatch 是 fire-and-forget，缺 void 时
					// 内部抛错即 unhandledRejection，而全仓没有兜底 handler，Node ≥15 直接崩进程。
					void cs.removeQueued(msg.kind, msg.text, msg.index);
					break;
				case "draft_update":
					cs.saveDraft?.(msg.sessionId, msg.text, msg.ts);
					break;
				case "abort":
					void cs.abort();
					break;
				case "abort_bash":
					void cs.abortBash();
					break;
				case "retry_last":
					void cs.retryLast();
					break;
				case "get_state":
					// Always a FULL snapshot: the client is (re)connecting or detected
					// a rev/seq gap — it needs an authoritative state to rebuild from.
					cs.flushSnapshot(true);
					break;
				case "get_commands":
					void cs.pushSlashCommands();
					break;
				case "get_tool_info":
					// 工具卡右键菜单的「显示工具详细信息」：按需取一次工具定义（不进快照）。
					// 引擎没实现（或旧版服务端）时回一条 unsupported，前端据此显示「不支持」
					// 而不是永远转圈。
					if (typeof cs.getToolInfo === "function") {
						void cs.getToolInfo(msg.name);
					} else {
						send({ type: "tool_info", name: msg.name, found: false, unsupported: true });
					}
					break;
				case "get_tool_prompt":
					// 设置页逐工具文案编辑器：取「出厂默认 + 当前覆盖」。
					if (typeof cs.getToolPrompt === "function") {
						void cs.getToolPrompt(msg.name);
					} else {
						send({ type: "tool_prompt", name: msg.name, found: false, unsupported: true });
					}
					break;
				case "take_over_conversation":
					if (typeof service.takeOverConversation === "function") {
						void service.takeOverConversation(clientId, msg.owner, msg.id);
					} else {
						send({
							type: "notice",
							level: "error",
							text: "当前引擎不支持过户（take over），请用 pi 引擎",
							textEn: "Takeover is not supported by the current engine; use the pi engine.",
						});
					}
					break;
				case "peek_elsewhere_question":
					if (typeof service.peekElsewhereQuestion === "function") {
						void service.peekElsewhereQuestion(clientId, msg.owner, msg.id);
					} else {
						send({
							type: "notice",
							level: "error",
							text: "当前引擎不支持跨页作答，请用 pi 引擎",
							textEn: "Cross-page answering is not supported by the current engine; use the pi engine.",
						});
					}
					break;
				case "set_locale":
					// UI language report — per-client persist + lang-aware prompt
					// refresh (streaming-safe). Engine-agnostic via DispatchSession.
					void service.setLocale(clientId, msg.locale);
					break;
				case "check_update":
					void cs.checkUpdate();
					break;
				case "check_updates_all":
					void cs.checkUpdatesAll(msg.force === true);
					break;
				case "restart_service": {
					// Same effect as `pi-web-ui server restart`: this process exits and its
					// supervisor brings it back (launchd/systemd immediately, the Windows
					// watchdog within ~10s). Refused without a supervisor — exiting there
					// would just stop the server the user is looking at.
					if (!ORIGIN.supervisor) {
						send({
							type: "notice",
							level: "error",
							text:
								"当前实例不是由 训推引擎组 Harness 服务启动的（前台运行），无法自动重启；" +
								"请在终端里重启，或先用 pi-web-ui server install 安装服务。",
							textEn:
								"This instance runs in the foreground, not as a 训推引擎组 Harness service — " +
								"nothing would bring it back. Restart it in its terminal, or install the service " +
								"with `pi-web-ui server install`.",
						});
						break;
					}
					send({
						type: "notice",
						level: "info",
						text: "正在重启服务…页面会在服务恢复后自动重连，进行中的对话会自动恢复并继续。",
						textEn:
							"Restarting the service… this page reconnects once it is back; running conversations resume automatically.",
					});
					// Record streaming runs BEFORE exiting: under systemd this path
					// exits via process.exit without shutdown(), so without this the
					// post-restart resume would find nothing to continue.
					try {
						service.recordInterruptedRuns();
					} catch {
						/* best effort — never block the restart on bookkeeping */
					}
					// Let the notice (and this socket's backlog) flush before we go down.
					setTimeout(() => void scheduleQuit(), 400);
					break;
				}
				default: {
					// 未知 type 只计数 + 节流 warn，不改变已知类型行为。
					// default 分支里 msg 已收窄成 never，type 需从宽化后取。
					const raw = (msg as unknown as { type?: unknown }).type;
					const name = typeof raw === "string" ? raw : String(raw);
					const r = recordUnknownWsType(name);
					if (r.warn) console.warn(`[ws] unknown message type "${name}" (x${r.count})`);
					break;
				}
			}
		} catch (err) {
			console.error(`[dispatch error on "${msg.type}"]:`, err);
			if (!closed) {
				send({
					type: "notice",
					level: "error",
					text: `操作「${msg.type}」执行出错：${err instanceof Error ? err.message : String(err)}`,
					textEn: `Error executing "${msg.type}": ${err instanceof Error ? err.message : String(err)}`,
				});
			}
		}
	};

	/** ready 握手帧：首连、重复 hello 与引擎热切共用同一构造，按 clientId 动态携带所属引擎。 */
	const readyMsg = (cid: string): ServerMessage => ({
		type: "ready",
		clientId: cid,
		serverVersion: VERSION,
		protocolVersion: PROTOCOL_VERSION,
		engine: resolveClientEngine(cid),
		engineCapabilities: ensureEngine(resolveClientEngine(cid)).getCapabilities?.(),
		// This package's own version. `serverVersion` is the pi SDK's,
		// and the client used to learn ours from the update check —
		// which a managed instance never runs.
		appVersion: appVersion(),
		buildId: buildId(),
		managed: MANAGED,
		tabs: TABS ? [...TABS] : undefined,
		service: SERVICE_INFO ?? undefined,
	});

	ws.on("message", (data) => {
		tracked.isAlive = true;
		tracked.missedPings = 0;
		let msg: ClientMessage;
		try {
			msg = JSON.parse(data.toString()) as ClientMessage;
		} catch {
			return;
		}

		if (msg.type === "hello") {
			// 重放守卫：一条连接只允许 attach 一次。clientId 已赋值说明 hello 处理过
			//（或进行中），再来的 hello 幂等回一条 ready 即可——否则重复 hello 会把
			// service.attach 整个再跑一遍：重型 ClientSession 重复创建 + 旧 send sink
			// 永久泄漏。
			if (clientId) {
				if (!closed) send(readyMsg(clientId));
				return;
			}
			// clientId 校验：外部输入，类型/长度/字符集不合格直接换 randomUUID()——
			// 它随后成为 ClientSession key 与上传落盘目录名（uploads/<clientId>/，
			// saveUpload 的两条路径都从这里来，入口统一拦一次即可）。
			const cid = validateClientId(msg.clientId) ?? randomUUID();
			clientId = cid;
			if (msg.locale) {
				const code = msg.locale.trim().slice(0, 16);
				if (code) sharedStateStore.saveLocale(cid, code);
			}
			// issue #295：ready 先行 —— 传输握手不等待会话初始化。attach 会进 SDK 的
			// resourceLoader.reload 等同步目录扫描，坏挂载/家目录下可能阻塞数十秒；
			// ready 在握手里先发，前端立刻离开「正在连接」（快照随后到）。
			if (!closed) {
				send(readyMsg(cid));
			}
			// attach 慢提示：本体继续等，不取消；完成后照常走快照流程。
			const slowTimer = setTimeout(() => {
				if (closed) return;
				send({
					type: "notice",
					level: "warning",
					text: "会话初始化耗时较长（可能在扫描工作区目录），请稍候…",
					textEn: "Session init is taking a while (possibly scanning the workspace) — hang on…",
				});
			}, ATTACH_SLOW_NOTICE_MS);
			const helloSvc = ensureEngine(resolveClientEngine(cid));
			const helloGen = ++attachGen;
			helloSvc
				.attach(cid, send)
				.then((cs) => {
					clearTimeout(slowTimer);
					if (closed) {
						helloSvc.detach(cid, send);
						return;
					}
					if (helloGen !== attachGen) {
						// hello 慢 attach 落定前用户已切换：旧引擎会话成孤儿，只清理（#699）
						helloSvc.detach(cid, send);
						return;
					}
					// hello may carry the UI locale — persist it before replaying
					// anything queued during startup (issue #91).
					if (msg.locale) void service.setLocale(cid, msg.locale);
					// 新连接/新客户端 attach 首次快照必须强制全量（forceFull=true），
					// 保证新标签页/刷新页能立刻拿到完整的会话基线，绝不因增量 delta 而卡在加载中。
					cs.flushSnapshot(true);
					// 内置定时任务列表随附推一次（后续变更经 pushSchedulerTasks 广播）。
					try {
						send({ type: "scheduler_tasks", tasks: scheduler.list() });
					} catch {
						/* 推送失败不挡快照 */
					}
					// attach 期间收到的命令先排队（dispatch 里的 pending），attach 完成后再重放。
					attachDone = true;
					for (const m of pending.drain()) dispatch(m);
				})
				.catch((err: unknown) => {
					clearTimeout(slowTimer);
					if (closed) {
						service.detach(cid, send);
					}
					// Admission refused (quiesce): close the socket so the browser
					// reconnect loop keeps retrying until admission reopens. Do NOT
					// leave a half-alive connection that can only show an error.
					clearTimeout(slowTimer);
					if (err instanceof QuiesceRejectedError) {
						closed = true;
						if (ws.readyState === WebSocket.OPEN) {
							// 先发 4403 关闭帧，等它刷出去再真正撕连接：close 后立刻
							// terminate 会把关闭握手一起掐掉，客户端只能看到 1006
							// （quiesce-test 的 brand-new client 断言 4403）。
							try {
								ws.close(4403, "quiesced");
							} catch {
								/* already closing */
							}
							setTimeout(() => {
								try {
									if (ws.readyState !== WebSocket.CLOSED) ws.terminate?.();
								} catch {
									/* ignore */
								}
							}, 500);
						} else {
							try {
								ws.terminate?.();
							} catch {
								/* ignore */
							}
						}
						return;
					}
					// Real init failure (bad agent dir etc.) — keep the connection
					// open so the user can see the error and fix it.
					// 排队的命令此时无会话可服务，直接丢弃（否则 attachDone 永 false，
					// 队列越积越深；用户修好后重连会重发 get_state）。
					pending.clear();
					send({
						type: "notice",
						level: "error",
						text: `会话初始化失败：${(err as Error).message}`,
						textEn: `Failed to initialize session: ${(err as Error).message}`,
					});
				});
			return;
		}

		dispatch(msg);
	});

	ws.on("close", () => {
		service.noteSocketClose();
		closed = true;
		pending.clear();
		if (snapshotRetryTimer) {
			clearTimeout(snapshotRetryTimer);
			snapshotRetryTimer = null;
		}
		if (clientId) service.detach(clientId, send);
	});
});

// When spawned by the old process as an auto-restart replacement, wait for
// the old instance to release the port before binding (it exits right after
// spawning us). Probe by attempting a connection: refused = free.
if (process.env[RESTART_CHILD_ENV] === "1") {
	const deadline = Date.now() + 20_000;
	const portFree = () =>
		new Promise<boolean>((resolve) => {
			const sock = createConnection({ port: PORT, host: "127.0.0.1" });
			sock.once("connect", () => {
				sock.destroy();
				resolve(false); // busy — old instance still up
			});
			sock.once("error", () => resolve(true)); // refused → free
			sock.setTimeout(500, () => {
				sock.destroy();
				resolve(false);
			});
		});
	while (Date.now() < deadline) {
		if (await portFree()) break;
		await new Promise((r) => setTimeout(r, 300));
	}
}

httpServer.listen(PORT, HOST, () => {
	console.log("");
	console.log("  ⚡ 训推引擎组 Harness — web chat for the pi coding agent");
	console.log(`    http://localhost:${PORT}`);
	console.log(`    workspace   : ${CWD}`);
	console.log(`    session dir : ${SESSION_DIR_ROOT}`);
	console.log(`    pi SDK      : v${VERSION}`);
	// issue #260：全局那份 pi SDK 不是服务在用的那份（自带副本赢在 Node 解析顺序上）。
	// #321 起默认已反转（resolve-global-sdk 自动跟随更新的那份），这条提示只在
	// 「进程没跟上」（升级发生在启动后 / 旧构建没注入钩子）或显式 PI_WEB_SDK=bundled
	// 钉死自带副本时出现。
	const sdkNote = sdkOriginNote(sdkCopies(), VERSION);
	if (sdkNote) {
		console.log(`    pi SDK note : ${sdkNote}`);
	}
	console.log(`    bind        : ${HOST}:${PORT}`);
	console.log("");
});

// 上传文件保留期清理：启动扫一次 + 每 6 小时一次（best-effort，见 uploads.ts）
scheduleUploadCleanup();

// Local control socket (status / quiesce / unquiesce) — same data dir the
// CLI uses, so `pi-web-ui server status|quiesce|unquiesce` just works.
const stopControl = startControlServer({ service, dataDir: DATA_DIR, port: PORT });

/**
 * Graceful shutdown budget (issue #172): disposeAll() can hang forever on a
 * stuck session runtime / PTY / pending handle, and the process would then
 * sit forever with no way out. The watchdog guarantees the process is gone
 * within this long no matter what — unref'd so a clean shutdown never
 * waits on it.
 */
const SHUTDOWN_FORCE_EXIT_MS = 5000;

let shuttingDown = false;
/**
 * SIGINT / SIGTERM handler. A second signal while a shutdown is already
 * running exits immediately (130 = killed by SIGINT, 143 = SIGTERM) instead
 * of being swallowed by the shuttingDown guard — previously a hung first
 * shutdown made Ctrl+C look completely dead (issue #172).
 */
async function shutdown(signal: "SIGINT" | "SIGTERM" = "SIGINT"): Promise<void> {
	if (shuttingDown) {
		console.log("\n再次收到中断信号，强制退出…");
		process.exit(signal === "SIGTERM" ? 143 : 130);
	}
	shuttingDown = true;
	console.log("\nshutting down…");
	// Windows ConPTY 兜底看门狗（issue #215）：主线程若死锁在 native
	// ClosePseudoConsole 里，事件循环冻结，进程内的 forceExitTimer 永远触发不了 ——
	// 只能靠外部进程收尾。超时取 forceExit + 余量（只在进程内兜底失效时才开火）；
	// 正常退出在 finally 里取消，避免误杀 + PID 复用竞态。
	// taskkill 必须带 /T（树杀）：只杀单个 node.exe 会留下 node-pty 派生的
	// conhost --headless / bash，控制台永远不回提示符；/T 连它们一起收走。
	// 不用 detached：Windows 会给 detached 子进程分配可见控制台窗口（黑框一闪），
	// 而看门狗根本不需要脱离——父进程死锁时它照样能跑，父进程正常退出时 finally
	// 里会取消它；父进程崩掉时看门狗也没了，但那时本来就不需要收尾。
	// cmd.exe 是无 GUI 的控制台宿主，windowsHide 藏的是它一闪而过的黑窗口。
	let disarmKiller: (() => void) | null = null;
	if (process.platform === "win32") {
		try {
			const { spawn } = await import("node:child_process");
			const killer = spawn(
				"cmd.exe",
				[
					"/c",
					`timeout /t ${Math.ceil((SHUTDOWN_FORCE_EXIT_MS + 5000) / 1000)} /nobreak >nul && taskkill /F /T /PID ${process.pid}`,
				],
				{ stdio: "ignore", windowsHide: true },
			);
			killer.unref();
			disarmKiller = () => {
				try {
					killer.kill();
				} catch {
					// 已退出/杀不掉：看门狗使命本来就是收尾，无需上报
				}
			};
		} catch {
			// 看门狗起不来：回落进程内 forceExitTimer，不阻断关机
		}
	}
	const forceExitTimer = setTimeout(() => {
		console.error("shutdown 超时仍未完成，强制退出…");
		process.exit(1);
	}, SHUTDOWN_FORCE_EXIT_MS);
	forceExitTimer.unref();
	let code = 0;
	try {
		clearInterval(heartbeatTimer);
		stopControl();
		scheduler.stop();
		await globalLspPool.shutdownAll();
		await service.disposeAll();
		// Don't let dead browsers hold the exit open: half-open WebSocket /
		// keep-alive HTTP connections (e.g. test clients killed without
		// closing) would otherwise keep close() from ever finishing — drop
		// them first so shutdown stays prompt.
		for (const ws of wss.clients) {
			try {
				ws.terminate();
			} catch {
				/* already gone */
			}
		}
		wss.close();
		httpServer.closeAllConnections();
		httpServer.close();
	} catch (err) {
		code = 1;
		console.error("shutdown 释放资源时出错:", err);
	} finally {
		clearTimeout(forceExitTimer);
		disarmKiller?.();
		process.exit(code);
	}
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason: unknown) => {
	console.error("[pi-web-ui] Unhandled Promise Rejection:", reason);
});
process.on("uncaughtException", (err: Error) => {
	console.error("[pi-web-ui] Uncaught Exception:", err);
});
