/**
 * 沙盒项目服务（Sandbox Project Service）：
 *
 * 1. 隔离副本工作区管理（`<dataDir>/sandboxes/registry.json` + `<dataDir>/sandboxes/<id>/`）：
 *    - 支持「空白沙盒」与「导入现有项目」（自动跳过 node_modules/.venv/target 等重型缓存目录与越界软链）；
 *    - 支持「临时沙盒（用完即删）」与「永久沙盒（持久化保留，随时一键转正）」；
 *    - 支持一键重置（还原到初始空白或重新从源项目同步）、另存为正式项目（promote）、将修改写回源项目（applyToSource）、彻底销毁（destroy）。
 *
 * 2. 沙盒安全围栏（Sandbox Jail Gate）：
 *    - 当会话处于受管沙盒目录内时，所有文件写入/编辑/补丁（write/edit/edit_soft/patch）必须严格落在
 *      `sandbox.path` 内部（含祖先目录 realpath 校验，防软链逃逸），越界直接硬拒绝（不走审批放行）；
 *    - 终端命令（bash）采用启发式拦截（禁止直接引用源项目路径 `sourcePath`、拦截越界 cd、输出重定向、越界写删命令与系统特权命令等）；
 *      请注意：沙盒基于工作区副本与工具调用层校验，未采用内核命名空间/容器级物理隔离，bash 终端拦截为尽力而为的启发式防护，非绝对安全边界；
 *    - 外部副作用工具（sftp 远端写/删/执行、mail 发信/删信）在沙盒内默认拦截。
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { normalizePathKey } from "./client-state.js";
import { pick, type ServerLang } from "./i18n.js";
import type { SandboxInfo } from "./protocol.js";

/** 导入项目进沙盒时默认跳过的重型依赖/构建缓存目录名。 */
export const SANDBOX_IGNORED_DIRS = new Set([
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".next",
	".nuxt",
	".svelte-kit",
	".turbo",
	".parcel-cache",
	"target",
	".gradle",
	".cache",
	"coverage",
	".nyc_output",
]);

/** 导入项目进沙盒时跳过的系统垃圾文件。 */
const SANDBOX_IGNORED_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** 单次导入沙盒的最大文件数上限（防止意外导入超大目录卡死 I/O）。 */
const MAX_IMPORT_FILES = 15_000;
/** 单次导入沙盒的单文件大小上限（64 MB，超大二进制构建产物不拷入沙盒）。 */
const MAX_SINGLE_FILE_BYTES = 64 * 1024 * 1024;

function toWirePath(p: string): string {
	return resolve(p).replace(/\\/g, "/");
}

function toComparablePath(p: string): string {
	return normalizePathKey(p).replace(/\\/g, "/").replace(/\/+$/, "");
}

export function isSameOrSubpath(childAbs: string, parentAbs: string): boolean {
	const c = toComparablePath(childAbs);
	const p = toComparablePath(parentAbs);
	return c === p || c.startsWith(p + "/");
}

function isProtectedSystemOrHomeRoot(absPath: string): boolean {
	const resolved = resolve(absPath);
	// 文件系统根（如 "/" 或 "C:\"）
	if (parseRootOnly(resolved)) return true;
	const home = resolve(homedir());
	if (normalizePathKey(resolved) === normalizePathKey(home)) return true;
	return false;
}

function parseRootOnly(resolved: string): boolean {
	const trimmed = resolved.replace(/[\\/]+$/, "");
	if (!trimmed) return true;
	if (/^[a-zA-Z]:$/.test(trimmed)) return true;
	return dirname(resolved) === resolved;
}

/**
 * 解析目标路径并校验是否严格位于 `sandboxRoot` 内部（含祖先目录 realpath 校验，防软链逃逸）。
 */
export function isStrictlyInsideSandbox(targetPath: string, cwd: string, sandboxRoot: string): boolean {
	if (!targetPath || typeof targetPath !== "string") return false;
	const trimmed = targetPath.trim();
	if (!trimmed) return false;
	const expanded =
		trimmed === "~"
			? homedir()
			: trimmed.startsWith("~/") || trimmed.startsWith("~\\")
				? join(homedir(), trimmed.slice(2))
				: trimmed;
	const resolvedTarget = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
	const resolvedSandbox = resolve(sandboxRoot);

	// 1. 词法路径必须在 sandboxRoot 之内
	if (!isSameOrSubpath(resolvedTarget, resolvedSandbox)) {
		return false;
	}

	// 2. 真实路径（realpath）校验：沿目标路径向上找到第一个已存在的祖先目录，防止通过沙盒内软链写到外部
	let realSandbox = resolvedSandbox;
	try {
		realSandbox = realpathSync(resolvedSandbox);
	} catch {
		// 沙盒根自身若暂不可解则用词法路径
	}

	let cur = resolvedTarget;
	while (true) {
		if (existsSync(cur)) {
			try {
				const realCur = realpathSync(cur);
				if (!isSameOrSubpath(realCur, realSandbox)) {
					return false;
				}
			} catch {
				return false;
			}
			break;
		}
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}

	return true;
}

/** 从 patch 工具的补丁文本中提取所有涉及的文件路径。 */
export function extractPatchTargetPaths(patchText: string): string[] {
	if (!patchText || typeof patchText !== "string") return [];
	const paths: string[] = [];
	for (const rawLine of patchText.split(/\r?\n/)) {
		const line = rawLine.trim();
		const mHeader = line.match(/^\*\*\*\s+(?:Add File|Update File|Delete File|Move to):\s+(.+)$/);
		if (mHeader?.[1]) {
			paths.push(mHeader[1].trim());
			continue;
		}
		const mUnified = line.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?([^\t\r\n]+)$/);
		if (mUnified?.[1] && mUnified[1] !== "/dev/null") {
			paths.push(mUnified[1].trim());
			continue;
		}
		// hashline 格式段头（本仓 patch 工具实际消费的唯一格式）：[path#TAG] / [path]。
		// 不识别的话 hashline 补丁提取出 0 个目标 → 围栏检查整体空转，patch 路径
		// 只剩 hashline-engine 的词法 cwd 限制（无 realpath，沙盒内软链可逃逸）
		const mHashline = rawLine.match(/^\s*\[([^#\]]+)(?:#[0-9a-fA-F]{4})?\]\s*$/);
		if (mHashline?.[1]?.trim()) {
			paths.push(mHashline[1].trim());
		}
	}
	return paths;
}

export interface SandboxDenial {
	reason: string;
	reasonEn: string;
}

/**
 * 评估一次工具调用是否违反沙盒硬围栏。
 * 返回 null = 放行；返回 SandboxDenial = 硬拒绝（不弹审批框、不受“全部允许”影响）。
 */
export function evaluateSandboxJail(
	sandbox: SandboxInfo,
	toolName: string,
	params: Record<string, unknown> | undefined,
	cwd: string,
): SandboxDenial | null {
	const p = params ?? {};
	const sbxPath = sandbox.path;

	// 1. 直接写文件类工具：write / edit / edit_soft
	if (toolName === "write" || toolName === "edit" || toolName === "edit_soft") {
		const rawPath =
			typeof p.path === "string" && p.path.trim()
				? p.path.trim()
				: typeof p.file_path === "string" && p.file_path.trim()
					? p.file_path.trim()
					: "";
		if (!rawPath || !isStrictlyInsideSandbox(rawPath, cwd, sbxPath)) {
			return {
				reason:
					`【沙盒安全隔离拦截】当前项目处于隔离沙盒（${sandbox.name}）中，严禁修改沙盒目录（${sbxPath}）以外的文件："${rawPath || "(空)"}"。` +
					(sandbox.sourcePath ? ` 原项目（${sandbox.sourcePath}）受只读保护，请仅在当前沙盒工作区内修改。` : ""),
				reasonEn:
					`[Sandbox Isolation Blocked] Current project is in an isolated sandbox (${sandbox.name}); modifying files outside the sandbox directory (${sbxPath}) is strictly forbidden: "${rawPath || "(empty)"}".` +
					(sandbox.sourcePath
						? ` The source project (${sandbox.sourcePath}) is protected; only modify files inside the current sandbox workspace.`
						: ""),
			};
		}
		return null;
	}

	// 2. 补丁工具：patch
	if (toolName === "patch") {
		const patchText = typeof p.patch === "string" ? p.patch : "";
		const targets = extractPatchTargetPaths(patchText);
		for (const target of targets) {
			if (!isStrictlyInsideSandbox(target, cwd, sbxPath)) {
				return {
					reason: `【沙盒安全隔离拦截】补丁包含沙盒目录（${sbxPath}）以外的目标路径："${target}"。沙盒内严禁越界修改。`,
					reasonEn: `[Sandbox Isolation Blocked] Patch contains a target path outside the sandbox directory (${sbxPath}): "${target}". Out-of-bounds modification is forbidden in sandbox mode.`,
				};
			}
		}
		return null;
	}

	// 3. 终端命令：bash
	if (toolName === "bash") {
		const cmd = typeof p.command === "string" ? p.command : "";
		if (!cmd.trim()) return null;

		// 3a. 若为导入源项目的沙盒，严禁在命令中直接引用源项目路径（防 AI cd 回原项目改动）
		if (sandbox.sourcePath) {
			const srcWire = toWirePath(sandbox.sourcePath);
			const srcNative = resolve(sandbox.sourcePath);
			const cmdLower = process.platform === "win32" ? cmd.toLowerCase() : cmd;
			const wireNeedle = process.platform === "win32" ? srcWire.toLowerCase() : srcWire;
			const nativeNeedle = process.platform === "win32" ? srcNative.toLowerCase() : srcNative;
			if (
				(wireNeedle.length > 3 && cmdLower.includes(wireNeedle)) ||
				(nativeNeedle.length > 3 && cmdLower.includes(nativeNeedle))
			) {
				return {
					reason: `【沙盒安全隔离拦截】检测到命令直接引用了源项目路径（${sandbox.sourcePath}）。沙盒模式下原项目受严格保护，请仅对当前沙盒目录（${sbxPath}）执行操作。`,
					reasonEn: `[Sandbox Isolation Blocked] Command directly references the source project path (${sandbox.sourcePath}). The original project is strictly protected in sandbox mode; operate only inside the current sandbox directory (${sbxPath}).`,
				};
			}
		}

		// 3b. 拦截通过 cd 跳出沙盒边界（裸 cd 跳 $HOME、cd ~、cd ..、或 cd 到沙盒外绝对路径，支持括号子 shell 与带引号/变量路径）
		for (const m of cmd.matchAll(/(?:^|[;&|\n(`]\s*)cd(?:\s+([^;&|\n)`]+))?(?=$|[;&|\n)`])/g)) {
			const rawArg = (m[1] ?? "").trim().replace(/^["']|["']$/g, "");
			if (
				!rawArg ||
				rawArg === "~" ||
				rawArg.startsWith("~/") ||
				rawArg.startsWith("~\\") ||
				/^\$(?:HOME|USERPROFILE)\b|^\$\{(?:HOME|USERPROFILE)\}|^%USERPROFILE%/i.test(rawArg) ||
				/\$(?:HOME|USERPROFILE)|\$\{(?:HOME|USERPROFILE)\}/i.test(rawArg)
			) {
				return {
					reason: `【沙盒安全隔离拦截】沙盒内禁止执行跳回用户主目录的 "cd ${rawArg || "~"}" 命令，请保持在沙盒目录（${sbxPath}）内操作。`,
					reasonEn: `[Sandbox Isolation Blocked] Escaping to the user home directory via "cd ${rawArg || "~"}" is forbidden in sandbox mode; stay within "${sbxPath}".`,
				};
			}
			if (rawArg !== "-" && !rawArg.startsWith("$") && !isStrictlyInsideSandbox(rawArg, cwd, sbxPath)) {
				return {
					reason: `【沙盒安全隔离拦截】禁止通过 "cd ${rawArg}" 跳出沙盒根目录（${sbxPath}）。`,
					reasonEn: `[Sandbox Isolation Blocked] Escaping the sandbox root (${sbxPath}) via "cd ${rawArg}" is forbidden.`,
				};
			}
		}

		// 3c. 拦截重定向（> / >>）写入沙盒外路径（/dev/null 除外）
		for (const m of cmd.matchAll(/(?:^|[^0-9>&])>>?\s*([^\s;&|>'"]+|"[^"]+"|'[^']+')/g)) {
			const target = (m[1] ?? "").trim().replace(/^["']|["']$/g, "");
			if (!target || target === "/dev/null" || target === "NUL" || target.startsWith("&")) continue;
			if (!isStrictlyInsideSandbox(target, cwd, sbxPath)) {
				return {
					reason: `【沙盒安全隔离拦截】禁止将输出重定向写入沙盒目录（${sbxPath}）以外的路径："${target}"。`,
					reasonEn: `[Sandbox Isolation Blocked] Redirecting output to a path outside the sandbox directory (${sbxPath}) is forbidden: "${target}".`,
				};
			}
		}

		// 3d. 拦截系统特权命令与全局包安装污染宿主机
		if (
			/(?:^|[;&|\n]\s*)(?:sudo|su|mkfs|format|fdisk|diskpart|reg\s+(?:add|delete)|schtasks|systemctl|launchctl|sc\s+(?:create|delete|stop))\b/i.test(
				cmd,
			) ||
			/\b(?:npm\s+(?:i|install|add|un|uninstall)\s+(?:[^;&|\n]*\s)?(?:-g|--global)\b|pnpm\s+(?:add|remove)\s+(?:[^;&|\n]*\s)?(?:-g|--global)\b|yarn\s+global\b)/i.test(
				cmd,
			)
		) {
			return {
				reason: `【沙盒安全隔离拦截】沙盒内禁止执行宿主机系统级管理命令或全局包安装（-g/--global），以保护宿主系统环境。`,
				reasonEn: `[Sandbox Isolation Blocked] System administration commands and global package installations (-g/--global) are forbidden in sandbox mode to protect the host environment.`,
			};
		}

		// 3e. 拦截文件修改/删除命令（rm/del/mv/cp/chmod/touch/mkdir/sed -i/tee 等）指向 ..、~、$HOME 或沙盒外绝对路径
		const mutatingCmdRe =
			/(?:^|[;&|\n(`]\s*)(?:rm|del|erase|rmdir|rd|mv|move|cp|copy|xcopy|robocopy|ln|mklink|chmod|chown|touch|mkdir|tee|dd|Remove-Item|Move-Item|Copy-Item|Set-Content|Add-Content|Out-File|sed\s+-[a-zA-Z]*i)\b([^;&|\n)]*)/gi;
		for (const m of cmd.matchAll(mutatingCmdRe)) {
			const argsTail = (m[1] ?? "").trim();
			const tokens = argsTail.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? [];
			for (const rawTok of tokens) {
				const tok = rawTok.replace(/^["']|["']$/g, "");
				if (!tok || tok.startsWith("-") || tok === "/dev/null") continue;
				if (
					tok === "~" ||
					tok.startsWith("~/") ||
					tok.startsWith("~\\") ||
					/^\$(?:HOME|USERPROFILE)\b|^%USERPROFILE%/i.test(tok) ||
					tok === ".." ||
					tok.startsWith("../") ||
					tok.startsWith("..\\") ||
					tok.includes("/../") ||
					tok.includes("\\..\\")
				) {
					if (!isStrictlyInsideSandbox(tok, cwd, sbxPath)) {
						return {
							reason: `【沙盒安全隔离拦截】检测到命令尝试操作沙盒外部或宿主系统路径（"${tok}"），已被硬围栏阻断。`,
							reasonEn: `[Sandbox Isolation Blocked] Command attempted to mutate a path outside the sandbox or on the host system ("${tok}") and was blocked.`,
						};
					}
				}
				// 绝对路径（POSIX /... 或 Windows C:\...）且不在沙盒根内
				if ((tok.startsWith("/") && !tok.startsWith("//")) || /^[a-zA-Z]:[\\/]/.test(tok)) {
					if (!isStrictlyInsideSandbox(tok, cwd, sbxPath)) {
						return {
							reason: `【沙盒安全隔离拦截】检测到命令尝试修改沙盒目录（${sbxPath}）以外的系统/外部路径（"${tok}"），已被硬围栏阻断。`,
							reasonEn: `[Sandbox Isolation Blocked] Command attempted to modify an external/system path outside the sandbox ("${tok}") and was blocked.`,
						};
					}
				}
			}
		}

		return null;
	}

	// 4. 外部副作用工具：sftp / mail
	if (toolName === "sftp") {
		const act = typeof p.action === "string" ? p.action : "";
		const isMutatingSync = act === "sync" && p.dryRun === false;
		if (isMutatingSync || act === "write" || act === "rm" || act === "mv" || act === "mkdir" || act === "exec") {
			return {
				reason: `【沙盒安全隔离拦截】沙盒项目内禁止执行会修改远程服务器的 SFTP 写/执行操作（action=${act}）。`,
				reasonEn: `[Sandbox Isolation Blocked] Remote-mutating SFTP operations (action=${act}) are forbidden inside a sandbox project.`,
			};
		}
	}
	if (toolName === "mail") {
		const act = typeof p.action === "string" ? p.action : "";
		if (act === "send" || (act === "manage" && p.manage_action === "delete")) {
			return {
				reason: `【沙盒安全隔离拦截】沙盒项目内禁止外发邮件或删除邮箱邮件（action=${act}）。`,
				reasonEn: `[Sandbox Isolation Blocked] Sending or deleting emails (action=${act}) is forbidden inside a sandbox project.`,
			};
		}
	}

	return null;
}

/**
 * 为工具包一层「沙盒硬围栏」：当 `getSandbox()` 返回非空时，对越界写操作与源项目触达直接硬拒绝。
 */
export function withSandboxJailGate(
	tool: ToolDefinition,
	getSandbox: () => SandboxInfo | undefined,
	getCwd: () => string,
	getLang: () => ServerLang,
): ToolDefinition {
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const sbx = getSandbox();
			if (sbx) {
				const denied = evaluateSandboxJail(sbx, tool.name, params as Record<string, unknown> | undefined, getCwd());
				if (denied) {
					return {
						content: [{ type: "text", text: pick(getLang(), denied.reason, denied.reasonEn) }],
						details: { guardDenied: true, sandboxDenied: true, sandboxId: sbx.id },
						isError: true,
					} as never;
				}
			}
			return tool.execute(toolCallId, params as never, signal, onUpdate, ctx);
		},
	};
}

interface SandboxRegistryFile {
	version: 1;
	sandboxes: SandboxInfo[];
}

interface CopyTreeStats {
	copiedFiles: number;
	skippedFiles: number;
}

/**
 * 递归复制目录内容（安全跳过重型缓存目录与指向源目录外部的软链）。
 */
async function copyWorkspaceTree(
	srcRoot: string,
	destRoot: string,
	opts?: { skipGitDir?: boolean },
): Promise<CopyTreeStats> {
	const resolvedSrcRoot = resolve(srcRoot);
	let realSrcRoot = resolvedSrcRoot;
	try {
		realSrcRoot = realpathSync(resolvedSrcRoot);
	} catch {
		// ignore
	}

	const stats: CopyTreeStats = { copiedFiles: 0, skippedFiles: 0 };

	async function walk(curSrc: string, curDest: string): Promise<void> {
		await mkdir(curDest, { recursive: true });
		const entries = await readdir(curSrc, { withFileTypes: true });
		for (const entry of entries) {
			const name = entry.name;
			if (SANDBOX_IGNORED_FILES.has(name) || name.startsWith(".pi-tmp")) {
				continue;
			}
			if (SANDBOX_IGNORED_DIRS.has(name)) {
				continue;
			}
			if (opts?.skipGitDir && name === ".git") {
				continue;
			}

			const srcPath = join(curSrc, name);
			const destPath = join(curDest, name);

			let lst;
			try {
				lst = await lstat(srcPath);
			} catch {
				continue;
			}

			// 安全防御：跳过符号链接（避免软链逃逸或循环软链爆栈）
			if (lst.isSymbolicLink()) {
				stats.skippedFiles++;
				continue;
			}

			if (lst.isDirectory()) {
				// 防止把沙盒目录自身递归拷进自己
				if (isSameOrSubpath(destRoot, srcPath)) {
					continue;
				}
				await walk(srcPath, destPath);
			} else if (lst.isFile()) {
				if (stats.copiedFiles >= MAX_IMPORT_FILES || lst.size > MAX_SINGLE_FILE_BYTES) {
					stats.skippedFiles++;
					continue;
				}
				// 确认真实路径仍在源目录内
				try {
					const realParent = realpathSync(dirname(srcPath));
					if (!isSameOrSubpath(realParent, realSrcRoot)) {
						stats.skippedFiles++;
						continue;
					}
				} catch {
					stats.skippedFiles++;
					continue;
				}
				await copyFile(srcPath, destPath);
				stats.copiedFiles++;
			}
		}
	}

	await walk(resolvedSrcRoot, resolve(destRoot));
	return stats;
}

export class SandboxManager {
	readonly sandboxesRoot: string;
	private readonly registryPath: string;
	private items = new Map<string, SandboxInfo>();
	private lastLoadedMtime = -1;

	constructor(dataDir: string) {
		this.sandboxesRoot = toWirePath(join(dataDir, "sandboxes"));
		this.registryPath = join(dataDir, "sandboxes", "registry.json");
		this.load();
	}

	private ensureFresh(): void {
		if (!existsSync(this.registryPath)) {
			if (this.lastLoadedMtime !== -1) {
				this.items.clear();
				this.lastLoadedMtime = -1;
			}
			return;
		}
		try {
			const mtime = statSync(this.registryPath).mtimeMs;
			if (mtime !== this.lastLoadedMtime) {
				this.load();
			}
		} catch {
			// ignore
		}
	}

	private load(): void {
		this.items.clear();
		if (!existsSync(this.registryPath)) {
			this.lastLoadedMtime = -1;
			return;
		}
		try {
			this.lastLoadedMtime = statSync(this.registryPath).mtimeMs;
			const raw = JSON.parse(readFileSync(this.registryPath, "utf-8")) as Partial<SandboxRegistryFile>;
			if (!Array.isArray(raw.sandboxes)) return;
			for (const item of raw.sandboxes) {
				if (!item || typeof item.id !== "string" || typeof item.path !== "string") continue;
				const wirePath = toWirePath(item.path);
				if (!existsSync(wirePath)) continue;
				this.items.set(item.id, {
					id: item.id,
					name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : item.id,
					path: wirePath,
					sourcePath:
						typeof item.sourcePath === "string" && item.sourcePath.trim() ? toWirePath(item.sourcePath) : undefined,
					ephemeral: Boolean(item.ephemeral),
					createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
				});
			}
		} catch {
			// best-effort
		}
	}

	private save(): void {
		try {
			mkdirSync(dirname(this.registryPath), { recursive: true });
			const payload: SandboxRegistryFile = {
				version: 1,
				sandboxes: [...this.items.values()].sort((a, b) => b.createdAt - a.createdAt),
			};
			writeFileSync(this.registryPath, JSON.stringify(payload, null, "\t"), "utf-8");
			this.lastLoadedMtime = statSync(this.registryPath).mtimeMs;
		} catch {
			// best-effort
		}
	}

	/** 列出所有有效沙盒（自动剔除磁盘上已被外部删除的目录）。 */
	list(): SandboxInfo[] {
		this.ensureFresh();
		let dirty = false;
		for (const [id, info] of this.items) {
			if (!existsSync(info.path)) {
				this.items.delete(id);
				dirty = true;
			}
		}
		if (dirty) this.save();
		return [...this.items.values()].sort((a, b) => b.createdAt - a.createdAt);
	}

	/** 按沙盒 id 或路径精确查找沙盒。 */
	get(idOrPath: string): SandboxInfo | undefined {
		if (!idOrPath) return undefined;
		this.ensureFresh();
		const byId = this.items.get(idOrPath);
		if (byId && existsSync(byId.path)) return byId;
		const key = normalizePathKey(idOrPath);
		for (const info of this.list()) {
			if (normalizePathKey(info.path) === key) return info;
		}
		return undefined;
	}

	/** 判断给定工作目录 `cwd` 是否处于某个受管沙盒内（含沙盒的子目录），若是则返回该沙盒信息。 */
	getByCwd(cwd: string): SandboxInfo | undefined {
		if (!cwd) return undefined;
		for (const info of this.list()) {
			if (isSameOrSubpath(cwd, info.path)) {
				return info;
			}
		}
		return undefined;
	}

	/**
	 * 创建一个新沙盒工作区（空白或从 `sourcePath` 导入隔离副本）。
	 */
	async create(opts: {
		name?: string;
		sourcePath?: string;
		ephemeral?: boolean;
	}): Promise<{ sandbox: SandboxInfo; copiedFiles: number; skippedFiles: number }> {
		// 先同步共享注册表：每个 ClientSession/DshClientSession 各持一个管理器实例、
		// 共享同一 registry.json——不 ensureFresh 的话并发创建会用陈旧内存覆盖写回，
		// 丢掉其他客户端刚建的沙盒条目（getByCwd 找不到 → jail 围栏静默失效）
		this.ensureFresh();
		const rawSource = opts.sourcePath?.trim();
		let resolvedSource: string | undefined;

		if (rawSource) {
			const expanded =
				rawSource === "~"
					? homedir()
					: rawSource.startsWith("~/") || rawSource.startsWith("~\\")
						? join(homedir(), rawSource.slice(2))
						: rawSource;
			const abs = resolve(expanded);
			if (!existsSync(abs) || !statSync(abs).isDirectory()) {
				throw new Error(`Source directory does not exist: ${rawSource}`);
			}
			if (isProtectedSystemOrHomeRoot(abs)) {
				throw new Error(`Refusing to import system root or user home directory into sandbox: ${abs}`);
			}
			if (isSameOrSubpath(this.sandboxesRoot, abs)) {
				throw new Error(`Refusing to import a parent directory of sandboxes root: ${abs}`);
			}
			// 沙盒根**内部**的目录也不允许当源：会造出嵌套沙盒（源被另一沙盒的
			// destroy/reset 抽掉、apply_to_source 把改动写进另一个沙盒）
			if (isSameOrSubpath(abs, this.sandboxesRoot)) {
				throw new Error(`Refusing to import a directory inside the sandboxes root: ${abs}`);
			}
			// 若选中的 source 本身已经是某个沙盒，而且该沙盒记录了原始 sourcePath，保留最外层真实路径或直接复制该沙盒内容
			resolvedSource = toWirePath(abs);
		}

		const id = `sbx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		const sbxDir = toWirePath(join(this.sandboxesRoot, id));
		await mkdir(sbxDir, { recursive: true });

		let copyStats: CopyTreeStats = { copiedFiles: 0, skippedFiles: 0 };
		if (resolvedSource) {
			copyStats = await copyWorkspaceTree(resolvedSource, sbxDir);
		}

		const defaultName = resolvedSource ? `${basename(resolvedSource)} (Sandbox)` : `Sandbox ${id.slice(-4)}`;
		const name = opts.name?.trim() || defaultName;
		const info: SandboxInfo = {
			id,
			name,
			path: sbxDir,
			sourcePath: resolvedSource,
			ephemeral: opts.ephemeral ?? true,
			createdAt: Date.now(),
		};
		this.items.set(id, info);
		this.save();
		return { sandbox: info, ...copyStats };
	}

	/**
	 * 重置沙盒：清空沙盒根下所有文件；若存在 `sourcePath` 则重新从源项目同步干净副本。
	 */
	async reset(idOrPath: string): Promise<{ sandbox: SandboxInfo; copiedFiles: number; skippedFiles: number }> {
		const info = this.get(idOrPath) ?? this.getByCwd(idOrPath);
		if (!info) {
			throw new Error(`Sandbox not found: ${idOrPath}`);
		}
		await mkdir(info.path, { recursive: true });
		const entries = await readdir(info.path);
		// 逐条目容错：Windows 下沙盒内进程未停（npm run dev 的 node.exe 持有句柄）
		// 会让单个条目 EBUSY/EPERM——整体抛错会留下半清空状态；能删的先删，
		// 全部失败才抛
		const failures: string[] = [];
		for (const entry of entries) {
			try {
				await rm(join(info.path, entry), { recursive: true, force: true, maxRetries: 3 });
			} catch {
				failures.push(entry);
			}
		}
		if (failures.length === entries.length && entries.length > 0) {
			throw new Error(
				`Failed to clear sandbox contents (all ${failures.length} entries busy): ${failures.slice(0, 5).join(", ")}`,
			);
		}
		if (failures.length > 0) {
			console.warn(
				`[sandbox] reset: ${failures.length}/${entries.length} entries could not be removed (busy): ${failures.slice(0, 5).join(", ")}`,
			);
		}
		let copyStats: CopyTreeStats = { copiedFiles: 0, skippedFiles: 0 };
		if (info.sourcePath && existsSync(info.sourcePath)) {
			copyStats = await copyWorkspaceTree(info.sourcePath, info.path);
		}
		return { sandbox: info, ...copyStats };
	}

	/**
	 * 将临时沙盒转为永久沙盒（`ephemeral = false`）。
	 */
	persist(idOrPath: string): SandboxInfo {
		const info = this.get(idOrPath) ?? this.getByCwd(idOrPath);
		if (!info) {
			throw new Error(`Sandbox not found: ${idOrPath}`);
		}
		const updated: SandboxInfo = { ...info, ephemeral: false };
		this.items.set(info.id, updated);
		this.save();
		return updated;
	}

	/**
	 * 将沙盒项目导出/转正到指定目标目录（`targetPath` 必须位于沙盒根外部，且若已存在必须为空目录）。
	 */
	async promote(
		idOrPath: string,
		targetPath: string,
	): Promise<{ sandbox: SandboxInfo; targetPath: string; copiedFiles: number }> {
		const info = this.get(idOrPath) ?? this.getByCwd(idOrPath);
		if (!info) {
			throw new Error(`Sandbox not found: ${idOrPath}`);
		}
		const trimmed = targetPath.trim();
		if (!trimmed) {
			throw new Error("Target path is required");
		}
		const expanded =
			trimmed === "~"
				? homedir()
				: trimmed.startsWith("~/") || trimmed.startsWith("~\\")
					? join(homedir(), trimmed.slice(2))
					: trimmed;
		const resolvedTarget = resolve(expanded);
		if (isProtectedSystemOrHomeRoot(resolvedTarget)) {
			throw new Error(`Refusing to export sandbox to system or home root: ${resolvedTarget}`);
		}
		if (isSameOrSubpath(resolvedTarget, this.sandboxesRoot)) {
			throw new Error("Target path must be outside the managed sandboxes directory");
		}
		if (existsSync(resolvedTarget)) {
			const st = await stat(resolvedTarget);
			if (!st.isDirectory()) {
				throw new Error(`Target path already exists and is not a directory: ${resolvedTarget}`);
			}
			const existing = await readdir(resolvedTarget);
			if (existing.length > 0) {
				throw new Error(`Target directory is not empty: ${resolvedTarget}`);
			}
		} else {
			await mkdir(resolvedTarget, { recursive: true });
		}

		const stats = await copyWorkspaceTree(info.path, resolvedTarget);
		return {
			sandbox: info,
			targetPath: toWirePath(resolvedTarget),
			copiedFiles: stats.copiedFiles,
		};
	}

	/**
	 * 将导入型沙盒中的修改写回源项目（保留源项目 `.git` 与重型依赖目录，同步工作区文件变更并清理已删除文件）。
	 */
	async applyToSource(idOrPath: string): Promise<{
		sandbox: SandboxInfo;
		sourcePath: string;
		copiedFiles: number;
		deletedFiles: number;
	}> {
		const info = this.get(idOrPath) ?? this.getByCwd(idOrPath);
		if (!info) {
			throw new Error(`Sandbox not found: ${idOrPath}`);
		}
		if (!info.sourcePath || !existsSync(info.sourcePath)) {
			throw new Error("This sandbox has no valid source project to apply changes back to");
		}

		// 1. 先通过 diff 计算出被删除的文件列表，以便同步清理源项目中的对应文件
		const diff = await this.diffWithSource(info.id);
		let deletedFiles = 0;
		for (const rel of diff.deleted) {
			// 安全校验：严格限制在 sourcePath 内，且避开 .git 与重型忽略目录
			if (
				!rel ||
				rel === ".git" ||
				rel.startsWith(".git/") ||
				rel.startsWith(".git\\") ||
				!isStrictlyInsideSandbox(rel, info.sourcePath, info.sourcePath)
			) {
				continue;
			}
			const targetFile = join(info.sourcePath, rel);
			if (existsSync(targetFile)) {
				try {
					await rm(targetFile, { force: true });
					deletedFiles++;
					// 尝试顺带清理变空的父目录（直到 sourcePath，不删 sourcePath 自身）
					let parent = dirname(targetFile);
					while (
						parent &&
						isSameOrSubpath(parent, info.sourcePath) &&
						normalizePathKey(parent) !== normalizePathKey(info.sourcePath)
					) {
						const remaining = await readdir(parent).catch(() => ["non-empty"]);
						if (remaining.length === 0) {
							await rm(parent, { recursive: true, force: true }).catch(() => {});
							parent = dirname(parent);
						} else {
							break;
						}
					}
				} catch {
					// 忽略单个文件清理失败
				}
			}
		}

		// 2. 将沙盒工作区的文件复制覆盖回源项目
		const stats = await copyWorkspaceTree(info.path, info.sourcePath, { skipGitDir: true });
		return {
			sandbox: info,
			sourcePath: info.sourcePath,
			copiedFiles: stats.copiedFiles,
			deletedFiles,
		};
	}

	/**
	 * 对比沙盒与源项目之间的文件增删改差异（若为空白沙盒，则所有沙盒内文件计入 added）。
	 */
	async diffWithSource(idOrPath: string): Promise<{
		sandbox: SandboxInfo;
		sourcePath?: string;
		added: string[];
		modified: string[];
		deleted: string[];
		unchangedCount: number;
	}> {
		const info = this.get(idOrPath) ?? this.getByCwd(idOrPath);
		if (!info) {
			throw new Error(`Sandbox not found: ${idOrPath}`);
		}

		const collectRelativeFiles = async (rootDir: string): Promise<Map<string, { abs: string; size: number }>> => {
			const map = new Map<string, { abs: string; size: number }>();
			if (!existsSync(rootDir)) return map;
			const resolvedRoot = resolve(rootDir);

			const walk = async (curDir: string, relPrefix: string): Promise<void> => {
				const entries = await readdir(curDir, { withFileTypes: true });
				for (const entry of entries) {
					const name = entry.name;
					if (
						name === ".git" ||
						SANDBOX_IGNORED_FILES.has(name) ||
						name.startsWith(".pi-tmp") ||
						SANDBOX_IGNORED_DIRS.has(name)
					) {
						continue;
					}
					const fullPath = join(curDir, name);
					const relPath = relPrefix ? `${relPrefix}/${name}` : name;
					let lst;
					try {
						lst = await lstat(fullPath);
					} catch {
						continue;
					}
					if (lst.isSymbolicLink()) continue;
					if (lst.isDirectory()) {
						await walk(fullPath, relPath);
					} else if (lst.isFile()) {
						if (map.size < MAX_IMPORT_FILES && lst.size <= MAX_SINGLE_FILE_BYTES) {
							map.set(relPath, { abs: fullPath, size: lst.size });
						}
					}
				}
			};
			await walk(resolvedRoot, "");
			return map;
		};

		const sbxFiles = await collectRelativeFiles(info.path);
		if (!info.sourcePath || !existsSync(info.sourcePath)) {
			return {
				sandbox: info,
				sourcePath: info.sourcePath,
				added: [...sbxFiles.keys()].sort(),
				modified: [],
				deleted: [],
				unchangedCount: 0,
			};
		}

		const srcFiles = await collectRelativeFiles(info.sourcePath);
		const added: string[] = [];
		const modified: string[] = [];
		const deleted: string[] = [];
		let unchangedCount = 0;

		for (const [rel, sbxMeta] of sbxFiles) {
			const srcMeta = srcFiles.get(rel);
			if (!srcMeta) {
				added.push(rel);
				continue;
			}
			if (sbxMeta.size !== srcMeta.size) {
				modified.push(rel);
				continue;
			}
			try {
				const b1 = readFileSync(sbxMeta.abs);
				const b2 = readFileSync(srcMeta.abs);
				if (b1.equals(b2)) {
					unchangedCount++;
				} else {
					modified.push(rel);
				}
			} catch {
				modified.push(rel);
			}
		}

		for (const rel of srcFiles.keys()) {
			if (!sbxFiles.has(rel)) {
				deleted.push(rel);
			}
		}

		added.sort();
		modified.sort();
		deleted.sort();

		return {
			sandbox: info,
			sourcePath: info.sourcePath,
			added,
			modified,
			deleted,
			unchangedCount,
		};
	}

	/**
	 * 彻底销毁沙盒：从注册表移除并递归删除沙盒磁盘目录。
	 */
	async destroy(idOrPath: string): Promise<SandboxInfo | undefined> {
		const info = this.get(idOrPath) ?? this.getByCwd(idOrPath);
		if (!info) return undefined;
		this.items.delete(info.id);
		this.save();
		// 安全校验：仅删除位于 sandboxesRoot 下的目录
		if (
			isSameOrSubpath(info.path, this.sandboxesRoot) &&
			normalizePathKey(info.path) !== normalizePathKey(this.sandboxesRoot)
		) {
			await rm(info.path, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
		}
		return info;
	}
}
