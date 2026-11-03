/**
 * 持久化操作执行器（Prompt 修复④）：
 *  - stdio 落文件 + operation.json 记录 pid/状态 + shell 包装写退出码；
 *  - 服务「重启」后（新调用者只凭 operation.json）能观察仍在运行的实体、等其退出并收集退出码与输出。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const RUNS_ROOT = mkdtempSync(join(tmpdir(), "loop-operation-persist-"));
process.env.MINI_HARNESS_RUNTIME_ROOT = RUNS_ROOT;
const op = await import("../../server/loop/operation.js");
const { runCommandPersistent, listOperations, observeOperation, readOperation } = op;

afterAll(() => rmSync(RUNS_ROOT, { recursive: true, force: true }));

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

describe("持久化操作执行器", () => {
	it("命令结果落盘：exit code / stdout / operation.json 状态", async () => {
		const runId = "op-test-" + Date.now();
		const res = await runCommandPersistent("bash", ["-c", "echo hello-out; echo err-out >&2; exit 7"], {
			cwd: RUNS_ROOT,
			runId,
			stage: "validate",
			round: 1,
		});
		expect(res.code).toBe(7);
		expect(res.stdout).toContain("hello-out");
		expect(res.stderr).toContain("err-out");
		expect(res.opId).toBeTruthy();
		const rec = readOperation(runId, res.opId);
		expect(rec).toBeTruthy();
		expect(rec!.status).toBe("exited");
		expect(rec!.exitCode).toBe(7);
		expect(rec!.pid).toBeGreaterThan(0);
		// 退出码文件确实由 shell 包装写入（重启后据此拿 exit code）。
		expect(readFileSync(rec!.exitFile, "utf8").trim()).toBe("7");
	});

	it("跨「重启」接续：新调用者凭 operation.json 观察在运行实体、等退出并收集结果", async () => {
		const runId = "op-restart-" + Date.now();
		// 「旧服务」启动一个 1.5s 的长命令后立刻「崩溃」（不 await，模拟进程死亡）。
		runCommandPersistent("bash", ["-c", "sleep 1.5; echo long-done; exit 3"], {
			cwd: RUNS_ROOT,
			runId,
			stage: "validate",
			round: 2,
		}).catch(() => {});
		// 「新服务」只凭 operation.json：列出并找到 running 记录。
		await waitFor(() => listOperations(runId).some((o) => o.status === "running" && o.pid != null));
		const rec = listOperations(runId).find((o) => o.status === "running")!;
		expect(rec.pid).toBeGreaterThan(0);
		// 观察：等它退出并收集。
		const observed = await observeOperation(runId, rec.opId, { timeoutMs: 10_000 });
		expect(observed.code).toBe(3);
		expect(observed.stdout).toContain("long-done");
		expect(observed.pidAlive).toBe(false);
		const after = readOperation(runId, rec.opId);
		expect(after!.status).toBe("exited");
		expect(after!.exitCode).toBe(3);
	}, 30_000);
});
