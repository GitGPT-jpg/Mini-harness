/**
 * 工具提示词卫生守卫 — 所有发给模型的工具定义提示词必须为精简纯英文。
 *
 * 背景：工具定义的 description / promptSnippet / promptGuidelines 直接进入模型
 * 上下文。历史上曾用 bilingual(en, zh) 双语内联（issue #91），后统一为纯英文精简
 * （zh 文案仅在 per-call 返回文本与 UI 层保留）。本测试防回潮：
 *  1. server/*.ts 工具定义文件不得再调用 bilingual()（白名单外的残留即失败）；
 *  2. server/*.ts 的 description/promptSnippet/promptGuidelines 值不得含中文；
 *  3. 主 description 长度上限（patch-tool 这类操作语法参考单独豁免）；
 *  4. 插件 *.mjs 的 description/promptSnippet 行不得含中文（label/execute 返回
 *     文本/注释是 UI 与对话内容，允许中文，不在检查范围）。
 *
 * ―― 同一份工具信息在上下文里最多只说一遍（口径，2024 全量收敛时定）――
 * 模型能同时看到三处：tool schema 的 description、系统提示词 Available tools 列表里
 * 的 snippet、Guidelines 段的 guidelines。三处职责严格分开：
 *   description = 做什么 + 副作用/边界；不写「什么时候用」。
 *   promptSnippet = 触发条件（≤80c），不写工具名前缀（列表本身渲染 `- name: …`），
 *     不得是 description 的复述（否则同一条信息进上下文两次）。
 *   promptGuidelines = 何时用 / 顺序 / 禁止 / 跨工具路由；不得复述 description。
 * 于是填齐下列一条事实：① 同文件内不得出现「短串是长串子串」或高度改写的同义重复；
 * ② 各字段长度上限；③ snippet 不得以工具名开头。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** 仍允许使用 bilingual() 的文件（面向用户的 relay 文案，非工具定义）。 */
const BILINGUAL_ALLOW = new Set(["i18n.ts", "dsh-client.ts", "dsh-agent-service.ts"]);

/** CJK 检查豁免（非模型提示词）：斜杠命令 UI、用户可编辑模板数据（含其繁中视图）、宿主 API 目录、
 *  tool-manager 的工具预设说明（设置面板 UI）。 */
const CJK_ALLOW = new Set([
	"slash-commands.ts",
	"subagent-templates.ts",
	"subagent-templates-hant.ts",
	"plugin-api-catalog.ts",
	"tool-manager.ts",
]);

/** 主 description 长度上限（字符）；操作语法参考类工具单独豁免。 */
const MAIN_DESC_CAP = 600;
/** 操作语法参考类工具：整份 op/语法表本身就是工具的唯一文档位（patch 的补丁语法、
 *  browser_page 的 ops 参数矩阵），不能再移去别处，因此豁免主描述上限。 */
const MAIN_DESC_EXEMPT = new Set(["patch-tool.ts"]);
/** promptSnippet 上限：只写触发条件，一句话以内。 */
const SNIPPET_CAP = 80;
/** 单条 promptGuidelines 上限：一条规则（可带一句理由）。 */
const GUIDELINE_CAP = 200;
/** 「同义重复」判定阈值：短串≥此字数才参与比对（太短的短语重叠无意义）。 */
const DUP_MIN_LEN = 40;
/** 词集合高度重合算改写重复（Jaccard）。 */
const DUP_JACCARD = 0.85;
/** snippet ↔ description 的改写判定阈值（snippet 更短，相应放宽一点）。 */
const SNIPPET_DESC_JACCARD = 0.7;

const CJK = /[\u4e00-\u9fff\u3040-\u30ff]/;

function serverFiles(): string[] {
	return readdirSync(join(ROOT, "server"))
		.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
		.map((f) => join(ROOT, "server", f));
}

/** 解析一个「字符串表达式」（字面量按 + 拼接；返回 null 表示不是纯字符串）。 */
function readStr(src: string, i: number): { text: string; end: number } | null {
	const q = src[i];
	if (q !== '"' && q !== "'" && q !== "`") return null;
	let j = i + 1;
	let out = "";
	while (j < src.length && src[j] !== q) {
		if (src[j] === "\\") {
			const n = src[j + 1];
			out += n === "n" ? "\n" : n === "t" ? "\t" : n;
			j += 2;
		} else out += src[j++];
	}
	if (src[j] !== q) return null;
	return { text: out, end: j + 1 };
}

function readConcat(src: string, i: number): { text: string; end: number } | null {
	let out = "";
	let j = i;
	let expectOperand = true;
	for (;;) {
		while (/\s/.test(src[j] ?? "")) j++;
		const c = src[j];
		if (c === "+") {
			j++;
			expectOperand = true;
			continue;
		}
		if (c === ")" || c === "," || c === ";" || c == null) break;
		if (!expectOperand) break;
		const s = readStr(src, j);
		if (!s) return null;
		out += s.text;
		j = s.end;
		expectOperand = false;
	}
	return { text: out, end: j };
}

describe("tool prompt hygiene（工具提示词纯英文精简）", () => {
	it("server 工具定义文件不再调用 bilingual()", () => {
		const offenders: string[] = [];
		for (const file of serverFiles()) {
			if (BILINGUAL_ALLOW.has(file.split(/[/\\]/).pop()!)) continue;
			const src = readFileSync(file, "utf8");
			const calls = src.match(/\bbilingual\s*\(/g);
			if (calls) offenders.push(`${file}: ${calls.length} 处`);
		}
		expect(offenders, `以下文件仍有 bilingual() 调用：\n${offenders.join("\n")}`).toEqual([]);
	});

	it("server description/promptSnippet/promptGuidelines 值不含中文", () => {
		const offenders: string[] = [];
		for (const file of serverFiles()) {
			if (CJK_ALLOW.has(file.split(/[/\\]/).pop()!)) continue;
			const src = readFileSync(file, "utf8");
			for (const key of ["description", "promptSnippet", "promptGuidelines"]) {
				let idx = 0;
				while ((idx = src.indexOf(key + ":", idx)) !== -1) {
					const line = src.slice(0, idx).split("\n").length;
					idx += key.length + 1;
					let j = idx;
					while (/\s/.test(src[j])) j++;
					const r = readConcat(src, j);
					if (!r) continue; // 标识符/复杂表达式跳过（常量描述由审查保证）
					idx = r.end;
					if (CJK.test(r.text)) offenders.push(`${file}:${line} ${key} 含中文: ${r.text.slice(0, 60)}`);
				}
			}
		}
		expect(offenders, `以下工具提示词含中文：\n${offenders.join("\n")}`).toEqual([]);
	});

	it("server 主 description 不超过长度上限", () => {
		const offenders: string[] = [];
		for (const file of serverFiles()) {
			if (MAIN_DESC_EXEMPT.has(file.split(/[/\\]/).pop()!)) continue;
			const src = readFileSync(file, "utf8");
			let idx = 0;
			while ((idx = src.indexOf("description:", idx)) !== -1) {
				const line = src.slice(0, idx).split("\n").length;
				idx += "description:".length;
				let j = idx;
				while (/\s/.test(src[j])) j++;
				const r = readConcat(src, j);
				if (!r) continue;
				// 只看「工具定义的主描述」：同名对象里通常紧跟 name/label。这里放宽为
				// 所有 description 值（参数描述远短于上限，不会误伤）。
				if (r.text.length > MAIN_DESC_CAP) offenders.push(`${file}:${line} ${r.text.length}c`);
			}
		}
		expect(offenders, `以下 description 超过 ${MAIN_DESC_CAP}c：\n${offenders.join("\n")}`).toEqual([]);
	});

	it("插件 *.mjs 的 description/promptSnippet 行不含中文", () => {
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const f of readdirSync(dir)) {
				const p = join(dir, f);
				if (statSync(p).isDirectory()) {
					if (f !== "node_modules") walk(p);
					continue;
				}
				if (!f.endsWith(".mjs")) continue;
				const lines = readFileSync(p, "utf8").split("\n");
				for (let i = 0; i < lines.length; i++) {
					if (!/^\s*(description|promptSnippet|promptGuidelines)\s*[:=]/.test(lines[i])) continue;
					// registerCommand 的 description/descriptionEn 是 UI 文案，跳过
					const context = lines.slice(Math.max(0, i - 4), Math.min(lines.length, i + 5)).join("\n");
					if (context.includes("registerCommand") || context.includes("descriptionEn")) continue;
					// 单行含中文即报（跨行描述的续行由同组审查保证）；变量插值/动态拼接跳过
					const m = lines[i].match(/(["'`])((?:\\.|(?!\1).)*)\1/);
					if (m && CJK.test(m[2])) offenders.push(`${p}:${i + 1} ${m[2].slice(0, 60)}`);
				}
			}
		};
		walk(join(ROOT, "plugins"));
		expect(offenders, `以下插件提示词行含中文：\n${offenders.join("\n")}`).toEqual([]);
	}, 20_000);
});
// ────────────────────────────────────────────────────────────────────────────
// 三处职责分离（description / promptSnippet / promptGuidelines）的机器守卫
// ────────────────────────────────────────────────────────────────────────────

interface PromptEntry {
	line: number;
	field: "description" | "promptSnippet" | "guideline";
	text: string;
}

/** 归一化：小写、标点→空格、压缩空白（用于「同义重复」判定）。 */
function normalize(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/** 词集合：丢弃 ≤3 字母的噪声词（a / the / for…）。 */
function wordSet(s: string): Set<string> {
	return new Set(
		normalize(s)
			.split(" ")
			.filter((w) => w.length > 3),
	);
}

/** 词集合重合度（Jaccard）。 */
function jaccard(a: Set<string>, b: Set<string>): number {
	let inter = 0;
	for (const w of a) if (b.has(w)) inter++;
	return inter / (a.size + b.size - inter || 1);
}

/** 拆出数组字面量的顶层元素（跟踪括号与字符串字面量，不误切字符串里的逗号）。 */
function arrayElements(src: string, open: number): { items: string[]; end: number } | null {
	let depth = 0;
	let start = open + 1;
	let inStr: string | null = null;
	const items: string[] = [];
	for (let j = open + 1; j < src.length; j++) {
		const c = src[j];
		if (inStr) {
			if (c === "\\") {
				j++;
				continue;
			}
			if (c === inStr) inStr = null;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			inStr = c;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") {
			depth++;
			continue;
		}
		if (c === ")" || c === "}") {
			depth--;
			continue;
		}
		if (c === "]") {
			if (depth > 0) {
				depth--;
				continue;
			}
			items.push(src.slice(start, j));
			return { items, end: j + 1 };
		}
		if (c === "," && depth === 0) {
			items.push(src.slice(start, j));
			start = j + 1;
		}
	}
	return null;
}

/** 把一个数组元素里的字符串字面量拼起来；含展开/标识符等非字符串内容时返回 null。 */
function stringOnly(el: string): string | null {
	let out = "";
	let sawString = false;
	let j = 0;
	while (j < el.length) {
		const c = el[j];
		if (/\s/.test(c) || c === "+" || c === ",") {
			j++;
			continue;
		}
		const s = readStr(el, j);
		if (!s) return null;
		sawString = true;
		out += s.text;
		j = s.end;
	}
	return sawString ? out : null;
}

/** 抽取一个文件里全部模型可见字段值（guidelines 按条拆开，`+` 拼接合并）。 */
function scanPromptEntries(src: string): PromptEntry[] {
	const out: PromptEntry[] = [];
	for (const field of ["description", "promptSnippet"] as const) {
		let idx = 0;
		while ((idx = src.indexOf(`${field}:`, idx)) !== -1) {
			const line = src.slice(0, idx).split("\n").length;
			idx += field.length + 1;
			let j = idx;
			while (/\s/.test(src[j] ?? "")) j++;
			const r = readConcat(src, j);
			if (r && r.text.trim()) out.push({ line, field, text: r.text });
			idx = r ? Math.max(r.end, j + 1) : j + 1;
		}
	}
	let idx = 0;
	while ((idx = src.indexOf("promptGuidelines:", idx)) !== -1) {
		const line = src.slice(0, idx).split("\n").length;
		idx += "promptGuidelines:".length;
		let j = idx;
		while (/\s/.test(src[j] ?? "")) j++;
		if (src[j] === "[") {
			const arr = arrayElements(src, j);
			if (arr) {
				for (const el of arr.items) {
					const t = stringOnly(el);
					if (t && t.trim()) out.push({ line, field: "guideline", text: t });
				}
				idx = arr.end;
				continue;
			}
		}
		idx = j + 1;
	}
	return out;
}

/** 文件里出现过的工具名（`name: "xxx"`），用于 snippet 前缀检查。 */
function toolNamesIn(src: string): string[] {
	const out: string[] = [];
	const re = /\bname:\s*"([A-Za-z_][A-Za-z0-9_]*)"/g;
	let m = re.exec(src);
	while (m !== null) {
		out.push(m[1]);
		m = re.exec(src);
	}
	return out;
}

/** 插件里参与提示词检查的文件：跳过 node_modules 与第三方 vendor bundle。 */
function pluginPromptFiles(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const f of readdirSync(dir)) {
			const p = join(dir, f);
			if (statSync(p).isDirectory()) {
				if (f !== "node_modules" && f !== "vendor" && f !== "artifacts") walk(p);
				continue;
			}
			if (f.endsWith(".mjs")) out.push(p);
		}
	};
	walk(join(ROOT, "plugins"));
	return out;
}

/** 参与检查的全部文件（server 根目录 + 插件）。 */
function promptFiles(): string[] {
	return [...serverFiles(), ...pluginPromptFiles()];
}

describe("tool prompt hygiene（三处职责分离：description / snippet / guidelines）", () => {
	it(`promptSnippet ≤ ${SNIPPET_CAP}c 且不以工具名开头`, () => {
		const offenders: string[] = [];
		for (const file of promptFiles()) {
			const src = readFileSync(file, "utf8");
			const names = toolNamesIn(src);
			for (const e of scanPromptEntries(src)) {
				if (e.field !== "promptSnippet") continue;
				if (e.text.length > SNIPPET_CAP) offenders.push(`${file}:${e.line} ${e.text.length}c > ${SNIPPET_CAP}c`);
				const head = normalize(e.text);
				for (const n of names) {
					if (n.length < 4) continue;
					const link = normalize(n);
					if (head === link || head.startsWith(`${link} `)) {
						offenders.push(`${file}:${e.line} snippet 以工具名「${n}」开头: ${e.text.slice(0, 60)}`);
					}
				}
			}
		}
		expect(
			offenders,
			`snippet 违规（系统提示词列表已渲染 \`- name: …\`，不必再重复工具名）：\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("promptSnippet 不复述 description", () => {
		const offenders: string[] = [];
		for (const file of promptFiles()) {
			const src = readFileSync(file, "utf8");
			const entries = scanPromptEntries(src);
			const descs = entries.filter((e) => e.field === "description" && e.text.length > 60);
			for (const s of entries.filter((e) => e.field === "promptSnippet")) {
				const words = wordSet(s.text);
				if (words.size < 4) continue; // 太短的触发短语无法判定，交给长度上限约束
				for (const d of descs) {
					const v = jaccard(words, wordSet(d.text));
					if (v >= SNIPPET_DESC_JACCARD) {
						offenders.push(
							`${file}:${s.line} 与同文件 description 重合 ${(v * 100).toFixed(0)}%: ${s.text.slice(0, 60)}`,
						);
						break;
					}
				}
			}
		}
		expect(
			offenders,
			`以下 snippet 只是 description 的改写（同一条信息进上下文两次）：\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it(`promptGuidelines 单条 ≤ ${GUIDELINE_CAP}c 且不复述 description`, () => {
		const offenders: string[] = [];
		for (const file of promptFiles()) {
			const src = readFileSync(file, "utf8");
			const entries = scanPromptEntries(src);
			const descs = entries.filter((e) => e.field === "description" && e.text.length > 60);
			for (const g of entries.filter((e) => e.field === "guideline")) {
				if (g.text.length > GUIDELINE_CAP) offenders.push(`${file}:${g.line} ${g.text.length}c > ${GUIDELINE_CAP}c`);
				const norm = normalize(g.text);
				for (const d of descs) {
					const v = jaccard(wordSet(g.text), wordSet(d.text));
					if ((norm.length >= DUP_MIN_LEN && normalize(d.text).includes(norm)) || v >= DUP_JACCARD) {
						offenders.push(
							`${file}:${g.line} 复述 description（重合 ${(v * 100).toFixed(0)}%）: ${g.text.slice(0, 60)}`,
						);
						break;
					}
				}
			}
		}
		expect(
			offenders,
			`guidelines 只写「何时用/顺序/禁止/路由」，不复述 description：\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("同一文件内不出现同义重复的提示词串（子串 / 高度改写）", () => {
		const offenders: string[] = [];
		for (const file of promptFiles()) {
			const src = readFileSync(file, "utf8");
			const entries = scanPromptEntries(src).filter((e) => e.text.length >= DUP_MIN_LEN);
			for (let i = 0; i < entries.length; i++) {
				for (let k = i + 1; k < entries.length; k++) {
					const a = entries[i];
					const b = entries[k];
					const na = normalize(a.text);
					const nb = normalize(b.text);
					if (na === nb || na.includes(nb) || nb.includes(na)) {
						offenders.push(
							`${file}:${a.line}&${b.line} 子串重复: 「${a.text.slice(0, 45)}」/「${b.text.slice(0, 45)}」`,
						);
						continue;
					}
					const v = jaccard(wordSet(a.text), wordSet(b.text));
					if (v >= DUP_JACCARD) {
						offenders.push(`${file}:${a.line}&${b.line} 同义改写 ${(v * 100).toFixed(0)}%: 「${a.text.slice(0, 45)}」`);
					}
				}
			}
		}
		expect(offenders, `同一文件内同一条信息说了两遍（合并到唯一归属处）：\n${offenders.join("\n")}`).toEqual([]);
	});
});
