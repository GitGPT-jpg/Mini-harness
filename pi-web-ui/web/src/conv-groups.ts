/**
 * 左栏「运行的对话」的分组（跨项目）：当前项目排最前、不显示组标题（项目名），
 * 其余项目按路径稳定排序并挂上组标题。
 *
 * 抽成纯函数是为了那个「切项目时项目名闪一下」的坑（#140 的回归），有单测：
 * `tests/unit/conv-groups.test.ts`。
 */
import type { ConversationSummary } from "./types";

interface ConvGroup {
	cwd: string;
	isCurrent: boolean;
	convs: ConversationSummary[];
}

/**
 * Group the (now cross-project) running-conversation list by workspace,
 * current project first, others in stable path order. Lets the left panel
 * disambiguate same-titled chats across projects and shows where each
 * background run lives.
 *
 * 「当前项目」取哪个信号：`set_cwd` / 跨项目切对话时，服务端先推 `conversations`
 * （activeId 已经是新项目的对话），带新 `cwd` 的快照随后才到 —— 两个信号不同时
 * 到达。所以**只要当前对话在列表里，就认它所在的分组为当前项目**（唯一），
 * `currentCwd` 只作为它不在列表里时（空白新对话）的回落。只按 `cwd` 判定的那一
 * 帧会把当前项目当成「别的项目」，于是它顶上闪一下项目名再消失（实测约 8ms 一帧，
 * 正是用户看到的那一跳）；同一组立即置顶，也免掉了随后的位置跳动。
 */
export function groupConversations(
	list: ConversationSummary[],
	currentCwd: string,
	activeConversationId: string,
): ConvGroup[] {
	const byId = new Map(list.map((c) => [c.id, c]));
	/** 分组归属：子对话（即使自己 cwd 不同）跟着父对话的项目走。 */
	const groupCwdOf = (c: ConversationSummary): string => (c.parentId ? (byId.get(c.parentId)?.cwd ?? c.cwd) : c.cwd);
	const activeConv = list.find((c) => c.id === activeConversationId);
	const effectiveCwd = activeConv ? groupCwdOf(activeConv) : currentCwd;

	const byCwd = new Map<string, ConversationSummary[]>();
	for (const c of list) {
		const groupCwd = groupCwdOf(c);
		const arr = byCwd.get(groupCwd) ?? [];
		arr.push(c);
		byCwd.set(groupCwd, arr);
	}
	const groups: ConvGroup[] = [...byCwd.entries()].map(([cwd, convs]) => ({
		cwd,
		isCurrent: cwd === effectiveCwd,
		convs,
	}));
	groups.sort((a, b) => (a.isCurrent ? -1 : b.isCurrent ? 1 : a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0));
	return groups;
}

export interface ConvRowItem {
	c: ConversationSummary;
	depth: number;
	hasKids: boolean;
	isCollapsed: boolean;
	descendantCount: number;
	hasStreaming: boolean;
	hasError: boolean;
	hasQuestion: boolean;
}

/**
 * 将同组内的对话按父子树展开成扁平渲染行列表（issue #564）。
 * 当父对话处于折叠状态时，其所有后代子代理从行列表中隐藏，并在父行上汇总后代计数与活跃状态。
 */
export function buildConversationRows(
	convs: ConversationSummary[],
	collapsedParentIds: Set<string> = new Set(),
): ConvRowItem[] {
	const byId = new Map(convs.map((x) => [x.id, x]));
	const kids = new Map<string, ConversationSummary[]>();
	const roots: ConversationSummary[] = [];

	for (const x of convs) {
		if (x.parentId && byId.has(x.parentId)) {
			const arr = kids.get(x.parentId) ?? [];
			arr.push(x);
			kids.set(x.parentId, arr);
		} else {
			roots.push(x);
		}
	}

	const getDescendants = (id: string): ConversationSummary[] => {
		const res: ConversationSummary[] = [];
		const queue = [...(kids.get(id) ?? [])];
		const visited = new Set<string>();
		while (queue.length > 0) {
			const item = queue.shift()!;
			if (visited.has(item.id)) continue;
			visited.add(item.id);
			res.push(item);
			const sub = kids.get(item.id);
			if (sub) queue.push(...sub);
		}
		return res;
	};

	const rows: ConvRowItem[] = [];
	const seen = new Set<string>();
	const hidden = new Set<string>();

	const append = (c: ConversationSummary, depth: number) => {
		if (seen.has(c.id) || hidden.has(c.id)) return;
		seen.add(c.id);

		const myKids = kids.get(c.id) ?? [];
		const hasKids = myKids.length > 0;
		const isCollapsed = hasKids && collapsedParentIds.has(c.id);

		let descendantCount = 0;
		let hasStreaming = false;
		let hasError = false;
		let hasQuestion = false;

		if (hasKids) {
			const descendants = getDescendants(c.id);
			descendantCount = descendants.length;
			hasStreaming = descendants.some((d) => d.isStreaming);
			hasError = descendants.some((d) => Boolean(d.error));
			hasQuestion = descendants.some((d) => Boolean(d.hasQuestion));

			if (isCollapsed) {
				for (const d of descendants) {
					hidden.add(d.id);
				}
			}
		}

		rows.push({
			c,
			depth,
			hasKids,
			isCollapsed,
			descendantCount,
			hasStreaming,
			hasError,
			hasQuestion,
		});

		if (!isCollapsed) {
			for (const child of myKids) append(child, depth + 1);
		}
	};

	for (const root of roots) append(root, 0);
	for (const orphan of convs) append(orphan, 0);

	return rows;
}
