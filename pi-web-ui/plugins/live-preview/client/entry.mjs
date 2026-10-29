/**
 * live-preview 客户端 —— 无独立视图（manifest view:false），只接右键菜单动作。
 *
 * 宿主在第一次点菜单时按需加载本 bundle（见 App 的 triggerPluginUiAction），
 * 模块顶层 register() 即完成接管；mount 是空挂载（loader 要求 default.mount
 * 为函数，否则记 failed）。
 *
 * 动作回调签名 (itemId, value, target)：target = { id: wire 路径, kind, label }，
 * kind 取值 file（文件行）/ dir（文件夹行）/ list（列表空白处，id 即当前目录）。
 * 点击后直接 window.open 新标签（同源，鉴权靠 cookie）。
 */

const OPEN = "live-preview:open";
const OPEN_MD = "live-preview:open-md";

/** 应用根（含 nginx 子路径前缀），由本 bundle URL 推导。 */
function appRoot() {
	try {
		const u = new URL(import.meta.url);
		const i = u.pathname.indexOf("/plugins/");
		return `${u.origin}${i >= 0 ? u.pathname.slice(0, i) : ""}`;
	} catch {
		return "";
	}
}

/** wire 路径逐段编码（.. 一律丢弃，防穿越）。 */
function encPath(p) {
	return String(p ?? "")
		.split("/")
		.filter((s) => s && s !== "." && s !== "..")
		.map(encodeURIComponent)
		.join("/");
}

function parentDir(wire) {
	const segs = encPath(wire).split("/").filter(Boolean);
	segs.pop();
	return segs.join("/");
}

function hostApi() {
	try {
		return window.__piWebUiHost ?? null;
	} catch {
		return null;
	}
}

function openTab(prefix, rel, isDir) {
	let url = `${appRoot()}${prefix}/`;
	if (rel) url += `${encPath(rel)}${isDir ? "/" : ""}`;
	try {
		window.open(url, "_blank", "noopener");
	} catch {
		/* 弹窗被拦则忽略 */
	}
}

/** 🌐 Live Server 打开：文件夹→该目录；文件/空白→当前目录（文件取其所在目录）。 */
function onOpen(_itemId, _value, target) {
	const kind = String(target?.kind ?? "list");
	const id = String(target?.id ?? "");
	if (kind === "dir" && id) openTab("/liveserver", id, true);
	else if (kind === "file" && id) openTab("/liveserver", parentDir(id), true);
	else openTab("/liveserver", id, true);
}

/** 📝 预览 Markdown：md 文件走 /md；其它回落 Live Server（与 onOpen 同口径）。 */
function onOpenMd(_itemId, _value, target) {
	const kind = String(target?.kind ?? "list");
	const id = String(target?.id ?? "");
	if (kind === "file" && /\.md$/i.test(id)) {
		openTab("/md", id, false);
		return;
	}
	onOpen(_itemId, _value, target);
}

function register() {
	try {
		const api = hostApi();
		api?.onUiAction?.(OPEN, onOpen);
		api?.onUiAction?.(OPEN_MD, onOpenMd);
	} catch {
		/* 宿主太旧：菜单点了没反应总比崩好（manifest apiVersion 会先拦住旧版） */
	}
}

register();

export default {
	mount() {
		register();
		return () => {};
	},
};
