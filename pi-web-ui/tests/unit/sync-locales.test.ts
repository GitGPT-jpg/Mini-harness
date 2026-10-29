/**
 * sync-locales 单元测试：
 * 验证 scripts/sync-locales.mjs 的占位符提取、多语言包自动补齐、死 key 清理与键序重排。
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPlaceholders, syncLocales } from "../../scripts/sync-locales.mjs";

describe("sync-locales", () => {
	it("extractPlaceholders 能正确提取各类占位符", () => {
		const s = "Hello {name}, your count is {count}, pwd is ${pwd}, marker is [[marker:test]] and token is {{token}}.";
		expect(extractPlaceholders(s)).toEqual(["${pwd}", "[[marker", "{count}", "{name}", "{{token}}"]);
	});

	it("当前工作区的 12 个语言包已与 web/src/i18n.tsx 完全对齐", async () => {
		const res = await syncLocales({ dryRun: true, checkOnly: true });
		expect(res.ok).toBe(true);
		expect(res.hasChanges).toBe(false);
		expect(res.totalAdded).toBe(0);
		expect(res.totalPruned).toBe(0);
	});

	it("在隔离沙盒中能自动补齐缺失 key、清理死 key 并按 zh 键序重排", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-sync-locales-"));
		try {
			// 构建最小 mock 环境
			mkdirSync(join(tempDir, "web/src"), { recursive: true });
			mkdirSync(join(tempDir, "locales"), { recursive: true });

			const mockI18n = `
export const zh = {
	apple: "苹果",
	banana: "香蕉 {count} 根",
	cherry: "樱桃",
};

export const en: Record<keyof typeof zh, string> = {
	apple: "Apple",
	banana: "Banana {count} pcs",
	cherry: "Cherry",
};
`;
			writeFileSync(join(tempDir, "web/src/i18n.tsx"), mockI18n, "utf8");

			// de.json: 缺少 cherry，多余 deadKey，且已有 key 乱序 (banana 在 apple 前)
			const mockDe = {
				code: "de",
				nativeName: "Deutsch",
				version: "1.0.0",
				strings: {
					banana: "Banane {count} Stk",
					apple: "Apfel",
					deadKey: "Soll weg",
				},
			};
			writeFileSync(join(tempDir, "locales/de.json"), JSON.stringify(mockDe, null, "\t") + "\n", "utf8");

			// zh-TW.json: 缺少 banana 和 cherry
			const mockTw = {
				code: "zh-TW",
				nativeName: "繁體中文（台灣）",
				version: "1.0.0",
				strings: {
					apple: "蘋果",
				},
			};
			writeFileSync(join(tempDir, "locales/zh-TW.json"), JSON.stringify(mockTw, null, "\t") + "\n", "utf8");

			// 先测试 dryRun
			const dryRes = await syncLocales({ repoRoot: tempDir, dryRun: true });
			expect(dryRes.hasChanges).toBe(true);
			expect(dryRes.totalAdded).toBe(3); // de 缺 1，zh-TW 缺 2
			expect(dryRes.totalPruned).toBe(1); // de 多 1

			// 验证 dryRun 下文件未被改写
			const rawDeBefore = JSON.parse(readFileSync(join(tempDir, "locales/de.json"), "utf8"));
			expect(rawDeBefore.strings.deadKey).toBe("Soll weg");

			// 真实同步
			const realRes = await syncLocales({ repoRoot: tempDir });
			expect(realRes.hasChanges).toBe(true);

			// 读取同步后的 de.json
			const syncDe = JSON.parse(readFileSync(join(tempDir, "locales/de.json"), "utf8"));
			// 1. 键序必须与 zh 一致
			expect(Object.keys(syncDe.strings)).toEqual(["apple", "banana", "cherry"]);
			// 2. 原有翻译保留
			expect(syncDe.strings.apple).toBe("Apfel");
			expect(syncDe.strings.banana).toBe("Banane {count} Stk");
			// 3. 死 key 已被剔除
			expect(syncDe.strings.deadKey).toBeUndefined();
			// 4. 新 key 自动使用 en 的英文填充，无中文残留
			expect(syncDe.strings.cherry).toBe("Cherry");
			expect(/[\u4e00-\u9fff]/.test(syncDe.strings.cherry)).toBe(false);

			// 读取同步后的 zh-TW.json
			const syncTw = JSON.parse(readFileSync(join(tempDir, "locales/zh-TW.json"), "utf8"));
			expect(Object.keys(syncTw.strings)).toEqual(["apple", "banana", "cherry"]);
			expect(syncTw.strings.apple).toBe("蘋果");
			expect(syncTw.strings.banana).toContain("{count}");

			// 再次检查应该 0 差异
			const checkRes = await syncLocales({ repoRoot: tempDir, checkOnly: true });
			expect(checkRes.ok).toBe(true);
			expect(checkRes.hasChanges).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("重写语言包时不得吞掉 serverStrings（服务端 pick() 的译文）", async () => {
		// 回归：以前这里手工重建 { code, nativeName, version, strings }，每次
		// `npm run i18n:sync` 都会把同一文件里的 serverStrings 静默删掉
		// （pt/ja/tr 各丢 371/164/327 条，server-i18n / locales 单测连带全红）。
		const tempDir = mkdtempSync(join(tmpdir(), "pi-sync-locales-ss-"));
		try {
			mkdirSync(join(tempDir, "web/src"), { recursive: true });
			mkdirSync(join(tempDir, "locales"), { recursive: true });
			writeFileSync(
				join(tempDir, "web/src/i18n.tsx"),
				`export const zh = { apple: "苹果", banana: "香蕉" };
export const en: Record<keyof typeof zh, string> = { apple: "Apple", banana: "Banana" };
`,
				"utf8",
			);
			// pt.json：缺 banana（会触发重写）+ 带 serverStrings
			const mockPt = {
				code: "pt",
				nativeName: "Português",
				version: "1.0.0",
				strings: { apple: "Maçã" },
				serverStrings: { "agent.role.stop": "O modo objetivo encerrou uma conversa auxiliar" },
			};
			writeFileSync(join(tempDir, "locales/pt.json"), JSON.stringify(mockPt, null, "\t") + "\n", "utf8");

			const res = await syncLocales({ repoRoot: tempDir });
			expect(res.hasChanges).toBe(true);

			const synced = JSON.parse(readFileSync(join(tempDir, "locales/pt.json"), "utf8"));
			expect(Object.keys(synced.strings)).toEqual(["apple", "banana"]);
			expect(synced.strings.apple).toBe("Maçã");
			// 服务端译文原样保留（不是被重建/清空）
			expect(synced.serverStrings).toEqual({ "agent.role.stop": "O modo objetivo encerrou uma conversa auxiliar" });
			// 顶层键顺序也保持（写回不再重排/丢键）
			expect(Object.keys(synced)).toEqual(["code", "nativeName", "version", "strings", "serverStrings"]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
