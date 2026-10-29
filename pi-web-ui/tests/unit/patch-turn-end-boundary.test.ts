import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	candidateAgentSessionFiles,
	PATCHED_SENTINEL,
	patchAgentSessionSource,
	TARGET_PATTERN,
} from "../../server/patch-turn-end-boundary.js";

const RAW_MOCK_SOURCE = `
    async _dispatchTurnEndBoundary(message, toolResults) {
        this._lastActivityOutcome =
            message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";
        const messageEntryId = this._findPersistedMessageEntryId(message);
        if (!this._extensionRunner.hasHandlers("turn_end"))
            return false;
        if (!messageEntryId) {
            this._extensionRunner.emitError({
                extensionPath: "<boundary>",
                event: "turn_end",
                error: "turn_end could not resolve the persisted assistant entry ID",
            });
            return false;
        }
        const toolResultEntryIds = toolResults.flatMap((result) => {
            const entryId = this._findPersistedMessageEntryId(result);
            return entryId ? [entryId] : [];
        });
    }
`;

describe("patch-turn-end-boundary (issue #411)", () => {
	it("替换正确性：将 emitError 换成静默 return false", () => {
		const res = patchAgentSessionSource(RAW_MOCK_SOURCE);
		expect(res.patched).toBe(true);
		expect(res.code).toContain(PATCHED_SENTINEL);
		expect(res.code).toContain("return false;");
		expect(res.code).not.toContain("turn_end could not resolve the persisted assistant entry ID");
	});

	it("幂等性：已打补丁的源码再次 patch 时静默跳过", () => {
		const first = patchAgentSessionSource(RAW_MOCK_SOURCE);
		expect(first.patched).toBe(true);

		const second = patchAgentSessionSource(first.code);
		expect(second.patched).toBe(false);
		expect(second.code).toBe(first.code);
	});

	it("结构不匹配时原样返回（上游结构变化或非目标源码）", () => {
		const unrelated = `function unrelatedCode() { return true; }`;
		const res = patchAgentSessionSource(unrelated);
		expect(res.patched).toBe(false);
		expect(res.code).toBe(unrelated);
	});

	it("现装 SDK 可被识别（待上游修复后此测试变红提示删除 patch）", () => {
		const files = candidateAgentSessionFiles().filter((f) => existsSync(f));
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const src = readFileSync(file, "utf8");
			expect(TARGET_PATTERN.test(src) || src.includes(PATCHED_SENTINEL)).toBe(true);
		}
	});
});
