/**
 * format-bytes.ts — 字节大小格式化纯函数。
 */

/**
 * 将字节数格式化为人类可读的字符串（B / KB / MB / GB）。
 * undefined 或非有限数值返回 ""。
 */
export function formatBytes(bytes?: number | null, decimals = 1): string {
	if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(decimals)} KB`;
	}
	if (bytes < 1024 * 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(decimals)} MB`;
	}
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(decimals)} GB`;
}

/**
 * 整数 KB 格式化（与 FilePreview / Message 保持 100% 对齐：KB 四舍五入为整数，MB 保留 1 位小数）。
 */
export function formatSize(bytes?: number | null): string {
	if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return "";
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}
