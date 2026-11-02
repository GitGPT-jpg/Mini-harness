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

const DEFAULT_MAX_ROUNDS = 5;
const CUSTOM_TYPE = "mini-harness-loop";
const ROOT = process.env.MINI_HARNESS_RUNTIME_ROOT || path.join(os.homedir(), ".mini-harness", "runs");
const ACTIVE_STAGES = new Set(["intake", "plan", "run", "validate"]);
const RUN_ID_RE = /^[0-9]{8,}-[a-z0-9]{4,}$/i;

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

/**
 * 标记「本地执行已确认停止」：validator 子进程组因停止被 kill 后退场时调用。
 * 只更新 stop 相关字段，绝不把终态 run 复活（不碰 status/stage/epoch）。
 */
function markRunStopConfirmed(runId: string): void {
	try {
		const fresh = loadState(runId);
		if (!fresh || fresh.status !== "stopped") return;
		if (!fresh.stopRequestedAt || fresh.stopConfirmedAt) return;
		fresh.stopConfirmedAt = now();
		saveState(fresh);
		journal(fresh, "stop-confirmed", { runId });
	} catch {}
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
const eventReporters = new Set<((e: LoopEvent) => void)>();

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
	} catch {
		return null;
	}
}

/** 旧 state.json（D-12 之前）没有 acceptance / useReviewer：前者按 null，后者按「有没有评审模型」推断。 */
function normalizeState(st: LoopState): LoopState {
	if (st.acceptance === undefined) st.acceptance = null;
	if (typeof st.useReviewer !== "boolean") st.useReviewer = !!st.reviewerModel;
	return st;
}

function saveState(st: LoopState) {
	st.updatedAt = now();
	fs.mkdirSync(runDir(st.runId), { recursive: true });
	fs.writeFileSync(statePath(st.runId), JSON.stringify(st, null, 2));
	reportEvent({ type: "run-state", st });
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

/** 全部运行（读 state.json；任务台 / 运行状态接口也用它）。 */
export function listRuns(): LoopState[] {
	try {
		return fs
			.readdirSync(ROOT)
			.map((n) => loadState(n))
			.filter((s): s is LoopState => !!s);
	} catch {
		return [];
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

function resolveValidator(st: LoopState) {
	if (st.validateCmd) {
		return { cmd: "bash", args: ["-lc", st.validateCmd], label: st.validateCmd };
	}
	const candidates: string[] = [];
	if (st.workspace) candidates.push(path.join(st.workspace, "validate.py"));
	if (st.harnessRoot) candidates.push(path.join(st.harnessRoot, "validate.py"));
	if (process.env.HARNESS_ROOT) candidates.push(path.join(process.env.HARNESS_ROOT, "validate.py"));
	for (const p of candidates) {
		if (fs.existsSync(p)) return { cmd: "python3", args: [p], label: p };
	}
	return null;
}

async function runValidation(pi: ExtensionAPI, st: LoopState): Promise<ValidationResult> {
	const cwd = st.workspace || process.cwd();
	const ac = registerRunAbort(st.runId);
	const epoch = st.epoch;
	try {
		// 验收前绑定代码身份（Task 3）：先快照 candidate-A（真正被 validator 读取的代码）。
		const preId = await captureAttemptIdentity(st, epoch);
		const preCmd = String(st.precheckCmd ?? "").trim();

		// L0 快速预检：若配置了 precheckCmd，先秒级拦截语法/导包/配置错误，不浪费集群与压测资源
		if (preCmd) {
			let pre: { stdout?: string; stderr?: string; code?: number | null; killed?: boolean };
			try {
				pre = await pi.exec("bash", ["-lc", preCmd], { cwd, timeout: 5 * 60 * 1000, signal: ac.signal });
			} catch (e) {
				pre = { stdout: "", stderr: String((e as Error)?.message || e), code: -1, killed: false };
			}
			if (pre.killed) {
				markRunStopConfirmed(st.runId);
				return { pass: false, noValidator: false, precheckFailed: false, cancelled: true, code: null, evidence: null, output: "运行已停止：L0 预检进程已被取消。", metrics: null, scenario: null, snapshotRef: preId.snapshotRef, snapshotSha: preId.snapshotSha, recoverable: preId.recoverable, workspaceChangedDuringValidation: false };
			}
			if (pre.code !== 0) {
				const output =
					"[L0 precheck] $ " + preCmd + "\n" +
					"exit=" + pre.code + (pre.killed ? " (killed/timeout)" : "") + "（快速预检未通过，已跳过 L1 完整验收）\n" +
					"--- stdout (tail) ---\n" + tail(pre.stdout, 4000) + "\n" +
					"--- stderr (tail) ---\n" + tail(pre.stderr, 4000) + "\n";
				let evidence = "";
				try {
					const dir = path.join(runDir(st.runId), "evidence");
					fs.mkdirSync(dir, { recursive: true });
					evidence = path.join(dir, "round-" + st.round + "-" + Date.now() + ".log");
					fs.writeFileSync(evidence, output);
				} catch {}
				return { pass: false, noValidator: false, precheckFailed: true, code: pre.code ?? -1, evidence, output, metrics: null, scenario: null, snapshotRef: preId.snapshotRef, snapshotSha: preId.snapshotSha, recoverable: preId.recoverable, workspaceChangedDuringValidation: false };
			}
			// 停止/取消守卫：L0 预检期间若被停止（epoch 已递增），绝不再启动昂贵的 L1 完整验收。
			if (!stillCurrent(st.runId, epoch)) {
				return { pass: false, noValidator: false, precheckFailed: false, cancelled: true, code: null, evidence: null, output: "运行已停止：L0 预检期间收到停止，已跳过 L1 完整验收。", metrics: null, scenario: null, snapshotRef: preId.snapshotRef, snapshotSha: preId.snapshotSha, recoverable: preId.recoverable, workspaceChangedDuringValidation: false };
			}
		}

		const r = resolveValidator(st);
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
		let res: { stdout?: string; stderr?: string; code?: number | null; killed?: boolean };
		try {
			res = await pi.exec(r.cmd, r.args, { cwd, timeout: 30 * 60 * 1000, signal: ac.signal });
		} catch (e) {
			res = { stdout: "", stderr: String((e as Error)?.message || e), code: -1, killed: false };
		}
		if (res.killed) {
			markRunStopConfirmed(st.runId);
			return { pass: false, noValidator: false, precheckFailed: false, cancelled: true, code: res.code ?? null, evidence: null, output: "运行已停止：L1 validator 进程已被取消。", metrics: null, scenario: null, snapshotRef: preId.snapshotRef, snapshotSha: preId.snapshotSha, recoverable: preId.recoverable, workspaceChangedDuringValidation: false };
		}

		// 验收后校验代码指纹（Task 3）：工作区是否在验收期间发生变化。
		const postSha = await createWorkspaceSnapshot(st.workspace).catch(() => null);
		const unchanged = preId.recoverable && postSha != null && postSha === preId.snapshotSha;
		const workspaceChangedDuringValidation = preId.recoverable && !unchanged;

		const combined = (res.stdout ?? "") + "\n" + (res.stderr ?? "");
		const metrics = parseHarnessMetrics(combined);
		const scenario = parseHarnessScenario(combined);
		const output =
			(preCmd ? "[L0 precheck] $ " + preCmd + " -> PASS\n" : "") +
			"$ " + r.label + "\n" +
			"exit=" + res.code + (res.killed ? " (killed/timeout)" : "") + "\n" +
			"--- stdout (tail) ---\n" + tail(res.stdout, 6000) + "\n" +
			"--- stderr (tail) ---\n" + tail(res.stderr, 4000) + "\n";
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
	recoverable: boolean;
}

async function captureAttemptIdentity(st: LoopState, epoch: number): Promise<AttemptIdentity> {
	try {
		if (!stillCurrent(st.runId, epoch)) return { snapshotRef: null, snapshotSha: null, recoverable: false };
		const sha = await createWorkspaceSnapshot(st.workspace);
		if (!sha) return { snapshotRef: null, snapshotSha: null, recoverable: false };
		// createWorkspaceSnapshot is async. A stop/delete can win while it is producing the commit;
		// never pin a checkpoint ref for a run that is no longer current.
		if (!stillCurrent(st.runId, epoch)) return { snapshotRef: null, snapshotSha: null, recoverable: false };
		const ref = "refs/mini-harness/checkpoints/" + st.runId + "-r" + st.round;
		gitSync(["-C", st.workspace, "update-ref", ref, sha], st.workspace, 15000);
		return { snapshotRef: ref, snapshotSha: sha, recoverable: true };
	} catch {
		return { snapshotRef: null, snapshotSha: null, recoverable: false };
	}
}

async function recordValidationOutcome(
	st: LoopState,
	v: {
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
	epoch: number,
): Promise<boolean> {
	const at = now();
	const verdict = v.pass ? "pass" : "fail";
	const commitSha = resolveGitHeadSha(st.workspace || process.cwd());
	if (!stillCurrent(st.runId, epoch)) {
		journal(st, "late-callback-dropped", { at: "recordValidationOutcome", epoch });
		return false;
	}
	const snapshotRef = v.snapshotRef ?? null;
	const recoverable = v.recoverable === true;
	const workspaceChanged = v.workspaceChangedDuringValidation === true;
	const target = metricTargetOf(st);
	const gate = evaluateMetricGate(target, st.hardConstraints, v.metrics, v.scenario ?? null);
	st.validatedRound = st.round;
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
	// 可信轮：命令结果可信（验收期间工作区未变）且指标门禁通过，才允许更新最优 Checkpoint。
	const trusted = !workspaceChanged && gate.ok;
	if (trusted) {
		st.bestRound = pickBetterRound(
			st.bestRound,
			{
				round: st.round,
				verdict,
				commitSha,
				...(snapshotRef ? { snapshotRef } : {}),
				...(v.metrics ? { metrics: v.metrics } : {}),
				at,
			},
			target,
		);
	}
	return true;
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

async function collectDiff(pi: ExtensionAPI, st: LoopState) {
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
		const res = await pi.exec("bash", ["-lc", script], { cwd: st.workspace, timeout: 30000 });
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
	if (!st.reviewerModel || st.useReviewer === false) {
		return { verdict: "skip", reasons: [] as string[], diff: "" };
	}
	const model = st.reviewerModel.provider
		? ctx.modelRegistry?.find(st.reviewerModel.provider, st.reviewerModel.id) || null
		: null;
	if (!model) {
		return { verdict: "error", reasons: ["reviewer model unavailable"], diff: "" };
	}
	const diff = await collectDiff(pi, st);
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
 * 【修复②】await 前记录代次，await 后核对：停止过的 run 不再被迟到回调推进。
 * 必须重读磁盘：stop 走的是另一次 loadState（不同对象引用），内存里的 st
 * 不会随之更新——只比内存对象会误判「仍然有效」，把 stopped 覆盖成 done。
 */
function stillCurrent(runId: string, epoch: number) {
	const fresh = loadState(runId);
	return !!fresh && fresh.status === "active" && fresh.epoch === epoch;
}

/** 完成后的收尾（提交 worktree）只核代次：此时 status 已是 done，不能再要求 active。 */
function sameEpoch(runId: string, epoch: number) {
	const fresh = loadState(runId);
	return !!fresh && fresh.epoch === epoch;
}

function advanceOrStop(
	pi: ExtensionAPI,
	st: LoopState,
	v: { code?: number | null; output?: string } | null,
	feedback: string,
	event: string,
) {
	writeRoundReview(st, v, null, "");
	if (st.round < st.maxRounds) {
		const failedRound = st.round;
		st.round += 1;
		st.stage = "run";
		st.validatedRound = 0;
		saveState(st);
		journal(st, event, { code: v?.code ?? null, failedRound, nextRound: st.round });
		pi.sendUserMessage(nextRoundPrompt(st, v, feedback), { deliverAs: "followUp" });
	} else {
		st.stage = "stopped";
		st.status = "stopped";
		st.stopReason = event;
		st.epoch += 1;
		saveState(st);
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

/** 代码 loop 判定：validator 是硬门禁，reviewer 是否决层。 */
async function handleVerdict(
	pi: ExtensionAPI,
	ctx: LoopCtx,
	st: LoopState,
	v: { pass: boolean; noValidator?: boolean; code: number | null; output: string; workspaceChangedDuringValidation?: boolean },
) {
	// Task 3：验收期间工作区发生变化 → 本轮结果不可信，不得判通过 / 不得选为最优 Checkpoint。
	if (v.workspaceChangedDuringValidation) {
		advanceOrStop(
			pi,
			st,
			v,
			"工作区在验收期间发生变化，本轮验证结果不可信；请先停止并发改动，再基于稳定代码重新 loop_done。",
			"workspace-changed-during-validation",
		);
		return;
	}
	// Task 2：命令成功（exit 0）不等于指标达标。主指标缺失 / 数值非法 / 阈值或硬约束不满足 → 不判完成。
	if (v.pass && st.lastMetricGate && !st.lastMetricGate.ok) {
		advanceOrStop(
			pi,
			st,
			v,
			"指标门禁未通过：\n" + (st.lastMetricGate.reasons || []).join("\n"),
			"metric-gate",
		);
		return;
	}
	if (v.pass) {
		const epoch = st.epoch;
		const review = await runReview(ctx, st, v, pi);
		if (!stillCurrent(st.runId, epoch)) {
			journal(st, "late-callback-dropped", { at: "handleVerdict/review", epoch });
			return;
		}
		st.lastReview = review;
		st.lastDiff = review.diff || "";
		saveState(st);
		journal(st, "review", { verdict: review.verdict, reasons: review.reasons });
		writeRoundReview(st, v, review, review.diff);
		if (review.verdict === "block") {
			notify(ctx, `⚠️ mini-harness：validator 通过，但 reviewer 否决（第 ${st.round} 轮）。`, "warning");
			advanceOrStop(pi, st, v, `reviewer 否决：\n${review.reasons.join("\n")}`, "reviewer-block");
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
			saveState(st);
			journal(st, "reviewer-error", { mode: "code", code: v.code, reasons: review.reasons, epoch: st.epoch });
			notify(
				ctx,
				`⚠️ mini-harness：第 ${st.round} 轮代码验证已通过，但模型评审出错，未判定完成；` +
					`可重试评审或按代码验证收下。${(review.reasons || []).join("; ")}`,
				"warning",
			);
			return;
		}
		// pass = 代码验证 + 模型评审都过；skip = 没开评审 / 没有可用评审模型，只有代码验证
		st.stage = "done";
		st.status = "done";
		st.acceptance = review.verdict === "pass" ? "passed" : "passed-validator-only";
		saveState(st);
		journal(st, "validate-pass", { code: v.code, review: review.verdict, acceptance: st.acceptance });
		if (st.worktreeDir && st.worktreeBranch && !st.worktreeCommitted) {
			try {
				await pi.exec("git", ["-C", st.worktreeDir, "add", "-A"], { cwd: st.worktreeDir, timeout: 60000 });
				const d = await pi.exec("git", ["-C", st.worktreeDir, "diff", "--cached", "--quiet"], {
					cwd: st.worktreeDir,
					timeout: 60000,
				});
				if (d.code !== 0) {
					await pi.exec("git", ["-C", st.worktreeDir, "commit", "-m", `mini-harness run ${st.runId}`], {
						cwd: st.worktreeDir,
						timeout: 60000,
					});
				}
				if (!sameEpoch(st.runId, epoch)) {
					journal(st, "late-callback-dropped", { at: "handleVerdict/worktree", epoch });
					return;
				}
				st.worktreeCommitted = true;
				saveState(st);
				journal(st, "worktree-commit", { branch: st.worktreeBranch, dir: st.worktreeDir });
			} catch (e) {
				journal(st, "worktree-commit-error", { error: String((e as Error)?.message || e) });
			}
		}
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
		saveState(st);
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
	const epoch = st.epoch;
	const review = await runReview(ctx, st, syntheticV, pi);
	if (!stillCurrent(st.runId, epoch)) {
		journal(st, "late-callback-dropped", { at: "handleLlmVerdict/review", epoch });
		return;
	}
	st.lastReview = review;
	st.lastDiff = review.diff || "";
	st.lastVerdict = review.verdict === "pass" ? "pass" : review.verdict === "block" ? "fail" : review.verdict;
	st.lastCode = null;
	saveState(st);
	journal(st, "llm-review", { verdict: review.verdict, reasons: review.reasons });
	writeRoundReview(st, syntheticV, review, review.diff);
	if (review.verdict === "pass") {
		st.stage = "done";
		st.status = "done";
		st.acceptance = "passed";
		saveState(st);
		journal(st, "validate-pass", { mode: "llm", review: review.verdict, acceptance: st.acceptance });
		notify(ctx, "✅ mini-harness（LLM loop）：reviewer 判定达成。", "info");
	} else if (review.verdict === "block") {
		if (st.round < st.maxRounds) {
			const failedRound = st.round;
			st.round += 1;
			st.stage = "run";
			st.validatedRound = 0;
			saveState(st);
			journal(st, "llm-block", { reasons: review.reasons, failedRound, nextRound: st.round });
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
			saveState(st);
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
		saveState(st);
		journal(st, "llm-self-declared", {});
		notify(ctx, "✅ mini-harness（LLM loop）：reviewer 已关闭，按模型自述完成（self-declared）。", "info");
	} else {
		// reviewer 故障，且无 validator 可降级 → 停止（不做无判定完成）
		st.stage = "stopped";
		st.status = "stopped";
		st.stopReason = "reviewer-error";
		st.epoch += 1;
		saveState(st);
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
	const goal = String(input.goal ?? "").trim();
	if (!goal) return { ok: false, error: "goal 不能为空" };
	const sessionId = String(input.sessionId ?? "").trim();
	if (!sessionId) return { ok: false, error: "缺少 sessionId，run 无法绑定会话" };
	const existing = activeRunOf(sessionId);
	if (existing) return { ok: false, error: `当前会话已有运行中的任务 ${existing.runId}` };

	const runId = newRunId();
	const maxRounds = Math.max(1, Math.min(20, Number(input.maxRounds) || DEFAULT_MAX_ROUNDS));
	const baseWorkspace = real(input.cwd || process.cwd());
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
		precheckCmd: String(input.precheckCmd ?? "").trim() || null,
		validateCmd: String(input.validateCmd ?? "").trim() || null,
		primaryMetric: String(input.primaryMetric ?? "").trim() || null,
		metricDirection: input.metricDirection === "minimize" ? "minimize" : input.metricDirection === "maximize" ? "maximize" : null,
		metricPrecision: input.metricPrecision != null && Number.isFinite(Number(input.metricPrecision)) ? Number(input.metricPrecision) : null,
		metricUnit: String(input.metricUnit ?? "").trim() || null,
		metricThreshold: input.metricThreshold != null && Number.isFinite(Number(input.metricThreshold)) ? Number(input.metricThreshold) : null,
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
	saveState(st);
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
	saveState(st);
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
	saveState(st);
	journal(st, "setup", { main: st.mainModel, planner: st.plannerModel, reviewer: st.reviewerModel });

	let plannerNote = "";
	if (models.planner) {
		const epoch = st.epoch;
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
		if (!stillCurrent(st.runId, epoch)) {
			journal(st, "late-callback-dropped", { at: "setupRun/planner", epoch });
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
	saveState(st);
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
					metricDirection: params.metricDirection === "minimize" || params.metricDirection === "maximize" ? params.metricDirection : undefined,
					metricPrecision: params.metricPrecision,
					metricUnit: params.metricUnit,
					metricThreshold: params.metricThreshold,
					metricThresholdOp: isThresholdOp(params.metricThresholdOp) ? params.metricThresholdOp : undefined,
					metricTolerance: params.metricTolerance,
					metricScenario: params.metricScenario,
					hardConstraints: sanitizeHardConstraints(params.hardConstraints) ?? undefined,
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
				st.plan = String(params.plan || "").trim();
				st.stage = "run";
				saveState(st);
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
				st.stage = "validate";
				saveState(st);
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
				const epoch = st.epoch;
				const v = await runValidation(pi, st);
				// 停止/取消守卫：手动验收期间被停止（epoch 已递增）时，不得把旧状态写回 active，
				// 也不得继续跑 reviewer 或推进下一轮（回归：停止后手动验收的迟到结果复活任务）。
				if (v.cancelled || !stillCurrent(st.runId, epoch)) {
					journal(st, "late-callback-dropped", { at: "loop_validate", epoch });
					return {
						content: [{ type: "text", text: "运行已停止，本次手动验证结果已丢弃，不再推进。" }],
						details: { runId: st.runId, cancelled: true },
					};
				}
				if (!(await recordValidationOutcome(st, v, epoch))) {
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
					saveState(st);
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
				st.status = "stopped";
				st.stage = "stopped";
				st.stopReason = String(params.reason || "") || "user-stop";
				st.epoch += 1; // 【修复②】递增代次：在途/迟到的异步回调全部失效
				st.stopRequestedAt = now();
				saveState(st);
				journal(st, "stop", { reason: st.stopReason, epoch: st.epoch });
				abortRun(st.runId); // Task 1：真正取消在途 validator / precheck 子进程组
				return {
					content: [{ type: "text", text: "已停止运行 " + st.runId + "（epoch=" + st.epoch + "）。" }],
					details: { runId: st.runId, status: st.status, epoch: st.epoch },
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
			// D-12-2：服务端建的 run 在第一次开跑前做模型准备（家族解析 + 规划，原 loop_start 的逻辑）
			if (st.setupPending && !setupBusy.has(st.runId)) {
				const runId = st.runId;
				setupBusy.add(runId);
				let setup: Awaited<ReturnType<typeof setupRun>>;
				try {
					setup = await setupRun(c, st);
				} catch (e) {
					// 意外异常（落盘失败等）也要可见：按 setup-error 收尾，不让模型在没有 run 的情况下开工
					const msg = String((e as Error)?.message || e);
					const fresh = loadState(runId);
					if (fresh && fresh.status === "active") failSetup(c, fresh, msg);
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
			const epoch = st.epoch;
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
					};
					if (st.validatedRound === st.round && st.lastVerdict) {
						// 模型本轮已手动 loop_validate：复用结果，不再重复执行
						v = {
							pass: st.lastVerdict === "pass",
							noValidator: false,
							code: st.lastCode,
							output: st.lastEvidence || "",
							evidence: null,
						};
					} else {
						v = await runValidation(pi, st);
						if (v.cancelled || !stillCurrent(st.runId, epoch)) {
							journal(st, "late-callback-dropped", { at: "agent_end/runValidation", epoch });
							return;
						}
						if (!(await recordValidationOutcome(st, v, epoch))) return;
					}
					await handleVerdict(pi, c, st, v);
				}
			} catch (e) {
				journal(st, "runtime-error", { error: String((e as Error)?.message || e) });
				// 执行异常必须可见：不吞错，标记中断态（不伪装成完成）。
				// 用磁盘态 + 捕获的代次判定，避免把用户「停止」后的旧内存态重新落盘（epoch 回退会让迟到回调复活）。
				const fresh = loadState(st.runId);
				if (fresh && fresh.status === "active" && fresh.epoch === epoch) {
					fresh.status = "stopped";
					fresh.stage = "stopped";
					fresh.stopReason = "runtime-error";
					fresh.epoch += 1;
					saveState(fresh);
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
export function stopRunExternal(runId: string, reason = "user-stop"): { ok: boolean; error?: string } {
	const st = loadState(runId);
	if (!st) return { ok: false, error: "run 不存在：" + runId };
	if (st.status !== "active") return { ok: false, error: "run 已是终态：" + st.status };
	// 先使旧代次失效并取消在途执行，再落盘：迟到回调 / 在途子进程组一起作废。
	st.status = "stopped";
	st.stage = "stopped";
	st.stopReason = reason;
	st.epoch += 1;
	st.stopRequestedAt = now();
	saveState(st);
	journal(st, "stop", { source: "server", reason, epoch: st.epoch });
	// 真正取消该 run 的在途 validator / precheck 子进程（Task 1）。
	abortRun(runId);
	return { ok: true };
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
	st.sessionId = next;
	saveState(st);
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
	st.status = "done";
	st.stage = "done";
	st.acceptance = "passed-validator-only";
	delete st.stopReason;
	saveState(st);
	journal(st, "accepted-validator-only", { by: "user" });
	if (st.worktreeDir && st.worktreeBranch && !st.worktreeCommitted) {
		try {
			gitSync(["-C", st.worktreeDir, "add", "-A"], st.worktreeDir, 60000);
			const staged = gitSync(["-C", st.worktreeDir, "diff", "--cached", "--name-only"], st.worktreeDir, 60000);
			if (staged.trim())
				gitSync(["-C", st.worktreeDir, "commit", "-m", `mini-harness run ${st.runId}`], st.worktreeDir, 60000);
			st.worktreeCommitted = true;
			saveState(st);
			journal(st, "worktree-commit", { branch: st.worktreeBranch, dir: st.worktreeDir, by: "user-accept" });
		} catch (e) {
			journal(st, "worktree-commit-error", { error: String((e as Error)?.message || e) });
		}
	}
	return { ok: true };
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
	st.status = "active";
	st.stage = "validate";
	st.validatedRound = 0;
	delete st.stopReason;
	delete st.stopRequestedAt;
	delete st.stopConfirmedAt;
	st.epoch += 1;
	saveState(st);
	journal(st, "retry-review", { epoch: st.epoch });
	return { ok: true, st };
}

/** 服务端按 runId 读落盘状态（resume 显式绑定校验用）。 */
export function loadLoopState(runId: string) {
	return loadState(runId);
}
