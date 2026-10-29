/**
 * 「图标编辑」模式的**纯函数引擎**（拖动改布局）。
 *
 * 为什么单开一层：拖拽本身是 DOM 事件（落点靠 `elementFromPoint` + 矩形中点算，见
 * `components/IconEditor.tsx`），但**「拖到哪 = 布局偏好怎么变」这件事必须可穷举断言** ——
 * 它写的正是 `uiLayout` 的 order / align / slots / hidden 四个字段，写错了要么条目消失，
 * 要么顺序每次渲染乱跳。所以：
 *
 *   组件只负责算出「谁被拖到了 (哪个栏, 哪个段落, 第几个位置)」，
 *   本模块把它翻译成下一份 `UiLayoutPrefs`（纯函数、无副作用、不碰 React/DOM）。
 *
 * 与设置 → 界面布局页的关系：那边是同一份偏好的**表单**视图（↑↓ + 下拉），这边是
 * **直接拖**。两者写的是同一套字段，改完立刻互相可见 —— 不存在第二份布局数据。
 *
 * ⚠ `order` 是**跨槽位共享的一维数组**，合并引擎（ui-slots.ts 的 sortEntries）只按
 * 「同槽位内的相对次序」用它：列表里的条目一律排在没列的之前。因此这里每次都**重写目标
 * 栏的整串顺序**（先摘掉该栏旧痕迹，再接在其他槽位顺序之后），否则新拖的条目会带着
 * 一个旧 rank 排在别人前面 —— 与设置页 moveUiEntry 同一口径。
 */
import type { UiAlign, UiLayoutPrefs, UiSlotId } from "./types";
import type { UiSlotEntry } from "./ui-slots";

/** 「图标编辑」能拖的四个栏。其余槽位（右键菜单、输入框动作区、面板 tab …）不在编辑范围，
 *  仍走设置 → 界面布局。 */
interface IconEditZone {
	slot: UiSlotId;
	/** 界面上的分区标题（i18n key）。 */
	labelKey: string;
	/** 是否按 start/center/end 分段展示与落位：顶栏与底栏在界面上确实按段渲染
	 *  （TopBar 的 segStart/segCenter/segEnd、FooterBar 的左右分区），其余栏整串排序。 */
	alignable: boolean;
	/** 该栏的分段是**竖轴**（左侧/右侧停靠栏：靠上/居中/靠下）而不是横轴（靠左/居中/靠右）。
	 *  只影响分段文案（start/center/end vs 靠上/居中/靠下），取值与拖放口径完全一致。 */
	vertical: boolean;
}

export const ICON_EDIT_ZONES: readonly IconEditZone[] = [
	{ slot: "topbar.primary", labelKey: "uiLayoutTopbar", alignable: true, vertical: false },
	{ slot: "bottombar", labelKey: "uiLayoutBottombar", alignable: true, vertical: false },
	{ slot: "sidebar.left", labelKey: "uiLayoutSidebarLeft", alignable: true, vertical: true },
	{ slot: "sidebar.right", labelKey: "uiLayoutSidebarRight", alignable: true, vertical: true },
];

/** 「待放回」托盘的落点标识 —— 不是真 slot，只是一个落区（拖进来 = 隐藏该条目）。 */
export const ICON_EDIT_TRAY = "__tray";

/** 三段（与渲染层同口径；脏值一律当 start）。 */
export const ICON_EDIT_ALIGNS: readonly UiAlign[] = ["start", "center", "end"];

/** 竖栏的 align 文案（靠上 / 居中 / 靠下）。**字面量 key 集中在这里**，
 *  免得对齐下拉、分段头、图标编辑器各写一份 switch（也便于死 key 守卫认出来）。 */
export function sideAlignLabel(
	t: (key: "uiLayoutAlignTop" | "uiLayoutAlignMiddle" | "uiLayoutAlignBottom") => string,
	align: UiAlign,
): string {
	return t(align === "start" ? "uiLayoutAlignTop" : align === "end" ? "uiLayoutAlignBottom" : "uiLayoutAlignMiddle");
}

/** 一个落点：被拖条目 + 目标栏 + 目标段 + 目标下标。 */
interface IconDrop {
	id: string;
	/** 目标栏（ICON_EDIT_ZONES 里的一员的 slot）。 */
	slot: UiSlotId;
	/** 目标段；`undefined` = 该栏不分段，保持条目原有 align。 */
	align?: UiAlign;
	/** 落点下标，相对**去掉被拖条目之后**的目标段序列。 */
	index: number;
}

/** 四个栏里全部可编辑条目（**含被隐藏的**，编辑模式要把它们画进托盘）。 */
interface IconEditBuckets {
	/** key = 栏 slot；值 = 该栏条目（含 hidden，顺序即当前渲染顺序）。 */
	zones: Record<string, UiSlotEntry[]>;
	/** 托盘：四个栏里被隐藏的条目 + 被放进 `topbar.overflow`（⋯ 常驻）的条目。 */
	tray: UiSlotEntry[];
}

/**
 * 收集编辑模式要画的东西。
 *
 * 托盘的口径：**「当前不在可见位置」的条目** —— 既包括用户/插件隐藏的（`hidden`），也包括
 * 被挪进 `topbar.overflow`（只出现在 ⋯ 菜单里）的。拖出托盘 = 恢复（清 hidden + 改 slot），
 * 于是编辑模式同时是「找得回来」的入口，不必再回设置页翻。
 *
 * @param exclude 不参与编辑的 id（宿主侧传 `HIDDEN_FROM_LAYOUT_ITEM_IDS`：手机端历史/文件
 *   抽屉开关有常驻语义，位置由宿主强制）。
 */
export function collectIconEditItems(
	slots: Record<string, UiSlotEntry[] | undefined>,
	exclude: ReadonlySet<string> = new Set(),
): IconEditBuckets {
	const zones: Record<string, UiSlotEntry[]> = {};
	const tray: UiSlotEntry[] = [];
	const inTray = new Set<string>();
	for (const zone of ICON_EDIT_ZONES) {
		const list = (slots[zone.slot] ?? []).filter((e) => !exclude.has(e.id));
		zones[zone.slot] = list;
		for (const entry of list) {
			if (entry.hidden) {
				tray.push(entry);
				inTray.add(entry.id);
			}
		}
	}
	for (const entry of slots["topbar.overflow"] ?? []) {
		if (exclude.has(entry.id) || inTray.has(entry.id)) continue;
		tray.push(entry);
		inTray.add(entry.id);
	}
	return { zones, tray };
}

/** 在全部栏 + 托盘里按 id 找条目（找不到返回 undefined —— 条目可能已被插件卸载）。 */
export function findIconEditEntry(buckets: IconEditBuckets, id: string): UiSlotEntry | undefined {
	for (const list of Object.values(buckets.zones)) {
		const hit = list.find((e) => e.id === id);
		if (hit) return hit;
	}
	return buckets.tray.find((e) => e.id === id);
}

/** 该栏里「界面上真看得见」的条目（托盘里的不算）。 */
export function visibleZoneEntries(entries: readonly UiSlotEntry[] | undefined): UiSlotEntry[] {
	return (entries ?? []).filter((e) => !e.hidden);
}

/** 该栏某个段落里看得见的条目；`align` 为 undefined = 不分段，整栏一串。 */
export function zoneEntriesForAlign(
	entries: readonly UiSlotEntry[] | undefined,
	align: UiAlign | undefined,
): UiSlotEntry[] {
	const visible = visibleZoneEntries(entries);
	if (align === undefined) return visible;
	return visible.filter((e) => (e.align ?? "start") === align);
}

/** 去掉重复项、保持首次出现顺序。 */
function uniq(list: readonly string[]): string[] {
	return [...new Set(list)];
}

/**
 * 一次拖放的**唯一**落盘口径：算出下一份 `UiLayoutPrefs`（不改传入对象）。
 *
 * 做四件事：
 *   1. 被拖条目原来是隐藏的 → 取消隐藏（`hidden` 去掉、`shown` 记上，与设置页同口径）；
 *   2. 目标栏与它的当前栏不同 → 写 `slots[id]`；
 *   3. `drop.align` 给了值且与当前段不同 → 写 `align[id]`；
 *   4. 重写 `order`：摘掉目标栏的全部旧痕迹，再把目标栏的完整顺序接在最后，
 *      其中目标段的序列按 `drop.index` 插入被拖条目。
 *
 * 第 4 步是唯一需要注意的：同槽位内「在 order 里」的条目一律排在「不在 order 里」的
 * 之前（见 ui-slots.ts 的 sortEntries），所以只把被拖条目塞进 order 会让它**跳到最前**，
 * 必须连带把目标栏的其它条目一起写清楚。
 */
export function applyIconDrop(
	layout: UiLayoutPrefs | undefined,
	buckets: IconEditBuckets,
	drop: IconDrop,
): UiLayoutPrefs {
	const src = layout ?? {};
	const dragged = findIconEditEntry(buckets, drop.id);
	if (!dragged) return src;

	const next: UiLayoutPrefs = { ...src };

	// 1) 恢复隐藏
	if (dragged.hidden) {
		next.hidden = (src.hidden ?? []).filter((x) => x !== drop.id);
		next.shown = uniq([...(src.shown ?? []), drop.id]);
	}

	// 2) 换栏
	if (dragged.slot !== drop.slot) {
		next.slots = { ...src.slots, [drop.id]: drop.slot };
	}

	// 3) 换段
	const align = drop.align;
	if (align !== undefined && (dragged.align ?? "start") !== align) {
		next.align = { ...src.align, [drop.id]: align };
	}

	// 4) 重写顺序
	const zone = buckets.zones[drop.slot] ?? [];
	const visible = visibleZoneEntries(zone);
	// 被拖条目可能来自别的栏（不在这串里）或本来被隐藏（也不在可见串里）：两种都不需要剔除。
	const inGroup = (e: UiSlotEntry): boolean => (align === undefined ? true : (e.align ?? "start") === align);
	const groupIds = visible.filter((e) => e.id !== drop.id && inGroup(e)).map((e) => e.id);
	const at = Math.max(0, Math.min(Math.trunc(drop.index) || 0, groupIds.length));
	groupIds.splice(at, 0, drop.id);
	// 其它段按当前渲染顺序整段跟在后面（跨段的前后关系不影响渲染，见 ui-slots.ts 的分段逻辑）。
	const otherIds = align === undefined ? [] : visible.filter((e) => e.id !== drop.id && !inGroup(e)).map((e) => e.id);
	const zoneIds = new Set(zone.map((e) => e.id));
	const others = (src.order ?? []).filter((x) => !zoneIds.has(x) && x !== drop.id);
	next.order = uniq([...others, ...groupIds, ...otherIds]);

	return next;
}

/** 拖进托盘 = 隐藏该条目（与设置页的勾选框同一口径：hidden 加上、shown 去掉）。 */
export function applyIconHide(layout: UiLayoutPrefs | undefined, id: string): UiLayoutPrefs {
	const src = layout ?? {};
	return {
		...src,
		hidden: uniq([...(src.hidden ?? []), id]),
		shown: (src.shown ?? []).filter((x) => x !== id),
	};
}
