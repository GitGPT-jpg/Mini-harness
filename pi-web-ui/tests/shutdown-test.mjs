#!/usr/bin/env node
// issue #172 — SIGINT 关机必须让进程自己退出，不能永久挂起。
//
// 起一个真 server（独立端口 + 临时 data-dir），留下一个没关的 WS 连接
// （死掉的浏览器页）和一个永远发不完 body 的 POST 半开连接，然后只发一次
// SIGINT，要求进程自己退出且退出码为 0。旧代码在 dispose 卡住时会永久挂起
// （第二次 SIGINT 还被吞掉），本测试用自己的 20 秒超时兜底：超时则判 FAIL
// （并 SIGKILL 清理），绝不在 CI 里跟着挂起。
//
// 注意：win32 下跨进程 SIGINT 到不了 handler，本文件开头直接 SKIP（exit 0），
// ubuntu CI 正常跑。
//
// Usage: node tests/shutdown-test.mjs [port]
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import WebSocket from "ws";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform === "win32") {
	console.log(
		"SKIP shutdown-test — win32 下跨进程 SIGINT 到不了服务进程的 handler（直接按信号死亡），不断言退出码；ubuntu CI 正常跑",
	);
	process.exit(0);
}
const PORT = Number(process.argv[2] || 8983);
const base = mkdtempSync(join(tmpdir(), "pi-web-shutdown-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const NODE = realpathSync(process.execPath);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, cond, extra = "") {
	if (cond) {
		console.log(`  ok - ${name}`);
	} else {
		failed++;
		console.error(`  FAIL - ${name} ${extra}`);
	}
}

const server = spawn(NODE, [join(repoRoot, "dist", "server", "index.js")], {
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
server.stdout.on("data", () => {});
server.stderr.on("data", () => {});
const serverExited = new Promise((resolve) => {
	server.on("exit", (code, signal) => resolve({ code, signal }));
});

try {
	// 等 /api/health 就绪。
	let up = false;
	for (let i = 0; i < 60; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
			if (res.ok) {
				up = true;
				break;
			}
		} catch {
			/* not up yet */
		}
		await sleep(300);
	}
	check("server booted", up);
	if (!up) throw new Error("server did not become ready");

	// 死浏览器：连上 WS 并 hello，占一个 wss.clients 名额后故意不关。
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});
	ws.send(JSON.stringify({ type: "hello", clientId: "shutdown-probe", locale: "zh-CN" }));
	ws.on("error", () => {}); // 服务退出时连接会被重置：预期内，忽略
	await sleep(800);

	// 半开请求：header 声明 8KB body 只发几个字节就停住，express.json()
	// 会一直等 body，连接保持 busy（非 idle），close() 无法自然收尾。
	const stuck = connect(PORT, "127.0.0.1");
	stuck.on("error", () => {}); // 服务退出时连接会被重置：预期内，忽略
	await new Promise((resolve) => stuck.on("connect", resolve));
	stuck.write(
		`POST /api/health HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\n` +
			`Content-Length: 8192\r\nConnection: keep-alive\r\n\r\nPARTIAL-BODY`,
	);

	// 只发一次 SIGINT：进程必须自己退出（旧代码可能在此永久挂起）。
	const t0 = Date.now();
	server.kill("SIGINT");
	const outcome = await Promise.race([serverExited, sleep(20000).then(() => null)]);
	const elapsed = Date.now() - t0;
	if (outcome === null) {
		check("SIGINT → process exits by itself within 20s", false, "(no exit; SIGKILLing)");
		try {
			server.kill("SIGKILL");
		} catch {
			/* already gone */
		}
		await serverExited;
	} else {
		check("SIGINT → process exits by itself within 20s", true, `(${(elapsed / 1000).toFixed(1)}s)`);
		check("exit code is 0 (clean shutdown, watchdog not fired)", outcome.code === 0, JSON.stringify(outcome));
	}
	ws.terminate();
	stuck.destroy();
	console.log(`\n${failed === 0 ? "PASS" : "FAIL"} shutdown-test`);
} catch (err) {
	failed++;
	console.error("test crashed:", err);
	try {
		server.kill("SIGKILL");
	} catch {
		/* already gone */
	}
	await serverExited;
} finally {
	process.exit(failed === 0 ? 0 : 1);
}
