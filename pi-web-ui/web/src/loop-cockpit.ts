/**
 * 驾驶舱 Loop 体验的前端小状态与 HTTP 接口：任务台抽屉 / 新任务弹窗 / 连接集群 / 任务详情。
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

/** 新任务弹窗的验收方式：代码验证 + 模型评审 / 仅代码验证（都走 mini-harness 代码 loop）/
 *  仅模型评审（走 GoalService 的 LLM loop）。 */
export type TaskAcceptance = "code-review" | "code" | "llm";

/** 打开新任务弹窗时的预填（终态条「重试」/ 详情面板「用同一目标重新开始」带回上次的任务）。
 *  criteria 缺省 = 清空；acceptance 缺省 = 不动弹窗里当前选的验收方式。 */
export interface TaskPrefill {
	goal?: string;
	criteria?: string;
	acceptance?: TaskAcceptance;
}

interface CockpitState {
	taskOpen: boolean;
	/** 本次打开带的预填；null = 沿用弹窗里上次没提交的草稿。 */
	taskPrefill: TaskPrefill | null;
	clusterOpen: boolean;
	taskDeskOpen: boolean;
	/** 任务详情面板正在看的 runId；null = 关着。 */
	runDetail: string | null;
	cluster: ClusterStatus | null;
}

let state: CockpitState = {
	taskOpen: false,
	taskPrefill: null,
	clusterOpen: false,
	taskDeskOpen: false,
	runDetail: null,
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

/** 任一驾驶舱弹层开着（新任务 / 连接集群 / 任务台 / 任务详情）：输入框上沿的「新任务」胶囊此时收起，不与弹层抢视线。 */
export function useCockpitPopupOpen(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => state.taskOpen || state.clusterOpen || state.taskDeskOpen || state.runDetail !== null,
		() => false,
	);
}

export const openTaskModal = (prefill: TaskPrefill | null = null): void =>
	patch({ taskOpen: true, taskPrefill: prefill });
export const closeTaskModal = (): void => patch({ taskOpen: false, taskPrefill: null });
export const openCluster = (): void => patch({ clusterOpen: true });
export const closeCluster = (): void => patch({ clusterOpen: false });
export const openTaskDesk = (): void => patch({ taskDeskOpen: true });
export const closeTaskDesk = (): void => patch({ taskDeskOpen: false });
export const openRunDetail = (runId: string): void => patch({ runDetail: runId });
export const closeRunDetail = (): void => patch({ runDetail: null });

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
