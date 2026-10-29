/**
 * CanvasToolbar.tsx — 画布协作工作室顶部浮动控制栏。
 *
 * 功能区：工程管理 | 通用节点库 + 战队模板 | 调度控制 | 视口缩放
 */
import { useState, useRef, useEffect } from "react";
import type { CanvasCustomCard, CanvasGraph, CanvasGraphSummary, CanvasNodeRole } from "../../types";
import { SQUAD_TEMPLATES } from "./CanvasTemplates";
import { NODE_GROUPS, ROLE_METAS } from "./CanvasTypes";
import {
	FiPlus,
	FiPlay,
	FiSquare,
	FiRotateCcw,
	FiZoomIn,
	FiZoomOut,
	FiMaximize2,
	FiUsers,
	FiFolder,
	FiSave,
	FiTrash2,
	FiEdit3,
	FiFilePlus,
	FiTarget,
} from "react-icons/fi";

interface CanvasToolbarProps {
	graph: CanvasGraph;
	graphList: CanvasGraphSummary[];
	onSelectGraph: (id: string) => void;
	onSave: () => void;
	onAddNode: (role?: CanvasNodeRole) => void;
	customCards?: CanvasCustomCard[];
	onPlaceCard?: (card: CanvasCustomCard) => void;
	onDeleteCard?: (id: string) => void;
	onApplyTemplate: (templateGraph: CanvasGraph) => void;
	onRunAll: () => void;
	onStopAll: () => void;
	onResetStatus: () => void;
	onCreateGraph: (name: string) => void;
	onDeleteGraph: (id: string) => void;
	onRenameGraph: (name: string) => void;
	onFitView: () => void;
	onUndo: () => void;
	onRedo: () => void;
	onDuplicate: () => void;
	onAutoLayout: () => void;
	zoom: number;
	onZoomChange: (newZoom: number) => void;
	onResetViewport: () => void;
	hasUnsavedChanges?: boolean;
}

export function CanvasToolbar({
	graph,
	graphList,
	onSelectGraph,
	onSave,
	onAddNode,
	customCards = [],
	onPlaceCard,
	onDeleteCard,
	onApplyTemplate,
	onRunAll,
	onStopAll,
	onResetStatus,
	onCreateGraph,
	onDeleteGraph,
	onRenameGraph,
	onFitView,
	onUndo,
	onRedo,
	onDuplicate,
	onAutoLayout,
	zoom,
	onZoomChange,
	onResetViewport,
	hasUnsavedChanges,
}: CanvasToolbarProps) {
	const [showSquadMenu, setShowSquadMenu] = useState(false);
	const [showGraphMenu, setShowGraphMenu] = useState(false);
	const [showNodeMenu, setShowNodeMenu] = useState(false);
	const [renamingGraph, setRenamingGraph] = useState(false);
	const [renameValue, setRenameValue] = useState("");
	const [creatingGraph, setCreatingGraph] = useState(false);
	const [createValue, setCreateValue] = useState("");

	const squadMenuRef = useRef<HTMLDivElement>(null);
	const graphMenuRef = useRef<HTMLDivElement>(null);
	const nodeMenuRef = useRef<HTMLDivElement>(null);
	const renameInputRef = useRef<HTMLInputElement>(null);
	const createInputRef = useRef<HTMLInputElement>(null);

	// 点击外部关闭下拉菜单
	useEffect(() => {
		if (!showSquadMenu && !showGraphMenu && !showNodeMenu) return;
		const handleClick = (e: MouseEvent) => {
			if (showSquadMenu && squadMenuRef.current && !squadMenuRef.current.contains(e.target as Node)) {
				setShowSquadMenu(false);
			}
			if (showGraphMenu && graphMenuRef.current && !graphMenuRef.current.contains(e.target as Node)) {
				setShowGraphMenu(false);
			}
			if (showNodeMenu && nodeMenuRef.current && !nodeMenuRef.current.contains(e.target as Node)) {
				setShowNodeMenu(false);
			}
		};
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [showSquadMenu, showGraphMenu, showNodeMenu]);

	// 自动聚焦重命名输入框
	useEffect(() => {
		if (renamingGraph && renameInputRef.current) {
			renameInputRef.current.focus();
			renameInputRef.current.select();
		}
	}, [renamingGraph]);

	// 自动聚焦新建输入框
	useEffect(() => {
		if (creatingGraph && createInputRef.current) {
			createInputRef.current.focus();
		}
	}, [creatingGraph]);

	const handleRenameSubmit = () => {
		const trimmed = renameValue.trim();
		if (trimmed && trimmed !== graph.name) {
			onRenameGraph(trimmed);
		}
		setRenamingGraph(false);
	};

	const handleCreateSubmit = () => {
		const trimmed = createValue.trim();
		if (trimmed) {
			onCreateGraph(trimmed);
		}
		setCreatingGraph(false);
		setCreateValue("");
	};

	const handleDeleteCurrentGraph = () => {
		if (graphList.length <= 1) return; // 至少保留一个工程
		const confirmed = window.confirm(`确定要删除画布工程「${graph.name}」吗？\n此操作不可撤销。`);
		if (confirmed) {
			onDeleteGraph(graph.id);
		}
	};

	return (
		<div className="canvas-toolbar">
			{/* 工程管理区 */}
			<div className="canvas-toolbar-group">
				<FiFolder className="canvas-toolbar-icon" />

				{renamingGraph ? (
					<input
						ref={renameInputRef}
						className="canvas-toolbar-rename-input"
						value={renameValue}
						onChange={(e) => setRenameValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") handleRenameSubmit();
							else if (e.key === "Escape") setRenamingGraph(false);
						}}
						onBlur={handleRenameSubmit}
						placeholder="工程名称"
					/>
				) : (
					<select
						className="canvas-toolbar-select"
						value={graph.id}
						onChange={(e) => onSelectGraph(e.target.value)}
						title="切换画布工程"
					>
						{graphList.map((g) => (
							<option key={g.id} value={g.id}>
								{g.name} ({g.nodeCount}人)
							</option>
						))}
					</select>
				)}

				<div className="canvas-dropdown-wrap" ref={graphMenuRef}>
					<button
						type="button"
						className="canvas-toolbar-btn"
						onClick={() => setShowGraphMenu(!showGraphMenu)}
						title="工程管理菜单"
					>
						▾
					</button>
					{showGraphMenu && (
						<div
							className="canvas-dropdown-menu"
							onPointerDown={(e) => e.stopPropagation()}
							onMouseDown={(e) => e.stopPropagation()}
							onWheel={(e) => e.stopPropagation()}
						>
							{creatingGraph ? (
								<div className="canvas-dropdown-item canvas-inline-create" onPointerDown={(e) => e.stopPropagation()}>
									<input
										ref={createInputRef}
										className="canvas-inline-input"
										value={createValue}
										onChange={(e) => setCreateValue(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												handleCreateSubmit();
												setShowGraphMenu(false);
											} else if (e.key === "Escape") {
												setCreatingGraph(false);
											}
										}}
										placeholder="输入新工程名称..."
										onClick={(e) => e.stopPropagation()}
									/>
									<button
										type="button"
										className="canvas-inline-confirm"
										onClick={(e) => {
											e.stopPropagation();
											handleCreateSubmit();
											setShowGraphMenu(false);
										}}
									>
										✓
									</button>
								</div>
							) : (
								<button type="button" className="canvas-dropdown-item" onClick={() => setCreatingGraph(true)}>
									<b>
										<FiFilePlus style={{ verticalAlign: "middle" }} /> 新建画布工程
									</b>
									<small>创建一个全新的空白画布</small>
								</button>
							)}
							<button
								type="button"
								className="canvas-dropdown-item"
								onClick={() => {
									setRenameValue(graph.name);
									setRenamingGraph(true);
									setShowGraphMenu(false);
								}}
							>
								<b>
									<FiEdit3 style={{ verticalAlign: "middle" }} /> 重命名当前工程
								</b>
								<small>修改「{graph.name}」的名称</small>
							</button>
							<button
								type="button"
								className="canvas-dropdown-item canvas-dropdown-item-danger"
								onClick={() => {
									handleDeleteCurrentGraph();
									setShowGraphMenu(false);
								}}
								disabled={graphList.length <= 1}
								title={graphList.length <= 1 ? "至少需保留一个画布工程" : ""}
							>
								<b>
									<FiTrash2 style={{ verticalAlign: "middle" }} /> 删除当前工程
								</b>
								<small>{graphList.length <= 1 ? "仅剩一个工程，无法删除" : `永久删除「${graph.name}」`}</small>
							</button>
						</div>
					)}
				</div>

				<button
					type="button"
					className={`canvas-toolbar-btn ${hasUnsavedChanges ? "canvas-unsaved" : ""}`}
					onClick={onSave}
					title={hasUnsavedChanges ? "有未保存的更改 (Ctrl+S)" : "保存当前工程 (Ctrl+S)"}
				>
					<FiSave />
				</button>
			</div>

			<div className="canvas-toolbar-divider" />

			{/* 通用节点库 + 预设战队 */}
			<div className="canvas-toolbar-group">
				<button
					type="button"
					className="canvas-toolbar-btn primary"
					onClick={() => onAddNode("coder")}
					title="快速新增一个研发工程师节点，更多类型请点右侧节点库"
				>
					<FiPlus /> 新增队友
				</button>

				<div className="canvas-dropdown-wrap" ref={nodeMenuRef}>
					<button
						type="button"
						className="canvas-toolbar-btn"
						onClick={() => setShowNodeMenu(!showNodeMenu)}
						title="通用节点库：触发 / 智能体 / 逻辑控制 / 工具数据 / 评估收尾（对标 LangGraph / n8n / Dify）"
					>
						节点库 ▾
					</button>

					{showNodeMenu && (
						<div
							className="canvas-dropdown-menu canvas-node-palette"
							onPointerDown={(e) => e.stopPropagation()}
							onMouseDown={(e) => e.stopPropagation()}
							onWheel={(e) => e.stopPropagation()}
						>
							{customCards.length > 0 && (
								<div className="canvas-palette-group">
									<div className="canvas-palette-group-title">自定义卡片（{customCards.length}）</div>
									{customCards.map((c) => (
										<div
											key={c.id}
											className="canvas-dropdown-item"
											style={{ display: "flex", alignItems: "center", gap: 6 }}
										>
											<button
												type="button"
												style={{ flex: 1, textAlign: "left", background: "none", border: "none", cursor: "pointer" }}
												onClick={() => {
													onPlaceCard?.(c);
													setShowNodeMenu(false);
												}}
												title={c.role + (c.instruction ? "：" + c.instruction.slice(0, 80) : "")}
											>
												<b>🧩 {c.title}</b>
												<small>{c.role}</small>
											</button>
											<button
												type="button"
												className="canvas-toolbar-btn"
												onClick={() => onDeleteCard?.(c.id)}
												title={"删除卡片 " + c.title}
											>
												×
											</button>
										</div>
									))}
								</div>
							)}
							{NODE_GROUPS.map((g) => (
								<div key={g.id} className="canvas-palette-group">
									<div className="canvas-palette-group-title">{g.labelZh}</div>
									{(Object.values(ROLE_METAS) as (typeof ROLE_METAS)[keyof typeof ROLE_METAS][])
										.filter((m) => m.group === g.id)
										.map((m) => (
											<button
												key={m.role}
												type="button"
												className="canvas-dropdown-item"
												onClick={() => {
													onAddNode(m.role);
													setShowNodeMenu(false);
												}}
												title={m.blurb}
											>
												<b>
													<span style={{ marginRight: 6 }}>{m.icon}</span>
													{m.labelZh}
												</b>
												<small>{m.blurb}</small>
											</button>
										))}
								</div>
							))}
						</div>
					)}
				</div>

				<div className="canvas-dropdown-wrap" ref={squadMenuRef}>
					<button
						type="button"
						className="canvas-toolbar-btn"
						onClick={() => setShowSquadMenu(!showSquadMenu)}
						title="加载官方开箱即用战队模板"
					>
						<FiUsers /> 战队模板 ▾
					</button>

					{showSquadMenu && (
						<div
							className="canvas-dropdown-menu"
							onPointerDown={(e) => e.stopPropagation()}
							onMouseDown={(e) => e.stopPropagation()}
							onWheel={(e) => e.stopPropagation()}
						>
							{SQUAD_TEMPLATES.map((tmpl) => (
								<button
									key={tmpl.id}
									type="button"
									className="canvas-dropdown-item"
									onClick={() => {
										onApplyTemplate(tmpl.createGraph());
										setShowSquadMenu(false);
									}}
								>
									<b>{tmpl.title}</b>
									<small>{tmpl.desc}</small>
								</button>
							))}
						</div>
					)}
				</div>
			</div>

			<div className="canvas-toolbar-divider" />

			{/* 全图调度控制 */}
			<div className="canvas-toolbar-group">
				{graph.status === "running" ? (
					<button type="button" className="canvas-toolbar-btn stop" onClick={onStopAll} title="全部停止">
						<FiSquare /> 全部停止
					</button>
				) : (
					<button type="button" className="canvas-toolbar-btn run" onClick={onRunAll} title="启动全队流水线">
						<FiPlay /> 启动流水线
					</button>
				)}

				<button type="button" className="canvas-toolbar-btn" onClick={onResetStatus} title="重置全队状态为待命 (idle)">
					<FiRotateCcw /> 复位
				</button>
			</div>

			<div className="canvas-toolbar-divider" />

			<div className="canvas-toolbar-group">
				<button type="button" className="canvas-toolbar-btn" onClick={onUndo} title="撤销 (Ctrl+Z)">
					↩
				</button>
				<button type="button" className="canvas-toolbar-btn" onClick={onRedo} title="重做 (Ctrl+Shift+Z)">
					↪
				</button>
				<button type="button" className="canvas-toolbar-btn" onClick={onDuplicate} title="复制选中节点 (Ctrl+D)">
					⧉
				</button>
				<button type="button" className="canvas-toolbar-btn" onClick={onAutoLayout} title="一键自动布局">
					⛶
				</button>
			</div>

			<div className="canvas-toolbar-divider" />

			{/* 视口缩放与居中控制 */}
			<div className="canvas-toolbar-group">
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={() => onZoomChange(Math.max(zoom - 0.15, 0.25))}
					title="缩小"
				>
					<FiZoomOut />
				</button>
				<button type="button" className="canvas-toolbar-btn" onClick={onResetViewport} title="恢复 100% 居中视图">
					<FiMaximize2 /> {Math.round(zoom * 100)}%
				</button>
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={() => onZoomChange(Math.min(zoom + 0.15, 2.0))}
					title="放大"
				>
					<FiZoomIn />
				</button>
				<button type="button" className="canvas-toolbar-btn" onClick={onFitView} title="适配所有节点到视口 (Ctrl+0)">
					<FiTarget />
				</button>
			</div>
		</div>
	);
}
