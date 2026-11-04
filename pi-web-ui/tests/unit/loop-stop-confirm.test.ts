// @vitest-environment node
/**
 * 链路二回归（真实子进程 + 停止/续跑共享实体核对）：
 *  - 停止运行中任务：只取消目标 run，进程组退出确认后才显示已停止。
 *  - 进程身份不完整 → 停止待确认、进程不误杀、续跑投递阻断、共享同一核对规则。
 *  - 回合交接：A 结束、下一回合 B 排队时点停止 → B 启动即中止；同会话普通聊天不被误中断。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const RUNS_ROOT = mkdtempSync(join(tmpdir(), "loop-stop-confirm-runs-"));
process.env.MINI_HARNESS_RUNTIME_ROOT = RUNS_ROOT;
const ext = await import("../../server/loop/extension.js");
const {
	createLoopRun,
	loadLoopState,
	stopRunExternal,
	canResumeLoopDelivery,
	markRunTurnDispatch,
	beginLoopTurn,
	endLoopTurnsForSession,
} = ext as any;
const op = await import("../../server/loop/operation.js");
const { runCommandPersistent, listOperations } = op;

const WORKSPACES: string[] = [];
function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "loop-stop-confirm-ws-"));
	WORKSPACES.push(dir);
	return dir;
}

function spawnChild(terResistant = true): { pid: number; kill: () => void } {
	const child: ChildProcess = spawn(process.execPath, [
		"-e",
		terResistant ? "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);" : "setInterval(()=>{},1000);",
	]);
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

function waitFor(fn: () => boolean, ms = 8000, step = 20): Promise<void> {
	return new Promise((resolve, reject) => {
		const t0 = Date.now();
		const tick = () => {
			if (fn()) return resolve();
			if (Date.now() - t0 > ms) return reject(new Error("waitFor timeout"));
			setTimeout(tick, step);
		};
		tick();
	});
}

afterAll(() => {
	rmSync(RUNS_ROOT, { recursive: true, force: true });
	for (const dir of WORKSPACES) rmSync(dir, { recursive: true, force: true });
});

describe("链路二：停止后能确认退出", () => {
	it("停止运行中的任务：进程组退出确认后才显示已停止（真实子进程组）", async () => {
		const sid = "stop-live-" + Math.random().toString(36).slice(2, 8);
		const ws = workspace();
		const created = createLoopRun({ sessionId: sid, cwd: ws, goal: "g" });
		const running = runCommandPersistent("bash", ["-lc", "sleep 300"], {
			runId: created.runId,
			stage: "validate",
			round: created.st.round,
			attemptId: created.st.attemptId,
			cwd: ws,
		});
		await waitFor(() => listOperations(created.runId).some((o: { pid: number | null }) => o.pid != null));
		const opRec = listOperations(created.runId)[0]!;
		const r = stopRunExternal(created.runId);
		expect(r.ok, JSON.stringify(r)).toBe(true);
		expect(r.stopConfirmedAt).toBeTruthy(); // 进程组退出确认后才显示已停止
		await waitFor(() => !alive(opRec.pid!)); // 子进程被收割（僵尸进程会被 runner 回收）
		const st = loadLoopState(created.runId);
		expect(st.status).toBe("stopped");
		const after = listOperations(created.runId)[0]!;
		expect(after.result?.groupGone).toBe(true);
		await running.catch(() => {});
	}, 30_000);

	it("进程身份不完整（同 PID 但宿主不符）：停止待确认、不误杀、续跑投递阻断（停止与续跑共用核对规则）", async () => {
		const child = spawnChild();
		try {
			const sid = "stop-identity-" + Math.random().toString(36).slice(2, 8);
			const ws = workspace();
			const created = createLoopRun({ sessionId: sid, cwd: ws, goal: "g" });
			// 独立 operation B 已可信退出（result 已发布）。
			const b = await runCommandPersistent("bash", ["-lc", "exit 0"], {
				runId: created.runId,
				stage: "validate",
				round: created.st.round,
				attemptId: created.st.attemptId,
				cwd: ws,
			});
			const bOp = listOperations(created.runId).find((o: { opId: string }) => o.opId === b.opId)!;
			// 旧实体条目：PID 与 B 相同（PID 复用），但宿主不符 → 逐实体判定不核实。
			// 旧 pid-only 规则会因 op.pid === e.pid 放行；共享规则必须保持未核实。
			const stateFile = join(RUNS_ROOT, created.runId, "state.json");
			const fs = await import("node:fs");
			const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
			st.legacyExecutionEntities = [
				{ pid: bOp.pid, host: "other-host", startId: "unknown", capturedAt: new Date().toISOString(), generation: 1 },
			];
			fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
			// 该 PID 由真实存活进程占用（模拟复用）。
			// 用 child 的 PID 覆盖条目，使「存活但身份不符」成立。
			st.legacyExecutionEntities = [
				{ pid: child.pid, host: "other-host", startId: "unknown", capturedAt: new Date().toISOString(), generation: 1 },
			];
			fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
			const r = stopRunExternal(created.runId);
			expect(r.ok, JSON.stringify(r)).toBe(true);
			expect(r.stopConfirmedAt).toBeFalsy(); // 身份不完整 → 停止待确认
			expect(alive(child.pid)).toBe(true); // 不误杀身份不明的进程
			// 续跑投递同一门禁：未核实实体期间阻断。
			expect(canResumeLoopDelivery(loadLoopState(created.runId))).toBe(false);
			// 实体退出（可信退出证据）→ 重新核对确认停止 + 投递放行。
			child.kill();
			await waitFor(() => !alive(child.pid));
			await new Promise((res) => setTimeout(res, 200));
			const recheck = stopRunExternal(created.runId);
			expect(recheck.ok, JSON.stringify(recheck)).toBe(true);
			expect(recheck.stopConfirmedAt).toBeTruthy();
			// 停止已确认 = 终态：续跑投递门禁保持关闭（不能把已停止的任务续跑成新投递）。
			expect(canResumeLoopDelivery(loadLoopState(created.runId))).toBe(false);
		} finally {
			child.kill();
		}
	}, 30_000);
});

describe("回合交接：排队回合在停止后启动即中止", () => {
	it("A 结束、B 排队时点停止：B 启动即中止不产出，同会话普通聊天不被误中断", () => {
		const sid = "handoff-" + Math.random().toString(36).slice(2, 8);
		const created = createLoopRun({ sessionId: sid, cwd: workspace(), goal: "g" });
		// A 回合在途。
		const abortA = vi.fn();
		markRunTurnDispatch(created.runId, sid);
		beginLoopTurn(created.runId, sid, { abort: abortA, isIdle: () => false });
		// A 结束（结束事件清理自己）；随后下一轮 B 已投递排队（尚未开始）。
		endLoopTurnsForSession(sid);
		markRunTurnDispatch(created.runId, sid);
		// 在 B 开始前点停止：停止绑定 B 的 turnId。
		const first = stopRunExternal(created.runId);
		expect(first.ok, JSON.stringify(first)).toBe(true);
		expect(first.stopRequestedAt).toBeTruthy();
		expect(abortA).not.toHaveBeenCalled(); // A 已结束，不取消已结束的回合
		// B 开始（before_agent_start）：启动即中止，不产出内容。
		const abortB = vi.fn();
		beginLoopTurn(created.runId, sid, { abort: abortB, isIdle: () => true });
		expect(abortB).toHaveBeenCalledTimes(1); // B 启动即中止
		// 同会话普通聊天 C（无投递登记）不受影响：不注册、不取消。
		const abortC = vi.fn();
		beginLoopTurn(created.runId, sid, { abort: abortC, isIdle: () => false });
		expect(abortC).not.toHaveBeenCalled();
		// 重新核对：B 已中止（可核验 idle）→ 确认停止。
		const recheck = stopRunExternal(created.runId);
		expect(recheck.ok, JSON.stringify(recheck)).toBe(true);
		expect(recheck.stopConfirmedAt).toBeTruthy();
	}, 30_000);
});
