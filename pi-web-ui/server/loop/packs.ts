/**
 * 能力模板注册表（Capability Packs）。
 *
 * 模板只携带可安全复用的任务语义，不包含 shell 命令或可执行路径。真正的预检、验收和
 * 产物位置必须由发起者明确填写，避免工作目录或本地文件把任意命令注入 Loop。
 */

export interface CapabilityPack {
	id: string;
	title: string;
	summary: string;
	goal: string;
	criteria: string;
	primaryMetric: string;
	metricDirection: "maximize" | "minimize";
	maxRounds?: number;
	useReviewer?: boolean;
}

const CAPABILITY_PACKS: readonly CapabilityPack[] = Object.freeze([
	Object.freeze({
		id: "inference-perf",
		title: "推理性能（吞吐最大化）",
		summary: "填充吞吐优化目标与 tps 主指标；请在当前工作区明确填写实际验收命令。",
		goal: "优化推理服务的吞吐：在保持正确性不劣化的前提下，尽量提高实测 tps。",
		criteria: "以实际验收命令输出的 HARNESS_METRIC.tps 为唯一主指标，越大越好；正确性不得劣化。",
		primaryMetric: "tps",
		metricDirection: "maximize",
		maxRounds: 6,
		useReviewer: true,
	}),
	Object.freeze({
		id: "cache-loss",
		title: "缓存损耗（损耗率最小化）",
		summary: "填充缓存损耗优化目标与 loss_pct 主指标；请在当前工作区明确填写实际验收命令。",
		goal: "降低缓存命中损耗：在保持正确性不劣化的前提下，尽量压低实测 loss_pct。",
		criteria: "以实际验收命令输出的 HARNESS_METRIC.loss_pct 为唯一主指标，越小越好。",
		primaryMetric: "loss_pct",
		metricDirection: "minimize",
		maxRounds: 6,
		useReviewer: true,
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
