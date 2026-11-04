/**
 * 只读执行身份。沿用 workspace-snapshot.ts 的 cwd 子树与 git add -A 的路径规则
 * （tracked + others --exclude-standard），直接哈希执行 bytes，避免写影子 index/Git 对象，
 * 也避免 Git clean filter、stat 缓存或 staged 名单替代工作树实际内容。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSensitiveTaskPath, normalizeTaskInputs, validateTaskHardConstraints } from "./discovery.js";
import { resolvePack } from "./packs.js";
import type { HardConstraint } from "./metrics.js";
import type { EnvironmentFingerprint } from "./recovery.js";

export class FingerprintBlockedError extends Error {
	constructor(public readonly code: "unstable" | "limit" | "unsafe-path" | "unsupported" | "read" | "contract") {
		super(`执行指纹受阻：${code}`);
		this.name = "FingerprintBlockedError";
	}
}

export interface WorkspaceFingerprintOptions {
	/** 相对于实际执行 cwd；可覆盖普通 ignore/产物排除，不可覆盖敏感排除。仅支持文件。 */
	dependencies?: readonly string[];
	/** 额外凭据文件/目录（如命名任意的 kubeconfig）；只排除，绝不读取内容。 */
	sensitivePaths?: readonly string[];
	maxFiles?: number;
	maxFileBytes?: number;
	maxTotalBytes?: number;
	timeoutMs?: number;
	/** 两次完整内容扫描不一致时最多重试次数，0..2。 */
	retries?: number;
}

export interface WorkspaceContentFingerprint {
	workspace: string;
	gitHead: string | null;
	contentHash: string;
	/** index 对象 ID/模式/路径的摘要；不读 index 中的敏感 blob。 */
	indexHash: string | null;
	fileCount: number;
}

const OUTPUTS = new Set([
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	".cache",
	"dist",
	"build",
	"coverage",
	"logs",
	"runs",
	".mini-harness",
]);
/**
 * 指纹算法版本：纳入 contentHash 组合。算法变化会使所有旧证据的 contentHash
 * 无法对等证明等价 → 旧证据自动失效并触发重新验证（保留任务与历史，不误判「未变化」）。
 * v2：已跟踪内容默认纳入（build/dist 等产物目录的排除只作用于未跟踪文件）。
 */
const FINGERPRINT_VERSION = 2;
const sensitive = isSensitiveTaskPath;
// 产物目录排除只应用于未跟踪文件；已跟踪的 build/code.py 修改必须被检测（见 scan()）。
const ignored = (relative: string) =>
	relative.split(path.sep).some((part) => OUTPUTS.has(part)) || /\.(log|pyc)$/.test(relative);
// token 指标/分词器身份不是凭据；不要因包含 token 子串漏掉验收输入。
const sensitiveInputKey = (key: string) =>
	/(?:^|[_-])(?:password|secret|credentials?|kubeconfig)(?:$|[_-])|(?:^|[_-])token$|^(?:api[_-]?key|authorization)$/i.test(
		key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"),
	);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => JSON.stringify(canonical(value));
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, v]) => [k, canonical(v)]),
		);
	}
	return value ?? null;
}

/** 抛错即未知/受阻，调用方不得把它变成空 hash 或“未变化”。不使用 mtime/size 缓存。 */
export function computeWorkspaceContentFingerprint(
	cwd: string,
	options: WorkspaceFingerprintOptions = {},
): WorkspaceContentFingerprint {
	try {
		return captureWorkspace(cwd, options);
	} catch (error) {
		if (error instanceof FingerprintBlockedError) throw error;
		// 不把文件内容、命令 stderr 或凭据路径带入状态/提示。
		throw new FingerprintBlockedError("read");
	}
}

function captureWorkspace(cwd: string, options: WorkspaceFingerprintOptions): WorkspaceContentFingerprint {
	const workspace = fs.realpathSync(cwd);
	if (!fs.statSync(workspace).isDirectory()) throw new FingerprintBlockedError("read");
	if (sensitive(workspace) || workspace === path.parse(workspace).root || workspace === fs.realpathSync(os.homedir())) {
		throw new FingerprintBlockedError("unsafe-path");
	}
	const limits = {
		files: options.maxFiles ?? 10_000,
		fileBytes: options.maxFileBytes ?? 8 * 1024 * 1024,
		totalBytes: options.maxTotalBytes ?? 128 * 1024 * 1024,
		ms: options.timeoutMs ?? 15_000,
		retries: options.retries ?? 1,
	};
	for (const [key, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < (key === "retries" ? 0 : 1)) throw new FingerprintBlockedError("limit");
	}
	if (limits.retries > 2) throw new FingerprintBlockedError("limit");
	const deadline = Date.now() + limits.ms;
	const sensitivePaths = (options.sensitivePaths ?? []).map((file) => path.resolve(workspace, file));
	const credentialIdentities = sensitivePaths.flatMap((file) => {
		try {
			const st = fs.statSync(file);
			return [{ dev: st.dev, ino: st.ino }];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return [];
		}
	});
	const blocked = (rel: string) => {
		const full = path.resolve(workspace, rel);
		return sensitive(rel) || sensitivePaths.some((file) => full === file || full.startsWith(file + path.sep));
	};
	if (blocked(".")) throw new FingerprintBlockedError("unsafe-path");
	const checkTime = () => {
		if (Date.now() >= deadline) throw new FingerprintBlockedError("limit");
	};
	const relativeOf = (file: string): string => {
		const rel = path.relative(workspace, path.resolve(workspace, file));
		if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || blocked(rel)) {
			throw new FingerprintBlockedError("unsafe-path");
		}
		return rel;
	};
	const explicit = new Set((options.dependencies ?? []).map(relativeOf));
	const git = (args: string[]) => {
		checkTime();
		return execFileSync("git", ["--no-optional-locks", "-C", workspace, ...args], {
			timeout: Math.max(1, deadline - Date.now()),
			maxBuffer: 8 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
			// Ambient Git overrides must not silently fingerprint another tree/index.
			env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
		});
	};
	let isGit = false;
	try {
		isGit = git(["rev-parse", "--is-inside-work-tree"]).trim() === "true";
	} catch (error) {
		// A failed Git probe inside a repository is not permission to fall back to a different scope.
		let dir = workspace;
		for (;;) {
			if (fs.existsSync(path.join(dir, ".git"))) throw error;
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}

	const scan = () => {
		const names = new Set<string>();
		const index: string[] = [];
		let head: string | null = null;
		let visited = 0;
		const budget = () => {
			checkTime();
			if (++visited > limits.files) throw new FingerprintBlockedError("limit");
		};
		if (isGit) {
			try {
				head = git(["rev-parse", "--verify", "--quiet", "HEAD"]).trim();
			} catch (error) {
				// --quiet returns 1 for unborn HEAD; other failures remain blocked.
				if ((error as { status?: number }).status !== 1) throw error;
			}
			for (const record of git(["ls-files", "--stage", "-z", "--", "."]).split("\0")) {
				if (!record) continue;
				budget();
				const tab = record.indexOf("\t");
				const meta = record.slice(0, tab);
				const rel = record.slice(tab + 1);
				// 已跟踪内容默认纳入（含 build/dist 等产物目录）；敏感路径仍排除。
				// 产物目录排除只作用于未跟踪文件：修改并重新暂存 build/code.py 必须改变指纹。
				if (blocked(rel)) continue;
				if (meta.startsWith("160000 ")) throw new FingerprintBlockedError("unsupported");
				if (!meta.endsWith(" 0")) throw new FingerprintBlockedError("unsupported");
				relativeOf(rel);
				names.add(rel);
				index.push(record);
			}
			for (const rel of git([
				"ls-files",
				"--others",
				"--exclude-standard",
				...[
					".ssh",
					".aws",
					".azure",
					".gcloud",
					"gcloud",
					".kube",
					".docker",
					"secret",
					"secrets",
					"credential",
					"credentials",
					...OUTPUTS,
				].map((dir) => `--exclude=${dir}/`),
				"-z",
				"--",
				".",
			]).split("\0")) {
				if (!rel) continue;
				budget();
				if (!blocked(rel) && !ignored(rel)) names.add(relativeOf(rel));
			}
		} else {
			const walk = (dir: string) => {
				if (fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(dir) !== dir) {
					throw new FingerprintBlockedError("unsafe-path");
				}
				const handle = fs.opendirSync(dir);
				try {
					for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
						budget();
						const rel = path.relative(workspace, path.join(dir, entry.name));
						if (blocked(rel) || ignored(rel)) continue;
						if (entry.isDirectory()) walk(path.join(dir, entry.name));
						else names.add(relativeOf(rel));
					}
				} finally {
					handle.closeSync();
				}
			};
			walk(workspace);
		}
		for (const rel of explicit) names.add(rel);
		const entries = new Map<string, unknown>();
		const stamps = new Map<string, string>();
		let totalBytes = 0;
		const stamp = (st: fs.Stats) => [st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs].join(":");
		const read = (rel: string, chain = new Set<string>()) => {
			checkTime();
			if (entries.has(rel)) return;
			if (chain.has(rel)) throw new FingerprintBlockedError("unsupported");
			if (entries.size + chain.size >= limits.files) throw new FingerprintBlockedError("limit");
			const full = path.join(workspace, rel);
			// Reject symlink ancestors, even when an explicit dependency bypasses ordinary ignores.
			let parent = path.dirname(full);
			while (parent !== workspace) {
				try {
					if (fs.lstatSync(parent).isSymbolicLink()) throw new FingerprintBlockedError("unsafe-path");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT" || explicit.has(rel)) throw error;
					entries.set(rel, ["missing"]);
					return;
				}
				parent = path.dirname(parent);
			}
			let before: fs.Stats;
			try {
				before = fs.lstatSync(full);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT" || explicit.has(rel)) throw error;
				entries.set(rel, ["missing"]);
				return;
			}
			if (before.isSymbolicLink()) {
				const target = fs.readlinkSync(full);
				const targetRel = relativeOf(path.resolve(path.dirname(full), target));
				chain.add(rel);
				read(targetRel, chain);
				chain.delete(rel);
				entries.set(rel, ["symlink", target]);
			} else if (before.isFile()) {
				if (credentialIdentities.some((st) => st.dev === before.dev && st.ino === before.ino)) {
					if (explicit.has(rel)) throw new FingerprintBlockedError("unsafe-path");
					entries.set(rel, ["excluded-credential"]);
					return;
				}
				if (before.size > limits.fileBytes || totalBytes + before.size > limits.totalBytes) {
					throw new FingerprintBlockedError("limit");
				}
				const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
				try {
					if (stamp(fs.fstatSync(fd)) !== stamp(before)) throw new FingerprintBlockedError("unstable");
					const digest = createHash("sha256");
					const buffer = Buffer.alloc(64 * 1024);
					let bytes = 0;
					for (;;) {
						checkTime();
						const count = fs.readSync(fd, buffer, 0, buffer.length, null);
						if (!count) break;
						bytes += count;
						totalBytes += count;
						if (bytes > limits.fileBytes || totalBytes > limits.totalBytes) throw new FingerprintBlockedError("limit");
						digest.update(buffer.subarray(0, count));
					}
					if (bytes !== before.size || stamp(fs.fstatSync(fd)) !== stamp(before))
						throw new FingerprintBlockedError("unstable");
					entries.set(rel, ["file", before.mode & 0o111, digest.digest("hex")]);
				} finally {
					fs.closeSync(fd);
				}
			} else {
				throw new FingerprintBlockedError("unsupported");
			}
			if (stamp(fs.lstatSync(full)) !== stamp(before)) throw new FingerprintBlockedError("unstable");
			stamps.set(rel, stamp(before));
		};
		for (const rel of [...names].sort()) read(rel);
		return {
			head,
			indexHash: isGit ? hash(stable(index.sort())) : null,
			contentHash: hash(stable(Object.fromEntries(entries))),
			stamps: stable(Object.fromEntries(stamps)),
			fileCount: entries.size,
		};
	};
	for (let attempt = 0; attempt <= limits.retries; attempt++) {
		try {
			const first = scan();
			const second = scan();
			if (stable(first) !== stable(second) || fs.realpathSync(cwd) !== workspace)
				throw new FingerprintBlockedError("unstable");
			return {
				workspace,
				gitHead: second.head,
				contentHash: second.contentHash,
				indexHash: second.indexHash,
				fileCount: second.fileCount,
			};
		} catch (error) {
			if (!(error instanceof FingerprintBlockedError) || error.code !== "unstable" || attempt === limits.retries)
				throw error;
		}
	}
	throw new FingerprintBlockedError("unstable");
}

export interface ExecutionFingerprintInput {
	workspace: string;
	packId?: string | null;
	/** 兼容旧调用者；仅用于迁移，当前版本始终从 resolvePack 读取。 */
	packVersion?: string | null;
	goal?: string;
	criteria?: string | null;
	validateCmd?: string | null;
	precheckCmd?: string | null;
	inputs?: Record<string, unknown> | null;
	primaryMetric?: string | null;
	metricDirection?: string | null;
	metricUnit?: string | null;
	metricPrecision?: number | null;
	metricThreshold?: number | null;
	metricThresholdOp?: string | null;
	metricTolerance?: number | null;
	metricScenario?: string | null;
	hardConstraints?: HardConstraint[] | null;
	mode?: string;
	useReviewer?: boolean;
	artifactRoots?: readonly string[];
	validatorIdentity?: string | null;
	/** 调用者显式提供非敏感目标身份（如 pod UID / image digest），不读 kubeconfig。 */
	targetIdentity?: Record<string, string>;
	dependencies?: readonly string[];
	freshWorkspace?: boolean;
}

/**
 * 只从字面量命令及不改变 cwd 的命令段收集可证明的文件入口，不执行或重写 shell。
 * 支持边界：展开、重定向、动态模块、内联代码及 shell 包装器保持兼容，仍绑定完整
 * 命令原文 + workspace 快照；不声称静态覆盖其动态/忽略文件依赖。已有
 * inputs.validatorPath/configPath/dataConfig 或内部 dependencies 可补充这些文件身份。
 */
function commandFileDependencies(command: string, workspace: string): string[] {
	if (!command.trim()) return [];
	if (command.length > 64 * 1024) throw new FingerprintBlockedError("limit");
	const segments: string[][] = [];
	let words: string[] = [];
	let word = "";
	let started = false;
	let quote = "";
	const unsupported = () => literalSegmentsFileDependencies([...segments, words], workspace);
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote === "'") {
			if (ch === "'") quote = "";
			else word += ch;
		} else if (ch === "\\") {
			const next = command[++i];
			if (next === undefined || next === "\n" || next === "\r") return unsupported();
			word += quote === '"' && !["$", "`", '"', "\\"].includes(next) ? "\\" + next : next;
			started = true;
		} else if (ch === "$" || ch === "`" || ch === "\0") {
			return unsupported();
		} else if (quote === '"') {
			if (ch === '"') quote = "";
			else word += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			started = true;
		} else if (";&|\r\n".includes(ch)) {
			if (started) words.push(word);
			if (words.length) segments.push(words);
			words = [];
			word = "";
			started = false;
		} else if ("<>".includes(ch)) {
			if (started) words.push(word);
			return unsupported();
		} else if ("(){}[]*?~#".includes(ch)) {
			return unsupported();
		} else if (ch === " " || ch === "\t") {
			if (started) words.push(word);
			word = "";
			started = false;
		} else {
			word += ch;
			started = true;
		}
	}
	if (quote) return unsupported();
	if (started) words.push(word);
	if (words.length) segments.push(words);
	return literalSegmentsFileDependencies(segments, workspace);
}

function literalSegmentsFileDependencies(segments: string[][], workspace: string): string[] {
	const files: string[] = [];
	for (const segment of segments) {
		// Following commands may execute in another cwd after these constructs; do not guess that mapping.
		if (
			["cd", "pushd", "popd", "builtin", "eval", "exec", "source", ".", "env", "command", "sudo", "xargs"].includes(
				segment[0] ?? "",
			) ||
			segment[0]?.includes("=")
		)
			break;
		files.push(...literalCommandFileDependencies(segment, workspace));
	}
	return files;
}

function literalCommandFileDependencies(words: string[], workspace: string): string[] {
	const unsupported = (): string[] => [];
	const executable = words[0];
	if (!executable || executable.includes("=")) return unsupported();
	const name = path.basename(executable);
	if (["cd", "eval", "exec", "source", ".", "env", "command", "sudo", "xargs"].includes(name)) return unsupported();
	const files: string[] = [];
	const interpreter = /^(?:python(?:\d+(?:\.\d+)*)?|node(?:js)?|bash|sh|dash|zsh|ruby|perl)$/.test(name);
	// A PATH interpreter belongs to the runtime environment. Local interpreter binaries still bind bytes.
	const executableRelative = path.relative(path.resolve(workspace), path.resolve(workspace, executable));
	const localExecutable = executableRelative !== ".." && !executableRelative.startsWith(`..${path.sep}`);
	if (executable.includes("/") && (!interpreter || !path.isAbsolute(executable) || localExecutable)) {
		files.push(executable);
	}
	let argumentStart = 1;
	if (interpreter) {
		if (words.length === 2 && ["--version", "-V", "--help", "-h"].includes(words[1]!)) return files;
		let index = 1;
		const flags = name.startsWith("python")
			? new Set(["-u", "-B", "-E", "-I", "-s", "-S", "-O", "-OO", "-q", "-v", "-b", "-bb"])
			: new Set(["--no-warnings", "--trace-warnings"]);
		while (words[index]?.startsWith("-") && words[index] !== "--") {
			// Inline code is already bound by the raw command hash; do not parse it as shell or a filename.
			if (!flags.has(words[index]!)) return unsupported();
			index++;
		}
		if (words[index] === "--") index++;
		const script = words[index];
		if (!script || script === "-") return unsupported();
		files.push(script);
		argumentStart = index + 1;
	}
	// Literal output builtins do not interpret their operands as files.
	if (!interpreter && ["printf", "echo", "true", "false", ":"].includes(name)) return files;
	for (const arg of words.slice(argumentStart)) {
		const file = arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
		if (!file || file.startsWith("-")) continue;
		// Only existing literal file operands are identities; do not guess missing output paths.
		// Resolve within workspace before stat, so a command cannot cause probing arbitrary user paths.
		const relative = path.relative(path.resolve(workspace), path.resolve(workspace, file));
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			continue;
		}
		try {
			const stat = fs.lstatSync(path.resolve(workspace, file));
			if (stat.isFile() || stat.isSymbolicLink()) files.push(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new FingerprintBlockedError("read");
		}
	}
	return files;
}

/** 与 recovery.EnvironmentFingerprint 兼容；调用于真正执行前及恢复核对，不在列表轮询扫描。 */
export function computeExecutionFingerprint(
	input: ExecutionFingerprintInput,
	options: WorkspaceFingerprintOptions = {},
): EnvironmentFingerprint {
	const norm = normalizeTaskInputs(input);
	if (!norm.ok || validateTaskHardConstraints(input.hardConstraints)) throw new FingerprintBlockedError("contract");
	for (const value of [input.metricPrecision, input.metricThreshold, input.metricTolerance]) {
		if (value != null && (typeof value !== "number" || !Number.isFinite(value))) {
			throw new FingerprintBlockedError("contract");
		}
	}
	const pack = input.packId ? resolvePack(input.packId) : null;
	if (input.packId && !pack) throw new FingerprintBlockedError("contract");
	const dependencies = [...(options.dependencies ?? []), ...(input.dependencies ?? [])];
	for (const command of [norm.validateCmd, norm.precheckCmd]) {
		dependencies.push(...commandFileDependencies(command, input.workspace));
	}
	for (const key of ["deploy_yaml", "manifest", "validatorPath", "configPath", "dataConfig"]) {
		if (norm.inputs[key]) dependencies.push(norm.inputs[key]!);
	}
	const sensitivePaths = [
		...(options.sensitivePaths ?? []),
		...(process.env.KUBECONFIG?.split(path.delimiter).filter(Boolean) ?? []),
		...(norm.inputs.kubeconfig ? [norm.inputs.kubeconfig] : []),
	];
	const snapshot = computeWorkspaceContentFingerprint(input.workspace, { ...options, dependencies, sensitivePaths });
	const safeInputs = Object.fromEntries(Object.entries(norm.inputs).filter(([key]) => !sensitiveInputKey(key)));
	const contract = {
		inputs: safeInputs,
		goal: input.goal ?? "",
		criteria: input.criteria ?? "",
		mode: input.mode ?? "code",
		useReviewer: input.useReviewer ?? true,
		artifactRoots: input.artifactRoots ?? [],
		validatorIdentity: input.validatorIdentity ?? null,
		primaryMetric: input.primaryMetric ?? null,
		metricDirection: input.metricDirection ?? null,
		metricUnit: input.metricUnit ?? null,
		metricPrecision: input.metricPrecision ?? null,
		metricThreshold: input.metricThreshold ?? null,
		metricThresholdOp: input.metricThresholdOp ?? null,
		metricTolerance: input.metricTolerance ?? null,
		metricScenario: input.metricScenario ?? null,
		hardConstraints: input.hardConstraints ?? [],
		dependencies: [
			...new Set(dependencies.map((file) => path.relative(snapshot.workspace, path.resolve(snapshot.workspace, file)))),
		].sort(),
		// Exclude display titles/summaries; include the currently loaded executable acceptance contract.
		pack: pack
			? {
					id: pack.id,
					version: pack.version,
					provenance: pack.provenance.map(({ repo, path: sourcePath, version }) => ({
						repo,
						path: sourcePath,
						version,
					})),
					primaryMetric: pack.primaryMetric,
					metricDirection: pack.metricDirection,
					metricUnit: pack.metricUnit,
					metricThreshold: pack.metricThreshold,
					metricScenario: pack.metricScenario,
					hardConstraints: pack.hardConstraints,
					metric: pack.knowledge.metric,
					evidence: pack.knowledge.evidence,
					inputs: pack.inputs.map(({ id, required, source, defaultValue }) => ({ id, required, source, defaultValue })),
				}
			: null,
	};
	const target = input.targetIdentity ?? {};
	if (Object.keys(target).some(sensitiveInputKey)) {
		throw new FingerprintBlockedError("contract");
	}
	return {
		workspace: snapshot.workspace,
		gitHead: snapshot.gitHead,
		// Index identity is separate from worktree bytes, but both bind reconstructable evidence.
		// FINGERPRINT_VERSION 使算法变化显式区分指纹版本（旧证据无法对等证明 → 重新验证）。
		contentHash: hash(stable([FINGERPRINT_VERSION, snapshot.contentHash, snapshot.indexHash])),
		packId: pack?.id ?? null,
		packVersion: pack?.version ?? null,
		inputsHash: hash(stable(contract)),
		envHash: hash(
			stable({
				platform: process.platform,
				arch: process.arch,
				node: process.version,
				target,
				engine: process.env.HARNESS_ENGINE ?? "",
				sdk: process.env.HARNESS_SDK ?? process.env.PI_WEB_SDK ?? "",
			}),
		),
	};
}
