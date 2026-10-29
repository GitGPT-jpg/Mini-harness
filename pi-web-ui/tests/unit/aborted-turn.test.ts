import { describe, expect, it } from "vitest";
import { isAbortedTurn } from "../../web/src/aborted-turn.js";

/** #575：用户停止 / 被抢占的回合是「中性收尾」，不是红色报错、不给「立刻重试」。 */
describe("isAbortedTurn", () => {
	it("SDK 中止（stopReason=aborted）→ 中止回合", () => {
		expect(isAbortedTurn({ stopReason: "aborted", errorMessage: "Request aborted" })).toBe(true);
		expect(isAbortedTurn({ stopReason: "aborted" })).toBe(true);
	});

	it("用户停止长等待：stopReason=error + 「This operation was aborted」→ 中止回合", () => {
		expect(isAbortedTurn({ stopReason: "error", errorMessage: "This operation was aborted" })).toBe(true);
	});

	it("真实上游报错仍是报错（不得因为文案里带 aborted 被吞掉）", () => {
		expect(isAbortedTurn({ stopReason: "error", errorMessage: "Request aborted by upstream gateway 502" })).toBe(false);
		expect(isAbortedTurn({ stopReason: "error", errorMessage: "429 rate limit exceeded" })).toBe(false);
	});

	it("正常结束 / 无 stopReason → 非中止", () => {
		expect(isAbortedTurn({ stopReason: "stop" })).toBe(false);
		expect(isAbortedTurn({})).toBe(false);
	});
});
