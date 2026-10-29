/**
 * 浏览器 E2E 测试用的 Chrome 可执行文件探测。
 * 路径不再写死本机（旧常量是 macOS 专属的 playwright 缓存路径）：
 * 1. 环境变量 PI_WEB_CHROME 最优先；
 * 2. 常见平台默认位置逐个探测，取第一个存在的。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
	// Windows playwright 缓存
	join(
		homedir(),
		"AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe",
	),
	// playwright 缓存（各平台）
	join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
	join(homedir(), "Library/Caches/ms-playwright/chrome-headless-shell-1228/chrome-headless-shell"),
	join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell"),
	// Windows / macOS / Linux 本机 Chrome
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium-browser",
	"/usr/bin/chromium",
];

export const CHROME_PATH =
	process.env.PI_WEB_CHROME ?? CANDIDATES.find((p) => existsSync(p)) ?? "";
