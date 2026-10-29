/**
 * 自定义上下文压缩阈值（Soft Cap，issue #229）。
 *
 * 背景：SDK 的自动压缩只看物理上限（shouldCompact：tokens > window - reserveTokens，
 * reserveTokens 默认 16384）。对 1M 上下文的模型会堆到 ~900K 才压；对 Grok 这类
 * 200K 起阶梯翻倍计费的模型，会在高价区跑很久，还伴随长上下文降智。
 *
 * 实现：软上限 C 转成 reserveTokens = W - C，经
 * session.settingsManager.applyOverrides({ compaction: { reserveTokens } })
 * 注入（与重试次数覆盖同一 live 机制，reload/建会话/换模型后重放）。
 * 关掉软上限时回填 SDK 默认（DEFAULT_COMPACTION_SETTINGS.reserveTokens），
 * 不让旧覆盖泄漏。
 */
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";

/** SDK 默认保留 token（软上限关闭时的回填值）。 */
export const DEFAULT_COMPACTION_RESERVE_TOKENS = DEFAULT_COMPACTION_SETTINGS.reserveTokens;

/** 软上限下限（tokens）：低于此值每轮都压，无意义，直接视为关闭。 */
export const SOFT_CAP_MIN_TOKENS = 2000;
/** 压缩后至少要剩这么多工作空间（摘要本身也要占 reserve*0.8 的预算）。 */
export const SOFT_CAP_MIN_HEADROOM = 2048;
/** 单客户端最多存多少条按模型覆盖（防手滑粘贴刷爆 client-state）。 */
export const SOFT_CAP_MAX_OVERRIDES = 64;

/** 归一化全局软上限：支持数字或带单位字符串（如 "300k", "1.5m", "300,000"）；
 *  <= 1000 的正数智能识别为 K tokens（如 300 -> 300,000）；<=0 或非法 = 关闭；
 *  钳制到 [0, 10_000_000] 整数。纯函数。 */
export function normalizeSoftCapTokens(v: unknown): number {
	if (v === null || v === undefined) return 0;
	if (typeof v === "number") {
		if (!Number.isFinite(v) || v <= 0) return 0;
		const n = Math.floor(v);
		if (n <= 1000) return n * 1000;
		return Math.min(10_000_000, n);
	}
	const s = String(v)
		.trim()
		.toLowerCase()
		.replace(/[,_\s]/g, "");
	if (!s) return 0;
	const m = s.match(/^(\d+(?:\.\d+)?)([km])?$/);
	if (!m) return 0;
	const num = parseFloat(m[1]);
	if (!Number.isFinite(num) || num <= 0) return 0;
	const unit = m[2];
	let tokens: number;
	if (unit === "k") {
		tokens = Math.floor(num * 1_000);
	} else if (unit === "m") {
		tokens = Math.floor(num * 1_000_000);
	} else {
		tokens = Math.floor(num);
		if (tokens <= 1000) tokens *= 1000;
	}
	return Math.min(10_000_000, Math.max(0, tokens));
}

/** 归一化按模型覆盖：key = "provider/id" 非空（≤200 字），value 走
 *  normalizeSoftCapTokens；0 值条目丢弃（= 用全局）；上限 64 条。纯函数。 */
export function normalizeSoftCapByModel(v: unknown): Record<string, number> {
	if (!v || typeof v !== "object" || Array.isArray(v)) return {};
	const out: Record<string, number> = {};
	for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
		if (Object.keys(out).length >= SOFT_CAP_MAX_OVERRIDES) break;
		const key = String(k).trim();
		if (!key || key.length > 200) continue;
		const n = normalizeSoftCapTokens(val);
		if (n > 0) out[key] = n;
	}
	return out;
}

/** 当前模型的生效软上限（0 = 关闭）：按模型覆盖优先于全局。 */
export function effectiveSoftCap(
	globalCap: number,
	byModel: Record<string, number> | undefined,
	modelId: string | null | undefined,
): number {
	if (modelId) {
		const per = byModel?.[modelId.trim()];
		if (per !== undefined && per > 0) return per;
	}
	return globalCap > 0 ? globalCap : 0;
}

/** 软上限 → SDK reserveTokens（null = 不合法/关闭，走 SDK 默认）。
 *  合法条件：cap ≥ SOFT_CAP_MIN_TOKENS 且压完至少剩 SOFT_CAP_MIN_HEADROOM。 */
export function softCapToReserve(contextWindow: number, cap: number): number | null {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
	if (!Number.isFinite(cap) || cap < SOFT_CAP_MIN_TOKENS) return null;
	const reserve = Math.floor(contextWindow - cap);
	if (reserve < SOFT_CAP_MIN_HEADROOM) return null;
	return reserve;
}
