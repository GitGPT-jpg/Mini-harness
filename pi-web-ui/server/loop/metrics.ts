/**
 * 推理与性能任务指标提取、最优轮次 Checkpoint、指标门禁与前置探测（D-12c 方向二 + P1 指标门禁）。
 *
 * validator 标准输出中可携带结构化指标与场景标记：
 *   - JSON 格式：HARNESS_METRIC: {"ttft_ms": 118.4, "tps": 86.2, "cache_hit": 0.96}
 *   - KV 格式：  HARNESS_METRIC: ttft_ms=118.4 tps=86.2 loss_pct=14.2
 *   - 场景标记：  HARNESS_SCENARIO: ascache-on-vs-radix-off
 *
 * 运行时自动解析数值指标落盘到 history[i].metrics 与 st.lastMetrics，
 * 并基于通过态（或指标得分）维护 st.bestRound（含轮次、commitSha、metrics），
 * 防止多轮迭代改坏已跑通或性能更优的版本。
 *
 * 指标门禁（evaluateMetricGate）把「命令执行成功（exit 0）」与「指标采集成功 + 硬约束满足」分开：
 * 声明了主指标的任务，validator 即便 exit 0，只要没报出主指标 / 数值非法 / 阈值或硬约束不满足，
 * 都不得把该轮当作指标验收通过或最优 Checkpoint。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type HarnessMetrics = Record<string, number>;

export type MetricDirection = "maximize" | "minimize";
export type ThresholdOperator = "lt" | "lte" | "gt" | "gte";

export interface BestRoundRecord {
	round: number;
	verdict: string;
	commitSha: string | null;
	/** 可恢复的代码快照引用（git 快照 ref / 目录快照路径）；无则 null。 */
	snapshotRef?: string | null;
	metrics?: HarnessMetrics;
	at: string;
}

/** 任务声明的「主指标 + 优化方向 + 单位 + 目标阈值 + 比较容差」硬约束（可选）。 */
export interface MetricTarget {
	/** 主指标名（如 loss_pct / tps / ttft_ms）。声明后比较与门禁只认它，不再按名字猜。 */
	metric: string;
	/** 优化方向：maximize（越大越好）/ minimize（越小越好）。 */
	direction: MetricDirection;
	/** 声明单位（如 % / tokens/s / ms）。未声明则单位口径无法确认（记录展示，不阻塞）。 */
	unit?: string;
	/** 目标阈值（如 { op: "lt", value: 20 } 表示 loss_pct < 20）。未声明 = 无数值目标，只要求指标在场。 */
	threshold?: { op: ThresholdOperator; value: number };
	/** 最优轮次比较的数值容差（相对量，如 0.01 = 1%；0 = 精确比较）。只用于择优，不是阈值。 */
	tolerance?: number;
	/** 必要场景配置（如 "ascache-on-vs-radix-off"）。声明后 validator 必须报出匹配场景，否则证据不足。 */
	scenario?: string;
	/** @deprecated 旧字段「精度/硬约束」，已被 threshold / tolerance 拆分；仅向后兼容读取，不参与判定。 */
	precision?: number;
}

/** 必要硬约束：主指标之外的证据门禁（如「精度无退化」「稳定性通过」「输入长度 = 60k」）。 */
export interface HardConstraint {
	/** 约束名（展示用）。 */
	name: string;
	/** 约束指标名（取自 HARNESS_METRIC 的键）。 */
	metric: string;
	op: ThresholdOperator;
	value: number;
	/** 声明单位（记录展示）。 */
	unit?: string;
	/** 必要场景配置；声明后 validator 场景标记须匹配，否则证据不足。 */
	scenario?: string;
}

const METRIC_LINE_RE = /^\s*HARNESS_METRIC\s*:\s*(.+)$/i;
const SCENARIO_LINE_RE = /^\s*HARNESS_SCENARIO\s*:\s*(.+)$/i;
const KV_TOKEN_RE = /([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/gi;

/**
 * 从 validator 输出文本中提取 HARNESS_METRIC 数值指标。
 * 同名键取最后一次出现的值；无有效数值指标时返回 null。
 */
export function parseHarnessMetrics(output: unknown): HarnessMetrics | null {
	const text = String(output ?? "");
	if (!text) return null;
	const out: HarnessMetrics = {};
	for (const line of text.split(/\r?\n/)) {
		const m = METRIC_LINE_RE.exec(line);
		if (!m) continue;
		const payload = m[1]!.trim();
		if (payload.startsWith("{")) {
			try {
				const obj = JSON.parse(payload) as Record<string, unknown>;
				if (obj && typeof obj === "object" && !Array.isArray(obj)) {
					for (const [k, v] of Object.entries(obj)) {
						const num = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
						if (Number.isFinite(num)) out[k] = num;
					}
					continue;
				}
			} catch {
				// JSON 解析失败退回 KV 扫描
			}
		}
		KV_TOKEN_RE.lastIndex = 0;
		let kv: RegExpExecArray | null;
		while ((kv = KV_TOKEN_RE.exec(payload)) !== null) {
			const num = Number(kv[2]);
			if (Number.isFinite(num)) out[kv[1]!] = num;
		}
	}
	return Object.keys(out).length > 0 ? out : null;
}

/** 从 validator 输出中提取 HARNESS_SCENARIO 场景标记（字符串，非数值指标）；无则 null。 */
export function parseHarnessScenario(output: unknown): string | null {
	const text = String(output ?? "");
	for (const line of text.split(/\r?\n/)) {
		const m = SCENARIO_LINE_RE.exec(line);
		if (m) {
			const v = m[1]!.trim();
			if (v) return v;
		}
	}
	return null;
}

/**
 * 指标优劣得分（越大越好）：
 * - 声明了主指标：只认该指标，方向 minimize 时取负；该轮没报出主指标 → null（不猜）。
 * - 未声明主指标：沿用旧启发——先看「越大越好」的吞吐/命中类，再看「越小越好」的损耗/延迟类。
 */
function metricScore(metrics?: HarnessMetrics | null, target?: MetricTarget | null): number | null {
	if (!metrics) return null;
	if (target?.metric) {
		const v = metrics[target.metric];
		if (typeof v === "number" && Number.isFinite(v)) return target.direction === "minimize" ? -v : v;
		return null;
	}
	const higher = ["score", "tps", "throughput", "hit_rate", "cache_hit", "speedup"];
	for (const k of higher) {
		if (typeof metrics[k] === "number" && Number.isFinite(metrics[k])) return metrics[k]!;
	}
	const lower = ["loss_pct", "loss", "ttft_ms", "ttft", "latency_ms", "latency", "error_rate"];
	for (const k of lower) {
		if (typeof metrics[k] === "number" && Number.isFinite(metrics[k])) return -metrics[k]!;
	}
	const first = Object.values(metrics)[0];
	return typeof first === "number" && Number.isFinite(first) ? first : null;
}

function thresholdSatisfied(v: number, op: ThresholdOperator, value: number): boolean {
	switch (op) {
		case "lt":
			return v < value;
		case "lte":
			return v <= value;
		case "gt":
			return v > value;
		case "gte":
			return v >= value;
	}
}

/**
 * 决定本轮是否应更新 bestRound：
 * 1. 尚无 bestRound：未声明主指标时只要本轮 pass 或带有效指标即可记录；声明主指标时必须报出该指标；
 * 2. 声明主指标后，候选轮缺主指标 → 永不成为最优（即便 pass 也不能压过已有的 fail 带指标轮）；
 * 3. 同为 pass / 同为 fail / 一 pass 一 fail：都必须在主指标在场、口径一致时才可比较，数值更优者胜；
 *    容差内视为持平，pass 优先，再取更新一轮；
 * 4. 未声明主指标时回退旧启发：pass 永远优于 fail；同判定按指标得分；无指标取最新 pass。
 */
export function pickBetterRound(
	current: BestRoundRecord | null | undefined,
	candidate: BestRoundRecord,
	target?: MetricTarget | null,
): BestRoundRecord | null {
	const hasMetrics = candidate.metrics && Object.keys(candidate.metrics).length > 0;
	const candScore = metricScore(candidate.metrics, target);
	const tolerance = Math.max(0, Number(target?.tolerance) || 0);

	if (target?.metric) {
		// 声明主指标：候选轮没报出主指标（或数值非法）→ 永不成为最优。
		if (candScore === null) return current ?? null;
		if (!current) return candidate;
		const curScore = metricScore(current.metrics, target);
		// 已有最优轮没主指标，候选轮有 → 候选轮补齐证据，胜出。
		if (curScore === null) return candidate;
		if (candScore > curScore + tolerance) return candidate;
		if (candScore < curScore - tolerance) return current;
		// 容差内持平：pass 优先；同判定取更新一轮。
		const curPass = current.verdict === "pass";
		const candPass = candidate.verdict === "pass";
		if (candPass !== curPass) return candPass ? candidate : current;
		return candidate;
	}

	if (!current) {
		return candidate.verdict === "pass" || hasMetrics ? candidate : null;
	}
	const curPass = current.verdict === "pass";
	const candPass = candidate.verdict === "pass";
	if (candPass !== curPass) return candPass ? candidate : current;
	const curScore = metricScore(current.metrics, target);
	if (curScore !== null && candScore !== null) {
		return candScore >= curScore ? candidate : current;
	}
	if (candScore !== null && curScore === null) return candidate;
	if (candPass) return candidate;
	return current;
}

/** 指标门禁结果：区分「命令成功」与「指标/硬约束满足」。 */
export interface MetricGateResult {
	/** 门禁通过：无主指标时恒 true；有主指标时要求指标在场且阈值/硬约束全部满足。 */
	ok: boolean;
	/** 缺少声明的主指标（含数值非法）。 */
	missingPrimary: boolean;
	/** 声明了主指标但未声明单位（口径无法确认，仅记录展示，不阻塞）。 */
	unitUnconfirmed: boolean;
	/** 场景不匹配（声明了必要场景但 validator 未报出匹配场景）。 */
	scenarioMismatch: boolean;
	/** 不满足的硬约束（含主指标阈值）。 */
	violations: Array<{ name: string; detail: string }>;
	reasons: string[];
}

/**
 * 评估指标门禁：把「主指标在场 + 目标阈值 + 必要硬约束」统一成一道验收门禁。
 * 无主指标且无硬约束（普通功能性任务）→ ok=true，不破坏非指标任务。
 */
export function evaluateMetricGate(
	target: MetricTarget | null | undefined,
	constraints: HardConstraint[] | null | undefined,
	metrics: HarnessMetrics | null | undefined,
	scenario: string | null | undefined,
): MetricGateResult {
	const violations: Array<{ name: string; detail: string }> = [];
	const reasons: string[] = [];
	let missingPrimary = false;
	let scenarioMismatch = false;
	const unitUnconfirmed = !!target?.metric && !target?.unit;

	if (target?.metric) {
		const v = metrics?.[target.metric];
		if (typeof v !== "number" || !Number.isFinite(v)) {
			missingPrimary = true;
			reasons.push("缺少主指标 " + target.metric + "（validator 未输出或数值非法；命令 exit 0 不等于指标达标）。");
		} else if (target.threshold && !thresholdSatisfied(v, target.threshold.op, target.threshold.value)) {
			violations.push({
				name: "主指标 " + target.metric,
				detail: target.metric + "=" + v + " 不满足 " + target.threshold.op + " " + target.threshold.value,
			});
			reasons.push("主指标 " + target.metric + "=" + v + " 未达目标阈值（" + target.threshold.op + " " + target.threshold.value + "）。");
		}
		if (target.scenario) {
			if (scenario !== target.scenario) {
				scenarioMismatch = true;
				reasons.push("必要场景不匹配：任务声明 " + target.scenario + "，validator 报出 " + (scenario ?? "（无）") + "。");
			}
		}
	}
	for (const c of constraints ?? []) {
		const v = metrics?.[c.metric];
		if (typeof v !== "number" || !Number.isFinite(v)) {
			violations.push({ name: c.name, detail: "缺少约束指标 " + c.metric });
			reasons.push("缺少必要约束证据：" + c.name + "（" + c.metric + " 未输出）。");
		} else if (!thresholdSatisfied(v, c.op, c.value)) {
			violations.push({ name: c.name, detail: c.metric + "=" + v + " 不满足 " + c.op + " " + c.value });
			reasons.push("硬约束不满足：" + c.name + "（" + c.metric + "=" + v + " " + c.op + " " + c.value + "）。");
		} else if (c.scenario && scenario !== c.scenario) {
			scenarioMismatch = true;
			violations.push({ name: c.name, detail: "场景不匹配（声明 " + c.scenario + "，实际 " + (scenario ?? "（无）") + "）" });
			reasons.push("约束 " + c.name + " 声明的场景 " + c.scenario + " 与实际 " + (scenario ?? "（无）") + " 不一致。");
		}
	}
	return {
		ok: !missingPrimary && !scenarioMismatch && violations.length === 0,
		missingPrimary,
		unitUnconfirmed,
		scenarioMismatch,
		violations,
		reasons,
	};
}

/**
 * 读取工作区当前 git HEAD 短 SHA（非 git 仓库返回 null）。
 */
export function resolveGitHeadSha(cwd: string): string | null {
	try {
		const sha = execFileSync("git", ["-C", cwd, "rev-parse", "--short=12", "HEAD"], {
			cwd,
			timeout: 5000,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return sha || null;
	} catch {
		return null;
	}
}

/**
 * 轻量前置环境快照（注入 <mini_harness_loop>，让模型免于首轮盲跑探测命令）：
 * - git 分支与 HEAD SHA
 * - 常用验证文件（validate.py / package.json / pyproject.toml）存在性
 * - 集群 KUBECONFIG 是否已挂载
 */
export function collectPreflightSummary(workspace: string): string {
	const parts: string[] = [];
	try {
		const branch = execFileSync("git", ["-C", workspace, "rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: workspace,
			timeout: 3000,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const sha = resolveGitHeadSha(workspace);
		if (branch) parts.push("git=" + branch + (sha ? "@" + sha : ""));
	} catch {
		parts.push("git=none");
	}
	const markers = ["validate.py", "package.json", "pyproject.toml", "Cargo.toml", "Makefile"].filter((f) => {
		try {
			return fs.existsSync(path.join(workspace, f));
		} catch {
			return false;
		}
	});
	if (markers.length) parts.push("files=[" + markers.join(", ") + "]");
	if (process.env.KUBECONFIG && fs.existsSync(process.env.KUBECONFIG)) {
		parts.push("kubeconfig=ready");
	}
	return parts.join(" | ");
}
