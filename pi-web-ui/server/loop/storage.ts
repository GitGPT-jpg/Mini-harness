/**
 * Single-host storage v3. JSON files remain authoritative; SQLite is ONLY the
 * kernel-managed run mutex and migration ledger. Never delete/replace the DB.
 *
 * BEGIN IMMEDIATE covers read/check/atomic-replace, including nested lease/state
 * calls. This is NOT a multi-file rollback transaction: a crash can commit a
 * prefix of several file writes. Keep related business facts in one JSON record.
 * All writers must opt into this protocol. Old binaries cannot be fenced by a
 * version marker: stop them before upgrade and never restart them on this data.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

export const FILE_LOCK_TIMEOUT_MS = 5_000;
export const STORAGE_PROTOCOL_VERSION = 3;
export type LockResult<T> = { ok: true; value: T } | { ok: false; error: string };
const DB_NAME = ".run-lock.sqlite";

// Shared across duplicate module loaders in the extension host.
const registryKey = Symbol.for("mini-harness.run-lock.v3");
const globals = globalThis as typeof globalThis & { [registryKey]?: Set<string> };
const held = (globals[registryKey] ??= new Set<string>());

export function readFileOptionalSync(file: string): string | null {
	try {
		return fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function syncDir(dir: string): void {
	const fd = fs.openSync(dir, "r");
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function ensureDirectory(dir: string): void {
	if (fs.existsSync(dir)) return;
	const parent = path.dirname(dir);
	ensureDirectory(parent);
	try {
		fs.mkdirSync(dir, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !fs.statSync(dir).isDirectory()) throw error;
	}
	syncDir(parent);
}

function checkTarget(file: string): void {
	const root = [...held][0];
	if (!root) throw new Error("文件提交缺少 run 锁");
	let ancestor = path.dirname(path.resolve(file));
	while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
	const actual = fs.realpathSync(ancestor);
	if (actual !== root && !actual.startsWith(root + path.sep)) throw new Error("文件路径通过符号链接逃逸 run 锁域");
	const topology = checkStorageTopology(actual);
	if (!topology.ok) throw new Error(topology.error);
	if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("存储目标不能是符号链接");
}

/** Private raw writer: callers must already hold the appropriate run lock. */
function replaceFile(file: string, text: string): void {
	const dir = path.dirname(file);
	const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(12).toString("hex")}`;
	let fd: number | undefined;
	try {
		fd = fs.openSync(tmp, "wx", 0o600);
		fs.writeFileSync(fd, text, "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(tmp, file);
		syncDir(dir);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		fs.rmSync(tmp, { force: true });
	}
}

/** Fail closed on unknown mounts; an environment hint never overrides statfs. */
export function checkStorageTopology(dir: string): { ok: true } | { ok: false; error: string } {
	try {
		if (process.platform !== "darwin" && process.platform !== "linux") {
			throw new Error(`不支持的平台 ${process.platform}`);
		}
		const hint = process.env.MINI_HARNESS_STORAGE_TOPOLOGY?.trim().toLowerCase();
		if (hint && hint !== "local" && hint !== "posix") throw new Error(`不支持的存储拓扑 ${hint}`);
		let existing = path.resolve(dir);
		while (!fs.existsSync(existing)) existing = path.dirname(existing);
		const type = fs.statfsSync(existing).type;
		// macOS APFS/HFS; Linux ext*, XFS, Btrfs. No NFS/SMB/FUSE/overlay/tmpfs.
		const supported = process.platform === "darwin" ? [0x1a, 0x11] : [0xef53, 0x58465342, 0x9123683e];
		if (!supported.includes(type)) throw new Error(`未经支持的本地文件系统 0x${type.toString(16)}`);
		const version = readFileOptionalSync(path.join(dir, ".storage-version"));
		if (version !== null && !/^[123]$/.test(version.trim())) {
			throw new Error("存储协议版本不兼容或损坏");
		}
		return { ok: true };
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

/**
 * Canonical domain for existing public file APIs. All operation records map to
 * their run, not to per-operation DBs. Other nested layouts must use an explicit
 * withRunLockSync(runDir, ...) wrapper.
 */
export function runDirectoryForFile(file: string): string {
	const dir = path.dirname(path.resolve(file));
	if (path.basename(path.dirname(dir)) === "operations") return path.dirname(path.dirname(dir));
	for (const root of held) {
		if (dir === root || dir.startsWith(root + path.sep)) return root;
	}
	return dir;
}

function invokeSync<T>(fn: () => T): T {
	// Reject native async functions before their body can run.
	if (fn.constructor.name === "AsyncFunction") throw new Error("run lock callback must be synchronous");
	const value = fn();
	if (value && typeof (value as { then?: unknown }).then === "function") {
		throw new Error("run lock callback must not return a Promise");
	}
	return value;
}

/**
 * Bounded synchronous, reentrant run mutex. No callback retries, no TTL lock
 * theft, no external work/await inside. Connection closes on every outer exit.
 * Errors (including callback errors) return ok:false; file writes already made
 * are NOT rolled back. Callers must inspect both outer and inner CAS results.
 */
export function withRunLockSync<T>(runDir: string, fn: () => T, opts?: { timeoutMs?: number }): LockResult<T> {
	let db: DatabaseSync | undefined;
	let root: string | undefined;
	let entered = false;
	try {
		const topology = checkStorageTopology(runDir);
		if (!topology.ok) return topology;
		ensureDirectory(path.resolve(runDir));
		root = fs.realpathSync(runDir);
		if (held.has(root)) return { ok: true, value: invokeSync(fn) };
		if (held.size) throw new Error("不允许嵌套不同 run 的锁（避免锁顺序死锁）");
		const timeout = opts?.timeoutMs ?? Number(process.env.MINI_HARNESS_LOCK_TIMEOUT_MS ?? FILE_LOCK_TIMEOUT_MS);
		if (!Number.isInteger(timeout) || timeout < 0 || timeout > FILE_LOCK_TIMEOUT_MS) {
			throw new Error(`锁等待必须为 0..${FILE_LOCK_TIMEOUT_MS}ms`);
		}
		const dbPath = path.join(root, DB_NAME);
		if (fs.existsSync(dbPath) && fs.lstatSync(dbPath).isSymbolicLink()) throw new Error("锁数据库不能是符号链接");
		db = new DatabaseSync(dbPath);
		db.exec(`PRAGMA busy_timeout=${timeout}`);
		// DELETE journal avoids persistent WAL/shared-memory lifetime concerns.
		db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON");
		db.exec("BEGIN IMMEDIATE");
		entered = true;
		db.exec("CREATE TABLE IF NOT EXISTS protocol (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER, host TEXT)");
		const protocol = db.prepare("SELECT version, host FROM protocol WHERE id=1").get();
		if (protocol && (protocol.version !== STORAGE_PROTOCOL_VERSION || protocol.host !== os.hostname())) {
			throw new Error("存储协议/宿主不匹配，禁止混合版本或多宿主写入");
		}
		if (!protocol) {
			migrateLegacy(root);
			db.prepare("INSERT INTO protocol VALUES (1, ?, ?)").run(STORAGE_PROTOCOL_VERSION, os.hostname());
			// Migration must survive a later callback failure or SIGKILL.
			db.exec("COMMIT");
			entered = false;
			syncDir(root);
			db.exec("BEGIN IMMEDIATE");
			entered = true;
		}
		held.add(root);
		const value = invokeSync(fn);
		db.exec("COMMIT");
		entered = false;
		syncDir(root);
		return { ok: true, value };
	} catch (error) {
		return { ok: false, error: `run 存储受阻：${String(error)}` };
	} finally {
		if (entered) {
			try {
				db?.exec("ROLLBACK");
			} catch {
				// Preserve the original failure; close still releases the OS lock.
			}
		}
		if (root && db) held.delete(root);
		db?.close();
	}
}

/** Compatibility API: now a run lock, never a per-file wx lock. */
export function withFileLockSync<T>(file: string, fn: () => T, opts?: { timeoutMs?: number }): LockResult<T> {
	return withRunLockSync(runDirectoryForFile(file), fn, opts);
}

export function writeFileAtomicPreserveSync(file: string, text: string): void {
	const result = withFileLockSync(file, () => {
		checkTarget(file);
		ensureDirectory(path.dirname(path.resolve(file)));
		replaceFile(file, text);
	});
	if (!result.ok) throw new Error(result.error);
}

export function compareAndSwapFile(
	file: string,
	opts: {
		isExpected: (currentText: string | null) => boolean;
		buildNext: (currentText: string | null) => string | null;
	},
): { ok: boolean; current: string | null; error?: string } {
	let current: string | null = null;
	const result = withFileLockSync(file, () => {
		checkTarget(file);
		current = readFileOptionalSync(file);
		if (!opts.isExpected(current)) return false;
		const next = opts.buildNext(current);
		if (next === null) {
			fs.rmSync(file, { force: true });
			syncDir(path.dirname(file));
		} else {
			ensureDirectory(path.dirname(path.resolve(file)));
			replaceFile(file, next);
		}
		return true;
	});
	return result.ok ? { ok: result.value, current } : { ok: false, current, error: result.error };
}

function objectRecord(text: string): Record<string, unknown> {
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("损坏的旧记录");
	return value as Record<string, unknown>;
}

function assertDeadHolder(record: Record<string, unknown>): void {
	const ownerHost = typeof record.owner === "string" ? record.owner.split("@")[1] : undefined;
	const host = record.host ?? ownerHost;
	if (host !== undefined && host !== os.hostname()) throw new Error("旧记录来自不同宿主，升级受阻");
	const pid = record.pid ?? Number(String(record.owner ?? "").split("@")[0]);
	if (!Number.isSafeInteger(pid) || Number(pid) <= 0) throw new Error("无法核验旧写者身份，升级受阻");
	try {
		process.kill(Number(pid), 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
		throw new Error("无法确认旧写者已退出，升级受阻");
	}
	throw new Error("旧活进程仍可能写入，必须停止旧写者后升级（TTL 过期不构成退出证明）");
}

function validateLegacy(target: string, text: string, root: string): Record<string, unknown> {
	const record = objectRecord(text);
	const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
	if (record.schemaVersion !== undefined && record.schemaVersion !== 1) throw new Error("未知旧 schemaVersion");
	if (record.revision !== undefined && !integer(record.revision)) throw new Error("损坏的旧 revision");
	if (record.generation !== undefined && !integer(record.generation)) throw new Error("损坏的旧 generation");
	if (path.basename(target) === "lease.json") {
		if (
			typeof record.owner !== "string" ||
			!record.owner ||
			!integer(record.generation) ||
			!Number.isFinite(Date.parse(String(record.heartbeatAt))) ||
			!Number.isFinite(Date.parse(String(record.startedAt)))
		)
			throw new Error("损坏的旧 lease");
		assertDeadHolder(record);
	} else if (path.basename(target) === "state.json") {
		if (
			record.runId !== path.basename(root) ||
			!["active", "done", "stopped"].includes(String(record.status)) ||
			!integer(record.round) ||
			!integer(record.generation) ||
			!integer(record.epoch) ||
			typeof record.goal !== "string" ||
			typeof record.workspace !== "string" ||
			typeof record.sessionId !== "string" ||
			!Number.isFinite(Date.parse(String(record.createdAt))) ||
			!Array.isArray(record.history)
		) {
			throw new Error("旧 state runId/schema 不匹配");
		}
		for (const item of record.history) {
			if (!item || typeof item !== "object" || !integer(item.round) || typeof item.verdict !== "string") {
				throw new Error("旧 state history 损坏");
			}
		}
		if (record.owner) assertDeadHolder(record);
		else if (record.status === "active") throw new Error("旧 active state 无可核验 owner，升级受阻");
	} else if (path.basename(target) === "operation.json") {
		if (record.runId !== path.basename(root) || record.opId !== path.basename(path.dirname(target))) {
			throw new Error("旧 operation 身份不匹配");
		}
		// Old runners may write without a lease. Do not upgrade running operations.
		if (!["exited", "killed", "error"].includes(String(record.status))) {
			throw new Error("旧 operation 尚未终结，升级受阻");
		}
	} else {
		throw new Error(`未知旧 CAS 记录 ${path.basename(target)}，需人工核验`);
	}
	if (record.runId !== undefined && record.runId !== path.basename(root)) throw new Error("旧 runId 不匹配");
	return record;
}

/**
 * Reentrant offline migration: backup every input before validation; restore
 * only a single unambiguous value (equal replicas allowed). Never choose mtime
 * or blindly prefer a larger revision/generation. Crash prefixes are retryable.
 * The ledger is committed before business callbacks; .storage-version also
 * blocks the previous v2 helper (but cannot constrain older unaware binaries).
 */
function migrateLegacy(root: string): void {
	const records = new Map<string, { file: string; text: string }[]>();
	const leftovers: string[] = [];
	const dirs = [root];
	const ops = path.join(root, "operations");
	if (fs.existsSync(ops)) {
		if (fs.lstatSync(ops).isSymbolicLink()) throw new Error("旧 operations 目录为符号链接");
		const entries = fs.readdirSync(ops, { withFileTypes: true });
		if (entries.length > 1000) throw new Error("旧 operations 超过迁移上限");
		for (const entry of entries) {
			if (entry.isSymbolicLink()) throw new Error("旧 operation 目录为符号链接");
			if (entry.isDirectory()) dirs.push(path.join(ops, entry.name));
		}
	}
	let bytes = 0;
	for (const dir of dirs) {
		const names = fs.readdirSync(dir);
		if (names.length > 5000) throw new Error("旧存储目录超过迁移上限");
		for (const name of names) {
			const cas = name.match(/^(.*)\.cas\.(\d+)\.[\w-]+$/);
			const isLock = name.endsWith(".lock");
			if (name.includes(".cas.") && !cas) throw new Error("无法辨认的旧 CAS 残留，升级受阻");
			if (!cas && !isLock && !["state.json", "lease.json", "operation.json"].includes(name)) continue;
			const file = path.join(dir, name);
			const stat = fs.lstatSync(file);
			if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("旧存储记录类型或大小不支持");
			bytes += stat.size;
			if (bytes > 64 * 1024 * 1024) throw new Error("旧存储迁移总大小超限");
			const text = fs.readFileSync(file, "utf8");
			const backup = path.join(root, ".storage-backup-v3");
			if (fs.existsSync(backup) && fs.lstatSync(backup).isSymbolicLink()) throw new Error("迁移备份不能是符号链接");
			ensureDirectory(backup);
			const digest = crypto
				.createHash("sha256")
				.update(path.relative(root, file))
				.update("\0")
				.update(text)
				.digest("hex");
			const copy = path.join(backup, digest + ".json");
			if (readFileOptionalSync(copy) !== text) replaceFile(copy, text);
			replaceFile(
				path.join(backup, digest + ".source"),
				JSON.stringify({ version: STORAGE_PROTOCOL_VERSION, path: path.relative(root, file) }) + "\n",
			);
			if (isLock) {
				assertDeadHolder(objectRecord(text));
				leftovers.push(file);
				continue;
			}
			const target = path.join(dir, cas?.[1] ?? name);
			const list = records.get(target) ?? [];
			list.push({ file, text });
			records.set(target, list);
			if (cas) leftovers.push(file);
		}
	}
	// Validate ALL candidates before restoring any target.
	for (const [target, candidates] of records) {
		const parsed = candidates.map((c) => {
			const claimant = path.basename(c.file).match(/\.cas\.(\d+)\./);
			if (claimant) assertDeadHolder({ pid: Number(claimant[1]) });
			return validateLegacy(target, c.text, root);
		});
		if (parsed.some((p) => !isDeepStrictEqual(p, parsed[0]))) {
			throw new Error(`旧 CAS 冲突：${path.relative(root, target)}；原件和备份均保留`);
		}
	}
	const state = records.get(path.join(root, "state.json"))?.[0];
	const lease = records.get(path.join(root, "lease.json"))?.[0];
	if (state && lease) {
		const st = objectRecord(state.text);
		const ls = objectRecord(lease.text);
		if (st.owner !== ls.owner || st.generation !== ls.generation) {
			throw new Error("旧 state/lease owner 或 generation 冲突，升级受阻");
		}
	}
	for (const [target, candidates] of records) {
		if (readFileOptionalSync(target) === null) replaceFile(target, candidates[0].text);
	}
	for (const file of leftovers) {
		fs.unlinkSync(file);
		syncDir(path.dirname(file));
	}
	replaceFile(path.join(root, ".storage-version"), `${STORAGE_PROTOCOL_VERSION}\n`);
}
