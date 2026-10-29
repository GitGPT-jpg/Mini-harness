/**
 * 语义色实底前景可读性体检（issue：绿/红/黄/蓝底上的白字几乎看不见）。
 *
 * 背景：状态徽标、goalbar 状态 chip、下载/复制图标反馈、上传发送按钮都是用
 * 「语义色实底 + 前景色」画的，前景在 CSS 里写死 `#fff`。但语义色在主题里普遍偏亮：
 * 默认主题 `--amber #fbbf24` 白字只有 1.67:1、`--green #34d399` 1.92:1、
 * `--red #f87171` 2.77:1；亮色主题更糟（catppuccin 的 `--amber #f9e2af` 1.27:1）。
 *
 * 正确写法：前景取 `--on-green / --on-red / --on-amber / --on-blue /
 * --on-send-blue / --on-stop-red`（styles.css `:root` 给默认值，主题按调色板覆盖）。
 *
 * 本测试是**静态**体检（零端口、零浏览器，CI 必跑），两道关：
 *   1. 每套主题：6 个 `--on-*` 令牌在各自语义色实底上对比度 >= 3.0（灾难性地板）；
 *   2. styles.css 与所有内置插件：不得出现「语义色实底 + 硬编码白字」。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const THEMES_DIR = join(ROOT, "themes");
const PLUGINS_DIR = join(ROOT, "plugins");
const STYLES_PATH = join(ROOT, "web", "src", "styles.css");

/** 灾难性不可读的地板（与 accent-contrast / theme-inline-code 同口径）。 */
const MIN_RATIO = 3.0;

/** 语义色 → 实底上前景令牌 */
const PAIRS = [
	{ base: "--green", token: "--on-green" },
	{ base: "--red", token: "--on-red" },
	{ base: "--amber", token: "--on-amber" },
	{ base: "--blue", token: "--on-blue" },
	{ base: "--send-blue", token: "--on-send-blue" },
	{ base: "--stop-red", token: "--on-stop-red" },
];

// ---------------------------------------------------------------- 颜色工具

function parseHex(value: string | null | undefined): [number, number, number] | null {
	const m = /^#([0-9a-f]{6})$/i.exec((value ?? "").trim());
	if (!m) return null;
	const n = parseInt(m[1]!, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: [number, number, number]): number {
	const ch = [r, g, b].map((v) => v / 255).map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
	return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi! + 0.05) / (lo! + 0.05);
}

/** 从 CSS 文本里取某个十六进制令牌值（同名多次声明取第一次）。 */
function tokenValue(css: string, token: string): string | null {
	const m = new RegExp(token.replace(/[-]/g, "\\-") + "\\s*:\\s*(#[0-9a-fA-F]{6})\\b").exec(css);
	return m ? m[1]! : null;
}

// ---------------------------------------------------------------- 静态扫描

const WHITE_DECL = /(?:^|[\s;])color\s*:\s*(#fff(?:fff)?|white)\s*(?:!important)?\s*(?=;|$)/i;
const SEM_BG = /var\(--(green|red|amber|blue|send-blue|stop-red)\s*(?:,[^)]*)?\)/;

/** 取片段里最后一条 background 声明的值（层叠最后一条生效）。 */
function lastBackground(fragment: string): string | null {
	let last: string | null = null;
	for (const m of fragment.matchAll(/(?:^|[\s;])background(?:-color)?\s*:\s*([^;]+)/gi)) last = m[1]!;
	return last;
}

/** 该片段是否「语义色（或语义色半透明染色）作底 + 硬编码白字」。 */
function findViolations(text: string): string[] {
	const bad: string[] = [];
	const check = (where: string, body: string) => {
		const bg = lastBackground(body);
		if (!bg) return;
		const m = SEM_BG.exec(bg);
		if (!m) return;
		if (/-soft/.test(bg)) return;
		const fg = WHITE_DECL.exec(body);
		if (!fg) return;
		bad.push(`${where} → background: ${bg.trim()} 配 color: ${fg[1]}（应为 var(--on-${m[1]})）`);
	};
	for (const m of text.matchAll(/([^{}\n;]{1,400})\{([^{}]{0,6000})\}/g))
		check(`块 ${m[1]!.trim().replace(/\s+/g, " ").slice(-50)}`, m[2]!);
	for (const m of text.matchAll(/(style\s*=\s*)(["'])([^"']{0,4000})\2/g)) check("内联 style", m[3]!);
	for (const m of text.matchAll(/(cssText\s*\+?=\s*)(`)([^`]{0,4000})\2/g)) check("cssText", m[3]!);
	return bad;
}

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "vendor" || entry.startsWith(".")) continue;
		const p = join(dir, entry);
		const st = statSync(p);
		if (st.isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

// ---------------------------------------------------------------- 用例

describe("语义色实底的前景对比度", () => {
	const stylesCss = readFileSync(STYLES_PATH, "utf8");
	const themeFiles = readdirSync(THEMES_DIR).filter((f) => f.endsWith(".css"));
	const cases = themeFiles.map((file) => ({ file, css: readFileSync(join(THEMES_DIR, file), "utf8") }));

	it("扫描到了足够多的主题（防止解析器失效后静默全跳过）", () => {
		expect(cases.length).toBeGreaterThanOrEqual(20);
	});

	for (const { file, css } of cases) {
		for (const { base, token } of PAIRS) {
			const baseHex = tokenValue(css, base) ?? tokenValue(stylesCss, base);
			const onHex = tokenValue(css, token) ?? tokenValue(stylesCss, token);
			it(`${file}: ${token} 在 ${base} 上可读（>= ${MIN_RATIO}:1）`, () => {
				const bg = parseHex(baseHex);
				const fg = parseHex(onHex);
				expect(bg, `${file} 缺失 ${base}`).toBeTruthy();
				expect(fg, `${file} 缺失 ${token}`).toBeTruthy();
				const ratio = contrast(fg!, bg!);
				expect(
					ratio,
					`${file} 的 ${token}（${onHex}）在 ${base}（${baseHex}）上只有 ${ratio.toFixed(2)}:1 —— ` +
						`状态徽标 / 按钮会看不清字；请给这套主题声明对比度足够的 ${token}。`,
				).toBeGreaterThanOrEqual(MIN_RATIO);
			});
		}
	}

	it("宿主 styles.css 不再出现「语义色实底 + 硬编码白字」", () => {
		const bad = findViolations(stylesCss);
		expect(bad, `styles.css 违规：\n${bad.join("\n")}`).toEqual([]);
	});

	it("内置插件不再出现「语义色实底 + 硬编码白字」", () => {
		const files = walk(PLUGINS_DIR).filter((f) => /\.(mjs|js|cjs|css)$/.test(f));
		expect(files.length).toBeGreaterThan(50);
		const bad: string[] = [];
		for (const f of files) {
			if (statSync(f).size > 4_000_000) continue;
			const text = readFileSync(f, "utf8");
			if (!/var\(--(green|red|amber|blue|send-blue|stop-red)/.test(text)) continue;
			const rel = relative(ROOT, f).replace(/\\/g, "/");
			for (const v of findViolations(text)) bad.push(`${rel}: ${v}`);
		}
		expect(bad, `插件违规：\n${bad.join("\n")}`).toEqual([]);
	}, 30_000);
});
