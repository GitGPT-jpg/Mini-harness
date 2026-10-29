/// <reference path="./chrome.d.ts" />
/// <reference lib="dom" />
/**
 * Service worker：扩展的大脑（唯一知道 pi-web-ui 在哪的一块）。
 *
 * 职责边界：
 * - content script 只管「在被调试页面上拾取 + 画 UI」，**不知道 pi-web-ui 的存在**；
 * - 这里负责读设置、把契约渲染成 Markdown、找到 pi-web-ui 标签页、注入内容；
 * - 投递用 `world: "MAIN"` 注入（隔离世界看不到页面上的 `window.__piWebUiHost`）；
 * - 点图标时**先认页面**：当前页就是 pi-web-ui 的话，注入绑定浮条问用户要不要把它
 *   设成服务地址（远程/局域网部署不用再手打地址），而不是往它上面注入拾取器。
 *
 * 兜底纪律：**投递失败也必须把 Markdown 交给用户**（回给 content script 复制到剪贴板），
 * 绝不出现「点了发送，什么都没发生」。
 */

import type { BindResult, PiProbe } from "./shared/bind.js";
import { getMessage } from "./shared/i18n.js";
import {
	BUILTIN_OPS,
	EVAL_OP,
	SHOT_PERMISSION_ORIGINS,
	MAX_RESULT_CHARS,
	decideAiRoute,
	decideRoute,
	isBuiltinOp,
	measureForTransport,
	normalizeOrigin,
	parseBridgeCall,
	peersOf,
	type AiPage,
	type BridgePair,
} from "./shared/bridge.js";
import { hasOriginPermission, loadAiPages, loadPairs, rememberOrigin } from "./shared/bridge-store.js";
import { installBridgePage, invokeBridgeHandler, uninstallBridgePage } from "./content/bridge-page.js";
// 页面侧的两个函数也要给测试用（E2E 靠它们模拟 executeScript 把函数搬进页面）——它们
// 本来就不是私有的，只是被 background 当「可序列化的函数体」引用。
export { installBridgePage, invokeBridgeHandler, uninstallBridgePage };
import type { PickPayload } from "./shared/contract.js";
import {
	normalizeServerUrl,
	normalizeSettings,
	originPattern,
	tabMatchesBase,
	type PickerSettings,
} from "./shared/settings.js";
import { planCrop, type CropPlan } from "./shared/shot-crop.js";
import { toPrompt } from "./shared/to-prompt.js";

export const PICKER_FILE = "dist/picker.js";
export const BIND_FILE = "dist/bind.js";

/** 截图那条链上用到的最小 chrome 面（注入以便单测替换）。 */
export interface ChromeLike {
	tabs: { captureVisibleTab(windowId: number | undefined, options: { format: "png" }): Promise<string> };
}

/** 注入 MAIN world 的函数：调页面上的宿主动作桥，把内容塞进输入框草稿。 */
interface ComposeResult {
	ok: boolean;
	reason?: "no-host" | "refused";
}

interface ComposeAttachment {
	path: string;
	name: string;
	mode: "inline";
	imageData: string;
	key: string;
}

/** MAIN world 里执行：只做「找到桥 + 调用」，所有判断回传给 worker 做。 */
export function composeInPage(text: string, attachments: ComposeAttachment[]): ComposeResult {
	const host = (globalThis as unknown as Record<string, unknown>).__piWebUiHost as
		{ compose?: (o: { text: string; attachments?: ComposeAttachment[] }) => boolean } | undefined;
	if (!host || typeof host.compose !== "function") return { ok: false, reason: "no-host" };
	const ok = host.compose(attachments.length > 0 ? { text, attachments } : { text });
	return ok ? { ok: true } : { ok: false, reason: "refused" };
}

/**
 * MAIN world 里执行：判断当前这个页面是不是 pi-web-ui，以及页面上有没有宿主动作桥。
 *
 * 两个判据（**都要**，因为版本分布很杂）：
 * 1. `window.__piWebUiHost`（宿主 API v2 起有）—— 最硬，但仍要 `/api/health` 兜底，
 *    因为老版本没有这个桥；
 * 2. 同源探一次 `/api/health`（pi-web-ui 一直有这个路由，返回 `{ok, piVersion, engine}`）。
 *    这是**页面自己**发的同源请求，不需要扩展有该 origin 的权限（远程部署下正是缺这个）。
 *
 * 注意：这个函数会被序列化后注入页面，**不能引用模块作用域的任何东西**（只能用全局）。
 * 探测最长等 1.2s：点图标这件事绝不能被一个慢请求卡住。
 */
export async function detectPiWebUi(): Promise<PiProbe> {
	const g = globalThis as unknown as { __piWebUiHost?: { compose?: unknown } };
	const url = location.href;
	const title = document.title;
	const hasHost = typeof g.__piWebUiHost?.compose === "function";
	if (hasHost) return { isPiWebUi: true, hasHost: true, url, title };
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 1200);
		const res = await fetch("/api/health", { cache: "no-store", signal: ctrl.signal });
		clearTimeout(timer);
		if (res.ok) {
			const info = (await res.json()) as { ok?: unknown; piVersion?: unknown; engine?: unknown } | null;
			if (info && info.ok === true && (typeof info.piVersion === "string" || typeof info.engine === "string")) {
				return {
					isPiWebUi: true,
					hasHost: false,
					url,
					title,
					...(typeof info.piVersion === "string" ? { piVersion: info.piVersion } : {}),
				};
			}
		}
	} catch {
		/* 探不通（跨域/CSP/超时）→ 就当它不是 pi-web-ui，走原来的拾取流程 */
	}
	return { isPiWebUi: false, hasHost, url, title };
}

/** 在当前标签页里跑探测（注入不了就返回 undefined，交给调用方按老路走）。 */
async function probeTab(tabId: number): Promise<PiProbe | undefined> {
	try {
		const [first] = await chrome.scripting.executeScript<PiProbe>({
			target: { tabId },
			world: "MAIN",
			func: detectPiWebUi,
		});
		return first?.result;
	} catch {
		return undefined;
	}
}

/**
 * 点扩展图标 / 按快捷键的入口：**先认页面，再决定注入什么**。
 *
 * 在 pi-web-ui 自己的页面上注入拾取器是没有意义的（这里的元素不是用户要改的代码），
 * 而且远程部署的用户此刻正站在这页上 —— 正是问「要不要把它设成服务地址」的最佳时机。
 *
 * 三条分支都**不会静默**：
 * - 是 pi-web-ui → 注入绑定浮条；
 * - 不是 → 照旧注入拾取器；
 * - **探测本身不可用**（MAIN world 被 CSP/权限挡）→ 照样注入浮条，让它自己认页面
 *   （认不出会自己退场并请 worker 补注入拾取器）。路由决策也打进 SW 控制台，方便排障。
 */
export async function handleAction(tab: { id?: number; url?: string; title?: string } | undefined): Promise<void> {
	const tabId = tab?.id;
	if (tabId == null) return;
	// 用户主动在这个页面上点了一下图标 → 它进配对候选（此刻 activeTab 让 url/标题可读）。
	// 顺序无所谓：记候选失败不该挡住拾取器注入，所以 await 一个自己吞异常的调用
	await rememberOrigin(tab?.url, tab?.title);
	const probe = await probeTab(tabId);
	if (probe?.isPiWebUi) {
		console.log("[page-picker] 本页是 pi-web-ui → 注入绑定浮条", tabId, probe.url);
		await injectBindBar(tabId);
		return;
	}
	if (probe === undefined) {
		console.log("[page-picker] MAIN 探测不可用 → 交给浮条自检", tabId);
		await injectBindBar(tabId);
		return;
	}
	console.log("[page-picker] 本页不是 pi-web-ui → 注入拾取器", tabId, probe.url);
	await startPicking(tab);
}

/** 注入绑定浮条（它自己会找 background 要设置、按 location.href 算文案）。 */
export async function injectBindBar(tabId: number): Promise<void> {
	try {
		await chrome.scripting.executeScript({ target: { tabId }, files: [BIND_FILE] });
		await chrome.action.setBadgeText({ text: "", tabId });
		await chrome.action
			.setTitle({
				title: getMessage(
					"background_piWebUiPageBadge",
					undefined,
					"这个页面是 pi-web-ui：页面上会问你要不要把它设为拾取服务地址",
				),
				tabId,
			})
			.catch(() => {});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await chrome.action.setBadgeText({ text: "!", tabId }).catch(() => {});
		await chrome.action.setTitle({ title: `这个页面无法注入：${message}`, tabId }).catch(() => {});
	}
}

/** permissions API 的最小面（老环境可能整个没有 → 按可选处理）。 */
interface PermissionsLike {
	contains?: (p: { origins: string[] }) => Promise<boolean>;
	request?: (p: { origins: string[] }) => Promise<boolean>;
}

/**
 * 该 origin 的 host 权限有没有（没有就申请一次）。
 *
 * 申请必须在**用户手势**里发出，而绑定按钮点在页面上（content script 的 UI），
 * 浏览器不认这个手势 → `request` 会返回 false，于是回 needAuth，让用户去选项页点
 * （那里的点击一定带手势）。老环境没有 permissions API 时不阻断（后面按 URL 复核兜底）。
 */
async function ensureOrigin(pattern: string): Promise<boolean> {
	const perms = chrome.permissions as PermissionsLike | undefined;
	if (!perms?.contains || !perms.request) return true;
	try {
		if (await perms.contains({ origins: [pattern] })) return true;
	} catch {
		return true;
	}
	try {
		return await perms.request({ origins: [pattern] });
	} catch {
		return false;
	}
}

/**
 * 把某个 pi-web-ui 页面绑成服务地址（浮条上点了「设为服务地址」）。
 *
 * 地址一律按页面**归一后**再存：`http://host:8787/?token=x` → `http://host:8787`。
 * 授权拿不到就不写存储 —— 没授权时连「找到那个标签页」都做不到，绑了也是白绑。
 */
export async function bindServer(pageUrl: string): Promise<BindResult> {
	const base = normalizeServerUrl(pageUrl);
	const pattern = originPattern(base);
	if (!(await ensureOrigin(pattern))) {
		return {
			ok: false,
			base,
			needAuth: true,
			message: getMessage(
				"bind_needAuth",
				[pattern],
				`还差一次授权（${pattern}）：浏览器要求这个动作在扩展自己的页面里点一下`,
			),
		};
	}
	try {
		await chrome.storage.sync.set({ serverUrl: base });
	} catch (err) {
		return {
			ok: false,
			base,
			message: getMessage(
				"bind_saveFailed",
				[err instanceof Error ? err.message : String(err)],
				`保存失败：${err instanceof Error ? err.message : String(err)}`,
			),
		};
	}
	return {
		ok: true,
		base,
		message: getMessage("bind_bound", [base], `已绑定 ${base} —— 以后拾取的内容都注入到这里`),
	};
}

/** 打开选项页并带上 `?bind=`（那边有真正的用户手势，能授权、能测试连接）。 */
export async function openOptionsFor(pageUrl: string): Promise<void> {
	const base = normalizeServerUrl(pageUrl);
	try {
		await chrome.tabs.create({ url: chrome.runtime.getURL(`options.html?bind=${encodeURIComponent(base)}`) });
	} catch {
		/* 打不开就只是没打开：用户还能自己去 chrome://extensions → 选项页 */
	}
}

/**
 * 打开选项页的「页面桥」面板，并预填这一端（用户在页面上点了「与另一页配对…」）。
 *
 * 为什么不就地配对：建配对要申请两个 origin 的 host 权限，而 `permissions.request`
 * 必须在**用户手势**里发出 —— 网页上的按钮给不了。所以只能把用户送到扩展自己的页面上点一下。
 */
export async function openOptionsForPair(pageUrl: string): Promise<boolean> {
	const origin = normalizeOrigin(pageUrl);
	if (!origin) return false;
	try {
		await chrome.tabs.create({ url: chrome.runtime.getURL(`options.html?pair=${encodeURIComponent(origin)}`) });
		return true;
	} catch {
		return false;
	}
}

/**
 * 打开选项页的「AI 操作页面」面板并预填本页（用户在浮条上点了「让 AI 操作本页…」）。
 *
 * 同一个理由：授权一个页面 = 要那个 origin 的 host 权限 + 写授权表，而前者必须在选项页的
 * 一次点击里完成。这一步就是「要不要让模型碰这个页面」的人工确认。
 */
export async function openOptionsForGrant(pageUrl: string): Promise<boolean> {
	const origin = normalizeOrigin(pageUrl);
	if (!origin) return false;
	try {
		await chrome.tabs.create({ url: chrome.runtime.getURL(`options.html?grant=${encodeURIComponent(origin)}`) });
		return true;
	} catch {
		return false;
	}
}

export async function loadSettings(): Promise<PickerSettings> {
	try {
		const raw = await chrome.storage.sync.get(null);
		return normalizeSettings(raw);
	} catch {
		return normalizeSettings(null);
	}
}

/** 点扩展图标 / 按快捷键：往当前标签页注入拾取器。 */
export async function startPicking(tab: { id?: number } | undefined): Promise<void> {
	const tabId = tab?.id;
	if (tabId == null) return;
	try {
		await chrome.scripting.executeScript({ target: { tabId }, files: [PICKER_FILE] });
		await chrome.action.setBadgeText({ text: "", tabId });
	} catch (err) {
		// 浏览器内部页 / 商店页 / PDF 等注入不了：明确告诉用户，别静默失败
		const message = err instanceof Error ? err.message : String(err);
		await chrome.action.setBadgeText({ text: "!", tabId }).catch(() => {});
		await chrome.action.setTitle({ title: `这个页面无法拾取：${message}`, tabId }).catch(() => {});
	}
}

/** 找不到目标页面的原因（要能区分，否则远程用户会被误导着去查错地方）。 */
export type TargetMiss = "no-permission" | "no-tab";

async function findTargetTab(settings: PickerSettings): Promise<{ tab?: chrome.tabs.Tab; miss?: TargetMiss }> {
	const base = normalizeServerUrl(settings.serverUrl);
	// 权限先查：没授权时 tabs.query 的 url 过滤会被静默忽略（返回全部标签页），
	// 再往下走就可能把内容注入到无关页面，还会报一个「找不到页面」的错诊。
	try {
		const granted = await chrome.permissions.contains({ origins: [originPattern(base)] });
		if (!granted) return { miss: "no-permission" };
	} catch {
		/* 老版本/测试环境没有 permissions API → 不阻断，继续往下（后面还有 URL 复核兜底） */
	}
	let tabs: chrome.tabs.Tab[] = [];
	try {
		// 只按 **origin 模式** 过滤（`http://localhost:8787/*`）：
		// 裸 origin（`http://localhost:8787`）不是合法 match pattern，Chrome/Edge 会直接抛
		// `Invalid url pattern` —— 一旦被 catch 成「没找到页面」，就变成「页开着但投不进去」。
		// 路径前缀的精确认定交给下面的 tabMatchesBase（它才认子路径反代）。
		tabs = await chrome.tabs.query({ url: [originPattern(base)] });
	} catch {
		return { miss: "no-tab" };
	}
	// 复核 URL：远程/子路径部署下绝不靠「有 id 就算」挑第一个
	const tab = tabs.find((t) => t.id != null && tabMatchesBase(t.url, base));
	return tab ? { tab } : { miss: "no-tab" };
}

/**
 * 给每个元素补截图（可选，设置里开）。
 *
 * 整屏截一次（`captureVisibleTab` 只给可见区域），然后按每个元素的 rect × dpr 抠出来、
 * 缩到长边 ≤1568。**任何一步失败都只是「没有截图」**，绝不因此让整次拾取失败 ——
 * 用户点的是「添加到对话」，不是「截图」。
 */
export async function attachShots(
	payload: PickPayload,
	settings: PickerSettings,
	tab: { id?: number; windowId?: number } | undefined,
	chromeApi: ChromeLike = chrome,
): Promise<PickPayload> {
	if (!settings.screenshots) return payload;
	const tabId = tab?.id;
	if (tabId == null || !tab) return payload;
	let dataUrl: string;
	try {
		dataUrl = await chromeApi.tabs.captureVisibleTab(tab.windowId, { format: "png" });
	} catch {
		return payload; // 没有 activeTab/权限、页面正在滚动……都不是致命错
	}
	if (!dataUrl) return payload;
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
	} catch {
		return payload;
	}
	const dpr = payload.page?.viewport?.dpr ?? 1;
	const elements = [...payload.elements];
	let changed = false;
	for (let i = 0; i < elements.length; i++) {
		const el = elements[i];
		if (el.shot) continue;
		const plan = planCrop(el.snapshot.rect, { dpr, imageW: bitmap.width, imageH: bitmap.height });
		if (!plan) continue;
		try {
			const shot = await cropToPng(bitmap, plan);
			if (shot) {
				elements[i] = { ...el, shot };
				changed = true;
			}
		} catch {
			/* 单个元素截图失败不影响其它的 */
		}
	}
	bitmap.close();
	return changed ? { ...payload, elements } : payload;
}

/** 按计划抠图 → PNG data URL（service worker 里用 OffscreenCanvas，无 DOM 依赖）。 */
async function cropToPng(bitmap: ImageBitmap, plan: CropPlan): Promise<string | undefined> {
	const canvas = new OffscreenCanvas(plan.dstW, plan.dstH);
	const ctx = canvas.getContext("2d");
	if (!ctx) return undefined;
	ctx.drawImage(bitmap, plan.srcX, plan.srcY, plan.srcW, plan.srcH, 0, 0, plan.dstW, plan.dstH);
	const blob = await canvas.convertToBlob({ type: "image/png" });
	const bytes = new Uint8Array(await blob.arrayBuffer());
	return `data:image/png;base64,${toBase64(bytes)}`;
}

/** 手写 base64（SW 里没有 FileReader/btoa 的那套 DOM 便利）——分块避免超长参数栈溢出。 */
export function toBase64(bytes: Uint8Array): string {
	const TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let out = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i];
		const b1 = bytes[i + 1];
		const b2 = bytes[i + 2];
		out += TABLE[b0 >> 2];
		out += TABLE[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
		out += b1 === undefined ? "=" : TABLE[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
		out += b2 === undefined ? "=" : TABLE[b2 & 63];
	}
	return out;
}

/** 卡片 → 对话附件（截图）。
 *  无路径无 key 的裸数据在宿主侧不会去重，所以 key 必须带上拾取 id（重试时不叠加）。 */
export function attachmentsOf(payload: PickPayload): ComposeAttachment[] {
	const out: ComposeAttachment[] = [];
	payload.elements.forEach((el, i) => {
		if (!el.shot) return;
		out.push({
			path: "",
			name: `元素${i + 1}-${el.snapshot.tag}.png`,
			mode: "inline",
			imageData: el.shot,
			key: `${payload.id}-${i + 1}`,
		});
	});
	return out;
}

/** 把 Markdown（+ 截图附件）投进已打开的 pi-web-ui 页面输入框。 */
export async function deliver(
	payload: PickPayload,
	markdown: string,
	settings: PickerSettings,
): Promise<{ ok: boolean; message: string; copy?: string }> {
	const copy = settings.copyToClipboard ? markdown : undefined;
	const { tab, miss } = await findTargetTab(settings);
	if (!tab?.id) {
		const base = normalizeServerUrl(settings.serverUrl);
		const suffix = copy ? getMessage("deliver_copiedFallback", undefined, "，Markdown 已复制到剪贴板") : "";
		if (miss === "no-permission") {
			return {
				ok: false,
				copy,
				message: getMessage(
					"deliver_noPermission",
					[originPattern(base), suffix],
					`还没授权 ${originPattern(base)} —— 到扩展选项页点「授权该地址」${suffix}`,
				),
			};
		}
		return {
			ok: false,
			copy,
			message: getMessage("deliver_noTab", [base, suffix], `没找到打开的 pi-web-ui 页面（${base}）${suffix}`),
		};
	}
	let result: ComposeResult | undefined;
	try {
		const [first] = await chrome.scripting.executeScript<ComposeResult>({
			target: { tabId: tab.id },
			world: "MAIN",
			func: composeInPage,
			args: [markdown, attachmentsOf(payload)],
		});
		result = first?.result;
	} catch (err) {
		return {
			ok: false,
			copy,
			message: getMessage(
				"deliver_injectFailed",
				[err instanceof Error ? err.message : String(err)],
				`注入 pi-web-ui 失败：${err instanceof Error ? err.message : String(err)}`,
			),
		};
	}
	if (result?.ok) {
		if (settings.focusTarget) await focusTab(tab);
		const n = payload.elements.length;
		return {
			ok: true,
			copy,
			message: getMessage(
				"deliver_injected",
				[String(n)],
				`已添加到 pi-web-ui 输入框（${n} 个元素），补充说明后发送`,
			),
		};
	}
	if (result?.reason === "no-host") {
		return {
			ok: false,
			copy,
			message: getMessage(
				"deliver_noHost",
				undefined,
				"这个 pi-web-ui 页面还不支持输入框注入（版本过旧），请更新 pi-web-ui 后刷新页面",
			),
		};
	}
	return {
		ok: false,
		copy,
		message: getMessage("deliver_notReady", undefined, "pi-web-ui 输入框还没就绪，刷新页面后再试"),
	};
}

async function focusTab(tab: chrome.tabs.Tab): Promise<void> {
	try {
		if (tab.id != null) await chrome.tabs.update(tab.id, { active: true });
		if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
	} catch {
		/* 切不过去不影响已注入的内容 */
	}
}

// ------------------------------------------------------------------ 页面桥（跨页面读写）

/**
 * 页面桥的 content script（隔离世界上行中转）。
 *
 * 为什么不在 manifest 里声明 `content_scripts`：那会要求「读取所有网站数据」的权限，
 * 装扩展时的提示会劝退所有人。桥只在**用户显式配对过的 origin** 上按需注入。
 */
export const BRIDGE_FILE = "dist/bridge.js";

/** 一次对端调用的结果（`code` 供调用方分支，`error` 是给人看的）。 */
export interface PeerCallResult {
	ok: boolean;
	value?: unknown;
	error?: string;
	/** 机器可读分类：no-bridge（可补装重试）/ no-handler / bad-op / timeout / empty / too-large / inject-failed。 */
	code?: string;
}

/**
 * 一次协调要用的全部上下文（配对表 + AI 授权页 + 设置）。
 *
 * 打包成一个对象是为了「一次协调里读一次存储」：之前每个页面都重新读一遍，页面多了很吵；
 * 更重要的是**同一个决定要在同一份快照上做**（中途别人改了授权表，不该出现半新半旧）。
 */
export interface BridgeContext {
	pairs: BridgePair[];
	aiPages: AiPage[];
	settings: PickerSettings;
}

export async function loadBridgeContext(): Promise<BridgeContext> {
	const [pairs, aiPages, settings] = await Promise.all([loadPairs(), loadAiPages(), loadSettings()]);
	return { pairs, aiPages, settings };
}

/** 一个标签页在页面桥里的角色（**按地址判定，不信页面自报**）。 */
export function roleOf(tabUrl: string | undefined, ctx: BridgeContext): "host" | "target" | "peer" | "none" {
	if (!tabUrl) return "none";
	const origin = normalizeOrigin(tabUrl);
	if (!origin) return "none";
	// 宿主优先：pi-web-ui 页面即使也在配对表里，它的身份也是「控制台」
	if (tabMatchesBase(tabUrl, ctx.settings.serverUrl)) return "host";
	if (ctx.aiPages.some((page) => page.origin === origin)) return "target";
	if (peersOf(ctx.pairs, origin).length > 0) return "peer";
	return "none";
}

/** 给 Promise 加个上限：对端页面可能永远不回（它的 handler 挂了），不能把 worker 悬在那里。 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return await new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

/**
 * 把一个页面装成桥（content script + MAIN world 页面 API）。
 *
 * 三种角色（由 `roleOf` 按地址判定，**不是页面上自报的**）：
 * - `host`：浏览器里的 pi-web-ui 页面 —— 模型的操作从这里发起（peers = AI 授权页面）；
 * - `target`：被授权「让 AI 操作」的页面 —— 装内置动作（read/click/type/…）；
 * - `peer`：配对过的普通页面 —— 页面自己用 `window.__piBridge.on/call` 互调。
 *
 * 顺序不能反：MAIN 桥的通道凭据（token）是 content script 写进 DOM 属性的，先装 MAIN
 * 只会拿到 `no-token`。**无关的页面一个字节都不注入**（默认拒绝）。
 */
export async function armBridge(tab: { id?: number; url?: string }, ctx?: BridgeContext): Promise<boolean> {
	const tabId = tab?.id;
	const origin = normalizeOrigin(tab?.url);
	if (tabId == null || !origin) return false;
	const context = ctx ?? (await loadBridgeContext());
	const role = roleOf(tab?.url, context);
	if (role === "none") return false;
	try {
		await chrome.scripting.executeScript({ target: { tabId }, files: [BRIDGE_FILE] });
	} catch (err) {
		// chrome:// 页、商店页、扩展页：注入不了。这里只是日志，不是错误（拾取主流程不受影响）
		console.log("[page-picker] 页面桥注入失败：", tabId, err instanceof Error ? err.message : err);
		return false;
	}
	try {
		// arm：刷新 token 并写到 DOM 上，紧接着的 MAIN 注入会读它
		const res = await chrome.tabs.sendMessage<{ ok?: boolean; token?: string }>(tabId, {
			type: "page-picker:bridge-arm",
		});
		if (!res?.token) return false;
	} catch {
		return false;
	}
	// 宿主页要知道自己能操作哪些页面；其它角色看自己的对端
	const peers = role === "host" ? context.aiPages.map((page) => page.origin) : peersOf(context.pairs, origin);
	try {
		await chrome.scripting.executeScript({
			target: { tabId },
			world: "MAIN",
			func: installBridgePage,
			args: [{ peers, self: origin, control: role === "target" }],
		});
	} catch {
		return false;
	}
	return true;
}

/**
 * 全量协调：把已打开的、该装桥的页面都装好。
 *
 * 涵盖三类页面：AI 授权页（模型操作的目标）、配对页面、以及浏览器里的 pi-web-ui 宿主页。
 * 触发点：SW 启动（浏览器重启后页面还开着，缺这一步桥是哑的）、配对/授权变更、页面导航完成。
 */
export async function syncBridges(ctx?: BridgeContext): Promise<number> {
	const context = ctx ?? (await loadBridgeContext());
	const origins = new Set<string>();
	for (const page of context.aiPages) origins.add(page.origin);
	for (const pair of context.pairs) {
		if (!pair.enabled) continue;
		origins.add(pair.a);
		origins.add(pair.b);
	}
	// 宿主页（pi-web-ui 自己）也可能同时是一个配对端点，所以单独加进去
	const hostPattern = originPattern(context.settings.serverUrl);
	let count = 0;
	for (const origin of [...origins, context.settings.serverUrl]) {
		const pattern = originPattern(origin);
		// 没授权时 tabs.query 的 url 过滤会被**静默忽略**（返回全部标签页）——
		// 那样就会往无关页面里注入桥，这种事无论如何不能发生
		if (!(await hasOriginPermission(pattern))) continue;
		let tabs: chrome.tabs.Tab[] = [];
		try {
			tabs = await chrome.tabs.query({ url: [pattern] });
		} catch {
			continue;
		}
		for (const tab of tabs) {
			if (tab.id == null) continue;
			const same =
				tabMatchesBase(tab.url, context.settings.serverUrl) || normalizeOrigin(tab.url) === normalizeOrigin(origin);
			if (!same) continue; // pattern 只到 origin 级，再复核一次
			if (await armBridge({ id: tab.id, url: tab.url }, context)) count++;
		}
	}
	void hostPattern;
	return count;
}

/** 卸下某个 origin 的页面桥（那一对被删掉/停用了）。 */
export async function removeBridgeFromOrigin(origin: unknown): Promise<number> {
	const self = normalizeOrigin(origin);
	if (!self) return 0;
	const pattern = originPattern(self);
	if (!(await hasOriginPermission(pattern))) return 0;
	let tabs: chrome.tabs.Tab[] = [];
	try {
		tabs = await chrome.tabs.query({ url: [pattern] });
	} catch {
		return 0;
	}
	let count = 0;
	for (const tab of tabs) {
		if (tab.id == null || normalizeOrigin(tab.url) !== self) continue;
		try {
			await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: uninstallBridgePage });
			count++;
		} catch {
			/* 注入不了就跳过（页面已关/不可注入） */
		}
	}
	return count;
}

/** 在某个标签页里执行一次对端调用（MAIN world 注入，直接进页面的 handler）。 */
async function callPeerTab(
	tabId: number,
	req: { op: string; args?: unknown; from: string; builtin?: boolean },
	timeoutMs: number,
): Promise<PeerCallResult> {
	let res: PeerCallResult | undefined;
	try {
		const [first] = await withTimeout(
			chrome.scripting.executeScript<PeerCallResult>({
				target: { tabId },
				world: "MAIN",
				func: invokeBridgeHandler,
				args: [req],
			}),
			timeoutMs + 2000, // 比页面侧的超时宽一点：让页面自己先报「对端没回」，那句话更具体
			getMessage("bridge_peerTimeout", [String(timeoutMs)], `对端在 ${timeoutMs}ms 内没回`),
		);
		res = first?.result;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, code: "inject-failed", error: /没回/.test(message) ? message : `调用对端失败：${message}` };
	}
	if (!res || typeof res !== "object") {
		return {
			ok: false,
			code: "empty",
			error: getMessage("bridge_peerNoResult", undefined, "对端没有返回结果"),
		};
	}
	if (res.ok === true) {
		// 回程体积也查一遍：对端 handler 返回一个大对象是很容易发生的事
		const size = measureForTransport(
			res.value,
			getMessage("bridge_peerResultLabel", undefined, "对端返回的结果"),
			MAX_RESULT_CHARS,
		);
		if (!size.ok) return { ok: false, code: "too-large", error: size.message };
		return res.value === undefined ? { ok: true } : { ok: true, value: res.value };
	}
	return {
		ok: false,
		...(res.code ? { code: res.code } : {}),
		error: res.error ?? getMessage("bridge_peerCallFailed", undefined, "对端调用失败"),
	};
}

/**
 * content script 转发上来的调用：**全部准入判定都在这里**。
 *
 * 「谁在调用」只看 `sender.tab.url` —— 消息体里的任何字段都不作数。否则 A 页面可以自称
 * 是 B，把 B 的数据全部拿走（这是这套机制唯一真正的安全边界，其余都是过滤噪声）。
 */
export async function handleBridgeCall(raw: unknown, sender: chrome.runtime.MessageSender): Promise<PeerCallResult> {
	const from = normalizeOrigin(sender.tab?.url);
	if (!from) {
		return {
			ok: false,
			error: getMessage(
				"bridge_noHttpOrigin",
				undefined,
				"页面桥只能从 http/https 页面上发起（或者该地址还没授权，读不到标签页地址）",
			),
		};
	}
	const parsed = parseBridgeCall(raw);
	if (!parsed.ok) return { ok: false, code: "bad-op", error: parsed.message };
	const { op, args, to, timeoutMs } = parsed.call;

	const context = await loadBridgeContext();
	if (tabMatchesBase(sender.tab?.url, context.settings.serverUrl)) {
		return await handleAiCall({ op, args, to, timeoutMs, from }, context);
	}

	const route = decideRoute(context.pairs, from, to);
	if (!route.ok) return { ok: false, code: route.code, error: route.message };

	const pattern = originPattern(route.peer);
	if (!(await hasOriginPermission(pattern))) {
		return {
			ok: false,
			error: getMessage(
				"bridge_noPermission",
				[pattern],
				`还没授权 ${pattern} —— 到扩展选项页「页面桥」里点一次授权`,
			),
		};
	}
	let tabs: chrome.tabs.Tab[] = [];
	try {
		tabs = await chrome.tabs.query({ url: [pattern] });
	} catch {
		tabs = [];
	}
	const target = tabs.find((t) => t.id != null && normalizeOrigin(t.url) === route.peer);
	if (!target?.id) {
		return {
			ok: false,
			code: "no-peer",
			error: getMessage(
				"bridge_peerNotOpen",
				[route.peer],
				`对端页面（${route.peer}）没打开 —— 先把它开在一个标签页里`,
			),
		};
	}

	const req = { op, ...(args === undefined ? {} : { args }), from };
	const tabId = target.id;
	let result = await callPeerTab(tabId, req, timeoutMs);
	if (!result.ok && result.code === "no-bridge") {
		// 对端刚导航完 / 桥还没装上：补装一次再试。这一步决定了用户看到的是「失败」还是「自己好了」
		if (await armBridge({ id: tabId, url: target.url }, context)) {
			result = await callPeerTab(tabId, req, timeoutMs);
		}
	}
	return result;
}

/** `pages` 动作用：这些 origin 里哪些当前开着（没权限就不猜）。 */
async function openOrigins(origins: string[]): Promise<Set<string>> {
	const open = new Set<string>();
	for (const origin of origins) {
		const pattern = originPattern(origin);
		if (!(await hasOriginPermission(pattern))) continue;
		try {
			const tabs = await chrome.tabs.query({ url: [pattern] });
			if (tabs.some((t) => t.id != null && normalizeOrigin(t.url) === origin)) open.add(origin);
		} catch {
			/* 查不到就当没开 */
		}
	}
	return open;
}

/**
 * AI 操作页面的路由（浏览器里的 pi-web-ui 页面在调 —— 也就是模型在动手）。
 *
 * 与配对路由的区别：
 * - 目标必须在**授权列表**里（配对表不参与）；
 * - 目标页面走**内置动作**（`builtin: true`），不是页面自注册的 handler；
 * - 两个开关在这里强制：总开关（aiControl）与 eval（allowEval）。
 *
 * 这里是「不给 AI 乱动手」的唯一闸门：页面侧不重复判定（页面本来就无法绕过 worker）。
 */
async function handleAiCall(
	req: { op: string; args?: unknown; to?: string; timeoutMs: number; from: string },
	ctx: BridgeContext,
): Promise<PeerCallResult> {
	const { op, args, to, timeoutMs, from } = req;
	// `status` 是**状态查询**，不是页面动作：总开关关着时也要能答（否则用户在 pi-web-ui
	// 那边只会看到“没反应”，不知道该去哪里打开开关）。
	if (op === "status") {
		const open = await openOrigins(ctx.aiPages.map((page) => page.origin));
		return {
			ok: true,
			value: {
				installed: true,
				hasHost: true,
				version: chrome.runtime.getManifest?.().version ?? "",
				aiControl: ctx.settings.aiControl,
				allowEval: ctx.settings.allowEval,
				allowShot: ctx.settings.allowShot,
				shotPermission: await hasShotPermission(),
				pages: ctx.aiPages.map((page) => ({
					origin: page.origin,
					title: page.title ?? page.origin,
					open: open.has(page.origin),
				})),
				/** 扩展自己的设置页（授权/开关都在那里）—— pi-web-ui 的入口靠它给按钮。 */
				optionsUrl: chrome.runtime.getURL("options.html"),
			},
		};
	}
	// `openOptions`：帮用户打开扩展自己的设置页。网页不能直接导航到 `chrome-extension://`（会被
	// 浏览器拦），所以只能让扩展去开。与 status 一样不受总开关限制。
	if (op === "openOptions") {
		try {
			await chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
			return { ok: true, value: { opened: true } };
		} catch (err) {
			return {
				ok: false,
				error: getMessage(
					"ai_optionsOpenFailed",
					[err instanceof Error ? err.message : String(err)],
					`打不开扩展设置页：${err instanceof Error ? err.message : String(err)}`,
				),
			};
		}
	}
	if (!ctx.settings.aiControl) {
		return {
			ok: false,
			code: "disabled",
			error: getMessage("ai_statusDisabled", undefined, "「AI 操作页面」已在扩展设置里关闭 —— 到选项页打开后再试"),
		};
	}
	if (!isBuiltinOp(op)) {
		return {
			ok: false,
			code: "bad-op",
			error: getMessage(
				"ai_badOp",
				[op, BUILTIN_OPS.join("、")],
				`不支持的动作 "${op}"（支持：${BUILTIN_OPS.join("、")}）`,
			),
		};
	}
	if (op === EVAL_OP && !ctx.settings.allowEval) {
		return {
			ok: false,
			code: "eval-disabled",
			error: getMessage(
				"ai_evalDisabled",
				undefined,
				"「在页面里执行任意 JS」默认关闭 —— 到扩展选项页「AI 操作页面」里打开它再用 eval",
			),
		};
	}
	if (op === "shot" && !ctx.settings.allowShot) {
		return {
			ok: false,
			code: "shot-disabled",
			error: getMessage(
				"ai_shotDisabled",
				undefined,
				"「允许截图」已在扩展设置里关闭 —— 到选项页打开后再试（关掉时模型只能靠 read 读 DOM）",
			),
		};
	}
	// pages：worker 自己就能答（它知道标题、也知道哪些页面开着），不必去打扰页面
	if (op === "pages") {
		const open = await openOrigins(ctx.aiPages.map((page) => page.origin));
		return {
			ok: true,
			value: {
				pages: ctx.aiPages.map((page) => ({
					origin: page.origin,
					title: page.title ?? page.origin,
					open: open.has(page.origin),
				})),
			},
		};
	}
	const target = await resolveAiTarget(ctx, to);
	if (!target.ok) return target.result;
	// 截图：扩展自己的活（captureVisibleTab + 切页 + 裁剪），不进页面执行
	if (op === "shot") return await captureShot(target.tab, (args ?? {}) as Record<string, unknown>);
	const peerReq = { op, ...(args === undefined ? {} : { args }), from, builtin: true };
	let result = await callPeerTab(target.tab.id as number, peerReq, timeoutMs);
	if (!result.ok && (result.code === "no-bridge" || result.code === "no-control")) {
		// 刚导航完 / 桥还没装 / 刚授权还没重装：补装一次再试（与配对路径同一个兜底思路）
		if (await armBridge({ id: target.tab.id, url: target.tab.url }, ctx)) {
			result = await callPeerTab(target.tab.id as number, peerReq, timeoutMs);
		}
	}
	return result;
}

/** 定位 AI 动作的目标标签页（授权表 + 权限 + 开着没，三个条件一个不能少）。 */
async function resolveAiTarget(
	ctx: BridgeContext,
	to: string | undefined,
): Promise<{ ok: true; tab: chrome.tabs.Tab } | { ok: false; result: PeerCallResult }> {
	const route = decideAiRoute(ctx.aiPages, to);
	if (!route.ok) return { ok: false, result: { ok: false, code: route.code, error: route.message } };
	const pattern = originPattern(route.peer);
	if (!(await hasOriginPermission(pattern))) {
		return {
			ok: false,
			result: {
				ok: false,
				error: getMessage(
					"ai_noPermission",
					[pattern],
					`还没授权 ${pattern} —— 到扩展选项页「AI 操作页面」里授权该地址`,
				),
			},
		};
	}
	let tabs: chrome.tabs.Tab[] = [];
	try {
		tabs = await chrome.tabs.query({ url: [pattern] });
	} catch {
		tabs = [];
	}
	const tab = tabs.find((t) => t.id != null && normalizeOrigin(t.url) === route.peer);
	if (!tab?.id) {
		return {
			ok: false,
			result: {
				ok: false,
				code: "no-peer",
				error: getMessage(
					"ai_pageNotOpen",
					[route.peer],
					`页面（${route.peer}）没打开 —— 先把它开在一个标签页里`,
				),
			},
		};
	}
	return { ok: true, tab };
}

/** 截图的默认/上限长边（图片要经 WS 送给服务端，体积不能失控）。 */
const SHOT_DEFAULT_EDGE = 1280;
const SHOT_MAX_EDGE = 1568;
/**
 * 两个「质量」不是一回事，别混：
 * - `captureVisibleTab` 的 quality 是 **0-100 的整数**（真 Chrome 会校验类型，传 0.72 直接报错
 *   `expected integer, found number` —— 这个坑是装真扩展的 E2E 抓到的）；
 * - `canvas.convertToBlob` 的 quality 是 **0-1 的小数**。
 */
const SHOT_CAPTURE_QUALITY = 72;
const SHOT_ENCODE_QUALITY = 0.72;
/** 切到目标标签页后等它重绘（太快截到的是上一页/半张图）。 */
const SHOT_SETTLE_MS = 220;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 截图权限（`<all_urls>` 等价）有没有。拿不到 permissions API 的环境按「有」处理（测试替身）。 */
async function hasShotPermission(): Promise<boolean> {
	const perms = chrome.permissions;
	if (!perms?.contains) return true;
	try {
		return await perms.contains({ origins: [...SHOT_PERMISSION_ORIGINS] });
	} catch {
		return true;
	}
}

/** 整数参数归一（模型给的东西什么形状都可能有）。 */
function clampInt(v: unknown, dflt: number, min: number, max: number): number {
	const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : dflt;
	return Math.min(max, Math.max(min, n));
}

/** 整屏截图的缩放计划（没给 selector 时截整个视口）。 */
function fullPlan(w: number, h: number, maxEdge: number): CropPlan | null {
	if (!(w > 0) || !(h > 0)) return null;
	const scale = Math.min(1, maxEdge / Math.max(w, h));
	return {
		srcX: 0,
		srcY: 0,
		srcW: w,
		srcH: h,
		dstW: Math.max(1, Math.round(w * scale)),
		dstH: Math.max(1, Math.round(h * scale)),
	};
}

/** 裁剪 + 缩放 + 编码成 JPEG data URL（在 service worker 里用 OffscreenCanvas）。 */
async function encodeShot(
	dataUrl: string,
	rect: { x: number; y: number; w: number; h: number } | undefined,
	dpr: number,
	maxEdge: number,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
	} catch {
		return null;
	}
	const plan = rect
		? planCrop({ ...rect, vwPct: 0, vhPct: 0 }, { dpr, imageW: bitmap.width, imageH: bitmap.height, maxEdge })
		: fullPlan(bitmap.width, bitmap.height, maxEdge);
	if (!plan) {
		bitmap.close();
		return null;
	}
	try {
		const canvas = new OffscreenCanvas(plan.dstW, plan.dstH);
		const ctx2d = canvas.getContext("2d");
		if (!ctx2d) return null;
		ctx2d.drawImage(bitmap, plan.srcX, plan.srcY, plan.srcW, plan.srcH, 0, 0, plan.dstW, plan.dstH);
		const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: SHOT_ENCODE_QUALITY });
		const bytes = new Uint8Array(await blob.arrayBuffer());
		return { dataUrl: `data:image/jpeg;base64,${toBase64(bytes)}`, width: plan.dstW, height: plan.dstH };
	} catch {
		return null;
	} finally {
		bitmap.close();
	}
}

/**
 * 给页面截图（AI 的眼睛）。
 *
 * 为什么这么麻烦：`captureVisibleTab` **只能截当前活动标签页** —— 要截「后台那个页面」，
 * 只能先把它切到前台、截完**立刻切回**（无论成功失败都要切回：把用户的浏览器留在别的
 * 标签页上是最糟的失败方式）。用户会看到焦点跳一下，所以它是可关的开关
 * （`settings.allowShot`），关掉后模型只能靠 read 拿 DOM 文本。
 */
async function captureShot(tab: chrome.tabs.Tab, args: Record<string, unknown>): Promise<PeerCallResult> {
	const tabId = tab.id;
	if (tabId == null) {
		return {
			ok: false,
			code: "no-peer",
			error: getMessage("ai_targetNoId", undefined, "目标标签页没有 id"),
		};
	}
	if (!(await hasShotPermission())) {
		return {
			ok: false,
			code: "shot-permission",
			error: getMessage(
				"ai_shotPermissionNeeded",
				undefined,
				"截图需要额外权限（读取所有网站数据）：到扩展选项页「AI 操作页面」里打开「允许截图」并授权；不想给这个权限就保持关闭（模型只能靠 read 读 DOM）",
			),
		};
	}
	const selector = typeof args.selector === "string" ? args.selector.trim() : "";
	const maxEdge = clampInt(args.maxEdge, SHOT_DEFAULT_EDGE, 320, SHOT_MAX_EDGE);

	const metrics = await callPeerTab(tabId, { op: "metrics", args: {}, from: "", builtin: true }, 5000);
	if (!metrics.ok) return metrics;
	const dpr = Number((metrics.value as { dpr?: unknown } | undefined)?.dpr ?? 1) || 1;

	let rect: { x: number; y: number; w: number; h: number } | undefined;
	if (selector) {
		const probe = await callPeerTab(
			tabId,
			{ op: "read", args: { what: "query", selector, limit: 1 }, from: "", builtin: true },
			5000,
		);
		if (!probe.ok) return probe;
		const first = (probe.value as { items?: { rect?: { x: number; y: number; w: number; h: number } }[] } | undefined)
			?.items?.[0];
		if (!first?.rect) {
			return {
				ok: false,
				code: "op-failed",
				error: getMessage("ai_selectorNoMatch", [selector], `选择器没匹上：${selector}`),
			};
		}
		rect = first.rect;
	}

	let restoreTabId: number | undefined;
	try {
		const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
		if (active?.id != null && active.id !== tabId) restoreTabId = active.id;
	} catch {}
	const switched = restoreTabId != null;
	try {
		if (switched) {
			await chrome.tabs.update(tabId, { active: true });
			if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
			await sleep(SHOT_SETTLE_MS);
		}
		let dataUrl: string;
		try {
			dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: SHOT_CAPTURE_QUALITY });
		} catch (err) {
			return {
				ok: false,
				code: "inject-failed",
				error: getMessage(
					"ai_screenshotFailed",
					[err instanceof Error ? err.message : String(err)],
					`截不到这个页面：${err instanceof Error ? err.message : String(err)}`,
				),
			};
		}
		const encoded = await encodeShot(dataUrl, rect, dpr, maxEdge);
		if (!encoded) {
			return {
				ok: false,
				code: "op-failed",
				error: selector
					? getMessage("ai_elementNotInViewport", [selector], `元素几乎不在视口里，截出来是碎图：${selector}`)
					: getMessage("ai_screenshotFailedEmpty", undefined, "截图失败（页面没有可截内容）"),
			};
		}
		return {
			ok: true,
			value: {
				image: { dataUrl: encoded.dataUrl, mimeType: "image/jpeg", width: encoded.width, height: encoded.height },
				...(selector ? { selector } : {}),
				...(rect ? { rect } : {}),
				viewport: { dpr },
			},
		};
	} finally {
		if (switched && restoreTabId != null) {
			try {
				await chrome.tabs.update(restoreTabId, { active: true });
			} catch {}
		}
	}
}

/**
 * 消息路由（导出以便单测直接用假 chrome 驱动）。
 * @returns true = 会异步 respond（Chrome 要求回调返回 true 才保持通道）
 */
export function handleMessage(
	raw: unknown,
	sender: chrome.runtime.MessageSender,
	respond: (response?: unknown) => void,
): boolean | undefined {
	const msg = (raw ?? {}) as {
		type?: string;
		payload?: PickPayload;
		url?: string;
		detail?: unknown;
		sections?: unknown;
		/** 配对表变更时带上的「不再配对的 origin」（worker 得把那些页面的桥卸了）。 */
		removedOrigins?: unknown;
	};
	if (msg.type === "page-picker:settings") {
		// serverUrl 不是秘密（和 token 不同），绑定浮条要拿它对比「本页是不是就是已绑定的那个」；
		// detail + sections 是拾取器要的「采多深 + 采哪几类」
		void loadSettings().then((s) => respond({ detail: s.detail, sections: s.sections, serverUrl: s.serverUrl }));
		return true;
	}
	if (msg.type === "page-picker:page-state") {
		// 内容脚本问「本页授权给 AI 操作了吗」：底部常驻细条靠它决定显示「未授权」还是「已授权」。
		// 只读、不改任何状态，也不受总开关限制（用户得先看得见现状才知道该去哪儿开）。
		// 地址优先用内容脚本报上来的 location.href（activeTab 只在点图标那一刻有效，靠 sender.tab 会时灵时不灵）。
		void (async () => {
			const url = typeof msg.url === "string" && msg.url ? msg.url : (sender.tab?.url ?? "");
			const origin = normalizeOrigin(url) ?? "";
			const [pages, settings] = await Promise.all([loadAiPages(), loadSettings()]);
			const page = pages.find((item) => item.origin === origin);
			respond({
				origin,
				authorized: Boolean(page),
				...(page?.title ? { title: page.title } : {}),
				aiControl: settings.aiControl,
			});
		})();
		return true;
	}
	if (msg.type === "page-picker:set-sections") {
		// 拾取浮条上直接改了预设 / 勾选项（不用再去选项页）→ 写回同一份设置。
		// 只写 detail + sections 两个键（patch 式）：serverUrl / token 这些不在这次改动范围内，
		// 并发改设置的两个页面也不该互相覆盖。
		void (async () => {
			try {
				const current = await loadSettings();
				const next = normalizeSettings({
					...current,
					...(msg.detail === undefined ? {} : { detail: msg.detail }),
					...(msg.sections === undefined ? {} : { sections: msg.sections }),
				});
				await chrome.storage.sync.set({ detail: next.detail, sections: next.sections });
				// 把归一后的结果回给浮条：它照着回显，就不会出现「显示的和会生效的不一样」
				respond({ ok: true, detail: next.detail, sections: next.sections });
			} catch (err) {
				respond({
					ok: false,
					message: getMessage(
						"bind_saveFailed",
						[err instanceof Error ? err.message : String(err)],
						`保存失败：${err instanceof Error ? err.message : String(err)}`,
					),
				});
			}
		})();
		return true;
	}
	if (msg.type === "page-picker:bind") {
		void (async () => {
			const url = typeof msg.url === "string" && msg.url ? msg.url : (sender.tab?.url ?? "");
			try {
				respond(await bindServer(url));
			} catch (err) {
				respond({
					ok: false,
					base: "",
					message: getMessage(
						"bridge_bindFailed",
						[err instanceof Error ? err.message : String(err)],
						`绑定失败：${err instanceof Error ? err.message : String(err)}`,
					),
				});
			}
		})();
		return true;
	}
	if (msg.type === "page-picker:open-options") {
		void openOptionsFor(typeof msg.url === "string" ? msg.url : "");
		respond({ ok: true });
		return true;
	}
	if (msg.type === "page-picker:pick-anyway") {
		// 绑定浮条上的「仍然在本页拾取」：内容脚本自己收掉浮条，这里补注入拾取器
		void startPicking(sender.tab);
		respond({ ok: true });
		return true;
	}
	if (msg.type === "page-picker:picked") {
		void (async () => {
			const settings = await loadSettings();
			const original = msg.payload;
			if (!original?.elements?.length) {
				respond({ ok: false, message: getMessage("deliver_noElements", undefined, "没有可发送的元素") });
				return;
			}
			const payload = await attachShots(original, settings, sender.tab).catch(() => original);
			const markdown = toPrompt(payload);
			if (!markdown) {
				respond({ ok: false, message: getMessage("deliver_noElements", undefined, "没有可发送的元素") });
				return;
			}
			try {
				respond(await deliver(payload, markdown, settings));
			} catch (err) {
				respond({
					ok: false,
					copy: markdown,
					message: getMessage(
						"deliver_sendFailed",
						[err instanceof Error ? err.message : String(err)],
						`发送失败：${err instanceof Error ? err.message : String(err)}`,
					),
				});
			}
		})();
		return true; // 异步 respond
	}
	if (msg.type === "page-picker:pair-here") {
		// 拾取浮条上的「与另一页配对…」：记住本页 + 带着它打开设置页
		// （页面上的按钮给不了授权手势，所以真正的「授权并配对」只能在选项页完成）
		void (async () => {
			const url = typeof msg.url === "string" && msg.url ? msg.url : (sender.tab?.url ?? "");
			await rememberOrigin(url, sender.tab?.title);
			respond({ ok: await openOptionsForPair(url) });
		})();
		return true;
	}
	if (msg.type === "page-picker:grant-here") {
		// 拾取浮条上的「让 AI 操作本页…」：记住本页 + 带着它打开设置页的授权面板
		void (async () => {
			const url = typeof msg.url === "string" && msg.url ? msg.url : (sender.tab?.url ?? "");
			await rememberOrigin(url, sender.tab?.title);
			respond({ ok: await openOptionsForGrant(url) });
		})();
		return true;
	}
	if (msg.type === "page-picker:bridge-call") {
		// 页面 → content script → 这里（准入判定）→ 对端页面的 MAIN world
		void handleBridgeCall(raw, sender)
			.then((res) => respond(res))
			.catch((err) =>
				respond({
					ok: false,
					error: getMessage(
						"bridge_callFailed3",
						[err instanceof Error ? err.message : String(err)],
						`页面桥失败：${err instanceof Error ? err.message : String(err)}`,
					),
				}),
			);
		return true;
	}
	if (msg.type === "page-picker:pairs-changed" || msg.type === "page-picker:bridges-changed") {
		// 选项页改完配对表 / AI 授权表：装上该装的、卸掉不该留的。（两个消息走同一条路：
		// 「协调」本来就是全量重算，没必要为两种配置各写一份）
		void (async () => {
			try {
				const context = await loadBridgeContext();
				const installed = await syncBridges(context);
				const removed = Array.isArray(msg.removedOrigins) ? msg.removedOrigins : [];
				let uninstalled = 0;
				for (const origin of removed) uninstalled += await removeBridgeFromOrigin(origin);
				respond({ ok: true, installed, uninstalled });
			} catch (err) {
				respond({ ok: false, error: err instanceof Error ? err.message : String(err) });
			}
		})();
		return true;
	}
	void sender;
	return undefined;
}

// 事件接线（在单测里 import 本模块时没有 chrome 全局，所以得过一道护栏）
if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
	chrome.action?.onClicked?.addListener((tab) => {
		void handleAction(tab);
	});
	chrome.commands?.onCommand?.addListener((command, tab) => {
		if (command !== "toggle-picking") return;
		void handleAction(tab);
	});
	chrome.runtime.onMessage.addListener(handleMessage);
	// 页面导航完成 / 地址变了 → 该装桥的页面重新装上（桥活在页面的文档里，导航就没了）
	chrome.tabs?.onUpdated?.addListener((tabId, info, tab) => {
		if (!info.url && info.status !== "complete") return;
		void armBridge({ id: tabId, url: tab?.url });
	});
	// SW 启动/被唤醒：把已经开着的配对页面补齐（浏览器重启后页面还在，缺这一步桥就是哑的）
	void syncBridges();
}
