import { describe, expect, it } from "vitest";
import { filterSlashCommands, fuzzyScore, MatchTier, slashCandidates } from "../../web/src/slash-filter.js";

/**
 * slash 候选匹配单测：
 * 1. 用户敲裸 skill 名（`/review`）能列出 `skill:review`（裸名候选）；
 * 2. 词边界前缀（`/quit` → `pi-web-ui:quit`，段首算词首）；
 * 3. 模糊子序列搜索（`/mdel` → `model`，漏打/跳字匹配）；
 * 4. 分级排序保证 exact > startsWith > wordBoundary > subsequence，同级保序。
 */
const COMMANDS = [
	{ name: "reload", source: "builtin" },
	{ name: "resume", source: "builtin" },
	{ name: "review", source: "prompt" },
	{ name: "skill:review", source: "skill" },
	{ name: "skill:tdd", source: "skill" },
	{ name: "page-picker:pick", source: "plugin" },
	{ name: "pi-web-ui:quit", source: "builtin" },
	{ name: "model", source: "builtin" },
	{ name: "compact", source: "builtin" },
	{ name: "thinking", source: "builtin" },
];

const names = (prefix: string) => filterSlashCommands(COMMANDS, prefix).map((c) => c.name);

describe("filterSlashCommands", () => {
	it("裸 skill 名命中带命名空间的 skill 条目", () => {
		expect(names("review")).toEqual(["review", "skill:review"]);
	});

	it("skill 名的前缀也能命中（同名模板与 skill 并列，按目录顺序）", () => {
		expect(names("revi")).toEqual(["review", "skill:review"]);
	});

	it("带命名空间照旧命中（没破坏原来的输入方式）", () => {
		expect(names("skill:re")).toEqual(["skill:review"]);
	});

	it("大小写不敏感", () => {
		expect(names("REVIEW")).toEqual(["review", "skill:review"]);
	});

	it("保持目录原顺序（内置 → 扩展/模板 → skill → 插件）", () => {
		expect(names("re")).toEqual(["reload", "resume", "review", "skill:review"]);
	});

	it("词边界段名能命中带命名空间的命令（段首算词首）", () => {
		expect(names("pick")).toEqual(["page-picker:pick"]);
		expect(names("page-picker:pick")).toEqual(["page-picker:pick"]);
	});

	it("quit 命中 pi-web-ui:quit（词边界前缀）", () => {
		expect(names("quit")).toEqual(["pi-web-ui:quit"]);
	});

	it("mdel / cmpct / thnk 分别命中 model / compact / thinking（子序列）", () => {
		expect(names("mdel")).toEqual(["model"]);
		expect(names("cmpct")).toEqual(["compact"]);
		expect(names("thnk")).toEqual(["thinking"]);
	});

	it("首字母缩略 + 词边界（pwq 命中 pi-web-ui:quit）", () => {
		expect(names("pwq")).toEqual(["pi-web-ui:quit"]);
	});

	it("中段子序列命中（odel 命中 model）", () => {
		expect(names("odel")).toEqual(["model"]);
	});

	it("exact / 前缀级永远严格优先于子序列级", () => {
		const cmds = [
			{ name: "mock-demo-element", source: "plugin" },
			{ name: "model", source: "builtin" },
		];
		// mock-demo-element 包含 m-o-d-e-l 作为子序列
		// 即使 mock-demo-element 在目录靠前，输入 model 时 Exact 仍严格优先于 Subsequence
		expect(filterSlashCommands(cmds, "model").map((c) => c.name)).toEqual(["model", "mock-demo-element"]);
		// 输入 mode 时 StartsWith 仍严格优先于 Subsequence
		expect(filterSlashCommands(cmds, "mode").map((c) => c.name)).toEqual(["model", "mock-demo-element"]);
	});

	it("子序列级内部按 score 排序，score 相同保持目录原顺序", () => {
		const cmds = [
			// 在目录前面，但匹配跳字多、位置靠后
			{ name: "extra-thinking-tool", source: "plugin" },
			// 在目录后面，但连续命中且位置靠前
			{ name: "thinking", source: "builtin" },
		];
		expect(filterSlashCommands(cmds, "thnk").map((c) => c.name)).toEqual(["thinking", "extra-thinking-tool"]);

		// score 相同时保持目录原顺序
		const tied = [
			{ name: "test-a", source: "builtin" },
			{ name: "test-b", source: "builtin" },
		];
		expect(filterSlashCommands(tied, "tst").map((c) => c.name)).toEqual(["test-a", "test-b"]);
	});

	it("空前缀返回全部（组件靠「结果为空」决定是否收起菜单）", () => {
		expect(names("")).toEqual(COMMANDS.map((c) => c.name));
		// 新数组：组件会把它直接塞进 state，不该复用入参引用
		expect(filterSlashCommands(COMMANDS, "")).not.toBe(COMMANDS);
	});

	it("无匹配时返回空数组", () => {
		expect(names("zzz")).toEqual([]);
	});

	it("不改动入参", () => {
		const snapshot = [...COMMANDS];
		filterSlashCommands(COMMANDS, "re");
		expect(COMMANDS).toEqual(snapshot);
	});
});

describe("fuzzyScore", () => {
	it("空 query 返回 Exact 与 0 分", () => {
		expect(fuzzyScore("", "model")).toEqual({ tier: MatchTier.Exact, score: 0 });
	});

	it("query 长于 candidate 返回 null", () => {
		expect(fuzzyScore("toolongquery", "short")).toBeNull();
	});

	it("Exact 判定与加分", () => {
		const res = fuzzyScore("model", "model");
		expect(res).not.toBeNull();
		expect(res!.tier).toBe(MatchTier.Exact);
		expect(res!.score).toBeLessThan(-100);
	});

	it("StartsWith 判定", () => {
		const res = fuzzyScore("mode", "model");
		expect(res).not.toBeNull();
		expect(res!.tier).toBe(MatchTier.StartsWith);
	});

	it("WordBoundary 判定（段首命中）", () => {
		const res = fuzzyScore("quit", "pi-web-ui:quit");
		expect(res).not.toBeNull();
		expect(res!.tier).toBe(MatchTier.WordBoundary);
	});

	it("Subsequence 判定（子序列）", () => {
		const res = fuzzyScore("mdel", "model");
		expect(res).not.toBeNull();
		expect(res!.tier).toBe(MatchTier.Subsequence);
	});

	it("不满足子序列返回 null", () => {
		expect(fuzzyScore("zzz", "model")).toBeNull();
	});
});

describe("slashCandidates", () => {
	it("skill 条目同时给出完整名与裸名", () => {
		expect(slashCandidates("skill:review", "skill")).toEqual(["skill:review", "review"]);
	});

	it("非 skill 条目只给出自己的名字", () => {
		expect(slashCandidates("reload", "builtin")).toEqual(["reload"]);
		expect(slashCandidates("page-picker:pick", "plugin")).toEqual(["page-picker:pick"]);
	});

	it("source 不是 skill 时不做前缀剥离", () => {
		expect(slashCandidates("skill:review", "extension")).toEqual(["skill:review"]);
	});
});
