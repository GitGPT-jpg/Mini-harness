#!/usr/bin/env node
/**
 * 推理任务工作台 CLI（Comate 版）——自 dsh-inference-workbench `src/task-service.ts` + `controller.ts` 移植。
 *
 * 与 DSH 版的关键差异：DSH 版由宿主进程持有执行循环（agent bridge 开独立会话跑回合）；
 * Comate 版里执行者是 Comate 的子代理，状态机拆成两条确定性命令：
 *   round-begin：领取下一轮（守卫 + 递增轮次 + 产出执行提示词）
 *   round-end：  登记本轮结果（跑指标门禁 + 判定 + 状态转移 + 证据落盘）
 * 状态机语义（stage × status × acceptance、停止语义、指标门禁、最优轮次）与 DSH 版对齐。
 *
 * 数据落位：~/.comate/data/inference-workbench/{tasks,runs,clusters}（用户级，Skill 更新不丢数据）。
 * 可用 INFERENCE_WORKBENCH_DATA 改数据目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	collectPreflightSummary,
	evaluateMetricGate,
	parseHarnessMetrics,
	parseHarnessScenario,
	pickBetterRound,
	resolveGitHeadSha,
} from "./lib/metrics.mjs";
import { listCapabilityPacks, metricTargetOf, resolvePack } from "./lib/packs.mjs";
import { resolveTaskInputs, inputValue } from "./lib/discovery.mjs";
import { TaskStore, evidenceDirOf } from "./lib/store.mjs";
import {
	bindTaskCluster,
	discoverKubeconfigs,
	kubeconfigForTask,
	probeKubeconfig,
	releaseTaskBinding,
	verifyBinding,
} from "./lib/kubeconfig.mjs";

// 数据落在用户级目录：Skill 目录会被版本更新整体替换，任务记录不能放在里面。
const DATA_DIR =
	process.env.INFERENCE_WORKBENCH_DATA || path.join(os.homedir(), ".comate", "data", "inference-workbench");
const MAX_ROUNDS_DEFAULT = 6;

/** 有在途轮次危险的阶段（与 DSH 版 RUNNING_STAGES 对齐，intake 不算：还没开跑）。 */
const RUNNING_STAGES = new Set(["plan", "run", "validate", "stopping"]);

const store = new TaskStore(path.join(DATA_DIR, "tasks"));

const USAGE = `推理任务工作台 CLI（Comate 版）

用法：node cli.mjs <command> [options]

命令：
  packs                                          列出能力模板（id/名称/主指标/硬约束/是否需要集群）
  create  --pack <id> --workspace <dir> [opts]   创建任务（输入发现 + 缺口/冲突检查）
        可选：--name <名> --goal <目标> --input k=v（可多次）
              --kubeconfig <path>（等价 --input kubeconfig=<path>）
              --acceptance-mode code|code-review --max-rounds N
  list                                           列出任务（id/模板/阶段/状态/轮次/集群）
  get     --id <taskId>                          查看任务完整记录（JSON）
  start   --id <taskId>                          开始/重开一轮执行（done/stopped 可重开；集群任务自动绑定快照）
  round-begin --id <taskId>                      领取下一轮（守卫 + 产出执行提示词 + 集群 env）
  resume    --id <taskId>                        续跑：stage=run 重发在飞轮次（不递增），否则等同 round-begin
  status    --id <taskId>                        统一循环快照 + next 下一步动作（由 CLI 判定）
  round-end   --id <taskId> --exit-code N        登记本轮结果并跑指标门禁
              --stdout-file <f> [--stderr-file <f>]
  stop    --id <taskId>                          停止任务（标记停止，后续 round-begin 拒绝）
  delete  --id <taskId> [--force]                删除任务记录与证据（active 需 --force；同时释放集群快照）

集群命令（kubeconfig 发现 / 任务级绑定）：
  cluster list  [--kubeconfig <path>] [--workspace <dir>] [--probe]
                                                 列出可发现的 kubeconfig 来源与 context（只读）
  cluster bind    --id <taskId> [--kubeconfig <path>] [--context <名>] [--probe]
                                                 把当前（或指定）kubeconfig 快照绑定到任务
  cluster verify  --id <taskId> [--probe]        核实绑定快照未被改动（可选连通性探测）
  cluster env     --id <taskId>                  输出任务应使用的 KUBECONFIG（不能核实则指向占位配置）
  cluster unbind  --id <taskId>                  释放绑定并删除快照

输出：成功打印 JSON 到 stdout（exit 0）；失败打印 JSON 错误到 stderr（exit 1）。
数据：<plugin>/data/（INFERENCE_WORKBENCH_DATA 可覆盖）；集群快照在 data/clusters/（0600，含凭据，勿外传）。`;

// ---- 参数解析 ----

function parseArgs(argv) {
	const opts = { _: [], input: {} };
	for (let i = 0; i < argv.length; i++) {
		let a = argv[i];
		let inline = null;
		const eq = a.indexOf("=");
		if (a.startsWith("--") && eq > 2) {
			inline = a.slice(eq + 1);
			a = a.slice(0, eq);
		}
		const key = a.replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		if (key === "input") {
			const kv = inline ?? argv[++i];
			const sep = kv.indexOf("=");
			if (sep <= 0) usageError(`--input 需要 k=v 形式，收到：${kv}`);
			opts.input[kv.slice(0, sep)] = kv.slice(sep + 1);
		} else if (inline !== null) {
			opts[key] = inline;
		} else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
			opts[key] = argv[++i];
		} else {
			opts[key] = true;
		}
	}
	return opts;
}

function usageError(message) {
	process.stderr.write(JSON.stringify({ ok: false, error: message }) + "\n");
	process.stderr.write(`\n${USAGE}\n`);
	process.exit(2);
}

function fail(message, extra = {}) {
	process.stderr.write(JSON.stringify({ ok: false, error: message, ...extra }) + "\n");
	process.exit(1);
}

function ok(payload) {
	process.stdout.write(JSON.stringify({ ok: true, ...payload }, null, 2) + "\n");
	process.exit(0);
}

function now() {
	return new Date().toISOString();
}

function newId() {
	return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function requireTask(id) {
	const task = store.get(id);
	if (!task) fail(`任务不存在：${id}`);
	return task;
}

// ---- 三角色（单模型分饰，Comate 版）----
// DSH 版按角色选不同模型；Comate 版由当前 Comate 模型分饰，只保留结构性记录。

function resolveRoles(acceptanceMode, pack) {
	const roles = [
		{ role: "planner", model: "comate-main", family: "comate", source: "main" },
		{ role: "executor", model: "comate-main", family: "comate", source: "main" },
	];
	if (acceptanceMode === "code-review" || pack.useReviewer) {
		roles.push({ role: "reviewer", model: "comate-main", family: "comate", source: "main" });
	}
	return roles;
}

// ---- 命令实现 ----

function cmdPacks() {
	ok({ packs: listCapabilityPacks() });
}

async function cmdCreate(opts) {
	const pack = resolvePack(opts.pack);
	if (!pack) fail(`未知模板：${opts.pack}`, { knownPacks: listCapabilityPacks().map((p) => p.id) });

	const workspace = String(opts.workspace ?? "").trim();
	const userInputs = { ...(opts.input ?? {}) };
	// --kubeconfig 是 --input kubeconfig=... 的简写
	if (opts.kubeconfig && !userInputs.kubeconfig) userInputs.kubeconfig = String(opts.kubeconfig);
	// 任务级工作目录自动喂给 pack 的 workspace 输入，避免重复填写同一路径
	if (workspace && pack.inputs.some((i) => i.id === "workspace") && !userInputs.workspace) {
		userInputs.workspace = workspace;
	}
	// --goal 同理喂给 pack 的 goal 输入（DSH 表单里 goal 就是输入项之一）
	if (opts.goal && pack.inputs.some((i) => i.id === "goal") && !userInputs.goal) {
		userInputs.goal = String(opts.goal);
	}

	// ---- kubeconfig 只读发现（env > ~/.kube/config；显式输入优先，不覆盖用户值）----
	const discoveredInputs = {};
	let clusterDiscovery = null;
	if (pack.inputs.some((i) => i.id === "kubeconfig") && !userInputs.kubeconfig) {
		const discovered = discoverKubeconfigs({ workspace });
		const candidate = discovered.candidates.find((c) => c.isTarget);
		const value = discovered.target.kubeconfig ?? candidate?.path;
		if (discovered.target.source !== "none" && value) {
			discoveredInputs.kubeconfig = value;
			clusterDiscovery = {
				source: discovered.target.source,
				path: value,
				pathCount: discovered.target.pathCount,
				currentContext: candidate?.summary?.currentContext ?? null,
				contexts: candidate?.summary?.contexts ?? [],
				shadowed: discovered.target.shadowed,
				note: "任务启动时会把这套配置快照固定到任务，后续外部改动不影响任务",
			};
		}
	}

	const { inputs, missing, conflicts } = resolveTaskInputs(pack, workspace, userInputs, {}, discoveredInputs);
	if (missing.length) {
		fail("任务创建失败：必要输入缺失", { missingInputs: missing, conflicts, discovery: { kubeconfig: clusterDiscovery } });
	}

	const acceptanceMode = opts.acceptanceMode === "code-review" ? "code-review" : "code";
	const roles = resolveRoles(acceptanceMode, pack);
	const id = newId();
	const ts = now();
	const record = {
		id,
		packId: pack.id,
		name: String(opts.name ?? "").trim() || pack.name,
		workspace: path.resolve(workspace),
		goal: inputValue(inputs, "goal") || String(opts.goal ?? "").trim() || pack.goal,
		acceptanceMode,
		inputs,
		roles,
		metricTarget: metricTargetOf(pack),
		hardConstraints: pack.hardConstraints ?? [],
		maxRounds: opts.maxRounds && Number(opts.maxRounds) > 0 ? Number(opts.maxRounds) : pack.maxRounds ?? MAX_ROUNDS_DEFAULT,
		smokeTest: !!pack.smokeTest,
		useReviewer: !!pack.useReviewer,
		stage: "intake",
		status: "active",
		acceptance: null,
		round: 0,
		epoch: 1,
		generation: 0,
		owner: "comate",
		// DSH 版存执行会话 id；Comate 版存「本次执行的 Comate 会话标识」，占位 null
		sessionId: null,
		// 集群绑定：任务启动（start）时按当时生效的 kubeconfig 固定成快照
		clusterBinding: null,
		bestRound: null,
		lastMetrics: null,
		lastOutcome: null,
		failureReason: null,
		evidenceDir: evidenceDirOf(DATA_DIR, id),
		stopRequestedAt: null,
		stopConfirmedAt: null,
		stopTurnId: null,
		createdAt: ts,
		updatedAt: ts,
	};
	await store.put(record);
	ok({ result: { ok: true, task: record, discovery: { kubeconfig: clusterDiscovery } } });
}

function cmdList() {
	const tasks = store
		.list()
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
		.map(({ id, name, packId, stage, status, acceptance, round, maxRounds, failureReason, updatedAt, clusterBinding }) => ({
			id,
			name,
			packId,
			stage,
			status,
			acceptance,
			round,
			maxRounds,
			failureReason,
			updatedAt,
			cluster: clusterBinding ? { status: clusterBinding.status, context: clusterBinding.context, source: clusterBinding.source } : null,
		}));
	ok({ tasks });
}

/** 任务是否需要/已经有集群绑定：模板声明 clusterRelevant，或任务带 kubeconfig 输入。 */
function taskNeedsCluster(task, pack) {
	return !!pack?.clusterRelevant || !!pack?.inputs?.some((i) => i.id === "kubeconfig") || task.inputs.some((i) => i.key === "kubeconfig");
}

/** 按当前（或指定）kubeconfig 给任务做快照绑定；重复绑定先释放旧快照。 */
function bindTaskToCluster(task, { kubeconfig, context } = {}) {
	const pack = resolvePack(task.packId);
	if (!taskNeedsCluster(task, pack)) return null;
	const kcInput = task.inputs.find((i) => i.key === "kubeconfig");
	const value = kubeconfig ? String(kubeconfig) : kcInput?.value || "";
	// 只有「用户显式选择」才按 explicit 覆盖环境；发现得到的值仍走 env/default 解析（多路径语义不丢）
	const explicit = kubeconfig ? String(kubeconfig) : kcInput?.source === "user" ? value : undefined;
	const { target, candidates } = discoverKubeconfigs({ explicit, workspace: task.workspace });
	const sourceOverride =
		explicit ? null : kcInput?.source === "discovery" ? "discovery" : kcInput?.source === "user" ? "explicit" : null;
	// 显式输入但环境里没有对应来源时，仍按这个路径绑定
	const boundTarget =
		!explicit && value && target.source === "none"
			? { source: "explicit", kubeconfig: value, paths: [value], shadowed: [] }
			: target;
	if (task.clusterBinding) releaseTaskBinding(task.clusterBinding);
	const binding = bindTaskCluster({
		dataDir: DATA_DIR,
		taskId: task.id,
		target: boundTarget,
		context: context ? String(context) : null,
		sourceOverride,
	});
	task.clusterBinding = binding;
	// 把发现到的 kubeconfig 回填进任务输入（来源标 discovery，便于审计「这个任务当时用的是哪份配置」）
	if (kcInput && !kcInput.value && target.source !== "none" && binding.status !== "blocked") {
		kcInput.value = target.kubeconfig ?? candidates.find((c) => c.isTarget)?.path ?? "";
		if (kcInput.value) kcInput.source = "discovery";
	}
	return { binding, target, candidates };
}

function cmdGet(opts) {
	if (!opts.id) usageError("缺少 --id");
	ok({ task: requireTask(opts.id) });
}

async function cmdStart(opts) {
	if (!opts.id) usageError("缺少 --id");
	const task = requireTask(opts.id);
	// 进行中的任务不允许覆盖重开（防丢在途证据）；done/stopped/intake 可开新执行
	if (task.status === "active" && RUNNING_STAGES.has(task.stage)) {
		fail(`任务进行中（stage=${task.stage}），不允许覆盖重开；请先 stop 或继续跑完剩余轮次`);
	}
	// 重置为新一轮执行（与 DSH startTask 对齐）
	task.stage = "plan";
	task.status = "active";
	task.round = 0;
	task.acceptance = null;
	task.lastOutcome = null;
	task.lastMetrics = null;
	task.failureReason = null;
	task.stopRequestedAt = null;
	task.stopConfirmedAt = null;
	task.stopTurnId = null;
	task.generation += 1;
	task.updatedAt = now();
	// 集群任务在首个命令之前完成绑定（快照固定）；绑定 blocked/none 也照常开始，
	// 但后续 round-begin 的 KUBECONFIG 会指向必然连不上的占位配置，不会捡到全局配置。
	const cluster = bindTaskToCluster(task, { kubeconfig: opts.kubeconfig, context: opts.context });
	await store.put(task);
	const clusterState = task.clusterBinding
		? {
				status: task.clusterBinding.status,
				reason: task.clusterBinding.reason,
				context: task.clusterBinding.context,
				source: task.clusterBinding.source,
				flattened: task.clusterBinding.flattened ?? null,
				warning:
					task.clusterBinding.status === "pinned"
						? null
						: `集群绑定不可用（${task.clusterBinding.reason ?? "未配置"}）：任务内 kubectl 会失败，请补齐 kubeconfig 后重新 start 或 cluster bind`,
			}
		: null;
	ok({ task: { id: task.id, stage: task.stage, status: task.status, generation: task.generation }, cluster: clusterState });
}

function buildExecutorPrompt(task, pack, round, preflight, specificGoal, cluster) {
	const lines = [
		`你是「${pack.name}」任务的执行角色（executor）。`,
		``,
		`任务目标：${specificGoal || task.goal}`,
		`验收标准：${pack.criteria}`,
		``,
		`工作目录：${task.workspace}`,
		`环境快照：${preflight || "（无）"}`,
	];
	if (cluster) {
		lines.push(`集群绑定：${cluster.status}${cluster.context ? `（context: ${cluster.context}）` : ""}；KUBECONFIG=${cluster.env}`);
		if (cluster.status !== "pinned") {
			lines.push(
				`注意：集群绑定不可用（${cluster.reason ?? "未绑定"}），任务内 kubectl 会失败；不得改用全局 KUBECONFIG 绕过，遇到需要集群的操作应当如实报告受阻。`,
			);
		}
	}
	lines.push(
		``,
		`必要输入：`,
		...task.inputs.map((i) => `- ${i.label}（来源 ${i.source}）：${i.value}`),
		``,
		`当前是第 ${round} / ${task.maxRounds} 轮。`,
	);
	if (task.failureReason && round > 1) {
		lines.push(``, `上一轮未通过，原因：${task.failureReason}`, `请针对该原因改进后再完成目标。`);
	}
	lines.push(
		``,
		`要求：`,
		`1. 你只负责在工作目录内完成目标（改代码 / 补文件 / 跑必要的本地命令）。`,
		`2. 完成后不要自行判定结果——外部校验器会在你结束后运行验收命令。`,
		`3. 所有文件 / 命令改动都限定在工作目录内；不得触碰工作目录之外，不得执行生产 / 集群操作。`,
		`4. 回答里简要说明你做了什么、产物在哪里，然后结束本轮。`,
	);
	return lines.join("\n");
}

function buildClusterInfo(task) {
	const binding = task.clusterBinding;
	if (!binding) return null;
	const env = kubeconfigForTask(binding, DATA_DIR);
	return {
		status: binding.status,
		reason: binding.reason ?? null,
		context: binding.context ?? null,
		source: binding.source,
		env,
		externalCredentials: !!binding.externalCredentials,
	};
}

/** 生成一轮执行派发的完整负载。reissue=true 表示重发在飞轮次（不递增），用于中断续跑。 */
async function buildRoundDispatch(task, { reissue = false } = {}) {
	const pack = resolvePack(task.packId);
	if (!pack) fail(`未知模板：${task.packId}`);
	// 开轮前核实集群绑定：快照缺失/被改动 → 改判 blocked（之后的 KUBECONFIG 指向占位配置）
	if (task.clusterBinding) {
		const v = verifyBinding(task.clusterBinding);
		task.clusterBinding = v.binding;
	}
	if (!reissue) {
		task.round += 1;
		task.stage = "run";
	}
	task.updatedAt = now();
	await store.put(task);

	const cluster = buildClusterInfo(task);
	const preflight = collectPreflightSummary(task.workspace);
	const specificGoal = inputValue(task.inputs, "goal") || task.goal;
	const prompt = buildExecutorPrompt(task, pack, task.round, preflight, specificGoal, cluster);
	return {
		round: task.round,
		maxRounds: task.maxRounds,
		workspace: task.workspace,
		env: cluster ? { KUBECONFIG: cluster.env } : {},
		cluster: cluster
			? { status: cluster.status, reason: cluster.reason, context: cluster.context, source: cluster.source }
			: null,
		clusterEnvNote: cluster
			? cluster.status === "pinned"
				? "把 env.KUBECONFIG 注入执行子代理；这是任务级快照，外部改动原配置不影响它"
				: "绑定不可用：KUBECONFIG 指向占位配置，任务内 kubectl 必然失败；不得改用全局配置"
			: null,
		reissued: reissue,
		prompt,
	};
}

/** 守卫：任务处于 active 且允许派发。stage=run 属于在飞轮次，需用 resume，不在 round-begin 处理。 */
function guardDispatch(task, { allowInFlight }) {
	if (task.status !== "active") fail(`任务不在执行中（status=${task.status}），请先 start`);
	if (task.stopRequestedAt) fail("任务已请求停止，拒绝开新轮（如需继续请 start 重开）");
	if (!["plan", "run", "validate"].includes(task.stage)) {
		fail(`当前阶段不可开轮（stage=${task.stage}）`);
	}
	if (task.stage === "run" && !allowInFlight) {
		fail(`第 ${task.round} 轮已派发但尚未验收；用 resume 重发本轮，或先 round-end 登记结果`);
	}
	if (task.stage !== "run" && task.round >= task.maxRounds) {
		fail(`轮次已用尽（${task.round}/${task.maxRounds}）`);
	}
}

async function cmdRoundBegin(opts) {
	if (!opts.id) usageError("缺少 --id");
	const task = requireTask(opts.id);
	guardDispatch(task, { allowInFlight: false });
	ok(await buildRoundDispatch(task, { reissue: false }));
}

/** 续跑 / 重发在飞轮次：stage=run 时重发本轮（不递增），否则等同 round-begin。 */
async function cmdResume(opts) {
	if (!opts.id) usageError("缺少 --id");
	const task = requireTask(opts.id);
	guardDispatch(task, { allowInFlight: true });
	const reissue = task.stage === "run";
	ok(await buildRoundDispatch(task, { reissue }));
}

/** 统一循环快照 + 下一步动作：由 CLI 决定，Skill 据此推进。 */
function computeNext(task) {
	if (!task) return { action: "report", state: "unknown", text: "任务不存在" };
	if (task.status === "done") {
		if (task.acceptance === "passed") {
			return { action: "report", state: "passed", text: "验收通过", bestRound: task.bestRound };
		}
		return {
			action: "report",
			state: "failed",
			text: task.failureReason ?? "未达标（轮次用尽）",
			bestRound: task.bestRound,
			gap: gapOf(task),
		};
	}
	if (task.status === "stopped") {
		return { action: "report", state: "stopped", text: task.failureReason ?? "已停止", stopConfirmedAt: task.stopConfirmedAt };
	}
	if (task.status !== "active") {
		return { action: "report", state: "unknown", text: `状态异常（status=${task.status}）` };
	}
	switch (task.stage) {
		case "intake":
			return { action: "start", state: "created", text: "任务已创建，待 start" };
		case "plan":
			return { action: "round-begin", state: "ready", round: task.round, text: "待开始第 1 轮" };
		case "validate":
			return { action: "round-begin", state: "ready", round: task.round, text: `上一轮未通过，待第 ${task.round + 1} 轮`, failureReason: task.failureReason };
		case "run":
			return { action: "resume-round", state: "in-flight", round: task.round, text: `第 ${task.round} 轮已派发但尚未验收（可能中断），用 resume 重发本轮` };
		case "stopping":
			return { action: "confirm-stop", state: "stopping", text: "停止请求中，等待确认" };
		default:
			return { action: "report", state: "unknown", text: `阶段异常（stage=${task.stage}）` };
	}
}

/** 剩余差距：bestRound 主指标相对目标阈值的差（无阈值/无主指标时返回 null）。 */
function gapOf(task) {
	const b = task.bestRound;
	const t = task.metricTarget;
	if (!b?.metrics || !t?.threshold) return null;
	const v = b.metrics[t.metric];
	if (typeof v !== "number") return null;
	const d = t.threshold.value - v;
	const sign = t.direction === "maximize" ? 1 : -1;
	return { metric: t.metric, best: v, target: `${t.threshold.op} ${t.threshold.value}`, remaining: Math.max(0, sign * d) };
}

function cmdStatus(opts) {
	if (!opts.id) usageError("缺少 --id");
	const task = requireTask(opts.id);
	const cluster = task.clusterBinding
		? { status: task.clusterBinding.status, reason: task.clusterBinding.reason, context: task.clusterBinding.context, source: task.clusterBinding.source }
		: null;
	ok({
		task: {
			id: task.id,
			packId: task.packId,
			name: task.name,
			stage: task.stage,
			status: task.status,
			acceptance: task.acceptance,
			round: task.round,
			maxRounds: task.maxRounds,
			bestRound: task.bestRound,
			failureReason: task.failureReason,
			lastOutcome: task.lastOutcome
				? { round: task.lastOutcome.round, verdict: task.lastOutcome.verdict, reason: task.lastOutcome.reason }
				: null,
			evidenceDir: task.evidenceDir,
			cluster,
			acceptanceCriteria: task.goal ? { goal: task.goal, validateCmd: inputValue(task.inputs, "validateCmd") } : null,
		},
		next: computeNext(task),
	});
}

function verdictOf(gate, metrics, exitCode) {
	if (gate.ok) return "pass";
	const noMetrics = !metrics || Object.keys(metrics).length === 0;
	// 命令失败且无结构化输出 → 受阻（validator 自身未产出可判定证据）
	if (noMetrics && exitCode !== 0) return "blocked";
	// 缺少主指标 / 场景不匹配 → 受阻（无法按任务口径判定）
	if (gate.missingPrimary || gate.scenarioMismatch) return "blocked";
	// 有指标但阈值/硬约束未达标 → 失败（轮次预算内可继续）
	return "fail";
}

function readOutputFile(file, label) {
	if (!file) return "";
	try {
		return fs.readFileSync(file, "utf8");
	} catch (error) {
		fail(`无法读取${label}文件 ${file}：${error.message}`);
	}
}

async function cmdRoundEnd(opts) {
	if (!opts.id) usageError("缺少 --id");
	const exitCode = opts.exitCode === undefined || opts.exitCode === true ? null : Number(opts.exitCode);
	const task = requireTask(opts.id);
	if (task.status !== "active") fail(`任务不在执行中（status=${task.status}）`);
	if (task.stage !== "run") fail(`当前阶段不是执行中（stage=${task.stage}，应先 round-begin）`);
	if (task.round < 1) fail("尚无在途轮次（round=0）");

	const pack = resolvePack(task.packId);
	if (!pack) fail(`未知模板：${task.packId}`);

	const stdout = readOutputFile(opts.stdoutFile, "validator stdout");
	const stderr = readOutputFile(opts.stderrFile, "validator stderr");
	const validateCmd = inputValue(task.inputs, "validateCmd");

	// 未提供验收命令 → 受阻（与 DSH 版一致，不臆造结果）
	const metrics = parseHarnessMetrics(stdout);
	const scenario = parseHarnessScenario(stdout);
	let outcome;
	if (!validateCmd) {
		outcome = {
			round: task.round,
			exitCode,
			stdout,
			stderr,
			metrics: null,
			scenario: null,
			gate: { ok: false, missingPrimary: false, scenarioMismatch: false, violations: [], reasons: ["未提供验收命令（validateCmd）"] },
			verdict: "blocked",
			reason: "未提供验收命令（validateCmd）",
			at: now(),
		};
	} else {
		const gate = evaluateMetricGate(task.metricTarget, task.hardConstraints, metrics, scenario);
		const verdict = verdictOf(gate, metrics, exitCode);
		outcome = {
			round: task.round,
			exitCode,
			stdout,
			stderr,
			metrics,
			scenario,
			gate,
			verdict,
			reason: gate.reasons.join(" ") || (exitCode === 0 ? "" : `命令退出码 ${exitCode}`),
			at: now(),
		};
	}

	// 证据落盘（validator 原始输出 + 判定元数据）
	const dir = task.evidenceDir ?? evidenceDirOf(DATA_DIR, task.id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `round-${task.round}.stdout.txt`), stdout);
	fs.writeFileSync(path.join(dir, `round-${task.round}.stderr.txt`), stderr);
	fs.writeFileSync(
		path.join(dir, `round-${task.round}.meta.json`),
		JSON.stringify({ exitCode, verdict: outcome.verdict, metrics: metrics ?? undefined, scenario: scenario ?? undefined, gate: outcome.gate }, null, 2),
	);
	if (!task.evidenceDir) task.evidenceDir = dir;

	task.lastOutcome = { ...outcome, stdout: stdout.length > 2000 ? stdout.slice(0, 2000) + "…（截断，全文见证据文件）" : stdout, stderr: stderr.length > 2000 ? stderr.slice(0, 2000) + "…" : stderr };
	task.lastMetrics = metrics;
	task.updatedAt = now();

	// 最优轮次 checkpoint
	const candidate = {
		round: task.round,
		verdict: outcome.verdict,
		commitSha: resolveGitHeadSha(task.workspace),
		metrics: metrics ?? undefined,
		at: outcome.at,
	};
	task.bestRound = pickBetterRound(task.bestRound, candidate, task.metricTarget);

	if (outcome.verdict === "pass") {
		task.acceptance = "passed";
		task.stage = "done";
		task.status = "done";
		task.failureReason = null;
	} else if (outcome.verdict === "blocked") {
		task.failureReason = outcome.reason || "受阻";
		task.stage = "done";
		task.status = "done";
		task.acceptance = null;
	} else {
		// fail：保留失败原因供下一轮反馈；轮次用尽则结束
		task.failureReason = outcome.reason || "未通过验收";
		if (task.round >= task.maxRounds) {
			task.stage = "done";
			task.status = "done";
			task.acceptance = null;
			task.failureReason = `${task.failureReason}（轮次用尽，共 ${task.maxRounds} 轮）`;
		} else {
			task.stage = "validate"; // 待下一轮 round-begin
		}
	}
	await store.put(task);
	ok({ outcome, task: { id: task.id, stage: task.stage, status: task.status, acceptance: task.acceptance, round: task.round, bestRound: task.bestRound, failureReason: task.failureReason } });
}

async function cmdStop(opts) {
	if (!opts.id) usageError("缺少 --id");
	const task = requireTask(opts.id);
	if (task.status !== "active" || task.stage === "done" || task.stage === "stopped") {
		ok({ task, note: `任务已是终态（stage=${task.stage}），无需停止` });
		return;
	}
	// CLI 版没有可取消的在途进程：停止请求即确认（子代理的停止由 Comate 侧 skill 控制）
	task.stopRequestedAt = now();
	task.stopConfirmedAt = now();
	task.stopTurnId = task.sessionId;
	task.stage = "stopped";
	task.status = "stopped";
	task.updatedAt = now();
	await store.put(task);
	ok({ task });
}

async function cmdDelete(opts) {
	if (!opts.id) usageError("缺少 --id");
	const task = requireTask(opts.id);
	if (task.status === "active" && RUNNING_STAGES.has(task.stage) && !opts.force) {
		fail("任务进行中，删除会丢失在途记录与证据；确认请加 --force，或先 stop");
	}
	// 释放任务级集群快照（占位配置共享，不删）
	releaseTaskBinding(task.clusterBinding);
	await store.remove(task.id);
	fs.rmSync(task.evidenceDir ?? evidenceDirOf(DATA_DIR, task.id), { recursive: true, force: true });
	ok({ deleted: task.id });
}

// ---- 集群命令 ----

function sanitizeCandidate(c) {
	return {
		source: c.source,
		path: c.path,
		exists: c.exists,
		isTarget: c.isTarget,
		size: c.size,
		mtime: c.mtime,
		error: c.error,
		currentContext: c.summary?.currentContext ?? null,
		contexts: c.summary?.contexts ?? [],
		clusters: c.summary?.clusters ?? [],
		externalCredentials: !!c.summary?.externalCredentials,
		relativeCredentialRefs: !!c.summary?.relativeCredentialRefs,
	};
}

function cmdClusterList(opts) {
	const explicit = opts.kubeconfig ? String(opts.kubeconfig) : undefined;
	const workspace = opts.workspace ? path.resolve(String(opts.workspace)) : process.cwd();
	const discovered = discoverKubeconfigs({ explicit, workspace });
	const target = discovered.target;
	let probe = null;
	if (opts.probe && target.source !== "none") {
		probe = probeKubeconfig({ source: target.source, kubeconfig: target.kubeconfig, paths: target.paths ?? [] });
	}
	ok({
		target: {
			source: target.source,
			kubeconfig: target.kubeconfig,
			pathCount: target.pathCount,
			shadowed: target.shadowed,
			probe,
		},
		candidates: discovered.candidates.map(sanitizeCandidate),
		note: "发现只读：只 stat/读文件做摘要，不执行集群命令；--probe 才会 GET /version",
	});
}

async function cmdClusterBind(opts) {
	if (!opts.id) usageError("缺少 --id");
	const task = requireTask(opts.id);
	const explicit = opts.kubeconfig ? String(opts.kubeconfig) : undefined;
	const context = opts.context ? String(opts.context) : null;
	const { target, candidates } = discoverKubeconfigs({ explicit, workspace: task.workspace });
	if (target.source === "none") {
		fail("没有可绑定的 kubeconfig：显式路径、KUBECONFIG 与 ~/.kube/config 都不存在", {
			hint: "用 cluster list 查看候选，或 --kubeconfig 指定路径",
		});
	}
	// context 预校验（单路径时能静态判断；多路径合并后的 context 交给 bind 判定）
	if (context) {
		const candidate = candidates.find((c) => c.isTarget);
		const contexts = candidate?.summary?.contexts ?? [];
		if (candidate && contexts.length && !contexts.includes(context)) {
			fail(`context 不存在：${context}`, { availableContexts: contexts });
		}
	}
	if (task.clusterBinding) releaseTaskBinding(task.clusterBinding);
	const binding = bindTaskCluster({ dataDir: DATA_DIR, taskId: task.id, target, context });
	task.clusterBinding = binding;
	// 回填任务输入，记录「这个任务当时绑的是哪份配置」
	const kcInput = task.inputs.find((i) => i.key === "kubeconfig");
	if (kcInput && !kcInput.value && target.source !== "none" && binding.status !== "blocked") {
		kcInput.value = target.kubeconfig ?? candidates.find((c) => c.isTarget)?.path ?? "";
		if (kcInput.value) kcInput.source = "discovery";
	}
	task.updatedAt = now();
	await store.put(task);
	if (binding.reason === "context-not-found") {
		fail(`context 在目标配置中不存在：${context}`, { availableContexts: binding.availableContexts ?? [] });
	}
	const probe = opts.probe
		? probeKubeconfig({ source: binding.source, kubeconfig: binding.file, paths: binding.file ? [binding.file] : [] })
		: null;
	ok({
		binding: {
			source: binding.source,
			status: binding.status,
			reason: binding.reason,
			context: binding.context,
			flattened: binding.flattened ?? null,
			externalCredentials: binding.externalCredentials,
			createdAt: binding.createdAt,
		},
		env: kubeconfigForTask(binding, DATA_DIR) ? { KUBECONFIG: kubeconfigForTask(binding, DATA_DIR) } : {},
		probe,
	});
}

async function cmdClusterVerify(opts) {
	if (!opts.id) usageError("缺少 --id");
	const task = requireTask(opts.id);
	if (!task.clusterBinding) fail("该任务尚未绑定集群（先 start 或 cluster bind）");
	const result = verifyBinding(task.clusterBinding, { probe: !!opts.probe });
	task.clusterBinding = result.binding;
	task.updatedAt = now();
	await store.put(task);
	const binding = result.binding;
	ok({
		ok: result.ok,
		reason: result.reason,
		binding: {
			source: binding.source,
			status: binding.status,
			reason: binding.reason,
			context: binding.context,
			verifiedAt: binding.verifiedAt ?? null,
			probe: binding.probe ?? null,
		},
		env: kubeconfigForTask(binding, DATA_DIR) ? { KUBECONFIG: kubeconfigForTask(binding, DATA_DIR) } : {},
	});
}

function cmdClusterEnv(opts) {
	if (!opts.id) usageError("缺少 --id");
	const task = requireTask(opts.id);
	if (!task.clusterBinding) fail("该任务尚未绑定集群（先 start 或 cluster bind）");
	const env = kubeconfigForTask(task.clusterBinding, DATA_DIR);
	ok({
		env: env ? { KUBECONFIG: env } : {},
		binding: {
			source: task.clusterBinding.source,
			status: task.clusterBinding.status,
			reason: task.clusterBinding.reason,
			context: task.clusterBinding.context,
		},
		note:
			task.clusterBinding.status === "pinned"
				? "快照可用；执行子代理须使用该 KUBECONFIG"
				: "绑定不可用：KUBECONFIG 指向占位配置，任务内 kubectl 必然失败",
	});
}

async function cmdClusterUnbind(opts) {
	if (!opts.id) usageError("缺少 --id");
	const task = requireTask(opts.id);
	if (!task.clusterBinding) {
		ok({ task: task.id, note: "该任务本就没有集群绑定" });
		return;
	}
	releaseTaskBinding(task.clusterBinding);
	task.clusterBinding = null;
	task.updatedAt = now();
	await store.put(task);
	ok({ task: task.id, unbound: true });
}

// ---- 入口 ----

const [command, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);
switch (command) {
	case "packs":
		cmdPacks();
		break;
	case "create":
		await cmdCreate(opts);
		break;
	case "list":
		cmdList();
		break;
	case "get":
		cmdGet(opts);
		break;
	case "start":
		await cmdStart(opts);
		break;
	case "round-begin":
		await cmdRoundBegin(opts);
		break;
	case "resume":
		await cmdResume(opts);
		break;
	case "status":
		cmdStatus(opts);
		break;
	case "round-end":
		await cmdRoundEnd(opts);
		break;
	case "stop":
		await cmdStop(opts);
		break;
	case "delete":
		await cmdDelete(opts);
		break;
	case "cluster":
		if (opts.list) cmdClusterList(opts);
		else if (opts.bind) await cmdClusterBind(opts);
		else if (opts.verify) await cmdClusterVerify(opts);
		else if (opts.env) cmdClusterEnv(opts);
		else if (opts.unbind) await cmdClusterUnbind(opts);
		else usageError("cluster 需要子命令：list | bind | verify | env | unbind");
		break;
	case undefined:
	case "help":
	case "--help":
	case "-h":
		process.stdout.write(USAGE + "\n");
		break;
	default:
		usageError(`未知命令：${command}`);
}
