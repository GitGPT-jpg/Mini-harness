/**
 * 插件运行相位纯函数（设置面板「界面插件」页顶部的清单区用）。
 *
 * 相位由服务端 `UiPluginInfo.active` + 本地禁用集 + `error` 三源合成：
 *   error 非空        → failed（红：激活失败 / manifest 坏 / 待授权的 wantsDom）
 *   在 disabledPlugins → disabled（灰：用户手动禁用，配置保留、仅不加载）
 *   active 为 true     → active（绿：宿主持有实例）
 *   其他              → idle（灰：纯前端插件，无 index.mjs，从未激活）
 *
 * 旧服务端无 active 字段（undefined）→ 按 idle 处理，不误报绿灯。
 */

import type { UiPluginInfo } from "./types.js";

export type PluginPhase = "active" | "disabled" | "failed" | "idle";

export function pluginPhase(p: Pick<UiPluginInfo, "error" | "active">, disabled: boolean): PluginPhase {
	if (p.error) return "failed";
	if (disabled) return "disabled";
	if (p.active === true) return "active";
	return "idle";
}

/** 清单计数（active/disabled/failed/idle 各几只，供头部汇总行用）。 */
export function countPluginPhases(
	plugins: Pick<UiPluginInfo, "id" | "error" | "active">[],
	disabledIds: ReadonlySet<string>,
): Record<PluginPhase, number> {
	const out: Record<PluginPhase, number> = { active: 0, disabled: 0, failed: 0, idle: 0 };
	for (const p of plugins) out[pluginPhase(p, disabledIds.has(p.id))] += 1;
	return out;
}
