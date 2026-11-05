/**
 * kubeconfig 发现、探测与「任务级集群绑定」（自 mini-harness `loop/cluster-config.ts` +
 * `loop/discovery.ts` 的 kubeconfig 部分移植，按 Comate CLI 形态裁剪）。
 *
 * 优先级（发现与绑定同一套）：
 *   1. explicit  任务显式输入 / --kubeconfig（单文件）
 *   2. env       进程环境 KUBECONFIG（保留多路径语义）
 *   3. default   ~/.kube/config（不设 KUBECONFIG，由 kubectl 默认解析）
 *   4. none      未配置
 *
 * 绑定（bind）把当前配置固定成自包含快照：优先 `kubectl config view --raw --flatten --minify`
 * （无 current-context 时退整份展开）；没有 kubectl 时，单文件且不含相对凭据引用才允许按字节复制，
 * 否则 blocked（不让它悄悄解析到另一份凭据）。快照 0600、目录 0700，之后外部改写原文件不影响任务。
 * 核实不了（快照缺失 / 被改动 / 绑定 blocked）时，任务子进程的 KUBECONFIG 指向必然连不上的
 * 占位配置，而不是当前全局配置。
 *
 * 安全：凭据内容不出本模块；对外只有归类后的稳定错误码、固定文案和白名单元数据
 * （来源、context 名、路径个数），kubectl stdout/stderr 不外传。
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BLOCKED_KUBECONFIG = [
	"apiVersion: v1",
	"kind: Config",
	"clusters:",
	"- name: harness-cluster-binding-blocked",
	"  cluster:",
	"    server: https://harness-cluster-binding-blocked.invalid",
	"contexts:",
	"- name: harness-cluster-binding-blocked",
	"  context:",
	"    cluster: harness-cluster-binding-blocked",
	"    user: harness-cluster-binding-blocked",
	"users:",
	"- name: harness-cluster-binding-blocked",
	"  user: {}",
	"current-context: harness-cluster-binding-blocked",
	"",
].join("\n");

const MESSAGES = {
	"not-configured": "未找到集群配置",
	"no-kubectl": "本机找不到 kubectl（只能按文件快照绑定，无法探测连通性）",
	ok: "API 可达（/version 探测成功）",
	unauthorized: "认证失败（401）：凭据无效或已过期",
	forbidden: "API 已响应，但当前凭据无权访问 /version（403）",
	tls: "TLS 校验失败",
	network: "网络不可达或连接被拒绝",
	timeout: "探测超时",
	"config-invalid": "配置无效、文件缺失或没有可用的 context",
	error: "探测失败（未分类错误）",
};

const SNAPSHOT_MAX_BYTES = 1024 * 1024;
const KUBECTL_TIMEOUT_MS = 5000;

export function sha256Of(data) {
	return createHash("sha256").update(data).digest("hex");
}

function stripQuotes(v) {
	const s = String(v ?? "").trim();
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
	return s;
}

function safeName(raw) {
	const s = stripQuotes(raw);
	return /^[\w.@:/-]{1,128}$/.test(s) ? s : null;
}

/** 按 kubectl 的退出情况与 stderr 归类（stderr 只在这里读，不外传）。 */
export function classifyKubectlFailure(err, stderr) {
	if (!err) return "ok";
	if (err.code === "ENOENT") return "no-kubectl";
	if (err.killed || err.signal === "SIGKILL" || err.signal === "SIGTERM") return "timeout";
	const s = String(stderr ?? "");
	if (/\b401\b|Unauthorized|must be logged in|provide credentials|token (?:has )?expired|invalid bearer token/i.test(s))
		return "unauthorized";
	if (/\b403\b|Forbidden/i.test(s)) return "forbidden";
	if (/context deadline exceeded|Client\.Timeout|i\/o timeout|handshake timeout|timed out/i.test(s)) return "timeout";
	if (/x509|certificate|tls:/i.test(s)) return "tls";
	if (
		/connection refused|was refused|no such host|network is unreachable|no route to host|dial tcp|Unable to connect to the server|connection reset|\bEOF\b/i.test(
			s,
		)
	)
		return "network";
	if (
		/no configuration has been provided|invalid configuration|error loading config|current-context|context .*(?:does not exist|not found)|cluster has no server|no such file|yaml:|json:/i.test(
			s,
		)
	)
		return "config-invalid";
	return "error";
}

function kubectl(args, env, timeoutMs = KUBECTL_TIMEOUT_MS) {
	try {
		const stdout = execFileSync("kubectl", args, {
			env,
			timeout: timeoutMs,
			killSignal: "SIGKILL",
			encoding: "utf8",
			maxBuffer: 512 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, stdout: String(stdout ?? "") };
	} catch (error) {
		return {
			ok: false,
			code: classifyKubectlFailure(error, error?.stderr),
			stdout: String(error?.stdout ?? ""),
		};
	}
}

/**
 * 轻量 kubeconfig 摘要：只取名字与结构标记，不碰凭据内容。
 * 用于发现展示、context 校验与绑定前的安全检查。
 */
export function summarizeKubeconfig(text) {
	const lines = String(text ?? "").split(/\r?\n/);
	const summary = {
		currentContext: null,
		contexts: [],
		clusters: [],
		users: [],
		servers: [],
		externalCredentials: false,
		relativeCredentialRefs: false,
	};
	let section = null;
	let pendingServer = null;
	for (const line of lines) {
		const top = /^([A-Za-z][\w-]*):(?:\s*(.*))?$/.exec(line);
		if (top) {
			section = top[1];
			if (section === "current-context") summary.currentContext = safeName(top[2]);
			continue;
		}
		if (!section) continue;
		if (section === "clusters") {
			const srv = /^\s*server:\s*(.+)$/.exec(line);
			if (srv) pendingServer = stripQuotes(srv[1]).slice(0, 200);
		}
		const name = /^\s*-?\s*name:\s*(.+)$/.exec(line);
		if (!name) continue;
		const v = safeName(name[1]);
		if (!v) continue;
		if (section === "contexts") summary.contexts.push(v);
		else if (section === "clusters") {
			summary.clusters.push(v);
			if (pendingServer) summary.servers.push({ name: v, server: pendingServer });
		} else if (section === "users") summary.users.push(v);
	}
	summary.externalCredentials = /^\s*(?:exec|auth-provider|tokenFile):/m.test(text);
	// 相对路径的凭据引用在快照目录下会解析不到原文件 → 快照固定不了。
	summary.relativeCredentialRefs =
		/^\s*(?:certificate-authority|client-certificate|client-key|tokenFile):\s*["']?(?![/"'])\S/m.test(text);
	return summary;
}

function defaultPath(home) {
	return path.join(home, ".kube", "config");
}

function workspaceKubeconfigCandidates(workspace) {
	if (!workspace) return [];
	const names = ["kubeconfig", "kubeconfig.yaml", "kubeconfig.yml", ".kube/config", "conf/kubeconfig", "deploy/kubeconfig"];
	const out = [];
	for (const name of names) {
		const full = path.join(workspace, name);
		if (fs.existsSync(full)) out.push(full);
	}
	return out;
}

/**
 * 列出所有可发现的 kubeconfig 来源（只读：stat + 读文件做摘要，不执行任何命令）。
 * target 是「新任务/绑定时实际会用的那一份」，按 explicit > env > default 解析。
 */
export function discoverKubeconfigs({ explicit, env = process.env, home = os.homedir(), workspace } = {}) {
	const candidates = [];
	const add = (source, file, isTarget) => {
		let exists = false;
		let size = null;
		let mtime = null;
		let summary = null;
		let error = null;
		try {
			const st = fs.statSync(file);
			exists = st.isFile();
			size = st.size;
			mtime = new Date(st.mtimeMs).toISOString();
			if (exists && size <= SNAPSHOT_MAX_BYTES) {
				summary = summarizeKubeconfig(fs.readFileSync(file, "utf8"));
			} else if (exists) {
				error = "文件超过 1 MiB，跳过摘要";
			}
		} catch (e) {
			error = e.code === "ENOENT" ? "文件不存在" : "无法读取该路径";
		}
		candidates.push({ source, path: file, exists, size, mtime, isTarget, summary, error });
	};

	const envPaths = String(env.KUBECONFIG ?? "").split(path.delimiter).filter(Boolean);
	const hasExplicit = !!explicit;

	const target = (() => {
		if (hasExplicit) return { source: "explicit", kubeconfig: explicit, paths: [explicit], shadowed: envPaths.length ? ["env"] : [] };
		if (envPaths.length) return { source: "env", kubeconfig: String(env.KUBECONFIG), paths: envPaths, shadowed: fs.existsSync(defaultPath(home)) ? ["default"] : [] };
		if (fs.existsSync(defaultPath(home))) return { source: "default", kubeconfig: null, paths: [defaultPath(home)], shadowed: [] };
		return { source: "none", kubeconfig: null, paths: [], shadowed: [] };
	})();

	if (hasExplicit) add("explicit", explicit, target.source === "explicit");
	for (const p of envPaths) add("env", p, target.source === "env");
	if (fs.existsSync(defaultPath(home))) add("default", defaultPath(home), target.source === "default");
	for (const p of workspaceKubeconfigCandidates(workspace)) {
		// 工作区候选只做展示（避免自动捡起仓库里的凭据文件）；与已列出的路径去重。
		if (!candidates.some((c) => path.resolve(c.path) === path.resolve(p))) add("workspace", p, false);
	}

	return {
		target: {
			source: target.source,
			kubeconfig: target.kubeconfig,
			paths: target.paths,
			pathCount: target.paths.length,
			shadowed: target.shadowed,
		},
		candidates,
	};
}

/** 探测：只证明 API 可达且凭据被接受（GET /version），不代表业务 namespace 权限齐全。 */
export function probeKubeconfig(target, { env = process.env } = {}) {
	if (target.source === "none") return { code: "not-configured", connected: false, message: MESSAGES["not-configured"], context: null, serverVersion: null };
	const runEnv = { ...env };
	if (target.kubeconfig) runEnv.KUBECONFIG = target.kubeconfig;
	else delete runEnv.KUBECONFIG;
	const res = kubectl(["get", "--raw=/version", "--request-timeout=5s"], runEnv);
	const base = { context: readContext(target, env), serverVersion: null };
	if (!res.ok) return { code: res.code, connected: false, message: MESSAGES[res.code] ?? MESSAGES.error, ...base };
	let serverVersion = null;
	try {
		const v = JSON.parse(res.stdout)?.gitVersion;
		serverVersion = typeof v === "string" && /^v?\d+\.\d+(?:\.\d+)?[\w.+-]{0,40}$/.test(v) ? v : null;
	} catch {
		// 忽略：探测成功但版本格式不识别
	}
	return { code: "ok", connected: true, message: MESSAGES.ok, ...base, serverVersion };
}

function readContext(target, env) {
	const file = target.paths?.[0];
	if (!file) return null;
	try {
		return summarizeKubeconfig(fs.readFileSync(file, "utf8")).currentContext;
	} catch {
		return null;
	}
}

function snapshotDir(dataDir) {
	const dir = path.join(dataDir, "clusters");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(dir, 0o700);
	} catch {
		// 非 POSIX 文件系统忽略
	}
	return dir;
}

/** 必然连不上的占位配置：绑定 none / blocked 时任务一律使用它，防止捡到全局配置。 */
export function blockedKubeconfigPath(dataDir) {
	const file = path.join(snapshotDir(dataDir), "blocked.yaml");
	try {
		if (!fs.existsSync(file)) fs.writeFileSync(file, BLOCKED_KUBECONFIG, { mode: 0o600 });
	} catch {
		// 写不了占位文件：返回路径同样不会落到全局配置上
	}
	return file;
}

function readSmallFile(file) {
	const st = fs.statSync(file);
	if (!st.isFile()) throw new Error("不是普通文件");
	if (st.size > SNAPSHOT_MAX_BYTES) throw new Error("超过 1 MiB");
	return fs.readFileSync(file, "utf8");
}

function writeSnapshot(dir, taskId, text) {
	const file = path.join(dir, `bound-${taskId}-${Date.now()}-${randomBytes(3).toString("hex")}.yaml`);
	fs.writeFileSync(file, text, { mode: 0o600, flag: "wx" });
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// 忽略
	}
	return file;
}

/**
 * 任务级绑定：固定「当前实际使用的配置」。返回可写入任务记录的白名单字段。
 * 同一个任务重复绑定应先 releaseTaskBinding 释放旧快照。
 */
export function bindTaskCluster({ dataDir, taskId, target, env = process.env, context = null, sourceOverride = null }) {
	const dir = snapshotDir(dataDir);
	const base = {
		source: sourceOverride ?? target.source,
		status: "none",
		reason: null,
		context: null,
		file: null,
		sha256: null,
		externalCredentials: false,
		createdAt: new Date().toISOString(),
		verifiedAt: null,
	};
	const blocked = (reason, extra = {}) => ({ ...base, status: "blocked", reason, ...extra });

	if (target.source === "none" || target.paths.length === 0) return { ...base, status: "none" };

	if (target.source === "explicit" && target.paths.length === 1) {
		// 显式单文件：能复制就复制（不可变快照），kubectl 可用时再尝试 flatten。
		let text = null;
		try {
			text = readSmallFile(target.paths[0]);
		} catch {
			return blocked("snapshot-missing");
		}
		const summary = summarizeKubeconfig(text);
		const flattened = tryFlatten(target, env);
		const snapshot = flattened ?? text;
		const snapSummary = summarizeKubeconfig(snapshot);
		if (!snapSummary.clusters.length) return blocked("config-invalid");
		if (snapSummary.relativeCredentialRefs) return blocked("snapshot-unpinnable");
		const ctx = pickContext(snapSummary, context);
		if (ctx.error) return blocked("context-not-found", { availableContexts: snapSummary.contexts });
		const finalText = ctx.context ? setCurrentContext(snapshot, ctx.context) : snapshot;
		const file = writeSnapshot(dir, taskId, finalText);
		return {
			...base,
			status: "pinned",
			context: ctx.context ?? snapSummary.currentContext,
			file,
			sha256: sha256Of(finalText),
			externalCredentials: snapSummary.externalCredentials,
			flattened: !!flattened,
			verifiedAt: new Date().toISOString(),
		};
	}

	// env / default（可能多路径）：必须经 kubectl 展开合并。
	const flattened = tryFlatten(target, env);
	if (!flattened) {
		// 没有 kubectl：仅当单路径且不含相对凭据引用时按字节复制，否则拒绝固定。
		if (target.paths.length === 1) {
			let text = null;
			try {
				text = readSmallFile(target.paths[0]);
			} catch {
				return blocked("snapshot-missing");
			}
			const summary = summarizeKubeconfig(text);
			if (!summary.clusters.length) return blocked("config-invalid");
			if (summary.relativeCredentialRefs) return blocked("snapshot-unpinnable");
			const ctx = pickContext(summary, context);
			if (ctx.error) return blocked("context-not-found", { availableContexts: summary.contexts });
			const finalText = ctx.context ? setCurrentContext(text, ctx.context) : text;
			const file = writeSnapshot(dir, taskId, finalText);
			return {
				...base,
				status: "pinned",
				context: ctx.context ?? summary.currentContext,
				file,
				sha256: sha256Of(finalText),
				externalCredentials: summary.externalCredentials,
				flattened: false,
				verifiedAt: new Date().toISOString(),
			};
		}
		return blocked("no-kubectl");
	}

	const summary = summarizeKubeconfig(flattened);
	if (!summary.clusters.length) return blocked("config-invalid");
	if (summary.relativeCredentialRefs) return blocked("snapshot-unpinnable");
	const ctx = pickContext(summary, context);
	if (ctx.error) return blocked("context-not-found", { availableContexts: summary.contexts });
	const finalText = ctx.context ? setCurrentContext(flattened, ctx.context) : flattened;
	const file = writeSnapshot(dir, taskId, finalText);
	return {
		...base,
		status: "pinned",
		context: ctx.context ?? summary.currentContext,
		file,
		sha256: sha256Of(finalText),
		externalCredentials: summary.externalCredentials,
		flattened: true,
		verifiedAt: new Date().toISOString(),
	};
}

function tryFlatten(target, env) {
	const runEnv = { ...env };
	if (target.kubeconfig) runEnv.KUBECONFIG = target.kubeconfig;
	else delete runEnv.KUBECONFIG;
	let res = kubectl(["config", "view", "--raw", "--flatten", "--minify"], runEnv);
	// 没有 current-context 时 --minify 会失败：退回整份展开（多 context 也一并固定）。
	if (!res.ok && res.code !== "no-kubectl") res = kubectl(["config", "view", "--raw", "--flatten"], runEnv);
	if (!res.ok) return null;
	if (!/^\s*apiVersion:/m.test(res.stdout) || !/^\s*clusters:/m.test(res.stdout)) return null;
	return res.stdout;
}

function pickContext(summary, requested) {
	if (!requested) return { context: summary.currentContext ?? null };
	if (!summary.contexts.includes(requested)) return { error: "context-not-found" };
	return { context: requested };
}

/** 把快照的 current-context 改成指定 context（仅文本层改写，凭据不动）。 */
function setCurrentContext(text, ctx) {
	const line = `current-context: ${ctx}`;
	if (/^current-context:.*$/m.test(text)) return text.replace(/^current-context:.*$/m, line);
	return `${text.replace(/\s*$/, "")}\n${line}\n`;
}

/**
 * 核实绑定：快照仍在且内容未变才算 pinned；否则改判 blocked（缺失 / 被改动）。
 * 返回更新后的绑定（调用方负责写回任务记录）。
 */
export function verifyBinding(binding, { probe = false, env = process.env } = {}) {
	if (!binding) return { binding: null, ok: false, reason: "not-bound" };
	if (binding.status === "none") return { binding, ok: true, reason: null };
	if (binding.status !== "pinned" || !binding.file) {
		return { binding, ok: false, reason: binding.reason ?? "blocked" };
	}
	let sha = null;
	try {
		sha = sha256Of(fs.readFileSync(binding.file));
	} catch {
		sha = null;
	}
	if (!sha) {
		binding.status = "blocked";
		binding.reason = "snapshot-missing";
		return { binding, ok: false, reason: binding.reason };
	}
	if (sha !== binding.sha256) {
		binding.status = "blocked";
		binding.reason = "snapshot-changed";
		return { binding, ok: false, reason: binding.reason };
	}
	const updated = { ...binding, verifiedAt: new Date().toISOString() };
	if (probe) {
		const target = { source: binding.source, kubeconfig: binding.file, paths: [binding.file] };
		updated.probe = probeKubeconfig(target, { env });
	}
	return { binding: updated, ok: true, reason: null };
}

/** 任务子进程应使用的 KUBECONFIG：核实通过 → 快照；否则 → 必然连不上的占位配置。 */
export function kubeconfigForTask(binding, dataDir) {
	if (!binding) return null;
	if (binding.status === "pinned" && binding.file) {
		try {
			const sha = sha256Of(fs.readFileSync(binding.file));
			if (sha === binding.sha256) return binding.file;
		} catch {
			// 落到占位
		}
	}
	return blockedKubeconfigPath(dataDir);
}

/** 释放任务绑定：删快照文件（占位配置共享，不删）。 */
export function releaseTaskBinding(binding) {
	if (!binding?.file) return;
	try {
		if (path.basename(binding.file).startsWith("bound-")) fs.rmSync(binding.file, { force: true });
	} catch {
		// 删不掉的快照留给人工清理
	}
}

export function clusterMessages() {
	return { ...MESSAGES };
}
