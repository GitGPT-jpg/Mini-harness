/**
 * 能力模板注册表（Capability Packs）。
 *
 * 模板只携带可安全复用的任务语义与「验收契约」，不包含 shell 命令或可执行路径：
 * 真正的预检 / 验收命令和产物位置由发起者按 validatorInterface / inputs 明确填写，
 * 避免工作目录或本地文件把任意命令注入 Loop。
 *
 * 契约字段与 Loop 运行时的指标门禁（metrics.ts）对齐：
 *  - primaryMetric + metricDirection + metricUnit + metricThreshold + metricScenario + hardConstraints
 *   会原样进入 evaluateMetricGate：validator exit 0 不等于指标达标；缺主指标 / 阈值不满足 /
 *   必要场景不匹配 / 硬约束不满足都会挡下完成态。
 *  - 真实 ASCache 的 on/off 场景、输入长度、命中率、对齐、loss_pct 公式、多轮、精度与稳定性，
 *   全部落在包内声明（scenario / hardConstraints / evidence），不硬编码进通用 Loop。
 */
import type { HardConstraint } from "./metrics.js";

export interface CapabilityPackInput {
	/** 输入项 id（前端表单字段 / 发起者必填键）。 */
	id: string;
	/** 展示名。 */
	label: string;
	/** 是否必填。 */
	required?: boolean;
	/** 填写提示（不含可执行命令）。 */
	hint?: string;
}

export interface CapabilityPack {
	/** 稳定 id（前端 / 协议引用）。 */
	id: string;
	/** 展示名。 */
	name: string;
	/** 语义版本（模板契约版本；升级时递增）。 */
	version: string;
	title: string;
	summary: string;
	goal: string;
	criteria: string;
	/** 主指标名（如 loss_pct / tps）。 */
	primaryMetric: string;
	metricDirection: "maximize" | "minimize";
	/** 主指标单位（如 % / tokens/s / ms）；未声明则口径无法确认。 */
	metricUnit?: string;
	/** 主指标目标阈值（如 { op: "lt", value: 20 } 表示 loss_pct < 20）。 */
	metricThreshold?: { op: "lt" | "lte" | "gt" | "gte"; value: number };
	/** 必要场景配置（声明后 validator 必须报出匹配的 HARNESS_SCENARIO）。 */
	metricScenario?: string;
	/** 必要硬约束（主指标之外的证据门禁：精度 / 稳定性 / 输入长度 / 命中率等）。 */
	hardConstraints?: HardConstraint[];
	/** 发起者必填输入项（不含可执行命令 / 路径）。 */
	inputs: CapabilityPackInput[];
	/** 验收接口说明：发起者据此填写 validateCmd / precheckCmd / artifactRoots。 */
	validatorInterface: {
		validateCmdHint: string;
		precheckCmdHint?: string;
		artifactRootsHint?: string[];
	};
	/** 验收须产出的证据：主指标 + 证据产物清单。 */
	evidence: { metric: string; artifacts: string[] };
	maxRounds?: number;
	useReviewer?: boolean;
	/** 是否默认自动验证（Loop 策略）。 */
	auto?: boolean;
}

const CAPABILITY_PACKS: readonly CapabilityPack[] = Object.freeze([
	Object.freeze({
		id: "inference-perf",
		name: "推理性能（吞吐最大化）",
		version: "1.1.0",
		title: "推理性能（吞吐最大化）",
		summary: "填充吞吐优化目标与 tps 主指标（单位 tokens/s）；请在当前工作区明确填写实际验收命令。",
		goal: "优化推理服务的吞吐：在保持正确性不劣化的前提下，尽量提高实测 tps。",
		criteria: "以实际验收命令输出的 HARNESS_METRIC.tps 为唯一主指标，越大越好；正确性不得劣化（硬约束 acc_drop <= 0.01）。",
		primaryMetric: "tps",
		metricDirection: "maximize",
		metricUnit: "tokens/s",
		hardConstraints: [
			Object.freeze({ name: "正确性不劣化", metric: "acc_drop", op: "lte", value: 0.01 }),
		],
		inputs: [
			Object.freeze({ id: "validateCmd", label: "验收命令", required: true, hint: "真实压测的 --validate 命令，须输出 HARNESS_METRIC.tps" }),
			Object.freeze({ id: "acc_drop", label: "正确性退化上限", hint: "相对基线的精度/正确性退化，默认 0.01" }),
		],
		validatorInterface: Object.freeze({
			validateCmdHint: "真实推理压测的 --validate 命令（须输出 HARNESS_METRIC.tps）",
			precheckCmdHint: "python3 validate.py --precheck",
			artifactRootsHint: ["runs"],
		}),
		evidence: Object.freeze({ metric: "tps", artifacts: ["压测日志", "延迟分位记录"] }),
		maxRounds: 6,
		useReviewer: true,
		auto: true,
	}),
	Object.freeze({
		id: "cache-loss",
		name: "缓存损耗（损耗率最小化）",
		version: "1.1.0",
		title: "缓存损耗（损耗率最小化）",
		summary: "填充缓存损耗优化目标与 loss_pct 主指标（单位 %）；含 on/off 场景、输入长度、命中率、对齐与稳定性硬约束。",
		goal: "降低缓存命中损耗：在保持精度/稳定性不劣化的前提下，尽量压低实测 loss_pct（越小越好）。",
		criteria: "以验收命令输出的 HARNESS_METRIC.loss_pct 为唯一主指标（loss_pct = (1 - 命中率) * 100，越小越好）；必须在 ascache-on-vs-radix-off 两组场景下各跑一遍并报出 HARNESS_SCENARIO；输入长度、命中率、对齐（精度）、稳定性为必要硬约束，缺一不可。",
		primaryMetric: "loss_pct",
		metricDirection: "minimize",
		metricUnit: "%",
		metricThreshold: Object.freeze({ op: "lt", value: 15 }),
		metricScenario: "ascache-on-vs-radix-off",
		hardConstraints: [
			Object.freeze({ name: "输入长度", metric: "input_len", op: "gte", value: 60000 }),
			Object.freeze({ name: "命中率下限", metric: "cache_hit", op: "gte", value: 0.8 }),
			Object.freeze({ name: "精度无退化（对齐）", metric: "acc_drop", op: "lte", value: 0.01 }),
			Object.freeze({ name: "稳定性（多轮方差）", metric: "loss_std", op: "lte", value: 0.5 }),
		],
		inputs: [
			Object.freeze({ id: "validateCmd", label: "验收命令", required: true, hint: "真实 ASCache 的 --validate 命令，须在 on/off 两组场景各跑一遍" }),
			Object.freeze({ id: "input_len", label: "输入长度", hint: "如 60000（token），validator 须报出 HARNESS_METRIC.input_len" }),
			Object.freeze({ id: "cache_hit", label: "命中率下限", hint: "默认 0.8" }),
			Object.freeze({ id: "acc_drop", label: "对齐/精度退化上限", hint: "默认 0.01" }),
			Object.freeze({ id: "loss_std", label: "稳定性方差上限", hint: "默认 0.5" }),
		],
		validatorInterface: Object.freeze({
			validateCmdHint: "真实 ASCache 的 --validate 命令（on/off 两组场景，输出 HARNESS_METRIC.loss_pct 与 HARNESS_SCENARIO）",
			precheckCmdHint: "python3 validate.py --precheck",
			artifactRootsHint: ["runs"],
		}),
		evidence: Object.freeze({
			metric: "loss_pct",
			artifacts: ["loss_pct 公式记录", "on/off 场景对比日志", "命中率采样", "输入长度与对齐记录", "多轮稳定性记录"],
		}),
		maxRounds: 6,
		useReviewer: true,
		auto: true,
	}),
]);

/** 返回受服务端源码控制的能力模板（按 id 稳定排序）。 */
export function listCapabilityPacks(): CapabilityPack[] {
	return CAPABILITY_PACKS.map((pack) => ({ ...pack }));
}

export function resolvePack(id: string): CapabilityPack | null {
	if (!id) return null;
	return CAPABILITY_PACKS.find((pack) => pack.id === id) ?? null;
}
