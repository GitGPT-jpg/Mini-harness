// Test-only deterministic barriers in the standalone group process.
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

if (process.argv[2] === "--durable-operation" && process.argv[3] === "group") {
	const dir = process.argv[4];
	const run = path.basename(path.dirname(path.dirname(dir)));
	const root = process.env.MINI_HARNESS_RUNTIME_ROOT;
	const pause = () => {
		fs.writeFileSync(path.join(root, `${run}.group-ready`), String(process.pid));
		const deadline = Date.now() + 10000;
		while (!fs.existsSync(path.join(root, `${run}.group-release`))) {
			if (Date.now() > deadline) throw new Error("Group fixture barrier timeout");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
		}
	};
	if (process.env.OP_F3_GROUP_BARRIER === "outside-lock") {
		const original = fs.openSync;
		fs.openSync = (...args) => {
			const fd = original(...args);
			if (String(args[0]) === path.join(dir, "stderr.log")) pause();
			return fd;
		};
	} else if (process.env.OP_F3_GROUP_BARRIER === "inside-lock") {
		const original = childProcess.spawn;
		childProcess.spawn = (...args) => {
			pause();
			return original(...args);
		};
	} else if (process.env.OP_F3_GROUP_BARRIER === "empty-drain") {
		const original = childProcess.spawnSync;
		childProcess.spawnSync = (...args) => {
			if (args[0] === "/bin/ps" && (args[1].includes("-g") || args[1].includes("--sid"))) pause();
			return original(...args);
		};
	}
	syncBuiltinESMExports();
}
