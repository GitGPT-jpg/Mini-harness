import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoalConversation } from "../../server/goal-service.js";

// agent-service loads extension.ts, whose run root is fixed at module initialization.
const LOOP_RUNS_ROOT = mkdtempSync(join(tmpdir(), "goal-executor-loop-runs-"));
const previousLoopRunsRoot = process.env.MINI_HARNESS_RUNTIME_ROOT;
process.env.MINI_HARNESS_RUNTIME_ROOT = LOOP_RUNS_ROOT;
const { ClientSession } = await import("../../server/agent-service.js");
const { createLoopRun, loadLoopState } = await import("../../server/loop/extension.js");
if (previousLoopRunsRoot === undefined) delete process.env.MINI_HARNESS_RUNTIME_ROOT;
else process.env.MINI_HARNESS_RUNTIME_ROOT = previousLoopRunsRoot;

afterAll(() => {
	rmSync(LOOP_RUNS_ROOT, { recursive: true, force: true });
});

function makeFakeSession() {
	const sentMessages: { text: string; options?: { deliverAs?: string } }[] = [];
	const emitted: any[] = [];
	let isStreaming = false;

	const execSession = {
		get isStreaming() {
			return isStreaming;
		},
		sendUserMessage: vi.fn(async (text: string, options?: { deliverAs?: string }) => {
			sentMessages.push({ text, options });
		}),
	};

	const mainSession = {
		isStreaming: false,
		prompt: vi.fn(async () => {}),
	};

	const cs = Object.create(ClientSession.prototype) as any;
	cs.convs = new Map<string, any>();
	cs.emit = (msg: any) => emitted.push(msg);
	cs.flushSnapshot = vi.fn();
	cs.getLang = () => "zh";
	cs.slash = {
		exec: vi.fn(async (name: string, _args: string) => {
			if (name === "model" || name === "help") return true;
			return false;
		}),
	};

	const execConv = {
		id: "exec-1",
		title: "执行者",
		session: execSession,
	};
	cs.convs.set("exec-1", execConv);

	const mainConv: any = {
		id: "main-1",
		title: "主会话",
		planMode: false,
		delegateMode: false,
		session: mainSession,
		goal: {
			phase: "executing",
			round: 1,
			reviewing: true,
		},
		roleExec: {
			convId: "exec-1",
			generation: 1,
		},
	};
	cs.convs.set("main-1", mainConv);
	cs.activeId = "main-1";

	return {
		cs,
		mainConv,
		execConv,
		execSession,
		mainSession,
		sentMessages,
		emitted,
		setStreaming: (s: boolean) => {
			isStreaming = s;
		},
	};
}

describe("Goal 2.0 执行期主会话插话自动转发给执行者 (#625)", () => {
	it("当目标处于 executing 且执行者活跃时，主会话插话自动转发给执行者并发送 notice", async () => {
		const { cs, mainConv, sentMessages, emitted, setStreaming } = makeFakeSession();
		setStreaming(true);

		const handled = await (ClientSession.prototype as any).dispatchToGoalExecutor.call(
			cs,
			mainConv,
			"需要去除健康探针",
		);

		expect(handled).toBe(true);
		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0]?.text).toBe("需要去除健康探针");
		expect(sentMessages[0]?.options).toEqual({ deliverAs: "steer" });
		expect(emitted.some((m) => m.type === "notice" && m.text.includes("已同步至目标执行者"))).toBe(true);
	});

	it("非流式执行时无需 deliverAs=steer 正常发送", async () => {
		const { cs, mainConv, sentMessages, setStreaming } = makeFakeSession();
		setStreaming(false);

		const handled = await (ClientSession.prototype as any).dispatchToGoalExecutor.call(
			cs,
			mainConv,
			"请注意包含单元测试",
		);

		expect(handled).toBe(true);
		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0]?.text).toBe("请注意包含单元测试");
		expect(sentMessages[0]?.options).toBeUndefined();
	});

	it("原生斜杠命令由本地消费，不转发给执行者", async () => {
		const { cs, mainConv, sentMessages } = makeFakeSession();

		const handled = await (ClientSession.prototype as any).dispatchToGoalExecutor.call(cs, mainConv, "/model");

		expect(handled).toBe(true);
		expect(cs.slash.exec).toHaveBeenCalledWith("model", "");
		expect(sentMessages.length).toBe(0);
	});

	it("计划模式开启时优先规划，不自动转发", async () => {
		const { cs, mainConv, sentMessages } = makeFakeSession();
		mainConv.planMode = true;

		const handled = await (ClientSession.prototype as any).dispatchToGoalExecutor.call(cs, mainConv, "补充信息");

		expect(handled).toBe(false);
		expect(sentMessages.length).toBe(0);
	});

	it("目标非 executing 阶段（如 idle、reviewing）不转发，返回 false", async () => {
		const { cs, mainConv, sentMessages } = makeFakeSession();
		mainConv.goal.phase = "reviewing";

		const handled = await (ClientSession.prototype as any).dispatchToGoalExecutor.call(cs, mainConv, "补充信息");

		expect(handled).toBe(false);
		expect(sentMessages.length).toBe(0);
	});

	it("目标执行者不存在或已销毁时不转发，返回 false", async () => {
		const { cs, mainConv, sentMessages } = makeFakeSession();
		mainConv.roleExec = { convId: "exec-dead", generation: 1 };

		const handled = await (ClientSession.prototype as any).dispatchToGoalExecutor.call(cs, mainConv, "补充信息");

		expect(handled).toBe(false);
		expect(sentMessages.length).toBe(0);
	});

	it("流式执行期间若 queue=true（补充按钮），则以 deliverAs=followUp 投递", async () => {
		const { cs, mainConv, sentMessages, setStreaming } = makeFakeSession();
		setStreaming(true);

		const handled = await (ClientSession.prototype as any).dispatchToGoalExecutor.call(
			cs,
			mainConv,
			"结束本轮后再检查日志",
			true,
		);

		expect(handled).toBe(true);
		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0]?.options).toEqual({ deliverAs: "followUp" });
	});

	it("当 sendUserMessage 抛错时仍返回 true 并弹错误通知，绝不退回主会话并发起跑模型", async () => {
		const { cs, mainConv, execSession, emitted, setStreaming } = makeFakeSession();
		setStreaming(true);
		execSession.sendUserMessage.mockRejectedValueOnce(new Error("transport closed"));

		const handled = await (ClientSession.prototype as any).dispatchToGoalExecutor.call(cs, mainConv, "补充信息");

		expect(handled).toBe(true);
		expect(emitted.some((m) => m.type === "notice" && m.level === "error" && m.text.includes("同步消息失败"))).toBe(
			true,
		);
	});
});

describe("ClientSession.startLoop", () => {
	it("拒绝未知能力模板，不创建 run", async () => {
		const conv: any = { session: {} };
		const cs = Object.create(ClientSession.prototype) as any;
		cs.convs = new Map([["c1", conv]]);
		cs.activeId = "c1";
		cs.emitNotice = vi.fn();
		cs.flushSnapshot = vi.fn();

		await ClientSession.prototype.startLoop.call(cs, {
			goal: "优化吞吐",
			taskId: "unknown-pack-test",
			packId: "does-not-exist",
		});

		expect(conv.loop).toMatchObject({
			kind: "request-failed",
			taskId: "unknown-pack-test",
			goal: "优化吞吐",
			reason: "未知能力模板：does-not-exist",
		});
		expect(cs.emitNotice).toHaveBeenCalledWith("warning", "Loop 启动失败：未知能力模板 does-not-exist");
		expect(cs.flushSnapshot).toHaveBeenCalledTimes(1);
	});
});

describe("worktree Loop executor kickoff", () => {
	it("sendUserMessage 拒绝时停止 run、标记父会话失败并刷新快照", async () => {
		const created = createLoopRun({
			sessionId: "loop-parent-session",
			cwd: LOOP_RUNS_ROOT,
			goal: "run in a worktree",
		});
		if (!created.ok) throw new Error(created.error);
		const st = {
			...created.st,
			worktreeDir: join(LOOP_RUNS_ROOT, created.runId, "worktree"),
			worktreeBranch: `mini-harness/${created.runId}`,
		};

		const cs = Object.create(ClientSession.prototype) as any;
		const parent: any = { id: "parent", loop: { kind: "run", runId: created.runId } };
		const executor: any = {
			id: "executor",
			session: {
				sessionId: "loop-executor-session",
				sendUserMessage: vi.fn().mockRejectedValue(new Error("transport closed")),
			},
		};
		cs.convs = new Map([
			[parent.id, parent],
			[executor.id, executor],
		]);
		cs.spawnSubagentConversation = vi.fn(async () => executor.id);
		cs.emitNotice = vi.fn();
		cs.flushSnapshot = vi.fn();

		await (ClientSession.prototype as any).startWorktreeExecutor.call(cs, parent, st, "kick off");
		await executor.kickoff;

		expect(loadLoopState(created.runId)).toMatchObject({
			status: "stopped",
			stopReason: "worktree-executor-error",
		});
		expect(parent.loop).toMatchObject({
			kind: "request-failed",
			reason: expect.stringContaining("transport closed"),
		});
		expect(cs.emitNotice).toHaveBeenCalledWith("warning", expect.stringContaining("transport closed"));
		expect(cs.flushSnapshot).toHaveBeenCalled();
	});
});
