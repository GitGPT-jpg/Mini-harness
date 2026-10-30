/**
 * 驾驶舱 Loop 体验的前端小状态与 HTTP 接口：任务台抽屉 / 代码 loop 弹窗 / 连接集群。
 *
 * 只是几个弹层开关 + 一份集群连通状态，不进 app-globals（那里是快照镜像）；
 * 打开入口的组件（顶栏、输入框、目标条药丸）各自 import 开关函数，不必层层传 props。
 * HTTP 一律 appUrl()（子路径部署）+ withToken()（PI_WEB_TOKEN）。
 */
import { useEffect, useSyncExternalStore } from "react";
import { appUrl } from "./base-url";
import { withToken } from "./auth-token";

/** GET /api/mini-harness/cluster 的结果（server/loop/routes.ts 的 ClusterStatus）。 */
export interface ClusterStatus {
	configured: boolean;
	connected: boolean;
	code: "not-configured" | "no-kubectl" | "error" | "ok";
	message: string;
}

interface CockpitState {
	codeLoopOpen: boolean;
	/** 打开代码 loop 弹窗时预填的目标（终态条「重试」带回上次的 goal）。 */
	codeLoopPrefill: string;
	clusterOpen: boolean;
	taskDeskOpen: boolean;
	cluster: ClusterStatus | null;
}

let state: CockpitState = {
	codeLoopOpen: false,
	codeLoopPrefill: "",
	clusterOpen: false,
	taskDeskOpen: false,
	cluster: null,
};
const listeners = new Set<() => void>();

function patch(p: Partial<CockpitState>): void {
	state = { ...state, ...p };
	for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

export function useCockpit<K extends keyof CockpitState>(key: K): CockpitState[K] {
	return useSyncExternalStore(
		subscribe,
		() => state[key],
		() => state[key],
	);
}

/** 任一驾驶舱弹层开着（输入框上沿的 loop 胶囊此时收起，不与弹层抢视线）。 */
export function useCockpitPopupOpen(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => state.codeLoopOpen || state.clusterOpen || state.taskDeskOpen,
		() => false,
	);
}

export const openCodeLoop = (prefill = ""): void => patch({ codeLoopOpen: true, codeLoopPrefill: prefill });
export const closeCodeLoop = (): void => patch({ codeLoopOpen: false });
export const openCluster = (): void => patch({ clusterOpen: true });
export const closeCluster = (): void => patch({ clusterOpen: false });
export const openTaskDesk = (): void => patch({ taskDeskOpen: true });
export const closeTaskDesk = (): void => patch({ taskDeskOpen: false });

export function mhUrl(path: string): string {
	return withToken(appUrl(`/api/mini-harness/${path}`));
}

export async function mhGet<T>(path: string): Promise<T | null> {
	try {
		const r = await fetch(mhUrl(path));
		return r.ok ? ((await r.json()) as T) : null;
	} catch {
		return null;
	}
}

/** POST JSON；非 2xx 也把响应体带回来（400 的 { error } 要给用户看）。网络失败 = null。 */
export async function mhPost<T>(path: string, body: unknown): Promise<{ ok: boolean; data: T | null } | null> {
	try {
		const r = await fetch(mhUrl(path), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		let data: T | null = null;
		try {
			data = (await r.json()) as T;
		} catch {
			data = null;
		}
		return { ok: r.ok, data };
	} catch {
		return null;
	}
}

export function setClusterStatus(c: ClusterStatus | null): void {
	patch({ cluster: c });
}

export async function refreshCluster(): Promise<void> {
	const j = await mhGet<ClusterStatus>("cluster");
	if (j) patch({ cluster: j });
}

let pollers = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** 集群状态轮询（6s，页面隐藏时跳过）：输入框按钮与底栏指示共用同一个定时器。 */
export function useClusterPolling(): void {
	useEffect(() => {
		pollers += 1;
		if (pollers === 1) {
			void refreshCluster();
			pollTimer = setInterval(() => {
				if (!document.hidden) void refreshCluster();
			}, 6000);
		}
		return () => {
			pollers -= 1;
			if (pollers === 0 && pollTimer) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
		};
	}, []);
}
