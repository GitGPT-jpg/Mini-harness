/**
 * 恢复指纹（Prompt §4 修复③）：
 *  - 未提交改动必须进入指纹（回归：gitHead ?? "" + "|" + out 的运算符优先级把未提交 diff 丢掉，
 *    导致「改了代码但 fingerprint 认为没变」）；
 *  - 恢复核对绕过 10s 工作区签名缓存，真实重新探测磁盘。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const RUNS_ROOT = mkdtempSync(join(tmpdir(), "loop-fingerprint-"));
process.env.MINI_HARNESS_RUNTIME_ROOT = RUNS_ROOT;
const ext = await import("../../server/loop/extension.js");
const { createLoopRun, recoveryInfoOf, recoverRun, stopLeaseHeartbeat } = ext;

const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
	rmSync(RUNS_ROOT, { recursive: true, force: true });
});

let seq = 0;
const SID = () => "fingerprint-" + seq++;

function gitRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "loop-fp-repo-"));
	DIRS.push(repo);
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
	execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
	writeFileSync(join(repo, "a.txt"), "v1\n");
	execFileSync("git", ["add", "-A"], { cwd: repo });
	execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
	return repo;
}

describe("恢复指纹含未提交改动", () => {
	it("git 仓库里未提交改动必须使 environmentChanged=true（不再因优先级丢 diff）", () => {
		const repo = gitRepo();
		const sid = SID();
		const created = createLoopRun({ sessionId: sid, cwd: repo, goal: "g", validateCmd: "true", useReviewer: false });
		if (!created.ok) throw new Error(created.error);
		const runId = created.runId;
		// 干净工作区 → 指纹一致
		expect(recoveryInfoOf(runId)?.environmentChanged).toBe(false);
		// 改一个文件（未提交）→ 指纹必须变化（回归：旧代码 gitHead ?? "" + "|" + out 会把 out 丢掉）
		writeFileSync(join(repo, "a.txt"), "v2\n");
		// 列表只读投影不扫描 Git；明确恢复核对必须重新读取实际内容。
		expect(recoverRun(runId).classification?.needRecheck).toBe(true);
		expect(recoverRun(runId).resumeEligible).toBe(false);
		stopLeaseHeartbeat(runId);
	});
});
