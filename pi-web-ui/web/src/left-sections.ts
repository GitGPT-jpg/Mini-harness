/**
 * 左栏分区（最近项目 / 运行的对话 / 历史对话）的**顺序、显隐与权重**纯函数。
 *
 * 数据来源是宿主挂载点 `leftpanel.sections`：三条 `host:lp-*` 是宿主内置分区（P2）。
 * 合并引擎（宿主默认 → 用户偏好）决定每条的 `hidden` 与 `order`，
 * LeftPanel 只按这里算出的计划渲染。
 *
 * 为什么抽成纯模块：排序 / 显隐 / 分隔条配对 / 权重持久化是最容易错的部分，单独成模块才能
 * 穷举单测，而不用起 React。
 */

/** 左栏分区键：三个宿主分区。 */
export type LpSectionKey = "projects" | "convs" | "sessions";

/** 宿主分区键 → 挂载点条目 id（用户偏好用这个 id）。 */
export const LP_SECTION_ENTRY_ID: Readonly<Record<LpSectionKey, string>> = {
	projects: "host:lp-projects",
	convs: "host:lp-running",
	sessions: "host:lp-history",
};

/** 宿主分区的缺省顺序（没有任何条目信息时，与改造前的 JSX 先后一致）。 */
export const LP_SECTION_DEFAULT_ORDER: readonly LpSectionKey[] = ["projects", "convs", "sessions"];

const HOST_KEY_BY_ENTRY_ID: ReadonlyMap<string, LpSectionKey> = new Map(
	(Object.keys(LP_SECTION_ENTRY_ID) as LpSectionKey[]).map((k) => [LP_SECTION_ENTRY_ID[k], k]),
);

/** 合并引擎给出的一条分区条目（只取计划需要的字段）。 */
export interface LpSectionEntryLike {
	id: string;
	hidden?: boolean;
}

export interface LpSectionPlanItem {
	key: LpSectionKey;
	/** false = 用户隐藏了这个分区：不渲染、不占权重、不画分隔条。 */
	shown: boolean;
}

/**
 * 算出分区的渲染计划（顺序 + 显隐）。
 *  - 条目按传入顺序（= 合并引擎已排好的挂载点顺序）决定先后；
 *  - 不认识的条目 id 忽略（只认宿主三条）；
 *  - 缺失的分区按缺省顺序补在末尾（条目被整体去掉时界面仍完整）。
 */
export function planLeftSections(entries: readonly LpSectionEntryLike[] | undefined): LpSectionPlanItem[] {
	const order: LpSectionPlanItem[] = [];
	const seen = new Set<string>();
	for (const e of entries ?? []) {
		const key = HOST_KEY_BY_ENTRY_ID.get(e.id);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		order.push({ key, shown: !e.hidden });
	}
	for (const key of LP_SECTION_DEFAULT_ORDER) {
		if (!seen.has(key)) order.push({ key, shown: true });
	}
	return order;
}

/**
 * 参与权重分配的分区（flex）：显示中 且 自身「有内容」的那些。
 * 项目区没有项目、运行区没有运行对话时只剩标题（或不渲染），不吃权重也不画分隔条。
 */
export function flexSectionKeys(
	plan: readonly LpSectionPlanItem[],
	hasContent: (key: LpSectionKey) => boolean,
): LpSectionKey[] {
	return plan.filter((p) => p.shown && hasContent(p.key)).map((p) => p.key);
}

/**
 * 相邻两个 flex 分区之间的分隔条：只有两端都展开才画（与改造前的条件一致）。
 * 返回 [上, 下] 对，调用方按 above 键挂到对应分区后面。
 */
export function sashPairs(
	flex: readonly LpSectionKey[],
	collapsed: (key: LpSectionKey) => boolean,
): [LpSectionKey, LpSectionKey][] {
	const out: [LpSectionKey, LpSectionKey][] = [];
	for (let i = 0; i + 1 < flex.length; i++) {
		const above = flex[i]!;
		const below = flex[i + 1]!;
		if (!collapsed(above) && !collapsed(below)) out.push([above, below]);
	}
	return out;
}

/**
 * 权重存档解析：只接受 `defaults` 里有的键。
 * 只收正的有限数字，其余丢弃；坏 JSON 回落全量默认。
 */
export function parseLpWeights(raw: string | null, defaults: Readonly<Record<string, number>>): Record<string, number> {
	const out: Record<string, number> = { ...defaults };
	if (!raw) return out;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (!(key in defaults)) continue;
			if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
		}
	} catch {
		// 坏 JSON → 全量默认
	}
	return out;
}
