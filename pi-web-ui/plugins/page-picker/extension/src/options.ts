/// <reference path="./chrome.d.ts" />
/// <reference lib="dom" />
/**
 * 设置页（options）。
 *
 * 只有一件事值得注意：**访问非 localhost 的地址需要单独申请 host 权限**
 * （manifest 里只预置了 localhost/127.0.0.1，避免装扩展时就吓人的「读取所有网站数据」）。
 * 用户把 pi-web-ui 挂在局域网/反代域名上时，在这里点一下授权即可。
 */

import {
	DEFAULT_SETTINGS,
	normalizeServerUrl,
	normalizeSettings,
	originPattern,
	tabMatchesBase,
	type PickerSettings,
} from "./shared/settings.js";
import {
	SHOT_PERMISSION_ORIGINS,
	normalizeOrigin,
	removePair,
	upsertPair,
	type AiPage,
	type BridgePair,
} from "./shared/bridge.js";
import {
	AI_PAGES_KEY,
	PAIRS_KEY,
	grantAiPage,
	loadAiPages,
	loadPairs,
	loadRecent,
	revokeAiPage,
	savePairs,
} from "./shared/bridge-store.js";
import {
	PICK_SECTIONS,
	SECTION_INFO,
	SECTION_PRESETS,
	describeSections,
	normalizeSections,
	presetForSections,
	sectionsForDepth,
	type DetailLevel,
	type PickSection,
} from "./shared/contract.js";

const $ = <T extends HTMLElement>(id: string): T => {
	const node = document.getElementById(id);
	if (!node) throw new Error(`missing #${id}`);
	return node as T;
};

/**
 * Apply i18n translations to all elements with data-i18n / data-i18n-html / data-i18n-ph attributes.
 * Called once on page load after the DOM is ready.
 */
function applyI18n(): void {
	for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
		const key = el.dataset.i18n;
		if (key) el.textContent = chrome.i18n.getMessage(key);
	}
	for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-html]")) {
		const key = el.dataset.i18nHtml;
		if (key) el.innerHTML = chrome.i18n.getMessage(key);
	}
	for (const el of document.querySelectorAll<HTMLInputElement>("[data-i18n-ph]")) {
		const key = el.dataset.i18nPh;
		if (key) el.placeholder = chrome.i18n.getMessage(key);
	}
}

const fields = {
	serverUrl: $<HTMLInputElement>("serverUrl"),
	token: $<HTMLInputElement>("token"),
	preset: $<HTMLSelectElement>("preset"),
	copyToClipboard: $<HTMLInputElement>("copyToClipboard"),
	screenshots: $<HTMLInputElement>("screenshots"),
	focusTarget: $<HTMLInputElement>("focusTarget"),
	// AI 操作页面：总开关 + eval 开关（都是「一改就生效」的设置，走同一个 save）
	aiControl: $<HTMLInputElement>("aiControl"),
	allowEval: $<HTMLInputElement>("allowEval"),
	allowShot: $<HTMLInputElement>("allowShot"),
};

/**
 * 「发送什么」的多选控件。
 *
 * 设计：**预设 + 逐项勾选**。预设决定「采多深 + 默认勾哪些」，用户再自己增减；
 * 勾选只影响内容项，深度（文本长度/骨架深度）沿用最近一次预设 —— 这样「嫌多」时
 * 只需取消勾选，不必再关心档位。
 */
const sectionBoxes = new Map<PickSection, HTMLInputElement>();
/** 最近一次应用的预设深度（手动勾选不改它）。 */
let depth: DetailLevel = DEFAULT_SETTINGS.detail;

function buildSectionList(): void {
	const list = $("sectionList");
	fields.preset.replaceChildren(
		...SECTION_PRESETS.map((p) => {
			const opt = document.createElement("option");
			opt.value = p.id;
			opt.textContent = `${p.label} — ${p.hint}`;
			return opt;
		}),
	);
	const custom = document.createElement("option");
	custom.value = "custom";
	custom.textContent = chrome.i18n.getMessage("preset_customItem");
	fields.preset.append(custom);

	list.replaceChildren(
		...PICK_SECTIONS.map((key) => {
			const info = SECTION_INFO[key];
			const box = document.createElement("input");
			box.type = "checkbox";
			box.id = `sec-${key}`;
			box.addEventListener("change", () => {
				const picked = checkedSections();
				renderPresetSelect(picked);
				void (async () => {
					await save();
					// 提示要在「已保存」之后落笔，否则会被它覆盖掉
					if (picked.length === 0) status(chrome.i18n.getMessage("status_atLeastOne"), "warn");
				})();
			});
			sectionBoxes.set(key, box);
			const label = document.createElement("label");
			label.className = "check";
			const span = document.createElement("span");
			const b = document.createElement("b");
			b.textContent = info.label;
			const i = document.createElement("i");
			i.textContent = info.hint;
			span.append(b, i);
			label.append(box, span);
			return label;
		}),
	);
}

function checkedSections(): PickSection[] {
	return PICK_SECTIONS.filter((key) => sectionBoxes.get(key)?.checked);
}

/** 预设下拉的选中项：与某个预设一致就选它，否则「自定义」。 */
function renderPresetSelect(sections: PickSection[]): void {
	const matched = presetForSections(sections);
	fields.preset.value = matched ? matched.id : "custom";
	// 摘要文案与拾取浮条共用一份实现（describeSections）—— 两处说的必须是同一件事
	$("sectionSummary").textContent = describeSections(sections);
}

function status(text: string, kind: "ok" | "err" | "warn" | "info" = "info"): void {
	const box = $("status");
	box.textContent = text;
	box.className = `status ${kind}`;
}

function readForm(): PickerSettings {
	return normalizeSettings({
		serverUrl: fields.serverUrl.value,
		token: fields.token.value,
		detail: depth,
		sections: checkedSections(),
		copyToClipboard: fields.copyToClipboard.checked,
		screenshots: fields.screenshots.checked,
		focusTarget: fields.focusTarget.checked,
		aiControl: fields.aiControl.checked,
		allowEval: fields.allowEval.checked,
		allowShot: fields.allowShot.checked,
	});
}

function fillForm(s: PickerSettings): void {
	fields.serverUrl.value = s.serverUrl;
	fields.token.value = s.token;
	fields.copyToClipboard.checked = s.copyToClipboard;
	fields.screenshots.checked = s.screenshots;
	fields.focusTarget.checked = s.focusTarget;
	fields.aiControl.checked = s.aiControl;
	fields.allowEval.checked = s.allowEval;
	fields.allowShot.checked = s.allowShot;
	depth = s.detail;
	const effective = s.sections.length > 0 ? s.sections : sectionsForDepth(s.detail);
	for (const [key, box] of sectionBoxes) box.checked = effective.includes(key);
	renderPresetSelect(effective);
}

async function load(): Promise<void> {
	applyI18n();
	try {
		fillForm(normalizeSettings(await chrome.storage.sync.get(null)));
	} catch {
		fillForm(DEFAULT_SETTINGS);
	}
}

async function save(): Promise<void> {
	const settings = readForm();
	fields.serverUrl.value = settings.serverUrl; // 回显归一后的地址，让用户看到实际会用哪个
	await chrome.storage.sync.set({ ...settings });
	await refreshGrant();
	status(chrome.i18n.getMessage("status_saved"), "ok");
}

/** 该地址的 host 权限有没有（没有就请求；默认 localhost 已内置）。 */
async function originGranted(): Promise<boolean> {
	try {
		return await chrome.permissions.contains({ origins: [originPattern(fields.serverUrl.value)] });
	} catch {
		return false;
	}
}

/** 刷新授权状态显示（远程部署全靠这一步：没授权连「找到 pi-web-ui 页面」都做不到）。 */
async function refreshGrant(): Promise<void> {
	const pattern = originPattern(fields.serverUrl.value);
	const granted = await originGranted();
	const label = $("grantState");
	label.textContent = granted ? chrome.i18n.getMessage("status_grantGranted", [pattern]) : chrome.i18n.getMessage("status_grantNotGranted", [pattern]);
	label.className = `grant-state ${granted ? "ok" : "warn"}`;
	const button = $<HTMLButtonElement>("grant");
	button.disabled = granted;
	button.textContent = granted ? chrome.i18n.getMessage("options_grantButtonDone") : chrome.i18n.getMessage("options_grantButton");
}

async function ensureOrigin(): Promise<boolean> {
	const pattern = originPattern(fields.serverUrl.value);
	const granted = await chrome.permissions.request({ origins: [pattern] });
	await refreshGrant();
	status(granted ? chrome.i18n.getMessage("status_grantGranted", [pattern]) : chrome.i18n.getMessage("status_originNotGrantedAuthRequired", [pattern]), granted ? "ok" : "err");
	return granted;
}

async function testConnection(): Promise<void> {
	const base = normalizeServerUrl(fields.serverUrl.value);
	if (!(await originGranted())) {
		status(chrome.i18n.getMessage("status_grantNotGranted", [originPattern(base)]), "err");
		return;
	}
	status(chrome.i18n.getMessage("status_testingProbing"));
	try {
		const res = await fetch(`${base}/api/health`, { cache: "no-store" });
		if (!res.ok) {
			status(`服务端返回 HTTP ${res.status}`, "err");
			return;
		}
		const info = (await res.json()) as { cwd?: string; piVersion?: string };
		const open = await countOpenTabs(base);
		status(
			open > 0
				? chrome.i18n.getMessage("status_serverOnlineWithTabs", [info.cwd ?? "?", String(open)])
				: chrome.i18n.getMessage("status_serverOnlineNoTabs", [info.cwd ?? "?"]),
			open > 0 ? "ok" : "warn",
		);
	} catch (err) {
		status(chrome.i18n.getMessage("status_connectionFailed", [err instanceof Error ? err.message : String(err)]), "err");
	}
}

/** 浏览器里当前开着几个这个地址的 pi-web-ui 页面（投递的目标）。 */
async function countOpenTabs(base: string): Promise<number> {
	try {
		// 同 findTargetTab：只能用 origin 级 match pattern（裸 origin 会让 tabs.query 抛异常），
		// 路径前缀自己复核（否则 `https://host/pi-other` 也会被算成我们的页面）
		const tabs = await chrome.tabs.query({ url: [originPattern(base)] });
		return tabs.filter((t) => tabMatchesBase(t.url, base)).length;
	} catch {
		return 0;
	}
}

buildSectionList();
for (const [key, node] of Object.entries(fields)) {
	if (key === "preset") continue; // 预设自己处理（要连带勾选项与深度）
	if (key === "allowShot") continue; // 截图要额外权限：勾选时先申请（见 toggleShot）
	node.addEventListener("change", () => void save());
}

/**
 * 「允许截图」：勾选时先申请 `captureVisibleTab` 要求的权限（http/https 任意主机）。
 *
 * 为什么截图要这么重的权限：那个 API 只认 `<all_urls>` 或 `activeTab`，普通 host 权限不够。
 * 拾取时的元素截图能用，是因为用户刚点过扩展图标（那一刻有 activeTab）；AI 操作是模型自己
 * 发起的，没有那个手势。用户拒绝授权就**保持关闭**并说明原因 —— 绝不「勾上了但其实用不了」。
 */
async function toggleShot(on: boolean): Promise<void> {
	if (!on) {
		await save();
		status(chrome.i18n.getMessage("status_shotDisabled"), "info");
		return;
	}
	let granted = false;
	try {
		granted = await chrome.permissions.contains({ origins: [...SHOT_PERMISSION_ORIGINS] });
		if (!granted) granted = await chrome.permissions.request({ origins: [...SHOT_PERMISSION_ORIGINS] });
	} catch {
		granted = false;
	}
	if (!granted) {
		fields.allowShot.checked = false;
		status(chrome.i18n.getMessage("status_shotNeedPermission"), "err");
		return;
	}
	await save();
	status(chrome.i18n.getMessage("status_shotEnabled"), "ok");
}
fields.allowShot.addEventListener("change", () => void toggleShot(fields.allowShot.checked));
fields.preset.addEventListener("change", () => {
	const preset = SECTION_PRESETS.find((p) => p.id === fields.preset.value);
	if (!preset) return; // 「自定义」= 不动勾选（只是当前状态的名字）
	depth = preset.depth;
	for (const [key, box] of sectionBoxes) box.checked = preset.sections.includes(key);
	renderPresetSelect(preset.sections);
	void save();
});
$("grant").addEventListener("click", () => void ensureOrigin());
// 拾取浮条上也能改这两项（页面上直接切预设，不用回设置页）→ 两个写者必须互相看得见，
// 否则会出现「在页面上切了预设，回选项页随手改一下别的，预设又被旧值覆盖回去」。
chrome.storage.onChanged?.addListener((changes, area) => {
	if (area !== "sync") return;
	if (!changes.detail && !changes.sections) return;
	void load();
});
$("test").addEventListener("click", () => void testConnection());
$("reset").addEventListener("click", () => {
	fillForm({ ...DEFAULT_SETTINGS, sections: [...normalizeSections(DEFAULT_SETTINGS.sections)] });
	void save();
});

// --------------------------------------------------------------------- ?bind= 绑定面板

/**
 * `?bind=<url>`：从 pi-web-ui 页面上的绑定浮条跳过来（用户在那个页面上点了「设为服务地址」）。
 *
 * 为什么不能就地完成：`chrome.permissions.request` 必须在**用户手势**里发出，而浮条的按钮
 * 点在网页上（content script 的 UI），浏览器不认这个手势 —— 只能把用户送到扩展自己的页面，
 * 这里的点击一定带手势。所以这条路径不是多余的，是权限模型要求的。
 */
async function initBindPanel(): Promise<void> {
	const raw = new URLSearchParams(location.search).get("bind");
	if (!raw) return;
	const base = normalizeServerUrl(raw);
	const already = normalizeServerUrl(fields.serverUrl.value) === base;
	fields.serverUrl.value = base;

	const title = $("bindTitle");
	const body = $("bindBody");
	const accept = $<HTMLButtonElement>("bindAccept");
	if (already) {
		title.textContent = chrome.i18n.getMessage("status_bindAlreadyCurrent", [base]);
		body.textContent = chrome.i18n.getMessage("status_bindAlreadyCurrentBody");
		accept.classList.add("hidden");
	} else {
		const granted = await originGranted();
		title.textContent = granted ? chrome.i18n.getMessage("status_bindSetAsServer", [base]) : chrome.i18n.getMessage("status_bindDetectedPage", [base]);
		body.textContent = granted
			? chrome.i18n.getMessage("options_bindBodyGranted")
			: chrome.i18n.getMessage("options_bindBodyNotGranted", [originPattern(base)]);
		accept.textContent = granted ? chrome.i18n.getMessage("status_bindAcceptGranted") : chrome.i18n.getMessage("status_bindAcceptNotGranted");
		accept.addEventListener("click", () => void acceptBind(base));
	}
	$("bindPanel").classList.remove("hidden");
	$("bindDismiss").addEventListener("click", () => $("bindPanel").classList.add("hidden"));
}

/** 授权（如需要）+ 写入设置。失败时 ensureOrigin 已经写了原因，不要静默。 */
async function acceptBind(base: string): Promise<void> {
	if (!(await originGranted()) && !(await ensureOrigin())) return;
	await save(); // save 会回显归一后的地址，用户看得见实际会用哪个
	status(chrome.i18n.getMessage("status_bindBound", [base]), "ok");
	$("bindPanel").classList.add("hidden");
}

void load().then(async () => {
	await refreshGrant();
	await initBindPanel();
});

// ------------------------------------------------------------------ 页面桥（配对管理）

/**
 * 配对管理。
 *
 * 为什么只能在这里做（不能像绑定浮条那样在网页上问一句）：**加一对配对要申请两个 origin
 * 的 host 权限**，而 `chrome.permissions.request` 必须在用户手势里发出 —— 网页上的按钮
 * 给不了这个手势。选项页的点击一定带手势，所以这里才是「授权 + 配对」能完成的地方。
 */
let pairs: BridgePair[] = [];
const pairFields = {
	a: $<HTMLInputElement>("pairA"),
	b: $<HTMLInputElement>("pairB"),
	note: $<HTMLInputElement>("pairNote"),
};

function pairStatus(text: string, kind: "ok" | "err" | "warn" | "info" = "info"): void {
	const box = $("pairStatus");
	box.textContent = text;
	box.className = `status ${kind}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text !== undefined) node.textContent = text;
	return node;
}

function renderPairs(): void {
	const list = $("pairList");
	if (pairs.length === 0) {
		list.replaceChildren(el("div", "empty", chrome.i18n.getMessage("options_pairEmpty")));
		return;
	}
	list.replaceChildren(...pairs.map(renderPair));
}

function renderPair(pair: BridgePair): HTMLElement {
	const card = el("div", `pair${pair.enabled ? "" : " off"}`);
	card.append(el("div", "who", `${pair.a} ↔ ${pair.b}`));
	const meta = el("div", "meta", pair.note ? `${pair.note} · ${chrome.i18n.getMessage("options_pairPermissionChecking")}` : chrome.i18n.getMessage("options_pairPermissionChecking"));
	card.append(meta);

	const toggle = el("input");
	toggle.type = "checkbox";
	toggle.checked = pair.enabled;
	toggle.addEventListener("change", () => void setPairEnabled(pair, toggle.checked));
	const toggleLabel = el("label", "check");
	toggleLabel.append(toggle, el("span", undefined, pair.enabled ? chrome.i18n.getMessage("options_pairEnabled") : chrome.i18n.getMessage("options_pairDisabled")));

	const drop = el("button", undefined, chrome.i18n.getMessage("options_pairDelete"));
	drop.addEventListener("click", () => void dropPair(pair));

	const actions = el("div", "actions");
	actions.append(toggleLabel, drop);
	card.append(actions);

	void showPairPermission(meta, pair);
	return card;
}

/** 两端授权状态（缺哪端就说哪端 —— 「配对在、但调不过去」十有八九是这里）。 */
async function showPairPermission(meta: HTMLElement, pair: BridgePair): Promise<void> {
	const patterns = [originPattern(pair.a), originPattern(pair.b)];
	const missing: string[] = [];
	for (const pattern of patterns) {
		let granted = true;
		try {
			granted = await chrome.permissions.contains({ origins: [pattern] });
		} catch {
			granted = true; // 没有 permissions API 的环境不阻断
		}
		if (!granted) missing.push(pattern);
	}
	const head = pair.note ? `${pair.note} · ` : "";
	meta.textContent = missing.length === 0
		? `${head}${chrome.i18n.getMessage("options_pairBothGranted")}`
		: `${head}${chrome.i18n.getMessage("options_pairMissingGrant", [missing.join(chrome.i18n.getMessage("ai_opSeparator"))])}`;
}

async function notifyPairsChanged(
	removedOrigins: string[] = [],
): Promise<{ installed?: number; uninstalled?: number } | undefined> {
	try {
		// 一个消息名同时服务「配对变更」与「AI 授权变更」：worker 那边本来就是全量重算
		return (await chrome.runtime.sendMessage({ type: "page-picker:bridges-changed", removedOrigins })) as
			{ installed?: number; uninstalled?: number } | undefined;
	} catch {
		return undefined; // worker 不在线：下次它启动时会自己 syncBridges 补齐
	}
}

async function addPair(): Promise<void> {
	const merged = upsertPair(pairs, pairFields.a.value, pairFields.b.value, {
		note: pairFields.note.value,
		now: new Date().toISOString(),
	});
	if (merged.error || !merged.pair) {
		pairStatus(merged.error ?? chrome.i18n.getMessage("status_pairInvalid"), "err");
		return;
	}
	const pair = merged.pair;
	const patterns = [originPattern(pair.a), originPattern(pair.b)];
	let granted = false;
	try {
		granted = await chrome.permissions.request({ origins: patterns });
	} catch {
		granted = false;
	}
	if (!granted) {
		pairStatus(chrome.i18n.getMessage("status_pairNotGranted", [patterns.join(chrome.i18n.getMessage("ai_opSeparator"))]), "err");
		return;
	}
	pairs = merged.pairs;
	await savePairs(pairs);
	pairFields.note.value = "";
	renderPairs();
	const res = await notifyPairsChanged();
	pairStatus(
		res?.installed
			? chrome.i18n.getMessage("status_pairAddedWithInstall", [pair.a, pair.b, String(res.installed)])
			: chrome.i18n.getMessage("status_pairAddedAuto", [pair.a, pair.b]),
		"ok",
	);
	await refreshOriginOptions();
}

async function setPairEnabled(pair: BridgePair, enabled: boolean): Promise<void> {
	pairs = pairs.map((p) => (p.id === pair.id ? { ...p, enabled } : p));
	await savePairs(pairs);
	renderPairs();
	const res = await notifyPairsChanged(enabled ? [] : [pair.a, pair.b]);
	pairStatus(
		enabled
			? res?.installed
				? chrome.i18n.getMessage("status_pairEnabledWithInstall", [String(res.installed)])
				: chrome.i18n.getMessage("status_pairEnabledAuto")
			: chrome.i18n.getMessage("status_pairDisabled"),
		"ok",
	);
}

async function dropPair(pair: BridgePair): Promise<void> {
	pairs = removePair(pairs, pair.id);
	await savePairs(pairs);
	renderPairs();
	const res = await notifyPairsChanged([pair.a, pair.b]);
	pairStatus(res?.uninstalled ? chrome.i18n.getMessage("status_pairDeletedWithUninstall", [String(res.uninstalled)]) : chrome.i18n.getMessage("status_pairDeleted"), "ok");
}

/** 配对候选：最近点过扩展图标的页面（带标题）+ 已配对过的 origin（它们不一定在最近列表里）。 */
async function refreshOriginOptions(): Promise<void> {
	const known = new Map<string, string>();
	for (const item of await loadRecent()) known.set(item.origin, item.title ?? item.origin);
	for (const pair of pairs) {
		if (!known.has(pair.a)) known.set(pair.a, chrome.i18n.getMessage("options_pairCandidatePaired", [pair.a]));
		if (!known.has(pair.b)) known.set(pair.b, chrome.i18n.getMessage("options_pairCandidatePaired", [pair.b]));
	}
	const list = $("piOrigins");
	list.replaceChildren(
		...[...known.entries()].map(([origin, label]) => {
			const opt = document.createElement("option");
			opt.value = origin;
			// Chrome 的 datalist 显示 value + label（textContent 只参与搜索匹配），两个都放上
			opt.label = label;
			opt.textContent = label;
			return opt;
		}),
	);
}

/**
 * `?pair=<url>`：从开发页的拾取浮条「与另一页配对…」跳过来（本页已自动记成候选并预填）。
 *
 * 用户在这里只需选另一个端点 + 点一下「授权并添加配对」—— 对比手打两个 origin，少掉的是
 * 「去另一个标签页看一眼地址、再切回来小心拄写」这一段真正的麻烦。
 */
async function initPairDeepLink(): Promise<void> {
	const raw = new URLSearchParams(location.search).get("pair");
	if (!raw) return;
	const origin = normalizeOrigin(raw);
	if (!origin) return;
	pairFields.a.value = origin;
	pairStatus(chrome.i18n.getMessage("status_pairDeepLinkFilled", [origin]), "info");
	pairFields.b.focus();
}

async function initBridgePanel(): Promise<void> {
	pairs = await loadPairs();
	renderPairs();
	$("pairAdd").addEventListener("click", () => void addPair());
	// 别的页面（或另一个选项页标签）改了配对表 → 这边跟着刷新
	chrome.storage.onChanged?.addListener((changes, area) => {
		if (area !== "local" || !changes[PAIRS_KEY]) return;
		void (async () => {
			pairs = await loadPairs();
			renderPairs();
		})();
	});
	await refreshOriginOptions();
	await initPairDeepLink();
}

void initBridgePanel();

// -------------------------------------------------------------- AI 操作页面（授权管理）

/**
 * 「给模型一个能读写网页的工具」的授权管理。
 *
 * 与页面桥的区别：那个是两个网页互调、得配两端；这里**另一端固定是 pi-web-ui 页面**
 * （模型的动作从那个页面送进扩展），所以只需授权被操作的那个页面。
 * 授权动作必须在选项页完成 —— host 权限要用户手势，网页面上的按钮给不了。
 */
let aiPages: AiPage[] = [];

function aiStatus(text: string, kind: "ok" | "err" | "warn" | "info" = "info"): void {
	const box = $("aiStatus");
	box.textContent = text;
	box.className = `status ${kind}`;
}

function renderAiPages(): void {
	const list = $("aiList");
	if (aiPages.length === 0) {
		list.replaceChildren(el("div", "empty", chrome.i18n.getMessage("options_aiEmpty")));
		return;
	}
	list.replaceChildren(
		...aiPages.map((page) => {
			const named = Boolean(page.title) && page.title !== page.origin;
			const card = el("div", "pair");
			card.append(el("div", "who", named ? (page.title as string) : page.origin));
			if (named) card.append(el("div", "meta", page.origin));
			const actions = el("div", "actions");
			const drop = el("button", undefined, chrome.i18n.getMessage("options_aiRevoke"));
			drop.addEventListener("click", () => void revokePage(page));
			actions.append(drop);
			card.append(actions);
			return card;
		}),
	);
}

async function grantPage(): Promise<void> {
	const origin = normalizeOrigin($<HTMLInputElement>("aiPageInput").value);
	if (!origin) {
		aiStatus(chrome.i18n.getMessage("status_aiInvalidAddress"), "err");
		return;
	}
	const pattern = originPattern(origin);
	let granted = false;
	try {
		granted = await chrome.permissions.request({ origins: [pattern] });
	} catch {
		granted = false;
	}
	if (!granted) {
		aiStatus(chrome.i18n.getMessage("status_aiNotGranted", [pattern]), "err");
		return;
	}
	const recent = await loadRecent();
	aiPages = await grantAiPage(origin, recent.find((item) => item.origin === origin)?.title);
	$<HTMLInputElement>("aiPageInput").value = "";
	renderAiPages();
	const res = await notifyPairsChanged();
	aiStatus(
		res?.installed
			? chrome.i18n.getMessage("status_aiGrantedWithInstall", [origin, String(res.installed)])
			: chrome.i18n.getMessage("status_aiGrantedAuto", [origin]),
		"ok",
	);
	await refreshOriginOptions();
}

async function revokePage(page: AiPage): Promise<void> {
	aiPages = await revokeAiPage(page.origin);
	renderAiPages();
	await notifyPairsChanged([page.origin]);
	aiStatus(chrome.i18n.getMessage("status_aiRevoked", [page.origin]), "ok");
}

/** `?grant=<url>`：从开发页的拾取浮条「让 AI 操作本页…」跳过来（已预填本页）。 */
async function initGrantDeepLink(): Promise<void> {
	const raw = new URLSearchParams(location.search).get("grant");
	if (!raw) return;
	const origin = normalizeOrigin(raw);
	if (!origin) return;
	$<HTMLInputElement>("aiPageInput").value = origin;
	aiStatus(chrome.i18n.getMessage("status_aiDeepLinkFilled", [origin]), "info");
	$<HTMLButtonElement>("aiGrant").focus();
}

async function initAiPanel(): Promise<void> {
	aiPages = await loadAiPages();
	renderAiPages();
	$("aiGrant").addEventListener("click", () => void grantPage());
	// 别的选项页标签改了授权表 → 这边跟着刷新
	chrome.storage.onChanged?.addListener((changes, area) => {
		if (area !== "local" || !changes[AI_PAGES_KEY]) return;
		void (async () => {
			aiPages = await loadAiPages();
			renderAiPages();
		})();
	});
}

void initAiPanel().then(initGrantDeepLink);
