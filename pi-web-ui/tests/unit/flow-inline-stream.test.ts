/**
 * 极简行文「字级输入流」布局契约守卫。
 *
 * 这套布局接连翻车过几次，根因都是**契约没被盯住**：
 *   1. 主题样式表把选择器从 `.turn-tools-trail` 换成 `.flow-turn`，而前端包没重建
 *      → 样式与渲染层对不上，胶囊退化成每行一个；
 *   2. 容器一会 block 一会 inline-block 一会 flex，正文与胶囊的间距靠逐元素
 *      margin 互相较劲 → 「文字贴胶囊」「思考胶囊和工具胶囊错半行」反复回归；
 *   3. 基线 styles.css 里有一批「类选择器军备竞赛」留下的高权重规则
 *      （如 `.main.hide-model-row .msg-assistant .toolcall { margin: 4px 0 }`），
 *      主题里 2~3 个类的规则永远压不住 → 胶囊凭空多出上下外边距，行距忽宽忽窄。
 *
 * 第 3 条的根治方案是**显式层叠分层**（`@layer guard, base, theme;`）：基线落 `base` 层、
 * 主题落 `theme` 层，普通声明里靠后的层恒压过靠前的层，与选择器权重无关。于是：
 *   · 主题样式表里不再需要任何优先级补丁（本测试断言计数为 0）；
 *   · 流布局规则也不再需要 `#root` 前缀这种 ID 权重 hack（断言不带 `#root`）。
 *
 * 契约本体（用户要的语义：**只有连续胶囊连排，正文前后必断行**）：
 *   · 容器 `.flow-turn` 必须是 flex + wrap + 统一 gap；
 *   · 胶囊（.toolcall / .thinking / .wait）是行内项、定高 22px、行内居中 → 永远对齐；
 *   · 其余内容一律 100% 宽项 → 天然独占整行；
 *   · 渲染层产出的类名必须与样式表一致（防「改了 CSS 忘了 JS / 前端包过期」）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FLOW_BASE = readFileSync(join(ROOT, "themes", "bases", "flow-base.css"), "utf8");
const BASE_CSS = readFileSync(join(ROOT, "web", "src", "styles.css"), "utf8");
const MESSAGE_LIST = readFileSync(join(ROOT, "web", "src", "components", "MessageList.tsx"), "utf8");
const FLOW_MODE = readFileSync(join(ROOT, "web", "src", "flow-mode.ts"), "utf8");

/** 极简行文家族的全部主题样式表：分层后一律不许再出现优先级补丁。 */
const FLOW_THEME_FILES = [
	join(ROOT, "themes", "bases", "flow-base.css"),
	join(ROOT, "themes", "flow.css"),
	join(ROOT, "themes", "flow-light.css"),
	join(ROOT, "themes", "wallpaper-flow.css"),
];

/** 取出以 `prefix` 开头的规则块（到第一个 `}` 为止），便于逐条断言。 */
function ruleBlock(prefix: string): string {
	const i = FLOW_BASE.indexOf(prefix);
	expect(i, `缺少规则 ${prefix}`).toBeGreaterThan(-1);
	return FLOW_BASE.slice(i, FLOW_BASE.indexOf("}", i) + 1);
}

const CHIP_RULE_PREFIX = ".flow-turn .toolcall,";

describe("极简行文字级输入流布局契约", () => {
	it("容器是弹性行流：flex + wrap + 行列统一的 gap（间距单源，不再靠逐元素 margin 互斗）", () => {
		const turn = ruleBlock(".flow-turn {");
		expect(turn).toContain("display: flex;");
		expect(turn).toContain("flex-wrap: wrap;");
		expect(turn).toContain("align-items: center;");
		expect(turn).toMatch(/gap: \d+px;/);
	});

	it("非胶囊内容一律 100% 宽项（正文 / 附件 / 报错独占整行，前后必断行）", () => {
		const items = ruleBlock(".flow-turn .msg-body > * {");
		expect(items).toContain("flex: 0 0 100%;");
	});

	it("胶囊是行内项：定高 22px + 行内居中，工具与思考永远同行同高", () => {
		const chips = ruleBlock(CHIP_RULE_PREFIX);
		expect(chips).toContain("flex: 0 0 auto;");
		expect(chips).toContain("align-self: center;");
		expect(chips).toContain("height: 22px;");
		// 高度单源：这三类胶囊不能出现 23px 之类的第二套高度
		expect(chips).not.toContain("height: 23px");
		// 间距只由容器 gap 决定：胶囊自身外边距必须清零
		expect(chips).toContain("margin: 0;");
	});

	it("正文与胶囊的间距由容器 gap + 正文项外边距提供，正文项不得被行内化", () => {
		const text = ruleBlock(".flow-turn .msg-text {");
		expect(text).toMatch(/margin: \d+px 0;/);
		// 正文行内化会把文字和胶囊焊在同一行 —— 用户明确要求排除
		expect(text).not.toContain("display: inline");
		expect(text).not.toContain("display: inline-flex");
	});

	it("流布局规则不带 #root 作用域：分层后 theme 层天然压过 base 层，不再靠 ID 权重", () => {
		// 基线里那条 4 个类的高权重规则仍然存在 —— 但它现在落在 base 层，压不过 theme 层
		expect(BASE_CSS).toContain(".main.hide-model-row .msg-assistant .toolcall");
		// 本主题的流布局规则一律普通类选择器
		for (const sel of [".flow-turn {", CHIP_RULE_PREFIX, ".flow-turn .msg-text {"]) {
			expect(FLOW_BASE, `规则 ${sel} 必须存在`).toContain(sel);
		}
		// 反向守卫：不允许再出现 `#root` 前缀的流布局规则（ID 权重 hack 已撤销）
		expect(FLOW_BASE).not.toContain("#root .flow-turn");
		expect(FLOW_BASE).not.toContain("#root\t.flow-turn");
	});

	it("极简行文家族的主题样式表里一个优先级补丁都不剩（分层后由 @layer theme 兜底）", () => {
		for (const file of FLOW_THEME_FILES) {
			const content = readFileSync(file, "utf8");
			expect(content.includes("!important"), `${file} 仍有 !important，分层后必须清零`).toBe(false);
		}
	});

	it("渲染层与样式表的容器类名一致（防「改了 CSS 忘了 JS」与前端包过期）", () => {
		// MessageList 的 variant="flow" 分支必须渲染 .flow-turn
		expect(MESSAGE_LIST).toContain('variant === "flow" ? "flow-turn"');
		// 样式表必须有同名容器规则
		expect(FLOW_BASE).toContain(".flow-turn {");
		// 极简行文按回合合并（正文也进同一单元），否则正文会把它切成多个流单元
		expect(MESSAGE_LIST).toContain("mergeTurns");
	});

	it("主题用自定义属性声明能力，前端据此切换渲染（不维护主题 id 白名单）", () => {
		expect(FLOW_BASE).toContain("--flow-inline-stream: 1;");
		expect(FLOW_MODE).toContain('"--flow-inline-stream"');
		expect(FLOW_MODE).toContain("THEME_CHANGE_EVENT");
	});
});
