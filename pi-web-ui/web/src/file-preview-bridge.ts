/// <reference lib="dom" />
/**
 * 文件预览桥 —— 工具卡片（present_files）把文件**弹进文件预览弹窗**的反向通道。
 *
 * 为什么需要 sink 注册：预览弹窗（FilePreview）的开关状态在 App 的 state 里，
 * 渲染它的 JSX 也在 App；而调用方是消息流深处的工具卡片（ToolCallBlock →
 * PresentedFiles），中间隔着 MessageList / Message 好几层，为它拉一条 props 链
 * 得不偿失（也与 composer-bridge.ts 同一取舍：宿主侧只认这一个模块级入口）。
 *
 * 与 app-globals 的纪律一致：这里只放**跨边界动作**，不放状态、不吃快照流。
 * 打开是「有就打开、没有就没得打开」，所以返回值告诉调用方有没有受理——卡片
 * 需要据此决定要不要给出降级提示（目前是静默：页面还没挂载好时点预览没反应
 * 的概率极低，而弹提示反而更吵）。
 */

/** 预览目标（与 FilePreview 的 PreviewFile 结构一致：path + name）。 */
interface PreviewTarget {
	path: string;
	name: string;
}

type OpenSink = (file: PreviewTarget) => void;
type OpenChecker = () => boolean;

let openSink: OpenSink | null = null;
let openChecker: OpenChecker | null = null;

/** App 挂载时注册（传 null 注销）。可重复调用，后注册的覆盖先前的。 */
export function registerFilePreviewHost(host: { open: OpenSink; isOpen?: OpenChecker } | null): void {
	openSink = host?.open ?? null;
	openChecker = host?.isOpen ?? null;
}

/** 有没有宿主在听（页面挂载完成 = true）。 */
export function isFilePreviewReady(): boolean {
	return openSink !== null;
}

/** 预览弹窗当前是否已经开着（自动打开前用来避让：不抢用户已经打开的那一个）。 */
export function isFilePreviewOpen(): boolean {
	return openChecker ? openChecker() : false;
}

/** 仅供单测：清掉注册表（避免用例之间互相串）。 */
export function resetFilePreviewHost(): void {
	openSink = null;
	openChecker = null;
}

/** 打开文件预览弹窗，返回是否受理。 */
export function openFilePreview(file: PreviewTarget): boolean {
	if (!openSink || !file?.path) return false;
	openSink(file);
	return true;
}
