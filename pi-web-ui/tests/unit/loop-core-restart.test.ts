import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const fixture = fileURLToPath(new URL("../fixtures/loop-core-host.ts", import.meta.url));
const quote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
async function until<T>(read: () => T | undefined, label: string, timeout = 15000): Promise<T> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
}
async function host(root: string) {
	const child = fork(fixture, [], {
		execArgv: ["--import", "tsx"],
		silent: true,
		env: {
			PATH: process.env.PATH,
			TMPDIR: process.env.TMPDIR,
			LANG: "en_US.UTF-8",
			MINI_HARNESS_RUNTIME_ROOT: path.join(root, "runs"),
			FIXTURE_WORKSPACE: path.join(root, "workspace"),
			FIXTURE_DATA: path.join(root, "data"),
			FIXTURE_TOKEN: path.basename(root),
			PI_WEB_DATA_DIR: path.join(root, "data"),
			PI_CODING_AGENT_DIR: path.join(root, "agent"),
		},
	});
	let log = "";
	child.stdout?.on("data", (chunk) => {
		log += chunk;
	});
	child.stderr?.on("data", (chunk) => {
		log += chunk;
	});
	let port: number | undefined;
	const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	child.on("message", (message: any) => {
		if (message.ready) port = message.port;
		const waiter = pending.get(message.id);
		if (waiter) {
			pending.delete(message.id);
			if (message.error) waiter.reject(new Error(message.error));
			else waiter.resolve(message.result);
		}
	});
	child.on("exit", () => {
		for (const waiter of pending.values()) waiter.reject(new Error(`Host exited: ${log}`));
		pending.clear();
	});
	await until(() => port, "host HTTP ready");
	const rpc = (action: string, args: Record<string, unknown> = {}) =>
		new Promise<any>((resolve, reject) => {
			const id = crypto.randomUUID();
			pending.set(id, { resolve, reject });
			child.send({ id, action, ...args });
		});
	const http = async (runId: string, action: string) => {
		const response = await fetch(`http://127.0.0.1:${port}/api/mini-harness/runs/${runId}/${action}`, {
			method: action === "detail" ? "GET" : "POST",
			headers: { authorization: `Bearer ${path.basename(root)}` },
		});
		return { status: response.status, body: (await response.json()) as any };
	};
	return { child, rpc, http, log: () => log };
}
async function killHost(child: ChildProcess) {
	if (child.exitCode !== null || child.signalCode) return;
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
}
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

for (const mode of [
	"complete-running",
	"complete-before-recovery",
	"consumed-then-crash",
	"review-unknown",
	"stop",
] as const) {
	it(`R01/R02/R03/C01: SIGKILL A → production B → ${mode}`, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-core-restart-"));
		for (const dir of ["workspace", "runs", "data", "agent"]) fs.mkdirSync(path.join(root, dir));
		const counter = path.join(root, "starts.jsonl");
		const barrier = path.join(root, "release");
		const nonce = crypto.randomUUID();
		// Control/outputs live outside execution workspace. Append-only startup
		// evidence is independent of Run/Operation metadata.
		const program = `
			const fs = require("node:fs"), cp = require("node:child_process");
			const child = cp.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio:"ignore"});
			fs.appendFileSync(${JSON.stringify(counter)}, JSON.stringify({pid:process.pid, child:child.pid, nonce:${JSON.stringify(nonce)}})+"\\n");
			const timer = setInterval(() => {
				if (fs.existsSync(${JSON.stringify(barrier)})) {
					clearInterval(timer); child.kill("SIGTERM");
					child.on("exit", () => { console.log("HARNESS_METRIC score=42 unit=items"); });
				}
			}, 30);
		`;
		const command = `${quote(process.execPath)} -e ${quote(program)}`;
		let a: Awaited<ReturnType<typeof host>> | undefined;
		let b: Awaited<ReturnType<typeof host>> | undefined;
		let runId: string | undefined;
		try {
			a = await host(root);
			const created = await a.rpc("start", { command, review: mode === "review-unknown" });
			runId = created.runId;
			const start = await until(() => {
				if (!fs.existsSync(counter)) return;
				try {
					return JSON.parse(fs.readFileSync(counter, "utf8").trim());
				} catch {
					return;
				}
			}, "append-only command startup");
			const original = await a.rpc("inspect", { runId });
			expect(original.operations).toHaveLength(1);
			const opId = original.operations[0].opId;
			const attemptId = original.state.attemptId;
			expect(alive(start.pid)).toBe(true);
			if (mode === "review-unknown") {
				fs.writeFileSync(barrier, "release");
				await until(
					() => (fs.existsSync(path.join(root, "data", "review-starts.jsonl")) ? true : undefined),
					"persisted reviewer request",
				);
			}
			await killHost(a.child);
			if (mode !== "review-unknown") expect(alive(start.pid)).toBe(true);
			if (mode === "complete-before-recovery") {
				fs.writeFileSync(barrier, "release");
				await until(
					() => (fs.existsSync(path.join(root, "runs", runId!, "operations", opId, "result.json")) ? true : undefined),
					"runner result before B",
				);
			}
			b = await host(root);
			const recovered = await b.http(runId!, "recover");
			expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
			expect(recovered.body).toMatchObject({
				takeover: true,
				resumeEligible: true,
				inFlightOpId: mode === "review-unknown" ? null : opId,
			});
			if (mode === "stop") {
				const resuming = b.rpc("resume", { runId });
				let stop = await b.http(runId!, "stop");
				for (let i = 0; i < 4 && !stop.body.stopConfirmedAt; i++) stop = await b.http(runId!, "stop");
				expect(stop.status, JSON.stringify(stop.body)).toBe(200);
				expect(stop.body.stopRequestedAt).toBeTruthy();
				expect(stop.body.stopConfirmedAt).toBeTruthy();
				await until(() => (!alive(start.pid) && !alive(start.child) ? true : undefined), "original process tree exit");
				await resuming;
				const duplicate = await b.http(runId!, "stop");
				expect(duplicate.body.stopConfirmedAt).toBe(stop.body.stopConfirmedAt);
				const final = await b.rpc("duplicate", { runId });
				expect(final.status).toBe("stopped");
				expect(final.history).toHaveLength(0);
				expect(final.round).toBe(1);
			} else {
				if (mode === "consumed-then-crash") {
					const observing = b.rpc("observe", { runId });
					fs.writeFileSync(barrier, "release");
					await observing;
					const consumed = await b.rpc("inspect", { runId });
					expect(consumed.state.validatedRound).toBe(1);
					expect(consumed.state.history).toHaveLength(1);
					expect(consumed.state.consumedResults[opId]).toBeTruthy();
					await killHost(b.child);
					b = await host(root);
				}
				const resuming = b.rpc("resume", { runId });
				fs.writeFileSync(barrier, "release");
				const resumed = await resuming;
				expect(resumed.state.status, JSON.stringify(resumed)).toBe(mode === "review-unknown" ? "stopped" : "done");
				const final = await b.rpc("duplicate", { runId });
				expect(final.attemptId).toBe(attemptId);
				expect(final.generation).toBeGreaterThan(original.state.generation);
				expect(final.validatedRound).toBe(1);
				expect(final.history).toHaveLength(1);
				if (mode === "review-unknown") {
					expect(final).toMatchObject({ stage: "review-error", stopReason: "reviewer-error", acceptance: null });
					expect(
						fs
							.readFileSync(path.join(root, "data", "review-starts.jsonl"), "utf8")
							.trim()
							.split("\n"),
					).toHaveLength(1);
				} else expect(final.acceptance).toBe("passed-validator-only");
				expect(final.consumedResults[opId].digest).toMatch(/^[a-f0-9]{64}$/);
				expect(final.lastEvidence).toContain("score=42");
			}
			expect(fs.readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);
			const detail = await b.http(runId!, "detail");
			fs.writeFileSync(
				path.join(root, "evidence.json"),
				JSON.stringify(
					{
						mode,
						nonce,
						oldHost: a.child.pid,
						newHost: b.child.pid,
						runId,
						opId,
						attemptId,
						recovered,
						detail,
						starts: fs.readFileSync(counter, "utf8"),
					},
					null,
					2,
				),
			);
			console.info(`restart evidence: ${root}`);
		} finally {
			// Cleanup goes through the product stop path while a host exists.
			if (b && runId) await b.http(runId, "stop").catch(() => {});
			if (a) await killHost(a.child);
			if (b) await killHost(b.child);
			// Keep isolated evidence for independent inspection; no user resources.
		}
	}, 45000);
}

// ---------------------------------------------------------------------------
// P5：恢复分类按当前 round/attempt 判断。上一轮 validator pass 但 reviewer/指标
// 门禁否决、新一轮已落盘且尚未执行时真实终止宿主 → 新服务必须接续当前轮，
// 不得把上一轮 lastVerdict=pass 当作当前轮结论（unknown），也不重放上一轮。
// ---------------------------------------------------------------------------
for (const mode of ["reviewer-block-new-round", "metric-gate-new-round"] as const) {
	it(`P5: ${mode} — 新轮落盘后首执行前 SIGKILL，恢复接续当前轮`, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-core-restart-"));
		for (const dir of ["workspace", "runs", "data", "agent"]) fs.mkdirSync(path.join(root, dir));
		const counter = path.join(root, "starts.jsonl");
		const barrier = path.join(root, "release");
		const nonce = crypto.randomUUID();
		// 两种模式都需要 validator 快速退出（exit 0）：reviewer 模式打印指标，metric 模式不打印。
		const program =
			mode === "reviewer-block-new-round"
				? `
			const fs = require("node:fs");
			fs.appendFileSync(${JSON.stringify(counter)}, JSON.stringify({pid:process.pid, nonce:${JSON.stringify(nonce)}})+"\\n");
			const timer = setInterval(() => {
				if (fs.existsSync(${JSON.stringify(barrier)})) {
					clearInterval(timer);
					console.log("HARNESS_METRIC score=42 unit=items");
					process.exit(0);
				}
			}, 20);
		`
				: `
			const fs = require("node:fs");
			fs.appendFileSync(${JSON.stringify(counter)}, JSON.stringify({pid:process.pid, nonce:${JSON.stringify(nonce)}})+"\\n");
			process.exit(0);
		`;
		const command = `${quote(process.execPath)} -e ${quote(program)}`;
		let a: Awaited<ReturnType<typeof host>> | undefined;
		let b: Awaited<ReturnType<typeof host>> | undefined;
		let runId: string | undefined;
		try {
			a = await host(root);
			const created = await a.rpc("start", {
				command,
				review: mode === "reviewer-block-new-round",
				reviewBlock: mode === "reviewer-block-new-round",
				maxRounds: 2,
				...(mode === "metric-gate-new-round"
					? { constraints: { primaryMetric: "tps", metricDirection: "maximize" } }
					: {}),
			});
			runId = created.runId;
			await until(() => (fs.existsSync(counter) ? true : undefined), "round-1 command startup");
			if (mode === "reviewer-block-new-round") {
				// 第 1 轮 validator 通过、reviewer 否决 → 第 2 轮已落盘（尚无 operation）。
				fs.writeFileSync(barrier, "release");
			}
			const stateFile = path.join(root, "runs", runId!, "state.json");
			await until(() => {
				if (!fs.existsSync(stateFile)) return;
				const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
				return st.round === 2 && st.status === "active" ? true : undefined;
			}, "round 2 persisted before first execution");
			// 新轮状态落盘后、首次执行前真实终止宿主。
			await killHost(a.child);
			b = await host(root);
			const recovered = await b.http(runId!, "recover");
			expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
			expect(recovered.body).toMatchObject({ takeover: true, resumeEligible: true, inFlightOpId: null });
			// 关键断言：按当前轮分类为 failed-retryable，而不是拿上一轮 lastVerdict=pass 判 unknown。
			expect(recovered.body.classification.unit).toBe("failed-retryable");
			const resumed = await b.rpc("resume", { runId });
			expect(resumed.state.status, JSON.stringify(resumed)).toBe("stopped");
			const final = await b.rpc("duplicate", { runId });
			expect(final.round).toBe(2);
			expect(final.stopReason).toBe(mode === "reviewer-block-new-round" ? "reviewer-block" : "metric-gate");
			expect(final.status).toBe("stopped");
			// 每个 round 各自验证一次：不重放第 1 轮，也不跳过第 2 轮。
			expect(fs.readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(2);
			expect(final.history).toHaveLength(2);
			fs.writeFileSync(
				path.join(root, "evidence.json"),
				JSON.stringify({ mode, nonce, oldHost: a.child.pid, newHost: b.child.pid, runId, recovered, final }, null, 2),
			);
			console.info(`restart evidence: ${root}`);
		} finally {
			if (b && runId) await b.http(runId, "stop").catch(() => {});
			if (a) await killHost(a.child);
			if (b) await killHost(b.child);
		}
	}, 45000);
}
