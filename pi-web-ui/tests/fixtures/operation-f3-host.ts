/** Independent harness-host fixture; fault barriers exist only in this test. */
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { withRunLockSync } from "../../server/loop/storage.js";

const [mode, runId, phase = "running"] = process.argv.slice(2);
const root = process.env.MINI_HARNESS_RUNTIME_ROOT!;
const releaseBarrier = (point: string) => {
	process.send?.({ point, hostPid: process.pid });
	const deadline = Date.now() + 10000;
	while (!fs.existsSync(path.join(root, `${runId}.host-release`))) {
		if (Date.now() > deadline) throw new Error("Host barrier timed out");
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
	}
};
const barrier = (point: string) => {
	process.send?.({ point, hostPid: process.pid });
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

if (mode === "start" && phase === "after-spawn") {
	const original = childProcess.spawn;
	childProcess.spawn = ((...args: Parameters<typeof original>) => {
		const child = original(...args);
		if (Array.isArray(args[1]) && args[1].includes("--durable-operation")) barrier("after-spawn");
		return child;
	}) as typeof original;
	syncBuiltinESMExports();
}
if (mode === "start" && phase === "outside-lock") {
	const original = fs.openSync;
	fs.openSync = ((...args: Parameters<typeof original>) => {
		const fd = original(...args);
		if (String(args[0]).endsWith("/runner.log")) releaseBarrier("outside-lock");
		return fd;
	}) as typeof original;
	syncBuiltinESMExports();
}
if (process.env.OP_F3_GROUP_BARRIER) {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import ${new URL("./operation-f3-preload.mjs", import.meta.url).href}`;
}

const moduleUrl = new URL(
	process.env.OP_F3_COMPILED === "1" ? "../../dist/server/loop/operation.js" : "../../server/loop/operation.js",
	import.meta.url,
);
const operations = (await import(moduleUrl.href)) as typeof import("../../server/loop/operation.js");

if (mode === "start") {
	let checks = 0;
	const script =
		process.env.OP_FIXTURE_SCRIPT ??
		`
		const fs = require("node:fs");
		const path = require("node:path");
		const root = ${JSON.stringify(root)};
		fs.appendFileSync(path.join(root, ${JSON.stringify(runId + ".starts")}), process.pid + "\\n");
		console.log("fixture-start");
		console.error("fixture-stderr");
		const timer = setInterval(() => {
			if (fs.existsSync(path.join(root, ${JSON.stringify(runId + ".release")}))) {
				clearInterval(timer);
				console.log("fixture-complete");
				process.exitCode = 7;
			}
		}, 20);
	`;
	const result = await operations
		.runCommandPersistent(process.execPath, ["-e", script], {
			runId,
			cwd: root,
			stage: "validate",
			round: 4,
			attemptId: "attempt-f3",
			snapshotRef: "fixture-snapshot",
			snapshotSha: "fixture-sha",
			recoverable: true,
			timeout: Number(process.env.OP_FIXTURE_TIMEOUT ?? 15000),
			canControl: () => {
				if (++checks === 3) {
					if (phase === "before-spawn") barrier("before-spawn");
					if (phase === "inside-lock") releaseBarrier("inside-lock");
				}
				return true;
			},
			onSpawn: (pid, opId) => {
				process.send?.({ point: "running", pid, opId, hostPid: process.pid });
			},
		})
		.catch((error) => {
			process.send?.({ failure: String(error) });
			process.exitCode = 1;
			return null;
		});
	process.send?.({ result });
} else if (mode === "observe") {
	const rec = operations.listOperations(runId)[0];
	const result = await operations.observeOperation(runId, rec.opId, { timeoutMs: 20000 });
	process.send?.({ result, hostPid: process.pid });
} else if (mode === "cancel") {
	const result = operations.cancelRunOperations(runId, "fixture-stop", { canControl: () => true });
	process.send?.({ result, hostPid: process.pid });
} else if (mode === "cancel-crash") {
	const result = operations.cancelRunOperations(runId, "fixture-stop", {
		canControl: () => {
			const rec = operations.listOperations(runId)[0];
			if (rec.cancelRequestedAt) barrier("cancel-persisted");
			return true;
		},
	});
	process.send?.({ result });
} else if (mode === "read") {
	process.send?.({ result: operations.listOperations(runId), hostPid: process.pid });
} else if (mode === "try-cancel" || mode === "request-cancel") {
	const result = withRunLockSync(
		path.join(root, runId),
		() => {
			const rec = operations.listOperations(runId)[0];
			return operations.mutateOperation(runId, rec.opId, (cur) => ({
				...cur,
				cancelRequestedAt: cur.cancelRequestedAt ?? new Date().toISOString(),
				cancelReason: cur.cancelReason ?? "lock-fixture-stop",
			})).ok;
		},
		{ timeoutMs: mode === "try-cancel" ? 0 : 5000 },
	);
	process.send?.({ result });
} else {
	throw new Error(`Invalid fixture mode ${mode}`);
}
// IPC handles are closed explicitly so the parent can await a real host exit.
process.disconnect?.();
