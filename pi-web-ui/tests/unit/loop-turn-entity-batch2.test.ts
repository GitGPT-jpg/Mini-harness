// @vitest-environment node
/**
 * 第二批回归（Round 5）：
 *  - 停止只取消「已注册且对应本回合」的实体：回合结束只清理自己，普通聊天不受停止影响。
 *  - 旧执行实体逐实体判定：独立 operation 的退出证据只核实匹配实体，未核实实体期间投递门禁不放行。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const RUNS_ROOT = mkdtempSync(join(tmpdir(), "loop-batch2-runs-"));
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
	pendingUnconsumedOp,
	recoverRun,
} = ext as any;
const op = await import("../../server/loop/operation.js");
const { runCommandPersistent, listOperations } = op;

const WORKSPACES: string[] = [];
function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "loop-batch2-ws-"));
	WORKSPACES.push(dir);
	return dir;
}

function spawnChild(): { pid: number; kill: () => void } {
	const child: ChildProcess = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"]);
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

/** 改写 run 的 legacyExecutionEntities / consumedResults / setupPending 等状态字段。 */
function patchState(runId: string, patch: Record<string, unknown>) {
	const dir = join(RUNS_ROOT, runId);
	const stateFile = join(dir, "state.json");
	const st = JSON.parse(readFileSync(stateFile, "utf8"));
	writeFileSync(stateFile, JSON.stringify({ ...st, ...patch }, null, 2));
}

afterAll(() => {
	rmSync(RUNS_ROOT, { recursive: true, force: true });
	for (const dir of WORKSPACES) rmSync(dir, { recursive: true, force: true });
});

describe("停止只取消「已注册且对应本回合」的实体", () => {
	it("A 回合结束、同会话普通聊天 B 开始后再停止 A：B 不收到取消且继续运行，停止立即确认", () => {
		const sid = "b2-a-then-b-" + Math.random().toString(36).slice(2, 8);
		const created = createLoopRun({ sessionId: sid, cwd: workspace(), goal: "g" });
		const abortA = vi.fn();
		// A 的 run 回合：投递登记 → 回合启动（before_agent_start）注册取消控制器。
		markRunTurnDispatch(created.runId, sid);
		beginLoopTurn(created.runId, sid, { abort: abortA, isIdle: () => false });
		// A 回合结束：结束事件只清理自己（标记与控制器一并注销）。
		endLoopTurnsForSession(sid);
		// 模型准备完成（A 回合内跑完 setup）：后续回合不再因 setupPending 被当作 run 回合。
		patchState(created.runId, { setupPending: false });
		// B 开始：普通聊天没有投递登记 → 不置「回合在途」、不注册控制器。
		const abortB = vi.fn();
		beginLoopTurn(created.runId, sid, { abort: abortB, isIdle: () => false });
		const r = stopRunExternal(created.runId);
		expect(abortA).not.toHaveBeenCalled(); // 已结束的回合不再取消
		expect(abortB).not.toHaveBeenCalled(); // B 不收到取消且继续运行
		expect(r.ok).toBe(true);
		expect(r.stopConfirmedAt).toBeTruthy(); // 无在途 run 回合证据 → 停止可确认
	});

	it("活跃 run 回合仍可取消：停止取消本回合并等待可核验的结束", () => {
		const sid = "b2-active-" + Math.random().toString(36).slice(2, 8);
		const created = createLoopRun({ sessionId: sid, cwd: workspace(), goal: "g" });
		const abort = vi.fn();
		let idle = false;
		markRunTurnDispatch(created.runId, sid);
		beginLoopTurn(created.runId, sid, { abort, isIdle: () => idle });
		const first = stopRunExternal(created.runId);
		expect(first.ok).toBe(true);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(first.stopConfirmedAt).toBeFalsy(); // 回合未结束 → 待确认
		idle = true;
		const recheck = stopRunExternal(created.runId);
		expect(recheck.stopConfirmedAt).toBeTruthy();
	});

	it("停止绑定「发起时登记的回合」：登记回合更换后不取消新回合", () => {
		const sid = "b2-turn-replaced-" + Math.random().toString(36).slice(2, 8);
		const created = createLoopRun({ sessionId: sid, cwd: workspace(), goal: "g" });
		const abort1 = vi.fn();
		markRunTurnDispatch(created.runId, sid);
		beginLoopTurn(created.runId, sid, { abort: abort1, isIdle: () => false });
		const first = stopRunExternal(created.runId);
		expect(abort1).toHaveBeenCalledTimes(1);
		expect(first.stopConfirmedAt).toBeFalsy();
		// 登记的回合已更换（新 run 回合开始）→ 停止不再取消新回合。
		const abort2 = vi.fn();
		markRunTurnDispatch(created.runId, sid);
		beginLoopTurn(created.runId, sid, { abort: abort2, isIdle: () => false });
		const second = stopRunExternal(created.runId);
		expect(abort2).not.toHaveBeenCalled(); // 新回合不对应发起时的停止 → 不取消
		// 停止等待的回合已结束 → 不计在途，可确认。
		expect(second.ok).toBe(true);
		expect(second.stopConfirmedAt).toBeTruthy();
	});

	it("跨会话：A 会话的回合结束事件不清 B 会话的控制器", () => {
		const sidA = "b2-x-a-" + Math.random().toString(36).slice(2, 8);
		const sidB = "b2-x-b-" + Math.random().toString(36).slice(2, 8);
		const a = createLoopRun({ sessionId: sidA, cwd: workspace(), goal: "a" });
		const b = createLoopRun({ sessionId: sidB, cwd: workspace(), goal: "b" });
		const abortA = vi.fn();
		const abortB = vi.fn();
		markRunTurnDispatch(a.runId, sidA);
		beginLoopTurn(a.runId, sidA, { abort: abortA, isIdle: () => false });
		markRunTurnDispatch(b.runId, sidB);
		beginLoopTurn(b.runId, sidB, { abort: abortB, isIdle: () => false });
		endLoopTurnsForSession(sidA);
		const ra = stopRunExternal(a.runId);
		expect(ra.ok).toBe(true);
		expect(ra.stopConfirmedAt).toBeTruthy();
		expect(abortA).not.toHaveBeenCalled();
		const rb = stopRunExternal(b.runId);
		expect(rb.ok).toBe(true);
		expect(abortB).toHaveBeenCalledTimes(1); // B 的控制器不受 A 会话结束影响
	});

	it("租约代次变化（接管）后旧控制器失效：不取消、无法核验保持未确认", () => {
		const sid = "b2-gen-" + Math.random().toString(36).slice(2, 8);
		const created = createLoopRun({ sessionId: sid, cwd: workspace(), goal: "g" });
		const abort = vi.fn();
		markRunTurnDispatch(created.runId, sid);
		beginLoopTurn(created.runId, sid, { abort, isIdle: () => false });
		// 模拟宿主冻结后接管：租约过期 → recoverRun 原子接管（generation 递增，本地持权）。
		const dir = join(RUNS_ROOT, created.runId);
		const leaseFile = join(dir, "lease.json");
		const lease = JSON.parse(readFileSync(leaseFile, "utf8"));
		lease.heartbeatAt = new Date(0).toISOString();
		writeFileSync(leaseFile, JSON.stringify(lease, null, 2));
		const rec = recoverRun(created.runId);
		expect(rec.ok).toBe(true);
		expect(rec.takeover).toBe(true);
		const r = stopRunExternal(created.runId);
		expect(r.ok, JSON.stringify(r)).toBe(true);
		expect(abort).not.toHaveBeenCalled(); // 旧代次的控制器不取消任何东西
		expect(r.stopConfirmedAt).toBeFalsy(); // 无法核验旧回合 → 保持未确认
		// 回合证据清理后重新核对 → 确认。
		endLoopTurnsForSession(sid);
		const recheck = stopRunExternal(created.runId);
		expect(recheck.stopConfirmedAt).toBeTruthy();
	});
});

describe("旧执行实体逐实体判定（投递门禁）", () => {
	it("旧 PID A 存活 + 独立 operation B：B 的退出证据只核实 B，A 未核实期间门禁不放行", async () => {
		const childA = spawnChild();
		try {
			const sid = "b2-entity-ab-" + Math.random().toString(36).slice(2, 8);
			const ws = workspace();
			const created = createLoopRun({ sessionId: sid, cwd: ws, goal: "g" });
			patchState(created.runId, {
				legacyExecutionEntities: [
					{ pid: childA.pid, host: "old-host", startId: null, capturedAt: new Date().toISOString(), generation: 1 },
				],
			});
			// 独立 operation B：真实执行、有可信退出证据（pid+host+startId+result）。
			const b = await runCommandPersistent("bash", ["-lc", "exit 0"], {
				runId: created.runId,
				stage: "validate",
				round: created.st.round,
				attemptId: created.st.attemptId,
				cwd: ws,
			});
			const bOp = listOperations(created.runId).find((o: { opId: string }) => o.opId === b.opId)!;
			expect(bOp.result).toBeTruthy();
			expect(bOp.pid).not.toBe(childA.pid);
			// B 的退出证据不能核实 A：A 存活期间所有新投递为零。
			expect(canResumeLoopDelivery(loadLoopState(created.runId))).toBe(false);
			// A 退出（可信退出证据）→ 门禁放行。
			childA.kill();
			await waitFor(() => !alive(childA.pid));
			await new Promise((r) => setTimeout(r, 200));
			expect(canResumeLoopDelivery(loadLoopState(created.runId))).toBe(true);
		} finally {
			childA.kill();
		}
	});

	it("同一实体不双重阻断：pid+host+startId 全部匹配且有可信退出证据的实体不阻断", async () => {
		const sid = "b2-entity-once-" + Math.random().toString(36).slice(2, 8);
		const ws = workspace();
		const created = createLoopRun({ sessionId: sid, cwd: ws, goal: "g" });
		const b = await runCommandPersistent("bash", ["-lc", "exit 0"], {
			runId: created.runId,
			stage: "validate",
			round: created.st.round,
			attemptId: created.st.attemptId,
			cwd: ws,
		});
		const bOp = listOperations(created.runId).find((o: { opId: string }) => o.opId === b.opId)!;
		patchState(created.runId, {
			legacyExecutionEntities: [
				{
					pid: bOp.pid,
					host: bOp.entity!.host,
					startId: bOp.entity!.startId,
					capturedAt: new Date().toISOString(),
					generation: 1,
				},
			],
		});
		expect(canResumeLoopDelivery(loadLoopState(created.runId))).toBe(true);
	});

	it("PID 复用/身份不符：startId 不匹配或仍在运行（无退出证据）都保持阻断；退出证据落地后放行", async () => {
		const sid = "b2-entity-reuse-" + Math.random().toString(36).slice(2, 8);
		const ws = workspace();
		const created = createLoopRun({ sessionId: sid, cwd: ws, goal: "g" });
		const running = runCommandPersistent("bash", ["-lc", "sleep 1; exit 0"], {
			runId: created.runId,
			stage: "validate",
			round: created.st.round,
			attemptId: created.st.attemptId,
			cwd: ws,
		});
		await waitFor(() => listOperations(created.runId).some((o: { entity?: unknown }) => o.entity));
		const opRec = listOperations(created.runId).find((o: { status?: string }) => o.status === "running")!;
		const ent = opRec.entity!;
		expect(alive(opRec.pid!)).toBe(true);
		// 正确身份但仍在运行（无 result）→ 未核实，阻断。
		patchState(created.runId, {
			legacyExecutionEntities: [
				{ pid: opRec.pid, host: ent.host, startId: ent.startId, capturedAt: new Date().toISOString(), generation: 1 },
			],
		});
		expect(canResumeLoopDelivery(loadLoopState(created.runId))).toBe(false);
		// 同 PID 但进程启动身份不符（PID 复用/伪造）→ 阻断。
		patchState(created.runId, {
			legacyExecutionEntities: [
				{ pid: opRec.pid, host: ent.host, startId: "forged-start-id", capturedAt: new Date().toISOString(), generation: 1 },
			],
		});
		expect(canResumeLoopDelivery(loadLoopState(created.runId))).toBe(false);
		// 可信退出证据落地 + 身份匹配 → 放行。
		await running;
		patchState(created.runId, {
			legacyExecutionEntities: [
				{ pid: opRec.pid, host: ent.host, startId: ent.startId, capturedAt: new Date().toISOString(), generation: 1 },
			],
		});
		expect(canResumeLoopDelivery(loadLoopState(created.runId))).toBe(true);
	});

	it("观察选择规则：当前 round/attempt 未消费的 operation 只被选中一次", async () => {
		const sid = "b2-obs-once-" + Math.random().toString(36).slice(2, 8);
		const ws = workspace();
		const created = createLoopRun({ sessionId: sid, cwd: ws, goal: "g" });
		const b = await runCommandPersistent("bash", ["-lc", "exit 0"], {
			runId: created.runId,
			stage: "validate",
			round: created.st.round,
			attemptId: created.st.attemptId,
			cwd: ws,
		});
		expect(pendingUnconsumedOp(loadLoopState(created.runId))?.opId).toBe(b.opId);
		// 消费后（consumedResults 登记）不再被选中 → 观察仅一次。
		patchState(created.runId, {
			consumedResults: { [b.opId]: { digest: "d", round: created.st.round, stage: "validate" } },
		});
		expect(pendingUnconsumedOp(loadLoopState(created.runId))).toBeNull();
	});
});
