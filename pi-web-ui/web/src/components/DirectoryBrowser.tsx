import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	FiArrowRight,
	FiArrowUp,
	FiBookmark,
	FiCheck,
	FiFolder,
	FiFolderPlus,
	FiHardDrive,
	FiHome,
	FiMonitor,
	FiX,
} from "react-icons/fi";
import { isZhLocale, useLocale, useT } from "../i18n";
import { appSend, useAppField } from "../app-globals";
import { TipButton } from "./HintTip.js";

/** 机器根（此电脑/盘符列表）wire 字面量 —— 与 server/files-service.ts 的 MACHINE_ROOT 同值。 */
export const MACHINE_ROOT = "@root";

export const browseQuery = (p: string) => (p.endsWith("/") ? p : p + "/");

/**
 * 规范拼接工作目录父路径与新建子目录名称。
 * 该函数只负责正斜杠路径连接；服务端负责解析为原生绝对路径。
 */
export function joinProjectPath(parent: string, name: string): string {
	const trimmedName = name.trim();
	const normParent = parent.replace(/\\/g, "/");
	if (normParent.endsWith("/")) {
		return normParent + trimmedName;
	}
	if (/^[A-Za-z]:$/.test(normParent)) {
		return normParent + "/" + trimmedName;
	}
	return normParent + "/" + trimmedName;
}

/** 校验新建项目名称：不能包含分隔符、不能为 . 或 ..、不能唯空。 */
export function isValidProjectName(name: string): boolean {
	const trimmed = name.trim();
	if (!trimmed) return false;
	if (trimmed === "." || trimmed === "..") return false;
	if (trimmed.includes("/") || trimmed.includes("\\")) return false;
	return true;
}

/** Parent of an absolute "/"-separated path; null at the filesystem root. */
export const parentOf = (p: string): string | null => {
	const s = p.endsWith("/") && p !== "/" ? p.slice(0, -1) : p;
	if (s === MACHINE_ROOT || s === "/") return null;
	const i = s.lastIndexOf("/");
	if (i < 0) {
		return /^[A-Za-z]:$/.test(s) ? MACHINE_ROOT : null;
	}
	if (i === 0) return "/";
	const parent = s.slice(0, i);
	return /^[A-Za-z]:$/.test(parent) ? parent + "/" : parent;
};

interface DirectoryBrowserProps {
	currentCwd: string;
	pathCompletions: { name: string; path: string; type: "dir" | "file" }[];
	workspaceRoots: string[];
	onClose: () => void;
	onSelectDirectory: (path: string) => void;
	mode?: "folder" | "project";
	onCreateProject?: (path: string) => void;
	className?: string;
	backdropClassName?: string;
	role?: string;
	ariaLabel?: string;
}

export function DirectoryBrowser({
	currentCwd,
	pathCompletions,
	workspaceRoots,
	onClose,
	onSelectDirectory,
	mode = "folder",
	onCreateProject,
	className,
	backdropClassName,
	role,
	ariaLabel,
}: DirectoryBrowserProps) {
	const t = useT();
	const isZh = isZhLocale(useLocale());
	// 常用目录跳转（快照直给的绝对路径；旧服务空串则不渲染对应按钮）
	const homeDir = useAppField("homeDir");
	const desktopDir = useAppField("desktopDir");

	// ===== 本地文件浏览状态 =====
	const [browsePath, setBrowsePath] = useState("");
	const [draft, setDraft] = useState("");
	const [showNew, setShowNew] = useState(false);
	const [newName, setNewName] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);
	const [compIndex, setCompIndex] = useState(-1);
	const inputRef = useRef<HTMLInputElement>(null);
	const newInputRef = useRef<HTMLInputElement>(null);

	const dirs = pathCompletions.filter((c) => c.type === "dir");

	// 初始化本地路径
	useEffect(() => {
		const norm = (currentCwd || "").replace(/\\/g, "/");
		setBrowsePath(norm);
		setDraft(norm);
		setShowNew(false);
		setNewName("");
		setLocalError(null);
		setCompIndex(-1);
	}, [currentCwd]);

	// 打开后聚焦输入框
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			inputRef.current?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, []);

	// 全局 Escape 键监听
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				if (showNew) {
					setShowNew(false);
					setNewName("");
					setLocalError(null);
				} else {
					onClose();
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [showNew, onClose]);

	// 本地目录浏览请求（60ms 防抖）
	useEffect(() => {
		const timer = setTimeout(() => {
			appSend({ type: "complete_path", path: browseQuery(browsePath) });
		}, 60);
		return () => clearTimeout(timer);
	}, [browsePath]);

	// 本地自由路径打字补全（150ms 防抖）
	useEffect(() => {
		if (draft === browsePath) return;
		const timer = setTimeout(() => {
			appSend({ type: "complete_path", path: draft });
		}, 150);
		return () => clearTimeout(timer);
	}, [draft, browsePath]);

	const commitLocal = (path: string) => {
		const trimmed = path.trim();
		if (!trimmed || trimmed === MACHINE_ROOT) return;
		onSelectDirectory(trimmed);
	};

	// 常用目录一键跳转：此电脑 / 用户目录 / 桌面（与右侧文件树 crumbs 同一条路）
	const goQuickJump = (target: string) => {
		setBrowsePath(target);
		setDraft(target);
		setCompIndex(-1);
		setLocalError(null);
	};

	const handleCreateLocal = () => {
		const trimmed = newName.trim();
		if (!trimmed || browsePath === MACHINE_ROOT) return;

		if (mode === "project") {
			if (!isValidProjectName(trimmed)) {
				setLocalError(t("invalidProjectName"));
				return;
			}
			const fullPath = joinProjectPath(browsePath, trimmed);
			if (onCreateProject) {
				onCreateProject(fullPath);
			} else {
				appSend({ type: "make_dir", path: fullPath });
				onSelectDirectory(fullPath);
			}
			setShowNew(false);
			setNewName("");
			setLocalError(null);
			onClose();
		} else {
			appSend({ type: "make_dir", path: `${browseQuery(browsePath)}${trimmed}` });
			setTimeout(() => {
				appSend({ type: "complete_path", path: browseQuery(browsePath) });
			}, 80);
			setNewName("");
			setShowNew(false);
		}
	};

	const onLocalKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			if (showNew) {
				setShowNew(false);
				setNewName("");
				setLocalError(null);
			} else {
				onClose();
			}
		} else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
			commitLocal(draft);
		} else if (e.key === "Tab") {
			if (dirs.length === 0) return;
			e.preventDefault();
			const idx = compIndex >= 0 ? (compIndex + 1) % dirs.length : 0;
			setCompIndex(idx);
			setDraft(dirs[idx].path);
			setBrowsePath(dirs[idx].path);
		}
	};

	const upPath = parentOf(browsePath);
	const norm = (p: string) => {
		const f = p.replace(/\\/g, "/").replace(/\/+$/, "");
		return /^[A-Za-z]:/.test(f) ? f.toLowerCase() : f;
	};
	const cur = norm(browsePath);
	const canAddRoot =
		Boolean(browsePath) &&
		browsePath !== MACHINE_ROOT &&
		cur !== norm(currentCwd) &&
		!workspaceRoots.some((r) => norm(r) === cur);

	/* Portal 到 body：选择器从底栏（.statusbar）或左栏打开时，祖先的 opacity<1 会把
	   整个弹层层层相乘（主题里 `.statusbar *{opacity:.95}` → 底部按钮 0.95^5≈0.77，
	   背景看起来透明），并且会把它锁进祖先的 stacking context，被侧边浮标等
	   z-index>50 的元素压住。挂到 body 后 opacity 与层级都只取决于自身。 */
	return createPortal(
		<>
			<div
				className={`status-cwd-backdrop ${backdropClassName ?? ""}`.trim()}
				onClick={onClose}
				onPointerDown={(e) => e.stopPropagation()}
				onMouseDown={(e) => e.stopPropagation()}
			/>
			<div
				className={`cwd-picker ${className ?? ""}`.trim()}
				role={role}
				aria-label={ariaLabel}
				onPointerDown={(e) => e.stopPropagation()}
				onMouseDown={(e) => e.stopPropagation()}
				onWheel={(e) => e.stopPropagation()}
			>
				<div className="cwd-mode-tabs">
					<button type="button" className="cwd-close" title={t("close")} aria-label={t("close")} onClick={onClose}>
						<FiX />
					</button>
				</div>

				{/* 本地目录视图 */}
				<div className="cwd-picker-head">
					<span className="cwd-picker-title" title={browsePath === MACHINE_ROOT ? t("computer") : browsePath}>
						{browsePath === MACHINE_ROOT ? <FiHardDrive /> : <FiFolder />}
						<span>{browsePath === MACHINE_ROOT ? t("computer") : browsePath}</span>
					</span>
				</div>
				{/* 单行图标工具栏（旧 head 三按钮与跳转行合并，去掉重复的此电脑）：跳转 | 导航 | 新建 | 选定 */}
				<div className="cwd-toolbar" role="toolbar" aria-label={t("projectPickerTitle")}>
					<TipButton
						className={`cwd-jump ${browsePath === MACHINE_ROOT ? "active" : ""}`}
						tip={t("computer")}
						onClick={() => goQuickJump(MACHINE_ROOT)}
					>
						<FiHardDrive />
					</TipButton>
					{homeDir !== "" && (
						<TipButton
							className={`cwd-jump ${norm(browsePath) === norm(homeDir) ? "active" : ""}`}
							tip={`${t("homeDir")} ${homeDir}`}
							onClick={() => goQuickJump(homeDir)}
						>
							<FiHome />
						</TipButton>
					)}
					{desktopDir !== "" && (
						<TipButton
							className={`cwd-jump ${norm(browsePath) === norm(desktopDir) ? "active" : ""}`}
							tip={`${t("desktopDir")} ${desktopDir}`}
							onClick={() => goQuickJump(desktopDir)}
						>
							<FiMonitor />
						</TipButton>
					)}
					<span className="cwd-toolbar-sep" aria-hidden="true" />
					<TipButton
						className="cwd-jump tool-up"
						tip={upPath ? `${t("cwdGoUp")} · ${upPath}` : `${t("cwdGoUp")} · ${isZh ? "已在顶层" : "already at top"}`}
						aria-disabled={!upPath}
						onClick={() => {
							if (upPath) goQuickJump(upPath);
						}}
					>
						<FiArrowUp />
					</TipButton>
					<TipButton
						className="cwd-jump tool-root"
						tip={
							canAddRoot
								? t("addWorkspaceRootHint")
								: browsePath === MACHINE_ROOT
									? `${t("addWorkspaceRoot")} · ${isZh ? "此电脑本身不是目录" : "This PC is not a directory"}`
									: cur === norm(currentCwd)
										? `${t("addWorkspaceRoot")} · ${isZh ? "已是当前项目目录" : "Already the current project"}`
										: `${t("addWorkspaceRoot")} · ${isZh ? "已在工作区根中" : "Already a workspace root"}`
						}
						aria-disabled={!canAddRoot}
						onClick={() => {
							if (!canAddRoot) return;
							appSend({ type: "set_workspace_roots", roots: [...workspaceRoots, browsePath] });
						}}
					>
						<FiBookmark />
					</TipButton>
					<TipButton
						className={`cwd-jump tool-new ${showNew ? "active" : ""}`}
						tip={
							browsePath === MACHINE_ROOT
								? `${t("cwdNewFolder")} · ${isZh ? "此电脑下不能新建" : "Cannot create here"}`
								: showNew
									? t("cwdCancel")
									: t("cwdNewFolder")
						}
						aria-disabled={browsePath === MACHINE_ROOT}
						onClick={() => {
							if (browsePath === MACHINE_ROOT) return;
							if (showNew) {
								setShowNew(false);
								setNewName("");
								setLocalError(null);
							} else {
								setNewName("");
								setLocalError(null);
								setShowNew(true);
							}
						}}
					>
						<FiFolderPlus />
					</TipButton>
					<span className="cwd-toolbar-spacer" />
					<TipButton
						className="cwd-jump primary tool-pick"
						tip={
							browsePath === MACHINE_ROOT
								? `${t("cwdPickCurrent")} · ${isZh ? "此电脑不能作为工作目录" : "This PC cannot be a workspace"}`
								: `${t("cwdPickCurrent")} · ${browsePath}`
						}
						aria-disabled={browsePath === MACHINE_ROOT}
						onClick={() => commitLocal(browsePath)}
					>
						<FiCheck />
					</TipButton>
				</div>
				<div className="cwd-picker-row">
					<input
						ref={inputRef}
						className="status-cwd-input cwd-picker-input"
						value={draft}
						placeholder={t("enterPath")}
						spellCheck={false}
						onChange={(e) => {
							setDraft(e.target.value);
							setCompIndex(-1);
						}}
						onKeyDown={onLocalKeyDown}
					/>
					{draft.trim() !== "" && draft !== browsePath && (
						<TipButton
							className="cwd-jump tool-enter"
							tip={`${t("cwdEnter")} · ${draft.trim()}`}
							onClick={() => {
								setBrowsePath(draft.trim());
								setCompIndex(-1);
							}}
						>
							<FiArrowRight />
						</TipButton>
					)}
				</div>
				<div className="cwd-list">
					{upPath && (
						<div key=".." className="cwd-item">
							<button
								type="button"
								className="cwd-enter"
								title={`${t("cwdGoUp")} · ${upPath}`}
								onClick={() => goQuickJump(upPath)}
							>
								<FiFolder />
								<span className="cwd-name">..</span>
							</button>
						</div>
					)}
					{dirs.length === 0 && !upPath && <div className="cwd-empty">{t("cwdEmpty")}</div>}
					{dirs.map((d) => (
						<div key={d.path} className="cwd-item">
							<button
								type="button"
								className="cwd-enter"
								title={`${t("cwdEnter")} ${d.path}`}
								onClick={() => {
									setBrowsePath(d.path);
									setDraft(d.path);
									setCompIndex(-1);
								}}
							>
								<FiFolder />
								<span className="cwd-name">{d.name}</span>
							</button>
							<TipButton
								className="cwd-jump tool-choose"
								tip={`${t("cwdChoose")} · ${d.path}`}
								onClick={() => commitLocal(d.path)}
							>
								<FiCheck />
							</TipButton>
						</div>
					))}
				</div>
				{showNew && (
					<div className="cwd-picker-foot">
						<div className="cwd-newrow">
							<input
								ref={newInputRef}
								value={newName}
								autoFocus
								spellCheck={false}
								placeholder={t("cwdNewName")}
								onChange={(e) => {
									setNewName(e.target.value);
									if (localError) setLocalError(null);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.nativeEvent.isComposing) {
										e.preventDefault();
										handleCreateLocal();
									} else if (e.key === "Escape") {
										e.stopPropagation();
										setShowNew(false);
										setNewName("");
										setLocalError(null);
									}
								}}
							/>
							<TipButton className="cwd-jump primary" tip={t("cwdCreate")} onClick={handleCreateLocal}>
								<FiCheck />
							</TipButton>
							<TipButton
								className="cwd-jump"
								tip={t("cwdCancel")}
								onClick={() => {
									setShowNew(false);
									setNewName("");
									setLocalError(null);
								}}
							>
								<FiX />
							</TipButton>
						</div>
						{localError && (
							<div className="project-picker-error" style={{ color: "var(--red)", fontSize: "11px", marginTop: "4px" }}>
								{localError}
							</div>
						)}
					</div>
				)}
			</div>
		</>,
		document.body,
	);
}
