/**
 * 隔夜恢复（跨中断）最小实现回归：
 * - 同 Run 锁域内的租约（acquire/heartbeat/expire/release）；
 * - 环境指纹（输入/环境摘要）与恢复分类（done/running/failed/unknown/cancelled）；
 * - createLoopRun 落盘 attemptId/owner/generation/environmentFingerprint 并取得租约；
 * - recoverRun 接管：失联才接管（generation+1、保留 attemptId）；他人持权不接管；已取消不复活。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	acquireLease,
	buildRecoverySummary,
	classifyRecovery,
	getLease,
	hashEnvironment,
	hashInputs,
	heartbeat,
	leaseExpired,
	newAttemptId,
	releaseLease,
	LEASE_TTL_MS,
} from "../../server/loop/recovery.js";

// extension.ts 在模块初始化时固定 run root，必须先指到临时目录再 import。
const LOOP_RUNS_ROOT = mkdtempSync(join(tmpdir(), "loop-recovery-runs-"));
const WORKSPACE = mkdtempSync(join(tmpdir(), "loop-recovery-workspace-"));
const prev = process.env.MINI_HARNESS_RUNTIME_ROOT;
process.env.MINI_HARNESS_RUNTIME_ROOT = LOOP_RUNS_ROOT;
const {
	createLoopRun,
	loadLoopState,
	recoverRun,
	recoveryInfoOf,
	stopRunExternal,
	migrateMissingLoopStates,
	listRuns,
} = await import("../../server/loop/extension.js");
if (prev === undefined) delete process.env.MINI_HARNESS_RUNTIME_ROOT;
else process.env.MINI_HARNESS_RUNTIME_ROOT = prev;

afterAll(() => {
	rmSync(LOOP_RUNS_ROOT, { recursive: true, force: true });
	rmSync(WORKSPACE, { recursive: true, force: true });
});

describe("恢复原语（recovery.ts）", () => {
	it("hashInputs 键序无关、稳定；hashEnvironment 只取身份键", () => {
		expect(hashInputs({ b: "2", a: "1" })).toBe(hashInputs({ a: "1", b: "2" }));
		expect(hashInputs({ a: null, b: undefined })).toBe(hashInputs({ a: "", b: "" }));
		// 非身份键不参与摘要：换掉它不改变 envHash。
		expect(hashEnvironment({ FOO: "x" })).toBe(hashEnvironment({ FOO: "y" }));
	});

	it("租约：取得→续租→过期→释放；heartbeat 校验 owner", () => {
		const dir = join(LOOP_RUNS_ROOT, "lease-" + Date.now());
		const nowIso = new Date().toISOString();
		const ok = acquireLease(dir, {
			owner: "a@host",
			pid: 1,
			generation: 1,
			startedAt: nowIso,
			heartbeatAt: nowIso,
			remoteJobId: null,
		});
		expect(ok).toBe(true);
		expect(getLease(dir)?.owner).toBe("a@host");
		expect(leaseExpired(getLease(dir))).toBe(false);
		expect(heartbeat(dir, "a@host", 1)).toBe(true);
		expect(heartbeat(dir, "b@host", 1)).toBe(false); // 非 owner 不能续租
		expect(releaseLease(dir, "b@host", 1)).toBe(false); // 非 owner 不能释放
		expect(releaseLease(dir, "a@host", 1)).toBe(true);
		expect(getLease(dir)).toBeNull();
	});

	it("租约过期判定：心跳超过 TTL 视为失联", () => {
		const dir = join(LOOP_RUNS_ROOT, "lease-exp-" + Date.now());
		const past = new Date(Date.now() - LEASE_TTL_MS - 1000).toISOString();
		acquireLease(dir, {
			owner: "a@host",
			pid: 1,
			generation: 1,
			startedAt: past,
			heartbeatAt: past,
			remoteJobId: null,
		});
		expect(leaseExpired(getLease(dir))).toBe(true);
	});

	it("恢复分类：done/running/failed-retryable/unknown/cancelled", () => {
		const base = {
			leaseHeld: false,
			environmentChanged: false,
			pidAlive: null as boolean | null,
			lastRoundPassed: false,
			inFlight: false,
		};
		expect(classifyRecovery({ status: "stopped" }, base).unit).toBe("cancelled");
		expect(classifyRecovery({ status: "done" }, { ...base, environmentChanged: false }).unit).toBe("completed-valid");
		expect(classifyRecovery({ status: "done" }, { ...base, environmentChanged: true }).unit).toBe("unknown");
		expect(classifyRecovery({ status: "active" }, { ...base, leaseHeld: true }).unit).toBe("running");
		expect(classifyRecovery({ status: "active" }, { ...base, environmentChanged: true }).unit).toBe("unknown");
		expect(classifyRecovery({ status: "active" }, { ...base, inFlight: true, pidAlive: true }).unit).toBe("running");
		expect(classifyRecovery({ status: "active" }, { ...base, inFlight: true, pidAlive: false }).unit).toBe("unknown");
		expect(classifyRecovery({ status: "active" }, { ...base, inFlight: false, lastRoundPassed: false }).unit).toBe(
			"failed-retryable",
		);
	});

	it("恢复摘要包含分类与下一步语义", () => {
		const cls = classifyRecovery(
			{ status: "active" },
			{ leaseHeld: false, environmentChanged: true, pidAlive: null, lastRoundPassed: false, inFlight: false },
		);
		const s = buildRecoverySummary({
			runId: "r1",
			attemptId: "a1",
			generation: 1,
			cls,
			completedRounds: 3,
			bestRound: 2,
			blockedOn: null,
		});
		expect(s).toContain("<mini_harness_recovery>");
		expect(s).toContain("unknown");
		expect(s).toContain("先核对执行现场/证据");
	});
});

describe("隔夜恢复集成（extension.ts）", () => {
	function makeRun() {
		const created = createLoopRun({
			sessionId: "sess-" + Date.now() + Math.random(),
			cwd: WORKSPACE,
			goal: "恢复回归",
		});
		expect(created.ok).toBe(true);
		return created as { ok: true; runId: string; st: import("../../server/loop/extension.js").LoopState };
	}

	it("createLoopRun 落盘 attemptId/owner/generation/环境指纹，并取得租约", () => {
		const { runId } = makeRun();
		const st = loadLoopState(runId)!;
		expect(st.attemptId).toBeTruthy();
		expect(st.owner).toBeTruthy();
		expect(st.generation).toBe(1);
		expect(st.environmentFingerprint).not.toBeNull();
		expect(st.environmentFingerprint!.workspace).toBeTruthy();
		expect(getLease(join(LOOP_RUNS_ROOT, runId))?.owner).toBe(st.owner);
		expect(recoveryInfoOf(runId)?.unit).toBe("running");
	});

	it("失联接管：generation+1、保留 attemptId、新 owner；他人持权不接管", () => {
		const { runId } = makeRun();
		const st0 = loadLoopState(runId)!;
		// 他人仍持有效租约 → 不接管。
		const denied = recoverRun(runId, "intruder@host");
		expect(denied.ok).toBe(true);
		expect(denied.takeover).toBe(false);
		expect(getLease(join(LOOP_RUNS_ROOT, runId))?.owner).toBe(st0.owner);

		// 这里只验证租约缺失分支；真实 SIGKILL 由 core-restart 覆盖。
		// 重新观察保留 attempt，不能通过新 attempt 掩盖重跑。
		rmSync(join(LOOP_RUNS_ROOT, runId, "lease.json"), { force: true });
		const taken = recoverRun(runId, "recoverer@host");
		expect(taken.ok).toBe(true);
		expect(taken.takeover).toBe(true);
		const st1 = loadLoopState(runId)!;
		expect(st1.owner).toBe("recoverer@host");
		expect(st1.generation).toBe(2);
		expect(st1.attemptId).toBe(st0.attemptId);
		expect(getLease(join(LOOP_RUNS_ROOT, runId))?.owner).toBe("recoverer@host");
	});

	it("已停止的 run 不复活（cancelled），且停止时释放租约", () => {
		const { runId } = makeRun();
		const r = stopRunExternal(runId, "user-stop");
		expect(r.ok).toBe(true);
		expect(getLease(join(LOOP_RUNS_ROOT, runId))).toBeNull();
		const rec = recoverRun(runId, "recoverer@host");
		expect(rec.ok).toBe(true);
		expect(rec.takeover).toBe(false);
		expect(rec.classification?.unit).toBe("cancelled");
	});

	it("newAttemptId 唯一", () => {
		const ids = new Set(Array.from({ length: 200 }, () => newAttemptId()));
		expect(ids.size).toBe(200);
	});

	it("列表遇到损坏或超大状态明确失败，不把已有运行伪装成空列表", () => {
		const id = "20261103000000-listbudget";
		const dir = join(LOOP_RUNS_ROOT, id);
		mkdirSync(dir);
		try {
			writeFileSync(join(dir, "state.json"), "{broken");
			expect(() => listRuns()).toThrow();
			truncateSync(join(dir, "state.json"), 16 * 1024 * 1024 + 1);
			expect(() => listRuns()).toThrow("Run list state size budget exceeded");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		expect(Array.isArray(listRuns())).toBe(true);
	});

	it("启动迁移恢复仅剩 CAS 的旧任务，查询不写入且冲突保留原件", () => {
		const { runId } = makeRun();
		expect(stopRunExternal(runId).ok).toBe(true);
		const template = { ...loadLoopState(runId)!, owner: null };
		const legacyId = "20261103000000-casonly";
		const conflictId = "20261103000000-conflict";
		for (const id of [legacyId, conflictId]) {
			mkdirSync(join(LOOP_RUNS_ROOT, id));
			writeFileSync(join(LOOP_RUNS_ROOT, id, "state.json.cas.999999.seed"), JSON.stringify({ ...template, runId: id }));
		}
		const conflictingFile = join(LOOP_RUNS_ROOT, conflictId, "state.json.cas.999999.other");
		const conflictingBytes = JSON.stringify({ ...template, runId: conflictId, goal: "different" });
		writeFileSync(conflictingFile, conflictingBytes);
		expect(listRuns().some((st) => st.runId === legacyId)).toBe(false);
		expect(existsSync(join(LOOP_RUNS_ROOT, legacyId, ".storage-version"))).toBe(false);
		const results = migrateMissingLoopStates();
		expect(results.find((r) => r.runId === legacyId)?.error).toBeUndefined();
		expect(loadLoopState(legacyId)?.status).toBe("stopped");
		expect(listRuns().some((st) => st.runId === legacyId)).toBe(true);
		expect(results.find((r) => r.runId === conflictId)?.error).toBeTruthy();
		expect(readFileSync(conflictingFile, "utf8")).toBe(conflictingBytes);
		expect(existsSync(join(LOOP_RUNS_ROOT, conflictId, ".storage-backup-v3"))).toBe(true);
		expect(migrateMissingLoopStates().some((r) => r.runId === legacyId)).toBe(false);
	});

	it("环境变化使旧证据失效（fingerprint 变更 → unknown/需核对）", () => {
		const { runId } = makeRun();
		rmSync(join(LOOP_RUNS_ROOT, runId, "lease.json"), { force: true });
		// 直接改 run 状态里的 goal，使输入摘要变化 → 环境指纹不匹配。
		const st = loadLoopState(runId)!;
		writeFileSync(join(LOOP_RUNS_ROOT, runId, "state.json"), JSON.stringify({ ...st, goal: "改动后的目标" }));
		const rec = recoverRun(runId, "recoverer@host");
		expect(rec.ok).toBe(true);
		// 环境指纹不匹配（旧指纹 goal 摘要 vs 新 goal）→ 需核对，不盲目重跑。
		expect(rec.classification?.needRecheck).toBe(true);
	});
});
