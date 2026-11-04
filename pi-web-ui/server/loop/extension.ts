/**
 * mini-harness Loop 扩展 —— 受控任务运行时（源码版，正式接入 pi-web-ui）
 *
 * 移植自 pi-web-cockpit/vendor/mini-harness-runtime（DOM 注入时代的运行时），
 * 本版为源码级正式实现，包含四项正确性修复：
 *
 *  1) 任务绑定只认显式 sessionId（去掉「同 cwd 最新活跃 run」兜底，杜绝串任务）；
 *  2) epoch 代际守卫：停止即递增代次，所有 await 之后的续写先核对代次与活跃态，
 *     迟到回调不得把 stopped 翻转成 done，也不得继续调度下一轮；
 *  3) LLM loop 关闭 reviewer 时按「模型自述完成」收尾（self-declared），
 *     不再以 reviewer-error 停止；
 *  4) loop_start 支持 taskId（外部批量/编排显式关联用），落进运行状态。
 *
 * D-12（见 HANDOFF §13.1）：完成态可信度 acceptance（评审出错不算完成，可重试评审 /
 * 按代码验证收下）；服务端结构化启动 createLoopRun（先建 run 再让模型干活，模型准备
 * 挪到 before_agent_start）。
 *
 * 状态落盘在仓库之外（默认 ~/.mini-harness/runs/<id>/state.json + journal.jsonl），
 * 进程重启后可识别孤立运行（alive 判定在服务层）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	collectPreflightSummary,
	evaluateMetricGate,
	parseHarnessMetrics,
	parseHarnessScenario,
	pickBetterRound,
	resolveGitHeadSha,
	type BestRoundRecord,
	type HardConstraint,
	type HarnessMetrics,
	type MetricGateResult,
	type MetricTarget,
} from "./metrics.js";
import { createWorkspaceSnapshot } from "../workspace-snapshot.js";
import { cancelRunOperations, listOperations, observeOperation, runCommandPersistent, type OpRecord } from "./operation.js";
import { withRunLockSync, writeFileAtomicPreserveSync } from "./storage.js";
import { computeExecutionFingerprint } from "./fingerprint.js";
import { normalizeTaskInputs, resolveTaskContext, type TaskContext } from "./discovery.js";
import { runCommand } from "./run-command.js";
import {
	acquireLease,
	buildRecoverySummary,
	classifyRecovery,
	getLease,
	getProcessStartId,
	heartbeat,
	LEASE_HEARTBEAT_MS,
	leaseExpired,
	mutateLease,
	newAttemptId,
	newOwner,
	releaseLease,
	type EnvironmentFingerprint,
} from "./recovery.js";

const DEFAULT_MAX_ROUNDS = 5;
const CUSTOM_TYPE = "mini-harness-loop";
const ROOT = process.env.MINI_HARNESS_RUNTIME_ROOT || path.join(os.homedir(), ".mini-harness", "runs");
const ACTIVE_STAGES = new Set(["intake", "plan", "run", "validate"]);
const RUN_ID_RE = /^[0-9]{8,}-[a-z0-9]{4,}$/i;
// A token read from disk is evidence, not local authorization.
const localClaims = new Map<string, { owner: string; generation: number }>();
function locallyClaimed(runId: string, owner: string | null, generation: number): boolean {
	const claim = localClaims.get(runId);
	return !!claim && claim.owner === owner && claim.generation === generation;
}

// ---------- 执行取消上下文（Task 1：停止要作用于实际执行） ----------

/** 每个 run 在途 validator / precheck 的取消控制器（模块级，跨会话可找到）。 */
const runAborts = new Map<string, AbortController>();

/** 为指定 run 注册一个取消控制器；返回的 controller 一旦 abort，在途子进程组被杀。 */
function registerRunAbort(runId: string): AbortController {
	// 同一 run 理论上同一时刻只有一个 validator 在途；防御性替换旧控制器并触发它失效。
	const prev = runAborts.get(runId);
	if (prev) prev.abort();
	const ac = new AbortController();
	runAborts.set(runId, ac);
	return ac;
}

/** 释放指定 run 的取消控制器（validator 正常跑完时清理，不再持有引用）。 */
function releaseRunAbort(runId: string, ac: AbortController): void {
	if (runAborts.get(runId) === ac) runAborts.delete(runId);
}

/**
 * 停止时真正取消该 run 的在途 validator / precheck 子进程组。
 * 只杀属于该 run 的进程组；不影响同工作区其它任务。
 */
function abortRun(runId: string): void {
	const ac = runAborts.get(runId);
	if (ac) ac.abort();
}

// ---------- 绑定会话的模型回合取消（停止要作用于 Pi 回合，而不只是 validator 进程） ----------

/**
 * 服务层为每个活跃 run 注册的回合控制器：abort 取消该 run 绑定会话（原会话或
 * worktree 执行者）的在途回合，turnEnded 给出可核验的「回合已结束」判定。
 * 宿主消失或会话未加载时没有注册项：不存在可取消的回合，不能据此声称回合仍在运行。
 */
const runTurnControllers = new Map<
	string,
	{ turnId: string; sessionId: string; generation: number | null; abort: () => void; turnEnded: () => boolean }
>();

/**
 * 注册回合控制器：绑定用 runId + sessionId + turnId + generation 标识。
 * generation 取自注册时点的租约：接管/恢复（generation 递增）后旧控制器自动失效，
 * 停止不得据此取消接管后的实体。由 before_agent_start 在 run 回合启动时注册
 * （普通聊天回合不注册），agent_end 只注销属于本会话本回合的控制器。
 */
export function registerRunTurnController(
	runId: string,
	controller: { abort: () => void; turnEnded: () => boolean },
	turnId: string = crypto.randomUUID(),
	sessionId = "",
): void {
	runTurnControllers.set(runId, {
		...controller,
		turnId,
		sessionId,
		generation: getLease(runDir(runId))?.generation ?? null,
	});
}
export function unregisterRunTurnController(runId: string): void {
	runTurnControllers.delete(runId);
}

/**
 * 扩展可见的「本进程有在途回合」标记：run 回合投递/启动时置位、agent_end 清除。
 * 服务层控制器未注册时（例如宿主刚重启、会话尚未恢复）作为回合在途的兜底判断；
 * 已注册时以服务层的 turnEnded 为准（agent_end 可能因强制重置不触发）。
 */
const runTurnActive = new Set<string>();
const runTurnSessions = new Map<string, string>();
/** runId → 最近一次登记的 run 回合 turnId（同会话新回合覆盖旧值）。 */
const runTurnTurns = new Map<string, string>();

/**
 * runId → 最近一次「run 回合投递」登记：服务层 startLoop/resumeLoop、扩展内
 * 下一轮/LLM 复审的 sendUserMessage 之前调用。before_agent_start 据此区分 run
 * 回合与同会话的普通聊天回合 —— 只有 run 回合置「回合在途」证据并注册控制器，
 * 普通聊天回合不注册、不被停止取消。
 */
const runTurnDispatches = new Map<string, { sessionId: string; turnId: string }>();

/** 登记一次 run 回合投递，返回该回合的 turnId。投递即持久化「回合在途」证据：
 *  停止在回合排队窗口也能看到有回合在途；before_agent_start 消费登记并注册该回合的控制器。 */
export function markRunTurnDispatch(runId: string, sessionId: string): string {
	const turnId = crypto.randomUUID();
	runTurnDispatches.set(runId, { sessionId, turnId });
	runTurnTurns.set(runId, turnId);
	runTurnActive.add(runId);
	runTurnSessions.set(runId, sessionId);
	try {
		const st = loadState(runId);
		if (st?.owner) {
			st.turnActive = { owner: st.owner, since: now(), turnId };
			saveState(st);
		}
	} catch {}
	return turnId;
}

/** 投递失败（sendUserMessage 拒绝）：撤销投递登记，回合从未开始，不留下虚假的「回合在途」证据。 */
export function unmarkRunTurnDispatch(runId: string): void {
	runTurnDispatches.delete(runId);
	runTurnActive.delete(runId);
	runTurnSessions.delete(runId);
	runTurnTurns.delete(runId);
	try {
		const st = loadState(runId);
		if (st?.turnActive) {
			st.turnActive = null;
			saveState(st);
		}
	} catch {}
}

/**
 * run 回合启动（before_agent_start）：消费投递登记并注册该回合的取消控制器。
 * 没有投递登记（同会话的普通聊天回合）不置位、不注册 —— 停止只取消「已注册且
 * 对应本回合」的实体。setupPending 的 run（legacy loop_start 路径建在回合中）
 * 尚未开跑，本轮就是它的首个 run 回合，也注册。
 */
export function beginLoopTurn(
	runId: string,
	sessionId: string,
	c: { abort?: () => void; isIdle?: () => boolean } = {},
): void {
	const st = loadState(runId);
	if (!st || st.status !== "active") return;
	const disp = runTurnDispatches.get(runId);
	const dispatched = disp?.sessionId === sessionId;
	if (!dispatched && !st.setupPending) return;
	runTurnDispatches.delete(runId);
	const turnId = dispatched ? disp!.turnId : crypto.randomUUID();
	runTurnActive.add(runId);
	runTurnSessions.set(runId, sessionId);
	runTurnTurns.set(runId, turnId);
	if (st.owner) {
		try {
			st.turnActive = { owner: st.owner, since: now(), turnId };
			saveState(st);
		} catch {}
	}
	// 回合控制器绑定本回合：abort 取消本运行时当前回合，turnEnded 用本运行时 idle 判定。
	registerRunTurnController(
		runId,
		{
			abort: () => {
				try {
					c.abort?.();
				} catch {}
			},
			turnEnded: () => {
				try {
					// 只有可核验地 idle 才算回合已结束：拿不到判定（无 isIdle）→ 保持未确认。
					return c.isIdle?.() === true;
				} catch {
					return false;
				}
			},
		},
		turnId,
		sessionId,
	);
}

/** 回合结束（agent_end）：只清理属于本会话的「回合在途」标记与控制器（清理自己）。 */
export function endLoopTurnsForSession(sessionId: string): void {
	for (const [runId, sid] of runTurnSessions) {
		if (sid === sessionId) {
			runTurnSessions.delete(runId);
			runTurnActive.delete(runId);
			clearPersistedTurnActive(runId);
		}
	}
	// 只注销绑定本会话且仍对应本回合的控制器：别的会话/新回合的取消域不受影响。
	for (const [runId, ctl] of runTurnControllers) {
		if (ctl.sessionId === sessionId && ctl.turnId === runTurnTurns.get(runId)) {
			unregisterRunTurnController(runId);
		}
	}
}

/** 清除落盘的「回合在途」持久证据（回合结束时调用；失败不影响回合已结束的事实）。 */
function clearPersistedTurnActive(runId: string): void {
	try {
		const st = loadState(runId);
		if (!st || !st.turnActive) return;
		st.turnActive = null;
		saveState(st);
	} catch {}
}

// ---------- 租约心跳生命周期（Task B：心跳接入真实服务生命周期） ----------

/** 每个活跃 run 的心跳定时器（模块级，跨会话共享；run 终态时清理）。 */
const runHeartbeats = new Map<string, ReturnType<typeof setInterval>>();

/**
 * 启动心跳：持有者进程周期续租。只有「仍是当前 owner+generation」时续租成功；
 * 失去所有权（被他人接管）时停止调度并记录一次丢失，避免旧实例继续推进新代次。
 */
export function startLeaseHeartbeat(runId: string, owner: string, generation: number): void {
	stopLeaseHeartbeat(runId);
	const t = setInterval(() => {
		let ok = false;
		try {
			ok = heartbeat(runDir(runId), owner, generation);
		} catch {
			// Storage failure fences further scheduling; never renew from a stale Run.
		}
		if (!ok) {
			// 续租失败：失去所有权或被删除。停表，不再调度新操作。
			stopLeaseHeartbeat(runId);
			journal(loadState(runId) ?? ({ runId, round: 0 } as LoopState), "heartbeat-lost", { owner, generation });
		}
	}, LEASE_HEARTBEAT_MS);
	t.unref?.();
	runHeartbeats.set(runId, t);
}

/** 停止并清除心跳定时器。 */
export function stopLeaseHeartbeat(runId: string): void {
	const t = runHeartbeats.get(runId);
	if (t) {
		clearInterval(t);
		runHeartbeats.delete(runId);
	}
}

/** 进程退出 / 关闭时清理所有心跳定时器（定时器不引用 event loop，unref 已足够；此处兜底）。 */
function stopAllHeartbeats(): void {
	for (const runId of runHeartbeats.keys()) stopLeaseHeartbeat(runId);
}
process.once("exit", stopAllHeartbeats);

/**
 * 把本地实际执行实体 pid（validator/precheck 子进程组）写进租约，供恢复核对。
 * 走 CAS：仅当仍是当前 owner+generation 才写，旧代次/被接管者不得替新执行者写入或清空 PID。
 */
export function recordTaskPid(runId: string, pid: number | null, owner: string, generation: number): void {
	try {
		mutateLease(runDir(runId), { owner, generation }, (cur) => ({ ...cur, taskPid: pid }));
	} catch {}
}

/** 命令执行器：生产用 runCommand（detached 进程组 + 真实 pid）；单测注入 pi.exec mock。 */
type LoopExecOpts = {
	cwd: string;
	timeout: number;
	signal?: AbortSignal;
	onSpawn?: (pid: number) => void;
	/** 持久化执行上下文：提供时 stdio 落文件 + 写 operation.json，重启后可用 observeOperation 接续。 */
	runId?: string;
	stage?: string;
	round?: number;
	attemptId?: string | null;
	snapshotRef?: string | null;
	snapshotSha?: string | null;
	recoverable?: boolean;
	canControl?: () => boolean;
};
type LoopExecResult = { stdout: string; stderr: string; code: number | null; killed: boolean; opId?: string };
let loopExecOverride: ((cmd: string, args: string[], opts: LoopExecOpts) => Promise<LoopExecResult>) | null = null;
export function setLoopExecForTest(fn: typeof loopExecOverride): void {
	loopExecOverride = fn;
}
function loopExec(cmd: string, args: string[], opts: LoopExecOpts): Promise<LoopExecResult> {
	if (loopExecOverride) return loopExecOverride(cmd, args, opts);
	if (opts.runId && opts.stage) {
		return runCommandPersistent(cmd, args, {
			...opts,
			cwd: opts.cwd,
			runId: opts.runId,
			stage: opts.stage,
			round: opts.round ?? 0,
			signal: opts.signal,
			timeout: opts.timeout,
			onSpawn: opts.onSpawn,
		});
	}
	return runCommand(cmd, args, { ...opts });
}

/** 从 run 状态构建指标门禁目标（含单位/阈值/容差/场景）；旧 metricPrecision 不再参与判定。 */
function metricTargetOf(st: LoopState): MetricTarget | null {
	if (!st.primaryMetric || !st.metricDirection) return null;
	return {
		metric: st.primaryMetric,
		direction: st.metricDirection,
		...(st.metricUnit ? { unit: st.metricUnit } : {}),
		...(st.metricThreshold != null && st.metricThresholdOp
			? { threshold: { op: st.metricThresholdOp, value: st.metricThreshold } }
			: {}),
		...(st.metricTolerance != null ? { tolerance: st.metricTolerance } : {}),
		...(st.metricScenario ? { scenario: st.metricScenario } : {}),
	};
}

function isThresholdOp(v: unknown): v is "lt" | "lte" | "gt" | "gte" {
	return v === "lt" || v === "lte" || v === "gt" || v === "gte";
}

/** 清洗硬约束入参：只保留有指标名、合法运算符、数值合法的条目。 */
function sanitizeHardConstraints(input: unknown): HardConstraint[] | null {
	if (!Array.isArray(input)) return null;
	const out: HardConstraint[] = [];
	for (const raw of input) {
		if (!raw || typeof raw !== "object") continue;
		const r = raw as Record<string, unknown>;
		const name = String(r.name ?? "").trim();
		const metric = String(r.metric ?? "").trim();
		const op = r.op;
		const value = Number(r.value);
		if (!name || !metric || !isThresholdOp(op) || !Number.isFinite(value)) continue;
		out.push({
			name,
			metric,
			op,
			value,
			...(r.unit != null ? { unit: String(r.unit).trim() } : {}),
			...(r.scenario != null ? { scenario: String(r.scenario).trim() } : {}),
		});
	}
	return out.length > 0 ? out : null;
}

/**
 * 校验 Loop 入参中用户声明的硬约束/阈值/类型是否合法。
 * 返回字段级错误列表；非空时启动必须拒绝，绝不静默删除条目后继续（那会削弱验收要求）。
 */
function validateLoopInputs(input: CreateLoopRunInput): string[] {
	const errors: string[] = [];
	// 主指标阈值成对校验：给了值必须给运算符，给了运算符必须给值，值必须有限。
	const th = input.metricThreshold;
	const thOp = input.metricThresholdOp;
	if ((th != null && thOp == null) || (th == null && thOp != null)) {
		errors.push("metricThreshold 与 metricThresholdOp 必须成对提供");
	}
	if (th != null && !Number.isFinite(Number(th))) {
		errors.push("metricThreshold 必须是有限数值（收到：" + JSON.stringify(th) + "）");
	}
	if (thOp != null && !isThresholdOp(thOp)) {
		errors.push("metricThresholdOp 必须是 lt/lte/gt/gte 之一（收到：" + JSON.stringify(thOp) + "）");
	}
	if (input.metricDirection != null && input.metricDirection !== "maximize" && input.metricDirection !== "minimize") {
		errors.push("metricDirection 必须是 maximize/minimize（收到：" + JSON.stringify(input.metricDirection) + "）");
	}
	if (input.metricTolerance != null && !Number.isFinite(Number(input.metricTolerance))) {
		errors.push("metricTolerance 必须是有限数值（收到：" + JSON.stringify(input.metricTolerance) + "）");
	}
	// 硬约束逐条校验：非法条目必须报出字段名，不能静默丢弃。
	if (input.hardConstraints != null) {
		if (!Array.isArray(input.hardConstraints)) {
			errors.push("hardConstraints 必须是数组");
		} else {
			input.hardConstraints.forEach((c, i) => {
				const name = String(c?.name ?? "").trim();
				const metric = String(c?.metric ?? "").trim();
				const value = Number(c?.value);
				if (!name) errors.push(`hardConstraints[${i}].name 不能为空`);
				if (!metric) errors.push(`hardConstraints[${i}].metric 不能为空`);
				if (!isThresholdOp(c?.op)) errors.push(`hardConstraints[${i}].op 必须是 lt/lte/gt/gte 之一`);
				if (!Number.isFinite(value)) errors.push(`hardConstraints[${i}].value 必须是有限数值`);
			});
		}
	}
	return errors;
}

/** 工具执行的 ctx（模型注册表/会话 id 等）；SDK 类型面较宽，这里按实际使用收窄。 */
type LoopCtx = {
	model?: { provider?: string; id: string } | null;
	modelRegistry?: {
		find: (provider: string, id: string) => { provider: string; id: string } | undefined;
		getAll?: () => Array<{ provider?: string; id: string }>;
		getAvailable?: () => Array<{ provider?: string; id: string }>;
		complete: (model: unknown, context: unknown) => Promise<{ content?: Array<{ type: string; text?: string }> }>;
	} | null;
	sessionManager?: { getSessionId?: () => string } | null;
	cwd?: string;
	ui?: { notify?: (message: string, type?: string) => void } | null;
};

/**
 * 完成态可信度（D-12-1），只在 status=done 时有值：
 *  - passed：代码验证 + 模型评审都过（LLM 模式：评审通过）；
 *  - passed-validator-only：只有代码验证（没开评审 / 没有可用评审模型，或评审掉线后用户按代码验证收下）；
 *  - self-declared：LLM 模式关了评审，按模型自述完成。
 */
export type LoopAcceptance = "passed" | "passed-validator-only" | "self-declared";

/** 运行状态（state.json 的结构；字段与旧运行时保持兼容）。 */
export interface LoopState {
	runId: string;
	revision?: number;
	inputs?: Record<string, string | null>;
	taskContext?: TaskContext;
	/** Result application and acceptance facts share this single state commit. */
	consumedResults?: Record<string, { digest: string; round: number; stage: string }>;
	validationIdentity?: {
		round: number;
		attemptId: string | null;
		fingerprint: EnvironmentFingerprint;
	} & AttemptIdentity;
	reviewStep?: {
		id: string;
		round: number;
		status: "requested" | "completed";
		result?: Awaited<ReturnType<typeof runReview>>;
	};
	taskId: string | null;
	goal: string;
	workspace: string;
	baseWorkspace: string;
	worktreeDir: string | null;
	worktreeBranch: string | null;
	worktreeCommitted: boolean;
	harnessRoot: string | null;
	artifactRoots: string[];
	/** L0 快速预检命令（语法/配置/轻量检查）：失败直接拦截，不跑昂贵的 L1 validateCmd 与 reviewer。 */
	precheckCmd?: string | null;
	validateCmd: string | null;
	/** 主指标名（如 loss_pct / tps / ttft_ms）：声明后 bestRound 比较只认它，不按名字猜。 */
	primaryMetric?: string | null;
	/** 主指标优化方向。 */
	metricDirection?: "maximize" | "minimize" | null;
	/** @deprecated 旧「精度/硬约束」字段，已被 threshold/tolerance 拆分，仅向后兼容读取。 */
	metricPrecision?: number | null;
	/** 主指标声明单位（如 % / tokens/s / ms）；未声明 = 口径无法确认。 */
	metricUnit?: string | null;
	/** 主指标目标阈值（与 metricThresholdOp 成对使用）。 */
	metricThreshold?: number | null;
	/** 主指标目标阈值运算符：lt / lte / gt / gte。 */
	metricThresholdOp?: "lt" | "lte" | "gt" | "gte" | null;
	/** 最优轮次比较的数值容差（相对量，仅择优，不是阈值）。 */
	metricTolerance?: number | null;
	/** 必要场景配置（如 "ascache-on-vs-radix-off"）；声明后 validator 必须报出匹配场景。 */
	metricScenario?: string | null;
	/** 必要硬约束（主指标之外的证据门禁，如精度/稳定性/输入长度）。 */
	hardConstraints?: HardConstraint[] | null;
	/** 停止请求发出时间（区分「已发出停止请求」与「本地执行已确认停止」）。 */
	stopRequestedAt?: string | null;
	/** 本地执行（validator/precheck 子进程组）确认退出时间；未确认 = 仍可能在途或远端未知。 */
	stopConfirmedAt?: string | null;
	/** 绑定会话的「回合在途」持久证据（owner = 启动回合的宿主身份，turnId 区分回合）。
	 *  宿主重启后内存标记消失，停止/恢复必须依据这条持久证据判断旧回合是否已随宿主结束。 */
	turnActive?: { owner: string; since: string; turnId: string } | null;
	/** 停止请求绑定的回合（发起停止时登记的 turnId）：只等待该回合退出，不取消后来开始的回合。 */
	stopTurnId?: string | null;
	/**
	 * 接管前从旧租约保留的执行实体证据（旧协议 run 可能没有 operation）。
	 * 只作核对线索：身份未核实时不向该 pid 发信号，也不自动重放任务。
	 */
	legacyExecutionEntities?: Array<{
		pid: number;
		host: string | null;
		startId: string | null;
		capturedAt: string;
		generation: number;
	}>;
	/** 最近一轮的指标门禁结果（命令成功 ≠ 指标达标）。 */
	lastMetricGate?: MetricGateResult | null;
	maxRounds: number;
	auto: boolean;
	mode: "code" | "llm";
	round: number;
	stage: string;
	status: "active" | "done" | "stopped";
	stopReason?: string;
	epoch: number;
	sessionId: string;
	mainModel: { provider?: string; id: string; family: string } | null;
	plannerModel: { provider?: string; id: string; family: string } | null;
	reviewerModel: { provider?: string; id: string; family: string } | null;
	plannerOutput: string;
	lastReview: { verdict: string; reasons?: string[]; diff?: string } | null;
	lastDiff?: string;
	plan: string;
	summary: string;
	lastVerdict: string | null;
	lastCode: number | null;
	lastEvidence: string;
	validatedRound: number;
	createdAt: string;
	updatedAt?: string;
	history: Array<{
		round: number;
		verdict: string;
		code: number | null;
		at: string;
		evidence: string | null;
		metrics?: HarnessMetrics;
		commitSha?: string | null;
		/** 可恢复的代码快照引用（git 快照 ref / 目录快照路径）。 */
		snapshotRef?: string | null;
		precheckFailed?: boolean;
		/** 指标门禁是否通过（命令 exit 0 但缺主指标/违反硬约束时为 false）。 */
		metricGateOk?: boolean;
		/** 指标门禁未通过的原因（中文，便于 UI/经验卡片展示）。 */
		metricGateReasons?: string[];
		/** 验收期间工作区发生变化：结果不可信，不能作为有效通过或最优 Checkpoint。 */
		workspaceChangedDuringValidation?: boolean;
		/** 本轮是否具备可恢复快照（git 仓库且快照成功）。非 git / 快照失败 = false。 */
		recoverable?: boolean;
	}>;
	/** 最近一轮提取的 HARNESS_METRIC 数值指标。 */
	lastMetrics?: HarnessMetrics | null;
	/** 最优轮次 Checkpoint（防止后续轮次退化）。 */
	bestRound?: BestRoundRecord | null;
	/** 指标最好、但未通过必要验收资格（精度/稳定性/必要评审）的观察候选；与 bestRound 明确区分。 */
	observedBest?: BestRoundRecord | null;
	/** 工作区前置环境摘要（分支、HEAD SHA、关键文件）。 */
	preflightSummary?: string;
	/** 完成态可信度（见 LoopAcceptance）；未完成 = null。旧 state.json 没有该字段，读入按 null。 */
	acceptance: LoopAcceptance | null;
	/** 是否启用模型评审（默认 true）。旧 state.json 没有该字段，读入按「有没有评审模型」推断。 */
	useReviewer: boolean;
	/** 用户写的验收标准（自然语言），进规划 / 评审提示词与状态块。 */
	criteria?: string;
	/** 服务端建的 run 还没做模型准备（D-12-2）：before_agent_start 做完家族解析与规划即清掉。 */
	setupPending?: boolean;
	/** 模型准备失败原因（stopReason=setup-error 时有值）。 */
	setupError?: string;
	/** 请求的规划 / 评审模型（provider/id 或 id；缺省 = 自动挑选），模型准备时解析。 */
	plannerSpec?: string;
	reviewerSpec?: string;
	/** 能力包 id / 版本（追溯本次使用的知识版本）。 */
	packId?: string | null;
	packVersion?: string | null;
	/** 执行尝试 id（同一 run 内重试分配新 attempt，保留旧证据）。 */
	attemptId: string | null;
	/** 执行所有者（pid@host）。 */
	owner: string | null;
	/** 执行代次（恢复接管时 +1；与 epoch 的「迟到回调守卫」语义不同）。 */
	generation: number;
	/** 远端作业 / 请求标识；本地进程退出不代表远端已停止。 */
	remoteJobId: string | null;
	/** 环境指纹（workspace/git/pack/inputs/env），恢复时核对旧证据是否仍适用。 */
	environmentFingerprint: EnvironmentFingerprint | null;
	/** 恢复状态（UI 显示：running / interrupted / needs-review / unknown / cancelled）。 */
	recoveryState: string | null;
}

// ---------- 事件上报（服务层接线用：run 状态变化 / 启动请求失败） ----------

/**
 * Loop 事件，进程内单上报器（服务层经 setLoopEventReporter 注册一次，
 * 按 st.sessionId 路由到对应会话——扩展本身是每会话一份，上报器是全局的）。
 *  - run-state：每次状态落盘后上报（事件驱动，替代轮询 state.json）；
 *  - request-failed：挂起的启动请求在该回合结束时仍未变成 run（模型没调
 *    loop_start，或调用被拒）——修复「启动后无可见记录/无明确失败态」。
 */
export type LoopEvent =
	| { type: "run-state"; st: LoopState }
	| { type: "request-failed"; sessionId: string; taskId: string; goal: string; reason: string };

/** 多客户端事件上报器注册表：每个 ClientSession 注册一份，后注册不再覆盖先注册。
 *  事件按 sessionId 由各上报器自行过滤路由（handleLoopEvent 只更新属于本客户端的会话）。 */
const eventReporters = new Set<(e: LoopEvent) => void>();

/** 注册全局事件上报器，返回注销函数（dispose 时调用退订）。上报器异常不影响其它上报器。 */
export function addLoopEventReporter(fn: (e: LoopEvent) => void): () => void {
	eventReporters.add(fn);
	return () => {
		eventReporters.delete(fn);
	};
}

/** 兼容旧的单上报器语义（单元测试用）：fn 替换为唯一上报器；null 清空全部。 */
export function setLoopEventReporter(fn: ((e: LoopEvent) => void) | null) {
	eventReporters.clear();
	if (fn) eventReporters.add(fn);
}

function reportEvent(e: LoopEvent) {
	for (const fn of eventReporters) {
		try {
			fn(e);
		} catch {}
	}
}

// 挂起的启动请求：登记后 loop_start 成功即消费；回合结束仍是挂起 → 上报 request-failed。
// D-12-2 起服务层改为 createLoopRun 直接建 run，不再登记；这条路保留给仍走「提示词→loop_start」的调用方。
const pendingRequests = new Map<string, { taskId: string; goal: string; at: string }>();

/** 服务层登记挂起启动请求（按 sessionId；重复登记覆盖旧的）。 */
export function markLoopRequestPending(sessionId: string, taskId: string, goal: string) {
	pendingRequests.set(sessionId, { taskId, goal, at: now() });
}

/** 消费挂起请求（loop_start 成功时用；不存在返回 null）。 */
export function takePendingLoopRequest(sessionId: string): { taskId: string; goal: string; at: string } | null {
	const p = pendingRequests.get(sessionId);
	pendingRequests.delete(sessionId);
	return p ?? null;
}

// ---------- 基础工具 ----------

function now() {
	return new Date().toISOString();
}

/** 运行状态根目录（~/.mini-harness/runs，可由 MINI_HARNESS_RUNTIME_ROOT 覆盖）。 */
export function runsRoot(): string {
	return ROOT;
}

function runDir(runId: string) {
	return path.join(ROOT, runId);
}

function statePath(runId: string) {
	return path.join(runDir(runId), "state.json");
}

function newRunId() {
	const t = new Date()
		.toISOString()
		.replace(/[-:TZ.]/g, "")
		.slice(0, 14);
	return `${t}-${crypto.randomBytes(3).toString("hex")}`;
}

function loadState(runId: string): LoopState | null {
	try {
		return normalizeState(JSON.parse(fs.readFileSync(statePath(runId), "utf8")) as LoopState);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** 旧 state.json（D-12 之前）没有 acceptance / useReviewer：前者按 null，后者按「有没有评审模型」推断。 */
function normalizeState(st: LoopState): LoopState {
	if (st.revision === undefined) st.revision = 0;
	if (st.acceptance === undefined) st.acceptance = null;
	if (typeof st.useReviewer !== "boolean") st.useReviewer = !!st.reviewerModel;
	if (st.attemptId === undefined) st.attemptId = null;
	if (st.owner === undefined) st.owner = null;
	if (st.generation === undefined) st.generation = 1;
	if (st.remoteJobId === undefined) st.remoteJobId = null;
	if (st.environmentFingerprint === undefined) st.environmentFingerprint = null;
	if (st.recoveryState === undefined) st.recoveryState = null;
	if (st.observedBest === undefined) st.observedBest = null;
	if (st.legacyExecutionEntities === undefined) st.legacyExecutionEntities = [];
	if (st.turnActive === undefined) st.turnActive = null;
	return st;
}

/**
 * 落盘运行状态。可选 token：当异步回调持有一个执行身份 token 时，用 CAS 条件写——
 * 只有磁盘态仍是 token 对应的 owner+generation+epoch 才写，否则丢弃（旧代次不得覆盖新代次）。
 * 无 token 的同步路径仍检查本进程资格、有效租约和预期 revision。
 */
function saveState(st: LoopState, token?: ExecToken): boolean {
	if (!locallyClaimed(st.runId, st.owner, st.generation)) throw new Error("本进程未取得 Run 控制权");
	const wrote = withRunLockSync(runDir(st.runId), () => {
		const current = loadState(st.runId);
		const lease = getLease(runDir(st.runId));
		if (!lease || leaseExpired(lease) || lease.owner !== st.owner || lease.generation !== st.generation) return false;
		if (
			current &&
			((current.revision ?? 0) !== (st.revision ?? 0) ||
				(token ? !matchesToken(current, token) : current.owner !== st.owner || current.generation !== st.generation))
		)
			return false;
		const next = { ...st, revision: (st.revision ?? 0) + 1, updatedAt: now() };
		writeFileAtomicPreserveSync(statePath(st.runId), JSON.stringify(next, null, 2) + "\n");
		Object.assign(st, next);
		return true;
	});
	if (!wrote.ok) throw new Error(wrote.error);
	if (!wrote.value) {
		journal(st, "stale-write-dropped", { token });
		throw new Error("Run 提交被拒绝：执行权或 revision 已变化");
	}
	// 终态收尾：停止心跳、释放执行所有权（只有仍是当前 owner 才删，不误删后继接管者的租约）。
	if (st.status !== "active" && (!st.stopRequestedAt || st.stopConfirmedAt)) {
		stopLeaseHeartbeat(st.runId);
		if (st.owner) releaseLease(runDir(st.runId), st.owner, st.generation);
	}
	reportEvent({ type: "run-state", st });
	return true;
}

function journal(st: LoopState, event: string, extra: Record<string, unknown> = {}) {
	try {
		fs.mkdirSync(runDir(st.runId), { recursive: true });
		fs.appendFileSync(
			path.join(runDir(st.runId), "journal.jsonl"),
			JSON.stringify({ at: now(), runId: st.runId, round: st.round, event, ...extra }) + "\n",
		);
	} catch {}
}

/** 有界只读扫描；损坏/超限明确失败而非返回部分或空列表，避免遗漏活跃任务后重复创建。 */
export function listRuns(): LoopState[] {
	let directory: fs.Dir;
	try {
		directory = fs.opendirSync(ROOT);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const deadline = performance.now() + 1000;
	let entries = 0;
	let bytes = 0;
	const runs: LoopState[] = [];
	try {
		for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
			if (++entries > 10_000 || performance.now() > deadline) throw new Error("Run list scan budget exceeded");
			if (!entry.isDirectory() || !RUN_ID_RE.test(entry.name)) continue;
			try {
				const size = fs.statSync(statePath(entry.name)).size;
				bytes += size;
				if (size > 16 * 1024 * 1024 || bytes > 64 * 1024 * 1024) throw new Error("Run list state size budget exceeded");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			const st = loadState(entry.name);
			if (st) runs.push(st);
		}
		if (performance.now() > deadline) throw new Error("Run list scan budget exceeded");
		return runs;
	} finally {
		directory.closeSync();
	}
}

function sessionIdOf(ctx: LoopCtx): string {
	try {
		return ctx?.sessionManager?.getSessionId?.() || "";
	} catch {
		return "";
	}
}

/** 解析真实路径（macOS /tmp -> /private/tmp），保证 workspace 比较一致。 */
function real(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
}

/**
 * 找到当前会话的活跃 run —— 【修复①】只认显式 sessionId 精确匹配。
 * 不做「同 cwd 最新活跃 run」兜底：那条路会把别的会话/别的 worktree 的任务接过来。
 * 恢复必须显式绑定（服务层按 runId 重开会话，sessionId 天然一致）。
 */
function findActiveRun(ctx: LoopCtx): LoopState | null {
	return activeRunOf(sessionIdOf(ctx));
}

/** 按 sessionId 精确找活跃 run（空 sid 不匹配任何 run；工具调用与服务端建 run 共用）。 */
function activeRunOf(sid: string): LoopState | null {
	if (!sid) return null;
	const runs = listRuns().filter((r) => r.status === "active" && ACTIVE_STAGES.has(r.stage));
	return runs.find((r) => r.sessionId === sid) || null;
}

/** 评审结论的对外摘要（快照 conv.loop 与运行列表共用）：最多 5 条理由，每条不超过 300 字。 */
export function reviewBrief(review: LoopState["lastReview"]): { verdict: string; reasons: string[] } | null {
	if (!review) return null;
	return {
		verdict: String(review.verdict || ""),
		reasons: (review.reasons || []).slice(0, 5).map((r) => {
			const s = String(r);
			return s.length > 300 ? `${s.slice(0, 299)}…` : s;
		}),
	};
}

/** 本 run 的模型评审是否生效：要求开启，且已解析出评审模型（模型准备完成前按请求值算）。 */
export function reviewerEnabledOf(st: LoopState): boolean {
	if (st.useReviewer === false) return false;
	return st.setupPending === true || !!st.reviewerModel;
}

function tail(s: unknown, n: number) {
	const str = String(s || "");
	return str.length > n ? "…" + str.slice(-n) : str;
}

function notify(ctx: LoopCtx, message: string, type = "info") {
	try {
		ctx?.ui?.notify?.(message, type);
	} catch {}
}

// ---------- 模型家族与选择 ----------

/** 按模型 id 归类家族。planner / reviewer 必须与主模型、彼此都不同家族。 */
export function familyOf(id: string): string {
	const s = String(id || "").toLowerCase();
	const rules: Array<[RegExp, string]> = [
		[/^(gpt|o[1-9])/, "openai"],
		[/claude|opus|sonnet|haiku/, "anthropic"],
		[/gemini/, "google"],
		[/glm/, "zhipu"],
		[/kimi|moonshot/, "moonshot"],
		[/deepseek/, "deepseek"],
		[/grok/, "xai"],
		[/minimax|abab/, "minimax"],
		[/qwen|tongyi/, "alibaba"],
		[/llama/, "meta"],
		[/mistral|mixtral/, "mistral"],
		[/ernie/, "baidu"],
		[/doubao/, "bytedance"],
	];
	for (const [re, fam] of rules) if (re.test(s)) return fam;
	return "other";
}

function resolveModel(ctx: LoopCtx, spec: string) {
	if (!spec) return null;
	const reg = ctx?.modelRegistry;
	if (!reg) return null;
	const s = String(spec).trim();
	if (s.includes("/")) {
		const i = s.indexOf("/");
		return reg.find(s.slice(0, i), s.slice(i + 1)) || null;
	}
	const all = reg.getAll ? reg.getAll() : [];
	return all.find((m) => m.id === s) || all.find((m) => String(m.id).toLowerCase() === s.toLowerCase()) || null;
}

const PREFER_FAMILIES = ["openai", "anthropic", "zhipu", "deepseek", "moonshot", "google", "xai", "minimax", "alibaba"];

function pickModelByFamily(ctx: LoopCtx, exclude: Set<string>) {
	const reg = ctx?.modelRegistry;
	if (!reg) return null;
	const models = (reg.getAvailable ? reg.getAvailable() : null) || (reg.getAll ? reg.getAll() : []);
	for (const fam of PREFER_FAMILIES) {
		if (exclude.has(fam)) continue;
		const m = models.find((x) => familyOf(x.id) === fam);
		if (m) return m;
	}
	return models.find((m) => !exclude.has(familyOf(m.id))) || null;
}

function modelBrief(m: { provider?: string; id: string } | null) {
	return m ? { provider: m.provider, id: m.id, family: familyOf(m.id) } : null;
}

async function callModel(ctx: LoopCtx, model: unknown, systemPrompt: string, userText: string, timeoutMs = 120000) {
	if (!model) throw new Error("model not resolved");
	let timer: NodeJS.Timeout | undefined;
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`model call timeout after ${timeoutMs}ms`)), timeoutMs);
		});
		const msg = await Promise.race([
			ctx.modelRegistry!.complete(model, {
				systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
			}),
			timeout,
		]);
		const text = (msg?.content || [])
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n")
			.trim();
		return text;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function mainModel(ctx: LoopCtx) {
	try {
		return ctx?.model || null;
	} catch {
		return null;
	}
}

type RegModel = { provider?: string; id: string };
type RunModels = { main: RegModel | null; mainFam: string; planner: RegModel | null; reviewer: RegModel | null };

/**
 * 规划 / 评审模型解析（loop_start 与服务端建的 run 共用）：planner / reviewer 必须与主模型、
 * 彼此都不同家族；没指定就按家族偏好自动挑。纯解析，不落盘；失败返回给用户看的原因。
 */
function resolveRunModels(
	ctx: LoopCtx,
	req: { plannerSpec: string; reviewerSpec: string; useReviewer: boolean },
): ({ ok: true } & RunModels) | { ok: false; error: string } {
	const main = mainModel(ctx);
	const mainFam = main ? familyOf(main.id) : "unknown";
	let planner: RegModel | null = req.plannerSpec ? resolveModel(ctx, req.plannerSpec) : null;
	let reviewer: RegModel | null = req.reviewerSpec ? resolveModel(ctx, req.reviewerSpec) : null;
	if (req.plannerSpec && !planner) {
		return { ok: false, error: `无法解析 plannerModel「${req.plannerSpec}」。` };
	}
	const used = new Set([mainFam]);
	if (planner) {
		const f = familyOf(planner.id);
		if (used.has(f)) {
			return {
				ok: false,
				error: `planner 家族冲突：主模型 ${main?.id || "?"} 属于 ${mainFam}，planner ${planner.id} 也属于 ${f}。请选择不同家族的模型。`,
			};
		}
		used.add(f);
	} else {
		planner = pickModelByFamily(ctx, used);
		if (planner) used.add(familyOf(planner.id));
	}
	if (req.useReviewer) {
		if (req.reviewerSpec && !reviewer) {
			return { ok: false, error: `无法解析 reviewerModel「${req.reviewerSpec}」。` };
		}
		if (reviewer) {
			const f = familyOf(reviewer.id);
			if (used.has(f)) {
				return {
					ok: false,
					error:
						"reviewer 家族冲突：必须与主模型、planner 都不同家族。" +
						`当前已用 ${[...used].join("/")}，reviewer ${reviewer.id} 属于 ${f}。`,
				};
			}
		} else {
			reviewer = pickModelByFamily(ctx, used);
		}
	} else {
		reviewer = null;
	}
	return { ok: true, main, mainFam, planner, reviewer };
}

// ---------- validator ----------

/** 一轮 validator 的执行结果（pass 或 fail / 无 validator / 预检失败 / 被停止取消）。 */
interface ValidationResult {
	opId?: string;
	resultDigest?: string;
	pass: boolean;
	noValidator: boolean;
	precheckFailed: boolean;
	/** 运行在验收期间被停止：结果已作废，调用方不得落盘、不得推进下一轮。 */
	cancelled?: boolean;
	code: number | null;
	evidence: string | null;
	output: string;
	metrics: HarnessMetrics | null;
	/** validator 报出的场景标记（HARNESS_SCENARIO），无则 null。 */
	scenario: string | null;
	/** 验收前绑定的可恢复快照 ref（真正被测试的 candidate-A）；非 git 为 null。 */
	snapshotRef: string | null;
	/** 验收前快照的 commit SHA（用于验收后指纹比对）。 */
	snapshotSha: string | null;
	/** 是否具备可恢复快照（git 仓库且快照成功）。 */
	recoverable: boolean;
	/** 验收前后代码身份不一致（或无法确认一致）：本轮结果不可信，不得判通过 / 选为最优。 */
	workspaceChangedDuringValidation: boolean;
}

function resolveValidator(st: LoopState, dir?: string) {
	if (st.validateCmd) {
		return { cmd: "bash", args: ["-lc", st.validateCmd], label: st.validateCmd };
	}
	const candidates: string[] = [];
	// 物化冻结目录优先：validator 从冻结内容中解析（执行 cwd 也指向冻结目录）。
	const base = dir ?? st.workspace;
	if (base) candidates.push(path.join(base, "validate.py"));
	if (st.harnessRoot) candidates.push(path.join(st.harnessRoot, "validate.py"));
	if (process.env.HARNESS_ROOT) candidates.push(path.join(process.env.HARNESS_ROOT, "validate.py"));
	for (const p of candidates) {
		if (fs.existsSync(p)) return { cmd: "python3", args: [p], label: p };
	}
	return null;
}

const validationFlights = new Map<string, Promise<ValidationResult>>();
async function runValidation(pi: ExtensionAPI, st: LoopState): Promise<ValidationResult> {
	const existing = validationFlights.get(st.runId);
	if (existing) return existing;
	const pending = runValidationOnce(pi, st);
	validationFlights.set(st.runId, pending);
	try {
		return await pending;
	} catch (error) {
		if (stillCurrent(tokenOf(st))) throw error;
		return {
			pass: false,
			noValidator: false,
			precheckFailed: false,
			cancelled: true,
			code: null,
			evidence: null,
			output: "执行已停止或控制权已变更",
			metrics: null,
			scenario: null,
			snapshotRef: null,
			snapshotSha: null,
			recoverable: false,
			workspaceChangedDuringValidation: false,
		};
	} finally {
		if (validationFlights.get(st.runId) === pending) validationFlights.delete(st.runId);
	}
}

async function validationFromOperation(st: LoopState, opId: string): Promise<ValidationResult> {
	const observed = await observeOperation(st.runId, opId, { timeoutMs: 0 });
	const op = observed.record;
	if (!op?.result || !op.resultDigest) throw new Error("操作结果未知，不能重跑");
	const expected = op.stage === "precheck" ? { cmd: "bash", args: ["-lc", st.precheckCmd] } : resolveValidator(st);
	if (
		op.runId !== st.runId ||
		op.round !== st.round ||
		op.attemptId !== st.attemptId ||
		!["validate", "precheck"].includes(op.stage) ||
		real(op.cwd) !== real(st.workspace) ||
		!expected ||
		op.command !== expected.cmd ||
		JSON.stringify(op.args) !== JSON.stringify(expected.args)
	) {
		throw new Error("结果与当前执行契约不匹配");
	}
	const identity = st.validationIdentity;
	if (!identity || identity.round !== st.round || identity.attemptId !== st.attemptId)
		throw new Error("缺少执行前身份");
	if (op.snapshotSha !== identity.snapshotSha || op.snapshotRef !== identity.snapshotRef)
		throw new Error("结果快照身份冲突");
	// operation 的执行 cwd 必须等于冻结目录（恢复时同 run 目录复用；缺失即未验收状态）。
	if (identity.frozenDir && real(op.cwd) !== real(identity.frozenDir)) {
		throw new Error("操作执行目录与冻结内容不一致");
	}
	// 冻结目录未被改写：validator 若改写了纳入验收的源码，结果失效并重新冻结验证。
	if (identity.frozenHash && identity.frozenDir) {
		if (frozenDirectoryHash(identity.frozenDir) !== identity.frozenHash)
			throw new Error("冻结执行目录已被改写，本轮证据失效");
	}
	// 同一冻结内容：op.snapshotSha 必须等于冻结快照（上面已校验），此处再把
	// 当前工作树重建树与冻结树比较。A→B 竞态下即使内容指纹已在 B 上计算，
	// 树比较仍会把「验证 B、提交 A」识别为漂移。
	const unchanged = frozenContentMatches(st);
	const combined = observed.stdout + "\n" + observed.stderr;
	return {
		opId,
		resultDigest: op.resultDigest,
		pass:
			observed.code === 0 &&
			!observed.killed &&
			!observed.timedOut &&
			!op.result.killed &&
			!op.result.signal &&
			!op.result.error &&
			!op.cancelRequestedAt &&
			!observed.stdoutTruncated &&
			!observed.stderrTruncated,
		noValidator: false,
		precheckFailed: op.stage === "precheck",
		code: observed.code,
		output: combined,
		evidence: op.stdoutFile,
		metrics: parseHarnessMetrics(combined),
		scenario: parseHarnessScenario(combined),
		snapshotRef: identity.snapshotRef,
		snapshotSha: identity.snapshotSha,
		recoverable: identity.recoverable,
		workspaceChangedDuringValidation: !unchanged,
	};
}

async function runValidationOnce(pi: ExtensionAPI, st: LoopState): Promise<ValidationResult> {
	const cwd = st.workspace || process.cwd();
	const ac = registerRunAbort(st.runId);
	const token = tokenOf(st);
	try {
		if (!stillCurrent(token)) throw new Error("执行权已失效");
		// 复用旧结果的前提：证据仍对应当前 round/attempt 的执行内容与验收契约。
		if (st.validatedRound === st.round && st.lastVerdict && evidenceStillValid(st)) {
			return {
				pass: st.lastVerdict === "pass",
				noValidator: false,
				precheckFailed: false,
				code: st.lastCode,
				evidence: null,
				output: st.lastEvidence,
				metrics: st.lastMetrics ?? null,
				scenario: st.metricScenario ?? null,
				snapshotRef: null,
				snapshotSha: null,
				recoverable: false,
				workspaceChangedDuringValidation: st.history.at(-1)?.workspaceChangedDuringValidation ?? false,
			};
		}
		const prior = listOperations(st.runId).filter((op) => op.round === st.round && op.attemptId === st.attemptId);
		const validator = prior.find((op) => op.stage === "validate");
		if (validator) {
			await observeOperation(st.runId, validator.opId);
			if (!stillCurrent(token)) throw new Error("执行权已失效");
			return validationFromOperation(st, validator.opId);
		}
		// 验收前绑定代码身份（Task 3）：先快照 candidate-A（真正被 validator 读取的代码）。
		const preId =
			st.validationIdentity?.round === st.round ? st.validationIdentity : await captureAttemptIdentity(st, token);
		if (!stillCurrent(token)) throw new Error("执行权已失效");
		if (!st.validationIdentity || st.validationIdentity.round !== st.round) {
			const fingerprint = currentFingerprintOf(st, true);
			st.validationIdentity = { ...preId, round: st.round, attemptId: st.attemptId, fingerprint };
			st.environmentFingerprint = fingerprint;
			if (!saveState(st, token)) throw new Error("执行身份提交冲突");
		}
		const preCmd = st.precheckCmd ?? "";
		const execCwd = preId.frozenDir || cwd;
		const execOptions = {
			attemptId: st.attemptId,
			...preId,
			canControl: () => stillCurrent(token),
		};

		// L0 快速预检：若配置了 precheckCmd，先秒级拦截语法/导包/配置错误，不浪费集群与压测资源
		if (preCmd) {
			let pre: Partial<LoopExecResult>;
			try {
				const previous = prior.find((op) => op.stage === "precheck");
				pre = previous
					? { ...(await observeOperation(st.runId, previous.opId)), opId: previous.opId }
					: await loopExec("bash", ["-lc", preCmd], {
							...execOptions,
							cwd,
							timeout: 5 * 60 * 1000,
							signal: ac.signal,
							runId: st.runId,
							stage: "precheck",
							round: st.round,
							onSpawn: (pid) => recordTaskPid(st.runId, pid, st.owner!, st.generation),
						});
			} catch (e) {
				if (!loopExecOverride) throw e;
				pre = { stdout: "", stderr: String((e as Error)?.message || e), code: -1, killed: false };
			}
			recordTaskPid(st.runId, null, st.owner!, st.generation);
			if (!stillCurrent(token)) throw new Error("执行权已失效");
			if (pre.opId) {
				const result = await validationFromOperation(st, pre.opId);
				if (!result.pass || result.workspaceChangedDuringValidation) return result;
				st.consumedResults = {
					...st.consumedResults,
					[pre.opId]: { digest: result.resultDigest!, round: st.round, stage: "precheck" },
				};
				if (!saveState(st, token)) throw new Error("预检结果提交冲突");
			}
			if (pre.killed) {
				return {
					pass: false,
					noValidator: false,
					precheckFailed: false,
					cancelled: true,
					code: null,
					evidence: null,
					output: "运行已停止：L0 预检进程已被取消。",
					metrics: null,
					scenario: null,
					snapshotRef: preId.snapshotRef,
					snapshotSha: preId.snapshotSha,
					recoverable: preId.recoverable,
					workspaceChangedDuringValidation: false,
				};
			}
			if (pre.code !== 0) {
				const output =
					"[L0 precheck] $ " +
					preCmd +
					"\n" +
					"exit=" +
					pre.code +
					(pre.killed ? " (killed/timeout)" : "") +
					"（快速预检未通过，已跳过 L1 完整验收）\n" +
					"--- stdout (tail) ---\n" +
					tail(pre.stdout, 4000) +
					"\n" +
					"--- stderr (tail) ---\n" +
					tail(pre.stderr, 4000) +
					"\n";
				let evidence = "";
				try {
					const dir = path.join(runDir(st.runId), "evidence");
					fs.mkdirSync(dir, { recursive: true });
					evidence = path.join(dir, "round-" + st.round + "-" + Date.now() + ".log");
					fs.writeFileSync(evidence, output);
				} catch {}
				return {
					pass: false,
					noValidator: false,
					precheckFailed: true,
					code: pre.code ?? -1,
					evidence,
					output,
					metrics: null,
					scenario: null,
					snapshotRef: preId.snapshotRef,
					snapshotSha: preId.snapshotSha,
					recoverable: preId.recoverable,
					workspaceChangedDuringValidation: false,
				};
			}
			// 停止/取消守卫：L0 预检期间若被停止（epoch 已递增），绝不再启动昂贵的 L1 完整验收。
			if (!stillCurrent(token)) {
				return {
					pass: false,
					noValidator: false,
					precheckFailed: false,
					cancelled: true,
					code: null,
					evidence: null,
					output: "运行已停止：L0 预检期间收到停止，已跳过 L1 完整验收。",
					metrics: null,
					scenario: null,
					snapshotRef: preId.snapshotRef,
					snapshotSha: preId.snapshotSha,
					recoverable: preId.recoverable,
					workspaceChangedDuringValidation: false,
				};
			}
		}

		const r = resolveValidator(st, execCwd);
		if (!r) {
			return {
				pass: false,
				noValidator: true,
				precheckFailed: false,
				code: null as number | null,
				evidence: null as string | null,
				metrics: null as HarnessMetrics | null,
				scenario: null,
				snapshotRef: preId.snapshotRef,
				snapshotSha: preId.snapshotSha,
				recoverable: preId.recoverable,
				workspaceChangedDuringValidation: false,
				output:
					"未找到 validator。请提供 validateCmd（例如 validate.py 的路径），或在 workspace 放置 validate.py，或设置 HARNESS_ROOT。",
			};
		}
		let res: Partial<LoopExecResult>;
		try {
			res = await loopExec(r.cmd, r.args, {
				...execOptions,
				cwd: execCwd,
				timeout: 30 * 60 * 1000,
				signal: ac.signal,
				runId: st.runId,
				stage: "validate",
				round: st.round,
				onSpawn: (pid) => recordTaskPid(st.runId, pid, st.owner!, st.generation),
			});
		} catch (e) {
			if (!loopExecOverride) throw e;
			res = { stdout: "", stderr: String((e as Error)?.message || e), code: -1, killed: false };
		}
		recordTaskPid(st.runId, null, st.owner!, st.generation);
		if (!stillCurrent(token)) throw new Error("执行权已失效");
		if (res.opId) return validationFromOperation(st, res.opId);
		if (res.killed) {
			return {
				pass: false,
				noValidator: false,
				precheckFailed: false,
				cancelled: true,
				code: res.code ?? null,
				evidence: null,
				output: "运行已停止：L1 validator 进程已被取消。",
				metrics: null,
				scenario: null,
				snapshotRef: preId.snapshotRef,
				snapshotSha: preId.snapshotSha,
				recoverable: preId.recoverable,
				workspaceChangedDuringValidation: false,
			};
		}

		// 验收后校验冻结内容（Task 3/P1）：validator 执行前后工作树必须仍是同一棵树。
		// 有冻结树时直接比较树（重建树失败也视为漂移：无法证明一致就不能通过）。
		const unchanged = preId.recoverable && frozenContentMatches(st);
		const workspaceChangedDuringValidation = preId.recoverable && !unchanged;

		const combined = (res.stdout ?? "") + "\n" + (res.stderr ?? "");
		const metrics = parseHarnessMetrics(combined);
		const scenario = parseHarnessScenario(combined);
		const output =
			(preCmd ? "[L0 precheck] $ " + preCmd + " -> PASS\n" : "") +
			"$ " +
			r.label +
			"\n" +
			"exit=" +
			res.code +
			(res.killed ? " (killed/timeout)" : "") +
			"\n" +
			"--- stdout (tail) ---\n" +
			tail(res.stdout, 6000) +
			"\n" +
			"--- stderr (tail) ---\n" +
			tail(res.stderr, 4000) +
			"\n";
		let evidence = "";
		try {
			const dir = path.join(runDir(st.runId), "evidence");
			fs.mkdirSync(dir, { recursive: true });
			evidence = path.join(dir, "round-" + st.round + "-" + Date.now() + ".log");
			fs.writeFileSync(evidence, output);
		} catch {}
		return {
			pass: res.code === 0,
			noValidator: false,
			precheckFailed: false,
			code: res.code ?? null,
			evidence,
			output,
			metrics,
			scenario,
			snapshotRef: preId.snapshotRef,
			snapshotSha: preId.snapshotSha,
			recoverable: preId.recoverable,
			workspaceChangedDuringValidation,
		};
	} finally {
		releaseRunAbort(st.runId, ac);
	}
}

/**
 * 给一轮验证绑一个「可恢复」的代码快照引用（P2-⑤）：连续多轮修改但不提交时，
 * 单记 git HEAD 会让多轮指向同一个 baseline、无法恢复真正测试过的代码。
 * 用 workspace-snapshot 的备用 index 生成提交对象（包含未跟踪文件且不触碰真实 index），再用 update-ref 固定到
 * `refs/mini-harness/checkpoints/<runId>-r<round>`，避免被 GC 回收；后续可 `git checkout` 恢复。
 * 无改动（测试的就是 HEAD）或非 git 仓库返回 null（commitSha 兜底定位）。
 */
/**
 * 给一轮验证绑一个「可恢复」的代码快照引用（Task 3）：在验收开始前调用，绑定真正被测的代码。
 * 用 workspace-snapshot 的备用 index 生成提交对象（包含未跟踪文件且不触碰真实 index），再用 update-ref 固定到
 * refs/mini-harness/checkpoints/<runId>-r<round>，避免被 GC 回收；后续可 git checkout 恢复。
 * 无改动（测试的就是 HEAD）或非 git 仓库返回 recoverable=false（commitSha 兜底定位）。
 */
interface AttemptIdentity {
	snapshotRef: string | null;
	snapshotSha: string | null;
	/** 冻结快照对应的 tree 对象：validator/reviewer/提交绑定的是同一棵树，不是随后的工作树。 */
	treeSha: string | null;
	/** 冻结树物化后的隔离执行目录（validator 从这里运行，不读原可变工作树）。 */
	frozenDir: string | null;
	/** 冻结目录内容指纹：检测 validator 是否改写了纳入验收的源码。 */
	frozenHash: string | null;
	recoverable: boolean;
}

/**
 * 把冻结树物化到 run 目录内的隔离执行目录（git archive 保留执行位/符号链接/路径）。
 * 同名目录已存在且标记相同 tree 时复用；不同则清空重建。跨宿主恢复时同 run 目录直接复用。
 */
function materializeFrozenTree(runId: string, round: number, tree: string, workspace: string): string {
	const dir = path.join(runDir(runId), "frozen", "r" + round);
	const marker = path.join(dir, ".frozen-tree");
	try {
		if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === tree) return dir;
		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(dir, { recursive: true });
		const archive = execFileSync("git", ["--no-optional-locks", "-C", workspace, "archive", tree], {
			timeout: 30000,
			maxBuffer: 256 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const untar = execFileSync("tar", ["-x", "-C", dir], {
			input: archive,
			timeout: 30000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		void untar;
		fs.writeFileSync(marker, tree + "\n");
		return dir;
	} catch (error) {
		throw new Error("冻结树物化受阻：" + String((error as Error).message || error).slice(0, 300));
	}
}

/** 冻结目录内容指纹（非 git 目录：目录项相对路径 + 模式 + sha256）。 */
function frozenDirectoryHash(dir: string): string | null {
	try {
		const parts: string[] = [];
		const walk = (current: string) => {
			for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
				if (entry.name === ".frozen-tree") continue;
				const full = path.join(current, entry.name);
				const rel = path.relative(dir, full);
				if (entry.isDirectory()) {
					parts.push("d " + rel);
					walk(full);
				} else if (entry.isSymbolicLink()) {
					parts.push("l " + rel + " -> " + fs.readlinkSync(full));
				} else if (entry.isFile()) {
					const mode = fs.statSync(full).mode & 0o7777;
					parts.push(
						"f " +
							rel +
							" " +
							mode.toString(8) +
							" " +
							crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
					);
				}
			}
		};
		walk(dir);
		return crypto.createHash("sha256").update(parts.join("\n")).digest("hex");
	} catch {
		return null;
	}
}

async function captureAttemptIdentity(st: LoopState, token: ExecToken): Promise<AttemptIdentity> {
	const blocked = (): AttemptIdentity => ({
		snapshotRef: null,
		snapshotSha: null,
		treeSha: null,
		frozenDir: null,
		frozenHash: null,
		recoverable: false,
	});
	try {
		if (!stillCurrent(token)) return blocked();
		const sha = await createWorkspaceSnapshot(st.workspace);
		if (!sha) {
			// Git 工作区必须能生成冻结快照：无法创建/证明冻结内容时明确受阻，
			// 而不是退化为「无法检测漂移」的验收（否则 A/B 竞态会提交旧树）。
			if (isGitWorkspaceAt(st.workspace)) throw new Error("无法生成执行内容冻结快照（git 工作区）");
			return blocked();
		}
		// createWorkspaceSnapshot is async. A stop/takeover can win while it is producing the commit;
		// never pin a checkpoint ref for a run that is no longer current.
		if (!stillCurrent(token)) return blocked();
		const tree = gitSync(["-C", st.workspace, "rev-parse", sha + "^{tree}"], st.workspace, 15000).trim();
		if (!tree) throw new Error("冻结快照缺少可核对的 tree 对象");
		const ref = "refs/mini-harness/checkpoints/" + st.runId + "-r" + st.round;
		gitSync(["-C", st.workspace, "update-ref", ref, sha], st.workspace, 15000);
		// 物化冻结树到隔离执行目录：validator/reviewer 从这里读取，原工作树不再参与。
		const frozenDir = materializeFrozenTree(st.runId, st.round, tree, st.workspace);
		const frozenHash = frozenDirectoryHash(frozenDir);
		if (!frozenHash) throw new Error("冻结目录身份不可用");
		return { snapshotRef: ref, snapshotSha: sha, treeSha: tree, frozenDir, frozenHash, recoverable: true };
	} catch (error) {
		// 阻断原因不外泄内容：统一为冻结快照受阻。
		throw new Error("执行内容冻结受阻：" + String((error as Error).message || error).slice(0, 300));
	}
}

async function recordValidationOutcome(
	st: LoopState,
	v: {
		opId?: string;
		resultDigest?: string;
		pass: boolean;
		code: number | null;
		evidence: string | null;
		output: string;
		metrics?: HarnessMetrics | null;
		precheckFailed?: boolean;
		scenario?: string | null;
		snapshotRef?: string | null;
		recoverable?: boolean;
		workspaceChangedDuringValidation?: boolean;
	},
	token: ExecToken,
): Promise<boolean> {
	// 无 opId 的重复提交（loop_validate 工具复用路径）同样要求证据仍对应当前内容。
	if (!v.opId && st.validatedRound === st.round && evidenceStillValid(st)) return stillCurrent(token);
	if (v.opId) {
		const round = st.round;
		const attempt = st.attemptId;
		// Both callbacks re-read the immutable runner result, never trust prompt text.
		v = await validationFromOperation(st, v.opId);
		const fresh = loadState(st.runId);
		if (!fresh || fresh.round !== round || fresh.attemptId !== attempt || !stillCurrent(token)) return false;
		const consumed = fresh.consumedResults?.[v.opId!];
		if (consumed) {
			if (consumed.digest !== v.resultDigest) throw new Error("同一操作出现冲突结果");
			Object.assign(st, fresh);
			return false;
		}
		Object.assign(st, fresh);
		st.consumedResults = {
			...st.consumedResults,
			[v.opId!]: { digest: v.resultDigest!, round: st.round, stage: v.precheckFailed ? "precheck" : "validate" },
		};
	}
	const at = now();
	const verdict = v.pass ? "pass" : "fail";
	const commitSha = resolveGitHeadSha(st.workspace || process.cwd());
	if (!stillCurrent(token)) {
		journal(st, "late-callback-dropped", { at: "recordValidationOutcome", epoch: token.epoch });
		return false;
	}
	const snapshotRef = v.snapshotRef ?? null;
	const recoverable = v.recoverable === true;
	const workspaceChanged = v.workspaceChangedDuringValidation === true;
	const target = metricTargetOf(st);
	const gate = evaluateMetricGate(target, st.hardConstraints, v.metrics, v.scenario ?? null);
	st.validatedRound = st.round;
	st.stage = "validate";
	st.lastVerdict = verdict;
	st.lastCode = v.code;
	st.lastEvidence = v.output;
	st.lastMetricGate = gate;
	if (v.metrics) st.lastMetrics = v.metrics;
	st.history.push({
		round: st.round,
		verdict,
		code: v.code,
		at,
		evidence: v.evidence,
		...(v.metrics ? { metrics: v.metrics } : {}),
		...(commitSha ? { commitSha } : {}),
		...(snapshotRef ? { snapshotRef } : {}),
		...(v.precheckFailed ? { precheckFailed: true } : {}),
		metricGateOk: gate.ok,
		...(gate.reasons.length ? { metricGateReasons: gate.reasons } : {}),
		...(workspaceChanged ? { workspaceChangedDuringValidation: true } : {}),
		recoverable,
	});
	// 可信轮：命令结果可信（验收期间工作区未变）且指标门禁通过。
	const trusted = !workspaceChanged && gate.ok;
	const candidate: BestRoundRecord = {
		round: st.round,
		verdict,
		commitSha,
		...(snapshotRef ? { snapshotRef } : {}),
		...(v.metrics ? { metrics: v.metrics } : {}),
		at,
	};
	if (trusted) {
		// 观察候选：指标层面最好的方案（不管是否通过必要评审），仅作观察，不算有效版本。
		st.observedBest = pickBetterRound(st.observedBest, candidate, target);
		// 必要验收资格：validator pass + 指标门禁过 + 工作区未变；开启评审时还需 reviewer 通过（在 handleVerdict 里升级）。
		if (verdict === "pass" && !reviewerEnabledOf(st)) {
			st.bestRound = pickBetterRound(st.bestRound, candidate, target);
		}
	}
	return saveState(st, token);
}

/** 从当前轮最新历史记录构建最优轮候选（reviewer 通过后升级 bestRound 用）。 */
function currentRoundCandidate(st: LoopState): BestRoundRecord | null {
	const h = st.history[st.history.length - 1];
	if (!h || h.round !== st.round) return null;
	return {
		round: h.round,
		verdict: h.verdict,
		commitSha: h.commitSha ?? null,
		...(h.snapshotRef ? { snapshotRef: h.snapshotRef } : {}),
		...(h.metrics ? { metrics: h.metrics } : {}),
		at: h.at,
	};
}

// ---------- 提示词 ----------

function stateBlock(st: LoopState) {
	const lines = [
		"<mini_harness_loop>",
		`runId: ${st.runId}`,
		`mode: ${st.mode} | stage: ${st.stage} | round: ${st.round}/${st.maxRounds}`,
		`workspace: ${st.workspace}${st.worktreeBranch ? `（独立 git worktree，分支 ${st.worktreeBranch}；shell/终端默认 cwd 不在此，改动请用绝对路径或先 cd ${st.workspace}）` : ""}`,
		`goal: ${st.goal}`,
		st.criteria ? `criteria（用户给定的验收标准）: ${tail(st.criteria, 800)}` : "",
		st.plannerModel ? `planner: ${st.plannerModel.family}/${st.plannerModel.id}` : "",
		st.reviewerModel ? `reviewer: ${st.reviewerModel.family}/${st.reviewerModel.id}` : "",
		st.plan ? `plan: ${tail(st.plan, 600)}` : "",
		st.plannerOutput ? `planner_acceptance:\n${tail(st.plannerOutput, 1600)}` : "",
		st.preflightSummary ? `preflight: ${st.preflightSummary}` : "",
		st.precheckCmd ? `precheck_l0: ${st.precheckCmd}` : "",
		st.lastVerdict ? `last_verdict: ${st.lastVerdict} (exit ${st.lastCode})` : "last_verdict: (none yet)",
		st.lastMetrics ? `last_metrics: ${JSON.stringify(st.lastMetrics)}` : "",
		st.bestRound
			? `best_checkpoint: round ${st.bestRound.round} (${st.bestRound.verdict}${st.bestRound.commitSha ? `@${st.bestRound.commitSha}` : ""}${st.bestRound.metrics ? ` ${JSON.stringify(st.bestRound.metrics)}` : ""})`
			: "",
		st.observedBest
			? `observed_best(指标最好但未通过必要评审/资格，仅观察): round ${st.observedBest.round}${st.observedBest.metrics ? ` ${JSON.stringify(st.observedBest.metrics)}` : ""}`
			: "",
		st.lastReview
			? `last_review: ${st.lastReview.verdict} — ${tail((st.lastReview.reasons || []).join("; "), 600)}`
			: "",
		st.lastEvidence ? `last_evidence_tail:\n${tail(st.lastEvidence, 1600)}` : "",
		"规则：",
		"- 完成本轮工作后调用 loop_done(summary) 声明完成；运行时会在本轮结束时自动执行 validator。",
		"- 不要自行宣布完成；只有 validator 通过（且开了评审时 reviewer 通过）才算完成。",
		"- 若验证失败：按证据修复，不要重复已完成的步骤，也不要向用户提问。",
		"</mini_harness_loop>",
	];
	return lines.filter(Boolean).join("\n");
}

/** run 没启动起来（模型准备失败 / 准备期间被停止）时注入的状态块：让模型别再开工。 */
function setupFailedBlock(st: LoopState, reason: string) {
	return [
		"<mini_harness_loop>",
		`runId: ${st.runId}`,
		`status: stopped | reason: ${reason}`,
		"这个受控运行没有启动起来：不要开始这项工作，也不要调用 loop_start 另起运行；把上面的原因原样告诉用户，然后结束本轮。",
		"</mini_harness_loop>",
	].join("\n");
}

function nextRoundPrompt(st: LoopState, v: { code?: number | null; output?: string } | null, feedback: string) {
	return [
		`【mini-harness · 第 ${st.round} 轮】上一轮未通过。`,
		v ? `validator 退出码：${v.code}` : "",
		st.lastMetrics ? `本轮指标：${JSON.stringify(st.lastMetrics)}` : "",
		st.bestRound
			? `历史最优 Checkpoint：第 ${st.bestRound.round} 轮（${st.bestRound.verdict}${st.bestRound.commitSha ? ` · git ${st.bestRound.commitSha}` : ""}）——若本轮发生性能或正确性退化，请对照最优轮改动收敛。`
			: "",
		v ? "validator 证据（尾部）：\n```\n" + tail(v.output, 3000) + "\n```" : "",
		feedback ? `额外反馈：\n${tail(feedback, 2000)}` : "",
		`请修复后再次调用 loop_done(summary)。目标：${st.goal}`,
		"要求：直接修改工作区，不要只在回复里描述；不要向用户提问。",
	]
		.filter(Boolean)
		.join("\n");
}

// ---------- 证据采集与评审 ----------

async function collectDiff(pi: ExtensionAPI, st: LoopState, frozenDir?: string) {
	try {
		// git diff 不包含未跟踪的新文件；非 git 目录还要回退成目录快照，reviewer 才能核验真实状态。
		const script = [
			"echo '=== cwd ==='; pwd",
			"if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then",
			"  echo '=== git status ==='; git status --porcelain 2>/dev/null | head -100",
			"  echo '=== git diff --stat ==='; git diff --stat 2>/dev/null | tail -50",
			"  echo '=== git diff ==='; git diff 2>/dev/null | head -c 6000",
			"  echo '=== untracked files (first 5, 2KB each) ==='; " +
				"for f in $(git ls-files --others --exclude-standard 2>/dev/null | head -5); " +
				'do echo "--- $f ---"; head -c 2000 "$f" 2>/dev/null; echo; done',
			"else",
			"  echo '=== not a git repo: directory snapshot ==='; ls -la 2>/dev/null | head -50",
			"  echo '=== files (first 8, 2KB each) ==='; " +
				"for f in $(find . -maxdepth 2 -type f -not -path './.git/*' 2>/dev/null | head -8); " +
				'do echo "--- $f ---"; head -c 2000 "$f" 2>/dev/null; echo; done',
			"fi",
		].join("\n");
		const evidenceCwd = frozenDir && fs.existsSync(frozenDir) ? frozenDir : st.workspace;
		const res = await pi.exec("bash", ["-lc", script], { cwd: evidenceCwd, timeout: 30000 });
		let out = `${res.stdout || ""}${res.stderr ? "\n" + res.stderr : ""}`;
		// 外部产物根（artifact roots）：workspace 之外的真实产出，reviewer 也必须能看到
		for (const root of st.artifactRoots || []) {
			const r = await pi.exec(
				"bash",
				[
					"-lc",
					[
						`echo '=== artifact root: ${root} ==='`,
						`ls -la ${JSON.stringify(root)} 2>/dev/null | head -40`,
						"echo '--- files (maxdepth 5, first 20) ---'",
						`find ${JSON.stringify(root)} -maxdepth 5 -type f 2>/dev/null | head -20`,
						"echo '--- recent json/status contents (first 5, 2KB each) ---'",
						`for f in $(find ${JSON.stringify(root)} -maxdepth 6 -type f ` +
							"\\( -name '*.json' -o -name '*.log' -o -name '*.md' \\) 2>/dev/null | head -5); " +
							'do echo "--- $f ---"; head -c 2000 "$f" 2>/dev/null; echo; done',
					].join("\n"),
				],
				{ cwd: st.workspace, timeout: 30000 },
			);
			out += `\n${r.stdout || ""}${r.stderr ? "\n" + r.stderr : ""}`;
		}
		return tail(out, 20000);
	} catch {
		return "";
	}
}

/** 从模型输出里提取第一个合法的 JSON 对象（处理前后夹杂文字/多个对象）。 */
function extractJson(text: unknown): Record<string, unknown> | null {
	const s = String(text || "");
	for (let start = s.indexOf("{"); start !== -1; start = s.indexOf("{", start + 1)) {
		let depth = 0;
		let inStr = false;
		let esc = false;
		for (let i = start; i < s.length; i++) {
			const ch = s[i];
			if (inStr) {
				if (esc) esc = false;
				else if (ch === "\\") esc = true;
				else if (ch === '"') inStr = false;
				continue;
			}
			if (ch === '"') inStr = true;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					try {
						return JSON.parse(s.slice(start, i + 1)) as Record<string, unknown>;
					} catch {
						break;
					}
				}
			}
		}
	}
	return null;
}

async function runReview(ctx: LoopCtx, st: LoopState, v: { code?: number | null; output?: string }, pi: ExtensionAPI) {
	const token = tokenOf(st);
	if (!stillCurrent(token)) throw new Error("评审执行权已失效");
	if (!st.reviewerModel || st.useReviewer === false) {
		return { verdict: "skip", reasons: [] as string[], diff: "" };
	}
	const model = st.reviewerModel.provider
		? ctx.modelRegistry?.find(st.reviewerModel.provider, st.reviewerModel.id) || null
		: null;
	if (!model) {
		return { verdict: "error", reasons: ["reviewer model unavailable"], diff: "" };
	}
	const diff = await collectDiff(pi, st, st.validationIdentity?.frozenDir ?? undefined);
	if (!stillCurrent(token)) throw new Error("评审执行权已失效");
	const system =
		"你是独立审查者。下面给出的是「运行时自动采集的真实证据」：工作区快照" +
		"（git 状态/diff/未跟踪文件内容；非 git 目录为目录快照）、artifact 产物目录快照、以及 validator 输出。" +
		'只依据这些证据判断目标是否达成，不要臆测，也不要因为"没有终端日志"而否决。' +
		'只输出一个 JSON 对象，不要输出任何其它文字：{"verdict":"pass"|"block","reasons":["..."]}。' +
		"证据不足、或与目标/验收条件不符时，必须输出 block。";
	const user = [
		`目标：${st.goal}`,
		st.criteria ? `验收标准（用户给定）：\n${tail(st.criteria, 1500)}` : "",
		st.plannerOutput ? `规划与验收条件：\n${tail(st.plannerOutput, 2000)}` : "",
		st.plan ? `执行计划：\n${tail(st.plan, 1200)}` : "",
		st.summary ? `执行者自述：\n${tail(st.summary, 1200)}` : "",
		`validator：exit=${v.code}\n${tail(v.output, 3000)}`,
		diff ? `工作区/产物快照（运行时采集，真实）：\n${tail(diff, 12000)}` : "工作区/产物快照：（空）",
	]
		.filter(Boolean)
		.join("\n\n");
	const parse = (text: string) => {
		const obj = extractJson(text);
		if (!obj) return null;
		const verdict = obj.verdict === "block" ? "block" : obj.verdict === "pass" ? "pass" : null;
		if (!verdict) return null;
		const reasons = Array.isArray(obj.reasons)
			? (obj.reasons as unknown[]).map(String)
			: obj.reasons
				? [String(obj.reasons)]
				: [];
		return { verdict, reasons };
	};
	try {
		let text = await callModel(ctx, model, system, user);
		if (!stillCurrent(token)) throw new Error("评审执行权已失效");
		let parsed = parse(text);
		if (!parsed) {
			// 一次重试：明确要求只输出 JSON
			text = await callModel(
				ctx,
				model,
				system,
				`${user}\n\n上一次输出不是合法 JSON。请只输出一个 JSON 对象，不要任何其它文字。`,
				120000,
			);
			if (!stillCurrent(token)) throw new Error("评审执行权已失效");
			parsed = parse(text);
		}
		if (!parsed) {
			return { verdict: "error", reasons: ["reviewer output is not valid JSON after retry"], diff };
		}
		return { ...parsed, diff };
	} catch (e) {
		return { verdict: "error", reasons: [String((e as Error)?.message || e)], diff };
	}
}

// ---------- 判定处理 ----------

/**
 * 统一执行身份 token：异步操作在 await 前捕获 {runId, owner, generation, epoch}，
 * await 后（写盘前）必须三者全部一致才允许推进。
 *  - epoch：当前执行流程的取消/失效身份（停止会递增 epoch）；
 *  - generation：所有权代次（恢复接管会递增 generation；旧 owner 的迟到回调必须被拒）。
 * 两者语义不同、不能互相绕过：旧代次的回调即使 epoch 碰巧没变，也会因 generation 不符被拒。
 */
interface ExecToken {
	runId: string;
	owner: string;
	generation: number;
	epoch: number;
}

function tokenOf(st: LoopState): ExecToken {
	return { runId: st.runId, owner: st.owner ?? "", generation: st.generation ?? 0, epoch: st.epoch };
}

function matchesToken(fresh: LoopState | null, token: ExecToken): boolean {
	return !!fresh && fresh.owner === token.owner && fresh.generation === token.generation && fresh.epoch === token.epoch;
}

/**
 * 【修复②】await 前记录执行身份，await 后核对：停止/被接管的 run 不再被迟到回调推进。
 * 必须重读磁盘：stop / takeover 走的是另一次 loadState（不同对象引用），内存里的 st
 * 不会随之更新——只比内存对象会误判「仍然有效」，把 stopped / 新代次覆盖成旧代次。
 */
function stillCurrent(token: ExecToken) {
	if (!locallyClaimed(token.runId, token.owner, token.generation)) return false;
	const fresh = loadState(token.runId);
	const lease = getLease(runDir(token.runId));
	return (
		!!fresh &&
		fresh.status === "active" &&
		!fresh.stopRequestedAt &&
		matchesToken(fresh, token) &&
		!!lease &&
		!leaseExpired(lease) &&
		lease.owner === token.owner &&
		lease.generation === token.generation
	);
}

/** Service dispatch uses the same lease fence as command/reviewer dispatch. */
export function canContinueLoop(st: LoopState): boolean {
	return stillCurrent(tokenOf(st));
}

/** 完成后的收尾（提交 worktree）只核执行身份：此时 status 已是 done，不能再要求 active。 */
function sameEpoch(token: ExecToken) {
	return stillCurrent(token);
}

function advanceOrStop(
	pi: ExtensionAPI,
	st: LoopState,
	v: { code?: number | null; output?: string } | null,
	feedback: string,
	event: string,
	token?: ExecToken,
) {
	writeRoundReview(st, v, null, "");
	if (st.round < st.maxRounds) {
		const failedRound = st.round;
		st.round += 1;
		st.stage = "run";
		st.validatedRound = 0;
		st.validationIdentity = undefined;
		st.reviewStep = undefined;
		if (!saveState(st, token)) return;
		journal(st, event, { code: v?.code ?? null, failedRound, nextRound: st.round });
		markRunTurnDispatch(st.runId, st.sessionId);
		pi.sendUserMessage(nextRoundPrompt(st, v, feedback), { deliverAs: "followUp" });
	} else {
		st.stage = "stopped";
		st.status = "stopped";
		st.stopReason = event;
		st.epoch += 1;
		if (!saveState(st, token)) return;
		journal(st, event, { code: v?.code ?? null, maxRounds: st.maxRounds });
		pi.sendUserMessage(
			`【mini-harness】已达最大轮数 ${st.maxRounds}，停止。` +
				`${v ? `最后 validator 退出码 ${v.code}。` : ""}\n` +
				(feedback ? `反馈：${tail(feedback, 1500)}\n` : "") +
				(v ? `证据：\n\`\`\`\n${tail(v.output, 2000)}\n\`\`\`` : ""),
			{ deliverAs: "followUp" },
		);
	}
}

const reviewsInFlight = new Set<string>();
async function reviewOnce(pi: ExtensionAPI, ctx: LoopCtx, st: LoopState, v: { code?: number | null; output?: string }) {
	const token = tokenOf(st);
	if (!stillCurrent(token)) return null;
	if (st.reviewStep?.round === st.round) {
		if (st.reviewStep.status === "completed") return st.reviewStep.result ?? null;
		if (reviewsInFlight.has(st.reviewStep.id)) return null;
		st.stage = "review-error";
		st.status = "stopped";
		st.stopReason = "reviewer-error";
		st.recoveryState = "unknown";
		saveState(st, token);
		return null;
	}
	st.reviewStep = { id: crypto.randomUUID(), round: st.round, status: "requested" };
	if (!saveState(st, token) || !stillCurrent(token)) return null;
	reviewsInFlight.add(st.reviewStep.id);
	try {
		const review = await runReview(ctx, st, v, pi);
		if (!stillCurrent(token)) {
			journal(st, "late-callback-dropped", { at: "reviewOnce" });
			return null;
		}
		st.reviewStep = { ...st.reviewStep, status: "completed", result: review };
		if (!saveState(st, token)) return null;
		return review;
	} finally {
		reviewsInFlight.delete(st.reviewStep.id);
	}
}
/**
 * 自动/手动收下共享的 Git 收尾（P2）：提交验收绑定的不可变树，并在推进分支引用后
 * 协调真实 index —— 提交后暂存区只保留用户独立的 staged 改动，绝不残留「收下内容
 * 相对新 HEAD 的反向差异」，也不覆盖用户暂存。
 *
 * 步骤：校验预期旧 SHA（并发推进时幂等接续/明确拒绝）→ 冲突预检（用户 staged 与
 * 收下内容同路径不同 blob → 更新引用前拒绝）→ commit-tree + update-ref（需要时）→
 * 重写 index（已验证树 + 用户额外 staged 条目）。工作树与用户 unstaged 改动不动。
 * 返回：ok+commit（commit 为 null 表示树已等于分支 tip，无新提交）；失败返回可恢复错误。
 */
export function finalizeVerifiedCommit(
	worktree: string,
	branch: string,
	expectedParent: string,
	tree: string,
	message: string,
): { ok: true; commit: string | null } | { ok: false; error: string } {
	const run = (args: string[], env: NodeJS.ProcessEnv = {}, input?: string) =>
		execFileSync("git", ["--no-optional-locks", "-C", worktree, ...args], {
			env: { ...process.env, ...env },
			timeout: 15000,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			...(input !== undefined ? { input } : {}),
		});
	try {
		const treeEntry = (sha: string, rel: string) => {
			try {
				const out = run(["ls-tree", "-z", sha + "^{tree}", "--", rel])
					.split("\0")
					.filter(Boolean)[0];
				if (!out) return null;
				return { mode: out.split(" ")[1]!, blob: out.split(" ")[2]!.split("\t")[0]! };
			} catch {
				return null;
			}
		};
		const tip = run(["rev-parse", "--verify", "refs/heads/" + branch]).trim();
		const tipTree = run(["rev-parse", tip + "^{tree}"]).trim();
		let commit: string | null = null;
		if (tipTree !== tree) {
			// 引用必须先等于预期旧 SHA：并发推进时要么同一内容（幂等接续），要么明确拒绝。
			if (tip !== expectedParent) return { ok: false, error: "worktree 分支已被并发推进，未覆盖他人提交" };
			// 冲突预检：用户 staged（含 staged 删除与仅模式变化）与「旧 HEAD → 收下树」同路径
			// 且内容/模式不同 → 更新引用前拒绝。
			// 用户 staged = 真实 index 相对「旧 HEAD」的差异（而不是相对即将推进的新 HEAD）。
			const staged = run(["diff", "--cached", expectedParent, "--name-only", "-z"]).split("\0").filter(Boolean);
			for (const rel of staged) {
				const entry = run(["ls-files", "--stage", "-z", "--", rel]).split("\0").filter(Boolean)[0];
				// 无条目 = staged 删除。
				const stagedEntry = entry
					? (() => {
							const tab = entry.indexOf("\t");
							const meta = entry.slice(0, tab).split(" ");
							return { mode: meta[0]!, blob: meta[1]! };
						})()
					: null;
				const oldEntry = treeEntry(expectedParent, rel);
				const newEntry = treeEntry(tree, rel);
				const oldKey = oldEntry ? oldEntry.mode + ":" + oldEntry.blob : "";
				const newKey = newEntry ? newEntry.mode + ":" + newEntry.blob : "";
				const stagedKey = stagedEntry ? stagedEntry.mode + ":" + stagedEntry.blob : "";
				// 冲突只在「收下改动了该路径（mode/blob）」且用户 staged 第三种状态时成立；
				// 收下未触及的路径上的 staged 内容是用户的独立暂存，保留即可。
				if (oldKey !== newKey && stagedKey !== newKey && stagedKey !== oldKey) {
					return { ok: false, error: "暂存内容与收下的改动冲突（" + rel + "），未更新分支引用" };
				}
			}
			commit = run(["commit-tree", tree, "-p", tip, "-m", message]).trim();
			// update-ref 自身携带预期旧 SHA（CAS）：关闭「检查之后、推进之前」的并发窗口。
			run(["update-ref", "refs/heads/" + branch, commit, tip]);
		}
		// 协调 index：新 index = 收下树 + 用户额外 staged（staged 与收下树不同的条目）。
		// 工作树与 unstaged 改动不动；重写真实 index 为原子拷贝。
		// 「用户暂存」按收下前的旧 HEAD 判定：幂等重入时旧 HEAD 是当前 tip 的父提交。
		// 收下前的旧 HEAD 恒为 expectedParent：调用方保证（幂等重入时传 tip 的父提交）。
		const preHead = expectedParent;
		const gitDir = run(["rev-parse", "--absolute-git-dir"]).trim();
		const tmp = path.join(gitDir, `pi-finalize-index-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
		try {
			const tmpEnv = { GIT_INDEX_FILE: tmp };
			run(["read-tree", tree], tmpEnv);
			// 协调时的「用户 staged」相对收下前的旧 HEAD 判定；新 HEAD 与 index 的差异由 read-tree 收口。
			const stagedNow = run(["diff", "--cached", preHead, "--name-only", "-z"]).split("\0").filter(Boolean);
			const extra: string[] = [];
			for (const rel of stagedNow) {
				const entry = run(["ls-files", "--stage", "-z", "--", rel]).split("\0").filter(Boolean)[0];
				if (!entry) {
					// staged 删除：收下未改动的路径（old==new）→ 保留用户删除（全零条目）。
					const oldEntry = treeEntry(preHead, rel);
					const newEntry = treeEntry(tree, rel);
					const oldKey = oldEntry ? oldEntry.mode + ":" + oldEntry.blob : "";
					const newKey = newEntry ? newEntry.mode + ":" + newEntry.blob : "";
					if (oldKey === newKey) extra.push("0 0000000000000000000000000000000000000000 0\t" + rel);
					continue;
				}
				const tab = entry.indexOf("\t");
				const meta = entry.slice(0, tab).split(" ");
				const blobIn = (sha: string) => {
					try {
						const out = run(["ls-tree", "-z", sha, "--", rel]).split("\0").filter(Boolean)[0];
						return out ? out.split(" ")[2].split("\t")[0] : "";
					} catch {
						return "";
					}
				};
				const inTree = blobIn(tree);
				const oldBlob = blobIn(preHead + "^{tree}");
				if (meta[1] && meta[1] !== inTree && meta[1] !== oldBlob)
					extra.push(meta[0] + " " + meta[1] + " " + meta[2] + "\t" + entry.slice(tab + 1));
			}
			if (extra.length) {
				run(["update-index", "--index-info"], tmpEnv, extra.join("\n") + "\n");
			}
			const realIndex = run(["rev-parse", "--git-path", "index"]).trim();
			const realPath = path.resolve(worktree, realIndex);
			// 按 git lockfile 协议发布：index.lock 存在 = 并发 git 操作占用 → 明确受阻可重试；
			// 否则写 lock 后原子 rename 到真实 index。
			const lockPath = realPath + ".lock";
			const lockFd = fs.openSync(lockPath, "wx", 0o600);
			try {
				const content = fs.readFileSync(tmp);
				fs.writeFileSync(lockFd, content);
				fs.fsyncSync(lockFd);
			} finally {
				fs.closeSync(lockFd);
			}
			fs.renameSync(lockPath, realPath);
		} finally {
			fs.rmSync(tmp, { force: true });
		}
		return { ok: true, commit };
	} catch (error) {
		return { ok: false, error: String((error as Error).message || error).slice(0, 300) };
	}
}

async function commitVerifiedWorktreeTree(st: LoopState): Promise<string | null | "drift"> {
	const worktree = st.worktreeDir!;
	const identity = st.validationIdentity;
	let tree: string;
	if (identity?.snapshotSha) {
		tree = gitSync(["-C", worktree, "rev-parse", identity.snapshotSha + "^{tree}"], worktree, 15000).trim();
	} else {
		const fresh = await createWorkspaceSnapshot(st.workspace);
		if (!fresh) return null;
		tree = gitSync(["-C", worktree, "rev-parse", fresh + "^{tree}"], worktree, 15000).trim();
	}
	if (!evidenceStillValid(st)) return "drift";
	const branch = st.worktreeBranch!;
	const tip = gitSync(["-C", worktree, "rev-parse", "--verify", "refs/heads/" + branch], worktree, 15000).trim();
	const tipTree = gitSync(["-C", worktree, "rev-parse", tip + "^{tree}"], worktree, 15000).trim();
	// 幂等重入（tip 树已等于收下树）：收下前 HEAD 是 tip 的父提交。
	let parent = tip;
	if (tipTree === tree) {
		try {
			parent = gitSync(["-C", worktree, "rev-parse", tip + "^"], worktree, 15000).trim();
		} catch {
			parent = tip;
		}
	}
	const result = finalizeVerifiedCommit(worktree, branch, parent, tree, `mini-harness run ${st.runId}`);
	if (!result.ok) throw new Error(result.error);
	return result.commit;
}

/** 同步路径（用户「按代码验证收下」）取验收绑定的不可变树；无预存快照返回 null。 */
function verifiedTreeFromIdentity(st: LoopState): string | null {
	const identity = st.validationIdentity;
	if (!identity?.snapshotSha || !st.worktreeDir) return null;
	return gitSync(["-C", st.worktreeDir, "rev-parse", identity.snapshotSha + "^{tree}"], st.worktreeDir, 15000).trim();
}

/** 代码 loop 判定：validator 是硬门禁，reviewer 是否决层。 */
async function handleVerdict(
	pi: ExtensionAPI,
	ctx: LoopCtx,
	st: LoopState,
	v: {
		pass: boolean;
		noValidator?: boolean;
		code: number | null;
		output: string;
		workspaceChangedDuringValidation?: boolean;
	},
) {
	const token = tokenOf(st);
	if (!stillCurrent(token)) {
		return;
	}
	// Task 3：验收期间工作区发生变化 → 本轮结果不可信，不得判通过 / 不得选为最优 Checkpoint。
	if (v.workspaceChangedDuringValidation) {
		advanceOrStop(
			pi,
			st,
			v,
			"工作区在验收期间发生变化，本轮验证结果不可信；请先停止并发改动，再基于稳定代码重新 loop_done。",
			"workspace-changed-during-validation",
			token,
		);
		return;
	}
	// Task 2：命令成功（exit 0）不等于指标达标。主指标缺失 / 数值非法 / 阈值或硬约束不满足 → 不判完成。
	if (v.pass && st.lastMetricGate && !st.lastMetricGate.ok) {
		advanceOrStop(pi, st, v, "指标门禁未通过：\n" + (st.lastMetricGate.reasons || []).join("\n"), "metric-gate", token);
		return;
	}
	if (v.pass) {
		const review = await reviewOnce(pi, ctx, st, v);
		if (!review) return;
		if (!stillCurrent(token)) {
			journal(st, "late-callback-dropped", { at: "handleVerdict/review", epoch: token.epoch });
			return;
		}
		// reviewer 等待期间代码发生变化 → 旧结论不对应新版本，不得据此通过或提交。
		if (!evidenceStillValid(st)) {
			advanceOrStop(
				pi,
				st,
				v,
				"评审期间工作区内容发生变化，评审结论不再对应当前代码；请基于稳定代码重新验证。",
				"workspace-changed-during-review",
				token,
			);
			return;
		}
		st.lastReview = review;
		st.reviewStep = { id: st.reviewStep!.id, round: st.round, status: "completed", result: review };
		st.lastDiff = review.diff || "";
		if (!saveState(st, token)) return;
		journal(st, "review", { verdict: review.verdict, reasons: review.reasons });
		writeRoundReview(st, v, review, review.diff);
		if (review.verdict === "block") {
			notify(ctx, `⚠️ mini-harness：validator 通过，但 reviewer 否决（第 ${st.round} 轮）。`, "warning");
			advanceOrStop(pi, st, v, `reviewer 否决：\n${review.reasons.join("\n")}`, "reviewer-block", token);
			return;
		}
		if (review.verdict === "error") {
			// D-12-1：reviewer 掉线（404/超时/输出非法）不算完成——停在 review-error 等用户
			// 「重试评审」（reactivateForReview）或「按代码验证收下」（acceptRunValidatorOnly）。
			// lastVerdict 仍是 validator 的 pass；不提交 worktree（还没被收下）。
			st.stage = "review-error";
			st.status = "stopped";
			st.stopReason = "reviewer-error";
			st.epoch += 1;
			if (!saveState(st, token)) return;
			journal(st, "reviewer-error", { mode: "code", code: v.code, reasons: review.reasons, epoch: st.epoch });
			notify(
				ctx,
				`⚠️ mini-harness：第 ${st.round} 轮代码验证已通过，但模型评审出错，未判定完成；` +
					`可重试评审或按代码验证收下。${(review.reasons || []).join("; ")}`,
				"warning",
			);
			return;
		}
		// pass = 代码验证 + 模型评审都过；skip = 没开评审 / 没有可用评审模型，只有代码验证。
		// 必要评审通过后，才把本轮升级为「最佳有效版本」（否则只保留在 observedBest 观察候选里）。
		const cand = currentRoundCandidate(st);
		if (cand && review.verdict !== "block" && review.verdict !== "error") {
			st.bestRound = pickBetterRound(st.bestRound, cand, metricTargetOf(st));
		}
		if (listOperations(st.runId).some((op) => !op.result?.groupGone)) {
			st.recoveryState = "unknown";
			saveState(st, token);
			return;
		}
		st.stage = "done";
		st.status = "done";
		st.acceptance = review.verdict === "pass" ? "passed" : "passed-validator-only";
		if (st.worktreeDir && st.worktreeBranch && !st.worktreeCommitted) {
			try {
				if (!stillCurrent(token)) {
					return;
				}
				const committed = await commitVerifiedWorktreeTree(st);
				if (committed === "drift") {
					advanceOrStop(
						pi,
						st,
						v,
						"提交前工作区内容发生变化，验收结论不再对应当前代码；请基于稳定代码重新验证。",
						"workspace-changed-before-commit",
						token,
					);
					return;
				}
				if (!committed) {
					// 构建不了可核验树（非 git / 快照失败）：退化为原有 add+commit 序列；
					// 证据核对已在前置门禁完成，该退化路径仅存在于无法生成快照的工作区。
					await pi.exec("git", ["-C", st.worktreeDir, "add", "-A"], { cwd: st.worktreeDir, timeout: 60000 });
					if (!stillCurrent(token)) {
						return;
					}
					const d = await pi.exec("git", ["-C", st.worktreeDir, "diff", "--cached", "--quiet"], {
						cwd: st.worktreeDir,
						timeout: 60000,
					});
					if (d.code !== 0) {
						if (!stillCurrent(token)) return;
						await pi.exec("git", ["-C", st.worktreeDir, "commit", "-m", `mini-harness run ${st.runId}`], {
							cwd: st.worktreeDir,
							timeout: 60000,
						});
					}
					if (!sameEpoch(token)) {
						journal(st, "late-callback-dropped", { at: "handleVerdict/worktree", epoch: token.epoch });
						return;
					}
					st.worktreeCommitted = true;
					journal(st, "worktree-commit", { branch: st.worktreeBranch, dir: st.worktreeDir, fallback: true });
				} else {
					if (!sameEpoch(token)) {
						journal(st, "late-callback-dropped", { at: "handleVerdict/worktree", epoch: token.epoch });
						return;
					}
					st.worktreeCommitted = true;
					journal(st, "worktree-commit", { branch: st.worktreeBranch, dir: st.worktreeDir, commit: committed });
				}
			} catch (e) {
				journal(st, "worktree-commit-error", { error: String((e as Error)?.message || e) });
			}
		}
		if (!saveState(st, token)) {
			return;
		}
		journal(st, "validate-pass", { code: v.code, review: review.verdict, acceptance: st.acceptance });
		notify(
			ctx,
			`✅ mini-harness：第 ${st.round} 轮验证通过` +
				`${review.verdict === "skip" ? "（仅代码验证，未经模型评审）" : `（reviewer ${review.verdict}）`}，目标达成。`,
			"info",
		);
		return;
	}
	if (v.noValidator) {
		st.stage = "stopped";
		st.status = "stopped";
		st.stopReason = "no-validator";
		st.epoch += 1;
		if (!saveState(st, token)) return;
		journal(st, "no-validator");
		notify(ctx, "⚠️ mini-harness：未找到 validator，运行已停止。请提供 validateCmd 或 validate.py。", "warning");
		return;
	}
	advanceOrStop(pi, st, v, "", "validate-fail");
}

/** LLM loop 判定：无代码 validator，reviewer 是唯一判定。 */
async function handleLlmVerdict(pi: ExtensionAPI, ctx: LoopCtx, st: LoopState) {
	const syntheticV = {
		pass: true,
		code: null as number | null,
		output: "（LLM loop：无代码 validator，由 reviewer 判定）",
	};
	const token = tokenOf(st);
	const review = await reviewOnce(pi, ctx, st, syntheticV);
	if (!review) return;
	if (!stillCurrent(token)) {
		journal(st, "late-callback-dropped", { at: "handleLlmVerdict/review", epoch: token.epoch });
		return;
	}
	st.lastReview = review;
	st.lastDiff = review.diff || "";
	st.lastVerdict = review.verdict === "pass" ? "pass" : review.verdict === "block" ? "fail" : review.verdict;
	st.lastCode = null;
	if (!saveState(st, token)) return;
	journal(st, "llm-review", { verdict: review.verdict, reasons: review.reasons });
	writeRoundReview(st, syntheticV, review, review.diff);
	if (review.verdict === "pass") {
		st.stage = "done";
		st.status = "done";
		st.acceptance = "passed";
		if (!saveState(st, token)) return;
		journal(st, "validate-pass", { mode: "llm", review: review.verdict, acceptance: st.acceptance });
		notify(ctx, "✅ mini-harness（LLM loop）：reviewer 判定达成。", "info");
	} else if (review.verdict === "block") {
		if (st.round < st.maxRounds) {
			const failedRound = st.round;
			st.round += 1;
			st.stage = "run";
			st.validatedRound = 0;
			st.reviewStep = undefined;
			if (!saveState(st, token)) return;
			journal(st, "llm-block", { reasons: review.reasons, failedRound, nextRound: st.round });
			markRunTurnDispatch(st.runId, st.sessionId);
			pi.sendUserMessage(
				`【mini-harness · LLM loop 第 ${st.round} 轮】reviewer 否决：\n${review.reasons.join("\n")}\n` +
					`请修复后再次调用 loop_done(summary)。目标：${st.goal}。不要向用户提问。`,
				{ deliverAs: "followUp" },
			);
		} else {
			st.stage = "stopped";
			st.status = "stopped";
			st.stopReason = "max-rounds";
			st.epoch += 1;
			if (!saveState(st, token)) return;
			journal(st, "llm-max-rounds");
			notify(ctx, `⚠️ mini-harness（LLM loop）：已达最大轮数 ${st.maxRounds}，停止。`, "warning");
		}
	} else if (review.verdict === "skip") {
		// 【修复③】reviewer 被关闭：LLM loop 按模型自述完成收尾（显式标记 self-declared），
		// 不再以 reviewer-error 停止。用户关闭 reviewer 即接受自述完成这一语义。
		st.lastVerdict = "self-declared";
		st.stage = "done";
		st.status = "done";
		st.acceptance = "self-declared";
		if (!saveState(st, token)) return;
		journal(st, "llm-self-declared", {});
		notify(ctx, "✅ mini-harness（LLM loop）：reviewer 已关闭，按模型自述完成（self-declared）。", "info");
	} else {
		// reviewer 故障，且无 validator 可降级 → 停止（不做无判定完成）
		st.stage = "stopped";
		st.status = "stopped";
		st.stopReason = "reviewer-error";
		st.epoch += 1;
		if (!saveState(st, token)) return;
		journal(st, "reviewer-error", { mode: "llm", reasons: review.reasons });
		notify(ctx, "⚠️ mini-harness（LLM loop）：reviewer 不可用且无 validator 可降级，已停止。", "warning");
	}
}

// ---------- 运行报告 ----------

function writeRoundReview(
	st: LoopState,
	v: { pass?: boolean; code?: number | null; output?: string } | null,
	review: { verdict: string; reasons?: string[] } | null,
	diff: string,
) {
	try {
		const dir = path.join(runDir(st.runId), "evidence");
		fs.mkdirSync(dir, { recursive: true });
		const lines = [
			`# mini-harness 运行报告 · ${st.runId}`,
			`- round: ${st.round} | stage: ${st.stage} | mode: ${st.mode}`,
			`- goal: ${st.goal}`,
			`- verdict: ${v?.pass ? "PASS" : "FAIL"}${v?.code != null ? `（exit ${v.code}）` : ""}`,
			review ? `- reviewer: ${review.verdict}` : "",
			...(review?.reasons?.length ? ["- reviewer reasons:", ...review.reasons.map((r) => `  - ${r}`)] : []),
			"",
			"## 执行者自述",
			st.summary || "(空)",
			"",
			"## 计划",
			st.plan || "(空)",
			"",
			"## validator 输出",
			"```",
			tail(v?.output || "", 4000),
			"```",
			"",
			"## 工作区/产物快照",
			"```",
			tail(diff, 4000),
			"```",
		];
		fs.writeFileSync(path.join(dir, `round-${st.round}-review.md`), lines.filter(Boolean).join("\n"));
	} catch {}
}

function buildTimelineText(st: LoopState) {
	try {
		const f = path.join(runDir(st.runId), "evidence", `round-${st.round}-review.md`);
		if (fs.existsSync(f)) return fs.readFileSync(f, "utf8");
	} catch {}
	return (
		`# mini-harness 运行报告 · ${st.runId}\n` +
		`stage=${st.stage} round=${st.round}\n` +
		`最近验证：${st.lastVerdict}（exit ${st.lastCode}）\n` +
		tail(st.lastEvidence || "", 2000)
	);
}

// ---------- 运行创建与模型准备（D-12-2） ----------

/** createLoopRun 的入参（服务端 startLoop 与 loop_start 工具共用）。 */
export interface CreateLoopRunInput {
	inputs?: Record<string, string | null>;
	taskContext?: TaskContext;
	sessionId: string;
	cwd: string;
	goal: string;
	criteria?: string;
	precheckCmd?: string;
	validateCmd?: string;
	/** 主指标名（声明后 bestRound 只认它，不按名字猜）。 */
	primaryMetric?: string;
	/** 主指标优化方向：maximize / minimize。 */
	metricDirection?: "maximize" | "minimize";
	/** @deprecated 旧「精度/硬约束」字段，仅向后兼容。 */
	metricPrecision?: number;
	/** 主指标声明单位。 */
	metricUnit?: string;
	/** 主指标目标阈值（与 metricThresholdOp 成对）。 */
	metricThreshold?: number;
	/** 主指标目标阈值运算符。 */
	metricThresholdOp?: "lt" | "lte" | "gt" | "gte";
	/** 最优轮次比较容差（相对量）。 */
	metricTolerance?: number;
	/** 必要场景配置。 */
	metricScenario?: string;
	/** 必要硬约束（主指标之外的证据门禁）。 */
	hardConstraints?: HardConstraint[];
	mode?: "code" | "llm";
	maxRounds?: number;
	useReviewer?: boolean;
	plannerModel?: string;
	reviewerModel?: string;
	worktree?: boolean;
	artifactRoots?: string[];
	taskId?: string;
	harnessRoot?: string;
	/** 能力包 id / 版本（追溯本次使用的知识版本）。 */
	packId?: string;
	packVersion?: string;
	/** 是否自动验证并自动下一轮（loop_start 的 auto 参数，默认 true）。 */
	auto?: boolean;
	/** journal 里记谁建的 run：server = 界面启动（默认），tool = 模型自己调 loop_start。 */
	source?: "server" | "tool";
}

function gitSync(args: string[], cwd: string, timeout: number): string {
	return execFileSync("git", args, { cwd, timeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * 建 run，只做文件与 git 操作、不调模型：校验 → runId → 可选 worktree → 落盘 state.json
 * （绑定 sessionId、stage=intake、setupPending=true）→ journal start。同会话已有活跃 run 时拒绝。
 * 家族解析与规划留给 setupRun（服务端建的 run 在 before_agent_start 里做）。
 * saveState 会上报 run-state 事件，界面立刻能看到这个 run。
 */
export function createLoopRun(
	input: CreateLoopRunInput,
): { ok: true; runId: string; st: LoopState } | { ok: false; error: string } {
	const normalized = normalizeTaskInputs(input);
	if (!normalized.ok) return { ok: false, error: normalized.error ?? "输入不合法" };
	input = {
		...input,
		inputs: normalized.inputs,
		validateCmd: normalized.inputs.validateCmd ?? undefined,
		precheckCmd: normalized.inputs.precheckCmd ?? undefined,
	};
	if (input.packId) {
		const context = resolveTaskContext(input.packId, input.cwd, normalized.inputs);
		if (context.error || context.missing.length || context.conflicts.length) {
			return { ok: false, error: context.error || "任务输入存在缺口或冲突" };
		}
		input.taskContext = context;
	}
	const goal = String(input.goal ?? "").trim();
	if (!goal) return { ok: false, error: "goal 不能为空" };
	const sessionId = String(input.sessionId ?? "").trim();
	if (!sessionId) return { ok: false, error: "缺少 sessionId，run 无法绑定会话" };
	// 用户声明的硬约束/阈值/类型不合法：拒绝启动并指出字段，绝不静默删除条目削弱验收要求。
	const inputErrors = validateLoopInputs(input);
	if (inputErrors.length) {
		return { ok: false, error: "验收约束不合法：" + inputErrors.join("；") };
	}
	const existing = activeRunOf(sessionId);
	if (existing) return { ok: false, error: `当前会话已有运行中的任务 ${existing.runId}` };

	const runId = newRunId();
	const maxRounds = Math.max(1, Math.min(20, Number(input.maxRounds) || DEFAULT_MAX_ROUNDS));
	const baseWorkspace = real(input.cwd || process.cwd());
	if (!fs.existsSync(baseWorkspace) || !fs.statSync(baseWorkspace).isDirectory())
		return { ok: false, error: "workspace 不存在" };
	// worktree 隔离：可选，在 git 仓库里开一个独立 worktree，避免并行任务互相污染
	let workspace = baseWorkspace;
	let worktreeDir: string | null = null;
	let worktreeBranch: string | null = null;
	if (input.worktree) {
		try {
			const inside = gitSync(["-C", baseWorkspace, "rev-parse", "--is-inside-work-tree"], baseWorkspace, 15000);
			if (inside.trim() !== "true") {
				return { ok: false, error: `要求 worktree 隔离，但 ${baseWorkspace} 不是 git 仓库。` };
			}
			const dir = path.join(ROOT, runId, "worktree");
			const branch = `mini-harness/${runId}`;
			gitSync(["-C", baseWorkspace, "worktree", "add", "-b", branch, dir], baseWorkspace, 60000);
			worktreeDir = dir;
			worktreeBranch = branch;
			workspace = real(dir);
		} catch (e) {
			// 要求隔离时，创建失败必须显式报错，绝不静默回退到原工作区
			//（否则会出现「模型改原目录、验收查 worktree」的不一致）。
			return { ok: false, error: `worktree 隔离失败：${String((e as Error)?.message || e)}` };
		}
	}
	const criteria = String(input.criteria ?? "").trim();
	const plannerSpec = String(input.plannerModel ?? "").trim();
	const reviewerSpec = String(input.reviewerModel ?? "").trim();
	const st: LoopState = {
		runId,
		revision: 0,
		inputs: normalized.inputs,
		taskContext: input.taskContext,
		taskId: input.taskId ? String(input.taskId) : null,
		goal,
		workspace,
		baseWorkspace,
		worktreeDir,
		worktreeBranch,
		worktreeCommitted: false,
		harnessRoot: input.harnessRoot || null,
		artifactRoots: (input.artifactRoots ?? [])
			.map((x) => String(x).trim())
			.filter(Boolean)
			.map((x) => real(x)),
		precheckCmd: input.precheckCmd ?? null,
		validateCmd: input.validateCmd ?? null,
		primaryMetric: String(input.primaryMetric ?? "").trim() || null,
		metricDirection:
			input.metricDirection === "minimize" ? "minimize" : input.metricDirection === "maximize" ? "maximize" : null,
		metricPrecision:
			input.metricPrecision != null && Number.isFinite(Number(input.metricPrecision))
				? Number(input.metricPrecision)
				: null,
		metricUnit: String(input.metricUnit ?? "").trim() || null,
		metricThreshold:
			input.metricThreshold != null && Number.isFinite(Number(input.metricThreshold))
				? Number(input.metricThreshold)
				: null,
		metricThresholdOp: isThresholdOp(input.metricThresholdOp) ? input.metricThresholdOp : null,
		metricTolerance:
			input.metricTolerance != null && Number.isFinite(Number(input.metricTolerance))
				? Math.max(0, Number(input.metricTolerance))
				: null,
		metricScenario: String(input.metricScenario ?? "").trim() || null,
		hardConstraints: sanitizeHardConstraints(input.hardConstraints),
		maxRounds,
		auto: input.auto !== false,
		mode: input.mode === "llm" ? "llm" : "code",
		round: 1,
		stage: "intake",
		status: "active",
		epoch: 0,
		sessionId,
		packId: input.packId ? String(input.packId) : null,
		packVersion: input.packVersion ? String(input.packVersion) : null,
		attemptId: newAttemptId(),
		owner: newOwner(),
		generation: 1,
		remoteJobId: null,
		environmentFingerprint: null,
		recoveryState: "running",
		mainModel: null,
		plannerModel: null,
		reviewerModel: null,
		plannerOutput: "",
		lastReview: null,
		plan: "",
		summary: "",
		lastVerdict: null,
		lastCode: null,
		lastEvidence: "",
		validatedRound: 0,
		createdAt: now(),
		history: [],
		acceptance: null,
		useReviewer: input.useReviewer !== false,
		...(criteria ? { criteria } : {}),
		preflightSummary: collectPreflightSummary(workspace),
		setupPending: true,
		...(plannerSpec ? { plannerSpec } : {}),
		...(reviewerSpec ? { reviewerSpec } : {}),
	};
	st.environmentFingerprint = currentFingerprintOf(st, true);
	// 隔夜恢复：run 创建即取得执行所有权（owner + generation + 心跳）。
	const leaseAcquired = withRunLockSync(runDir(runId), () => {
		const acquired = acquireLease(runDir(runId), {
			owner: st.owner!,
			pid: process.pid,
			generation: st.generation,
			startedAt: st.createdAt,
			heartbeatAt: st.createdAt,
			remoteJobId: null,
		});
		if (!acquired) return false;
		localClaims.set(runId, { owner: st.owner!, generation: st.generation });
		return saveState(st);
	});
	if (!leaseAcquired.ok || !leaseAcquired.value) {
		// 取租约失败 = 无法证明独占执行权：任务创建必须明确失败，不能忽略后继续执行。
		return { ok: false, error: `无法取得执行所有权（租约被占用）：${runId}` };
	}
	// 心跳接入真实生命周期：活跃期间周期续租，终态时停止。
	startLeaseHeartbeat(runId, st.owner!, st.generation);
	journal(st, "start", {
		source: input.source ?? "server",
		goal,
		taskId: st.taskId,
		mode: st.mode,
		useReviewer: st.useReviewer,
		worktree: worktreeBranch,
	});
	return { ok: true, runId, st };
}

function plannerPrompt(st: LoopState) {
	return [
		`目标：${st.goal}`,
		st.criteria ? `验收标准（用户给定）：${st.criteria}` : "",
		`工作区：${st.workspace}`,
		st.precheckCmd ? `precheck (L0)：${st.precheckCmd}` : "",
		st.validateCmd ? `validator (L1)：${st.validateCmd}` : "",
		st.mode === "llm" ? "（LLM loop：无代码 validator，验收条件由 reviewer 判定）" : "",
		"请输出：1) 拆解步骤；2) 验收条件（明确文件/命令/指标，能被 validator 或人工直接核验）；3) 风险与需要人工确认的点。",
	]
		.filter(Boolean)
		.join("\n");
}

/** 模型准备失败：stopped / setup-error（epoch+1，在途回调全部失效），记下原因并告警。 */
function failSetup(ctx: LoopCtx, st: LoopState, error: string) {
	st.status = "stopped";
	st.stage = "stopped";
	st.stopReason = "setup-error";
	st.setupError = error;
	st.setupPending = false;
	st.epoch += 1;
	if (!saveState(st)) return;
	journal(st, "setup-error", { error, epoch: st.epoch });
	notify(ctx, `⚠️ mini-harness：任务 ${st.runId} 没启动起来：${error}`, "warning");
}

/**
 * 模型准备（loop_start 与 before_agent_start 共用）：家族解析（loop_start 传入已解析的结果）→
 * 落盘主/规划/评审模型 → planner 规划（失败不阻塞，只记录）→ 清 setupPending、stage=plan。
 * 解析失败 → failSetup。planner 的 await 前后核对代次：准备期间被停止的 run 不得被复活。
 */
async function setupRun(
	ctx: LoopCtx,
	st: LoopState,
	resolved?: RunModels,
): Promise<{ ok: true; plannerNote: string } | { ok: false; error: string }> {
	let models: RunModels;
	if (resolved) {
		models = resolved;
	} else {
		const r = resolveRunModels(ctx, {
			plannerSpec: st.plannerSpec || "",
			reviewerSpec: st.reviewerSpec || "",
			useReviewer: st.useReviewer !== false,
		});
		if (!r.ok) {
			failSetup(ctx, st, r.error);
			return { ok: false, error: r.error };
		}
		models = r;
	}
	st.mainModel = modelBrief(models.main);
	st.plannerModel = modelBrief(models.planner);
	st.reviewerModel = modelBrief(models.reviewer);
	if (!saveState(st)) return { ok: false, error: "模型准备状态提交冲突，未发起规划" };
	journal(st, "setup", { main: st.mainModel, planner: st.plannerModel, reviewer: st.reviewerModel });

	let plannerNote = "";
	const setupToken = tokenOf(st);
	if (models.planner) {
		let plan = "";
		let error = "";
		try {
			plan = await callModel(
				ctx,
				models.planner,
				"你是任务规划者。只输出可执行的计划与机器可验证的验收条件，不要调用工具、不要臆测环境。",
				plannerPrompt(st),
			);
		} catch (e) {
			error = String((e as Error)?.message || e);
		}
		if (!stillCurrent(setupToken)) {
			journal(st, "late-callback-dropped", { at: "setupRun/planner", epoch: setupToken.epoch });
			return { ok: false, error: "模型准备期间运行已被停止" };
		}
		if (error) {
			plannerNote = `\n⚠️ planner 调用失败（不影响运行）：${error}`;
			journal(st, "planner-error", { error });
		} else {
			st.plannerOutput = plan;
			journal(st, "planner", { family: st.plannerModel?.family, chars: plan.length });
			plannerNote = `\nplanner（${st.plannerModel?.family}/${st.plannerModel?.id}）已产出验收条件，见状态块。`;
		}
	}
	st.setupPending = false;
	st.stage = "plan";
	if (!saveState(st, setupToken)) return { ok: false, error: "模型准备结果提交冲突" };
	return { ok: true, plannerNote };
}

// ---------- 扩展入口 ----------

/**
 * mini-harness Loop 扩展工厂。
 * 经 agent-service 的 extensionFactories 注入（名字 mini-harness-loop，hidden），
 * 不再依赖 ~/.pi/agent 注册的包路径（那会加载到别的目录树的副本）。
 */
export function createLoopExtension() {
	return (pi: ExtensionAPI): void => {
		const busy = new Set<string>();
		// 模型准备在途的 runId（before_agent_start 不重复做同一个 run 的家族解析与规划）
		const setupBusy = new Set<string>();

		// ---- 工具：loop_start ----
		pi.registerTool({
			name: "loop_start",
			label: "Loop Start",
			description:
				"启动一个受 validator 约束的任务运行（状态机 intake→plan→run→validate）。" +
				"validator 不通过会自动进入下一轮。状态落盘，可断点续跑。" +
				"当前会话已有活跃运行时直接返回该运行，不重复创建。",
			parameters: Type.Object({
				goal: Type.String({ description: "要达成的目标（写清可验证的完成条件）" }),
				precheckCmd: Type.Optional(
					Type.String({
						description: "L0 fast precheck shell command run before full validator",
					}),
				),
				validateCmd: Type.Optional(
					Type.String({
						description: "validator 命令（shell）。缺省自动找 workspace/validate.py 或 HARNESS_ROOT/validate.py",
					}),
				),
				harnessRoot: Type.Optional(
					Type.String({ description: "infer-forge-harness 仓库根目录（用于定位 validate.py）" }),
				),
				primaryMetric: Type.Optional(
					Type.String({ description: "主指标名（如 loss_pct / tps / ttft_ms）；声明后最优轮次只按它比较，不按名字猜" }),
				),
				metricDirection: Type.Optional(
					Type.String({ description: "主指标优化方向：maximize（越大越好）或 minimize（越小越好）" }),
				),
				metricPrecision: Type.Optional(Type.Number({ description: "（废弃）旧精度/硬约束字段，仅向后兼容" })),
				metricUnit: Type.Optional(Type.String({ description: "主指标单位（如 % / tokens/s / ms）" })),
				metricThreshold: Type.Optional(Type.Number({ description: "主指标目标阈值（与 metricThresholdOp 成对）" })),
				metricThresholdOp: Type.Optional(Type.String({ description: "主指标目标阈值运算符：lt / lte / gt / gte" })),
				metricTolerance: Type.Optional(Type.Number({ description: "最优轮次比较容差（相对量，仅择优用）" })),
				metricScenario: Type.Optional(Type.String({ description: "必要场景配置；声明后 validator 必须报出匹配场景" })),
				hardConstraints: Type.Optional(
					Type.Array(
						Type.Object({
							name: Type.String({ description: "约束名（展示用）" }),
							metric: Type.String({ description: "约束指标名（HARNESS_METRIC 的键）" }),
							op: Type.String({ description: "运算符：lt / lte / gt / gte" }),
							value: Type.Number({ description: "约束值" }),
							unit: Type.Optional(Type.String({ description: "声明单位" })),
							scenario: Type.Optional(Type.String({ description: "必要场景配置" })),
						}),
						{ description: "必要硬约束（主指标之外的证据门禁）" },
					),
				),
				artifactRoots: Type.Optional(
					Type.Array(Type.String(), { description: "产物根目录（可多个，workspace 之外）；reviewer 会核验这些目录" }),
				),
				maxRounds: Type.Optional(Type.Number({ description: `最大轮数，默认 ${DEFAULT_MAX_ROUNDS}` })),
				auto: Type.Optional(Type.Boolean({ description: "是否自动验证并自动下一轮，默认 true" })),
				plannerModel: Type.Optional(
					Type.String({ description: "规划模型（provider/id 或 id）。必须与主模型不同家族；缺省自动挑选" }),
				),
				reviewerModel: Type.Optional(
					Type.String({ description: "审查模型（provider/id 或 id）。必须与主模型、planner 都不同家族；缺省自动挑选" }),
				),
				useReviewer: Type.Optional(
					Type.Boolean({ description: "是否启用 reviewer 否决层，默认 true（有可用模型时）" }),
				),
				worktree: Type.Optional(
					Type.Boolean({
						description:
							"若 workspace 是 git 仓库，则在新 git worktree 中执行（隔离并行任务，验证通过后提交到独立分支）",
					}),
				),
				mode: Type.Optional(
					Type.String({
						description: "loop 类型：code（默认，validator 门禁）或 llm（无代码 validator，纯 reviewer 判定完成/迭代）",
					}),
				),
				taskId: Type.Optional(
					Type.String({
						description: "调用方任务 ID（批量队列/外部编排用）；记入运行状态用于显式关联，避免按 cwd+时间猜测",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const c = ctx as unknown as LoopCtx;
				// D-12-2：同会话已有活跃 run（多半是服务端点启动时建好的）→ 直接返回它，不重复创建
				const existing = findActiveRun(c);
				if (existing) {
					return {
						content: [
							{
								type: "text",
								text:
									`当前会话已有运行中的任务 ${existing.runId}（mode=${existing.mode}，stage=${existing.stage}，` +
									`第 ${existing.round}/${existing.maxRounds} 轮），不要再调用 loop_start。\n` +
									(existing.stage === "intake" || existing.stage === "plan"
										? "下一步：调用 loop_plan 写出计划，然后直接修改工作区，完成时调用 loop_done(summary)。"
										: "按状态块继续当前这一轮，完成时调用 loop_done(summary)。"),
							},
						],
						details: {
							runId: existing.runId,
							taskId: existing.taskId,
							mode: existing.mode,
							stage: existing.stage,
							round: existing.round,
							existing: true,
						},
					};
				}
				// 家族约束先校验：冲突 / 无法解析照旧直接报错，不建 run
				const plannerSpec = params.plannerModel ? String(params.plannerModel) : "";
				const reviewerSpec = params.reviewerModel ? String(params.reviewerModel) : "";
				const useReviewer = params.useReviewer !== false;
				const models = resolveRunModels(c, { plannerSpec, reviewerSpec, useReviewer });
				if (!models.ok) {
					return { content: [{ type: "text", text: models.error }], details: {} };
				}
				const created = createLoopRun({
					sessionId: sessionIdOf(c),
					cwd: c?.cwd || process.cwd(),
					goal: String(params.goal || ""),
					precheckCmd: params.precheckCmd,
					validateCmd: params.validateCmd,
					harnessRoot: params.harnessRoot,
					primaryMetric: params.primaryMetric,
					metricDirection:
						params.metricDirection === "minimize" || params.metricDirection === "maximize"
							? params.metricDirection
							: undefined,
					metricPrecision: params.metricPrecision,
					metricUnit: params.metricUnit,
					metricThreshold: params.metricThreshold,
					metricThresholdOp: isThresholdOp(params.metricThresholdOp) ? params.metricThresholdOp : undefined,
					metricTolerance: params.metricTolerance,
					metricScenario: params.metricScenario,
					hardConstraints: params.hardConstraints as HardConstraint[] | undefined,
					artifactRoots: Array.isArray(params.artifactRoots) ? params.artifactRoots : [],
					maxRounds: params.maxRounds,
					auto: params.auto,
					plannerModel: plannerSpec,
					reviewerModel: reviewerSpec,
					useReviewer,
					worktree: params.worktree,
					mode: params.mode === "llm" ? "llm" : "code",
					taskId: params.taskId,
					source: "tool",
				});
				if (!created.ok) {
					return { content: [{ type: "text", text: created.error }], details: {} };
				}
				const st = created.st;
				const runId = st.runId;
				// run 已创建：消费服务层登记的挂起启动请求（该回合结束不再上报 request-failed）
				takePendingLoopRequest(st.sessionId);
				// 模型准备（与服务端建的 run 共用 setupRun）：落盘模型 + planner 规划，stage → plan
				const setup = await setupRun(c, st, models);
				if (!setup.ok) {
					return {
						content: [{ type: "text", text: `运行 ${runId} 没有启动起来：${setup.error}` }],
						details: { runId, taskId: st.taskId, mode: st.mode, stage: st.stage, round: st.round },
					};
				}
				const plannerNote = setup.plannerNote;
				const mainFam = models.mainFam;
				const maxRounds = st.maxRounds;

				return {
					content: [
						{
							type: "text",
							text:
								`已创建运行 ${runId}（mode=${st.mode}，stage=${st.stage}，最多 ${maxRounds} 轮）。\n` +
								`主模型家族：${mainFam}；` +
								`planner：${st.plannerModel ? `${st.plannerModel.family}/${st.plannerModel.id}` : "(无)"}；` +
								`reviewer：${st.reviewerModel ? `${st.reviewerModel.family}/${st.reviewerModel.id}` : "(无)"}。\n` +
								(st.worktreeBranch
									? `worktree 隔离：已在新分支 ${st.worktreeBranch} 的独立工作树中执行（验证通过后自动提交）。\n`
									: "") +
								"下一步：先调用 loop_plan 写出计划（会自动进入 run 阶段），然后直接修改工作区。\n" +
								"完成时调用 loop_done(summary)；运行时会自动执行 validator，" +
								"通过后 reviewer 可行使否决权，不通过则带证据进入下一轮。" +
								plannerNote,
						},
					],
					details: {
						runId,
						taskId: st.taskId,
						mode: st.mode,
						stage: st.stage,
						round: st.round,
						mainFamily: mainFam,
						planner: st.plannerModel,
						reviewer: st.reviewerModel,
					},
				};
			},
		});

		// ---- 工具：loop_plan ----
		pi.registerTool({
			name: "loop_plan",
			label: "Loop Plan",
			description: "记录本轮计划并进入 run 阶段。",
			parameters: Type.Object({ plan: Type.String({ description: "计划/步骤" }) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const st = findActiveRun(ctx as unknown as LoopCtx);
				if (!st) {
					return { content: [{ type: "text", text: "当前会话没有活跃运行。请先调用 loop_start。" }], details: {} };
				}
				if (!stillCurrent(tokenOf(st)) || st.stage === "validate" || st.reviewStep) {
					return { content: [{ type: "text", text: "当前验收或停止尚未落定，不能重新规划。" }], details: {} };
				}
				st.plan = String(params.plan || "").trim();
				st.stage = "run";
				if (!saveState(st))
					return { content: [{ type: "text", text: "状态提交冲突，计划未保存，请重新核对任务。" }], details: {} };
				journal(st, "plan", { plan: tail(st.plan, 400) });
				return {
					content: [
						{ type: "text", text: `计划已记录，进入 run（第 ${st.round} 轮）。完成后调用 loop_done(summary)。` },
					],
					details: { runId: st.runId, stage: st.stage },
				};
			},
		});

		// ---- 工具：loop_done ----
		pi.registerTool({
			name: "loop_done",
			label: "Loop Done",
			description: "声明本轮完成。运行时会自动执行 validator；只有 validator 通过才算真正完成。",
			parameters: Type.Object({ summary: Type.String({ description: "本轮改了什么、怎么验证的" }) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const st = findActiveRun(ctx as unknown as LoopCtx);
				if (!st) {
					return { content: [{ type: "text", text: "当前会话没有活跃运行。请先调用 loop_start。" }], details: {} };
				}
				st.summary = String(params.summary || "").trim();
				if (!stillCurrent(tokenOf(st)))
					return { content: [{ type: "text", text: "执行权已失效或正在停止。" }], details: {} };
				if (st.stage === "validate" || st.validatedRound === st.round || st.reviewStep) {
					return { content: [{ type: "text", text: "本轮验收已开始或已记录，复用原结果。" }], details: {} };
				}
				st.stage = "validate";
				if (!saveState(st))
					return { content: [{ type: "text", text: "状态提交冲突，未进入验收，请重新核对任务。" }], details: {} };
				journal(st, "done-claimed", { summary: tail(st.summary, 400) });
				return {
					content: [{ type: "text", text: "已声明完成。运行时将在本轮结束时自动执行 validator 并给出判定。" }],
					details: { runId: st.runId, stage: st.stage },
				};
			},
		});

		// ---- 工具：loop_validate ----
		pi.registerTool({
			name: "loop_validate",
			label: "Loop Validate",
			description: "手动执行 validator 并记录证据（通常由运行时自动调用）。",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				const c = ctx as unknown as LoopCtx;
				const st = findActiveRun(c);
				if (!st) {
					return { content: [{ type: "text", text: "当前会话没有活跃运行。" }], details: {} };
				}
				if (st.mode === "llm") {
					await handleLlmVerdict(pi, c, st);
					return {
						content: [{ type: "text", text: `LLM loop 判定完成（reviewer ${st.lastReview?.verdict ?? "n/a"}）。` }],
						details: { runId: st.runId, mode: "llm", review: st.lastReview?.verdict },
					};
				}
				const token = tokenOf(st);
				const v = await runValidation(pi, st);
				// 停止/接管守卫：手动验收期间被停止（epoch 已递增）或被接管（generation 已变）时，
				// 不得把旧状态写回 active，也不得继续跑 reviewer 或推进下一轮（回归：停止后手动验收的迟到结果复活任务）。
				if (v.cancelled || !stillCurrent(token)) {
					journal(st, "late-callback-dropped", { at: "loop_validate", epoch: token.epoch });
					return {
						content: [{ type: "text", text: "运行已停止，本次手动验证结果已丢弃，不再推进。" }],
						details: { runId: st.runId, cancelled: true },
					};
				}
				if (!(await recordValidationOutcome(st, v, token))) {
					return {
						content: [{ type: "text", text: "运行已停止，本次手动验证结果已丢弃，不再推进。" }],
						details: { runId: st.runId, cancelled: true },
					};
				}
				journal(st, "manual-validate", {
					pass: v.pass,
					code: v.code,
					precheckFailed: v.precheckFailed,
					metrics: v.metrics,
				});
				if (v.pass) {
					// 通过：同步跑 reviewer 并完结，避免 headless/print 模式下 agent_end 早退导致 reviewer 被跳过
					await handleVerdict(pi, c, st, v);
				} else {
					// 失败：交给 agent_end 统一推进下一轮（带证据 followUp）
					st.stage = "run";
					if (!saveState(st, token))
						return { content: [{ type: "text", text: "状态提交冲突，不再推进任务。" }], details: {} };
				}
				return {
					content: [
						{
							type: "text",
							text:
								`${v.pass ? "PASS" : "FAIL"}（exit ${v.code}）\n${tail(v.output, 2000)}` +
								(v.pass ? `\nreviewer: ${st.lastReview?.verdict ?? "n/a"}` : ""),
						},
					],
					details: {
						runId: st.runId,
						pass: v.pass,
						code: v.code,
						evidence: v.evidence,
						review: st.lastReview?.verdict,
					},
				};
			},
		});

		// ---- 工具：loop_status ----
		pi.registerTool({
			name: "loop_status",
			label: "Loop Status",
			description: "查看当前会话的活跃运行状态（或指定 runId）。",
			parameters: Type.Object({ runId: Type.Optional(Type.String()) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const st = params.runId ? loadState(String(params.runId)) : findActiveRun(ctx as unknown as LoopCtx);
				if (!st) {
					return { content: [{ type: "text", text: "没有找到运行。" }], details: {} };
				}
				return {
					content: [{ type: "text", text: buildTimelineText(st) }],
					details: { runId: st.runId, stage: st.stage, status: st.status },
				};
			},
		});

		// ---- 工具：loop_stop ----
		pi.registerTool({
			name: "loop_stop",
			label: "Loop Stop",
			description: "停止当前会话的活跃运行（对在途操作与后续调度都生效）。",
			parameters: Type.Object({ reason: Type.Optional(Type.String()) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const st = findActiveRun(ctx as unknown as LoopCtx);
				if (!st) {
					return { content: [{ type: "text", text: "当前会话没有活跃运行。" }], details: {} };
				}
				const result = stopRunExternal(st.runId, String(params.reason || "") || "user-stop");
				return {
					content: [
						{
							type: "text",
							text: !result.ok
								? result.error!
								: result.stopConfirmedAt
									? "已确认停止运行 " + st.runId
									: "已请求停止，等待执行实体退出确认。",
						},
					],
					details: { runId: st.runId, ...result },
				};
			},
		});

		// ---- 工具：loop_review ----
		pi.registerTool({
			name: "loop_review",
			label: "Loop Review",
			description: "读取运行报告（validator 证据 + reviewer 结论）。",
			parameters: Type.Object({ runId: Type.Optional(Type.String()) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const st = params.runId ? loadState(String(params.runId)) : findActiveRun(ctx as unknown as LoopCtx);
				if (!st) return { content: [{ type: "text", text: "没有找到运行。" }], details: {} };
				return {
					content: [{ type: "text", text: buildTimelineText(st) }],
					details: { runId: st.runId, stage: st.stage, status: st.status },
				};
			},
		});

		// ---- 工具：loop_timeline ----
		pi.registerTool({
			name: "loop_timeline",
			label: "Loop Timeline",
			description: "读取运行 journal（时间线）。",
			parameters: Type.Object({ runId: Type.Optional(Type.String()) }),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const c = ctx as unknown as LoopCtx;
				const st = params.runId
					? loadState(String(params.runId))
					: findActiveRun(c) || listRuns().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
				if (!st) return { content: [{ type: "text", text: "没有找到运行。" }], details: {} };
				return {
					content: [{ type: "text", text: buildTimelineText(st) }],
					details: { runId: st.runId, stage: st.stage, status: st.status },
				};
			},
		});

		// ---- 运行前注入状态（缓存友好：作为隐藏尾消息，不改系统提示词）----
		pi.on("before_agent_start", async (event, ctx) => {
			if ((event as { messageType?: string })?.messageType === "custom") {
				return;
			}
			const c = ctx as unknown as LoopCtx;
			let st = findActiveRun(c);
			if (!st || st.status !== "active") {
				return;
			}
			// 回合在途标记（内存 + 持久）只对「run 回合」置位：服务层/扩展投递 run 回合前
			// 登记（markRunTurnDispatch），本回合启动时消费并注册取消控制器。同会话的普通
			// 聊天回合没有登记 → 不置位、不注册，停止不会取消它。持久证据供宿主重启后
			// 判断旧回合是否随宿主结束。
			beginLoopTurn(st.runId, sessionIdOf(c), c as LoopCtx & { abort?: () => void; isIdle?: () => boolean });
			// 重新读取：beginLoopTurn 落盘了「回合在途」证据，后续 setup 的 saveState 要带上它。
			st = findActiveRun(c) ?? st;
			// D-12-2：服务端建的 run 在第一次开跑前做模型准备（家族解析 + 规划，原 loop_start 的逻辑）
			if (st.setupPending && !setupBusy.has(st.runId)) {
				const runId = st.runId;
				const setupToken = tokenOf(st);
				setupBusy.add(runId);
				let setup: Awaited<ReturnType<typeof setupRun>>;
				try {
					setup = await setupRun(c, st);
				} catch (e) {
					// 意外异常（落盘失败等）也要可见：按 setup-error 收尾，不让模型在没有 run 的情况下开工
					const msg = String((e as Error)?.message || e);
					const fresh = loadState(runId);
					if (fresh && stillCurrent(setupToken)) failSetup(c, fresh, msg);
					setup = { ok: false, error: msg };
				} finally {
					setupBusy.delete(runId);
				}
				if (!setup.ok) {
					return { message: { customType: CUSTOM_TYPE, content: setupFailedBlock(st, setup.error), display: false } };
				}
				st = findActiveRun(c) ?? st;
			}
			return { message: { customType: CUSTOM_TYPE, content: stateBlock(st), display: false } };
		});

		// ---- 运行结束：自动 validator → 通过则完成；失败则自动下一轮 ----
		pi.on("agent_end", async (_event, ctx) => {
			const c = ctx as unknown as LoopCtx;
			// 回合结束事件只清理自己：清除本会话 run 的「回合在途」标记并注销本会话本回合
			// 的控制器（含刚被停止的 run）；别的会话/新回合的取消域不受影响。
			endLoopTurnsForSession(sessionIdOf(c));
			const st = findActiveRun(c);
			if (!st) {
				// 修复「启动后无可见记录/无明确失败态」：服务层发启动提示词前会登记挂起请求；
				// 本回合结束仍没有活跃 run（模型没调 loop_start，或调用被拒）→ 上报明确失败。
				const sid = sessionIdOf(c);
				const pending = sid ? takePendingLoopRequest(sid) : null;
				if (pending) {
					reportEvent({
						type: "request-failed",
						sessionId: sid,
						taskId: pending.taskId,
						goal: pending.goal,
						reason: "模型未在本回合调用 loop_start（或调用被拒）",
					});
				}
				return;
			}
			if (!st.auto || st.status !== "active") {
				return;
			}
			if (!["run", "validate"].includes(st.stage)) {
				return;
			}
			if (busy.has(st.runId)) {
				return;
			}
			busy.add(st.runId);
			const token = tokenOf(st);
			try {
				if (st.mode === "llm") {
					await handleLlmVerdict(pi, c, st);
				} else {
					let v: {
						pass: boolean;
						noValidator: boolean;
						code: number | null;
						evidence: string | null;
						output: string;
						cancelled?: boolean;
						workspaceChangedDuringValidation?: boolean;
					};
					if (st.validatedRound === st.round && st.lastVerdict && evidenceStillValid(st)) {
						// 模型本轮已手动 loop_validate：复用结果，不再重复执行
						v = {
							pass: st.lastVerdict === "pass",
							noValidator: false,
							code: st.lastCode,
							output: st.lastEvidence || "",
							evidence: null,
							workspaceChangedDuringValidation: st.history.at(-1)?.workspaceChangedDuringValidation,
						};
					} else {
						v = await runValidation(pi, st);
						if (v.cancelled || !stillCurrent(token)) {
							journal(st, "late-callback-dropped", { at: "agent_end/runValidation", epoch: token.epoch });
							return;
						}
						if (!(await recordValidationOutcome(st, v, token))) {
							return;
						}
					}
					await handleVerdict(pi, c, st, v);
				}
			} catch (e) {
				journal(st, "runtime-error", { error: String((e as Error)?.message || e) });
				// 执行异常必须可见：不吞错，标记中断态（不伪装成完成）。
				// 用磁盘态 + 捕获的执行身份判定，避免把用户「停止」/「接管」后的旧内存态重新落盘。
				const fresh = loadState(st.runId);
				if (fresh && fresh.status === "active" && matchesToken(fresh, token)) {
					fresh.status = "stopped";
					fresh.stage = "stopped";
					fresh.stopReason = "runtime-error";
					fresh.epoch += 1;
					saveState(fresh, token);
					journal(fresh, "runtime-error-stop", { epoch: fresh.epoch });
					notify(c, `⚠️ mini-harness：运行时异常，已停止（${String((e as Error)?.message || e)}）。`, "warning");
				}
			} finally {
				busy.delete(st.runId);
			}
		});
	};
}

// ---------- 服务端停止入口（UI「停止」按钮用；与 loop_stop 工具同一语义） ----------

/**
 * 服务端停止指定 run：status=stopped、epoch+1（在途/迟到回调全部失效）、落盘。
 * 与扩展内 loop_stop 工具同语义；saveState 会自动上报 run-state 事件，
 * 服务层据此刷新快照。返回 ok=false 附原因（run 不存在/已终态）。
 */
function acquireRunControl(
	st: LoopState,
	owner = locallyClaimed(st.runId, st.owner, st.generation) ? st.owner! : newOwner(),
): boolean {
	const result = withRunLockSync(runDir(st.runId), () => {
		const fresh = loadState(st.runId);
		if (!fresh || fresh.revision !== st.revision) return false;
		const lease = getLease(runDir(st.runId));
		if (lease?.owner === owner && lease.generation === st.generation && !leaseExpired(lease)) {
			return locallyClaimed(st.runId, owner, st.generation);
		}
		const token = tokenOf(st);
		const generation = Math.max(st.generation, lease?.generation ?? 0) + 1;
		if (
			!acquireLease(
				runDir(st.runId),
				{ owner, generation, pid: process.pid, startedAt: now(), heartbeatAt: now(), remoteJobId: st.remoteJobId },
				{ allowOrphan: true },
			)
		)
			return false;
		st.owner = owner;
		st.generation = generation;
		// 接管前保留旧租约的执行实体证据（旧协议 run 没有 operation，taskPid 是唯一线索；
		// 身份未核实前不向该 pid 发信号，也不据此确认已停止）。
		const previousTaskPid = lease?.taskPid ?? null;
		const legacy = st.legacyExecutionEntities ?? [];
		if (previousTaskPid != null && !legacy.some((e) => e.pid === previousTaskPid)) {
			legacy.push({
				pid: previousTaskPid,
				host: lease?.host ?? null,
				startId: getProcessStartId(previousTaskPid),
				capturedAt: now(),
				generation: lease?.generation ?? 0,
			});
		}
		st.legacyExecutionEntities = legacy.slice(-8);
		// Acquisition is a distinct commit; don't release a terminal run until the
		// explicitly authorized terminal action has finished.
		const next = { ...st, revision: (st.revision ?? 0) + 1, updatedAt: now() };
		if (!matchesToken(fresh, token)) return false;
		writeFileAtomicPreserveSync(statePath(st.runId), JSON.stringify(next, null, 2) + "\n");
		Object.assign(st, next);
		localClaims.set(st.runId, { owner, generation });
		startLeaseHeartbeat(st.runId, owner, generation);
		return true;
	});
	if (!result.ok) throw new Error(result.error);
	return result.value;
}

export function stopRunExternal(
	runId: string,
	reason = "user-stop",
): {
	ok: boolean;
	error?: string;
	stopRequestedAt?: string | null;
	stopConfirmedAt?: string | null;
	status?: string;
} {
	try {
		const st = loadState(runId);
		if (!st) return { ok: false, error: "run 不存在：" + runId };
		if (st.stopConfirmedAt || (st.status === "done" && !listOperations(runId).some((op) => !op.result?.groupGone))) {
			return { ok: true, status: st.status, stopRequestedAt: st.stopRequestedAt, stopConfirmedAt: st.stopConfirmedAt };
		}
		if (!acquireRunControl(st)) return { ok: false, error: "无法取得停止控制权" };
		if (!st.stopRequestedAt) {
			st.stage = "stopping";
			st.stopReason = reason;
			st.epoch += 1;
			st.stopRequestedAt = now();
			// 停止绑定「发起时登记的回合」：后来开始的普通聊天回合不受取消、不计在途。
			st.stopTurnId = runTurnControllers.get(runId)?.turnId ?? loadState(runId)?.turnActive?.turnId ?? null;
			if (!saveState(st)) return { ok: false, error: "停止请求提交冲突" };
		}
		const token = tokenOf(st);
		const canControl = () => {
			const lease = getLease(runDir(runId));
			return (
				matchesToken(loadState(runId), token) &&
				!!lease &&
				!leaseExpired(lease) &&
				lease.owner === token.owner &&
				lease.generation === token.generation
			);
		};
		// 先取消绑定会话的模型回合（回合启动时注册的控制器；含原会话与 worktree 执行者），
		// 再取消持久 operation。abort 只是请求：回合是否真正结束由 turnEnded 给出可核验结论。
		const turn = runTurnControllers.get(runId);
		// 租约代次变化（接管/恢复）→ 旧控制器不再对应本代次的回合：不取消、不据此判定在途。
		const leaseAtTurn = getLease(runDir(runId));
		const turnStale =
			turn && turn.generation != null && leaseAtTurn?.generation != null && turn.generation !== leaseAtTurn.generation;
		let turnAbortError: string | null = null;
		if (turn && !turnStale) {
			// 停止只取消「发起时登记的回合」：登记回合已更换（后来开始的回合）→ 不取消新回合。
			const stopTurnId = loadState(runId)?.stopTurnId;
			if (!stopTurnId || turn.turnId === stopTurnId) {
				try {
					turn.abort();
				} catch (error) {
					turnAbortError = String((error as Error).message);
				}
			}
		}
		const turnInFlight = (() => {
			// 停止只等待「发起时登记的回合」：当前登记回合已更换（后来开始的回合）
			// → 旧回合已结束，不计在途、不取消新回合。
			const stopTurnId = loadState(runId)?.stopTurnId;
			if (turn && !turnStale) {
				if (stopTurnId && turn.turnId !== stopTurnId) return false;
				return !turn.turnEnded();
			}
			// 无控制器（宿主重启/会话未加载/回合未登记）：按持久证据判断。旧宿主进程已死 →
			// 回合随宿主结束，不计在途；旧宿主仍活（同机）→ 无法核验 → 待确认。
			const active = loadState(runId)?.turnActive;
			if (!active) return runTurnActive.has(runId);
			if (stopTurnId && active.turnId !== stopTurnId) return false;
			const ownerPid = Number(String(active.owner).split("@")[0]);
			if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && ownerPid !== process.pid) return isPidAlive(ownerPid);
			return runTurnActive.has(runId);
		})();
		const cancellation = cancelRunOperations(runId, reason, { canControl });
		if (!canControl()) return { ok: false, error: "停止期间控制权已失效" };
		const fresh = loadState(runId)!;
		const operations = listOperations(runId);
		const lease = getLease(runDir(runId));
		const taskPid = lease?.taskPid;
		// 接管保留的旧执行实体：身份未核实（裸 PID 不可信）时不发信号、不确认已停。
		const legacyUnverified = (fresh.legacyExecutionEntities ?? []).filter(
			(e) => e.pid != null && !operations.some((op) => op.pid === e.pid) && isPidAlive(e.pid),
		);
		const unknownExternal =
			!!fresh.remoteJobId || (!!taskPid && !operations.some((op) => op.pid === taskPid)) || legacyUnverified.length > 0;
		if (cancellation.allConfirmed && !unknownExternal && !turnInFlight && !turnAbortError) {
			fresh.status = "stopped";
			fresh.stage = "stopped";
			fresh.stopConfirmedAt = now();
			fresh.recoveryState = "cancelled";
			unregisterRunTurnController(runId);
			runTurnDispatches.delete(runId);
		} else {
			fresh.stage = "stopping";
			fresh.recoveryState = "stop-unconfirmed";
		}
		if (!saveState(fresh, token)) return { ok: false, error: "停止确认提交冲突" };
		abortRun(runId);
		journal(fresh, fresh.stopConfirmedAt ? "stop-confirmed" : "stop-requested", {
			cancellation,
			turn: { inFlight: turnInFlight, abortError: turnAbortError },
			legacyUnverified: legacyUnverified.map((e) => e.pid),
		});
		return {
			ok: true,
			status: fresh.stage,
			stopRequestedAt: fresh.stopRequestedAt,
			stopConfirmedAt: fresh.stopConfirmedAt,
		};
	} catch (error) {
		return { ok: false, error: String((error as Error).message) };
	}
}

export type DeleteLoopRunResult =
	| {
			ok: true;
			runId: string;
			worktreeRemoved: boolean;
			checkpointRefsRemoved: string[];
			runDirRemoved: true;
	  }
	| {
			ok: false;
			code: "invalid" | "missing" | "active" | "cleanup-error";
			error: string;
			runId?: string;
			worktreeRemoved?: boolean;
			checkpointRefsRemoved?: string[];
	  };

function isGitWorkspaceAt(cwd: string): boolean {
	try {
		return gitSync(["-C", cwd, "rev-parse", "--is-inside-work-tree"], cwd, 15000).trim() === "true";
	} catch {
		return false;
	}
}

function removeRunWorktree(st: LoopState, runId: string): boolean {
	if (st.worktreeDir == null) return false;
	const expected = path.resolve(runDir(runId), "worktree");
	if (path.resolve(st.worktreeDir) !== expected) {
		throw new Error(`worktreeDir 不属于该 run：${st.worktreeDir}`);
	}

	const baseWorkspace = st.baseWorkspace || st.workspace;
	const registered = gitSync(["-C", baseWorkspace, "worktree", "list", "--porcelain"], baseWorkspace, 60000)
		.split("\n")
		.some(
			(line) => line.startsWith("worktree ") && real(path.resolve(line.slice("worktree ".length))) === real(expected),
		);
	if (!registered) {
		if (fs.existsSync(expected)) throw new Error(`run worktree 未注册，拒绝删除目录：${expected}`);
		return false;
	}

	// Deliberately do not delete st.worktreeBranch. A terminal run remains inspectable/recoverable by branch.
	gitSync(["-C", baseWorkspace, "worktree", "remove", "--force", expected], baseWorkspace, 60000);
	return true;
}

function removeCheckpointRefs(st: LoopState, runId: string): string[] {
	const repo = st.baseWorkspace || st.workspace;
	if (!isGitWorkspaceAt(repo)) return [];
	const prefix = `refs/mini-harness/checkpoints/${runId}-`;
	const refs = gitSync(["-C", repo, "for-each-ref", "--format=%(refname)", `${prefix}*`], repo, 15000)
		.split("\n")
		.map((ref) => ref.trim())
		.filter((ref) => ref.startsWith(prefix));
	for (const ref of refs) {
		gitSync(["-C", repo, "update-ref", "-d", ref], repo, 15000);
	}
	return refs;
}

/**
 * Remove a terminal run and its owned resources. Active runs are never removed, and a worktree is only
 * eligible when its recorded path is exactly `<runsRoot>/<runId>/worktree`.
 */
export function deleteLoopRun(runIdInput: string): DeleteLoopRunResult {
	const runId = String(runIdInput ?? "").trim();
	if (!RUN_ID_RE.test(runId)) return { ok: false, code: "invalid", error: "bad runId" };

	const st = loadState(runId);
	if (!st) return { ok: false, code: "missing", runId, error: "run not found" };
	if (st.status === "active") return { ok: false, code: "active", runId, error: "run is active" };

	let worktreeRemoved = false;
	let checkpointRefsRemoved: string[] = [];
	try {
		worktreeRemoved = removeRunWorktree(st, runId);
	} catch (e) {
		return {
			ok: false,
			code: "cleanup-error",
			runId,
			error: String((e as Error)?.message || e),
			worktreeRemoved,
			checkpointRefsRemoved,
		};
	}
	try {
		checkpointRefsRemoved = removeCheckpointRefs(st, runId);
	} catch (e) {
		return {
			ok: false,
			code: "cleanup-error",
			runId,
			error: String((e as Error)?.message || e),
			worktreeRemoved,
			checkpointRefsRemoved,
		};
	}
	try {
		fs.rmSync(runDir(runId), { recursive: true, force: true });
	} catch (e) {
		return {
			ok: false,
			code: "cleanup-error",
			runId,
			error: String((e as Error)?.message || e),
			worktreeRemoved,
			checkpointRefsRemoved,
		};
	}
	return { ok: true, runId, worktreeRemoved, checkpointRefsRemoved, runDirRemoved: true };
}

/** 把 active run 重绑到执行者会话（worktree 模式：loop 在绑定 worktree 的子代理里跑，
 *  模型工具/终端/validator/reviewer 全落 worktree）。落盘即上报 run-state，新 sessionId 的事件会路由到执行者会话。 */
export function rebindLoopSession(runId: string, sessionId: string): { ok: boolean; error?: string } {
	const st = loadState(runId);
	if (!st) return { ok: false, error: `run 不存在：${runId}` };
	if (st.status !== "active") return { ok: false, error: `run 已是终态：${st.status}` };
	const next = String(sessionId ?? "").trim();
	if (!next) return { ok: false, error: "缺少 sessionId" };
	if (!stillCurrent(tokenOf(st))) return { ok: false, error: "执行权已失效" };
	st.sessionId = next;
	if (!saveState(st)) return { ok: false, error: "会话绑定提交冲突" };
	journal(st, "rebind-session", { sessionId: next });
	return { ok: true };
}

// ---------- 评审掉线后的两条路（D-12-1；UI「重试评审」/「按代码验证收下」用） ----------

/** 评审掉线的 run：代码验证已过、模型评审出错，停在 review-error 等用户处理。 */
function isReviewerErrorRun(st: LoopState) {
	return st.status === "stopped" && st.stopReason === "reviewer-error";
}

/**
 * 「按代码验证收下」：只接受 stopped + reviewer-error + lastVerdict=pass 的 run（LLM 模式出错时
 * lastVerdict 是 error，不能收）→ done、acceptance=passed-validator-only，journal 记 by user。
 * 与自动通过一样把 worktree 提交到独立分支（失败只记 journal，不影响收下）。saveState 自动上报 run-state 事件。
 */
export function acceptRunValidatorOnly(runId: string): { ok: boolean; error?: string } {
	const st = loadState(runId);
	if (!st) return { ok: false, error: `run 不存在：${runId}` };
	if (!isReviewerErrorRun(st) || st.lastVerdict !== "pass") {
		return { ok: false, error: "只有代码验证已通过、模型评审出错的 run 才能按代码验证收下" };
	}
	if (!acquireRunControl(st)) return { ok: false, error: "无法取得执行权" };
	// 收下的前提：验证证据仍对应当前 round/attempt 的执行内容与验收契约（不能补记未验证版本）。
	if (!evidenceStillValid(st)) return { ok: false, error: "验收证据与当前代码不一致，不能按代码验证收下" };
	const token = tokenOf(st);
	const assertAcceptControl = () => {
		const fresh = loadState(runId);
		const lease = getLease(runDir(runId));
		if (
			!locallyClaimed(runId, token.owner, token.generation) ||
			!fresh ||
			!matchesToken(fresh, token) ||
			fresh.revision !== st.revision ||
			!isReviewerErrorRun(fresh) ||
			!lease ||
			leaseExpired(lease) ||
			lease.owner !== token.owner ||
			lease.generation !== token.generation
		)
			throw new Error("验收期间执行权或任务状态已变化");
	};
	try {
		assertAcceptControl();
		if (st.worktreeDir && st.worktreeBranch && !st.worktreeCommitted) {
			const tree = verifiedTreeFromIdentity(st);
			if (tree) {
				// 提交验收绑定的不可变树并协调真实 index（P2 共享收尾）：
				// 预期旧 SHA 校验 + 冲突预检 + commit-tree/update-ref + index 重写。
				const parent = gitSync(
					["-C", st.worktreeDir, "rev-parse", "--verify", "refs/heads/" + st.worktreeBranch],
					st.worktreeDir,
					60000,
				).trim();
				const result = finalizeVerifiedCommit(
					st.worktreeDir,
					st.worktreeBranch,
					parent,
					tree,
					`mini-harness run ${st.runId}`,
				);
				if (!result.ok) throw new Error(result.error);
			} else {
				// Git 工作区禁止 git add -A 回退提交：无冻结树即明确受阻。
				throw new Error("缺少已验证冻结快照，无法安全收下（git 工作区不提供回退提交）");
			}
			assertAcceptControl();
			st.worktreeCommitted = true;
			journal(st, "worktree-commit", { branch: st.worktreeBranch, dir: st.worktreeDir, by: "user-accept" });
		}
		st.status = "done";
		st.stage = "done";
		st.acceptance = "passed-validator-only";
		delete st.stopReason;
		assertAcceptControl();
		if (!saveState(st, token)) return { ok: false, error: "验收提交冲突" };
		journal(st, "accepted-validator-only", { by: "user" });
		return { ok: true };
	} catch (error) {
		journal(st, "accept-error", { error: String((error as Error).message || error) });
		return { ok: false, error: String((error as Error).message || error) };
	}
}

/**
 * 「重试评审」：把 stopped + reviewer-error 的 run 重新激活到 validate 阶段（epoch+1：
 * 激活前在途 / 迟到的回调全部失效）。validatedRound 清零 → 下一次验收重跑 validator 再评审。
 * 由服务层（resumeLoop）随后提示模型调 loop_validate；模型没调时本回合结束的 agent_end 也会补跑。
 */
export function reactivateForReview(runId: string): { ok: true; st: LoopState } | { ok: false; error: string } {
	const st = loadState(runId);
	if (!st) return { ok: false, error: `run 不存在：${runId}` };
	if (!isReviewerErrorRun(st)) return { ok: false, error: "只有模型评审出错停下的 run 才能重试评审" };
	if (!fingerprintMatches(st.environmentFingerprint, currentFingerprintOf(st, true)))
		return { ok: false, error: "执行内容已变化，不能复用旧验收" };
	if (!acquireRunControl(st)) return { ok: false, error: "无法取得执行权" };
	st.status = "active";
	st.stage = "validate";
	st.reviewStep = undefined;
	delete st.stopReason;
	delete st.stopRequestedAt;
	delete st.stopConfirmedAt;
	st.epoch += 1;
	if (!saveState(st)) return { ok: false, error: "评审重试提交冲突" };
	journal(st, "retry-review", { epoch: st.epoch });
	return { ok: true, st };
}

/** 服务端按 runId 读落盘状态（resume 显式绑定校验用）。 */
export function loadLoopState(runId: string) {
	return loadState(runId);
}

// ---------- 隔夜恢复：先核对，再接续（Task B） ----------

/** 本地进程是否仍存活（0 信号探测；EPERM 视为存活）。 */
function isPidAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** 读取文件尾部片段（最多 max 字符）；文件不存在/读失败返回 ""。 */
function readFileTail(file: string, max: number): string {
	try {
		const s = fs.readFileSync(file, "utf8");
		return s.length > max ? s.slice(s.length - max) : s;
	} catch {
		return "";
	}
}

/** 环境指纹是否仍一致；旧记录无指纹时视为「已变化」→ 需要核对，不盲目复用。 */
function fingerprintMatches(a: EnvironmentFingerprint | null, b: EnvironmentFingerprint): boolean {
	if (!a) return false;
	return (
		a.workspace === b.workspace &&
		a.gitHead === b.gitHead &&
		a.contentHash === b.contentHash &&
		a.packId === b.packId &&
		a.packVersion === b.packVersion &&
		a.inputsHash === b.inputsHash &&
		a.envHash === b.envHash
	);
}

/**
 * 已有验收证据（validationIdentity）是否仍对应当前 round/attempt 的实际执行内容与
 * 验收契约。指纹受阻（读失败/超限）视为不能复用：复用决策不允许「无法证明就没变」。
 */
/**
 * 同步重建当前工作树的 tree 对象（影子 index，不触碰真实 index 与工作树）。
 * 与 captureAttemptIdentity 的冻结口径一致：都只读工作树内容本身。
 */
function syncCurrentTreeSha(cwd: string): string | null {
	let gitDir: string;
	try {
		gitDir = execFileSync("git", ["--no-optional-locks", "-C", cwd, "rev-parse", "--absolute-git-dir"], {
			timeout: 15000,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
	const tmp = path.join(gitDir, `pi-sync-tree-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
	try {
		const env = { GIT_INDEX_FILE: tmp };
		execFileSync("git", ["--no-optional-locks", "-C", cwd, "read-tree", "--empty"], {
			env,
			timeout: 15000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		execFileSync("git", ["--no-optional-locks", "-C", cwd, "add", "-A", "--", "."], {
			env,
			timeout: 15000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return execFileSync("git", ["--no-optional-locks", "-C", cwd, "write-tree"], {
			env,
			timeout: 15000,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

/**
 * 冻结内容一致判定：git 工作区优先比较冻结树与当前工作树重建树（A/B 竞态下，
 * 「指纹匹配 B 但快照是 A」会被树比较识别为漂移）；无冻结树的旧状态回退内容指纹。
 */
function frozenContentMatches(st: LoopState): boolean {
	const identity = st.validationIdentity;
	if (!identity || identity.round !== st.round || identity.attemptId !== st.attemptId) return false;
	// 冻结目录（validator 实际读取的内容）必须未被改写。
	if (identity.frozenHash && identity.frozenDir && frozenDirectoryHash(identity.frozenDir) !== identity.frozenHash) {
		return false;
	}
	// 原工作树仍须与冻结树一致：验证/评审期间模型的新改动进入下一轮重新验证。
	if (identity.treeSha) {
		return syncCurrentTreeSha(st.workspace) === identity.treeSha;
	}
	try {
		return fingerprintMatches(identity.fingerprint, currentFingerprintOf(st, true));
	} catch {
		return false;
	}
}

function evidenceStillValid(st: LoopState): boolean {
	return frozenContentMatches(st);
}

/** 从 run 状态构建当前环境指纹（恢复/展示共用，避免三处字段映射漂移）。fresh 用于恢复核对绕过缓存。 */
function currentFingerprintOf(st: LoopState, fresh = false): EnvironmentFingerprint {
	return computeExecutionFingerprint({
		...st,
		workspace: st.workspace,
		packId: st.packId ?? null,
		packVersion: st.packVersion ?? null,
		goal: st.goal,
		criteria: st.criteria ?? "",
		validateCmd: st.validateCmd,
		precheckCmd: st.precheckCmd ?? null,
		primaryMetric: st.primaryMetric ?? null,
		metricDirection: st.metricDirection ?? null,
		metricUnit: st.metricUnit ?? null,
		metricThreshold: st.metricThreshold ?? null,
		metricThresholdOp: st.metricThresholdOp ?? null,
		metricTolerance: st.metricTolerance ?? null,
		metricScenario: st.metricScenario ?? null,
		hardConstraints: st.hardConstraints ?? null,
		freshWorkspace: fresh,
	});
}

export interface RecoverRunResult {
	ok: boolean;
	runId: string;
	classification: ReturnType<typeof classifyRecovery> | null;
	summary: string | null;
	/** 本次调用是否真正接管了执行所有权（只有失联/过期、分类允许重试、且无人持权时）。 */
	takeover: boolean;
	/** 是否已连接/确认实际执行实体（本地 taskPid 存活，或远端 jobId 仍在）。 */
	connectedEntity: boolean;
	/** 是否允许继续执行（resumeLoop 可据此投递续跑提示词）。 */
	resumeEligible: boolean;
	/** 不能继续时的阻塞原因。 */
	blockedReason: string | null;
	/** 下一步建议动作（供 UI / 模型使用）。 */
	nextAction: string;
	/** 仍在运行的本地执行实体 operation id（供 observeRunOperation 接续收集退出码/输出）。 */
	inFlightOpId: string | null;
	error?: string;
}

/**
 * 恢复入口：载入持久化记录 → 核对租约/环境/本地进程 → 分类执行单元 → 需要时原子接管所有权。
 *  - 仍持权：重新跟踪，不启动第二份；
 *  - 明确失败、允许重试且失联：接管（generation+1、新 attemptId）；
 *  - 环境/代码变化 或 结果未知：不接管、不盲目重放副作用（保持受阻，先核对证据）；
 *  - 已取消（stopped）：不自动复活。
 * requesterOwner 可显式传入（测试/多实例场景）；缺省用当前进程 owner。
 */
export function loadLoopStateForRecovery(runId: string): LoopState | null {
	if (!RUN_ID_RE.test(runId) || !fs.existsSync(runDir(runId))) return null;
	const migrated = withRunLockSync(runDir(runId), () => true);
	if (!migrated.ok) throw new Error(migrated.error);
	return loadState(runId);
}

/**
 * 启动专用迁移：把只剩 .cas 残留、缺少 state.json 的旧任务目录恢复为可见记录。
 * 只处理有效 run ID 的目录；最多 1000 条、总预算 5 秒、每次锁等待 500ms；
 * 冲突/损坏保留原件并返回错误，不做猜测合并。列表轮询不触发本函数。
 */
export function migrateMissingLoopStates(): Array<{ runId: string; error?: string }> {
	const out: Array<{ runId: string; error?: string }> = [];
	if (!fs.existsSync(ROOT)) return out;
	let directory: fs.Dir;
	try {
		directory = fs.opendirSync(ROOT);
	} catch {
		return out;
	}
	const deadline = performance.now() + 5000;
	let visited = 0;
	try {
		for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
			if (++visited > 1000 || performance.now() > deadline) break;
			if (!entry.isDirectory() || !RUN_ID_RE.test(entry.name)) continue;
			if (fs.existsSync(statePath(entry.name))) continue;
			try {
				const migrated = withRunLockSync(runDir(entry.name), () => true, { timeoutMs: 500 });
				if (!migrated.ok) throw new Error(migrated.error);
			} catch (error) {
				out.push({ runId: entry.name, error: String((error as Error).message || error) });
			}
		}
	} finally {
		directory.closeSync();
	}
	return out;
}

export function recoverRun(runId: string, requesterOwner?: string): RecoverRunResult {
	// Migration is an explicit write action; list/detail/load remain read-only.
	if (RUN_ID_RE.test(runId) && fs.existsSync(runDir(runId))) {
		const migrated = withRunLockSync(runDir(runId), () => true);
		if (!migrated.ok)
			return {
				ok: false,
				runId,
				classification: null,
				summary: null,
				takeover: false,
				connectedEntity: false,
				resumeEligible: false,
				blockedReason: migrated.error,
				nextAction: "核对存储迁移",
				inFlightOpId: null,
				error: migrated.error,
			};
	}
	const st = loadState(runId);
	if (!st) {
		return {
			ok: false,
			runId,
			classification: null,
			summary: null,
			takeover: false,
			connectedEntity: false,
			resumeEligible: false,
			blockedReason: "run 不存在",
			nextAction: "确认 runId 是否正确",
			inFlightOpId: null,
			error: "run 不存在：" + runId,
		};
	}
	const dir = runDir(runId);
	if (st.stopRequestedAt && !st.stopConfirmedAt) {
		const stopped = stopRunExternal(runId, st.stopReason);
		return {
			ok: stopped.ok,
			runId,
			classification: null,
			summary: null,
			takeover: false,
			connectedEntity: false,
			resumeEligible: false,
			blockedReason: stopped.error ?? "停止请求待核对，不恢复工作",
			nextAction: "核对停止确认",
			inFlightOpId: null,
		};
	}
	const me = requesterOwner || newOwner();
	const lease = getLease(dir);
	const leaseOwnerAlive = lease != null && lease.pid != null ? isPidAlive(lease.pid) : false;
	const leaseHeld =
		lease != null && !leaseExpired(lease) && lease.owner === me && locallyClaimed(runId, me, lease.generation);
	// 他人仍持有有效执行权 = 租约未过期 + owner 不同 + 且该 owner 的服务进程仍存活。
	// 服务已退出（孤儿租约）不算「他人持权」，可立即接管 —— 这是「服务可重启」支持范围的一部分。
	const leaseHeldByOther = lease != null && !leaseExpired(lease) && lease.owner !== me && leaseOwnerAlive;
	let currentFp: EnvironmentFingerprint;
	try {
		currentFp = currentFingerprintOf(st, true);
	} catch (error) {
		return {
			ok: false,
			runId,
			classification: null,
			summary: null,
			takeover: false,
			connectedEntity: false,
			resumeEligible: false,
			blockedReason: String((error as Error).message),
			nextAction: "核对执行指纹",
			inFlightOpId: null,
		};
	}
	const environmentChanged = !fingerprintMatches(st.environmentFingerprint, currentFp);
	// 在途 = 新协议持久化操作（validator/precheck 已启动但尚未落定）。仅含旧 taskPid 而没有
	// 对应 operation 的 run 是历史实体证据：不作为在途（不阻止接管），接管后由 stop 侧保持未确认。
	const pending = pendingUnconsumedOp(st);
	const inFlight = !!pending;
	const cls = classifyRecovery(st, {
		leaseHeld,
		environmentChanged,
		pidAlive: pending ? pending.status === "running" : null,
		hasUnconsumedResult: !!pending?.result || st.validatedRound === st.round,
		// 只认当前 round/attempt 的验收结论；上一轮 lastVerdict 仅保留作历史与诊断。
		lastRoundPassed: st.validatedRound === st.round && st.lastVerdict === "pass",
		inFlight,
	});
	const connectedEntity = !!pending?.entity && pending.status === "running";
	// 接续收集：找出仍在运行的持久化操作（Prompt 修复④：不只分类，还收集输出 + 暴露 opId 供观察退出码）。
	const latestRunning = pending;
	let inFlightNote: string | null = null;
	let inFlightOpId: string | null = null;
	if (latestRunning) {
		inFlightOpId = latestRunning.opId;
		const so = readFileTail(latestRunning.stdoutFile, 2000);
		const se = readFileTail(latestRunning.stderrFile, 1000);
		inFlightNote =
			"仍在运行的本地执行实体: " +
			latestRunning.stage +
			" (round " +
			latestRunning.round +
			") pid=" +
			latestRunning.pid +
			"\n--- 已收集 stdout 片段 ---\n" +
			so +
			"\n--- 已收集 stderr 片段 ---\n" +
			se;
	}
	let takeover = false;
	let blockedReason: string | null = null;
	if (lease?.remoteJobId || st.remoteJobId) {
		return {
			ok: true,
			runId,
			classification: cls,
			summary: null,
			takeover: false,
			connectedEntity: false,
			resumeEligible: false,
			blockedReason: "缺少远端任务执行适配器，无法核验或接续",
			nextAction: "核对远端原任务",
			inFlightOpId: null,
		};
	}
	// 只有「明确失败、允许重试」或「在途本地执行实体仍在运行」才允许接管；
	// unknown / cancelled / completed-valid / 环境变化一律不接管。
	// 「在途仍在跑」接管 = 原子取得执行所有权（generation+1），但不重跑：resumeLoop 会 observeRunOperation 接续收集。
	if (
		st.status === "active" &&
		!environmentChanged &&
		!leaseHeld &&
		!leaseHeldByOther &&
		(cls.unit === "failed-retryable" ||
			(cls.unit === "running" && (inFlightOpId != null || st.validatedRound === st.round)))
	) {
		const got = acquireRunControl(st, me);
		if (got) {
			takeover = true;
			// 捕获接管前的执行身份：CAS 写 state 时要求磁盘仍是旧身份（旧 owner/gen/epoch），
			// 防止旧 owner 的迟到回调在「接管 lease 之后、写 state 之前」这个窗口里抢先写回旧状态。
			st.recoveryState = cls.unit;
			if (!saveState(st)) throw new Error("恢复状态提交冲突");
			startLeaseHeartbeat(runId, me, st.generation);
			journal(st, "recovery-takeover", { owner: me, generation: st.generation, classification: cls.unit });
			// 旧执行实体身份未核实前阻断「续跑投递」，但允许「观察在运行 operation」：
			// running + inFlightOpId 时放行观察（observe 消费结果），投递新轮仍由
			// canResumeLoopDelivery 阻断（结果消费后的后续调度过同一门禁）。
			const unverified = unverifiedLegacyEntities(st);
			if (unverified.length > 0) {
				const canObserve = cls.unit === "running" && inFlightOpId != null;
				if (!canObserve) {
					blockedReason =
						"存在未核实的旧执行实体（pid: " + unverified.map((e) => e.pid).join(", ") + "），先核对现场再续跑";
				}
			}
		} else {
			blockedReason = "接管失败：并发竞争者已取得执行所有权";
		}
	} else if (st.status === "active" && (cls.needRecheck || cls.unit === "unknown" || environmentChanged)) {
		blockedReason = "环境/代码已变化或结果未知，需先核对证据，不盲目重试";
	} else if (leaseHeldByOther && st.status === "active") {
		// 他人仍持有有效执行权：不接管，不覆盖。
		blockedReason = "其他执行者仍持有有效执行权";
	}
	const resumeEligible = !blockedReason && st.status === "active" && (leaseHeld || takeover);
	const completedRounds = st.history.filter(
		(h) => h.verdict === "pass" && h.metricGateOk !== false && !h.workspaceChangedDuringValidation,
	).length;
	const summary = buildRecoverySummary({
		runId,
		attemptId: st.attemptId,
		generation: st.generation ?? 0,
		cls,
		completedRounds,
		bestRound: st.bestRound?.round ?? null,
		blockedOn: blockedReason,
		inFlightNote,
	});
	let nextAction: string;
	if (cls.unit === "cancelled") nextAction = "保持取消，不自动执行";
	else if (cls.unit === "completed-valid") nextAction = "证据仍有效，复用结果，不重跑";
	else if (leaseHeld) nextAction = "仍持有执行权，重新跟踪，不启动第二份";
	else if (takeover && cls.unit === "running") nextAction = "已原子接管，观察在运行实体并收集结果，不重跑";
	else if (takeover) nextAction = "已原子接管，从未完成部分继续";
	else if (blockedReason) nextAction = "先核对执行现场/证据，再决定是否重试";
	else nextAction = "先核对执行现场/证据，再决定";
	return {
		ok: true,
		runId,
		classification: cls,
		summary,
		takeover,
		connectedEntity,
		resumeEligible,
		blockedReason,
		nextAction,
		inFlightOpId,
	};
}

/**
 * 接续观察一个持久化操作（服务重启后调用）：等待仍在运行的本地执行实体退出，
 * 收集退出码与输出。用于「分类=running」时真正拿到最终结果，而不是只给一个分类标签。
 */
/** 当前 round/attempt 尚未消费的持久化 operation（恢复观察与接续投递共用同一选择规则）。 */
export function pendingUnconsumedOp(st: LoopState): OpRecord | null {
	return (
		listOperations(st.runId).find(
			(op) => op.round === st.round && op.attemptId === st.attemptId && !st.consumedResults?.[op.opId],
		) ?? null
	);
}

export async function observeRunOperation(runId: string, timeoutMs = 30 * 60 * 1000) {
	const st = loadState(runId);
	if (!st) return null;
	const token = tokenOf(st);
	if (!stillCurrent(token)) return null;
	const pending = pendingUnconsumedOp(st);
	if (!pending) return null;
	const observed = await observeOperation(runId, pending.opId, { timeoutMs });
	if (!stillCurrent(token) || !observed.record?.result) return observed;
	const v = await validationFromOperation(st, pending.opId);
	if (!stillCurrent(token)) return observed;
	if (pending.stage === "precheck" && v.pass && !v.workspaceChangedDuringValidation) {
		const fresh = loadState(runId)!;
		fresh.consumedResults = {
			...fresh.consumedResults,
			[pending.opId]: { digest: v.resultDigest!, round: st.round, stage: "precheck" },
		};
		if (!saveState(fresh, token)) throw new Error("恢复预检结果提交冲突");
	} else {
		// false also means another callback already applied this exact result.
		// Storage failures throw; duplicate observation is a successful no-op.
		await recordValidationOutcome(st, v, token);
	}
	return observed;
}

/**
 * 未核实的旧执行实体：接管保留的 legacyExecutionEntities 中仍然存活、且没有
 * 对应持久 operation 的条目。身份未核实时不向这些 pid 发信号，也阻断续跑投递。
 */
function unverifiedLegacyEntities(st: LoopState): Array<{ pid: number }> {
	const ops = listOperations(st.runId);
	// 逐实体判定：只有 PID、宿主与进程启动身份都与既有 operation 证据一致时才算核实；
	// 同 PID/PID 复用/缺身份都不能单独解除门禁。有可信退出证据的匹配实体也不阻断。
	const matchesOp = (e: { pid: number; host?: string | null; startId?: string | null }) =>
		ops.find((op) => {
			if (op.pid !== e.pid) return false;
			if (e.host && op.entity?.host && op.entity.host !== e.host) return false;
			if (e.startId && op.entity?.startId && op.entity.startId !== e.startId) return false;
			// 必须有可信退出证据（result 已发布）才算核实；仍在运行 = 未核实。
			return !!op.result;
		});
	return (st.legacyExecutionEntities ?? [])
		.filter((e) => e.pid != null && isPidAlive(e.pid) && !matchesOp(e))
		.map((e) => ({ pid: e.pid }));
}

/** 服务投递入口门禁：执行权有效且不存在未核实旧实体时才能实际投递续跑提示词。 */
export function canResumeLoopDelivery(st: LoopState): boolean {
	if (!canContinueLoop(st)) return false;
	return unverifiedLegacyEntities(st).length === 0;
}

/** 任务台只读恢复信息（不接管、不写盘）：unit / 租约 / 环境变化 / attempt。 */
export function recoveryInfoOf(runId: string) {
	const st = loadState(runId);
	if (!st) return null;
	const lease = getLease(runDir(runId));
	const leaseHeld =
		lease != null &&
		lease.pid != null &&
		!leaseExpired(lease) &&
		isPidAlive(lease.pid) &&
		lease.owner === (st.owner ?? newOwner());
	// Polling is a projection. Only explicit recover/recheck hashes execution bytes.
	const environmentChanged = st.recoveryState === "needs-review";
	const unit =
		st.status === "active"
			? leaseHeld
				? "running"
				: environmentChanged
					? "needs-review"
					: "interrupted"
			: st.status === "stopped"
				? "cancelled"
				: st.status;
	return {
		unit,
		leaseHeld,
		environmentChanged,
		attemptId: st.attemptId,
		generation: st.generation ?? 0,
		owner: st.owner,
		remoteJobId: st.remoteJobId,
	};
}
