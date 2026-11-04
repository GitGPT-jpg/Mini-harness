/**
 * 接管代际隔离（Prompt §4 修复② / 验证矩阵 B）：
 *  - 新执行者接管（generation+1、owner 更换）后，旧 owner 的迟到 validator 回调不得把新代次状态写回 done；
 *  - 旧 owner 的 heartbeat / release / recordTaskPid 不得覆盖或删除新 owner 的租约。
 *
 * 与 loop-recovery/loop-lease-race 的差异：这里验证的是「异步回调在 await 后写盘」这条链上的代际隔离，
 * 而不是租约文件本身的 CAS（后者已在 loop-lease-race 覆盖）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUNS_ROOT = mkdtempSync(join(tmpdir(), "loop-takeover-fencing-"));
process.env.MINI_HARNESS_RUNTIME_ROOT = RUNS_ROOT;
const ext = await import("../../server/loop/extension.js");
const { createLoopExtension, createLoopRun, recoverRun, setLoopExecForTest, stopLeaseHeartbeat } = ext;
const recovery = await import("../../server/loop/recovery.js");
const { getLease, LEASE_TTL_MS } = recovery;

const CWD = mkdtempSync(join(tmpdir(), "loop-fencing-workspace-"));
let seq = 0;
const SID = () => "takeover-fencing-" + seq++;

afterAll(() => {
	rmSync(RUNS_ROOT, { recursive: true, force: true });
	rmSync(CWD, { recursive: true, force: true });
});

function loadRun(runId: string): any {
	return JSON.parse(readFileSync(join(RUNS_ROOT, runId, "state.json"), "utf8"));
}
/** 把当前租约改写为「已过期」，模拟旧 owner 失联/服务退出，使 recoverRun 允许接管。 */
function expireLease(runId: string): void {
	const lease = getLease(join(RUNS_ROOT, runId));
	const past = new Date(Date.now() - LEASE_TTL_MS - 60_000).toISOString();
	const expired = { ...lease, heartbeatAt: past };
	writeFileSync(join(RUNS_ROOT, runId, "lease.json"), JSON.stringify(expired, null, 2));
}

function waitFor(fn: () => boolean, ms = 8000, step = 10): Promise<void> {
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

describe("接管代际隔离（旧 owner 迟到回调不得覆盖新代次）", () => {
	it("B.8 接管后，旧 owner 的迟到 validator 回调不能把新代次状态写回 done", async () => {
		const sid = SID();
		const tools = new Map<string, any>();
		const handlers = new Map<string, any[]>();
		let resolveValidator: ((r: any) => void) | null = null;
		let deferred = true;
		const pi: any = {
			registerTool: (t: any) => tools.set(t.name, t),
			on: (ev: string, fn: any) => {
				if (!handlers.has(ev)) handlers.set(ev, []);
				handlers.get(ev)!.push(fn);
			},
			exec: (cmd: string, args: string[]) => {
				if (deferred) return new Promise((res) => (resolveValidator = res));
				return Promise.resolve({ code: 0, stdout: "ok", stderr: "" });
			},
			sendUserMessage: () => {},
		};
		createLoopExtension()(pi);
		setLoopExecForTest(async (cmd: string, args: string[], opts?: { cwd?: string }) => {
			const r = await pi.exec(cmd, args, opts);
			return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? null, killed: false };
		});
		const created = createLoopRun({
			sessionId: sid,
			cwd: CWD,
			goal: "g",
			validateCmd: "validator_cmd",
			useReviewer: false,
		});
		if (!created.ok) throw new Error(created.error);
		const runId = created.runId;
		const before = loadRun(runId);
		expect(before.owner).toBeTruthy();
		expect(before.generation).toBe(1);

		const ctx: any = { sessionManager: { getSessionId: () => sid }, cwd: CWD };
		await tools.get("loop_done")!.execute("tc", { summary: "s" }, undefined, undefined, ctx);
		// agent_end 触发验收：validator 挂起，期间旧 owner 失联 → 新 owner 接管
		const pending = handlers.get("agent_end")![0]({}, ctx);
		await waitFor(() => resolveValidator !== null);

		expireLease(runId);
		const rec = recoverRun(runId, "b@host");
		expect(rec.takeover).toBe(true);
		const afterTakeover = loadRun(runId);
		expect(afterTakeover.owner).toBe("b@host");
		expect(afterTakeover.generation).toBe(2);

		// 旧 owner 的 validator 迟到完成（pass）：必须被代际隔离丢弃，不得把新代次写回 done。
		deferred = false;
		resolveValidator!({ code: 0, stdout: "ok", stderr: "" });
		await pending;

		const final = loadRun(runId);
		expect(final.owner).toBe("b@host");
		expect(final.generation).toBe(2);
		expect(final.status).toBe("active"); // 仍由新 owner 持有，未被旧回调翻成 done
		stopLeaseHeartbeat(runId);
	}, 30_000);
});
