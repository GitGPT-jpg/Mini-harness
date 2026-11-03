/**
 * 隔夜恢复的最小执行记录与「先核对，再接续」原语。
 *
 * 设计目标：跨中断恢复不是加定时器。持久化 runId/taskId/attemptId、执行所有权（租约/心跳/代次）、
 * 环境指纹、已启动操作的身份与证据位置；恢复时先核对本地/远端进程与证据，再只从缺失或失效的部分继续。
 *
 * 本模块只提供纯函数与文件级租约原语，不包含任何领域/集群命令。
 *  - attempt：run 内的一次执行代次；重试分配新 attempt，保留旧 attempt 证据；
 *  - lease： 文件级执行所有权（owner + pid + generation + heartbeat），跨进程互斥，O_EXCL 独占创建保证只有一个赢家；
 *  - fingerprint：workspace + git HEAD + 能力包版本 + 规范化输入 + 环境变量摘要，判定旧证据是否仍适用。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
}

export interface EnvironmentFingerprint {
	workspace: string;
	gitHead: string | null;
	/** 工作区内容指纹（git HEAD + 未提交改动摘要）；非 git 仓库时退化为目录关键文件摘要。 */
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
	const canon = JSON.stringify(Object.keys(inputs).sort().map((k) => [k, String(inputs[k] ?? "")]));
	return sha256(canon);
}

/** 任意内容的稳定摘要（用于未提交 diff 等；只取内容指纹，不落地原文）。 */
export function hashString(s: string): string {
	return sha256(s);
}

/** 环境变量摘要：只取身份相关项，绝不把密钥/Token 写入摘要或状态。 */
const ENV_ID_KEYS = ["HARNESS_CWD", "PI_WEB_CWD", "HARNESS_ENGINE", "HARNESS_SDK"];
export function hashEnvironment(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): string {
	const parts = ENV_ID_KEYS.map((k) => k + "=" + (env[k] ?? "")).join("|");
	return sha256(parts);
}

/** 生成新的 attemptId（同一 run 内多次尝试互斥、可追溯）。 */
export function newAttemptId(): string {
	return crypto.randomBytes(6).toString("hex");
}

/** 生成 owner 标识（pid@host，跨页/跨实例可辨认）。 */
export function newOwner(): string {
	return process.pid + "@" + os.hostname();
}

function leasePath(runDir: string): string {
	return path.join(runDir, "lease.json");
}

function readLease(runDir: string): Lease | null {
	try {
		const raw = JSON.parse(fs.readFileSync(leasePath(runDir), "utf8")) as Lease;
		if (raw && typeof raw.owner === "string" && typeof raw.generation === "number") return raw;
		return null;
	} catch {
		return null;
	}
}

/** 租约是否已过期（心跳超过 TTL）。 */
export function leaseExpired(lease: Lease | null, nowMs = Date.now()): boolean {
	if (!lease) return true;
	const t = Date.parse(lease.heartbeatAt) || 0;
	return nowMs - t > LEASE_TTL_MS;
}

/**
 * 用 O_CREAT|O_EXCL 原子创建租约文件：文件系统保证同一路径只有一个创建者成功。
 * 成功写入并 fsync 后返回 true；EEXIST（他人已建）返回 false；写入失败时清理半成品并返回 false。
 * 这是「同宿主多进程 + 单机多页面」互斥的原子原语：不是「写后读回」，而是内核级独占创建。
 */
function tryCreateLeaseFile(runDir: string, lease: Lease): boolean {
	let fd: number | null = null;
	try {
		fs.mkdirSync(runDir, { recursive: true });
		fd = fs.openSync(leasePath(runDir), "wx", 0o600);
		try {
			fs.writeFileSync(fd, JSON.stringify(lease, null, 2));
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
			fd = null;
		}
		return true;
	} catch (e) {
		if (fd != null) {
			try {
				fs.closeSync(fd);
			} catch {}
		}
		// 创建成功后写入失败：清掉半成品，避免留下无法解析的锁文件。
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
			try {
				fs.rmSync(leasePath(runDir), { force: true });
			} catch {}
		}
		return false;
	}
}

/**
 * 原子取得执行所有权。两个实例 / 两个页面同时请求时只有一个赢家：
 * 1. 先用 O_EXCL 独占创建——文件系统保证只有一个赢家；
 * 2. 已存在且未过期 → 他人仍持权，返回 false；
 * 3. 已存在但已过期（失联/崩溃/休眠）→ 原子 rename 移走旧文件再独占创建：
 *    rename 是原子移动，两个竞争者的 rename 只有一个成功，另一个得到 ENOENT 后回到独占创建，
 *    最终仍只有一个进程创建成功（真正的赢家），其余进程创建 EEXIST 或读回新租约后判负。
 *
 * 支持拓扑：单机多进程 / 多页面、同一本地（或具备 POSIX rename + O_EXCL 语义的共享）文件系统。
 * 跨主机 NFS/对象存储不保证强一致，明确标注为不支持。
 */
export function acquireLease(runDir: string, lease: Lease): boolean {
	try {
		if (tryCreateLeaseFile(runDir, lease)) return true;
		const cur = readLease(runDir);
		if (cur && !leaseExpired(cur)) return false;
		// 过期 / 无法解析 → 尝试接管：原子移走旧文件，再独占创建。
		const stale = leasePath(runDir) + ".stale." + process.pid + "." + crypto.randomBytes(4).toString("hex");
		try {
			fs.renameSync(leasePath(runDir), stale);
		} catch {
			// ENOENT：他人已移走旧文件并可能已重建。落到下面的独占创建，赢则赢、输则输。
		}
		try {
			fs.rmSync(stale, { force: true });
		} catch {}
		return tryCreateLeaseFile(runDir, lease);
	} catch {
		return false;
	}
}

/** 读取当前租约（供恢复核对 / 展示用）。 */
export function getLease(runDir: string): Lease | null {
	return readLease(runDir);
}

/** 续租：仍是当前 owner+generation 才更新心跳；否则返回 false（已被他人接管）。 */
export function heartbeat(runDir: string, owner: string, generation: number): boolean {
	try {
		const cur = readLease(runDir);
		if (!cur || cur.owner !== owner || cur.generation !== generation) return false;
		const next = { ...cur, heartbeatAt: new Date().toISOString() };
		const tmp = leasePath(runDir) + ".hb." + process.pid + "." + crypto.randomBytes(4).toString("hex");
		fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
		// rename 到同一路径是原子的；但必须确认当前 owner 仍是自己（rename 会覆盖他人文件）。
		// 因此 rename 前再读一次校验 owner+generation，随后立即 rename，窗口极小且只能自己覆盖自己。
		const before = readLease(runDir);
		if (!before || before.owner !== owner || before.generation !== generation) {
			fs.rmSync(tmp, { force: true });
			return false;
		}
		fs.renameSync(tmp, leasePath(runDir));
		return true;
	} catch {
		return false;
	}
}

/** 释放所有权：仅当仍是 owner 时移除；已被接管则不删。 */
export function releaseLease(runDir: string, owner: string): boolean {
	try {
		const cur = readLease(runDir);
		if (cur && cur.owner === owner) {
			fs.rmSync(leasePath(runDir), { force: true });
			return true;
		}
		return false;
	} catch {
		return false;
	}
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
}

/**
 * 恢复分类：把 run 归入 completed-valid / running / failed-retryable / unknown / cancelled。
 * 规则：已取消不复活；完成且证据有效不复跑；仍持权重新跟踪不重启；
 * 结果未知先核对预期效果/补证据，不盲目重跑；环境或代码变化使旧证据失效。
 */
export function classifyRecovery(st: { status: string; stopRequestedAt?: string | null }, o: ClassifyOptions): RecoveryClass {
	if (st.status === "stopped") {
		return { unit: "cancelled", reason: "已停止，不自动复活", canResume: false, needRecheck: false };
	}
	if (st.status === "done") {
		if (o.environmentChanged) {
			return { unit: "unknown", reason: "完成态但环境/代码已变化，旧证据失效，需重新核对", canResume: false, needRecheck: true };
		}
		return { unit: "completed-valid", reason: "已完成且证据有效，复用不重跑", canResume: false, needRecheck: false };
	}
	if (o.leaseHeld) {
		return { unit: "running", reason: "仍持有有效执行权，重新跟踪，不启动第二份", canResume: true, needRecheck: false };
	}
	// 失联（lease 过期/缺失）：先核对，不盲目重跑。
	if (o.environmentChanged) {
		return { unit: "unknown", reason: "环境或代码变化，旧证据失效，重新确定执行范围", canResume: false, needRecheck: true };
	}
	if (o.inFlight) {
		if (o.pidAlive === true) {
			return { unit: "running", reason: "在途执行仍在跑（本地/远端进程存活），重新跟踪不重启", canResume: true, needRecheck: false };
		}
		return { unit: "unknown", reason: "在途执行结果未知（本地进程不可确认≠远端未执行），先查预期效果/证据", canResume: false, needRecheck: true };
	}
	if (!o.lastRoundPassed) {
		return { unit: "failed-retryable", reason: "最近一轮明确失败，允许重试 → 新 attempt", canResume: true, needRecheck: false };
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
}): string {
	const c = input.cls;
	const parts = [
		"<mini_harness_recovery>",
		"runId: " + input.runId + " | attempt: " + (input.attemptId ?? "(无)") + " | 代次: " + input.generation,
		"分类: " + c.unit + " — " + c.reason,
		"已完成并有效: " + input.completedRounds + " 轮" + (input.bestRound != null ? "（best=第 " + input.bestRound + " 轮）" : ""),
		input.blockedOn ? "当前阻塞: " + input.blockedOn : "当前阻塞: (无)",
		"下一步: " + (c.needRecheck ? "先核对执行现场/证据，再决定" : c.canResume ? "从缺失或失效部分继续，不从第一步整段重跑" : "保持终态，不自动执行"),
		"</mini_harness_recovery>",
	];
	return parts.join("\n");
}
