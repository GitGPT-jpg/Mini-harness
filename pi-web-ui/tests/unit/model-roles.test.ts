/**
 * 新任务角色解析（server/loop/model-roles.ts）与预检接口 POST /api/mini-harness/roles。
 * 假模型目录（临时 agentDir），零 token。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "model-roles-"));
const previousRunsRoot = process.env.MINI_HARNESS_RUNTIME_ROOT;
process.env.MINI_HARNESS_RUNTIME_ROOT = join(ROOT, "runs");
const { resolveTaskRoles } = await import("../../server/loop/model-roles.js");
const { registerLoopRoutes } = await import("../../server/loop/routes.js");
if (previousRunsRoot === undefined) delete process.env.MINI_HARNESS_RUNTIME_ROOT;
else process.env.MINI_HARNESS_RUNTIME_ROOT = previousRunsRoot;

type M = { provider: string; id: string };
const registry = (models: M[]) => ({
	find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
	getAll: () => models,
	getAvailable: () => models,
});
const CATALOG: M[] = [
	{ provider: "oneapi", id: "gpt-5" },
	{ provider: "oneapi", id: "glm-5.3" },
	{ provider: "oneapi", id: "glm-4.6" },
	{ provider: "oneapi", id: "deepseek-v4" },
	{ provider: "other", id: "GPT-5" },
];
const reg = registry(CATALOG);
const gpt = { provider: "oneapi", id: "gpt-5" };
const glm = { provider: "oneapi", id: "glm-5.3" };

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("resolveTaskRoles：仅模型评审（llm）", () => {
	it("规划 A、执行 A、审查 B：没有独立规划约束，成功；审查用指定的 B", () => {
		const r = resolveTaskRoles(reg, glm, {
			mode: "llm",
			planner: "oneapi/gpt-5",
			executor: "oneapi/gpt-5",
			reviewer: "oneapi/glm-5.3",
		});
		expect(r.ok).toBe(true);
		expect(r.roles.reviewer).toMatchObject({ id: "glm-5.3", family: "zhipu", source: "explicit" });
		expect(r.roles.executor).toMatchObject({ id: "gpt-5", family: "openai" });
		expect(r.conflicts).toEqual([]);
	});

	it("规划 A、执行 B、审查 B：明确报执行与审查冲突（两个角色、实际模型、家族）", () => {
		const r = resolveTaskRoles(reg, gpt, {
			mode: "llm",
			planner: "oneapi/gpt-5",
			executor: "oneapi/glm-5.3",
			reviewer: "oneapi/glm-4.6",
		});
		expect(r.ok).toBe(false);
		expect(r.conflicts).toEqual([
			{ roles: ["executor", "reviewer"], family: "zhipu", models: ["oneapi/glm-5.3", "oneapi/glm-4.6"] },
		]);
		expect(r.message).toContain("执行模型 oneapi/glm-5.3");
		expect(r.message).toContain("审查模型 oneapi/glm-4.6");
		expect(r.suggestion).toMatchObject({ role: "reviewer", family: "openai" });
	});

	it("默认审查（跟随主对话）与执行同家族 → 冲突；改选另一家族审查即可启动，主模型不变", () => {
		const def = resolveTaskRoles(reg, gpt, { mode: "llm", executor: "oneapi/gpt-5" });
		expect(def.ok).toBe(false);
		expect(def.roles.reviewer).toMatchObject({ id: "gpt-5", source: "main" });
		const fixed = resolveTaskRoles(reg, gpt, { mode: "llm", executor: "oneapi/gpt-5", reviewer: "oneapi/deepseek-v4" });
		expect(fixed.ok).toBe(true);
		expect(fixed.roles.reviewer).toMatchObject({ id: "deepseek-v4", source: "explicit" });
	});

	it("旧客户端不传审查字段：审查=主对话（原默认语义），同样过家族校验", () => {
		expect(resolveTaskRoles(reg, gpt, { mode: "llm" }).conflicts[0]?.roles).toEqual(["executor", "reviewer"]);
		expect(resolveTaskRoles(reg, gpt, { mode: "llm", executor: "oneapi/glm-5.3" }).ok).toBe(true);
	});

	it("不同 provider 下同家族照样冲突；所选模型被移除 → 报无法解析而不是静默回落", () => {
		const r = resolveTaskRoles(reg, gpt, { mode: "llm", executor: "oneapi/gpt-5", reviewer: "other/GPT-5" });
		expect(r.conflicts[0]).toMatchObject({ family: "openai" });
		const gone = resolveTaskRoles(reg, gpt, { mode: "llm", executor: "oneapi/glm-5.3", reviewer: "oneapi/removed" });
		expect(gone).toMatchObject({ ok: false, error: { code: "unresolved", role: "reviewer" } });
	});

	it("只有一个可用家族：报冲突且没有可替换的建议，说明需要补哪类配置", () => {
		const one = registry([gpt, { provider: "oneapi", id: "gpt-5-mini" }]);
		const r = resolveTaskRoles(one, gpt, { mode: "llm" });
		expect(r.ok).toBe(false);
		expect(r.suggestion).toBeNull();
	});
});

describe("resolveTaskRoles：代码验收", () => {
	it("代码 + 模型审查：执行=主对话；规划/审查自动挑选时避开执行与彼此的家族", () => {
		const r = resolveTaskRoles(reg, gpt, { mode: "code-review" });
		expect(r.ok).toBe(true);
		expect(r.roles.executor).toMatchObject({ id: "gpt-5", source: "main" });
		expect(r.roles.planner).toMatchObject({ family: "zhipu", source: "auto" });
		expect(r.roles.reviewer).toMatchObject({ family: "deepseek", source: "auto" });
	});

	it("审查与执行同家族 → 冲突指向执行/审查；与规划同家族 → 冲突指向规划/审查；保留既有规划约束", () => {
		const execRev = resolveTaskRoles(reg, gpt, { mode: "code-review", reviewer: "other/GPT-5" });
		expect(execRev.conflicts[0]?.roles).toEqual(["executor", "reviewer"]);
		expect(execRev.suggestion?.role).toBe("reviewer");
		const planRev = resolveTaskRoles(reg, gpt, {
			mode: "code-review",
			planner: "oneapi/glm-5.3",
			reviewer: "oneapi/glm-4.6",
		});
		expect(planRev.conflicts[0]?.roles).toEqual(["planner", "reviewer"]);
		const planExec = resolveTaskRoles(reg, gpt, { mode: "code", planner: "other/GPT-5" });
		expect(planExec.conflicts[0]?.roles).toEqual(["executor", "planner"]);
		expect(planExec.message).toContain("规划模型");
	});

	it("仅代码验收：没有审查角色，残留的审查选择不参与解析也不阻断", () => {
		const r = resolveTaskRoles(reg, gpt, { mode: "code", reviewer: "other/GPT-5" });
		expect(r.ok).toBe(true);
		expect(r.roles.reviewer).toBeNull();
	});

	it("只有执行者一个家族：自动挑不到审查 → no-candidate，指明缺审查角色", () => {
		const one = registry([gpt]);
		const r = resolveTaskRoles(one, gpt, { mode: "code-review" });
		expect(r).toMatchObject({ ok: false, error: { code: "no-candidate", role: "reviewer" } });
		expect(r.message).toContain("审查");
		expect(resolveTaskRoles(one, gpt, { mode: "code" }).ok).toBe(true);
	});
});

describe("resolveTaskRoles：三个角色显式 / 自动联立", () => {
	const fams = (r: ReturnType<typeof resolveTaskRoles>) =>
		(["planner", "executor", "reviewer"] as const).map((k) => r.roles[k]?.family ?? null);

	it("三个都选「自动」：执行优先主对话，规划 / 审查联立分配，三者两两不同家族", () => {
		const r = resolveTaskRoles(reg, gpt, { mode: "code-review", planner: "auto", executor: "auto", reviewer: "auto" });
		expect(r.ok).toBe(true);
		expect(r.roles.executor).toMatchObject({ id: "gpt-5", source: "main" });
		expect(r.roles.planner?.source).toBe("auto");
		expect(r.roles.reviewer?.source).toBe("auto");
		expect(new Set(fams(r)).size).toBe(3);
	});

	it("显式执行模型不同于主对话：自动角色避开执行模型的家族，可以用主对话的家族", () => {
		const r = resolveTaskRoles(reg, glm, { mode: "code-review", executor: "oneapi/gpt-5" });
		expect(r.ok).toBe(true);
		expect(r.roles.executor).toMatchObject({ id: "gpt-5", source: "explicit" });
		expect(fams(r)).not.toContain(null);
		expect(new Set(fams(r)).size).toBe(3);
		const llm = resolveTaskRoles(reg, glm, { mode: "llm", executor: "oneapi/gpt-5", reviewer: "auto" });
		expect(llm.roles.reviewer).toMatchObject({ id: "glm-5.3", source: "main" });
	});

	it("显式执行与显式审查同家族：点名执行 / 审查，建议替换审查", () => {
		const r = resolveTaskRoles(reg, glm, { mode: "code-review", executor: "oneapi/gpt-5", reviewer: "other/GPT-5" });
		expect(r.ok).toBe(false);
		expect(r.conflicts[0]?.roles).toEqual(["executor", "reviewer"]);
		expect(r.suggestion?.role).toBe("reviewer");
		expect(r.suggestion?.family).not.toBe("openai");
		expect(r.message).toContain("执行模型");
	});

	it("只有两个家族：三角色凑不齐 → 点名缺审查、列出要避开的家族；切到仅代码验证或仅模型评审可启动", () => {
		const two = registry([gpt, glm]);
		const r = resolveTaskRoles(two, gpt, { mode: "code-review", planner: "auto", executor: "auto", reviewer: "auto" });
		expect(r).toMatchObject({ ok: false, error: { code: "no-candidate", role: "reviewer" } });
		expect(r.message).toContain("openai");
		expect(r.message).toContain("zhipu");
		expect(resolveTaskRoles(two, gpt, { mode: "code", planner: "auto", executor: "auto", reviewer: "auto" }).ok).toBe(
			true,
		);
		const llm = resolveTaskRoles(two, gpt, { mode: "llm", planner: "auto", executor: "auto", reviewer: "auto" });
		expect(llm.ok).toBe(true);
		expect(llm.roles.reviewer?.family).toBe("zhipu");
		expect(llm.message).toBe("");
	});

	it("模式切换：同一组选择按各自的隔离规则解析", () => {
		const pick = { planner: "oneapi/glm-5.3", executor: "oneapi/gpt-5", reviewer: "oneapi/glm-4.6" };
		const cr = resolveTaskRoles(reg, gpt, { mode: "code-review", ...pick });
		expect(cr.conflicts.map((c) => c.roles)).toEqual([["planner", "reviewer"]]);
		const code = resolveTaskRoles(reg, gpt, { mode: "code", ...pick });
		expect(code.ok).toBe(true);
		expect(code.roles.reviewer).toBeNull();
		const llm = resolveTaskRoles(reg, gpt, { mode: "llm", ...pick });
		expect(llm.ok).toBe(true);
		expect(llm.roles.planner?.family).toBe("zhipu");
	});

	it("所选执行模型已失效：报执行无法解析，不静默回落主对话", () => {
		const r = resolveTaskRoles(reg, gpt, { mode: "code-review", executor: "oneapi/removed-model" });
		expect(r).toMatchObject({ ok: false, error: { code: "unresolved", role: "executor" } });
		expect(r.roles.executor).toBeNull();
		expect(r.message).toContain("执行模型无法解析");
	});
});

describe("POST /api/mini-harness/roles", () => {
	let server: Server;
	let base = "";
	beforeAll(async () => {
		const agentDir = join(ROOT, "agent");
		const dataDir = join(ROOT, "data");
		for (const d of [agentDir, dataDir]) rmSync(d, { recursive: true, force: true });
		const { mkdirSync } = await import("node:fs");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					oneapi: {
						baseUrl: "http://127.0.0.1:9/v1",
						api: "openai-completions",
						apiKey: "fake-key",
						models: [{ id: "gpt-5" }, { id: "glm-5.3" }, { id: "deepseek-v4" }],
					},
				},
			}),
		);
		const app = express();
		app.use(express.json());
		registerLoopRoutes(app, { dataDir, agentDir, cluster: { env: {}, home: dataDir } });
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((r) => server.once("listening", () => r()));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(() => server?.close());
	const post = (body: unknown) =>
		fetch(`${base}/api/mini-harness/roles`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

	it("按服务端模型目录解析，冲突与建议结构化返回；坏 mode 400", async () => {
		const r = await (await post({ mode: "llm", main: "oneapi/gpt-5", executor: "oneapi/gpt-5" })).json();
		expect(r).toMatchObject({ ok: false, conflicts: [{ roles: ["executor", "reviewer"], family: "openai" }] });
		expect(r.suggestion).toMatchObject({ role: "reviewer", provider: "oneapi" });
		const ok = await (
			await post({ mode: "llm", main: "oneapi/gpt-5", executor: "oneapi/gpt-5", reviewer: "oneapi/glm-5.3" })
		).json();
		expect(ok.ok).toBe(true);
		const code = await (await post({ mode: "code-review", main: "oneapi/gpt-5" })).json();
		expect(code.roles.planner.source).toBe("auto");
		expect(code.roles.reviewer.source).toBe("auto");
		expect(code.ok).toBe(true);
		// 主对话模型不在目录里（扩展注册的 provider）：仍按 id 归类参与比较
		const ext = await (await post({ mode: "llm", main: "cliproxy/glm-9", reviewer: "oneapi/glm-5.3" })).json();
		expect(ext.conflicts[0]).toMatchObject({ family: "zhipu" });
		expect((await post({ mode: "nope" })).status).toBe(400);
		expect(JSON.stringify(r)).not.toContain("fake-key");
	});
});
