// Shared runtime-tree resolution for the pi-web-ui DSH runtime.
// Used by launcher.mjs (boot-time) and dev/dsh-probes/probe-mixed.mjs (self-check).
//
// A "runtime tree" is a node_modules root that directly contains the dsh
// runtime packages: `@deepseek-ai/dsh-base` (with its cordis.patch.yml
// bundle) and `@deepseek-ai/dsh-app-boot`. Two layouts are accepted:
//
//   flat:   <root>/@deepseek-ai/dsh-base/cordis.patch.yml
//           (a node_modules root where the runtime packages live top-level)
//
//   nested: <root>/@deepseek-ai/dsh/node_modules/@deepseek-ai/…
//           (`npm i -g @deepseek-ai/dsh` installs the CLI package with its
//           OWN nested runtime tree of ~196 packages; the global root itself
//           only holds the `dsh` package)
//
// The returned value is always the *bare-module base dir*: the node_modules
// root that directly contains the runtime packages. That is what
// boot(bareModuleBaseUrl) anchors bare package names (dsh-base rows) to.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 兜底固定的 DSH 版本族，与 package.json / lockfile 对齐 */
export const FALLBACK_DSH_VERSION = "0.2.1-rc.2";

/** Given a candidate node_modules root, return the bare-module base dir, or null. */
export function runtimeBaseFor(root) {
	if (root == null) return null;
	const flatScope = join(root, "@deepseek-ai");
	if (
		existsSync(join(flatScope, "dsh-base", "cordis.patch.yml")) &&
		existsSync(join(flatScope, "dsh-app-boot", "lib", "index.js"))
	) {
		return resolve(root);
	}
	const nestedScope = join(root, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai");
	if (
		existsSync(join(nestedScope, "dsh-base", "cordis.patch.yml")) &&
		existsSync(join(nestedScope, "dsh-app-boot", "lib", "index.js"))
	) {
		return resolve(join(root, "@deepseek-ai", "dsh", "node_modules"));
	}
	return null;
}

/** 向上查找 pi-web-ui 包根目录（支持源码态 server/ 与构建态 dist/） */
export function findLocalPackageRoot(startDir = HERE) {
	let cur = resolve(startDir);
	for (let i = 0; i < 6; i++) {
		const pkgPath = join(cur, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
				if (pkg.name === "pi-web-ui") return cur;
			} catch {}
		}
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return null;
}

/**
 * 提取 DSH 版本族。
 * 在 pre-release（0.x）阶段，按 major.minor 分族（如 0.1.x 同族，0.2.x 同族），
 * 既隔离 0.1 与 0.2 底层重大协议断裂，又避免 patch/rc 微调时过度阻断；正式版（>=1.0）按 major 分族。
 */
export function getDshFamily(version) {
	if (!version || typeof version !== "string") return "";
	const clean = version.replace(/^[v^~]/, "").trim();
	const m = clean.match(/^(\d+)\.(\d+)/);
	if (!m) return clean;
	const [, major, minor] = m;
	if (major === "0") {
		return `${major}.${minor}`;
	}
	return `${major}`;
}

/** 读取运行时树中已安装的 @deepseek-ai/dsh-base 版本 */
export function getRuntimeDshVersion(runtimeBase) {
	if (!runtimeBase) return null;
	const pkgPath = join(runtimeBase, "@deepseek-ai", "dsh-base", "package.json");
	if (existsSync(pkgPath)) {
		try {
			return JSON.parse(readFileSync(pkgPath, "utf8")).version || null;
		} catch {
			return null;
		}
	}
	return null;
}

/** 读取 pi-web-ui 本地期望绑定的 DSH 版本 */
export function getExpectedDshVersion(pkgRoot) {
	const root = pkgRoot || findLocalPackageRoot(HERE);
	if (root) {
		try {
			const p = join(root, "node_modules", "@deepseek-ai", "dsh-sdk-jsonrpc-server", "package.json");
			if (existsSync(p)) {
				const v = JSON.parse(readFileSync(p, "utf8")).version;
				if (v) return v;
			}
		} catch {}
		try {
			const p = join(root, "package.json");
			if (existsSync(p)) {
				const pkg = JSON.parse(readFileSync(p, "utf8"));
				const v = pkg.dependencies?.["@deepseek-ai/dsh-sdk-jsonrpc-server"];
				if (v) return v.replace(/^[v^~]/, "").trim();
			}
		} catch {}
	}
	return FALLBACK_DSH_VERSION;
}

/** 校验运行时树与 pi-web-ui 依赖的版本族兼容性 */
export function checkDshRuntimeCompatibility(runtimeBase, expectedVersion) {
	const runtimeVersion = getRuntimeDshVersion(runtimeBase);
	const expected = expectedVersion || getExpectedDshVersion();
	const runtimeFamily = getDshFamily(runtimeVersion);
	const expectedFamily = getDshFamily(expected);
	const compatible = Boolean(runtimeFamily && expectedFamily && runtimeFamily === expectedFamily);
	return {
		compatible,
		runtimeVersion,
		expectedVersion: expected,
		runtimeFamily,
		expectedFamily,
	};
}

/** 解析 .npmrc 内容中的 prefix 配置值 */
export function parseNpmrcPrefix(content) {
	if (!content || typeof content !== "string") return null;
	const lines = content.split(/\r?\n/);
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
		const m = trimmed.match(/^prefix\s*=\s*(.+)$/);
		if (m) {
			let val = m[1].trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1).trim();
			}
			if (val.startsWith("~")) {
				val = join(homedir(), val.slice(1));
			}
			return resolve(val);
		}
	}
	return null;
}

/** 从常见 npmrc 位置发现用户与系统配置的 prefix */
export function findPrefixFromNpmrc() {
	const prefixes = [];
	const npmrcLocations = [
		join(homedir(), ".npmrc"),
		process.env.PREFIX ? join(process.env.PREFIX, "etc", "npmrc") : null,
		process.platform === "win32"
			? process.env.APPDATA
				? join(process.env.APPDATA, "npm", "etc", "npmrc")
				: null
			: "/usr/local/etc/npmrc",
		process.platform === "win32"
			? process.env.ProgramFiles
				? join(process.env.ProgramFiles, "nodejs", "etc", "npmrc")
				: null
			: "/etc/npmrc",
		process.platform !== "win32" ? "/usr/etc/npmrc" : null,
	].filter(Boolean);

	for (const loc of npmrcLocations) {
		try {
			if (existsSync(loc)) {
				const content = readFileSync(loc, "utf8");
				const p = parseNpmrcPrefix(content);
				if (p && !prefixes.includes(p)) {
					prefixes.push(p);
				}
			}
		} catch {}
	}
	return prefixes;
}

/** 从 $PATH 中探测 dsh / pi-web-ui / npm 二进制并推导 node_modules 候选 */
export function findCandidatesFromPath() {
	const candidates = [];
	const rawPath = process.env.PATH || process.env.Path || "";
	if (!rawPath) return candidates;

	const binNames =
		process.platform === "win32"
			? [
					"dsh.cmd",
					"dsh.ps1",
					"dsh.exe",
					"dsh",
					"pi-web-ui.cmd",
					"pi-web-ui.ps1",
					"pi-web-ui.exe",
					"pi-web-ui",
					"npm.cmd",
					"npm.ps1",
					"npm.exe",
					"npm",
				]
			: ["dsh", "pi-web-ui", "npm"];

	const dirs = rawPath.split(delimiter).filter(Boolean);
	for (const dir of dirs) {
		let dirExists = false;
		try {
			dirExists = existsSync(dir);
		} catch {}
		if (!dirExists) continue;

		for (const bin of binNames) {
			const binPath = join(dir, bin);
			let binExists = false;
			try {
				binExists = existsSync(binPath);
			} catch {}
			if (!binExists) continue;

			// a) 符号链接真实路径反查 node_modules 根
			try {
				const real = realpathSync(binPath);
				const nmIdx = real.lastIndexOf("node_modules");
				if (nmIdx !== -1) {
					const nmRoot = real.slice(0, nmIdx + "node_modules".length);
					candidates.push({ path: nmRoot, source: `path:${bin} (symlink realpath)` });
				}
			} catch {}

			// b) Windows npm 全局安装常见布局：<prefix>/dsh.cmd，对应 <prefix>/node_modules
			candidates.push({ path: join(dir, "node_modules"), source: `path:${bin} (adjacent)` });
			candidates.push({ path: join(dir, "lib", "node_modules"), source: `path:${bin} (lib)` });

			// c) POSIX npm 全局安装常见布局：<prefix>/bin/dsh，对应 <prefix>/lib/node_modules
			const parent = dirname(dir);
			if (parent && parent !== dir) {
				candidates.push({ path: join(parent, "lib", "node_modules"), source: `path:${bin} (parent/lib)` });
				candidates.push({ path: join(parent, "node_modules"), source: `path:${bin} (parent)` });
			}
		}
	}
	return candidates;
}

/**
 * 完整运行时树探测与详情收集（纯 fs 操作，无子进程 spawn，杜绝 Android/Termux 死锁）。
 * 顺序：
 *   1. $PI_WEB_DSH_RUNTIME — 显式指定最高优先级
 *   2. 本包（pi-web-ui）的 node_modules
 *   3. execPath 邻近 node_modules
 *   4. 从 $PATH 二进制推断的全局目录（支持符号链接 realpath 反查）
 *   5. 从 .npmrc prefix 配置派生的全局目录
 *   6. 环境变量 NPM_CONFIG_PREFIX / npm_config_prefix / PREFIX
 *   7. 系统常见全局 node_modules 目录
 */
export async function resolveRuntimeBaseWithDetails() {
	const scannedPaths = [];
	const seenPaths = new Set();
	let firstFoundBase = null;
	let firstCompatibleBase = null;

	const expectedVersion = getExpectedDshVersion();

	const probe = (candidatePath, source) => {
		if (!candidatePath) return null;
		const norm = resolve(candidatePath);
		if (seenPaths.has(norm)) return null;
		seenPaths.add(norm);

		let exists = false;
		try {
			exists = existsSync(norm);
		} catch {}

		if (!exists) {
			scannedPaths.push({ path: norm, exists: false, validRuntime: false, source });
			return null;
		}

		const base = runtimeBaseFor(norm);
		if (!base) {
			scannedPaths.push({
				path: norm,
				exists: true,
				validRuntime: false,
				reason: "缺少 @deepseek-ai/dsh-base 或 dsh-app-boot",
				source,
			});
			return null;
		}

		const compat = checkDshRuntimeCompatibility(base, expectedVersion);
		scannedPaths.push({
			path: norm,
			exists: true,
			validRuntime: true,
			base,
			version: compat.runtimeVersion,
			family: compat.runtimeFamily,
			compatible: compat.compatible,
			source,
		});

		if (!firstFoundBase) {
			firstFoundBase = base;
		}
		if (compat.compatible && !firstCompatibleBase) {
			firstCompatibleBase = base;
		}

		return base;
	};

	// 1. $PI_WEB_DSH_RUNTIME — 显式指定
	const explicit = process.env.PI_WEB_DSH_RUNTIME;
	if (explicit) {
		const base = probe(explicit, "env:PI_WEB_DSH_RUNTIME");
		if (base) {
			return {
				base,
				scannedPaths,
				compatibility: checkDshRuntimeCompatibility(base, expectedVersion),
			};
		}
	}

	// 2. 本包（pi-web-ui）的 node_modules
	const pkgRoot = findLocalPackageRoot(HERE);
	if (pkgRoot) {
		probe(join(pkgRoot, "node_modules"), "local:packageRoot");
	}
	probe(join(resolve(HERE, "..", "..", ".."), "node_modules"), "local:relative-3");
	probe(join(resolve(HERE, "..", "..", "..", ".."), "node_modules"), "local:relative-4");

	// 3. execPath 邻近 node_modules
	probe(join(dirname(process.execPath), "node_modules"), "execPath:adjacent");
	probe(join(dirname(process.execPath), "..", "lib", "node_modules"), "execPath:parent-lib");
	probe(join(dirname(process.execPath), "..", "node_modules"), "execPath:parent");

	// 4. 从 $PATH 中探测到的候选
	for (const cand of findCandidatesFromPath()) {
		probe(cand.path, cand.source);
	}

	// 5. 从 npmrc 中探测到的 prefix
	for (const p of findPrefixFromNpmrc()) {
		probe(join(p, "lib", "node_modules"), "npmrc:prefix-lib");
		probe(join(p, "node_modules"), "npmrc:prefix");
	}

	// 6. 环境变量里的前缀
	const envPrefixes = [process.env.NPM_CONFIG_PREFIX, process.env.npm_config_prefix, process.env.PREFIX];
	for (const p of envPrefixes) {
		if (p) {
			probe(join(p, "lib", "node_modules"), "env:prefix-lib");
			probe(join(p, "node_modules"), "env:prefix");
		}
	}

	// 7. 常见系统默认路径
	if (process.platform === "win32") {
		if (process.env.APPDATA) probe(join(process.env.APPDATA, "npm", "node_modules"), "default:win-appdata");
		if (process.env.LOCALAPPDATA)
			probe(join(process.env.LOCALAPPDATA, "npm", "node_modules"), "default:win-localappdata");
		if (process.env.ProgramFiles)
			probe(join(process.env.ProgramFiles, "nodejs", "node_modules"), "default:win-programfiles");
	} else {
		probe("/usr/local/lib/node_modules", "default:posix-usr-local");
		probe("/usr/lib/node_modules", "default:posix-usr");
		const home = homedir();
		probe(join(home, ".local", "npm", "lib", "node_modules"), "default:posix-home-local-npm");
		probe(join(home, ".local", "npm", "node_modules"), "default:posix-home-local-npm-flat");
		probe(join(home, ".local", "lib", "node_modules"), "default:posix-home-local");
		probe(join(home, ".npm-global", "lib", "node_modules"), "default:posix-npm-global");
		probe(join(home, ".npm-global", "node_modules"), "default:posix-npm-global-flat");
	}

	// 若存在同版本族的有效树，优先选择；否则回退至首个可用树（由 launcher 报错指引版本）
	const chosenBase = firstCompatibleBase || firstFoundBase || null;
	const compatibility = chosenBase ? checkDshRuntimeCompatibility(chosenBase, expectedVersion) : null;

	return {
		base: chosenBase,
		scannedPaths,
		compatibility,
	};
}

/** 供已有代码直接获取有效 runtimeBase 路径 */
export async function resolveRuntimeBase() {
	const { base } = await resolveRuntimeBaseWithDetails();
	return base;
}
