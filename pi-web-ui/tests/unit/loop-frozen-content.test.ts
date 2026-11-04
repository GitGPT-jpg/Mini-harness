// @vitest-environment node
/**
 * P1/P2：验收、评审与提交使用同一份冻结内容；收下后协调 Git index。
 * 真实 Git 仓库 + worktree：validator 用确定性 mock（记录它实际读到的文件内容，
 * 并可受控地在验证期间把工作树从 A 改成 B），内容身份与提交走真实冻结快照。
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const RUNS_ROOT = mkdtempSync(join(tmpdir(), "loop-frozen-runs-"));
process.env.MINI_HARNESS_RUNTIME_ROOT = RUNS_ROOT;
const ext = await import("../../server/loop/extension.js");
const { createLoopExtension, createLoopRun, loadLoopState, setLoopExecForTest, finalizeVerifiedCommit } = ext as any;

let validatorCode = 0;
let driftOnValidate = false;
let readLog: string;

function harness(sessionId: string, workspace: string) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => any>>();
	const pi: any = {
		registerTool: (t: any) => tools.set(t.name, t),
		on: (ev: string, fn: any) => {
			if (!handlers.has(ev)) handlers.set(ev, []);
			handlers.get(ev)!.push(fn);
		},
		exec: async (cmd: string, args: string[], opts?: { cwd?: string }) => {
			return { code: validatorCode, stdout: "ok", stderr: "" };
		},
		sendUserMessage: () => {},
	};
	setLoopExecForTest(async (cmd: string, args: string[], opts?: { cwd?: string }) => {
		// 记录 validator 实际读到的目标文件内容（真实执行 cwd = 运行绑定的工作树）。
		const execCwd = opts?.cwd || workspace;
		const target = join(execCwd, "a.py");
		const before = readFileSync(target, "utf8");
		writeFileSync(readLog, JSON.stringify({ content: before }) + "\n");
		if (driftOnValidate) writeFileSync(target, "B\n"); // 验证窗口内工作树 A → B
		const r = await pi.exec(cmd, args, opts);
		return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? null, killed: false };
	});
	createLoopExtension()(pi);
	const ctx = {
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry: {
			find: () => undefined,
			getAll: () => [],
			getAvailable: () => [],
			complete: async () => ({ content: [] }),
		},
		model: { provider: "fixture", id: "deepseek-main" },
		cwd: workspace,
		ui: { notify: () => {} },
	};
	return { tools, handlers, ctx };
}

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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

function makeRepo(name: string): string {
	const repo = mkdtempSync(join(tmpdir(), name));
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "t@example.com");
	git(repo, "config", "user.name", "t");
	writeFileSync(join(repo, "a.py"), "A\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "baseline");
	return repo;
}

/** 影子 index 构建「已验证树」（与 workspace-snapshot 同口径：只读工作树内容）。 */
function shadowTree(repo: string): string {
	const gitDir = git(repo, "rev-parse", "--absolute-git-dir");
	const tmp = join(gitDir, "tmp-idx-" + Math.random().toString(36).slice(2, 8));
	try {
		execFileSync("git", ["-C", repo, "read-tree", "--empty"], { env: { GIT_INDEX_FILE: tmp } });
		execFileSync("git", ["-C", repo, "add", "-A", "--", "."], { env: { GIT_INDEX_FILE: tmp } });
		return execFileSync("git", ["-C", repo, "write-tree"], { env: { GIT_INDEX_FILE: tmp }, encoding: "utf8" }).trim();
	} finally {
		rmSync(tmp, { force: true });
	}
}

afterAll(() => {
	rmSync(RUNS_ROOT, { recursive: true, force: true });
});

describe("冻结内容：validator/reviewer/提交同一棵树", () => {
	it("验证期间 A→B：不判完成、不产生提交，旧 pass 不落到新内容（漂移阻断）", async () => {
		const repo = makeRepo("loop-frozen-drift-");
		try {
			const sid = "fz-drift-" + Math.random().toString(36).slice(2, 8);
			const h = harness(sid, repo);
			validatorCode = 0;
			driftOnValidate = true;
			readLog = join(repo, "validator-read.jsonl");
			const created = createLoopRun({ sessionId: sid, cwd: repo, goal: "g", validateCmd: "true", worktree: true });
			const st0 = loadLoopState(created.runId);
			await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
			await h.handlers.get("agent_end")![0](undefined, h.ctx);
			const st = loadLoopState(created.runId);
			expect(st.status).toBe("active"); // 漂移：不判完成
			expect(st.round).toBe(2);
			expect(journalEvents(created.runId)).toContain("workspace-changed-during-validation");
			// 没有产生任何提交：分支 tip 树保持基线内容。
			const branch = st0.worktreeBranch!;
			const tip = git(st0.worktreeDir!, "rev-parse", `refs/heads/${branch}^{tree}`);
			const baseline = git(repo, "rev-parse", "HEAD^{tree}");
			expect(tip).toBe(baseline);
			// validator 实际读到的内容已被记录（A 内容），从未把 B 的证据落到提交。
			expect(JSON.parse(readFileSync(readLog, "utf8").trim()).content).toBe("A\n");
		} finally {
			driftOnValidate = false;
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("稳定快照：完成并提交，提交树内容 == validator 实际读到的内容", async () => {
		const repo = makeRepo("loop-frozen-ok-");
		try {
			const sid = "fz-ok-" + Math.random().toString(36).slice(2, 8);
			const h = harness(sid, repo);
			validatorCode = 0;
			driftOnValidate = false;
			readLog = join(repo, "validator-read.jsonl");
			// 先改内容再验证：验证的就是 B，提交的也必须是 B。
			writeFileSync(join(repo, "a.py"), "B\n");
			const created = createLoopRun({ sessionId: sid, cwd: repo, goal: "g", validateCmd: "true", worktree: true });
			const st0 = loadLoopState(created.runId);
			await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
			await h.handlers.get("agent_end")![0](undefined, h.ctx);
			const st = loadLoopState(created.runId);
			expect(st.status).toBe("done");
			expect(st.worktreeCommitted).toBe(true);
			// 提交树中的 a.py blob 必须等于 validator 读到的内容。
			const readContent = JSON.parse(readFileSync(readLog, "utf8").trim()).content;
			const committedBlob = git(st0.worktreeDir!, "rev-parse", `refs/heads/${st0.worktreeBranch}:a.py`);
			const blobOf = (content: string) =>
				execFileSync("git", ["hash-object", "--stdin"], { input: content, encoding: "utf8" }).trim();
			expect(committedBlob).toBe(blobOf(readContent));
			// 收下后 index 无残留反向差异。
			expect(git(st0.worktreeDir!, "diff", "--cached", "--name-only")).toBe("");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("git 工作区冻结快照失败：明确受阻，不落入不可检测的验收", async () => {
		const repo = makeRepo("loop-frozen-blocked-");
		try {
			const sid = "fz-block-" + Math.random().toString(36).slice(2, 8);
			const h = harness(sid, repo);
			validatorCode = 0;
			readLog = join(repo, "validator-read.jsonl");
			const created = createLoopRun({ sessionId: sid, cwd: repo, goal: "g", validateCmd: "true" });
			// 让 git 无法写临时 index → 冻结快照失败。
			const gitDir = git(repo, "rev-parse", "--absolute-git-dir");
			chmodSync(gitDir, 0o555);
			try {
				await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
				await h.handlers.get("agent_end")![0](undefined, h.ctx);
			} finally {
				chmodSync(gitDir, 0o755);
			}
			const st = loadLoopState(created.runId);
			expect(st.status).toBe("stopped");
			expect(st.stopReason).toBe("runtime-error");
			expect(journalEvents(created.runId)).toContain("runtime-error");
			expect(st.acceptance).toBeNull();
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("收下后协调 Git index（P2）", () => {
	it("干净暂存区：提交已验证树后 index 无残留，后续提交不撤销", () => {
		const repo = makeRepo("loop-finalize-clean-");
		try {
			const base = git(repo, "rev-parse", "HEAD");
			const branch = git(repo, "symbolic-ref", "--short", "HEAD");
			writeFileSync(join(repo, "a.py"), "NEW\n");
			const tree = shadowTree(repo);
			const r = finalizeVerifiedCommit(repo, branch, base, tree, "accept");
			expect(r.ok).toBe(true);
			expect(git(repo, "rev-parse", "HEAD^{tree}")).toBe(tree);
			expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
			// 后续提交不撤销刚收下的内容。
			writeFileSync(join(repo, "b.txt"), "follow-up\n");
			git(repo, "add", "b.txt");
			git(repo, "commit", "-qm", "follow-up");
			expect(git(repo, "rev-parse", "HEAD:a.py")).toBe(git(repo, "hash-object", "a.py").trim());
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("已有用户 staged 改动：保留用户暂存，收下内容不进入反向差异", () => {
		const repo = makeRepo("loop-finalize-staged-");
		try {
			const base = git(repo, "rev-parse", "HEAD");
			const branch = git(repo, "symbolic-ref", "--short", "HEAD");
			writeFileSync(join(repo, "a.py"), "NEW\n");
			const tree = shadowTree(repo);
			// 用户独立 staged 的文件（不在收下树里）。
			writeFileSync(join(repo, "extra.txt"), "user-staged\n");
			git(repo, "add", "extra.txt");
			const r = finalizeVerifiedCommit(repo, branch, base, tree, "accept");
			expect(r.ok).toBe(true);
			expect(git(repo, "rev-parse", "HEAD^{tree}")).toBe(tree);
			// 只保留用户额外 staged。
			expect(git(repo, "diff", "--cached", "--name-only")).toBe("extra.txt");
			expect(git(repo, "diff", "--cached", "--name-only", "--", "a.py")).toBe("");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("同路径 staged 与收下内容冲突：更新引用前拒绝，分支与 index 均不变", () => {
		const repo = makeRepo("loop-finalize-conflict-");
		try {
			const base = git(repo, "rev-parse", "HEAD");
			const branch = git(repo, "symbolic-ref", "--short", "HEAD");
			// 收下树里 a.py 是 NEW。
			writeFileSync(join(repo, "a.py"), "NEW\n");
			const tree = shadowTree(repo);
			// 用户 staged 了同路径的不同内容。
			writeFileSync(join(repo, "a.py"), "USER-OWN\n");
			git(repo, "add", "a.py");
			const r = finalizeVerifiedCommit(repo, branch, base, tree, "accept");
			expect(r.ok).toBe(false);
			expect((r as { error: string }).error).toContain("冲突");
			expect(git(repo, "rev-parse", "HEAD")).toBe(base); // 引用未推进
			expect(git(repo, "diff", "--cached", "--name-only")).toBe("a.py"); // 用户暂存未动
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("引用并发推进：明确拒绝；同内容幂等重入只做 index 协调", () => {
		const repo = makeRepo("loop-finalize-race-");
		try {
			const base = git(repo, "rev-parse", "HEAD");
			const branch = git(repo, "symbolic-ref", "--short", "HEAD");
			writeFileSync(join(repo, "a.py"), "NEW\n");
			const tree = shadowTree(repo);
			// 并发推进：他人先提交了一个不同内容。
			writeFileSync(join(repo, "other.txt"), "other\n");
			git(repo, "add", "-A");
			git(repo, "commit", "-qm", "concurrent");
			const raced = finalizeVerifiedCommit(repo, branch, base, tree, "accept");
			expect(raced.ok).toBe(false);
			expect((raced as { error: string }).error).toContain("并发推进");
			// 幂等重入：先把分支推进到与 tree 相同内容（模拟上次 update-ref 已成功），再调用应只做 index 协调。
			const commit = git(repo, "commit-tree", tree, "-p", base, "-m", "accept");
			git(repo, "update-ref", `refs/heads/${branch}`, commit);
			git(repo, "read-tree", base); // 故意让 index 停在旧 HEAD（分支保持 commit）
			const again = finalizeVerifiedCommit(repo, branch, commit, tree, "accept");
			expect(again.ok).toBe(true);
			expect(again.commit).toBeNull();
			expect(git(repo, "rev-parse", "HEAD")).toBe(commit);
			expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
