import { useSyncExternalStore } from "react";

/**
 * 成本显示格式化与货币符号单源（issue #607）。
 *
 * 同时支持两条扩展路径（默认行为 100% 保持 `$` + 4 位小数不变）：
 *   1. 轻量配置货币符号：`setCostCurrencySymbol("¥")` 或写 `localStorage.setItem("pi-web-ui:cost-currency", "¥")`；
 *   2. 插件自定义成本格式化器：`window.__piWebUiHost.setCostFormatter((cost, ctx) => ...)`
 *      （可返回形如 `"¥0.085"` 的字符串，或返回 `{ symbol: "¥", value: "0.085", tooltip?: "..." }`）。
 */

export const COST_CURRENCY_STORAGE_KEY = "pi-web-ui:cost-currency";
export const DEFAULT_COST_CURRENCY_SYMBOL = "$";

export interface CostDisplayParts {
	symbol: string;
	value: string;
	tooltip?: string;
}

export type CostFormatterResult = string | CostDisplayParts;

export type CostFormatter = (cost: number, ctx: { defaultSymbol: string; defaultValue: string }) => CostFormatterResult;

let customFormatter: CostFormatter | null = null;
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
	version += 1;
	// Snapshot the listener set first: a listener may unsubscribe (or subscribe)
	// from inside its own callback, and mutating a Set mid-iteration would skip
	// the next listener.
	// oxlint-disable-next-line unicorn/no-useless-spread -- deliberate snapshot
	for (const fn of [...listeners]) {
		try {
			fn();
		} catch {
			/* ignore listener errors */
		}
	}
}

export function subscribeCostFormat(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function getSnapshotVersion(): number {
	return version;
}

/** 默认数值格式化（不含货币符号）：与 BarItem 历史口径一致。 */
export function formatDefaultCostValue(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "0";
	if (cost < 0.0001) return "<0.0001";
	return cost.toFixed(4).replace(/\.?0+$/, "");
}

/** 读取当前配置的成本货币符号（默认 "$"）。 */
export function getCostCurrencySymbol(): string {
	try {
		if (typeof localStorage !== "undefined") {
			const raw = localStorage.getItem(COST_CURRENCY_STORAGE_KEY);
			if (typeof raw === "string" && raw.trim().length > 0) {
				return raw.trim().slice(0, 8);
			}
		}
	} catch {
		/* ignore storage errors */
	}
	return DEFAULT_COST_CURRENCY_SYMBOL;
}

/** 设置或重置成本货币符号（传空串或 null 恢复默认 "$"）。 */
export function setCostCurrencySymbol(symbol: string | null | undefined): void {
	try {
		if (typeof localStorage !== "undefined") {
			const trimmed = typeof symbol === "string" ? symbol.trim().slice(0, 8) : "";
			if (!trimmed || trimmed === DEFAULT_COST_CURRENCY_SYMBOL) {
				localStorage.removeItem(COST_CURRENCY_STORAGE_KEY);
			} else {
				localStorage.setItem(COST_CURRENCY_STORAGE_KEY, trimmed);
			}
		}
	} catch {
		/* ignore storage errors */
	}
	notify();
}

/** 注册或清除插件自定义成本格式化器；返回取消注册函数。 */
export function registerCostFormatter(formatter: CostFormatter | null): () => void {
	if (typeof formatter !== "function") {
		customFormatter = null;
		notify();
		return () => {};
	}
	customFormatter = formatter;
	notify();
	return () => {
		if (customFormatter === formatter) {
			customFormatter = null;
			notify();
		}
	};
}

/** 将插件返回的字符串（如 "¥0.085" 或 "$0.012"）拆分为 { symbol, value }。 */
function splitFormattedCostString(raw: string, fallbackSymbol: string): CostDisplayParts {
	const text = String(raw ?? "").trim();
	if (!text) return { symbol: fallbackSymbol, value: "0" };
	// 匹配前导非数字货币前缀（排除 "<0.0001" 的 '<' 与负号 '-'）
	const m = text.match(/^([^\d<>+-]+)\s*(.+)$/);
	if (m) {
		return { symbol: m[1], value: m[2] };
	}
	return { symbol: "", value: text };
}

/** 计算给定 cost 的展示结构（symbol + value + 可选 tooltip）。 */
export function formatCostDisplay(cost: number, opts?: { fixedDigits?: number }): CostDisplayParts {
	const safeCost = typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
	const defaultSymbol = getCostCurrencySymbol();
	const defaultValue =
		typeof opts?.fixedDigits === "number" ? safeCost.toFixed(opts.fixedDigits) : formatDefaultCostValue(safeCost);

	if (customFormatter) {
		try {
			const out = customFormatter(safeCost, { defaultSymbol, defaultValue });
			if (typeof out === "string") {
				return splitFormattedCostString(out, defaultSymbol);
			}
			if (out && typeof out === "object" && typeof out.value === "string") {
				return {
					symbol: typeof out.symbol === "string" ? out.symbol : defaultSymbol,
					value: out.value,
					tooltip: typeof out.tooltip === "string" ? out.tooltip : undefined,
				};
			}
		} catch (err) {
			console.error("[cost-format] custom cost formatter threw:", err);
		}
	}

	return { symbol: defaultSymbol, value: defaultValue };
}

/** React Hook：订阅货币符号与插件成本格式化器变化，返回当前成本展示部分。 */
export function useFormattedCost(cost: number, opts?: { fixedDigits?: number }): CostDisplayParts {
	useSyncExternalStore(subscribeCostFormat, getSnapshotVersion, getSnapshotVersion);
	return formatCostDisplay(cost, opts);
}
