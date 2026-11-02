/**
 * Files service — 预览读写 / 路径补全 / 全局检索。
 *
 * 全部为无状态 fs 操作，经 FilesHost 回调与 ClientSession 解耦。
 */
import { Dirent, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, relative, sep, isAbsolute, posix } from "node:path";
import type { ServerMessage, FileEntry, FileSearchResult } from "./protocol.js";
import { pick, type ServerLang } from "./i18n.js";
import { previewKind, looksLikeText, decodeText, hexDump, countLines } from "./text-sniff.js";
import { extractOfficeText, isOfficeFile, OFFICE_MAX_FILE_BYTES } from "./office-parse.js";
import {
	getGlobalRemoteSshService,
	isRemoteWorkspaceUri,
	parseRemoteWorkspaceUri,
	resolveRemoteWorkspacePath,
} from "./remote-ssh-service.js";

export const IS_WIN32 = process.platform === "win32";

/** 机器根虚拟路径：工作区「上一级」到达此处，列出所有盘符（Windows）/ "/"（posix）。
 *  这是 wire 字面量，前端 web/src/components/DirectoryBrowser.tsx 里同值使用。 */
export const MACHINE_ROOT = "@root";

/** 桌面目录（wire 格式）：存在且为目录才返回，否则空串（前端不渲染 🖥️）。
 *  Linux 优先读 XDG user-dirs（中文环境可能是 ~/桌面），其余平台即 ~/Desktop。 */
export function desktopDirWire(homeWire: string): string {
	const cands: string[] = [];
	if (process.platform === "linux") {
		try {
			const conf = readFileSync(resolve(homedir(), ".config", "user-dirs.dirs"), "utf8");
			const m = /XDG_DESKTOP_DIR="([^"]+)"/.exec(conf);
			if (m) {
				const dir = m[1].replace(/\$HOME/g, homeWire);
				if (dir.startsWith("/")) cands.push(dir);
			}
		} catch {
			// 无 XDG 配置就回落 ~/Desktop
		}
	}
	cands.push(`${homeWire}/Desktop`);
	for (const c of cands) {
		try {
			if (statSync(wireToAbs(c)).isDirectory()) return c;
		} catch {
			// 不存在就试下一个
		}
	}
	return "";
}

/** wire 路径统一用 "/"。绝对 = posix "/..."；win32 还有 "C:/..." / 裸 "C:"。
 *  机器浏览（越过工作区根换盘符）发送这些路径；工作区相对树不会产生它们（Windows
 *  文件名不能含 ":"，相对路径经 relative() 归一化后也不以 "/" 开头）。
 *  win32 还必须把盘符相对路径（"D:x"，冒号后无分隔符 —— resolve 会落到该盘的
 *  当前目录）与 UNC（"\\host\share"；"//host/share" 已被上面的 "/" 前缀覆盖）
 *  判为绝对：这些形态若被当工作区相对路径处理，会在跨盘/UNC 下绕过 ".." 检查
 *  逃出工作区。posix 上 "C:x" 是合法文件名，故盘符检查必须限定在 win32。 */
export function isAbsoluteWirePath(p: string): boolean {
	if (p === MACHINE_ROOT || p.startsWith("/") || p.startsWith("\\\\")) return true;
	return IS_WIN32 && /^[A-Za-z]:/.test(p);
}

/** 去掉结尾 "/"（保留 posix 根 "/" 本身），归一成规范的 wire 形式。前端面包屑
 *  不产生结尾斜杠，这里只对补全/直接输入做防御性清理。 */
export function normWirePath(p: string): string {
	if (p.endsWith("/") && p !== "/") return p.replace(/\/+$/, "") || "/";
	return p;
}

/** wire 绝对路径（"C:/Users/x" / "/Users/x" / "C:"）→ 原生绝对路径。
 *  裸盘符根（"C:"）在 win32 的 resolve 里会落到「C: 上的当前目录」，必须显式转 "C:\\"。 */
export function wireToAbs(wire: string): string {
	const w = normWirePath(wire);
	if (IS_WIN32) {
		const m = /^([A-Za-z]):$/.exec(w);
		if (m) return `${m[1].toUpperCase()}:\\`;
	}
	return resolve(w);
}

/** 预览只读文件前 512KB。 */
export const MAX_PREVIEW_BYTES = 512 * 1024;

/** 右键上传单文件上限（内存中转 base64 → Buffer）。 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** 上传 cap 对应的 base64 文本长度上限（4/3 膨胀，向上取整到 4 字符边界）。 */
export const MAX_UPLOAD_BASE64_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;
/** WS 入站帧上限：base64 上限 + 1MB JSON 包络余量（dirPath/name/type）。
 *  server/index.ts 的 maxPayload 由此取值，两处上限保持对齐。 */
export const WS_MAX_PAYLOAD_BYTES = MAX_UPLOAD_BASE64_CHARS + 1024 * 1024;

// mac/linux: hide build & dependency noise (original behavior).
const IGNORED_ENTRIES = new Set([
	"node_modules",
	".git",
	".svn",
	".hg",
	"dist",
	".next",
	".nuxt",
	".cache",
	".venv",
	"venv",
	"__pycache__",
	"coverage",
	".pi-web",
	".DS_Store",
	"Thumbs.db",
]);

// Windows: the file tree is the primary way to navigate a project, so only
// hide what would flood or destabilize the panel (dependency trees, VCS
// internals, session data) plus pure junk. Build output (dist/.next/…) and
// local env dirs (venv/__pycache__/…) stay visible — "所有文件可查看".
const IGNORED_ENTRIES_WIN = new Set(["node_modules", ".git", ".pi-web", ".DS_Store", "Thumbs.db", "desktop.ini"]);

/** The ignore set for the current platform — keeps win/posix lists separate. */
function ignoredEntries(): Set<string> {
	return IS_WIN32 ? IGNORED_ENTRIES_WIN : IGNORED_ENTRIES;
}

/**
 * Resolve a workspace-relative path against a root, refusing traversal
 * (".." escapes). Returns { abs, rel } — rel is normalized and slash-
 * separated — or null when the path leaves the workspace.
 */
export function workspacePath(root: string, raw: string): { abs: string; rel: string } | null {
	const abs = resolve(root, raw);
	const rawRel = relative(root, abs);
	// 只查 ".." 拦不住 Windows 的跨盘/UNC：relative("C:/a","D:/x") 与
	// relative("C:/a","//h/s") 返回绝对路径（"D:\x"、"\\h\s\"），不以 ".." 开头；
	// 盘符相对路径（"D:x"）经 resolve 落到该盘当前目录后也归此形 —— 必须同时
	// 拒绝 isAbsolute 的结果，否则 "D:x" 这类输入可逃出工作区根。
	if (rawRel.startsWith("..") || rawRel.includes(`${sep}..`) || isAbsolute(rawRel)) return null;
	// Normalize to forward slashes: the wire protocol and the frontend always
	// use "/", but relative() returns "\\" on Windows.
	return { abs, rel: rawRel.split(sep).join("/") };
}

/** dirent → FileEntry classification: directory symlinks are resolved via
 *  stat() on ALL platforms (#262 — Termux's ~/storage/* entries are symlinks;
 *  the directory-only cwd picker renders an empty list if they type as files). */
async function classifyDirent(d: Dirent, absDir: string): Promise<{ name: string; type: "dir" | "file" }> {
	const fs = await import("node:fs/promises");
	const { join } = await import("node:path");
	let type: "dir" | "file";
	if (d.isSymbolicLink()) {
		try {
			type = (await fs.stat(join(absDir, d.name))).isDirectory() ? "dir" : "file";
		} catch {
			type = "file"; // broken link
		}
	} else {
		type = d.isDirectory() ? "dir" : "file";
	}
	return { name: d.name, type };
}

/** ClientSession 提供给本服务的宿主能力。 */
export interface FilesHost {
	emit: (msg: ServerMessage) => void;
	/** 预览读写 / 路径补全 / 创建文件夹的工作区根（服务启动 cwd 或会话 cwd）。 */
	getCwd: () => string;
	/** 全局检索等所用工作区（当前活动对话所属项目，可能与 getCwd 不同）。 */
	getActiveCwd: () => string;
	/**
	 * 服务端语言（issue #91）：单字段错误通道（抛错 message 插值）经 pick
	 * 按此选中文/英文；推 UI 的 notice 已是 text+textEn 双字段，不用它。
	 * 缺省英文。agent-service 接线 () => this.getLang()。
	 */
	getLang?: () => ServerLang;
}

export class FilesService {
	constructor(private readonly host: FilesHost) {}

	/** 机器根列目录（此电脑/盘符列表）；posix 上就是根 "/"。 */
	private async machineRootEntries(): Promise<FileEntry[]> {
		const fsp = await import("node:fs/promises");
		if (IS_WIN32) {
			const out: FileEntry[] = [];
			for (let c = 65; c <= 90; c++) {
				const drive = `${String.fromCharCode(c)}:`;
				try {
					const st = await fsp.stat(`${drive}\\`);
					if (st.isDirectory()) out.push({ name: drive, path: drive, type: "dir" });
				} catch {
					// 空口/未挂载盘符 —— 跳过
				}
			}
			return out;
		}
		// Android/Termux: "/" itself is not listable (even `ls /` is denied),
		// so fall back to $HOME + shared storage as the machine-root landing
		// spots — otherwise machine browsing is a dead end on Android.
		try {
			await fsp.readdir("/");
		} catch {
			const home = homedir();
			const out: FileEntry[] = [{ name: home, path: home, type: "dir" }];
			try {
				await fsp.readdir("/storage/emulated/0");
				out.push({ name: "/storage/emulated/0", path: "/storage/emulated/0", type: "dir" });
			} catch {
				// no shared storage
			}
			return out;
		}
		return [{ name: "/", path: "/", type: "dir" }];
	}

	/** 单字段错误文本的语言（host 未接线时英文默认）。 */
	private lang(): ServerLang {
		return this.host.getLang?.() ?? "en";
	}

	/**
	 * Global search: recursive filename match across the active workspace.
	 * Best-effort bounded walk — ignored dirs (node_modules/.git/…) are
	 * skipped, unreadable dirs silently passed, and hard caps on results /
	 * visited entries / elapsed time keep big repos responsive. Always answers
	 * with a search_files_result echoing reqId so the client's request never
	 * stalls (ok:false on unexpected failure).
	 */
	async searchFiles(query: string, reqId: number): Promise<void> {
		const activeCwd = this.host.getActiveCwd();
		if (isRemoteWorkspaceUri(activeCwd)) {
			await this.searchRemoteFiles(activeCwd, query, reqId);
			return;
		}
		const { join } = await import("node:path");
		const fsp = await import("node:fs/promises");
		const q = query.trim().toLowerCase();
		if (!q) {
			this.host.emit({ type: "search_files_result", reqId, ok: true, results: [] });
			return;
		}
		const root = resolve(activeCwd);
		const ignored = ignoredEntries();
		const MAX_RESULTS = 50;
		const MAX_VISITED = 20000;
		const MAX_MS = 4000;
		const start = Date.now();
		const results: FileSearchResult[] = [];
		let visited = 0;
		let truncated = false;
		const budgetLeft = () => results.length < MAX_RESULTS && visited < MAX_VISITED && Date.now() - start < MAX_MS;
		// Breadth-first-ish iterative stack; depth cap is a symlink-cycle guard.
		const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
			if (!budgetLeft() || depth > 24) {
				truncated = true;
				return;
			}
			let dirents: import("node:fs").Dirent[];
			try {
				dirents = await fsp.readdir(abs, { withFileTypes: true });
			} catch {
				return; // unreadable dir (ACL/permissions) — skip silently
			}
			for (const d of dirents) {
				visited++;
				if (!budgetLeft()) {
					truncated = true;
					break;
				}
				if (ignored.has(d.name)) continue;
				const childRel = rel ? `${rel}/${d.name}` : d.name;
				let isDir = d.isDirectory();
				if (d.isSymbolicLink()) {
					// Follow directory symlinks (Termux's ~/storage/*); the depth
					// cap doubles as a symlink-cycle guard, budgets bound the cost.
					try {
						isDir = (await fsp.stat(join(abs, d.name))).isDirectory();
					} catch {
						isDir = false; // broken link — treat as file
					}
				}
				if (d.name.toLowerCase().includes(q)) {
					results.push({
						path: childRel,
						name: d.name,
						type: isDir ? "dir" : "file",
					});
				}
				if (isDir) {
					await walk(join(abs, d.name), childRel, depth + 1);
				}
			}
		};
		try {
			await walk(root, "", 0);
			this.host.emit({
				type: "search_files_result",
				reqId,
				ok: true,
				results,
				...(truncated ? { truncated: true } : {}),
			});
		} catch {
			this.host.emit({ type: "search_files_result", reqId, ok: false, results: [] });
		}
	}

	/** Read a workspace file for the preview panel (size-capped, binary-safe). */
	async readFile(relPath: string): Promise<void> {
		const root = this.host.getCwd();
		if (isRemoteWorkspaceUri(root)) {
			await this.readRemoteFile(root, relPath);
			return;
		}
		try {
			const fs = await import("node:fs/promises");
			const absWire = isAbsoluteWirePath(relPath);
			let abs: string;
			let rel: string;
			if (absWire) {
				// 机器浏览：绝对路径直接读；回显用绝对 wire 形式（前端按 path 匹配）。
				abs = wireToAbs(relPath);
				rel = abs.split(sep).join("/");
			} else {
				const w = workspacePath(resolve(root), relPath);
				if (!w) {
					this.host.emit({
						type: "notice",
						level: "warning",
						text: `路径超出工作区：${relPath}`,
						textEn: `Path is outside the workspace: ${relPath}`,
					});
					return;
				}
				abs = w.abs;
				rel = w.rel;
			}
			const stat = await fs.stat(abs);
			if (!stat.isFile()) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `不是文件：${relPath}`,
					textEn: `Not a file: ${relPath}`,
				});
				return;
			}
			const name = relPath.split(/[\\/]/).pop() ?? relPath;
			// Office 文档（docx/xlsx/xlsm）：转 Markdown 文本下发，前端按 Markdown
			// 渲染表格/段落——文件树、附件、预览弹窗随处可看。失败回落到底下旧分支。
			if (isOfficeFile(name) && stat.size <= OFFICE_MAX_FILE_BYTES) {
				try {
					const data = await fs.readFile(abs);
					const office = extractOfficeText(name, data);
					if (office) {
						this.host.emit({
							type: "file_content",
							path: rel,
							name,
							text: office.text,
							truncated: office.truncated || data.length < stat.size,
							binary: false,
							kind: "text",
							lines: countLines(Buffer.from(office.text)),
							size: stat.size,
							slides: office.slides,
						});
						return;
					}
				} catch {
					/* 解析失败（加密/损坏/非预期结构）→ 回落旧的二进制嗅探分支 */
				}
			}
			const kind = previewKind(name);
			// Media previews stream over the /api/file HTTP endpoint, so only
			// metadata is sent here — the raw bytes never touch the socket.
			if (kind === "image" || kind === "video" || kind === "audio") {
				this.host.emit({
					type: "file_content",
					path: rel,
					name,
					text: "",
					truncated: false,
					binary: true,
					kind,
					lines: 0,
					size: stat.size,
				});
				return;
			}
			// Everything else: read a capped prefix and sniff the content.
			// Anything that looks like text previews as text regardless of its
			// extension (jsonl, .log.1, weird suffixes, …); binary content gets
			// a hex dump of the first few KB instead of being refused.
			const handle = await fs.open(abs, "r");
			try {
				const buf = Buffer.alloc(Math.min(stat.size, MAX_PREVIEW_BYTES));
				const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
				const data = buf.subarray(0, bytesRead);
				if (looksLikeText(data)) {
					this.host.emit({
						type: "file_content",
						path: rel,
						name,
						text: decodeText(data),
						truncated: bytesRead < stat.size,
						binary: false,
						kind: "text",
						lines: countLines(data),
						size: stat.size,
					});
				} else {
					this.host.emit({
						type: "file_content",
						path: rel,
						name,
						text: hexDump(data),
						truncated: bytesRead < stat.size,
						binary: true,
						kind: kind === "text" ? "text" : "none",
						lines: 0,
						size: stat.size,
					});
				}
			} finally {
				await handle.close();
			}
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `读取文件失败：${(err as Error).message}`,
				textEn: `Failed to read file: ${(err as Error).message}`,
			});
		}
	}

	/** Save text from the file preview panel within the active workspace. */
	async writeFile(relPath: string, text: string): Promise<void> {
		const root = this.host.getCwd();
		if (isRemoteWorkspaceUri(root)) {
			await this.writeRemoteFile(root, relPath, text);
			return;
		}
		try {
			const absWire = isAbsoluteWirePath(relPath);
			let abs: string;
			let rel: string;
			if (absWire) {
				abs = wireToAbs(relPath);
				rel = abs.split(sep).join("/");
			} else {
				const w = workspacePath(resolve(root), relPath);
				if (!w) {
					this.host.emit({
						type: "notice",
						level: "warning",
						text: `路径超出工作区：${relPath}`,
						textEn: `Path is outside the workspace: ${relPath}`,
					});
					return;
				}
				abs = w.abs;
				rel = w.rel;
			}
			if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: "文件内容过大，无法保存（上限 2MB）",
					textEn: "File too large to save (2MB max)",
				});
				return;
			}
			const stat = statSync(abs);
			if (!stat.isFile()) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `不是文件：${relPath}`,
					textEn: `Not a file: ${relPath}`,
				});
				return;
			}
			writeFileSync(abs, text, "utf8");
			this.host.emit({
				type: "notice",
				level: "info",
				text: `已保存：${rel}`,
				textEn: `Saved: ${rel}`,
			});
			// Re-read through the same path as the preview request so the client
			// gets the canonical content, line count and file size after saving.
			await this.readFile(rel);
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `保存文件失败：${(err as Error).message}`,
				textEn: `Failed to save file: ${(err as Error).message}`,
			});
		}
	}

	/**
	 * Create a folder. Accepts absolute, ~-prefixed or session-relative paths
	 * (same expansion rules as completePath — the cwd picker may browse outside
	 * the session root, and set_cwd itself accepts any directory). Answers
	 * with a notice; the picker refreshes its listing on its own.
	 */
	async makeDir(input: string): Promise<string | null> {
		const rawCwd = this.host.getCwd();
		if (isRemoteWorkspaceUri(rawCwd) || isRemoteWorkspaceUri(input)) {
			try {
				const sshSvc = getGlobalRemoteSshService();
				if (!sshSvc) throw new Error("Remote SSH service not initialized");
				const uri = isRemoteWorkspaceUri(input) ? input.trim() : rawCwd;
				const parsed = parseRemoteWorkspaceUri(uri);
				if (!parsed) throw new Error("Invalid remote workspace URI");
				const targetAbs = isRemoteWorkspaceUri(input)
					? parsed.remotePath
					: input.trim().startsWith("/")
						? posix.normalize(input.trim())
						: posix.resolve(parsed.remotePath, input.trim());
				await sshSvc.sftpMkdirRecursive(uri, targetAbs);
				this.host.emit({
					type: "notice",
					level: "info",
					text: `已创建远程文件夹：${targetAbs}`,
					textEn: `Remote folder created: ${targetAbs}`,
				});
				return isRemoteWorkspaceUri(input) ? uri : targetAbs;
			} catch (err) {
				this.host.emit({
					type: "notice",
					level: "error",
					text: `创建远程文件夹失败：${(err as Error).message}`,
					textEn: `Failed to create remote folder: ${(err as Error).message}`,
				});
				return null;
			}
		}
		try {
			const fs = await import("node:fs/promises");
			const { resolve, sep, isAbsolute } = await import("node:path");
			const { homedir } = await import("node:os");
			const home = homedir();
			let expanded = input.trim();
			if (!expanded) throw new Error(pick(this.lang(), "路径为空", "Empty path", "files.path.empty"));
			if (expanded === "~" || expanded === "~\\") {
				expanded = home;
			} else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
				expanded = home + sep + expanded.slice(2);
			} else if (!isAbsolute(expanded)) {
				expanded = resolve(this.host.getCwd(), expanded);
			}
			const abs = resolve(expanded);
			await fs.mkdir(abs, { recursive: true });
			this.host.emit({
				type: "notice",
				level: "info",
				text: `已创建文件夹：${abs}`,
				textEn: `Folder created: ${abs}`,
			});
			return abs;
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `创建文件夹失败：${(err as Error).message}`,
				textEn: `Failed to create folder: ${(err as Error).message}`,
			});
			return null;
		}
	}

	/* ---- 系统原生打开 / 定位（issue #187，见 protocol.ts file_reveal / file_open_default） ---- */

	/** reveal / openDefault 共用的路径解析：绝对 wire（机器浏览）直接转原生绝对路径；
	 *  相对路径限定在工作区内（越界 → null，与 readFile/writeFile 同口径）。
	 *  空串（工作区根须由调用方特判）与机器根 "@root" 本身不可作为操作对象 → null。 */
	private resolveOpTarget(raw: string): { abs: string } | null {
		const wire = normWirePath(raw.trim());
		if (!wire || wire === MACHINE_ROOT) return null;
		if (isAbsoluteWirePath(wire)) return { abs: wireToAbs(wire) };
		const w = workspacePath(resolve(this.host.getCwd()), wire);
		return w ? { abs: w.abs } : null;
	}

	/** 系统原生打开/定位的公共执行体（issue #187）：cmd/args 已按平台组装好。
	 *  spawn 成功即算送达（explorer/open 都是 daemon 式返回，exit code 不可信）；
	 *  ENOENT（headless/无桌面）等失败一律 warning notice，绝不抛。 */
	private async spawnDetached(cmd: string, args: string[], okText: string, okTextEn: string): Promise<void> {
		const fail = (detail: string) =>
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "无法打开系统文件管理：" + detail + "（远端/无桌面主机不支持）",
				textEn: "Cannot open system file manager: " + detail + " (unsupported on remote/headless hosts)",
			});
		try {
			const { spawn } = await import("node:child_process");
			// ⚠ 这里绝不能加 windowsHide: true：它经 STARTF_USESHOWWINDOW + SW_HIDE 压住子进程首窗口，
			// explorer/open 起的是 GUI（无控制台可藏），加了之后进程在、窗口永远不出来
			// （2026-09 实测：notepad/explorer 同参数起，进程 session 1 正常、桌面无窗口；去掉即现）。
			const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
			if (typeof child.unref === "function") child.unref();
			const launched = await new Promise<boolean>((resolve) => {
				let done = false;
				const settle = (v: boolean) => {
					if (!done) {
						done = true;
						resolve(v);
					}
				};
				child.on("spawn", () => settle(true));
				child.on("error", () => settle(false));
				// 极端平台无 spawn 事件时兜底放行（进程已脱离，成败不再可知）。
				setTimeout(() => settle(true), 3000);
			});
			if (!launched) {
				fail(cmd);
				return;
			}
			this.host.emit({ type: "notice", level: "info", text: okText, textEn: okTextEn });
		} catch (e) {
			fail((e as Error).message);
		}
	}

	/** 在系统资源管理器中定位（issue #187）：文件→打开目录并选中该文件，目录→直接打开。
	 *  只读操作（不改文件），保护根/盘符根也允许；@root 本体与越界路径拒绝。 */
	async revealEntry(path: string): Promise<void> {
		const err = (text: string, textEn?: string) => this.host.emit({ type: "notice", level: "warning", text, textEn });
		try {
			const fsp = await import("node:fs/promises");
			const { dirname } = await import("node:path");
			const trimmed = path.trim();
			const t = !trimmed ? { abs: resolve(this.host.getCwd()) } : this.resolveOpTarget(trimmed);
			if (!t) {
				err("此处不可定位：" + path, "Cannot reveal here: " + path);
				return;
			}
			const abs = t.abs;
			const st = await fsp.stat(abs).catch(() => null);
			if (!st) {
				err("文件不存在：" + path, "Not found: " + path);
				return;
			}
			const isDir = st.isDirectory();
			const segs = trimmed.split("/");
			const base = !trimmed ? t.abs.split(/[\\/]/).pop() || t.abs : (segs[segs.length - 1] ?? trimmed);
			if (process.platform === "win32") {
				// /select, 与路径分两个 argv 传（explorer 对此格式稳定支持，路径含空格也无碍）。
				// 目录传 /n, 强制打开新窗口，防止若该目录已在后台打开时被 Windows 静默复用且因反抢焦点机制不置顶。
				await this.spawnDetached(
					"explorer.exe",
					isDir ? ["/n,", abs] : ["/select,", abs],
					"已在资源管理器中显示：" + base,
					"Revealed in File Explorer: " + base,
				);
			} else if (process.platform === "darwin") {
				await this.spawnDetached(
					"open",
					isDir ? [abs] : ["-R", abs],
					"已在访达中显示：" + base,
					"Revealed in Finder: " + base,
				);
			} else {
				// Linux 无统一选中语义：打开其父目录（目录则打开自身）。
				await this.spawnDetached(
					"xdg-open",
					[isDir ? abs : dirname(abs)],
					"已打开所在目录：" + base,
					"Opened containing folder: " + base,
				);
			}
		} catch (e) {
			err("定位失败：" + (e as Error).message, "Reveal failed: " + (e as Error).message);
		}
	}

	/** 用系统默认应用打开文件（issue #187）：仅文件；目录请用 reveal。 */
	async openDefaultEntry(path: string): Promise<void> {
		const err = (text: string, textEn?: string) => this.host.emit({ type: "notice", level: "warning", text, textEn });
		try {
			const fsp = await import("node:fs/promises");
			const t = this.resolveOpTarget(path);
			if (!t) {
				err("此处不可打开：" + path, "Cannot open here: " + path);
				return;
			}
			const st = await fsp.stat(t.abs).catch(() => null);
			if (!st) {
				err("文件不存在：" + path, "Not found: " + path);
				return;
			}
			if (!st.isFile()) {
				err("请选择文件（目录请用“在资源管理器中显示”）", 'Please select a file (use "Reveal" for folders)');
				return;
			}
			const segs = path.split("/");
			const base = segs[segs.length - 1] ?? path;
			// explorer 直接跟路径即走默认关联打开（含空格路径单 argv，无拆分问题）。
			const cmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
			await this.spawnDetached(cmd, [t.abs], "已用默认应用打开：" + base, "Opened with default app: " + base);
		} catch (e) {
			err("打开失败：" + (e as Error).message, "Open failed: " + (e as Error).message);
		}
	}

	/**
	 * Path completion for the cwd input: expand ~/relative paths, list the parent
	 * directory, and return prefix matches (dirs first, capped).
	 */
	async completePath(input: string): Promise<void> {
		const empty = () => this.host.emit({ type: "path_completions", completions: [] });
		const cwd = this.host.getCwd();
		if (isRemoteWorkspaceUri(input) || (isRemoteWorkspaceUri(cwd) && !isAbsoluteWirePath(input.trim()))) {
			await this.completeRemotePath(isRemoteWorkspaceUri(input) ? input.trim() : cwd, input.trim());
			return;
		}
		try {
			const fs = await import("node:fs/promises");
			const { resolve, sep, isAbsolute } = await import("node:path");
			const { homedir } = await import("node:os");
			const home = homedir();
			const isWin = IS_WIN32;
			const rawInput = input.trim();
			if (rawInput === "") {
				empty();
				return;
			}

			// ---- 机器根（此电脑/盘符列表）----
			if (rawInput === MACHINE_ROOT || rawInput === MACHINE_ROOT + "/") {
				this.host.emit({ type: "path_completions", completions: await this.machineRootEntries() });
				return;
			}

			// ---- Windows 盘符输入："D"（补全到盘符，Tab 即换盘）/ "D:"（列盘根）----
			if (isWin && /^[A-Za-z]:?$/.test(rawInput)) {
				const letter = rawInput[0].toUpperCase();
				const drive = `${letter}:`;
				let st: { isDirectory(): boolean };
				try {
					st = await fs.stat(`${drive}\\`);
				} catch {
					empty();
					return;
				}
				if (!st.isDirectory()) {
					empty();
					return;
				}
				if (rawInput.length === 2) {
					// 已带冒号：直接列出盘根条目。
					const dirents = await fs.readdir(`${drive}\\`, { withFileTypes: true }).catch(() => null);
					if (!dirents) {
						empty();
						return;
					}
					const items = (
						await Promise.all(
							dirents.filter((d) => !ignoredEntries().has(d.name)).map((d) => classifyDirent(d, `${drive}\\`)),
						)
					)
						.map((e) => ({ ...e, path: `${drive}/${e.name}` }))
						.sort((a, b) => {
							const aHidden = a.name.startsWith(".");
							const bHidden = b.name.startsWith(".");
							if (aHidden !== bHidden) return aHidden ? 1 : -1;
							if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
							return a.name.localeCompare(b.name);
						})
						.slice(0, 100);
					this.host.emit({ type: "path_completions", completions: items });
					return;
				}
				// 只有字母：补全到盘符本身。
				this.host.emit({ type: "path_completions", completions: [{ name: drive, path: drive, type: "dir" }] });
				return;
			}

			// Expand ~ and relative inputs to an absolute path. Windows users type
			// backslashes (P:\agent) and ~\ — handle both separator styles.
			let expanded = rawInput;
			if (expanded === "~" || expanded === "~\\") {
				expanded = home;
			} else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
				expanded = home + sep + expanded.slice(2);
			} else if (!isAbsolute(expanded)) {
				expanded = resolve(cwd, expanded);
			}

			// Split into parent dir + prefix on the LAST separator of either style
			// (Windows accepts both / and \, so P:\agent/de must work too).
			const lastSlash = Math.max(expanded.lastIndexOf("/"), expanded.lastIndexOf("\\"));
			const dirPart = lastSlash >= 0 ? expanded.slice(0, lastSlash + 1) : "";
			const prefix = lastSlash >= 0 ? expanded.slice(lastSlash + 1) : expanded;

			const dirents = await fs.readdir(dirPart, { withFileTypes: true }).catch(() => null);
			if (!dirents) {
				empty();
				return;
			}
			const { join } = await import("node:path");
			const completions = (
				await Promise.all(
					dirents
						.filter((d) => d.name.startsWith(prefix) && !ignoredEntries().has(d.name))
						.map((d) => classifyDirent(d, dirPart)),
				)
			)
				.map((e) => ({
					...e,
					// Windows users type backslashes — normalize the completion to the
					// wire format ("/") so the picked path round-trips cleanly.
					path: IS_WIN32 ? join(dirPart, e.name).split(sep).join("/") : dirPart + e.name,
				}))
				.sort((a, b) => {
					const aHidden = a.name.startsWith(".");
					const bHidden = b.name.startsWith(".");
					if (aHidden !== bHidden) return aHidden ? 1 : -1;
					if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
					return a.name.localeCompare(b.name);
				})
				.slice(0, 100);
			this.host.emit({ type: "path_completions", completions });
		} catch {
			empty();
		}
	}

	// =========================================================================
	// 远程 SSH 工作区 (ssh://...) 专属文件操作实现
	// =========================================================================

	private resolveRemoteTarget(
		rawCwd: string,
		p: string,
		allowRoot: boolean = false,
	): { abs: string; rel: string; parentRel: string; absolute: boolean } | null {
		const parsed = parseRemoteWorkspaceUri(rawCwd);
		if (!parsed) return null;
		let trimmed = (p || "").trim();
		if (trimmed === MACHINE_ROOT || trimmed === MACHINE_ROOT + "/") return null;
		if (isRemoteWorkspaceUri(trimmed)) {
			const parsedUri = parseRemoteWorkspaceUri(trimmed);
			if (parsedUri) {
				trimmed = parsedUri.remotePath;
			}
		}
		if (!trimmed || trimmed === ".") {
			if (!allowRoot) return null;
			return { abs: parsed.remotePath, rel: "", parentRel: "", absolute: false };
		}
		if (trimmed.startsWith("/")) {
			const abs = posix.normalize(trimmed);
			if (abs === "/" && !allowRoot) return null;
			const parentRel = abs === "/" ? "" : posix.dirname(abs);
			return { abs, rel: abs, parentRel, absolute: true };
		}
		const w = resolveRemoteWorkspacePath(parsed.remotePath, trimmed);
		if (!w || (!allowRoot && w.rel === "")) return null;
		const parentRel = w.rel.includes("/") ? w.rel.slice(0, w.rel.lastIndexOf("/")) : "";
		return { abs: w.abs, rel: w.rel, parentRel, absolute: false };
	}

	private async searchRemoteFiles(rawCwd: string, query: string, reqId: number): Promise<void> {
		const q = query.trim().toLowerCase();
		if (!q) {
			this.host.emit({ type: "search_files_result", reqId, ok: true, results: [] });
			return;
		}
		const sshSvc = getGlobalRemoteSshService();
		if (!sshSvc) {
			this.host.emit({ type: "search_files_result", reqId, ok: false, results: [] });
			return;
		}
		try {
			const cmd = `find . -maxdepth 8 \\( -name node_modules -o -name .git -o -name .pi-web \\) -prune -o -print 2>/dev/null | head -n 5000`;
			const res = await sshSvc.execInWorkspace(rawCwd, cmd, { timeoutMs: 8000 });
			const lines = res.stdout.split(/\r?\n/);
			const results: FileSearchResult[] = [];
			let truncated = false;
			for (const line of lines) {
				const clean = line.trim().replace(/^\.\//, "");
				if (!clean || clean === ".") continue;
				const name = posix.basename(clean);
				if (name.toLowerCase().includes(q)) {
					results.push({
						path: clean,
						name,
						type: "file",
					});
					if (results.length >= 50) {
						truncated = true;
						break;
					}
				}
			}
			this.host.emit({
				type: "search_files_result",
				reqId,
				ok: true,
				results,
				...(truncated ? { truncated: true } : {}),
			});
		} catch {
			this.host.emit({ type: "search_files_result", reqId, ok: false, results: [] });
		}
	}

	private async readRemoteFile(rawCwd: string, relPath: string): Promise<void> {
		try {
			const sshSvc = getGlobalRemoteSshService();
			if (!sshSvc) throw new Error("Remote SSH service not initialized");
			const t = this.resolveRemoteTarget(rawCwd, relPath);
			if (!t) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `路径超出工作区：${relPath}`,
					textEn: `Path is outside the workspace: ${relPath}`,
				});
				return;
			}
			const st = await sshSvc.sftpStat(rawCwd, t.abs);
			if (!st.isFile) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `不是文件：${relPath}`,
					textEn: `Not a file: ${relPath}`,
				});
				return;
			}
			const name = posix.basename(t.abs) || relPath;
			if (isOfficeFile(name) && st.size <= OFFICE_MAX_FILE_BYTES) {
				try {
					const { data } = await sshSvc.sftpReadFile(rawCwd, t.abs, OFFICE_MAX_FILE_BYTES);
					const office = extractOfficeText(name, data);
					if (office) {
						this.host.emit({
							type: "file_content",
							path: t.rel,
							name,
							text: office.text,
							truncated: office.truncated || data.length < st.size,
							binary: false,
							kind: "text",
							lines: countLines(Buffer.from(office.text)),
							size: st.size,
							slides: office.slides,
						});
						return;
					}
				} catch {}
			}
			const kind = previewKind(name);
			if (kind === "image" || kind === "video" || kind === "audio") {
				this.host.emit({
					type: "file_content",
					path: t.rel,
					name,
					text: "",
					truncated: false,
					binary: true,
					kind,
					lines: 0,
					size: st.size,
				});
				return;
			}
			const { data, size } = await sshSvc.sftpReadFile(rawCwd, t.abs, MAX_PREVIEW_BYTES);
			if (looksLikeText(data)) {
				this.host.emit({
					type: "file_content",
					path: t.rel,
					name,
					text: decodeText(data),
					truncated: data.length < size,
					binary: false,
					kind: "text",
					lines: countLines(data),
					size,
				});
			} else {
				this.host.emit({
					type: "file_content",
					path: t.rel,
					name,
					text: hexDump(data),
					truncated: data.length < size,
					binary: true,
					kind: kind === "text" ? "text" : "none",
					lines: 0,
					size,
				});
			}
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `读取远程文件失败：${(err as Error).message}`,
				textEn: `Failed to read remote file: ${(err as Error).message}`,
			});
		}
	}

	private async writeRemoteFile(rawCwd: string, relPath: string, text: string): Promise<void> {
		try {
			const sshSvc = getGlobalRemoteSshService();
			if (!sshSvc) throw new Error("Remote SSH service not initialized");
			const t = this.resolveRemoteTarget(rawCwd, relPath);
			if (!t) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `路径超出工作区：${relPath}`,
					textEn: `Path is outside the workspace: ${relPath}`,
				});
				return;
			}
			if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: "文件内容过大，无法保存（上限 2MB）",
					textEn: "File too large to save (2MB max)",
				});
				return;
			}
			await sshSvc.sftpWriteFile(rawCwd, t.abs, text);
			this.host.emit({
				type: "notice",
				level: "info",
				text: `已保存：${t.rel}`,
				textEn: `Saved: ${t.rel}`,
			});
			await this.readRemoteFile(rawCwd, t.rel);
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `保存远程文件失败：${(err as Error).message}`,
				textEn: `Failed to save remote file: ${(err as Error).message}`,
			});
		}
	}

	private async completeRemotePath(rawCwd: string, rawInput: string): Promise<void> {
		const empty = () => this.host.emit({ type: "path_completions", completions: [] });
		try {
			const sshSvc = getGlobalRemoteSshService();
			const parsed = parseRemoteWorkspaceUri(rawCwd);
			if (!sshSvc || !parsed) {
				empty();
				return;
			}
			let targetPath = rawInput;
			if (isRemoteWorkspaceUri(rawInput)) {
				const p = parseRemoteWorkspaceUri(rawInput);
				targetPath = p ? p.remotePath + (rawInput.endsWith("/") ? "/" : "") : "/";
			} else if (!targetPath.startsWith("/")) {
				targetPath = posix.resolve(parsed.remotePath, targetPath);
			}
			const lastSlash = targetPath.lastIndexOf("/");
			const dirPart = lastSlash >= 0 ? targetPath.slice(0, lastSlash + 1) || "/" : "/";
			const prefix = lastSlash >= 0 ? targetPath.slice(lastSlash + 1) : targetPath;
			const entries = await sshSvc.sftpReaddir(rawCwd, dirPart).catch(() => null);
			if (!entries) {
				empty();
				return;
			}
			const completions = entries
				.filter((d: { name: string }) => d.name.startsWith(prefix))
				.map((e: { name: string; type: string }) => ({
					name: e.name,
					type: e.type,
					path: dirPart === "/" ? `/${e.name}` : `${dirPart.replace(/\/+$/, "")}/${e.name}`,
				}))
				.sort((a: { type: string; name: string }, b: { type: string; name: string }) => {
					if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
					return a.name.localeCompare(b.name);
				})
				.slice(0, 100);
			this.host.emit({ type: "path_completions", completions });
		} catch {
			empty();
		}
	}
}
