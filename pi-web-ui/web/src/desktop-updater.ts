/**
 * 桌面壳应用内更新桥（issue #180）。
 *
 * 打包后的桌面应用服务来自包内 `dist/server`，`npm i -g pi-web-ui@latest`
 * 换不掉它 —— 更新面板在桌面壳里必须走 electron-updater（主进程直连
 * GitHub releases 的 latest*.yml），而不是 npm 那套终端命令。
 *
 * 主进程（desktop/main.ts）↔ preload（desktop/preload.ts）↔ 这里：
 * invoke 三件套（check/download/quit-install）+ event 订阅。
 * 纯函数（reduceUpdaterEvent / releasesTagUrl / isBridgeUsable）可单测；
 * useDesktopUpdater 是 TopBar 更新面板用的 hook。
 */
import { useCallback, useEffect, useState } from "react";
import { isDesktopShell, type DesktopShellWindow } from "./desktop.js";

const DESKTOP_REPO = "xing-shuyin/pi-web-ui";

/** 与 desktop/preload.ts 的 DesktopUpdaterEvent 同构。 */
export interface DesktopUpdaterEvent {
	state: "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error";
	version?: string | null;
	percent?: number;
	message?: string;
}

interface DesktopUpdaterBridge {
	check: () => Promise<unknown>;
	download: () => Promise<unknown>;
	quitAndInstall: () => Promise<unknown>;
	onEvent: (cb: (msg: DesktopUpdaterEvent) => void) => () => void;
}

type DesktopUpdaterState = "idle" | "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error";

interface DesktopUpdaterStatus {
	state: DesktopUpdaterState;
	/** electron-updater 报的远端版本（null = 还没结论）。 */
	version: string | null;
	/** downloading 时的 0-100。 */
	percent: number;
	/** error 时的原始信息。 */
	message: string | null;
}

export const INITIAL_DESKTOP_UPDATER_STATUS: DesktopUpdaterStatus = {
	state: "idle",
	version: null,
	percent: 0,
	message: null,
};

function clampPercent(n: unknown): number {
	return typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

/** 主进程事件 → 面板状态（纯函数，单测覆盖）。 */
export function reduceUpdaterEvent(prev: DesktopUpdaterStatus, event: DesktopUpdaterEvent): DesktopUpdaterStatus {
	switch (event.state) {
		case "checking":
			return { ...prev, state: "checking", message: null };
		case "available":
			return { ...prev, state: "available", version: event.version ?? prev.version, message: null };
		case "up-to-date":
			return { ...prev, state: "up-to-date", version: event.version ?? prev.version, message: null };
		case "downloading":
			return { ...prev, state: "downloading", percent: clampPercent(event.percent), message: null };
		case "downloaded":
			return {
				...prev,
				state: "downloaded",
				version: event.version ?? prev.version,
				percent: 100,
				message: null,
			};
		case "error":
			return { ...prev, state: "error", message: event.message ?? "unknown error" };
		default:
			return prev;
	}
}

/**
 * preload 桥是否可用：桌面壳（piDesktop.isDesktop 或 Electron UA）且
 * updater 三件套齐全。旧版桌面壳（#180 之前）没有 updater —— 面板此时
 * 只给下载页指引，不画更新按钮（isBridgeUsable=false + isDesktop=true）。
 */
export function getDesktopUpdaterBridge(win?: unknown): DesktopUpdaterBridge | null {
	if (!isDesktopShell(win)) return null;
	const w =
		(win as DesktopShellWindow | undefined) ??
		(typeof window === "undefined" ? undefined : (window as unknown as DesktopShellWindow));
	const updater = (w as { piDesktop?: { updater?: DesktopUpdaterBridge } } | undefined)?.piDesktop?.updater;
	if (!updater || typeof updater.check !== "function" || typeof updater.download !== "function") return null;
	return updater;
}

function invokeMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * 去下载页：有远端版本号就直达该 tag（`…/releases/tag/vX.Y.Z`），
 * 还没结论就落到 `…/releases/latest`。永远有地方可去，不 404。
 */
export function desktopReleasesUrl(version: string | null | undefined): string {
	const v = (version ?? "").trim().replace(/^v/, "");
	return v
		? `https://github.com/${DESKTOP_REPO}/releases/tag/v${v}`
		: `https://github.com/${DESKTOP_REPO}/releases/latest`;
}

/** 更新面板用的 hook：订阅主进程事件 + 三个动作（失败都落成 error 状态）。 */
export function useDesktopUpdater(): DesktopUpdaterStatus & {
	bridge: DesktopUpdaterBridge | null;
	check: () => void;
	download: () => void;
	quitAndInstall: () => void;
} {
	const [bridge] = useState<DesktopUpdaterBridge | null>(() => getDesktopUpdaterBridge());
	const [status, setStatus] = useState<DesktopUpdaterStatus>(INITIAL_DESKTOP_UPDATER_STATUS);

	useEffect(() => {
		if (!bridge) return;
		return bridge.onEvent((msg) => setStatus((prev) => reduceUpdaterEvent(prev, msg)));
	}, [bridge]);

	const check = useCallback(() => {
		if (!bridge) return;
		setStatus((prev) => ({ ...prev, state: "checking", message: null }));
		bridge
			.check()
			.catch((err: unknown) => setStatus((prev) => ({ ...prev, state: "error", message: invokeMessage(err) })));
	}, [bridge]);

	const download = useCallback(() => {
		if (!bridge) return;
		setStatus((prev) => ({ ...prev, state: "downloading", message: null }));
		bridge
			.download()
			.catch((err: unknown) => setStatus((prev) => ({ ...prev, state: "error", message: invokeMessage(err) })));
	}, [bridge]);

	const quitAndInstall = useCallback(() => {
		if (!bridge) return;
		bridge
			.quitAndInstall()
			.catch((err: unknown) => setStatus((prev) => ({ ...prev, state: "error", message: invokeMessage(err) })));
	}, [bridge]);

	return { ...status, bridge, check, download, quitAndInstall };
}
