// @vitest-environment node
/**
 * 链路一回归（真实默认执行器 runCommandPersistent + 真实 Git worktree，不设 loopExec 替身）：
 *  - 命令启动 / 即时消费 / 重启后消费共用同一份执行契约（修复冻结目录 op 的 cwd/validator 契约失配）。
 *  - export-ignore 与冻结目录被改写：验收内容必须等于最终收下的 Git 树。
 *  - Git 收尾受阻（index.lock）：不提前报完成，任务台拿到受阻原因，可重试收下。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const RUNS_ROOT = mkdtempSync(join(tmpdir(), "loop-exec-contract-runs-"));
process.env.MINI_HARNESS_RUNTIME_ROOT = RUNS_ROOT;
const ext = await import("../../server/loop/extension.js");
const { createLoopRun, loadLoopState, observeRunOperation, acceptRunValidatorOnly, recoverRun } = ext as any;
const op = await import("../../server/loop/operation.js");
const { collectRunDetail } = await import("../../server/loop/routes.js");
const { listOperations } = op;

const REPOS: string[] = [];
function makeRepo(name: string, files: Record<string, string> = {}): string {
	const repo = mkdtempSync(join(tmpdir(), name));
	REPOS.push(repo);
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	for (const [rel, content] of Object.entries(files)) {
		const p = join(repo, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, content);
	}
	git("add", "-A");
	git("commit", "-qm", "baseline");
	return repo;
}
const git = (repo: string, ...args: string[]) =>
	execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function loadRun(runId: string): any {
	return JSON.parse(readFileSync(join(RUNS_ROOT, runId, "state.json"), "utf8"));
}
function patchRun(runId: string, patch: Record<string, unknown>) {
	writeFileSync(join(RUNS_ROOT, runId, "state.json"), JSON.stringify({ ...loadRun(runId), ...patch }, null, 2));
}
function journalRecords(runId: string): any[] {
	try {
		return readFileSync(join(RUNS_ROOT, runId, "journal.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

let seq = 0;
const SID = () => `exec-contract-${seq++}`;

/** 扩展工厂 harness：模型/会话替身，但验证执行走真实 loopExec（runCommandPersistent）。 */
function makeHarness(sessionId: string) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => any>>();
	const notices: unknown[] = [];
	const models = [
		{ provider: "fixture", id: "deepseek-main" },
		{ provider: "fixture", id: "gpt-planner" },
		{ provider: "fixture", id: "glm-reviewer" },
	];
	const text = (v: string) => ({ content: [{ type: "text", text: v }] });
	const registry = {
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		getAll: () => models,
		getAvailable: () => models,
		complete: async (model: { id: string }) => {
			if (model.id === "gpt-planner") return text("1. 验证现有工作区");
			return text('{"verdict":"pass","reasons":["ok"]}');
		},
	};
	const pi: any = {
		registerTool: (t: any) => tools.set(t.name, t),
		on: (ev: string, fn: any) => {
			if (!handlers.has(ev)) handlers.set(ev, []);
			handlers.get(ev)!.push(fn);
		},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		sendUserMessage: (t: string) => notices.push(t),
	};
	ext.createLoopExtension()(pi);
	const ctx = {
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry: registry,
		model: models[0],
		cwd: RUNS_ROOT,
		ui: { notify: (m: string) => notices.push(m) },
	};
	return { tools, handlers, ctx, notices };
}

/** 标准链路：before_agent_start（模型准备）→ loop_done → agent_end。 */
async function runFlow(h: ReturnType<typeof makeHarness>, runId: string) {
	await h.handlers.get("before_agent_start")![0]({}, h.ctx);
	await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
	await h.handlers.get("agent_end")![0](undefined, h.ctx);
}

afterAll(() => {
	rmSync(RUNS_ROOT, { recursive: true, force: true });
	for (const repo of REPOS) rmSync(repo, { recursive: true, force: true });
});

describe("链路一：默认执行器冻结候选 → L0/L1 → 收下", () => {
	it("显式 validateCmd：冻结目录启动、即时消费同一契约，收下树 == 验收内容", async () => {
		const repo = makeRepo("exec-contract-cmd-", { "a.py": "print(42)\n" });
		const sid = SID();
		const h = makeHarness(sid);
		const created = createLoopRun({ sessionId: sid, cwd: repo, goal: "g", validateCmd: "true", worktree: true, useReviewer: false });
		if (!created.ok) throw new Error(created.error);
		// 模型在 worktree 里产出本轮候选内容（worktree 从空树起步）。
		writeFileSync(join(loadRun(created.runId).worktreeDir, "a.py"), "print(99)\n");
		await runFlow(h, created.runId);
		const st = loadRun(created.runId);
		expect(st.status).toBe("done");
		expect(st.acceptance).toBe("passed-validator-only");
		// 默认执行器：L1 恰好一个持久 operation，执行目录是冻结目录。
		const ops = listOperations(created.runId).filter((o: any) => o.stage === "validate");
		expect(ops).toHaveLength(1);
		expect(ops[0].cwd).toContain("frozen");
		expect(st.consumedResults?.[ops[0].opId]).toBeTruthy();
		// 收下的 Git 树内容 == 验收的候选内容。
		const branch = st.worktreeBranch;
		expect(git(st.worktreeDir, "rev-parse", `refs/heads/${branch}:a.py`)).toBe(
			execFileSync("git", ["hash-object", "--stdin"], { input: "print(99)\n", encoding: "utf8" }).trim(),
		);
		expect(git(st.worktreeDir, "log", "--format=%s", `refs/heads/${branch}`)).toContain(`mini-harness run ${created.runId}`);
	}, 30_000);

	it("自动发现 validate.py：冻结目录解析 validator，重启后消费同一契约只消费一次", async () => {
		const repo = makeRepo("exec-contract-discover-", { "validate.py": "import sys\nsys.exit(0)\n" });
		const sid = SID();
		const h = makeHarness(sid);
		const created = createLoopRun({ sessionId: sid, cwd: repo, goal: "g", worktree: true, useReviewer: false });
		if (!created.ok) throw new Error(created.error);
		// 模型产出 validate.py（自动发现目标）。
		writeFileSync(join(loadRun(created.runId).worktreeDir, "validate.py"), "import sys\nsys.exit(0)\n");
		await runFlow(h, created.runId);
		const st = loadRun(created.runId);
		expect(st.status).toBe("done");
		const ops = listOperations(created.runId).filter((o: any) => o.stage === "validate");
		expect(ops).toHaveLength(1);
		// 自动发现的 validator 从冻结目录解析（args 指向冻结目录里的 validate.py）。
		expect(ops[0].args[0]).toContain("frozen");
		expect(st.consumedResults?.[ops[0].opId]).toBeTruthy();
		// 模拟「L1 结果已落盘、宿主在消费前死亡」：清掉消费痕迹后按重启路径重新消费。
		patchRun(created.runId, {
			status: "active",
			stage: "validate",
			consumedResults: {},
			validatedRound: 0,
			lastVerdict: null,
			lastCode: null,
			history: [],
		});
		// 模拟重启后的持有进程：先恢复接管（本地持权），再按重启路径消费。
		const rec = recoverRun(created.runId);
		expect(rec.ok).toBe(true);
		const observed = await observeRunOperation(created.runId);
		expect(observed?.record?.opId).toBe(ops[0].opId);
		const after = loadRun(created.runId);
		expect(after.validatedRound).toBe(1);
		expect(after.consumedResults?.[ops[0].opId]).toBeTruthy();
		// 只消费一次：再观察没有未消费的 operation，也没有重跑出第二个 op。
		expect(await observeRunOperation(created.runId)).toBeNull();
		expect(listOperations(created.runId).filter((o: any) => o.stage === "validate")).toHaveLength(1);
	}, 30_000);

	it("export-ignore 不遗漏候选：验收内容 == 收下树（物化不走 archive 过滤）", async () => {
		const repo = makeRepo("exec-contract-export-", {
			"excluded.txt": "only-in-accepted-tree\n",
			".gitattributes": "excluded.txt export-ignore\n",
		});
		const sid = SID();
		const h = makeHarness(sid);
		const created = createLoopRun({
			sessionId: sid,
			cwd: repo,
			goal: "g",
			// 冻结目录必须包含 secret.txt（旧 git archive 物化会因 export-ignore 漏掉它 → 验证失败）。
			validateCmd: "test -f excluded.txt",
			worktree: true,
			useReviewer: false,
		});
		if (!created.ok) throw new Error(created.error);
		// 模型产出候选：secret.txt 与把它标记为 export-ignore 的 .gitattributes。
		writeFileSync(join(loadRun(created.runId).worktreeDir, "excluded.txt"), "only-in-accepted-tree\n");
		writeFileSync(join(loadRun(created.runId).worktreeDir, ".gitattributes"), "excluded.txt export-ignore\n");
		await runFlow(h, created.runId);
		const st = loadRun(created.runId);
		expect(st.status).toBe("done");
		// 收下的树同样包含该文件：验收内容 == 收下树。
		const branch = st.worktreeBranch;
		const blob = git(st.worktreeDir, "rev-parse", `refs/heads/${branch}:excluded.txt`);
		expect(blob).toBe(
			execFileSync("git", ["hash-object", "--stdin"], { input: "only-in-accepted-tree\n", encoding: "utf8" }).trim(),
		);
	}, 30_000);

	it("冻结目录被 validator 改写：证据失效明确受阻，不判完成、不提交", async () => {
		const repo = makeRepo("exec-contract-rewrite-", { "a.py": "print(42)\n" });
		const sid = SID();
		const h = makeHarness(sid);
		const created = createLoopRun({
			sessionId: sid,
			cwd: repo,
			goal: "g",
			// validator 改写纳入验收的源码：命令成功但验错内容必须被拦下。
			validateCmd: "echo hacked > a.py",
			worktree: true,
			useReviewer: false,
		});
		if (!created.ok) throw new Error(created.error);
		await runFlow(h, created.runId);
		const st = loadRun(created.runId);
		expect(st.status).not.toBe("done");
		expect(st.worktreeCommitted).toBe(false);
		// 受阻原因可见：journal 里保留明确的证据失效记录。
		const records = journalRecords(created.runId);
		expect(records.some((r) => String(r.error ?? "").includes("冻结执行目录已被改写"))).toBe(true);
		// 分支没有被推进（无 mini-harness 提交）。
		expect(git(st.worktreeDir, "log", "--format=%s", `refs/heads/${loadRun(created.runId).worktreeBranch}`)).not.toContain(`mini-harness run ${created.runId}`);
	}, 30_000);

	it("收尾受阻（用户 staged 与收下内容冲突）：不提前报完成、任务台可见受阻原因、清理后可重试收下", async () => {
		const repo = makeRepo("exec-contract-conflict-", { "a.py": "print(42)\n" });
		const sid = SID();
		const h = makeHarness(sid);
		const created = createLoopRun({ sessionId: sid, cwd: repo, goal: "g", validateCmd: "true", worktree: true, useReviewer: false });
		if (!created.ok) throw new Error(created.error);
		const wd = loadRun(created.runId).worktreeDir;
		writeFileSync(join(wd, "a.py"), "print(99)\n"); // 模型候选（纳入冻结树，与基线不同）
		await h.handlers.get("before_agent_start")![0]({}, h.ctx);
		await h.tools.get("loop_done")!.execute("t", { summary: "s" }, undefined, undefined, h.ctx);
		// 收尾前用户在同路径 staged 第三种版本（工作树保持候选内容）：更新引用前冲突预检必须拒绝。
		writeFileSync(join(wd, "a.py"), "print(999)\n");
		git(wd, "add", "a.py");
		writeFileSync(join(wd, "a.py"), "print(99)\n"); // 工作树回到候选内容（staged 仍是 999）
		await h.handlers.get("agent_end")![0](undefined, h.ctx);
		const st = loadRun(created.runId);
		expect(
			st.status,
			JSON.stringify({ stopReason: st.stopReason, stage: st.stage, journal: journalRecords(created.runId) }),
		).toBe("active"); // 禁止提前报完成
		expect(st.worktreeCommitted).toBe(false);
		expect(String(st.worktreeFinalizeError ?? "")).toContain("冲突");
		// 任务台详情可见受阻原因（run detail API 携带，UI 展示 runDetailFinalizeBlocked）。
		const detail = collectRunDetail(created.runId);
		expect(String(detail?.worktreeFinalizeError ?? "")).toContain("冲突");
		// 用户放弃冲突 staged 后经「按代码验证收下」重试：收下成功且不重复提交。
		git(wd, "reset", "-q", "--", "a.py"); // 放弃冲突 staged；工作树保持候选内容
		const accept = acceptRunValidatorOnly(created.runId);
		expect(accept).toEqual({ ok: true });
		const after = loadRun(created.runId);
		expect(after.status).toBe("done");
		expect(after.worktreeCommitted).toBe(true);
		expect(after.worktreeFinalizeError).toBeNull();
		expect(git(after.worktreeDir, "log", "--format=%s", `refs/heads/${after.worktreeBranch}`)).toContain(`mini-harness run ${created.runId}`);
	}, 30_000);
});
