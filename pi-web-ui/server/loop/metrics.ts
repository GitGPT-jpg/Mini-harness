/**
 * 推理与性能任务指标提取、最优轮次 Checkpoint 与前置探测（D-12c 方向二）。
 *
 * validator 标准输出中可携带一行或多行结构化指标：
 *   - JSON 格式：HARNESS_METRIC: {"ttft_ms": 118.4, "tps": 86.2, "cache_hit": 0.96}
 *   - KV 格式：  HARNESS_METRIC: ttft_ms=118.4 tps=86.2 loss_pct=14.2
 *
 * 运行时自动解析数值指标落盘到 history[i].metrics 与 st.lastMetrics，
 * 并基于通过态（或指标得分）维护 st.bestRound（含轮次、commitSha、metrics），
 * 防止多轮迭代改坏已跑通或性能更优的版本。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type HarnessMetrics = Record<string, number>;

export interface BestRoundRecord {
	round: number;
	verdict: string;
	commitSha: string | null;
	/** 可恢复的代码快照引用（git 快照 ref / 目录快照路径）；无则 null。 */
	snapshotRef?: string | null;
	metrics?: HarnessMetrics;
	at: string;
}

const METRIC_LINE_RE = /^\s*HARNESS_METRIC\s*:\s*(.+)$/i;
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

/** 任务声明的「主指标 + 优化方向 + 精度」硬约束（可选）。 */
export interface MetricTarget {
	/** 主指标名（如 loss_pct / tps / ttft_ms）。声明后比较只认它，不再按名字猜。 */
	metric: string;
	/** 优化方向：maximize（越大越好）/ minimize（越小越好）。 */
	direction: "maximize" | "minimize";
	/** 精度/硬约束（如数值精度、目标阈值），仅记录展示，不参与择优。 */
	precision?: number;
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

/**
 * 决定本轮是否应更新 bestRound：
 * 1. 尚无 bestRound：未声明主指标时只要本轮 pass 或带有效指标即可记录；声明主指标时必须报出该指标；
 * 2. 已有 bestRound 为 fail 而本轮为 pass：必更新；
 * 3. 本轮为 fail 而已有 bestRound 为 pass：绝不覆盖；
 * 4. 同为 pass（或同为 fail）：若双方都有指标，得分更高（或持平但更新）时更新；无指标时取最新 pass。
 *    target 声明了主指标时，比较只认主指标与方向；否则回退旧启发。
 */
export function pickBetterRound(
	current: BestRoundRecord | null | undefined,
	candidate: BestRoundRecord,
	target?: MetricTarget | null,
): BestRoundRecord | null {
	const hasMetrics = candidate.metrics && Object.keys(candidate.metrics).length > 0;
	const candScore = metricScore(candidate.metrics, target);
	if (!current) {
		if (target?.metric) return candScore !== null ? candidate : null;
		return candidate.verdict === "pass" || hasMetrics ? candidate : null;
	}
	const curPass = current.verdict === "pass";
	const candPass = candidate.verdict === "pass";
	if (candPass && !curPass) return candidate;
	if (!candPass && curPass) return current;
	const curScore = metricScore(current.metrics, target);
	if (target?.metric) {
		if (candScore === null) return current;
		if (curScore === null) return candidate;
		return candScore >= curScore ? candidate : current;
	}
	if (curScore !== null && candScore !== null) {
		return candScore >= curScore ? candidate : current;
	}
	if (candScore !== null && curScore === null) return candidate;
	if (candPass) return candidate;
	return current;
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
		if (branch) parts.push(`git=${branch}${sha ? `@${sha}` : ""}`);
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
	if (markers.length) parts.push(`files=[${markers.join(", ")}]`);
	if (process.env.KUBECONFIG && fs.existsSync(process.env.KUBECONFIG)) {
		parts.push("kubeconfig=ready");
	}
	return parts.join(" | ");
}
