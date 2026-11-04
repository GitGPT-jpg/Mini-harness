/**
 * Loop 任务台 / 代码 loop 表单 / 连接集群用的 HTTP 接口（/api/mini-harness/*）。
 *
 * - runs：代码 loop 运行状态（~/.mini-harness/runs/<id>/state.json 的公开字段）；
 * - models：代码 loop 表单的规划/评审模型下拉（只给 provider/id/family，不含 baseUrl/密钥）；
 * - roles：新任务各验收方式的规划/执行/审查实际模型与家族冲突预检（与服务端启动校验同一套规则）；
 * - task：执行者会话 jsonl 尾部 → 工具调用时间线（只读）；
 * - goals：LLM loop 永久目录（goal-history.jsonl）；
 * - cluster：服务实际可见的 kubeconfig（Web 导入 > 启动时 KUBECONFIG > ~/.kube/config）+ /version 探测，
 *   规则与新任务配置同源（cluster-config.ts）；响应只有错误码、固定文案和白名单元数据。
 *
 * PI_WEB_TOKEN 鉴权由 index.ts 的全局中间件覆盖，这里只做入参校验。
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Express, NextFunction, Request, Response } from "express";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	ClusterConfig,
	setActiveClusterConfig,
	type ClusterConfigOptions,
	type ClusterStatus,
} from "./cluster-config.js";
import { deleteGoalLog, listGoalLog } from "../goal-history-log.js";
import { distillLoopRun } from "./distill.js";
import { findModel, resolveTaskRoles, type TaskMode } from "./model-roles.js";
import { listOperations } from "./operation.js";
import type { BestRoundRecord, HardConstraint, HarnessMetrics, MetricGateResult } from "./metrics.js";
import { getPackKnowledge, getPackReference, listCapabilityPacks, listPackReferences } from "./packs.js";
import { normalizeTaskInputs, renderDiscoverySummary, resolveTaskContext } from "./discovery.js";
import {
	deleteLoopRun,
	familyOf,
	listRuns,
	loadLoopState,
	recoverRun,
	recoveryInfoOf,
	reviewBrief,
	reviewerEnabledOf,
	runsRoot,
	stopRunExternal,
	type LoopAcceptance,
} from "./extension.js";

export interface LoopRoutesOptions {
	dataDir: string;
	agentDir: string;
	/** 测试注入（假 kubectl / HOME / 环境对象）；缺省管理 process.env。 */
	cluster?: Omit<ClusterConfigOptions, "dataDir">;
}

export type { ClusterStatus };

export interface LoopRunBrief {
	runId: string;
	stage: string;
	round: number;
	maxRounds: number;
	status: string;
	lastVerdict: string | null;
	goal: string;
	project: string;
	models: { main: string | null; planner: string | null; reviewer: string | null };
	updatedAt: string | null;
	/** D-12-1：代码 loop / LLM loop。 */
	mode: "code" | "llm";
	stopReason: string | null;
	/** 完成态可信度（只在 status=done 时有值，见 server/loop/extension.ts 的 LoopAcceptance）。 */
	acceptance: LoopAcceptance | null;
	/** 最近一次模型评审结论与理由（最多 5 条，每条 ≤300 字；与快照 conv.loop.review 同源截断）。 */
	reviewVerdict: string | null;
	reviewReasons: string[];
	reviewerEnabled: boolean;
	createdAt: string | null;
	/** 隔夜恢复只读信息（unit / 租约 / 环境变化 / attempt）。 */
	recovery?: {
		unit: string;
		leaseHeld: boolean;
		environmentChanged: boolean;
		attemptId: string | null;
		generation: number;
		owner: string | null;
		remoteJobId: string | null;
	} | null;
}

export interface ToolEvent {
	id: string;
	name: string;
	arg: string;
	at: string | null;
	status: "running" | "done" | "error";
	ms: number | null;
	out: string;
}

const RUN_ID_RE = /^[0-9]{8,}-[a-z0-9]{4,}$/i;
const GOAL_ID_RE = /^[0-9]{6,}-[a-z0-9]{2,16}$/i;
/** 运行列表：非历史视图只看活跃 + 5 分钟内结束的。 */
const RECENT_MS = 5 * 60_000;
/** 时间线只读会话文件尾部（会话文件可达数 MB，每 1.5s 轮询不能整读）。 */
const TAIL_BYTES = 1024 * 1024;
const KUBECONFIG_MAX = 256 * 1024;

export function collectRuns(history: boolean, nowMs = Date.now()): LoopRunBrief[] {
	const out: LoopRunBrief[] = [];
	for (const st of listRuns()) {
		const t = Date.parse(st.updatedAt ?? "") || 0;
		const active = st.status === "active";
		if (!history && !active && nowMs - t >= RECENT_MS) continue;
		const ws = String(st.baseWorkspace || st.workspace || "");
		const review = reviewBrief(st.lastReview);
		out.push({
			runId: st.runId,
			stage: st.stage,
			round: st.round,
			maxRounds: st.maxRounds,
			status: st.status,
			lastVerdict: st.lastVerdict,
			goal: String(st.goal || "").slice(0, 200),
			project: ws ? basename(ws) : "",
			models: {
				main: st.mainModel?.id ?? null,
				planner: st.plannerModel?.id ?? null,
				reviewer: st.reviewerModel?.id ?? null,
			},
			updatedAt: st.updatedAt ?? null,
			mode: st.mode === "llm" ? "llm" : "code",
			stopReason: st.stopReason ?? null,
			acceptance: st.acceptance ?? null,
			reviewVerdict: review?.verdict ?? null,
			reviewReasons: review?.reasons ?? [],
			reviewerEnabled: reviewerEnabledOf(st),
			createdAt: st.createdAt ?? null,
			recovery: recoveryInfoOf(st.runId),
		});
	}
	out.sort(
		(a, b) =>
			Number(b.status === "active") - Number(a.status === "active") ||
			(Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0),
	);
	return out.slice(0, history ? 500 : 8);
}

/** 详情面板里一轮的证据：本轮评审报告 + validator 原始输出尾部（文件都在 runs/<id>/evidence/）。 */
export interface LoopRoundEvidence {
	round: number;
	review: string | null;
	logs: Array<{ file: string; tail: string }>;
}

/** GET /api/mini-harness/runs/:runId/detail 的返回（state.json 公开字段 + 证据 + journal 时间线）。 */
export interface LoopRunDetail {
	runId: string;
	goal: string;
	criteria: string | null;
	mode: "code" | "llm";
	status: string;
	stage: string;
	round: number;
	maxRounds: number;
	stopReason: string | null;
	acceptance: string | null;
	setupError: string | null;
	validator: {
		started?: boolean;
		precheckCmd?: string | null;
		cmd: string | null;
		verdict: string | null;
		code: number | null;
		evidenceTail: string;
	};
	review: { enabled: boolean; verdict: string | null; reasons: string[] };
	models: { main: string | null; planner: string | null; reviewer: string | null };
	project: string;
	workspace: string;
	worktreeBranch: string | null;
	worktreeCommitted: boolean;
	plannerOutput: string;
	plan: string;
	summary: string;
	history: Array<{
		round: number;
		verdict: string;
		code: number | null;
		at: string;
		metrics?: HarnessMetrics;
		commitSha?: string | null;
		snapshotRef?: string | null;
		precheckFailed?: boolean;
		metricGateOk?: boolean;
		metricGateReasons?: string[];
		workspaceChangedDuringValidation?: boolean;
		recoverable?: boolean;
	}>;
	lastMetrics?: HarnessMetrics | null;
	bestRound?: BestRoundRecord | null;
	stopRequestedAt?: string | null;
	stopConfirmedAt?: string | null;
	metricUnit?: string | null;
	metricThreshold?: number | null;
	metricThresholdOp?: "lt" | "lte" | "gt" | "gte" | null;
	metricTolerance?: number | null;
	metricScenario?: string | null;
	hardConstraints?: HardConstraint[] | null;
	lastMetricGate?: MetricGateResult | null;
	rounds: LoopRoundEvidence[];
	diff: string;
	journal: Array<Record<string, unknown>>;
	createdAt: string;
	updatedAt: string | null;
	packId?: string | null;
	packVersion?: string | null;
	attemptId?: string | null;
	generation?: number;
	owner?: string | null;
	remoteJobId?: string | null;
	recovery?: ReturnType<typeof recoveryInfoOf>;
}

const DETAIL_TEXT_MAX = 4000;
const DETAIL_REVIEW_MAX = 12_000;
const DETAIL_LOG_MAX = 6000;
const DETAIL_DIFF_MAX = 20_000;
const DETAIL_JOURNAL_MAX = 200;

/** 超长文本留尾部（证据最有用的是结尾的报错 / 结论）。 */
function clipTail(s: unknown, n: number): string {
	const text = String(s ?? "");
	return text.length > n ? `…${text.slice(-n)}` : text;
}

function readTextSafe(file: string, maxBytes: number): string {
	try {
		return readTail(file, maxBytes);
	} catch {
		return "";
	}
}

/** 一个 run 的完整详情；run 不存在返回 null。 */
export function collectRunDetail(runId: string): LoopRunDetail | null {
	const st = loadLoopState(runId);
	if (!st) return null;
	const dir = join(runsRoot(), runId);
	const evDir = join(dir, "evidence");
	const byRound = new Map<number, LoopRoundEvidence>();
	const roundOf = (n: number) => {
		let r = byRound.get(n);
		if (!r) {
			r = { round: n, review: null, logs: [] };
			byRound.set(n, r);
		}
		return r;
	};
	let files: string[] = [];
	try {
		files = readdirSync(evDir).sort();
	} catch {}
	for (const name of files) {
		const review = /^round-(\d+)-review\.md$/.exec(name);
		if (review) {
			roundOf(Number(review[1])).review = readTextSafe(join(evDir, name), DETAIL_REVIEW_MAX);
			continue;
		}
		const log = /^round-(\d+)-\d+\.log$/.exec(name);
		if (log) roundOf(Number(log[1])).logs.push({ file: name, tail: readTextSafe(join(evDir, name), DETAIL_LOG_MAX) });
	}
	const journal: Array<Record<string, unknown>> = [];
	for (const line of readTextSafe(join(dir, "journal.jsonl"), 512 * 1024).split("\n")) {
		if (!line.trim()) continue;
		try {
			journal.push(JSON.parse(line));
		} catch {}
	}
	const review = reviewBrief(st.lastReview);
	const ws = String(st.baseWorkspace || st.workspace || "");
	return {
		runId: st.runId,
		goal: String(st.goal || ""),
		criteria: st.criteria ?? null,
		mode: st.mode,
		status: st.status,
		stage: st.stage,
		round: st.round,
		maxRounds: st.maxRounds,
		stopReason: st.stopReason ?? null,
		acceptance: st.acceptance ?? null,
		setupError: st.setupError ?? null,
		validator: {
			started: listOperations(runId).some((op) => op.stage === "validate" && op.round === st.round && !!op.entity),
			precheckCmd: st.precheckCmd ?? null,
			cmd: st.validateCmd ?? null,
			verdict: st.lastVerdict ?? null,
			code: st.lastCode ?? null,
			evidenceTail: clipTail(st.lastEvidence, DETAIL_LOG_MAX),
		},
		review: { enabled: reviewerEnabledOf(st), verdict: review?.verdict ?? null, reasons: review?.reasons ?? [] },
		models: {
			main: st.mainModel?.id ?? null,
			planner: st.plannerModel?.id ?? null,
			reviewer: st.reviewerModel?.id ?? null,
		},
		project: ws ? basename(ws) : "",
		workspace: ws,
		worktreeBranch: st.worktreeBranch ?? null,
		worktreeCommitted: Boolean(st.worktreeCommitted),
		plannerOutput: clipTail(st.plannerOutput, DETAIL_TEXT_MAX),
		plan: clipTail(st.plan, DETAIL_TEXT_MAX),
		summary: clipTail(st.summary, DETAIL_TEXT_MAX),
		history: (st.history ?? []).map((h) => ({
			round: h.round,
			verdict: h.verdict,
			code: h.code,
			at: h.at,
			...(h.metrics ? { metrics: h.metrics } : {}),
			...(h.commitSha ? { commitSha: h.commitSha } : {}),
			...(h.snapshotRef ? { snapshotRef: h.snapshotRef } : {}),
			...(h.precheckFailed ? { precheckFailed: true } : {}),
			...(typeof h.metricGateOk === "boolean" ? { metricGateOk: h.metricGateOk } : {}),
			...(h.metricGateReasons?.length ? { metricGateReasons: h.metricGateReasons } : {}),
			...(h.workspaceChangedDuringValidation ? { workspaceChangedDuringValidation: true } : {}),
			...(typeof h.recoverable === "boolean" ? { recoverable: h.recoverable } : {}),
		})),
		...(st.lastMetrics ? { lastMetrics: st.lastMetrics } : {}),
		...(st.bestRound ? { bestRound: st.bestRound } : {}),
		...(st.stopRequestedAt ? { stopRequestedAt: st.stopRequestedAt } : {}),
		...(st.stopConfirmedAt ? { stopConfirmedAt: st.stopConfirmedAt } : {}),
		...(st.metricUnit ? { metricUnit: st.metricUnit } : {}),
		...(st.metricThreshold != null ? { metricThreshold: st.metricThreshold } : {}),
		...(st.metricThresholdOp ? { metricThresholdOp: st.metricThresholdOp } : {}),
		...(st.metricTolerance != null ? { metricTolerance: st.metricTolerance } : {}),
		...(st.metricScenario ? { metricScenario: st.metricScenario } : {}),
		...(st.hardConstraints?.length ? { hardConstraints: st.hardConstraints } : {}),
		...(st.lastMetricGate ? { lastMetricGate: st.lastMetricGate } : {}),
		rounds: [...byRound.values()].sort((a, b) => a.round - b.round),
		diff: clipTail(st.lastDiff, DETAIL_DIFF_MAX),
		journal: journal.slice(-DETAIL_JOURNAL_MAX),
		createdAt: st.createdAt,
		updatedAt: st.updatedAt ?? null,
		packId: st.packId ?? null,
		packVersion: st.packVersion ?? null,
		attemptId: st.attemptId ?? null,
		generation: st.generation ?? 0,
		owner: st.owner ?? null,
		remoteJobId: st.remoteJobId ?? null,
		recovery: recoveryInfoOf(st.runId),
	};
}

/** models.json 里配置的模型（家族规则与 loop 运行时 familyOf 同源）。 */
export function collectModels(agentDir: string): Array<{ provider: string; id: string; family: string }> {
	let cfg: { providers?: Record<string, { models?: Array<{ id?: unknown }> }> };
	try {
		cfg = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
	} catch {
		return [];
	}
	const out: Array<{ provider: string; id: string; family: string }> = [];
	for (const [provider, p] of Object.entries(cfg?.providers ?? {})) {
		for (const m of Array.isArray(p?.models) ? p.models : []) {
			if (m && m.id) out.push({ provider, id: String(m.id), family: familyOf(String(m.id)) });
		}
	}
	return out;
}

function readTail(file: string, maxBytes: number): string {
	const size = statSync(file).size;
	const start = Math.max(0, size - maxBytes);
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(size - start);
		readSync(fd, buf, 0, buf.length, start);
		const text = buf.toString("utf8");
		// 从中间截断时首行是半行，丢掉
		return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
	} finally {
		closeSync(fd);
	}
}

function briefArg(a: Record<string, unknown>): string {
	const v = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.url ?? a.goal ?? "";
	return String(v).replace(/\s+/g, " ").slice(0, 180);
}

/** 会话 jsonl → 工具调用时间线（toolCall 配对 toolResult；取最后 limit 条）。 */
export function parseToolTimeline(jsonl: string, limit = 40): ToolEvent[] {
	const calls = new Map<string, ToolEvent>();
	const events: ToolEvent[] = [];
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let o: { timestamp?: string; message?: Record<string, unknown> };
		try {
			o = JSON.parse(line);
		} catch {
			continue;
		}
		const m = o?.message;
		if (!m) continue;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const b of m.content as Array<Record<string, unknown>>) {
				if (b?.type !== "toolCall") continue;
				const ev: ToolEvent = {
					id: String(b.id ?? ""),
					name: String(b.name ?? ""),
					arg: briefArg((b.arguments as Record<string, unknown>) ?? {}),
					at: o.timestamp ?? null,
					status: "running",
					ms: null,
					out: "",
				};
				calls.set(ev.id, ev);
				events.push(ev);
			}
		} else if (m.role === "toolResult") {
			const ev = calls.get(String(m.toolCallId ?? ""));
			if (!ev) continue;
			ev.status = m.isError ? "error" : "done";
			ev.ms = typeof m.durationMs === "number" ? m.durationMs : null;
			const text = (Array.isArray(m.content) ? (m.content as Array<{ text?: string }>) : [])
				.map((c) => c?.text ?? "")
				.join(" ")
				.replace(/\s+/g, " ")
				.trim();
			ev.out = text.slice(0, 240);
		}
	}
	return events.slice(-limit);
}

export function registerLoopRoutes(app: Express, opts: LoopRoutesOptions): void {
	const sessionsRoot = join(opts.agentDir, "sessions");
	// 启动即按优先级对齐服务进程的 KUBECONFIG（新派生的 bash/终端/validator 继承它）。
	const cluster = new ClusterConfig({ dataDir: opts.dataDir, ...opts.cluster });
	setActiveClusterConfig(cluster);
	// 上次进程留下的 run 绑定：run 记录还在就保留（续跑 / 恢复时按快照核实），不在了就释放。
	cluster.pruneBindings((key) => {
		if (!key.startsWith("run:")) return false;
		try {
			return !!loadLoopState(key.slice(4));
		} catch {
			return true;
		}
	});

	app.get("/api/mini-harness/runs", (req, res) => {
		try {
			res.json({ runs: collectRuns(Boolean(req.query.history)) });
		} catch {
			res.status(503).json({ error: "Run list unavailable: scan budget exceeded or storage requires inspection" });
		}
	});
	app.get("/api/mini-harness/runs/latest", (req, res) => {
		try {
			res.json(collectRuns(Boolean(req.query.history))[0] ?? null);
		} catch {
			res.status(503).json({ error: "Run list unavailable: scan budget exceeded or storage requires inspection" });
		}
	});
	app.get("/api/mini-harness/runs/:runId/detail", (req, res) => {
		const id = String(req.params.runId ?? "");
		if (!RUN_ID_RE.test(id)) {
			res.status(400).json({ error: "bad runId" });
			return;
		}
		const detail = collectRunDetail(id);
		if (!detail) {
			res.status(404).json({ error: "run not found" });
			return;
		}
		// 集群绑定只给白名单标识（来源 / 状态 / context / 代次），不含路径与凭据。
		res.json({ ...detail, clusterBinding: cluster.taskBinding(`run:${id}`) });
	});
	app.post("/api/mini-harness/runs/:runId/recover", (req, res) => {
		const id = String(req.params.runId ?? "");
		if (!RUN_ID_RE.test(id)) {
			res.status(400).json({ error: "bad runId" });
			return;
		}
		const r = recoverRun(id);
		if (!r.ok) {
			res.status(404).json(r);
			return;
		}
		res.status(r.blockedReason ? 409 : 200).json(r);
	});
	app.post("/api/mini-harness/runs/:runId/stop", (req, res) => {
		const id = String(req.params.runId ?? "");
		if (!RUN_ID_RE.test(id)) {
			res.status(400).json({ error: "bad runId" });
			return;
		}
		const result = stopRunExternal(id);
		res.status(!result.ok ? 409 : result.stopConfirmedAt || result.status === "done" ? 200 : 202).json(result);
	});
	app.post("/api/mini-harness/runs/:runId/distill", (req, res) => {
		const id = String(req.params.runId ?? "");
		if (!RUN_ID_RE.test(id)) {
			res.status(400).json({ error: "bad runId" });
			return;
		}
		const st = loadLoopState(id);
		if (!st) {
			res.status(404).json({ error: "run not found" });
			return;
		}
		try {
			res.json(distillLoopRun(st, opts.dataDir));
		} catch (e) {
			res.status(500).json({ error: String((e as Error)?.message || e) });
		}
	});
	app.post("/api/mini-harness/runs/delete", (req, res) => {
		const runId = String(req.body?.runId ?? "");
		const deleted = deleteLoopRun(runId);
		if (!deleted.ok) {
			const status =
				deleted.code === "invalid" ? 400 : deleted.code === "missing" ? 404 : deleted.code === "active" ? 409 : 500;
			res.status(status).json(deleted);
			return;
		}
		// 记录已删：不存在接续引用，释放它的集群绑定（删快照 / 回收导入版本）。
		cluster.releaseTask(`run:${runId}`);
		res.status(200).json(deleted);
	});

	app.get("/api/mini-harness/models", (_req, res) => {
		res.json({ models: collectModels(opts.agentDir) });
	});
	app.post("/api/mini-harness/roles", async (req, res) => {
		const b = req.body ?? {};
		const mode = String(b.mode ?? "");
		if (mode !== "code-review" && mode !== "code" && mode !== "llm") {
			res.status(400).json({ error: "bad mode" });
			return;
		}
		const spec = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 200) : "");
		let registry: ModelRegistry;
		try {
			registry = new ModelRegistry(
				await ModelRuntime.create({
					authPath: join(opts.agentDir, "auth.json"),
					modelsPath: join(opts.agentDir, "models.json"),
				}),
			);
		} catch {
			res.status(503).json({ error: "model catalog unavailable" });
			return;
		}
		// 主对话模型可能来自扩展注册的 provider（不在这份目录里）：家族只看 id，按 "provider/id" 原样参与比较。
		const mainSpec = spec(b.main);
		const slash = mainSpec.indexOf("/");
		const main =
			findModel(registry, mainSpec) ??
			(mainSpec
				? slash > 0
					? { provider: mainSpec.slice(0, slash), id: mainSpec.slice(slash + 1) }
					: { id: mainSpec }
				: null);
		res.json(
			resolveTaskRoles(registry, main, {
				mode: mode as TaskMode,
				planner: spec(b.planner),
				executor: spec(b.executor),
				reviewer: spec(b.reviewer),
			}),
		);
	});

	app.get("/api/mini-harness/packs", (_req, res) => {
		res.json({ packs: listCapabilityPacks() });
	});
	app.get("/api/mini-harness/packs/:id/knowledge", (req, res) => {
		const k = getPackKnowledge(String(req.params.id ?? ""));
		if (!k) {
			res.status(404).json({ error: "unknown pack" });
			return;
		}
		res.json(k);
	});
	app.get("/api/mini-harness/packs/:id/references", (req, res) => {
		res.json({ references: listPackReferences(String(req.params.id ?? "")) });
	});
	app.get("/api/mini-harness/packs/:id/references/:refId", (req, res) => {
		const r = getPackReference(String(req.params.id ?? ""), String(req.params.refId ?? ""));
		if (!r) {
			res.status(404).json({ error: "unknown reference" });
			return;
		}
		res.json(r);
	});
	app.post("/api/mini-harness/discover", (req, res) => {
		const packId = typeof req.body?.packId === "string" ? req.body.packId : "";
		const workspace = typeof req.body?.workspace === "string" ? req.body.workspace : "";
		if (!packId || !workspace) {
			res.status(400).json({ error: "packId and workspace required" });
			return;
		}
		const normalized = normalizeTaskInputs(req.body ?? {});
		if (!normalized.ok) {
			res.status(400).json({
				error: normalized.error,
				summary: normalized.error,
				context: { error: normalized.error, inputConflicts: normalized.conflicts, normalizedInputs: normalized.inputs },
				conflicts: normalized.conflicts,
				typeErrors: normalized.typeErrors,
			});
			return;
		}
		const ctx = resolveTaskContext(packId, workspace, normalized.inputs);
		if (ctx.error) {
			res.status(404).json({ error: ctx.error, context: ctx, summary: renderDiscoverySummary(ctx) });
			return;
		}
		res.json({ context: ctx, summary: renderDiscoverySummary(ctx) });
	});

	// 会话文件定位缓存：sid → 路径（每 1.5s 一次的轮询不重复扫目录）。
	const sessionFiles = new Map<string, string>();
	const findSession = (sid: string): string => {
		const hit = sessionFiles.get(sid);
		if (hit && existsSync(hit)) return hit;
		let dirs: string[] = [];
		try {
			dirs = readdirSync(sessionsRoot);
		} catch {
			return "";
		}
		for (const d of dirs) {
			let names: string[] = [];
			try {
				names = readdirSync(join(sessionsRoot, d));
			} catch {
				continue;
			}
			const name = names.find((n) => n.endsWith(`_${sid}.jsonl`));
			if (name) {
				const file = join(sessionsRoot, d, name);
				sessionFiles.set(sid, file);
				return file;
			}
		}
		return "";
	};
	app.get("/api/mini-harness/task", (req, res) => {
		const sid = String(req.query.session ?? "").replace(/[^A-Za-z0-9-]/g, "");
		if (!sid) {
			res.status(400).json({ error: "session required" });
			return;
		}
		const file = findSession(sid);
		if (!file) {
			res.json({ found: false, events: [] });
			return;
		}
		let text = "";
		try {
			text = readTail(file, TAIL_BYTES);
		} catch {
			text = "";
		}
		res.json({ found: true, events: parseToolTimeline(text) });
	});

	app.get("/api/mini-harness/goals", (_req, res) => {
		res.json({ goals: listGoalLog(300, opts.dataDir) });
	});
	app.post("/api/mini-harness/goals/delete", (req, res) => {
		const id = String(req.body?.id ?? "");
		if (!GOAL_ID_RE.test(id)) {
			res.status(400).json({ error: "bad id" });
			return;
		}
		res.json({ ok: true, removed: deleteGoalLog(id, opts.dataDir) });
	});

	app.get("/api/mini-harness/cluster", async (req, res) => {
		res.json(await cluster.status(Boolean(req.query.refresh)));
	});
	app.post("/api/mini-harness/cluster", async (req, res) => {
		const text = typeof req.body?.kubeconfig === "string" ? req.body.kubeconfig : "";
		if (!text.trim()) {
			res.status(400).json({ error: "empty kubeconfig", code: "empty" });
			return;
		}
		if (text.length > KUBECONFIG_MAX) {
			res.status(400).json({ error: "kubeconfig too large", code: "too-large" });
			return;
		}
		const saved = cluster.save(text);
		if (!saved.ok) {
			// 写入失败：原配置保持不变，状态照常返回（不带异常文本）。
			res.status(500).json({ error: "save failed", code: saved.code, status: await cluster.status(true) });
			return;
		}
		res.json(await cluster.status(true));
	});
	app.post("/api/mini-harness/cluster/clear", async (_req, res) => {
		const cleared = cluster.clear();
		// 清除后按优先级回退到仍有效的外部配置，并立即重探。
		res.json({ ...cleared, ...(await cluster.status(true)) });
	});
	// express.json 的解析错误会带出请求体片段（kubeconfig 里可能有 token）：集群接口统一回固定错误，不记日志。
	app.use("/api/mini-harness/cluster", (err: unknown, _req: Request, res: Response, next: NextFunction) => {
		if (!err) return next();
		res.status(400).json({ error: "bad request", code: "bad-request" });
	});
}
