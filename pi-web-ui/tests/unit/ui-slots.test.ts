/**
 * 宿主 UI 扩展点引擎（web/src/ui-slots.ts，issue #146）单测。
 *
 * 锁的是**合并优先级**这条契约（宿主默认 < 用户偏好），
 * 以及布局页要用的审计字段（userOverrides / movedFrom）。
 *
 * 另一个不变量：BUILTIN_UI_ITEMS 的 labelKey 必须真实存在于 zh 文案表里 ——
 * 内置条目表是「宿主入口的登记册」，key 打错 = 运行时显示成 key 本身，
 * 用一条断言把它挡在提交前（zh 表就是 i18n.tsx 里那份，见 locales.test.ts 同款导入）。
 */
import { describe, expect, it } from "vitest";
import {
	BUILTIN_UI_ITEMS,
	HIDDEN_FROM_LAYOUT_ITEM_IDS,
	UI_SLOT_SPECS,
	applyUiSlotCardinality,
	buildUiSlots,
	restoreAllUi,
	restoreUiItem,
	splitOverflow,
	type UiDiagnostic,
} from "../../web/src/ui-slots.js";
import type { UiSlotId } from "../../server/protocol.js";
import { zh } from "../../web/src/i18n.js";

const zhTable = zh as Record<string, string>;

/** 测试用的 t()：直接回显 key —— 断言里就能看出「文案来自哪个 key」。 */
const t = (key: string) => `#${key}`;

/** 默认调用：回显翻译。 */
function build(opts?: Omit<Parameters<typeof buildUiSlots>[0], "t">) {
	return buildUiSlots({ t, ...opts });
}

const ids = (entries: { id: string }[]) => entries.map((e) => e.id);

describe("UI slot cardinality（P1-4）", () => {
	it("所有现有挂载点都有显式 list 规格，新增 single 不会改变现有入口语义", () => {
		expect(UI_SLOT_SPECS).toHaveLength(32);
		expect(UI_SLOT_SPECS.every((spec) => spec.cardinality === "list")).toBe(true);
		expect(new Set(UI_SLOT_SPECS.map((spec) => spec.slot)).size).toBe(UI_SLOT_SPECS.length);
	});

	it("list 保留条目，返回新数组且不修改输入", () => {
		const input = [
			{ id: "a", hidden: false },
			{ id: "b", hidden: true },
		];
		const result = applyUiSlotCardinality(input, "list");
		expect(result.entries).toEqual(input);
		expect(result.entries).not.toBe(input);
		expect(result.conflicts).toEqual([]);
	});

	it("single 选择排序后的第一个可见条目，保留隐藏候选并置隐藏其它可见条目", () => {
		const input = [
			{ id: "winner", hidden: false },
			{ id: "hidden", hidden: true },
			{ id: "loser", hidden: false },
		];
		const result = applyUiSlotCardinality(input, "single");
		expect(result.winner?.id).toBe("winner");
		expect(result.conflicts.map((entry) => entry.id)).toEqual(["loser"]);
		expect(result.entries).toEqual([
			{ id: "winner", hidden: false },
			{ id: "hidden", hidden: true },
			{ id: "loser", hidden: true },
		]);
		expect(input[2]?.hidden).toBe(false);
	});

	it("single 没有可见候选时不选举、不产生冲突", () => {
		const input = [
			{ id: "a", hidden: true },
			{ id: "b", hidden: true },
		];
		expect(applyUiSlotCardinality(input, "single")).toEqual({ entries: input, conflicts: [] });
	});
});

describe("BUILTIN_UI_ITEMS（宿主默认）", () => {
	it("id 全局唯一、都以 host: 开头", () => {
		const all = BUILTIN_UI_ITEMS.map((i) => i.id);
		expect(new Set(all).size).toBe(all.length);
		for (const id of all) expect(id.startsWith("host:")).toBe(true);
	});

	it("每个内置条目的 labelKey 都在 zh 文案表里（写错 key 立刻失败）", () => {
		for (const item of BUILTIN_UI_ITEMS) {
			expect(zhTable[item.labelKey], `${item.id} → ${item.labelKey}`).toBeTypeOf("string");
			expect(zhTable[item.labelKey]?.trim().length, item.labelKey).toBeGreaterThan(0);
		}
	});

	it("覆盖宿主既有入口（顶栏/底栏/右键菜单），且没有把 settings.pages 列成内置", () => {
		const bySlot = (slot: UiSlotId) => BUILTIN_UI_ITEMS.filter((i) => i.slot === slot).map((i) => i.id);
		// 顶栏：视图开关 + 搜索/后台任务/设置/语言/主题/更新
		expect(bySlot("topbar.primary")).toEqual(
			expect.arrayContaining([
				"host:chat",
				"host:terminal",
				"host:search",
				"host:tasks",
				"host:settings",
				"host:language",
				"host:update",
			]),
		);
		// 底栏：上下文/成本/缓存/消息数/主机指标/工作目录
		expect(bySlot("bottombar")).toEqual(
			expect.arrayContaining([
				"host:ctx",
				"host:cost",
				"host:cache",
				"host:msg-count",
				"host:host-metrics",
				"host:cwd",
			]),
		);
		expect(bySlot("contextmenu.session").length).toBeGreaterThan(0);
		expect(bySlot("contextmenu.file").length).toBeGreaterThan(0);
		// 消息区右键菜单登记宿主操作项（复制/编辑/分支/回滚/朗读）
		expect(bySlot("contextmenu.message").length).toBeGreaterThan(0);
		expect(bySlot("settings.pages")).toEqual([]);
	});
});

describe("buildUiSlots / 第 1 层：宿主默认", () => {
	it("无偏好时：返回全部槽位，按 order 排序，文案走 t(labelKey)", () => {
		const slots = build();
		expect(ids(slots["topbar.primary"])).toEqual([
			"host:history",
			"host:brand",
			"host:open-project",
			"host:chat",
			"host:terminal",
			"host:search",
			"host:task-desk",
			"host:tasks",
			"host:settings",
			"host:language",
			"host:theme",
			"host:update",
			"host:new-chat",
			"host:new-ephemeral-chat",
			"host:new-sandbox",
			// order 200：尾部条目 = 实测溢出的第一顺位被收起者（见 BUILTIN_UI_ITEMS 注释）
		]);
		expect(ids(slots.bottombar)).toEqual([
			"host:conn",
			"host:cluster",
			"host:ctx",
			"host:cost",
			"host:cache",
			"host:msg-count",
			"host:plugin-status",
			"host:working",
			"host:loop",
			"host:host-metrics",
			"host:cwd",
		]);
		const settings = slots["topbar.primary"].find((e) => e.id === "host:settings");
		expect(settings?.label).toBe("#settingsTitle");
		expect(settings?.labelKey).toBe("settingsTitle");
		expect(settings?.source).toBe("host");
		expect(settings?.kind).toBe("action");
		expect(settings?.hidden).toBe(false);
		expect(settings?.order).toBe(60);
		// 没用到的槽位是空数组（渲染层不必判空），且全部槽位都在
		expect(Object.keys(slots)).toHaveLength(32);
		expect(slots["composer.leading"]).toEqual([]);
		// 输入框动作区有 7 个宿主内置（上传/模板/模型/思考/DSH×2/发送），发送簇 align=end
		// （计划模式已搬到目标条 host:goal-plan）
		expect(ids(slots["composer.actions"])).toEqual([
			"host:composer-upload",
			"host:composer-templates",
			"host:composer-model",
			"host:composer-thinking",
			"host:composer-dsh-perm",
			"host:composer-dsh-preset",
			"host:composer-send",
		]);
		expect(slots["composer.actions"].find((e) => e.id === "host:composer-send")?.align).toBe("end");
		expect(slots["modal.dialog"]).toEqual([]);
	});

	/** 缺省收起 = 低频 / 有替代入口的条目落进顶栏「⋯」（App.tsx 把 hidden 的 primary 条目
	 *  塞进 uiOverflow → 菜单里能点，菜单型条目在菜单里是整块组件，功能不少）。
	 *  这条断言是「顶栏默认长什么样」的唯一入口 —— 想改默认口径就改这里与 BUILTIN_UI_ITEMS。 */
	it("缺省收进「⋯」的 3 条 + 常驻的 12 条", () => {
		const slots = build();
		const top = slots["topbar.primary"];
		expect(top.filter((e) => e.hidden).map((e) => e.id)).toEqual(["host:language", "host:theme", "host:update"]);
		// 常驻 = 「切视图（chat/terminal/git） / 起新活（new-chat/new-ephemeral-chat/new-sandbox） /
		// 看运行态（tasks） / 进设置（settings）」四类，加品牌、项目、搜索、面板开关
		expect(top.filter((e) => !e.hidden).map((e) => e.id)).toEqual([
			"host:history",
			"host:brand",
			"host:open-project",
			"host:chat",
			"host:terminal",
			"host:search",
			"host:task-desk",
			"host:tasks",
			"host:settings",
			"host:new-chat",
			"host:new-ephemeral-chat",
			"host:new-sandbox",
		]);
		// 缺省收起是「内置默认」，不写成用户覆盖 —— 否则布局页会把它们标成「已自定义」，
		// 「恢复」按钮还会把它们恢复成同一个值
		for (const e of top) expect(e.userOverrides).toEqual([]);
	});

	it("槽位 key 顺序 = 实际界面的 DOM/视觉顺序（布局页分区同表）", () => {
		const slots = build();
		expect(Object.keys(slots)).toEqual([
			"topbar.primary",
			"topbar.overflow",
			"notice.actions",
			"leftpanel.sections",
			"leftpanel.projects.actions",
			"leftpanel.project",
			"leftpanel.running.actions",
			"leftpanel.running",
			"leftpanel.history.actions",
			"leftpanel.history",
			"leftpanel.sessions",
			"chat.header",
			"chat.empty",
			"message.actions",
			"goalbar.actions",
			"composer.leading",
			"composer.actions",
			"rightpanel.tabs",
			"terminal.toolbar",
			"bottombar",
			"file.preview.toolbar",
			"contextmenu.topbar",
			"contextmenu.message",
			"contextmenu.session",
			"contextmenu.project",
			"contextmenu.file",
			"contextmenu.toolcall",
			"settings.pages",
			"tasks.panel",
			"modal.dialog",
			"sidebar.left",
			"sidebar.right",
		]);
	});

	it("kind=view 的条目带 view 目标（宿主据此切视图）", () => {
		const slots = build();
	});

	it("同 order 时保持声明顺序（稳定排序）", () => {
		const seq = new Map(BUILTIN_UI_ITEMS.map((item, i) => [item.id, i]));
		let ties = 0;
		for (const entries of Object.values(build())) {
			for (let i = 1; i < entries.length; i++) {
				const a = entries[i - 1]!;
				const b = entries[i]!;
				if (a.order !== b.order) continue;
				ties++;
				expect(seq.get(a.id)!, `${a.id} / ${b.id}`).toBeLessThan(seq.get(b.id)!);
			}
		}
		// 宿主表里确有同权重条目（如 contextmenu.file 的 16 / 17），否则上面的断言是空转
		expect(ties).toBeGreaterThan(0);
	});
});

describe("常驻入口（REQUIRED_TOPBAR_ITEM_IDS / HIDDEN_FROM_LAYOUT_ITEM_IDS）", () => {
	it("设置入口不能被偏好隐藏", () => {
		const settings = build({ layout: { hidden: ["host:settings"] } })["topbar.primary"].find(
			(e) => e.id === "host:settings",
		);
		expect(settings?.hidden).toBe(false);
		expect(settings?.slot).toBe("topbar.primary");
	});

	it("手机端抽屉入口（host:history）不能被偏好隐藏", () => {
		const slots = build({ layout: { hidden: ["host:history"] } });
		const entry = slots["topbar.primary"].find((e) => e.id === "host:history");
		expect(entry?.hidden).toBe(false);
		expect(entry?.slot).toBe("topbar.primary");
	});

	it("HIDDEN_FROM_LAYOUT_ITEM_IDS 锁定手机端抽屉按钮不进入布局设置", () => {
		expect([...HIDDEN_FROM_LAYOUT_ITEM_IDS].sort()).toEqual(["host:history"]);
	});
});

describe("buildUiSlots / 第 2 层：用户偏好（最高）", () => {
	it("hidden/shown 互相覆盖：shown 后应用 → 显示赢（撤销必须生效）", () => {
		const hiddenOnly = build({ layout: { hidden: ["host:chat"] } });
		expect(hiddenOnly["topbar.primary"].find((e) => e.id === "host:chat")?.hidden).toBe(true);
		// shown 覆盖宿主缺省的 hidden（host:language 缺省收进「⋯」）
		const shown = build({ layout: { shown: ["host:language"] } });
		expect(shown["topbar.primary"].find((e) => e.id === "host:language")?.hidden).toBe(false);
		// 同时写了 hidden 与 shown → shown 赢
		const both = build({ layout: { hidden: ["host:chat"], shown: ["host:chat"] } });
		const entry = both["topbar.primary"].find((e) => e.id === "host:chat");
		expect(entry?.hidden).toBe(false);
		expect(entry?.userOverrides).toEqual(["hidden"]);
	});

	it("order 列表：列出的按列表顺序排在最前，未列出的保持原顺序", () => {
		const slots = build({ layout: { order: ["host:chat"] } });
		expect(ids(slots["topbar.primary"])[0]).toBe("host:chat");
		// 其余仍按权重排：chat 置顶之后是 history(0) → brand(1) → open-project(3) …
		expect(ids(slots["topbar.primary"]).slice(1, 4)).toEqual(["host:history", "host:brand", "host:open-project"]);
		expect(slots["topbar.primary"].find((e) => e.id === "host:chat")?.userOverrides).toEqual(["order"]);
	});

	it("order 列表里的历史 id（条目已不存在）被忽略", () => {
		const slots = build({ layout: { order: ["ghost:gone", "host:chat"] } });
		expect(ids(slots["topbar.primary"])[0]).toBe("host:chat");
		expect(slots["topbar.primary"]).toHaveLength(BUILTIN_UI_ITEMS.filter((i) => i.slot === "topbar.primary").length);
	});

	it("groups/labels 覆盖，并记进 userOverrides", () => {
		const slots = build({
			layout: { groups: { "host:chat": "我的组" }, labels: { "host:chat": "聊天", "host:settings": "设置面板" } },
		});
		const chat = slots["topbar.primary"].find((e) => e.id === "host:chat");
		expect(chat?.group).toBe("我的组");
		expect(chat?.label).toBe("聊天");
		expect(chat?.labelKey).toBe("chat"); // host 条目保留 key，便于渲染层自行翻译/恢复
		expect(chat?.userOverrides).toEqual(["group", "label"]);
		expect(slots["topbar.primary"].find((e) => e.id === "host:settings")?.userOverrides).toEqual(["label"]);
	});

	it("slots 覆盖条目槽位（可在顶部/底部/左侧/右侧自由移动）", () => {
		const slots = build({
			layout: {
				slots: {
					"host:settings": "sidebar.left",
					"host:search": "bottombar",
					"host:ctx": "topbar.primary",
				},
			},
		});
		expect(ids(slots["sidebar.left"])).toContain("host:settings");
		expect(ids(slots["topbar.primary"])).not.toContain("host:settings");
		expect(slots["sidebar.left"].find((e) => e.id === "host:settings")?.userOverrides).toContain("slot");
		expect(slots["sidebar.left"].find((e) => e.id === "host:settings")?.movedFrom).toBe("topbar.primary");

		expect(ids(slots["bottombar"])).toContain("host:search");
		expect(ids(slots["topbar.primary"])).not.toContain("host:search");

		expect(ids(slots["topbar.primary"])).toContain("host:ctx");
		expect(ids(slots["bottombar"])).not.toContain("host:ctx");
	});

	it("偏好指向不存在的 id 时不报错、不新增条目", () => {
		const slots = build({
			layout: { hidden: ["ghost:1"], groups: { "ghost:1": "g" }, labels: { "ghost:1": "l" } },
		});
		expect(slots["topbar.primary"]).toHaveLength(BUILTIN_UI_ITEMS.filter((i) => i.slot === "topbar.primary").length);
	});

	it("不改动传入的 layout（纯函数）", () => {
		const layout = { hidden: ["host:chat"], order: ["host:search"] };
		const snapshot = JSON.stringify(layout);
		build({ layout });
		expect(JSON.stringify(layout)).toBe(snapshot);
	});
});

describe("splitOverflow", () => {
	const entries = build().bottombar;

	it("主栏最多 max 个，其余进溢出且保持相对顺序、不重复", () => {
		const { inline, overflow } = splitOverflow(entries, 3);
		expect(ids(inline)).toEqual(ids(entries).slice(0, 3));
		expect(ids(overflow)).toEqual(ids(entries).slice(3));
		expect(ids([...inline, ...overflow])).toEqual(ids(entries));
	});

	it("max >= 长度 → 全在主栏；max<=0 → 全在溢出", () => {
		expect(splitOverflow(entries, entries.length).overflow).toEqual([]);
		expect(splitOverflow(entries, 99).inline).toHaveLength(entries.length);
		const zero = splitOverflow(entries, 0);
		expect(zero.inline).toEqual([]);
		expect(ids(zero.overflow)).toEqual(ids(entries));
	});

	it("不修改入参数组（返回新数组）", () => {
		const copy = [...entries];
		const { inline, overflow } = splitOverflow(entries, 2);
		expect(entries).toEqual(copy);
		inline.pop();
		expect(overflow).toHaveLength(entries.length - 2);
	});
});

describe("restoreUiItem / restoreAllUi", () => {
	it("清掉该 id 在各偏好字段里的所有痕迹（顶栏文字开关原样保留）", () => {
		const layout = {
			hidden: ["host:chat", "host:sound"],
			shown: ["host:chat"],
			order: ["host:chat", "host:search"],
			groups: { "host:chat": "g", "host:sound": "s" },
			labels: { "host:chat": "聊天", "host:sound": "声音" },
		};
		expect(restoreUiItem(layout, "host:chat")).toEqual({
			hidden: ["host:sound"],
			order: ["host:search"],
			groups: { "host:sound": "s" },
			labels: { "host:sound": "声音" },
		});
	});

	it("清空后不留空数组/空对象；全清光返回 {}", () => {
		expect(restoreUiItem({ hidden: ["host:chat"], groups: { "host:chat": "g" } }, "host:chat")).toEqual({});
		expect(restoreUiItem(undefined, "host:chat")).toEqual({});
		expect(restoreUiItem({}, "host:chat")).toEqual({});
	});

	it("不修改入参（纯函数），恢复后 buildUiSlots 回到宿主默认", () => {
		const layout = { hidden: ["host:chat"], labels: { "host:chat": "聊天" } };
		const restored = restoreUiItem(layout, "host:chat");
		expect(layout).toEqual({ hidden: ["host:chat"], labels: { "host:chat": "聊天" } });
		const slots = build({ layout: restored });
		const chat = slots["topbar.primary"].find((e) => e.id === "host:chat");
		expect(chat?.label).toBe("#chat"); // 用户文案已撤回
		expect(chat?.hidden).toBe(false); // 宿主默认可见
		expect(chat?.userOverrides).toEqual([]);
	});

	it("restoreAllUi 返回空偏好", () => {
		expect(restoreAllUi()).toEqual({});
		expect(build({ layout: restoreAllUi() })).toEqual(build());
	});
});

describe("品牌二合一（host:brand-logo/host:brand-name → host:brand）", () => {
	it("buildUiSlots：旧偏好直接对新品牌生效", () => {
		const slots = build({
			layout: {
				hidden: ["host:brand-logo"],
				order: ["host:brand-name", "host:chat"],
				labels: { "host:brand-name": "我的站" },
			},
		});
		const brand = slots["topbar.primary"].find((e) => e.id === "host:brand");
		expect(brand?.hidden).toBe(true);
		expect(brand?.label).toBe("我的站");
		expect(brand?.userOverrides).toEqual(expect.arrayContaining(["hidden", "order", "label"]));
		expect(ids(slots["topbar.primary"]).slice(0, 2)).toEqual(["host:brand", "host:chat"]);
		// 旧 id 不再登记为条目。
		expect(slots["topbar.primary"].some((e) => e.id === "host:brand-logo" || e.id === "host:brand-name")).toBe(false);
	});

	it("restoreUiItem(host:brand) 连带清掉旧双 id 残留", () => {
		expect(
			restoreUiItem({ hidden: ["host:brand", "host:brand-logo"], labels: { "host:brand-name": "旧" } }, "host:brand"),
		).toEqual({});
	});
});

describe("bottombar align 分区（P1-2 收尾：路由走数据不走 id）", () => {
	it("host:host-metrics 与 host:cwd 缺省 end，其余宿主条目缺省 start", () => {
		const slots = build();
		const end = slots["bottombar"].filter((e) => e.align === "end").map((e) => e.id);
		expect(end).toEqual(["host:host-metrics", "host:cwd"]);
	});
	it("用户偏好能翻转分区（把条目挪到右区 / 挪回左区）", () => {
		const slots = build({ layout: { align: { "host:cost": "end", "host:cwd": "start" } } });
		expect(slots["bottombar"].filter((e) => e.align === "end").map((e) => e.id)).toEqual([
			"host:cost",
			"host:host-metrics",
		]);
		expect(slots["bottombar"].find((e) => e.id === "host:cwd")!.align).toBe("start");
	});
});

describe("buildUiSlots —— diagnostics（P0-1）", () => {
	it("不传 diagnostics 时行为与原来完全一致（纯函数，零副作用）", () => {
		const before = build();
		const diagnostics: UiDiagnostic[] = [];
		const after = build({ diagnostics });
		expect(after).toEqual(before);
		expect(diagnostics).toEqual([]);
	});
});

describe("左栏分区（P2 · leftpanel.sections）", () => {
	const sectionIds = (slots: ReturnType<typeof build>) => ids(slots["leftpanel.sections"]);

	it("三条宿主分区默认登记在 leftpanel.sections，顺序：项目 / 运行 / 历史", () => {
		const slots = build();
		expect(sectionIds(slots)).toEqual(["host:lp-projects", "host:lp-running", "host:lp-history"]);
		expect(slots["leftpanel.sections"].every((e) => e.source === "host" && !e.hidden)).toBe(true);
	});

	it("布局页隐藏某分区 → hidden=true，条目本身仍在（布局页才找得回来）", () => {
		const slots = build({ layout: { hidden: ["host:lp-running"] } });
		expect(slots["leftpanel.sections"].find((e) => e.id === "host:lp-running")?.hidden).toBe(true);
		expect(sectionIds(slots)).toHaveLength(3);
	});

	it("用户调序（layout.order）改变分区先后", () => {
		const slots = build({ layout: { order: ["host:lp-history", "host:lp-projects"] } });
		const order = sectionIds(slots);
		expect(order.indexOf("host:lp-history")).toBeLessThan(order.indexOf("host:lp-projects"));
	});

	it("用户偏好把宿主分区挪到别的槽位 → 复位回 leftpanel.sections 并诊断", () => {
		const diagnostics: UiDiagnostic[] = [];
		const slots = build({ layout: { slots: { "host:lp-history": "bottombar" } }, diagnostics });
		expect(sectionIds(slots)).toContain("host:lp-history");
		expect(slots.bottombar.some((e) => e.id === "host:lp-history")).toBe(false);
		expect(
			diagnostics.some((d) => d.entryId === "host:lp-history" && /must stay in leftpanel\.sections/.test(d.message)),
		).toBe(true);
	});
});
