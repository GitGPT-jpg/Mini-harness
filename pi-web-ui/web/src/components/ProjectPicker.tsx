import { useT } from "../i18n";
import {
	DirectoryBrowser,
	MACHINE_ROOT,
	browseQuery,
	joinProjectPath,
	isValidProjectName,
	parentOf,
} from "./DirectoryBrowser.js";

export { MACHINE_ROOT, browseQuery, joinProjectPath, isValidProjectName, parentOf };

interface ProjectPickerProps {
	open: boolean;
	currentCwd: string;
	pathCompletions: { name: string; path: string; type: "dir" | "file" }[];
	workspaceRoots: string[];
	onClose: () => void;
	onSelectDirectory: (path: string) => void;
	/** 缺省走 DirectoryBrowser 内置回退：project=建完即选，folder=建完刷新停留 */
	onCreateProject?: (path: string) => void;
	/** folder=选目录（建完停留刷新）/project=选项目（建完即打开），默认 project */
	mode?: "folder" | "project";
}

export function ProjectPicker({
	open,
	currentCwd,
	pathCompletions,
	workspaceRoots,
	onClose,
	onSelectDirectory,
	onCreateProject,
	mode = "project",
}: ProjectPickerProps) {
	const t = useT();
	if (!open) return null;

	return (
		<DirectoryBrowser
			currentCwd={currentCwd}
			pathCompletions={pathCompletions}
			workspaceRoots={workspaceRoots}
			onClose={onClose}
			onSelectDirectory={(p) => {
				onSelectDirectory(p);
				onClose();
			}}
			onCreateProject={onCreateProject}
			mode={mode}
			className="project-picker"
			backdropClassName="project-picker-backdrop"
			role="dialog"
			ariaLabel={t("projectPickerTitle")}
		/>
	);
}
