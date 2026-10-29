/**
 * 插件内联 SVG 图标（manifest.json `iconSvg` / catalog `iconSvg`）的校验与规范化。
 *
 * 为什么是纯函数独立模块：
 *   - server/plugins.ts 与 server/plugin-catalog.ts 都要用；normalize 放 plugins.ts
 *     里会形成循环依赖（plugins.ts 已 import plugin-catalog.ts）。
 *   - 前端另有一份 sanitize（web/src/plugin-icon.tsx）：服务端只做形状校验与长度
 *     截断（入库前），渲染前的前端 sanitize 负责真正的 XSS 过滤（去 script/on*）。
 */

/** iconSvg 上限：16px 展示位，正常图标 <2KB；超了直接拒掉（不是截断，截断会断标签）。 */
export const MAX_ICON_SVG_LENGTH = 8192;

/**
 * 校验并规范化内联 SVG 图标；非法返回 undefined。
 * 接受：以 `<svg` 开头（含 `<?xml` 前导也认）、`</svg>` 结尾、不含 `<script`、
 * 不含行内事件处理器（`on*=`) 的字符串。返回 trim 后的原文（不改写内容）。
 */
export function normalizeIconSvg(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const s = raw.trim();
	if (!s || s.length > MAX_ICON_SVG_LENGTH) return undefined;
	const body = s.startsWith("<?xml") ? s.slice(s.indexOf("?>") + 2).trimStart() : s;
	if (!/^<svg[\s>]/.test(body)) return undefined;
	if (!/<\/svg\s*>\s*$/.test(body)) return undefined;
	if (/<script[\s>]/i.test(body)) return undefined;
	if (/\son\w+\s*=/i.test(body)) return undefined;
	if (/javascript\s*:/i.test(body)) return undefined;
	return s;
}
