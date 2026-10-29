/**
 * `shell.openExternal` 前的 scheme allowlist（desktop 专用纯函数，无 Electron 依赖，方便单测）。
 *
 * 背景：`desktop/main.ts` 的 `setWindowOpenHandler` 与 `will-navigate` 曾把任何
 * 非应用 origin 的 URL 直接丢给 `shell.openExternal`，恶意 Markdown 链接
 *（`file:` / `javascript:` / 自定义协议）可触发本地协议处理器。两处调用点现
 * 在都经 `isAllowedExternalUrl` 先验 scheme，不在表里的直接 deny + 日志。
 *
 * 表的口径与 `web/src/components/Markdown.tsx` 的 `MdLink` 一致：`http(s):` +
 * 它已当外链处理的 `mailto:` / `tel:`。`ftp:` 等不在表里 —— 有需要再加。
 */
export const ALLOWED_EXTERNAL_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:", "tel:"]);

/** 待打开的 URL 是否在 allowlist 里。解析失败一律 false（安全 deny）。 */
export function isAllowedExternalUrl(raw: string): boolean {
	const s = raw.trim();
	if (!s) return false;
	try {
		return ALLOWED_EXTERNAL_SCHEMES.has(new URL(s).protocol);
	} catch {
		return false;
	}
}
