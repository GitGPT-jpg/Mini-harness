/**
 * 左栏「运行的对话」分组（#140 的回归）：当前项目那组不显示组标题（项目名）。
 *
 * 关键回归：`set_cwd` / 跨项目切对话时，`conversations` 推送先到（activeId 已是
 * 新对话），带新 cwd 的快照后到 —— 中间那一帧只按 cwd 判定会把当前项目当成
 * 「别的项目」，顶上闪一下项目名再消失。含当前对话的组必须直接算当前项目。
 */
import { describe, expect, it } from "vitest";
import { buildConversationRows, groupConversations } from "../../web/src/conv-groups.js";
import type { ConversationSummary } from "../../web/src/types.js";

const conv = (id: string, cwd: string, extra: Partial<ConversationSummary> = {}): ConversationSummary => ({
	id,
	title: id,
	cwd,
	messageCount: 1,
	isStreaming: false,
	isSubagent: false,
	...extra,
});

const A = "C:/proj/a";
const B = "C:/proj/b";

describe("groupConversations", () => {
	it("按 cwd 分组，当前项目排最前并标记 isCurrent", () => {
		const groups = groupConversations([conv("c1", A), conv("c2", B)], B, "c2");
		expect(groups.map((g) => g.cwd)).toEqual([B, A]);
		expect(groups[0].isCurrent).toBe(true);
		expect(groups[1].isCurrent).toBe(false);
	});

	it("cwd 还没跟上、但 activeId 已在目标项目时，当前项目以 activeId 为准", () => {
		// 切到 B 的那一帧：客户端 cwd 还是 A，列表里 active 已经是 B 的对话。
		// 当前项目只能有一个（B）：A 那组是别的项目的后台运行，标题照旧显示。
		const groups = groupConversations([conv("c1", A), conv("c2", B)], A, "c2");
		expect(groups[0].cwd).toBe(B);
		expect(groups[0].isCurrent).toBe(true);
		expect(groups[1].cwd).toBe(A);
		expect(groups[1].isCurrent).toBe(false);
	});

	it("只有一个项目时（切过去只有一条对话）也认 activeId", () => {
		const groups = groupConversations([conv("c9", A)], B, "c9");
		expect(groups).toHaveLength(1);
		expect(groups[0].isCurrent).toBe(true);
	});

	it("activeId 不在列表里（空白新对话）时只按 cwd 判定", () => {
		const groups = groupConversations([conv("c1", A), conv("c2", B)], A, "c-blank");
		expect(groups[0].cwd).toBe(A);
		expect(groups[0].isCurrent).toBe(true);
		expect(groups[1].isCurrent).toBe(false);
	});

	it("子代理挂在父对话的项目下（即使自己 cwd 不同）", () => {
		const groups = groupConversations([conv("p", A), conv("s", B, { isSubagent: true, parentId: "p" })], B, "s");
		expect(groups).toHaveLength(1);
		expect(groups[0].cwd).toBe(A);
		expect(groups[0].convs.map((c) => c.id)).toEqual(["p", "s"]);
		// 父组是当前项目（其中就有当前对话），所以不显示组标题
		expect(groups[0].isCurrent).toBe(true);
	});

	it("空列表 → 空分组", () => {
		expect(groupConversations([], A, "")).toEqual([]);
	});
});

describe("buildConversationRows (issue #564 子代理树展开与折叠)", () => {
	it("默认未折叠时展开全部子代理行，深度与父子关系正确", () => {
		const parent = conv("p1", A);
		const kid1 = conv("k1", A, { isSubagent: true, parentId: "p1" });
		const kid2 = conv("k2", A, { isSubagent: true, parentId: "p1" });
		const rows = buildConversationRows([parent, kid1, kid2]);

		expect(rows).toHaveLength(3);
		expect(rows[0].c.id).toBe("p1");
		expect(rows[0].depth).toBe(0);
		expect(rows[0].hasKids).toBe(true);
		expect(rows[0].isCollapsed).toBe(false);
		expect(rows[0].descendantCount).toBe(2);

		expect(rows[1].c.id).toBe("k1");
		expect(rows[1].depth).toBe(1);
		expect(rows[1].hasKids).toBe(false);

		expect(rows[2].c.id).toBe("k2");
		expect(rows[2].depth).toBe(1);
		expect(rows[2].hasKids).toBe(false);
	});

	it("父对话处于折叠状态时：隐藏子代理行，父行包含准确的计数与活跃状态", () => {
		const parent = conv("p1", A);
		const kid1 = conv("k1", A, { isSubagent: true, parentId: "p1", isStreaming: true });
		const kid2 = conv("k2", A, { isSubagent: true, parentId: "p1", hasQuestion: true });
		const kid3 = conv("k3", A, { isSubagent: true, parentId: "p1", error: "failed" });
		const standalone = conv("c2", A);

		const collapsed = new Set(["p1"]);
		const rows = buildConversationRows([parent, kid1, kid2, kid3, standalone], collapsed);

		// k1, k2, k3 被隐藏，只剩下 p1 和 standalone
		expect(rows).toHaveLength(2);
		expect(rows[0].c.id).toBe("p1");
		expect(rows[0].hasKids).toBe(true);
		expect(rows[0].isCollapsed).toBe(true);
		expect(rows[0].descendantCount).toBe(3);
		expect(rows[0].hasStreaming).toBe(true);
		expect(rows[0].hasQuestion).toBe(true);
		expect(rows[0].hasError).toBe(true);

		expect(rows[1].c.id).toBe("c2");
		expect(rows[1].hasKids).toBe(false);
	});

	it("深层嵌套（孙代理）递归折叠：折叠父时整棵子树隐藏，计数包含多级后代", () => {
		const parent = conv("p1", A);
		const child = conv("c1", A, { isSubagent: true, parentId: "p1" });
		const grandChild = conv("g1", A, { isSubagent: true, parentId: "c1", isStreaming: true });

		// 1. 折叠根父：整棵树都被隐藏
		const rowsRootCollapsed = buildConversationRows([parent, child, grandChild], new Set(["p1"]));
		expect(rowsRootCollapsed).toHaveLength(1);
		expect(rowsRootCollapsed[0].descendantCount).toBe(2);
		expect(rowsRootCollapsed[0].hasStreaming).toBe(true);

		// 2. 根父展开，仅折叠子代理：grandChild 被隐藏
		const rowsChildCollapsed = buildConversationRows([parent, child, grandChild], new Set(["c1"]));
		expect(rowsChildCollapsed).toHaveLength(2);
		expect(rowsChildCollapsed[0].c.id).toBe("p1");
		expect(rowsChildCollapsed[0].isCollapsed).toBe(false);
		expect(rowsChildCollapsed[1].c.id).toBe("c1");
		expect(rowsChildCollapsed[1].isCollapsed).toBe(true);
		expect(rowsChildCollapsed[1].descendantCount).toBe(1);
		expect(rowsChildCollapsed[1].hasStreaming).toBe(true);
	});

	it("孤儿对话（parentId 指向不存在的会话）安全保底平铺在根层级", () => {
		const orphan = conv("orphan1", A, { isSubagent: true, parentId: "non-existent" });
		const normal = conv("normal1", A);
		const rows = buildConversationRows([orphan, normal]);

		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.c.id)).toEqual(["orphan1", "normal1"]);
		expect(rows.every((r) => r.depth === 0)).toBe(true);
	});
});
