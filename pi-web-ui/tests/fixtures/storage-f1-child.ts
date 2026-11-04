import fs from "node:fs";
import path from "node:path";
import {
	acquireLease,
	compareAndSwapFile,
	getLease,
	heartbeat,
	leaseExpired,
	newOwner,
	releaseLease,
	withRunLockSync,
	writeFileAtomicPreserveSync,
} from "../../server/loop/recovery.js";

const [dir, action, argument = "1"] = process.argv.slice(2);
const gate = path.join(dir, `gate-${process.pid}`);
function barrier(label: string): void {
	fs.writeFileSync(path.join(dir, `${label}-${process.pid}`), "");
	const deadline = Date.now() + 15_000;
	while (!fs.existsSync(gate)) {
		if (Date.now() > deadline) throw new Error("fixture barrier timeout");
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
	}
}
const state = path.join(dir, "state.json");
function waitForCommand(command: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error(`fixture IPC timeout: ${command}`)), 50_000);
		const disconnected = () => finish(new Error("fixture parent disconnected"));
		const received = (message: unknown) => {
			if (message === command) finish();
		};
		function finish(error?: Error) {
			clearTimeout(timer);
			process.off("message", received);
			process.off("disconnect", disconnected);
			if (error) reject(error);
			else resolve();
		}
		process.on("message", received);
		process.once("disconnect", disconnected);
	});
}

function sendMessage(message: object): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!process.send) return reject(new Error("fixture requires IPC"));
		process.send(message, (error) => (error ? reject(error) : resolve()));
	});
}

if (action === "pause-owner" || action === "takeover-real-ttl") {
	// S07 deliberately uses the production TTL and wall clock without rewriting
	// timestamps. The parent alone controls SIGSTOP/SIGCONT and IPC sequencing.
	const owner = newOwner();
	const generation = action === "pause-owner" ? 1 : 2;
	const canControl = () => {
		const current = getLease(dir);
		return !!current && current.owner === owner && current.generation === generation && !leaseExpired(current);
	};
	const counter = path.join(dir, "controlled-actions");
	const controlledAction = () => {
		const locked = withRunLockSync(dir, () => {
			if (!canControl()) return false;
			fs.appendFileSync(counter, `${owner}\n`);
			return true;
		});
		if (!locked.ok) throw new Error(locked.error);
		return locked.value;
	};
	try {
		const previous = getLease(dir);
		const now = new Date().toISOString();
		const acquired = acquireLease(dir, {
			owner,
			pid: process.pid,
			generation,
			startedAt: now,
			heartbeatAt: now,
			remoteJobId: null,
		});
		if (!acquired) throw new Error("fixture failed to acquire lease");
		if (action === "pause-owner") {
			writeFileAtomicPreserveSync(state, JSON.stringify({ revision: 1, owner, generation }));
			const controlBeforePause = canControl();
			const actionBeforePause = controlledAction();
			// Install the listener before announcing readiness.
			const resumed = waitForCommand("resume-check");
			await sendMessage({
				type: "ready",
				lease: getLease(dir),
				controlBeforePause,
				actionBeforePause,
			});
			await resumed;
			const renewed = heartbeat(dir, owner, generation);
			const committed = withRunLockSync(dir, () => {
				if (!canControl()) return false;
				return compareAndSwapFile(state, {
					isExpected: (raw) => JSON.parse(raw!).revision === 1,
					buildNext: () => JSON.stringify({ revision: 2, owner, generation, stale: true }),
				}).ok;
			});
			const released = releaseLease(dir, owner, generation);
			console.log(
				JSON.stringify({
					renewed,
					committed,
					released,
					canControl: canControl(),
					newAction: controlledAction(),
				}),
			);
		} else {
			const committed = withRunLockSync(dir, () => {
				if (!canControl()) return false;
				return compareAndSwapFile(state, {
					isExpected: (raw) => JSON.parse(raw!).revision === 1,
					buildNext: () => JSON.stringify({ revision: 2, owner, generation }),
				}).ok;
			});
			if (!committed.ok || !committed.value) throw new Error("fixture takeover state commit failed");
			// Keep B alive until A's rejected actions have been checked.
			const finished = waitForCommand("finish");
			await sendMessage({
				type: "taken-over",
				lease: getLease(dir),
				previous,
				ageAtTakeoverMs: Date.now() - Date.parse(previous!.heartbeatAt),
			});
			await finished;
		}
	} finally {
		if (process.connected) process.disconnect();
	}
} else if (action === "compete") {
	barrier("ready");
	const now = new Date().toISOString();
	const ok = acquireLease(dir, {
		owner: String(process.pid),
		pid: process.pid,
		generation: Number(argument),
		startedAt: now,
		heartbeatAt: now,
		remoteJobId: null,
	});
	if (ok) fs.appendFileSync(path.join(dir, "winners"), `${process.pid}\n`);
	console.log(JSON.stringify({ ok }));
} else if (action === "hold") {
	console.log(JSON.stringify(withRunLockSync(dir, () => barrier("locked"))));
} else if (action === "crash") {
	// Fault injection is confined to this isolated fixture, never production env.
	const rename = fs.renameSync;
	fs.renameSync = (from, to) => {
		if (String(to) === state && argument === "before-rename") barrier("crash");
		rename(from, to);
		if (String(to) === state && argument === "after-rename") barrier("crash");
	};
	const result = compareAndSwapFile(state, {
		isExpected: (raw) => JSON.parse(raw!).revision === 1,
		buildNext: () => {
			if (argument === "before-write") barrier("crash");
			return JSON.stringify({ revision: 2, payload: "new".repeat(10_000) });
		},
	});
	if (argument === "after-commit") barrier("crash");
	console.log(JSON.stringify(result));
} else if (action === "stale") {
	const before = getLease(dir)!;
	barrier("ready");
	const renewed = heartbeat(dir, before.owner, before.generation);
	const committed = withRunLockSync(dir, () => {
		const current = getLease(dir);
		if (!current || current.owner !== before.owner || current.generation !== before.generation) return false;
		return compareAndSwapFile(state, {
			isExpected: (raw) => JSON.parse(raw!).revision === 1,
			buildNext: () => JSON.stringify({ revision: 2, stale: true }),
		}).ok;
	});
	const released = releaseLease(dir, before.owner, before.generation);
	console.log(JSON.stringify({ renewed, committed, released }));
} else {
	throw new Error(`unknown fixture action: ${action}`);
}
