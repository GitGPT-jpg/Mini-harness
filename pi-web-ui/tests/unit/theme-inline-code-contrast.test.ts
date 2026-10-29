/**
 * 主题「内联代码」可读性体检（issue：朱批/朱批·夜 行内代码看不清）。
 *
 * 背景：styles.css 里所有内联代码 chip（`:not(pre) > code`）的前景色统一取
 * `--link-soft` —— 文件预览（`.fp-markdown`）、问卷对话框（`.dialog-inline` /
 * `.dialog-option`）都用它，值由每套主题各自定义。而 themes/zhupi.css 与
 * themes/zhupi-dark.css 的 `--link-soft` 恰好写反了（浅色主题拿了浅桃色
 * `#e8c9b8`、深色主题拿了深棕 `#5a3020`），结果 chip 底色叠上去后身体全在
 * 1.1~1.4 的对比度 —— 行内代码基本等于隐形（默认深色主题是 13.9）。
 *
 * 本测试是**静态**体检：只读主题 CSS 文本，毫秒级、零端口、零浏览器（CI 必跑）。
 * 阈值取 2.0：它不是 WCAG 达标线（正文 AA 是 4.5），而是**令牌写反/写错**这类
 * 灾难性回归的地板 —— 修复前朱批两套是 1.17/1.35，其余 26 套主题最低 2.35。
 * 主题改版只要不是把前景色和背景色搞反就不会被它拦下。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 锚到仓库根（不依赖 process.cwd()，与其它单测同惯例）。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const THEMES_DIR = join(ROOT, "themes");

/** 灾难性不可读的地板（见文件头）。 */
const MIN_RATIO = 2.0;

/** 从主题 CSS 里取 `:root` 下的十六进制令牌值；缺失返回 null。 */
function readHexToken(css: string, token: string): string | null {
	const m = new RegExp("--" + token + "\\s*:\\s*(#[0-9a-fA-F]{6})\\b").exec(css);
	return m ? m[1] : null;
}

function toRgb(hex: string): [number, number, number] {
	const n = parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: [number, number, number]): number {
	const ch = [r, g, b].map((v) => {
		const x = v / 255;
		return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
	});
	return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(toRgb(a)), luminance(toRgb(b))].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

describe("主题内联代码对比度", () => {
	const files = readdirSync(THEMES_DIR).filter((f) => f.endsWith(".css"));
	// 半透明 / 透明主题只改视觉效果，不重定义调色板（继承 styles.css 的 :root），
	// 因此没有 --link-soft 可查，跳过。
	const cases = files
		.map((file) => {
			const css = readFileSync(join(THEMES_DIR, file), "utf8");
			return { file, bg: readHexToken(css, "bg"), link: readHexToken(css, "link-soft") };
		})
		.filter((c) => c.bg !== null && c.link !== null);

	it("扫描到了足够多的主题（防止解析器失效后静默全跳过）", () => {
		expect(cases.length).toBeGreaterThanOrEqual(20);
	});

	for (const { file, bg, link } of cases) {
		it(`${file}: --link-soft 在内联代码底色上可见（>= ${MIN_RATIO}:1）`, () => {
			const ratio = contrast(bg!, link!);
			expect(
				ratio,
				`${file} 的 --link-soft（${link}）与 --bg（${bg}）对比度仅 ${ratio.toFixed(2)}:1，` +
					`内联代码会看不清；这套主题把明暗前景写反了吗？`,
			).toBeGreaterThanOrEqual(MIN_RATIO);
		});
	}
});
