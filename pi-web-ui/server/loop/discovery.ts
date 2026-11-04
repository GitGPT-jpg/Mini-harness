/**
 * 上下文发现与「只追问缺口」编排（三层任务默认知识的第一层 → 第二层衔接）。
 *
 * 目标体验：用户只给「代码/项目位置 + 任务目标」，系统先发现并整理现有信息，
 * 再只询问真正缺失的必要项。发现只做只读扫描（列目录 + 读少量项目配置文件），
 * 绝不执行工作目录文档里的任意指令。
 *
 * 修复 F5：所有入口（TaskModal / `/api/mini-harness/discover` / `startLoop` / API 调用）
 * 在发现、缺口判断和启动校验前，共用同一个 `normalizeTaskInputs` 规范化入口：
 *  - 顶层 `validateCmd` / `precheckCmd` 与 `inputs.validateCmd` / `inputs.precheckCmd` 统一合并；
 *  - 两处相同 → 合并，不重复询问；
 *  - 一处缺失、一处有合法值 → 采用合法值；
 *  - 两处存在不同的非空显式值 → 返回字段级冲突错误，不悄悄选一处；
 *  - `0` 和 `false` 保留为 `"0"` 和 `"false"`，不因 truthy 判断丢失；非法类型（对象/数组/NaN）明确报错。
 *
 * 输入来源标签（与 packs.ts 的 CapabilityPackInput.source 对齐）：
 *  - user           用户显式输入；
 *  - discovery      当前环境实际探测结果（工作区文件 / KUBECONFIG / git）；
 *  - project-config 项目配置（pyproject.toml / task.yaml / manifest 等）；
 *  - pack-default   能力包默认值（如目标命中率 0.96、输入长度 81920）；
 *  - history        历史经验（可参考，不覆盖当前事实）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAllDocuments } from "yaml";
import { resolveGitHeadSha } from "./metrics.js";
import { resolvePack, type CapabilityPackInput } from "./packs.js";

export interface WorkspaceProbe {
	workspace: string;
	exists: boolean;
	gitBranch: string | null;
	gitHead: string | null;
	kubeconfigReady: boolean;
	markers: string[];
	dirs: string[];
	/** 发现的部署 manifest 候选（相对路径，如 "deploy/decode.yaml"）。 */
	deployManifests: string[];
	error?: string;
}

const KNOWN_MARKERS = [
	"validate.py",
	"run.py",
	"task.yaml",
	"pyproject.toml",
	"Cargo.toml",
	"Makefile",
	"package.json",
	"bench_ascache.py",
	"benchmark",
	"Script",
	"references",
	"workflows",
	"tasks",
];

/** 部署 manifest 候选名（必须在扫描清单里，否则 service-config-verify 的 deploy_yaml 永远发现不到）。 */
const DEPLOY_MANIFEST_NAMES = [
	"decode.yaml",
	"deploy.yaml",
	"deployment.yaml",
	"decode.yml",
	"deploy.yml",
	"deployment.yml",
];

/** 允许同时出现在顶层请求与 `inputs` 字典中的规范化键。 */
const TOP_LEVEL_SHARED_KEYS = [
	"validateCmd",
	"precheckCmd",
	"deploy_yaml",
	"manifest",
	"namespace",
	"kubeconfig",
] as const;

/** 发现与内容指纹使用同一敏感路径规则；仅检查路径，不读取凭据。 */
export function isSensitiveTaskPath(file: string): boolean {
	return file
		.split(/[\\/]/)
		.some((part) =>
			/^(?:\.git|\.ssh|\.aws|\.azure|\.gcloud|gcloud|\.kube|\.docker|\.npmrc|\.netrc|\.pypirc|(?:secrets?|credentials?|kubeconfig|\.env)(?:\..*)?|id_rsa|id_ed25519)$|\.(?:pem|key|p12|pfx)$/i.test(
				part,
			),
		);
}

const MANIFEST_MAX_BYTES = 256 * 1024;
const MANIFEST_MAX_FILES = 16;
const NAMESPACE = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;

class ManifestInputError extends Error {}

/** 不接受 workspace 外路径或 symlink；文件名白名单不能覆盖已声明的凭据身份。 */
function readManifestFile(workspace: string, file: string, credentialPaths: string[]): string {
	try {
		const root = fs.realpathSync(workspace);
		const full = path.resolve(root, file);
		const rel = path.relative(root, full);
		if (
			!rel ||
			rel === ".." ||
			rel.startsWith(`..${path.sep}`) ||
			path.isAbsolute(rel) ||
			isSensitiveTaskPath(full) ||
			root === path.parse(root).root ||
			root === fs.realpathSync(os.homedir())
		) {
			throw new ManifestInputError("manifest 路径越界或敏感，拒绝读取");
		}
		const parents: Array<[string, fs.Stats]> = [];
		let current = root;
		for (const part of rel.split(path.sep).slice(0, -1)) {
			current = path.join(current, part);
			const st = fs.lstatSync(current);
			if (!st.isDirectory() || st.isSymbolicLink()) throw new ManifestInputError("manifest 路径含符号链接或非目录");
			parents.push([current, st]);
		}
		const before = fs.lstatSync(full);
		if (!before.isFile() || before.isSymbolicLink())
			throw new ManifestInputError("manifest 必须是普通文件，拒绝符号链接");
		if (before.size > MANIFEST_MAX_BYTES) throw new ManifestInputError("manifest 超过 256 KiB 读取上限");
		for (const credential of credentialPaths) {
			const secret = path.resolve(root, credential);
			if (full === secret || full.startsWith(secret + path.sep))
				throw new ManifestInputError("manifest 指向凭据，拒绝读取");
			// 识别凭据的别名/硬链接，只读 stat，不打开凭据。
			try {
				const st = fs.statSync(secret);
				if (st.dev === before.dev && st.ino === before.ino) throw new ManifestInputError("manifest 指向凭据，拒绝读取");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		const stamp = (st: fs.Stats) => [st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs].join(":");
		const checkParents = () => {
			if (fs.realpathSync(workspace) !== root || parents.some(([dir, st]) => stamp(fs.lstatSync(dir)) !== stamp(st))) {
				throw new ManifestInputError("manifest 读取期间路径发生变化");
			}
		};
		const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
		try {
			checkParents();
			if (stamp(fs.fstatSync(fd)) !== stamp(before)) throw new ManifestInputError("manifest 读取期间文件发生变化");
			const buffer = Buffer.alloc(MANIFEST_MAX_BYTES + 1);
			let bytes = 0;
			while (bytes < buffer.length) {
				const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
				if (!count) break;
				bytes += count;
			}
			if (bytes > MANIFEST_MAX_BYTES) throw new ManifestInputError("manifest 超过 256 KiB 读取上限");
			checkParents();
			if (
				bytes !== before.size ||
				stamp(fs.fstatSync(fd)) !== stamp(before) ||
				stamp(fs.lstatSync(full)) !== stamp(before)
			)
				throw new ManifestInputError("manifest 读取期间文件发生变化");
			return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
		} finally {
			fs.closeSync(fd);
		}
	} catch (error) {
		if (error instanceof ManifestInputError) throw error;
		throw new ManifestInputError("manifest 无法安全读取（缺失、权限或编码错误）");
	}
}

export interface NormalizedTaskInputs {
	ok: boolean;
	inputs: Record<string, string>;
	validateCmd: string;
	precheckCmd: string;
	conflicts: Array<{ field: string; topLevel: string; inInputs: string }>;
	typeErrors: Array<{ field: string; message: string }>;
	error: string | null;
}

/**
 * 把单个输入值规范化为字符串：
 *  - `undefined` / `null` → `null`（未提供）
 *  - `number` → 有限数值转 `String(v)`（保留 `0`），`NaN`/`Infinity` 报类型错
 *  - `boolean` → `"true"` / `"false"`（保留 `false`）
 *  - `string` → 空白串视为未提供；命令逐字保留，其余字段去除首尾空白
 *  - 其它类型（对象、数组、函数等）→ 报字段级类型错误
 */
function coerceScalarInput(
	field: string,
	raw: unknown,
	typeErrors: Array<{ field: string; message: string }>,
): string | null {
	if (raw === undefined || raw === null) return null;
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		return trimmed.length > 0 ? (/^(inputs\.)?(validateCmd|precheckCmd)$/.test(field) ? raw : trimmed) : null;
	}
	if (/^(inputs\.)?(validateCmd|precheckCmd|deploy_yaml|manifest|namespace|kubeconfig)$/.test(field)) {
		typeErrors.push({ field, message: `字段 ${field} 必须是字符串` });
		return null;
	}
	if (typeof raw === "number") {
		if (!Number.isFinite(raw)) {
			typeErrors.push({ field, message: `字段 ${field} 数值非法（收到 ${String(raw)}）` });
			return null;
		}
		return String(raw);
	}
	if (typeof raw === "boolean") {
		return raw ? "true" : "false";
	}
	typeErrors.push({
		field,
		message: `字段 ${field} 类型非法（期望字符串/数值/布尔，收到 ${Array.isArray(raw) ? "array" : typeof raw}）`,
	});
	return null;
}

/**
 * 统一规范化任务输入（F5 唯一权威入口）：
 * 在上下文发现、缺失项判定、能力包合并和启动前，先把顶层字段（`validateCmd`、`precheckCmd` 等）
 * 与 `inputs` 对象合并并做冲突/类型检查。
 */
export function normalizeTaskInputs(raw: {
	validateCmd?: unknown;
	precheckCmd?: unknown;
	inputs?: unknown;
	topLevelExtras?: Record<string, unknown>;
	hardConstraints?: unknown;
	packId?: string | null;
	deploy_yaml?: unknown;
	manifest?: unknown;
	namespace?: unknown;
	kubeconfig?: unknown;
}): NormalizedTaskInputs {
	const typeErrors: Array<{ field: string; message: string }> = [];
	const conflicts: Array<{ field: string; topLevel: string; inInputs: string }> = [];
	const normalized: Record<string, string> = Object.create(null);
	const constraintError = validateTaskHardConstraints(raw.hardConstraints);
	if (constraintError) typeErrors.push({ field: "hardConstraints", message: constraintError });

	if (raw.inputs !== undefined && raw.inputs !== null) {
		if (
			typeof raw.inputs !== "object" ||
			Array.isArray(raw.inputs) ||
			(Object.getPrototypeOf(raw.inputs) !== Object.prototype && Object.getPrototypeOf(raw.inputs) !== null)
		) {
			typeErrors.push({
				field: "inputs",
				message: `字段 inputs 必须是键值对对象（收到 ${Array.isArray(raw.inputs) ? "array" : typeof raw.inputs}）`,
			});
		} else {
			for (const [k, v] of Object.entries(raw.inputs as Record<string, unknown>)) {
				const coerced = coerceScalarInput(`inputs.${k}`, v, typeErrors);
				if (coerced !== null) {
					normalized[k] = coerced;
				}
			}
		}
	}

	const topMap: Record<string, unknown> = {
		...raw.topLevelExtras,
		...Object.fromEntries(TOP_LEVEL_SHARED_KEYS.filter((key) => raw[key] != null).map((key) => [key, raw[key]])),
	};
	// API 可把能力包输入放在顶层；已知声明和 inputs 同名键都参与冲突检查。
	for (const key of new Set([
		...Object.keys(normalized),
		...(resolvePack(raw.packId ?? "")?.inputs.map((item) => item.id) ?? []),
	])) {
		if (Object.prototype.hasOwnProperty.call(raw, key)) topMap[key] = (raw as Record<string, unknown>)[key];
	}

	for (const key of Object.keys(topMap)) {
		const topVal = coerceScalarInput(key, topMap[key], typeErrors);
		if (topVal === null) continue;
		const inInputsVal = normalized[key];
		if (inInputsVal !== undefined && inInputsVal !== topVal) {
			conflicts.push({ field: key, topLevel: topVal, inInputs: inInputsVal });
		} else {
			normalized[key] = topVal;
		}
	}

	const errParts: string[] = [];
	if (typeErrors.length > 0) {
		errParts.push("输入类型不合法：" + typeErrors.map((e) => e.message).join("；"));
	}
	if (conflicts.length > 0) {
		errParts.push("输入字段冲突（顶层与 inputs 不一致）：" + conflicts.map((c) => c.field).join("；"));
	}

	return {
		ok: errParts.length === 0,
		inputs: normalized,
		validateCmd: normalized.validateCmd ?? "",
		precheckCmd: normalized.precheckCmd ?? "",
		conflicts,
		typeErrors,
		error: errParts.length > 0 ? errParts.join("；") : null,
	};
}

/** 不把非法约束过滤成空数组；入口必须在发现或创建 run 前拒绝。 */
export function validateTaskHardConstraints(raw: unknown): string | null {
	if (raw === undefined || raw === null) return null;
	if (!Array.isArray(raw)) return "hardConstraints 必须是数组";
	for (const [i, item] of raw.entries()) {
		const prefix = `hardConstraints[${i}]`;
		if (!item || typeof item !== "object" || Array.isArray(item)) return `${prefix} 必须是对象`;
		for (const key of ["name", "metric"] as const) {
			if (typeof item[key] !== "string" || !item[key].trim()) return `${prefix}.${key} 必须是非空字符串`;
		}
		if (!["lt", "lte", "gt", "gte"].includes(item.op)) return `${prefix}.op 必须是 lt/lte/gt/gte`;
		if (typeof item.value !== "number" || !Number.isFinite(item.value)) return `${prefix}.value 必须是有限数值`;
		for (const key of ["unit", "scenario"] as const) {
			if (item[key] !== undefined && typeof item[key] !== "string") return `${prefix}.${key} 必须是字符串`;
		}
	}
	return null;
}

export interface ResolvedInput extends CapabilityPackInput {
	source: "user" | "discovery" | "project-config" | "pack-default" | "history";
	value: string | null;
	sourceOf: string;
	/** 探测候选（如裸 validate.py/run.py）：value 只是建议，须发起者确认后才算有效输入，不得自动当作已确认。 */
	confirmed?: boolean;
}

export interface InputCandidate {
	inputId: string;
	value: string;
	sourceOf: string;
}

export interface TaskContext {
	packId: string;
	workspace: string;
	probe: WorkspaceProbe;
	inputs: ResolvedInput[];
	missing: ResolvedInput[];
	/** 探测得到的候选值（只建议、不确认），供发起者选择；未选择时对应输入仍算缺失。 */
	candidates: InputCandidate[];
	conflicts: Array<{ inputId: string; defaultValue: string; resolvedValue: string; source: string }>;
	/** 顶层字段与 inputs 字段冲突。 */
	inputConflicts?: Array<{ field: string; topLevel: string; inInputs: string }>;
	packVersion: string | null;
	provenance: Array<{ repo: string; path: string; version: string }>;
	/** 规范化后的完整有效输入字典（供启动/校验直接读取）。 */
	normalizedInputs?: Record<string, string>;
	/** 发现错误（未知能力包 / 工作区不存在 / 输入冲突或类型错误等）；非 null 时不得当作成功结果。 */
	error?: string | null;
}

/** 只读扫描工作区，发现已有入口与关键文件；不执行任何工作区命令。 */
export function probeWorkspace(workspace: string): WorkspaceProbe {
	const ws = path.resolve(workspace || process.cwd());
	const probe: WorkspaceProbe = {
		workspace: ws,
		exists: false,
		gitBranch: null,
		gitHead: null,
		kubeconfigReady: false,
		markers: [],
		dirs: [],
		deployManifests: [],
	};
	try {
		probe.exists = fs.existsSync(ws) && fs.statSync(ws).isDirectory();
	} catch {
		return probe;
	}
	if (!probe.exists) return probe;
	try {
		const real = fs.realpathSync(ws);
		if (isSensitiveTaskPath(real) || real === path.parse(real).root || real === fs.realpathSync(os.homedir())) {
			probe.error = "工作区路径敏感或范围过大，拒绝扫描";
			return probe;
		}
	} catch {
		probe.error = "工作区路径无法核验";
		return probe;
	}
	const list = (dir: string) => {
		const names: string[] = [];
		const handle = fs.opendirSync(dir);
		try {
			for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
				if (names.length >= 2048) throw new Error("目录条目超限");
				names.push(entry.name);
			}
		} finally {
			handle.closeSync();
		}
		return names.sort();
	};
	let entries: string[] = [];
	try {
		entries = list(ws);
	} catch {
		probe.error = "工作区无法读取或超过目录条目上限";
		return probe;
	}
	for (const e of entries) {
		const full = path.join(ws, e);
		let stat: fs.Stats | null = null;
		try {
			stat = fs.lstatSync(full);
		} catch {
			continue;
		}
		if (stat.isDirectory()) {
			if (KNOWN_MARKERS.includes(e)) probe.dirs.push(e);
		} else if (KNOWN_MARKERS.includes(e)) probe.markers.push(e);
		else if (DEPLOY_MANIFEST_NAMES.includes(e)) probe.deployManifests.push(e);
	}
	// 部署 manifest 常放在 deploy/ 子目录：浅扫一层，仍是有界扫描。
	try {
		const deployDir = path.join(ws, "deploy");
		if (fs.lstatSync(deployDir).isDirectory()) {
			for (const f of list(deployDir)) {
				if (DEPLOY_MANIFEST_NAMES.includes(f)) probe.deployManifests.push("deploy/" + f);
				else if (/\.ya?ml$/.test(f)) {
					probe.deployManifests.push("deploy/" + f);
				}
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") probe.error = "deploy 目录无法读取或超过目录条目上限";
	}
	probe.gitHead = resolveGitHeadSha(ws);
	try {
		probe.gitBranch = execFileSync("git", ["-C", ws, "rev-parse", "--abbrev-ref", "HEAD"], {
			timeout: 3000,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		probe.gitBranch = null;
	}
	probe.kubeconfigReady =
		!!process.env.KUBECONFIG &&
		(() => {
			try {
				return fs.existsSync(process.env.KUBECONFIG!);
			} catch {
				return false;
			}
		})();
	return probe;
}

/**
 * 解析某能力包在指定工作区的任务上下文：
 * 先经 `normalizeTaskInputs` 统一顶层与 `userInputs` 并检查类型/冲突，
 * 再按「用户显式输入 → 探测/项目配置 → 能力包默认」合并，
 * 输出每个必要输入的来源与值、缺失项、候选及冲突。
 */
export function resolveTaskContext(
	packId: string,
	workspace: string,
	userInputs: unknown = {},
	topLevel?: { validateCmd?: unknown; precheckCmd?: unknown; [k: string]: unknown },
): TaskContext {
	const norm = normalizeTaskInputs({
		validateCmd: topLevel?.validateCmd,
		precheckCmd: topLevel?.precheckCmd,
		inputs: userInputs,
		topLevelExtras:
			topLevel && Object.fromEntries(Object.entries(topLevel).filter(([key]) => key !== "hardConstraints")),
		hardConstraints: topLevel?.hardConstraints,
	});
	const pack = resolvePack(packId);
	// 输入非法时不扫描目录。错误仍保留在 TaskContext，供 HTTP/聊天统一展示。
	const probe = norm.ok
		? probeWorkspace(workspace)
		: {
				workspace: path.resolve(workspace || process.cwd()),
				exists: false,
				gitBranch: null,
				gitHead: null,
				kubeconfigReady: false,
				markers: [],
				dirs: [],
				deployManifests: [],
			};
	const inputs: ResolvedInput[] = [];
	const missing: ResolvedInput[] = [];
	const candidates: InputCandidate[] = [];
	const conflicts: TaskContext["conflicts"] = [];

	if (!norm.ok) {
		return {
			packId,
			workspace: probe.workspace,
			probe,
			inputs,
			missing,
			candidates,
			conflicts,
			inputConflicts: norm.conflicts,
			normalizedInputs: norm.inputs,
			packVersion: pack?.version ?? null,
			provenance: pack?.provenance.map((p) => ({ repo: p.repo, path: p.path, version: p.version })) ?? [],
			error: norm.error,
		};
	}

	if (!pack) {
		return {
			packId,
			workspace: probe.workspace,
			probe,
			inputs,
			missing,
			candidates,
			conflicts,
			normalizedInputs: norm.inputs,
			packVersion: null,
			provenance: [],
			error: "未知能力包：" + packId,
		};
	}
	if (!probe.exists || probe.error) {
		return {
			packId,
			workspace: probe.workspace,
			probe,
			inputs,
			missing,
			candidates,
			conflicts,
			normalizedInputs: norm.inputs,
			packVersion: pack.version,
			provenance: [],
			error: probe.error ?? "工作区不存在：" + probe.workspace,
		};
	}

	const cleanInputs = norm.inputs;
	let namespaceHint: ResolvedInput | null = null;
	try {
		if (cleanInputs.namespace && !NAMESPACE.test(cleanInputs.namespace)) throw new ManifestInputError("namespace 非法");
		const explicit = [
			...new Set([cleanInputs.deploy_yaml, cleanInputs.manifest].filter((file): file is string => !!file)),
		];
		const needsNamespace = pack.inputs.some((item) => item.id === "namespace");
		const files = explicit.length ? explicit : needsNamespace ? [...probe.deployManifests] : [];
		if (!files.length && needsNamespace && probe.markers.includes("task.yaml")) files.push("task.yaml");
		if (files.length > MANIFEST_MAX_FILES) throw new ManifestInputError("manifest 文件数量超过 16 个上限，请显式选择");
		const credentials = [
			...(process.env.KUBECONFIG?.split(path.delimiter).filter(Boolean) ?? []),
			...(cleanInputs.kubeconfig ? [cleanInputs.kubeconfig] : []),
		];
		const namespaces = new Set<string>();
		for (const file of files) {
			const ns = parseNamespaceFromManifest(readManifestFile(probe.workspace, file, credentials));
			if (ns) namespaces.add(ns);
		}
		if (namespaces.size > 1) throw new ManifestInputError("多个 manifest 的 namespace 冲突，请显式选择一致的输入");
		const ns = [...namespaces][0];
		if (ns && cleanInputs.namespace && ns !== cleanInputs.namespace) {
			conflicts.push({
				inputId: "namespace",
				defaultValue: ns,
				resolvedValue: cleanInputs.namespace,
				source: "manifest",
			});
			throw new ManifestInputError("用户 namespace 与 manifest metadata.namespace 冲突");
		}
		if (ns)
			namespaceHint = {
				id: "namespace",
				label: "namespace",
				source: "project-config",
				value: ns,
				sourceOf: "从 manifest 解析：" + files.join(", ") + " → " + ns,
				confirmed: true,
			};
		// manifest 是显式文件输入的别名；两者同时提供时已分别读取并核对。
		if (!cleanInputs.deploy_yaml && cleanInputs.manifest) cleanInputs.deploy_yaml = cleanInputs.manifest;
	} catch (error) {
		return {
			packId,
			workspace: probe.workspace,
			probe,
			inputs,
			missing,
			candidates,
			conflicts,
			normalizedInputs: cleanInputs,
			packVersion: pack.version,
			provenance: pack.provenance.map(({ repo, path: sourcePath, version }) => ({ repo, path: sourcePath, version })),
			error: error instanceof ManifestInputError ? error.message : "manifest 解析失败",
		};
	}
	for (const decl of pack.inputs) {
		const hasExplicit = Object.prototype.hasOwnProperty.call(cleanInputs, decl.id);
		const userValue = hasExplicit ? cleanInputs[decl.id]! : null;
		if (userValue !== null && userValue !== "") {
			inputs.push({ ...decl, source: "user", value: userValue, sourceOf: "用户输入", confirmed: true });
			continue;
		}
		const discovered = discoverInputValue(decl.id, probe, namespaceHint);
		if (discovered && discovered.confirmed === false) {
			// 探测候选：只建议、不确认。归入 candidates，输入仍算缺失（发起者确认后才算有效）。
			candidates.push({ inputId: decl.id, value: discovered.value!, sourceOf: discovered.sourceOf });
			const resolved: ResolvedInput = {
				...decl,
				source: "discovery",
				value: null,
				sourceOf: discovered.sourceOf,
				confirmed: false,
			};
			inputs.push(resolved);
			if (decl.required) missing.push(resolved);
			continue;
		}
		if (discovered) {
			inputs.push({ ...discovered, confirmed: true });
			if (decl.source === "pack-default" && decl.defaultValue && discovered.value !== decl.defaultValue) {
				conflicts.push({
					inputId: decl.id,
					defaultValue: decl.defaultValue,
					resolvedValue: discovered.value!,
					source: discovered.sourceOf,
				});
			}
			continue;
		}
		if (decl.source === "pack-default") {
			inputs.push({
				...decl,
				source: "pack-default",
				value: decl.defaultValue ?? null,
				sourceOf: decl.sourceOf ?? "能力包默认",
				confirmed: true,
			});
			continue;
		}
		const resolved: ResolvedInput = {
			...decl,
			source: decl.source ?? "user",
			value: null,
			sourceOf: "尚未确定",
			confirmed: false,
		};
		inputs.push(resolved);
		if (decl.required) missing.push(resolved);
	}
	if (namespaceHint && !inputs.some((item) => item.id === "namespace")) {
		inputs.push(
			cleanInputs.namespace
				? { ...namespaceHint, source: "user", sourceOf: "用户输入", value: cleanInputs.namespace }
				: namespaceHint,
		);
	}

	const mergedNormalized: Record<string, string> = { ...cleanInputs };
	for (const item of inputs) {
		if (item.value != null && item.confirmed !== false && mergedNormalized[item.id] === undefined) {
			mergedNormalized[item.id] = item.value;
		}
	}

	return {
		packId,
		workspace: probe.workspace,
		probe,
		inputs,
		missing,
		candidates,
		conflicts,
		inputConflicts: [],
		normalizedInputs: mergedNormalized,
		packVersion: pack.version,
		provenance: pack.provenance.map((p) => ({ repo: p.repo, path: p.path, version: p.version })),
	};
}

/** 真实解析 YAML 多文档；Kubernetes 只读 metadata，旧无 kind/apiVersion 配置兼容顶层 namespace。 */
export function parseNamespaceFromManifest(text: string): string | null {
	try {
		if (Buffer.byteLength(text, "utf8") > MANIFEST_MAX_BYTES)
			throw new ManifestInputError("manifest 超过 256 KiB 解析上限");
		const docs = parseAllDocuments(text, { strict: true, uniqueKeys: true, prettyErrors: false, merge: true });
		if (docs.length > 32) throw new ManifestInputError("manifest YAML 文档数量超过 32 个上限");
		const namespaces = new Set<string>();
		let resources = 0;
		const visit = (resource: unknown, depth = 0) => {
			if (++resources > 256 || depth > 16) throw new ManifestInputError("manifest 资源数量或嵌套超限");
			if (!resource || typeof resource !== "object" || Array.isArray(resource))
				throw new ManifestInputError("manifest 文档必须是映射对象");
			const obj = resource as Record<string, unknown>;
			const metadata = obj.metadata;
			if (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata))) {
				throw new ManifestInputError("manifest metadata 必须是映射对象");
			}
			const values = [(metadata as Record<string, unknown> | undefined)?.namespace];
			if (obj.kind === undefined && obj.apiVersion === undefined) values.push(obj.namespace);
			for (const value of values) {
				if (value === undefined) continue;
				if (typeof value !== "string" || !NAMESPACE.test(value))
					throw new ManifestInputError("manifest namespace 必须是合法字符串");
				namespaces.add(value);
			}
			if (typeof obj.kind === "string" && obj.kind.endsWith("List")) {
				if (!Array.isArray(obj.items)) throw new ManifestInputError("manifest List.items 必须是数组");
				for (const item of obj.items) visit(item, depth + 1);
			}
		};
		for (const doc of docs) {
			if (doc.errors.length || doc.warnings.length)
				throw new ManifestInputError("manifest YAML 解析失败（语法、重复键或标签错误）");
			if (doc.contents === null) continue;
			visit(doc.toJS({ maxAliasCount: 32 }));
		}
		if (namespaces.size > 1) throw new ManifestInputError("manifest 不同文档或资源的 namespace 冲突");
		return [...namespaces][0] ?? null;
	} catch (error) {
		if (error instanceof ManifestInputError) throw error;
		throw new ManifestInputError("manifest YAML 解析失败（别名、嵌套或结构错误）");
	}
}

function discoverInputValue(
	inputId: string,
	probe: WorkspaceProbe,
	namespaceHint: ResolvedInput | null,
): ResolvedInput | null {
	const has = (m: string) => probe.markers.includes(m) || probe.dirs.includes(m);
	switch (inputId) {
		case "validateCmd":
			// 裸文件名只是探测候选，不是已确认的验收命令：validate.py 可能不是唯一入口，run.py 更只是执行入口。
			// 标记 confirmed=false，交给 resolveTaskContext 归入 candidates，发起者确认前该输入仍算缺失。
			if (has("validate.py"))
				return {
					id: "validateCmd",
					label: "验收命令",
					required: true,
					source: "discovery",
					value: "validate.py",
					sourceOf: "发现 validate.py（候选，须发起者确认）",
					confirmed: false,
				};
			if (has("run.py"))
				return {
					id: "validateCmd",
					label: "验收命令",
					source: "discovery",
					value: "run.py",
					sourceOf: "发现 run.py（执行入口，验收命令仍需真实 --validate 入口；候选）",
					confirmed: false,
				};
			return null;
		case "deploy_yaml":
			for (const m of probe.deployManifests) {
				return {
					id: "deploy_yaml",
					label: "部署 YAML",
					required: true,
					source: "project-config",
					value: m,
					sourceOf: "发现部署 manifest（候选，须发起者确认）：" + m,
				};
			}
			return null;
		case "kubeconfig":
			if (probe.kubeconfigReady)
				return {
					id: "kubeconfig",
					label: "kubeconfig",
					required: true,
					source: "discovery",
					value: process.env.KUBECONFIG!,
					sourceOf: "KUBECONFIG 环境变量",
				};
			return null;
		case "namespace":
			return namespaceHint;
		default:
			return null;
	}
}

/**
 * 生成「只追问缺口」的注入摘要：只列已确认信息与真正缺失的必要项，不把整包知识塞进提示词。
 * 冲突项显式呈现（默认 vs 当前事实），由用户/模型决定，不静默选择。
 */
export function renderDiscoverySummary(ctx: TaskContext): string {
	const lines: string[] = [];
	if (ctx.error) {
		lines.push("error: " + ctx.error);
		return lines.join("\n");
	}
	lines.push("pack: " + ctx.packId + (ctx.packVersion ? "@" + ctx.packVersion : "") + " | workspace: " + ctx.workspace);
	if (ctx.probe.gitBranch || ctx.probe.gitHead) {
		lines.push("git: " + (ctx.probe.gitBranch || "") + (ctx.probe.gitHead ? "@" + ctx.probe.gitHead : ""));
	}
	if (ctx.probe.markers.length || ctx.probe.dirs.length) {
		lines.push("found: " + ([...ctx.probe.markers, ...ctx.probe.dirs].join(", ") || "(none)"));
	}
	const confirmed = ctx.inputs.filter((i) => i.value != null);
	if (confirmed.length) {
		lines.push("confirmed: " + confirmed.map((i) => i.id + "(" + i.source + ":" + i.value + ")").join(" "));
	}
	if (ctx.conflicts.length) {
		lines.push(
			"conflicts: " +
				ctx.conflicts
					.map((c) => c.inputId + " 默认=" + c.defaultValue + " 实际=" + c.resolvedValue + "(" + c.source + ")")
					.join("; "),
		);
	}
	if (ctx.candidates.length) {
		lines.push(
			"candidates(需发起者确认，未确认前视为缺失): " +
				ctx.candidates.map((c) => c.inputId + "=" + c.value + "（" + c.sourceOf + "）").join("; "),
		);
	}
	if (ctx.missing.length) {
		lines.push("missing(只问这些): " + ctx.missing.map((m) => m.id + ": " + (m.hint ?? m.label)).join("; "));
	} else {
		lines.push("missing: (none)");
	}
	lines.push("provenance: " + ctx.provenance.map((p) => p.repo + "@" + p.path + "#" + p.version).join(" | "));
	return lines.join("\n");
}
