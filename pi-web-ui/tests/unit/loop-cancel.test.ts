/**
 * Task 1 真实子进程取消测试：停止要作用于实际执行，而不是只改 state.json。
 *  - runCommand 用 detached 进程组，abort 时 SIGTERM/SIGKILL 整个进程组（含孙进程）。
 *  - 端到端：validator（真实 sleep 进程）运行中调用 stopRunExternal → 子进程退出、
 *    状态保持 stopped、stopConfirmedAt 已记录、不会推进下一轮。
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../server/loop/run-command.js";

// extension.ts 在模块加载时读取 MINI_HARNESS_RUNTIME_ROOT 计算 ROOT（模块级 const），
// 必须在 import extension 之前指到临时目录，避免污染真实 ~/.mini-harness/runs。
process.env.MINI_HARNESS_RUNTIME_ROOT = mkdtempSync(join(tmpdir(), "loop-cancel-runs-"));

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(cond: () => boolean, ms = 5000, label = "condition"): Promise<void> {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) throw new Error("waitFor timeout: " + label);
		await new Promise((r) => setTimeout(r, 20));
	}
}

describe("runCommand：进程组取消", () => {
	it("abort 杀掉整个进程组（含孙进程）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "loop-cancel-grp-"));
		const pidfile = join(dir, "main.pid");
		const childpidfile = join(dir, "child.pid");
		const ac = new AbortController();
		const cmd = "bash";
		const script = "sleep 300 & echo $! > " + childpidfile + "; echo $$ > " + pidfile + "; wait";
		const p = runCommand(cmd, ["-lc", script], { cwd: dir, signal: ac.signal });
		await waitFor(() => existsSync(pidfile) && existsSync(childpidfile), 5000, "pidfiles appear");
		const mainPid = Number(readFileSync(pidfile, "utf8").trim());
		const childPid = Number(readFileSync(childpidfile, "utf8").trim());
		expect(mainPid).toBeGreaterThan(0);
		expect(childPid).toBeGreaterThan(0);
		expect(isAlive(mainPid)).toBe(true);
		expect(isAlive(childPid)).toBe(true);
		ac.abort();
		const res = await p;
		expect(res.killed).toBe(true);
		// 主进程与孙进程都应退出（进程组整体被杀，而非只杀直接子进程）。
		await waitFor(() => !isAlive(mainPid) && !isAlive(childPid), 5000, "group exit");
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("停止作用于实际执行（端到端）", () => {
	it("L1 validator 运行中停止 → 子进程退出、状态保持 stopped、记录 stopConfirmedAt、不推进轮次", async () => {
		const { createLoopExtension, createLoopRun, stopRunExternal, loadLoopState } = await import("../../server/loop/extension.js");
		const dir = mkdtempSync(join(tmpdir(), "loop-cancel-e2e-"));
		const pidfile = join(dir, "validator.pid");

		const tools = new Map<string, any>();
		const handlers = new Map<string, any[]>();
		const pi: any = {
			registerTool: (t: any) => tools.set(t.name, t),
			on: (ev: string, fn: any) => {
				if (!handlers.has(ev)) handlers.set(ev, []);
				handlers.get(ev)!.push(fn);
			},
			// 真实执行器：runCommand 尊重 signal，abort 时杀进程组。
			exec: async (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number; signal?: AbortSignal }) =>
				runCommand(cmd, args, { cwd: opts?.cwd ?? process.cwd(), timeout: opts?.timeout, signal: opts?.signal }),
			sendUserMessage: () => {},
		};
		createLoopExtension()(pi);

		const sid = "sess-cancel-" + Date.now();
		const created = createLoopRun({
			sessionId: sid,
			cwd: dir,
			goal: "验证停止能真正杀掉运行中的 validator",
			validateCmd: "echo $$ > " + pidfile + "; exec sleep 300",
			useReviewer: false,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const runId = created.runId;
		const ctx: any = { sessionManager: { getSessionId: () => sid }, cwd: dir };

		// 进入 run 阶段后触发 agent_end（fire-and-forget：内部会 await 真实 validator）。
		await tools.get("loop_done").execute("tc", { summary: "start validation" }, undefined, undefined, ctx);
		const pending = handlers.get("agent_end")![0]({}, ctx);
		await waitFor(() => existsSync(pidfile), 5000, "validator starts");
		const pid = Number(readFileSync(pidfile, "utf8").trim());
		expect(isAlive(pid)).toBe(true);

		// 停止：应真正取消在途 validator 子进程组。
		const stop = stopRunExternal(runId, "user-stop");
		expect(stop.ok).toBe(true);
		await waitFor(() => !isAlive(pid), 5000, "validator process exits");
		await pending;

		const st = loadLoopState(runId)!;
		expect(st.status).toBe("stopped");
		expect(st.stopReason).toBe("user-stop");
		expect(st.stopConfirmedAt).toBeTruthy();
		expect(st.round).toBe(1); // 没有进入下一轮
		rmSync(dir, { recursive: true, force: true });
	});
});
