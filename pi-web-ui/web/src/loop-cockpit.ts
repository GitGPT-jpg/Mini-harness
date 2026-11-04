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

/** GET /api/mini-harness/cluster 的结果（server/loop/cluster-config.ts 的 ClusterStatus，只含白名单字段）。 */
export interface ClusterStatus {
	configured: boolean;
	connected: boolean;
	code:
		| "not-configured"
		| "no-kubectl"
		| "ok"
		| "unauthorized"
		| "forbidden"
		| "tls"
		| "network"
		| "timeout"
		| "config-invalid"
		| "error";
	message: string;
	/** 服务实际使用的来源：Web 导入 / 启动时继承的 KUBECONFIG / ~/.kube/config / 无。 */
	source?: ClusterSource;
	envPathCount?: number;
	shadowed?: ClusterSource[];
	context?: string | null;
	serverVersion?: string | null;
	generation?: number;
	instance?: string;
	checkedAt?: string;
}

export type ClusterSource = "app" | "env" | "default" | "none";

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
	/** 打开详情时直接展开的操作：delete = 删除确认（任务台的「删除」走这里）。 */
	runDetailIntent: "delete" | null;
	/** 任务被删除后加一，任务台据此立即重拉列表。 */
	runsVersion: number;
	cluster: ClusterStatus | null;
	/** 有集群探测在途（首次加载 / 打开面板 / 刷新 / 导入 / 清除）。 */
	clusterChecking: boolean;
}

let state: CockpitState = {
	taskOpen: false,
	taskPrefill: null,
	clusterOpen: false,
	taskDeskOpen: false,
	runDetail: null,
	runDetailIntent: null,
	runsVersion: 0,
	cluster: null,
	clusterChecking: false,
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
export const openRunDetail = (runId: string, intent: "delete" | null = null): void =>
	patch({ runDetail: runId, runDetailIntent: intent });
export const closeRunDetail = (): void => patch({ runDetail: null, runDetailIntent: null });
export const bumpRunsVersion = (): void => patch({ runsVersion: state.runsVersion + 1 });

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

// 集群状态的过期结果防护：每个请求一个序号；导入/清除把下限抬到自己的序号，
// 之前发出、之后才返回的探测（配置已变）一律丢弃。同一服务实例内代次只增不减。
let clusterSeq = 0;
let clusterApplied = 0;
let clusterFloor = 0;

function applyCluster(seq: number, c: ClusterStatus | null | undefined): void {
	if (!c || seq < clusterFloor || seq < clusterApplied) return;
	const cur = state.cluster;
	if (cur?.instance && cur.instance === c.instance && (c.generation ?? 0) < (cur.generation ?? 0)) return;
	clusterApplied = seq;
	patch({ cluster: c });
}

function settleChecking(seq: number): void {
	if (seq === clusterSeq) patch({ clusterChecking: false });
}

/** 取服务端状态；force = 跳过服务端 8s 缓存（打开面板 / 点刷新）。 */
export async function refreshCluster(force = false): Promise<void> {
	const seq = ++clusterSeq;
	patch({ clusterChecking: true });
	applyCluster(seq, await mhGet<ClusterStatus>(force ? "cluster?refresh=1" : "cluster"));
	settleChecking(seq);
}

/** 导入（path="cluster"）或清除（"cluster/clear"）；响应里是变更后对当前配置的探测结果。 */
export async function mutateCluster(
	path: "cluster" | "cluster/clear",
	body: unknown,
): Promise<{ ok: boolean; data: (ClusterStatus & { error?: string; status?: ClusterStatus }) | null } | null> {
	const seq = ++clusterSeq;
	clusterFloor = seq;
	patch({ clusterChecking: true });
	const r = await mhPost<ClusterStatus & { error?: string; status?: ClusterStatus }>(path, body);
	applyCluster(seq, r?.ok ? r.data : r?.data?.status);
	settleChecking(seq);
	return r;
}

let pollers = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const onVisible = () => {
	if (!document.hidden) void refreshCluster();
};

/** 集群状态轮询（15s，页面隐藏时跳过、回到前台补一次）：输入框按钮与底栏指示共用同一个定时器。
 *  服务端另有 8s 缓存与在途合并，多个页面不会叠加出高频探测。 */
export function useClusterPolling(): void {
	useEffect(() => {
		pollers += 1;
		if (pollers === 1) {
			void refreshCluster();
			pollTimer = setInterval(() => {
				if (!document.hidden) void refreshCluster();
			}, 15_000);
			document.addEventListener("visibilitychange", onVisible);
		}
		return () => {
			pollers -= 1;
			if (pollers === 0 && pollTimer) {
				clearInterval(pollTimer);
				pollTimer = null;
				document.removeEventListener("visibilitychange", onVisible);
			}
		};
	}, []);
}
