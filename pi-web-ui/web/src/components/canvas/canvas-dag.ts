import type { CanvasEdge, CanvasGraph, CanvasNode, CanvasNodeRole } from "../../types";
import { ROLE_METAS } from "./CanvasTypes";

const VALID_ROLES = new Set(Object.keys(ROLE_METAS));

/** 从助手文本中提取 ```canvas-dag JSON 块 */
export function extractDagJson(text: string): string | null {
	const m = text.match(/```canvas-dag\s*([\s\S]*?)```/);
	return m ? m[1].trim() : null;
}

export interface ParsedDag {
	nodes: { title: string; role: CanvasNodeRole; instruction?: string }[];
	edges: { from: number; to: number }[];
}

/** 校验 LLM 返回的 DAG（白名单角色 + 下标边 + 环检测），非法直接抛错 */
export function parseDagJson(raw: string): ParsedDag {
	const data = JSON.parse(raw) as Partial<ParsedDag>;
	if (!data || !Array.isArray(data.nodes) || data.nodes.length === 0 || data.nodes.length > 20) {
		throw new Error("nodes 非法（需 1-20 个）");
	}
	for (const n of data.nodes) {
		if (!n || typeof n.title !== "string" || !VALID_ROLES.has(n.role)) {
			throw new Error(`非法节点 role: ${(n as { role?: string })?.role}`);
		}
	}
	const edges = Array.isArray(data.edges) ? data.edges : [];
	for (const e of edges) {
		if (
			!Number.isInteger(e.from) ||
			!Number.isInteger(e.to) ||
			e.from < 0 ||
			e.to < 0 ||
			e.from >= data.nodes.length ||
			e.to >= data.nodes.length ||
			e.from === e.to
		) {
			throw new Error("非法边下标");
		}
	}
	// 环检测（DFS）
	const adj: number[][] = data.nodes.map(() => []);
	edges.forEach((e) => adj[e.from].push(e.to));
	const color = new Array(data.nodes.length).fill(0);
	const dfs = (u: number): boolean => {
		color[u] = 1;
		for (const v of adj[u]) {
			if (color[v] === 1) return true;
			if (color[v] === 0 && dfs(v)) return true;
		}
		color[u] = 2;
		return false;
	};
	for (let i = 0; i < data.nodes.length; i++) {
		if (color[i] === 0 && dfs(i)) throw new Error("DAG 含环，拒绝落图");
	}
	return { nodes: data.nodes, edges };
}

/** 把校验过的 DAG 展开为 CanvasGraph（缺边时链式补边 + 自动布局坐标后续由调用方处理） */
export function dagToGraph(
	parsed: ParsedDag,
	name: string,
	defaultModel: string,
	layout: (nodes: CanvasNode[], edges: CanvasEdge[]) => CanvasNode[],
	defaultCwd = ".",
): CanvasGraph {
	const now = Date.now();
	const nodes: CanvasNode[] = parsed.nodes.map((n, i) => ({
		id: `n_${now}_${i}_${Math.random().toString(36).slice(2, 6)}`,
		title: n.title.slice(0, 24),
		role: n.role,
		x: 80,
		y: 80 + i * 100,
		width: 300,
		engine: "pi",
		model: defaultModel,
		cwd:
			typeof (n as { cwd?: unknown }).cwd === "string" && ((n as { cwd?: string }).cwd as string)
				? ((n as { cwd?: string }).cwd as string)
				: defaultCwd,
		useWorktree: false,
		status: "idle",
		...(n.instruction ? { instruction: n.instruction } : {}),
	}));
	let edges: CanvasEdge[] = parsed.edges.map((e, i) => ({
		id: `e_${now}_${i}`,
		sourceNodeId: nodes[e.from].id,
		targetNodeId: nodes[e.to].id,
		type: "handoff" as const,
	}));
	if (edges.length === 0 && nodes.length > 1) {
		edges = nodes.slice(1).map((n, i) => ({
			id: `e_${now}_chain_${i}`,
			sourceNodeId: nodes[i].id,
			targetNodeId: n.id,
			type: "handoff" as const,
		}));
	}
	const laid = layout(nodes, edges);
	return {
		id: `graph_${now}_${Math.random().toString(36).slice(2, 6)}`,
		name: name.slice(0, 24) || "AI 智能流水线",
		viewport: { x: 60, y: 60, zoom: 1 },
		nodes: laid,
		edges,
		status: "idle",
		executionMode: "real",
		createdAt: now,
		updatedAt: now,
	};
}

/** 发给对话 LLM 的生成指令（含可用角色表 + 输出 schema 约束） */
export function buildSmartPrompt(userAsk: string): string {
	const roles = Object.keys(ROLE_METAS).join(", ");
	return [
		"【画布工作流生成】请把下面的需求拆成工作流节点，只输出一个 ```canvas-dag JSON 块，不要其他解释。",
		`可用 role（必须严格使用）：${roles}。`,
		"常用：researcher 调研 / planner 规划 / architect 架构 / coder 编码 / tester 测试 / reviewer 审查 / writer 文档 / human 人工审批 / condition 条件分支 / loop 循环 / merge 汇总 / trigger 开始 / end 结束。",
		'JSON 格式：{"nodes":[{"title":"步骤名","role":"coder","instruction":"给该节点的执行指令"}],"edges":[{"from":0,"to":1}]}，nodes 1-12 个，edges 下标引用 nodes，禁止成环。',
		`需求：${userAsk}`,
	].join("\n");
}
