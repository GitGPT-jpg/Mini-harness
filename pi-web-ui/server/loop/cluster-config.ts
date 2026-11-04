/**
 * 集群连接配置：「连接集群」状态与新任务所用 kubeconfig 的唯一事实源。
 *
 * 优先级（Web 探测与新任务同一套，见 target()）：
 *   1. app     Web 导入、应用保存的单文件配置（<dataDir>/kubeconfig.d/ 下的不可变版本；
 *              兼容旧版的 <dataDir>/kubeconfig）；
 *   2. env     服务进程启动时继承的 KUBECONFIG，保留多路径语义，原样交给 kubectl 解析；
 *   3. default ~/.kube/config（不设 KUBECONFIG，由 kubectl 默认解析）；
 *   4. none    未配置。
 * 服务启动后，别的终端里 export 的 KUBECONFIG 不会进入本进程；界面按 source 提示更新方式。
 * 每次导入写新文件、不覆盖旧文件：已绑定旧版本的任务（bind）继续指向原目标，释放后才回收。
 *
 * 探测用 `kubectl get --raw=/version`：只证明 API 可达且凭据被接受，不代表业务 namespace 权限齐全。
 * 安全：kubectl 的 stdout/stderr、异常文本、上传内容都不出本模块；对外只有稳定错误码、
 * 固定文案和白名单元数据（来源、context 名、服务端版本号、路径个数）。
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

export type ClusterSource = "app" | "env" | "default" | "none";
export type ClusterCode =
	| "not-configured"
	| "no-kubectl"
	| "ok"
	| "unauthorized"
	| "forbidden"
	| "tls"
	| "network"
	| "timeout"
	| "config-invalid"
	| "error";

/** GET /api/mini-harness/cluster 的返回；字段全部是白名单，不含 kubectl 原始输出。 */
export interface ClusterStatus {
	configured: boolean;
	/** API 探测（/version）成功。 */
	connected: boolean;
	code: ClusterCode;
	/** 按 code 取的固定文案。 */
	message: string;
	source: ClusterSource;
	/** env 来源时 KUBECONFIG 的路径个数（不回传路径本身）。 */
	envPathCount: number;
	/** 存在但被更高优先级遮住的来源（清除 Web 配置后会回退到它们）。 */
	shadowed: ClusterSource[];
	context: string | null;
	serverVersion: string | null;
	/** 配置代次：导入/清除 +1；前端据此与 instance 丢弃过期结果。 */
	generation: number;
	instance: string;
	checkedAt: string;
}

/** 新任务应使用的配置。kubeconfig=null 表示不设 KUBECONFIG（kubectl 默认解析）。 */
export interface ClusterTarget {
	source: ClusterSource;
	generation: number;
	kubeconfig: string | null;
}

export interface ClusterConfigOptions {
	dataDir: string;
	/** 被管理的进程环境（默认 process.env）：启动时读取继承的 KUBECONFIG，之后由本模块维护。 */
	env?: NodeJS.ProcessEnv;
	home?: string;
	kubectl?: string;
	cacheMs?: number;
	/** /version 的 --request-timeout；子进程另有硬超时（再加 min(4s, 该值)）。 */
	probeTimeoutMs?: number;
}

const MESSAGES: Record<ClusterCode, string> = {
	"not-configured": "未找到集群配置",
	"no-kubectl": "服务端找不到 kubectl",
	ok: "API 可达（/version 探测成功）",
	unauthorized: "认证失败（401）：凭据无效或已过期",
	forbidden: "API 已响应，但当前凭据无权访问 /version（403）",
	tls: "TLS 校验失败",
	network: "网络不可达或连接被拒绝",
	timeout: "探测超时",
	"config-invalid": "配置无效、文件缺失或没有可用的 context",
	error: "探测失败（未分类错误）",
};

const VERSION_NAME_RE = /^kc-\d{13}-[0-9a-f]{6}\.yaml$/;
const CLEARED_MARK = ".cleared";

/** 按 kubectl 的退出情况与 stderr 归类（stderr 只在这里读，不外传）。 */
export function classifyKubectlFailure(
	err: { code?: unknown; killed?: boolean; signal?: unknown } | null,
	stderr: string,
): ClusterCode {
	if (!err) return "ok";
	if (err.code === "ENOENT") return "no-kubectl";
	if (err.killed || err.signal === "SIGKILL" || err.signal === "SIGTERM") return "timeout";
	const s = stderr;
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

function safeContext(raw: string): string | null {
	const s = raw.trim();
	return /^[\w.@:/-]{1,128}$/.test(s) ? s : null;
}

function safeVersion(raw: string): string | null {
	try {
		const v = (JSON.parse(raw) as { gitVersion?: unknown }).gitVersion;
		return typeof v === "string" && /^v?\d+\.\d+(?:\.\d+)?[\w.+-]{0,40}$/.test(v) ? v : null;
	} catch {
		return null;
	}
}

interface RunResult {
	err: { code?: unknown; killed?: boolean; signal?: unknown } | null;
	stdout: string;
	stderr: string;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RunResult> {
	return new Promise((done) => {
		execFile(
			cmd,
			args,
			{ env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true },
			(err, stdout, stderr) =>
				done({ err: err as RunResult["err"], stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
		);
	});
}

function splitPaths(v: string | null): string[] {
	return (v ?? "").split(delimiter).filter(Boolean);
}

export class ClusterConfig {
	readonly instance = randomBytes(4).toString("hex");
	private generation = 1;
	private readonly env: NodeJS.ProcessEnv;
	private readonly home: string;
	private readonly dir: string;
	private readonly legacy: string;
	/** 启动时继承的 KUBECONFIG（指向应用保存文件的不算，那是旧启动脚本导出的 app 来源）。 */
	private readonly inherited: string | null;
	private appFile: string | null;
	/** 已运行任务绑定的应用配置版本：bindKey → 文件路径（回收时保留）。 */
	private readonly bound = new Map<string, string>();
	private cache: { key: string; at: number; status: ClusterStatus } | null = null;
	private inflight: { key: string; promise: Promise<ClusterStatus> } | null = null;

	constructor(private readonly opts: ClusterConfigOptions) {
		this.env = opts.env ?? process.env;
		this.home = opts.home ?? homedir();
		this.dir = join(opts.dataDir, "kubeconfig.d");
		this.legacy = join(opts.dataDir, "kubeconfig");
		const raw = this.env.KUBECONFIG?.trim() || null;
		this.inherited = raw && !splitPaths(raw).every((p) => this.isAppPath(p)) ? raw : null;
		this.appFile = this.loadAppFile();
		this.applyEnv();
	}

	private isAppPath(p: string): boolean {
		const abs = resolve(p);
		return abs === resolve(this.legacy) || dirname(abs) === resolve(this.dir);
	}

	private versions(): string[] {
		try {
			return readdirSync(this.dir)
				.filter((n) => VERSION_NAME_RE.test(n))
				.sort()
				.map((n) => join(this.dir, n));
		} catch {
			return [];
		}
	}

	private loadAppFile(): string | null {
		if (existsSync(join(this.dir, CLEARED_MARK))) {
			this.gc();
			return null;
		}
		const latest = this.versions().pop();
		if (latest) return latest;
		return existsSync(this.legacy) ? this.legacy : null;
	}

	/** 新任务应使用的配置（每次现查文件是否存在：外部新建 ~/.kube/config 也能被看到）。 */
	target(): ClusterTarget {
		const generation = this.generation;
		if (this.appFile && existsSync(this.appFile)) return { source: "app", generation, kubeconfig: this.appFile };
		if (this.inherited) return { source: "env", generation, kubeconfig: this.inherited };
		if (existsSync(this.defaultPath())) return { source: "default", generation, kubeconfig: null };
		return { source: "none", generation, kubeconfig: null };
	}

	private defaultPath(): string {
		return join(this.home, ".kube", "config");
	}

	/** 子进程环境：按 target 设置或去掉 KUBECONFIG（其余变量原样保留）。 */
	envFor(target: ClusterTarget, base: NodeJS.ProcessEnv = this.env): NodeJS.ProcessEnv {
		const env = { ...base };
		if (target.kubeconfig) env.KUBECONFIG = target.kubeconfig;
		else delete env.KUBECONFIG;
		return env;
	}

	/** 把被管理的进程环境对齐到当前 target（新派生的 bash/终端/validator 默认继承它）。 */
	private applyEnv(): void {
		const t = this.target();
		if (t.kubeconfig) this.env.KUBECONFIG = t.kubeconfig;
		else delete this.env.KUBECONFIG;
	}

	/** 当前配置的指纹：代次 + 来源 + 涉及文件的 mtime/size（context 切换会改文件）。 */
	private configKey(t: ClusterTarget): string {
		const files = t.source === "default" ? [this.defaultPath()] : splitPaths(t.kubeconfig);
		const sig = files.map((f) => {
			try {
				const s = statSync(f);
				return `${s.mtimeMs}:${s.size}`;
			} catch {
				return "x";
			}
		});
		return `${t.generation}|${t.source}|${t.kubeconfig ?? ""}|${sig.join(",")}`;
	}

	private shadowed(source: ClusterSource): ClusterSource[] {
		const out: ClusterSource[] = [];
		if (source === "app" && this.inherited) out.push("env");
		if ((source === "app" || source === "env") && existsSync(this.defaultPath())) out.push("default");
		return out;
	}

	/** 当前配置的连通状态；force 跳过缓存。探测期间配置变了就丢弃结果，对新配置重探。 */
	async status(force = false): Promise<ClusterStatus> {
		let last: ClusterStatus | null = null;
		for (let attempt = 0; attempt < 3; attempt++) {
			const t = this.target();
			const key = this.configKey(t);
			const cacheMs = this.opts.cacheMs ?? 8000;
			if (!force && this.cache?.key === key && Date.now() - this.cache.at < cacheMs) return this.cache.status;
			if (this.inflight?.key !== key) {
				const promise = this.probe(t);
				const entry = { key, promise };
				this.inflight = entry;
				void promise.finally(() => {
					if (this.inflight === entry) this.inflight = null;
				});
			}
			last = await this.inflight!.promise;
			if (this.configKey(this.target()) === key) {
				this.cache = { key, at: Date.now(), status: last };
				return last;
			}
			force = true;
		}
		return last!;
	}

	private async probe(t: ClusterTarget): Promise<ClusterStatus> {
		const base = {
			source: t.source,
			envPathCount: t.source === "env" ? splitPaths(t.kubeconfig).length : 0,
			shadowed: this.shadowed(t.source),
			context: null as string | null,
			serverVersion: null as string | null,
			generation: t.generation,
			instance: this.instance,
		};
		const done = (code: ClusterCode, extra: Partial<ClusterStatus> = {}): ClusterStatus => ({
			...base,
			configured: code !== "not-configured",
			connected: code === "ok",
			code,
			message: MESSAGES[code],
			checkedAt: new Date().toISOString(),
			...extra,
		});
		if (t.source === "none") return done("not-configured");
		const kubectl = this.opts.kubectl ?? "kubectl";
		const timeout = this.opts.probeTimeoutMs ?? 5000;
		// app 来源是单文件，显式 --kubeconfig；env/default 按 kubectl 正常解析（多路径不能塞进 --kubeconfig）。
		const args = t.source === "app" ? ["--kubeconfig", t.kubeconfig!] : [];
		const env = this.envFor(t, { ...this.env, ...(this.opts.home ? { HOME: this.opts.home } : {}) });
		const ver = await run(
			kubectl,
			[...args, "get", "--raw=/version", `--request-timeout=${Math.max(1, Math.ceil(timeout / 1000))}s`],
			env,
			timeout + Math.min(4000, timeout),
		);
		const code = classifyKubectlFailure(ver.err, ver.stderr);
		if (code === "no-kubectl") return done(code);
		const ctx = await run(kubectl, [...args, "config", "current-context"], env, 3000);
		return done(code, {
			context: ctx.err ? null : safeContext(ctx.stdout),
			serverVersion: code === "ok" ? safeVersion(ver.stdout) : null,
		});
	}

	/** 保存 Web 导入的配置为新版本（0600，不覆盖旧版本）。失败时保持原配置不变。 */
	save(text: string): { ok: true } | { ok: false; code: "write-failed" } {
		const file = join(this.dir, `kc-${Date.now()}-${randomBytes(3).toString("hex")}.yaml`);
		try {
			mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			chmodSync(this.dir, 0o700);
			writeFileSync(file, text, { mode: 0o600, flag: "wx" });
			chmodSync(file, 0o600);
		} catch {
			try {
				rmSync(file, { force: true });
			} catch {
				// 目录本身不可用（如被普通文件占住）：没有半截文件可删。
			}
			return { ok: false, code: "write-failed" };
		}
		rmSync(join(this.dir, CLEARED_MARK), { force: true });
		this.appFile = file;
		this.bump();
		this.gc();
		return { ok: true };
	}

	/** 清除应用保存的配置：新任务按优先级回退；已绑定的版本保留到任务释放。 */
	clear(): { ok: boolean; retainedForTasks: number } {
		this.appFile = null;
		try {
			mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			writeFileSync(join(this.dir, CLEARED_MARK), "", { mode: 0o600 });
		} catch {
			// 标记写不进去：本进程内照样生效；重启后若文件也删不掉会按「最新版本」恢复。
		}
		this.bump();
		const r = this.gc();
		return { ok: r.failed === 0, retainedForTasks: r.retained };
	}

	private bump(): void {
		this.generation += 1;
		this.cache = null;
		this.applyEnv();
	}

	/** 回收不再使用的应用配置版本（当前版本与任务绑定的版本除外）。 */
	private gc(): { retained: number; failed: number } {
		const keep = new Set([this.appFile, ...this.bound.values()].filter((p): p is string => !!p));
		let retained = 0;
		let failed = 0;
		for (const f of [...this.versions(), ...(existsSync(this.legacy) ? [this.legacy] : [])]) {
			if (keep.has(f)) {
				if (f !== this.appFile) retained += 1;
				continue;
			}
			try {
				rmSync(f, { force: true });
			} catch {
				failed += 1;
			}
		}
		return { retained, failed };
	}

	/** 任务启动时绑定当前配置；返回值交给 envFor() 生成该任务子进程的环境。 */
	bind(key: string): ClusterTarget {
		const t = this.target();
		if (t.source === "app" && t.kubeconfig) this.bound.set(key, t.kubeconfig);
		return t;
	}

	release(key: string): void {
		if (this.bound.delete(key)) this.gc();
	}
}

let active: ClusterConfig | null = null;

/** 服务进程里的唯一实例（registerLoopRoutes 创建）；任务执行器经它绑定配置。 */
export function setActiveClusterConfig(c: ClusterConfig | null): void {
	active = c;
}

export function activeClusterConfig(): ClusterConfig | null {
	return active;
}
