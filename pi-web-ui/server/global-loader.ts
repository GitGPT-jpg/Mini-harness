/**
 * global-loader.ts — 通用全局环境动态解析与穿透加载器（Universal Global Package Loader）。
 *
 * 背景与架构意义：
 * 在 Node.js ESM 规范中，裸模块说明符（如 import("foo")）仅支持沿当前项目的祖先链
 * 回溯 node_modules，无法跨盘符或跨目录直接发现用户通过全局安装（npm i -g、pnpm add -g、
 * fnm、nvm、volta、bun 等）的包。
 *
 * 本模块作为宿主级基础服务，提供一站式的：
 * 1. 全版本管理器与包管理器全局目录自动嗅探（fnm / nvm / pnpm / volta / bun / npm）；
 * 2. 物理定位任意包根路径与包版本元数据（findPackageRoot / probeGlobalPackage）；
 * 3. 严格遵循 package.json 的 exports 条件导出规范解析入口文件；
 * 4. 基于 file:// URL 协议跨环境穿透动态导入 ESM 模块（dynamicImportGlobalPackage）。
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let cachedNpmRootG: string | null = null;
let cachedCandidateRoots: string[] | null = null;
const packageRootCache = new Map<string, string | null>();

/**
 * 安全且带缓存地获取系统 npm 全局 root 目录。
 */
export function getSystemNpmRootG(): string | null {
	if (cachedNpmRootG !== null) return cachedNpmRootG;

	try {
		const out = execSync("npm root -g", {
			timeout: 2500,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			shell: process.platform === "win32" ? "cmd.exe" : undefined,
			windowsHide: true,
		}).trim();
		if (out && existsSync(out)) {
			cachedNpmRootG = resolve(out);
			return cachedNpmRootG;
		}
	} catch {
		/* ignore */
	}

	cachedNpmRootG = null;
	return null;
}

/**
 * 全方位收集系统所有可能存放全局或本地包的 node_modules 候选根目录。
 * 覆盖：本地项目链、Node 邻近目录、fnm、nvm、pnpm、volta、yarn、bun、npm 全局 prefix 等。
 */
export function getCandidateNodeModulesRoots(options?: { refresh?: boolean }): string[] {
	if (!options?.refresh && cachedCandidateRoots !== null) {
		return cachedCandidateRoots;
	}

	const candidates = new Set<string>();

	// 1. 本包内部与向上的祖先链路 node_modules
	let cur = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 6; i++) {
		const nm = join(cur, "node_modules");
		if (existsSync(nm)) candidates.add(resolve(nm));
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}

	// 2. 当前工作区 process.cwd() 及其父目录链
	let cwdCur = process.cwd();
	for (let i = 0; i < 5; i++) {
		const nm = join(cwdCur, "node_modules");
		if (existsSync(nm)) candidates.add(resolve(nm));
		const parent = dirname(cwdCur);
		if (parent === cwdCur) break;
		cwdCur = parent;
	}

	// 3. 运行中 Node 解释器自身的邻近目录（process.execPath）
	try {
		const nodeDir = dirname(process.execPath);
		candidates.add(resolve(join(nodeDir, "node_modules")));
		candidates.add(resolve(join(nodeDir, "..", "node_modules")));
		candidates.add(resolve(join(nodeDir, "..", "lib", "node_modules")));
	} catch {
		/* ignore */
	}

	// 4. 环境变量 NODE_PATH 显式配置的目录
	if (process.env.NODE_PATH) {
		const parts = process.env.NODE_PATH.split(delimiter).filter(Boolean);
		for (const p of parts) {
			if (existsSync(p)) candidates.add(resolve(p));
		}
	}

	// 5. 显式探测系统级 npm root -g
	const npmGlobal = getSystemNpmRootG();
	if (npmGlobal) candidates.add(npmGlobal);

	const env = process.env;
	const home = env.HOME || env.USERPROFILE || homedir();

	// 6. 版本管理器：fnm 自动嗅探
	if (process.platform === "win32") {
		const localAppData = env.LOCALAPPDATA;
		if (localAppData) {
			const fnmMultishells = join(localAppData, "fnm_multishells");
			if (existsSync(fnmMultishells)) {
				try {
					const entries = readdirSync(fnmMultishells);
					for (const entry of entries) {
						const subNm = join(fnmMultishells, entry, "node_modules");
						if (existsSync(subNm)) candidates.add(resolve(subNm));
					}
				} catch {
					/* ignore */
				}
			}
		}
		if (env.APPDATA) {
			const fnmCurrent = join(env.APPDATA, "fnm", "current", "node_modules");
			if (existsSync(fnmCurrent)) candidates.add(resolve(fnmCurrent));
		}
	} else {
		const xdgData = env.XDG_DATA_HOME || join(home, ".local", "share");
		const fnmCurrent = join(xdgData, "fnm", "current", "lib", "node_modules");
		if (existsSync(fnmCurrent)) candidates.add(resolve(fnmCurrent));
	}

	// 7. 版本管理器：nvm 自动嗅探
	if (process.platform === "win32") {
		if (env.NVM_SYMLINK) {
			candidates.add(resolve(join(env.NVM_SYMLINK, "node_modules")));
		}
		if (env.NVM_HOME && existsSync(env.NVM_HOME)) {
			try {
				const nvmVersions = readdirSync(env.NVM_HOME);
				for (const v of nvmVersions) {
					const subNm = join(env.NVM_HOME, v, "node_modules");
					if (existsSync(subNm)) candidates.add(resolve(subNm));
				}
			} catch {
				/* ignore */
			}
		}
	} else {
		const nvmDir = env.NVM_DIR || join(home, ".nvm");
		const nvmVersionsDir = join(nvmDir, "versions", "node");
		if (existsSync(nvmVersionsDir)) {
			try {
				const versions = readdirSync(nvmVersionsDir);
				for (const v of versions) {
					const subNm = join(nvmVersionsDir, v, "lib", "node_modules");
					if (existsSync(subNm)) candidates.add(resolve(subNm));
				}
			} catch {
				/* ignore */
			}
		}
	}

	// 8. 包管理器：pnpm 全局目录嗅探
	if (env.PNPM_HOME) {
		candidates.add(resolve(join(env.PNPM_HOME, "node_modules")));
		candidates.add(resolve(join(env.PNPM_HOME, "global", "5", "node_modules")));
	}
	if (home) {
		const pnpmPosix = join(home, ".local", "share", "pnpm", "global", "5", "node_modules");
		if (existsSync(pnpmPosix)) candidates.add(resolve(pnpmPosix));
	}
	if (env.LOCALAPPDATA) {
		const pnpmWin = join(env.LOCALAPPDATA, "pnpm", "global", "5", "node_modules");
		if (existsSync(pnpmWin)) candidates.add(resolve(pnpmWin));
	}

	// 9. 包管理器：npm / yarn / volta / bun 标准系统全局目录
	const prefix = env.NPM_CONFIG_PREFIX || env.npm_config_prefix || env.PREFIX;
	if (prefix) {
		candidates.add(resolve(join(prefix, "lib", "node_modules")));
		candidates.add(resolve(join(prefix, "node_modules")));
	}

	if (env.APPDATA) {
		candidates.add(resolve(join(env.APPDATA, "npm", "node_modules")));
	}

	if (home) {
		candidates.add(resolve(join(home, ".npm-global", "lib", "node_modules")));
		candidates.add(resolve(join(home, ".npm-global", "node_modules")));
		candidates.add(resolve(join(home, ".volta", "tools", "image", "packages")));
		candidates.add(resolve(join(home, ".bun", "install", "global", "node_modules")));
	}

	if (process.platform !== "win32") {
		candidates.add(resolve("/usr/local/lib/node_modules"));
		candidates.add(resolve("/usr/lib/node_modules"));
	}

	cachedCandidateRoots = Array.from(candidates);
	return cachedCandidateRoots;
}

/**
 * 在所有候选路径中精准物理定位某个 npm 包的真实安装根目录。
 * 验证规则：目录存在且内部包含匹配的 package.json 文件。
 */
export function resolvePackageRoot(packageName: string, options?: { refresh?: boolean }): string | null {
	if (!options?.refresh && packageRootCache.has(packageName)) {
		const cached = packageRootCache.get(packageName);
		if (cached && existsSync(cached)) return cached;
	}

	const roots = getCandidateNodeModulesRoots(options);
	const subpathParts = packageName.split("/");

	for (const root of roots) {
		const candidateDir = join(root, ...subpathParts);
		const candidatePkgJson = join(candidateDir, "package.json");
		if (existsSync(candidatePkgJson)) {
			try {
				const info = JSON.parse(readFileSync(candidatePkgJson, "utf8")) as { name?: string };
				if (info.name === packageName) {
					const finalRoot = resolve(candidateDir);
					packageRootCache.set(packageName, finalRoot);
					return finalRoot;
				}
			} catch {
				/* ignore corrupt json */
			}
		}
	}

	packageRootCache.set(packageName, null);
	return null;
}

/**
 * 探测某个全局或本地包的安装就绪状态与版本信息。
 */
export function probeGlobalPackage(
	packageName: string,
	options?: { refresh?: boolean },
): {
	installed: boolean;
	version?: string;
	packagePath?: string;
} {
	const root = resolvePackageRoot(packageName, options);
	if (!root) {
		return { installed: false };
	}

	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			version?: string;
		};
		return {
			installed: true,
			version: pkg.version,
			packagePath: root,
		};
	} catch {
		return { installed: true, packagePath: root };
	}
}

/**
 * 依据目标包的 package.json 中的 exports/main/module 规范，
 * 将逻辑子路径解析为物理入口文件的绝对路径。
 */
export function resolvePackageEntryFile(packageName: string, subpath = ""): string | null {
	const root = resolvePackageRoot(packageName);
	if (!root) return null;

	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			exports?: Record<string, any>;
			main?: string;
			module?: string;
		};

		const exportKey = subpath ? `./${subpath}` : ".";
		let targetRel: string | undefined;

		if (pkg.exports && pkg.exports[exportKey]) {
			const exp = pkg.exports[exportKey];
			if (typeof exp === "string") {
				targetRel = exp;
			} else if (exp && typeof exp === "object") {
				targetRel = exp.import || exp.default || exp.node || exp.require;
			}
		} else if (!subpath) {
			targetRel = pkg.main || pkg.module;
		}

		// 默认回落入口推断
		if (!targetRel) {
			const fallbacks = [
				subpath ? `dist/${subpath}.js` : "dist/index.js",
				subpath ? `dist/${subpath}/index.js` : "index.js",
				subpath ? `${subpath}.js` : "index.js",
			];
			for (const fb of fallbacks) {
				const cand = join(root, fb);
				if (existsSync(cand)) {
					targetRel = fb;
					break;
				}
			}
		}

		if (targetRel) {
			const full = isAbsolute(targetRel) ? targetRel : resolve(root, targetRel);
			if (existsSync(full)) return full;
		}
	} catch {
		/* ignore */
	}

	return null;
}

/**
 * 终极通用动态穿透加载器：
 * 1. 优先尝试本地裸模块名说明符原生 import；
 * 2. 失败后穿透使用全局候选路径定位物理入口，并通过 file:// 协议动态导入。
 *
 * @param packageName 目标包名（如 "@earendil-works/pi-durable" 或 "@earendil-works/chord"）
 * @param subpath 子导出路径（如 "tools" 或 "storage/sqlite/node" 或 "context"）
 */
export async function dynamicImportGlobalPackage<T = any>(packageName: string, subpath = ""): Promise<T> {
	const specifier = subpath ? `${packageName}/${subpath}` : packageName;

	// 1. 优先尝试本地 Node.js ESM 规范解析
	try {
		const mod = await import(/* webpackIgnore: true */ specifier as string);
		if (mod) return mod as T;
	} catch {
		/* fall through to global physical loader */
	}

	// 2. 自动穿透全局候选目录定位入口
	const entryFile = resolvePackageEntryFile(packageName, subpath);
	if (!entryFile) {
		throw new Error(`无法加载模块 "${specifier}"：未在本地或全局环境找到匹配的包安装或有效入口文件。`);
	}

	const fileUrl = pathToFileURL(entryFile).href;
	return import(/* webpackIgnore: true */ fileUrl as string) as Promise<T>;
}
