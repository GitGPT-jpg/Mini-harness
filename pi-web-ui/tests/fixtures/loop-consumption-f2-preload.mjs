// Loaded only by the test's core host, never by its durable runner or command.
// Pause real polling continuations, not production result/state functions.
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

if (process.send && process.env.F2_MODE && !process.argv.includes("--durable-operation")) {
	const root = path.dirname(process.env.MINI_HARNESS_RUNTIME_ROOT);
	const label = process.env.F2_HOST;
	const read = fs.readFileSync.bind(fs);
	const rename = fs.renameSync.bind(fs);
	const timeout = globalThis.setTimeout;
	const interval = globalThis.setInterval;
	const parked = new Map();
	const released = new Set();
	const consumers = new Set();
	let heartbeat;
	let armed = false;
	const trace = (event, extra = {}) => {
		const record = { host: label, pid: process.pid, event, ...extra };
		fs.appendFileSync(path.join(root, "barriers.jsonl"), JSON.stringify(record) + "\n");
		process.send?.({ f2Event: record });
	};
	globalThis.setTimeout = (callback, ms, ...args) => {
		const stack = new Error().stack ?? "";
		const lane = stack.includes("runCommandPersistent")
			? "waiter"
			: stack.includes("observeOperation")
				? "observer"
				: null;
		if (process.env.F2_MODE !== "race" || ms !== 50 || !lane || released.has(lane)) {
			return timeout(callback, ms, ...args);
		}
		if (parked.has(lane)) throw new Error(`Duplicate parked ${lane}`);
		const watchdog = timeout(() => {
			throw new Error(`F2 ${lane} barrier was not released`);
		}, 25000);
		parked.set(lane, () => {
			clearTimeout(watchdog);
			released.add(lane);
			parked.delete(lane);
			trace("released", { lane });
			callback(...args);
		});
		trace("parked", { lane, stack });
		return watchdog;
	};
	globalThis.setInterval = (callback, ms, ...args) => {
		if (new Error().stack?.includes("startLeaseHeartbeat")) {
			// Retain the real callback, but schedule it explicitly through IPC so
			// its write is between the chosen result/stop transitions.
			heartbeat = () => callback(...args);
			return interval(() => {}, ms);
		}
		return interval(callback, ms, ...args);
	};
	fs.readFileSync = (...args) => {
		const value = read(...args);
		if (String(args[0]).endsWith("/state.json")) {
			const stack = new Error().stack ?? "";
			if (stack.includes("recordValidationOutcome")) {
				const lane = stack.includes("observeRunOperation") ? "observer" : "waiter";
				if (!consumers.has(lane)) {
					consumers.add(lane);
					trace("consumption-entered", { lane, stack });
				}
			}
		}
		return value;
	};
	fs.renameSync = (source, target) => {
		let added = [];
		let next;
		if (String(target).endsWith("/state.json")) {
			next = JSON.parse(read(source, "utf8"));
			const previous = fs.existsSync(target) ? JSON.parse(read(target, "utf8")) : {};
			added = Object.keys(next.consumedResults ?? {}).filter((id) => !previous.consumedResults?.[id]);
			if (armed && added.length) {
				armed = false;
				// The new file has already been fsynced; the old state is still
				// authoritative. Parent SIGKILLs this process while holding the lock.
				fs.writeFileSync(
					path.join(root, `${label}-before-consume.json`),
					JSON.stringify({ pid: process.pid, source, target, added, previous, next }, null, 2),
				);
				trace("before-consume-rename", { added });
				const deadline = Date.now() + 25000;
				while (Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
				throw new Error("F2 crash barrier was not killed");
			}
		}
		const result = rename(source, target);
		if (added.length) trace("consumption-committed", { added, revision: next.revision });
		if (next?.status === "done") trace("done-committed", { revision: next.revision });
		return result;
	};
	syncBuiltinESMExports();
	process.on("message", (message) => {
		if (!message.f2Id) return;
		try {
			if (message.f2 === "release") {
				for (const lane of message.lanes) {
					const resume = parked.get(lane);
					if (!resume) throw new Error(`${lane} not parked`);
					resume();
				}
			} else if (message.f2 === "heartbeat") {
				if (!heartbeat) throw new Error("Production heartbeat not registered");
				heartbeat();
				trace("heartbeat");
			} else if (message.f2 === "arm") {
				armed = true;
				trace("armed");
			} else throw new Error("Unknown F2 control");
			process.send?.({ f2Id: message.f2Id, result: true });
		} catch (error) {
			process.send?.({ f2Id: message.f2Id, error: String(error) });
		}
	});
}
