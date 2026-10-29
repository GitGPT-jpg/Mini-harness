/**
 * 跨平台测试辅助：端口探测与清理。
 * 替代 macOS/Linux 专属的 lsof（Windows 上不存在，导致整批测试无法运行）。
 */
import { createConnection } from "node:net";
import { execSync } from "node:child_process";

/** TCP 连接探测：端口有监听时 resolve(true)，否则 false。 */
export function portUp(port, host = "127.0.0.1", timeoutMs = 500) {
	return new Promise((resolve) => {
		const socket = createConnection({ port, host });
		const done = (v) => {
			socket.destroy();
			resolve(v);
		};
		const timer = setTimeout(() => done(false), timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			done(true);
		});
		socket.once("error", () => {
			clearTimeout(timer);
			done(false);
		});
	});
}

/** 尽力清掉占用端口的进程（posix: lsof+kill；win32: netstat+taskkill）。 */
export function freePort(port) {
	try {
		if (process.platform === "win32") {
			const out = execSync(
				`netstat -ano -p tcp | findstr LISTENING | findstr ":${port} "`,
				{ stdio: ["ignore", "pipe", "ignore"] },
			).toString();
			const pids = new Set(
				out
					.split("\n")
					.map((line) => line.trim().split(/\s+/).pop())
					.filter((pid) => /^\d+$/.test(pid)),
			);
			for (const pid of pids) {
				if (pid !== String(process.pid)) {
					try {
						execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
					} catch {
						/* already gone */
					}
				}
			}
		} else {
			execSync(`lsof -ti :${port} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`, {
				stdio: "ignore",
				shell: "/bin/bash",
			});
		}
	} catch {
		/* port already free */
	}
}
