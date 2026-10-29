import { describe, expect, it } from "vitest";
import { classifyScroll, shouldEscapeOnScroll } from "../../web/src/components/scroll-classify.js";

/**
 * MUTATION-PROOF PIN for the scroll layout-shift discriminator (5cd680b).
 *
 * The synthetic E2E harness self-recovers (the lazy-window sweep re-clears
 * escapedRef), so reverting the dSh<0 branch still shows 9/9 green there.
 * These unit tests do NOT self-recover: if you simulate the pre-fix behavior
 * by deleting/commenting the `if (dSh < 0)` branch in classifyScroll
 * (web/src/components/scroll-classify.ts) — i.e. always treating a moderate
 * negative dSt as user intent (flipEscape = true) — the tests marked
 * [MUTATION-KILL] below MUST fail.
 *
 * Mutation check procedure:
 *   1. Comment out `if (dSh < 0) { ... return ...; }` in classifyScroll.
 *   2. npx vitest run tests/unit/scroll-classify.test.ts  → expect RED.
 *   3. Restore the branch.
 *   4. npx vitest run tests/unit/scroll-classify.test.ts  → expect GREEN.
 */
const base = {
	escaped: false,
	graceActive: false,
	stuck: true,
};

function run(over: Partial<Parameters<typeof classifyScroll>[0]>) {
	return classifyScroll({ ...base, ...over } as Parameters<typeof classifyScroll>[0]);
}

describe("classifyScroll — layout-shift discriminator decision table", () => {
	it("[MUTATION-KILL] dSt in (-500,-4), dSh < 0, escaped=false, stuck → NO flipEscape, reassert=true (layout collapse while stuck: follow the bottom)", () => {
		const d = run({ dSt: -120, dSh: -300 });
		expect(d.flipEscape).toBe(false);
		expect(d.reassert).toBe(true);
	});

	it("[MUTATION-KILL] dSt in (-500,-4), dSh < 0, escaped=true → stays escaped (collapsed while reading: no drag, no reassert)", () => {
		const d = run({ dSt: -120, dSh: -300, escaped: true });
		expect(d.flipEscape).toBe(false);
		expect(d.reassert).toBe(false);
	});

	it("[MUTATION-KILL] dSt in (-500,-4), dSh >= 0 (true user wheel-up) → flipEscape=true", () => {
		const d = run({ dSt: -120, dSh: 0 });
		expect(d.flipEscape).toBe(true);
		expect(d.reassert).toBe(false);

		const growing = run({ dSt: -120, dSh: 50 });
		expect(growing.flipEscape).toBe(true);
	});

	it("dSt < -500 (large jump = native clamp after layout collapse) → escape preserved: no flip, no reassert", () => {
		const collapse = run({ dSt: -800, dSh: -600 });
		expect(collapse.flipEscape).toBe(false);
		expect(collapse.reassert).toBe(false);

		const largeUser = run({ dSt: -800, dSh: 0 });
		expect(largeUser.flipEscape).toBe(false); // existing behavior for that band
	});

	it("dSt >= -4 → no-op", () => {
		for (const dSt of [0, 5, -4]) {
			const d = run({ dSt, dSh: 0 });
			expect(d.flipEscape).toBe(false);
			expect(d.reassert).toBe(false);
		}
	});

	it("graceActive=true + negative dSt → no flip, no reassert (programmatic jumps are never user intent)", () => {
		const d = run({ dSt: -120, dSh: -300, graceActive: true });
		expect(d.flipEscape).toBe(false);
		expect(d.reassert).toBe(false);
	});

	it("not stuck → no reassert even on layout collapse", () => {
		const d = run({ dSt: -120, dSh: -300, stuck: false });
		expect(d.reassert).toBe(false);
		expect(d.flipEscape).toBe(false);
	});
});

describe("shouldEscapeOnScroll — 用户物理手势门禁与布局突变重吸底", () => {
	it("用户真实向上滚轮/手势（hasUserUpwardIntent=true）且 flipEscape=true → 准许逃逸，不吸底", () => {
		const res = shouldEscapeOnScroll({
			decisionFlipEscape: true,
			hasUserUpwardIntent: true,
			stuck: true,
			escaped: false,
		});
		expect(res.shouldEscape).toBe(true);
		expect(res.shouldReassert).toBe(false);
	});

	it("长输出工具/正文流式排版导致负向抖动但无用户手势（hasUserUpwardIntent=false）且处于吸底态 → 拒绝逃逸，强制重新吸底", () => {
		const res = shouldEscapeOnScroll({
			decisionFlipEscape: true,
			hasUserUpwardIntent: false,
			stuck: true,
			escaped: false,
		});
		expect(res.shouldEscape).toBe(false);
		expect(res.shouldReassert).toBe(true);
	});

	it("用户已处于逃逸状态（escaped=true）时发生布局突变 → 不逃逸，也不强行拉回底部（不打扰用户看历史）", () => {
		const res = shouldEscapeOnScroll({
			decisionFlipEscape: true,
			hasUserUpwardIntent: false,
			stuck: false,
			escaped: true,
		});
		expect(res.shouldEscape).toBe(false);
		expect(res.shouldReassert).toBe(false);
	});

	it("decisionFlipEscape=false → 既不逃逸也不再吸底", () => {
		const res = shouldEscapeOnScroll({
			decisionFlipEscape: false,
			hasUserUpwardIntent: false,
			stuck: true,
			escaped: false,
		});
		expect(res.shouldEscape).toBe(false);
		expect(res.shouldReassert).toBe(false);
	});
});
