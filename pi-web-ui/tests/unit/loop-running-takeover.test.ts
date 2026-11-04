/**
 * 在途执行接续（Prompt 修复④）：服务退出/重启后，本地长命令仍在运行时，
 * 恢复不再「只分类」，而是能原子接管（孤儿租约立即接管）+ 暴露 inFlightOpId 供观察收集。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const RUNS_ROOT = mkdtempSync(join(tmpdir(), "loop-running-takeover-"));
process.env.MINI_HARNESS_RUNTIME_ROOT = RUNS_ROOT;
const ext = await import("../../server/loop/extension.js");
const { createLoopRun, recoverRun, stopLeaseHeartbeat, stopRunExternal } = ext;
const op = await import("../../server/loop/operation.js");
const { runCommandPersistent, listOperations } = op;

const CWD = mkdtempSync(join(tmpdir(), "loop-running-workspace-"));
let seq = 0;
const SID = () => "running-takeover-" + seq++;

afterAll(() => {
	rmSync(RUNS_ROOT, { recursive: true, force: true });
	rmSync(CWD, { recursive: true, force: true });
});

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

describe("在途执行接续（孤儿租约 + 在运行实体 → 接管并可观察）", () => {
	it("服务退出后，本地 validator 仍在跑：recoverRun 原子接管 + 暴露 inFlightOpId + resumeEligible", async () => {
		const sid = SID();
		const created = createLoopRun({ sessionId: sid, cwd: CWD, goal: "g", validateCmd: "sleep 30", useReviewer: false });
		if (!created.ok) throw new Error(created.error);
		const runId = created.runId;
		stopLeaseHeartbeat(runId); // 模拟服务进程心跳停止（但本地命令仍在跑）

		// 「旧服务」启动一个长 validator 后立刻退出（不 await 结果，只留 operation.json）。
		runCommandPersistent("bash", ["-lc", "sleep 30; echo long-validator"], {
			cwd: CWD,
			runId,
			attemptId: created.st.attemptId,
			stage: "validate",
			round: 1,
		}).catch(() => {});
		await waitFor(() => listOperations(runId).some((o) => o.status === "running" && o.pid != null));
		const runningOp = listOperations(runId).find((o) => o.status === "running")!;

		// 模拟「旧服务已死、租约成为孤儿」：owner 换成别的进程、pid 指向一个已死 pid、心跳仍新鲜。
		const nowIso = new Date().toISOString();
		writeFileSync(
			join(RUNS_ROOT, runId, "lease.json"),
			JSON.stringify(
				{
					owner: "old-service@host",
					pid: 999999, // 已死的服务进程 pid
					generation: 1,
					startedAt: nowIso,
					heartbeatAt: nowIso,
					remoteJobId: null,
					taskPid: runningOp.pid, // 本地 validator 仍在跑
				},
				null,
				2,
			),
		);

		const rec = recoverRun(runId, "b@host");
		expect(rec.ok).toBe(true);
		expect(rec.classification?.unit).toBe("running"); // 只分类 → 现在是「分类 + 接续」
		expect(rec.takeover).toBe(true); // 孤儿租约 → 立即接管（不等 30s TTL）
		expect(rec.resumeEligible).toBe(true);
		expect(rec.inFlightOpId).toBe(runningOp.opId);

		const after = JSON.parse(readFileSync(join(RUNS_ROOT, runId, "state.json"), "utf8"));
		expect(after.owner).toBe("b@host");
		expect(after.generation).toBe(2);
		stopLeaseHeartbeat(runId);
		// 清理由持久身份核验后的产品入口执行，不能把 runner PID 当作 PGID。
		expect(stopRunExternal(runId).ok).toBe(true);
	}, 30_000);
});
