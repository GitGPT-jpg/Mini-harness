import { useEffect, useMemo, useState } from "react";
import { FiEdit3 } from "react-icons/fi";
import { useT } from "../i18n";
import { invalidateToolPrompt, requestToolPrompt, useToolPromptView } from "../tool-prompt-state";
import type { UiToolPromptOverride } from "../types";
import { Modal } from "./Modal";

/**
 * 逐工具文案编辑器（设置页「工具」区每个工具行的「编辑文案」入口）。
 *
 * 三个字段对应模型能看到的三处工具文案（见 server/tool-prompt-overrides.ts）：
 *  - 描述        → tool schema 的 `description`（这是什么 / 有什么副作用）；
 *  - 提示词摘要  → 系统提示词 Available tools 列表里的一行；
 *  - 行为要点    → 系统提示词 Guidelines 段（每行一条）。
 * 留空 = 用工具自带默认（默认值从服务端 `get_tool_prompt` 取，展示在输入框下方）。
 *
 * 保存直接走 `set_settings.toolPromptOverrides`（服务端逐工具合并 + 持久化 + 即时生效），
 * 不需要单独协议。
 */
export function ToolPromptEditor({
	name,
	override,
	onApply,
	onClose,
}: {
	/** 正在编辑的工具名（同名工具覆盖对全局生效）。 */
	name: string;
	/** 当前设置里的覆盖（来自 settings_state；缺省 = 没覆盖）。 */
	override: UiToolPromptOverride | null;
	/** 保存：override 为 null = 清除覆盖（恢复默认）。 */
	onApply: (name: string, override: UiToolPromptOverride | null) => void;
	onClose: () => void;
}) {
	const t = useT();
	const view = useToolPromptView(name);
	const [description, setDescription] = useState(() => override?.description ?? "");
	const [snippet, setSnippet] = useState(() => override?.promptSnippet ?? "");
	const [guidelines, setGuidelines] = useState(() => (override?.promptGuidelines ?? []).join("\n"));

	// 打开（或切换到另一个工具）时拉一次默认值 + 当前覆盖。
	useEffect(() => {
		requestToolPrompt(name);
	}, [name]);

	const defaultGuidelinesText = useMemo(() => (view?.defaultPromptGuidelines ?? []).join("\n"), [view]);

	const unavailable = view?.status === "unsupported" || view?.status === "missing";

	const save = () => {
		const next: UiToolPromptOverride = {};
		const d = description.trim();
		if (d) next.description = d;
		const s = snippet.trim();
		if (s) next.promptSnippet = s;
		const g = guidelines
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		if (g.length > 0) next.promptGuidelines = g;
		onApply(name, Object.keys(next).length > 0 ? next : null);
		invalidateToolPrompt(name);
		onClose();
	};

	const reset = () => {
		onApply(name, null);
		invalidateToolPrompt(name);
		onClose();
	};

	return (
		<Modal
			className="tool-prompt-editor"
			title={`${t("toolPromptEdit")} · ${name}`}
			icon={<FiEdit3 />}
			onClose={onClose}
		>
			<div className="tool-prompt-body">
				{unavailable && <p className="set-note">{t("toolPromptUnavailable")}</p>}
				<p className="set-note">{t("toolPromptHint")}</p>

				<label className="tool-prompt-field">
					<span className="set-field-label">{t("toolPromptDescription")}</span>
					<textarea
						className="set-prompt-input"
						rows={5}
						value={description}
						placeholder={view?.defaultDescription ?? ""}
						onChange={(e) => setDescription(e.target.value)}
					/>
					{view?.defaultDescription && (
						<details className="tool-prompt-default">
							<summary>{t("toolPromptDefault")}</summary>
							<pre>{view.defaultDescription}</pre>
						</details>
					)}
				</label>

				<label className="tool-prompt-field">
					<span className="set-field-label">{t("toolPromptSnippet")}</span>
					<input
						type="text"
						className="set-input"
						value={snippet}
						placeholder={view?.defaultPromptSnippet ?? ""}
						onChange={(e) => setSnippet(e.target.value)}
					/>
					{view?.defaultPromptSnippet && (
						<details className="tool-prompt-default">
							<summary>{t("toolPromptDefault")}</summary>
							<pre>{view.defaultPromptSnippet}</pre>
						</details>
					)}
				</label>

				<label className="tool-prompt-field">
					<span className="set-field-label">{t("toolPromptGuidelines")}</span>
					<textarea
						className="set-prompt-input tool-prompt-guidelines"
						rows={4}
						value={guidelines}
						placeholder={defaultGuidelinesText}
						onChange={(e) => setGuidelines(e.target.value)}
					/>
					{defaultGuidelinesText && (
						<details className="tool-prompt-default">
							<summary>{t("toolPromptDefault")}</summary>
							<pre>{defaultGuidelinesText}</pre>
						</details>
					)}
				</label>

				<div className="tool-prompt-actions">
					<button type="button" className="btn" onClick={reset}>
						{t("toolPromptReset")}
					</button>
					<button type="button" className="btn primary" onClick={save}>
						{t("toolPromptSave")}
					</button>
				</div>
			</div>
		</Modal>
	);
}
