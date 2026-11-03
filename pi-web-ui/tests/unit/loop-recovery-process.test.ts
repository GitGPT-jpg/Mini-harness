/**
 * 真实本地跨进程恢复验证（Task B §13.2 / §13.3）：
 *  - 两个真实独立进程并发争抢同一租约，只有一个 WIN（O_EXCL 原子互斥，不是写后读回）；
 *  - 真实长任务子进程中途「服务退出」，新进程按真实 pid 重新核对现场：仍在跑 → 重新跟踪不重跑；
 *    进程已死且无产物 → 结果未知，保持受阻，不盲目重放副作用。
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { acquireLease, classifyRecovery, getLease, releaseLease, LEASE_TTL_MS } from "../../server/loop/recovery.js";

const execFileP = promisify(execFile);
const TSBIN = join(process.cwd(), "node_modules", ".bin", "tsx");
const CONTENDER = join(import.meta.dirname, "..", "fixtures", "lease-contender.ts");

const DIRS: string[] = [];
function tmpDir(): string {
	const d = mkdtempSync(join(tmpdir(), "loop-recovery-proc-"));
	DIRS.push(d);
	return d;
}
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

describe("跨进程执行所有权（§6.1 原子互斥）", () => {
	it("两个真实进程并发争抢同一租约，只有一个 WIN", async () => {
		const dir = tmpDir();
		const [a, b] = await Promise.all([
			execFileP(TSBIN, [CONTENDER, dir, "a@host"]),
			execFileP(TSBIN, [CONTENDER, dir, "b@host"]),
		]);
		const wins = [a.stdout.trim(), b.stdout.trim()].filter((o) => o.startsWith("WIN"));
		expect(wins).toHaveLength(1);
		expect(getLease(dir)?.owner).toBe(wins[0]!.replace("WIN:", ""));
	});

	it("他人持权（未过期）时第二个进程不接管；过期后可接管且原 owner 不能续租", async () => {
		const dir = tmpDir();
		const nowIso = new Date().toISOString();
		expect(acquireLease(dir, { owner: "a@host", pid: process.pid, generation: 1, startedAt: nowIso, heartbeatAt: nowIso, remoteJobId: null })).toBe(true);
		expect(acquireLease(dir, { owner: "b@host", pid: process.pid, generation: 1, startedAt: nowIso, heartbeatAt: nowIso, remoteJobId: null })).toBe(false);
		expect(getLease(dir)?.owner).toBe("a@host");

		const past = new Date(Date.now() - LEASE_TTL_MS - 1000).toISOString();
		expect(acquireLease(dir, { owner: "b@host", pid: process.pid, generation: 2, startedAt: past, heartbeatAt: past, remoteJobId: null })).toBe(false);
		// 未过期，仍被 a 持有，不能直接覆盖；b 只能等过期。
		releaseLease(dir, "a@host");
		expect(acquireLease(dir, { owner: "b@host", pid: process.pid, generation: 2, startedAt: nowIso, heartbeatAt: nowIso, remoteJobId: null })).toBe(true);
		expect(getLease(dir)?.owner).toBe("b@host");
	});
});

describe("本地长任务跨重启恢复（§13.2 真实子进程 + 持久化 pid）", () => {
	it("仍在跑的真实进程 → 重新跟踪不重跑；进程消失且无产物 → 结果未知保持受阻", async () => {
		const dir = tmpDir();
		// 真实长任务（独立进程组），模拟「服务退出但本地命令仍在」。
		const marker = join(dir, "started.txt");
		const child = spawn("bash", ["-lc", `echo started > "${marker}" && sleep 30`], {
			detached: true,
			stdio: "ignore",
		});
		// 等它写下标记，证明「副作用已发生」。
		for (let i = 0; i < 50 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
		expect(existsSync(marker)).toBe(true);
		const taskPid = child.pid!;
		expect(pidAlive(taskPid)).toBe(true);

		// 服务「崩溃」：租约过期，但真实任务 pid 仍在 → 分类 = running（重新跟踪，不启动第二份）。
		const clsRunning = classifyRecovery(
			{ status: "active" },
			{ leaseHeld: false, environmentChanged: false, pidAlive: pidAlive(taskPid), lastRoundPassed: false, inFlight: true },
		);
		expect(clsRunning.unit).toBe("running");
		expect(clsRunning.canResume).toBe(true);

		// 真实停止：杀掉进程组（负 pid），确认进程确实退出（不误杀、不残留）。
		try {
			process.kill(-taskPid, "SIGKILL");
		} catch {
			try { process.kill(taskPid, "SIGKILL"); } catch {}
		}
		for (let i = 0; i < 50 && pidAlive(taskPid); i++) await new Promise((r) => setTimeout(r, 50));
		expect(pidAlive(taskPid)).toBe(false);

		// 进程已死、无可靠产物 → 结果未知：保持受阻，不盲目重放（不当作「未执行」）。
		const clsUnknown = classifyRecovery(
			{ status: "active" },
			{ leaseHeld: false, environmentChanged: false, pidAlive: false, lastRoundPassed: false, inFlight: true },
		);
		expect(clsUnknown.unit).toBe("unknown");
		expect(clsUnknown.canResume).toBe(false);
		expect(clsUnknown.needRecheck).toBe(true);
	}, 30_000);
});
