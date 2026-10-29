/// <reference lib="dom" />
/**
 * 聊天背景图（壁纸，issue #100）：纯前端 localStorage 设置，不经过 server。
 *
 * - 主题也可以自带一张背景图（主题文件里写 `--bg-image: url(...)`），此时
 *   无需任何设置即生效；用户在此填了地址则优先用用户的（内联变量覆盖主题）。
 * - 可读性配套：压暗（在图上按 --bg 盖一层，越高越接近纯色背景）+ 模糊。
 * - normalize/sanitize 为纯函数，可单测（tests/unit/wallpaper-settings.test.ts）。
 */

import { useEffect, useSyncExternalStore } from "react";
import { fileToProcessedImage } from "./image-paste";
import { THEME_CHANGE_EVENT } from "./theme";

const WALLPAPER_SETTINGS_KEY = "pi-web-ui:wallpaper";
const WALLPAPER_BODY_CLASS = "has-wallpaper";

interface WallpaperSettings {
	/** 图片地址（空 = 关闭，主题自带的图仍可生效）。 */
	url: string;
	/** 压暗强度 0–95（百分比，越高越接近纯色背景）。 */
	dim: number;
	/** 模糊半径 0–24（px）。 */
	blur: number;
}

export const DEFAULT_WALLPAPER_SETTINGS: WallpaperSettings = { url: "", dim: 78, blur: 0 };

const MAX_HTTP_URL_LENGTH = 2000;
/** data: 图存 localStorage：图片管线按 2MB 二进制封顶，base64 后约 2.7M 字符。 */
const MAX_DATA_URL_LENGTH = 2800000;

/** 只允许无害的图片来源：http(s) / blob / data:image / 站内相对路径。 */
export function sanitizeWallpaperUrl(raw: unknown): string {
	if (typeof raw !== "string") return "";
	const url = raw.trim();
	if (!url) return "";
	const cap = url.toLowerCase().startsWith("data:image/") ? MAX_DATA_URL_LENGTH : MAX_HTTP_URL_LENGTH;
	if (url.length > cap) return "";
	if (/^https?:\/\//i.test(url)) return url;
	if (/^blob:/i.test(url)) return url;
	if (/^data:image\//i.test(url)) return url;
	// 站内相对路径（/themes/…、/uploads/… 等），不接受 javascript: 等伪协议。
	if (url.startsWith("/") && !url.startsWith("//")) return url;
	return "";
}

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	return Math.min(max, Math.max(min, Math.round(v)));
};

/** 规整设置值：字段类型错误一律回退默认（坏地址按空处理）。 */
export function normalizeWallpaperSettings(raw: unknown): WallpaperSettings {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_WALLPAPER_SETTINGS };
	const o = raw as Record<string, unknown>;
	return {
		url: sanitizeWallpaperUrl(o.url),
		dim: clampInt(o.dim, 0, 95, DEFAULT_WALLPAPER_SETTINGS.dim),
		blur: clampInt(o.blur, 0, 24, DEFAULT_WALLPAPER_SETTINGS.blur),
	};
}

/** 读取持久化的壁纸设置（localStorage 不可用 / 数据损坏时回退默认）。 */
function loadWallpaperSettings(): WallpaperSettings {
	try {
		const raw = localStorage.getItem(WALLPAPER_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_WALLPAPER_SETTINGS };
		return normalizeWallpaperSettings(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_WALLPAPER_SETTINGS };
	}
}

/** CSS url("…") 内容转义：反斜杠 / 双引号 / 换行。 */
export function cssEscapeUrl(url: string): string {
	return url
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/[\r\n]/g, "");
}

/**
 * 本地图片文件 → 可直接存设置的壁纸地址：复用粘贴图片管线
 *（等比缩 ≤1568px + 重编码，见 image-paste.ts），返回完整 data: URL；
 * 非图片 / 浏览器解码失败返回 null（由调用方提示用户换一张）。
 */
export async function fileToWallpaperUrl(file: File): Promise<string | null> {
	const img = await fileToProcessedImage(file);
	if (!img) return null;
	return `data:${img.mimeType};base64,${img.data}`;
}

/**
 * 把当前壁纸设置应用到 document：
 * 有用户地址 → 写 --bg-image/--bg-image-dim/--bg-image-blur 内联变量（覆盖主题）；
 * 无 → 清掉内联变量（主题自带的 --bg-image 若有则自然生效）。
 * body.has-wallpaper 按「最终生效的 --bg-image 是否为 none」开关，
 * styles.css 里 body 上的两层全屏壁纸（图 + 压暗）靠它显隐。
 */
function applyWallpaper(): void {
	const s = cached ?? loadWallpaperSettings();
	const root = document.documentElement;
	if (s.url) {
		root.style.setProperty("--bg-image", `url("${cssEscapeUrl(s.url)}")`);
		root.style.setProperty("--bg-image-dim", String(s.dim / 100));
		root.style.setProperty("--bg-image-blur", `${s.blur}px`);
	} else {
		root.style.removeProperty("--bg-image");
		root.style.removeProperty("--bg-image-dim");
		root.style.removeProperty("--bg-image-blur");
	}
	const effective = getComputedStyle(root).getPropertyValue("--bg-image").trim();
	document.body.classList.toggle(WALLPAPER_BODY_CLASS, s.url !== "" || (effective !== "" && effective !== "none"));
}

/** 保存并广播变更（localStorage 不可写时静默忽略，内存值仍即时生效）。 */
export function saveWallpaperSettings(s: WallpaperSettings): void {
	const norm = normalizeWallpaperSettings(s);
	cached = norm;
	try {
		localStorage.setItem(WALLPAPER_SETTINGS_KEY, JSON.stringify(norm));
	} catch {
		/* ignore */
	}
	for (const l of listeners) l();
	applyWallpaper();
}

// ---- 订阅：单例 listener 集合（与 chat-width-settings.ts 同模式）------------

let cached: WallpaperSettings | null = null;
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

function getSnapshot(): WallpaperSettings {
	if (!cached) cached = loadWallpaperSettings();
	return cached;
}

/** 当前壁纸设置（设置面板切换后即时生效，无需刷新）。 */
export function useWallpaperSettings(): WallpaperSettings {
	return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * 在 App 顶层调用一次：挂载即应用，并订阅主题切换事件——
 * 换主题（<link> 替换）后重新计算主题自带 --bg-image 是否生效。
 */
export function useWallpaperEffect(): void {
	const s = useWallpaperSettings();
	useEffect(() => {
		applyWallpaper();
	}, [s]);
	useEffect(() => {
		const onTheme = () => applyWallpaper();
		window.addEventListener(THEME_CHANGE_EVENT, onTheme);
		applyWallpaper();
		return () => window.removeEventListener(THEME_CHANGE_EVENT, onTheme);
	}, []);
}
