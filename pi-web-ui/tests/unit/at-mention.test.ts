/**
 * matchAtToken 单测（web/src/at-mention.ts）：`@` 提及词元判定。
 * 锁住三条不变量：邮箱不误弹 / CJK 无空格可触发 / 空格关闭。
 */
import { describe, expect, it } from "vitest";
import {
	mapFileHits,
	mapSkillHits,
	matchAtToken,
	mergeAtHits,
	type AtHit,
	type SkillCommandLike,
} from "../../web/src/at-mention.js";

describe("matchAtToken", () => {
	it("行首 @ + 空 query 也触发（列出全部）", () => {
		expect(matchAtToken("@", 1)).toEqual({ start: 0, query: "" });
	});

	it("空白后触发，query 取到光标", () => {
		expect(matchAtToken("请看 @文", 5)).toEqual({ start: 3, query: "文" });
	});

	it("CJK 无空格书写可触发（看不是 ASCII 单词字符）", () => {
		expect(matchAtToken("请看@文件", 5)).toEqual({ start: 2, query: "文件" });
	});

	it("邮箱不触发（@ 前是 ASCII 字母）", () => {
		expect(matchAtToken("mail@test", 9)).toBeNull();
		expect(matchAtToken("a@b", 3)).toBeNull();
	});

	it("数字下划线之后不触发", () => {
		expect(matchAtToken("v2@test", 7)).toBeNull();
		expect(matchAtToken("a_@b", 4)).toBeNull();
	});

	it("空白隔开的第二个 @ 只认后一个；紧贴字母的 @ 按邮箱拒", () => {
		expect(matchAtToken("@a @b", 5)).toEqual({ start: 3, query: "b" });
		expect(matchAtToken("@a@b", 4)).toBeNull();
	});

	it("query 含空格即关闭（trailing space 回车发送）", () => {
		expect(matchAtToken("@ab ", 4)).toBeNull();
		expect(matchAtToken("@a b", 4)).toBeNull();
	});

	it("光标不在词元后即无触发", () => {
		expect(matchAtToken("hi @ab", 3)).toBeNull();
		expect(matchAtToken("no at here", 5)).toBeNull();
	});

	it("括号引号后可触发", () => {
		expect(matchAtToken("(@x", 3)).toEqual({ start: 1, query: "x" });
		expect(matchAtToken("「@y」", 3)).toEqual({ start: 1, query: "y" });
		expect(matchAtToken("（@z", 3)).toEqual({ start: 1, query: "z" });
	});

	describe("mapFileHits", () => {
		it("文件/目录映射为引用 chip 命中", () => {
			const out = mapFileHits("文件", [
				{ path: "src/a.ts", name: "a.ts", type: "file" },
				{ path: "src", name: "src", type: "dir" },
				{ path: "", name: "x", type: "file" },
			]);
			expect(out).toHaveLength(2);
			// 正文写相对路径（非 basename）：同名条目靠路径区分，linkify 按路径渲染药丸。
			expect(out[0]).toMatchObject({ providerId: "host:files", title: "a.ts", text: "@src/a.ts" });
			expect(out[0]?.attachments?.[0]).toMatchObject({ path: "src/a.ts", mode: "reference" });
			expect(out[0]?.attachments?.[0]).not.toHaveProperty("isDir");
			expect(out[1]?.attachments?.[0]).toMatchObject({ isDir: true });
		});

		it("同名 basename 的两个条目正文互不混淆", () => {
			const out = mapFileHits("文件", [
				{ path: "报告", name: "报告", type: "dir" },
				{ path: "方案/报告", name: "报告", type: "dir" },
			]);
			expect(out[0]?.text).toBe("@报告");
			expect(out[1]?.text).toBe("@方案/报告");
			expect(out[0]?.text).not.toBe(out[1]?.text);
		});
	});

	describe("mapSkillHits", () => {
		const commands: SkillCommandLike[] = [
			{
				name: "skill:wrapup",
				source: "skill",
				description: "收尾当前会话",
				descriptionEn: "Wrap up the current session",
			},
			{ name: "skill:analyze", source: "skill", description: "深度代码分析", descriptionEn: "Deep repo analysis" },
			{ name: "exit", source: "extension", description: "Exit pi" },
			{ name: "skill:review", source: "skill" },
			{ name: "bare-skill", source: "skill", description: "No prefix skill" },
			{ name: "skill:code-helper", source: "skill", description: "A skill that helps with code" },
			{ name: "skill:helper-with-long-desc", source: "skill", description: "Contains word code in description" },
		];

		it("提取 bareName，生成正确的 @skill:<name> 文本，排除非 skill 命令", () => {
			const out = mapSkillHits("Skills", commands, "");
			expect(out).toHaveLength(6);
			expect(out[0]).toMatchObject({
				providerId: "host:skills",
				providerLabel: "Skills",
				title: "wrapup",
				hint: "收尾当前会话",
				text: "@skill:wrapup",
			});
			expect(out[1]?.title).toBe("analyze");
			expect(out[1]?.text).toBe("@skill:analyze");
			expect(out[2]?.title).toBe("review");
			expect(out[2]?.hint).toBe("Skill review");
			expect(out[3]?.title).toBe("bare-skill");
			expect(out[3]?.text).toBe("@skill:bare-skill");
		});

		it("支持以 skill: 为前缀的 query（含空 cleanQ），正确去除前缀匹配", () => {
			const outPrefix = mapSkillHits("Skills", commands, "skill:ana");
			expect(outPrefix).toHaveLength(1);
			expect(outPrefix[0]?.title).toBe("analyze");

			const outBarePrefix = mapSkillHits("Skills", commands, "skill:");
			expect(outBarePrefix).toHaveLength(6);
		});

		it("相关性排序：名称匹配优先于描述匹配，防止描述泛匹配挤占名称命中", () => {
			const out = mapSkillHits("Skills", commands, "code");
			expect(out.length).toBeGreaterThanOrEqual(2);
			// "code-helper" 包含 "code" 在名称中，必须排在仅描述包含 "code" 的 "helper-with-long-desc" 之前
			expect(out[0]?.title).toBe("code-helper");
			expect(out[1]?.title).toBe("helper-with-long-desc");
		});

		it("按 bareName 或中英文 description 过滤，短查询仅匹配名称", () => {
			const byName = mapSkillHits("Skills", commands, "wrap");
			expect(byName).toHaveLength(1);
			expect(byName[0]?.title).toBe("wrapup");

			// 3 字符以上支持 description / descriptionEn 检索
			const byDescEn = mapSkillHits("Skills", commands, "repo");
			expect(byDescEn).toHaveLength(1);
			expect(byDescEn[0]?.title).toBe("analyze");

			// 自定义 resolver 优先
			const byResolver = mapSkillHits("Skills", commands, "session", 15, (c) => c.descriptionEn ?? "");
			expect(byResolver).toHaveLength(1);
			expect(byResolver[0]?.hint).toBe("Wrap up the current session");

			// 2 字符短查询不匹配 description（防泛匹配挤占）
			const shortDesc = mapSkillHits("Skills", commands, "se");
			expect(shortDesc).toHaveLength(0);
		});

		it("超出 limit 时正确截断，limit <= 0 返回空数组", () => {
			const out = mapSkillHits("Skills", commands, "", 2);
			expect(out).toHaveLength(2);

			const outZero = mapSkillHits("Skills", commands, "", 0);
			expect(outZero).toEqual([]);
		});
	});

	describe("mergeAtHits", () => {
		const skillHit: AtHit = {
			providerId: "host:skills",
			providerLabel: "Skills",
			title: "wrapup",
			text: "@skill:wrapup",
		};
		const fileHit: AtHit = { providerId: "host:files", providerLabel: "Files", title: "readme.md" };

		it("技能在前、文件在后；query 不影响顺序（含 skill: 前缀）", () => {
			for (const q of ["skill:wr", "test", ""]) {
				const merged = mergeAtHits({ files: [fileHit], skills: [skillHit] }, q);
				expect(merged.map((m) => m.providerId)).toEqual(["host:skills", "host:files"]);
			}
		});

		it("缺省 totalCap 为 30，支持显式截断与空 bucket", () => {
			// 验证缺省 totalCap 为 30：35 条项目默认截断为 30 条
			const thirtyFiveSkills: AtHit[] = Array.from({ length: 35 }, (_, idx) => ({
				providerId: "host:skills",
				providerLabel: "Skills",
				title: `skill-${idx}`,
			}));
			const defaultCapped = mergeAtHits({ skills: thirtyFiveSkills }, "query");
			expect(defaultCapped).toHaveLength(30);

			// 显式 totalCap 截断：排在后面的文件先被截掉
			const capped = mergeAtHits({ skills: [skillHit], files: [fileHit] }, "test", 1);
			expect(capped.map((m) => m.providerId)).toEqual(["host:skills"]);
			expect(mergeAtHits({ skills: [skillHit], files: [fileHit] }, "test", 0)).toEqual([]);

			// 空 buckets / 单桶
			expect(mergeAtHits({}, "test")).toHaveLength(0);
			expect(mergeAtHits({ files: [fileHit] }, "test")).toEqual([fileHit]);
		});
	});

	it("cursor 越界钳制不抛错", () => {
		expect(matchAtToken("@ab", 99)).toEqual({ start: 0, query: "ab" });
		expect(matchAtToken("@ab", -5)).toBeNull();
		expect(matchAtToken("", 0)).toBeNull();
	});
});
