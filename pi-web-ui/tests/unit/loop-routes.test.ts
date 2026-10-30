/**
 * Loop 任务台后端：/api/mini-harness/* 路由 + LLM loop 永久目录（goal-history.jsonl）。
 * 全部跑在 mkdtemp 隔离目录里，不碰真实 ~/.pi-web / ~/.pi/agent。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectModels, parseToolTimeline, registerLoopRoutes } from "../../server/loop/routes.js";
import { configureGoalLog, deleteGoalLog, listGoalLog, recordGoalEvent } from "../../server/goal-history-log.js";

const entry = (kind: string, goal = "补齐 README") => ({
	convId: "conv-1",
	convTitle: "会话",
	goal,
	kind,
	phase: "executing",
	round: 1,
	verdict: "",
	status: "",
});

describe("goal-history-log", () => {
	it("未配置数据目录时不落盘（单测里 new GoalService 不会写用户目录）", () => {
		configureGoalLog(null);
		recordGoalEvent(entry("created"));
		expect(listGoalLog()).toEqual([]);
	});

	it("finished 复用 created 的 id，目录里一个目标只占一行；删除按 id 清掉全部记录", () => {
		const dir = mkdtempSync(join(tmpdir(), "goal-log-"));
		try {
			recordGoalEvent(entry("created"), dir);
			recordGoalEvent(entry("created", "另一个目标"), dir);
			recordGoalEvent({ ...entry("finished:pass"), verdict: "pass", round: 3 }, dir);
			const list = listGoalLog(300, dir);
			expect(list).toHaveLength(2);
			const done = list.find((r) => r.goal === "补齐 README")!;
			expect(done.kind).toBe("finished:pass");
			expect(done.verdict).toBe("pass");
			expect(done.round).toBe(3);
			expect(statSync(join(dir, "goal-history.jsonl")).mode & 0o777).toBe(0o600);
			expect(deleteGoalLog(done.id, dir)).toBe(2);
			expect(listGoalLog(300, dir).map((r) => r.goal)).toEqual(["另一个目标"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("parseToolTimeline", () => {
	it("toolCall 与 toolResult 配对，参数取首个有意义的字段", () => {
		const lines = [
			{
				timestamp: "t1",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "a", name: "bash", arguments: { command: "kubectl  get pods" } }],
				},
			},
			{
				message: {
					role: "toolResult",
					toolCallId: "a",
					isError: false,
					durationMs: 12,
					content: [{ type: "text", text: "ok\nall" }],
				},
			},
			{
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "b", name: "read", arguments: { path: "/x" } }],
				},
			},
			"not json",
		].map((l) => (typeof l === "string" ? l : JSON.stringify(l)));
		const ev = parseToolTimeline(lines.join("\n"));
		expect(ev).toHaveLength(2);
		expect(ev[0]).toMatchObject({
			name: "bash",
			arg: "kubectl get pods",
			status: "done",
			ms: 12,
			out: "ok all",
			at: "t1",
		});
		expect(ev[1]).toMatchObject({ name: "read", arg: "/x", status: "running" });
	});
});

describe("/api/mini-harness/*", () => {
	let server: Server;
	let base = "";
	let dataDir = "";
	let agentDir = "";
	const sid = "0f1e2d3c-aaaa-bbbb-cccc-1234567890ab";

	beforeAll(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "loop-routes-data-"));
		agentDir = mkdtempSync(join(tmpdir(), "loop-routes-agent-"));
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: { oneapi: { baseUrl: "https://secret", apiKey: "k", models: [{ id: "gpt-5" }, { id: "glm-4.6" }] } },
			}),
		);
		const sessDir = join(agentDir, "sessions", "--proj--");
		mkdirSync(sessDir, { recursive: true });
		writeFileSync(
			join(sessDir, `2026-10-30T00-00-00_${sid}.jsonl`),
			JSON.stringify({
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
				},
			}) + "\n",
		);
		recordGoalEvent(entry("created"), dataDir);
		const app = express();
		app.use(express.json());
		registerLoopRoutes(app, { dataDir, agentDir });
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((r) => server.once("listening", () => r()));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(() => {
		server?.close();
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});

	const post = (path: string, body: unknown) =>
		fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

	it("models 只给 provider/id/family，不带 baseUrl/密钥", async () => {
		const j = await (await fetch(`${base}/api/mini-harness/models`)).json();
		expect(j.models).toEqual([
			{ provider: "oneapi", id: "gpt-5", family: "openai" },
			{ provider: "oneapi", id: "glm-4.6", family: "zhipu" },
		]);
		expect(collectModels(join(agentDir, "missing"))).toEqual([]);
	});

	it("task 按 sessionId 找会话文件并返回时间线；sessionId 会被净化", async () => {
		const j = await (await fetch(`${base}/api/mini-harness/task?session=${sid}`)).json();
		expect(j.found).toBe(true);
		expect(j.events[0]).toMatchObject({ name: "bash", arg: "ls", status: "running" });
		const miss = await (await fetch(`${base}/api/mini-harness/task?session=../../etc`)).json();
		expect(miss).toEqual({ found: false, events: [] });
		expect((await fetch(`${base}/api/mini-harness/task`)).status).toBe(400);
	});

	it("goals 列表 + 删除（id 校验）", async () => {
		const j = await (await fetch(`${base}/api/mini-harness/goals`)).json();
		expect(j.goals).toHaveLength(1);
		expect((await post("/api/mini-harness/goals/delete", { id: "../x" })).status).toBe(400);
		const del = await (await post("/api/mini-harness/goals/delete", { id: j.goals[0].id })).json();
		expect(del).toEqual({ ok: true, removed: 1 });
	});

	it("runs/delete 拒绝非法 runId（防路径穿越）", async () => {
		expect((await post("/api/mini-harness/runs/delete", { runId: "../../.ssh" })).status).toBe(400);
		const j = await (await fetch(`${base}/api/mini-harness/runs?history=1`)).json();
		expect(Array.isArray(j.runs)).toBe(true);
	});

	it("cluster：未配置时报 not-configured；空 kubeconfig 拒绝；clear 幂等", async () => {
		const j = await (await fetch(`${base}/api/mini-harness/cluster`)).json();
		expect(j).toMatchObject({ configured: false, connected: false, code: "not-configured" });
		expect((await post("/api/mini-harness/cluster", { kubeconfig: "  " })).status).toBe(400);
		expect(await (await post("/api/mini-harness/cluster/clear", {})).json()).toEqual({ ok: true });
	});
});
