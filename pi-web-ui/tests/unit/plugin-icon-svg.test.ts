/**
 * 插件内联 SVG 图标（iconSvg）单测：
 * server/icon-svg.ts 的 normalizeIconSvg（形状校验）+ web/src/plugin-icon.tsx 的
 * sanitizeIconSvg（node 下走正则快检分支）+ vscode-editor 真实图标能过两道门。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeIconSvg, MAX_ICON_SVG_LENGTH } from "../../server/icon-svg.js";
import { isAllowedIconAttr, isAllowedIconTag, sanitizeIconSvg } from "../../web/src/plugin-icon.js";

const SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="0.5" y="0.5" width="15" height="15" rx="3.5" fill="#007ACC"/></svg>';

describe("normalizeIconSvg", () => {
	it("合法 svg 原样保留", () => {
		expect(normalizeIconSvg(SVG)).toBe(SVG);
	});
	it("首尾空白被 trim", () => {
		expect(normalizeIconSvg(`\n  ${SVG}  `)).toBe(SVG);
	});
	it("非 svg / 空 / 非字符串拒绝", () => {
		expect(normalizeIconSvg("📝")).toBeUndefined();
		expect(normalizeIconSvg("<div>x</div>")).toBeUndefined();
		expect(normalizeIconSvg("")).toBeUndefined();
		expect(normalizeIconSvg(undefined)).toBeUndefined();
		expect(normalizeIconSvg(123)).toBeUndefined();
	});
	it("缺闭合标签拒绝（防截断）", () => {
		expect(normalizeIconSvg('<svg viewBox="0 0 16 16"><rect/>')).toBeUndefined();
	});
	it("script / 事件处理器 / javascript: 拒绝", () => {
		expect(normalizeIconSvg(SVG.replace("</svg>", "<script>alert(1)</script></svg>"))).toBeUndefined();
		expect(normalizeIconSvg(SVG.replace("<rect", '<rect onclick="x"'))).toBeUndefined();
		expect(normalizeIconSvg(SVG.replace("<rect", '<rect fill="javascript:alert(1)"'))).toBeUndefined();
	});
	it("超长拒绝", () => {
		expect(normalizeIconSvg(`<svg>${"x".repeat(MAX_ICON_SVG_LENGTH)}</svg>`)).toBeUndefined();
	});
});

describe("sanitizeIconSvg", () => {
	it("合法 svg 通过", () => {
		expect(sanitizeIconSvg(SVG)).toBe(SVG);
	});
	it("恶意内容拒绝", () => {
		expect(sanitizeIconSvg("📝")).toBeNull();
		expect(sanitizeIconSvg(SVG.replace("</svg>", "<script>alert(1)</script></svg>"))).toBeNull();
	});
});

/** 白名单口径（大小写不敏感）：这两个函数是 `viewBox` 被静默剥掉那次的根因所在 ——
 *  白名单键按 SVG 原始大小写书写，比较时必须归一，否则 DOMParser 解析出的
 *  `viewBox` / `clipPath` / `linearGradient` 永远匹配不上（DOM 分支的实测见
 *  tests/unit/plugin-icon-dom.test.ts）。 */
describe("iconSvg 白名单口径", () => {
	it("大小写敏感的标签 / 属性放行（原名或全小写都认）", () => {
		expect(isAllowedIconAttr("viewBox")).toBe(true);
		expect(isAllowedIconAttr("viewbox")).toBe(true);
		expect(isAllowedIconAttr("gradientUnits")).toBe(true);
		expect(isAllowedIconAttr("gradientTransform")).toBe(true);
		expect(isAllowedIconAttr("stroke-width")).toBe(true);
		expect(isAllowedIconTag("clipPath")).toBe(true);
		expect(isAllowedIconTag("clippath")).toBe(true);
		expect(isAllowedIconTag("linearGradient")).toBe(true);
		expect(isAllowedIconTag("radialGradient")).toBe(true);
		expect(isAllowedIconTag("path")).toBe(true);
	});

	it("表外的标签 / 属性（含事件处理器）一律拒绝", () => {
		expect(isAllowedIconAttr("onclick")).toBe(false);
		expect(isAllowedIconAttr("onLoad")).toBe(false);
		expect(isAllowedIconAttr("onmouseover")).toBe(false);
		expect(isAllowedIconTag("script")).toBe(false);
		expect(isAllowedIconTag("foreignObject")).toBe(false);
		expect(isAllowedIconTag("image")).toBe(false);
		expect(isAllowedIconTag("iframe")).toBe(false);
	});
});

describe("vscode-editor 真实图标", () => {
	const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const manifest = JSON.parse(readFileSync(join(root, "plugins", "vscode-editor", "manifest.json"), "utf8")) as {
		iconSvg?: string;
	};
	const catalog = JSON.parse(readFileSync(join(root, "plugins", "catalog.json"), "utf8")) as {
		id: string;
		iconSvg?: string;
	}[];
	const entry = catalog.find((e) => e.id === "vscode-editor");
	it("manifest 与 catalog 都有 iconSvg 且两道校验都过", () => {
		expect(manifest.iconSvg).toBeTruthy();
		expect(entry?.iconSvg).toBe(manifest.iconSvg);
		expect(normalizeIconSvg(manifest.iconSvg)).toBe(manifest.iconSvg);
		expect(sanitizeIconSvg(manifest.iconSvg)).toBeTruthy();
	});
});
