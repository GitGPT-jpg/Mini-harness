/**
 * 等页面「导航静默」再动手 —— 给 E2E 脚本用。
 *
 * 为什么需要：新会话页面会**自己重载一次**（WS `hello` 里的 buildId 与页面烧进去的
 * `__BUILD_ID__` 不一致时，`web/src/use-chat.ts` 会 reload 一遭去取新 bundle；两边取值域
 * 不同，所以每次新会话都会发生）。而宿主内置的顶栏按钮（如插件面板入口）**在重载之前
 * 就已经 attached** —— 「一 attached 就点」会点在那个马上被重载抹掉的页面上，面板/菜单随之消失。
 * 旧脚本找的是插件 tab（数据来自 hello 之后的快照），天然避开了这个窗口；改成点宿主按钮后
 * 就必须先等重载过去。
 *
 * 判定：主框架在 `quietMs` 内没有再发生导航即认为稳定（初始 goto 也算一次导航，所以无论
 * 重载发生在 attach 之前还是之后都安全 —— 最坏只是多等一个 quietMs）。
 */
import { setTimeout as sleep } from "node:timers/promises";

export async function waitForStablePage(page, { quietMs = 800, timeoutMs = 30000 } = {}) {
	let lastNav = Date.now();
	const onNav = (frame) => {
		if (frame === page.mainFrame()) lastNav = Date.now();
	};
	page.on("framenavigated", onNav);
	try {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			await sleep(100);
			if (Date.now() - lastNav > quietMs) return true;
		}
		return false;
	} finally {
		page.off("framenavigated", onNav);
	}
}
