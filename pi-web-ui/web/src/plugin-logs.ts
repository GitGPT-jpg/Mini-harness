/**
 * 插件运行时分级日志（host.log）的前端侧：按需拉取 + 本地 store。
 *
 * 通道（复用既有 plugin_message / plugin_data，不动 wire 协议）：
 * - 上行：{ type:"plugin_message", pluginId, payload:{ __host:"logs", op:"get"|"clear" } }
 * - 下行：{ type:"plugin_data", pluginId, payload:{ __host:"logs", logs:[...], cleared? } }
 *
 * use-chat 收到 plugin_data 后先走 ingestPluginLogsData：命中即吞掉并刷新 store，
 * 不再扇出给插件视图（插件的 onData 看不到宿主保留通道）。设置面板“界面插件”页
 * 订阅本 store，按插件展开查看（全量日志绝不进 60ms 快照，只有点了“日志”才拉一次）。
 */

export type PluginLogLevel = "debug" | "info" | "warn" | "error";

export interface PluginLogEntry {
	/** 毫秒时间戳（服务端时钟）。 */
	ts: number;
	level: PluginLogLevel;
	text: string;
}

export const PLUGIN_LOG_LEVELS: readonly PluginLogLevel[] = ["debug", "info", "warn", "error"];

/** 构造“拉取某插件日志”的上行消息（经 appSend 发出）。 */
export function pluginLogsFetch(pluginId: string): {
	type: "plugin_message";
	pluginId: string;
	payload: { __host: "logs"; op: "get" };
} {
	return { type: "plugin_message", pluginId, payload: { __host: "logs", op: "get" } };
}

/** 构造“清空某插件日志”的上行消息（服务端清完后回空 logs + cleared 回包）。 */
export function pluginLogsClearRequest(pluginId: string): {
	type: "plugin_message";
	pluginId: string;
	payload: { __host: "logs"; op: "clear" };
} {
	return { type: "plugin_message", pluginId, payload: { __host: "logs", op: "clear" } };
}

/** 是否为宿主保留的日志回包（下行 plugin_data 的 payload 形状校验）。 */
export function isPluginLogsResponse(payload: unknown): payload is {
	__host: "logs";
	logs: PluginLogEntry[];
	cleared?: boolean;
} {
	if (!payload || typeof payload !== "object") return false;
	const o = payload as Record<string, unknown>;
	if (o.__host !== "logs" || !Array.isArray(o.logs)) return false;
	return o.logs.every(
		(e) =>
			!!e &&
			typeof e === "object" &&
			typeof (e as { ts?: unknown }).ts === "number" &&
			typeof (e as { text?: unknown }).text === "string" &&
			(PLUGIN_LOG_LEVELS as readonly string[]).includes(String((e as { level?: unknown }).level)),
	);
}

// ---- 本地 store（模块级单例；设置面板订阅，不进 useChat reducer） ------------

const logsByPlugin = new Map<string, PluginLogEntry[]>();
const listeners = new Set<() => void>();

function notify(): void {
	// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: 订阅者可能在回调里退订
	for (const l of [...listeners]) {
		try {
			l();
		} catch {
			/* 订阅者异常不影响其他订阅者 */
		}
	}
}

/** 订阅日志 store 变化（返回取消订阅函数）。 */
export function subscribePluginLogs(cb: () => void): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

/** 读某插件上次拉到的日志（拷贝；没拉过回 []）。 */
export function getPluginLogs(pluginId: string): PluginLogEntry[] {
	return (logsByPlugin.get(pluginId) ?? []).map((e) => ({ ...e }));
}

/**
 * use-chat 的 plugin_data 入口先调本函数：命中日志回包即存入 store 并返回 true
 * （调用方不再扇出给插件视图）；不是回包返回 false（照常走 emitPluginData）。
 */
export function ingestPluginLogsData(pluginId: string, payload: unknown): boolean {
	if (!isPluginLogsResponse(payload)) return false;
	logsByPlugin.set(
		pluginId,
		payload.logs.map((e) => ({ ts: e.ts, level: e.level, text: e.text })),
	);
	notify();
	return true;
}
