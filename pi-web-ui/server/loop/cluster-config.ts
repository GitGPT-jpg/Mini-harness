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
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

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

/**
 * 运行中任务的集群绑定（对外只有这些标识，不含凭据）。
 *  - pinned：已固定。app 来源绑定不可变的导入版本；env / default 来源在绑定时用
 *    `kubectl config view --raw --flatten` 存一份自包含快照（0600），之后外部改写原文件不影响任务；
 *  - none：绑定时没有任何配置，任务里的 kubectl 一律失败，不会捡到之后导入的配置；
 *  - blocked：没法固定（缺 kubectl / 快照失败）或旧绑定已不可核实（快照缺失 / 被改动）。
 * none / blocked 时任务子进程的 KUBECONFIG 指向一个必然连不上的占位配置，而不是当前全局配置。
 */
export interface ClusterBinding {
	key: string;
	source: ClusterSource;
	generation: number;
	status: "pinned" | "none" | "blocked";
	context: string | null;
	reason: "no-kubectl" | "snapshot-failed" | "snapshot-unpinnable" | "snapshot-missing" | "snapshot-changed" | null;
	/** 凭据来自配置之外（exec 插件 / auth-provider / 绝对路径 tokenFile）：目标已固定，凭据内容随外部来源刷新。 */
	externalCredentials: boolean;
	createdAt: string;
}

interface BindingRecord extends ClusterBinding {
	/** 固定用的配置文件（应用版本或快照）；仅存在本模块的 0600 存储里。 */
	file: string | null;
	sha256: string | null;
}

const BLOCKED_KUBECONFIG = [
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

const sha256Of = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

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
	/** 运行中任务的绑定（持久化在 kubeconfig.d/bindings.json；回收时保留它们引用的文件）。 */
	private readonly bindings = new Map<string, BindingRecord>();
	private cache: { key: string; at: number; status: ClusterStatus } | null = null;
	private inflight: { key: string; promise: Promise<ClusterStatus> } | null = null;

	constructor(private readonly opts: ClusterConfigOptions) {
		this.env = opts.env ?? process.env;
		this.home = opts.home ?? homedir();
		this.dir = join(opts.dataDir, "kubeconfig.d");
		this.legacy = join(opts.dataDir, "kubeconfig");
		const raw = this.env.KUBECONFIG?.trim() || null;
		this.inherited = raw && !splitPaths(raw).every((p) => this.isAppPath(p)) ? raw : null;
		this.loadBindings();
		this.appFile = this.loadAppFile();
		this.applyEnv();
	}

	private bindingsFile(): string {
		return join(this.dir, "bindings.json");
	}

	/** 读回上次进程留下的绑定：目标任务（goal:）不跨重启，丢弃并删快照；其余等调用方按任务是否还在裁剪。 */
	private loadBindings(): void {
		let raw: Record<string, BindingRecord> = {};
		try {
			raw = JSON.parse(readFileSync(this.bindingsFile(), "utf8")) as Record<string, BindingRecord>;
		} catch {
			return;
		}
		for (const [key, rec] of Object.entries(raw ?? {})) {
			if (!rec || typeof rec !== "object" || rec.key !== key) continue;
			this.bindings.set(key, rec);
		}
		// 构造期还没读当前导入版本：只摘记录、删快照，不做版本回收（否则会误删当前配置）。
		let dropped = false;
		for (const key of [...this.bindings.keys()]) {
			if (key.startsWith("goal:")) dropped = this.dropBinding(key) || dropped;
		}
		if (dropped) this.saveBindings();
	}

	private saveBindings(): void {
		try {
			mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			writeFileSync(this.bindingsFile(), JSON.stringify(Object.fromEntries(this.bindings), null, 2), { mode: 0o600 });
			chmodSync(this.bindingsFile(), 0o600);
		} catch {
			// 写不进去：本进程内的绑定照常生效，只是跨重启时按「无记录」处理。
		}
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
		const keep = new Set(
			[this.appFile, ...[...this.bindings.values()].map((b) => b.file)].filter((p): p is string => !!p),
		);
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

	/**
	 * 任务启动时绑定当前实际使用的配置（同一个 key 重复绑定 = 先释放旧的）。
	 * 绑定在任务的首个命令之前完成；之后任务的 Bash / validator / 任务终端都经 envForTask 取环境。
	 */
	async bindTask(key: string): Promise<ClusterBinding> {
		if (this.bindings.has(key)) this.releaseTask(key);
		const t = this.target();
		const base = { key, source: t.source, generation: t.generation, createdAt: new Date().toISOString() };
		let rec: BindingRecord;
		if (t.source === "none") {
			rec = {
				...base,
				status: "none",
				context: null,
				reason: null,
				externalCredentials: false,
				file: null,
				sha256: null,
			};
		} else if (t.source === "app" && t.kubeconfig) {
			let sha: string | null = null;
			try {
				sha = sha256Of(readFileSync(t.kubeconfig));
			} catch {
				sha = null;
			}
			const external = sha ? /^\s*(?:exec|auth-provider|tokenFile):/m.test(readFileSync(t.kubeconfig, "utf8")) : false;
			rec = sha
				? {
						...base,
						status: "pinned",
						context: this.cachedContext(t),
						reason: null,
						externalCredentials: external,
						file: t.kubeconfig,
						sha256: sha,
					}
				: {
						...base,
						status: "blocked",
						context: null,
						reason: "snapshot-missing",
						externalCredentials: false,
						file: null,
						sha256: null,
					};
		} else {
			rec = await this.snapshotBinding(t, base);
		}
		this.bindings.set(key, rec);
		this.saveBindings();
		return publicBinding(rec);
	}

	private cachedContext(t: ClusterTarget): string | null {
		const st = this.cache?.status;
		return st && st.generation === t.generation && st.source === t.source ? st.context : null;
	}

	/** env / default 来源：按 kubectl 正常解析得到当前 context 的自包含快照，之后不受原文件改写影响。 */
	private async snapshotBinding(
		t: ClusterTarget,
		base: Pick<BindingRecord, "key" | "source" | "generation" | "createdAt">,
	): Promise<BindingRecord> {
		const kubectl = this.opts.kubectl ?? "kubectl";
		const env = this.envFor(t, { ...this.env, ...(this.opts.home ? { HOME: this.opts.home } : {}) });
		let res = await run(kubectl, ["config", "view", "--raw", "--flatten", "--minify"], env, 5000);
		// 没有 current-context 时 --minify 会失败：退回整份展开（多 context 也一并固定）。
		if (res.err && res.err.code !== "ENOENT")
			res = await run(kubectl, ["config", "view", "--raw", "--flatten"], env, 5000);
		const blocked = (reason: BindingRecord["reason"]): BindingRecord => ({
			...base,
			status: "blocked",
			context: null,
			reason,
			externalCredentials: false,
			file: null,
			sha256: null,
		});
		if (res.err) return blocked(res.err.code === "ENOENT" ? "no-kubectl" : "snapshot-failed");
		if (!/^\s*apiVersion:/m.test(res.stdout) || !/^\s*clusters:/m.test(res.stdout)) return blocked("snapshot-failed");
		// --flatten 会内联证书 / 私钥文件；仍残留的相对路径引用（如 tokenFile）在快照目录下解析不到原文件，
		// 快照固定不了 → 受阻，而不是让它在别处解析出另一份凭据。
		if (/^\s*(?:certificate-authority|client-certificate|client-key|tokenFile):\s*["']?(?![/"'])\S/m.test(res.stdout))
			return blocked("snapshot-unpinnable");
		const file = join(this.dir, `bound-${Date.now()}-${randomBytes(3).toString("hex")}.yaml`);
		try {
			mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			chmodSync(this.dir, 0o700);
			writeFileSync(file, res.stdout, { mode: 0o600, flag: "wx" });
		} catch {
			return blocked("snapshot-failed");
		}
		const ctx = /^current-context:\s*"?([^"\n]+?)"?\s*$/m.exec(res.stdout)?.[1] ?? "";
		return {
			...base,
			status: "pinned",
			context: safeContext(ctx),
			reason: null,
			externalCredentials: /^\s*(?:exec|auth-provider|tokenFile):/m.test(res.stdout),
			file,
			sha256: sha256Of(res.stdout),
		};
	}

	/** 任务子进程的环境：有绑定 → 绑定的配置（核实不了就指向占位配置）；没有绑定 → 当前配置。 */
	envForTask(key: string, base: NodeJS.ProcessEnv = this.env): NodeJS.ProcessEnv {
		const rec = this.bindings.get(key);
		if (!rec) return this.envFor(this.target(), base);
		return { ...base, KUBECONFIG: this.verifiedFile(rec) ?? this.blockedFile() };
	}

	/** 绑定的文件是否仍是绑定时那份（缺失 / 内容变了 → 改记为 blocked，不再放行）。 */
	private verifiedFile(rec: BindingRecord): string | null {
		if (rec.status !== "pinned" || !rec.file) return null;
		let sha: string | null = null;
		try {
			sha = sha256Of(readFileSync(rec.file));
		} catch {
			sha = null;
		}
		if (sha && sha === rec.sha256) return rec.file;
		rec.status = "blocked";
		rec.reason = sha ? "snapshot-changed" : "snapshot-missing";
		this.saveBindings();
		return null;
	}

	private blockedFile(): string {
		const file = join(this.dir, "blocked.yaml");
		try {
			if (!existsSync(file)) {
				mkdirSync(this.dir, { recursive: true, mode: 0o700 });
				writeFileSync(file, BLOCKED_KUBECONFIG, { mode: 0o600 });
			}
		} catch {
			// 写不了占位文件：指向一个不存在的路径同样不会落到全局配置上。
		}
		return file;
	}

	taskBinding(key: string): ClusterBinding | null {
		const rec = this.bindings.get(key);
		if (!rec) return null;
		if (rec.status === "pinned") this.verifiedFile(rec);
		return publicBinding(rec);
	}

	/** 任务真正结束（记录删除 / 目标收尾）后释放：删快照，回收不再被引用的导入版本。 */
	releaseTask(key: string): void {
		if (!this.dropBinding(key)) return;
		this.saveBindings();
		this.gc();
	}

	/** 摘掉一条绑定并删它独占的快照文件（导入版本留给 gc 按引用回收）。 */
	private dropBinding(key: string): boolean {
		const rec = this.bindings.get(key);
		if (!rec) return false;
		this.bindings.delete(key);
		const stillUsed = [...this.bindings.values()].some((b) => b.file === rec.file);
		if (rec.file && !stillUsed && basename(rec.file).startsWith("bound-")) {
			try {
				rmSync(rec.file, { force: true });
			} catch {
				// 删不掉的快照留给下次回收。
			}
		}
		return true;
	}

	/** 启动后按任务是否还存在裁剪绑定（keep 返回 false 的键释放）。 */
	pruneBindings(keep: (key: string) => boolean): void {
		for (const key of [...this.bindings.keys()]) if (!keep(key)) this.releaseTask(key);
	}
}

function publicBinding(rec: BindingRecord): ClusterBinding {
	const { file: _file, sha256: _sha, ...pub } = rec;
	return pub;
}

let active: ClusterConfig | null = null;

/** 服务进程里的唯一实例（registerLoopRoutes 创建）；任务执行器经它绑定配置。 */
export function setActiveClusterConfig(c: ClusterConfig | null): void {
	active = c;
}

export function activeClusterConfig(): ClusterConfig | null {
	return active;
}
