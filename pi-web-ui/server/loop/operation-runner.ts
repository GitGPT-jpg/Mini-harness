/**
 * Standalone runner and group anchor, deliberately no service/extension imports.
 * Single local host, macOS/Linux, storage.ts-supported filesystems only.
 * Children that escape the session/process group are outside this contract.
 *
 * runner -> detached group anchor -> command + normal descendants
 * The anchor catches TERM and stays alive to pin PGID through escalation.
 * The runner stays outside that group to persist the observed SIGKILL result.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { compareAndSwapFile, readFileOptionalSync, withRunLockSync } from "./storage.js";
import type { OpRecord } from "./operation.js";

interface Binding {
	runId: string;
	opId: string;
	nonce: string;
	host: string;
	bootId: string;
	intentDigest: string;
}

export interface EntityIdentity extends Binding {
	pid: number;
	pgid: number;
	startId: string;
	role: "runner" | "group";
}

export interface RunnerHandshake extends EntityIdentity {
	startedAt: string;
	deadline: number | null;
}

interface CommandResult extends Binding {
	code: number | null;
	signal: NodeJS.Signals | null;
	endedAt: string;
	error?: string;
}

export interface ExecutionResult extends CommandResult {
	logs: { stdout: LogIntegrity; stderr: LogIntegrity };
	/** Execution group was terminated, even if the foreground command exited 0. */
	killed: boolean;
	commandResult: CommandResult | null;
	entity: EntityIdentity | null;
	groupGone: boolean;
	timedOut: boolean;
	terminationReason: string | null;
	workerCode: number | null;
	workerSignal: NodeJS.Signals | null;
}

export interface LogIntegrity {
	sha256: string;
	bytes: number;
}

// Bounded synchronous verification: fixed memory, finite bytes and wall time.
// Larger logs fail closed rather than consuming an unverified tail.
export const MAX_OPERATION_LOG_BYTES = 256 * 1024 * 1024;
export const MAX_OPERATION_OUTPUT_BYTES = 16 * 1024 * 1024;
const LOG_HASH_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 1000;
const MAX_GROUP_MEMBERS = 4096;

/** Permit filesystem aliases above the run (e.g. macOS /var), but never an
 * operations/op directory redirected outside that canonical run. */
export function operationFile(dir: string, name: string): string {
	if (path.basename(name) !== name) throw new Error("Noncanonical operation filename");
	const run = path.dirname(path.dirname(dir));
	const canonical = path.join(fs.realpathSync(run), "operations", path.basename(dir));
	if (fs.realpathSync(dir) !== canonical) throw new Error("Noncanonical operation directory");
	const file = path.join(dir, name);
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Noncanonical operation file: ${name}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return file;
}

export function assertOperationPaths(dir: string, rec: OpRecord): void {
	for (const [field, name] of [
		["stdoutFile", "stdout.log"],
		["stderrFile", "stderr.log"],
		["exitFile", "exit.code"],
		["runnerPidFile", "runner.json"],
	] as const) {
		if (rec[field] !== path.join(dir, name)) throw new Error(`Noncanonical operation path: ${field}`);
	}
	operationFile(dir, "operation.json");
}

/** Hash the complete, stable regular file and retain a bounded tail from the
 * SAME read. Missing completed logs, links, concurrent changes and oversize
 * files are errors. No metadata-based integrity cache. */
export function inspectOperationLog(
	dir: string,
	name: "stdout.log" | "stderr.log",
	expected?: LogIntegrity,
	maxTail = 0,
	flush = false,
): LogIntegrity & { text: string; truncated: boolean } {
	if (!Number.isSafeInteger(maxTail) || maxTail < 0 || maxTail > MAX_OPERATION_OUTPUT_BYTES) {
		throw new Error("Invalid operation output budget");
	}
	if (
		expected &&
		(!Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || !/^[a-f0-9]{64}$/.test(expected.sha256))
	)
		throw new Error("Invalid operation log digest");
	const file = operationFile(dir, name);
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const before = fs.fstatSync(fd, { bigint: true });
		if (!before.isFile() || before.nlink !== 1n) throw new Error(`Invalid operation log: ${name}`);
		if (before.size > BigInt(MAX_OPERATION_LOG_BYTES)) throw new Error(`Operation log exceeds hash limit: ${name}`);
		if (expected && before.size !== BigInt(expected.bytes))
			throw new Error(`Operation log integrity mismatch: ${name}`);
		if (flush) fs.fsyncSync(fd);
		const bytes = Number(before.size);
		const tail = Buffer.alloc(Math.min(bytes, maxTail));
		const chunk = Buffer.alloc(64 * 1024);
		const hash = crypto.createHash("sha256");
		const deadline = performance.now() + LOG_HASH_TIMEOUT_MS;
		let offset = 0;
		while (offset < bytes) {
			if (performance.now() > deadline) throw new Error(`Operation log hash deadline exceeded: ${name}`);
			const length = fs.readSync(fd, chunk, 0, Math.min(chunk.length, bytes - offset), offset);
			if (!length) throw new Error(`Operation log changed during verification: ${name}`);
			hash.update(chunk.subarray(0, length));
			const from = Math.max(offset, bytes - tail.length);
			if (offset + length > from) chunk.copy(tail, from - (bytes - tail.length), from - offset, length);
			offset += length;
		}
		const after = fs.fstatSync(fd, { bigint: true });
		const current = fs.lstatSync(operationFile(dir, name), { bigint: true });
		for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const) {
			if (before[key] !== after[key] || after[key] !== current[key]) {
				throw new Error(`Operation log changed during verification: ${name}`);
			}
		}
		const sha256 = hash.digest("hex");
		if (expected && expected.sha256 !== sha256) throw new Error(`Operation log integrity mismatch: ${name}`);
		return { sha256, bytes, text: tail.toString("utf8"), truncated: bytes > tail.length };
	} finally {
		fs.closeSync(fd);
	}
}

function exec(command: string, args: string[]): string {
	const options = {
		encoding: "utf8" as const,
		timeout: PROBE_TIMEOUT_MS,
		maxBuffer: 256 * 1024,
		detached: true,
		env: { ...process.env, LC_ALL: "C" },
	};
	const result = spawnSync(command, args, options);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Process probe failed: ${command} (${result.status})`);
	return result.stdout.trim();
}

export function bootIdentity(): string {
	if (process.platform === "linux") return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	if (process.platform === "darwin") return exec("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
	throw new Error(`Durable operations unsupported on ${process.platform}`);
}

export function startIdentity(pid: number): string {
	if (process.platform === "linux") {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	}
	const result = exec("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
	if (!result) throw new Error("Process start identity unavailable");
	return result;
}

function binding(rec: OpRecord): Binding {
	if (rec.protocolVersion !== 2 || !rec.nonce || !rec.bootId || !rec.intentDigest) {
		throw new Error("Unsupported operation identity");
	}
	return {
		runId: rec.runId,
		opId: rec.opId,
		nonce: rec.nonce,
		host: rec.host,
		bootId: rec.bootId,
		intentDigest: rec.intentDigest,
	};
}

export function readFact<T extends Binding>(dir: string, name: string, rec: OpRecord): T | null {
	const text = readFileOptionalSync(operationFile(dir, name));
	if (text === null) return null;
	const fact = JSON.parse(text) as T;
	const expected = binding(rec);
	for (const key of Object.keys(expected) as (keyof Binding)[]) {
		if (fact[key] !== expected[key]) throw new Error(`Operation fact identity conflict: ${name}/${key}`);
	}
	if (name === "runner.json" || name === "entity.json") {
		const entity = fact as unknown as EntityIdentity;
		if (
			!Number.isSafeInteger(entity.pid) ||
			entity.pid <= 1 ||
			entity.pgid !== entity.pid ||
			typeof entity.startId !== "string" ||
			!entity.startId ||
			entity.role !== (name === "runner.json" ? "runner" : "group")
		) {
			throw new Error(`Invalid execution identity: ${name}`);
		}
	}
	if (name === "command-result.json" || name === "result.json") {
		const result = fact as unknown as CommandResult;
		if (
			(result.code !== null && (!Number.isSafeInteger(result.code) || result.code < 0)) ||
			(result.signal !== null && !(result.signal in os.constants.signals)) ||
			!Number.isFinite(Date.parse(result.endedAt))
		)
			throw new Error(`Invalid exit result: ${name}`);
		if (name === "result.json" && (fact as unknown as ExecutionResult).groupGone !== true) {
			throw new Error("Result lacks process-group exit evidence");
		}
		if (name === "result.json") {
			const result = fact as unknown as ExecutionResult;
			if (
				!result.logs?.stdout ||
				!result.logs?.stderr ||
				typeof result.killed !== "boolean" ||
				typeof result.timedOut !== "boolean"
			)
				throw new Error("Result lacks log integrity/termination evidence");
		}
	}
	return fact;
}

/** Immutable, serialized publication. Conflicts are errors, never last-wins. */
function publish(dir: string, name: string, value: Binding): void {
	const text = JSON.stringify(value, null, 2) + "\n";
	const result = compareAndSwapFile(operationFile(dir, name), {
		isExpected: (old) => {
			if (old === null) return true;
			if (!isDeepStrictEqual(JSON.parse(old), value)) throw new Error(`Conflicting ${name}`);
			return false;
		},
		buildNext: () => text,
	});
	if (result.error) throw new Error(result.error);
}

export function runnerArguments(role: "runner" | "group", dir: string, nonce: string): string[] {
	const file = fileURLToPath(import.meta.url);
	return [
		...(file.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []),
		file,
		"--durable-operation",
		role,
		dir,
		nonce,
	];
}

function selfIdentity(rec: OpRecord, role: EntityIdentity["role"]): EntityIdentity {
	return { ...binding(rec), pid: process.pid, pgid: process.pid, startId: startIdentity(process.pid), role };
}

export function identityMatches(entity: EntityIdentity): boolean {
	try {
		if (
			!Number.isSafeInteger(entity.pid) ||
			entity.pid <= 1 ||
			entity.pgid !== entity.pid ||
			!entity.startId ||
			!/^[a-f0-9]{64}$/.test(entity.nonce) ||
			entity.host !== os.hostname() ||
			entity.bootId !== bootIdentity()
		)
			return false;
		if (startIdentity(entity.pid) !== entity.startId) return false;
		const pgid = Number(exec("/bin/ps", ["-p", String(entity.pid), "-o", "pgid="]));
		if (pgid !== entity.pgid) return false;
		// macOS lstart has second resolution. The random nonce in the process's
		// original argv is required too; matching a recycled PID/time is insufficient.
		const argv =
			process.platform === "linux"
				? fs.readFileSync(`/proc/${entity.pid}/cmdline`, "utf8").split("\0")
				: exec("/bin/ps", ["-ww", "-p", String(entity.pid), "-o", "command="]).split(/\s+/);
		return argv.includes(entity.nonce) && argv.includes("--durable-operation") && argv.includes(entity.role);
	} catch {
		return false; // Unknown identity is never authorization.
	}
}

export function signalEntity(entity: EntityIdentity, signal: NodeJS.Signals, group: boolean): boolean {
	if (!identityMatches(entity)) return false;
	try {
		process.kill(group ? -entity.pgid : entity.pid, signal);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

/** Used for group-drain evidence only, NEVER for per-PID signalling. Zombies
 * cannot execute or fork; reaping orphan zombies belongs to the OS init process. */
export function groupMembers(pgid: number): number[] {
	if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new Error("Invalid process group");
	// BSD -g selects PGID; procps --sid selects our detached session. Filter PGID
	// again on Linux. Never enumerate the host's full process table. A group is
	// supported up to 4096 members / 256 KiB probe output / 1 second per probe.
	const selection = process.platform === "darwin" ? ["-g", String(pgid)] : ["--sid", String(pgid)];
	const options = { encoding: "utf8" as const, detached: true, timeout: PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024 };
	const probe = spawnSync("/bin/ps", [...selection, "-o", "pid=,pgid=,stat="], options);
	if (probe.error) throw probe.error;
	if (probe.status === 1 && !probe.stdout.trim() && !probe.stderr.trim()) return [];
	if (probe.status !== 0) throw new Error("Process group probe failed");
	const lines = probe.stdout.trim().split("\n");
	if (lines.length > MAX_GROUP_MEMBERS) throw new Error("Process group exceeds supported member limit");
	return lines.flatMap((line) => {
		const [pid, group, state] = line.trim().split(/\s+/);
		return Number(group) === pgid && !state?.startsWith("Z") ? [Number(pid)] : [];
	});
}

function readIntent(dir: string, nonce: string): OpRecord {
	const text = readFileOptionalSync(operationFile(dir, "operation.json"));
	if (!text) throw new Error("Operation intent missing");
	const rec = JSON.parse(text) as OpRecord;
	assertOperationPaths(dir, rec);
	if (
		rec.opId !== path.basename(dir) ||
		rec.runId !== path.basename(path.dirname(path.dirname(dir))) ||
		rec.nonce !== nonce ||
		rec.host !== os.hostname() ||
		rec.bootId !== bootIdentity()
	) {
		throw new Error("Operation intent identity mismatch");
	}
	if (operationIntentDigest(rec) !== rec.intentDigest) throw new Error("Operation intent digest mismatch");
	return rec;
}

/** Canonical authorized tuple shared with the service-facing API. */
export function operationIntentDigest(rec: OpRecord): string {
	return crypto
		.createHash("sha256")
		.update(
			JSON.stringify([
				rec.runId,
				rec.opId,
				rec.nonce,
				rec.host,
				rec.bootId,
				rec.attemptId,
				rec.stage,
				rec.round,
				rec.command,
				rec.args,
				rec.cwd,
				rec.timeoutMs,
				rec.snapshotRef,
				rec.snapshotSha,
				rec.recoverable,
				rec.retryOf,
				rec.retryReason,
			]),
		)
		.digest("hex");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runGroup(dir: string, nonce: string): Promise<void> {
	const rec = readIntent(dir, nonce);
	const identity = selfIdentity(rec, "group");
	// Anchor survives TERM until its command and normal descendants drain.
	process.on("SIGTERM", () => {});
	publish(dir, "entity.json", identity);
	const stdout = fs.openSync(operationFile(dir, "stdout.log"), "wx", 0o600);
	let stderr: number | undefined;
	let child;
	try {
		stderr = fs.openSync(operationFile(dir, "stderr.log"), "wx", 0o600);
		// Cancellation during runner/group startup must prevent command launch.
		const started = withRunLockSync(path.dirname(path.dirname(dir)), () => {
			const current = readIntent(dir, nonce);
			if (current.cancelRequestedAt) return null;
			return spawn(rec.command, rec.args, { cwd: rec.cwd, stdio: ["ignore", stdout, stderr!] });
		});
		if (!started.ok) throw new Error(started.error);
		child = started.value;
		if (!child) {
			publish(dir, "command-result.json", {
				...binding(rec),
				code: null,
				signal: null,
				endedAt: new Date().toISOString(),
				error: "Cancelled before command spawn",
			} as CommandResult);
			return;
		}
	} finally {
		fs.closeSync(stdout);
		if (stderr !== undefined) fs.closeSync(stderr);
	}
	const result = await new Promise<CommandResult>((resolve) => {
		child.once("error", (error) =>
			resolve({
				...binding(rec),
				code: null,
				signal: null,
				endedAt: new Date().toISOString(),
				error: error.message,
			}),
		);
		child.once("exit", (code, signal) =>
			resolve({
				...binding(rec),
				code,
				signal,
				endedAt: new Date().toISOString(),
			}),
		);
	});
	publish(dir, "command-result.json", result);
	// Hold group identity even when a shell exits ahead of its background jobs.
	while (groupMembers(process.pid).some((pid) => pid !== process.pid)) await sleep(250);
}

async function runRunner(dir: string, nonce: string): Promise<void> {
	const rec = readIntent(dir, nonce);
	process.on("SIGUSR1", () => {}); // Wakeup is advisory; durable request is authority.
	const identity: RunnerHandshake = {
		...selfIdentity(rec, "runner"),
		startedAt: new Date().toISOString(),
		deadline: rec.timeoutMs ? Date.now() + rec.timeoutMs : null,
	};
	// Claim once. A second invocation must not launch another group.
	const claimed = compareAndSwapFile(operationFile(dir, "runner.json"), {
		isExpected: (text) => text === null,
		buildNext: () => JSON.stringify(identity, null, 2) + "\n",
	});
	if (claimed.error) throw new Error(claimed.error);
	if (!claimed.ok) throw new Error("Operation runner already registered; replay refused");
	const worker = spawn(process.execPath, runnerArguments("group", dir, nonce), {
		detached: true,
		stdio: "inherit",
		cwd: rec.cwd,
	});
	// Poll timers keep a healthy runner alive. A fatal storage/protocol error
	// must exit nonzero instead of being kept alive forever by this child handle.
	worker.unref();
	let workerExit: { code: number | null; signal: NodeJS.Signals | null; error?: string } | undefined;
	worker.once("error", (error) => {
		workerExit = { code: null, signal: null, error: error.message };
	});
	worker.once("exit", (code, signal) => {
		workerExit = { code, signal };
	});
	let termAt: number | null = null;
	let hardSent = false;
	let timedOut = false;
	let reason: string | null = null;
	let entity: EntityIdentity | null = null;
	for (;;) {
		entity = readFact<EntityIdentity>(dir, "entity.json", rec);
		const current = readIntent(dir, nonce);
		const expired = identity.deadline !== null && Date.now() >= identity.deadline;
		if (!workerExit && entity && (current.cancelRequestedAt || expired)) {
			// Re-read durable authorization and exact entity before EVERY signal,
			// including escalation. Never query a new PID to invent old identity.
			if (termAt === null) {
				// A completed command and an empty workload leave only our anchor.
				// Let it exit naturally; a late stop must not manufacture killed.
				if (
					readFact<CommandResult>(dir, "command-result.json", rec) &&
					groupMembers(entity.pgid).every((pid) => pid === entity!.pid)
				) {
					await sleep(50);
					continue;
				}
				if (!signalEntity(entity, "SIGTERM", true)) {
					await sleep(50);
					if (!workerExit) throw new Error("Group identity lost before TERM");
				} else {
					termAt = Date.now();
					timedOut = expired && !current.cancelRequestedAt;
					reason = timedOut ? "timeout" : (current.cancelReason ?? "user-stop");
				}
			} else if (!hardSent && Date.now() - termAt >= 1000) {
				if (!signalEntity(entity, "SIGKILL", true)) {
					// Worker may have exited between the poll and identity check.
					await sleep(50);
					if (!workerExit) throw new Error("Group identity lost before KILL");
				} else hardSent = true;
			}
		}
		if (workerExit) break;
		await sleep(250);
	}
	// Missing group registration after worker death is uncertain, not success.
	if (!entity) throw new Error("Worker exited before durable identity registration");
	const drainDeadline = Date.now() + 2000;
	while (groupMembers(entity.pgid).length > 0) {
		if (Date.now() >= drainDeadline) throw new Error("Process group exit unconfirmed");
		await sleep(50);
	}
	const commandResult = readFact<CommandResult>(dir, "command-result.json", rec);
	const stdout = inspectOperationLog(dir, "stdout.log", undefined, 0, true);
	const stderr = inspectOperationLog(dir, "stderr.log", undefined, 0, true);
	const result: ExecutionResult = {
		...binding(rec),
		entity,
		groupGone: true,
		commandResult,
		logs: {
			stdout: { sha256: stdout.sha256, bytes: stdout.bytes },
			stderr: { sha256: stderr.sha256, bytes: stderr.bytes },
		},
		killed: termAt !== null || !!commandResult?.signal || !!workerExit.signal,
		code: commandResult?.code ?? null,
		signal: commandResult?.signal ?? workerExit.signal,
		endedAt: new Date().toISOString(),
		timedOut,
		terminationReason: reason,
		workerCode: workerExit.code,
		workerSignal: workerExit.signal,
		...(commandResult?.error || workerExit.error
			? { error: commandResult?.error ?? workerExit.error }
			: !commandResult && !workerExit.signal
				? { error: "Command result missing" }
				: {}),
	};
	// Preserve natural command result even if cancellation arrived during drain.
	if (commandResult) result.signal = commandResult.signal;
	// Compatibility projection first; result.json is the authoritative commit.
	if (result.code !== null) {
		const exit = compareAndSwapFile(operationFile(dir, "exit.code"), {
			isExpected: (old) => {
				if (old !== null && old.trim() !== String(result.code)) throw new Error("Conflicting exit.code");
				return old === null;
			},
			buildNext: () => `${result.code}\n`,
		});
		if (exit.error) throw new Error(exit.error);
	}
	publish(dir, "result.json", result);
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
	process.argv[2] === "--durable-operation"
) {
	const [, , , role, dir, nonce] = process.argv;
	try {
		if (role === "runner") await runRunner(dir, nonce);
		else if (role === "group") await runGroup(dir, nonce);
		else throw new Error("Invalid runner role");
	} catch (error) {
		// Fatal/storage failures are visible in runner.log and a nonzero exit.
		// Never synthesize a successful result after an uncertain failure.
		console.error(error);
		process.exitCode = 1;
	}
}
