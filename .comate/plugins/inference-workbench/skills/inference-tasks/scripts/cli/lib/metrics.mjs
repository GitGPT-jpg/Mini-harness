/**
 * 指标提取、最优轮次 Checkpoint 与指标门禁（自 dsh-inference-workbench `src/metrics.ts` 原样移植，
 * 其源头是 Mini-harness `loop/metrics.ts`）。纯函数，无宿主依赖。
 *
 * validator 标准输出中可携带结构化指标与场景标记：
 *   - JSON 格式：HARNESS_METRIC: {"ttft_ms": 118.4, "tps": 86.2, "cache_hit": 0.96}
 *   - KV 格式：  HARNESS_METRIC: ttft_ms=118.4 tps=86.2 loss_pct=14.2
 *   - 场景标记：  HARNESS_SCENARIO: ascache-on-vs-radix-off
 *
 * 指标门禁（evaluateMetricGate）把「命令执行成功（exit 0）」与「指标采集成功 + 硬约束满足」分开：
 * 声明了主指标的任务，validator 即便 exit 0，只要没报出主指标 / 数值非法 / 阈值或硬约束不满足，
 * 都不得把该轮当作指标验收通过或最优 Checkpoint。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const METRIC_LINE_RE = /^\s*HARNESS_METRIC\s*:\s*(.+)$/i;
const SCENARIO_LINE_RE = /^\s*HARNESS_SCENARIO\s*:\s*(.+)$/i;
const KV_TOKEN_RE = /([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/gi;

/** 从 validator 输出文本中提取 HARNESS_METRIC 数值指标；无有效数值指标时返回 null。 */
export function parseHarnessMetrics(output) {
	const text = String(output ?? "");
	if (!text) return null;
	const out = {};
	for (const line of text.split(/\r?\n/)) {
		const m = METRIC_LINE_RE.exec(line);
		if (!m) continue;
		const payload = m[1].trim();
		if (payload.startsWith("{")) {
			try {
				const obj = JSON.parse(payload);
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
		let kv;
		while ((kv = KV_TOKEN_RE.exec(payload)) !== null) {
			const num = Number(kv[2]);
			if (Number.isFinite(num)) out[kv[1]] = num;
		}
	}
	return Object.keys(out).length > 0 ? out : null;
}

/** 从 validator 输出中提取 HARNESS_SCENARIO 场景标记；无则 null。 */
export function parseHarnessScenario(output) {
	const text = String(output ?? "");
	for (const line of text.split(/\r?\n/)) {
		const m = SCENARIO_LINE_RE.exec(line);
		if (m) {
			const v = m[1].trim();
			if (v) return v;
		}
	}
	return null;
}

/** 指标优劣得分（越大越好）；声明主指标时只认该指标，缺失返回 null（不猜）。 */
function metricScore(metrics, target) {
	if (!metrics) return null;
	if (target?.metric) {
		const v = metrics[target.metric];
		if (typeof v === "number" && Number.isFinite(v)) return target.direction === "minimize" ? -v : v;
		return null;
	}
	const higher = ["score", "tps", "throughput", "hit_rate", "cache_hit", "speedup"];
	for (const k of higher) {
		if (typeof metrics[k] === "number" && Number.isFinite(metrics[k])) return metrics[k];
	}
	const lower = ["loss_pct", "loss", "ttft_ms", "ttft", "latency_ms", "latency", "error_rate"];
	for (const k of lower) {
		if (typeof metrics[k] === "number" && Number.isFinite(metrics[k])) return -metrics[k];
	}
	const first = Object.values(metrics)[0];
	return typeof first === "number" && Number.isFinite(first) ? first : null;
}

function thresholdSatisfied(v, op, value) {
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

/** 决定本轮是否应更新 bestRound（与 Mini-harness 保持一致）。 */
export function pickBetterRound(current, candidate, target) {
	const hasMetrics = candidate.metrics && Object.keys(candidate.metrics).length > 0;
	const candScore = metricScore(candidate.metrics, target);
	const tolerance = Math.max(0, Number(target?.tolerance) || 0);

	if (target?.metric) {
		if (candScore === null) return current ?? null;
		if (!current) return candidate;
		const curScore = metricScore(current.metrics, target);
		if (curScore === null) return candidate;
		if (candScore > curScore + tolerance) return candidate;
		if (candScore < curScore - tolerance) return current;
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

/** 评估指标门禁：主指标在场 + 目标阈值 + 必要硬约束统一成一道验收门禁。 */
export function evaluateMetricGate(target, constraints, metrics, scenario) {
	const violations = [];
	const reasons = [];
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

/** 读取工作区当前 git HEAD 短 SHA（非 git 仓库返回 null）。 */
export function resolveGitHeadSha(cwd) {
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

/** 轻量前置环境快照（注入执行提示词，让模型免于首轮盲跑探测命令）。 */
export function collectPreflightSummary(workspace) {
	const parts = [];
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
