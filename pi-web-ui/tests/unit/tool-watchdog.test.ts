/**
 * 工具挂死看门狗超时可设置（issue：AI 传 `bash timeout: 5400`（90 分钟），
 * 却被写死的 20 分钟看门狗联同整轮对话一起剁掉）。
 *
 * 两条不变量：
 *   1. 基础超时可配（设置面板「工具」页 / PI_WEB_TOOL_TIMEOUT_MS / 默认 20 分钟），
 *      0 = 禁用看门狗，脏值一律回落默认；
 *   2. 工具自己声明了更长超时时看门狗必须顺延（否则设置再大也没用）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ClientStateStore,
	DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS,
	effectiveToolWatchdogMs,
	normalizeToolWatchdogTimeoutMs,
	TOOL_WATCHDOG_EXPLICIT_GRACE_MS,
} from "../../server/client-state.js";

const roots: string[] = [];
function tempStore(): { store: ClientStateStore; file: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-tool-watchdog-"));
	roots.push(dir);
	const file = join(dir, "client-state.json");
	return { store: new ClientStateStore(file), file };
}

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("工具看门狗超时配置 (toolWatchdogTimeoutMs)", () => {
	it("normalizeToolWatchdogTimeoutMs 正常归一化", () => {
		// 0 保持为 0（禁用看门狗）——不能被当成「空值」回落默认。
		expect(normalizeToolWatchdogTimeoutMs(0)).toBe(0);
		expect(normalizeToolWatchdogTimeoutMs("0")).toBe(0);

		// 正整数保留
		expect(normalizeToolWatchdogTimeoutMs(60_000)).toBe(60_000);
		expect(normalizeToolWatchdogTimeoutMs("1200000")).toBe(1_200_000);

		// 浮点数向下取整
		expect(normalizeToolWatchdogTimeoutMs(60_000.7)).toBe(60_000);

		// 负数、非数值、空值回落默认值
		expect(normalizeToolWatchdogTimeoutMs(-1)).toBe(DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS);
		expect(normalizeToolWatchdogTimeoutMs("invalid")).toBe(DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS);
		expect(normalizeToolWatchdogTimeoutMs(null)).toBe(DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS);
		expect(normalizeToolWatchdogTimeoutMs(undefined)).toBe(DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS);
		expect(normalizeToolWatchdogTimeoutMs(NaN)).toBe(DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS);
	});

	it("默认值就是 20 分钟（旧行为不变）", () => {
		expect(DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS).toBe(20 * 60_000);
	});

	it("工具显式超时（bash timeout: 5400s）时看门狗自动顺延", () => {
		const base = 20 * 60_000; // 默认 20 分钟
		// AI 要求跑 90 分钟 → 看门狗顺延到 90 分钟 + 5 秒余量
		expect(effectiveToolWatchdogMs(base, "bash", { timeout: 5400 })).toBe(5_405_000);
		// 工具超时比基础值短 → 保持基础值
		expect(effectiveToolWatchdogMs(base, "bash", { timeout: 60 })).toBe(base);
		// 字符串形式的 timeout 同样识别
		expect(effectiveToolWatchdogMs(base, "bash", { timeout: "5400" })).toBe(5_405_000);
		// 非 bash 工具 / 无参数 / 脏参数：不受影响
		expect(effectiveToolWatchdogMs(base, "read", { timeout: 5400 })).toBe(base);
		expect(effectiveToolWatchdogMs(base, "bash", undefined)).toBe(base);
		expect(effectiveToolWatchdogMs(base, "bash", { timeout: "abc" })).toBe(base);
		expect(effectiveToolWatchdogMs(base, "bash", { timeout: -5 })).toBe(base);
	});

	it("设置面板把基础值调大/禁用后生效", () => {
		// 用户在设置里填 120 分钟 → 比 90 分钟大，保持 120 分钟
		expect(effectiveToolWatchdogMs(120 * 60_000, "bash", { timeout: 5400 })).toBe(120 * 60_000);
		// 用户填 0 → 不布看门狗（无论工具参数如何）
		expect(effectiveToolWatchdogMs(0, "bash", { timeout: 5400 })).toBe(0);
		expect(effectiveToolWatchdogMs(0, "read", undefined)).toBe(0);
		// 脏基础值（负/NaN）同样视为不布看门狗，不会算出负数 setTimeout
		expect(effectiveToolWatchdogMs(-1, "bash", { timeout: 5400 })).toBe(0);
		expect(effectiveToolWatchdogMs(NaN, "bash", undefined)).toBe(0);
	});

	it("余量是非零正数（保证工具先于看门狗超时）", () => {
		expect(TOOL_WATCHDOG_EXPLICIT_GRACE_MS).toBeGreaterThan(0);
	});

	it("持久化往返：设置存盘后重读仍然是同一个值（含 0 = 禁用）", () => {
		const { store, file } = tempStore();
		// 未设过 → 默认 20 分钟
		expect(store.getSettings("c1").toolWatchdogTimeoutMs).toBe(DEFAULT_TOOL_WATCHDOG_TIMEOUT_MS);

		// 存 90 分钟
		store.saveSettings("c1", { toolWatchdogTimeoutMs: 90 * 60_000 });
		expect(store.getSettings("c1").toolWatchdogTimeoutMs).toBe(90 * 60_000);

		// 新实例读同一份文件（模拟服务重启）仍是 90 分钟
		expect(new ClientStateStore(file).getSettings("c1").toolWatchdogTimeoutMs).toBe(90 * 60_000);

		// 0（禁用）必须存得住，不能被当成空值回落默认
		store.saveSettings("c1", { toolWatchdogTimeoutMs: 0 });
		expect(new ClientStateStore(file).getSettings("c1").toolWatchdogTimeoutMs).toBe(0);
	});
});
