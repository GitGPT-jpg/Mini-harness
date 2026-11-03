/**
 * server/loop/operation.ts
 *
 * 持久化本地操作执行器：validator / precheck 等长命令的「真实执行现场」落盘，
 * 使服务退出/重启后仍能核对、观察、收集结果（Prompt 修复④）。
 *
 * 与 runCommand 的关系：runCommand 把 stdout/stderr 留在内存 Promise 里，服务一退就丢；
 * 这里把 stdio 重定向到文件、把 {pid, 文件路径, 状态} 写成 operation.json，
 * 并包一层 shell 在退出时把退出码写进 exit.code，重启后的新进程能据此观察/收集。
 *
 * 支持范围：单主机、持久本地文件系统；本地长命令独立进程组继续运行。
 * 不承诺远端 GPU / K8s 作业（那需要远端作业状态适配器，不在此层伪装）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface PersistentExecOptions {
	cwd: string;
	runId: string;
	/** "precheck" | "validate" | 其它上层自定；用于恢复摘要区分阶段。 */
	stage: string;
	round: number;
	signal?: AbortSignal;
	timeout?: number;
	maxBuffer?: number;
	onSpawn?: (pid: number) => void;
}

export interface PersistentExecResult {
	stdout: string;
	stderr: string;
	code: number | null;
	killed: boolean;
	pid: number | null;
	opId: string;
}

export interface OpRecord {
	opId: string;
	runId: string;
	stage: string;
	round: number;
	pid: number | null;
	command: string;
	args: string[];
	cwd: string;
	stdoutFile: string;
	stderrFile: string;
	exitFile: string;
	startedAt: string;
	status: "running" | "exited" | "killed" | "error";
	exitCode: number | null;
	endedAt: string | null;
}

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

function operationsDir(runId: string, opId: string): string {
	return path.join(process.env.MINI_HARNESS_RUNTIME_ROOT || path.join(requireHome(), ".mini-harness", "runs"), runId, "operations", opId);
}

function requireHome(): string {
	return process.env.HOME || process.env.USERPROFILE || "/tmp";
}

function opFilePath(runDirForOp: string): string {
	return path.join(runDirForOp, "operation.json");
}

function readOp(opDir: string): OpRecord | null {
	try {
		const rec = JSON.parse(fs.readFileSync(opFilePath(opDir), "utf8")) as OpRecord;
		if (rec && typeof rec.opId === "string") return rec;
		return null;
	} catch {
		return null;
	}
}

function writeOp(opDir: string, rec: OpRecord): void {
	try {
		const tmp = path.join(opDir, "operation.json.tmp." + process.pid + "." + crypto.randomBytes(3).toString("hex"));
		fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
		fs.renameSync(tmp, opFilePath(opDir));
	} catch {}
}

function isPidAlive(pid: number | null): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** 杀掉子进程所在的进程组（Unix: -pid；Windows: taskkill /T）。与 run-command.ts 同一语义。 */
export function killProcessGroup(child: ChildProcess): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
		} catch {}
		return;
	}
	if (child.pid == null) return;
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		try { child.kill("SIGTERM"); } catch {}
	}
	const timer = setTimeout(() => {
		try {
			process.kill(-child.pid!, "SIGKILL");
		} catch {
			try { child.kill("SIGKILL"); } catch {}
		}
	}, 3000);
	timer.unref?.();
}

/** 读取文件尾部（截断到 maxBuffer），文件不存在返回 ""。 */
function readTail(file: string, maxBuffer: number): string {
	try {
		const buf = fs.readFileSync(file, "utf8");
		return buf.length > maxBuffer ? buf.slice(buf.length - maxBuffer) : buf;
	} catch {
		return "";
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * 持久化执行：detached 进程组 + stdio 落文件 + operation.json 记录 + 退出码由 shell 包装写入。
 * 在进程存续期间返回 {stdout,stderr,code,killed,pid,opId}；服务中途退出后，新进程用 observeOperation 接续。
 */
export function runCommandPersistent(
	command: string,
	args: string[],
	options: PersistentExecOptions,
): Promise<PersistentExecResult> {
	const opId = crypto.randomBytes(8).toString("hex");
	const opDir = operationsDir(options.runId, opId);
	fs.mkdirSync(opDir, { recursive: true });
	const stdoutFile = path.join(opDir, "stdout.log");
	const stderrFile = path.join(opDir, "stderr.log");
	const exitFile = path.join(opDir, "exit.code");

	const rec: OpRecord = {
		opId,
		runId: options.runId,
		stage: options.stage,
		round: options.round,
		pid: null,
		command,
		args,
		cwd: options.cwd,
		stdoutFile,
		stderrFile,
		exitFile,
		startedAt: new Date().toISOString(),
		status: "running",
		exitCode: null,
		endedAt: null,
	};

	return new Promise((resolve) => {
		// 包一层 shell：把实际命令的退出码写进 exit.code（父进程若中途死亡，新进程据此拿到 exit code）。
		// 退出码文件路径经环境变量传入，避免路径含空格/引号时被 shell 拆错。
		const wrapper = `"$@" ; _rc=$? ; printf '%s' "$_rc" > "$HARNESS_OP_EXIT" ; exit "$_rc"`;
		let stdoutFd = -1;
		let stderrFd = -1;
		let child: ChildProcess;
		try {
			stdoutFd = fs.openSync(stdoutFile, "w");
			stderrFd = fs.openSync(stderrFile, "w");
		} catch {
			// 打不开文件也继续（退化为只写 operation 记录 + 内存）；但 stdio 用 pipe 兜底。
			stdoutFd = -1;
			stderrFd = -1;
		}
		child = spawn("bash", ["-c", wrapper, "harness-op", command, ...args], {
			cwd: options.cwd,
			detached: true,
			stdio: ["ignore", stdoutFd >= 0 ? stdoutFd : "pipe", stderrFd >= 0 ? stderrFd : "pipe"],
			env: { ...process.env, HARNESS_OP_EXIT: exitFile },
			windowsHide: true,
		});
		if (stdoutFd >= 0) {
			try { fs.closeSync(stdoutFd); } catch {}
		}
		if (stderrFd >= 0) {
			try { fs.closeSync(stderrFd); } catch {}
		}

		rec.pid = child.pid ?? null;
		writeOp(opDir, rec);
		if (child.pid != null) {
			try {
				options.onSpawn?.(child.pid);
			} catch {}
		}

		let killed = false;
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		const doKill = () => {
			if (killed) return;
			killed = true;
			killProcessGroup(child);
		};
		if (options.signal) {
			if (options.signal.aborted) doKill();
			else options.signal.addEventListener("abort", doKill, { once: true });
		}
		if (options.timeout && options.timeout > 0) {
			timeoutId = setTimeout(doKill, options.timeout);
		}

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			if (timeoutId) clearTimeout(timeoutId);
			options.signal?.removeEventListener("abort", doKill);
			const stdout = readTail(stdoutFile, options.maxBuffer ?? DEFAULT_MAX_BUFFER);
			const stderr = readTail(stderrFile, options.maxBuffer ?? DEFAULT_MAX_BUFFER);
			let exitCode = code;
			if (exitCode == null) {
				try {
					const ec = fs.readFileSync(exitFile, "utf8").trim();
					if (ec !== "") exitCode = Number(ec);
				} catch {}
			}
			rec.status = killed ? "killed" : "exited";
			rec.exitCode = exitCode ?? null;
			rec.endedAt = new Date().toISOString();
			writeOp(opDir, rec);
			resolve({ stdout, stderr, code: exitCode ?? null, killed, pid: child.pid ?? null, opId });
		};

		child.once("error", () => finalize(null));
		child.once("exit", (code: number | null) => finalize(code));
	});
}

/** 读取某 run 的持久化操作记录（恢复/观察用）。 */
export function readOperation(runId: string, opId: string): OpRecord | null {
	return readOp(operationsDir(runId, opId));
}

/** 列出某 run 的所有操作（按 startedAt 倒序）。 */
export function listOperations(runId: string): OpRecord[] {
	const base = path.join(process.env.MINI_HARNESS_RUNTIME_ROOT || path.join(requireHome(), ".mini-harness", "runs"), runId, "operations");
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(base);
	} catch {
		return [];
	}
	const out: OpRecord[] = [];
	for (const e of entries) {
		const rec = readOp(path.join(base, e));
		if (rec) out.push(rec);
	}
	out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
	return out;
}

/**
 * 观察/接续一个持久化操作（服务重启后由新进程调用）：
 * 若 pid 仍存活则等待其退出（poll，上限 timeoutMs），随后收集退出码与输出，并更新 operation.json。
 * 返回 {code, stdout, stderr, pidAlive, status}。
 */
export async function observeOperation(
	runId: string,
	opId: string,
	opts: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; pidAlive: boolean; status: string }> {
	const opDir = operationsDir(runId, opId);
	const rec = readOp(opDir);
	if (!rec) return { code: null, stdout: "", stderr: "", pidAlive: false, status: "missing" };
	let pidAlive = isPidAlive(rec.pid);
	const deadline = Date.now() + (opts.timeoutMs ?? 0);
	while (pidAlive && (opts.timeoutMs == null || Date.now() < deadline)) {
		await sleep(200);
		pidAlive = isPidAlive(rec.pid);
	}
	const stdout = readTail(rec.stdoutFile, opts.maxBuffer ?? DEFAULT_MAX_BUFFER);
	const stderr = readTail(rec.stderrFile, opts.maxBuffer ?? DEFAULT_MAX_BUFFER);
	let code: number | null = rec.exitCode;
	if (code == null) {
		try {
			const ec = fs.readFileSync(rec.exitFile, "utf8").trim();
			if (ec !== "") code = Number(ec);
		} catch {}
	}
	const ended = !pidAlive;
	rec.status = ended ? (code === null ? "error" : "exited") : "running";
	rec.exitCode = code ?? null;
	if (ended && !rec.endedAt) rec.endedAt = new Date().toISOString();
	writeOp(opDir, rec);
	return { code, stdout, stderr, pidAlive, status: rec.status };
}
