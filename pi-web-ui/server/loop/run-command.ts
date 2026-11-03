/**
 * server/loop/run-command.ts
 *
 * validator / precheck 用的进程组可取消执行器。
 *
 * 与 SDK 的 pi.exec 不同：这里用 detached 让子进程成为独立进程组（Unix），
 * 停止时 SIGTERM/SIGKILL 整个进程组，而不是只杀直接子进程（bash）。
 * 这样「validator 里再拉起的压测 / GPU 作业」也会随停止一起退出，
 * 满足「停止要作用于实际执行（进程组）」，而不仅是 state.json 变 stopped。
 *
 * 返回结构与 SDK ExecResult 兼容：{ stdout, stderr, code, killed }。
 * 远程作业（kubectl/SSH 里启动的远端 GPU 任务）不在此列——本地进程组退出
 * 不等于远端任务已退出，上层必须把这一点作为「远端状态未知」暴露。
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface RunCommandOptions {
	cwd: string;
	signal?: AbortSignal;
	timeout?: number;
	maxBuffer?: number;
	/** 子进程一 spawn 就回调其 pid（用于把「实际执行实体」及时落盘供恢复核对）。 */
	onSpawn?: (pid: number) => void;
}

export interface RunCommandResult {
	stdout: string;
	stderr: string;
	code: number | null;
	killed: boolean;
	/** 子进程 pid（进程组 id，Unix 下为 detached 子进程的 pid）；用于恢复时核对实际执行实体。 */
	pid: number | null;
}

const EXIT_STDIO_GRACE_MS = 100;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/** 杀掉子进程所在的进程组（Unix: -pid；Windows: taskkill /T）。 */
function killProcessGroup(child: ChildProcess): void {
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

/**
 * 执行命令并在退出 / 超时 / 信号取消时杀掉整个进程组。
 * 结果在子进程 exit 且 stdio 落定后返回（沿用 SDK 的静默宽限逻辑，避免截断尾部输出）。
 */
export function runCommand(
	command: string,
	args: string[],
	options: RunCommandOptions,
): Promise<RunCommandResult> {
	return new Promise((resolve) => {
		const detached = process.platform !== "win32";
		const child = spawn(command, args, {
			cwd: options.cwd,
			detached,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		if (child.pid != null) {
			try {
				options.onSpawn?.(child.pid);
			} catch {}
		}
		const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
		let stdout = "";
		let stderr = "";
		let killed = false;
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		let postExitTimer: ReturnType<typeof setTimeout> | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const append = (buf: string, chunk: string) => (buf.length >= maxBuffer ? buf : buf + chunk);

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

		const cleanup = () => {
			if (timeoutId) clearTimeout(timeoutId);
			if (postExitTimer) clearTimeout(postExitTimer);
			options.signal?.removeEventListener("abort", doKill);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("data", onStdoutData);
			child.stderr?.removeListener("data", onStderrData);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
		};

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve({ stdout, stderr, code, killed, pid: child.pid ?? null });
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) finalize(exitCode);
		};

		const armIdleTimer = () => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
		};

		const onStdoutData = (chunk: Buffer) => {
			stdout = append(stdout, chunk.toString());
			if (exited && !settled) armIdleTimer();
		};
		const onStderrData = (chunk: Buffer) => {
			stderr = append(stderr, chunk.toString());
			if (exited && !settled) armIdleTimer();
		};
		const onStdoutEnd = () => { stdoutEnded = true; maybeFinalizeAfterExit(); };
		const onStderrEnd = () => { stderrEnded = true; maybeFinalizeAfterExit(); };
		const onError = () => { if (!settled) finalize(exitCode ?? 1); };
		const onExit = (code: number | null) => {
			exited = true;
			exitCode = code;
			maybeFinalizeAfterExit();
		};
		const onClose = (code: number | null) => {
			exited = true;
			if (exitCode === null) exitCode = code;
			maybeFinalizeAfterExit();
		};

		child.stdout?.on("data", onStdoutData);
		child.stderr?.on("data", onStderrData);
		child.stdout?.on("end", onStdoutEnd);
		child.stderr?.on("end", onStderrEnd);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

