// @vitest-environment node
/**
 * P3/P4：停止只取消目标回合并核验退出；旧执行实体未核实前阻断续跑。
 *  - 持久回合在途证据：旧宿主进程已死 → 不计在途（可确认）；旧宿主仍活 → 待确认。
 *  - 服务层停止定位：run 绑定其它会话时不注册/不取消当前聊天的回合。
 *  - 旧实体接管后：resumeEligible=false、投递门禁阻断、进程不误杀；核实后恢复。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const RUNS_ROOT = mkdtempSync(join(tmpdir(), "loop-turn-p4-runs-"));
process.env.MINI_HARNESS_RUNTIME_ROOT = RUNS_ROOT;
const ext = await import("../../server/loop/extension.js");
const {
	createLoopRun,
	loadLoopState,
	registerRunTurnController,
	unregisterRunTurnController,
	stopRunExternal,
	recoverRun,
	canResumeLoopDelivery,
	markRunTurnDispatch,
	beginLoopTurn,
} = ext as any;
const { ClientSession } = await import("../../server/agent-service.js");

function spawnChild(): { pid: number; kill: () => void } {
	const child: ChildProcess = spawn(process.execPath, [
		"-e",
		"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);",
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

function workspace(): string {
	return mkdtempSync(join(tmpdir(), "loop-turn-p4-ws-"));
}

afterAll(() => {
	rmSync(RUNS_ROOT, { recursive: true, force: true });
});

describe("停止只取消目标回合并核验退出（P3）", () => {
	it("持久回合证据：旧宿主进程已死 → 不计在途，停止可确认", () => {
		const created = createLoopRun({
			sessionId: "p3-dead-" + Math.random().toString(36).slice(2, 8),
			cwd: workspace(),
			goal: "g",
		});
		const dir = join(RUNS_ROOT, created.runId);
		const stateFile = join(dir, "state.json");
		const st = JSON.parse(readFileSync(stateFile, "utf8"));
		st.turnActive = { owner: "999999@old-host@x", since: new Date().toISOString() };
		writeFileSync(stateFile, JSON.stringify(st, null, 2));
		const r = stopRunExternal(created.runId);
		expect(r.ok).toBe(true);
		expect(r.stopConfirmedAt).toBeTruthy();
		expect(loadLoopState(created.runId)).toMatchObject({ status: "stopped", stage: "stopped" });
	});

	it("持久回合证据：旧宿主进程仍活 → 无法核验，停止待确认", async () => {
		const child = spawnChild();
		try {
			const created = createLoopRun({
				sessionId: "p3-live-" + Math.random().toString(36).slice(2, 8),
				cwd: workspace(),
				goal: "g",
			});
			const dir = join(RUNS_ROOT, created.runId);
			const stateFile = join(dir, "state.json");
			const st = JSON.parse(readFileSync(stateFile, "utf8"));
			st.turnActive = { owner: `${child.pid}@old-host@x`, since: new Date().toISOString() };
			writeFileSync(stateFile, JSON.stringify(st, null, 2));
			const first = stopRunExternal(created.runId);
			expect(first.ok).toBe(true);
			expect(first.stopRequestedAt).toBeTruthy();
			expect(first.stopConfirmedAt).toBeFalsy();
			expect(loadLoopState(created.runId)).toMatchObject({ stage: "stopping", recoveryState: "stop-unconfirmed" });
			// 回合可核验结束后重新核对 → 确认（等真实退出，避免僵尸进程 kill(pid,0) 仍成功）。
			child.kill();
			await vi.waitFor(() => expect(alive(child.pid)).toBe(false), { timeout: 5000 });
			await new Promise((r) => setTimeout(r, 200));
			const recheck = stopRunExternal(created.runId);
			expect(recheck.ok).toBe(true);
			expect(recheck.stopConfirmedAt).toBeTruthy();
		} finally {
			child.kill();
		}
	});

	it("run 绑定其它会话：服务层停止不取消当前聊天的回合", async () => {
		const mainSid = "main-" + Math.random().toString(36).slice(2, 8);
		const otherSid = "other-" + Math.random().toString(36).slice(2, 8);
		const created = createLoopRun({ sessionId: otherSid, cwd: workspace(), goal: "g" });
		const conv: any = { id: "main", isSubagent: false, session: { sessionId: mainSid, isIdle: true } };
		const session: any = Object.create(ClientSession.prototype);
		session.loopResuming = new Set();
		Object.defineProperty(session, "conv", { value: conv, configurable: true, writable: true });
		session.convs = new Map([["main", conv]]);
		session.activeId = "main";
		session.flushSnapshot = () => {};
		session.emitNotice = () => {};
		session.interruptRun = vi.fn(async () => {});
		await session.stopLoop(created.runId);
		expect(session.interruptRun).not.toHaveBeenCalled(); // 不取消当前聊天 B
	});

	it("run 绑定当前会话：停止经回合启动注册的控制器取消目标回合并确认", async () => {
		const mainSid = "main2-" + Math.random().toString(36).slice(2, 8);
		const created = createLoopRun({ sessionId: mainSid, cwd: workspace(), goal: "g" });
		const abort = vi.fn();
		let idle = false;
		// 回合启动（before_agent_start）：消费投递登记 → 注册绑定本回合的取消控制器。
		markRunTurnDispatch(created.runId, mainSid);
		beginLoopTurn(created.runId, mainSid, { abort, isIdle: () => idle });
		const conv: any = { id: "main", isSubagent: false, session: { sessionId: mainSid, isIdle: false } };
		const session: any = Object.create(ClientSession.prototype);
		session.loopResuming = new Set();
		Object.defineProperty(session, "conv", { value: conv, configurable: true, writable: true });
		session.convs = new Map([["main", conv]]);
		session.activeId = "main";
		session.flushSnapshot = () => {};
		session.emitNotice = () => {};
		await session.stopLoop(created.runId);
		expect(abort).toHaveBeenCalledTimes(1); // 只取消本回合（经回合启动注册的控制器）
		const st = loadLoopState(created.runId);
		expect(st.stopRequestedAt).toBeTruthy();
		expect(st.stopConfirmedAt).toBeFalsy(); // 回合尚未结束 → 待确认
		// 回合结束后重新核对 → 确认。
		idle = true;
		const recheck = stopRunExternal(created.runId);
		expect(recheck.stopConfirmedAt).toBeTruthy();
	});
});

describe("旧执行实体未核实前阻断续跑（P4）", () => {
	it("跨宿主接管：证据保留、进程不误杀、resumeEligible=false、投递门禁阻断", async () => {
		const child = spawnChild();
		try {
			const sid = "p4-legacy-" + Math.random().toString(36).slice(2, 8);
			const created = createLoopRun({ sessionId: sid, cwd: workspace(), goal: "g" });
			const dir = join(RUNS_ROOT, created.runId);
			const leaseFile = join(dir, "lease.json");
			const st = loadLoopState(created.runId);
			writeFileSync(
				leaseFile,
				JSON.stringify(
					{
						owner: st.owner,
						pid: 1,
						generation: st.generation,
						startedAt: new Date(0).toISOString(),
						heartbeatAt: new Date(0).toISOString(),
						remoteJobId: null,
						taskPid: child.pid,
					},
					null,
					2,
				) + "\n",
			);
			const rec = recoverRun(created.runId);
			expect(rec.ok).toBe(true);
			expect(rec.takeover).toBe(true);
			expect(rec.resumeEligible).toBe(false);
			expect(rec.blockedReason).toContain("未核实的旧执行实体");
			const after = loadLoopState(created.runId);
			expect(after.legacyExecutionEntities?.some((e: { pid: number }) => e.pid === child.pid)).toBe(true);
			expect(alive(child.pid)).toBe(true); // 身份未核实：不发信号
			// 投递门禁：自动/手动入口共用。
			expect(canResumeLoopDelivery(after)).toBe(false);
			// 实体退出（核实结束）→ 门禁放行。
			child.kill();
			await new Promise((r) => setTimeout(r, 300));
			const rec2 = recoverRun(created.runId);
			expect(rec2.ok).toBe(true);
			expect(rec2.resumeEligible).toBe(true);
			expect(canResumeLoopDelivery(loadLoopState(created.runId))).toBe(true);
		} finally {
			child.kill();
		}
	});

	it("PID 复用（不同进程占用同一 PID 位置）：存活即视为未核实，阻断续跑", () => {
		// 用一个真实存活进程的 PID 伪造旧实体：身份未核实，不能仅凭 PID 相同放行。
		const child = spawnChild();
		try {
			const sid = "p4-reuse-" + Math.random().toString(36).slice(2, 8);
			const created = createLoopRun({ sessionId: sid, cwd: workspace(), goal: "g" });
			const dir = join(RUNS_ROOT, created.runId);
			const stateFile = join(dir, "state.json");
			const st = JSON.parse(readFileSync(stateFile, "utf8"));
			st.legacyExecutionEntities = [
				{ pid: child.pid, host: "old-host", startId: null, capturedAt: new Date().toISOString(), generation: 1 },
			];
			writeFileSync(stateFile, JSON.stringify(st, null, 2));
			const fresh = loadLoopState(created.runId);
			expect(canResumeLoopDelivery(fresh)).toBe(false);
			// 停止同样不得向该 PID 发信号。
			const r = stopRunExternal(created.runId);
			expect(r.ok).toBe(true);
			expect(r.stopConfirmedAt).toBeFalsy();
			expect(alive(child.pid)).toBe(true);
		} finally {
			child.kill();
		}
	});

	it("服务实际投递为零：resumeLoop 在旧实体未核实时不发送续跑提示词", async () => {
		const child = spawnChild();
		try {
			const sid = "p4-dispatch-" + Math.random().toString(36).slice(2, 8);
			const created = createLoopRun({ sessionId: sid, cwd: workspace(), goal: "g" });
			const dir = join(RUNS_ROOT, created.runId);
			const leaseFile = join(dir, "lease.json");
			const st = loadLoopState(created.runId);
			writeFileSync(
				leaseFile,
				JSON.stringify(
					{
						owner: st.owner,
						pid: 1,
						generation: st.generation,
						startedAt: new Date(0).toISOString(),
						heartbeatAt: new Date(0).toISOString(),
						remoteJobId: null,
						taskPid: child.pid,
					},
					null,
					2,
				) + "\n",
			);
			let promptCalls = 0;
			const conv: any = { id: "main", isSubagent: false, session: { sessionId: sid, isIdle: true } };
			const session: any = Object.create(ClientSession.prototype);
			session.loopResuming = new Set();
			Object.defineProperty(session, "conv", { value: conv, configurable: true, writable: true });
			session.convs = new Map([["main", conv]]);
			session.activeId = "main";
			session.flushSnapshot = () => {};
			session.emitNotice = () => {};
			session.prompt = async () => {
				promptCalls += 1;
			};
			await session.resumeLoop(created.runId);
			expect(promptCalls).toBe(0); // 实际投递次数为零
			expect(alive(child.pid)).toBe(true);
		} finally {
			child.kill();
		}
	});
});
