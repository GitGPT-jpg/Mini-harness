/**
 * 会话快照的选会话策略单测（issue #542，server/conversation-view.ts，纯函数，无宿主/端口）。
 *
 * 覆盖：本客户端取「正在看的对话」/最近活跃、缺省跳过子代理、includeSubagents。
 * 内置定时任务经 `ClientSession.readConversationForScheduler` 用它取运行状态。
 */
import { describe, expect, it } from "vitest";
import { pickClientConversation } from "../../server/conversation-view.js";

const conv = (id: string, lastActiveAt: number, isSubagent = false) => ({ id, lastActiveAt, isSubagent });

describe("pickClientConversation", () => {
	it("给了 active 就返回它，即使它不是最近活跃的（标签页正在看的对话优先）", () => {
		const convs = [conv("a", 100), conv("b", 900)];
		expect(pickClientConversation(convs, { active: convs[0] })?.id).toBe("a");
	});

	it("没有 active 命中时退回归属本客户端的最近活跃会话", () => {
		const convs = [conv("a", 100), conv("b", 900), conv("c", 500)];
		expect(pickClientConversation(convs)?.id).toBe("b");
		expect(pickClientConversation(convs, { active: undefined })?.id).toBe("b");
		expect(pickClientConversation([])).toBeNull();
	});

	it("缺省跳过子代理（含 active 是子代理的情形）——子代理跑得再勤也不挤出用户正看的对话", () => {
		const parent = conv("parent", 100);
		const child = conv("child", 900, true);
		expect(pickClientConversation([parent, child], { active: child })?.id).toBe("parent");
		expect(pickClientConversation([child])).toBeNull();
	});

	it("includeSubagents 时子代理照算（显式按 clientId 取快照走这条）", () => {
		const parent = conv("parent", 100);
		const child = conv("child", 900, true);
		expect(pickClientConversation([parent, child], { includeSubagents: true })?.id).toBe("child");
		expect(pickClientConversation([parent, child], { active: child, includeSubagents: true })?.id).toBe("child");
	});

	it("lastActiveAt 相等时保留先遇到的（不来回跳）", () => {
		expect(pickClientConversation([conv("first", 5), conv("second", 5)])?.id).toBe("first");
	});
});
