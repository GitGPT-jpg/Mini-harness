/**
 * Background-server tracking — 从 agent-service.ts 抽出。
 *
 * bash 工具执行前后各拍一次监听端口快照，diff 出 AI 启动的后台服务记入列表；
 * 列表按客户端持久（对话切换/断线重连不消失），只有任务被停或进程自行退出才移除。
 * 本模块自包含：只依赖 process-utils 与协议类型，经回调与 ClientSession 解耦
 * （emit 推消息 / flushSnapshot 立即刷快照 / isDisposed 停止后台刷新）。
 */
import type { ServerMessage, BgServer } from "./protocol.js";
import {
	killPidTree,
	lookupProcessDetailsBatch,
	snapshotListeningPorts,
	snapshotProcessTree,
	type ProcessTreeNode,
} from "./process-utils.js";

const BG_REFRESH_INTERVAL_MS = 30_000;
/** bash 结束后等这么久再拍「后」快照——给后台服务绑定端口的时间。 */
const BG_BIND_WAIT_MS = 1500;

/** 自动清理时「闲置多久算遗留」的兜底阈值（分钟）——手动「立即清理」在策略为关时用它。 */
export const BG_CLEANUP_FALLBACK_MIN = 30;

/**
 * 从当前列表里挑出「该被自动清理」的条目（纯函数，好测）：
 *   - **钉住的（keep）不碰** —— 用户明确说要留的，永远不动；
 *   - 插件注册的任务不参与（它们不在这个列表里，由插件的 stop 回调负责）；
 *   - 只看 `since`（宿主首次发现它的时间）与阈值，与是否还在跑无关（还在跑才会在列表里）。
 * @param entries `{port, pid, since, keep?}` 列表
 * @param opts `{ now, thresholdMs }`；thresholdMs ≤ 0 = 不清理
 * @returns 待清理的条目（原样引用）
 */
export function staleLeftovers(
	entries: ReadonlyArray<{ port: number; pid: number; since: number; keep?: boolean }>,
	opts: { now: number; thresholdMs: number },
): Array<{ port: number; pid: number; since: number; keep?: boolean }> {
	if (!Number.isFinite(opts.thresholdMs) || opts.thresholdMs <= 0) return [];
	return entries.filter((e) => !e.keep && Number.isFinite(e.since) && opts.now - e.since >= opts.thresholdMs);
}

/**
 * 基本不可能由 AI 启动的常驻桌面软件进程名（小写）。命中即跳过，避免面板被
 * 微信/QQ/WPS/ima 等本地软件的动态监听端口污染。注意 Chrome 不进黑名单：AI 会用
 * Playwright 拉浏览器做模拟，它靠下方父链回溯判定（Playwright 起的 chrome
 * 能回溯到服务器进程，自己开的 chrome 父链是 explorer，分得开）。
 */
export const NON_AGENT_PROCESS_NAMES = new Set([
	// 办公与知识库（Issue #651：WPS、腾讯 ima.copilot 等）
	"wps.exe",
	"wpscenter.exe",
	"ksoqing.exe",
	"ksolaunch.exe",
	"wpscloudsvr.exe",
	"ima.copilot.exe",
	"ima.exe",
	// 即时通讯与社交
	"wechat.exe",
	"weixin.exe",
	"wechatappex.exe",
	"qq.exe",
	"tim.exe",
	"telegram.exe",
	"dingtalk.exe",
	// 系统外壳与基础设施
	"explorer.exe",
	"searchhost.exe",
	"searchapp.exe",
	"svchost.exe",
	"winlogon.exe",
	"dwm.exe",
	"csrss.exe",
	"conhost.exe",
	"sihost.exe",
	"taskhostw.exe",
	"services.exe",
	"shellexperiencehost.exe",
	"startmenuexperiencehost.exe",
]);

/**
 * 桌面外壳与系统服务进程名（小写）。
 * 祖先回溯时如果撞上这些进程，说明该进程是由桌面 GUI、开始菜单或系统服务启动的，
 * 绝不可能由当前 CLI / Node.js 进程在后台拉起。
 */
export const SHELL_OR_SYSTEM_PROCESS_NAMES = new Set([
	"explorer.exe",
	"winlogon.exe",
	"services.exe",
	"dwm.exe",
	"taskhostw.exe",
	"sihost.exe",
	"svchost.exe",
	"shellexperiencehost.exe",
	"startmenuexperiencehost.exe",
	"system",
]);

/**
 * 典型的 AI / 开发者开发服务运行时进程名（小写）。
 * 在发生中途断链（父进程已退出）时作为启发式白名单校验依据。
 */
export const DEV_RUNTIME_PROCESS_NAMES = new Set([
	"node.exe",
	"node",
	"python.exe",
	"python",
	"python3.exe",
	"python3",
	"deno.exe",
	"deno",
	"bun.exe",
	"bun",
	"ruby.exe",
	"ruby",
	"go.exe",
	"go",
	"java.exe",
	"java",
	"dotnet.exe",
	"dotnet",
	"php.exe",
	"php",
	"cargo.exe",
	"cargo",
	"uvicorn.exe",
	"uvicorn",
	"gunicorn",
	"vite.exe",
	"vite",
	"flask.exe",
	"flask",
]);

export interface BackgroundServerFilterOptions {
	commandLine?: string;
	createdMs?: number;
	startedBeforeMs?: number;
	workspaceCwd?: string;
}

/**
 * 判定 bash 后新出现的监听端口进程是否该记入后台任务列表（即「AI 启动的」）。
 *
 * 判定规则（三重防护）：
 * 1. 【时序防线（CreationDate）】如果进程启动时间早于 bash 启动时刻（留 2s 容差），
 *    说明该进程在 bash 执行前就已存在，100% 为外部已有应用（如提前开着的 WPS、ima、游戏），跳过；
 * 2. 【进程名与黑名单】命中 NON_AGENT_PROCESS_NAMES（如 wps.exe、ima.copilot.exe、wechat.exe），跳过；
 * 3. 【祖先链追溯】
 *    - 撞上服务器进程（serverPid）→ 记录（铁证）；
 *    - 撞上桌面 Shell 或系统服务（explorer.exe / services.exe 等）→ 跳过；
 *    - 撞上本次 diff 出的其他新 pid（如 concurrently 等中间层）→ 记录并继续向上回溯；
 *    - 完整回溯到系统根（0/1）未命中 serverPid → 跳过；
 * 4. 【断链安全底线】中途断链（父进程已退出，常见于 nohup 或 Windows launcher）：
 *    - 具备明确开发特征（DEV_RUNTIME_PROCESS_NAMES 或命令行/路径包含工作区）才予收录；
 *    - 未知可执行文件或桌面安装目录应用（如 Program Files）坚决跳过，杜绝误杀用户正常程序。
 */
export function shouldTrackBackgroundServer(
	pid: number,
	parents: ReadonlyMap<number, number | ProcessTreeNode> | undefined,
	newPids: ReadonlySet<number>,
	serverPid: number,
	name?: string,
	opts?: BackgroundServerFilterOptions,
): boolean {
	const lowerName = name?.toLowerCase();

	// 1. 命中黑名单 → 跳过
	if (lowerName && NON_AGENT_PROCESS_NAMES.has(lowerName)) return false;

	// 2. 时序防护：早于 bash 开始时刻创建的进程绝不可能是本次命令拉起的新任务。
	if (
		typeof opts?.startedBeforeMs === "number" &&
		opts.startedBeforeMs > 0 &&
		typeof opts.createdMs === "number" &&
		opts.createdMs > 0
	) {
		// 允许 2000ms 的时钟抖动/快照耗时容差
		if (opts.createdMs < opts.startedBeforeMs - 2000) {
			return false;
		}
	}

	// 3. 命令行路径防范：如果可执行路径明显指向普通桌面安装目录（如 Program Files / AppData Local Programs）
	// 且不是开发工具链运行时，跳过
	if (opts?.commandLine) {
		const lowerCmd = opts.commandLine.toLowerCase();
		const isDevRuntime = lowerName ? DEV_RUNTIME_PROCESS_NAMES.has(lowerName) : false;
		if (!isDevRuntime) {
			const isDesktopPath =
				lowerCmd.includes("\\program files") ||
				lowerCmd.includes("/program files") ||
				lowerCmd.includes("\\appdata\\local\\programs\\") ||
				lowerCmd.includes("/appdata/local/programs/");
			if (isDesktopPath) {
				return false;
			}
		}
	}

	// 4. 进程树查不到时：降级为保守记录（保持现有纯单测行为）
	if (!parents) {
		return true;
	}

	// 5. 向上回溯父链
	const seen = new Set<number>();
	let cur: number | undefined = pid;
	let brokenAt: number | undefined;

	while (cur !== undefined && !seen.has(cur)) {
		seen.add(cur);
		if (cur === serverPid) return true;
		if (cur !== pid && newPids.has(cur)) return true;

		const parentEntry = parents.get(cur);
		let next: number | undefined;
		let parentName: string | undefined;

		if (typeof parentEntry === "object" && parentEntry !== null) {
			next = parentEntry.ppid;
			parentName = parentEntry.name;
		} else if (typeof parentEntry === "number") {
			next = parentEntry;
		}

		// 检查当前祖先节点是否命中桌面外壳或系统服务
		if (parentName) {
			const lowerParent = parentName.toLowerCase();
			if (SHELL_OR_SYSTEM_PROCESS_NAMES.has(lowerParent) || NON_AGENT_PROCESS_NAMES.has(lowerParent)) {
				return false;
			}
		}

		if (next === undefined) {
			// 到达系统根（0 或 1）→ 完整链，非 AI 启动
			if (cur <= 1) return false;
			// 中途断链：父进程已退出
			brokenAt = cur;
			break;
		}

		if (next === cur) {
			// 自引用根，视为完整链终点
			return false;
		}

		cur = next;
	}

	// 6. 断链处理（brokenAt !== undefined）
	if (brokenAt !== undefined) {
		// 如果未传 opts 且未传 name（保持现有纯断链单测的向后兼容）
		if (!opts && !name) {
			return true;
		}
		// 具备明确开发运行时特征（node, python 等）才予收录
		if (lowerName && DEV_RUNTIME_PROCESS_NAMES.has(lowerName)) {
			return true;
		}
		// 命令行包含当前工作区路径时收录
		if (opts?.workspaceCwd && opts.commandLine) {
			const normalizedCwd = opts.workspaceCwd.toLowerCase().replace(/\\/g, "/");
			const normalizedCmd = opts.commandLine.toLowerCase().replace(/\\/g, "/");
			if (normalizedCmd.includes(normalizedCwd)) {
				return true;
			}
		}
		// 默认断链不再盲目信任，防止误杀外部软件
		return false;
	}

	return false;
}

export class BgServerTracker {
	private readonly servers = new Map<
		number,
		{ pid: number; since: number; name?: string; command?: string; keep?: boolean }
	>();
	/**
	 * bash 工具开始执行前拍的监听端口快照（tool_execution_start 时设置）。
	 * 槽位存「in-flight Promise」而非已解析的 Map：并发 bash 同时开跑时不互相
	 * 覆盖（??= 保住最早的一份——更早的基线只会多算新增，落库有去重兜底），
	 * 也修掉 fire-and-forget 时序竞态（bash 先于快照返回结束 → trackAfterBash
	 * 读到 null 直接漏记，延迟解析的旧快照还会污染下一轮）。
	 */
	private listenBefore: Promise<Map<number, number>> | null = null;
	private listenBeforeTime: number = 0;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly opts: {
			emit: (msg: ServerMessage) => void;
			flushSnapshot: () => void;
			isDisposed: () => boolean;
			/** 插件注册的常驻任务（host.registerBackgroundTask）→ 追加进同一列表。 */
			pluginTasks?: () => BgServer[];
			/** 自动清理阈值（分钟；0 = 关）。每轮定时器实时读，改设置即时生效。 */
			cleanupMinutes?: () => number;
			/** 当前工作区目录（用于断链时核对进程是否在工作区内启动）。 */
			workspaceCwd?: () => string | undefined;
		},
	) {}

	/** 启动周期性存活检查（死项静默剔除）+ 按策略自动清理遗留实例。 */
	start(): void {
		this.refreshTimer = setInterval(() => void this.tick(), BG_REFRESH_INTERVAL_MS);
		this.refreshTimer.unref?.();
	}

	/** 一轮定时任务：先剔死项，再按策略清遗留（策略为 0 = 关，只剔不杀）。 */
	private async tick(): Promise<void> {
		await this.refresh();
		const minutes = Number(this.opts.cleanupMinutes?.() ?? 0);
		if (!Number.isFinite(minutes) || minutes <= 0) return;
		await this.cleanStale(minutes * 60_000, { manual: false });
	}

	stop(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	/** tool_execution_start(bash)：先记下「前」快照（快照在途时保留最早的一份与启动时间）。 */
	snapshotBefore(): void {
		if (!this.listenBefore) {
			this.listenBeforeTime = Date.now();
			this.listenBefore = snapshotListeningPorts();
		}
	}

	/** After a bash tool run, wait briefly for background servers to bind,
	 *  then diff the listening-port snapshot against the pre-run one and
	 *  remember anything new — those are servers the agent left running. */
	async trackAfterBash(): Promise<void> {
		// 读后清槽：await in-flight 快照（消除 fire-and-forget 的时序竞态），
		// 并发 bash 共用这份最早的基线，各自结束都能对得上。
		const beforePromise = this.listenBefore;
		const beforeTime = this.listenBeforeTime;
		this.listenBefore = null;
		this.listenBeforeTime = 0;
		if (!beforePromise) return;
		const before = await beforePromise;
		await new Promise((r) => setTimeout(r, BG_BIND_WAIT_MS));
		const after = await snapshotListeningPorts();
		const fresh: Array<{ port: number; pid: number }> = [];
		for (const [port, pid] of after) {
			if (!before.has(port) && !this.servers.has(port)) {
				fresh.push({ port, pid });
			}
		}
		if (fresh.length === 0) return;
		// 剔除桌面软件误报（微信/WPS/ima 等）后，剩下的才是 AI 启动的后台服务。
		const keep = await this.filterAgentSpawned(fresh, beforeTime);
		let added = false;
		for (const { port, pid, name, command } of keep) {
			if (this.servers.has(port)) continue;
			this.servers.set(port, {
				pid,
				since: Date.now(),
				...(name ? { name } : {}),
				...(command ? { command } : {}),
			});
			added = true;
			this.opts.emit({
				type: "notice",
				level: "info",
				text: `检测到 AI 启动的后台服务：端口 ${port}（pid ${pid}）——可在顶栏「后台任务」里单独停止或全部关闭`,
				textEn: `Detected an AI-started background service: port ${port} (pid ${pid}) — stop it individually or all at once under Background tasks in the top bar`,
			});
		}
		if (added) this.push();
	}

	/** 并行拉进程树与各进程详情，用时序防线 + 黑名单 + 父链回溯剔除桌面软件误报。 */
	private async filterAgentSpawned(
		fresh: Array<{ port: number; pid: number }>,
		beforeTime: number,
	): Promise<Array<{ port: number; pid: number; name?: string; command?: string }>> {
		const pids = [...new Set(fresh.map((f) => f.pid))];
		const [tree, detailsMap] = await Promise.all([snapshotProcessTree(), lookupProcessDetailsBatch(pids)]);
		const newPids = new Set(pids);
		const cwd = this.opts.workspaceCwd?.();
		const out: Array<{ port: number; pid: number; name?: string; command?: string }> = [];

		for (const { port, pid } of fresh) {
			const details = detailsMap.get(pid);
			const name = details?.name;
			const command = details?.commandLine;
			const should = shouldTrackBackgroundServer(pid, tree, newPids, process.pid, name, {
				commandLine: command,
				createdMs: details?.createdMs,
				startedBeforeMs: beforeTime > 0 ? beforeTime : undefined,
				workspaceCwd: cwd,
			});
			if (should) {
				out.push({
					port,
					pid,
					...(name ? { name } : {}),
					...(command ? { command } : {}),
				});
			}
		}
		return out;
	}

	/** The current background-server list, oldest first. 合并插件任务。 */
	list(): BgServer[] {
		const out: BgServer[] = [...this.servers.entries()]
			.map(([port, v]) => ({
				port,
				pid: v.pid,
				since: v.since,
				...(v.name ? { name: v.name } : {}),
				...(v.command ? { command: v.command } : {}),
				...(v.keep ? { keep: true } : {}),
			}))
			.sort((a, b) => a.since - b.since);
		for (const t of this.opts.pluginTasks?.() ?? []) out.push(t);
		return out;
	}

	/** Push the current background-task list to every connected socket. */
	push(): void {
		this.opts.emit({ type: "bg_servers", servers: this.list() });
	}

	/** Re-snapshot listening ports and drop tracked entries that are no longer
	 *  listening — the process exited on its own, so it must leave the panel.
	 *  Port AND pid must both match: a port reused by an unrelated process is
	 *  not our server anymore. Silent (the list just updates). */
	async refresh(): Promise<void> {
		if (this.opts.isDisposed() || this.servers.size === 0) return;
		const now = await snapshotListeningPorts();
		let changed = false;
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const [port, v] of [...this.servers]) {
			if (now.get(port) !== v.pid) {
				this.servers.delete(port);
				changed = true;
			}
		}
		if (changed) this.push();
	}

	/** Re-push the current list on request (panel opened); prunes dead entries first. */
	async listAndPush(): Promise<void> {
		await this.refresh();
		this.push();
	}

	/** 杀前复核端口→pid 归属（与 refresh() 同一判定：端口与 pid 都对得上才算我们的）。
	 *  缓存的 pid 可能已过期——原进程退出后端口被无关进程复用时，按缓存 pid 直接
	 *  killPidTree 会误伤无辜进程树。不符的条目剔除并推送，绝不对其开杀。 */
	private async verifyBeforeKill(): Promise<void> {
		const now = await snapshotListeningPorts();
		let changed = false;
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const [port, v] of [...this.servers]) {
			if (now.get(port) !== v.pid) {
				this.servers.delete(port);
				changed = true;
			}
		}
		if (changed) this.push();
	}

	/** Kill ONE background server (by port); returns whether anything was killed. */
	async killOne(port: number): Promise<boolean> {
		const entry = this.servers.get(port);
		if (!entry) {
			this.opts.emit({
				type: "notice",
				level: "info",
				text: `端口 ${port} 不在后台任务列表中`,
				textEn: `Port ${port} is not in the background task list`,
			});
			this.opts.flushSnapshot();
			return false;
		}
		await this.verifyBeforeKill();
		const verified = this.servers.get(port);
		if (!verified || verified.pid !== entry.pid) {
			this.opts.emit({
				type: "notice",
				level: "warning",
				text: `端口 ${port} 已不在原进程（原 pid ${entry.pid}）监听，已跳过并刷新列表`,
				textEn: `Port ${port} is no longer held by the original process (pid ${entry.pid}); skipped and list refreshed`,
			});
			this.opts.flushSnapshot();
			return false;
		}
		killPidTree(entry.pid);
		this.servers.delete(port);
		this.push();
		this.opts.emit({
			type: "notice",
			level: "info",
			text: `已停止后台任务：端口 ${port}（pid ${entry.pid}）`,
			textEn: `Stopped background task: port ${port} (pid ${entry.pid})`,
		});
		this.opts.flushSnapshot();
		return true;
	}

	/** 钉住 / 取消钉住一个实例（自动清理跳过钉住的）。端口不在列表里 → 回一条 info 通知。 */
	setKeep(port: number, keep: boolean): boolean {
		const entry = this.servers.get(port);
		if (!entry) {
			this.opts.emit({
				type: "notice",
				level: "info",
				text: `端口 ${port} 不在后台任务列表中（可能已自行退出）`,
				textEn: `Port ${port} is not in the background task list (it may have exited)`,
			});
			this.opts.flushSnapshot();
			return false;
		}
		if (keep) entry.keep = true;
		else delete entry.keep;
		this.push();
		return true;
	}

	/**
	 * 按阈值清理遗留实例：先复核端口→pid 归属（同 killOne，不对就剔条目绝不误杀），
	 * 再杀**未钉住**且闲置超阈值的那些，最后推一条汇总通知。
	 * @param manual 手动点「立即清理」：即使没东西可清也给一句反馈（否则点了像没反应）。
	 */
	async cleanStale(thresholdMs: number, opts: { manual: boolean }): Promise<number[]> {
		await this.verifyBeforeKill();
		const picked = staleLeftovers(
			[...this.servers.entries()].map(([port, v]) => ({ port, ...v })),
			{ now: Date.now(), thresholdMs },
		);
		if (picked.length === 0) {
			if (opts.manual) {
				this.opts.emit({
					type: "notice",
					level: "info",
					text: `没有需要清理的遗留实例（阈值 ${Math.round(thresholdMs / 60_000)} 分钟，已钉住的不算）`,
					textEn: `No leftover instance to clean (threshold ${Math.round(thresholdMs / 60_000)} min; kept ones excluded)`,
				});
			}
			return [];
		}
		const killed: number[] = [];
		for (const item of picked) {
			killPidTree(item.pid);
			this.servers.delete(item.port);
			killed.push(item.port);
		}
		this.push();
		this.opts.emit({
			type: "notice",
			level: "info",
			text: `已清理 ${killed.length} 个遗留后台实例：端口 ${killed.join("、")}（闲置超 ${Math.round(thresholdMs / 60_000)} 分钟；可在面板里钉住想留的）`,
			textEn: `Cleaned ${killed.length} leftover background instance(s): port ${killed.join(", ")} (idle over ${Math.round(thresholdMs / 60_000)} min; pin the ones you want to keep)`,
		});
		this.opts.flushSnapshot();
		return killed;
	}

	/** Kill every background server the agent started; returns the freed ports. */
	async killAll(): Promise<string[]> {
		if (this.servers.size === 0) return [];
		await this.verifyBeforeKill();
		if (this.servers.size === 0) return [];
		const killed: string[] = [];
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const [port, { pid }] of [...this.servers]) {
			killPidTree(pid);
			killed.push(String(port));
		}
		this.servers.clear();
		this.push();
		return killed;
	}
}
