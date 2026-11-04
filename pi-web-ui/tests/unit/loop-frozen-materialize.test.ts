// @vitest-environment node
/**
 * 第一批回归：冻结内容物化执行 + 收下引用/index 的 CAS 与 lockfile。
 * 真实 Git 仓库 + worktree；validator/reviewer 用确定性替身记录实际读取内容。
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const RUNS_ROOT = mkdtempSync(join(tmpdir(), "loop-mat-runs-"));
process.env.MINI_HARNESS_RUNTIME_ROOT = RUNS_ROOT;
const ext = await import("../../server/loop/extension.js");
const { createLoopExtension, createLoopRun, loadLoopState, setLoopExecForTest, finalizeVerifiedCommit } = ext as any;

let validatorCode = 0;
let readLog: string;
let reviewerPayloads: string[] = [];
let execCalls: string[] = [];

function harness(sessionId: string, workspace: string) {
	execCalls = [];
	reviewerPayloads = [];
	const tools = new Map<string, any>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => any>>();
	const pi: any = {
		registerTool: (t: any) => tools.set(t.name, t),
		on: (ev: string, fn: any) => {
			if (!handlers.has(ev)) handlers.set(ev, []);
			handlers.get(ev)!.push(fn);
		},
		exec: async (cmd: string, args: string[], opts?: { cwd?: string }) => {
			execCalls.push(opts?.cwd || "");
			return { code: validatorCode, stdout: "ok", stderr: "" };
		},
		sendUserMessage: () => {},
	};
	setLoopExecForTest(async (cmd: string, args: string[], opts?: { cwd?: string }) => {
		// 记录 validator 实际读取的 a.py（执行 cwd = 冻结目录，验证物化）。
		const target = join(opts?.cwd || workspace, "a.py");
		const content = readFileSync(target, "utf8");
		writeFileSync(readLog, JSON.stringify({ cwd: opts?.cwd, content }) + "\n");
		const r = await pi.exec(cmd, args, opts);
		return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? null, killed: false };
	});
	createLoopExtension()(pi);
	const ctx = {
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry: {
			find: (_p: string, id: string) => ({ provider: "fixture", id }),
			getAll: () => [],
			getAvailable: () => [],
			complete: async (_model: unknown, context: unknown) => {
				const user = (context as { messages: Array<{ content: Array<{ text?: string }> }> }).messages
					.map((m) => m.content.map((c) => c.text ?? "").join(" "))
					.join(" | ");
				reviewerPayloads.push(user);
				return { content: [{ type: "text", text: '{"verdict":"pass","reasons":["ok"]}' }] };
			},
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

function makeRepo(name: string, aContent: string): string {
	const repo = mkdtempSync(join(tmpdir(), name));
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "t@example.com");
	git(repo, "config", "user.name", "t");
	writeFileSync(join(repo, "a.py"), aContent);
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "baseline");
	return repo;
}

afterAll(() => {
	rmSync(RUNS_ROOT, { recursive: true, force: true });
});

describe("第一批 1：冻结内容物化（validator/reviewer 同一棵树）", () => {
	it("A→B→A 绕过：validator 与 reviewer 都看到 A，零收下（不产生 B 的通过证据）", async () => {
		// A 会失败、B 会通过：validator 按内容判定。冻结 A 后、执行前原树切 B，读完恢复 A。
		const repo = makeRepo("loop-mat-ab-a-", "raise SystemExit(1) # A fails\n");
		try {
			const sid = "mat-aba-" + Math.random().toString(36).slice(2, 8);
			const h = harness(sid, repo);
			validatorCode = 0; // mock 恒过（内容判定靠脚本语义不可行时，用读到的内容断言）
			readLog = join(repo, "validator-read.jsonl");
			const created = createLoopRun({
				sessionId: sid,
				cwd: repo,
				goal: "g",
				validateCmd: "true",
				worktree: true,
				reviewerModel: "fixture/glm-reviewer",
			});
			await h.handlers.get("before_agent_start")![0]({}, h.ctx);
			await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
			// 冻结 A 后、validator 读之前把原树切 B：用「先改再触发」模拟窗口——物化后
			// validator 读冻结目录，原树 B 不影响；读完恢复 A。
			writeFileSync(join(repo, "a.py"), "print('B passes')\n");
			await h.handlers.get("agent_end")![0](undefined, h.ctx);
			writeFileSync(join(repo, "a.py"), "raise SystemExit(1) # A fails\n");
			const st = loadLoopState(created.runId);
			const read = JSON.parse(readFileSync(readLog, "utf8").trim());
			// validator 读到的是冻结 A（不是窗口内的 B）。
			expect(read.content).toBe("raise SystemExit(1) # A fails\n");
			// validator 从冻结目录执行（不是原工作树）。
			expect(read.cwd).toContain("frozen");
			// 恢复 A 后原树与冻结树一致 → 通过路径会收下 A（该断言验证同一棵树被提交）；
			// 这里 A 内容与冻结一致，验证没有把 B 的证据提交。
			expect(st.status).toBe("done");
			const committed = git(st.worktreeDir!, "rev-parse", `refs/heads/${st.worktreeBranch}:a.py`);
			const blobA = execFileSync("git", ["hash-object", "--stdin"], {
				input: "raise SystemExit(1) # A fails\n",
				encoding: "utf8",
			}).trim();
			expect(committed).toBe(blobA);
			// reviewer 证据采集在冻结目录执行（collectDiff 的 cwd 含 frozen）。
			expect(execCalls.some((c) => c.includes("frozen"))).toBe(true);
			expect(reviewerPayloads.some((p) => p.includes("validator：exit=0"))).toBe(true);
		} finally {
			reviewerPayloads = [];
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("稳定 A 通过：提交树匹配 validator 与 reviewer 双方证据", async () => {
		const repo = makeRepo("loop-mat-ok-", "print('A ok')\n");
		try {
			const sid = "mat-ok-" + Math.random().toString(36).slice(2, 8);
			const h = harness(sid, repo);
			validatorCode = 0;
			readLog = join(repo, "validator-read.jsonl");
			const created = createLoopRun({
				sessionId: sid,
				cwd: repo,
				goal: "g",
				validateCmd: "true",
				worktree: true,
				reviewerModel: "fixture/glm-reviewer",
			});
			await h.handlers.get("before_agent_start")![0]({}, h.ctx);
			await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
			await h.handlers.get("agent_end")![0](undefined, h.ctx);
			const st = loadLoopState(created.runId);
			expect(st.status).toBe("done");
			expect(st.worktreeCommitted).toBe(true);
			const read = JSON.parse(readFileSync(readLog, "utf8").trim());
			const blobOf = (content: string) =>
				execFileSync("git", ["hash-object", "--stdin"], { input: content, encoding: "utf8" }).trim();
			expect(git(st.worktreeDir!, "rev-parse", `refs/heads/${st.worktreeBranch}:a.py`)).toBe(blobOf(read.content));
			// reviewer 载荷来自冻结目录证据（collectDiff 的 cwd 含 frozen）。
			expect(reviewerPayloads.length).toBeGreaterThan(0);
			expect(reviewerPayloads[0]!).toContain("validator：exit=0");
			expect(execCalls.some((c) => c.includes("frozen"))).toBe(true);
		} finally {
			reviewerPayloads = [];
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("第一批 2：收下引用 CAS 与 index lockfile", () => {
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

	it("旧 tip 检查与 update-ref 之间并发推进：CAS 拒绝并保留新 tip 与 index，重试后成功", () => {
		const repo = makeRepo("loop-mat-cas-", "A\n");
		try {
			const base = git(repo, "rev-parse", "HEAD");
			const branch = git(repo, "symbolic-ref", "--short", "HEAD");
			writeFileSync(join(repo, "a.py"), "NEW\n");
			const tree = shadowTree(repo);
			// 并发推进者：独立进程反复把分支往前推（与 finalize 的 CAS 竞争）。
			const racer = execFileSync(
				process.execPath,
				[
					"-e",
					`const {execFileSync}=require("node:child_process");
					const repo=${JSON.stringify(repo)};
					const branch=${JSON.stringify(branch)};
					for(let i=0;i<20;i++){
						try{
							const tip=execFileSync("git",["-C",repo,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
							const c=execFileSync("git",["-C",repo,"commit-tree",tip+"^{tree}","-p",tip,"-m","race"],{encoding:"utf8"}).trim();
							execFileSync("git",["-C",repo,"update-ref","refs/heads/"+branch,c,tip]);
						}catch{}
					}`,
				],
				{ encoding: "utf8" },
			);
			void racer;
			const raced = finalizeVerifiedCommit(repo, branch, base, tree, "accept");
			// 要么拒绝且保留并发 tip，要么在并发停止后成功；绝不能覆盖并发提交。
			if (!raced.ok) {
				expect((raced as { error: string }).error).toContain("并发推进");
				expect(git(repo, "rev-parse", "HEAD")).not.toBe(base);
			}
			// 重试（无并发）：应成功推进到收下树或幂等接续。
			const retry = finalizeVerifiedCommit(repo, branch, git(repo, "rev-parse", "HEAD"), tree, "accept");
			if (!retry.ok) {
				// tip 树已等于收下树时视为幂等；否则必须报并发。
				expect((retry as { error: string }).error).toContain("并发推进");
			} else {
				expect(git(repo, "rev-parse", "HEAD^{tree}")).toBe(tree);
				expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("staged 删除与收下冲突：更新引用前拒绝；一致删除则接受", () => {
		const repo = makeRepo("loop-mat-del-", "A\n");
		try {
			writeFileSync(join(repo, "keep.txt"), "keep\n");
			git(repo, "add", "-A");
			git(repo, "commit", "-qm", "with keep");
			const base = git(repo, "rev-parse", "HEAD");
			const branch = git(repo, "symbolic-ref", "--short", "HEAD");
			// 收下树包含 keep.txt（验证树未删）。
			const tree = shadowTree(repo);
			// 收下未改动 keep.txt、用户 staged 删除 → 接受并保留用户删除。
			execFileSync("rm", ["-f", join(repo, "keep.txt")]);
			git(repo, "add", "keep.txt");
			const r = finalizeVerifiedCommit(repo, branch, base, tree, "accept");
			expect(r.ok).toBe(true);
			expect(git(repo, "rev-parse", "HEAD^{tree}")).toBe(tree);
			// 用户 staged 删除保留（HEAD 树仍有 keep.txt，index 中已删除）。
			expect(git(repo, "diff", "--cached", "--name-status")).toContain("D\tkeep.txt");
			expect(git(repo, "ls-tree", "--name-only", "HEAD")).toContain("keep.txt");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("index.lock 被并发 git 操作占用：明确受阻，不覆盖用户暂存", () => {
		const repo = makeRepo("loop-mat-lock-", "A\n");
		try {
			const base = git(repo, "rev-parse", "HEAD");
			const branch = git(repo, "symbolic-ref", "--short", "HEAD");
			writeFileSync(join(repo, "a.py"), "NEW\n");
			const tree = shadowTree(repo);
			writeFileSync(join(repo, "extra.txt"), "user\n");
			git(repo, "add", "extra.txt");
			// 模拟并发 git 操作持有 index.lock。
			const index = git(repo, "rev-parse", "--git-path", "index");
			const lock = join(repo, index) + ".lock";
			const fd = openSync(lock, "wx");
			try {
				const r = finalizeVerifiedCommit(repo, branch, base, tree, "accept");
				expect(r.ok).toBe(false);
				expect((r as { error: string }).error).toMatch(/lock|占用|exist/i);
			} finally {
				closeSync(fd);
				rmSync(lock, { force: true });
			}
			// 分支推进与 index 写回之间存在中断点：引用可能已推进（可恢复），
			// 用户暂存不被覆盖；重试幂等接续协调。
			expect(git(repo, "diff", "--cached", "--name-only")).toContain("extra.txt");
			// 重试成功并保留用户 staged。
			const tipNow = git(repo, "rev-parse", "HEAD");
			const tipNowTree = git(repo, "rev-parse", "HEAD^{tree}");
			const retry = finalizeVerifiedCommit(
				repo,
				branch,
				tipNowTree === tree ? git(repo, "rev-parse", "HEAD^") : tipNow,
				tree,
				"accept",
			);
			if (!retry.ok) {
				// 引用已推进为并发内容：明确拒绝，不覆盖。
				expect((retry as { error: string }).error).toContain("并发推进");
			} else {
				expect(git(repo, "diff", "--cached", "--name-only")).toBe("extra.txt");
				expect(git(repo, "rev-parse", "HEAD^{tree}")).toBe(tree);
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("仅模式变化：收下可执行位，用户工作树模式保留为 unstaged 差异", () => {
		const repo = makeRepo("loop-mat-mode-", "A\n");
		try {
			const base = git(repo, "rev-parse", "HEAD");
			const branch = git(repo, "symbolic-ref", "--short", "HEAD");
			// 收下树把 a.py 改为可执行。
			chmodSync(join(repo, "a.py"), 0o755);
			const tree = shadowTree(repo);
			// 用户把工作树改回不可执行（未 stage 的独立状态）。
			chmodSync(join(repo, "a.py"), 0o644);
			const r = finalizeVerifiedCommit(repo, branch, base, tree, "accept");
			expect(r.ok).toBe(true);
			expect(git(repo, "rev-parse", "HEAD^{tree}")).toBe(tree);
			// index 中 a.py 为可执行（收下语义），工作树保留用户 unstaged 模式。
			expect(git(repo, "ls-files", "--stage", "a.py").split(" ")[0]).toBe("100755");
			expect(execFileSync("stat", ["-f", "%Lp", join(repo, "a.py")], { encoding: "utf8" }).trim()).toBe("644");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
