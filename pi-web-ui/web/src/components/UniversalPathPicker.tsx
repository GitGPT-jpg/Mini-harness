/**
 * UniversalPathPicker.tsx — 全项目通用的工作区与目录路径选择组件（自包含）。
 *
 * 整合：
 * 1. 路径显示与直接编辑；
 * 2. 常用子目录推荐与最近项目 (projects) 下拉菜单；
 * 3. 内置 ProjectPicker 目录浏览器弹窗（含本地/远程 SSH 新建文件夹与新建项目）。
 *
 * 调用方只需传 cwd + onSelectCwd(+ 可选 projects/workspaceRoots/pathCompletions)，
 * 不必再在外层接线弹窗 state。仍在外层自管弹窗的旧调用处可继续传
 * onOpenProjectPicker（此时内置弹窗不再挂载）。
 */
import { useState, useRef, useEffect } from "react";
import type { ProjectSummary } from "../types";
import { useT } from "../i18n";
import { FiFolder, FiFolderPlus, FiChevronDown, FiClock } from "react-icons/fi";
import { ProjectPicker } from "./ProjectPicker";
import { TipButton } from "./HintTip";

export interface UniversalPathPickerProps {
	cwd: string;
	onSelectCwd: (cwd: string) => void;
	/** 旧式外接弹窗：传入则点击浏览按钮时调用它（内置弹窗不挂载）；缺省走内置 ProjectPicker */
	onOpenProjectPicker?: () => void;
	projects?: ProjectSummary[];
	workspaceRoots?: string[];
	pathCompletions?: { name: string; path: string; type: "dir" | "file" }[];
	/** folder=选目录（建完停留刷新）/project=选项目（建完即选），默认 project */
	mode?: "folder" | "project";
	/** cwd 为 "." 或空时的弹窗初始目录回退（如画布 currentCwd），缺省用 cwd 本身 */
	baseCwd?: string;
	/** 自定义创建：缺省走 DirectoryBrowser 内置回退（mkdir + 选中新目录） */
	onCreateProject?: (path: string) => void;
	className?: string;
	placeholder?: string;
}

export function UniversalPathPicker({
	cwd,
	onSelectCwd,
	onOpenProjectPicker,
	projects = [],
	workspaceRoots = [],
	pathCompletions = [],
	mode = "project",
	baseCwd,
	onCreateProject,
	className = "",
	placeholder = "如 . 或 web 或绝对路径",
}: UniversalPathPickerProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);
	const t = useT();

	// 点击外部自动关闭快捷菜单
	useEffect(() => {
		const handleOutside = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
				setMenuOpen(false);
			}
		};
		if (menuOpen) {
			window.addEventListener("mousedown", handleOutside);
			return () => window.removeEventListener("mousedown", handleOutside);
		}
	}, [menuOpen]);

	// 推荐常用子目录
	const commonDirs = [
		{ label: ". (当前项目根目录)", value: "." },
		{ label: "web (前端目录)", value: "web" },
		{ label: "server (后端服务)", value: "server" },
		{ label: "tests (测试套件)", value: "tests" },
		{ label: "src (源码目录)", value: "src" },
		{ label: "docs (文档目录)", value: "docs" },
	];

	const openPicker = () => {
		if (onOpenProjectPicker) {
			onOpenProjectPicker();
		} else {
			setMenuOpen(false);
			setPickerOpen(true);
		}
	};

	// 弹窗初始目录：相对/缺省 cwd 回退到 baseCwd（旧中央弹窗的 currentCwd 回退语义）
	const pickerCwd = cwd && cwd !== "." ? cwd : baseCwd || cwd || ".";

	return (
		<div className={`universal-path-picker-root ${className}`} ref={wrapRef}>
			<div className="universal-path-input-group">
				<FiFolder className="universal-path-icon" />
				<input
					type="text"
					className="universal-path-input"
					value={cwd}
					onChange={(e) => onSelectCwd(e.target.value)}
					placeholder={placeholder}
					title={`工作目录: ${cwd || "."}`}
				/>
				<button
					type="button"
					className="universal-path-dropdown-toggle"
					onClick={() => setMenuOpen(!menuOpen)}
					title="选择推荐子目录或最近项目"
				>
					<FiChevronDown />
				</button>
			</div>

			<TipButton className="universal-path-browse-btn" tip={t("projectPickerTitle")} onClick={openPicker}>
				<FiFolderPlus />
			</TipButton>

			{menuOpen && (
				<div
					className="universal-path-menu"
					onPointerDown={(e) => e.stopPropagation()}
					onMouseDown={(e) => e.stopPropagation()}
					onWheel={(e) => e.stopPropagation()}
				>
					{workspaceRoots.length > 0 && (
						<>
							<div className="universal-path-menu-header">工作区根目录</div>
							{workspaceRoots.map((root) => (
								<button
									key={root}
									type="button"
									className="universal-path-menu-item"
									onClick={() => {
										onSelectCwd(root);
										setMenuOpen(false);
									}}
								>
									<span className="path-label">{root}</span>
								</button>
							))}
						</>
					)}

					<div className="universal-path-menu-header">推荐子目录</div>
					{commonDirs.map((d) => (
						<button
							key={d.value}
							type="button"
							className="universal-path-menu-item"
							onClick={() => {
								onSelectCwd(d.value);
								setMenuOpen(false);
							}}
						>
							<span className="path-label">{d.label}</span>
						</button>
					))}

					{projects.length > 0 && (
						<>
							<div className="universal-path-menu-header">
								<FiClock /> 最近项目
							</div>
							{projects.slice(0, 6).map((p) => {
								const folderName = p.path.split(/[/\\]/).filter(Boolean).pop() || p.path;
								return (
									<button
										key={p.path}
										type="button"
										className="universal-path-menu-item"
										onClick={() => {
											onSelectCwd(p.path);
											setMenuOpen(false);
										}}
										title={p.path}
									>
										<span className="path-title">{folderName}</span>
										<span className="path-sub">{p.path}</span>
									</button>
								);
							})}
						</>
					)}
				</div>
			)}

			{/* 自带弹窗：未外接 onOpenProjectPicker 时挂载，创建走内置回退或 onCreateProject */}
			{!onOpenProjectPicker && pickerOpen && (
				<ProjectPicker
					open
					currentCwd={pickerCwd}
					pathCompletions={pathCompletions}
					workspaceRoots={workspaceRoots}
					onClose={() => setPickerOpen(false)}
					onSelectDirectory={(p) => {
						onSelectCwd(p);
						setPickerOpen(false);
					}}
					onCreateProject={
						onCreateProject
							? (p) => {
									onCreateProject(p);
									setPickerOpen(false);
								}
							: undefined
					}
					mode={mode}
				/>
			)}
		</div>
	);
}
