import { describe, expect, it } from "vitest";
import { getMaxOpenConversations, MAX_OPEN_CONVERSATIONS } from "../../server/agent-formatters.js";

describe("getMaxOpenConversations", () => {
	it("默认返回 MAX_OPEN_CONVERSATIONS (8)，支持 PI_WEB_MAX_OPEN_CONVERSATIONS 覆盖", () => {
		const prev = process.env.PI_WEB_MAX_OPEN_CONVERSATIONS;
		try {
			delete process.env.PI_WEB_MAX_OPEN_CONVERSATIONS;
			expect(getMaxOpenConversations()).toBe(MAX_OPEN_CONVERSATIONS);
			expect(getMaxOpenConversations()).toBe(8);

			process.env.PI_WEB_MAX_OPEN_CONVERSATIONS = "32";
			expect(getMaxOpenConversations()).toBe(32);

			process.env.PI_WEB_MAX_OPEN_CONVERSATIONS = "0";
			expect(getMaxOpenConversations()).toBe(8);

			process.env.PI_WEB_MAX_OPEN_CONVERSATIONS = "-3";
			expect(getMaxOpenConversations()).toBe(8);

			process.env.PI_WEB_MAX_OPEN_CONVERSATIONS = "invalid";
			expect(getMaxOpenConversations()).toBe(8);

			// 非整数向下取整、且最小 1（与 getMaxSubagents 同口径）。
			process.env.PI_WEB_MAX_OPEN_CONVERSATIONS = "2.7";
			expect(getMaxOpenConversations()).toBe(2);

			process.env.PI_WEB_MAX_OPEN_CONVERSATIONS = "0.5";
			expect(getMaxOpenConversations()).toBe(1);
		} finally {
			if (prev === undefined) delete process.env.PI_WEB_MAX_OPEN_CONVERSATIONS;
			else process.env.PI_WEB_MAX_OPEN_CONVERSATIONS = prev;
		}
	});
});
