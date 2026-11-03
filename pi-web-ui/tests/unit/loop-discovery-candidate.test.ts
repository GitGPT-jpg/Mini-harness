/**
 * 发现候选语义（Prompt 修复⑥）：裸 validate.py/run.py 只是探测候选，不是已确认输入。
 * 未确认前该输入仍算缺失；summary 显式标注 candidates。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderDiscoverySummary, resolveTaskContext } from "../../server/loop/discovery.js";

const TMP = mkdtempSync(join(tmpdir(), "loop-discovery-candidate-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("发现候选 ≠ 已确认输入", () => {
	it("裸 validate.py 归入 candidates 且仍算缺失；用户显式输入后才确认", () => {
		const ws = join(TMP, "ws-validate-py");
		mkdirSync(ws, { recursive: true });
		writeFileSync(join(ws, "validate.py"), "print(1)");
		const ctx = resolveTaskContext("cache-loss", ws, {});
		const byId = new Map(ctx.inputs.map((i) => [i.id, i]));
		// 不是已确认：value 为 null，sourceOf 标注候选
		const v = byId.get("validateCmd");
		expect(v?.value).toBeNull();
		expect(ctx.candidates.some((c) => c.inputId === "validateCmd" && c.value === "validate.py")).toBe(true);
		expect(ctx.missing.map((m) => m.id)).toContain("validateCmd");
		// summary 显式标出候选与缺失
		const summary = renderDiscoverySummary(ctx);
		expect(summary).toContain("candidates");
		expect(summary).toContain("validateCmd=validate.py");
		expect(summary).toContain("missing");

		// 用户显式确认后：不再缺失、不再候选
		const ctx2 = resolveTaskContext("cache-loss", ws, { validateCmd: "python3 validate.py --validate" });
		expect(ctx2.candidates).toHaveLength(0);
		expect(ctx2.missing).toHaveLength(0);
		expect(ctx2.inputs.find((i) => i.id === "validateCmd")?.value).toBe("python3 validate.py --validate");
	});

	it("run.py 同样只是候选，不冒充验收命令", () => {
		const ws = join(TMP, "ws-run-py");
		mkdirSync(ws, { recursive: true });
		writeFileSync(join(ws, "run.py"), "print(1)");
		const ctx = resolveTaskContext("cache-loss", ws, {});
		expect(ctx.candidates.some((c) => c.inputId === "validateCmd" && c.value === "run.py")).toBe(true);
		expect(ctx.missing.map((m) => m.id)).toContain("validateCmd");
	});
});
