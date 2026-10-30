/**
 * 用户输入的 token 数量字符串解析与回显格式化（纯函数，单测覆盖）。
 *
 * 支持：
 * - "300k" / "300K" -> 300,000
 * - "1.5m" / "1.5M" -> 1,500,000
 * - "300,000" / "300_000" -> 300,000
 * - "300000" -> 300,000
 * - 纯数字 <= 1000（如 300、128、64）：智能识别为 K tokens（300 -> 300,000）
 * - 空串 / 0 / 非法：返回 0
 */

export function parseTokenInput(v: unknown): number {
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

/**
 * 格式化 token 数量为用户可读的输入回显（如 300000 -> "300k", 1000000 -> "1M"）。
 * 0 或空返回 ""。
 */
export function formatTokenDraft(n: number | null | undefined): string {
	if (!n || n <= 0 || !Number.isFinite(n)) return "";
	if (n >= 1_000_000 && n % 100_000 === 0) {
		return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (n >= 1_000 && n % 1_000 === 0) {
		return `${n / 1_000}k`;
	}
	return String(n);
}
