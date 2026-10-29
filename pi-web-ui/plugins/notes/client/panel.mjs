/**
 * 全局可拖拽浮窗（置顶小窗）—— 用户要的「点开是个能自由拖拽位置的全局弹窗」。
 *
 * 它不走宿主 slot（slot 只管声明式条目），而是自己往 `document.body` 挂一个
 * `position:fixed` 的节点：
 *   - 与宿主同源，bundle 本身就能碰 DOM；声明 `dom:anchor` 表明「只往宿主锚点范围里挂
 *     自己的一块界面」，因此**不需要用户单独授权 DOM**（声明完整 `dom` 才会 403 + 要授权）。
 *   - 位置/尺寸/开合/最小化状态存 localStorage，刷新后原样恢复；拖动时实时钳制在视口内
 *     （换窗口大小、投到别的显示器也不会跑到屏幕外）。
 *   - z-index 350：盖住内容与拖放遮罩（300），但**低于**宿主弹窗（400，设置/后台任务）——
 *     置顶不等于压住用户正在操作的对话框。
 *
 * 浮窗内嵌的是 app.mjs 那份**紧凑布局**（compact=true），与设置表单共用同一套数据客户端。
 *
 * 结构：`head`（可拖拽标题栏）+ `nt-panel-main`（正文 + 设置覆盖层）+ `grip`（右下缩放角）。
 * 设置是**盖在正文之上的覆盖层**（不是挤在底部的第三块）：打开时正文不缩水，关掉就
 * 回到原来的 tab 与滚动位置。
 */
import { createNotesApp } from "./app.mjs";
import { el } from "./dom.mjs";
import { createSettings } from "./settings-form.mjs";
import * as S from "./store.mjs";

const POS_KEY = "notes:panel";
const MIN_W = 260;
const MIN_H = 200;

/** 与顶栏入口同一枚图钉图标（manifest 里的 iconSvg 是同一个形状）—— 按钮和它打开
 *  的浮窗长得一样，别一个 emoji 一个矢量。 */
const NOTE_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 6h10"/><path d="M6 10h10"/><path d="M6 14h6"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/></svg>';

function readPos() {
	try {
		const raw = JSON.parse(localStorage.getItem(POS_KEY) ?? "{}");
		if (raw && typeof raw === "object") return raw;
	} catch {
		/* ignore */
	}
	return {};
}

function writePos(patch) {
	try {
		localStorage.setItem(POS_KEY, JSON.stringify({ ...readPos(), ...patch }));
	} catch {
		/* ignore */
	}
}

/**
 * 建浮窗。返回 { toggle, show, hide, minimize, isOpen, destroy, app }。
 *   t        当前语言下的文案函数（语言切换时 entry.mjs 会调 refreshLabels）
 *   data     data.mjs 的共享客户端
 *   onNotify    提示文本（导入结果等）
 */
export function createPanel(options) {
	const { data, onNotify } = options;
	let t = options.t;
	const saved = readPos();
	const state = {
		open: saved.open === true, // 缺省收起（不请自来地弹窗会扰人）；点顶栏 📌 或快捷键打开，之后记住状态
		min: saved.min === true,
		x: Number.isFinite(saved.x) ? saved.x : Math.max(16, window.innerWidth - 376),
		y: Number.isFinite(saved.y) ? saved.y : 64,
		w: Number.isFinite(saved.w) ? saved.w : 360,
		h: Number.isFinite(saved.h) ? saved.h : 440,
	};

	const title = el("span", { class: "nt-panel-title" });
	const pillCount = el("span", { class: "nt-pill-count nt-zero" });
	const pillLabel = el("span", { class: "nt-pill-label" });
	const icon = el("span", { class: "nt-head-icon" });
	try {
		icon.innerHTML = NOTE_SVG;
	} catch {
		icon.textContent = "📓";
	}
	const head = el(
		"div",
		{ class: "nt-panel-head" },
		icon,
		title,
		pillCount,
		pillLabel,
		el("span", { class: "nt-grow" }),
	);

	// ⚙ 开设置、▾ 收起为小贴片、✕ 关浮窗 —— 只有三个（曾经的 ⤢「打开完整视图」随独立
	// 视图一起删掉了：本插件不再有 tab 页，浮窗就是它的全部界面）。
	const settingsBtn = el("button", { type: "button", class: "nt-btn nt-icon nt-pill-hide", text: "⚙" });
	const minBtn = el("button", { type: "button", class: "nt-btn nt-icon", text: "▾" });
	const closeBtn = el("button", { type: "button", class: "nt-btn nt-icon nt-pill-hide", text: "✕" });
	head.append(settingsBtn, minBtn, closeBtn);

	const appHost = el("div", { class: "nt-panel-body" });
	const grip = el("div", { class: "nt-grip", title: "resize" });
	// 设置覆盖层：盖在正文之上（absolute inset:0），自己带标题栏与关闭按钮、自己滚。
	// 放在 `nt-panel-main` 里而不是 panel 根上：这样它的定位基准就是正文区（不用
	// 拿头栏高度去算 top），也不会被 `ensureApp()` 清 appHost 时误删。
	const settingsTitle = el("span", { class: "nt-settings-title", text: t("action.settings") });
	const settingsClose = el("button", { type: "button", class: "nt-btn nt-icon", text: "✕" });
	const settingsPop = el(
		"div",
		{ class: "nt-settings-pop" },
		el("div", { class: "nt-settings-head" }, settingsTitle, el("span", { class: "nt-grow" }), settingsClose),
	);
	const main = el("div", { class: "nt-panel-main" }, appHost, settingsPop);
	const root = el("div", { class: "nt-panel nt-root" }, head, main, grip);
	// 挂在宿主给的 `app` 锚点里（manifest 声明的是 dom:anchor = **只动锚点范围里的 DOM**，
	// 免用户授权；挂 document.body 属于整页范围，该走 dom + 授权，声明就对不上了）。
	// 锚点不可用（老宿主/桥未就绪）才退回 body。position:fixed 在锚点内仍是视口坐标
	// （`.app` 上没有 transform/filter，不会变成它的相对坐标）。
	appendToAnchor();

	let app = null;
	let settingsOpen = false;

	/** 把浮窗放进宿主锚点（缺锚点退回 body）。 */
	function appendToAnchor() {
		let anchor = null;
		try {
			anchor = globalThis.window?.__piWebUiHost?.dom?.anchors?.()?.app ?? null;
		} catch {
			anchor = null;
		}
		(anchor ?? document.body).append(root);
	}

	// ---------------------------------------------------------------- 位置/尺寸
	function apply() {
		const w = Math.min(Math.max(MIN_W, state.w), Math.max(MIN_W, window.innerWidth - 16));
		const h = Math.min(Math.max(MIN_H, state.h), Math.max(MIN_H, window.innerHeight - 16));
		state.x = Math.min(Math.max(8, state.x), Math.max(8, window.innerWidth - w - 8));
		state.y = Math.min(Math.max(8, state.y), Math.max(8, window.innerHeight - 40));
		if (state.min) {
			// 最小化：尺寸交给内容（否则 pill 的 border-radius:999px 会把大盒子的四角裁掉，
			// 右上角的按钮落在圆角外 → 真的点不到，Chrome 对 overflow:hidden + 圆角做命中裁剪）
			root.style.width = "";
			root.style.height = "";
		} else {
			root.style.width = `${Math.round(w)}px`;
			root.style.height = `${Math.round(h)}px`;
		}
		root.style.left = `${Math.round(state.x)}px`;
		root.style.top = `${Math.round(state.y)}px`;
		root.style.display = state.open ? "" : "none";
		root.classList.toggle("nt-pill", state.min);
		root.classList.toggle("nt-open", state.open);
		minBtn.textContent = state.min ? "▸" : "▾";
		minBtn.title = state.min ? t("action.restore") : t("action.minimize");
		closeBtn.title = t("action.close");
		settingsBtn.title = t("action.settings");
		settingsTitle.textContent = t("action.settings");
		title.textContent = t("app.title");
	}

	function persist() {
		writePos({ open: state.open, min: state.min, x: state.x, y: state.y, w: state.w, h: state.h });
	}

	// 拖动（头部）与缩放（右下角）：pointer 事件统一处理，触摸屏也能拖
	let drag = null;
	head.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		if (e.target.closest("button,input,select,textarea,a")) return;
		drag = { mode: "move", dx: e.clientX - state.x, dy: e.clientY - state.y, id: e.pointerId };
		root.classList.add("nt-dragging");
		e.preventDefault();
	});
	grip.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		drag = { mode: "resize", w0: state.w, h0: state.h, x0: e.clientX, y0: e.clientY, id: e.pointerId };
		e.preventDefault();
	});
	window.addEventListener("pointermove", onPointerMove);
	window.addEventListener("pointerup", onPointerUp);
	window.addEventListener("pointercancel", onPointerUp);
	window.addEventListener("resize", apply);

	function onPointerMove(e) {
		if (!drag || e.pointerId !== drag.id) return;
		if (drag.mode === "move") {
			state.x = e.clientX - drag.dx;
			state.y = e.clientY - drag.dy;
		} else {
			state.w = Math.max(MIN_W, drag.w0 + (e.clientX - drag.x0));
			state.h = Math.max(MIN_H, drag.h0 + (e.clientY - drag.y0));
		}
		apply();
	}

	function onPointerUp(e) {
		if (!drag || e.pointerId !== drag.id) return;
		drag = null;
		root.classList.remove("nt-dragging");
		persist();
	}

	// ---------------------------------------------------------------- 开合
	function ensureApp() {
		if (!app) {
			appHost.textContent = "";
			app = createNotesApp({ root: appHost, data, t, compact: true });
		}
		return app;
	}

	function show(focusQuick = false) {
		state.open = true;
		state.min = false;
		ensureApp();
		apply();
		persist();
		void data.refresh();
		if (focusQuick) app?.focusQuickInput();
	}

	function hide() {
		state.open = false;
		apply();
		persist();
	}

	function minimize() {
		state.min = true;
		apply();
		persist();
	}

	settingsBtn.addEventListener("click", () => {
		settingsOpen = !settingsOpen;
		renderSettings();
	});
	settingsClose.addEventListener("click", () => {
		settingsOpen = false;
		renderSettings();
	});
	minBtn.addEventListener("click", () => {
		if (state.min) show();
		else minimize();
	});
	closeBtn.addEventListener("click", hide);

	// ---------------------------------------------------------------- 角标（最小化时的计数）
	const unsubscribe = data.subscribe((snap) => {
		const counts = S.counts(snap.store);
		pillCount.textContent = String(counts.attention);
		pillCount.classList.toggle("nt-zero", counts.attention === 0);
		pillLabel.textContent = counts.attention ? "" : t("app.title");
	});

	// ---------------------------------------------------------------- 设置（覆盖层）
	// 与设置表单共用同一份字段（settings-form.mjs）；这里多一个「重置浮窗位置」，
	// 并把它包进一个盖住正文的层：打开设置不会把当前 tab 压成一条缝。
	const settingsBox = createSettings({
		t,
		data,
		onNotify: (text) => onNotify?.(text),
		extra: [
			el("button", {
				type: "button",
				class: "nt-btn",
				text: t("settings.position"),
				onClick: () => {
					state.x = Math.max(16, window.innerWidth - 376);
					state.y = 64;
					state.w = 360;
					state.h = 440;
					apply();
					persist();
				},
			}),
		],
	});
	settingsPop.append(settingsBox.el);

	function renderSettings() {
		settingsPop.classList.toggle("on", settingsOpen);
		settingsBtn.classList.toggle("on", settingsOpen);
		if (settingsOpen) settingsBox.refresh();
	}

	// 首次运行时若默认开着桌面通知，不主动弹权限框（避免一装插件就来个系统弹窗），
	// 由用户在设置里点「桌面通知」时再请求。

	if (state.open) ensureApp();
	apply();

	return {
		toggle() {
			if (state.open && !state.min) hide();
			else show();
		},
		show: () => show(true),
		hide,
		minimize,
		isOpen: () => state.open && !state.min,
		/** 语言切换后刷新文案（app 实例重建，编辑器状态不保 —— 切语言是低频动作）。 */
		refreshLabels(nextT) {
			t = nextT;
			if (app) {
				app.destroy();
				app = null;
			}
			if (state.open) ensureApp();
			settingsBox.refresh();
			apply();
		},
		destroy() {
			unsubscribe();
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onPointerUp);
			window.removeEventListener("resize", apply);
			app?.destroy();
			app = null;
			root.remove();
		},
	};
}
