/**
 * 插件声明式设置里 `select` 字段的候选值清单（纯函数，有单测）。
 *
 * 候选值三种来源合一（见 server/protocol.ts 的 UiPluginSettingField）：
 *  - `options`：manifest 里的静态清单；
 *  - `optionsFrom: "models"`：宿主**已配置鉴权**的模型（值 `provider/id`，标签由调用方从模型清单取）；
 *  - `optionsFrom: "thinkingLevels"`：SDK 思考强度档位（标签走 i18n `thinking.<值>`）。
 *
 * 两条硬规则：
 *  ① 宿主数据源（optionsFrom）永远在最前面补一个空值选项 = 跟随全局默认（插件侧拿到空串自行回落）；
 *  ② 当前存值不在清单里时也保留（模型被删/手改过 storage.json/换过供应商）——否则下拉会
 *     静默显示成别的项，用户一保存就把配置“吃掉”了。
 */
import { THINKING_VALUES } from "./thinking-levels";

/** 模型清单条目（UiVisionBridgeModel 的最小结构；设置面板的模型选择器用同一份数据）。 */
export interface PluginSelectModel {
	provider: string;
	id: string;
	label: string;
}

/** 计算一个 select 字段要渲染的全部候选项（顺序 = 空值 → 静态 → 动态 → 当前值）。 */
export function pluginSelectValues(
	field: { options?: string[]; optionsFrom?: "models" | "thinkingLevels" },
	models: readonly PluginSelectModel[] = [],
	current?: unknown,
): string[] {
	const out: string[] = [];
	const push = (v: string): void => {
		if (!out.includes(v)) out.push(v);
	};
	if (field.optionsFrom) push("");
	for (const o of field.options ?? []) push(o);
	if (field.optionsFrom === "models") {
		for (const m of models) push(`${m.provider}/${m.id}`);
	} else if (field.optionsFrom === "thinkingLevels") {
		for (const v of THINKING_VALUES) push(v);
	}
	const cur = typeof current === "string" ? current : current === undefined || current === null ? "" : String(current);
	if (cur) push(cur);
	return out;
}
