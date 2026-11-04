// @vitest-environment node
/**
 * P3/P4：停止必须覆盖 run 绑定的模型回合与执行实体；接管保留旧执行实体证据。
 *  - 回合在途（含忽略取消的工具）→ 停止只受理不确认；回合结束后重新核对才确认。
 *  - 两个 run 的回合控制器互不干扰：停止 A 不取消 B。
 *  - 接管保留旧 lease 的 taskPid 证据：身份未核实不向该 pid 发信号、不确认停止。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const RUNS_ROOT = mkdtempSync(join(tmpdir(), "loop-stop-turn-runs-"));
const WORKSPACES: string[] = [];
const workspace = () => {
	const dir = mkdtempSync(join(tmpdir(), "loop-stop-turn-ws-"));
	WORKSPACES.push(dir);
	return dir;
};
process.env.MINI_HARNESS_RUNTIME_ROOT = RUNS_ROOT;
const ext = await import("../../server/loop/extension.js");
const { createLoopRun, loadLoopState, registerRunTurnController, unregisterRunTurnController, stopRunExternal } =
	ext as any;

function journalEvents(runId: string): string[] {
	try {
		return readFileSync(join(RUNS_ROOT, runId, "journal.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l).event as string);
	} catch {
		return [];
	}
}

/** 真实子进程：忽略 SIGTERM 的守卫进程，测试用（测试自己负责清理）。 */
function spawnChild(): { pid: number; kill: () => void } {
	const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"]);
	return { pid: child.pid!, kill: () => child.kill("SIGKILL") };
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	rmSync(RUNS_ROOT, { recursive: true, force: true });
	for (const dir of WORKSPACES) rmSync(dir, { recursive: true, force: true });
});

describe("停止覆盖回合与实际执行实体", () => {
	it("回合在途且忽略取消：停止只受理不确认；回合结束后重新核对才确认", async () => {
		const sid = "turn-" + Math.random().toString(36).slice(2, 8);
		const created = createLoopRun({ sessionId: sid, cwd: workspace(), goal: "g", validateCmd: "true" });
		let turnEnded = false;
		let aborts = 0;
		registerRunTurnController(created.runId, {
			abort: () => {
				aborts += 1;
			},
			turnEnded: () => turnEnded,
		});
		const first = stopRunExternal(created.runId);
		expect(first.ok).toBe(true);
		expect(aborts).toBe(1);
		expect(first.stopRequestedAt).toBeTruthy();
		expect(first.stopConfirmedAt).toBeFalsy();
		expect(loadLoopState(created.runId)).toMatchObject({ stage: "stopping", recoveryState: "stop-unconfirmed" });
		// 回合结束（可核验）后重新核对 → 确认停止。
		turnEnded = true;
		const recheck = stopRunExternal(created.runId);
		expect(recheck.ok).toBe(true);
		expect(recheck.stopConfirmedAt).toBeTruthy();
		expect(loadLoopState(created.runId)).toMatchObject({ status: "stopped", stage: "stopped" });
		// 重复停止幂等。
		const again = stopRunExternal(created.runId);
		expect(again.stopConfirmedAt).toBe(recheck.stopConfirmedAt);
		unregisterRunTurnController(created.runId);
	});

	it("两个 run 的回合互不干扰：停止 A 只取消 A 的回合", async () => {
		const a = createLoopRun({ sessionId: "ta-" + Math.random().toString(36).slice(2, 8), cwd: workspace(), goal: "a" });
		const b = createLoopRun({ sessionId: "tb-" + Math.random().toString(36).slice(2, 8), cwd: workspace(), goal: "b" });
		let aAborts = 0;
		let bAborts = 0;
		registerRunTurnController(a.runId, { abort: () => (aAborts += 1), turnEnded: () => false });
		registerRunTurnController(b.runId, { abort: () => (bAborts += 1), turnEnded: () => false });
		const r = stopRunExternal(a.runId);
		expect(r.ok).toBe(true);
		expect(aAborts).toBe(1);
		expect(bAborts).toBe(0);
		expect(loadLoopState(b.runId).status).toBe("active");
		unregisterRunTurnController(a.runId);
		unregisterRunTurnController(b.runId);
	});
});

describe("接管保留旧执行实体证据", () => {
	it("旧 lease 的 taskPid 在接管后保留为证据：存活时不发信号、不确认停止", async () => {
		const sid = "legacy-" + Math.random().toString(36).slice(2, 8);
		const created = createLoopRun({ sessionId: sid, cwd: workspace(), goal: "g", validateCmd: "true" });
		const child = spawnChild();
		try {
			// 旧租约记录真实执行实体 taskPid（旧协议 run 没有 operation）。
			const dir = join(RUNS_ROOT, created.runId);
			writeLease(dir, { runId: created.runId, st: loadLoopState(created.runId) }, child.pid);
			// 宿主失联：旧 owner 的 lease 过期，新宿主接管。
			expireLease(dir);
			const rec = (await import("../../server/loop/extension.js")).recoverRun(created.runId);
			expect(rec.ok).toBe(true);
			expect(rec.takeover).toBe(true);
			const st = loadLoopState(created.runId);
			expect(st.legacyExecutionEntities?.some((e: { pid: number }) => e.pid === child.pid)).toBe(true);
			// 停止：旧实体身份未核实（裸 PID 不可信）→ 不发信号、不确认停止。
			const first = stopRunExternal(created.runId);
			expect(first.ok).toBe(true);
			expect(first.stopConfirmedAt).toBeFalsy();
			expect(loadLoopState(created.runId)).toMatchObject({ stage: "stopping", recoveryState: "stop-unconfirmed" });
			expect(alive(child.pid)).toBe(true); // 没有误杀身份不明的进程
			// 实体退出后重新核对 → 确认停止。
			child.kill();
			await new Promise((r) => setTimeout(r, 300));
			const recheck = stopRunExternal(created.runId);
			expect(recheck.ok).toBe(true);
			expect(recheck.stopConfirmedAt).toBeTruthy();
		} finally {
			child.kill();
		}
	});
});

// ---- 辅助：直接构造旧 lease 与过期状态（走 storage 原子写） ----
import { readFileSync as rfs, writeFileSync } from "node:fs";
const { withRunLockSync } = await import("../../server/loop/storage.js");

function writeLease(
	dir: string,
	created: { runId: string; st: { owner: string | null; generation?: number } },
	taskPid: number,
) {
	withRunLockSync(dir, () => {
		const lease = {
			owner: created.st.owner,
			pid: 1,
			generation: created.st.generation ?? 1,
			startedAt: new Date(0).toISOString(),
			heartbeatAt: new Date(0).toISOString(),
			remoteJobId: null,
			taskPid,
		};
		writeFileSync(join(dir, "lease.json"), JSON.stringify(lease, null, 2) + "\n");
	});
}

function expireLease(dir: string) {
	withRunLockSync(dir, () => {
		const lease = JSON.parse(rfs(join(dir, "lease.json"), "utf8"));
		lease.heartbeatAt = new Date(0).toISOString();
		writeFileSync(join(dir, "lease.json"), JSON.stringify(lease, null, 2) + "\n");
	});
}
