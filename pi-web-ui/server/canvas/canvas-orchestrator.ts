/**
 * canvas-orchestrator.ts — 多引擎、多模型、多目录画布协作调度器。
 *
 * 核心功能：
 * 1. 管理运行中的 CanvasGraph 拓扑生命周期；
 * 2. 调度四大引擎（Pi / DSH / Claude Code / Durable）的并发会话；
 * 3. 隔离各节点的工作目录（相对子目录，或自动启用 Git Worktree 物理隔离）；
 * 4. 沿连线执行契约化数据流转（Handoff）；
 * 5. 审查回路与防死循环熔断保护（Review Loop Breaker）。
 */

import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { isRemoteWorkspaceUri } from "../remote-ssh-service.js";
import type {
	CanvasEngineId,
	CanvasGraph,
	CanvasNode,
	CanvasNodeLogEntry,
	CanvasNodeLogKind,
	ServerMessage,
	UiMessage,
} from "../protocol.js";
import { existsSync as fsExistsSync, mkdirSync as fsMkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { saveCanvasRuntimeState, loadCanvasGraph, isSafeGraphId } from "./canvas-store.js";
import { isInsideGitRepo, normalizeWirePath } from "../worktree-service.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type CanvasEventBroadcaster = (msg: ServerMessage) => void;
export type EngineServiceGetter = (engine: CanvasEngineId) => any;

interface ActiveNodeExecution {
	graphId: string;
	nodeId: string;
	abortController?: AbortController;
	timeoutId?: ReturnType<typeof setTimeout>;
}

export class CanvasOrchestrator {
	private readonly dataDir: string;
	/** 每个节点的对话实录：key=`${graphId}:${nodeId}`，内存常驻 + 落盘持久化（canvas/logs/）。上限 300 条防爆内存。 */
	private readonly nodeLogs = new Map<string, CanvasNodeLogEntry[]>();
	/** 复用当前对话流：sink 里收到的标准 UiMessage 按节点缓存，前端抽屉直接复用 Message 组件渲染。 */
	private readonly nodeMessages = new Map<string, UiMessage[]>();
	private logSeq = 0;
	private readonly baseCwd: string;
	/** 运行期项目基准（graphId -> 目录）：相对 cwd 相对它解析；缺省=服务启动目录。
	 *  谁先启动这次运行谁定：UI 按钮=点击者当前项目，AI 工具=所有者对话 cwd。 */
	private readonly runBaseByGraph = new Map<string, string>();
	private readonly engineGetter?: EngineServiceGetter;
	private broadcaster: CanvasEventBroadcaster | null = null;
	private readonly activeExecutions = new Map<string, ActiveNodeExecution>();
	private readonly runningGraphs = new Map<string, CanvasGraph>();

	constructor(baseCwd: string, dataDir: string, engineGetter?: EngineServiceGetter) {
		this.baseCwd = baseCwd;
		this.dataDir = dataDir;
		this.engineGetter = engineGetter;
	}

	setBroadcaster(broadcaster: CanvasEventBroadcaster): void {
		this.broadcaster = broadcaster;
	}

	private broadcast(msg: ServerMessage): void {
		try {
			this.broadcaster?.(msg);
		} catch {
			// 背压/断连导致广播失败不得污染调度主路径（故障注入 S3 命中）
		}
	}

	private logKey(graphId: string, nodeId: string): string {
		return `${graphId}:${nodeId}`;
	}

	/** 读取节点对话实录（内存命中优先，否则尝试从落盘恢复） */
	getNodeLog(graphId: string, nodeId: string): CanvasNodeLogEntry[] {
		const key = this.logKey(graphId, nodeId);
		const mem = this.nodeLogs.get(key);
		if (mem) return [...mem];
		try {
			const file = pathJoin(this.dataDir, "canvas", "logs", `${graphId}__${nodeId}.json`);
			if (fsExistsSync(file)) {
				const arr = JSON.parse(readFileSync(file, "utf8")) as CanvasNodeLogEntry[];
				if (Array.isArray(arr)) {
					const capped = arr.slice(-300);
					this.nodeLogs.set(key, capped);
					return [...capped];
				}
			}
		} catch {
			// 读盘失败回落空日志
		}
		return [];
	}

	/** 读取节点复用的对话流消息（与主对话同构的 UiMessage[]，上限 200 条） */
	getNodeMessages(graphId: string, nodeId: string): UiMessage[] {
		const mem = this.nodeMessages.get(this.logKey(graphId, nodeId));
		return mem ? [...mem] : [];
	}

	/** 清空节点对话实录（内存 + 落盘） */
	clearNodeLog(graphId: string, nodeId: string): void {
		const key = this.logKey(graphId, nodeId);
		this.nodeLogs.delete(key);
		this.nodeMessages.delete(key);
		try {
			const file = pathJoin(this.dataDir, "canvas", "logs", `${graphId}__${nodeId}.json`);
			if (fsExistsSync(file)) unlinkSync(file);
		} catch {
			// 忽略清理失败
		}
	}

	/** 追加一条对话实录并广播 + 节流落盘 */
	private appendLog(graphId: string, nodeId: string, kind: CanvasNodeLogKind, text: string, toolName?: string): void {
		if (!isSafeGraphId(graphId) || !isSafeGraphId(nodeId)) return;
		const clean = (text ?? "").slice(0, 2000) || "(空)";
		const entry: CanvasNodeLogEntry = {
			id: `log_${Date.now()}_${(this.logSeq += 1)}`,
			ts: Date.now(),
			kind,
			text: clean,
			...(toolName ? { toolName: toolName.slice(0, 80) } : {}),
		};
		const key = this.logKey(graphId, nodeId);
		const list = this.nodeLogs.get(key) ?? [];
		list.push(entry);
		while (list.length > 300) list.shift();
		this.nodeLogs.set(key, list);
		this.broadcast({ type: "canvas_node_log", graphId, nodeId, entry });
		// 每 10 条落盘一次，避免高频 IO
		if (list.length % 10 === 0 || kind === "error" || kind === "done") {
			try {
				const dir = pathJoin(this.dataDir, "canvas", "logs");
				if (!fsExistsSync(dir)) fsMkdirSync(dir, { recursive: true });
				writeFileSync(pathJoin(dir, `${graphId}__${nodeId}.json`), JSON.stringify(list.slice(-300)));
			} catch {
				// 落盘失败不影响主流程
			}
		}
	}

	/** 缓存并转播复用的对话流消息（直接透传主对话同构 UiMessage，前端复用 Message 组件渲染） */
	private pushNodeMessages(graphId: string, nodeId: string, incoming: UiMessage[]): void {
		if (!Array.isArray(incoming) || incoming.length === 0) return;
		const key = this.logKey(graphId, nodeId);
		const list = this.nodeMessages.get(key) ?? [];
		// 按 id 去重追加，保持 200 条上限
		const seen = new Set(list.map((m) => m.id));
		for (const m of incoming) {
			if (!m || typeof m.id !== "string" || seen.has(m.id)) continue;
			seen.add(m.id);
			list.push(m);
		}
		while (list.length > 200) list.shift();
		this.nodeMessages.set(key, list);
		this.broadcast({
			type: "canvas_node_messages",
			graphId,
			nodeId,
			appended: incoming.slice(-20),
			streaming: true,
		});
	}

	/** 确保该节点所需的真实工作目录（支持 Worktree 隔离） */
	/** 有效运行基准：显式 runBase（本地绝对路径）优先，否则服务启动目录 */
	private pickRunBase(runBase?: string): string {
		const r = (runBase ?? "").trim();
		if (r && isAbsolute(r) && !isRemoteWorkspaceUri(r)) return resolve(r);
		return resolve(this.baseCwd);
	}

	async resolveNodeCwd(node: CanvasNode, runBase?: string): Promise<string> {
		// node.id 用于 worktree 目录名与 git 分支名；node.cwd 允许工作区外任意绝对路径。
		if (!isSafeGraphId(node.id)) throw new Error(`Invalid canvas node id: ${JSON.stringify(node.id)}`);
		const base = this.pickRunBase(runBase);
		const raw = (node.cwd ?? "").trim();
		// 空 = 运行基准；相对路径 = 相对运行基准（默认服务工作区，运行时可被当前项目覆盖）；绝对路径 = 原样使用（不再拦截越出工作区）。
		const targetDir = !raw ? base : isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
		if (!node.useWorktree) {
			if (!existsSync(targetDir)) {
				mkdirSync(targetDir, { recursive: true });
			}
			return targetDir;
		}

		// 启用 Git Worktree 隔离机制（仅工作区内目录才做 worktree；工作区外绝对路径直接使用目标目录）
		const basePrefix = base.endsWith(sep) ? base : base + sep;
		const insideBase = targetDir === base || targetDir.startsWith(basePrefix);
		if (!insideBase) {
			return targetDir;
		}
		const isGit = await isInsideGitRepo(base);
		if (!isGit) {
			// 如果不是 git 仓库，回落到普通子目录
			return targetDir;
		}

		const worktreeDir = resolve(base, ".worktrees", `canvas-${node.id}`);
		if (!existsSync(worktreeDir)) {
			mkdirSync(resolve(base, ".worktrees"), { recursive: true });
			try {
				await exec("git", ["worktree", "add", "-B", `canvas/${node.id}`, normalizeWirePath(worktreeDir), "HEAD"], {
					cwd: base,
					windowsHide: true,
				});
			} catch {
				// 若创建 worktree 失败（例如已存在锁），回退普通目录
				return targetDir;
			}
		}
		return worktreeDir;
	}

	/** 启动单个节点 */
	async runNode(graph: CanvasGraph, nodeId: string, initialPrompt?: string, runBase?: string): Promise<void> {
		const node = graph.nodes.find((n) => n.id === nodeId);
		if (!node) return;

		this.runningGraphs.set(graph.id, graph);
		const execKey = `${graph.id}:${nodeId}`;
		if (this.activeExecutions.has(execKey)) {
			// 已在运行中
			return;
		}
		const controller = new AbortController();
		this.activeExecutions.set(execKey, {
			graphId: graph.id,
			nodeId,
			abortController: controller,
		});

		node.status = "running";
		node.error = undefined;
		node.currentAction = `[${node.engine.toUpperCase()}] 正在分配独立环境与工作目录...`;
		saveCanvasRuntimeState(this.dataDir, graph);
		this.appendLog(
			graph.id,
			nodeId,
			"system",
			`启动节点「${node.title}」(${node.engine}/${node.model})，工作目录: ${node.cwd || "."}（基准: ${this.pickRunBase(runBase ?? this.runBaseByGraph.get(graph.id))}）`,
		);

		this.broadcast({
			type: "canvas_node_event",
			graphId: graph.id,
			nodeId,
			event: "started",
			currentAction: node.currentAction,
		});

		try {
			if ((runBase ?? "").trim()) this.runBaseByGraph.set(graph.id, runBase as string);
			const resolvedCwd = await this.resolveNodeCwd(node, runBase ?? this.runBaseByGraph.get(graph.id));
			if (controller.signal.aborted) {
				this.activeExecutions.delete(execKey);
				return;
			}

			node.currentAction = `[${node.engine.toUpperCase()}] 启动 ${node.model} 执行中 (${node.role})...`;
			this.broadcast({
				type: "canvas_node_event",
				graphId: graph.id,
				nodeId,
				event: "action",
				currentAction: node.currentAction,
			});

			// 组装前置契约提示词（若上游边有 handoff 产物）
			const incomingEdges = graph.edges.filter((e) => e.targetNodeId === nodeId);
			let contractContext = "";
			for (const edge of incomingEdges) {
				if (edge.lastHandoffSummary) {
					const PORT_ZH: Record<string, string> = {
						contract: "任务契约",
						instruction: "AI指令",
						system: "角色规约",
						config: "控制参数",
					};
					const srcTitle = graph.nodes.find((n) => n.id === edge.sourceNodeId)?.title || edge.sourceNodeId;
					const portSuffix =
						edge.targetPort && edge.targetPort !== "contract"
							? ` → ${PORT_ZH[edge.targetPort] || edge.targetPort}`
							: "";
					contractContext += `\n【来自「${srcTitle}」的定向输入${portSuffix}】:\n${edge.lastHandoffSummary}\n`;
				}
			}

			// 指令优先级：本次手动输入 > 节点持久化 instruction（AI 可输入） > systemPromptOverride > 直接使用输入 > 默认。
			// instruction 支持 {{input}} / {{上游摘要}} / {{upstream}} / {{contract}} 变量引用上游契约产物；
			// 留空或只写输入变量 = 直接使用输入（不再追加通用兜底，避免输入被复制两遍）。
			const rawInstruction =
				initialPrompt?.trim() || node.instruction?.trim() || node.systemPromptOverride?.trim() || "";
			let expandedInstruction = rawInstruction;
			if (contractContext) {
				expandedInstruction = expandedInstruction.replace(
					/\{\{\s*(上游摘要|upstream|contract|input)\s*\}\}/gi,
					contractContext,
				);
			}
			const isInputOnly =
				contractContext.trim().length > 0 &&
				(!expandedInstruction.trim() || expandedInstruction.trim() === contractContext.trim());
			const cfgEntries = Object.entries(node.config ?? {}).filter((entry) => entry[1] !== undefined && entry[1] !== "");
			let configContext = "";
			if (!isCanvasPassthroughRole(node.role) && node.role !== "transform" && cfgEntries.length > 0) {
				configContext = `\n【本节点专属参数】:\n${cfgEntries.map((entry) => `${entry[0]}=${String(entry[1])}`).join("；")}\n`;
			}
			let prompt = isInputOnly
				? `${contractContext}${configContext ? `\n${configContext}` : ""}`
				: `${expandedInstruction || "按照你的角色职责进行开发"}\n${configContext}${contractContext}`;
			this.appendLog(graph.id, nodeId, "prompt", prompt.slice(0, 2000));

			let outputSummary = "";

			// AI 条件裁决（config.aiJudge=true）：条件节点走一次轻量问答做语义判定，
			// 只能回“结论：通过/不通过”，下游按它分流；失败回落关键词。未开启还是零 token 透传。
			const wantAiJudge =
				(node.role === "ai_judge" || (node.role === "condition" && node.config?.aiJudge === true)) &&
				graph.executionMode !== "simulate" &&
				!!this.engineGetter;
			let judgeModel: string = node.model;
			if (wantAiJudge) {
				const condRef = String(node.config?.condition ?? "").trim() || "上游产物符合预期";
				const instructionAsk = (node.instruction ?? "").trim().slice(0, 500);
				const judgeAsk =
					typeof node.config?.judge === "string" && node.config.judge.trim()
						? String(node.config.judge).trim().slice(0, 500)
						: instructionAsk || `判断上游产物是否满足【${condRef}】`;
				const upstreamBlock = contractContext.trim()
					? `上游产物摘要：\n${contractContext.slice(0, 4000)}\n问题：${judgeAsk}（以上游产物为依据）`
					: `无上游产物，直接回答问题：${judgeAsk}`;
				prompt = `你是流水线分支裁判。只做二选一语义判断，不干别的活，不调用任何工具。\n${upstreamBlock}\n要求：最后一行必须 exactly 输出“结论：通过”或“结论：不通过”，前面可附一行理由。`;
				judgeModel =
					typeof node.config?.judgeModel === "string" && node.config.judgeModel.trim()
						? node.config.judgeModel.trim().slice(0, 120)
						: node.model;
				this.appendLog(
					graph.id,
					nodeId,
					"system",
					`AI 裁决启动（${node.engine}/${judgeModel}）：${judgeAsk.slice(0, 200)}`,
				);
			}
			// 纯透传控制节点（条件/循环/人工/汇聚/记忆/结束）：不启动 LLM 会话，直接透传摘要。人工审批节点停留在 waiting_approval 等待抽屉批准，不自动向下游流转。
			if (node.role === "transform") {
				const transformed = executeTransformNode(graph, node);
				node.status = "done";
				node.currentAction = "格式转换完成（本地执行）";
				node.lastOutputSummary = transformed;
				this.appendLog(graph.id, nodeId, "done", transformed.slice(0, 2000));
				this.activeExecutions.delete(execKey);
				saveCanvasRuntimeState(this.dataDir, graph);
				this.broadcast({
					type: "canvas_node_event",
					graphId: graph.id,
					nodeId,
					event: "done",
					currentAction: node.currentAction,
					summary: node.lastOutputSummary,
				});
				await this.handleDownstreamEdges(graph, node);
				return;
			}
			if (!wantAiJudge && isCanvasPassthroughRole(node.role)) {
				const passthroughSummary = buildPassthroughSummary(node, contractContext, initialPrompt);
				if (node.role === "human") {
					node.status = "waiting_approval";
					node.currentAction =
						(node.config?.approvalHint ? String(node.config.approvalHint) + " —— " : "") + "等待人工在抽屉中批准/驳回";
					node.lastOutputSummary = passthroughSummary;
					this.appendLog(graph.id, nodeId, "system", "人工审批节点已就绪，等待批准");
					this.activeExecutions.delete(execKey);
					saveCanvasRuntimeState(this.dataDir, graph);
					this.broadcast({
						type: "canvas_node_event",
						graphId: graph.id,
						nodeId,
						event: "paused",
						currentAction: node.currentAction,
						summary: node.lastOutputSummary,
					});
					return;
				}
				node.status = "done";
				node.currentAction = `控制节点直通 (${node.role})`;
				node.lastOutputSummary = passthroughSummary;
				this.appendLog(graph.id, nodeId, "done", passthroughSummary.slice(0, 2000));
				this.activeExecutions.delete(execKey);
				saveCanvasRuntimeState(this.dataDir, graph);
				this.broadcast({
					type: "canvas_node_event",
					graphId: graph.id,
					nodeId,
					event: "done",
					currentAction: node.currentAction,
					summary: node.lastOutputSummary,
				});
				await this.handleDownstreamEdges(graph, node);
				return;
			}

			// 双模调度：真实引擎执行 (Real Engine) vs 拓扑演练演示 (Simulation)
			if (graph.executionMode === "simulate" || !this.engineGetter) {
				await this.simulateNodeExecution(node, resolvedCwd, prompt, controller.signal, (action) => {
					node.currentAction = action;
					this.broadcast({
						type: "canvas_node_event",
						graphId: graph.id,
						nodeId,
						event: "action",
						currentAction: action,
					});
				});
				outputSummary = `[${node.title}] 演练完成，工作目录：${node.cwd || "."}`;
			} else {
				const savedModel = node.model;
				if (wantAiJudge && judgeModel !== node.model) node.model = judgeModel;
				try {
					outputSummary = await this.executeRealEngineNode(
						graph,
						node,
						resolvedCwd,
						prompt,
						controller.signal,
						(action) => {
							node.currentAction = action;
							this.broadcast({
								type: "canvas_node_event",
								graphId: graph.id,
								nodeId,
								event: "action",
								currentAction: action,
							});
						},
					);
				} finally {
					node.model = savedModel;
				}
			}

			if (controller.signal.aborted) {
				this.activeExecutions.delete(execKey);
				return;
			}

			// 节点完成
			node.status = "done";
			node.currentAction = `已完成 (${node.engine.toUpperCase()})`;
			node.lastOutputSummary = outputSummary;
			if (wantAiJudge) {
				const hits = [
					...outputSummary.matchAll(/结论\s*[：:]\s*(通过|不通过|成立|不成立|是|否|真|假|true|false|yes|no)/gi),
				];
				const last = hits.length > 0 ? String(hits[hits.length - 1][1]).toLowerCase() : "";
				node.aiVerdict = last ? ["通过", "成立", "是", "真", "true", "yes"].includes(last) : undefined;
				this.appendLog(
					graph.id,
					nodeId,
					"system",
					node.aiVerdict === undefined
						? "AI 裁决未给出有效结论（默认走不成立边）。"
						: `AI 裁决结论：${node.aiVerdict ? "通过" : "不通过"}（独立判定，未混入关键词）。`,
				);
			}
			this.appendLog(graph.id, nodeId, "done", outputSummary.slice(0, 2000));
			this.activeExecutions.delete(execKey);
			saveCanvasRuntimeState(this.dataDir, graph);

			this.broadcast({
				type: "canvas_node_event",
				graphId: graph.id,
				nodeId,
				event: "done",
				currentAction: node.currentAction,
				summary: node.lastOutputSummary,
			});

			// 触发下游交接或审查
			await this.handleDownstreamEdges(graph, node);
		} catch (err: unknown) {
			if (controller.signal.aborted) {
				this.activeExecutions.delete(execKey);
				return;
			}
			const msg = (err as Error).message || String(err);
			node.status = "error";
			node.error = msg;
			node.currentAction = `执行出错: ${msg}`;
			this.appendLog(graph.id, node.id, "error", msg.slice(0, 2000));
			this.activeExecutions.delete(execKey);
			saveCanvasRuntimeState(this.dataDir, graph);

			this.broadcast({
				type: "canvas_node_event",
				graphId: graph.id,
				nodeId,
				event: "error",
				currentAction: node.currentAction,
				error: msg,
			});
		}
	}

	/** 运行全图（从所有入度为 0 的根节点，或者未完成节点并发拉起） */
	async runAll(graph: CanvasGraph, initialPrompt?: string, runBase?: string): Promise<void> {
		this.runningGraphs.set(graph.id, graph);
		graph.status = "running";
		saveCanvasRuntimeState(this.dataDir, graph);

		// 找到没有入边或当前状态为 idle/error 的起点节点
		const targetNodes = new Set(graph.nodes.map((n) => n.id));
		for (const edge of graph.edges) {
			targetNodes.delete(edge.targetNodeId);
		}

		let startNodes = graph.nodes.filter((n) => targetNodes.has(n.id));
		if (startNodes.length === 0) {
			startNodes = graph.nodes.filter((n) => n.status === "idle" || n.status === "error");
		}
		if (startNodes.length === 0 && graph.nodes.length > 0) {
			startNodes = [graph.nodes[0]];
		}

		if ((runBase ?? "").trim()) this.runBaseByGraph.set(graph.id, runBase as string);
		await Promise.all(startNodes.map((n) => this.runNode(graph, n.id, initialPrompt, runBase)));
	}

	/** 处理节点完成后的下游连线流转 */
	private async handleDownstreamEdges(graph: CanvasGraph, completedNode: CanvasNode, via?: "approve"): Promise<void> {
		let outEdges = graph.edges.filter((e) => e.sourceNodeId === completedNode.id);
		if (via === "approve") {
			// 人工批准只走批准/主线边，不触发驳回回路边（reject / loop_back / review）
			outEdges = outEdges.filter((e) => e.type !== "reject" && e.type !== "loop_back" && e.type !== "review");
		}
		if (completedNode.role === "condition" || completedNode.role === "ai_judge") {
			const aiMode = completedNode.role === "ai_judge" || completedNode.config?.aiJudge === true;
			const condText = String(completedNode.config?.condition ?? "");
			const upstreamText =
				graph.edges
					.filter((e) => e.targetNodeId === completedNode.id)
					.map((e) => e.lastHandoffSummary ?? "")
					.join("\n") ||
				completedNode.lastOutputSummary ||
				"";
			const summary = upstreamText;
			const tokens = condText
				.split(/[\s,\uFF0C\u3001/()\u2014\u2014]+/)
				.map((t) => t.trim())
				.filter((t) => t.length >= 2);
			const hit = aiMode
				? completedNode.aiVerdict === true
				: tokens.length === 0
					? true
					: tokens.some((t) => summary.includes(t));
			if (aiMode) {
				this.appendLog(
					graph.id,
					completedNode.id,
					"system",
					`分支：${hit ? "成立边" : "不成立边"}（AI 独立裁决${completedNode.aiVerdict === undefined ? "，无结论默认不成立" : ""}）。`,
				);
			}
			outEdges = outEdges.filter((e) => {
				if (e.type === "condition_true") return hit;
				if (e.type === "condition_false") return !hit;
				return true;
			});
			this.appendLog(
				graph.id,
				completedNode.id,
				"system",
				"条件分支判定：" + (hit ? "成立，走 true 边" : "不成立，走 false 边"),
			);
		}
		for (const edge of outEdges) {
			edge.lastHandoffSummary = completedNode.lastOutputSummary;

			if (edge.type === "review" || edge.type === "loop_back" || edge.type === "reject") {
				// 审查回路：检查是否超出最大驳回重试次数
				const maxRetries = edge.maxLoopRetries ?? 3;
				const current = edge.currentLoopCount ?? 0;
				if (current >= maxRetries) {
					// 达到熔断上限，暂停并等待人工介入
					completedNode.status = "waiting_approval";
					completedNode.currentAction = `已达审查重试上限 (${maxRetries} 次)，暂停等待人工仲裁确认`;
					saveCanvasRuntimeState(this.dataDir, graph);
					this.broadcast({
						type: "canvas_node_event",
						graphId: graph.id,
						nodeId: completedNode.id,
						event: "paused",
						currentAction: completedNode.currentAction,
					});
					continue;
				}
			}

			// 触发下游目标节点
			const targetNode = graph.nodes.find((n) => n.id === edge.targetNodeId);
			if (targetNode) {
				this.appendLog(
					graph.id,
					targetNode.id,
					"handoff",
					`收到来自「${completedNode.title}」的交接${edge.label ? `（${edge.label}）` : ""}：${(edge.lastHandoffSummary || "").slice(0, 1500)}`,
				);
			}
			if (targetNode) {
				const execKey = graph.id + ":" + targetNode.id;
				if (targetNode.status === "running" || this.activeExecutions.has(execKey)) continue;
				const upstreamIds = graph.edges.filter((e) => e.targetNodeId === targetNode.id).map((e) => e.sourceNodeId);
				const allUpstreamDone = upstreamIds.every((uid) => graph.nodes.find((n) => n.id === uid)?.status === "done");
				if (!via && !allUpstreamDone) continue; // 人工批准直放（via=approve）不受合流门限制
				targetNode.status = "running";
				void this.runNode(graph, targetNode.id, undefined, this.runBaseByGraph.get(graph.id));
			}
		}

		// 检查图上所有节点是否都已经到达完成状态
		const allDone = graph.nodes.every((n) => n.status === "done");
		if (allDone) {
			graph.status = "completed";
			saveCanvasRuntimeState(this.dataDir, graph);
		}
	}

	/** 停止单个节点 */
	stopNode(graphId: string, nodeId: string): void {
		const execKey = `${graphId}:${nodeId}`;
		const execution = this.activeExecutions.get(execKey);
		if (execution) {
			execution.abortController?.abort();
			this.activeExecutions.delete(execKey);
		}

		const graph = this.runningGraphs.get(graphId);
		if (graph) {
			const node = graph.nodes.find((n) => n.id === nodeId);
			if (node) {
				node.status = "idle";
				node.currentAction = "已手动中止";
				this.appendLog(graphId, nodeId, "system", "已手动中止当前任务");
				saveCanvasRuntimeState(this.dataDir, graph);
				this.broadcast({
					type: "canvas_node_event",
					graphId,
					nodeId,
					event: "paused",
					currentAction: node.currentAction,
				});
			}
		}
	}

	/** 停止全图所有正在运行的节点 */
	stopAll(graphId: string): void {
		this.runBaseByGraph.delete(graphId);
		for (const [key, execution] of this.activeExecutions.entries()) {
			if (execution.graphId === graphId) {
				execution.abortController?.abort();
				this.activeExecutions.delete(key);
			}
		}
		const graph = this.runningGraphs.get(graphId);
		if (graph) {
			graph.status = "idle";
			for (const node of graph.nodes) {
				if (node.status === "running") {
					node.status = "idle";
					node.currentAction = "已手动中止";
				}
			}
			saveCanvasRuntimeState(this.dataDir, graph);
		}
	}

	/** 审查门禁裁决（#707）：批准/驳回落盘持久化并广播；执行中的节点同步收到审查意见 */
	reviewNode(graphId: string, nodeId: string, decision: "approve" | "reject", comment?: string): CanvasGraph | null {
		if (!isSafeGraphId(graphId)) return null;
		let graph = this.runningGraphs.get(graphId);
		if (!graph) {
			try {
				graph = loadCanvasGraph(this.dataDir, graphId);
			} catch {
				return null;
			}
		}
		const node = graph.nodes.find((n) => n.id === nodeId);
		if (!node) return null;
		const cleanComment = (comment ?? "").slice(0, 500);
		if (decision === "approve") {
			node.status = "done";
			node.currentAction = cleanComment ? `人工审查批准合流：${cleanComment}` : "人工审查批准合流";
		} else {
			node.status = "waiting_approval";
			node.currentAction = cleanComment ? `人工驳回：${cleanComment}` : "人工驳回：需补充完善测试与注释";
		}
		graph.updatedAt = Date.now();
		saveCanvasRuntimeState(this.dataDir, graph);
		this.runningGraphs.set(graphId, graph);
		this.appendLog(
			graphId,
			nodeId,
			"review",
			`${decision === "approve" ? "人工审查批准合流" : "人工驳回"}${cleanComment ? `：${cleanComment}` : ""}`,
		);
		// 执行中的节点同步收到审查意见（复用节点事件通道，currentAction 即裁决正文）
		if (this.activeExecutions.has(`${graphId}:${nodeId}`)) {
			this.broadcast({
				type: "canvas_node_event",
				graphId,
				nodeId,
				event: decision === "approve" ? "done" : "paused",
				currentAction: node.currentAction,
				summary: node.lastOutputSummary,
			});
		}
		if (decision === "approve") {
			void this.handleDownstreamEdges(graph, node, "approve");
		}
		return graph;
	}

	/** 向节点插话干预 (Steer) */
	steerNode(graphId: string, nodeId: string, message: string): void {
		let graph = this.runningGraphs.get(graphId);
		if (!graph) {
			try {
				graph = loadCanvasGraph(this.dataDir, graphId);
				this.runningGraphs.set(graphId, graph);
			} catch {
				return;
			}
		}
		const node = graph.nodes.find((n) => n.id === nodeId);
		if (!node) return;

		node.currentAction = `[收到人工插话指导]: ${message.slice(0, 40)}`;
		saveCanvasRuntimeState(this.dataDir, graph);
		this.appendLog(graphId, nodeId, "steer", message.slice(0, 2000));

		this.broadcast({
			type: "canvas_node_event",
			graphId,
			nodeId,
			event: "action",
			currentAction: node.currentAction,
		});
	}

	/** 重置全图节点状态为 idle */
	resetStatus(graph: CanvasGraph): void {
		this.stopAll(graph.id);
		graph.status = "idle";
		for (const node of graph.nodes) {
			node.status = "idle";
			node.aiVerdict = undefined;
			node.error = undefined;
			node.currentAction = undefined;
			node.lastOutputSummary = undefined;
		}
		for (const edge of graph.edges) {
			edge.currentLoopCount = 0;
			edge.lastHandoffSummary = undefined;
		}
		saveCanvasRuntimeState(this.dataDir, graph);
	}

	/** 节点执行过程模拟与调度心跳（具备取消信号响应） */
	private async simulateNodeExecution(
		node: CanvasNode,
		_cwd: string,
		_prompt: string,
		signal: AbortSignal,
		onAction: (act: string) => void,
	): Promise<void> {
		const steps = [
			`[${node.engine.toUpperCase()}] 分析任务上下文与关联代码库...`,
			`[${node.engine.toUpperCase()}] 规划模块变更方案与接口契约...`,
			`[${node.engine.toUpperCase()}] 写入并应用变更...`,
			`[${node.engine.toUpperCase()}] 验证输出结果与测试检查...`,
		];

		for (const step of steps) {
			if (signal.aborted) return;
			onAction(step);
			const stepDelay = process.env.NODE_ENV === "test" || process.env.VITEST ? 20 : 600;
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, stepDelay);
				signal.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(new Error("Aborted"));
					},
					{ once: true },
				);
			});
		}
	}

	/** 真实智能体引擎执行通道（接入真实的会话、模型调用与代码修改） */
	private async executeRealEngineNode(
		graph: CanvasGraph,
		node: CanvasNode,
		resolvedCwd: string,
		prompt: string,
		signal: AbortSignal,
		onAction: (act: string) => void,
	): Promise<string> {
		if (!this.engineGetter) {
			throw new Error("引擎服务提供者未注入");
		}
		const engineSvc = this.engineGetter(node.engine);
		if (!engineSvc) {
			throw new Error(`找不到智能体引擎：${node.engine}`);
		}

		const clientId = `canvas:${graph.id}:${node.id}`;
		let collectedText = "";

		onAction(`[${node.engine.toUpperCase()}] 正在接入真实引擎运行时...`);

		// sink 具名持有：finally 必须用同一引用 detach，否则旧闭包永久残留串台（#698）
		// 复用当前对话流：snapshot/appended 的标准 UiMessage 直接缓存 + 转播，抽屉复用 Message 组件渲染；
		// 工具调用与文本增量同时记一条轻量协同事件，保证调用/错误清晰可见。
		const seenToolIds = new Set<string>();
		// 本轮运行期间从直播帧里看到的 errorMessage（与快照索引无关，压缩/翻页也不会丢）。
		// 只收「本轮新增」的消息：attach / 首帧可能是带全量 history 的 snapshot，
		// 否则该节点上一次留下的旧报错会被当成本轮失败（换模型后仍报旧错）。
		let sinkError: string | undefined;
		const baselineMsgIds = new Set<string>();
		let captureErrors = false;
		const sink = (msg: ServerMessage) => {
			if (signal.aborted) return;
			if (msg.type === "message_delta") {
				const delta = (msg as any).delta || "";
				collectedText += delta;
				if (collectedText.length % 50 === 0) {
					onAction(`[${node.engine.toUpperCase()}] 正在生成: ${collectedText.slice(-30).replace(/\n/g, " ")}...`);
				}
			} else if (msg.type === "snapshot" || msg.type === "snapshot_delta") {
				const messages = ((msg as any).state?.messages || (msg as any).appended || []) as UiMessage[];
				if (messages.length > 0) this.pushNodeMessages(graph.id, node.id, messages);
				for (const m of messages) {
					if (m.toolName) {
						const tid = m.toolCallId || `${m.toolName}:${m.id}`;
						if (!seenToolIds.has(tid)) {
							seenToolIds.add(tid);
							this.appendLog(
								graph.id,
								node.id,
								"tool",
								m.isError
									? `工具 ${m.toolName} 报错${m.errorMessage ? `：${m.errorMessage.slice(0, 500)}` : ""}`
									: `正在调用工具： ${m.toolName}`,
								m.toolName,
							);
						}
						onAction(`[${node.engine.toUpperCase()}] 正在调用工具: ${m.toolName}`);
					} else if (m.errorMessage) {
						if (captureErrors && !baselineMsgIds.has(m.id)) sinkError = m.errorMessage;
						if (!baselineMsgIds.has(m.id)) {
							this.appendLog(graph.id, node.id, "error", m.errorMessage.slice(0, 2000));
						}
					}
				}
			}
		};

		const cs = await engineSvc.attach(clientId, sink);

		try {
			if (cs.cwd !== resolvedCwd) {
				await cs.setCwd(resolvedCwd);
			}

			// 真实应用模型切换（若模型不存在或 Key 无效，真实报错）
			// 归一化双前缀：历史存量可能是 opencode-go/opencode-go/xxx，压成 opencode-go/xxx 再切换。
			if (node.model && typeof (cs as any).switchModelOrThrow === "function") {
				try {
					await (cs as any).switchModelOrThrow(normalizeCanvasModelId(node.model));
				} catch (err) {
					throw new Error(`模型未配置或不可用 [${node.model}]: ${(err as Error).message}`);
				}
			}

			// 真实应用思考强度
			if (node.thinkingLevel && typeof (cs as any).setThinking === "function") {
				try {
					(cs as any).setThinking(node.thinkingLevel);
				} catch {}
			}

			onAction(`[${node.engine.toUpperCase()}] 开始执行任务...`);

			// 本轮起点快照：报错检测只看本次运行新增的消息，
			// 避免把该节点历史运行留下的旧报错当成本轮失败。
			const preRunMsgs = canvasSnapshotMessages(cs);
			for (const m of preRunMsgs) baselineMsgIds.add(m.id);
			const baselineMsgCount = preRunMsgs.length;
			captureErrors = true;

			await cs.prompt(prompt);

			// 等待执行完成（带超时和取消监听）
			const startTime = Date.now();
			const maxWaitMs = 15 * 60 * 1000;

			while (!signal.aborted) {
				await new Promise((r) => setTimeout(r, 1200));
				if (signal.aborted) {
					await cs.abort().catch(() => {});
					throw new Error("任务已被手动中止");
				}

				let isStreaming = false;
				let turnError: string | undefined;

				if (typeof (cs as any).readConversationForPlugins === "function") {
					const snap = (cs as any).readConversationForPlugins();
					isStreaming = snap?.isStreaming === true;
					// 注意：PluginConversationSnapshot 并无 `lastError` 字段（旧写法恒为 undefined），
					// 于是 API 报错（如 403 RegionError）被当成执行成功、节点照样标 done。
					// 与定时任务桥（agent-service-daemon）同口径：读尾部 assistant 消息的 errorMessage；
					// 自动重试中的失败消息会被服务端隐藏，中止回合不算报错。
					turnError =
						tailAssistantError(canvasSnapshotMessages(cs).slice(baselineMsgCount)) ??
						(sinkError && !CANVAS_ABORT_MESSAGES.test(sinkError.trim()) ? sinkError : undefined);
				}

				if (turnError) {
					throw new Error(`引擎执行失败：${turnError}`);
				}

				if (!isStreaming && Date.now() - startTime > 3000) {
					break;
				}

				if (Date.now() - startTime > maxWaitMs) {
					await cs.abort().catch(() => {});
					throw new Error("任务执行超时 (15分钟)");
				}
			}

			// 真实检测代码变更统计
			let diffSummary = "";
			try {
				const { stdout: diffStat } = await exec("git", ["diff", "--stat"], {
					cwd: resolvedCwd,
					timeout: 5000,
					windowsHide: true,
				});
				if (diffStat.trim()) {
					diffSummary = `\n【代码变更统计】:\n${diffStat.trim()}`;
				}
			} catch {}

			// 交付正文：优先用流式增量累积，其次取本轮新增的 assistant 正文。
			// （部分引擎/重连路径只走 snapshot 增量、没有 message_delta，collectedText 会是空的，
			//  旧逻辑于是把下游交接内容写成「交付完成（未产生文件修改）」的占位文案）
			const replyText = (
				collectedText.trim() || extractRunReplyText(canvasSnapshotMessages(cs).slice(baselineMsgCount))
			).trim();
			if (replyText) return `${replyText.slice(-300)}${diffSummary}`;
			return `[${node.title}] 交付完成${diffSummary || "（未产生文件修改）"}`;
		} finally {
			engineSvc.detach(clientId, sink);
		}
	}
}

/** 读一次会话快照里的消息列表（快照失败/引擎不支持时返回空数组，不抛出）。 */
function canvasSnapshotMessages(cs: unknown): UiMessage[] {
	const reader = (cs as { readConversationForPlugins?: () => { messages?: UiMessage[] } | null } | null)
		?.readConversationForPlugins;
	if (typeof reader !== "function") return [];
	try {
		const snap = reader.call(cs);
		return (snap?.messages ?? []) as UiMessage[];
	} catch {
		return [];
	}
}

/** SDK 主动中止的精确文案（与 web/src/aborted-turn.ts 同口径，中止不是真实报错） */
const CANVAS_ABORT_MESSAGES = /^(This operation was aborted|Request aborted|任务已被手动中止)$/;

/** 末尾 assistant 回合若是真实报错，返回其 errorMessage；正常收尾或中止返回 undefined。 */
function tailAssistantError(msgs: UiMessage[]): string | undefined {
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (m.role !== "assistant") continue;
		if (m.stopReason === "aborted") return undefined;
		const err = (m.errorMessage ?? "").trim();
		if (!err) return undefined;
		return CANVAS_ABORT_MESSAGES.test(err) ? undefined : err;
	}
	return undefined;
}

/** 从本轮新增消息里取最后一条 assistant 正文（text 块拼接），作为交付摘要兜底。 */
function extractRunReplyText(msgs: UiMessage[]): string {
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (m.role !== "assistant" || m.stopReason === "aborted") continue;
		const text = (m.content ?? [])
			.filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

/** 纯透传控制节点集合（与前端 CanvasTypes.PASSTHROUGH_ROLES 保持一致） */
const CANVAS_PASSTHROUGH_ROLES: ReadonlySet<string> = new Set([
	"condition",
	"loop",
	"human",
	"merge",
	"memory",
	"end",
	"trigger",
	"cron",
	"webhook",
]);

function isCanvasPassthroughRole(role: string): boolean {
	return CANVAS_PASSTHROUGH_ROLES.has(role);
}

/** 格式转换节点：本地确定性执行，无需 LLM。text2json / json2text / template。 */
function executeTransformNode(graph: CanvasGraph, node: CanvasNode): string {
	const cfg = (node as { config?: Record<string, string | number | boolean | undefined> }).config ?? {};
	const mode = String(cfg["mode"] ?? "text2json");
	const rawInput = graph.edges
		.filter((e) => e.targetNodeId === node.id)
		.map((e) => e.lastHandoffSummary ?? "")
		.filter(Boolean)
		.join("\n")
		.trim();
	const fallbackInput = rawInput || String(cfg["input"] ?? "");
	try {
		if (mode === "json2text") {
			if (!fallbackInput) return "【格式转换 " + node.title + "】输入为空，无输出";
			try {
				const v = JSON.parse(fallbackInput) as unknown;
				if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n");
				if (v !== null && typeof v === "object") {
					const vals = Object.values(v as Record<string, unknown>);
					if (vals.every((x) => typeof x === "string" || typeof x === "number")) return vals.join("\n");
					return JSON.stringify(v, null, 2);
				}
				return String(v);
			} catch {
				return fallbackInput;
			}
		}
		if (mode === "template") {
			const tpl = String(cfg["template"] ?? "{{input}}");
			return tpl.split("{{input}}").join(fallbackInput).split("{{上游摘要}}").join(fallbackInput);
		}
		if (!fallbackInput) return "【格式转换 " + node.title + "】输入为空，无输出";
		try {
			return JSON.stringify(JSON.parse(fallbackInput), null, 2);
		} catch {
			return JSON.stringify({ text: fallbackInput }, null, 2);
		}
	} catch (err) {
		return "【格式转换 " + node.title + "】转换失败：" + (err as Error).message;
	}
}

/** 归一化画布模型 ID：历史存量可能是 provider/provider/xxx，压成 provider/xxx */
function normalizeCanvasModelId(raw: string): string {
	const t = (raw ?? "").trim();
	const slash = t.indexOf("/");
	if (slash <= 0) return t;
	const provider = t.slice(0, slash);
	let rest = t.slice(slash + 1);
	const prefix = `${provider}/`;
	while (rest.startsWith(prefix)) rest = rest.slice(prefix.length);
	return `${provider}/${rest}`;
}

function buildPassthroughSummary(node: CanvasNode, contractContext: string, initialPrompt?: string): string {
	const cfg = (node as { config?: Record<string, string | number | boolean> }).config ?? {};
	const cfgText = Object.entries(cfg)
		.map(([k, v]) => `${k}=${String(v)}`)
		.slice(0, 8)
		.join("；");
	const contract = contractContext ? contractContext.slice(0, 1500) : "（无上游输入，直接透传）";
	switch (node.role) {
		case "condition":
			return `【条件分支 ${node.title}】判定配置：${cfgText || "未配置表达式，默认走 true 边"}\n透传上游产物：\n${contract}`;
		case "loop":
			return `【循环控制 ${node.title}】循环配置：${cfgText || "默认最多 3 次（熔断保护）"}\n透传上游产物：\n${contract}`;
		case "human":
			return `【人工审批 ${node.title}】${cfgText ? `审批提示：${cfgText}` : ""}\n待人工在抽屉中批准/驳回。上游产物：\n${contract}`;
		case "trigger": {
			const popup = (initialPrompt ?? "").trim();
			const payload = popup || String(cfg["payload"] ?? "").trim();
			const extra = contractContext ? contractContext.slice(0, 1000) : "";
			if (payload)
				return (
					"【手动触发 " +
					node.title +
					"】启动载荷：\n" +
					payload.slice(0, 1500) +
					(extra ? "\n上游输入：\n" + extra : "")
				);
			return "【手动触发 " + node.title + "】" + (extra ? "上游输入：\n" + extra : "（无载荷，直接启动）");
		}
		case "cron":
			return (
				"【定时触发 " +
				node.title +
				"】计划：" +
				(cfgText || "未配置 Cron（默认手动拉起）") +
				"\n透传上游产物：\n" +
				contract
			);
		case "webhook":
			return (
				"【Webhook 触发 " + node.title + "】接入配置：" + (cfgText || "未配置 path") + "\n透传上游产物：\n" + contract
			);
		case "merge":
			return `【汇聚合并 ${node.title}】已汇总上游分支产物：\n${contract}`;
		case "memory":
			return `【记忆读写 ${node.title}】记忆键：${cfgText || "default"}\n快照：\n${contract}`;
		case "end":
			return `【流水线结束 ${node.title}】最终交付汇总：\n${contract}`;
		default:
			return `【控制节点 ${node.title}】透传：\n${contract}`;
	}
}
