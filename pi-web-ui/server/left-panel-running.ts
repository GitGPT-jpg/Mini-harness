/**
 * 左栏「运行的对话」里的**插件运行条目**（P3）的服务端存储与清洗。
 *
 * 插件经 `host.leftPanel.setRunning(items)` 整体替换自己的条目列表；每次调用同时是一次
 * **心跳**：超过 TTL 没有任何调用，该插件的条目整组过期清空（防止「幽灵运行中」——插件
 * 崩了、卡死、忘了收尾都不会让左栏永远挂着一条已经不存在的任务）。
 *
 * 为什么抽成独立模块：清洗（上限 / 去重 / 枚举夹取）、TTL 夹取、过期判定、「内容没变就不
 * 广播」都是纯逻辑，单独成类才能不起 PluginManager 就穷举单测。定时器与广播由调用方
 * （plugins.ts）负责，这里不碰 timer、不碰 WS。
 */
import type { PluginPanelGroup, PluginPanelItem } from "./protocol.js";

/** 单个插件同时可见的条目上限（超出的丢弃并给诊断）。 */
export const PANEL_ITEM_CAP = 50;
/** 心跳 TTL：缺省 60 秒（插件若不传 ttlMs）。 */
export const PANEL_TTL_DEFAULT_MS = 60_000;
/** TTL 夹取区间：过短会抖动，过长等于没有超时。 */
export const PANEL_TTL_MIN_MS = 5_000;
export const PANEL_TTL_MAX_MS = 3_600_000;

const ID_MAX = 96;
const TITLE_MAX = 200;
const HINT_MAX = 200;
const ICON_MAX = 8;
const ACTION_MAX = 96;
const STATUSES: ReadonlySet<string> = new Set(["running", "done", "error"]);

export interface PanelSanitizeResult {
	items: PluginPanelItem[];
	/** 清洗过程中的诊断（丢弃 / 截断 / 改写），调用方转成插件的运行时诊断。 */
	diags: string[];
}

/** 把插件传来的 `items` 清洗成可信的条目列表（纯函数）。不合法的条目丢弃，不抛错。 */
export function sanitizePanelItems(raw: unknown): PanelSanitizeResult {
	const diags: string[] = [];
	const items: PluginPanelItem[] = [];
	if (!Array.isArray(raw)) {
		diags.push("setRunning: items must be an array — ignored");
		return { items, diags };
	}
	const seen = new Set<string>();
	raw.forEach((rawItem, idx) => {
		if (!rawItem || typeof rawItem !== "object") {
			diags.push(`setRunning[#${idx}]: not an object — dropped`);
			return;
		}
		const o = rawItem as Record<string, unknown>;
		const id = typeof o.id === "string" ? o.id.trim().slice(0, ID_MAX) : "";
		if (!id) {
			diags.push(`setRunning[#${idx}]: missing id — dropped`);
			return;
		}
		if (seen.has(id)) {
			diags.push(`setRunning: duplicate id "${id}" — later one dropped`);
			return;
		}
		if (items.length >= PANEL_ITEM_CAP) {
			diags.push(`setRunning: capped at ${PANEL_ITEM_CAP} items — "${id}" and later dropped`);
			return;
		}
		seen.add(id);
		const title = typeof o.title === "string" && o.title.trim() ? o.title.trim().slice(0, TITLE_MAX) : id;
		let status: PluginPanelItem["status"] = "running";
		if (o.status !== undefined) {
			if (typeof o.status === "string" && STATUSES.has(o.status)) status = o.status as PluginPanelItem["status"];
			else diags.push(`setRunning["${id}"]: unknown status — treated as "running"`);
		}
		const item: PluginPanelItem = { id, title, status };
		if (typeof o.hint === "string" && o.hint.trim()) item.hint = o.hint.trim().slice(0, HINT_MAX);
		if (typeof o.icon === "string" && o.icon.trim()) item.icon = o.icon.trim().slice(0, ICON_MAX);
		if (typeof o.action === "string" && o.action.trim()) item.action = o.action.trim().slice(0, ACTION_MAX);
		items.push(item);
	});
	return { items, diags };
}

/** TTL 夹取：非数字 / 缺省 → 默认值；其余夹进 [MIN, MAX]。 */
export function clampPanelTtl(raw: unknown): number {
	const n = typeof raw === "number" && Number.isFinite(raw) ? raw : PANEL_TTL_DEFAULT_MS;
	return Math.min(PANEL_TTL_MAX_MS, Math.max(PANEL_TTL_MIN_MS, Math.round(n)));
}

interface PluginPanelSlot {
	pluginName: string;
	items: PluginPanelItem[];
	ttlMs: number;
	/** 最近一次 setRunning（心跳）的时刻。 */
	touchedAt: number;
}

export interface PanelSetOutcome {
	/** 清洗后的条目数（0 = 等同于 clear）。 */
	count: number;
	/** 对外可见的内容是否变了（只心跳不变内容 = false，调用方据此决定要不要广播）。 */
	changed: boolean;
	diags: string[];
}

export class LeftPanelRunningStore {
	private readonly slots = new Map<string, PluginPanelSlot>();

	constructor(private readonly now: () => number = Date.now) {}

	/** 整体替换某插件的运行条目（同时是心跳）。 */
	set(pluginId: string, pluginName: string, raw: unknown, opts?: { ttlMs?: unknown }): PanelSetOutcome {
		const { items, diags } = sanitizePanelItems(raw);
		if (items.length === 0) {
			const had = this.slots.delete(pluginId);
			return { count: 0, changed: had, diags };
		}
		const ttlMs = clampPanelTtl(opts?.ttlMs);
		const prev = this.slots.get(pluginId);
		const changed = !prev || prev.pluginName !== pluginName || JSON.stringify(prev.items) !== JSON.stringify(items);
		this.slots.set(pluginId, { pluginName, items, ttlMs, touchedAt: this.now() });
		return { count: items.length, changed, diags };
	}

	/** 清空某插件的条目。返回是否真的删了东西（没有则不需要广播）。 */
	clear(pluginId: string): boolean {
		return this.slots.delete(pluginId);
	}

	/** 清掉心跳过期的插件，返回被清掉的插件 id 列表（调用方据此广播）。 */
	sweep(): string[] {
		const t = this.now();
		const expired: string[] = [];
		for (const [pluginId, slot] of this.slots) {
			if (t - slot.touchedAt > slot.ttlMs) {
				this.slots.delete(pluginId);
				expired.push(pluginId);
			}
		}
		return expired;
	}

	/** 当前全部分组（按插件 id 排序，空组不出现）。返回副本，调用方随便改。 */
	groups(): PluginPanelGroup[] {
		return [...this.slots.entries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([pluginId, slot]) => ({
				pluginId,
				pluginName: slot.pluginName,
				items: slot.items.map((it) => ({ ...it })),
			}));
	}

	get size(): number {
		return this.slots.size;
	}
}
