// @vitest-environment jsdom
/**
 * 插件内联 SVG 图标（iconSvg）单测 —— **真实 DOM 分支**。
 *
 * 为什么单独一个文件：`sanitizeIconSvg` 走哪条路取决于 `typeof DOMParser`。
 * `tests/unit/plugin-icon-svg.test.ts` 跑在 node 环境（无 DOMParser）→ 只覆盖正则快检
 * 分支，**白名单剥离逻辑一行都没跑过**；这正是 `viewBox` 被静默剥掉却没人发现的原因
 * （bug 现场：DOMParser 解析出的属性名保留原文 `viewBox`，过滤代码却拿
 * `attr.name.toLowerCase()` 去比白名单里带大写的键 → 永不匹配 → 属性删除；
 * 没有 viewBox 的 SVG 不再做坐标映射，24×24 的图标按 1 单位 = 1px 画进 1em 的容器，
 * 只剩左上角一块，CSS 怎么调都对不上）。
 *
 * jsdom 提供真的 DOMParser + XMLSerializer，所以这里锁的就是浏览器里跑的那段代码。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeIconSvg } from "../../server/icon-svg.js";
import { isAllowedIconAttr, isAllowedIconTag, sanitizeIconSvg } from "../../web/src/plugin-icon.js";

const ICON_24 =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>';

describe("sanitizeIconSvg（jsdom：DOM 分支）", () => {
	it("合法图标原样保留（含大小写敏感属性 viewBox）", () => {
		const out = sanitizeIconSvg(ICON_24);
		expect(out).toBeTruthy();
		expect(out).toContain('viewBox="0 0 24 24"');
		expect(out).toContain('stroke-width="2"');
		expect(out).toContain("<path");
	});

	it("大小写敏感标签与属性不被剥掉（clipPath / linearGradient / gradientUnits）", () => {
		const icon =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
			'<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="16" y2="0">' +
			'<stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
			'<clipPath id="c"><rect x="0" y="0" width="8" height="8"/></clipPath>' +
			'<rect x="0" y="0" width="16" height="16" clip-path="url(#c)" fill="url(#g)"/></svg>';
		const out = sanitizeIconSvg(icon) ?? "";
		expect(out).toContain("<clipPath");
		expect(out).toContain("<linearGradient");
		expect(out).toContain("gradientUnits");
		expect(out).toContain('clip-path="url(#c)"');
	});

	it("事件处理器 / script / foreignObject 仍然拦（安全口径不放松）", () => {
		const withHandler = ICON_24.replace("<path", '<path onclick="alert(1)"');
		expect(sanitizeIconSvg(withHandler)).not.toContain("onclick");

		const withScript = ICON_24.replace("</svg>", "<script>alert(1)</script></svg>");
		expect(sanitizeIconSvg(withScript)).not.toContain("<script");

		const withForeign = ICON_24.replace(
			"</svg>",
			'<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject></svg>',
		);
		const out = sanitizeIconSvg(withForeign) ?? "";
		expect(out).not.toContain("foreignObject");
		expect(out).not.toContain("<div");
	});

	it("javascript: 协议的值被剥掉", () => {
		const out = sanitizeIconSvg(ICON_24.replace("<path", '<path fill="javascript:alert(1)"')) ?? "";
		expect(out).not.toContain("javascript:");
	});

	it("vscode-editor 真实图标（manifest / catalog 同串）过 sanitize 后仍带 viewBox", () => {
		const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
		const manifest = JSON.parse(readFileSync(join(root, "plugins", "vscode-editor", "manifest.json"), "utf8")) as {
			iconSvg?: string;
		};
		const catalog = JSON.parse(readFileSync(join(root, "plugins", "catalog.json"), "utf8")) as {
			id: string;
			iconSvg?: string;
		}[];
		const entry = catalog.find((e) => e.id === "vscode-editor");
		// 这是本次回归的现场：manifest 与 catalog 必须是同一串，且 viewBox 必须活下来。
		// 改图标时若换了 viewBox 坐标系（16 → 24），下面这条断言仍成立，界面尺寸也不会再歪。
		expect(entry?.iconSvg).toBe(manifest.iconSvg);
		const out = sanitizeIconSvg(manifest.iconSvg) ?? "";
		expect(out).toMatch(/viewBox="0 0 24 24"/);
	});
});

/**
 * 内置插件统一线条图标（feather / lucide 风格：`stroke=currentColor` + `fill=none`）。
 * 一个插件忘加 `iconSvg`（回落到 emoji）或塞回彩色方块，界面上立刻就不是一套；
 * 而 iconSvg 缺 `viewBox` 又会被渲染成“被裁一半”的老毛病（见本文件顶部的回归说明）。
 * 四条一起锁：都有、都合法、都带 viewBox、catalog 与 manifest 同一串。
 *
 * 豁免表：用户点名要的实心填充图标不受“线条风格”约束（只锁跟随主题色），
 * 新增豁免必须在这里写明理由。
 */
/** 填充图标豁免：notes（用户指定的 iconfont 实心笔记本图标，2026-09）。 */
const FILLED_ICON_EXEMPTIONS = new Set(["notes"]);
describe("内置插件统一线条图标", () => {
	const pluginsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins");
	const dirs = readdirSync(pluginsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(pluginsDir, d.name, "manifest.json")))
		.map((d) => d.name);
	const manifests = dirs.map((dir) => ({
		dir,
		manifest: JSON.parse(readFileSync(join(pluginsDir, dir, "manifest.json"), "utf8")) as {
			id?: string;
			icon?: string;
			iconSvg?: string;
		},
	}));
	const catalog = JSON.parse(readFileSync(join(pluginsDir, "catalog.json"), "utf8")) as {
		id: string;
		icon?: string;
		iconSvg?: string;
	}[];

	it("每个内置插件都声明了 iconSvg（不再只靠 emoji）", () => {
		expect(manifests.filter((m) => !m.manifest.iconSvg).map((m) => m.dir)).toEqual([]);
	});

	it("每个 iconSvg 都过服务端校验，且 sanitize 后带 viewBox + 是线条风格", () => {
		for (const { dir, manifest } of manifests) {
			const raw = manifest.iconSvg ?? "";
			expect(normalizeIconSvg(raw), `${dir}: 过 server 校验`).toBeTruthy();
			const out = sanitizeIconSvg(raw) ?? "";
			expect(out, `${dir}: viewBox 必须活下来`).toContain('viewBox="');
			if (FILLED_ICON_EXEMPTIONS.has(dir)) {
				// 填充图标豁免：只锁“填充跟文字色”（深浅主题都可见），不锁线条描边。
				expect(out, `${dir}: 填充跟文字色`).toContain('fill="currentColor"');
			} else {
				expect(out, `${dir}: 线条描边跟文字色`).toContain('stroke="currentColor"');
				expect(out, `${dir}: 无填充`).toContain('fill="none"');
			}
			// emoji 保留为回落（iconSvg 缺失/被过滤时才会用到）
			expect(manifest.icon, `${dir}: emoji 回落`).toBeTruthy();
		}
	});

	it("catalog 条目与插件 manifest 的 iconSvg 完全一致（同一串）", () => {
		for (const entry of catalog) {
			const m = manifests.find((x) => x.dir === entry.id || x.manifest.id === entry.id);
			if (!m) continue; // 目录里没有的条目（尚未 vendored）不参与一致性检查
			expect(entry.iconSvg, `catalog:${entry.id}`).toBe(m.manifest.iconSvg);
		}
	});

	it("catalog 里有 iconSvg 的条目也得是线条风格", () => {
		for (const entry of catalog) {
			if (!entry.iconSvg) continue;
			const out = sanitizeIconSvg(entry.iconSvg) ?? "";
			if (FILLED_ICON_EXEMPTIONS.has(entry.id)) {
				expect(out, `catalog:${entry.id}`).toContain('fill="currentColor"');
			} else {
				expect(out, `catalog:${entry.id}`).toContain('stroke="currentColor"');
			}
		}
	});

	/** 回归：白名单漏一个属性就是“图标静默缺一块”（`points` 漏了 polyline 整个不渲染
	 *  —— run-trace 的图标当时就是空白；`ry` 漏了椭圆/圆角矩形不画）。
	 *  这里把每个内置图标的标签/属性逐个过白名单，漏了就点名。 */
	it("白名单必须覆盖所有内置图标用到的标签 / 属性", () => {
		const missing: string[] = [];
		const check = (who: string, svg: string) => {
			const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
			const walk = (el: Element) => {
				if (!isAllowedIconTag(el.tagName.toLowerCase())) missing.push(`${who}: 标签 <${el.tagName}>`);
				for (const attr of el.attributes) {
					if (!isAllowedIconAttr(attr.name)) missing.push(`${who}: 属性 ${attr.name}`);
				}
				for (const child of el.children) walk(child);
			};
			walk(doc.documentElement);
		};
		for (const { dir, manifest } of manifests) if (manifest.iconSvg) check(dir, manifest.iconSvg);
		for (const entry of catalog) if (entry.iconSvg) check(`catalog:${entry.id}`, entry.iconSvg);
		expect(missing).toEqual([]);
	});

	it("sanitize 后不丢任何几何属性（points / ry 等）", () => {
		const runTrace = manifests.find((m) => m.dir === "run-trace")?.manifest.iconSvg ?? "";
		expect(runTrace).toContain("polyline");
		expect(sanitizeIconSvg(runTrace) ?? "").toContain("points=");
		const dbClient = manifests.find((m) => m.dir === "db-client")?.manifest.iconSvg ?? "";
		expect(sanitizeIconSvg(dbClient) ?? "").toContain('ry="');
	});
});
