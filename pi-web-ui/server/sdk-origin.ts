/**
 * sdk-origin — 本进程实际加载的是哪一份 pi SDK，以及被它遮蔽的副本（issue #260）。
 *
 * 背景：npm 全局安装会把依赖**嵌在** `<npm root -g>/pi-web-ui/node_modules/`（不 hoist，
 * 实测），而 Node 的解析顺序是「嵌套优先于祖先」。于是用户按更新面板/README 的提示
 * `npm i -g @earendil-works/pi-coding-agent@latest` 升级全局那份时，服务实际加载的
 * 仍是自带副本 —— 表现为「升了 0.86.1，横幅和 /api/health 还显示 0.85.1」。
 *
 * 这里把「所有能被解析到的副本」按 Node 的顺序算出来（[0] = 生效的那份），
 * 让启动横幅与健康检查说实话，而不是让用户去猜。
 *
 * 纯函数 + 零副作用，便于单测（见 tests/unit/sdk-origin.test.ts）。
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, delimiter, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "@earendil-works/pi-coding-agent";

export interface SdkCopy {
	/** package.json 的绝对路径。 */
	path: string;
	/** 该副本的版本号。 */
	version: string;
}

function addCopy(pjPath: string, out: SdkCopy[], requireName = false): void {
	if (!existsSync(pjPath)) return;
	const norm = pjPath.replace(/\\/g, "/");
	if (out.some((c) => c.path.replace(/\\/g, "/") === norm)) return;
	try {
		const raw = readFileSync(pjPath, "utf8");
		const info = JSON.parse(raw);
		if (requireName && info?.name !== PKG) return;
		if (typeof info?.version === "string" && info.version) {
			out.push({ path: pjPath, version: info.version });
		}
	} catch {}
}

/** 探测 PATH 上的 pi 可执行文件反推其包根（issue #559, #562）。 */
function scanPathForPi(out: SdkCopy[], env: NodeJS.ProcessEnv = process.env): void {
	const rawPath = env.PATH || "";
	if (!rawPath) return;
	const dirs = rawPath.split(delimiter).filter(Boolean);
	const isWin = process.platform === "win32";
	const names = isWin ? ["pi.cmd", "pi.exe", "pi.ps1", "pi"] : ["pi"];

	for (const dir of dirs) {
		for (const name of names) {
			const candidate = join(dir, name);
			if (!existsSync(candidate)) continue;

			// 1. 尝试 realpathSync 解析符号链接（Unix 下 npm/pnpm 全局 bin 标准布局）
			try {
				const real = realpathSync(candidate);
				let cur = dirname(real);
				for (let i = 0; i < 5; i++) {
					const pj = join(cur, "package.json");
					addCopy(pj, out, true);
					const parent = dirname(cur);
					if (parent === cur) break;
					cur = parent;
				}
			} catch {}

			// 2. 检查常见同级/相对 node_modules 目录（Windows npm 全局 bin 同级 node_modules 等）
			addCopy(join(dir, "node_modules", PKG, "package.json"), out);
			addCopy(join(dir, "..", "lib", "node_modules", PKG, "package.json"), out);
			addCopy(join(dir, "..", "node_modules", PKG, "package.json"), out);

			// 3. 脚本包装内容解析（Windows 下 .cmd / .ps1 或 Unix 下 shell 包装脚本）
			try {
				const head = readFileSync(candidate, "utf8").slice(0, 4096);
				const m = head.match(/[^\r\n"']*@earendil-works[/\\]pi-coding-agent[^\r\n"']*/);
				if (m) {
					let matchedPath = m[0].trim().replace(/%~?dp0%?[/\\]/gi, "");
					let targetDir = isAbsolute(matchedPath) ? matchedPath : join(dir, matchedPath);
					for (let i = 0; i < 5; i++) {
						const pj = join(targetDir, "package.json");
						addCopy(pj, out, true);
						const parent = dirname(targetDir);
						if (parent === targetDir) break;
						targetDir = parent;
					}
				}
			} catch {}
		}
	}
}

/** 探测 npm / pnpm 全局 prefix 目录（issue #559）。 */
function scanGlobalPrefixes(out: SdkCopy[], env: NodeJS.ProcessEnv = process.env): void {
	const home = env.HOME || env.USERPROFILE || "";

	// 1. NPM_CONFIG_PREFIX / npm_config_prefix / PREFIX
	const prefix = env.NPM_CONFIG_PREFIX || env.npm_config_prefix || env.PREFIX;
	if (prefix) {
		addCopy(join(prefix, "lib", "node_modules", PKG, "package.json"), out);
		addCopy(join(prefix, "node_modules", PKG, "package.json"), out);
	}

	// 2. 用户级 npm 全局 (~/.npm-global, %APPDATA%\npm)
	if (home) {
		addCopy(join(home, ".npm-global", "lib", "node_modules", PKG, "package.json"), out);
		addCopy(join(home, ".npm-global", "node_modules", PKG, "package.json"), out);
	}
	if (env.APPDATA) {
		addCopy(join(env.APPDATA, "npm", "node_modules", PKG, "package.json"), out);
	}

	// 3. POSIX 系统级 npm 全局
	if (process.platform !== "win32") {
		addCopy(join("/usr", "local", "lib", "node_modules", PKG, "package.json"), out);
		addCopy(join("/usr", "lib", "node_modules", PKG, "package.json"), out);
	}

	// 4. pnpm 全局目录 (PNPM_HOME, ~/.local/share/pnpm/global, %LOCALAPPDATA%\pnpm\global)
	if (env.PNPM_HOME) {
		addCopy(join(env.PNPM_HOME, "node_modules", PKG, "package.json"), out);
		addCopy(join(env.PNPM_HOME, "global", "node_modules", PKG, "package.json"), out);
	}
	if (home) {
		addCopy(join(home, ".local", "share", "pnpm", "global", "node_modules", PKG, "package.json"), out);
	}
	if (env.LOCALAPPDATA) {
		addCopy(join(env.LOCALAPPDATA, "pnpm", "global", "node_modules", PKG, "package.json"), out);
	}
}

export interface SdkCopiesOptions {
	/** 是否包含系统 PATH 及全局 prefix 目录。测试环境下默认 false，生产环境默认 true。 */
	includeGlobal?: boolean;
	/** 环境变量覆盖（用于单测隔离 PATH/HOME 等）。 */
	env?: NodeJS.ProcessEnv;
}

/** 从某个文件出发，逐级向上查找 `<dir>/node_modules/<pkg>/package.json`，
 *  并探测系统/全局已安装的 pi SDK 副本（issue #260, #321, #559, #562）。
 *  `fromFile` 收 URL（`import.meta.url`）或普通文件路径（便于单测）。 */
export function sdkCopies(fromFile: string = import.meta.url, options: SdkCopiesOptions = {}): SdkCopy[] {
	const env = options.env ?? process.env;
	const includeGlobal = options.includeGlobal ?? (options.env ? true : !process.env.VITEST);
	const out: SdkCopy[] = [];
	let dir = dirname(fromFile.startsWith("file:") ? fileURLToPath(fromFile) : fromFile);
	for (;;) {
		const pj = join(dir, "node_modules", PKG, "package.json");
		addCopy(pj, out);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	// 显式透传的宿主 SDK 路径（如 extensions/webui.ts 宿主传递，issue #482）
	if (env.PI_WEB_SDK_DIR) {
		addCopy(join(env.PI_WEB_SDK_DIR, "package.json"), out);
	}

	// 宿主 Pi Node 路径探测（~/.local/share/pi-node/current/...，issue #482）
	const home = env.HOME || env.USERPROFILE;
	if (home) {
		addCopy(join(home, ".local", "share", "pi-node", "current", "lib", "node_modules", PKG, "package.json"), out);
	}

	if (includeGlobal) {
		// PATH 上的 pi 可执行文件反推（issue #559）
		scanPathForPi(out, env);

		// npm / pnpm 全局 prefix 目录探测（issue #559）
		scanGlobalPrefixes(out, env);
	}

	return out;
}

/** 点分版本号比较（够用即可：只比数字段，缺位当 0）。 */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(".");
	const pb = b.split(".");
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
		const nb = Number.parseInt(pb[i] ?? "0", 10) || 0;
		if (na !== nb) return na < nb ? -1 : 1;
	}
	return 0;
}

/**
 * 本进程实际加载的是否为**随包自带**的那份（未被钩子重定向到祖先链副本）。
 * 判据：自带副本是解析顺序上的第一份，且钩子只在祖先副本**严格更新**时才重定向
 * （同版本继续用自带），所以 running == copies[0] ⟺ 自带在用。copies 为空
 * （如部分桌面/容器布局）时按自带算 —— 那本来就是唯一能加载的份。
 * UI 用它决定是否亮「安装全局引擎并切换」入口（issue #321）。
 */
export function isBundledInUse(copies: SdkCopy[], effectiveVersion: string, bundledCopy?: SdkCopy | null): boolean {
	if (bundledCopy !== undefined) {
		return bundledCopy !== null && effectiveVersion === bundledCopy.version;
	}
	return copies.length === 0 || effectiveVersion === copies[0]!.version;
}

/**
 * 启动横幅要打印的一行（不含前缀），以及是否需要提示「本进程在用的不是最新的那份」。
 * `effective` 为空时（没找到副本）返回空串，调用方照旧只打印版本号。
 *
 * #321 起默认会自动跟随更新的那份（resolve-global-sdk），所以这条提示出现即意味着：
 * 进程启动时没跟上（升级发生在启动后 / 旧构建没注入钩子），或用户显式
 * PI_WEB_SDK=bundled 钉死了自带副本 —— 文案把两种出路都写明。
 */
export function sdkOriginNote(copies: SdkCopy[], effectiveVersion: string): string | null {
	const shadowed = copies.slice(1);
	const newer = shadowed.filter((c) => compareVersions(c.version, effectiveVersion) > 0);
	if (newer.length === 0) return null;
	return (
		`a newer pi SDK is installed on this machine (${newer.map((c) => `v${c.version}`).join(", ")}) ` +
		`but this process runs v${effectiveVersion} — restart to follow it (default), ` +
		`or set PI_WEB_SDK=bundled to pin the bundled copy.`
	);
}
