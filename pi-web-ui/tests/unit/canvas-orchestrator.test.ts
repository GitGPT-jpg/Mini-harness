/**
 * canvas-orchestrator.test.ts — 画布协作调度器与存储单元测试。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDefaultCanvasGraph,
	listCanvasGraphs,
	loadCanvasGraph,
	saveCanvasGraph,
	deleteCanvasGraph,
} from "../../server/canvas/canvas-store.js";
import { CanvasOrchestrator } from "../../server/canvas/canvas-orchestrator.js";
import type { ServerMessage, CanvasNode, CanvasNodeRole, CanvasEdge, UiMessage } from "../../server/protocol.js";

/** 测试用节点工厂：严格类型，避免隐式 any */
function mkTestNode(id: string, role: CanvasNodeRole, extra?: Partial<CanvasNode>): CanvasNode {
	return {
		id,
		title: id,
		role,
		x: 0,
		y: 0,
		width: 300,
		engine: "pi",
		model: "test/model",
		cwd: ".",
		useWorktree: false,
		status: "idle",
		...extra,
	};
}

describe("Canvas Store & Default Squad", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-canvas-test-"));
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("应创建包含四大引擎的默认战队", () => {
		const def = createDefaultCanvasGraph();
		expect(def.nodes.length).toBe(4);
		expect(def.edges.length).toBe(4);

		const engines = new Set(def.nodes.map((n) => n.engine));
		expect(engines.has("pi")).toBe(true);
		expect(engines.has("dsh")).toBe(true);
		expect(engines.has("claude")).toBe(true);
		expect(engines.has("durable")).toBe(true);

		// 前后端节点开启了 Worktree 物理隔离
		const fe = def.nodes.find((n) => n.id === "node_fe");
		expect(fe?.useWorktree).toBe(true);
		expect(fe?.cwd).toBe("web");
	});

	it("支持画布保存、读取、列表与删除", () => {
		const def = createDefaultCanvasGraph("test_graph");
		saveCanvasGraph(tempDir, def);

		const loaded = loadCanvasGraph(tempDir, "test_graph");
		expect(loaded.id).toBe("test_graph");
		expect(loaded.nodes.length).toBe(4);

		const list = listCanvasGraphs(tempDir);
		expect(list.some((g) => g.id === "test_graph")).toBe(true);

		const deleted = deleteCanvasGraph(tempDir, "test_graph");
		expect(deleted).toBe(true);

		const listAfter = listCanvasGraphs(tempDir);
		expect(listAfter.some((g) => g.id === "test_graph")).toBe(false);
	});
});

describe("Canvas Orchestrator", () => {
	let tempDir: string;
	let orchestrator: CanvasOrchestrator;
	const events: ServerMessage[] = [];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-canvas-orch-"));
		orchestrator = new CanvasOrchestrator(tempDir, tempDir);
		events.length = 0;
		orchestrator.setBroadcaster((msg) => events.push(msg));
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("支持单节点启动与完成事件通知", async () => {
		const graph = createDefaultCanvasGraph("orch_test");
		saveCanvasGraph(tempDir, graph);

		const feNode = graph.nodes.find((n) => n.id === "node_fe")!;
		// 在测试环境下取消 worktree 以加速纯目录测试
		feNode.useWorktree = false;

		await orchestrator.runNode(graph, "node_fe");

		// 检查状态变更为 done
		expect(feNode.status).toBe("done");
		expect(events.some((e) => e.type === "canvas_node_event" && e.event === "started")).toBe(true);
		expect(events.some((e) => e.type === "canvas_node_event" && e.event === "done")).toBe(true);
	});

	it("支持运行中实时插话干预 (Steer)", () => {
		const graph = createDefaultCanvasGraph("steer_test");
		saveCanvasGraph(tempDir, graph);

		orchestrator.steerNode(graph.id, "node_architect", "注意必须支持移动端触控");

		const updated = loadCanvasGraph(tempDir, graph.id);
		const arch = updated.nodes.find((n) => n.id === "node_architect");
		expect(arch?.currentAction).toContain("收到人工插话指导");
		expect(arch?.currentAction).toContain("必须支持移动端触控");
	});

	it("审查回路防死循环熔断保护 (Review Loop Breaker)", async () => {
		const graph = createDefaultCanvasGraph("review_test");
		// 构造一个达到重试上限的 review 连线
		graph.edges = [
			{
				id: "edge_review_1",
				sourceNodeId: "node_qa",
				targetNodeId: "node_fe",
				type: "review",
				maxLoopRetries: 3,
				currentLoopCount: 3, // 已达 3 次
			},
		];
		saveCanvasGraph(tempDir, graph);

		const qaNode = graph.nodes.find((n) => n.id === "node_qa")!;
		qaNode.useWorktree = false;

		await orchestrator.runNode(graph, "node_qa");

		// 达到上限应触发 waiting_approval 暂停等待人工
		expect(qaNode.status).toBe("waiting_approval");
		expect(qaNode.currentAction).toContain("已达审查重试上限");
	});

	it("审查门禁真动作：批准/驳回落盘持久化并广播（issue #707）", () => {
		const graph = createDefaultCanvasGraph("review_gate_test");
		saveCanvasGraph(tempDir, graph);

		const approved = orchestrator.reviewNode(graph.id, "node_fe", "approve");
		expect(approved?.nodes.find((n) => n.id === "node_fe")?.status).toBe("done");
		expect(loadCanvasGraph(tempDir, graph.id).nodes.find((n) => n.id === "node_fe")?.status).toBe("done");
		// 批准后自动向下游流转：node_fe 的下游 node_qa 被拉起（started 事件）；对话实录的 log 事件照常记录
		expect(events.some((e) => e.type === "canvas_node_event" && e.nodeId === "node_qa")).toBe(true);
		expect(orchestrator["runningGraphs"].get(graph.id)?.nodes.find((n) => n.id === "node_qa")?.status).toBe("running");
		expect(events.some((e) => e.type === "canvas_node_log")).toBe(true);
		orchestrator.stopAll(graph.id); // 停掉批准后自动拉起的下游模拟执行，避免后台定时器跨用例干扰

		const rejected = orchestrator.reviewNode(graph.id, "node_architect", "reject", "缺测试");
		const arch = rejected?.nodes.find((n) => n.id === "node_architect");
		expect(arch?.status).toBe("waiting_approval");
		expect(arch?.currentAction).toContain("缺测试");
		expect(loadCanvasGraph(tempDir, graph.id).nodes.find((n) => n.id === "node_architect")?.currentAction).toContain(
			"缺测试",
		);

		expect(orchestrator.reviewNode(graph.id, "node_missing", "approve")).toBeNull();
		expect(orchestrator.reviewNode("../evil", "node_fe", "approve")).toBeNull();
	});

	it("引擎真实报错不得标记为已完成（403 RegionError 曾被当成功）", async () => {
		const graph = createDefaultCanvasGraph("engine_error_test");
		graph.executionMode = "real";
		const node = graph.nodes.find((n) => n.id === "node_fe")!;
		node.useWorktree = false;
		node.cwd = ".";
		saveCanvasGraph(tempDir, graph);

		// 假引擎：prompt 期间追加一条带 errorMessage 的 assistant 回合（模拟 API 403）
		const messages: UiMessage[] = [];
		const fakeEngine = {
			attach: async () => ({
				cwd: tempDir,
				setCwd: async () => {},
				abort: async () => {},
				prompt: async () => {
					messages.push({
						id: "a1",
						role: "assistant",
						content: [],
						stopReason: "error",
						errorMessage: 'opencode-go API error (403): {"type":"RegionError"}',
					});
				},
				readConversationForPlugins: () => ({ isStreaming: false, messages }),
			}),
			detach: () => {},
		};
		const orch = new CanvasOrchestrator(tempDir, tempDir, () => fakeEngine);
		const engineEvents: ServerMessage[] = [];
		orch.setBroadcaster((msg) => engineEvents.push(msg));

		await orch.runNode(graph, "node_fe");

		expect(node.status).toBe("error");
		expect(node.error).toContain("403");
		expect(engineEvents.some((e) => e.type === "canvas_node_event" && e.event === "done")).toBe(false);
		expect(engineEvents.some((e) => e.type === "canvas_node_event" && e.event === "error")).toBe(true);
	});

	it("历史遗留报错不得污染本轮判定（换模型重跑应能成功）", async () => {
		const graph = createDefaultCanvasGraph("engine_stale_error_test");
		graph.executionMode = "real";
		const node = graph.nodes.find((n) => n.id === "node_fe")!;
		node.useWorktree = false;
		node.cwd = ".";
		saveCanvasGraph(tempDir, graph);

		// 会话历史里留着上一轮失败（旧模型报的 403），本轮正常完成
		const messages: UiMessage[] = [
			{
				id: "a-old",
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "opencode-go API error (403): RegionError",
			},
		];
		const fakeEngine = {
			attach: async (clientId: string, sink: (msg: unknown) => void) => {
				// 真实服务端 attach 后会推带全量 history 的 snapshot（这里是旧模型留下的报错），
				// 报错采集必须只认本轮新增消息，否则一启动就假失败。
				sink({ type: "snapshot", clientId, state: { messages: [...messages] } });
				return {
					cwd: tempDir,
					setCwd: async () => {},
					abort: async () => {},
					prompt: async () => {
						messages.push({ id: "a-new", role: "assistant", content: [], stopReason: "end_turn" });
						sink({ type: "snapshot", clientId, state: { messages: [...messages] } });
					},
					readConversationForPlugins: () => ({ isStreaming: false, messages }),
				};
			},
			detach: () => {},
		};
		const orch = new CanvasOrchestrator(tempDir, tempDir, () => fakeEngine);
		orch.setBroadcaster(() => {});

		await orch.runNode(graph, "node_fe");

		expect(node.status).toBe("done");
		expect(node.error).toBeUndefined();
	});

	it("交付摘要取本轮 assistant 正文（无 message_delta 也不退化成占位文案）", async () => {
		const graph = createDefaultCanvasGraph("engine_reply_test");
		graph.executionMode = "real";
		// 只留源节点，避免下游真被拉起留下后台定时器
		const node = graph.nodes.find((n) => n.id === "node_fe")!;
		graph.nodes = [node];
		graph.edges = [];
		node.useWorktree = false;
		node.cwd = ".";
		saveCanvasGraph(tempDir, graph);

		// 不发 message_delta，只在快照里落正文（部分引擎/重连路径就是这么回的）
		const messages: UiMessage[] = [];
		const fakeEngine = {
			attach: async () => ({
				cwd: tempDir,
				setCwd: async () => {},
				abort: async () => {},
				prompt: async () => {
					messages.push({
						id: "a1",
						role: "assistant",
						content: [{ type: "text", text: "你好！有什么我可以帮你的吗？" }],
						stopReason: "end_turn",
					});
				},
				readConversationForPlugins: () => ({ isStreaming: false, messages }),
			}),
			detach: () => {},
		};
		const orch = new CanvasOrchestrator(tempDir, tempDir, () => fakeEngine);
		orch.setBroadcaster(() => {});

		await orch.runNode(graph, "node_fe");

		expect(node.lastOutputSummary).toContain("有什么我可以帮你的吗");
		expect(node.lastOutputSummary).not.toContain("未产生文件修改");
	});

	it("人工审批批准后只走批准边，不触发驳回回路", () => {
		const graph = createDefaultCanvasGraph("approve_filter_test");
		const h = mkTestNode("h", "human", { status: "waiting_approval" });
		graph.nodes = [h, mkTestNode("a", "end"), mkTestNode("b", "end")];
		graph.edges = [
			{ id: "e1", sourceNodeId: "h", targetNodeId: "a", type: "approve" },
			{ id: "e2", sourceNodeId: "h", targetNodeId: "b", type: "reject" },
		] as CanvasEdge[];
		saveCanvasGraph(tempDir, graph);

		orchestrator.reviewNode(graph.id, "h", "approve");
		expect(orchestrator.getNodeLog(graph.id, "a").some((e) => e.kind === "handoff")).toBe(true);
		expect(orchestrator.getNodeLog(graph.id, "b").some((e) => e.kind === "handoff")).toBe(false);
		orchestrator.stopAll(graph.id);
	});

	it("条件分支按关键词路由到 true/false 边", async () => {
		const mkGraph = (gid: string, summary: string) => {
			const graph = createDefaultCanvasGraph(gid);
			const cNode: CanvasNode = { ...mkTestNode("c", "condition"), config: { condition: "成功" } };
			graph.nodes = [mkTestNode("s", "trigger"), cNode, mkTestNode("t", "end"), mkTestNode("f", "end")];
			graph.edges = [
				{ id: "e0", sourceNodeId: "s", targetNodeId: "c", type: "handoff", lastHandoffSummary: summary },
				{ id: "e1", sourceNodeId: "c", targetNodeId: "t", type: "condition_true" },
				{ id: "e2", sourceNodeId: "c", targetNodeId: "f", type: "condition_false" },
			] as CanvasEdge[];
			saveCanvasGraph(tempDir, graph);
			return graph;
		};
		const gTrue = mkGraph("cond_true_test", "任务执行成功，无报错");
		await orchestrator.runNode(gTrue, "c");
		expect(orchestrator.getNodeLog(gTrue.id, "t").some((e) => e.kind === "handoff")).toBe(true);
		expect(orchestrator.getNodeLog(gTrue.id, "f").some((e) => e.kind === "handoff")).toBe(false);
		orchestrator.stopAll(gTrue.id);

		const gFalse = mkGraph("cond_false_test", "任务执行失败，需要回炉");
		await orchestrator.runNode(gFalse, "c");
		expect(orchestrator.getNodeLog(gFalse.id, "t").some((e) => e.kind === "handoff")).toBe(false);
		expect(orchestrator.getNodeLog(gFalse.id, "f").some((e) => e.kind === "handoff")).toBe(true);
		orchestrator.stopAll(gFalse.id);
	});

	it("定向输入端口标注进入提示词（targetPort=instruction）", async () => {
		const graph = createDefaultCanvasGraph("port_label_test");
		graph.nodes = [mkTestNode("s", "trigger"), mkTestNode("n", "coder")];
		graph.edges = [
			{
				id: "e0",
				sourceNodeId: "s",
				targetNodeId: "n",
				type: "handoff",
				targetPort: "instruction",
				lastHandoffSummary: "XYZ-789 定向487输入摘要",
			},
		] as CanvasEdge[];
		saveCanvasGraph(tempDir, graph);

		await orchestrator.runNode(graph, "n");
		const promptLog = orchestrator.getNodeLog(graph.id, "n").find((e) => e.kind === "prompt");
		expect(promptLog?.text).toContain("AI指令");
		expect(promptLog?.text).toContain("XYZ-789");
		orchestrator.stopAll(graph.id);
	});

	it("节点专属参数拼入提示词（所见即所得）", async () => {
		const graph = createDefaultCanvasGraph("cfg_prompt_test");
		const n: CanvasNode = { ...mkTestNode("n", "reviewer"), config: { strictness: "严格" } };
		graph.nodes = [mkTestNode("s", "trigger"), n];
		graph.edges = [
			{ id: "e0", sourceNodeId: "s", targetNodeId: "n", type: "handoff", lastHandoffSummary: "待审代码" },
		] as CanvasEdge[];
		saveCanvasGraph(tempDir, graph);

		await orchestrator.runNode(graph, "n");
		const promptLog = orchestrator.getNodeLog(graph.id, "n").find((e) => e.kind === "prompt");
		expect(promptLog?.text).toContain("专属参数");
		expect(promptLog?.text).toContain("严格");
		orchestrator.stopAll(graph.id);
	});

	it("格式转换节点本地执行（文本↔JSON / 模板）", async () => {
		const mkGraph = (gid: string, mode: string, summary: string, extra?: Record<string, string>) => {
			const graph = createDefaultCanvasGraph(gid);
			const t: CanvasNode = { ...mkTestNode("t", "transform"), config: { mode, ...(extra ?? {}) } };
			graph.nodes = [mkTestNode("s", "trigger"), t];
			graph.edges = [
				{ id: "e0", sourceNodeId: "s", targetNodeId: "t", type: "handoff", lastHandoffSummary: summary },
			] as CanvasEdge[];
			saveCanvasGraph(tempDir, graph);
			return graph;
		};
		const g1 = mkGraph("tf_text2json", "text2json", '{"a":1}');
		await orchestrator.runNode(g1, "t");
		expect(orchestrator.getNodeLog(g1.id, "t").some((e) => e.kind === "done" && e.text.includes('"a": 1'))).toBe(true);
		orchestrator.stopAll(g1.id);

		const g2 = mkGraph("tf_wrap", "text2json", "纯文本不是 JSON");
		await orchestrator.runNode(g2, "t");
		expect(
			orchestrator.getNodeLog(g2.id, "t").some((e) => e.kind === "done" && e.text.includes("纯文本不是 JSON")),
		).toBe(true);
		orchestrator.stopAll(g2.id);

		const g3 = mkGraph("tf_json2text", "json2text", '["x","y"]');
		await orchestrator.runNode(g3, "t");
		const done3 = orchestrator.getNodeLog(g3.id, "t").find((e) => e.kind === "done");
		expect(done3 && done3.text.includes("x") && done3.text.includes("y")).toBe(true);
		orchestrator.stopAll(g3.id);

		const g4 = mkGraph("tf_tpl", "template", "上游结论", { template: "报告：{{input}}（完）" });
		await orchestrator.runNode(g4, "t");
		expect(
			orchestrator.getNodeLog(g4.id, "t").some((e) => e.kind === "done" && e.text.includes("报告：上游结论")),
		).toBe(true);
		orchestrator.stopAll(g4.id);
	});

	it("触发器族纯直通（手动 / 定时 / Webhook 不启动 LLM）", async () => {
		const graph = createDefaultCanvasGraph("trigger_passthrough_test");
		graph.nodes = [
			{ ...mkTestNode("tri", "trigger"), config: { payload: '{"task":"demo"}' } },
			{ ...mkTestNode("cro", "cron"), config: { cron: "*/5 * * * *" } },
			{ ...mkTestNode("wh", "webhook"), config: { path: "/hook/demo" } },
			mkTestNode("out", "end"),
		];
		graph.edges = [{ id: "e1", sourceNodeId: "tri", targetNodeId: "out", type: "handoff" }] as CanvasEdge[];
		saveCanvasGraph(tempDir, graph);

		await orchestrator.runNode(graph, "tri");
		const tri = graph.nodes.find((n) => n.id === "tri")!;
		expect(tri.status).toBe("done");
		expect(tri.lastOutputSummary).toContain("手动触发");
		expect(orchestrator.getNodeLog(graph.id, "out").some((e) => e.kind === "handoff")).toBe(true);

		await orchestrator.runNode(graph, "cro");
		expect(graph.nodes.find((n) => n.id === "cro")?.lastOutputSummary).toContain("*/5");

		await orchestrator.runNode(graph, "wh");
		expect(graph.nodes.find((n) => n.id === "wh")?.lastOutputSummary).toContain("/hook/demo");
		orchestrator.stopAll(graph.id);
	});

	it("支持复位状态 (resetStatus)", () => {
		const graph = createDefaultCanvasGraph("reset_test");
		graph.nodes[0].status = "done";
		graph.nodes[1].status = "error";
		saveCanvasGraph(tempDir, graph);

		orchestrator.resetStatus(graph);

		expect(graph.nodes[0].status).toBe("idle");
		expect(graph.nodes[1].status).toBe("idle");
	});
});
