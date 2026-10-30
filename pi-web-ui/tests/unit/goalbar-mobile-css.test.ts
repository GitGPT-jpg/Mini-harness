/**
 * 目标条（GoalBar）窄屏排版静态体检。
 *
 * 背景（同一个手机端 bug 的几层病因，任何一层回退都会复发）：
 *   1. 窄屏「省宽度」规则 `.chip > span:not(...) { display: none }` 曾把模型选择器的文字
 *      一起藏了 —— 豁免名单（含 `.goalbar-opt`）五处必须一致，否则打平后靠源码顺序反超；
 *   2. 活动态（目标已设 / 审查中）一行挤「图标 + 目标 + chip + 说明 + ✕」，
 *      末尾全被截掉；而 flex 只能按序换行，✕ 排在 chip 之后会被一起带下去。
 *   （旧的内联目标编辑器已由统一任务弹窗取代，它的偏好行/轮数框口径随之删除。）
 *
 * 本测试**只读** web/src/styles.css：毫秒级、零端口、零浏览器（CI 必跑）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 锚到仓库根（不用 process.cwd()，同 text-wrap.test.ts 的理由）。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web/src/styles.css"), "utf8");

interface Rule {
	selector: string;
	body: string;
	media: string;
}

/** 逐条收集规则：大括号配平扫一遍，记住所属 @media 条件（顶层规则 media=""）。 */
function parseRules(css: string): Rule[] {
	const out: Rule[] = [];
	const stack: string[] = [];
	let prelude = "";
	for (let i = 0; i < css.length; i++) {
		const ch = css[i]!;
		if (ch === "{") {
			const sel = prelude
				.replace(/\/\*[\s\S]*?\*\//g, " ")
				.replace(/\s+/g, " ")
				.trim();
			prelude = "";
			if (sel.startsWith("@")) {
				stack.push(sel.startsWith("@media") ? sel.replace(/^@media\s*/, "") : "");
				continue;
			}
			// 样式规则：扫到匹配的 '}' 为止
			let depth = 1;
			let body = "";
			for (i++; i < css.length && depth > 0; i++) {
				if (css[i] === "{") depth++;
				else if (css[i] === "}") {
					depth--;
					if (depth === 0) break;
				}
				body += css[i];
			}
			for (const one of sel.split(",")) {
				const one2 = one.trim();
				if (!one2) continue;
				out.push({ selector: one2, body, media: stack[stack.length - 1] ?? "" });
			}
			continue;
		}
		if (ch === "}") {
			stack.pop();
			prelude = "";
			continue;
		}
		if (ch === ";") {
			prelude = "";
			continue;
		}
		prelude += ch;
	}
	return out;
}

const RULES = parseRules(CSS);
const MOBILE = "(max-width: 768px)";

/** 某选择器的声明体（取最后一条 = 后写的赢；mobileOnly 只看窄屏媒体块）。 */
function bodyOf(selector: string, mobileOnly = false): string {
	const hit = RULES.filter((r) => r.selector === selector && (mobileOnly ? r.media === MOBILE : r.media === ""));
	if (hit.length === 0) {
		throw new Error(`styles.css 里没有 ${mobileOnly ? "窄屏 " : ""}规则：${selector}`);
	}
	return hit[hit.length - 1]!.body;
}

describe("chip 标签豁免名单（`.chip > span` 那组 `:not()` 链）", () => {
	/** 「chip 标签家族」的全部规则：只管 chip 的直接子 span。
	 *  .tb-tab / .plugin-topbar-item / .panel-toggle 是另一家（3 项名单、没有窄屏对应
	 *  规则、角标也不在名单里），不在本组口径内。 */
	const lists = RULES.filter(
		(r) =>
			/\.chip\s*>\s*span:/.test(r.selector) &&
			!/\.tb-tab|\.plugin-topbar-item|\.panel-toggle/.test(r.selector) &&
			r.selector.includes(":not("),
	).map((r) => ({
		selector: `${r.media ? `${r.media} ` : ""}${r.selector}`,
		names: [...r.selector.matchAll(/:not\(\s*\.([\w-]+)\s*\)/g)].map((m) => m[1]!).sort(),
	}));

	it("名单条目在五处落地（窄屏全局隐藏 + 窄屏三处豁免 + 基础 no-labels）", () => {
		expect(lists.length, `实际只找到 ${lists.length} 处`).toBeGreaterThanOrEqual(5);
	});

	it("五条规则的名单必须完全一致（写长写短都会打平后靠源码顺序反超）", () => {
		// 历史踩坑：只往窄屏那四条后面加了一项，基础 `.topbar.no-labels` 没跟 →
		// 它与窄屏顶栏豁免同为 (0,9,1) 打平，窄屏那条写在后面赢下 →
		// 「隐藏顶栏文字」失效，顶栏按钮全变回带文字。
		const first = lists[0]!.names;
		for (const rule of lists) {
			expect(rule.names, `豁免名单与第一条不一致：${rule.selector}`).toEqual(first);
		}
	});

	it("名单里有 .goalbar-opt（目标条模型选择器藏不得）", () => {
		for (const rule of lists) {
			expect(rule.names, `缺 :not(.goalbar-opt)：${rule.selector}`).toContain("goalbar-opt");
		}
	});
});

describe("目标条窄屏排版", () => {
	it("窄屏藏 chip 标签的规则必须豁免 .goalbar-opt（否则模型选择器只剩箭头）", () => {
		const hiding = RULES.filter((r) => r.media === MOBILE && /^\.chip\s*>\s*span:/.test(r.selector));
		expect(hiding.length, "没找到窄屏 .chip > span 规则，styles.css 结构变了？").toBeGreaterThan(0);
		for (const rule of hiding) {
			expect(rule.selector, "窄屏 chip 标签规则漏了 :not(.goalbar-opt) 豁免").toContain(":not(.goalbar-opt)");
		}
	});

	it("手机：状态条（LoopBar）按钮行平分宽度", () => {
		expect(bodyOf(".goalbar-row > .goalbar-btn", true)).toMatch(/flex:\s*1 1 auto/);
	});

	it("手机：活动态分行 + order（✕ 留在标题行，不被 chip 一起带下去）", () => {
		expect(bodyOf(".goalbar-active-row", true)).toMatch(/flex-wrap:\s*wrap/);
		expect(bodyOf(".goalbar-active-row .goalbar-x", true)).toMatch(/order:\s*2/);
		expect(bodyOf(".goalbar-active-row .goalbar-chip", true)).toMatch(/order:\s*3/);
		expect(bodyOf(".goalbar-active-row .goalbar-text", true)).toMatch(/max-width:\s*calc\(/);
	});
});
