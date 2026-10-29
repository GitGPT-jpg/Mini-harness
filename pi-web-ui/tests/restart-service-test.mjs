/**
 * 「重启服务」判定 + 协议测试（更新面板那个按钮的服务端一侧）：
 *
 *  1. 服务实例（`pi-web-ui server start|install` 起的：新版 install 烘焙了
 *     PI_WEB_LAUNCHED_BY=service / PI_WEB_SERVICE_NAME=<name>）——
 *     ready.service 带上 supervisor、控制 socket status 也带上（CLI `server
 *     status` 显示的启动方式），restart_service 让进程退出（真服务由 supervisor
 *     拉起；这里没有 supervisor，所以只看它确实退出了）。
 *  2. 前台实例（无标记、也没有 launchd/systemd/watchdog 痕迹；环境里的
 *     supervisor 标记先显式清掉，免得 CI runner 自己跑在 systemd 下被继承）——
 *     ready.service 缺省、status.service 为 null、restart_service 被拒绝，
 *     且进程继续运行（不会把用户正看着的服务关掉）。
 *
 * 运行：npm run build 之后 `node tests/restart-service-test.mjs`
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";

const REPO = resolve(process.cwd());
const ENTRY = join(REPO, "dist", "server", "index.js");
const PORT_SVC = 8972; // 服务实例（伪造启动器环境变量）
const PORT_FG = 8973; // 前台实例
const PORT_LEGACY = 8974; // 已装好的老服务：只有 PID 文件 + watchdog ps1，没有环境变量
const EXPECTED_SUPERVISOR =
	process.platform === "win32" ? "windows-watchdog" : process.platform === "darwin" ? "launchd" : "systemd";

let failures = 0;
function check(name, cond, extra = "") {
	if (cond) {
		console.log(`  ✅ ${name}`);
	} else {
		failures++;
		console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

/** Start one server instance on its own port + temp data dir. */
function startServer(port, extraEnv = {}) {
	const data = mkdtempSync(join(tmpdir(), "pi-web-restart-"));
	const proc = spawn(process.execPath, [ENTRY], {
		env: {
			...process.env,
			PI_WEB_PORT: String(port),
			PI_WEB_DATA_DIR: data,
			PI_WEB_CWD: REPO,
			...extraEnv,
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	proc.stdout.on("data", () => {});
	proc.stderr.on("data", () => {});
	return { proc, data };
}

async function waitHealth(port, ms = 25_000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/health`);
			if (res.ok) return true;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	return false;
}

/** One WS client: resolves on `ready`, collects notices, tracks close. */
function session(port, clientId) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
		origin: `http://127.0.0.1:${port}`,
		headers: { host: `127.0.0.1:${port}` },
	});
	const s = { ws, ready: null, notices: [], closed: false };
	s.readyPromise = new Promise((res) => {
		ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId })));
		ws.on("message", (d) => {
			let m;
			try {
				m = JSON.parse(d.toString());
			} catch {
				return;
			}
			if (m.type === "ready") {
				s.ready = m;
				res(m);
			} else if (m.type === "notice") {
				s.notices.push(m);
			}
		});
		ws.on("close", () => {
			s.closed = true;
		});
		ws.on("error", () => {});
	});
	return s;
}

function withTimeout(promise, ms, fallback = null) {
	return Promise.race([promise, sleep(ms).then(() => fallback)]);
}

/** 控制 socket 一条 status（CLI `server status` 走的就是这条路）。 */
function controlStatus(dataDir, port) {
	const path = process.platform === "win32" ? `\\\\.\\pipe\\pi-web-ui-${port}` : join(dataDir, "pi-web-ui.sock");
	return new Promise((res) => {
		const sock = createConnection(path);
		let buf = "";
		const timer = setTimeout(() => {
			sock.destroy();
			res(null);
		}, 4000);
		sock.on("connect", () => sock.write(JSON.stringify({ cmd: "status" }) + "\n"));
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			clearTimeout(timer);
			sock.destroy();
			try {
				res(JSON.parse(buf.slice(0, nl)));
			} catch {
				res(null);
			}
		});
		sock.on("error", () => {
			clearTimeout(timer);
			res(null);
		});
	});
}

/** Wait until the process really exited (graceful shutdown takes ~300ms + dispose). */
async function waitExit(proc, ms = 15_000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null || proc.signalCode !== null) return true;
		await sleep(200);
	}
	return false;
}

const svc = startServer(PORT_SVC, { PI_WEB_LAUNCHED_BY: "service", PI_WEB_SERVICE_NAME: "pi-web-ui" });
// 前台实例：显式清掉 supervisor 痕迹 —— CI runner 自己就跑在 systemd 下，
// INVOCATION_ID 会被子进程继承，不清就会把「前台」误判成服务实例（macOS 的
// XPC_SERVICE_NAME、启动器变量同理）。
const fg = startServer(PORT_FG, {
	PI_WEB_LAUNCHED_BY: "",
	PI_WEB_SERVICE_NAME: "",
	INVOCATION_ID: "",
	XPC_SERVICE_NAME: "",
});

try {
	check("服务实例启动", await waitHealth(PORT_SVC));
	check("前台实例启动", await waitHealth(PORT_FG));

	// --- 1. 服务实例：认得出 supervisor，重启会让进程退出 -------------------
	const s1 = session(PORT_SVC, "svc-client");
	const ready1 = await withTimeout(s1.readyPromise, 8000);
	check(
		"ready.service 带 supervisor（界面据此显示「重启服务」）",
		ready1?.service?.supervisor === EXPECTED_SUPERVISOR && ready1?.service?.name === "pi-web-ui",
		JSON.stringify(ready1?.service),
	);
	const st1 = await controlStatus(svc.data, PORT_SVC);
	check(
		"控制 socket status 带 service（CLI `server status` 显示启动方式）",
		st1?.service?.supervisor === EXPECTED_SUPERVISOR,
		JSON.stringify(st1?.service),
	);

	s1.ws.send(JSON.stringify({ type: "restart_service" }));
	check("restart_service 回执「正在重启」", await waitNotice(s1, "info"));
	check("服务实例按重启语义退出（supervisor 会拉起）", await waitExit(svc.proc));

	// --- 2. 前台实例：没有 supervisor，拒绝重启且继续运行 -------------------
	const s2 = session(PORT_FG, "fg-client");
	const ready2 = await withTimeout(s2.readyPromise, 8000);
	check("前台实例 ready.service 缺省（界面不显示按钮）", ready2 !== null && ready2.service === undefined);
	const st2 = await controlStatus(fg.data, PORT_FG);
	check("控制 socket status: service = null", st2 !== null && st2.service === null, JSON.stringify(st2?.service));

	s2.ws.send(JSON.stringify({ type: "restart_service" }));
	check("restart_service 被拒绝（error notice）", await waitNotice(s2, "error"));
	await sleep(1200);
	check("前台实例仍在运行（没被关掉）", fg.proc.exitCode === null && fg.proc.signalCode === null);
	check("前台实例连接仍然活着", !s2.closed);

	// --- 3. 已装好的老服务（无环境变量）：靠 PID 文件 + ps1 里的 watchdog 循环
	// 认得出来。Windows 专属路径（launchd/systemd 走各自的运行时痕迹）。
	if (process.platform === "win32") {
		// 模拟 `server install` 的启动器：%APPDATA%\pi-web-ui\<name>.pid 里是
		// powershell 的 PID，而 server 是它的直接子进程 → 本测试进程的 PID 正好
		// 能冒充那个父进程（子进程的 ppid = 本进程）。
		const appData = mkdtempSync(join(tmpdir(), "pi-web-appdata-"));
		const svcDir = join(appData, "pi-web-ui");
		mkdirSync(svcDir, { recursive: true });
		writeFileSync(join(svcDir, "pi-web-ui.pid"), String(process.pid));
		writeFileSync(
			join(svcDir, "pi-web-ui.ps1"),
			"try {\r\n  while ($true) {\r\n    & node server.js\r\n    Start-Sleep 10\r\n  }\r\n}",
		);
		const legacy = startServer(PORT_LEGACY, { APPDATA: appData, PI_WEB_LAUNCHED_BY: "", PI_WEB_SERVICE_NAME: "" });
		check("老服务实例启动", await waitHealth(PORT_LEGACY));
		const s3 = session(PORT_LEGACY, "legacy-client");
		const ready3 = await withTimeout(s3.readyPromise, 8000);
		check(
			"老服务（只有 PID 文件痕迹）也认得出 supervisor",
			ready3?.service?.supervisor === "windows-watchdog" && ready3?.service?.name === "pi-web-ui",
			JSON.stringify(ready3?.service),
		);
		try {
			legacy.proc.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}
} finally {
	for (const p of [svc.proc, fg.proc]) {
		try {
			p.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}
}

console.log(failures === 0 ? "\n✅ restart-service-test passed" : `\n❌ restart-service-test: ${failures} 处失败`);
process.exit(failures === 0 ? 0 : 1);

/** Wait for a notice of the given level. */
async function waitNotice(s, level, ms = 8000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (s.notices.some((n) => n.level === level)) return true;
		await sleep(100);
	}
	return false;
}
