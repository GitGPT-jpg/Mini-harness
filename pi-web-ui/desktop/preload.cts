/**
 * desktop preload — 只暴露最小只读信息 + 更新通道。业务全部走 HTTP/WS，
 * 不走 IPC，避免和 web/ 现有协议分叉；唯独应用内自动更新（issue #180）是
 * 主进程（electron-updater）的事，server sidecar 够不着，所以单开这三个
 * invoke（check/download/quit-install）+ 一个 event 订阅。
 */
import type { IpcRendererEvent } from "electron";
import electron = require("electron");
const { contextBridge, ipcRenderer } = electron;

/** 与 desktop/main.ts 的 DesktopUpdaterEvent 同构（JSON 过 IPC，字段只增不改）。 */
export interface DesktopUpdaterEvent {
	state: "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error";
	version?: string | null;
	percent?: number;
	message?: string;
}

contextBridge.exposeInMainWorld("piDesktop", {
	isDesktop: true as const,
	platform: process.platform,
	setTitleBarOverlay: (opts: { color?: string; symbolColor?: string }) =>
		ipcRenderer.invoke("pi-desktop:set-title-bar-overlay", opts),
	onFullScreenChange: (cb: (isFullScreen: boolean) => void) => {
		const listener = (_event: IpcRendererEvent, isFs: boolean) => cb(isFs);
		ipcRenderer.on("pi-desktop:full-screen-change", listener);
		return () => ipcRenderer.removeListener("pi-desktop:full-screen-change", listener);
	},
	window: {
		minimize: () => ipcRenderer.invoke("pi-desktop:window-minimize"),
		toggleMaximize: () => ipcRenderer.invoke("pi-desktop:window-toggle-maximize"),
		close: () => ipcRenderer.invoke("pi-desktop:window-close"),
		isMaximized: () => ipcRenderer.invoke("pi-desktop:window-is-maximized"),
		onMaximizedChange: (cb: (maximized: boolean) => void) => {
			const listener = (_event: IpcRendererEvent, max: boolean) => cb(max);
			ipcRenderer.on("pi-desktop:window-maximized-change", listener);
			return () => ipcRenderer.removeListener("pi-desktop:window-maximized-change", listener);
		},
	},
	updater: {
		check: () => ipcRenderer.invoke("pi-desktop-updater:check"),
		download: () => ipcRenderer.invoke("pi-desktop-updater:download"),
		quitAndInstall: () => ipcRenderer.invoke("pi-desktop-updater:quit-install"),
		onEvent: (cb: (msg: DesktopUpdaterEvent) => void) => {
			const listener = (_event: IpcRendererEvent, msg: DesktopUpdaterEvent) => cb(msg);
			ipcRenderer.on("pi-desktop-updater:event", listener);
			return () => ipcRenderer.removeListener("pi-desktop-updater:event", listener);
		},
	},
});
