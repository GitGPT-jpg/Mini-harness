/**
 * 构建目标回归（见 web/vite.config.ts 的 build.target）。
 *
 * 背景：Vite 默认 build.target = "modules"（含 es2020），esbuild 会把逻辑赋值
 * `r ||= {}` 降级成 `void 0 || (r = {})`，同时把只写不读的 `let r;` 声明当成死代码
 * 删掉 —— 生成的代码在严格模式 ESM 下抛 ReferenceError。xterm 6 的
 * `requestMode()`（DECRQM 查询处理）正是这个写法，被坑之后 vim 之类会发 DECRQM 的
 * TUI 一启动就打断终端解析器，表现为「终端里 vim 无法输入」。
 *
 * 因此构建目标必须 ≥ es2021（||= 原生支持）。浏览器下限不变：Chrome 85 /
 * Safari 14 / Firefox 79 起就支持逻辑赋值。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CONFIG = join(process.cwd(), "web/vite.config.ts");
const DIST_ASSETS = join(process.cwd(), "web/dist/assets");
/** 需要降级 ||= 的目标（会触发 esbuild 丢声明的 bug）。 */
const LOWERING_TARGETS = /^(es5|es6|es2015|es2016|es2017|es2018|es2019|es2020|modules)$/;

describe("web 构建目标", () => {
	it("显式设置了 build.target", () => {
		const src = readFileSync(CONFIG, "utf8");
		expect(src).toMatch(/\btarget:\s*"[^"]+"/);
	});

	it("target ≥ es2021，避免 ||= 被降级（xterm requestMode 会因此崩）", () => {
		const src = readFileSync(CONFIG, "utf8");
		const target = /\btarget:\s*"([^"]+)"/.exec(src)?.[1] ?? "";
		expect(target).not.toMatch(LOWERING_TARGETS);
		const year = /^es(\d{4})$/.exec(target)?.[1];
		if (year) expect(Number(year)).toBeGreaterThanOrEqual(2021);
	});

	// 构建产物存在时顺带体检：降级后的枚举 IIFE 调用形态一旦出现即为回归。
	it("构建产物里没有丢声明的 `))(void 0||(x=` 形态", () => {
		if (!existsSync(DIST_ASSETS)) return; // 未构建（CI 的 vitest 早于 build）时跳过
		const offenders: string[] = [];
		for (const file of readdirSync(DIST_ASSETS).filter((f) => f.endsWith(".js"))) {
			const code = readFileSync(join(DIST_ASSETS, file), "utf8");
			if (/\)\)\(void 0\|\|\(/.test(code)) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});
});
