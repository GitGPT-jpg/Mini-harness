import WebSocket from "ws";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { portUp, freePort } from "./lib/port-utils.mjs";

const PORT = 30000 + Math.floor(Math.random() * 9000);
const REPO_ROOT = process.cwd();
const base = mkdtempSync(join(tmpdir(), "pi-host-metrics-"));
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const NODE = realpathSync(process.execPath);
const server = spawn(NODE, ["dist/server/index.js"], {
	cwd: REPO_ROOT,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: REPO_ROOT,
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: "ignore",
	windowsHide: true,
});

let wsClient = null;
let cleaned = false;
function cleanup() {
	if (cleaned) return;
	cleaned = true;
	if (wsClient && wsClient.readyState === WebSocket.OPEN) {
		try {
			wsClient.close();
		} catch {}
	}
	try {
		server.kill("SIGTERM");
	} catch {}
	freePort(PORT);
	try {
		rmSync(base, { recursive: true, force: true });
	} catch {}
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
	cleanup();
	process.exit(1);
});

try {
	let up = false;
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		try {
			if (await portUp(PORT)) {
				up = true;
				break;
			}
		} catch {}
	}
	if (!up) {
		throw new Error(`服务未能成功启动并在端口 ${PORT} 监听`);
	}

	wsClient = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		wsClient.on("open", resolve);
		wsClient.on("error", reject);
	});

	wsClient.send(JSON.stringify({ type: "hello", clientId: "host-metrics-test" }));

	let lastMsgType = "none";
	const receivedHeartbeat = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`等待带 hostMetrics 的心跳超时，最后收到的消息类型为: ${lastMsgType}`));
		}, 15000);

		wsClient.on("message", (raw) => {
			try {
				const msg = JSON.parse(raw.toString());
				lastMsgType = msg.type;
				if (msg.type === "heartbeat") {
					clearTimeout(timer);
					resolve(msg);
				}
			} catch (e) {
				clearTimeout(timer);
				reject(e);
			}
		});
	});

	if (!receivedHeartbeat.hostMetrics) {
		console.error("  ✗ FAIL: heartbeat 消息缺少 hostMetrics 字段");
		process.exitCode = 1;
	} else {
		const { cpuPercent, memoryPercent } = receivedHeartbeat.hostMetrics;
		const cpuValid =
			cpuPercent === null ||
			(typeof cpuPercent === "number" && Number.isFinite(cpuPercent) && cpuPercent >= 0 && cpuPercent <= 100);
		const memValid =
			typeof memoryPercent === "number" && Number.isFinite(memoryPercent) && memoryPercent >= 0 && memoryPercent <= 100;
		const latencyValid =
			typeof receivedHeartbeat.latencyMs === "number" &&
			Number.isFinite(receivedHeartbeat.latencyMs) &&
			receivedHeartbeat.latencyMs >= 0;

		if (!cpuValid) {
			console.error(`  ✗ FAIL: cpuPercent 不合法: ${cpuPercent}`);
			process.exitCode = 1;
		} else if (!memValid) {
			console.error(`  ✗ FAIL: memoryPercent 不合法: ${memoryPercent}`);
			process.exitCode = 1;
		} else if (!latencyValid) {
			console.error(`  ✗ FAIL: latencyMs 不合法: ${receivedHeartbeat.latencyMs}`);
			process.exitCode = 1;
		} else {
			console.log(`  ✓ heartbeat 携带有效 hostMetrics 与 latencyMs (${receivedHeartbeat.latencyMs}ms) 指标`);
		}
	}
} catch (err) {
	console.error("测试异常:", err);
	process.exitCode = 1;
} finally {
	cleanup();
}
