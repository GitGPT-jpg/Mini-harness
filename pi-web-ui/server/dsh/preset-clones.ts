/**
 * preset-clones.ts — DSH Agent 预设的 file: 克隆生成。
 *
 * 背景（实测结论，见 tests/scratch/preset-spike-2026-09-15.md 探针2/5）：
 * shipped 预设（dsh-agent-presets 包内 standard/ptc/minimal/cordis）的 composition
 * 用裸包名（`@deepseek-ai/dsh-persona` 等），挂载时按 agent scope 的 baseUrl 解析 ——
 * launcher 式 boot 下 baseUrl = cordis.yml 所在目录，裸包名全部不可解析，四个预设
 * 全带 broken，mount 直接失败。官方 CLI 靠 PluginPackages resolution 走安装锚点，
 * pi-web-ui 没装那套。已验证可行的路：把 composition 拷一份，把裸包名改写成指向
 * 运行时树的绝对 file: URL（clone），roster 用 clone 目录做 system 根并关掉
 * includeShippedRoot（同名 id 早根优先，shipped 的 broken 条目会被 clone 遮蔽）。
 *
 * 本模块是纯 TS（vitest 可测）：发现 shipped 目录 → 逐预设拷贝+改写 → 写
 * preset-plane.patch.yml（disable 表 + roster，二者原子生效，缺一不可）。
 * Node 侧（dsh-agent-service）在每次启动运行时前调用；launcher 只消费环境变量，
 * 不做生成（职责分离；clone 缺失 = 回落 legacy 单组合，见 PI_WEB_DSH_PRESET_PATCH）。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** roster 默认预设（与官方 dsh-web-app/cordis.patch.yml 一致）。 */
export const PRESET_DEFAULT_ID = "standard";

/** clone 输出目录名（<dataDir>/ 下）。 */
export const PRESET_CLONES_DIRNAME = "dsh-preset-clones";

/** preset-plane patch 文件名（<dataDir>/ 下，由本模块生成，launcher 按 env 加载）。 */
export const PRESET_PLANE_PATCH_FILENAME = "dsh-preset-plane.patch.yml";

/** 生成结果（供服务端校验 + 持久化 + UI 回退判断）。 */
export interface PresetCloneResult {
	/** clone 根目录（roster roots[0]，trust system）。 */
	clonesDir: string;
	/** preset-plane patch 文件绝对路径（launcher env PI_WEB_DSH_PRESET_PATCH 指向它）。 */
	patchFile: string;
	/** 成功克隆的预设 id（目录名）。 */
	presetIds: string[];
	/** 改写时未能解析到入口文件的裸名（`id: bare`；对应行保留原文，roster 会报 broken）。 */
	warnings: string[];
}

// ---------------------------------------------------------------------------
// 运行时树发现（server/dsh/runtime/runtime-root.mjs 的 TS 镜像；改一处记得改另一处）
// ---------------------------------------------------------------------------

/** 候选 node_modules 根（顺序同 runtime-root.mjs：显式 > 本包 > execPath 邻近 > npm 全局）。 */
export function runtimeBaseCandidates(): string[] {
	const out: string[] = [];
	const explicit = process.env.PI_WEB_DSH_RUNTIME;
	if (explicit) out.push(resolve(explicit));
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 5; i++) {
		const nm = join(dir, "node_modules");
		if (existsSync(nm)) {
			out.push(resolve(nm));
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	out.push(join(dirname(process.execPath), "node_modules"));
	try {
		const prefixes = [
			process.env.NPM_CONFIG_PREFIX,
			process.env.npm_config_prefix,
			join(dirname(process.execPath), ".."),
		];
		for (const prefix of prefixes) {
			if (!prefix) continue;
			out.push(join(prefix, "lib", "node_modules"));
			out.push(join(prefix, "node_modules"));
		}
	} catch {
		/* ignore */
	}
	return [...new Set(out)];
}

function runtimeBaseFor(root: string): string | null {
	const flat = join(root, "@deepseek-ai");
	if (
		existsSync(join(flat, "dsh-base", "cordis.patch.yml")) &&
		existsSync(join(flat, "dsh-app-boot", "lib", "index.js"))
	) {
		return resolve(root);
	}
	const nested = join(root, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai");
	if (
		existsSync(join(nested, "dsh-base", "cordis.patch.yml")) &&
		existsSync(join(nested, "dsh-app-boot", "lib", "index.js"))
	) {
		return resolve(join(root, "@deepseek-ai", "dsh", "node_modules"));
	}
	return null;
}

/** shipped 预设源目录（<runtimeBase>/@deepseek-ai/dsh-agent-presets/presets），找不到 = null。 */
export function findShippedPresetsDir(): string | null {
	for (const root of runtimeBaseCandidates()) {
		const base = runtimeBaseFor(root);
		if (!base) continue;
		const dir = join(base, "@deepseek-ai", "dsh-agent-presets", "presets");
		if (existsSync(join(dir, "standard", "agent.cordis.yml"))) return dir;
	}
	return null;
}

// ---------------------------------------------------------------------------
// 裸包名改写（entry 文件解析 + 文本改写；改写是纯函数，可单测）
// ---------------------------------------------------------------------------

/**
 * 把一个裸包名解析到运行时树内的入口文件 file: URL。
 * discovery 的健康检查要求 file: 指向真实文件（目录 URL 恒判 broken），
 * mount 侧 Loader 直接 import 该 URL（peer 依赖从运行时树向上解析）。
 * @param scopeDir 运行时树里 `@deepseek-ai` 作用域的本地目录
 * @param bare `@deepseek-ai/<pkg>` 或 `@deepseek-ai/<pkg>/<sub>`
 * @returns 入口文件的 file: URL；解析不出返回 null（调用方保留原文，roster 报 broken）
 */
export function resolvePackageEntryFileUrl(scopeDir: string, bare: string): string | null {
	const parts = bare.split("/");
	if (parts.length < 2 || !parts[0].startsWith("@") || !parts[1]) return null;
	const pkg = parts[1];
	const sub = parts.length > 2 ? parts.slice(2).join("/") : undefined;
	const pkgDir = join(scopeDir, pkg);
	let manifest: { main?: unknown; exports?: unknown } = {};
	try {
		manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as typeof manifest;
	} catch {
		return null;
	}
	const pickDefault = (v: unknown): string | null => {
		if (typeof v === "string") return v;
		if (v && typeof v === "object" && typeof (v as Record<string, unknown>).default === "string") {
			return (v as Record<string, string>).default;
		}
		return null;
	};
	const candidates: string[] = [];
	const exportsMap =
		manifest.exports && typeof manifest.exports === "object" ? (manifest.exports as Record<string, unknown>) : null;
	if (sub) {
		const hit = exportsMap?.[`./${sub}`];
		const mapped = pickDefault(hit);
		if (mapped) candidates.push(mapped);
		candidates.push(join("lib", `${sub}.js`), join("lib", sub, "index.js"));
	} else {
		const mapped = pickDefault(exportsMap?.["."]);
		if (mapped) candidates.push(mapped);
		if (typeof manifest.main === "string" && manifest.main) candidates.push(manifest.main);
		candidates.push(join("lib", "index.js"));
	}
	for (const rel of candidates) {
		const abs = resolve(pkgDir, rel);
		if (existsSync(abs)) return pathToFileURL(abs).href;
	}
	return null;
}

/** 改写结果（文本 + 未能解析的裸名，调用方记 warnings）。 */
export interface RewriteResult {
	text: string;
	unresolved: string[];
}

/**
 * 把 composition 文本里的裸包名改写成入口文件 file: URL。
 * 只动 `name:` 行的 `@deepseek-ai/<pkg[\/sub]>`（单/双引号），`cordis:group`、
 * `./相对路径`、`!!js` 表达式一律不动。resolve 回 null 的行保留原文。
 */
export function rewriteBareNames(yamlText: string, resolve: (bare: string) => string | null): RewriteResult {
	const unresolved = new Set<string>();
	const text = yamlText.replace(
		/^([ \t]*name:[ \t]*)(['"])@deepseek-ai\/([^'"\s]+)\2([ \t]*(?:#.*)?)$/gim,
		(_m, prefix: string, quote: string, rest: string, suffix: string) => {
			const url = resolve(`@deepseek-ai/${rest}`);
			if (!url) {
				unresolved.add(`@deepseek-ai/${rest}`);
				return _m;
			}
			return `${prefix}${quote}${url}${quote}${suffix}`;
		},
	);
	return { text, unresolved: [...unresolved] };
}

// ---------------------------------------------------------------------------
// preset-plane patch（disable 表 + roster；纯函数，可单测）
// ---------------------------------------------------------------------------

/** 与官方 dsh-web-app/cordis.patch.yml 同表的 agent-plane disable 行（last-write-wins 整行替换）。 */
export const AGENT_PLANE_DISABLE_IDS = [
	"tool-bash",
	"tool-pwsh",
	"tool-jobs",
	"tool-fs",
	"tool-fs-search",
	"tool-str-replace-editor",
	"skill-filesystem",
	"tool-skill",
	"command-goal",
	"tool-goal",
	"plan-mode",
	"compaction-basic",
	"command-compact",
	"tool-result-pruner",
	"tool-subagent-control",
	"tool-subagent-list-agents",
	"tool-subagent",
	"tool-subagent-fork",
	"workflow-worker-thread",
	"tool-workflow",
	"tool-ralph",
	"agent-instructions",
	"tool-todo",
	"tool-web",
] as const;

/**
 * 生成 preset-plane patch 文本：先 disable 全部 agent-plane 行（工具下沉到预设），
 * 再 insert roster（clone 目录做唯一 system 根，关 shipped 根；user 根保留，
 * `$DSH_HOME/.agent-presets` 的自建预设照常出现）。
 * 注意：YAML 里 clonesDir 走 JSON 转义（Windows 反斜杠安全）。
 */
export function buildPresetPlanePatch(clonesDir: string): string {
	const disables = AGENT_PLANE_DISABLE_IDS.map((id) => `- id: ${id}\n  disabled: true`).join("\n");
	return (
		`# 由 server/dsh/preset-clones.ts 生成（每次 DSH 运行时启动前重写），勿手改。\n` +
		`# agent plane 下沉到预设：与官方 dsh-web-app/cordis.patch.yml 同表。\n` +
		`${disables}\n\n` +
		`# preset roster：clone 目录是唯一 system 根（同名 id 早根优先，shipped 原件被遮蔽）；\n` +
		`# user 根保留（自建预设照常上架；裸包名在 launcher boot 下不可解析是已知限制，见文档）。\n` +
		`- insert:\n` +
		`    - id: agent-presets\n` +
		`      name: '@deepseek-ai/dsh-agent-presets'\n` +
		`      config:\n` +
		`        default: ${PRESET_DEFAULT_ID}\n` +
		`        includeShippedRoot: false\n` +
		`        roots:\n` +
		`          - path: ${JSON.stringify(clonesDir)}\n` +
		`            trust: system\n`
	);
}

// ---------------------------------------------------------------------------
// 生成主入口（IO；幂等：先清后写）
// ---------------------------------------------------------------------------

/**
 * 生成 clone + preset-plane patch。成功返回结果；shipped 目录找不到返回 null
 * （调用方回落 legacy 单组合：不下发 patch，roster 不挂载）。
 * @param dataDir pi-web-ui 数据目录（输出 <dataDir>/dsh-preset-clones/ + patch 文件）
 * @param shippedDir 覆盖 shipped 源目录（单测 fixture 用；缺省自动发现）
 */
export function generatePresetClones(dataDir: string, shippedDir?: string): PresetCloneResult | null {
	const src = shippedDir ?? findShippedPresetsDir();
	if (!src) return null;
	let ids: string[];
	try {
		ids = readdirSync(src, { withFileTypes: true })
			.filter((e) => e.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(e.name))
			.map((e) => e.name)
			.filter((id) => existsSync(join(src, id, "agent.cordis.yml")))
			.sort();
	} catch {
		return null;
	}
	if (!ids.includes(PRESET_DEFAULT_ID)) return null;
	const clonesDir = join(dataDir, PRESET_CLONES_DIRNAME);
	rmSync(clonesDir, { recursive: true, force: true });
	mkdirSync(clonesDir, { recursive: true });
	// 入口解析基：运行时树里的 `@deepseek-ai` 作用域
	//（src = <base>/@deepseek-ai/dsh-agent-presets/presets，上两级即作用域）。
	const scopeDir = join(src, "..", "..");
	const warnings: string[] = [];
	try {
		for (const id of ids) {
			const dst = join(clonesDir, id);
			cpSync(join(src, id), dst, { recursive: true });
			const compFile = join(dst, "agent.cordis.yml");
			const raw = readFileSync(compFile, "utf8");
			const { text, unresolved } = rewriteBareNames(raw, (bare) => resolvePackageEntryFileUrl(scopeDir, bare));
			for (const u of unresolved) warnings.push(`${id}: ${u}`);
			writeFileSync(compFile, text);
		}
	} catch {
		rmSync(clonesDir, { recursive: true, force: true });
		return null;
	}
	const patchFile = join(dataDir, PRESET_PLANE_PATCH_FILENAME);
	writeFileSync(patchFile, buildPresetPlanePatch(clonesDir));
	return { clonesDir, patchFile, presetIds: ids, warnings };
}
