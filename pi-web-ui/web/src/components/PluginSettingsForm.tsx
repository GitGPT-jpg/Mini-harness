import { useState } from "react";
import type { UiPluginInfo, UiPluginSettingField } from "../types";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { pluginSelectValues, type PluginSelectModel } from "../plugin-setting-options";
import { THINKING_VALUES, type ThinkingValue } from "../thinking-levels";

/**
 * 插件声明式设置表单（manifest "settings" schema → 自动渲染）。
 * 值保存在 storage.json 的 "settings" 键（宿主统一管理），保存时发
 * plugin_settings，服务端校验 + 持久化 + 通知插件（onSettingsChanged）。
 * secret 类型例外：存加密 secrets，settingsValues 里只有有无（布尔），
 * 表单里永远是空输入框（留空 = 不改），明文只在提交那一刻经过内存。
 *
 * select 字段的候选项可以来自宿主数据源（manifest `optionsFrom`：模型清单 /
 * 思考强度档位，见 web/src/plugin-setting-options.ts）——模型清单由设置面板传进来，
 * 候选项随配置变化自动刷新，插件不必自己维护会过期的静态表。
 */
export function PluginSettingsForm({
	plugin,
	models = [],
}: {
	plugin: UiPluginInfo;
	/** 已配置鉴权的模型清单（UiSettingsState.subagentModels；缺省 = 只剩「跟随全局默认」）。 */
	models?: PluginSelectModel[];
}) {
	const t = useT();
	const schema = plugin.settingsSchema ?? [];
	// secret 的 settingsValues 是有无布尔：draft 里恒置空串（不把布尔发回去）。
	const [draft, setDraft] = useState<Record<string, unknown>>(() => {
		const init: Record<string, unknown> = { ...plugin.settingsValues };
		for (const f of schema) if (f.type === "secret") init[f.key] = "";
		return init;
	});
	const [saving, setSaving] = useState(false);

	if (schema.length === 0) return null;

	const set = (key: string, v: unknown) => setDraft((prev) => ({ ...prev, [key]: v }));
	// select 候选值与标签：空值 = 跟随全局默认；模型取清单标签，思考强度走 i18n 档位文案。
	const selectOptions = (f: UiPluginSettingField) =>
		pluginSelectValues(f, models, draft[f.key]).map((v) => {
			if (v === "") return { value: "", label: t("pluginSettingsInherit") };
			if (f.optionsFrom === "thinkingLevels" && (THINKING_VALUES as readonly string[]).includes(v)) {
				return { value: v, label: t(`thinking.${v as ThinkingValue}`) };
			}
			if (f.optionsFrom === "models") {
				const hit = models.find((m) => `${m.provider}/${m.id}` === v);
				if (hit) return { value: v, label: hit.label };
			}
			return { value: v, label: v };
		});
	// secret 字段的脏判定看输入框是否非空（settingsValues 里是有无布尔，不可直接比）。
	const isDirty = schema.some((f) =>
		f.type === "secret" ? String(draft[f.key] ?? "") !== "" : draft[f.key] !== plugin.settingsValues?.[f.key],
	);

	const save = () => {
		setSaving(true);
		appSend({ type: "plugin_settings", pluginId: plugin.id, values: draft });
		setTimeout(() => setSaving(false), 800);
	};

	const reset = () => {
		const init: Record<string, unknown> = { ...plugin.settingsValues };
		for (const f of schema) if (f.type === "secret") init[f.key] = "";
		setDraft(init);
	};

	return (
		<div className="plugin-settings-form">
			<div className="plugin-settings-fields">
				{schema.map((f) => (
					// 标签左列 + 控件右列：标签永不压缩（旧版被挤成竖排），hint 常显为标签下小字。
					<label key={f.key} className="plugin-settings-field" data-key={f.key} title={f.hint}>
						<span className="plugin-settings-label">
							<span className="plugin-settings-label-text" title={f.label}>
								{f.label}
							</span>
							{f.hint && <span className="plugin-settings-hint">{f.hint}</span>}
						</span>
						<span className="plugin-settings-control">
							{f.type === "boolean" ? (
								<input type="checkbox" checked={Boolean(draft[f.key])} onChange={(e) => set(f.key, e.target.checked)} />
							) : f.type === "secret" ? (
								<input
									type="password"
									value={String(draft[f.key] ?? "")}
									placeholder={t(plugin.settingsValues?.[f.key] ? "pluginSecretSet" : "pluginSecretUnset")}
									autoComplete="new-password"
									onChange={(e) => set(f.key, e.target.value)}
								/>
							) : f.type === "select" ? (
								<select value={String(draft[f.key] ?? "")} onChange={(e) => set(f.key, e.target.value)}>
									{selectOptions(f).map((o) => (
										<option key={o.value} value={o.value}>
											{o.label}
										</option>
									))}
								</select>
							) : (
								<input
									type={f.type === "password" ? "password" : f.type === "number" ? "number" : "text"}
									value={String(draft[f.key] ?? "")}
									min={f.min}
									max={f.max}
									onChange={(e) => set(f.key, f.type === "number" ? Number(e.target.value) : e.target.value)}
								/>
							)}
						</span>
					</label>
				))}
			</div>
			<div className="plugin-settings-actions">
				<button type="button" className="btn plugin-settings-save" disabled={!isDirty || saving} onClick={save}>
					{saving ? t("pluginSettingsSaving") : t("pluginSettingsSave")}
				</button>
				<button type="button" className="btn plugin-settings-reset" onClick={reset}>
					{t("pluginSettingsReset")}
				</button>
			</div>
		</div>
	);
}
