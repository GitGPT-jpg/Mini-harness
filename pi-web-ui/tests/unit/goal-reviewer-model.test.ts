/**
 * 「仅模型评审」的审查模型接线（GoalService）：显式审查模型在独立的只读审查对话里审、
 * 主对话模型不动；启动前与每轮审查前按 model-roles 规则复核执行 / 审查家族。
 * fake GoalHost + 真实 resolveTaskRoles（假模型目录），零 token。
 */
import { describe, expect, it } from "vitest";
import { GoalService, type GoalConversation, type GoalHost } from "../../server/goal-service.js";
import type { ServerMessage } from "../../server/protocol.js";
import { resolveTaskRoles } from "../../server/loop/model-roles.js";

type M = { provider: string; id: string };

function makeHarness(opts: { catalog?: M[]; reviewerActual?: (requested: string | null | undefined) => string } = {}) {
	let catalog: M[] = opts.catalog ?? [
		{ provider: "oneapi", id: "glm-5.3" },
		{ provider: "other", id: "glm-4.6" },
		{ provider: "oneapi", id: "gpt-5" },
		{ provider: "oneapi", id: "deepseek-v4" },
	];
	const sent: ServerMessage[] = [];
	const spawned: Array<{ id: string; role: string; model?: string | null; prompt: string }> = [];
	const mainSent: string[] = [];
	const stopped: string[] = [];
	const dismissed: string[] = [];
	const saved: unknown[] = [];
	const mainModelChanges: unknown[] = [];
	const clusterEvents: string[] = [];
	const models = new Map<string, string>();
	const convs = new Map<string, GoalConversation>();
	const registry = {
		find: (p: string, id: string) => catalog.find((m) => m.provider === p && m.id === id),
		getAll: () => catalog,
		getAvailable: () => catalog,
	};
	const mainModel = { provider: "oneapi", id: "glm-5.3" };
	const host: GoalHost = {
		clientId: "c",
		agentDir: "/tmp/agent",
		stateStore: {
			getGoalPrefs: () => null,
			saveGoalPrefs: (_c: string, p: unknown) => void saved.push(p),
		} as unknown as GoalHost["stateStore"],
		webUi: null as unknown as GoalHost["webUi"],
		emit: (m) => void sent.push(m),
		flushSnapshot: () => {},
		isDisposed: () => false,
		quiesceBlocked: () => false,
		activeConvId: () => "conv-a",
		activeConv: () => convs.get("conv-a")!,
		getConv: (id) => convs.get(id),
		cwd: () => "/tmp/proj",
		gitDiff: async () => `diff-${Math.random()}`,
		goalModeEnabled: () => true,
		lang: () => "zh",
		isGitRepo: async () => true,
		roleDeadlineMs: () => 1000,
		bindGoalCluster: async (convId) => void clusterEvents.push(`bind:${convId}`),
		releaseGoalCluster: (convId) => void clusterEvents.push(`release:${convId}`),
		spawnRoleAgent: async ({ role, prompt, model }) => {
			const id = `${role}-${spawned.length + 1}`;
			clusterEvents.push(`spawn:${role}`);
			spawned.push({ id, role, model, prompt });
			models.set(id, role === "reviewer" ? (opts.reviewerActual?.(model) ?? model ?? "") : (model ?? "oneapi/glm-5.3"));
			return id;
		},
		waitRoleAgent: async () => "done",
		sendRoleAgent: async (convId, message) => {
			if (convId === "conv-a") mainSent.push(message);
			return true;
		},
		readRoleAgent: (id) =>
			id.startsWith("reviewer")
				? { text: '{"verdict":"pass","feedback":"审查通过"}', model: models.get(id) }
				: { text: "已完成。", model: models.get(id) },
		stopRoleAgent: async (id) => void stopped.push(id),
		dismissRoleAgent: async (id) => void dismissed.push(id),
		hasConv: (id) => convs.has(id) || models.has(id),
		resolveGoalRoles: (_convId, req) =>
			resolveTaskRoles(registry, mainModel, { mode: "llm", executor: req.executor, reviewer: req.reviewer }),
	};
	const svc = new GoalService(host);
	const conv: GoalConversation = {
		id: "conv-a",
		title: "会话 A",
		cwd: "/tmp/proj",
		session: {
			isStreaming: false,
			isIdle: true,
			model: mainModel,
			setModel: async (m: unknown) => void mainModelChanges.push(m),
			sendUserMessage: async (text: string) => void mainSent.push(text),
			sendCustomMessage: async () => {},
			getLastAssistantText: () => "",
			getSessionStats: () => ({ totalMessages: 0 }),
		} as unknown as GoalConversation["session"],
		wizardRunning: false,
		goalGeneration: 0,
		goal: svc.makeGoalStatus(),
	};
	convs.set("conv-a", conv);
	const notices = () =>
		sent.filter((m): m is Extract<ServerMessage, { type: "notice" }> => m.type === "notice").map((m) => m.text);
	return {
		svc,
		conv,
		sent,
		spawned,
		mainSent,
		stopped,
		dismissed,
		saved,
		mainModelChanges,
		clusterEvents,
		notices,
		removeModel: (id: string) => (catalog = catalog.filter((m) => m.id !== id)),
	};
}

describe("仅模型评审：显式审查模型", () => {
	it("规划 A、执行 A、审查 B：审查在独立对话里用 B，主对话不收审查指令、聊天模型不变", async () => {
		const h = makeHarness();
		await h.svc.setGoal("写发布说明", {
			reviewModel: "oneapi/glm-5.3",
			maxRounds: 2,
			locked: true,
			execModel: "oneapi/glm-5.3",
			reviewerModel: "oneapi/gpt-5",
		});
		await h.svc.whenDelegatedSettled("conv-a");
		expect(h.spawned.map((s) => [s.role, s.model])).toEqual([
			["executor", "oneapi/glm-5.3"],
			["reviewer", "oneapi/gpt-5"],
		]);
		expect(h.spawned[1]!.prompt).toContain("写发布说明");
		expect(h.mainSent.some((t) => t.includes("verdict"))).toBe(false);
		expect(h.mainModelChanges).toEqual([]);
		expect(h.conv.goal.verdict).toBe("pass");
		// 收尾时执行与审查对话都移出
		expect(h.dismissed.sort()).toEqual(["executor-1", "reviewer-2"]);
		// 实际生效的审查模型随状态与偏好回读
		const status = h.sent.filter((m) => m.type === "goal_status").at(-1) as {
			status: { reviewerModel?: string | null };
		};
		expect(status.status.reviewerModel).toBe("oneapi/gpt-5");
		expect(h.saved.at(-1)).toMatchObject({ reviewerModel: "oneapi/gpt-5", execModel: "oneapi/glm-5.3" });
	});

	it("执行与审查同家族（跨 provider）：直接请求在启动前被拒，不派执行者、不改目标", async () => {
		const h = makeHarness();
		await h.svc.setGoal("写发布说明", {
			maxRounds: 1,
			locked: true,
			execModel: "oneapi/glm-5.3",
			reviewerModel: "other/glm-4.6",
		});
		expect(h.spawned).toEqual([]);
		expect(h.conv.goal.goal).toBeNull();
		expect(h.notices().at(-1)).toContain("执行模型 oneapi/glm-5.3 与审查模型 other/glm-4.6 同属 zhipu 家族");
		await h.svc.setGoal("写发布说明", {
			maxRounds: 1,
			locked: true,
			execModel: "oneapi/glm-5.3",
			reviewerModel: "oneapi/deepseek-v4",
		});
		await h.svc.whenDelegatedSettled("conv-a");
		expect(h.spawned.map((s) => s.role)).toEqual(["executor", "reviewer"]);
	});

	it("旧请求不带 reviewerModel：审查=主对话（原默认）并按主模型校验；执行另一家族时照旧由主对话审查", async () => {
		const h = makeHarness();
		await h.svc.setGoal("写发布说明", { maxRounds: 1, locked: true });
		expect(h.spawned).toEqual([]);
		expect(h.notices().at(-1)).toContain("同属 zhipu 家族");
		await h.svc.setGoal("写发布说明", { maxRounds: 1, locked: true, execModel: "oneapi/gpt-5" });
		// 主对话审查：等 verdict 的审查指令进了主对话；结论由 agent_end 送回
		await new Promise((r) => setTimeout(r, 20));
		expect(h.spawned.map((s) => s.role)).toEqual(["executor"]);
		expect(h.mainSent.some((t) => t.includes("verdict"))).toBe(true);
		await h.svc.clearGoal();
	});

	it("所选审查模型在目标进行中被移除：本轮审查前受阻并提示重新选择，不回落到主模型", async () => {
		const h = makeHarness();
		await h.svc.setGoal("写发布说明", {
			maxRounds: 1,
			locked: true,
			execModel: "oneapi/gpt-5",
			reviewerModel: "oneapi/deepseek-v4",
		});
		h.removeModel("deepseek-v4");
		await h.svc.whenDelegatedSettled("conv-a");
		expect(h.spawned.map((s) => s.role)).toEqual(["executor"]);
		expect(h.conv.goal.verdict).toBe("blocked");
		expect(h.conv.goal.feedback ?? h.conv.goal.status).toContain("审查模型无法解析");
	});

	it("宿主没能把审查对话切到所选模型（沿用了默认模型）：停掉该轮并受阻", async () => {
		const h = makeHarness({ reviewerActual: () => "oneapi/glm-5.3" });
		await h.svc.setGoal("写发布说明", {
			maxRounds: 1,
			locked: true,
			execModel: "oneapi/gpt-5",
			reviewerModel: "oneapi/deepseek-v4",
		});
		await h.svc.whenDelegatedSettled("conv-a");
		expect(h.stopped).toContain("reviewer-2");
		expect(h.conv.goal.verdict).toBe("blocked");
		expect(h.conv.goal.feedback ?? h.conv.goal.status).toContain("没能切换到所选模型 oneapi/deepseek-v4");
	});

	it("只有一个可用家族：默认组合被拒且没有可用替代", async () => {
		const h = makeHarness({ catalog: [{ provider: "oneapi", id: "glm-5.3" }] });
		await h.svc.setGoal("写发布说明", { maxRounds: 1, locked: true });
		expect(h.spawned).toEqual([]);
		expect(h.notices().at(-1)).toContain("同属 zhipu 家族");
	});

	it("偏好：set_goal_prefs 记住审查模型；目标进行中只记偏好、不改当前审查者", async () => {
		const h = makeHarness();
		await h.svc.setGoalPrefs({ reviewerModel: "oneapi/gpt-5" });
		expect(h.conv.goal.reviewerModel).toBe("oneapi/gpt-5");
		expect(h.saved.at(-1)).toMatchObject({ reviewerModel: "oneapi/gpt-5" });
		expect(h.svc.makeGoalStatus().reviewerModel).toBe("oneapi/gpt-5");
		await h.svc.setGoalPrefs({ reviewerModel: "" });
		expect(h.conv.goal.reviewerModel).toBeNull();
	});

	it("集群绑定：目标在派出执行者前绑定、收尾后释放；被拒的目标不绑定；清除目标释放", async () => {
		const h = makeHarness();
		await h.svc.setGoal("同家族", { maxRounds: 1, locked: true, execModel: "oneapi/glm-5.3" });
		expect(h.clusterEvents).toEqual([]);
		await h.svc.setGoal("写发布说明", {
			maxRounds: 1,
			locked: true,
			execModel: "oneapi/gpt-5",
			reviewerModel: "oneapi/deepseek-v4",
		});
		await h.svc.whenDelegatedSettled("conv-a");
		expect(h.clusterEvents).toEqual([
			"release:conv-a",
			"bind:conv-a",
			"spawn:executor",
			"spawn:reviewer",
			"release:conv-a",
		]);
		h.clusterEvents.length = 0;
		await h.svc.setGoal("再来一个", { maxRounds: 5, locked: true, execModel: "oneapi/gpt-5" });
		await h.svc.clearGoal();
		expect(h.clusterEvents[0]).toBe("release:conv-a");
		expect(h.clusterEvents[1]).toBe("bind:conv-a");
		expect(h.clusterEvents.at(-1)).toBe("release:conv-a");
	});
});
