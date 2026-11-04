import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acquireLease,
	compareAndSwapFile,
	getLease,
	heartbeat,
	leaseExpired,
	LEASE_TTL_MS,
	mutateLease,
	newOwner,
	releaseLease,
	withRunLockSync,
	writeFileAtomicPreserveSync,
	type Lease,
} from "../../server/loop/recovery.js";
import { checkStorageTopology } from "../../server/loop/storage.js";

const fixture = fileURLToPath(new URL("../fixtures/storage-f1-child.ts", import.meta.url));
const dirs: string[] = [];
const children: { child: ChildProcess; done: Promise<unknown> }[] = [];
function temp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-f1-"));
	dirs.push(dir);
	return dir;
}
function initialized(): string {
	const dir = temp();
	expect(withRunLockSync(dir, () => true)).toEqual({ ok: true, value: true });
	return dir;
}
function lease(owner = "owner", generation = 1): Lease {
	const now = new Date().toISOString();
	return { owner, generation, pid: process.pid, startedAt: now, heartbeatAt: now, remoteJobId: null };
}
function legacyState(dir: string) {
	return {
		runId: path.basename(dir),
		status: "done",
		round: 1,
		generation: 1,
		epoch: 0,
		revision: 2,
		goal: "migration fixture",
		workspace: dir,
		sessionId: "fixture",
		createdAt: new Date().toISOString(),
		history: [],
	};
}
function start(dir: string, action: string, argument?: string, ipc = false) {
	const child = spawn(process.execPath, ["--import", "tsx", fixture, dir, action, ...(argument ? [argument] : [])], {
		stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
	});
	const messages: unknown[] = [];
	child.on("message", (message) => messages.push(message));
	let stdout = "";
	let stderr = "";
	child.stdout!.on("data", (data: Buffer) => (stdout += data.toString()));
	child.stderr!.on("data", (data: Buffer) => (stderr += data.toString()));
	const done = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>(
		(resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
		},
	);
	children.push({ child, done });
	return { child, done, messages };
}
async function barrier(dir: string, label: string, child: ChildProcess): Promise<void> {
	await expect.poll(() => fs.existsSync(path.join(dir, `${label}-${child.pid}`)), { timeout: 10_000 }).toBe(true);
}
function go(dir: string, child: ChildProcess): void {
	fs.writeFileSync(path.join(dir, `gate-${child.pid}`), "");
}
afterEach(async () => {
	for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	await Promise.allSettled(children.map((c) => c.done));
	children.length = 0;
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

describe("F1 real process storage", () => {
	it.each([1, 2])("S01/S02 first/expired competition: generation %i has one winner", async (generation) => {
		const dir = generation === 1 ? temp() : initialized();
		if (generation === 2) {
			writeFileAtomicPreserveSync(
				path.join(dir, "lease.json"),
				JSON.stringify({ ...lease(), heartbeatAt: new Date(Date.now() - LEASE_TTL_MS - 1000).toISOString() }),
			);
		}
		const a = start(dir, "compete", String(generation));
		const b = start(dir, "compete", String(generation));
		await Promise.all([barrier(dir, "ready", a.child), barrier(dir, "ready", b.child)]);
		go(dir, a.child);
		go(dir, b.child);
		const results = await Promise.all([a.done, b.done]);
		expect(results.map((r) => r.code)).toEqual([0, 0]);
		expect(results.filter((r) => JSON.parse(r.stdout).ok)).toHaveLength(1);
		expect(fs.readFileSync(path.join(dir, "winners"), "utf8").trim().split("\n")).toHaveLength(1);
		expect(getLease(dir)?.generation).toBe(generation);
	});

	it("S03 valid heartbeats cannot be stolen by a real contender", async () => {
		const dir = initialized();
		expect(acquireLease(dir, lease())).toBe(true);
		const b = start(dir, "compete", "2");
		await barrier(dir, "ready", b.child);
		for (let i = 0; i < 10; i++) expect(heartbeat(dir, "owner", 1)).toBe(true);
		go(dir, b.child);
		const result = await b.done;
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).ok).toBe(false);
		expect(getLease(dir)?.owner).toBe("owner");
	});

	it("S04/S07 old process cannot renew, commit or release after takeover", async () => {
		const dir = initialized();
		acquireLease(dir, lease());
		writeFileAtomicPreserveSync(path.join(dir, "state.json"), '{"revision":1}');
		const old = start(dir, "stale");
		await barrier(dir, "ready", old.child);
		writeFileAtomicPreserveSync(
			path.join(dir, "lease.json"),
			JSON.stringify({ ...lease(), heartbeatAt: new Date(Date.now() - LEASE_TTL_MS - 1).toISOString() }),
		);
		expect(acquireLease(dir, lease("new", 2))).toBe(true);
		go(dir, old.child);
		const result = await old.done;
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			renewed: false,
			committed: { ok: true, value: false },
			released: false,
		});
		expect(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"))).toEqual({ revision: 1 });
	});

	it("S07 real SIGSTOP beyond TTL rejects stale control after SIGCONT", async () => {
		const dir = initialized();
		const a = start(dir, "pause-owner", undefined, true);
		let b: ReturnType<typeof start> | undefined;
		const send = (child: ChildProcess, command: string) =>
			new Promise<void>((resolve, reject) => child.send(command, (error) => (error ? reject(error) : resolve())));
		const stoppedState = () =>
			execFileSync("ps", ["-o", "stat=", "-p", String(a.child.pid)], { encoding: "utf8", timeout: 1000 }).trim();
		try {
			await expect
				.poll(() => a.messages, { timeout: 8000 })
				.toContainEqual(
					expect.objectContaining({
						type: "ready",
						controlBeforePause: true,
						actionBeforePause: true,
					}),
				);
			const original = getLease(dir)!;
			expect(original.pid).toBe(a.child.pid);
			expect(original.generation).toBe(1);
			expect(leaseExpired(original)).toBe(false);
			const leaseFile = path.join(dir, "lease.json");
			const originalBytes = fs.readFileSync(leaseFile, "utf8");
			const counter = path.join(dir, "controlled-actions");
			const originalActions = fs.readFileSync(counter, "utf8");
			expect(originalActions.trim().split("\n")).toEqual([original.owner]);

			expect(a.child.kill("SIGSTOP")).toBe(true);
			await expect.poll(stoppedState, { timeout: 3000 }).toMatch(/^T/);
			const pausedAt = performance.now();
			// This is the actual expiry condition, not a timing-based race barrier.
			// IPC fixes both sides of the wait; no lease timestamps are changed.
			await delay(31_000);
			const pausedMs = performance.now() - pausedAt;
			expect(pausedMs).toBeGreaterThan(LEASE_TTL_MS);
			expect(stoppedState()).toMatch(/^T/);
			expect(fs.readFileSync(leaseFile, "utf8")).toBe(originalBytes);
			expect(leaseExpired(getLease(dir))).toBe(true);

			b = start(dir, "takeover-real-ttl", undefined, true);
			await expect
				.poll(() => b!.messages, { timeout: 8000 })
				.toContainEqual(
					expect.objectContaining({
						type: "taken-over",
						previous: original,
					}),
				);
			const takeover = b.messages[0] as { ageAtTakeoverMs: number; lease: Lease };
			expect(takeover.ageAtTakeoverMs).toBeGreaterThan(LEASE_TTL_MS);
			const successor = getLease(dir)!;
			expect(successor).toEqual(takeover.lease);
			expect(successor.pid).toBe(b.child.pid);
			expect(successor.owner).not.toBe(original.owner);
			expect(successor.generation).toBe(2);
			expect(stoppedState()).toMatch(/^T/);
			const successorState = fs.readFileSync(path.join(dir, "state.json"), "utf8");
			expect(JSON.parse(successorState)).toEqual({ revision: 2, owner: successor.owner, generation: 2 });

			expect(a.child.kill("SIGCONT")).toBe(true);
			await send(a.child, "resume-check");
			const result = await a.done;
			expect(result.code, result.stderr).toBe(0);
			const denied = JSON.parse(result.stdout);
			expect(denied).toEqual({
				renewed: false,
				committed: { ok: true, value: false },
				released: false,
				canControl: false,
				newAction: false,
			});
			expect(getLease(dir)).toEqual(successor);
			expect(fs.readFileSync(path.join(dir, "state.json"), "utf8")).toBe(successorState);
			expect(fs.readFileSync(counter, "utf8")).toBe(originalActions);
			await send(b.child, "finish");
			const bResult = await b.done;
			expect(bResult.code, bResult.stderr).toBe(0);
			console.info(
				"S07 real TTL evidence",
				JSON.stringify({
					aPid: a.child.pid,
					bPid: b.child.pid,
					ttlMs: LEASE_TTL_MS,
					pausedMs: Math.round(pausedMs),
					ageAtTakeoverMs: takeover.ageAtTakeoverMs,
					generationBefore: original.generation,
					generationAfter: successor.generation,
					denied,
					controlledActionCountBefore: 1,
					controlledActionCountAfter: 1,
				}),
			);
		} finally {
			// SIGCONT first even on assertion/timeout failure: never leave our A stopped.
			for (const instance of [a, b]) {
				if (!instance) continue;
				if (instance.child.exitCode === null && instance.child.signalCode === null) {
					instance.child.kill("SIGCONT");
					instance.child.kill("SIGKILL");
				}
			}
			await Promise.allSettled([a.done, ...(b ? [b.done] : [])]);
		}
	}, 60_000);

	it.each(["before-write", "before-rename", "after-rename", "after-commit"])(
		"S05 SIGKILL at %s preserves complete state and releases OS lock",
		async (stage) => {
			const dir = initialized();
			const old = { revision: 1, payload: "old".repeat(10_000) };
			writeFileAtomicPreserveSync(path.join(dir, "state.json"), JSON.stringify(old));
			const a = start(dir, "crash", stage);
			await barrier(dir, "crash", a.child);
			// A plain reader sees a whole version even while writer is suspended.
			const visible = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
			expect(visible.revision).toBe(stage.startsWith("before") ? 1 : 2);
			a.child.kill("SIGKILL");
			expect((await a.done).signal).toBe("SIGKILL");
			expect(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"))).toEqual(visible);
			const b = start(dir, "hold");
			await barrier(dir, "locked", b.child);
			go(dir, b.child);
			expect((await b.done).code).toBe(0);
		},
	);

	it("S08 live lock cannot be reclaimed; bounded timeout and process-death recovery", async () => {
		const dir = initialized();
		const a = start(dir, "hold");
		await barrier(dir, "locked", a.child);
		const before = performance.now();
		const blocked = withRunLockSync(
			dir,
			() => {
				throw new Error("must not enter");
			},
			{ timeoutMs: 80 },
		);
		expect(blocked.ok).toBe(false);
		expect(JSON.stringify(blocked)).toMatch(/locked|busy/);
		expect(performance.now() - before).toBeLessThan(2000);
		a.child.kill("SIGKILL");
		await a.done;
		expect(withRunLockSync(dir, () => true).ok).toBe(true);
	});
});

describe("F1 storage contract and offline migration", () => {
	it("owner nonce is stable within a process and preserves pid/host parsing", () => {
		const owner = newOwner();
		expect(newOwner()).toBe(owner);
		const [pid, host, nonce, extra] = owner.split("@");
		expect(Number(pid)).toBe(process.pid);
		expect(host).toBe(os.hostname());
		expect(nonce).toMatch(/^[a-f0-9]{32}$/);
		expect(extra).toBeUndefined();
	});

	it.each(["legacy", "other-instance"])("same pid/host with %s owner cannot be mistaken for this instance", (kind) => {
		const dir = initialized();
		const previous = `${process.pid}@${os.hostname()}${kind === "legacy" ? "" : "@previous-instance"}`;
		expect(acquireLease(dir, lease(previous))).toBe(true);
		const before = getLease(dir);
		const me = newOwner();
		expect(acquireLease(dir, lease(me))).toBe(false);
		expect(heartbeat(dir, me, 1)).toBe(false);
		expect(mutateLease(dir, { owner: me, generation: 1 }, (cur) => ({ ...cur, taskPid: 123 }))).toBe(false);
		expect(releaseLease(dir, me, 1)).toBe(false);
		expect(getLease(dir)).toEqual(before);
	});

	it.each(["", "@instance-nonce"])("offline migration parses pid/host with owner suffix %s", (suffix) => {
		const dir = temp();
		const record = { ...legacyState(dir), owner: `2147483647@${os.hostname()}${suffix}` };
		fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(record));
		expect(withRunLockSync(dir, () => true).ok).toBe(true);
		expect(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"))).toEqual(record);
	});

	it.each(["valid", "corrupt", "residual", "directory"])("getLease query of %s legacy data is read-only", (kind) => {
		const dir = temp();
		const file = path.join(dir, "lease.json");
		const existing = lease();
		if (kind === "directory") fs.mkdirSync(file);
		else if (kind === "residual") fs.writeFileSync(file + ".cas.2147483647.a", JSON.stringify(existing));
		else fs.writeFileSync(file, kind === "valid" ? JSON.stringify(existing) : "{broken");
		const snapshot = () =>
			fs
				.readdirSync(dir)
				.sort()
				.map((name) => {
					const entry = path.join(dir, name);
					return [name, fs.statSync(entry).isFile() ? fs.readFileSync(entry, "utf8") : "<directory>"];
				});
		const before = snapshot();
		if (kind === "valid") expect(getLease(dir)).toEqual(existing);
		else if (kind === "directory") expect(() => getLease(dir)).toThrow(/EISDIR/);
		else expect(() => getLease(dir)).toThrow(kind === "corrupt" ? /损坏/ : /CAS/);
		expect(snapshot()).toEqual(before);
		// No DB, version marker, backup or implicit acquisition was created.
		expect(fs.existsSync(path.join(dir, ".run-lock.sqlite"))).toBe(false);
		const absent = path.join(dir, "absent-run");
		expect(getLease(absent)).toBeNull();
		expect(fs.existsSync(absent)).toBe(false);
	});

	it("nested run/lease/state/operation calls share the lock; revision prevents stale overwrite", () => {
		const dir = initialized();
		acquireLease(dir, lease());
		const state = path.join(dir, "state.json");
		writeFileAtomicPreserveSync(state, '{"revision":1,"stop":true}');
		const outer = withRunLockSync(dir, () => {
			expect(heartbeat(dir, "owner", 1)).toBe(true);
			expect(getLease(dir)?.owner).toBe("owner");
			writeFileAtomicPreserveSync(path.join(dir, "operations", "op1", "operation.json"), '{"result":true}');
			return compareAndSwapFile(state, {
				isExpected: (raw) => JSON.parse(raw!).revision === 1,
				buildNext: (raw) => JSON.stringify({ ...JSON.parse(raw!), revision: 2, result: true }),
			});
		});
		expect(outer.ok && outer.value.ok).toBe(true);
		expect(
			compareAndSwapFile(state, { isExpected: (raw) => JSON.parse(raw!).revision === 1, buildNext: () => "{}" }).ok,
		).toBe(false);
		expect(JSON.parse(fs.readFileSync(state, "utf8"))).toEqual({ revision: 2, stop: true, result: true });
		expect(fs.existsSync(path.join(dir, "operations", "op1", ".run-lock.sqlite"))).toBe(false);
	});

	it("expired heartbeat/mutator/same-generation acquire cannot revive lease", () => {
		const dir = initialized();
		const expired = { ...lease(), heartbeatAt: new Date(Date.now() - LEASE_TTL_MS).toISOString() };
		writeFileAtomicPreserveSync(path.join(dir, "lease.json"), JSON.stringify(expired));
		expect(heartbeat(dir, "owner", 1)).toBe(false);
		expect(mutateLease(dir, { owner: "owner", generation: 1 }, (cur) => ({ ...cur, taskPid: 42 }))).toBe(false);
		expect(acquireLease(dir, lease())).toBe(false);
		expect(getLease(dir)).toEqual(expired);
	});

	it("idempotent acquisition preserves task identity; release requires exact generation", () => {
		const dir = initialized();
		expect(acquireLease(dir, { ...lease(), taskPid: 42 })).toBe(true);
		const before = getLease(dir);
		expect(acquireLease(dir, lease())).toBe(true);
		expect(getLease(dir)).toEqual(before);
		expect(releaseLease(dir, "owner")).toBe(false);
		expect(releaseLease(dir, "owner", 2)).toBe(false);
		expect(releaseLease(dir, "owner", 1)).toBe(true);
		expect(getLease(dir)).toBeNull();
		expect(acquireLease(dir, lease())).toBe(false);
		expect(acquireLease(dir, lease("owner", 2))).toBe(true);
		expect(releaseLease(dir, "owner", 1)).toBe(false);
	});

	it("corrupt lease and I/O errors are explicit failures, never absence", () => {
		const dir = initialized();
		const file = path.join(dir, "lease.json");
		writeFileAtomicPreserveSync(file, "{broken");
		expect(() => getLease(dir)).toThrow(/损坏/);
		expect(() => acquireLease(dir, lease())).toThrow(/损坏/);
		expect(() => heartbeat(dir, "owner", 1)).toThrow(/损坏/);
		expect(() => releaseLease(dir, "owner", 1)).toThrow(/损坏/);
		expect(fs.readFileSync(file, "utf8")).toBe("{broken");
		const result = compareAndSwapFile(dir, { isExpected: () => true, buildNext: () => "bad" });
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
	});

	it("callback failure closes connection; async callback is rejected before execution", () => {
		const dir = initialized();
		expect(
			withRunLockSync(dir, () => {
				throw new Error("failed");
			}).ok,
		).toBe(false);
		let ran = false;
		expect(
			withRunLockSync(dir, async () => {
				ran = true;
			}).ok,
		).toBe(false);
		expect(ran).toBe(false);
		expect(withRunLockSync(dir, () => 42)).toEqual({ ok: true, value: 42 });
	});

	it("migration ledger survives a first callback failure after a file commit", () => {
		const dir = temp();
		const failed = withRunLockSync(dir, () => {
			expect(acquireLease(dir, lease())).toBe(true);
			throw new Error("after-write");
		});
		expect(failed.ok).toBe(false);
		expect(heartbeat(dir, "owner", 1)).toBe(true);
	});

	it.each([false, true])("fsync failure is reported, including after rename=%s", (afterRename) => {
		const dir = initialized();
		const file = path.join(dir, "state.json");
		writeFileAtomicPreserveSync(file, '{"revision":1}');
		const realSync = fs.fsyncSync;
		const spy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
			if (!afterRename || fs.fstatSync(fd).isDirectory()) throw new Error("fixture EIO");
			realSync(fd);
		});
		try {
			const result = compareAndSwapFile(file, { isExpected: () => true, buildNext: () => '{"revision":2}' });
			expect(result.ok).toBe(false);
			expect(result.error).toContain("EIO");
			expect(JSON.parse(fs.readFileSync(file, "utf8")).revision).toBe(afterRename ? 2 : 1);
		} finally {
			spy.mockRestore();
		}
		expect(withRunLockSync(dir, () => true).ok).toBe(true);
	});

	it("missing lease with legacy CAS residue is blocked even for read-only lookup", () => {
		const dir = temp();
		fs.writeFileSync(path.join(dir, "lease.json.cas.2147483647.a"), JSON.stringify(lease()));
		expect(() => getLease(dir)).toThrow(/CAS/);
	});

	it("S09 restores identical CAS replicas, backs up originals and is reentrant", () => {
		const dir = temp();
		const text = JSON.stringify(legacyState(dir));
		fs.writeFileSync(path.join(dir, "state.json.cas.2147483647.a"), text);
		fs.writeFileSync(path.join(dir, "state.json.cas.2147483647.b"), text);
		expect(withRunLockSync(dir, () => true).ok).toBe(true);
		expect(fs.readFileSync(path.join(dir, "state.json"), "utf8")).toBe(text);
		expect(fs.readdirSync(path.join(dir, ".storage-backup-v3")).filter((n) => n.endsWith(".json"))).toHaveLength(2);
		expect(withRunLockSync(dir, () => true).ok).toBe(true);
	});

	it.each(["conflict", "corrupt", "wrong-run"])("S09 %s leaves originals and backups, blocks execution", (kind) => {
		const dir = temp();
		const record = legacyState(dir);
		const text = JSON.stringify(record);
		fs.writeFileSync(path.join(dir, "state.json"), text);
		const bad =
			kind === "corrupt"
				? "{broken"
				: JSON.stringify({ ...record, ...(kind === "conflict" ? { revision: 3 } : { runId: "other" }) });
		const residual = path.join(dir, "state.json.cas.2147483647.bad");
		fs.writeFileSync(residual, bad);
		expect(
			withRunLockSync(dir, () => {
				throw new Error("must not execute");
			}).ok,
		).toBe(false);
		expect(fs.readFileSync(path.join(dir, "state.json"), "utf8")).toBe(text);
		expect(fs.readFileSync(residual, "utf8")).toBe(bad);
		expect(fs.readdirSync(path.join(dir, ".storage-backup-v3")).filter((n) => n.endsWith(".json"))).toHaveLength(2);
	});

	it("S09 incomplete legacy state schema is blocked", () => {
		const dir = temp();
		fs.writeFileSync(
			path.join(dir, "state.json.cas.2147483647.a"),
			JSON.stringify({ ...legacyState(dir), history: undefined }),
		);
		const result = withRunLockSync(dir, () => true);
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).toContain("schema");
		expect(fs.existsSync(path.join(dir, "state.json"))).toBe(false);
	});

	it("S10 old live process blocks upgrade even with expired heartbeat", () => {
		const dir = temp();
		fs.writeFileSync(path.join(dir, "lease.json"), JSON.stringify({ ...lease(), heartbeatAt: "2000-01-01T00:00:00Z" }));
		const result = withRunLockSync(dir, () => true);
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).toContain("旧活进程");
	});

	it("S09/S10 old CAS claimant and empty wx lock cannot be stolen", () => {
		const dir = temp();
		const record = JSON.stringify({ runId: path.basename(dir), status: "done", round: 1 });
		fs.writeFileSync(path.join(dir, `state.json.cas.${process.pid}.live`), record);
		expect(JSON.stringify(withRunLockSync(dir, () => true))).toContain("旧活进程");
		const emptyLock = temp();
		fs.writeFileSync(path.join(emptyLock, "lease.json.lock"), "");
		expect(withRunLockSync(emptyLock, () => true).ok).toBe(false);
		expect(fs.existsSync(path.join(emptyLock, "lease.json.lock"))).toBe(true);
	});

	it("S09 dead legacy owner/lock can migrate, preserving lease generation", () => {
		const dir = temp();
		const old = { ...lease("2147483647@local", 7), pid: 2147483647, host: os.hostname() };
		fs.writeFileSync(path.join(dir, "lease.json.cas.2147483647.a"), JSON.stringify(old));
		fs.writeFileSync(path.join(dir, "lease.json.lock"), JSON.stringify({ pid: 2147483647, host: os.hostname() }));
		expect(withRunLockSync(dir, () => true).ok).toBe(true);
		expect(getLease(dir)).toEqual(old);
		expect(acquireLease(dir, lease("new", 8), { allowOrphan: true })).toBe(true);
		expect(fs.existsSync(path.join(dir, "lease.json.lock"))).toBe(false);
	});

	it("nested operation cannot escape to a different filesystem/domain through symlink", () => {
		const dir = initialized();
		const outside = temp();
		fs.mkdirSync(path.join(dir, "operations"));
		fs.symlinkSync(outside, path.join(dir, "operations", "op"));
		expect(() => writeFileAtomicPreserveSync(path.join(dir, "operations", "op", "operation.json"), "{}")).toThrow(
			/逃逸/,
		);
		expect(fs.existsSync(path.join(outside, "operation.json"))).toBe(false);
	});

	it("S10 higher protocol and unsupported topology are refused", () => {
		const dir = temp();
		fs.writeFileSync(path.join(dir, ".storage-version"), "99");
		expect(checkStorageTopology(dir).ok).toBe(false);
		const saved = process.env.MINI_HARNESS_STORAGE_TOPOLOGY;
		try {
			process.env.MINI_HARNESS_STORAGE_TOPOLOGY = "nfs";
			expect(withRunLockSync(temp(), () => true).ok).toBe(false);
		} finally {
			if (saved === undefined) delete process.env.MINI_HARNESS_STORAGE_TOPOLOGY;
			else process.env.MINI_HARNESS_STORAGE_TOPOLOGY = saved;
		}
	});

	it("S10 actual filesystem type check rejects NFS even without an environment hint", () => {
		const dir = temp();
		const stat = fs.statfsSync(dir);
		const spy = vi.spyOn(fs, "statfsSync").mockReturnValue({ ...stat, type: 0x6969 });
		try {
			expect(checkStorageTopology(dir).ok).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});

	it("S10 unverified platform is rejected", () => {
		const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
		try {
			Object.defineProperty(process, "platform", { value: "win32" });
			expect(checkStorageTopology(dirs[0] ?? os.tmpdir()).ok).toBe(false);
		} finally {
			Object.defineProperty(process, "platform", descriptor);
		}
	});
});
