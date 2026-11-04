import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import express from "express";
import { afterAll, describe, expect, it, vi } from "vitest";
import { normalizeTaskInputs, resolveTaskContext } from "../../server/loop/discovery.js";

const root = mkdtempSync(join(tmpdir(), "inputs-f5-runs-"));
const ws = realpathSync(mkdtempSync(join(tmpdir(), "inputs-f5-workspace-")));
const oldRoot = process.env.MINI_HARNESS_RUNTIME_ROOT;
process.env.MINI_HARNESS_RUNTIME_ROOT = root;
const { ClientSession } = await import("../../server/agent-service.js");
const { loadLoopState, stopLeaseHeartbeat } = await import("../../server/loop/extension.js");
const { registerLoopRoutes } = await import("../../server/loop/routes.js");
if (oldRoot === undefined) delete process.env.MINI_HARNESS_RUNTIME_ROOT;
else process.env.MINI_HARNESS_RUNTIME_ROOT = oldRoot;
const runs: string[] = [];
let server: Server | undefined;
let base = "";
let sequence = 0;
afterAll(async () => {
	for (const run of runs) stopLeaseHeartbeat(run);
	if (server)
		await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
	rmSync(root, { recursive: true, force: true });
	rmSync(ws, { recursive: true, force: true });
});

function session() {
	const conv: any = { session: { sessionId: `f5-${++sequence}` }, runtime: { cwd: ws }, cwd: ws };
	const cs = Object.create(ClientSession.prototype) as any;
	cs.convs = new Map([["main", conv]]);
	cs.activeId = "main";
	cs.cwd = ws;
	cs.emitNotice = vi.fn();
	cs.flushSnapshot = vi.fn();
	cs.prompt = vi.fn(async () => {});
	cs.startWorktreeExecutor = vi.fn(async () => {});
	cs.startExecutorInWorkspace = vi.fn(async () => {});
	return { cs, conv };
}
async function start(patch: Record<string, unknown>) {
	const result = session();
	await result.cs.startLoop({
		goal: "fixture",
		workspace: ws,
		packId: "cache-loss",
		useReviewer: false,
		worktree: false,
		...patch,
	});
	if (result.conv.loop?.runId) runs.push(result.conv.loop.runId);
	return result;
}
async function post(body: unknown) {
	if (!server) {
		const app = express();
		app.use(express.json());
		registerLoopRoutes(app, { dataDir: root, agentDir: root });
		// Binding itself reserves an available isolated port; never touches running services.
		for (let port = 19090; port < 19110; port++) {
			try {
				server = await new Promise<Server>((resolve, reject) => {
					const candidate = app.listen(port, "127.0.0.1", () => resolve(candidate));
					candidate.once("error", reject);
				});
				base = `http://127.0.0.1:${port}`;
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
			}
		}
		if (!server) throw new Error("no free fixture port");
	}
	const response = await fetch(`${base}/api/mini-harness/discover`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: (await response.json()) as any };
}

describe("F5 production input entry points", () => {
	it.each([
		{ validateCmd: "printf fixture" },
		{ inputs: { validateCmd: "printf fixture" } },
		{ validateCmd: "printf fixture", inputs: { validateCmd: "printf fixture" } },
		{ validateCmd: " \n ", inputs: { validateCmd: "printf fixture", count: 0, enabled: false } },
	])("I01/I02/I03 creates through startLoop with normalized command: %j", async (patch) => {
		const { cs, conv } = await start(patch);
		expect(conv.loop.kind).toBe("run");
		const state = loadLoopState(conv.loop.runId)!;
		expect(state.validateCmd).toBe("printf fixture");
		expect(state.workspace).toBe(ws);
		expect(cs.prompt).toHaveBeenCalledOnce();
		expect(execFileSync("bash", ["-c", state.validateCmd!], { cwd: state.workspace }).toString()).toBe("fixture");
	});

	it.each([
		{ validateCmd: "true", inputs: { validateCmd: "false" } },
		{ validateCmd: false },
		{ inputs: [] },
		{ inputs: { validateCmd: {} } },
		{ validateCmd: "true", hardConstraints: [{ name: "acc", metric: "acc", op: "gte", value: "1" }] },
		{ validateCmd: "true", hardConstraints: [{ name: "acc", metric: "acc", op: "eq", value: 1 }] },
		{ validateCmd: "true", hardConstraints: [{ name: "acc", metric: "acc", op: "gte", value: false }] },
		{ validateCmd: "true", hardConstraints: [null] },
	])("I03/I08 rejects invalid request before discovery/run creation: %j", async (patch) => {
		const { cs, conv } = await start(patch);
		expect(conv.loop.kind).toBe("request-failed");
		expect(conv.loop.reason).toMatch(/冲突|非法|必须/);
		expect(cs.prompt).not.toHaveBeenCalled();
	});

	it("preserves shell whitespace, scalar zero/false, and rejects nonfinite values", () => {
		const command = "  printf '%s' 'tail ' \\\n  ";
		const normalized = normalizeTaskInputs({
			validateCmd: command,
			inputs: { count: 0, enabled: false, blank: " ", nil: null },
		});
		expect(normalized.ok).toBe(true);
		expect(normalized.validateCmd).toBe(command);
		expect(normalized.inputs).toEqual({ validateCmd: command, count: "0", enabled: "false" });
		expect(normalizeTaskInputs({ inputs: { number: Number.NaN } }).ok).toBe(false);
		expect(
			normalizeTaskInputs({ validateCmd: command, inputs: { validateCmd: command.trim() } }).conflicts[0]?.field,
		).toBe("validateCmd");
		expect(
			normalizeTaskInputs({
				inputs: { pod: "one" },
				topLevelExtras: { pod: "two" },
			}).conflicts[0]?.field,
		).toBe("pod");
	});

	it("I01 persists the exact command bytes through startLoop/createLoopRun", async () => {
		const validateCmd = "printf '%s' end\\ ";
		const { conv } = await start({ validateCmd });
		expect(conv.loop.kind).toBe("run");
		const state = loadLoopState(conv.loop.runId)!;
		expect(state.validateCmd).toBe(validateCmd);
		expect(execFileSync("bash", ["-c", state.validateCmd!], { cwd: state.workspace }).toString()).toBe("end ");
	});

	it("I04 candidates never become confirmed; API start rechecks changed inputs", async () => {
		writeFileSync(join(ws, "run.py"), "print('candidate')");
		const preview = await post({ packId: "cache-loss", workspace: ws });
		expect(preview.body.context.missing.some((item: any) => item.id === "validateCmd")).toBe(true);
		expect(preview.body.context.candidates.some((item: any) => item.inputId === "validateCmd")).toBe(true);
		const good = await post({ packId: "cache-loss", workspace: ws, validateCmd: "true" });
		expect(good.body.context.missing).toEqual([]);
		const { conv } = await start({ validateCmd: "", inputs: {} });
		expect(conv.loop.kind).toBe("request-failed");
		expect(conv.loop.reason).toContain("validateCmd");
	});

	it("I01/I03 HTTP uses same normalization, preserves raw command and returns field errors", async () => {
		const command = "printf 'fixture' \\\n ";
		const response = await post({
			packId: "cache-loss",
			workspace: ws,
			validateCmd: command,
			precheckCmd: "true",
			inputs: { count: 0, enabled: false },
		});
		expect(response.status).toBe(200);
		expect(response.body.context.normalizedInputs).toMatchObject({
			validateCmd: command,
			precheckCmd: "true",
			count: "0",
			enabled: "false",
		});
		expect(response.body.context.inputs.find((item: any) => item.id === "validateCmd")).toMatchObject({
			confirmed: true,
			source: "user",
			value: command,
		});
		for (const patch of [
			{ validateCmd: "one", inputs: { validateCmd: "two" } },
			{ inputs: [] },
			{ validateCmd: 0 },
			{ hardConstraints: [{ name: "x", metric: "x", op: "gte", value: false }] },
		]) {
			const bad = await post({ packId: "cache-loss", workspace: ws, ...patch });
			expect(bad.status).toBe(400);
			expect(bad.body.error).toBeTruthy();
		}
	});

	it("I05/I07 validates directory and unknown pack, accepts ordinary no-metric task and saved inputs", async () => {
		expect((await post({ packId: "missing", workspace: ws })).status).toBe(404);
		expect((await post({ packId: "cache-loss", workspace: join(ws, "missing") })).status).toBe(404);
		const { conv } = await start({ packId: undefined, validateCmd: "true" });
		expect(conv.loop.kind).toBe("run");
		expect(loadLoopState(conv.loop.runId)?.primaryMetric).toBeNull();
		const saved = normalizeTaskInputs({ validateCmd: "true", inputs: { enabled: false } }).inputs;
		expect(resolveTaskContext("cache-loss", ws, saved).normalizedInputs).toMatchObject(saved);
	});
});
