/**
 * server/workspace-snapshot.ts
 *
 * 工作区版本影子快照机制（Workspace Snapshot / Dual-State Rollback）。
 *
 * 每次用户发起新任务或运行关键操作前，为当前工作区记录轻量快照引用（Git commit SHA）。
 * 机制：
 * - 利用独立的临时 GIT_INDEX_FILE，通过 `git add -A -- .` + `git write-tree` + `git commit-tree` 生成独立 commit；
 * - 快照只覆盖对话 cwd 的**子树**（而非整个工作区），commit-tree 的顶层因此只有该子目录一个条目；
 * - 绝不改变用户现有的 HEAD、branch 指针、工作区文件或 .git/index；
 * - 回滚时若启用 restoreWorkspace，通过 `git checkout <snapshotRef> -- <prefix>` 与 `git clean -fd -- <prefix>`
 *   只还原/清理 cwd 子树，绝不触碰同仓库的兄弟目录。
 */

import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gitDirOf } from "./scm.js";

const exec = promisify(execFile);

/** 单次 git 快照/还原命令超时时间（毫秒）。 */
const GIT_SNAPSHOT_TIMEOUT_MS = 15_000;

/** 物理还原互斥链（#697）：同一 cwd 的 git read-tree/clean 序列串行执行，
 *  杜绝并发回滚交错破坏 index/工作区；key 为 resolve 后的 cwd。 */
const pendingRestores = new Map<string, Promise<void>>();

/** 执行单条 git 命令，返回 stdout。 */
async function runGit(cwd: string, args: string[], envExtra?: NodeJS.ProcessEnv): Promise<string> {
	const { stdout } = await exec("git", ["-c", "core.quotepath=false", ...args], {
		cwd,
		env: envExtra ? { ...process.env, ...envExtra } : process.env,
		timeout: GIT_SNAPSHOT_TIMEOUT_MS,
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
	});
	return stdout.trim();
}

/** 向 git 标准输入写一段内容。用于 `update-index --index-info` 这类不能把数万路径塞进 argv 的命令。 */
function runGitInput(cwd: string, args: string[], input: string, envExtra?: NodeJS.ProcessEnv): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("git", ["-c", "core.quotepath=false", ...args], {
			cwd,
			env: envExtra ? { ...process.env, ...envExtra } : process.env,
			windowsHide: true,
			// stdout 不读会把管道缓冲写满，git 可能一直不退出；也不要让它漏进测试进程的 console。
			stdio: ["pipe", "ignore", "pipe"],
		});
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(new Error(`git ${args[0] ?? ""} timed out`));
		}, GIT_SNAPSHOT_TIMEOUT_MS);
		// 防御 EPIPE：当子进程异常提早退出时，写管道不会引发未捕获异常崩溃 Node 进程
		child.stdin?.on("error", () => {});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0) resolvePromise();
			else reject(new Error(stderr.trim() || `git exited ${code}`));
		});
		try {
			child.stdin.end(input);
		} catch {
			// ignore synchronous pipe write error
		}
	});
}

/** 仓库元数据探测信息。 */
export interface GitRepoInfo {
	gitDir: string;
	indexFile: string;
	prefix: string;
}

/**
 * 一次性获取仓库核心元数据：gitDir、indexFile 与 prefix。
 * 合并多次独立的 `rev-parse` 调用，减少 Windows 下子进程启动开销。
 */
export async function probeGitRepo(cwd: string): Promise<GitRepoInfo | null> {
	try {
		const out = await runGit(cwd, ["rev-parse", "--git-dir", "--git-path", "index", "--show-prefix"]);
		const lines = out.split("\n").map((l) => l.trim());
		if (lines.length < 2) return null;
		const rawGitDir = lines[0];
		const rawIndex = lines[1];
		const rawPrefix = lines[2] ?? "";
		if (!rawGitDir || !rawIndex) return null;
		return {
			gitDir: resolve(cwd, rawGitDir),
			indexFile: resolve(cwd, rawIndex),
			prefix: rawPrefix.replace(/\\/g, "/").replace(/\/+$/, ""),
		};
	} catch {
		return null;
	}
}

/** 影子 index 缓存文件路径（按 gitDir 与规范化 cwd 的哈希隔离）。 */
export function snapshotCachePath(gitDir: string, cwd: string): string {
	const hash = createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 16);
	return join(gitDir, `pi-snapshot-cache-${hash}`);
}

/**
 * 把持久化的影子 index 缓存或用户真实 index 拷贝为快照用的临时 index。
 *
 * 优化：若之前已有该 cwd 的影子 index 缓存且有效，直接复用拷贝它（无需重复扫描兄弟目录且保留上一轮已跟踪/未跟踪文件的 stat 缓存）；
 * 若无缓存，拷贝用户真实 index 并剔除子树外条目；若出错则回退。
 */
async function seedSnapshotIndex(
	cwd: string,
	tempIndex: string,
	repo: GitRepoInfo,
	env: NodeJS.ProcessEnv,
): Promise<{ fromCache: boolean }> {
	const cachePath = snapshotCachePath(repo.gitDir, cwd);
	if (existsSync(cachePath)) {
		try {
			await copyFile(cachePath, tempIndex);
			return { fromCache: true };
		} catch {
			// 缓存损坏或不可读，清理并回落到真实 index
			await rm(cachePath, { force: true }).catch(() => {});
		}
	}

	try {
		await copyFile(repo.indexFile, tempIndex);
	} catch {
		return { fromCache: false };
	}

	const prefix = repo.prefix;
	if (!prefix) return { fromCache: false };
	const prefixSlash = `${prefix}/`;
	let listed = "";
	try {
		listed = await runGit(cwd, ["ls-files", "-z", "--full-name", "--", ":(top)"], env);
	} catch {
		await rm(tempIndex, { force: true }).catch(() => {});
		return { fromCache: false };
	}
	const outside = listed.split("\0").filter((path) => {
		if (!path || path.includes("\n")) return false;
		const norm = path.replace(/\\/g, "/");
		return norm !== prefix && !norm.startsWith(prefixSlash);
	});
	if (listed.includes("\n") && listed.split("\0").some((path) => path.includes("\n"))) {
		await rm(tempIndex, { force: true }).catch(() => {});
		return { fromCache: false };
	}
	if (outside.length > 0) {
		const info = outside.map((path) => `0 0000000000000000000000000000000000000000\t${path}\n`).join("");
		try {
			await runGitInput(cwd, ["update-index", "--index-info"], info, env);
		} catch {
			await rm(tempIndex, { force: true }).catch(() => {});
		}
	}
	return { fromCache: false };
}

/** 内存缓存：记录每个 cwd 上一次成功快照的 treeSha 与 commitHash，支持无变动轮次直接复用。 */
interface LastSnapshotCache {
	treeSha: string;
	snapshotRef: string;
	timestamp: number;
}
const lastSnapshotByCwd = new Map<string, LastSnapshotCache>();

/** 清理特定 cwd（或全部）的上次快照内存缓存（单测或工作区还原时调用）。 */
export function clearWorkspaceSnapshotCaches(cwd?: string): void {
	if (cwd) {
		lastSnapshotByCwd.delete(resolve(cwd));
	} else {
		lastSnapshotByCwd.clear();
	}
}

/** 检查工作区是否由 Git 管理。 */
export async function isGitWorkspace(cwd: string): Promise<boolean> {
	const info = await probeGitRepo(cwd);
	if (info) return true;
	return (await gitDirOf(cwd)) !== null;
}

/**
 * 为当前工作区创建轻量版本快照。
 * 若当前目录不在 Git 仓库内，返回 null。
 *
 * 该操作纯粹在临时 index 文件中完成，绝不影响用户的实际 index 或 HEAD。
 */
export async function createWorkspaceSnapshot(cwd: string): Promise<string | null> {
	const repo = await probeGitRepo(cwd);
	if (!repo) return null;

	const tempIndex = join(repo.gitDir, `temp-index-snapshot-${randomUUID()}`);
	const env = { GIT_INDEX_FILE: tempIndex };
	const cachePath = snapshotCachePath(repo.gitDir, cwd);

	try {
		// 1. 先种入 index（优先从持久化影子缓存拷贝，次选从真实 index 拷贝并剔除子树外条目）
		await seedSnapshotIndex(cwd, tempIndex, repo, env);

		// 2 & 3. 将 cwd 子树当前改动暂存到临时 index 并生成 tree 对象（若因 cache 损坏或脏索引失败，回退空 index 重试）
		let tree: string | null = null;
		try {
			await runGit(cwd, ["add", "-A", "--", "."], env);
			tree = await runGit(cwd, ["write-tree"], env);
		} catch (stageErr) {
			// 回退兜底：清理损坏的临时 index 和缓存 index，从纯空 index 重试一次
			await rm(tempIndex, { force: true }).catch(() => {});
			await rm(cachePath, { force: true }).catch(() => {});
			try {
				await runGit(cwd, ["add", "-A", "--", "."], env);
				tree = await runGit(cwd, ["write-tree"], env);
			} catch {
				throw stageErr;
			}
		}
		if (!tree) return null;

		// 异步更新持久化影子 index 缓存供下轮秒级复用。必须 await 后再进 finally：
		// 否则 finally 里 rm(tempIndex) 会在拷贝中途删掉源文件，Windows 上拷贝要么
		// EBUSY 失败、要么把半截内容写进 cachePath（下轮读坏缓存再回落，缓存失效）。
		await copyFile(tempIndex, cachePath).catch(() => {});

		// 优化 3：检查 tree 是否与该 cwd 上次快照完全一致
		const normCwd = resolve(cwd);
		const last = lastSnapshotByCwd.get(normCwd);
		if (last && last.treeSha === tree) {
			// 工作区内容完全无变动：直接复用已有快照 SHA，省去 rev-parse HEAD + commit-tree
			return last.snapshotRef;
		}

		// 4. 检查是否有 HEAD commit 作为 parent
		let hasHead = false;
		try {
			await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
			hasHead = true;
		} catch {
			hasHead = false;
		}

		// 5. 创建轻量 commit 对象，不关联任何分支引用
		const commitArgs = ["commit-tree", tree];
		if (hasHead) {
			commitArgs.push("-p", "HEAD");
		}
		commitArgs.push("-m", `pi-web-ui: workspace shadow snapshot ${new Date().toISOString()}`);

		const commitHash = await runGit(cwd, commitArgs, env);
		if (commitHash) {
			lastSnapshotByCwd.set(normCwd, {
				treeSha: tree,
				snapshotRef: commitHash,
				timestamp: Date.now(),
			});
			return commitHash;
		}
		return null;
	} catch (err) {
		console.warn(`[workspace-snapshot] 创建快照失败 (${cwd}):`, (err as Error).message);
		return null;
	} finally {
		// 务必清理临时 index 文件
		try {
			await rm(tempIndex, { force: true });
		} catch {
			// ignore cleanup error
		}
	}
}

/**
 * 将工作区物理文件还原到指定的快照状态，作用范围严格限定在 cwd 子树内。
 *
 * 执行步骤：
 * - 仓库根 cwd：使用原子 `git read-tree -u --reset` + `git clean -fd` 整仓还原（天然支持空仓库快照）；
 * - 子目录 cwd（pathspec 以 `:(top)` 锚定到仓库根的 cwd 前缀）：
 *   1. `git rm -r --cached -- <pathspec>` 把 cwd 子树移出 index（工作区文件不动），使快照中
 *      不存在的文件退回未跟踪状态——这一步让 checkout 之外的「快照后新增且已 add」的文件也能被回滚；
 *   2. `git checkout <snapshotRef> -- <pathspec>` 把快照内容写回 index 与工作区（恢复被修改/删除的跟踪文件，快照无该子树文件时容错跳过）；
 *   3. `git clean -fd -- <pathspec>` 清理快照之后新增的未跟踪文件与空目录。
 * 同仓库的兄弟目录在以上任何一步都不受影响。
 */
export async function restoreWorkspaceSnapshot(
	cwd: string,
	snapshotRef: string,
): Promise<{ success: boolean; error?: string }> {
	const key = resolve(cwd);
	const prev = pendingRestores.get(key);
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const mine = (prev ?? Promise.resolve()).then(() => gate);
	pendingRestores.set(key, mine);
	if (prev) {
		try {
			await prev;
		} catch {
			// 前一还原失败不阻塞后继
		}
	}
	try {
		return await restoreWorkspaceSnapshotInner(cwd, snapshotRef);
	} finally {
		if (pendingRestores.get(key) === mine) pendingRestores.delete(key);
		release();
	}
}

async function restoreWorkspaceSnapshotInner(
	cwd: string,
	snapshotRef: string,
): Promise<{ success: boolean; error?: string }> {
	const gitDir = await gitDirOf(cwd);
	if (!gitDir) {
		return { success: false, error: "Workspace is not a Git repository" };
	}

	// index 备份：子目录回滚的第 1 步 rm --cached 直接改真实 index，后续 checkout/clean
	// 中途失败时原子还原，暂存区不再留在损坏状态（见 catch 中的还原注释）
	let indexRealPath = "";
	let indexBackup = "";
	let indexBackedUp = false;

	try {
		// 验证 snapshotRef 合法性
		await runGit(cwd, ["rev-parse", "--verify", snapshotRef]);

		// cwd 相对仓库根的前缀（子目录形如 `proj/`，仓库根为空串）。
		const prefix = await runGit(cwd, ["rev-parse", "--show-prefix"]);

		if (!prefix) {
			// 仓库根 cwd：整仓还原，使用原子 read-tree --reset，旧实现经过长期验证且天然支持空仓库快照
			await runGit(cwd, ["read-tree", "-u", "--reset", snapshotRef]);
			await runGit(cwd, ["clean", "-fd"]);

			// 还原成功后，清除该 cwd 的上次快照缓存与影子 index
			lastSnapshotByCwd.delete(resolve(cwd));
			const cachePath = snapshotCachePath(gitDir, cwd);
			void rm(cachePath, { force: true }).catch(() => {});

			return { success: true };
		}

		// 子目录 cwd：作用域收敛到该子树，不误伤同仓兄弟目录与仓库根
		const pathspec = `:(top)${prefix}`;

		indexRealPath = resolve(cwd, (await runGit(cwd, ["rev-parse", "--git-path", "index"])).trim());
		indexBackup = join(gitDir, `temp-index-backup-${randomUUID()}`);
		try {
			await copyFile(indexRealPath, indexBackup);
			indexBackedUp = true;
		} catch {
			// 空仓库可能还没有 index 文件：rm --cached 无从破坏，无需备份
		}

		// 1. 把 cwd 子树移出 index（不删除工作区文件），快照里不存在的文件由此退回未跟踪状态
		await runGit(cwd, ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", pathspec]);

		// 2. 快照树内确有该子树文件时才 checkout（恢复被修改与被删除的跟踪文件）。
		//    先 ls-tree 判存在，替代老实现「捕获 checkout 的英文报错文案」的判空——
		//    本地化 git（zh_CN 等）下文案不匹配会把「快照为空」误当真失败抛出。
		//    ls-tree 的 path 按 git 进程 cwd（= 本子目录）相对解析：用 :(top) 锚定
		//    到仓库根的子树前缀，与第 1/3 步的 pathspec 同口径。
		const listed = await runGit(cwd, [
			"ls-tree",
			"-r",
			"--name-only",
			snapshotRef,
			"--",
			`:(top)${prefix.replace(/\/+$/, "")}`,
		]);
		if (listed.trim()) {
			await runGit(cwd, ["checkout", snapshotRef, "--", pathspec]);
		}

		// 3. 清理快照之后新增的未跟踪文件与空目录（含第 1 步退回未跟踪的那些）
		await runGit(cwd, ["clean", "-fd", "--", pathspec]);

		// 还原成功后，清除该 cwd 的上次快照缓存与影子 index，确保后续快照重新根据物理工作区生成
		lastSnapshotByCwd.delete(resolve(cwd));
		const cachePath = snapshotCachePath(gitDir, cwd);
		void rm(cachePath, { force: true }).catch(() => {});

		return { success: true };
	} catch (err) {
		if (indexBackedUp) {
			// 原子还原 index：第 1 步 rm --cached 已改真实 index，checkout 中途失败
			//（文件被占用 EBUSY、磁盘满…）不能把暂存区留在「整棵子树 staged-deleted」
			// 的损坏状态——回滚本身不能再制造新破坏。
			//（还原窗口内的并发 git 写操作会被覆盖：窗口毫秒级，且损坏的暂存区
			// 比丢一瞬间的暂存操作严重得多。）
			try {
				await copyFile(indexBackup, indexRealPath);
			} catch {
				// 还原失败：错误照常上报
			}
		}
		const msg = (err as Error).message;
		console.error(`[workspace-snapshot] 还原快照失败 (${cwd}, ${snapshotRef}):`, msg);
		return { success: false, error: msg };
	} finally {
		try {
			await rm(indexBackup, { force: true });
		} catch {
			// ignore cleanup error
		}
	}
}

/** 工作区影子快照记录项（与会话转录消息检查点联动）。 */
export interface WorkspaceSnapshotRecord {
	entryId?: string;
	timestamp: number;
	snapshotRef: string;
}

/**
 * 查找与指定消息 entryId/时间戳最匹配的工作区物理快照：
 * 优先匹配 exact entryId，其次查找该 entry 时间戳之前（或 +2000ms 内）的最近一份快照。
 */
export function findMatchingWorkspaceSnapshot(
	snapshots: WorkspaceSnapshotRecord[],
	entryId?: string,
	entryTs: number = 0,
): WorkspaceSnapshotRecord | undefined {
	if (!snapshots || snapshots.length === 0) return undefined;
	if (entryId) {
		const exact = snapshots.find((s) => s.entryId === entryId);
		if (exact) return exact;
	}
	const eligible = snapshots.filter((s) => entryTs === 0 || s.timestamp <= entryTs + 2000);
	if (eligible.length > 0) {
		return eligible[eligible.length - 1];
	}
	return snapshots[0];
}

/** 从会话 sessionManager entries 回放恢复之前持久化的快照映射记录。 */
export function readWorkspaceSnapshotsFromSession(sm: unknown): WorkspaceSnapshotRecord[] {
	try {
		const mgr = sm as { getEntries?: () => unknown[] };
		if (typeof mgr?.getEntries !== "function") return [];
		const entries = mgr.getEntries();
		const records: WorkspaceSnapshotRecord[] = [];
		for (const e of entries) {
			const entry = e as
				| {
						type?: string;
						customType?: string;
						data?: WorkspaceSnapshotRecord;
				  }
				| undefined;
			if (entry?.type === "custom" && entry.customType === "pi-web-ui/workspace-snapshot" && entry.data?.snapshotRef) {
				records.push({
					entryId: entry.data.entryId,
					timestamp: Number(entry.data.timestamp) || 0,
					snapshotRef: String(entry.data.snapshotRef),
				});
			}
		}
		return records.slice(-50);
	} catch {
		return [];
	}
}

/** 将快照映射记录持久化到会话转录中（以便会话重载或服务重启后支持双向回滚）。 */
export function appendWorkspaceSnapshotToSession(sm: unknown, record: WorkspaceSnapshotRecord): void {
	try {
		const mgr = sm as { appendCustomEntry?: (customType: string, data: unknown) => void };
		mgr?.appendCustomEntry?.("pi-web-ui/workspace-snapshot", record);
	} catch {
		// ignore
	}
}

/**
 * 为工具定义叠加影子快照门禁：在工具执行物理写操作之前，确保正在并发生成的快照已经完成。
 */
export function withWorkspaceSnapshotGate<T extends { execute: (...args: any[]) => any }>(
	def: T,
	awaitPendingSnapshot: () => Promise<void>,
): T {
	const originalExecute = def.execute;
	return {
		...def,
		execute: async (...args: any[]) => {
			await awaitPendingSnapshot();
			return originalExecute.apply(def, args);
		},
	};
}
