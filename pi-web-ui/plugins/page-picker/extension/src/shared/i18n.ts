/**
 * 安全的 i18n 辅助函数：
 * - 在扩展环境中优先使用 `chrome.i18n.getMessage`
 * - 在 Node.js 测试环境或没有 chrome 的环境下优雅回退到 fallback
 * - 简单处理替换参数（支持 $1、$2... 或占位符）
 */
export function getMessage(key: string, substitutions?: string | string[], fallback?: string): string {
	try {
		if (typeof chrome !== "undefined" && chrome?.i18n?.getMessage) {
			const msg = chrome.i18n.getMessage(key, substitutions);
			if (msg) return msg;
		}
	} catch {
		// 忽略任何环境异常
	}
	if (fallback !== undefined) {
		if (substitutions) {
			const arr = Array.isArray(substitutions) ? substitutions : [substitutions];
			return fallback.replace(/\$(\d+)/g, (_, n) => arr[Number(n) - 1] ?? "");
		}
		return fallback;
	}
	return "";
}
