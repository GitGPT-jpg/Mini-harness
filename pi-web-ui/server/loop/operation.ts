/**
 * Durable local operations. operation.json owns intent/control metadata; the
 * standalone runner owns immutable execution facts. Reads only project facts.
 * Run owns result consumption in its single conditional commit, never here.
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compareAndSwapFile, readFileOptionalSync, withRunLockSync } from "./storage.js";
import {
	assertOperationPaths,
	bootIdentity,
	groupMembers,
	identityMatches,
	inspectOperationLog,
	MAX_OPERATION_OUTPUT_BYTES,
	operationFile,
	operationIntentDigest,
	readFact,
	runnerArguments,
	signalEntity,
	startIdentity,
	type EntityIdentity,
	type ExecutionResult,
	type RunnerHandshake,
} from "./operation-runner.js";
export { operationIntentDigest } from "./operation-runner.js";

export interface ControlOptions {
	/** Synchronous current owner/generation check; false/throw prevents control.
	 * Called inside the run lock when accepting cancellation, and before signals.
	 * An accepted cancellation is irrevocable and delegated to this op's runner,
	 * so it survives the accepting owner's death (including TERM -> KILL).
	 */
	canControl?: () => boolean;
}

export interface PersistentExecOptions extends ControlOptions {
	cwd: string;
	runId: string;
	stage: string;
	round: number;
	attemptId?: string | null;
	snapshotRef?: string | null;
	snapshotSha?: string | null;
	recoverable?: boolean;
	retryOf?: string | null;
	retryReason?: string | null;
	signal?: AbortSignal;
	timeout?: number;
	maxBuffer?: number;
	onSpawn?: (pid: number, opId: string) => void;
}

export interface PersistentExecResult {
	stdout: string;
	stderr: string;
	code: number | null;
	killed: boolean;
	timedOut: boolean;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	pid: number | null;
	opId: string;
}

export type OpStatus = "intent" | "running" | "exited" | "killed" | "error" | "unknown";
/** Legacy metadata only. Never use this field as the result-consumption gate. */
export type OpConsumptionState = "unconsumed" | "consuming" | "consumed";

export interface OpRecord {
	opId: string;
	runId: string;
	attemptId?: string | null;
	stage: string;
	round: number;
	host: string;
	pid: number | null;
	pgid: number | null;
	processStartId: string | null;
	command: string;
	args: string[];
	cwd: string;
	stdoutFile: string;
	stderrFile: string;
	exitFile: string;
	runnerPidFile: string;
	startedAt: string;
	status: OpStatus;
	exitCode: number | null;
	endedAt: string | null;
	snapshotRef?: string | null;
	snapshotSha?: string | null;
	recoverable?: boolean;
	cancelRequestedAt?: string | null;
	cancelConfirmedAt?: string | null;
	cancelReason?: string | null;
	consumptionState?: OpConsumptionState;
	consumingBy?: string | null;
	consumingAt?: string | null;
	consumedAt?: string | null;
	consumedByGeneration?: number | null;
	retryOf?: string | null;
	retryReason?: string | null;
	protocolVersion?: number;
	bootId?: string;
	nonce?: string;
	intentDigest?: string;
	timeoutMs?: number;
	runner?: EntityIdentity;
	entity?: EntityIdentity;
	result?: ExecutionResult;
	resultDigest?: string;
	blockedReason?: string;
}

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

function runsBaseDir(): string {
	return path.resolve(process.env.MINI_HARNESS_RUNTIME_ROOT || path.join(os.homedir(), ".mini-harness", "runs"));
}

function safeId(id: string): string {
	if (!/^[\w-]+$/.test(id)) throw new Error("Invalid run/operation ID");
	return id;
}

function operationsDir(runId: string, opId: string): string {
	return path.join(runsBaseDir(), safeId(runId), "operations", safeId(opId));
}

function assertControl(options: ControlOptions): void {
	if (options.canControl && options.canControl() !== true) throw new Error("Operation control denied: owner lost");
}

function readRaw(opDir: string): OpRecord | null {
	let file: string;
	try {
		file = operationFile(opDir, "operation.json");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const text = readFileOptionalSync(file);
	if (text === null) return null;
	const rec = JSON.parse(text) as OpRecord;
	if (rec.opId !== path.basename(opDir) || rec.runId !== path.basename(path.dirname(path.dirname(opDir)))) {
		throw new Error("Operation record identity mismatch");
	}
	return rec;
}

/** Reconstruct from identities captured by the runner itself, never current PID
 * attributes. No migration, lock acquisition, directory creation or writes. */
function project(opDir: string, raw: OpRecord): OpRecord {
	const rec = { ...raw };
	assertOperationPaths(opDir, rec);
	if (rec.protocolVersion !== 2) {
		return { ...rec, status: "unknown", blockedReason: "Legacy operation lacks trustworthy boot/nonce identity" };
	}
	if (!rec.nonce || rec.intentDigest !== operationIntentDigest(rec)) throw new Error("Operation intent conflict");
	let handshake = readFact<RunnerHandshake>(opDir, "runner.json", rec);
	let entity = readFact<EntityIdentity>(opDir, "entity.json", rec);
	// Check liveness BEFORE reading result. A runner may publish and exit during
	// a probe; reading result first could falsely return unknown in that window.
	const runnerAlive = handshake ? identityMatches(handshake) : false;
	const result = readFact<ExecutionResult>(opDir, "result.json", rec);
	if (result) {
		// result.json is published after its immutable dependencies. Earlier
		// ENOENT reads may predate that publication; re-read before projecting
		// or checking identities, while still rejecting changed existing facts.
		const publishedHandshake = readFact<RunnerHandshake>(opDir, "runner.json", rec);
		const publishedEntity = readFact<EntityIdentity>(opDir, "entity.json", rec);
		if (
			(handshake && !isDeepStrictEqual(handshake, publishedHandshake)) ||
			(entity && !isDeepStrictEqual(entity, publishedEntity))
		) {
			throw new Error("Operation result entity conflict");
		}
		handshake = publishedHandshake;
		entity = publishedEntity;
	}
	delete rec.runner;
	delete rec.entity;
	delete rec.result;
	delete rec.resultDigest;
	if (!result && (raw.result || raw.resultDigest)) throw new Error("Committed operation result missing");
	if (handshake) rec.runner = handshake;
	if (entity) {
		rec.entity = entity;
		rec.pid = entity.pid;
		rec.pgid = entity.pgid;
		rec.processStartId = entity.startId;
	} else if (handshake) {
		rec.pid = handshake.pid;
		rec.processStartId = handshake.startId;
	}
	if (result) {
		if (!handshake || !entity || !isDeepStrictEqual(result.entity, entity)) {
			throw new Error("Operation result entity conflict");
		}
		const commandResult = readFact<NonNullable<ExecutionResult["commandResult"]>>(opDir, "command-result.json", rec);
		if (!isDeepStrictEqual(result.commandResult, commandResult)) throw new Error("Conflicting command results");
		const digest = crypto.createHash("sha256").update(JSON.stringify(result)).digest("hex");
		if ((raw.resultDigest && raw.resultDigest !== digest) || (raw.result && !isDeepStrictEqual(raw.result, result))) {
			throw new Error("Conflicting operation results");
		}
		const legacyExit = readFileOptionalSync(operationFile(opDir, "exit.code"));
		if (legacyExit !== null && (result.code === null || legacyExit.trim() !== String(result.code))) {
			throw new Error("Conflicting exit.code and operation result");
		}
		inspectOperationLog(opDir, "stdout.log", result.logs.stdout);
		inspectOperationLog(opDir, "stderr.log", result.logs.stderr);
		rec.result = result;
		rec.resultDigest = digest;
		rec.exitCode = result.code;
		rec.endedAt = result.endedAt;
		rec.status = result.error
			? "error"
			: result.killed || result.timedOut
				? "killed"
				: result.code === null
					? "error"
					: "exited";
		if (rec.cancelRequestedAt && result.groupGone) rec.cancelConfirmedAt = result.endedAt;
	} else {
		// A missing PID/result never proves "not started" or "stopped".
		rec.status = runnerAlive
			? "running"
			: Date.now() - Date.parse(rec.startedAt) < 2000 && !handshake
				? "intent"
				: "unknown";
	}
	return rec;
}

/** null rejects a mutation. It MUST NOT reach the storage API's delete branch. */
export function mutateOperation(
	runId: string,
	opId: string,
	mutator: (cur: OpRecord) => OpRecord | null,
): { ok: boolean; record: OpRecord | null } {
	const dir = operationsDir(runId, opId);
	let updated: OpRecord | null = null;
	const result = compareAndSwapFile(path.join(dir, "operation.json"), {
		isExpected: (text) => {
			if (text === null) return false;
			const current = project(dir, JSON.parse(text) as OpRecord);
			const next = mutator(structuredClone(current));
			if (!next) return false;
			assertOperationPaths(dir, next);
			if (
				next.opId !== opId ||
				next.runId !== runId ||
				operationIntentDigest(next) !== operationIntentDigest(current)
			) {
				throw new Error("Operation mutation cannot change execution identity");
			}
			if (
				!isDeepStrictEqual(next.result, current.result) ||
				next.resultDigest !== current.resultDigest ||
				next.exitCode !== current.exitCode ||
				next.status !== current.status ||
				next.endedAt !== current.endedAt
			) {
				throw new Error("Operation mutation cannot overwrite a result");
			}
			if (
				!isDeepStrictEqual(next.runner, current.runner) ||
				!isDeepStrictEqual(next.entity, current.entity) ||
				next.pid !== current.pid ||
				next.pgid !== current.pgid ||
				next.processStartId !== current.processStartId
			) {
				throw new Error("Operation mutation cannot overwrite execution identity");
			}
			if (
				current.cancelRequestedAt &&
				(next.cancelRequestedAt !== current.cancelRequestedAt || next.cancelReason !== current.cancelReason)
			)
				throw new Error("Cancellation is irrevocable");
			updated = next;
			return true;
		},
		buildNext: () => JSON.stringify(updated, null, 2) + "\n",
	});
	if (result.error) throw new Error(result.error);
	return { ok: result.ok, record: result.ok ? updated : readOperation(runId, opId) };
}

export function readOperation(runId: string, opId: string): OpRecord | null {
	const dir = operationsDir(runId, opId);
	const raw = readRaw(dir);
	return raw ? project(dir, raw) : null;
}

export function listOperations(runId: string): OpRecord[] {
	const base = path.join(runsBaseDir(), safeId(runId), "operations");
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(base, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => readOperation(runId, entry.name))
		.filter((rec): rec is OpRecord => rec !== null)
		.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function isOpProcessAlive(rec: OpRecord): boolean {
	return !rec.result && !!rec.runner && identityMatches(rec.runner);
}

/** Compatibility diagnostic only; never sufficient authorization to signal. */
export function isProcessGroupAlive(pgid: number | null | undefined, expectedStartId?: string | null): boolean {
	if (!pgid || !expectedStartId) return false;
	try {
		return startIdentity(pgid) === expectedStartId && groupMembers(pgid).length > 0;
	} catch {
		return false;
	}
}

const pauseBuffer = new Int32Array(new SharedArrayBuffer(4));
function pause(ms: number): void {
	Atomics.wait(pauseBuffer, 0, 0, ms);
}

function requestCancel(rec: OpRecord, reason: string, options: ControlOptions): OpRecord {
	const changed = mutateOperation(rec.runId, rec.opId, (cur) => {
		assertControl(options);
		return {
			...cur,
			cancelRequestedAt: cur.cancelRequestedAt ?? new Date().toISOString(),
			cancelReason: cur.cancelReason ?? reason,
		};
	});
	if (!changed.ok || !changed.record) throw new Error("Cancellation request was not committed");
	return changed.record;
}

/**
 * The runner owns TERM/KILL and persists the actual exit. This call authorizes
 * a durable cancellation, wakes only the verified runner, then waits boundedly.
 * No naked PID fallback when runner identity is absent, dead or mismatched.
 */
export function terminateOpProcessTreeSync(
	rec: OpRecord,
	opts: ControlOptions & { graceMs?: number; hardWaitMs?: number } = {},
): { confirmed: boolean; alreadyExited: boolean; blockedReason: string | null } {
	assertControl(opts);
	let current = readOperation(rec.runId, rec.opId);
	if (!current) return { confirmed: false, alreadyExited: false, blockedReason: "Operation missing" };
	if (
		rec.nonce !== current.nonce ||
		rec.intentDigest !== current.intentDigest ||
		(rec.runner && !isDeepStrictEqual(rec.runner, current.runner))
	) {
		return { confirmed: false, alreadyExited: false, blockedReason: "Operation identity changed" };
	}
	if (current.result?.groupGone) return { confirmed: true, alreadyExited: true, blockedReason: null };
	current = requestCancel(current, current.cancelReason ?? "user-stop", opts);
	const deadline = Date.now() + (opts.graceMs ?? 1500) + (opts.hardWaitMs ?? 2500);
	let notified = false;
	while (Date.now() < deadline) {
		current = readOperation(rec.runId, rec.opId);
		if (current?.result?.groupGone) return { confirmed: true, alreadyExited: false, blockedReason: null };
		if (current?.runner && !notified) {
			// Check caller's owner immediately before the wakeup signal. Runner
			// revalidates durable cancellation + group identity before each kill.
			assertControl(opts);
			if (!signalEntity(current.runner, "SIGUSR1", false)) break;
			notified = true;
		}
		if (current?.status === "unknown") break;
		pause(30);
	}
	current = readOperation(rec.runId, rec.opId);
	if (current?.result?.groupGone) return { confirmed: true, alreadyExited: false, blockedReason: null };
	return {
		confirmed: false,
		alreadyExited: false,
		blockedReason: "Runner/result identity unavailable or exit unconfirmed",
	};
}

export function cancelRunOperations(
	runId: string,
	reason = "user-stop",
	options: ControlOptions = {},
): {
	hadActive: boolean;
	allConfirmed: boolean;
	cancelledOpIds: string[];
	blockedReasons: string[];
} {
	assertControl(options);
	const out = { hadActive: false, allConfirmed: true, cancelledOpIds: [] as string[], blockedReasons: [] as string[] };
	for (const rec of listOperations(runId)) {
		if (rec.result?.groupGone) continue;
		out.hadActive = true;
		const requested = requestCancel(rec, reason, options);
		const result = terminateOpProcessTreeSync(requested, options);
		if (result.confirmed) out.cancelledOpIds.push(rec.opId);
		else {
			out.allConfirmed = false;
			out.blockedReasons.push(`${rec.opId}: ${result.blockedReason}`);
		}
	}
	return out;
}

// Compatibility for callers holding children created here. Never manufacture a
// persisted identity from a PID supplied after a service restart.
const ownedChildren = new WeakMap<ChildProcess, { runId: string; opId: string; options: ControlOptions }>();
export function killProcessGroup(child: ChildProcess): void {
	const owned = ownedChildren.get(child);
	if (!owned) throw new Error("Cannot control an unregistered child");
	const rec = readOperation(owned.runId, owned.opId);
	if (!rec) throw new Error("Operation missing");
	const result = terminateOpProcessTreeSync(rec, owned.options);
	if (!result.confirmed) throw new Error(result.blockedReason ?? "Exit unconfirmed");
}

function readTail(
	dir: string,
	name: "stdout.log" | "stderr.log",
	maxBuffer: number,
): { text: string; truncated: boolean } {
	if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 0 || maxBuffer > MAX_OPERATION_OUTPUT_BYTES) {
		throw new Error("Invalid maxBuffer");
	}
	let fd: number;
	try {
		fd = fs.openSync(
			operationFile(dir, name),
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", truncated: false };
		throw error;
	}
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1) throw new Error("Invalid operation log");
		const size = stat.size;
		const buffer = Buffer.alloc(Math.min(maxBuffer, size));
		const length = fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
		return { text: buffer.subarray(0, length).toString("utf8"), truncated: size > maxBuffer };
	} finally {
		fs.closeSync(fd);
	}
}

function readOutput(rec: OpRecord, maxBuffer: number) {
	const dir = operationsDir(rec.runId, rec.opId);
	const stdout = rec.result
		? inspectOperationLog(dir, "stdout.log", rec.result.logs.stdout, maxBuffer)
		: readTail(dir, "stdout.log", maxBuffer);
	const stderr = rec.result
		? inspectOperationLog(dir, "stderr.log", rec.result.logs.stderr, maxBuffer)
		: readTail(dir, "stderr.log", maxBuffer);
	return {
		stdout: stdout.text,
		stderr: stderr.text,
		stdoutTruncated: stdout.truncated,
		stderrTruncated: stderr.truncated,
	};
}

export async function runCommandPersistent(
	command: string,
	args: string[],
	options: PersistentExecOptions,
): Promise<PersistentExecResult> {
	assertControl(options);
	if (options.signal?.aborted) throw new Error("Operation aborted before spawn");
	if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0)) {
		throw new Error("Invalid operation timeout");
	}
	const opId = crypto.randomBytes(16).toString("hex");
	const dir = operationsDir(options.runId, opId);
	const rec: OpRecord = {
		opId,
		runId: options.runId,
		stage: options.stage,
		round: options.round,
		attemptId: options.attemptId ?? null,
		host: os.hostname(),
		bootId: bootIdentity(),
		nonce: crypto.randomBytes(32).toString("hex"),
		protocolVersion: 2,
		pid: null,
		pgid: null,
		processStartId: null,
		command,
		args: [...args],
		cwd: fs.realpathSync(options.cwd),
		stdoutFile: path.join(dir, "stdout.log"),
		stderrFile: path.join(dir, "stderr.log"),
		exitFile: path.join(dir, "exit.code"),
		runnerPidFile: path.join(dir, "runner.json"),
		startedAt: new Date().toISOString(),
		status: "intent",
		exitCode: null,
		endedAt: null,
		snapshotRef: options.snapshotRef ?? null,
		snapshotSha: options.snapshotSha ?? null,
		recoverable: options.recoverable ?? false,
		timeoutMs: options.timeout ?? 0,
		cancelRequestedAt: null,
		cancelConfirmedAt: null,
		cancelReason: null,
		retryOf: options.retryOf ?? null,
		retryReason: options.retryReason ?? null,
		consumptionState: "unconsumed",
	};
	rec.intentDigest = operationIntentDigest(rec);
	const created = compareAndSwapFile(path.join(dir, "operation.json"), {
		isExpected: (text) => {
			assertControl(options);
			return text === null;
		},
		buildNext: () => JSON.stringify(rec, null, 2) + "\n",
	});
	if (!created.ok) throw new Error(created.error ?? "Operation already exists");
	// No parent-side PID/result writes after spawn: self-registration survives
	// parent SIGKILL even before child 'spawn' notification is delivered.
	const fd = fs.openSync(
		operationFile(dir, "runner.log"),
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
		0o600,
	);
	let child: ChildProcess;
	try {
		const started = withRunLockSync(path.dirname(path.dirname(dir)), () => {
			assertControl(options);
			const current = readRaw(dir);
			if (!current || current.intentDigest !== rec.intentDigest || current.nonce !== rec.nonce) {
				throw new Error("Operation intent changed before spawn");
			}
			assertOperationPaths(dir, current);
			if (current.cancelRequestedAt || options.signal?.aborted)
				throw new Error("Operation cancelled before runner spawn");
			return spawn(process.execPath, runnerArguments("runner", dir, rec.nonce!), {
				detached: true,
				stdio: ["ignore", fd, fd],
				cwd: rec.cwd,
			});
		});
		if (!started.ok) throw new Error(started.error);
		child = started.value;
	} finally {
		fs.closeSync(fd);
	}
	ownedChildren.set(child, { runId: rec.runId, opId, options });
	child.unref();
	let launchError: Error | undefined;
	child.once("error", (error) => {
		launchError = error;
	});
	let notified = false;
	for (;;) {
		if (launchError) throw launchError;
		const current = readOperation(rec.runId, opId);
		if (!current) throw new Error("Operation disappeared");
		if (current.entity && !notified) {
			notified = true;
			options.onSpawn?.(current.entity.pid, opId);
		}
		if (options.signal?.aborted && !current.cancelRequestedAt && !current.result) {
			requestCancel(current, "abort-signal", options);
		}
		if (current.result) {
			return {
				opId,
				pid: current.pid,
				code: current.exitCode,
				killed: current.result.killed,
				timedOut: current.result.timedOut,
				...readOutput(current, options.maxBuffer ?? DEFAULT_MAX_BUFFER),
			};
		}
		if (current.status === "unknown") throw new Error(`Operation ${opId}: runner lost, result unknown`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

export async function observeOperation(
	runId: string,
	opId: string,
	opts: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<{
	opId: string;
	code: number | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	killed: boolean;
	timedOut: boolean;
	pidAlive: boolean;
	status: OpStatus | "missing";
	record: OpRecord | null;
}> {
	const deadline = opts.timeoutMs === undefined ? Infinity : Date.now() + opts.timeoutMs;
	let rec: OpRecord | null;
	for (;;) {
		rec = readOperation(runId, opId);
		if (!rec || rec.result || rec.status === "unknown" || Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return {
		opId,
		code: rec?.exitCode ?? null,
		...(rec
			? readOutput(rec, opts.maxBuffer ?? DEFAULT_MAX_BUFFER)
			: { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }),
		killed: rec?.result?.killed ?? false,
		timedOut: rec?.result?.timedOut ?? false,
		pidAlive: rec ? isOpProcessAlive(rec) : false,
		status: rec?.status ?? "missing",
		record: rec,
	};
}
