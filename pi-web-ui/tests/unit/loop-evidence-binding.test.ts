// @vitest-environment node
/**
 * P1：验收结果、评审与最终提交绑定同一份代码。
 * 回归场景（真实临时 Git 仓库，validator 用确定性 mock，内容身份走真实指纹）：
 *  - 恢复消费成功后改代码，再触发 agent_end：旧 pass 不得通过新版本（重新验证）；
 *  - reviewer 等待期间改代码：reviewer 旧结论不得让新版本通过；
 *  - 最终提交提交的是验收绑定的不可变树，提交后的并发改动不进入该提交；
 *  - 同一未变快照的重入不重复消费（evidenceStillValid 复用路径）。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// ROOT 在模块加载时读环境变量 —— 必须在 import 之前指到临时目录。
const RUNS_ROOT = mkdtempSync(join(tmpdir(), "loop-evidence-runs-"));
process.env.MINI_HARNESS_RUNTIME_ROOT = RUNS_ROOT;
const ext = await import("../../server/loop/extension.js");
const { createLoopExtension, createLoopRun, loadLoopState, setLoopExecForTest } = ext as any;

let validatorCode = 0;
let reviewJson = '{"verdict":"pass","reasons":["ok"]}';
let deferReview = false;
let reviewResolvers: Array<(v: string) => void> = [];
let execCalls: Array<{ cmd: string; args: string[] }> = [];

function harness(sessionId: string, workspace: string) {
	execCalls = [];
	reviewResolvers = [];
	deferReview = false;
	const tools = new Map<string, any>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => any>>();
	const models = [
		{ provider: "fixture", id: "deepseek-main" },
		{ provider: "fixture", id: "gpt-planner" },
		{ provider: "fixture", id: "glm-reviewer" },
	];
	const registry = {
		find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
		getAll: () => models,
		getAvailable: () => models,
		complete: async (model: unknown) => {
			if ((model as { id: string }).id === "glm-reviewer") {
				if (deferReview) {
					return new Promise<{ content: Array<{ type: string; text: string }> }>((res) => {
						reviewResolvers.push((v) => res({ content: [{ type: "text", text: v }] }));
					});
				}
				return { content: [{ type: "text", text: reviewJson }] };
			}
			return { content: [{ type: "text", text: "validate existing workspace" }] };
		},
	};
	const pi: any = {
		registerTool: (t: any) => tools.set(t.name, t),
		on: (ev: string, fn: any) => {
			if (!handlers.has(ev)) handlers.set(ev, []);
			handlers.get(ev)!.push(fn);
		},
		exec: async (cmd: string, args: string[], opts?: { cwd?: string }) => {
			execCalls.push({ cmd, args });
			return { code: validatorCode, stdout: "ok", stderr: "" };
		},
		sendUserMessage: () => {},
	};
	setLoopExecForTest(async (cmd: string, args: string[], opts?: { cwd?: string }) => {
		const r = await pi.exec(cmd, args, opts);
		return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? null, killed: false };
	});
	createLoopExtension()(pi);
	const ctx = {
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry: registry,
		model: models[0],
		cwd: workspace,
		ui: { notify: () => {} },
	};
	return { tools, handlers, ctx };
}

const journalEvents = (runId: string): string[] => {
	try {
		return readFileSync(join(RUNS_ROOT, runId, "journal.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l).event as string);
	} catch {
		return [];
	}
};

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	rmSync(RUNS_ROOT, { recursive: true, force: true });
});

describe("验收证据与提交绑定同一份代码", () => {
	it("恢复消费成功后改代码，再触发 agent_end：旧 pass 不能通过新版本，重新验证", async () => {
		const repo = mkdtempSync(join(tmpdir(), "loop-evidence-drift-"));
		git(repo, "init", "-q");
		git(repo, "config", "user.email", "t@example.com");
		git(repo, "config", "user.name", "t");
		writeFileSync(join(repo, "a.py"), "v1\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "baseline");
		try {
			const sid = "drift-sess-" + Math.random().toString(36).slice(2, 8);
			const h = harness(sid, repo);
			validatorCode = 0;
			deferReview = true; // 第一轮验证通过后评审挂起：run 保持 active，旧 pass 已消费
			const created = createLoopRun({
				sessionId: sid,
				cwd: repo,
				goal: "g",
				validateCmd: "true",
				reviewerModel: "fixture/glm-reviewer",
			});
			// 服务端建的 run 需先做模型准备（解析 planner/reviewer 家族）。
			await h.handlers.get("before_agent_start")![0]({}, h.ctx);
			await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
			const pending = h.handlers.get("agent_end")![0](undefined, h.ctx);
			await vi.waitFor(() => expect(reviewResolvers.length).toBe(1), { timeout: 8000 });
			const st1 = loadLoopState(created.runId);
			expect(st1.validatedRound).toBe(st1.round);
			expect(st1.lastVerdict).toBe("pass");
			// 消费成功后代码漂移。
			writeFileSync(join(repo, "a.py"), "v2-different\n");
			// 旧评审结论到达：旧 pass 不得让新版本通过。
			validatorCode = 1; // 新版本若重新验证，将失败
			reviewResolvers[0]!('{"verdict":"pass","reasons":["late"]}');
			await pending;
			const st2 = loadLoopState(created.runId);
			// reviewer 旧结论被丢弃：当前版本进入需要重新验证的状态（下一轮）。
			expect(st2.status).toBe("active");
			expect(st2.round).toBe(st1.round + 1);
			expect(st2.validatedRound).toBe(0);
			expect(journalEvents(created.runId)).toContain("workspace-changed-during-review");
			// 下一轮真正重新验证新内容：失败不沿用旧 pass。
			await h.tools.get("loop_done")!.execute("t", { summary: "s2" }, undefined, undefined, h.ctx);
			await h.handlers.get("agent_end")![0](undefined, h.ctx);
			const st3 = loadLoopState(created.runId);
			expect(st3.lastVerdict).toBe("fail");
			expect(st3.round).toBe(st2.round + 1);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("reviewer 等待期间改代码：旧结论无法让新版本通过，且不产生未核验提交", async () => {
		const repo = mkdtempSync(join(tmpdir(), "loop-evidence-review-"));
		git(repo, "init", "-q");
		git(repo, "config", "user.email", "t@example.com");
		git(repo, "config", "user.name", "t");
		writeFileSync(join(repo, "a.py"), "v1\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "baseline");
		try {
			const sid = "review-sess-" + Math.random().toString(36).slice(2, 8);
			const h = harness(sid, repo);
			validatorCode = 0;
			deferReview = true;
			const created = createLoopRun({
				sessionId: sid,
				cwd: repo,
				goal: "g",
				validateCmd: "true",
				reviewerModel: "fixture/glm-reviewer",
			});
			await h.handlers.get("before_agent_start")![0]({}, h.ctx);
			await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
			const pending = h.handlers.get("agent_end")![0](undefined, h.ctx);
			await vi.waitFor(() => expect(reviewResolvers.length).toBe(1), { timeout: 8000 });
			// reviewer 等待期间修改代码。
			writeFileSync(join(repo, "a.py"), "v2\n");
			reviewResolvers[0]!('{"verdict":"pass","reasons":["ok"]}');
			await pending;
			const st = loadLoopState(created.runId);
			expect(st.status).toBe("active"); // 不是 done：旧结论不能通过新版本
			expect(st.round).toBe(2);
			expect(journalEvents(created.runId)).toContain("workspace-changed-during-review");
			// 没有产生任何提交：漂移被拦截在 commit 之前。
			expect(() => git(repo, "rev-parse", "--verify", "HEAD^{commit}")).not.toThrow();
			expect(git(repo, "log", "--oneline").split("\n").filter(Boolean)).toHaveLength(1);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("最终提交只包含验收绑定的不可变树：提交后的并发改动不进入提交", async () => {
		const repo = mkdtempSync(join(tmpdir(), "loop-evidence-commit-"));
		git(repo, "init", "-q");
		git(repo, "config", "user.email", "t@example.com");
		git(repo, "config", "user.name", "t");
		writeFileSync(join(repo, "a.py"), "validated\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "baseline");
		try {
			const sid = "commit-sess-" + Math.random().toString(36).slice(2, 8);
			const h = harness(sid, repo);
			validatorCode = 0;
			reviewJson = '{"verdict":"pass","reasons":["ok"]}';
			const created = createLoopRun({
				sessionId: sid,
				cwd: repo,
				goal: "g",
				validateCmd: "true",
				worktree: true,
				reviewerModel: "fixture/glm-reviewer",
			});
			const st0 = loadLoopState(created.runId);
			expect(st0.worktreeDir).toBeTruthy();
			await h.handlers.get("before_agent_start")![0]({}, h.ctx);
			await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
			await h.handlers.get("agent_end")![0](undefined, h.ctx);
			const st = loadLoopState(created.runId);
			expect(st.status).toBe("done");
			expect(st.worktreeCommitted).toBe(true);
			// 提交的树必须等于验收绑定的快照树。
			const snapshotTree = git(st0.worktreeDir!, "rev-parse", st.validationIdentity.snapshotSha + "^{tree}");
			const branchTip = git(st0.worktreeDir!, "rev-parse", `refs/heads/${st.worktreeBranch}^{tree}`);
			expect(branchTip).toBe(snapshotTree);
			// 完成后的并发改动不进入已提交的树。
			writeFileSync(join(st0.worktreeDir!, "late.txt"), "after-commit\n");
			expect(git(st0.worktreeDir!, "rev-parse", `refs/heads/${st.worktreeBranch}^{tree}`)).toBe(snapshotTree);
			expect(git(st0.worktreeDir!, "ls-tree", "--name-only", `refs/heads/${st.worktreeBranch}`)).not.toContain(
				"late.txt",
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("同一未变快照：agent_end 复用既有结果，不重复消费", async () => {
		const repo = mkdtempSync(join(tmpdir(), "loop-evidence-reuse-"));
		git(repo, "init", "-q");
		git(repo, "config", "user.email", "t@example.com");
		git(repo, "config", "user.name", "t");
		writeFileSync(join(repo, "a.py"), "v1\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "baseline");
		try {
			const sid = "reuse-sess-" + Math.random().toString(36).slice(2, 8);
			const h = harness(sid, repo);
			validatorCode = 0;
			const created = createLoopRun({ sessionId: sid, cwd: repo, goal: "g", validateCmd: "true" });
			await h.tools.get("loop_validate")!.execute("t", {}, undefined, undefined, h.ctx);
			const st1 = loadLoopState(created.runId);
			expect(st1.validatedRound).toBe(st1.round);
			const historyLen = st1.history.length;
			// 未变快照：复用路径不新增消费记录。
			await h.handlers.get("agent_end")![0](undefined, h.ctx);
			const st2 = loadLoopState(created.runId);
			expect(st2.status).toBe("done");
			expect(st2.history.length).toBe(historyLen);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
