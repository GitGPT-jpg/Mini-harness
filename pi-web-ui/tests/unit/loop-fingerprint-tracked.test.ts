// @vitest-environment node
/**
 * P2：指纹纳入 build/、dist/ 等目录下的已跟踪源码。
 * 真实临时 Git 仓库：已跟踪 build/、dist/ 文件的内容（未暂存/已暂存/删除）都必须
 * 改变指纹；未跟踪产物仍排除；并通过恢复入口证明指纹变化阻断旧证据复用。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const RUNS_ROOT = mkdtempSync(join(tmpdir(), "loop-tracked-runs-"));
process.env.MINI_HARNESS_RUNTIME_ROOT = RUNS_ROOT;
const ext = await import("../../server/loop/extension.js");
const { createLoopRun, loadLoopState, recoverRun } = ext as any;

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

afterAll(() => {
	rmSync(RUNS_ROOT, { recursive: true, force: true });
});

describe("已跟踪 build/dist 源码纳入内容指纹", () => {
	it("已跟踪 build/dist 文件：修改、暂存、删除均改变指纹；未跟踪产物仍排除", async () => {
		const repo = mkdtempSync(join(tmpdir(), "loop-tracked-repo-"));
		git(repo, "init", "-q");
		git(repo, "config", "user.email", "t@example.com");
		git(repo, "config", "user.name", "t");
		mkdirSync(join(repo, "src"));
		mkdirSync(join(repo, "build"));
		mkdirSync(join(repo, "dist"));
		writeFileSync(join(repo, "src", "main.py"), "print('hi')\n");
		writeFileSync(join(repo, "build", "code.py"), "x = 1\n");
		writeFileSync(join(repo, "dist", "bundle.js"), "export const a = 1;\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "baseline");
		try {
			const sid = "fp-sess-" + Math.random().toString(36).slice(2, 8);
			const created = createLoopRun({ sessionId: sid, cwd: repo, goal: "g", validateCmd: "true" });
			const f0 = loadLoopState(created.runId).environmentFingerprint;
			expect(f0).not.toBeNull();
			const contentHashOf = (f: { contentHash: string }) => f.contentHash;

			// 1) 修改已跟踪 build/ 文件（未暂存）→ 指纹变化。
			writeFileSync(join(repo, "build", "code.py"), "x = 2\n");
			const created2 = createLoopRun({
				sessionId: "fp2-" + Math.random().toString(36).slice(2, 8),
				cwd: repo,
				goal: "g",
			});
			const f1 = loadLoopState(created2.runId).environmentFingerprint;
			expect(contentHashOf(f1)).not.toBe(contentHashOf(f0));

			// 2) 修改并暂存同路径 → 与未暂存内容区分（index 身份参与）。
			writeFileSync(join(repo, "build", "code.py"), "x = 3\n");
			git(repo, "add", "build/code.py");
			const created3 = createLoopRun({
				sessionId: "fp3-" + Math.random().toString(36).slice(2, 8),
				cwd: repo,
				goal: "g",
			});
			const f2 = loadLoopState(created3.runId).environmentFingerprint;
			expect(contentHashOf(f2)).not.toBe(contentHashOf(f1));

			// 3) 删除已跟踪 dist/ 文件（未暂存）→ 指纹变化。
			execFileSync("rm", ["-f", join(repo, "dist", "bundle.js")]);
			const created4 = createLoopRun({
				sessionId: "fp4-" + Math.random().toString(36).slice(2, 8),
				cwd: repo,
				goal: "g",
			});
			const f3 = loadLoopState(created4.runId).environmentFingerprint;
			expect(contentHashOf(f3)).not.toBe(contentHashOf(f2));

			// 4) 未跟踪的 dist/ 产物仍排除：新增未跟踪 build 产物不改变指纹。
			writeFileSync(join(repo, "dist", "untracked-artifact.js"), "generated\n");
			const created5 = createLoopRun({
				sessionId: "fp5-" + Math.random().toString(36).slice(2, 8),
				cwd: repo,
				goal: "g",
			});
			const f4 = loadLoopState(created5.runId).environmentFingerprint;
			expect(contentHashOf(f4)).toBe(contentHashOf(f3));
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("恢复入口：已跟踪 build/ 文件变化使旧证据失效（environmentChanged，拒绝复用）", async () => {
		const repo = mkdtempSync(join(tmpdir(), "loop-tracked-recover-"));
		git(repo, "init", "-q");
		git(repo, "config", "user.email", "t@example.com");
		git(repo, "config", "user.name", "t");
		mkdirSync(join(repo, "build"));
		writeFileSync(join(repo, "build", "code.py"), "x = 1\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "baseline");
		try {
			const sid = "rec-sess-" + Math.random().toString(36).slice(2, 8);
			const created = createLoopRun({ sessionId: sid, cwd: repo, goal: "g", validateCmd: "true" });
			// 修改已跟踪 build/ 文件后失联（删 lease 模拟宿主退出）。
			writeFileSync(join(repo, "build", "code.py"), "x = 2\n");
			const lease = join(RUNS_ROOT, created.runId, "lease.json");
			execFileSync("rm", ["-f", lease]);
			const rec = recoverRun(created.runId);
			expect(rec.ok).toBe(true);
			expect(rec.takeover).toBe(false);
			// 指纹变化被识别为环境变化：不盲目接管，需要先核对。
			expect(rec.blockedReason).toBeTruthy();
			expect(rec.resumeEligible).toBe(false);
			expect(loadLoopState(created.runId).status).toBe("active");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
