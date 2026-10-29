/**
 * 插件更新辅助（备份/回滚 + 远端 sha 对比）——纯逻辑，供 CLI（bin/pi-web-ui.mjs）
 * 与单测共用。零网络依赖：远端 sha 经注入的 exec 获取（生产 = git ls-remote；
 * 测试 = fake exec 或本地 git 仓库路径，git ls-remote 支持本地仓库，完全离线）。
 *
 * 布局：
 *   <dataDir>/plugins/<id>/           安装本体（含 .pi-source.json + .pi-git-sha）
 *   <dataDir>/plugin-backups/<id>-<ts>/  覆盖安装前的旧版本快照（保留最近 N 份）
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { pick, type ServerLang } from "./i18n.js";
import { parseInstallSpec, manifestCandidateUrls } from "./plugin-install-spec.js";

const PLUGIN_ID_RE = /^[A-Za-z0-9_-]+$/;
/** 保留的备份份数（超出删除最旧的）。 */
export const BACKUP_KEEP = 3;

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 解析宿主随包根目录（优先环境变量 PI_WEB_PKG_ROOT，次之向上查找包含 package.json 的祖先目录）。
 */
export function resolveDefaultPkgRoot(): string | undefined {
	if (process.env.PI_WEB_PKG_ROOT && existsSync(process.env.PI_WEB_PKG_ROOT)) {
		return process.env.PI_WEB_PKG_ROOT;
	}
	const candidates = [resolve(here, ".."), resolve(here, "..", ".."), resolve(here, "..", "..", "..")];
	for (const c of candidates) {
		if (existsSync(join(c, "package.json"))) return c;
	}
	return undefined;
}

export type Exec = (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/** 默认执行器：execFile 直跑 git（不经 shell），15s 超时。 */
export const execGit: Exec = (cmd, args) =>
	new Promise((resolve) => {
		execFile(cmd, args, { timeout: 15_000, encoding: "utf8" }, (err, stdout, stderr) => {
			if (err) resolve({ ok: false, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
			else resolve({ ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});

/**
 * 覆盖安装前备份旧插件目录 → <dataDir>/plugin-backups/<id>-<ts>/。
 * 目标不存在/备份失败返回 null（调用方可继续——备份是尽力而为的保护）。
 */
export function ensureBackup(dataDir: string, id: string, opts?: { source?: string }): string | null {
	if (!PLUGIN_ID_RE.test(id)) return null;
	const target = join(dataDir, "plugins", id);
	if (!existsSync(target)) return null;
	const ts = stamp();
	const dest = join(dataDir, "plugin-backups", `${id}-${ts}`);
	try {
		mkdirSync(dirnameOf(dest)!, { recursive: true });
		cpSync(target, dest, {
			recursive: true,
			// 与安装一致：不备份 .git/node_modules/whisper-cache（纯运行/大体量模型缓存），config.json 等保留。
			filter: (s) => !/(^|[\\/])(\.git|node_modules|whisper-cache)([\\/]|$)/.test(s),
		});
		writeFileSync(join(dest, ".pi-backup.json"), JSON.stringify({ id, ts, source: opts?.source }, null, 2) + "\n");
		pruneBackups(dataDir, id);
		return ts;
	} catch (err) {
		try {
			rmSync(dest, { recursive: true, force: true });
		} catch {
			/* 清理失败忽略 */
		}
		console.warn(`[plugin-updater] 备份 ${id} 失败：`, err instanceof Error ? err.message : err);
		return null;
	}
}

/** 该插件的备份目录列表（按时间从新到旧）。 */
export function listBackups(dataDir: string, id: string): string[] {
	if (!PLUGIN_ID_RE.test(id)) return [];
	const dir = join(dataDir, "plugin-backups");
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const re = new RegExp(`^${id.replace(/[^A-Za-z0-9_-]/g, "")}-(\\d{8}-\\d{9})$`);
	return names
		.filter((n) => re.test(n) && existsSync(join(dir, n, ".pi-backup.json")))
		.sort()
		.reverse();
}

/**
 * 回滚到最近一份备份：删当前 plugins/<id> → 拷贝备份回 → 删备份。
 * 返回最近备份 ts；无备份返回 null。
 */
export function restoreBackup(dataDir: string, id: string): string | null {
	const backups = listBackups(dataDir, id);
	if (backups.length === 0) return null;
	const src = join(dataDir, "plugin-backups", backups[0]);
	const target = join(dataDir, "plugins", id);
	try {
		if (existsSync(target)) {
			const keepDirs = new Set(["node_modules", "whisper-cache"]);
			for (const entry of readdirSync(target)) {
				if (keepDirs.has(entry)) continue;
				rmSync(join(target, entry), { recursive: true, force: true });
			}
		}
		mkdirSync(target, { recursive: true });
		cpSync(src, target, { recursive: true });
		rmSync(src, { recursive: true, force: true });
		return backups[0];
	} catch (err) {
		console.warn(`[plugin-updater] 回滚 ${id} 失败：`, err instanceof Error ? err.message : err);
		return null;
	}
}

/** 保留最近 BACKUP_KEEP 份，删除更旧的。 */
export function pruneBackups(dataDir: string, id: string, keep = BACKUP_KEEP): void {
	const backups = listBackups(dataDir, id);
	for (const b of backups.slice(keep)) {
		try {
			rmSync(join(dataDir, "plugin-backups", b), { recursive: true, force: true });
		} catch {
			/* 忽略 */
		}
	}
}

/**
 * 解析一个安装源并取远端 HEAD sha（前 12 位）。
 *  - 本地 git 仓库路径 / file:// → git ls-remote <path> HEAD（离线）
 *  - GitHub owner/repo、URL → git ls-remote https://github.com/o/r.git HEAD
 *  - 无法识别 / git 不在 / 网络失败 → null（调用方标记「无法检查」）
 */
export async function resolveRemoteSha(spec: string, exec: Exec = execGit): Promise<string | null> {
	const clean = String(spec ?? "").trim();
	if (!clean) return null;
	let remote: string | null = null;
	if (existsSync(clean)) {
		remote = clean; // 本地 git 仓库路径
	} else if (/^file:\/\//i.test(clean)) {
		remote = clean.slice("file://".length);
	} else {
		// GitHub 形态（owner/repo、URL、git@）
		let s = clean.replace(/^git@([^:]+):/, "");
		const m = s.match(/^https?:\/\/(?:www\.)?github\.com\/(.+?)(?:\.git)?\/?$/i);
		if (m) [, s] = m;
		s = s.split("#")[0]; // 去掉 #分支
		const segs = s.split("/").filter(Boolean);
		if (segs.length < 2) return null;
		// 只取 owner/repo（/tree/<ref>/<subpath> 等后缀不影响远端 sha）
		const repo = segs[0] + "/" + segs[1].replace(/\.git$/, "");
		remote = `https://github.com/${repo}.git`;
	}
	if (!remote) return null;
	const res = await exec("git", ["ls-remote", remote, "HEAD"]);
	if (!res.ok) return null;
	// 行格式: <sha>\tHEAD（可能多行——取第一行）
	const sha = res.stdout.match(/^([0-9a-f]{40,64})\s+HEAD/m)?.[1] ?? null;
	return sha ? sha.slice(0, 12) : null;
}

export interface PluginUpdateInfo {
	id: string;
	name?: string;
	version?: string;
	latestVersion?: string | null;
	source: string;
	/** 本地安装时记录的 sha（.pi-git-sha）。 */
	localSha: string | null;
	/** 远端 HEAD sha（null = 无法检查：非 git 源 / git 不可用 / 网络失败）。 */
	remoteSha: string | null;
	/** localSha 与 remoteSha 都存在且不同，或远端版本号大于本地版本号。 */
	updatable: boolean;
	/** 是否为内置插件（在官方内置目录 plugins/catalog.json 中定义，或源指向官方仓库）。 */
	builtin?: boolean;
	error?: string;
}

export type PluginManifestFetcher = (
	url: string,
	init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;

export interface CheckPluginUpdatesOptions {
	/** 随包发布的内置插件市场清单路径（<pkgRoot>/plugins/catalog.json）。 */
	builtinCatalogPath?: string;
	/** 宿主包根目录（本地开发时直接对比 <pkgRoot>/plugins/<id> 的最新源码）。 */
	pkgRoot?: string;
	/** 远端 manifest 探测器（默认全局 fetch；单测可注入 fake 实现零网络）。 */
	fetcher?: PluginManifestFetcher;
}

/**
 * 语义化版本（SemVer）比较器：
 * - 剥离前缀 `v` / `V` 及首尾空白；
 * - 剥离 `+` 后的构建元数据（build metadata 在优先级比较中被忽略）；
 * - 分离主要数字版本与预发布标识（prerelease，如 -beta.1）；
 * - 支持任意段数的数字比对；
 * - 符合 SemVer 规范：正式版 > 预发布版（例如 1.0.0 > 1.0.0-beta.1）；
 * - 返回值：>0 代表 a 比 b 新；<0 代表 a 比 b 旧；0 代表版本一致。
 */
export function compareVersions(a: string, b: string): number {
	const clean = (s: string) =>
		String(s ?? "")
			.trim()
			.replace(/^[vV]/, "")
			.split("+")[0]
			.trim();

	const cleanA = clean(a);
	const cleanB = clean(b);
	if (cleanA === cleanB) return 0;
	if (!cleanA && !cleanB) return 0;
	if (!cleanA) return -1;
	if (!cleanB) return 1;

	// 拆分主版本段与 prerelease 段
	const dashA = cleanA.indexOf("-");
	const mainAStr = dashA >= 0 ? cleanA.slice(0, dashA) : cleanA;
	const preA = dashA >= 0 ? cleanA.slice(dashA + 1) : null;

	const dashB = cleanB.indexOf("-");
	const mainBStr = dashB >= 0 ? cleanB.slice(0, dashB) : cleanB;
	const preB = dashB >= 0 ? cleanB.slice(dashB + 1) : null;

	// 比较主版本数字段
	const segsA = mainAStr.split(".").map((n) => parseInt(n, 10) || 0);
	const segsB = mainBStr.split(".").map((n) => parseInt(n, 10) || 0);
	const maxLen = Math.max(segsA.length, segsB.length);

	for (let i = 0; i < maxLen; i++) {
		const x = segsA[i] ?? 0;
		const y = segsB[i] ?? 0;
		if (x !== y) return x - y;
	}

	// 主版本数字段全相同时，比较 prerelease（正式版高于任何 prerelease 版）
	if (preA === null && preB !== null) return 1;
	if (preA !== null && preB === null) return -1;
	if (preA !== null && preB !== null) {
		const partsA = preA.split(".");
		const partsB = preB.split(".");
		const maxPreLen = Math.max(partsA.length, partsB.length);
		for (let i = 0; i < maxPreLen; i++) {
			const pa = partsA[i];
			const pb = partsB[i];
			if (pa === undefined) return -1;
			if (pb === undefined) return 1;
			if (pa === pb) continue;
			const isNumA = /^\d+$/.test(pa);
			const isNumB = /^\d+$/.test(pb);
			if (isNumA && isNumB) {
				const diff = parseInt(pa, 10) - parseInt(pb, 10);
				if (diff !== 0) return diff;
			} else if (isNumA && !isNumB) {
				return -1; // 数字标识优先级低于非数字标识
			} else if (!isNumA && isNumB) {
				return 1;
			} else {
				return pa.localeCompare(pb);
			}
		}
	}

	return 0;
}

/** 判断某个插件是否属于随包维护的内置插件（官方插件）。 */
export function isBuiltinPlugin(id: string, source?: string, builtinCatalogPath?: string): boolean {
	if (source && /xing-shuyin\/pi-web-ui\/plugins\//i.test(source)) return true;
	const catPath =
		builtinCatalogPath ??
		(() => {
			const pkgRoot = resolveDefaultPkgRoot();
			return pkgRoot ? join(pkgRoot, "plugins", "catalog.json") : undefined;
		})();
	if (catPath && existsSync(catPath)) {
		try {
			const raw = JSON.parse(readFileSync(catPath, "utf8")) as unknown[];
			if (Array.isArray(raw)) {
				return raw.some((e) => (e as { id?: string })?.id === id);
			}
		} catch {
			/* ignore parse errors */
		}
	}
	return false;
}

/** 探测远端或本地源 manifest 中的版本号（本地路径 / raw.githubusercontent.com / 注入的 fetcher）。 */
async function fetchRemoteVersion(source: string, fetcher?: PluginManifestFetcher): Promise<string | null> {
	const spec = parseInstallSpec(source);
	if (spec.kind === "path" && spec.normalized) {
		const manifestFile = join(spec.normalized, "manifest.json");
		if (existsSync(manifestFile)) {
			try {
				const data = JSON.parse(readFileSync(manifestFile, "utf8")) as { version?: unknown };
				if (typeof data?.version === "string" && data.version.trim()) {
					return data.version.trim();
				}
			} catch {
				/* ignore */
			}
		}
	}
	const urls = manifestCandidateUrls(spec);
	if (urls.length === 0) return null;
	const fetchImpl = fetcher ?? (typeof fetch === "function" ? (fetch as unknown as PluginManifestFetcher) : null);
	if (!fetchImpl) return null;
	for (const url of urls) {
		try {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), 6000);
			const res = await fetchImpl(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
			if (!res.ok) continue;
			const data = (await res.json()) as { version?: unknown };
			if (typeof data?.version === "string" && data.version.trim()) {
				return data.version.trim();
			}
		} catch {
			// 单个 URL 失败继续尝试下一个候选
		}
	}
	return null;
}

/** 扫描全部已装插件，对比本地 sha/version 与远端 sha/version，报告更新状态。 */
export async function checkPluginUpdates(
	dataDir: string,
	exec: Exec = execGit,
	/** error 字段文案语言（默认英文）；调用方可传 () => getLang() 实现跟随。 */
	lang?: () => ServerLang,
	opts?: CheckPluginUpdatesOptions,
): Promise<PluginUpdateInfo[]> {
	const l = lang?.() ?? "en";
	const effectivePkgRoot = opts?.pkgRoot ?? resolveDefaultPkgRoot();
	const effectiveCatalogPath =
		opts?.builtinCatalogPath ?? (effectivePkgRoot ? join(effectivePkgRoot, "plugins", "catalog.json") : undefined);

	const pluginsDir = join(dataDir, "plugins");
	let names: string[] = [];
	try {
		names = readdirSync(pluginsDir).sort();
	} catch {
		return [];
	}
	const out: PluginUpdateInfo[] = [];
	for (const n of names) {
		if (!PLUGIN_ID_RE.test(n)) continue;
		const dir = join(pluginsDir, n);
		try {
			const sourceJson = readFileSync(join(dir, ".pi-source.json"), "utf8");
			const { source } = JSON.parse(sourceJson) as { source?: string };
			if (!source) continue; // 无来源记录（手工拷入）→ skip
			let localSha: string | null = null;
			try {
				localSha = readFileSync(join(dir, ".pi-git-sha"), "utf8").trim() || null;
			} catch {
				localSha = null; // 无 sha 记录
			}
			let name: string | undefined;
			let version: string | undefined;
			try {
				const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
					name?: string;
					version?: string;
				};
				name = m.name;
				if (typeof m.version === "string" && m.version.trim()) {
					version = m.version.trim();
				}
			} catch {
				/* 坏 manifest：仍报告 */
			}

			const parsedSpec = parseInstallSpec(source);
			const isSubpath = Boolean(parsedSpec.subpath);
			const builtin = isBuiltinPlugin(n, source, effectiveCatalogPath);
			let latestVersion: string | null = null;

			// 随包或本地开发模式：若宿主包自带 plugins/<id>/manifest.json，可直接读随包最新版本号
			if (effectivePkgRoot) {
				const localPkgManifest = join(effectivePkgRoot, "plugins", n, "manifest.json");
				if (existsSync(localPkgManifest)) {
					try {
						const rawPkg = JSON.parse(readFileSync(localPkgManifest, "utf8")) as { version?: string };
						if (typeof rawPkg?.version === "string" && rawPkg.version.trim()) {
							latestVersion = rawPkg.version.trim();
						}
					} catch {
						/* ignore */
					}
				}
			}

			// 尝试通过 fetcher 探测远端 manifest.json，若拿到了更高版本则采用更高者
			try {
				const remoteVer = await fetchRemoteVersion(source, opts?.fetcher);
				if (remoteVer) {
					if (!latestVersion || compareVersions(remoteVer, latestVersion) > 0) {
						latestVersion = remoteVer;
					}
				}
			} catch {
				/* ignore */
			}

			let remoteSha: string | null = null;
			let error: string | undefined;
			try {
				remoteSha = await resolveRemoteSha(source, exec);
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
				remoteSha = null;
			}

			let updatable = false;
			if (latestVersion && version) {
				// 两端都有版本号：版本号是唯一权威事实源。
				// 严格大于才判定为有更新（cmp > 0）。
				// 相同或更低（cmp <= 0）坚决判定为无更新，彻底避免主仓库无关 commit 触发的假阳性误报。
				updatable = compareVersions(latestVersion, version) > 0;
			} else if (latestVersion && !version) {
				// 远端有版本号但本地无版本号：视为可更新
				updatable = true;
			} else if (!isSubpath && remoteSha) {
				// 仅在未能获取最新版本号且为独立仓库源（非子目录）时，才回退到基于 git commit SHA 比对
				updatable = !localSha || localSha !== remoteSha;
			}

			if (!updatable && !latestVersion && !remoteSha && !error) {
				error = pick(
					l,
					"无法检查（非 git 源或 git 不可用）",
					"Cannot check (non-git source or git unavailable)",
					"pluginupdate.cannot.check",
				);
			} else if (!updatable && isSubpath && !latestVersion && !error) {
				// 子目录源插件未能获取远端清单时，不凭仓库根 SHA 误报，而是提示未能获取清单
				error = pick(
					l,
					"无法检查（未能获取远端插件清单）",
					"Cannot check (failed to fetch remote plugin manifest)",
					"pluginupdate.subpath.manifest.failed",
				);
			}

			out.push({
				id: n,
				name,
				version,
				latestVersion,
				source,
				localSha,
				remoteSha,
				updatable,
				builtin,
				error,
			});
		} catch {
			continue; // 坏目录跳过
		}
	}
	return out;
}

function stamp(): string {
	const d = new Date();
	const p = (x: number, n = 2) => String(x).padStart(n, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

function dirnameOf(p: string): string | null {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i >= 0 ? p.slice(0, i) : null;
}
