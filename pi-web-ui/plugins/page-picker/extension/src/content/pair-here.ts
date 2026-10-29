/// <reference path="../chrome.d.ts" />
/// <reference lib="dom" />
/**
 * 拾取浮条上的「与另一页配对…」要做的唯一一件事：请 worker 打开设置页的配对面板，并预填本页。
 *
 * 为什么不能就地配对：建一对配对要申请两个 origin 的 host 权限，而
 * `chrome.permissions.request` **必须在用户手势里**发出 —— 网页上的按钮（content script 的 UI）
 * 给不了浏览器要的手势。所以这里只负责把用户送过去（预填好本端），
 * 真正的「授权 + 落盘」在选项页那一次点击里完成。
 *
 * 单独成文件是为了能单测：它只有一条通路（发消息 + 读 ok），失败必须返回 false，
 * 让调用方给用户一句提示 —— 绝不出现「点了按钮什么都没发生」。
 */

/** @returns true = 设置页已经打开；false = 让调用方提示用户手动去选项页。 */
export async function requestPairHere(url: string): Promise<boolean> {
	return await askWorker("page-picker:pair-here", url);
}

/**
 * 拾取浮条上的「让 AI 操作本页…」：把本页送到设置页的授权面板。
 *
 * 同样只负责「把用户送到那一次能完成授权的点击上」——授权要 host 权限，而权限申请
 * 必须发生在扩展自己的页面里。
 */
export async function requestGrantHere(url: string): Promise<boolean> {
	return await askWorker("page-picker:grant-here", url);
}

/** 几条路径共用的唯一通路（失败一律 false，不招异常到 UI）。 */
async function askWorker(type: string, url: string): Promise<boolean> {
	try {
		const res = (await chrome.runtime.sendMessage({ type, url })) as { ok?: boolean } | undefined;
		return res?.ok === true;
	} catch {
		// service worker 被回收 / 通道断了：不是致命错，调用方给一句「手动去选项页」
		return false;
	}
}
