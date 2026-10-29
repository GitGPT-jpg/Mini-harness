/**
 * 主题「文字令牌」可读性体检（issue：亮色主题沿用深色主题的浅色语义色当文字）。
 *
 * 背景：`--amber` / `--green` / `--red` / `--link` / `--text-faint` 这些令牌既当
 * 边框/图标，也**当文字色**（全仓 `--text-faint` 428 处、`--red` 208 处、`--amber` 147 处）。
 * 亮色主题曾直接继承深色默认值：`--amber #fbbf24` 在 codex 白底上只有 1.89:1、
 * `--plugin-purple #b58cff` 在 gruvbox-light 上 1.50:1 —— 警告文字/状态 chip 基本看不清。
 *
 * 规则（`make-light-theme.mjs` 的 `TEXT_FLOORS` 与 themes/*.css 同口径）：
 *   • 语义文字令牌在 --bg 与 --bg-elev2 上 >= 4.5:1（保持色相、只调明度）；
 *   • `--accent` 多作图标/次级强调文字，地板 3.5:1（默认品牌紫 4.28 保持不动）；
 *   • `--text-faint` 是「次要文字」，地板 3.05:1（仍是弱层级，但要能读）；
 *   • `--code-text` 在 --code-bg 上 >= 4.5:1。
 * 本测试取地板：语义 4.0、faint 2.9（略低于目标值，留给取整与主题微调）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const THEMES_DIR = join(ROOT, "themes");
const STYLES_PATH = join(ROOT, "web", "src", "styles.css");

/** 令牌 → [地板, 目标表面]（表面取不到十六进制时跳过）。 */
const FLOORS: Record<string, { min: number; surfaces: string[] }> = {
	"--text-faint": { min: 2.9, surfaces: ["--bg", "--bg-elev", "--bg-elev2", "--code-bg"] },
	"--accent": { min: 3.0, surfaces: ["--bg", "--bg-elev2"] },
	"--amber": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--amber-text": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--green": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--red": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--red-text": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--err-text": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--blue": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--link": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--link-soft": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--info-blue": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--skill-blue": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--auth-green": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--plugin-purple": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--md-strong": { min: 4.0, surfaces: ["--bg", "--bg-elev2"] },
	"--code-text": { min: 4.0, surfaces: ["--code-bg"] },
};

function parseHex(value: string | undefined | null): [number, number, number] | null {
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
function vars(css: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const m of css.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gm)) map.set(m[1]!, m[2]!.trim());
	return map;
}

describe("主题文字令牌可读性", () => {
	const rootCss = readFileSync(STYLES_PATH, "utf8");
	const rootVars = vars(rootCss);
	const themeFiles = readdirSync(THEMES_DIR).filter((f) => f.endsWith(".css"));
	const cases = themeFiles.map((file) => ({ file, vars: vars(readFileSync(join(THEMES_DIR, file), "utf8")) }));

	it("扫描到了足够多的主题（防止解析器失效后静默全跳过）", () => {
		expect(cases.length).toBeGreaterThanOrEqual(20);
	});

	it("默认调色板（styles.css :root）满足全部门槛", () => {
		for (const [token, { min, surfaces }] of Object.entries(FLOORS)) {
			const fg = parseHex(rootVars.get(token));
			expect(fg, `:root 缺少 ${token}`).toBeTruthy();
			for (const surf of surfaces) {
				const bg = parseHex(rootVars.get(surf));
				if (!bg) continue;
				const ratio = contrast(fg!, bg);
				expect(ratio, `默认主题 ${token} on ${surf} 只有 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(min);
			}
		}
	});

	for (const { file, vars: themeVars } of cases) {
		it(`${file}: 文字令牌在正文表面上足够可读`, () => {
			const failures: string[] = [];
			for (const [token, { min, surfaces }] of Object.entries(FLOORS)) {
				const fg = parseHex(themeVars.get(token) ?? rootVars.get(token));
				if (!fg) continue;
				for (const surf of surfaces) {
					const bg = parseHex(themeVars.get(surf) ?? rootVars.get(surf));
					if (!bg) continue;
					const ratio = contrast(fg, bg);
					if (ratio < min) {
						failures.push(
							`${token}(${themeVars.get(token) ?? rootVars.get(token)}) on ${surf} = ${ratio.toFixed(2)}:1（< ${min}）`,
						);
					}
				}
			}
			expect(
				failures,
				`${file} 的语义文字色太浅，状态文字/chip 会看不清：\n${failures.join("\n")}\n` +
					`修法：给这套主题声明更深的同名令牌（生成器 make-light-theme.mjs 的 TEXT_FLOORS 会自动压暗）。`,
			).toEqual([]);
		});
	}
});
