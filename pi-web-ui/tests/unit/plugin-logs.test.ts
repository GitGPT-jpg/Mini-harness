/**
 * plugin-logs.ts 单测：宿主保留日志通道的前端侧。
 *
 * 覆盖：
 * - isPluginLogsResponse 只认 {__host:"logs", logs:[...]} 形状（坏负载一律 false，
 *   绝不能把插件自己的业务回包吞掉）
 * - 上行构造器（get/clear）的 plugin_message 形状
 * - ingestPluginLogsData 命中即存 store 并返回 true；未命中返回 false
 *   （调用方照常 emitPluginData，不干扰插件视图）
 */
import { describe, expect, it } from "vitest";
import {
	getPluginLogs,
	ingestPluginLogsData,
	isPluginLogsResponse,
	pluginLogsClearRequest,
	pluginLogsFetch,
} from "../../web/src/plugin-logs.js";

const entry = (level: string, text: string, ts = 1700000000000) => ({ ts, level, text });

describe("isPluginLogsResponse", () => {
	it("合法回包 → true", () => {
		expect(isPluginLogsResponse({ __host: "logs", logs: [entry("info", "hi")] })).toBe(true);
		expect(isPluginLogsResponse({ __host: "logs", logs: [], cleared: true })).toBe(true);
	});

	it("插件业务回包/坏形状 → false（绝不吞插件自己的数据）", () => {
		expect(isPluginLogsResponse({ action: "state", mails: [] })).toBe(false);
		expect(isPluginLogsResponse({ __host: "logs" })).toBe(false);
		expect(isPluginLogsResponse({ __host: "logs", logs: "nope" })).toBe(false);
		expect(isPluginLogsResponse({ __host: "logs", logs: [entry("verbose", "x")] })).toBe(false);
		expect(isPluginLogsResponse({ __host: "logs", logs: [{ ts: 1 }] })).toBe(false);
		expect(isPluginLogsResponse(null)).toBe(false);
		expect(isPluginLogsResponse("logs")).toBe(false);
	});
});

describe("wire constructors", () => {
	it("get/clear 上行都是 plugin_message + __host 保留键", () => {
		expect(pluginLogsFetch("mail")).toEqual({
			type: "plugin_message",
			pluginId: "mail",
			payload: { __host: "logs", op: "get" },
		});
		expect(pluginLogsClearRequest("mail")).toEqual({
			type: "plugin_message",
			pluginId: "mail",
			payload: { __host: "logs", op: "clear" },
		});
	});
});

describe("ingestPluginLogsData", () => {
	it("命中回包 → 存 store 并返回 true；按插件隔离", () => {
		expect(ingestPluginLogsData("p1", { __host: "logs", logs: [entry("error", "boom")] })).toBe(true);
		expect(getPluginLogs("p1")).toEqual([entry("error", "boom")]);
		expect(getPluginLogs("p2")).toEqual([]);
	});

	it("clear 回包（空 logs + cleared）→ store 置空", () => {
		ingestPluginLogsData("p3", { __host: "logs", logs: [entry("info", "x")] });
		expect(getPluginLogs("p3")).toHaveLength(1);
		expect(ingestPluginLogsData("p3", { __host: "logs", logs: [], cleared: true })).toBe(true);
		expect(getPluginLogs("p3")).toEqual([]);
	});

	it("非回包 → 返回 false 且 store 不动", () => {
		expect(ingestPluginLogsData("p4", { action: "ping" })).toBe(false);
		expect(getPluginLogs("p4")).toEqual([]);
	});
});
