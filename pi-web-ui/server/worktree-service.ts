/**
 * server/worktree-service.ts
 *
 * Git 工作树（Git Worktree）核心服务层。
 *
 * 功能：
 * 1. 结构化解析 `git worktree list --porcelain`，获取主工作树与所有子工作树（Linked Worktrees）；
 * 2. 检测各工作树状态（分支名、HEAD SHA、未提交文件数、是否为当前工作区、是否为主仓库）；
 * 3. 规范化创建（create）、清理（remove）、剪枝（prune）工作树；
 * 4. 组装 `WorktreeInfo` 上下文供 UI 横幅与 AI 工具消费。
 */

import { execFile } from "node:child_process";
import { resolve, normalize } from "node:path";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { pick, type ServerLang } from "./i18n.js";
import type { LinkedWorktreeEntry, WorktreeInfo } from "./protocol.js";

const exec = promisify(execFile);

const GIT_TIMEOUT_MS = 15_000;
const FAST_GIT_TIMEOUT_MS = 5_000;

/** 统一路径分隔符为 '/'，兼顾 Windows 盘符大小写归一化。 */
export function normalizeWirePath(p: string): string {
	const resolved = resolve(normalize(p)).replace(/\\/g, "/");
	if (process.platform === "win32" && /^[a-zA-Z]:/.test(resolved)) {
		return resolved[0].toUpperCase() + resolved.slice(1);
	}
	return resolved;
}

/** 运行单条 git 命令，失败时抛出友好错误。 */
async function runGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
	try {
		const { stdout } = await exec("git", ["-c", "core.quotepath=false", ...args], {
			cwd,
			timeout: timeoutMs,
			maxBuffer: 8 * 1024 * 1024,
			windowsHide: true,
		});
		return stdout;
	} catch (err) {
		const e = err as { message?: string; stderr?: string };
		const detail = (e.stderr ?? e.message ?? "").trim().split("\n")[0];
		throw new Error(detail || "Git command failed");
	}
}

/** 检查指定目录是否位于 Git 仓库中。 */
export async function isInsideGitRepo(cwd: string): Promise<boolean> {
	try {
		const out = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], FAST_GIT_TIMEOUT_MS);
		return out.trim() === "true";
	} catch {
		return false;
	}
}

/** 单个工作树的内部解析条目。 */
export interface RawWorktreeItem {
	path: string;
	head: string;
	branch?: string;
	detached: boolean;
	bare: boolean;
	locked?: boolean | string;
	prunable?: boolean | string;
}

/** 解析 `git worktree list --porcelain` 文本输出。 */
export function parseWorktreePorcelain(text: string): RawWorktreeItem[] {
	const items: RawWorktreeItem[] = [];
	const blocks = text.trim().split(/\n\s*\n/);

	for (const block of blocks) {
		const lines = block
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
		if (lines.length === 0) continue;

		let path = "";
		let head = "";
		let branch: string | undefined;
		let detached = false;
		let bare = false;
		let locked: boolean | string | undefined;
		let prunable: boolean | string | undefined;

		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				path = normalizeWirePath(line.slice("worktree ".length).trim());
			} else if (line.startsWith("HEAD ")) {
				head = line.slice("HEAD ".length).trim();
			} else if (line.startsWith("branch ")) {
				const ref = line.slice("branch ".length).trim();
				branch = ref.replace(/^refs\/heads\//, "");
			} else if (line === "detached") {
				detached = true;
			} else if (line === "bare") {
				bare = true;
			} else if (line.startsWith("locked")) {
				const reason = line.slice("locked".length).trim();
				locked = reason || true;
			} else if (line.startsWith("prunable")) {
				const reason = line.slice("prunable".length).trim();
				prunable = reason || true;
			}
		}

		if (path) {
			items.push({
				path,
				head,
				branch,
				detached,
				bare,
				locked,
				prunable,
			});
		}
	}

	return items;
}

/** 快速检测指定工作树目录中的未提交更改数（status --porcelain）。 */
async function getUncommittedCount(worktreePath: string): Promise<{ isDirty: boolean; count: number }> {
	if (!existsSync(worktreePath)) {
		return { isDirty: false, count: 0 };
	}
	try {
		const out = await runGit(worktreePath, ["status", "--porcelain"], FAST_GIT_TIMEOUT_MS);
		const lines = out
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
		return {
			isDirty: lines.length > 0,
			count: lines.length,
		};
	} catch {
		return { isDirty: false, count: 0 };
	}
}

/** 计算当前工作树相对于主分支领先的 commit 数。 */
async function getAheadCount(worktreePath: string, mainBranch = "main"): Promise<number> {
	if (!existsSync(worktreePath)) return 0;
	try {
		const out = await runGit(worktreePath, ["rev-list", "--count", `HEAD`, `^${mainBranch}`], FAST_GIT_TIMEOUT_MS);
		const num = Number(out.trim());
		return Number.isNaN(num) ? 0 : num;
	} catch {
		// 主分支名可能是 master
		if (mainBranch === "main") {
			try {
				const out = await runGit(worktreePath, ["rev-list", "--count", `HEAD`, `^master`], FAST_GIT_TIMEOUT_MS);
				const num = Number(out.trim());
				return Number.isNaN(num) ? 0 : num;
			} catch {
				return 0;
			}
		}
		return 0;
	}
}

/** 列出当前 Git 仓库的所有工作树，包含主工作树与关联子工作树。 */
export async function listWorktrees(cwd: string): Promise<LinkedWorktreeEntry[]> {
	const inside = await isInsideGitRepo(cwd);
	if (!inside) return [];

	const rawText = await runGit(cwd, ["worktree", "list", "--porcelain"]);
	const rawItems = parseWorktreePorcelain(rawText);
	if (rawItems.length === 0) return [];

	const normCurrent = normalizeWirePath(cwd);
	const mainItem = rawItems[0];
	const mainBranch = mainItem.branch || "main";

	const results: LinkedWorktreeEntry[] = [];

	for (let i = 0; i < rawItems.length; i++) {
		const item = rawItems[i];
		const isMain = i === 0;
		const isCurrent =
			normCurrent === item.path ||
			normCurrent.startsWith(item.path + "/") ||
			(process.platform === "win32" && normCurrent.toLowerCase() === item.path.toLowerCase());

		const { isDirty, count } = await getUncommittedCount(item.path);
		const ahead = isMain ? 0 : await getAheadCount(item.path, mainBranch);

		results.push({
			path: item.path,
			branch: item.branch || (item.detached ? "(detached)" : undefined),
			isCurrent,
			isMain,
			isDirty,
			uncommittedCount: count,
			aheadCount: ahead,
		});
	}

	return results;
}

export interface CreateWorktreeOptions {
	path: string;
	branch?: string;
	newBranch?: boolean | string;
	commit?: string;
}

/** 创建新的 Git 工作树。 */
export async function createWorktree(
	cwd: string,
	opts: CreateWorktreeOptions,
	lang?: () => ServerLang,
): Promise<{ path: string; branch?: string }> {
	const l = lang?.() ?? "en";
	const inside = await isInsideGitRepo(cwd);
	if (!inside) {
		throw new Error(pick(l, "当前目录不是 Git 仓库", "Current directory is not a Git repository", "worktree.not.git"));
	}

	const targetPath = normalizeWirePath(resolve(cwd, opts.path));
	const args: string[] = ["worktree", "add"];

	let branchName = opts.branch;
	if (typeof opts.newBranch === "string" && opts.newBranch.trim()) {
		args.push("-b", opts.newBranch.trim());
		branchName = opts.newBranch.trim();
	} else if (opts.newBranch === true && opts.branch) {
		args.push("-b", opts.branch.trim());
	}

	args.push(targetPath);

	if (opts.commit) {
		args.push(opts.commit.trim());
	} else if (!opts.newBranch && opts.branch) {
		args.push(opts.branch.trim());
	}

	await runGit(cwd, args);
	return { path: targetPath, branch: branchName };
}

/** 移除指定 Git 工作树。 */
export async function removeWorktree(
	cwd: string,
	targetPathInput: string,
	force = false,
	lang?: () => ServerLang,
): Promise<void> {
	const l = lang?.() ?? "en";
	const inside = await isInsideGitRepo(cwd);
	if (!inside) {
		throw new Error(pick(l, "当前目录不是 Git 仓库", "Current directory is not a Git repository", "worktree.not.git"));
	}

	const targetPath = normalizeWirePath(resolve(cwd, targetPathInput));

	if (!force) {
		const { isDirty, count } = await getUncommittedCount(targetPath);
		if (isDirty) {
			throw new Error(
				pick(
					l,
					`工作树「${targetPath}」包含 ${count} 个未提交的文件修改；请先提交或传入 force=true 强制删除`,
					`Worktree "${targetPath}" has ${count} uncommitted changes; commit them or pass force=true to remove`,
					"worktree.remove.dirty",
					{ targetPath, count },
				),
			);
		}
	}

	const args = ["worktree", "remove"];
	if (force) args.push("--force");
	args.push(targetPath);

	await runGit(cwd, args);
}

/** 获取当前目录的完整工作树上下文元数据（用于 UI 横幅与快照）。 */
export async function getWorktreeContext(cwd: string): Promise<WorktreeInfo | null> {
	try {
		const inside = await isInsideGitRepo(cwd);
		if (!inside) return null;

		const list = await listWorktrees(cwd);
		if (list.length === 0) return null;

		const mainEntry = list.find((e) => e.isMain) || list[0];
		const currentEntry = list.find((e) => e.isCurrent);

		const isLinkedWorktree = Boolean(currentEntry && !currentEntry.isMain);
		const linkedWorktrees = list.filter((e) => !e.isMain);

		return {
			isLinkedWorktree,
			currentPath: currentEntry ? currentEntry.path : normalizeWirePath(cwd),
			branch: currentEntry?.branch,
			mainPath: mainEntry.path,
			mainBranch: mainEntry.branch,
			linkedWorktrees,
		};
	} catch {
		return null;
	}
}
