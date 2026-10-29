/// <reference lib="dom" />
import { getMessage } from "./i18n.js";
/**
 * 「页面桥」的纯逻辑：配对表 + 路由决策 + 消息形状/体积校验。
 *
 * 这个文件描述的是一件**扩展才能做到**的事：让两个互相看不见的页面（跨源、跨标签页、
 * 跨窗口）通过扩展互相读写。网页自己做不到 —— 跨源 `postMessage` 需要 `window.open`
 * 的返回句柄且对方配合，`BroadcastChannel` / `localStorage` 只限同源。
 *
 * 通路（三层，缺一层都不行）：
 *
 *   A 页面 MAIN world ──postMessage──▶ A 的 content script（ISOLATED）
 *        ▲                                      │ chrome.runtime.sendMessage
 *        └──postMessage（结果）                  ▼
 *                                          background service worker
 *                                               │ ① 用 sender.tab.url 判定「你是谁」
 *                                               │ ② 查配对表决定「你能跟谁说话」
 *                                               ▼
 *                        chrome.scripting.executeScript({tabId: B, world: "MAIN"})
 *                                               │ ③ 在 B 里直接调它的 handler
 *                                               ▼
 *                                          B 页面 MAIN world
 *
 * 安全模型（**这里是本文件存在的主要理由**）：
 * - 「谁在调用」只能由 worker 从 `sender.tab.url` 推出，**绝不读消息体里的字段** —— 否则
 *   A 页面可以自称是 B，拿到 B 的全部数据；
 * - 默认拒绝：不在配对表里的 origin 一律拒绝，把「任意页面读任意页面」这个后门关成
 *   「用户显式配对的几对」；
 * - 配对必须在扩展自己的页面里点（`chrome.permissions.request` 要求用户手势，网页面上的
 *   按钮给不了手势）—— 所以「加一对」这个动作天然带一次人工确认。
 *
 * 注意这里**没有**试图防住「被配对页面自己的第三方脚本」：桥装在页面的 MAIN world 里，
 * 同文档的任何脚本都能摸到 `window.__piBridge`。这是 MAIN world 的物理边界，不是实现缺陷；
 * 所以选项页要明说「只对你信任的页面开桥」。token（见 content/bridge.ts）只用来挡
 * 「偶发/无意伪造」，不当作安全边界。
 */

/** 页面侧 API 与扩展之间的协议版本；`bridge-page.ts` 里的字面量必须与它一致（有单测钉住）。 */
export const BRIDGE_VERSION = 1;

/** token 借 DOM 属性传递（content script 写、MAIN 桥读，同一个 document）。 */
export const BRIDGE_ATTR = "data-pi-bridge";

/** 一次跨页调用的默认超时与上限（对端可能永远不回 —— 不能让页面的 Promise 悬着）。 */
export const DEFAULT_TIMEOUT_MS = 5000;
export const MAX_TIMEOUT_MS = 30000;

/** 操作名长度上限（它只是标签，不该塞数据）。 */
export const MAX_OP_CHARS = 64;

/**
 * 参数 / 结果的体积上限（JSON 文本长度，UTF-16 码元数，够用作近似）。
 *
 * 为什么要限：数据要过三趟（页面 → content script → worker → 对端），一趟超大就能让
 * service worker 卡住甚至被浏览器回收。宁可报一个清楚的错，也不要「发出去没反应」。
 */
export const MAX_ARGS_CHARS = 256 * 1024;
export const MAX_RESULT_CHARS = 512 * 1024;

/**
 * 一对配对（两个 origin 互通，**对称**）。
 *
 * 存储用 `chrome.storage.local` 而不是 sync：host 权限是本机授予的，配对跟着权限走；
 * 同步到别的设备只会得到一份「那边没授权、用不了」的配对。
 */
export interface BridgePair {
	/** 稳定 id（`pairId`），同一对换个顺序也是同一个 id。 */
	id: string;
	/** origin（`https://a.example`，无路径）。字典序小的那个。 */
	a: string;
	b: string;
	enabled: boolean;
	/** ISO 时间字符串（纯记录，界面显示用）。 */
	createdAt: string;
	/** 用户自己看的备注（「订单页 ↔ 本地工具页」这种）。 */
	note?: string;
}

/**
 * 地址 → origin。
 *
 * 配对与路由一律按 origin 判定（`https://a.example/x` 与 `/y` 是同一个页面的两个路径，
 * 不该出现两套配对）。只认 http/https：`file://`、`chrome://`、扩展页注入不了，认了也是白认。
 * 解析失败返回 undefined（调用方必须当成「不合法」处理，不要回落默认值 —— 那样会
 * 悄悄把请求路由到别的 origin 去）。
 */
export function normalizeOrigin(raw: unknown): string | undefined {
	const text = typeof raw === "string" ? raw.trim() : "";
	if (!text) return undefined;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
	try {
		const url = new URL(withScheme);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		if (!url.hostname) return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

/** 一对配对的 id（排序后拼接，保证 `(a,b)` 与 `(b,a)` 得到同一个 id）。 */
export function pairId(x: string, y: string): string {
	return [x, y].sort().join(" | ");
}

/** 这对配对里「另一个」是谁（不是 `origin` 的那端）；`origin` 不在其中时返回 undefined。 */
export function peerOf(pair: BridgePair, origin: string): string | undefined {
	if (pair.a === origin) return pair.b;
	if (pair.b === origin) return pair.a;
	return undefined;
}

/**
 * 任意来源的对象 → 干净的配对表。
 *
 * 脏数据（手改存储、旧版本、导出的 JSON）不能让整条链挂掉：坏条目丢弃，
 * 字段类型错回落，重复对（同一对存了两遍）合并成一条。
 */
export function normalizePairs(raw: unknown): BridgePair[] {
	const list = Array.isArray(raw) ? raw : [];
	const out: BridgePair[] = [];
	const seen = new Set<string>();
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const src = item as Record<string, unknown>;
		const x = normalizeOrigin(src.a);
		const y = normalizeOrigin(src.b);
		if (!x || !y || x === y) continue;
		const [a, b] = x < y ? [x, y] : [y, x];
		const id = pairId(a, b);
		if (seen.has(id)) continue;
		seen.add(id);
		const note = typeof src.note === "string" ? src.note.trim() : "";
		out.push({
			id,
			a,
			b,
			// 只有显式 `false` 算停用：旧版本没有这个字段，缺省必须是「启用」（否则升级后桥全哑了）
			enabled: src.enabled !== false,
			createdAt: typeof src.createdAt === "string" ? src.createdAt : "",
			...(note ? { note: note.slice(0, 120) } : {}),
		});
	}
	return out.sort((x, y) => x.id.localeCompare(y.id));
}

/** 与 `origin` 有关的配对（默认只算启用的）。 */
export function pairsFor(pairs: BridgePair[], origin: unknown, enabledOnly = true): BridgePair[] {
	const self = normalizeOrigin(origin);
	if (!self) return [];
	return pairs.filter((p) => pairOfOrigin(p, self) && (!enabledOnly || p.enabled));
}

function pairOfOrigin(pair: BridgePair, origin: string): boolean {
	return pair.a === origin || pair.b === origin;
}

/** `origin` 能跟哪些页面说话（启用的配对的对端，去重）。 */
export function peersOf(pairs: BridgePair[], origin: unknown): string[] {
	const peers = pairsFor(pairs, origin).map((p) => peerOf(p, normalizeOrigin(origin) ?? "") ?? "");
	return [...new Set(peers.filter(Boolean))];
}

/** 路由结论：放行（给出配对与对端）或拒绝（给出可读原因）。 */
export type RouteDecision =
	| { ok: true; pair: BridgePair; peer: string }
	| { ok: false; code: "bad-origin" | "no-pair" | "ambiguous" | "disabled"; message: string };

/**
 * 「from 想调 to」能不能放行。
 *
 * `to` 省略时走「唯一对端」规则：只有一个对端就放行，多个则要求显式指定 ——
 * 猜一个然后调错页面，比报错难查得多（尤其两个对端都是 http://localhost 上的不同端口）。
 */
export function decideRoute(pairs: BridgePair[], fromOrigin: unknown, toOrigin?: unknown): RouteDecision {
	const from = normalizeOrigin(fromOrigin);
	if (!from) {
		return {
			ok: false,
			code: "bad-origin",
			message: `调用方地址不合法（${String(fromOrigin)}）—— 只支持 http/https 页面`,
		};
	}
	const rawTo = typeof toOrigin === "string" ? toOrigin.trim() : "";
	const want = rawTo ? normalizeOrigin(rawTo) : undefined;
	if (rawTo && !want) {
		return { ok: false, code: "bad-origin", message: `对端地址不合法（${rawTo}）—— 只支持 http/https 页面` };
	}
	if (want === from) {
		return { ok: false, code: "bad-origin", message: getMessage("bridge_selfPeer", undefined, "对端就是自己 —— 桥是用来跨页面的") };
	}

	const touching = pairs.filter((p) => pairOfOrigin(p, from));
	const enabled = touching.filter((p) => p.enabled);
	if (enabled.length === 0) {
		if (touching.length > 0) {
			return { ok: false, code: "disabled", message: `${from} 的配对已被停用 —— 到扩展选项页「页面桥」里重新启用` };
		}
		return { ok: false, code: "no-pair", message: `${from} 还没配对任何页面 —— 到扩展选项页「页面桥」里加一对` };
	}

	const peerList = [...new Set(enabled.map((p) => peerOf(p, from)).filter((v): v is string => Boolean(v)))];
	if (want) {
		const pair = enabled.find((p) => peerOf(p, from) === want);
		if (!pair) {
			return {
				ok: false,
				code: "no-pair",
				message: getMessage(
					"bridge_noPair",
					[from, want, peerList.join(getMessage("ai_opSeparator", undefined, "、")) || "无"],
					`${from} 与 ${want} 之间没有配对（当前配对的是：${peerList.join("、") || "无"}）`,
				),
			};
		}
		return { ok: true, pair, peer: want };
	}
	if (peerList.length > 1) {
		return {
			ok: false,
			code: "ambiguous",
			message: `${from} 配对了多个页面（${peerList.join("、")}）—— 调用时用 to 指定对端`,
		};
	}
	return { ok: true, pair: enabled[0], peer: peerList[0] };
}

/** 体积校验结果（`message` 是给用户/页面开发者看的原话）。 */
export interface SizeCheck {
	ok: boolean;
	message?: string;
	chars?: number;
}

/**
 * 能不能安全地过这条通路。
 *
 * 用 `JSON.stringify` 当探针：它同时测了「多大」和「能不能序列化」——循环引用、BigInt、
 * 函数都会在这里就被拦下，而不是在 postMessage / executeScript 里抛一个
 * `DataCloneError` 让页面开发者一头雾水。
 */
export function measureForTransport(value: unknown, what: string, limit: number): SizeCheck {
	if (value === undefined) return { ok: true, chars: 0 };
	if (typeof value === "function" || typeof value === "symbol") {
		return { ok: false, message: `${what}不能跨页面传输（函数 / Symbol 过不去）` };
	}
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch (err) {
		return {
			ok: false,
			message: `${what}不能跨页面传输：${err instanceof Error ? err.message : String(err)}（循环引用 / BigInt 过不去）`,
		};
	}
	if (text === undefined) return { ok: false, message: `${what}不能跨页面传输` };
	const chars = text.length;
	if (chars > limit) {
		return {
			ok: false,
			message: `${what}太大（${Math.round(chars / 1024)}KB > 上限 ${Math.round(limit / 1024)}KB）—— 只传必要字段`,
		};
	}
	return { ok: true, chars };
}

/** 超时归一（拿不到/离谱的值一律夹进 [1, MAX_TIMEOUT_MS]）。 */
export function clampTimeout(raw: unknown): number {
	const n = typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_TIMEOUT_MS;
	return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.round(n)));
}

/** content script 转发上来的调用请求（形状已校验）。 */
export interface BridgeCall {
	to?: string;
	op: string;
	args?: unknown;
	timeoutMs: number;
}

/**
 * 校验 content script 转上来的调用。
 *
 * 页面侧已经查过一次，这里必须再查一遍：**content script 的转发是不可信的输入**
 * （页面上的任何脚本都能往 window 里 postMessage）。规则宽松但明确：op 是个短字符串，
 * args 能过体积/序列化检查，其余一律拒绝并说明原因。
 */
export function parseBridgeCall(raw: unknown): { ok: true; call: BridgeCall } | { ok: false; message: string } {
	const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const op = typeof src.op === "string" ? src.op.trim() : "";
	if (!op) return { ok: false, message: getMessage("bridge_missingOp", undefined, "调用缺少操作名（op）") };
	if (op.length > MAX_OP_CHARS) return { ok: false, message: `操作名过长（${op.length} > ${MAX_OP_CHARS}）` };
	// eslint 风格的控制字符检查：op 是标签，混进换行/不可见字符只会让日志和报错变得难读
	if (/[\u0000-\u001f\u007f]/.test(op)) return { ok: false, message: getMessage("bridge_controlCharInOp", undefined, "操作名里有控制字符") };
	const size = measureForTransport(src.args, getMessage("bridge_argsLabel", undefined, "参数"), MAX_ARGS_CHARS);
	if (!size.ok) return { ok: false, message: size.message ?? getMessage("bridge_argsInvalid", undefined, "参数不合法") };
	const to = typeof src.to === "string" && src.to.trim() ? src.to.trim() : undefined;
	return {
		ok: true,
		call: {
			...(to ? { to } : {}),
			op,
			...(src.args === undefined ? {} : { args: src.args }),
			timeoutMs: clampTimeout(src.timeoutMs),
		},
	};
}

/** 一对配对的一句话描述（选项页与日志共用，免得两处漂移）。 */
export function describePair(pair: BridgePair): string {
	const note = pair.note ? `（${pair.note}）` : "";
	return `${pair.a} ↔ ${pair.b}${note}`;
}

/** 新增/覆盖一对配对（已存在就更新备注与启用状态，不产生重复项）。 */
export function upsertPair(
	pairs: BridgePair[],
	x: unknown,
	y: unknown,
	opts: { note?: string; now?: string; enabled?: boolean } = {},
): { pairs: BridgePair[]; pair?: BridgePair; error?: string } {
	const a = normalizeOrigin(x);
	const b = normalizeOrigin(y);
	if (!a || !b) return { pairs, error: getMessage("bridge_pairNeedsHttp", undefined, "两端都要是 http/https 地址（如 https://a.example）") };
	if (a === b) return { pairs, error: getMessage("bridge_pairSameAddress", undefined, "两端不能是同一个地址") };
	const id = pairId(a, b);
	const existing = pairs.find((p) => p.id === id);
	const note = (opts.note ?? existing?.note ?? "").trim();
	const merged: BridgePair = {
		id,
		a: a < b ? a : b,
		b: a < b ? b : a,
		enabled: opts.enabled ?? existing?.enabled ?? true,
		createdAt: existing?.createdAt || opts.now || "",
		...(note ? { note: note.slice(0, 120) } : {}),
	};
	const rest = pairs.filter((p) => p.id !== id);
	return { pairs: [...rest, merged].sort((p, q) => p.id.localeCompare(q.id)), pair: merged };
}

/** 从配对表里移除一对。 */
export function removePair(pairs: BridgePair[], id: string): BridgePair[] {
	return pairs.filter((p) => p.id !== id);
}

// ------------------------------------------------------- 配对候选（最近访问过的页面）

/**
 * 用户最近**点过扩展图标**的页面。
 *
 * 为什么要这个：加一对配对得先知道两端的 origin —— 让用户手打 `http://localhost:5173`
 * 这种地址是最容易被放弃的一步。而扩展在用户点图标那一刻就有 `activeTab` 授权，能读到
 * 当前页的 url 与标题 —— 于是「点过图标的页面」就是最好的候选集。
 *
 * 为什么不用 `chrome.tabs.query({})` 直接列所有标签页：那需要 host 权限（或 `tabs` 权限），
 * 前者对未授权站点拿不到 url，后者会在安装时提示「读取您的浏览记录」—— 为一个下拉框
 * 多要一份看着很吓人的权限不划算。
 */
export interface RecentOrigin {
	origin: string;
	/** 页面标题（下拉里用标题比 origin 好认得多）。 */
	title?: string;
	/** ISO 时间字符串（排序用：最近点过的排前面）。 */
	at: string;
}

/** 候选保留上限（下拉框不该变成一个需要滚动筛选的列表）。 */
export const MAX_RECENT = 12;

/** 任意来源的数组 → 干净的候选列表（去重、按最近在前、截断）。 */
export function normalizeRecent(raw: unknown): RecentOrigin[] {
	const list = Array.isArray(raw) ? raw : [];
	const best = new Map<string, RecentOrigin>();
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const src = item as Record<string, unknown>;
		const origin = normalizeOrigin(src.origin);
		if (!origin) continue;
		const title = typeof src.title === "string" ? src.title.trim() : "";
		const entry: RecentOrigin = {
			origin,
			title: title ? title.slice(0, 80) : origin,
			at: typeof src.at === "string" ? src.at : "",
		};
		// 同一 origin 出现两次（脏数据 / 两个写者）→ 保留**更新**的那条（ISO 字符串字典序 = 时间序）
		const prev = best.get(origin);
		if (!prev || entry.at > prev.at) best.set(origin, entry);
	}
	return [...best.values()]
		.sort((x, y) => (x.at === y.at ? x.origin.localeCompare(y.origin) : y.at.localeCompare(x.at)))
		.slice(0, MAX_RECENT);
}

/** 记一次「用户看过这个页面」（已存在就提到最前，不产生重复项）。 */
export function rememberRecent(
	list: RecentOrigin[],
	origin: unknown,
	opts: { title?: string; now?: string } = {},
): RecentOrigin[] {
	const self = normalizeOrigin(origin);
	if (!self) return list; // chrome:// 这类注入不了的地方不进候选（配了也没用）
	const rest = list.filter((item) => item.origin !== self);
	const title = (opts.title ?? "").trim();
	return normalizeRecent([
		{ origin: self, ...(title ? { title } : {}), at: opts.now ?? new Date().toISOString() },
		...rest,
	]);
}

// ------------------------------------------- AI 操作页面（browser_page 工具的目标页面）

/**
 * 被授权「让 AI 操作」的页面。
 *
 * 与配对（`BridgePair`）的区别：配对是**两个网页**之间互调（双方都是页面，用户得自己写
 * `window.__piBridge.call`）；这里是**pi-web-ui 当作控制台**、把另一个页面交给模型操作
 * （模型通过 `browser_page` 工具发起）。所以它只存**一个端点**，另一端固定是 pi-web-ui。
 *
 * 结构复用 `RecentOrigin`（origin + 标题 + 时间），它本来就是「用户关心的页面」。
 */
export type AiPage = RecentOrigin;

/** 授权列表归一（与配对候选同一套规则：去重保留最新、按最近排序、上限、只留 http(s)）。 */
export const normalizeAiPages = normalizeRecent;

/**
 * 页面侧支持的**内置动作**（AI 操作页面时的 op 白名单）。
 *
 * 服务端不解读 op（只透传），所以词表在这里；worker 侧必须按它校验 ——
 * 否则页面里一段脚本就能让扩展去执行任意内部动作。
 *
 * `status` / `openOptions` 不是页面动作（worker 自己答：授权了哪些页、两个开关开没开、
 * 扩展设置页在哪 / 帮用户打开那个页）—— 它们在白名单里，是为了让**宿主页面能问状态、
 * 能开设置**：pi-web-ui 的入口就靠它们。（网页不能自己打开 `chrome-extension://`，
 * 只能让扩展去开。）
 *
 * `shot`（截图）与 `metrics`（视口/dpr）也不是页面自己执行的：截图是**扩展**的能力
 * （`captureVisibleTab` 只能截活动标签页，还要先把目标页切到前台、截完切回），
 * `metrics` 只是给截图算裁剪用的（rect 是 CSS 像素，截出来的是物理像素）。
 */
export const BUILTIN_OPS = [
	"status",
	"openOptions",
	"pages",
	"read",
	"click",
	"type",
	"scroll",
	"goto",
	"wait",
	"eval",
	"shot",
	"metrics",
] as const;

export type BuiltinOp = (typeof BUILTIN_OPS)[number];

export function isBuiltinOp(v: unknown): v is BuiltinOp {
	return typeof v === "string" && (BUILTIN_OPS as readonly string[]).includes(v);
}

/**
 * 截图要额外申请的权限：http 与 https 的**任意主机**（等价于 `<all_urls>`）。
 *
 * 为什么非得要它：`chrome.tabs.captureVisibleTab` 只认 `<all_urls>` 或 `activeTab` ——
 * **普通 host 权限不够**。拾取时的元素截图能用是因为用户刚点过扩展图标（那一刻有 activeTab），
 * 而 AI 操作是模型自己发起的，没有那个手势。所以「允许截图」这个开关背后必然是一次
 * 「读取您在所有网站上的数据」的授权 —— 代价必须让用户看见（选项页里写明了）。
 *
 * 这两个模式已在 manifest 的 `optional_host_permissions` 里声明，所以能按需申请。
 */
export const SHOT_PERMISSION_ORIGINS = ["http://*/*", "https://*/*"] as const;

/** 「在页面里执行任意 JS」的 op —— 单独一个开关控制（默认关，worker 侧强制检查）。 */
export const EVAL_OP: BuiltinOp = "eval";

/** AI 路由结论：放行（给出目标页面）或拒绝（给出可读原因）。 */
export type AiRouteDecision =
	| { ok: true; page: AiPage; peer: string }
	| { ok: false; code: "bad-origin" | "no-page" | "ambiguous"; message: string };

/**
 * 「模型想操作 to 这个页面」能不能放行。
 *
 * 调用者固定是浏览器里那个 pi-web-ui 页面（worker 用 `sender.tab.url` 判定，本函数不管），
 * 所以这里只回答「目标页面在不在授权列表里」。`to` 省略时走「唯一页面」规则：
 * 只有一页就直接用，多页必须显式指定 —— 猜一个然后点错页面的代价太大。
 */
export function decideAiRoute(aiPages: AiPage[], toOrigin?: unknown): AiRouteDecision {
	const rawTo = typeof toOrigin === "string" ? toOrigin.trim() : "";
	const want = rawTo ? normalizeOrigin(rawTo) : undefined;
	if (rawTo && !want) {
		return { ok: false, code: "bad-origin", message: `目标页面地址不合法（${rawTo}）—— 只支持 http/https 页面` };
	}
	if (aiPages.length === 0) {
		return {
			ok: false,
			code: "no-page",
			message: getMessage(
				"bridge_noAiPages",
				undefined,
				"还没有授权任何页面给 AI —— 在 page-picker 扩展的选项页「AI 操作页面」里授权一个页面",
			),
		};
	}
	if (want) {
		const page = aiPages.find((p) => p.origin === want);
		if (!page) {
			return {
				ok: false,
				code: "no-page",
				message: `${want} 没有被授权给 AI（当前授权的：${aiPages.map((p) => p.origin).join("、")}）`,
			};
		}
		return { ok: true, page, peer: want };
	}
	if (aiPages.length > 1) {
		return {
			ok: false,
			code: "ambiguous",
			message: `有多个已授权页面（${aiPages.map((p) => p.origin).join("、")}）—— 调用时用 target 指定一个`,
		};
	}
	return { ok: true, page: aiPages[0], peer: aiPages[0].origin };
}
