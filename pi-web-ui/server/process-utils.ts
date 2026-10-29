import { resolve } from "node:path";

/**
 * process-utils — 跨平台进程工具：监听端口快照、进程树查杀、进程名查询。
 * 后台任务面板（bgServers）用它们检测/停止 agent 在后台拉起的服务。
 * 从 agent-service.ts 抽出，行为保持不变。全平台 best-effort：失败静默。
 */

/**
 * 解析 Windows `netstat -ano -p tcp` 输出 → 端口→pid。纯函数，单测覆盖。
 * 行形状：`TCP 0.0.0.0:5173 0.0.0.0:0 LISTENING 12345`。
 */
export function parseNetstatListening(stdout: string): Map<number, number> {
	const m = new Map<number, number>();
	for (const line of stdout.split(/\r?\n/)) {
		const p = line.trim().split(/\s+/);
		if (p.length >= 5 && p[0] === "TCP" && p[3] === "LISTENING") {
			// 本地地址可能是 0.0.0.0:5173 / [::1]:5173 —— 取最后一段就是端口。
			const port = Number(p[1].split(":").pop());
			const pid = Number(p[4]);
			if (Number.isFinite(port) && Number.isFinite(pid)) m.set(port, pid);
		}
	}
	return m;
}

/**
 * 解析 POSIX `lsof -iTCP -sTCP:LISTEN -P -n` 输出 → 端口→pid。纯函数，单测覆盖。
 *
 * NAME 列形如 `*:5173` / `127.0.0.1:5173` / `[::1]:5173`。监听态 `(LISTEN)`
 * 在不同发行版上**要么贴在 NAME 里、要么自成最后一列**，所以“取最后一列”的
 * 写法（旧实现）在后者上拿到的是 `(LISTEN)` 而不是地址 —— 整条 posix 端口探测
 * 静默失效（后台任务面板就看不到 AI 拉起的服务）。这里改成扫列：第一个
 * “以冒号+数字收尾”的列就是地址（FD/TYPE/DEVICE/SIZE-OFF/NODE 都不带这种形状）。
 */
export function parseLsofListening(stdout: string): Map<number, number> {
	const m = new Map<number, number>();
	for (const line of stdout.split(/\r?\n/)) {
		const p = line.trim().split(/\s+/);
		if (p.length < 5) continue;
		const pid = Number(p[1]);
		if (!Number.isFinite(pid) || pid <= 0) continue; // 表头 / 脏行
		const port = findListenPort(p.slice(3));
		if (port === null) continue;
		m.set(port, pid);
	}
	return m;
}

/** 从 lsof 行尾列里找出监听端口（第一个 `:数字` 收尾的列）。 */
function findListenPort(cols: string[]): number | null {
	for (const col of cols) {
		const mm = col.match(/:(\d{1,5})$/);
		if (!mm) continue;
		const port = Number(mm[1]);
		if (port > 0 && port <= 65535) return port;
	}
	return null;
}

/**
 * Snapshot currently LISTENING TCP ports → owning pid. Windows: netstat;
 * POSIX: lsof. Used to detect servers the agent started in the background
 * (the bash tool itself exits, leaving e.g. `npm run dev &` listening).
 */
export async function snapshotListeningPorts(): Promise<Map<number, number>> {
	const m = new Map<number, number>();
	try {
		const { execFile } = await import("node:child_process");
		if (process.platform === "win32") {
			const out = await new Promise<string>((resolve, reject) =>
				execFile("netstat", ["-ano", "-p", "tcp"], { windowsHide: true, timeout: 8000 }, (err, stdout) =>
					err ? reject(err) : resolve(stdout),
				),
			);
			return parseNetstatListening(out);
		}
		const out = await new Promise<string>((resolve, reject) =>
			execFile("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n"], { timeout: 8000 }, (err, stdout) =>
				err ? reject(err) : resolve(stdout),
			),
		);
		return parseLsofListening(out);
	} catch {
		// best effort — snapshot failure just means no tracking this round
	}
	return m;
}

export interface ProcessTreeNode {
	ppid: number;
	name?: string;
}

export interface ProcessDetails {
	pid: number;
	ppid?: number;
	name?: string;
	commandLine?: string;
	createdMs?: number;
}

/**
 * Snapshot every process's parent pid & name → Map<pid, ProcessTreeNode>.
 * Windows: one PowerShell CIM pass; POSIX: one `ps -Ao pid=,ppid=,comm=` pass.
 * Returns undefined when query fails — callers should treat as unverified.
 */
export async function snapshotProcessTree(): Promise<Map<number, ProcessTreeNode> | undefined> {
	try {
		const { execFile } = await import("node:child_process");
		const m = new Map<number, ProcessTreeNode>();
		if (process.platform === "win32") {
			const out = await new Promise<string>((resolve, reject) =>
				execFile(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId):$($_.ParentProcessId):$($_.Name)" }',
					],
					{ windowsHide: true, timeout: 10000 },
					(err, stdout) => (err ? reject(err) : resolve(stdout)),
				),
			);
			for (const line of out.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				const firstColon = trimmed.indexOf(":");
				const secondColon = trimmed.indexOf(":", firstColon + 1);
				if (firstColon === -1) continue;
				const pid = Number(trimmed.slice(0, firstColon));
				const ppid = Number(
					secondColon === -1 ? trimmed.slice(firstColon + 1) : trimmed.slice(firstColon + 1, secondColon),
				);
				const name = secondColon === -1 ? undefined : trimmed.slice(secondColon + 1).trim() || undefined;
				if (Number.isFinite(pid) && Number.isFinite(ppid)) {
					m.set(pid, { ppid, ...(name ? { name } : {}) });
				}
			}
		} else {
			const out = await new Promise<string>((resolve, reject) =>
				execFile("ps", ["-Ao", "pid=,ppid=,comm="], { timeout: 5000 }, (err, stdout) =>
					err ? reject(err) : resolve(stdout),
				),
			);
			for (const line of out.split(/\r?\n/)) {
				const p = line.trim().split(/\s+/);
				if (p.length >= 2) {
					const pid = Number(p[0]);
					const ppid = Number(p[1]);
					const name = p.slice(2).join(" ").trim() || undefined;
					if (Number.isFinite(pid) && Number.isFinite(ppid)) {
						m.set(pid, { ppid, ...(name ? { name } : {}) });
					}
				}
			}
		}
		return m;
	} catch {
		return undefined;
	}
}

/**
 * Snapshot every process's parent pid → Map<pid, ppid>.
 * Retained for backward compatibility; powered by snapshotProcessTree.
 */
export async function snapshotProcessParents(): Promise<Map<number, number> | undefined> {
	const tree = await snapshotProcessTree();
	if (!tree) return undefined;
	const m = new Map<number, number>();
	for (const [pid, node] of tree) {
		m.set(pid, node.ppid);
	}
	return m;
}

/**
 * Batch lookup detailed process info (pid, ppid, name, commandLine, createdMs).
 * Windows: single PowerShell CIM pass with filter; POSIX: `ps -o pid=,ppid=,etimes=,comm=,command=`.
 */
export async function lookupProcessDetailsBatch(pids: number[]): Promise<Map<number, ProcessDetails>> {
	const out = new Map<number, ProcessDetails>();
	const validPids = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
	if (validPids.length === 0) return out;

	try {
		const { execFile } = await import("node:child_process");
		if (process.platform === "win32") {
			const filter = validPids.map((p) => `ProcessId=${p}`).join(" or ");
			const command = [
				`$filter = '${filter}';`,
				`Get-CimInstance Win32_Process -Filter $filter | ForEach-Object {`,
				`    $ts = if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 };`,
				`    $cmd = if ($_.CommandLine) { $_.CommandLine -replace "\\r?\\n", " " } else { "" };`,
				`    "$($_.ProcessId)\`t$($_.ParentProcessId)\`t$($_.Name)\`t$ts\`t$cmd"`,
				`}`,
			].join(" ");

			const stdout = await new Promise<string>((resolve, reject) =>
				execFile(
					"powershell.exe",
					["-NoProfile", "-NonInteractive", "-Command", command],
					{ windowsHide: true, timeout: 8000 },
					(err, res) => (err ? reject(err) : resolve(res)),
				),
			);

			for (const line of stdout.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				const parts = trimmed.split("\t");
				if (parts.length >= 3) {
					const pid = Number(parts[0]);
					const ppid = Number(parts[1]);
					const name = parts[2] || undefined;
					const ts = Number(parts[3]);
					const cmd = parts.slice(4).join("\t").trim();
					if (Number.isFinite(pid)) {
						out.set(pid, {
							pid,
							...(Number.isFinite(ppid) ? { ppid } : {}),
							...(name ? { name } : {}),
							...(Number.isFinite(ts) && ts > 0 ? { createdMs: ts } : {}),
							...(cmd ? { commandLine: cmd } : {}),
						});
					}
				}
			}
			return out;
		}

		// POSIX (Linux / macOS)
		const stdout = await new Promise<string>((resolve, reject) =>
			execFile(
				"ps",
				["-o", "pid=,ppid=,etimes=,comm=,command=", "-p", validPids.join(",")],
				{ timeout: 5000 },
				(err, res) => (err ? reject(err) : resolve(res)),
			),
		);

		const now = Date.now();
		for (const line of stdout.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			// 格式: pid ppid etimes comm command...
			const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
			if (match) {
				const pid = Number(match[1]);
				const ppid = Number(match[2]);
				const etimes = Number(match[3]);
				const name = match[4];
				const commandLine = match[5]?.trim();
				const createdMs = Number.isFinite(etimes) ? now - etimes * 1000 : undefined;
				out.set(pid, {
					pid,
					ppid,
					name,
					...(commandLine ? { commandLine } : {}),
					...(createdMs !== undefined ? { createdMs } : {}),
				});
			}
		}
	} catch {
		// best effort — lookup failure just returns empty map
	}
	return out;
}

/** Kill a pid and its whole process tree (cross-platform).
 *
 * The returned promise is only meaningful on Windows, where taskkill is itself
 * asynchronous. Existing callers may continue to ignore it for best-effort
 * background cleanup; callers that own a deadline can await completion. */
export async function killPidTree(pid: number): Promise<void> {
	// pid 下界防护：pid<=1（init / Windows System 级 pid）或自身 pid 绝不能杀 ——
	// POSIX 的 -pid 是进程组语义，误传 0/1/自身 pid 会杀掉整组无辜进程甚至本进程。
	if (!(pid > 1 && pid !== process.pid)) return;
	try {
		if (process.platform === "win32") {
			const { spawn } = await import("node:child_process");
			await new Promise<void>((resolve) => {
				const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
					stdio: "ignore",
					windowsHide: true,
				});
				killer.once("error", () => resolve());
				killer.once("close", () => resolve());
			});
		} else {
			process.kill(-pid, "SIGKILL");
		}
	} catch {
		// already dead
	}
}

/** Best-effort full command line of a pid (PowerShell CIM on win32 — wmic is
 *  gone on recent Win11 builds; ps -o command= on POSIX). Returns undefined
 *  when the process is gone or the lookup fails. */
export async function lookupProcessCommandLine(pid: number): Promise<string | undefined> {
	try {
		const { execFile } = await import("node:child_process");
		if (process.platform === "win32") {
			// CIM query is slower (~1s) than tasklist but this is a one-shot
			// best-effort probe fired once per detected background server.
			const out = await new Promise<string>((resolve, reject) =>
				execFile(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
					],
					{ windowsHide: true, timeout: 10000 },
					(err, stdout) => (err ? reject(err) : resolve(stdout)),
				),
			);
			const line = out.trim();
			return line || undefined;
		}
		const out = await new Promise<string>((resolve, reject) =>
			execFile("ps", ["-o", "command=", "-p", String(pid)], { timeout: 4000 }, (err, stdout) =>
				err ? reject(err) : resolve(stdout),
			),
		);
		const line = out.trim();
		return line || undefined;
	} catch {
		return undefined;
	}
}

/** Best-effort process name for a pid (tasklist on win32, ps on POSIX).
 *  Returns undefined when the process is gone or the lookup fails. */
export async function lookupProcessName(pid: number): Promise<string | undefined> {
	try {
		const { execFile } = await import("node:child_process");
		if (process.platform === "win32") {
			const out = await new Promise<string>((resolve, reject) =>
				execFile(
					"tasklist",
					["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
					{ windowsHide: true, timeout: 4000 },
					(err, stdout) => (err ? reject(err) : resolve(stdout)),
				),
			);
			// CSV: "node.exe","12345",...
			const m = out.match(/"([^"]+)"/);
			return m ? m[1] : undefined;
		}
		const out = await new Promise<string>((resolve, reject) =>
			execFile("ps", ["-o", "comm=", "-p", String(pid)], { timeout: 4000 }, (err, stdout) =>
				err ? reject(err) : resolve(stdout),
			),
		);
		const name = out.trim();
		return name || undefined;
	} catch {
		return undefined;
	}
}

/**
 * 超时杀进程树的决策（纯函数，可单测）。runAsync 的超时兜底用：
 * - win32：shell:true 实际起的是 cmd.exe，p.kill() 只杀 cmd 本身，npm/git 的
 *   孙进程照活 —— 必须走 `taskkill /PID <pid> /T /F` 才能整树带走；
 * - posix：配合 spawn 的 detached:true，向负 pid（整组）发 SIGTERM。
 * 返回决策而不是直接执行，执行留在调用方（便于注入/测试）。
 */
export function processTreeKillPlan(
	platform: NodeJS.Platform,
	pid: number | undefined,
):
	| { kind: "taskkill"; cmd: string; args: string[] }
	| { kind: "group-signal"; signal: NodeJS.Signals }
	| { kind: "none" } {
	if (!pid || pid <= 0) return { kind: "none" };
	if (platform === "win32") return { kind: "taskkill", cmd: "taskkill", args: ["/PID", String(pid), "/T", "/F"] };
	return { kind: "group-signal", signal: "SIGTERM" };
}

/**
 * /cwd 目标解析（纯函数，可单测）：
 * - 相对路径以**当前会话 cwd** 为基准（/cwd src = 当前项目的 src），不按 server
 *   进程 cwd 解析 —— 两者经常不同，按进程 cwd 切必错位。绝对路径不受基准影响
 *   （resolve 遇到绝对段会丢弃前面的基准）。
 * - win32 裸盘符（"C:"）：resolve 会按该盘当前目录解析，必须显式指到盘根；仅
 *   win32 生效——posix 下 "C:" 仍是普通相对路径，避免误伤同名目录。
 */
export function resolveCwdTarget(
	raw: string,
	sessionCwd: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const trimmed = String(raw ?? "").trim();
	if (platform === "win32" && /^[A-Za-z]:$/.test(trimmed)) {
		return `${trimmed.toUpperCase()}\\`;
	}
	return resolve(sessionCwd, trimmed);
}
