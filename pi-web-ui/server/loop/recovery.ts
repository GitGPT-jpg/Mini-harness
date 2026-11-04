/**
 * 隔夜恢复的最小执行记录与「先核对，再接续」原语。
 *
 * 设计目标：跨中断恢复不是加定时器。持久化 runId/taskId/attemptId、执行所有权（租约/心跳/代次）、
 * 环境指纹、已启动操作的身份与证据位置；恢复时先核对本地/远端进程与证据，再只从缺失或失效的部分继续。
 *
 * 本模块提供纯函数、同宿主跨进程文件锁与「原目标不消失」原子提交原语，不包含任何领域/集群命令。
 *  - attempt：run 内的一次执行代次；重试分配新 attempt，保留旧 attempt 证据；
 *  - lease：文件级执行所有权（owner + pid + generation + heartbeat），跨进程互斥；
 *  - compareAndSwapFile：使用每 run SQLite BEGIN IMMEDIATE 串行化「读 → 校验 → fsync → 原子覆盖」，
 *    权威目标路径在更新窗口内永不消失（无 ENOENT 窗口），崩溃不丢失已有记录；
 *  - fingerprint：workspace + git HEAD + 实际执行内容快照 + 能力包版本 + 规范化输入 + 环境变量摘要，判定旧证据是否仍适用。
 *
 * 支持范围：单主机、受支持本地文件系统（POSIX / 本地磁盘）。NFS/跨主机共享目录不承诺强一致，检测到时拒绝自动执行。
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareAndSwapFile, readFileOptionalSync, writeFileAtomicPreserveSync } from "./storage.js";
export {
	checkStorageTopology,
	compareAndSwapFile,
	FILE_LOCK_TIMEOUT_MS,
	STORAGE_PROTOCOL_VERSION,
	withFileLockSync,
	withRunLockSync,
	writeFileAtomicPreserveSync,
} from "./storage.js";

/** 租约最长有效时间：超过则认为持有者已失联（进程崩溃 / 休眠 / 网络断开）。 */
export const LEASE_TTL_MS = 30_000;
export const LEASE_HEARTBEAT_MS = 5_000;

export interface Lease {
	owner: string;
	pid: number | null;
	generation: number;
	startedAt: string;
	heartbeatAt: string;
	/** 远端作业 / 请求标识（kubectl job id / 压测 task id 等）；本地进程退出不代表远端已停止。 */
	remoteJobId: string | null;
	/** 本地实际执行实体（validator/precheck 子进程 pid，而非服务进程 pid）。 */
	taskPid?: number | null;
	/** 宿主标识（hostname），用于跨重启核验同宿主身份。 */
	host?: string;
}

export interface EnvironmentFingerprint {
	workspace: string;
	gitHead: string | null;
	/** 工作区实际执行内容指纹（Git 影子树 SHA 或受控目录内容哈希）。 */
	contentHash: string | null;
	packId: string | null;
	packVersion: string | null;
	inputsHash: string;
	envHash: string;
}

function sha256(s: string): string {
	return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** 规范化输入的稳定摘要（键排序 + 仅字符串值；不含密钥）。 */
export function hashInputs(inputs: Record<string, string | null | undefined>): string {
	const canon = JSON.stringify(
		Object.keys(inputs)
			.sort()
			.map((k) => [k, String(inputs[k] ?? "")]),
	);
	return sha256(canon);
}

/** 任意内容的稳定摘要（用于未提交 diff 等；只取内容指纹，不落地原文）。 */
export function hashString(s: string): string {
	return sha256(s);
}

/** 环境变量摘要：只取身份相关项，绝不把密钥/Token 写入摘要或状态。 */
const ENV_ID_KEYS = ["HARNESS_CWD", "PI_WEB_CWD", "HARNESS_ENGINE", "HARNESS_SDK"];
export function hashEnvironment(
	env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
	const parts = ENV_ID_KEYS.map((k) => k + "=" + (env[k] ?? "")).join("|");
	return sha256(parts);
}

/** 生成新的 attemptId（同一 run 内多次尝试互斥、可追溯）。 */
export function newAttemptId(): string {
	return crypto.randomBytes(6).toString("hex");
}

// Keep one nonce across module reloads/duplicate loaders in this process.
const ownerInstanceKey = Symbol.for("mini-harness.owner-instance");
const ownerProcess = process as typeof process & { [ownerInstanceKey]?: string };
const ownerInstance = (ownerProcess[ownerInstanceKey] ??= crypto.randomBytes(16).toString("hex"));

/** 稳定的进程实例身份 pid@host@nonce；前两段保留旧 storage 的 pid/host 解析兼容。 */
export function newOwner(): string {
	return process.pid + "@" + os.hostname() + "@" + ownerInstance;
}

/** 本地 pid 是否存活（用于识别「孤儿租约」：服务进程已死但心跳尚未过期 → 可立即接管）。 */
export function pidAliveLocal(pid: number | null | undefined): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * 采样本地进程的启动时间指纹（用于防止 PID 复用误杀或误认）：
 * 在 POSIX (macOS/Linux) 上通过 `ps -o lstart= -p <pid>` 获取内核记录的进程精确启动时刻；
 * 进程不存在或不支持时返回 null。
 */
export function getProcessStartId(pid: number | null | undefined): string | null {
	if (!pid || pid <= 0) return null;
	if (!pidAliveLocal(pid)) return null;
	if (process.platform === "win32") return `pid:${pid}`;
	try {
		const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			timeout: 1500,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out ? `${os.hostname()}:${pid}:${out}` : null;
	} catch {
		return null;
	}
}

function leasePath(runDir: string): string {
	return path.join(runDir, "lease.json");
}

function readLease(runDir: string): Lease | null {
	const raw = readFileOptionalSync(leasePath(runDir));
	if (raw === null) {
		try {
			if (fs.readdirSync(runDir).some((name) => name.startsWith("lease.json.cas."))) {
				throw new Error("lease.json 缺失但存在旧 CAS 残留，必须先迁移，不能视为空租约");
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return null;
	}
	const lease = parseLease(raw);
	if (!lease) throw new Error("损坏的 lease.json：拒绝将损坏租约视为不存在");
	return lease;
}

function releasedGeneration(runDir: string): number {
	const raw = readFileOptionalSync(path.join(runDir, ".lease-generation"));
	if (raw === null) return 0;
	const value = Number(raw.trim());
	if (!raw.trim() || !Number.isSafeInteger(value) || value < 1) throw new Error("损坏的租约代次记录");
	return value;
}

function parseLease(raw: string): Lease | null {
	try {
		const parsed = JSON.parse(raw) as Lease;
		if (
			parsed &&
			typeof parsed.owner === "string" &&
			parsed.owner.length > 0 &&
			Number.isSafeInteger(parsed.generation) &&
			parsed.generation >= 1 &&
			(parsed.pid === null || (Number.isSafeInteger(parsed.pid) && parsed.pid > 0)) &&
			Number.isFinite(Date.parse(parsed.startedAt)) &&
			Number.isFinite(Date.parse(parsed.heartbeatAt))
		)
			return parsed;
		return null;
	} catch {
		return null;
	}
}

/** 租约是否已过期（心跳超过 TTL）。 */
export function leaseExpired(lease: Lease | null, nowMs = Date.now()): boolean {
	if (!lease) return true;
	const t = Date.parse(lease.heartbeatAt);
	return !Number.isFinite(t) || t > nowMs || nowMs - t >= LEASE_TTL_MS;
}

/**
 * 原子取得执行所有权：
 * 首次创建、过期接管、孤儿接管全部走同一个 `compareAndSwapFile(leasePath)` 串行化域，
 * 彻底消除旧实现中 `tryCreateLeaseFile (O_EXCL)` 与 `heartbeat (rename CAS)` 不在同一互斥域导致的「心跳期间被抢走有效租约」漏洞。
 *
 * 规则：
 *  - 文件不存在 → 允许创建；损坏明确报错，不能当作空租约；
 *  - 租约已过期（超过 LEASE_TTL_MS）且传入的新 generation 严格大于旧 generation（或首次 gen>=1）→ 允许接管；
 *  - 孤儿租约（同宿主 owner 服务进程已死但心跳未过期）仅在 `opts.allowOrphan === true` 时允许接管；
 *  - 其余情况（他人持有未过期有效租约）一律拒绝。
 */
export function acquireLease(runDir: string, lease: Lease, opts?: { allowOrphan?: boolean }): boolean {
	const enriched: Lease = {
		...lease,
		host: lease.host || os.hostname(),
	};
	const next = JSON.stringify(enriched, null, 2) + "\n";
	if (!parseLease(next)) return false;
	const r = compareAndSwapFile(leasePath(runDir), {
		isExpected: (cur) => {
			if (cur == null) return enriched.generation > releasedGeneration(runDir);
			const p = parseLease(cur);
			if (!p) throw new Error("损坏的 lease.json，获取执行权受阻");
			// 同一 owner 也不能通过 acquire 复活已过期的旧 generation。
			if (p.owner === enriched.owner && enriched.generation === p.generation && !leaseExpired(p)) return true;
			// 接管时新代次必须大于已存在代次（或者首次竞争同代次时文件原本不存在，已在 cur==null 处理）
			if (leaseExpired(p)) {
				return enriched.generation > p.generation;
			}
			const sameHost = !p.host || p.host === os.hostname();
			if (opts?.allowOrphan === true && sameHost && p.pid != null && !pidAliveLocal(p.pid)) {
				return enriched.generation > p.generation;
			}
			return false;
		},
		buildNext: (cur) => {
			const previous = cur === null ? null : parseLease(cur);
			// Idempotent acquisition must not erase taskPid or renew the heartbeat.
			return previous?.owner === enriched.owner && previous.generation === enriched.generation ? cur : next;
		},
	});
	if (r.error) throw new Error(r.error);
	return r.ok;
}

/** 读取当前租约（供恢复核对 / 展示用）。 */
export function getLease(runDir: string): Lease | null {
	return readLease(runDir);
}

/** 续租：仍是当前 owner+generation 才 CAS 更新心跳；否则返回 false（已被他人接管）。 */
export function heartbeat(runDir: string, owner: string, generation: number): boolean {
	const r = compareAndSwapFile(leasePath(runDir), {
		isExpected: (cur) => {
			const p = parseLease(cur ?? "");
			if (cur !== null && !p) throw new Error("损坏的 lease.json，续租受阻");
			return !!p && p.owner === owner && p.generation === generation && !leaseExpired(p);
		},
		buildNext: (cur) => {
			const p = parseLease(cur ?? "");
			if (!p) return null;
			return JSON.stringify({ ...p, heartbeatAt: new Date().toISOString() }, null, 2) + "\n";
		},
	});
	if (r.error) throw new Error(r.error);
	return r.ok;
}

/** 条件更新租约（如 recordTaskPid）：仅当仍是当前 owner+generation 才应用 mutator，否则不写。 */
export function mutateLease(
	runDir: string,
	expect: { owner: string; generation: number },
	mutator: (cur: Lease) => Lease,
): boolean {
	const r = compareAndSwapFile(leasePath(runDir), {
		isExpected: (cur) => {
			const p = parseLease(cur ?? "");
			if (cur !== null && !p) throw new Error("损坏的 lease.json，更新受阻");
			return !!p && p.owner === expect.owner && p.generation === expect.generation && !leaseExpired(p);
		},
		buildNext: (cur) => {
			const p = parseLease(cur ?? "");
			if (!p) return null;
			const previousHeartbeat = p.heartbeatAt;
			const next = mutator(p);
			const text = JSON.stringify(next, null, 2) + "\n";
			if (
				!parseLease(text) ||
				next.owner !== expect.owner ||
				next.generation !== expect.generation ||
				next.heartbeatAt !== previousHeartbeat
			) {
				throw new Error("mutateLease 不得改变 owner/generation 或写入无效租约");
			}
			return text;
		},
	});
	if (r.error) throw new Error(r.error);
	return r.ok;
}

/** 释放必须提供 owner+generation；兼容旧调用的类型，但缺少 generation 时拒绝删除。 */
export function releaseLease(runDir: string, owner: string, generation?: number): boolean {
	if (generation === undefined) return false;
	const r = compareAndSwapFile(leasePath(runDir), {
		isExpected: (cur) => {
			const p = parseLease(cur ?? "");
			if (cur !== null && !p) throw new Error("损坏的 lease.json，释放受阻");
			if (!p || p.owner !== owner) return false;
			if (generation != null && p.generation !== generation) return false;
			return true;
		},
		buildNext: (cur) => {
			const current = parseLease(cur!)!;
			// Persist the generation floor BEFORE removing the lease. A crash can
			// leave the old lease, but cannot permit an ABA reuse of an old token.
			writeFileAtomicPreserveSync(
				path.join(runDir, ".lease-generation"),
				String(Math.max(current.generation, releasedGeneration(runDir))) + "\n",
			);
			return null;
		},
	});
	if (r.error) throw new Error(r.error);
	return r.ok;
}

// ---------- 恢复分类与摘要 ----------

export type RecoveryUnit = "completed-valid" | "running" | "failed-retryable" | "unknown" | "cancelled";

export interface RecoveryClass {
	unit: RecoveryUnit;
	reason: string;
	/** 是否允许从当前状态续跑。 */
	canResume: boolean;
	/** 续跑前是否需要核对环境/证据（不盲目重放副作用）。 */
	needRecheck: boolean;
}

export interface ClassifyOptions {
	/** 是否仍持有有效执行权（租约未过期且 owner 一致）。 */
	leaseHeld: boolean;
	/** 环境指纹是否与记录一致（workspace/git/pack/inputs/env）。 */
	environmentChanged: boolean;
	/** 记录的本地进程是否仍存活（null = 无法确认）。 */
	pidAlive: boolean | null;
	/** 最近一轮是否通过（validator 证据有效）。 */
	lastRoundPassed: boolean;
	/** 是否还有在途执行单元（mid-validation，即已开始但未落定）。 */
	inFlight: boolean;
	/** 是否已有已退出但尚未消费完成的持久化操作结果（可安全接续消费，不重跑命令）。 */
	hasUnconsumedResult?: boolean;
}

/**
 * 恢复分类：把 run 归入 completed-valid / running / failed-retryable / unknown / cancelled。
 * 规则：已取消不复活；完成且证据有效不复跑；仍持权重新跟踪不重启；
 * 在途进程存活或已有完整退出结果待消费 → running（接续观察/消费，不重跑）；
 * 结果未知先核对预期效果/补证据，不盲目重跑；环境或代码变化使旧证据失效。
 */
export function classifyRecovery(
	st: { status: string; stopRequestedAt?: string | null },
	o: ClassifyOptions,
): RecoveryClass {
	if (st.status === "stopped") {
		return { unit: "cancelled", reason: "已停止，不自动复活", canResume: false, needRecheck: false };
	}
	if (st.status === "done") {
		if (o.environmentChanged) {
			return {
				unit: "unknown",
				reason: "完成态但环境/代码已变化，旧证据失效，需重新核对",
				canResume: false,
				needRecheck: true,
			};
		}
		return { unit: "completed-valid", reason: "已完成且证据有效，复用不重跑", canResume: false, needRecheck: false };
	}
	// 执行权不等于证据仍有效；明确恢复核对始终先检查内容身份。
	if (o.environmentChanged) {
		return {
			unit: "unknown",
			reason: "环境或代码变化，旧证据失效，重新确定执行范围",
			canResume: false,
			needRecheck: true,
		};
	}
	if (o.leaseHeld) {
		return { unit: "running", reason: "仍持有有效执行权，重新跟踪，不启动第二份", canResume: true, needRecheck: false };
	}
	if (o.hasUnconsumedResult) {
		return {
			unit: "running",
			reason: "持久化操作已产出结果但尚未完成验收消费，接续消费原结果（不重跑命令）",
			canResume: true,
			needRecheck: false,
		};
	}
	if (o.inFlight) {
		if (o.pidAlive === true) {
			return {
				unit: "running",
				reason: "在途执行仍在跑（本地/远端进程存活），重新跟踪不重启",
				canResume: true,
				needRecheck: false,
			};
		}
		return {
			unit: "unknown",
			reason: "在途执行结果未知（本地进程不可确认≠远端未执行），先查预期效果/证据",
			canResume: false,
			needRecheck: true,
		};
	}
	if (!o.lastRoundPassed) {
		return {
			unit: "failed-retryable",
			reason: "当前没有待确认执行，接续未完成阶段；新的命令必须重新经过启动门禁",
			canResume: true,
			needRecheck: false,
		};
	}
	return { unit: "unknown", reason: "无法确认执行现场，先核对证据再决定", canResume: false, needRecheck: true };
}

/** 精简恢复摘要（注入模型；完整日志按需读取）。 */
export function buildRecoverySummary(input: {
	runId: string;
	attemptId: string | null;
	generation: number;
	cls: RecoveryClass;
	completedRounds: number;
	bestRound: number | null;
	blockedOn: string | null;
	/** 仍在运行的本地执行实体 + 已收集的输出片段（Prompt 修复④：接续不只分类，还收集）。 */
	inFlightNote?: string | null;
}): string {
	const c = input.cls;
	const parts = [
		"<mini_harness_recovery>",
		"runId: " + input.runId + " | attempt: " + (input.attemptId ?? "(无)") + " | 代次: " + input.generation,
		"分类: " + c.unit + " — " + c.reason,
		"已完成并有效: " +
			input.completedRounds +
			" 轮" +
			(input.bestRound != null ? "（best=第 " + input.bestRound + " 轮）" : ""),
		input.blockedOn ? "当前阻塞: " + input.blockedOn : "当前阻塞: (无)",
		"下一步: " +
			(c.needRecheck
				? "先核对执行现场/证据，再决定"
				: c.canResume
					? "从缺失或失效部分继续，不从第一步整段重跑"
					: "保持终态，不自动执行"),
	];
	if (input.inFlightNote) parts.push(input.inFlightNote);
	parts.push("</mini_harness_recovery>");
	return parts.join("\n");
}
