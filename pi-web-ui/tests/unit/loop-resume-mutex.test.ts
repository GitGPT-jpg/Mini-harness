/**
 * Task 4 续跑互斥回归：
 *  resumeLoop 在 worktree 执行者分支把投递 Promise await 住之后才释放 loopResuming 锁；
 *  快速重复 resume 在第一次投递未落定前必须被互斥拒绝，不能双投递。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// agent-service 加载 extension.ts，其 run root 在模块初始化时固定，必须在 import 前指到临时目录。
const LOOP_RUNS_ROOT = mkdtempSync(join(tmpdir(), "loop-resume-runs-"));
const WORKSPACE = mkdtempSync(join(tmpdir(), "loop-resume-workspace-"));
const prev = process.env.MINI_HARNESS_RUNTIME_ROOT;
process.env.MINI_HARNESS_RUNTIME_ROOT = LOOP_RUNS_ROOT;
const { ClientSession } = await import("../../server/agent-service.js");
const { createLoopRun } = await import("../../server/loop/extension.js");
if (prev === undefined) delete process.env.MINI_HARNESS_RUNTIME_ROOT;
else process.env.MINI_HARNESS_RUNTIME_ROOT = prev;

afterAll(() => {
	rmSync(LOOP_RUNS_ROOT, { recursive: true, force: true });
	rmSync(WORKSPACE, { recursive: true, force: true });
});

describe("resumeLoop 在途互斥（Task 4）", () => {
	it("投递未落定前保持互斥；快速重复 resume 被拒绝，不双投递", async () => {
		const cs = Object.create(ClientSession.prototype) as any;
		cs.loopResuming = new Set<string>();
		cs.flushSnapshot = vi.fn();
		cs.emit = vi.fn();
		cs.emitNotice = vi.fn();
		cs.convs = new Map<string, any>();
		cs.activeId = "main";

		const execSessionId = "sess-exec-" + Date.now();
		const mainSessionId = "sess-main-" + Date.now();
		let resolveSend: (() => void) | null = null;
		const sendUserMessage = vi.fn(
			() =>
				new Promise<void>((res) => {
					resolveSend = res;
				}),
		);
		const execSession = { sessionId: execSessionId, sendUserMessage };
		const mainSession = { sessionId: mainSessionId, sendUserMessage: vi.fn() };
		const mainConv: any = { id: "main", session: mainSession, isSubagent: false };
		const execConv: any = { id: "exec", session: execSession, parentId: "main", isSubagent: true };
		cs.convs.set("main", mainConv);
		cs.convs.set("exec", execConv);

		// run 绑在 worktree 执行者会话上（sessionId = execSessionId），触发 executor 分支。
		const created = createLoopRun({
			sessionId: execSessionId,
			cwd: WORKSPACE,
			goal: "验证续跑互斥",
			validateCmd: "true",
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const runId = created.runId;

		// 第一次 resume：投递 Promise 挂起（未落定）。
		const p1 = cs.resumeLoop(runId);
		await new Promise((r) => setTimeout(r, 10));
		expect(cs.loopResuming.has(runId)).toBe(true);
		expect(sendUserMessage).toHaveBeenCalledTimes(1);

		// 快速重复 resume：互斥拒绝，绝不第二次投递。
		await cs.resumeLoop(runId);
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(cs.emitNotice).toHaveBeenCalledWith("warning", expect.stringContaining("已在续跑中"));

		// 第一次投递落定后，锁释放。
		resolveSend!();
		await p1;
		expect(cs.loopResuming.has(runId)).toBe(false);
	});
});
