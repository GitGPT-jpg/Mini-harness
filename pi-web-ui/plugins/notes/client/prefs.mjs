/**
 * 浮窗/通知相关的**浏览器本地偏好**（localStorage，按浏览器存）。
 *
 * 为什么不做服务端设置（manifest "settings"）：这些全是「这台设备上的这个浏览器」的
 * 行为（浮窗位置、要不要桌面通知、提示音），存服务端反而错 —— 手机不该被桌面的提示音
 * 设置影响。真正的库数据（笔记/待办/提醒）才在服务端。
 */
const KEY = "notes:prefs";

const DEFAULTS = {
	/** 站内通知条（宿主通知条，点了能直接打开浮窗）。 */
	toast: true,
	/** 桌面通知（浏览器 Notification，页面在后台/别的标签页时用）。 */
	desktop: true,
	/** 提示音（WebAudio 一声短音）。 */
	sound: false,
	/** 提醒到点自动展开浮窗。 */
	autoOpen: true,
	/** 语言：auto = 跟随主应用（document.lang），否则 zh / en。 */
	lang: "auto",
};

let cache = null;
const listeners = new Set();

function read() {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
		return { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
	} catch {
		return { ...DEFAULTS };
	}
}

/** 当前偏好（首次读盘，之后走内存）。 */
export function loadPrefs() {
	if (!cache) cache = read();
	return cache;
}

/** 合并保存（只写传进来的键），并通知订阅者。 */
export function savePrefs(patch) {
	const next = { ...loadPrefs(), ...(patch && typeof patch === "object" ? patch : {}) };
	cache = next;
	try {
		localStorage.setItem(KEY, JSON.stringify(next));
	} catch {
		/* 隐私模式写不进去：本次会话内仍然生效 */
	}
	for (const fn of [...listeners]) {
		try {
			fn(next);
		} catch (err) {
			console.error("[notes] prefs listener failed:", err);
		}
	}
	return next;
}

/** 订阅偏好变更（返回注销函数）。 */
export function onPrefs(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
