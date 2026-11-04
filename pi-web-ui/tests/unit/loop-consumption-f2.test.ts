import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const fixture = fileURLToPath(new URL("../fixtures/loop-core-host.ts", import.meta.url));
const preload = fileURLToPath(new URL("../fixtures/loop-consumption-f2-preload.mjs", import.meta.url));
const quote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
const json = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const lines = (file: string) =>
	fs.existsSync(file)
		? fs
				.readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];

async function until<T>(read: () => T | undefined, label: string): Promise<T> {
	const deadline = Date.now() + 15000;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function killHost(child: ChildProcess) {
	if (child.exitCode !== null || child.signalCode) return;
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
}

function scenario() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-consumption-f2-"));
	for (const dir of ["workspace", "runs", "data", "agent"]) fs.mkdirSync(path.join(root, dir));
	const nonce = crypto.randomUUID();
	const counter = path.join(root, "starts.jsonl");
	const release = path.join(root, "command-release");
	// External append-only evidence and gates never enter the workspace fingerprint.
	// The watchdog also bounds cleanup if an assertion fails before a host can stop.
	const program = `
		const fs = require("node:fs");
		fs.appendFileSync(${JSON.stringify(counter)}, JSON.stringify({pid:process.pid, nonce:${JSON.stringify(nonce)}})+"\\n");
		const watchdog = setTimeout(() => process.exit(73), 60000);
		const timer = setInterval(() => {
			if (!fs.existsSync(${JSON.stringify(release)})) return;
			clearInterval(timer); clearTimeout(watchdog);
			console.log("HARNESS_METRIC: score=42");
			console.log(${JSON.stringify(nonce)});
		}, 20);
	`;
	return {
		root,
		nonce,
		counter,
		command: `${quote(process.execPath)} -e ${quote(program)}`,
		release: () => fs.writeFileSync(release, "release"),
		state: (runId: string) => json(path.join(root, "runs", runId, "state.json")),
		lease: (runId: string) => json(path.join(root, "runs", runId, "lease.json")),
	};
}

interface Host {
	child: ChildProcess;
	events: any[];
	rpc: (action: string, args?: Record<string, unknown>) => Promise<any>;
	control: (action: string, args?: Record<string, unknown>) => Promise<any>;
	http: (runId: string, action: string) => Promise<{ status: number; body: any }>;
}
async function host(root: string, label: string, mode: "race" | "crash" | "plain", hosts: Host[]): Promise<Host> {
	const child = fork(fixture, [], {
		execArgv: ["--import", preload, "--import", "tsx"],
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
			F2_MODE: mode,
			F2_HOST: label,
		},
	});
	const logFile = path.join(root, `${label}.log`);
	child.stdout?.on("data", (chunk) => fs.appendFileSync(logFile, chunk));
	child.stderr?.on("data", (chunk) => fs.appendFileSync(logFile, chunk));
	let port: number | undefined;
	const events: any[] = [];
	const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	child.on("message", (message: any) => {
		if (message.ready) port = message.port;
		if (message.f2Event) events.push(message.f2Event);
		const id = message.f2Id ?? message.id;
		const waiter = pending.get(id);
		if (!waiter) return;
		pending.delete(id);
		if (message.error) waiter.reject(new Error(message.error));
		else waiter.resolve(message.result);
	});
	child.on("exit", () => {
		for (const waiter of pending.values()) waiter.reject(new Error(`Host ${label} exited; see ${logFile}`));
		pending.clear();
	});
	const request = (payload: Record<string, unknown>, control = false) => {
		const promise = new Promise<any>((resolve, reject) => {
			const id = crypto.randomUUID();
			pending.set(id, { resolve, reject });
			child.send({ ...payload, [control ? "f2Id" : "id"]: id });
		});
		// A planned SIGKILL rejects its outstanding observe request.
		void promise.catch(() => {});
		return promise;
	};
	const result = {
		child,
		events,
		rpc: (action: string, args: Record<string, unknown> = {}) => request({ action, ...args }),
		control: (f2: string, args: Record<string, unknown> = {}) => request({ f2, ...args }, true),
		http: async (runId: string, action: string) => {
			const response = await fetch(`http://127.0.0.1:${port}/api/mini-harness/runs/${runId}/${action}`, {
				method: action === "detail" ? "GET" : "POST",
				headers: { authorization: `Bearer ${path.basename(root)}` },
				signal: AbortSignal.timeout(10000),
			});
			const body = await response.json();
			fs.appendFileSync(
				path.join(root, "http.jsonl"),
				JSON.stringify({ label, action, status: response.status, body }) + "\n",
			);
			return { status: response.status, body: body as any };
		},
	};
	hosts.push(result);
	await until(() => {
		if (child.exitCode !== null || child.signalCode) throw new Error(`Startup failed: ${logFile}`);
		return port;
	}, `${label} ready`);
	// Existing host uses listen(0): the OS atomically selects and binds a free port.
	expect(port).toBeGreaterThanOrEqual(8900);
	fs.appendFileSync(path.join(root, "hosts.jsonl"), JSON.stringify({ label, pid: child.pid, port }) + "\n");
	return result;
}

async function parked(h: Host, lane: string) {
	return until(() => h.events.find((event) => event.event === "parked" && event.lane === lane), `${lane} parked`);
}

async function original(h: Host, s: ReturnType<typeof scenario>) {
	const created = await h.rpc("start", { command: s.command });
	const runId: string = created.runId;
	await until(() => lines(s.counter)[0], "real command startup");
	const initial = await h.rpc("inspect", { runId });
	expect(initial.operations).toHaveLength(1);
	const opId: string = initial.operations[0].opId;
	const resultPath = path.join(s.root, "runs", runId, "operations", opId, "result.json");
	return { runId, opId, initial, resultPath };
}

function assertConsumed(state: any, opId: string, nonce: string) {
	expect(Object.keys(state.consumedResults)).toEqual([opId]);
	expect(state.consumedResults[opId]).toMatchObject({ round: 1, stage: "validate" });
	expect(state.consumedResults[opId].digest).toMatch(/^[a-f0-9]{64}$/);
	expect(state.validatedRound).toBe(1);
	expect(state.history).toHaveLength(1);
	expect(state.history[0]).toMatchObject({ round: 1, verdict: "pass", code: 0, metricGateOk: true });
	expect(state.lastEvidence).toContain("score=42");
	expect(state.lastEvidence).toContain(nonce);
	expect(state.lastVerdict).toBe("pass");
	expect(state.lastCode).toBe(0);
	expect(state.lastMetrics).toEqual({ score: 42 });
	expect(state.bestRound?.round).toBe(1);
}

async function cleanup(s: ReturnType<typeof scenario>, hosts: Host[], runId?: string) {
	// Release only our command. Stop uses the product API, not a PID name search.
	s.release();
	const live = [...hosts].reverse().find((h) => h.child.exitCode === null && !h.child.signalCode);
	try {
		if (live && runId) await live.http(runId, "stop").catch(() => {});
	} finally {
		for (const h of hosts) await killHost(h.child);
		console.info(`F2 evidence retained: ${s.root}`);
	}
}

for (const stopBeforeWaiter of [false, true]) {
	it(`R04/S06: real waiter + observer, ${stopBeforeWaiter ? "heartbeat → stop → late waiter" : "both released together"}`, async () => {
		const s = scenario();
		const hosts: Host[] = [];
		let runId: string | undefined;
		try {
			const a = await host(s.root, "A", "race", hosts);
			const started = await original(a, s);
			runId = started.runId;
			const { opId, initial, resultPath } = started;
			await parked(a, "waiter");
			const observing = a.rpc("observe", { runId });
			await parked(a, "observer");
			const leaseBefore = s.lease(runId);
			await a.control("heartbeat");
			const renewed = s.lease(runId);
			expect(renewed).toMatchObject({ owner: initial.state.owner, generation: initial.state.generation });
			expect(Date.parse(renewed.heartbeatAt)).toBeGreaterThan(Date.parse(leaseBefore.heartbeatAt));
			expect(s.state(runId)).toEqual(initial.state);
			s.release();
			await until(() => (fs.existsSync(resultPath) ? true : undefined), "immutable real result");
			expect(json(resultPath)).toMatchObject({ code: 0, groupGone: true });
			if (stopBeforeWaiter) {
				await a.control("release", { lanes: ["observer"] });
				await observing;
				const consumed = s.state(runId);
				assertConsumed(consumed, opId, s.nonce);
				await a.control("heartbeat");
				expect(s.state(runId)).toEqual(consumed);
				expect(s.lease(runId)).toMatchObject({ owner: consumed.owner, generation: consumed.generation });
				const stopped = await a.http(runId, "stop");
				expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
				expect(stopped.body.stopRequestedAt).toBeTruthy();
				expect(stopped.body.stopConfirmedAt).toBeTruthy();
				const stoppedState = s.state(runId);
				// Simulate a tick already queued before stop cleared its timer.
				await a.control("heartbeat");
				expect(s.state(runId)).toEqual(stoppedState);
				expect(fs.existsSync(path.join(s.root, "runs", runId, "lease.json"))).toBe(false);
				await a.control("release", { lanes: ["waiter"] });
				await until(
					() =>
						lines(path.join(s.root, "runs", runId!, "journal.jsonl")).find(
							(entry) => entry.event === "late-callback-dropped",
						),
					"late waiter fenced",
				);
				const final = await a.rpc("duplicate", { runId });
				assertConsumed(final, opId, s.nonce);
				expect(final).toEqual(stoppedState);
				expect(final).toMatchObject({
					status: "stopped",
					stage: "stopped",
					stopReason: "user-stop",
					owner: consumed.owner,
					generation: consumed.generation,
					epoch: consumed.epoch + 1,
					attemptId: initial.state.attemptId,
					history: consumed.history,
					consumedResults: consumed.consumedResults,
					lastMetrics: consumed.lastMetrics,
					bestRound: consumed.bestRound,
				});
				expect(final.acceptance).toBeNull();
			} else {
				// Both real polling promises resume within one IPC turn. Neither
				// consumer is invoked with fabricated raw output or a mocked store.
				await a.control("release", { lanes: ["waiter", "observer"] });
				await observing;
				await until(() => (s.state(runId!).validatedRound === 1 ? true : undefined), "result consumed");
				assertConsumed(s.state(runId), opId, s.nonce);
				await until(
					() => (a.events.filter((event) => event.event === "consumption-entered").length === 2 ? true : undefined),
					"both production consumers entered",
				);
				expect(
					a.events
						.filter((event) => event.event === "consumption-entered")
						.map((event) => event.lane)
						.sort(),
				).toEqual(["observer", "waiter"]);
				// Explicit continuation covers an observer winning the commit;
				// an already completed normal callback must also be idempotent.
				const final = await a.rpc("duplicate", { runId });
				assertConsumed(final, opId, s.nonce);
				expect(final).toMatchObject({
					status: "done",
					acceptance: "passed-validator-only",
					generation: initial.state.generation,
					attemptId: initial.state.attemptId,
				});
			}
			const inspected = await a.rpc("inspect", { runId });
			expect(inspected.operations).toHaveLength(1);
			expect(inspected.operations[0].opId).toBe(opId);
			expect(inspected.state.consumedResults[opId].digest).toBe(inspected.operations[0].resultDigest);
			expect(lines(s.counter)).toEqual([expect.objectContaining({ nonce: s.nonce })]);
			expect(a.events.filter((event) => event.event === "consumption-committed")).toHaveLength(1);
			expect(a.events.filter((event) => event.event === "done-committed")).toHaveLength(stopBeforeWaiter ? 0 : 1);
			expect(
				lines(path.join(s.root, "runs", runId, "journal.jsonl")).filter((entry) => entry.event === "runtime-error"),
			).toHaveLength(0);
			fs.writeFileSync(
				path.join(s.root, "evidence.json"),
				JSON.stringify({ initial, inspected, events: a.events }, null, 2),
			);
		} finally {
			await cleanup(s, hosts, runId);
		}
	}, 45000);
}

it("R05: SIGKILL B before consumption rename → C applies the same durable result exactly once", async () => {
	const s = scenario();
	const hosts: Host[] = [];
	let runId: string | undefined;
	try {
		const a = await host(s.root, "A", "race", hosts);
		const started = await original(a, s);
		runId = started.runId;
		const { opId, initial, resultPath } = started;
		await parked(a, "waiter");
		await killHost(a.child);
		s.release();
		await until(() => (fs.existsSync(resultPath) ? true : undefined), "result after A death");
		const rawResult = fs.readFileSync(resultPath, "utf8");
		const b = await host(s.root, "B", "crash", hosts);
		const recovery = await b.http(runId, "recover");
		expect(recovery.status, JSON.stringify(recovery.body)).toBe(200);
		expect(recovery.body).toMatchObject({ takeover: true, resumeEligible: true, inFlightOpId: opId });
		await b.control("arm");
		const observing = b.rpc("observe", { runId });
		const barrierPath = path.join(s.root, "B-before-consume.json");
		await until(() => (fs.existsSync(barrierPath) ? true : undefined), "B fsynced consumption before rename");
		const barrier = json(barrierPath);
		expect(barrier.pid).toBe(b.child.pid);
		expect(barrier.added).toEqual([opId]);
		assertConsumed(barrier.next, opId, s.nonce);
		expect(barrier.previous.history).toHaveLength(0);
		expect(barrier.previous.consumedResults?.[opId]).toBeUndefined();
		expect(s.state(runId)).toEqual(barrier.previous);
		await killHost(b.child);
		await expect(observing).rejects.toThrow("Host B exited");
		expect(s.state(runId)).toEqual(barrier.previous);
		expect(fs.readFileSync(resultPath, "utf8")).toBe(rawResult);
		const c = await host(s.root, "C", "plain", hosts);
		const disk = await c.rpc("inspect", { runId });
		expect(disk.state).toEqual(barrier.previous);
		const resumed = await c.rpc("resume", { runId });
		assertConsumed(resumed.state, opId, s.nonce);
		expect(resumed.state).toMatchObject({
			status: "done",
			acceptance: "passed-validator-only",
			attemptId: initial.state.attemptId,
			round: 1,
		});
		expect(resumed.state.generation).toBeGreaterThan(barrier.previous.generation);
		const final = await c.rpc("duplicate", { runId });
		expect(final).toEqual(resumed.state);
		expect(await c.rpc("observe", { runId })).toBeNull();
		const inspected = await c.rpc("inspect", { runId });
		expect(inspected.operations).toHaveLength(1);
		expect(inspected.operations[0].opId).toBe(opId);
		expect(final.consumedResults[opId].digest).toBe(barrier.next.consumedResults[opId].digest);
		expect(final.consumedResults[opId].digest).toBe(inspected.operations[0].resultDigest);
		expect(fs.readFileSync(resultPath, "utf8")).toBe(rawResult);
		expect(lines(s.counter)).toEqual([expect.objectContaining({ nonce: s.nonce })]);
		expect(
			lines(path.join(s.root, "barriers.jsonl")).filter((entry) => entry.event === "consumption-committed"),
		).toEqual([expect.objectContaining({ host: "C", added: [opId] })]);
		expect((await c.http(runId, "detail")).status).toBe(200);
		fs.writeFileSync(
			path.join(s.root, "evidence.json"),
			JSON.stringify({ initial, recovery, barrier, disk, inspected }, null, 2),
		);
	} finally {
		await cleanup(s, hosts, runId);
	}
}, 60000);
