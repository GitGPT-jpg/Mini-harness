/**
 * CanvasNodeDrawer.tsx — 数字员工审查门禁与深度控制台抽屉 (Review Gate & Steer Console)。
 */
import { useState, useEffect, useMemo, useRef } from "react";
import type { CanvasNode, CanvasEdge, CanvasNodeLogEntry, ModelInfo, ProjectSummary, UiMessage } from "../../types";
import type { ThinkingValue } from "../../thinking-levels";
import type { RoleField } from "./CanvasTypes";
import type { ReactNode } from "react";
import {
	ENGINE_METAS,
	ROLE_METAS,
	roleNeedsInstruction,
	IN_PORT_DEFS,
	outPortsForRole,
	inPortLabel,
	outPortLabel,
	visibleRoleFields,
} from "./CanvasTypes";
import { ModelThinking } from "../ModelThinking";
import { UniversalPathPicker } from "../UniversalPathPicker";
import {
	FiX,
	FiSend,
	FiPlay,
	FiSquare,
	FiGitBranch,
	FiCheckCircle,
	FiAlertCircle,
	FiTrash2,
	FiMessageSquare,
	FiActivity,
} from "react-icons/fi";
import { Message } from "../Message";

interface CanvasNodeDrawerProps {
	node: CanvasNode | null;
	edges: CanvasEdge[];
	allNodes: CanvasNode[];
	models: ModelInfo[];
	/** 全局默认模型（"provider/model-id"），列表中找不到节点模型时的显示回退 */
	defaultModel?: string | null;
	projects: ProjectSummary[];
	workspaceRoots?: string[];
	pathCompletions?: { name: string; path: string; type: "dir" | "file" }[];
	/** cwd 为 "." 时弹窗初始目录的回退（画布 currentCwd） */
	baseCwd?: string;
	/** 经画布通道下发 make_dir（缺省由通用选择器内置回退经主通道创建） */
	onMakeDir?: (path: string) => void;
	onClose: () => void;
	onUpdate: (nodeId: string, patch: Partial<CanvasNode>) => void;
	onRun: (nodeId: string) => void;
	onStop: (nodeId: string) => void;
	onSteer: (nodeId: string, message: string) => void;
	onReview?: (nodeId: string, decision: "approve" | "reject", comment?: string) => void;
	/** 复用的对话流：entries=协同事件，messages=与主对话同构 UiMessage[] */
	logEntries?: CanvasNodeLogEntry[];
	logMessages?: UiMessage[];
	onClearLog?: (nodeId: string) => void;
	/** 重指定连线端子/类型（Studio handleUpdateEdge） */
	onUpdateEdge?: (edgeId: string, patch: Partial<CanvasEdge>) => void;
}

export function CanvasNodeDrawer({
	node,
	edges,
	allNodes,
	models,
	defaultModel,
	projects,
	workspaceRoots = [],
	pathCompletions = [],
	baseCwd,
	onMakeDir,
	onClose,
	onUpdate,
	onRun,
	onStop,
	onSteer,
	onReview,
	logEntries = [],
	logMessages = [],
	onClearLog,
	onUpdateEdge,
}: CanvasNodeDrawerProps) {
	const [steerInput, setSteerInput] = useState("");
	const [logTab, setLogTab] = useState<"chat" | "events">("chat");
	const logScrollRef = useRef<HTMLDivElement | null>(null);

	// 支持按 Escape 键关闭抽屉（必须放在顶部，保证 Hook 调用数量恒定）
	const emptyMap: ReadonlyMap<string, never> = new Map<string, never>();
	const emptyToolStatuses: ReadonlyMap<string, any> = new Map();
	const drawerCfg = ((node?.config ?? {}) as Record<string, string | number | boolean | undefined>) || {};
	/** 专属参数单字段（抽屉样式）：全走 ROLE_FIELDS 总表，与卡片同构 */
	const renderDrawerField = (f: RoleField) => {
		const strVal = String(drawerCfg[f.key] ?? f.default ?? "");
		const setF = (v: string | number | boolean) => onUpdate(node!.id, { config: { ...node!.config, [f.key]: v } });
		let control: ReactNode = null;
		if (f.kind === "textarea") {
			control = (
				<textarea
					className="canvas-drawer-textarea"
					rows={f.rows ?? 3}
					value={strVal}
					onChange={(e) => setF(e.target.value)}
					placeholder={f.placeholder}
				/>
			);
		} else if (f.kind === "number") {
			control = (
				<input
					type="number"
					min={f.min}
					max={f.max}
					className="canvas-drawer-input"
					value={Number(drawerCfg[f.key] ?? f.default ?? 0)}
					onChange={(e) => {
						const raw = Number(e.target.value);
						const v = Number.isFinite(raw) ? raw : Number(f.default ?? 0);
						setF(Math.max(f.min ?? Number.NEGATIVE_INFINITY, Math.min(f.max ?? Number.POSITIVE_INFINITY, v)));
					}}
				/>
			);
		} else if (f.kind === "select") {
			control = (
				<select className="canvas-drawer-input" value={strVal} onChange={(e) => setF(e.target.value)}>
					{(f.options ?? []).map((o) => (
						<option key={o.value} value={o.value}>
							{o.labelZh}
						</option>
					))}
				</select>
			);
		} else if (f.kind === "boolean") {
			control = (
				<input
					type="checkbox"
					checked={drawerCfg[f.key] === true || (drawerCfg[f.key] === undefined && f.default === true)}
					onChange={(e) => setF(e.target.checked)}
				/>
			);
		} else if (f.kind !== "hint") {
			control = (
				<input
					type="text"
					className="canvas-drawer-input"
					value={strVal}
					onChange={(e) => setF(e.target.value)}
					placeholder={f.placeholder}
				/>
			);
		}
		return (
			<label key={f.key} className="canvas-config-row">
				<span>{f.kind === "hint" ? f.labelZh : f.labelZh}</span>
				{control}
				{f.hint && <span className="canvas-muted-note">{f.hint}</span>}
			</label>
		);
	};
	const logKindLabel = (e: CanvasNodeLogEntry) =>
		e.kind === "tool"
			? "🔧 " + (e.toolName || "tool")
			: e.kind === "error"
				? "❌ error"
				: e.kind === "steer"
					? "💬 steer"
					: e.kind === "handoff"
						? "🔗 handoff"
						: e.kind === "review"
							? "🔍 review"
							: e.kind === "prompt"
								? "📝 prompt"
								: e.kind === "done"
									? "✅ done"
									: "ℹ️ system";
	useEffect(() => {
		logScrollRef.current?.scrollTo({ top: logScrollRef.current.scrollHeight });
	}, [logMessages.length, logEntries.length, logTab]);
	useEffect(() => {
		if (!node) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [node, onClose]);

	// 解析出与 ModelThinking 兼容的当前模型对象：绝不杜撰，不存在时回退到全局默认/列表第一个
	const selectedModelObj = useMemo(() => {
		if (!node) return null;
		const raw = node.model;
		const canonical = (m: { provider: string; id: string }) =>
			m.id.startsWith(`${m.provider}/`) ? m.id : `${m.provider}/${m.id}`;
		const normRaw = (() => {
			const s = (raw ?? "").trim();
			const i = s.indexOf("/");
			if (i <= 0) return s;
			const p = s.slice(0, i);
			let rest = s.slice(i + 1);
			while (rest.startsWith(`${p}/`)) rest = rest.slice(p.length + 1);
			return `${p}/${rest}`;
		})();
		const found = models.find((m) => canonical(m) === normRaw || m.id === normRaw);
		if (found) return found;
		if (defaultModel) {
			const def = models.find((m) => `${m.provider}/${m.id}` === defaultModel || m.id === defaultModel);
			if (def) return def;
		}
		if (models.length > 0) return models[0];
		const parts = raw.split("/");
		return {
			id: raw,
			name: parts.length > 1 ? parts.slice(1).join("/") : raw,
			provider: parts.length > 1 ? parts[0] : "custom",
		} as ModelInfo;
	}, [node, models, defaultModel]);

	if (!node) return null;

	const engineMeta = ENGINE_METAS[node.engine] || ENGINE_METAS.pi;
	const roleMeta = ROLE_METAS[node.role] || ROLE_METAS.coder;

	// 查询输入连线（上游契约）
	const incomingEdges = edges.filter((e) => e.targetNodeId === node.id);
	const outgoingEdges = edges.filter((e) => e.sourceNodeId === node.id);
	const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

	const handleSendSteer = () => {
		if (!steerInput.trim()) return;
		onSteer(node.id, steerInput.trim());
		setSteerInput("");
	};

	return (
		<div
			className="canvas-drawer-overlay"
			onPointerDown={(e) => {
				if (e.target === e.currentTarget) {
					e.stopPropagation();
				}
			}}
			onClick={(e) => {
				if (e.target === e.currentTarget) {
					e.stopPropagation();
					onClose();
				}
			}}
		>
			<div
				className="canvas-drawer-panel"
				onPointerDown={(e) => e.stopPropagation()}
				onMouseDown={(e) => e.stopPropagation()}
				onWheel={(e) => e.stopPropagation()}
				onClick={(e) => e.stopPropagation()}
			>
				{/* 抽屉头部 */}
				<div className="canvas-drawer-header">
					<div className="canvas-drawer-title-group">
						<span className="canvas-drawer-role-icon">{roleMeta.icon}</span>
						<div>
							<h3 className="canvas-drawer-title">{node.title}</h3>
							<div className="canvas-drawer-subtitle">
								<span
									className="canvas-engine-chip"
									style={{
										color: engineMeta.color,
										borderColor: engineMeta.color,
										backgroundColor: engineMeta.bgColor,
									}}
								>
									{engineMeta.name}
								</span>
								<span className="canvas-model-chip">{node.model}</span>
							</div>
						</div>
					</div>

					<button type="button" className="canvas-drawer-close" onClick={onClose} title="关闭抽屉">
						<FiX />
					</button>
				</div>

				{/* 抽屉内容区 */}
				<div className="canvas-drawer-body">
					{roleNeedsInstruction(node.role) && (
						<>
							{/* 模型与思考强度配置（通用 ModelThinking 控件） */}
							<div className="canvas-drawer-section">
								<h4 className="canvas-section-title">模型选择与思考强度 (Model & Thinking)</h4>
								<ModelThinking
									state={{
										model: selectedModelObj,
										thinkingLevel: (node.thinkingLevel as ThinkingValue) || "off",
										availableThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
									}}
									models={models}
									direction="down"
									onSelectModel={(m) =>
										onUpdate(node.id, {
											model: m.id.startsWith(`${m.provider}/`) ? m.id : `${m.provider}/${m.id}`,
										})
									}
									onSelectThinking={(lvl) => onUpdate(node.id, { thinkingLevel: lvl })}
								/>
							</div>

							{/* 环境与物理目录（通用 UniversalPathPicker 控件） */}
							<div className="canvas-drawer-section">
								<h4 className="canvas-section-title">工作区沙箱环境</h4>
								<UniversalPathPicker
									cwd={node.cwd}
									onSelectCwd={(c) => onUpdate(node.id, { cwd: c })}
									projects={projects}
									workspaceRoots={workspaceRoots}
									pathCompletions={pathCompletions}
									baseCwd={baseCwd}
									mode="project"
									onCreateProject={
										onMakeDir
											? (p) => {
													onMakeDir(p);
													onUpdate(node.id, { cwd: p });
												}
											: undefined
									}
								/>
								<label className="canvas-checkbox-row" style={{ marginTop: "8px" }}>
									<input
										type="checkbox"
										checked={node.useWorktree}
										onChange={(e) => onUpdate(node.id, { useWorktree: e.target.checked })}
									/>
									<span className="canvas-checkbox-label">
										<FiGitBranch /> 启用独立 Git Worktree 物理隔离 (.worktrees/canvas-{node.id})
									</span>
								</label>
							</div>

							{/* 角色职责与 System Prompt（基座人设） */}
							<div className="canvas-drawer-section">
								<h4 className="canvas-section-title">角色指令规约 (System Prompt)</h4>
								<textarea
									className="canvas-drawer-textarea"
									rows={5}
									value={node.systemPromptOverride || ""}
									onChange={(e) => onUpdate(node.id, { systemPromptOverride: e.target.value })}
									placeholder="输入该数字员工的专属职责人设（基座），与下方「任务指令」配合使用…"
								/>
								<p className="canvas-tip">
									基座人设×任务指令双轨制：人设决定“是谁”，任务指令决定“做什么”。启动优先级：本次手动输入 &gt; 节点 AI
									指令 &gt; 角色规约。
								</p>
							</div>
						</>
					)}

					{/* AI 任务指令（可输入）：LLM 型节点显示 */}
					{roleNeedsInstruction(node.role) && (
						<div className="canvas-drawer-section">
							<h4 className="canvas-section-title canvas-instruction-title">AI 任务指令 (可输入·随图保存)</h4>
							<textarea
								className="canvas-drawer-textarea canvas-instruction-textarea"
								rows={6}
								value={node.instruction || ""}
								onChange={(e) => onUpdate(node.id, { instruction: e.target.value })}
								placeholder="留空=直接使用输入；或例：按照 PRD 完成登录页 {{input}}…"
							/>
							<p className="canvas-tip">
								{"支持变量：{{input}} / {{上游摘要}} / {{upstream}} 引用上游输入；留空 = 直接使用输入。"}
							</p>
						</div>
					)}

					{/* 通用工作流控制参数：条件 / 循环 / 审批 / 工具 / API 等 */}
					{visibleRoleFields(node.role, drawerCfg).length > 0 && (
						<div className="canvas-drawer-section">
							<h4 className="canvas-section-title">节点控制参数</h4>
							{visibleRoleFields(node.role, drawerCfg).map((f) => renderDrawerField(f))}
						</div>
					)}

					{/* 上游任务契约 (Incoming Contracts) */}
					{incomingEdges.length > 0 && (
						<div className="canvas-drawer-section">
							<h4 className="canvas-section-title">上游前置契约 (Incoming Contracts)</h4>
							<div className="canvas-contract-list">
								{incomingEdges.map((edge) => {
									const sourceNode = nodeMap.get(edge.sourceNodeId);
									return (
										<div key={edge.id} className="canvas-contract-card">
											<div className="canvas-contract-header">
												<span>
													来源: <b>{sourceNode?.title || edge.sourceNodeId}</b>
												</span>
												<span className="canvas-contract-type">{edge.type}</span>
											</div>
											<div className="canvas-contract-ports">
												<span className="canvas-port-tag">
													{outPortLabel(edge.sourcePort)} → {inPortLabel(edge.targetPort)}
												</span>
												<label>
													接入本节点端子
													<select
														className="canvas-select"
														value={edge.targetPort || "contract"}
														onChange={(e) => onUpdateEdge?.(edge.id, { targetPort: e.target.value })}
													>
														{IN_PORT_DEFS.map((d) => (
															<option key={d.key} value={d.key}>
																{d.labelZh} — {d.desc}
															</option>
														))}
													</select>
												</label>
											</div>
											<div className="canvas-contract-content">
												{edge.lastHandoffSummary || "（等待上游完成交付后自动注入）"}
											</div>
										</div>
									);
								})}
							</div>
						</div>
					)}

					{/* 下游交接 (Outgoing Handoffs)：本节点各输出端子的连线 */}
					{outgoingEdges.length > 0 && (
						<div className="canvas-drawer-section">
							<h4 className="canvas-section-title">下游交接 (Outgoing Handoffs)</h4>
							<div className="canvas-contract-list">
								{outgoingEdges.map((edge) => {
									const targetNode = nodeMap.get(edge.targetNodeId);
									return (
										<div key={edge.id} className="canvas-contract-card">
											<div className="canvas-contract-header">
												<span>
													去向: <b>{targetNode?.title || edge.targetNodeId}</b>
													<small className="canvas-port-tag">
														{outPortLabel(edge.sourcePort)} → {inPortLabel(edge.targetPort)}
													</small>
												</span>
												<span className="canvas-contract-type">{edge.type}</span>
											</div>
											<div className="canvas-contract-ports">
												<label>
													本节点输出端子
													<select
														className="canvas-select"
														value={edge.sourcePort || "result"}
														onChange={(e) => {
															const v = e.target.value;
															onUpdateEdge?.(edge.id, {
																sourcePort: v,
																type:
																	v === "true"
																		? "condition_true"
																		: v === "false"
																			? "condition_false"
																			: v === "approve"
																				? "approve"
																				: v === "reject"
																					? "reject"
																					: edge.type,
															});
														}}
													>
														{outPortsForRole(node.role).map((d) => (
															<option key={d.key} value={d.key}>
																{d.labelZh} — {d.desc}
															</option>
														))}
													</select>
												</label>
											</div>
										</div>
									);
								})}
							</div>
						</div>
					)}

					{/* 任务交付物与审查门禁 (Review Gate) */}
					<div className="canvas-drawer-section">
						<h4 className="canvas-section-title">任务交付与审查门禁 (Review Gate)</h4>
						<div className="canvas-review-gate-box">
							<div className="canvas-review-status-row">
								<span>当前状态：</span>
								<b className={`status-badge status-${node.status}`}>{node.status.toUpperCase()}</b>
							</div>
							<div className="canvas-summary-box">
								{node.status === "error" && node.error ? (
									<div>
										<p className="canvas-summary-text canvas-summary-error">执行失败：{node.error}</p>
										<div className="canvas-review-actions">
											<button type="button" className="canvas-btn green" onClick={() => onRun(node.id)}>
												<FiPlay /> 重跑本节点
											</button>
										</div>
									</div>
								) : node.lastOutputSummary ? (
									<div>
										<p className="canvas-summary-text">{node.lastOutputSummary}</p>
										<div className="canvas-review-actions">
											<button
												type="button"
												className="canvas-btn green"
												onClick={() => {
													if (onReview) onReview(node.id, "approve");
													else onUpdate(node.id, { status: "done", currentAction: "人工审查批准合流" });
												}}
											>
												<FiCheckCircle /> 审查通过并批准
											</button>
											<button
												type="button"
												className="canvas-btn orange"
												onClick={() => {
													if (onReview) onReview(node.id, "reject");
													else
														onUpdate(node.id, {
															status: "waiting_approval",
															currentAction: "人工驳回：需补充完善测试与注释",
														});
												}}
											>
												<FiAlertCircle /> 驳回修改
											</button>
										</div>
									</div>
								) : (
									<span className="canvas-text-muted">暂无交付物产出，等待节点执行完成。</span>
								)}
							</div>
						</div>
					</div>

					{/* 运行中实时插话干预 (Steer Console) */}
					<div className="canvas-drawer-section">
						<h4 className="canvas-section-title">实时插话干预 (Steer)</h4>
						<p className="canvas-tip">数字员工在后台干活时，你随时可以敲字发指令插话纠偏，信息会直接投递进当前会话。</p>
						{/* 对话实录：复用主对话流 + 协同事件，调用/错误/协同清晰可见 */}
						<div className="canvas-drawer-section canvas-log-section">
							<div className="canvas-log-header">
								<h4 className="canvas-section-title">对话实录</h4>
								<div className="canvas-log-tabs">
									<button
										type="button"
										className={"canvas-log-tab " + (logTab === "chat" ? "active" : "")}
										onClick={() => setLogTab("chat")}
										title="复用主对话流的消息"
									>
										<FiMessageSquare /> 对话 {logMessages.length ? "(" + logMessages.length + ")" : ""}
									</button>
									<button
										type="button"
										className={"canvas-log-tab " + (logTab === "events" ? "active" : "")}
										onClick={() => setLogTab("events")}
										title="调用/错误/协同事件"
									>
										<FiActivity /> 事件 {logEntries.length ? "(" + logEntries.length + ")" : ""}
									</button>
									{(logEntries.length > 0 || logMessages.length > 0) && onClearLog && (
										<button
											type="button"
											className="canvas-log-clear"
											onClick={() => onClearLog(node.id)}
											title="清空对话实录"
										>
											<FiTrash2 />
										</button>
									)}
								</div>
							</div>
							<div className="canvas-log-body" ref={logScrollRef}>
								{logTab === "chat" ? (
									logMessages.length === 0 ? (
										<span className="canvas-text-muted">
											暂无对话消息：启动节点后，这里复用主对话流实时显示每一轮调用与回复。
										</span>
									) : (
										logMessages.slice(-100).map((m) => (
											<div key={m.id} className="canvas-log-msg">
												<Message
													message={m}
													readOnly
													toolResults={emptyMap as ReadonlyMap<string, UiMessage>}
													liveOutputs={emptyMap as ReadonlyMap<string, { toolName: string; text: string }>}
													toolStatuses={emptyToolStatuses as ReadonlyMap<string, never>}
													streaming={false}
													isLast={false}
												/>
											</div>
										))
									)
								) : logEntries.length === 0 ? (
									<span className="canvas-text-muted">暂无协同事件：工具调用、报错、插话与交接都会记在这里。</span>
								) : (
									logEntries.slice(-200).map((e) => (
										<div key={e.id} className={"canvas-log-entry kind-" + e.kind}>
											<span className="canvas-log-kind">{logKindLabel(e)}</span>
											<span className="canvas-log-time">{new Date(e.ts).toLocaleTimeString()}</span>
											<div className="canvas-log-text">{e.text}</div>
										</div>
									))
								)}
							</div>
						</div>

						<div className="canvas-steer-bar">
							<input
								type="text"
								className="canvas-steer-input"
								placeholder="输入实时纠偏意见 (如: 别修改 styles.css，只在组件内局部改动)..."
								value={steerInput}
								onChange={(e) => setSteerInput(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleSendSteer();
								}}
							/>
							<button type="button" className="canvas-steer-btn" onClick={handleSendSteer} title="发送插话">
								<FiSend />
							</button>
						</div>
					</div>
				</div>

				{/* 抽屉底部控制 */}
				<div className="canvas-drawer-footer">
					{node.status === "running" ? (
						<button type="button" className="canvas-btn stop" onClick={() => onStop(node.id)}>
							<FiSquare /> 停止当前任务
						</button>
					) : (
						<button type="button" className="canvas-btn run" onClick={() => onRun(node.id)}>
							<FiPlay /> 启动该节点
						</button>
					)}
					<button type="button" className="canvas-btn" onClick={onClose}>
						关闭
					</button>
				</div>
			</div>
		</div>
	);
}
