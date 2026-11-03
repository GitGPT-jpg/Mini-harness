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

function leasePath(runDir: string): string {
	return path.join(runDir, "lease.json");
}

function readLease(runDir: string): Lease | null {
	try {
		return parseLease(fs.readFileSync(leasePath(runDir), "utf8"));
	} catch {
		return null;
	}
}

function parseLease(raw: string): Lease | null {
	try {
		const parsed = JSON.parse(raw) as Lease;
		if (parsed && typeof parsed.owner === "string" && typeof parsed.generation === "number") return parsed;
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
 * 单文件原子「读 → 校验 → 写回 / 删除」CAS（compare-and-swap）。
 *
 * 协议（所有写者都必须走这条协议，否则并发下不成立）：
 *  1. rename 原子认领：把目标文件移到唯一的 claim 路径（同一时刻只有一个进程能认领成功；
 *     认领失败 ENOENT 说明文件当前不存在）。
 *  2. 读认领到的旧内容，用 isExpected 校验是否允许改写。
 *  3. 允许 → 用 buildNext 生成新内容；null 表示删除；否则写临时文件后 link 放回
 *     （link 是原子且不覆盖：若并发者已重建目标，link 抛 EEXIST，则本次放弃）。
 *  4. 不允许 → 放弃：用 link 把认领的原文件放回（同样不覆盖并发者重建的新文件）。
 *
 * 为什么不用「rename 放回」：rename 会无条件覆盖目标；一旦并发者在认领窗口内重建了目标，
 * rename 会把它的新文件覆盖掉（即「旧写者覆盖新代次」）。link+unlink 天然具备「仅当目标不存在」语义。
 * 支持范围：单主机、持久本地文件系统（POSIX rename/link + O_EXCL）；不承诺 NFS/跨主机强一致。
 */
export function compareAndSwapFile(
	filePath: string,
	opts: {
		isExpected: (currentText: string | null) => boolean;
		buildNext: (currentText: string | null) => string | null;
	},
): { ok: boolean; current: string | null } {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const claim = filePath + ".cas." + process.pid + "." + crypto.randomBytes(4).toString("hex");
	let current: string | null = null;
	let claimed = false;
	try {
		try {
			fs.renameSync(filePath, claim);
			claimed = true;
		} catch {
			claimed = false; // ENOENT：目标不存在
		}
		if (claimed) {
			try {
				current = fs.readFileSync(claim, "utf8");
			} catch {
				current = null;
			}
		}
		if (!opts.isExpected(current)) {
			restoreClaim(claim, claimed, filePath);
			return { ok: false, current };
		}
		casTestBarrier();
		const next = opts.buildNext(current);
		if (next === null) {
			if (claimed) {
				try {
					fs.rmSync(claim, { force: true });
				} catch {}
			}
			return { ok: true, current };
		}
		const tmp = filePath + ".new." + process.pid + "." + crypto.randomBytes(4).toString("hex");
		fs.writeFileSync(tmp, next);
		try {
			fs.linkSync(tmp, filePath);
			try {
				fs.rmSync(tmp, { force: true });
			} catch {}
			if (claimed) {
				try {
					fs.rmSync(claim, { force: true });
				} catch {}
			}
			return { ok: true, current };
		} catch {
			// 并发者已重建目标（link EEXIST）：放弃本次写，把认领的原文件放回（同样不覆盖）。
			try {
				fs.rmSync(tmp, { force: true });
			} catch {}
			restoreClaim(claim, claimed, filePath);
			return { ok: false, current };
		}
	} catch {
		try {
			fs.rmSync(claim, { force: true });
		} catch {}
		return { ok: false, current };
	}
}

function restoreClaim(claim: string, claimed: boolean, filePath: string): void {
	if (!claimed) return;
	try {
		fs.linkSync(claim, filePath);
	} catch {
		// 并发者已重建目标：保留其新文件，认领的旧内容随 claim 一起清理。
	}
	try {
		fs.rmSync(claim, { force: true });
	} catch {}
}

/**
 * 测试专用竞争屏障（默认关闭，生产恒为 no-op）：仅当环境变量 MINI_HARNESS_CAS_BARRIER_DIR
 * 指向一个目录时启用。在 CAS 判定「允许改写」之后、真正 link 放置之前暂停，写 ready.<pid>
 * 并等待 <dir>/go 出现（上限 10s 后放行），用于确定性复现「A 已判定过期、B 先接管、A 再继续」的交错。
 * 普通用户任务输入无法启用（只能通过服务进程环境变量），不构成生产绕过口。
 */
function casTestBarrier(): void {
	const dir = process.env.MINI_HARNESS_CAS_BARRIER_DIR;
	if (!dir) return;
	try {
		fs.writeFileSync(path.join(dir, "ready." + process.pid), String(process.pid));
	} catch {}
	const go = path.join(dir, "go");
	const t0 = Date.now();
	while (Date.now() - t0 < 10_000) {
		try {
			if (fs.existsSync(go)) return;
		} catch {}
	}
}

/** 用 O_CREAT|O_EXCL 原子创建租约文件：同一路径只有一个创建者成功；用于「空目录首次取得」。 */
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
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
			try {
				fs.rmSync(leasePath(runDir), { force: true });
			} catch {}
		}
		return false;
	}
}

/**
 * 原子取得执行所有权：空目录首次取得用 O_EXCL；已存在则用 CAS 判「已过期才可接管」。
 * 两个进程竞争同一过期租约时只有一个成功（CAS 的 claim+link 保证），旧进程不会覆盖新代次。
 * 孤儿租约（owner 服务进程已死但心跳未过期）只在 opts.allowOrphan 时允许接管 —— 该语义属于
 * 服务级恢复（recoverRun），不属于裸 acquireLease 竞争者原语，避免短命竞争者退出后被误判「孤儿」。
 */
export function acquireLease(runDir: string, lease: Lease, opts?: { allowOrphan?: boolean }): boolean {
	if (tryCreateLeaseFile(runDir, lease)) return true;
	const next = JSON.stringify(lease, null, 2);
	const r = compareAndSwapFile(leasePath(runDir), {
		isExpected: (cur) => {
			// 不存在/不可解析/已过期 → 允许接管；仅服务级恢复（allowOrphan）才把「owner 服务进程已死」当孤儿。
			const p = parseLease(cur ?? "");
			if (!p) return true;
			if (leaseExpired(p)) return true;
			return opts?.allowOrphan === true && p.pid != null && !pidAliveLocal(p.pid);
		},
		buildNext: () => next,
	});
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
			return !!p && p.owner === owner && p.generation === generation;
		},
		buildNext: (cur) => {
			const p = parseLease(cur ?? "");
			if (!p) return null;
			return JSON.stringify({ ...p, heartbeatAt: new Date().toISOString() }, null, 2);
		},
	});
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
			return !!p && p.owner === expect.owner && p.generation === expect.generation;
		},
		buildNext: (cur) => {
			const p = parseLease(cur ?? "");
			if (!p) return null;
			return JSON.stringify(mutator(p), null, 2);
		},
	});
	return r.ok;
}

/** 释放所有权：仅当仍是 owner 时 CAS 删除；已被接管则不删（旧代次不得删除新租约）。 */
export function releaseLease(runDir: string, owner: string): boolean {
	const r = compareAndSwapFile(leasePath(runDir), {
		isExpected: (cur) => {
			const p = parseLease(cur ?? "");
			return !!p && p.owner === owner;
		},
		buildNext: () => null,
	});
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
	/** 仍在运行的本地执行实体 + 已收集的输出片段（Prompt 修复④：接续不只分类，还收集）。 */
	inFlightNote?: string | null;
}): string {
	const c = input.cls;
	const parts = [
		"<mini_harness_recovery>",
		"runId: " + input.runId + " | attempt: " + (input.attemptId ?? "(无)") + " | 代次: " + input.generation,
		"分类: " + c.unit + " — " + c.reason,
		"已完成并有效: " + input.completedRounds + " 轮" + (input.bestRound != null ? "（best=第 " + input.bestRound + " 轮）" : ""),
		input.blockedOn ? "当前阻塞: " + input.blockedOn : "当前阻塞: (无)",
		"下一步: " + (c.needRecheck ? "先核对执行现场/证据，再决定" : c.canResume ? "从缺失或失效部分继续，不从第一步整段重跑" : "保持终态，不自动执行"),
	];
	if (input.inFlightNote) parts.push(input.inFlightNote);
	parts.push("</mini_harness_recovery>");
	return parts.join("\n");
}
