import { fork, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	cancelRunOperations,
	listOperations,
	mutateOperation,
	observeOperation,
	readOperation,
	runCommandPersistent,
	terminateOpProcessTreeSync,
} from "../../server/loop/operation.js";
import {
	groupMembers,
	identityMatches,
	runnerArguments,
	signalEntity,
	inspectOperationLog,
	MAX_OPERATION_LOG_BYTES,
} from "../../server/loop/operation-runner.js";

const root = fs.mkdtempSync(path.join(process.env.OP_F3_EVIDENCE_PARENT ?? os.tmpdir(), "operation-f3-"));
process.env.MINI_HARNESS_RUNTIME_ROOT = root;
const fixture = fileURLToPath(new URL("../fixtures/operation-f3-host.ts", import.meta.url));
const hosts: ChildProcess[] = [];
const runs = new Set<string>();
const evidence: unknown[] = [];
let sequence = 0;
const runName = () => {
	const name = `f3-${++sequence}`;
	runs.add(name);
	return name;
};

async function until<T>(fn: () => T | undefined | false, timeout = 12000): Promise<T> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const result = fn();
		if (result !== undefined && result !== false) return result as T;
		if (Date.now() > deadline) throw new Error("Fixture barrier timeout");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function host(mode: string, run: string, phase = "running", env: Record<string, string> = {}) {
	const child = fork(fixture, [mode, run, phase], {
		execArgv: ["--import", "tsx"],
		env: { ...process.env, MINI_HARNESS_RUNTIME_ROOT: root, ...env },
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	hosts.push(child);
	const messages: Record<string, any>[] = [];
	let stderr = "";
	child.stderr!.on("data", (data) => {
		stderr += data;
	});
	child.on("message", (message) => {
		messages.push(message as Record<string, any>);
	});
	const message = async (key: string) =>
		until(() => {
			const found = messages.find((item) => item[key] !== undefined);
			if (!found && child.exitCode !== null) throw new Error(`Host exited ${child.exitCode}: ${stderr}`);
			return found;
		});
	return { child, message };
}

async function killHost(child: ChildProcess) {
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGKILL");
	await exited;
}

async function startAndKill(run: string, phase = "running", env: Record<string, string> = {}) {
	const a = host("start", run, phase, env);
	const barrier = await a.message("point");
	await killHost(a.child);
	const record = await until(() => {
		const rec = listOperations(run)[0];
		return rec?.entity ? rec : undefined;
	});
	evidence.push({ scenario: phase, a: barrier, operation: record });
	return record;
}

afterAll(async () => {
	// Product API cleanup is scoped to this fixture's temporary run IDs.
	for (const run of runs) {
		try {
			cancelRunOperations(run);
		} catch {
			/* Conflict tests preserve originals before cleanup. */
		}
	}
	for (const child of hosts) {
		if (child.exitCode === null && child.signalCode === null) await killHost(child);
	}
	// Retain opt-in evidence for reviewers; otherwise remove only fixture data.
	if (process.env.OP_F3_KEEP_EVIDENCE === "1") {
		fs.writeFileSync(path.join(root, "test-evidence.json"), JSON.stringify(evidence, null, 2));
		console.log(`F3 evidence: ${root}`);
	} else fs.rmSync(root, { recursive: true, force: true });
}, 30000);

describe("F3: real independent hosts and durable runner", () => {
	it.each(["runner.json", "entity.json"])(
		"result publication after a real missing %s read resolves the same operation",
		async (dependency) => {
			const run = runName();
			const originalRead = fs.readFileSync;
			let intercepted = false;
			let resultPublished = false;
			const reader = vi.spyOn(fs, "readFileSync");
			reader.mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
				try {
					return originalRead(...args);
				} catch (error) {
					const file = String(args[0]);
					if (
						!intercepted &&
						file.startsWith(path.join(root, run, "operations") + path.sep) &&
						path.basename(file) === dependency &&
						(error as NodeJS.ErrnoException).code === "ENOENT"
					) {
						intercepted = true;
						const resultFile = path.join(path.dirname(file), "result.json");
						const deadline = Date.now() + 10000;
						// Keep the actual ENOENT pending while the independent runner
						// finishes and publishes. No fabricated identity or result.
						while (!fs.existsSync(resultFile)) {
							if (Date.now() >= deadline) throw new Error("Result publication barrier timed out");
							Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
						}
						resultPublished = true;
					}
					throw error;
				}
			}) as typeof fs.readFileSync);
			try {
				const result = await runCommandPersistent(process.execPath, ["-e", "console.log('publication-complete')"], {
					runId: run,
					cwd: root,
					stage: "validate",
					round: 1,
					timeout: 15000,
				});
				expect(intercepted).toBe(true);
				expect(resultPublished).toBe(true);
				expect(result.code).toBe(0);
				expect(result.stdout).toContain("publication-complete");
				const rec = readOperation(run, result.opId)!;
				expect(rec.status).toBe("exited");
				expect(rec.runner).toBeTruthy();
				expect(rec.entity).toEqual(rec.result?.entity);
				expect(rec.result?.groupGone).toBe(true);
				const entityFile = path.join(root, run, "operations", rec.opId, "entity.json");
				const original = originalRead(entityFile, "utf8");
				fs.writeFileSync(entityFile, JSON.stringify({ ...JSON.parse(original), startId: "conflicting-start" }));
				try {
					expect(() => readOperation(run, rec.opId)).toThrow("Operation result entity conflict");
				} finally {
					fs.writeFileSync(entityFile, original);
				}
			} finally {
				reader.mockRestore();
			}
		},
		15000,
	);

	it("R01/R02: host SIGKILL, B collects same operation with one actual command start", async () => {
		const run = runName();
		const original = await startAndKill(run);
		await until(() => fs.existsSync(path.join(root, `${run}.starts`)));
		fs.writeFileSync(path.join(root, `${run}.release`), "");
		await until(() => readOperation(run, original.opId)?.result);
		const b = host("observe", run);
		const collected = await b.message("result");
		expect(collected.result.opId).toBe(original.opId);
		expect(collected.result.code).toBe(7);
		expect(collected.result.stdout).toContain("fixture-complete");
		expect(collected.result.stderr).toContain("fixture-stderr");
		expect(collected.result.record.entity).toEqual(original.entity);
		expect(
			fs
				.readFileSync(path.join(root, `${run}.starts`), "utf8")
				.trim()
				.split("\n"),
		).toHaveLength(1);
		evidence.push({ scenario: "complete", b: collected });
	}, 30000);

	it("R06: kill parent immediately after OS spawn, before any parent PID notification", async () => {
		const run = runName();
		const rec = await startAndKill(run, "after-spawn");
		const raw = JSON.parse(fs.readFileSync(path.join(root, run, "operations", rec.opId, "operation.json"), "utf8"));
		expect(raw.pid).toBeNull();
		expect(rec.runner?.nonce).toBe(rec.nonce);
		expect(rec.entity?.startId).toBeTruthy();
		fs.writeFileSync(path.join(root, `${run}.release`), "");
		const b = host("observe", run);
		expect((await b.message("result")).result.code).toBe(7);
		expect(
			fs
				.readFileSync(path.join(root, `${run}.starts`), "utf8")
				.trim()
				.split("\n"),
		).toHaveLength(1);
	}, 30000);

	it("R06: a second runner cannot replay the same registered operation", async () => {
		const run = runName();
		const rec = await startAndKill(run);
		await until(() => fs.existsSync(path.join(root, `${run}.starts`)));
		const duplicateOptions = { encoding: "utf8" as const, timeout: 10000, detached: true };
		const duplicate = spawnSync(
			process.execPath,
			runnerArguments("runner", path.join(root, run, "operations", rec.opId), rec.nonce!),
			duplicateOptions,
		);
		expect(duplicate.status).toBe(1);
		expect(duplicate.stderr).toContain("replay refused");
		expect(readOperation(run, rec.opId)?.entity).toEqual(rec.entity);
		expect(
			fs
				.readFileSync(path.join(root, `${run}.starts`), "utf8")
				.trim()
				.split("\n"),
		).toHaveLength(1);
	}, 15000);

	it("R06/C08: intent before spawn remains unknown, no replay and no stop confirmation", async () => {
		const run = runName();
		const a = host("start", run, "before-spawn");
		expect((await a.message("point")).point).toBe("before-spawn");
		await killHost(a.child);
		const rec = listOperations(run)[0];
		const observed = await observeOperation(run, rec.opId, { timeoutMs: 3000 });
		expect(observed.status).toBe("unknown");
		const cancelled = cancelRunOperations(run);
		expect(cancelled.hadActive).toBe(true);
		expect(cancelled.allConfirmed).toBe(false);
		expect(readOperation(run, rec.opId)?.cancelConfirmedAt).toBeNull();
		expect(fs.existsSync(path.join(root, `${run}.starts`))).toBe(false);
	}, 15000);

	it("C01/C02/C06/C07: B cancels original group, escalates TERM, leaves another run alive", async () => {
		const run = runName();
		const other = runName();
		const script = `
			const { spawn } = require("node:child_process");
			const fs = require("node:fs");
			process.on("SIGTERM", () => {});
			const c = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
				{ stdio: "ignore" });
			fs.writeFileSync(${JSON.stringify(path.join(root, `${run}.children`))}, JSON.stringify([process.pid,c.pid]));
			setInterval(()=>{},1000);
		`;
		const rec = await startAndKill(run, "running", { OP_FIXTURE_SCRIPT: script });
		const unaffected = await startAndKill(other);
		await until(() => fs.existsSync(path.join(root, `${run}.children`)));
		const b = host("cancel", run);
		const stopped = await b.message("result");
		expect(stopped.result.allConfirmed).toBe(true);
		const final = readOperation(run, rec.opId)!;
		expect(final.result?.workerSignal).toBe("SIGKILL");
		expect(final.status).toBe("killed");
		expect(final.cancelConfirmedAt).toBeTruthy();
		expect(groupMembers(rec.entity!.pgid)).toEqual([]);
		expect(identityMatches(unaffected.runner!)).toBe(true);
		expect(cancelRunOperations(run).allConfirmed).toBe(true);
		evidence.push({ scenario: "stop-tree", b: stopped, result: final.result });
	}, 30000);

	it("C04: cancellation request survives B SIGKILL and C confirms original exit", async () => {
		const run = runName();
		const rec = await startAndKill(run);
		const b = host("cancel-crash", run);
		expect((await b.message("point")).point).toBe("cancel-persisted");
		await killHost(b.child);
		const c = host("cancel", run);
		const result = await c.message("result");
		expect(result.result.allConfirmed).toBe(true);
		expect(readOperation(run, rec.opId)?.cancelConfirmedAt).toBeTruthy();
		evidence.push({ scenario: "cancel-restart", c: result });
	}, 30000);

	it("R07: runner timeout survives host death without a new owner", async () => {
		const run = runName();
		const rec = await startAndKill(run, "running", { OP_FIXTURE_TIMEOUT: "1800" });
		const final = await until(() => {
			const value = readOperation(run, rec.opId);
			return value?.result ? value : undefined;
		});
		expect(final.result?.timedOut).toBe(true);
		expect(final.result?.terminationReason).toBe("timeout");
		expect(final.status).toBe("killed");
		expect(final.result?.groupGone).toBe(true);
	}, 15000);

	it("R07/C08: runner itself dies, missing result stays unknown and cannot confirm cancellation", async () => {
		const run = runName();
		const rec = await startAndKill(run);
		expect(signalEntity(rec.runner!, "SIGKILL", false)).toBe(true);
		try {
			await until(() => !identityMatches(rec.runner!));
			expect((await observeOperation(run, rec.opId, { timeoutMs: 0 })).status).toBe("unknown");
			expect(cancelRunOperations(run).allConfirmed).toBe(false);
			expect(readOperation(run, rec.opId)?.result).toBeUndefined();
			expect(readOperation(run, rec.opId)?.cancelConfirmedAt).toBeNull();
		} finally {
			// Failure-fixture cleanup, deliberately NOT counted as product stop.
			signalEntity(rec.entity!, "SIGKILL", true);
			await until(() => groupMembers(rec.entity!.pgid).length === 0);
		}
	}, 15000);

	it("runner storage failure exits visibly instead of leaving a falsely live observer", async () => {
		const run = runName();
		const rec = await startAndKill(run);
		const dir = path.join(root, run, "operations", rec.opId);
		const file = path.join(dir, "operation.json");
		const intent = fs.readFileSync(file, "utf8");
		fs.unlinkSync(file);
		try {
			await until(() => !identityMatches(rec.runner!));
			expect(fs.readFileSync(path.join(dir, "runner.log"), "utf8")).toContain("Operation intent missing");
		} finally {
			fs.writeFileSync(file, intent);
			signalEntity(rec.entity!, "SIGKILL", true);
			await until(() => groupMembers(rec.entity!.pgid).length === 0);
		}
		expect(readOperation(run, rec.opId)?.status).toBe("unknown");
		expect(cancelRunOperations(run).allConfirmed).toBe(false);
	}, 15000);

	it("C03: concurrent stop callers preserve real zero exit while draining descendants", async () => {
		const run = runName();
		const script = `
			const { spawn } = require("node:child_process");
			const c = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
				{ stdio: "ignore" });
			c.unref();
			console.log("real-success-before-stop");
		`;
		const rec = await startAndKill(run, "running", { OP_FIXTURE_SCRIPT: script });
		await until(() => fs.existsSync(path.join(root, run, "operations", rec.opId, "command-result.json")));
		const b = host("cancel", run);
		const c = host("cancel", run);
		const results = await Promise.all([b.message("result"), c.message("result")]);
		expect(results.every((message) => message.result.allConfirmed)).toBe(true);
		const final = readOperation(run, rec.opId)!;
		expect(final.exitCode).toBe(0);
		expect(final.status).toBe("killed");
		expect(final.result?.killed).toBe(true);
		expect(final.result?.commandResult?.code).toBe(0);
		expect(final.result?.signal).toBeNull();
		expect(final.cancelConfirmedAt).toBeTruthy();
	}, 15000);

	it("reads are byte/mtime stable; mutation null cannot delete; storage failures surface", async () => {
		const run = runName();
		const rec = await startAndKill(run);
		const dir = path.join(root, run, "operations", rec.opId);
		const file = path.join(dir, "operation.json");
		const before = fs.readFileSync(file);
		const mtime = fs.statSync(file).mtimeMs;
		readOperation(run, rec.opId);
		listOperations(run);
		await observeOperation(run, rec.opId, { timeoutMs: 0 });
		expect(mutateOperation(run, rec.opId, () => null).ok).toBe(false);
		expect(fs.readFileSync(file)).toEqual(before);
		expect(fs.statSync(file).mtimeMs).toBe(mtime);
		process.env.MINI_HARNESS_STORAGE_TOPOLOGY = "nfs";
		try {
			expect(() => mutateOperation(run, rec.opId, (cur) => ({ ...cur, cancelReason: "x" }))).toThrow();
			await expect(
				runCommandPersistent("true", [], { cwd: root, runId: runName(), stage: "validate", round: 1 }),
			).rejects.toThrow();
		} finally {
			delete process.env.MINI_HARNESS_STORAGE_TOPOLOGY;
		}
	}, 15000);

	it("C05: missing/start/boot/host/nonce mismatch cannot send signals", async () => {
		const run = runName();
		const rec = await startAndKill(run);
		const identity = rec.entity!;
		for (const changed of [
			{ host: "another-host" },
			{ bootId: "another-boot" },
			{ startId: "reused-pid" },
			{ nonce: "0".repeat(64) },
			{ startId: "" },
			{ pid: 0 },
		]) {
			expect(signalEntity({ ...identity, ...changed }, "SIGKILL", true)).toBe(false);
			expect(identityMatches(identity)).toBe(true);
		}
		expect(terminateOpProcessTreeSync({ ...rec, nonce: "wrong" }).confirmed).toBe(false);
		expect(terminateOpProcessTreeSync({ ...rec, opId: "missing" }).confirmed).toBe(false);
	}, 15000);

	it("owner callback prevents launch/cancel; real natural result survives late cancel and conflicts reject", async () => {
		const denied = runName();
		await expect(
			runCommandPersistent("true", [], {
				cwd: root,
				runId: denied,
				stage: "validate",
				round: 1,
				canControl: () => false,
			}),
		).rejects.toThrow("owner lost");
		expect(listOperations(denied)).toEqual([]);
		const run = runName();
		const rec = await startAndKill(run);
		expect(() => cancelRunOperations(run, "denied", { canControl: () => false })).toThrow("owner lost");
		expect(readOperation(run, rec.opId)?.cancelRequestedAt).toBeNull();
		fs.writeFileSync(path.join(root, `${run}.release`), "");
		const completed = await observeOperation(run, rec.opId, { timeoutMs: 10000 });
		expect(completed.code).toBe(7);
		expect(cancelRunOperations(run).allConfirmed).toBe(true);
		expect(readOperation(run, rec.opId)?.status).toBe("exited");
		expect(mutateOperation(run, rec.opId, (cur) => ({ ...cur, cancelRequestedAt: new Date().toISOString() })).ok).toBe(
			true,
		);
		expect(readOperation(run, rec.opId)?.status).toBe("exited");
		expect(() => mutateOperation(run, rec.opId, (cur) => ({ ...cur, exitCode: 0 }))).toThrow("overwrite");
		const file = path.join(root, run, "operations", rec.opId, "result.json");
		const original = fs.readFileSync(file, "utf8");
		fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), code: 0 }));
		try {
			expect(() => readOperation(run, rec.opId)).toThrow("Conflicting");
		} finally {
			fs.writeFileSync(file, original);
		}
		const entityFile = path.join(root, run, "operations", rec.opId, "entity.json");
		const identity = fs.readFileSync(entityFile, "utf8");
		fs.unlinkSync(entityFile);
		try {
			expect(() => cancelRunOperations(run)).toThrow("entity conflict");
		} finally {
			fs.writeFileSync(entityFile, identity);
		}
	}, 20000);

	it("owner loss at the final pre-spawn check leaves intent but starts no runner", async () => {
		const run = runName();
		let checks = 0;
		await expect(
			runCommandPersistent(process.execPath, ["-e", "throw new Error('must not execute')"], {
				cwd: root,
				runId: run,
				stage: "validate",
				round: 1,
				canControl: () => ++checks < 3,
			}),
		).rejects.toThrow("owner lost");
		expect(checks).toBe(3);
		const rec = listOperations(run)[0];
		expect(rec).toBeTruthy();
		expect(rec.runner).toBeUndefined();
		expect(rec.entity).toBeUndefined();
		expect(fs.existsSync(path.join(root, run, "operations", rec.opId, "stdout.log"))).toBe(false);
	});

	it("complete stdout/stderr hashes bind the digest and the returned bounded tail", async () => {
		const run = runName();
		const result = await runCommandPersistent(
			process.execPath,
			["-e", "process.stdout.write('a'.repeat(150000)+'TAIL');process.stderr.write('error-tail')"],
			{
				runId: run,
				cwd: root,
				stage: "validate",
				round: 1,
				maxBuffer: 4,
			},
		);
		expect(result.stdout).toBe("TAIL");
		expect(result.stderr).toBe("tail");
		expect(result.stdoutTruncated).toBe(true);
		expect(result.stderrTruncated).toBe(true);
		const rec = readOperation(run, result.opId)!;
		const dir = path.join(root, run, "operations", rec.opId);
		const digest = rec.resultDigest;
		for (const name of ["stdout", "stderr"] as const) {
			const file = path.join(dir, `${name}.log`);
			const original = fs.readFileSync(file);
			expect(rec.result!.logs[name]).toEqual({
				bytes: original.length,
				sha256: crypto.createHash("sha256").update(original).digest("hex"),
			});
			// Same length, including a change outside the returned tail.
			const changed = Buffer.from(original);
			changed[0] ^= 1;
			fs.writeFileSync(file, changed);
			try {
				await expect(observeOperation(run, rec.opId, { maxBuffer: 4 })).rejects.toThrow("integrity");
			} finally {
				fs.writeFileSync(file, original);
			}
			fs.unlinkSync(file);
			try {
				await expect(observeOperation(run, rec.opId)).rejects.toThrow();
			} finally {
				fs.writeFileSync(file, original);
			}
		}
		expect(readOperation(run, rec.opId)?.resultDigest).toBe(digest);
	}, 15000);

	it("noncanonical log fields, symlinks and oversized logs fail closed", async () => {
		const run = runName();
		const result = await runCommandPersistent("true", [], { runId: run, cwd: root, stage: "validate", round: 1 });
		const dir = path.join(root, run, "operations", result.opId);
		const rec = readOperation(run, result.opId)!;
		const outside = path.join(root, "outside-log");
		fs.writeFileSync(outside, "not operation output");
		expect(() => mutateOperation(run, result.opId, (cur) => ({ ...cur, stdoutFile: outside }))).toThrow("Noncanonical");
		const recordFile = path.join(dir, "operation.json");
		const recordText = fs.readFileSync(recordFile, "utf8");
		fs.writeFileSync(recordFile, JSON.stringify({ ...JSON.parse(recordText), stdoutFile: outside }));
		try {
			expect(() => readOperation(run, result.opId)).toThrow("Noncanonical");
		} finally {
			fs.writeFileSync(recordFile, recordText);
		}
		const log = path.join(dir, "stdout.log");
		fs.unlinkSync(log);
		fs.symlinkSync(outside, log);
		try {
			expect(() => inspectOperationLog(dir, "stdout.log", rec.result!.logs.stdout)).toThrow("Noncanonical");
		} finally {
			fs.unlinkSync(log);
			fs.writeFileSync(log, "");
		}
		fs.truncateSync(log, MAX_OPERATION_LOG_BYTES + 1);
		try {
			expect(() => inspectOperationLog(dir, "stdout.log")).toThrow("hash limit");
		} finally {
			fs.truncateSync(log, 0);
		}
		expect(fs.readFileSync(outside, "utf8")).toBe("not operation output");
	}, 15000);

	it("exit 0 with live background descendants times out as killed, preserving original command code", async () => {
		const run = runName();
		const script = `
			const child = require("node:child_process").spawn(process.execPath,
				["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {stdio:"ignore"});
			child.unref();
			console.log("foreground passed");
		`;
		const result = await runCommandPersistent(process.execPath, ["-e", script], {
			runId: run,
			cwd: root,
			stage: "validate",
			round: 1,
			timeout: 1200,
		});
		expect(result.code).toBe(0);
		expect(result.killed).toBe(true);
		expect(result.timedOut).toBe(true);
		const observed = await observeOperation(run, result.opId);
		expect(observed.status).toBe("killed");
		expect(observed.killed).toBe(true);
		expect(observed.timedOut).toBe(true);
		expect(observed.record?.result?.commandResult?.code).toBe(0);
	}, 15000);

	it.each(["inside-lock", "outside-lock"])(
		"host spawn linearizes with stop: %s",
		async (phase) => {
			const run = runName();
			const a = host("start", run, phase);
			expect((await a.message("point")).point).toBe(phase);
			try {
				const b = host(phase === "inside-lock" ? "try-cancel" : "request-cancel", run);
				const attempt = (await b.message("result")).result;
				expect(attempt.ok).toBe(phase === "outside-lock");
			} finally {
				fs.writeFileSync(path.join(root, `${run}.host-release`), "");
			}
			if (phase === "outside-lock") {
				expect((await a.message("failure")).failure).toContain("cancelled before runner spawn");
				expect(listOperations(run)[0].runner).toBeUndefined();
			} else {
				await until(() => fs.existsSync(path.join(root, `${run}.starts`)));
				expect(cancelRunOperations(run).allConfirmed).toBe(true);
			}
		},
		20000,
	);

	it.each(["inside-lock", "outside-lock"])(
		"group command spawn linearizes with stop: %s",
		async (phase) => {
			const run = runName();
			const rec = await startAndKill(run, "running", { OP_F3_GROUP_BARRIER: phase });
			await until(() => fs.existsSync(path.join(root, `${run}.group-ready`)));
			try {
				const b = host(phase === "inside-lock" ? "try-cancel" : "request-cancel", run);
				const attempt = (await b.message("result")).result;
				expect(attempt.ok).toBe(phase === "outside-lock");
			} finally {
				fs.writeFileSync(path.join(root, `${run}.group-release`), "");
			}
			if (phase === "outside-lock") {
				const result = await observeOperation(run, rec.opId, { timeoutMs: 10000 });
				expect(result.record?.result?.error).toBe("Cancelled before command spawn");
				expect(fs.existsSync(path.join(root, `${run}.starts`))).toBe(false);
			} else {
				await until(() => fs.existsSync(path.join(root, `${run}.starts`)));
				expect(cancelRunOperations(run).allConfirmed).toBe(true);
			}
		},
		20000,
	);

	it("late stop with only an empty anchor preserves natural exit", async () => {
		const run = runName();
		const rec = await startAndKill(run, "running", {
			OP_F3_GROUP_BARRIER: "empty-drain",
			OP_FIXTURE_SCRIPT: "console.log('finished')",
		});
		await until(() => fs.existsSync(path.join(root, `${run}.group-ready`)));
		const b = host("cancel", run);
		try {
			await until(() => readOperation(run, rec.opId)?.cancelRequestedAt);
		} finally {
			fs.writeFileSync(path.join(root, `${run}.group-release`), "");
		}
		expect((await b.message("result")).result.allConfirmed).toBe(true);
		const final = readOperation(run, rec.opId)!;
		expect(final.status).toBe("exited");
		expect(final.result?.killed).toBe(false);
		expect(final.result?.timedOut).toBe(false);
	}, 15000);
});
