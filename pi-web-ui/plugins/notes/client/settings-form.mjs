/**
 * 设置表单（浮窗的设置覆盖层用，也是非紧凑布局那份界面的设置块）：通知开关 /
 * 语言 / 导入导出。
 *
 * 为什么单独成模块：这些开关存在浏览器 localStorage（prefs.mjs），跟「界面长什么样」
 * 无关 —— 无论从哪个入口打开设置，读写的都是同一份。
 *
 * 不做的两件事：
 *   - 不在这里存盘：读写都走 prefs.mjs（它是单源，两个界面同时开着也不会各存一份）。
 *   - 不做「重置浮窗位置」：那是浮窗自己的事，浮窗用 extra 参数把自己的按钮塞进来。
 */
import { el } from "./dom.mjs";
import { loadPrefs, savePrefs } from "./prefs.mjs";

/**
 * 建表单。返回 { el, refresh }（refresh = 语言变了以后重画文案）。
 *   t        当前文案函数
 *   data     data.mjs 的数据客户端（导入导出走它）
 *   onNotify 提示文本（导入结果等）
 *   extra    额外的节点（浮窗的「重置位置」按钮等），放在最后一行
 */
export function createSettings({ t, data, onNotify, extra = [] }) {
	const root = el("div", { class: "nt-settings" });

	const importInput = el("input", {
		type: "file",
		accept: ".json,application/json",
		style: "display:none",
		onChange: (e) => {
			const file = e.target.files?.[0];
			e.target.value = "";
			if (file) void doImport(file);
		},
	});

	function requestDesktopPermission() {
		try {
			if (typeof Notification === "undefined") return;
			if (Notification.permission === "default") void Notification.requestPermission();
			else if (Notification.permission === "denied") onNotify?.(t("settings.desktopDenied"));
		} catch {
			/* 不支持就算了 */
		}
	}

	async function doImport(file) {
		try {
			const parsed = JSON.parse(await file.text());
			const replace = confirm(t("confirm.replace"));
			const res = await data.op({ op: "store.import", store: parsed, mode: replace ? "replace" : "merge" });
			if (res?.ok === false) onNotify?.(t("import.fail", { e: res.error ?? "error" }));
			else onNotify?.(t("import.ok", { a: res?.added ?? 0, u: res?.updated ?? 0 }));
		} catch (err) {
			onNotify?.(t("import.fail", { e: err instanceof Error ? err.message : String(err) }));
		}
	}

	function render() {
		const prefs = loadPrefs();
		root.textContent = "";
		const line = (labelText, key) =>
			el(
				"label",
				{ class: "nt-checkline" },
				el("input", {
					type: "checkbox",
					checked: !!prefs[key],
					onChange: (e) => {
						savePrefs({ [key]: e.target.checked });
						if (key === "desktop" && e.target.checked) requestDesktopPermission();
					},
				}),
				el("span", { text: labelText }),
			);
		const langSel = el(
			"select",
			{
				class: "nt-select",
				onChange: (e) => savePrefs({ lang: e.target.value }),
			},
			...[
				["auto", `${t("settings.lang")} · auto`],
				["zh", "中文"],
				["en", "English"],
			].map(([value, label]) => el("option", { value, selected: prefs.lang === value, text: label })),
		);
		root.append(
			line(t("settings.toast"), "toast"),
			line(t("settings.desktop"), "desktop"),
			line(t("settings.sound"), "sound"),
			line(t("settings.autoOpen"), "autoOpen"),
			el("label", { class: "nt-checkline" }, el("span", { text: t("settings.lang") }), langSel),
			el(
				"div",
				{ class: "nt-actions" },
				el("button", {
					type: "button",
					class: "nt-btn",
					text: t("action.exportJson"),
					onClick: () => void data.download("json"),
				}),
				el("button", {
					type: "button",
					class: "nt-btn",
					text: t("action.exportMd"),
					onClick: () => void data.download("md"),
				}),
				el("button", { type: "button", class: "nt-btn", text: t("action.import"), onClick: () => importInput.click() }),
			),
			extra.length ? el("div", { class: "nt-actions" }, ...extra) : null,
			el("div", { class: "nt-hint", text: t("settings.about") }),
		);
	}

	render();
	root.append(importInput);

	return {
		el: root,
		refresh() {
			render();
		},
	};
}
