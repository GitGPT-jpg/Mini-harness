/**
 * remote-ssh-service.ts — 远程工作区路径纯工具（SSH 连接/探针/SFTP 已随精简发行版移除）。
 *
 * 保留：ssh:// URI 的解析、会话目录映射、路径到远程路径的换算、提示词里的 cwd 呈现
 * 等纯函数 —— 文件层的 `isRemoteWorkspaceUri` 分支依赖它们。远程分支永不触发
 * （getGlobalRemoteSshService 恒返回 null，见文件尾）。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ParsedRemoteUri {
	username: string;
	host: string;
	port: number;
	remotePath: string;
	hostKey: string;
}

/** `~` 路径展开 */
/** `~` 路径展开 */
export function expandHome(p?: string): string | undefined {
	if (p === undefined) return undefined;
	const s = p.trim();
	if (!s) return s;
	if (s === "~") return os.homedir();
	if (s.startsWith("~/") || s.startsWith("~\\")) {
		return path.join(os.homedir(), s.slice(2));
	}
	return s;
}

/** 判断路径是否为 ssh:// 远程工作区 URI */
export function isRemoteWorkspaceUri(uri?: string | null): boolean {
	return Boolean(uri && uri.trim().startsWith("ssh://"));
}

/** 解析 ssh://user@host:port/remote/path */
export function parseRemoteWorkspaceUri(uri: string): ParsedRemoteUri | null {
	if (!isRemoteWorkspaceUri(uri)) return null;
	const trimmed = uri.trim();
	const m = /^ssh:\/\/([^@]+)@([^:/]+)(?::(\d+))?(\/.*)?$/.exec(trimmed);
	if (!m) return null;
	const username = m[1];
	const host = m[2];
	const port = m[3] ? parseInt(m[3], 10) || 22 : 22;
	const rawPath = m[4] ? m[4].replace(/\\/g, "/") : "/";
	const remotePath = path.posix.normalize(rawPath).replace(/\/+$/, "") || "/";
	return {
		username,
		host,
		port,
		remotePath,
		hostKey: `${username}@${host}:${port}`,
	};
}

/** 构造规范的 ssh://user@host:port/remote/path */
export function formatRemoteWorkspaceUri(username: string, host: string, port: number, remotePath: string): string {
	const cleanPath = path.posix.normalize((remotePath || "/").replace(/\\/g, "/"));
	const normPath = cleanPath.startsWith("/") ? cleanPath : `/${cleanPath}`;
	return `ssh://${username}@${host}:${port || 22}${normPath !== "/" ? normPath.replace(/\/+$/, "") : "/"}`;
}

/**
 * 在远程工作区根 remoteRoot 下解析相对或绝对路径，防止 `..` 越界。
 * 返回 { abs: 远程 posix 绝对路径, rel: 相对工作区根的 posix 相对路径（根自身为 ""） }
 */
export function resolveRemoteWorkspacePath(remoteRoot: string, rawPath: string): { abs: string; rel: string } | null {
	const root = path.posix.normalize(remoteRoot.replace(/\\/g, "/")).replace(/\/+$/, "") || "/";
	let cleaned = (rawPath || "").replace(/\\/g, "/").trim();
	if (isRemoteWorkspaceUri(cleaned)) {
		const parsed = parseRemoteWorkspaceUri(cleaned);
		if (parsed) {
			cleaned = parsed.remotePath;
		}
	}
	if (!cleaned || cleaned === ".") {
		return { abs: root, rel: "" };
	}
	const abs = cleaned.startsWith("/") ? path.posix.normalize(cleaned) : path.posix.resolve(root, cleaned);
	const rel = path.posix.relative(root, abs);
	if (rel.startsWith("..") || rel.includes("/..") || path.posix.isAbsolute(rel)) {
		return null;
	}
	return { abs, rel: rel === "." ? "" : rel };
}

const REMOTE_URI_MARKER_FILE = ".pi-remote-uri";

/**
 * 将工作区路径（本地目录或 ssh:// URI）映射到本地会话物理存储目录。
 * - 本地工作区原样返回；
 * - 远程 ssh:// 工作区映射到 `<dataDir>/remote-workspaces/<slug>`，并在其中写入 `.pi-remote-uri` 标记文件，
 *   使得所有的会话 JSONL、计划、草稿全部 100% 存储在本地磁盘。
 */
export function resolveWorkspaceSessionDir(dataDir: string | undefined, cwdOrUri: string): string {
	const trimmed = (cwdOrUri || "").trim();
	if (!isRemoteWorkspaceUri(trimmed)) {
		return trimmed;
	}
	const safeDataDir = dataDir || process.env.PI_WEB_DATA_DIR || path.join(os.homedir(), ".pi-web");
	const parsed = parseRemoteWorkspaceUri(trimmed);
	const hash = createHash("sha1").update(trimmed).digest("hex").slice(0, 10);
	const baseName = parsed
		? `${parsed.username}_${parsed.host}_${parsed.port}_${parsed.remotePath.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "")}`.slice(
				0,
				72,
			)
		: trimmed.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 72);
	const dir = path.resolve(safeDataDir, "remote-workspaces", `${baseName}_${hash}`);
	try {
		mkdirSync(dir, { recursive: true });
		const markerPath = path.join(dir, REMOTE_URI_MARKER_FILE);
		if (!existsSync(markerPath)) {
			writeFileSync(markerPath, trimmed, "utf8");
		}
	} catch {
		// ignore mkdir error in read-only edge cases
	}
	return dir;
}

/**
 * 从本地会话物理存储目录还原出工作区标识：
 * 若目录下含有 `.pi-remote-uri` 标记文件，则返回原始 `ssh://...` URI；否则原样返回本地路径。
 */
export function restoreWorkspaceUriFromSessionDir(dir: string): string {
	if (!dir || isRemoteWorkspaceUri(dir)) return dir;
	try {
		const markerPath = path.join(dir, REMOTE_URI_MARKER_FILE);
		if (existsSync(markerPath)) {
			const uri = readFileSync(markerPath, "utf8").trim();
			if (isRemoteWorkspaceUri(uri)) return uri;
		}
	} catch {
		// ignore
	}
	return dir;
}

/** Shell 安全单引号转义 */
export function shellQuotePosix(s: string): string {
	return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * 将 SDK resolveToCwd 产生的本地路径（或原始输入路径）映射为远程工作区的 posix 绝对路径。
 */
export function mapResolvedPathToRemote(
	resolvedOrRawPath: string,
	localSessionDir: string,
	remoteWorkspaceUri: string,
): string {
	const parsed = parseRemoteWorkspaceUri(remoteWorkspaceUri);
	const remoteRoot = parsed?.remotePath || "/";
	const raw = (resolvedOrRawPath || "").trim();
	if (!raw || raw === ".") return remoteRoot;

	try {
		const rel = path.relative(path.resolve(localSessionDir), path.resolve(raw));
		if (rel === "") return remoteRoot;
		if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
			return path.posix.join(remoteRoot, rel.split(path.sep).join("/"));
		}
	} catch {}

	const stripped = raw
		.replace(/^[A-Za-z]:/, "")
		.split(path.sep)
		.join("/");
	return stripped.startsWith("/") ? path.posix.normalize(stripped) : path.posix.resolve(remoteRoot, stripped);
}

/**
 * 生成面向 AI 的远程工作区身份与工具透明桥接提示词。
 * 在远程工作区下替代本地 WINDOWS_PERSONA 的平台身份描述，同时完整保留防挂死（timeout / 禁前台长驻 / TTY 禁交互 / GBK 编码）核心规则。
 */
export function buildRemoteWorkspacePersona(remoteUri: string): string {
	const parsed = parseRemoteWorkspaceUri(remoteUri);
	const hostDesc = parsed ? `${parsed.username}@${parsed.host}:${parsed.port}` : remoteUri;
	const remoteDir = parsed ? parsed.remotePath : remoteUri;
	return [
		`You are operating inside a REMOTE SSH workspace (${remoteUri}).`,
		`- Target host: ${hostDesc}`,
		`- Remote working directory: ${remoteDir}`,
		`- All built-in workspace tools (bash, read, write, edit, edit_soft, ls, find, grep) and interactive terminals are ALREADY transparently bridged to execute directly on the remote host in "${remoteDir}".`,
		`- Use normal POSIX relative paths (e.g. "src/index.ts") or remote absolute paths (e.g. "${remoteDir}/src/index.ts") directly in read/write/edit/bash/ls/find/grep. Do NOT wrap bash commands in "ssh ..." and do NOT treat this workspace as the local client OS.`,
		``,
		`Follow these rules to avoid hanging the session:`,
		`- ALWAYS pass a timeout parameter to the bash tool (in seconds). There is NO default timeout — a command that never finishes (servers, watchers, infinite loops, slow downloads/installs) will hang the entire conversation indefinitely. Pick a generous timeout for long-running work, but never omit it.`,
		`- NEVER run interactive or foreground long-running commands through the bash tool (vi, less, top, python -, node -, npm run dev, sleep 10000). For servers/daemons use background execution with output redirected to a log file, then poll the log; stop them when done.`,
		`- In the interactive terminal (TTY) — NEVER use heredocs (<<'EOF' ... EOF) or here-strings, and NEVER start interactive programs (vi, less, python -, node -, npm init): they wait for keyboard input that never arrives and hang the terminal forever. Prefer writing a temp script file (e.g. .pi-tmp.sh) and running it non-interactively. ALWAYS pass a timeout to long-running commands (e.g. \`timeout 120 npm run dev\`).`,
		`- Many legacy Chinese text files (.html/.txt/.md/.log, exported documents) are GBK/GB2312 encoded: the read tool decodes UTF-8 only and will show mojibake (乱码) for them. If a file's content looks garbled, read it through the terminal or bash using \`iconv -f GBK -t UTF-8 file\`. Never paste mojibake into your reasoning or answer — describe the decoded content instead.`,
	].join("\n");
}

/**
 * 将会话 cwd 格式化为系统提示词里的 Current working directory 展示文本。
 * 若为远程工作区，展示远程真实目录与 SSH URI，绝不向模型暴露本地缓存路径。
 */
export function formatCwdForPrompt(cwdOrSessionDir: string): string {
	const real = restoreWorkspaceUriFromSessionDir(cwdOrSessionDir);
	if (isRemoteWorkspaceUri(real)) {
		const parsed = parseRemoteWorkspaceUri(real);
		return parsed ? `${parsed.remotePath} (remote SSH: ${real})` : real;
	}
	return cwdOrSessionDir;
}

/**
 * 若当前会话目录对应远程 ssh:// 工作区，构造供 SDK 内置工具（read/write/edit/ls/find/grep）使用的远程 operations。
 * 若为普通本地工作区则返回 null。
 */
export function createRemoteSdkOperations(localSessionDir: string) {
	const remoteUri = restoreWorkspaceUriFromSessionDir(localSessionDir);
	if (!isRemoteWorkspaceUri(remoteUri)) return null;

	const toRemote = (p: string) => mapResolvedPathToRemote(p, localSessionDir, remoteUri);
	const getSvc = () => {
		const svc = getGlobalRemoteSshService();
		if (!svc) throw new Error("Remote SSH service is not initialized");
		return svc;
	};

	return {
		remoteUri,
		toRemote,
		isDirectory: async (p: string): Promise<boolean> => {
			try {
				const st = await getSvc().sftpStat(remoteUri, toRemote(p));
				return st.isDirectory;
			} catch {
				return false;
			}
		},
		read: {
			readFile: async (p: string): Promise<Buffer> => {
				const { data } = await getSvc().sftpReadFile(remoteUri, toRemote(p));
				return data;
			},
			access: async (p: string): Promise<void> => {
				await getSvc().sftpStat(remoteUri, toRemote(p));
			},
		},
		write: {
			writeFile: async (p: string, content: string): Promise<void> => {
				await getSvc().sftpWriteFile(remoteUri, toRemote(p), content, { createParents: true });
			},
			mkdir: async (dir: string): Promise<void> => {
				await getSvc().sftpMkdirRecursive(remoteUri, toRemote(dir));
			},
		},
		edit: {
			readFile: async (p: string): Promise<Buffer> => {
				const { data } = await getSvc().sftpReadFile(remoteUri, toRemote(p));
				return data;
			},
			writeFile: async (p: string, content: string): Promise<void> => {
				await getSvc().sftpWriteFile(remoteUri, toRemote(p), content, { createParents: true });
			},
			access: async (p: string): Promise<void> => {
				await getSvc().sftpStat(remoteUri, toRemote(p));
			},
		},
		ls: {
			exists: async (p: string): Promise<boolean> => {
				try {
					await getSvc().sftpStat(remoteUri, toRemote(p));
					return true;
				} catch {
					return false;
				}
			},
			stat: async (p: string): Promise<{ isDirectory: () => boolean }> => {
				const st = await getSvc().sftpStat(remoteUri, toRemote(p));
				return { isDirectory: () => st.isDirectory };
			},
			readdir: async (p: string): Promise<string[]> => {
				const entries = await getSvc().sftpReaddir(remoteUri, toRemote(p));
				return entries.map((e: { name: string }) => e.name);
			},
		},
		find: {
			exists: async (p: string): Promise<boolean> => {
				try {
					await getSvc().sftpStat(remoteUri, toRemote(p));
					return true;
				} catch {
					return false;
				}
			},
			glob: async (
				pattern: string,
				searchPath: string,
				options: { ignore: string[]; limit: number },
			): Promise<string[]> => {
				const remoteDir = toRemote(searchPath);
				const limit = Math.max(1, options.limit || 1000);
				const namePat = pattern.includes("/") ? pattern.split("/").pop() || "*" : pattern;
				const cmd = `find . \\( -name node_modules -o -name .git \\) -prune -o -name ${shellQuotePosix(namePat)} -print 2>/dev/null | head -n ${limit}`;
				const res = await getSvc().execInWorkspace(remoteUri, cmd, { cwd: remoteDir, timeoutMs: 15_000 });
				return res.stdout
					.split(/\r?\n/)
					.map((l: string) => l.trim().replace(/^\.\//, ""))
					.filter((l: string) => l && l !== ".");
			},
		},
		grepExecute: async (params: {
			pattern: string;
			path?: string;
			glob?: string;
			ignoreCase?: boolean;
			literal?: boolean;
			context?: number;
			limit?: number;
		}): Promise<string> => {
			const remoteTarget = toRemote(params.path || ".");
			const limit = Math.max(1, params.limit ?? 100);
			const flags: string[] = ["-rnI", "--exclude-dir=node_modules", "--exclude-dir=.git"];
			if (params.ignoreCase) flags.push("-i");
			if (params.literal) flags.push("-F");
			else flags.push("-E");
			if (params.context && params.context > 0) flags.push(`-C ${Math.floor(params.context)}`);
			if (params.glob) flags.push(`--include=${shellQuotePosix(params.glob)}`);
			const cmd = `grep ${flags.join(" ")} -- ${shellQuotePosix(params.pattern)} ${shellQuotePosix(remoteTarget)} 2>/dev/null | head -n ${limit}`;
			const res = await getSvc().execInWorkspace(remoteUri, cmd, { timeoutMs: 15_000 });
			const out = res.stdout.trim();
			return out || "No matches found";
		},
	};
}

/**
 * SSH 远程工作区已随精简发行版移除（只保留聊天/终端/Skills/状态栏/Loop 五项）。
 * 下方两个桩让文件层的「远程分支」保持编译：getGlobal 恒返回 null，远程分支永不触发；
 * setGlobal 空操作。createRemoteSdkOperations（上方）对非远程路径本就返回 null。
 */
export function setGlobalRemoteSshService(_svc: unknown): void {}

export function getGlobalRemoteSshService(): any {
	return null;
}
