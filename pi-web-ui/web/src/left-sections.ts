/**
 * 左栏分区（最近项目 / 运行的对话 / 历史对话 + 插件自定义分区）的**顺序、显隐与权重**纯函数。
 *
 * 数据来源是宿主挂载点 `leftpanel.sections`：
 *   - 三条 `host:lp-*` 是宿主内置分区（P2）；
 *   - 插件可以用 `kind="view"` 往这里加**自定义分区**（P4）：分区正文由插件的客户端
 *     bundle 挂载（同 tasks.panel 的 PluginPage 口径）。插件**不能替换**内置分区，
 *     只能新增；内置分区的隐藏 / 调序仍走布局页与 arrange hide。
 * 合并引擎（四层：宿主默认 → 插件 → arrange → 用户偏好）决定每条的 `hidden` 与 `order`，
 * LeftPanel 只按这里算出的计划渲染。
 *
 * 为什么抽成纯模块：排序 / 显隐 / 分隔条配对 / 权重持久化是最容易错的部分，单独成模块才能
 * 穷举单测，而不用起 React。
 */

/** 插件自定义分区的键：`plugin:<插件id>:<条目id>`（条目 id 即合并引擎的全局 id）。 */
export type PluginSectionKey = `plugin:${string}`;

/** 左栏分区键：三个宿主分区 + 插件自定义分区。 */
export type LpSectionKey = "projects" | "convs" | "sessions" | PluginSectionKey;

/** 宿主分区键 → 挂载点条目 id（用户偏好与插件 arrange 都用这个 id）。 */
export const LP_SECTION_ENTRY_ID: Readonly<Record<"projects" | "convs" | "sessions", string>> = {
	projects: "host:lp-projects",
	convs: "host:lp-running",
	sessions: "host:lp-history",
};

/** 宿主分区的缺省顺序（没有任何条目信息时，与改造前的 JSX 先后一致）。 */
export const LP_SECTION_DEFAULT_ORDER: readonly ("projects" | "convs" | "sessions")[] = [
	"projects",
	"convs",
	"sessions",
];

const HOST_KEY_BY_ENTRY_ID: ReadonlyMap<string, "projects" | "convs" | "sessions"> = new Map(
	(Object.keys(LP_SECTION_ENTRY_ID) as ("projects" | "convs" | "sessions")[]).map((k) => [LP_SECTION_ENTRY_ID[k], k]),
);

/** 插件分区键前缀（权重持久化时用来区分「宿主键」与「插件键」）。 */
const PLUGIN_KEY_PREFIX = "plugin:";

export function isPluginSectionKey(key: string): key is PluginSectionKey {
	return key.startsWith(PLUGIN_KEY_PREFIX) && key.length > PLUGIN_KEY_PREFIX.length;
}

/** 合并引擎给出的一条分区条目（只取计划需要的字段）。 */
export interface LpSectionEntryLike {
	id: string;
	hidden?: boolean;
	/** `host` 或 `plugin:<id>`。 */
	source?: string;
	/** 插件分区必须是 `view`（其余种类由引擎丢弃）。 */
	kind?: string;
}

export interface LpSectionPlanItem<E extends LpSectionEntryLike = LpSectionEntryLike> {
	key: LpSectionKey;
	/** false = 用户（或插件）隐藏了这个分区：不渲染、不占权重、不画分隔条。 */
	shown: boolean;
	/** 插件自定义分区的条目（宿主分区没有）；类型跟随调用方传入的条目类型。 */
	entry?: E;
}

/**
 * 算出分区的渲染计划（顺序 + 显隐）。
 *  - 条目按传入顺序（= 合并引擎已排好的挂载点顺序）决定先后；插件分区也按这个顺序插入；
 *  - 不认识的条目 id 忽略（只认宿主三条 + 「插件、kind=view」的条目）；
 *  - 缺失的**宿主**分区按缺省顺序补在末尾（条目被整体去掉时界面仍完整）。插件分区不补。
 */
export function planLeftSections<E extends LpSectionEntryLike>(
	entries: readonly E[] | undefined,
): LpSectionPlanItem<E>[] {
	const order: LpSectionPlanItem<E>[] = [];
	const seen = new Set<string>();
	for (const e of entries ?? []) {
		let key: LpSectionKey | null = null;
		let entry: E | undefined;
		const host = HOST_KEY_BY_ENTRY_ID.get(e.id);
		if (host) key = host;
		else if (e.source?.startsWith("plugin:") && e.kind === "view") {
			key = `${PLUGIN_KEY_PREFIX}${e.id}` as PluginSectionKey;
			entry = e;
		}
		if (!key || seen.has(key)) continue;
		seen.add(key);
		order.push({ key, shown: !e.hidden, ...(entry ? { entry } : {}) });
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
 * 权重存档解析：宿主键只接受 `defaults` 里有的键；插件分区键（`plugin:` 前缀）原样保留。
 * 只收正的有限数字，其余丢弃；坏 JSON 回落全量默认。
 */
export function parseLpWeights(raw: string | null, defaults: Readonly<Record<string, number>>): Record<string, number> {
	const out: Record<string, number> = { ...defaults };
	if (!raw) return out;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (!(key in defaults) && !isPluginSectionKey(key)) continue;
			if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
		}
	} catch {
		// 坏 JSON → 全量默认
	}
	return out;
}
