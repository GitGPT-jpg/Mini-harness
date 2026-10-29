/**
 * pm2-manager 插件 E2E（零 token、自包含、独立临时 dataDir/端口）。
 *
 * 覆盖真实宿主接线（单测只到假宿主，manifest 是否被宿主接受、路由是否真挂上、
 * 激活是否真跑完，只有起真服务器才算数）：
 *   1. manifest 被接受：插件出现在 `plugins` 推送里且没有 error；
 *   2. `view:false`（没有独立面板）+ `ui["tasks.panel"]` 一条 kind=view（内嵌进宿主「后台任务」面板）；
 *   3. 服务端入口真激活（stdout 有 activated 日志，且无 [plugin:pm2-manager] 报错）；
 *   4. 三个 HTTP 路由可用：GET /status 回结构化状态、POST /action 的非法入参被挡（ok:false）、
 *      已删的 /scan 真回 404（遗留实例扫描交给宿主面板，不重复实现）；
 *   5. 未装 pm2 时面板拿到的是「可安装」状态而不是崩（status.installCommand 有值）。
 *
 * 插件**不接管 bash**：不订阅 onToolPre / onToolPost，不管 AI 怎么写后台命令。
 *
 * 运行：npm run build && node tests/pm2-manager-plugin-test.mjs（已进 tests/run-smoke.mjs）
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 30000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const PLUGIN_ID = "pm2-manager";

const root = mkdtempSync(join(tmpdir(), "pi-pm2-manager-"));
const dataDir = join(root, "data");
const work = join(root, "work");
mkdirSync(work, { recursive: true });

// 把仓库里的插件原样装进临时 dataDir（与用户从市场安装同一条路径：<dataDir>/plugins/<id>/）
const srcPlugin = resolve(__dirname, "../plugins", PLUGIN_ID);
const dstPlugin = join(dataDir, "plugins", PLUGIN_ID);
mkdirSync(dirname(dstPlugin), { recursive: true });
cpSync(srcPlugin, dstPlugin, { recursive: true });

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

let proc = null;
let sock = null;
let serverLog = "";
/** 连接建立后收到的全部消息（plugins 这类推送可能在 hello 之前就到，先存下来再查）。 */
const messages = [];

const connect = (clientId) =>
	new Promise((resolve, reject) => {
		const s = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("connect timeout")), 20_000);
		s.on("error", reject);
		s.on("open", () => s.send(JSON.stringify({ type: "hello", clientId })));
		s.on("message", (raw) => {
			let m;
			try {
				m = JSON.parse(raw.toString());
			} catch {
				return;
			}
			messages.push(m);
			if (m.type === "ready") {
				clearTimeout(timer);
				resolve(s);
			}
		});
	});

/** 先查已收到的，再等新的。 */
const waitMsg = (pred, label, timeoutMs = 20_000) => {
	const hit = messages.find(pred);
	if (hit) return Promise.resolve(hit);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sock.off("message", onMsg);
			reject(new Error(`timeout waiting for ${label}`));
		}, timeoutMs);
		const onMsg = (raw) => {
			let m;
			try {
				m = JSON.parse(raw.toString());
			} catch {
				return;
			}
			if (pred(m)) {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve(m);
			}
		};
		sock.on("message", onMsg);
	});
};

const postJson = async (path, body) => {
	const r = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	return { status: r.status, json: await r.json().catch(() => null) };
};

async function main() {
	proc = spawn(process.execPath, [resolve(__dirname, "../dist/server/index.js")], {
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: work },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stdout.on("data", (d) => {
		serverLog += String(d);
	});
	proc.stderr.on("data", (d) => {
		serverLog += String(d);
	});

	const t0 = Date.now();
	for (;;) {
		try {
			if ((await fetch(`${BASE}/api/health`)).ok) break;
		} catch {
			/* 还没起来 */
		}
		if (Date.now() - t0 > 30_000) throw new Error("server not ready");
		await new Promise((r) => setTimeout(r, 300));
	}
	check("服务器起来了", true, `:${PORT}`);

	sock = await connect("pm2-manager-test");

	// ── 1. 插件被宿主接受（plugins 推送里没有 error）──────────────────────────
	const pluginsMsg = await waitMsg((m) => m.type === "plugins", "plugins", 10_000).catch(() => null);
	const info = pluginsMsg?.plugins?.find((p) => p.id === PLUGIN_ID);
	check(
		"manifest 被接受且无激活错误",
		Boolean(info) && !info.error,
		info
			? `name=${info.name} hasClient=${info.hasClient}${info.error ? ` error=${info.error}` : ""}`
			: "未出现在 plugins 列表",
	);

	// ── 2. 内嵌进「后台任务」面板：view:false + tasks.panel 一条 kind=view ──────────────
	sock.send(JSON.stringify({ type: "plugin_api_catalog", requestId: "cat-1" }));
	const catMsg = await waitMsg(
		(m) => m.type === "plugin_api_catalog_result" && m.requestId === "cat-1",
		"plugin_api_catalog_result",
	).catch(() => null);
	const tasksSlot = catMsg?.catalog?.slots?.find((s) => s.slot === "tasks.panel");
	const occupant = tasksSlot?.occupants?.find((o) => o.pluginId === PLUGIN_ID);
	const panelItem = info?.ui?.items?.find((it) => it.slot === "tasks.panel");
	check("没有独立面板（view:false）", info?.view === false);
	check("占住 tasks.panel 槽位", Boolean(occupant) && occupant.items >= 1, JSON.stringify(occupant ?? null));
	check(
		"槽位条目是 kind=view（面板内嵌渲染本插件）",
		panelItem?.kind === "view" && panelItem?.view === `plugin:${PLUGIN_ID}`,
		JSON.stringify(panelItem ? { kind: panelItem.kind, view: panelItem.view } : null),
	);

	// ── 3. 服务端入口真激活 ─────────────────────────────────────────────────
	const tWaitActivated = Date.now();
	while (!serverLog.includes("pm2-manager activated") && Date.now() - tWaitActivated < 5000) {
		await new Promise((r) => setTimeout(r, 100));
	}
	check("activate 跑完（日志可见）", serverLog.includes("pm2-manager activated"));
	const pluginErrors = serverLog
		.split(/\r?\n/)
		.filter((line) => line.includes(`[plugin:${PLUGIN_ID}]`) && /error|invalid|ignored|failed|reject/i.test(line));
	check("无插件运行时报错", pluginErrors.length === 0, pluginErrors.slice(0, 2).join(" | "));

	// ── 4. HTTP 路由 ────────────────────────────────────────────────────────
	const statusRes = await fetch(`${BASE}/plugins-api/${PLUGIN_ID}/status`);
	const status = await statusRes.json().catch(() => null);
	check(
		"GET /status 回结构化状态",
		statusRes.ok &&
			typeof status?.installed === "boolean" &&
			status?.guardMode === undefined &&
			status?.platform === process.platform,
		JSON.stringify({ installed: status?.installed, platform: status?.platform }),
	);
	check(
		"未装 pm2 时给出安装路径（不崩）",
		status?.installed === true || String(status?.installCommand ?? "").includes("pm2"),
		String(status?.installCommand ?? status?.version ?? ""),
	);

	const bad = await postJson(`/plugins-api/${PLUGIN_ID}/action`, { action: "explode", name: "" });
	check("POST /action 挡非法入参", bad.json?.ok === false, JSON.stringify(bad.json?.error ?? ""));

	const gone = await postJson(`/plugins-api/${PLUGIN_ID}/scan`);
	check("已删的 /scan 真回 404（遗留实例交给宿主面板）", gone.status === 404, `status=${gone.status}`);
}

main()
	.catch((err) => {
		failures++;
		console.error(`✗ ${err?.stack ?? err}`);
	})
	.finally(async () => {
		try {
			sock?.close();
		} catch {
			/* ignore */
		}
		try {
			proc?.kill();
		} catch {
			/* ignore */
		}
		await new Promise((r) => setTimeout(r, 500));
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		console.log(failures === 0 ? "\npm2-manager 插件 E2E 全过" : `\npm2-manager 插件 E2E 失败 ${failures} 项`);
		process.exit(failures === 0 ? 0 : 1);
	});
