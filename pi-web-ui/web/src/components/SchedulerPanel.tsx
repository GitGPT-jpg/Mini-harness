import { useEffect, useState } from "react";
import { FiClock, FiEdit3, FiPlay, FiPlus, FiTrash2, FiX } from "react-icons/fi";
import type { SchedulerTaskView, UiVisionBridgeModel } from "../types";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { THINKING_VALUES } from "../thinking-levels";
import { HintTip } from "./HintTip";

interface SchedulerPanelProps {
	tasks: SchedulerTaskView[];
	/** 当前项目（新建任务时一键填入）。 */
	cwd: string;
	/** 可选模型（与子代理模板编辑器同一来源：settings.subagentModels）。 */
	models: UiVisionBridgeModel[];
}

const CRON_PRESETS: { value: string; key: string }[] = [
	{ value: "0 9 * * *", key: "schedulerPresetDaily" },
	{ value: "0 * * * *", key: "schedulerPresetHourly" },
	{ value: "*/30 * * * *", key: "schedulerPresetHalfHour" },
	{ value: "0 9 * * 1-5", key: "schedulerPresetWorkday" },
	{ value: "0 9 * * 1", key: "schedulerPresetMonday" },
];

interface Draft {
	id: string;
	name: string;
	description: string;
	cwd: string;
	kind: "cron" | "interval";
	cron: string;
	preset: string;
	intervalMinutes: string;
	prompt: string;
	model: string;
	thinkingLevel: string;
	catchUp: boolean;
}

function blankDraft(cwd: string): Draft {
	return {
		id: "",
		name: "",
		description: "",
		cwd,
		kind: "cron",
		cron: "0 9 * * *",
		preset: "0 9 * * *",
		intervalMinutes: "60",
		prompt: "",
		model: "",
		thinkingLevel: "",
		catchUp: false,
	};
}

function draftFromTask(t: SchedulerTaskView): Draft {
	const presetHit = t.kind === "cron" && CRON_PRESETS.some((p) => p.value === t.spec);
	return {
		id: t.id,
		name: t.name,
		description: t.description,
		cwd: t.cwd,
		kind: t.kind,
		cron: t.kind === "cron" ? t.spec : "0 9 * * *",
		preset: presetHit ? t.spec : "custom",
		intervalMinutes: t.kind === "interval" ? String(Math.max(1, Math.round(Number(t.spec) / 60000))) : "60",
		prompt: t.prompt,
		model: t.model,
		thinkingLevel: t.thinkingLevel,
		catchUp: t.catchUp === "once",
	};
}

/** 调度规格一句话（列表行展示用）。 */
function specSummary(t: SchedulerTaskView, tr: ReturnType<typeof useT>): string {
	if (t.kind === "interval") {
		const min = Math.round(Number(t.spec) / 60000);
		if (min < 60) return `${tr("schedulerKindInterval")} · ${min} min`;
		if (min % 60 === 0) return `${tr("schedulerKindInterval")} · ${min / 60} h`;
		return `${tr("schedulerKindInterval")} · ${min} min`;
	}
	const hit = CRON_PRESETS.find((p) => p.value === t.spec);
	if (hit) return tr(hit.key as Parameters<typeof tr>[0]);
	return t.spec;
}

function formatTime(ts: number | null): string {
	if (!ts) return "";
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return String(ts);
	}
}

/**
 * 内置定时任务管理（issue #184）：任务列表（下次触发/上次状态/手动执行/
 * 启用停用/历史）+ 新建/编辑表单。全部经 schedule_* wire 消息走服务端
 * SchedulerStore（<dataDir>/scheduler-tasks.json 全局持久化）。
 */
export function SchedulerPanel({ tasks, cwd, models }: SchedulerPanelProps) {
	const t = useT();
	const [draft, setDraft] = useState<Draft | null>(null);
	const [isNew, setIsNew] = useState(false);
	const [openHistory, setOpenHistory] = useState<Set<string>>(new Set());

	// 打开面板即向服务端要一份新鲜列表（重连/别处改动后对齐）。
	useEffect(() => {
		appSend({ type: "schedule_list" });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const toggleHistory = (id: string) =>
		setOpenHistory((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	const save = () => {
		if (!draft) return;
		const kind = draft.kind;
		appSend({
			type: "schedule_save",
			task: {
				...(draft.id ? { id: draft.id } : {}),
				name: draft.name.trim(),
				description: draft.description.trim(),
				cwd: draft.cwd.trim(),
				kind,
				spec:
					kind === "cron"
						? draft.cron.trim()
						: String(Math.max(1, Math.floor(Number(draft.intervalMinutes) || 0)) * 60000),
				prompt: draft.prompt.trim(),
				...(draft.model.trim() ? { model: draft.model.trim() } : {}),
				...(draft.thinkingLevel.trim() ? { thinkingLevel: draft.thinkingLevel.trim() } : {}),
				catchUp: draft.catchUp ? "once" : "skip",
			},
		});
		setDraft(null);
	};

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiClock className="set-section-icon" />
				{t("settingsScheduler")}
				<HintTip text={t("schedulerDesc")} />
				<span className="set-count">{tasks.length}</span>
				<button
					type="button"
					className="set-save-btn"
					title={t("schedulerNew")}
					onClick={() => {
						setDraft(blankDraft(cwd));
						setIsNew(true);
					}}
				>
					<FiPlus /> {t("schedulerNew")}
				</button>
			</div>

			{tasks.length === 0 ? (
				<p className="set-hint">{t("schedulerEmpty")}</p>
			) : (
				<ul className="scheduler-list">
					{tasks.map((task) => (
						<li key={task.id} className={`scheduler-item ${task.enabled ? "" : "off"}`}>
							<div className="scheduler-line1">
								<span className="scheduler-name" title={task.description || task.name}>
									{task.running ? `${t("schedulerRunning")} ` : ""}
									{task.name}
								</span>
								<span className={`scheduler-badge ${task.enabled ? "on" : ""}`}>
									{task.enabled ? t("schedulerEnabled") : t("schedulerDisabled")}
								</span>
								<button
									type="button"
									className={`set-switch ${task.enabled ? "on" : ""}`}
									title={task.enabled ? t("schedulerDisable") : t("schedulerEnable")}
									onClick={() => appSend({ type: "schedule_toggle", id: task.id, enabled: !task.enabled })}
								>
									<span className="set-switch-knob" />
								</button>
							</div>
							<div className="scheduler-line2">
								<span title={task.cwd}>{task.cwd}</span>
								<span>·</span>
								<span title={task.kind === "cron" ? task.spec : `${task.spec} ms`}>{specSummary(task, t)}</span>
							</div>
							<div className="scheduler-line2">
								<span>
									{t("schedulerNextFire")}: {task.nextFire ? formatTime(task.nextFire) : "—"}
								</span>
								<span>·</span>
								<span>
									{t("schedulerLastRun")}:{" "}
									{task.lastRun ? (
										<>
											{formatTime(task.lastRun.at)} ·{" "}
											<span className={task.lastRun.ok ? "scheduler-ok" : "scheduler-fail"}>
												{task.lastRun.ok ? t("schedulerRunOk") : t("schedulerRunFail")}
											</span>
											{task.lastRun.manual ? ` · ${t("schedulerManualBadge")}` : ""}
											{task.lastRun.error ? ` · ${task.lastRun.error}` : ""}
										</>
									) : (
										t("schedulerNeverRun")
									)}
								</span>
								{task.history.length > 1 && (
									<button type="button" className="scheduler-link" onClick={() => toggleHistory(task.id)}>
										{t("schedulerHistory")} ({task.history.length})
									</button>
								)}
							</div>
							{openHistory.has(task.id) && task.history.length > 0 && (
								<ul className="scheduler-history">
									{task.history.map((h, i) => (
										<li key={`${h.at}-${i}`}>
											{formatTime(h.at)} ·{" "}
											<span className={h.ok ? "scheduler-ok" : "scheduler-fail"}>
												{h.ok ? t("schedulerRunOk") : t("schedulerRunFail")}
											</span>
											{` · ${(h.durationMs / 1000).toFixed(0)}s`}
											{h.manual ? ` · ${t("schedulerManualBadge")}` : ""}
											{h.error ? ` · ${h.error}` : ""}
										</li>
									))}
								</ul>
							)}
							<div className="scheduler-actions">
								<button
									type="button"
									className="btn"
									disabled={task.running}
									title={t("schedulerRunNow")}
									onClick={() => appSend({ type: "schedule_run", id: task.id })}
								>
									<FiPlay /> {t("schedulerRunNow")}
								</button>
								<button
									type="button"
									className="btn"
									title={t("schedulerEdit")}
									onClick={() => {
										setDraft(draftFromTask(task));
										setIsNew(false);
									}}
								>
									<FiEdit3 /> {t("schedulerEdit")}
								</button>
								<button
									type="button"
									className="btn"
									title={t("schedulerDelete")}
									onClick={() => {
										if (window.confirm(t("schedulerConfirmDelete", { name: task.name })))
											appSend({ type: "schedule_delete", id: task.id });
									}}
								>
									<FiTrash2 /> {t("schedulerDelete")}
								</button>
							</div>
						</li>
					))}
				</ul>
			)}

			{draft && (
				<div className="modal-backdrop" onClick={() => setDraft(null)}>
					<div className="modal" onClick={(e) => e.stopPropagation()}>
						<button type="button" className="modal-close" aria-label={t("close")} onClick={() => setDraft(null)}>
							<FiX />
						</button>
						<div className="modal-head">
							<FiClock className="modal-head-icon" />
							<h2>{isNew ? t("schedulerNew") : `${t("schedulerEdit")} · ${draft.name || ""}`}</h2>
						</div>
						<div className="modal-body">
							<div className="tpl-fields">
								<input
									className="set-input"
									placeholder={t("schedulerNamePlaceholder")}
									value={draft.name}
									onChange={(e) => setDraft({ ...draft, name: e.target.value })}
								/>
								<input
									className="set-input"
									placeholder={t("schedulerDescPlaceholder")}
									value={draft.description}
									onChange={(e) => setDraft({ ...draft, description: e.target.value })}
								/>
							</div>
							<div className="set-mode-row">
								<label className="set-field-label">{t("schedulerCwdLabel")}</label>
								<div className="scheduler-cwd-row">
									<input
										className="set-input"
										placeholder={t("schedulerCwdPlaceholder")}
										value={draft.cwd}
										onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
									/>
									<button type="button" className="btn" onClick={() => setDraft({ ...draft, cwd })}>
										{t("schedulerUseCurrentCwd")}
									</button>
								</div>
							</div>
							<div className="set-mode-row">
								<label className="set-field-label">{t("schedulerKindLabel")}</label>
								<select
									className="set-select"
									value={draft.kind}
									onChange={(e) => setDraft({ ...draft, kind: e.target.value as "cron" | "interval" })}
								>
									<option value="cron">{t("schedulerKindCron")}</option>
									<option value="interval">{t("schedulerKindInterval")}</option>
								</select>
							</div>
							{draft.kind === "cron" ? (
								<div className="set-mode-row">
									<label className="set-field-label">{t("schedulerKindCron")}</label>
									<div className="scheduler-cwd-row">
										<select
											className="set-select"
											value={draft.preset}
											onChange={(e) => {
												const v = e.target.value;
												setDraft({ ...draft, preset: v, ...(v !== "custom" ? { cron: v } : {}) });
											}}
										>
											{CRON_PRESETS.map((p) => (
												<option key={p.value} value={p.value}>
													{t(p.key as Parameters<typeof t>[0])} · {p.value}
												</option>
											))}
											<option value="custom">{t("schedulerPresetCustom")}</option>
										</select>
										{draft.preset === "custom" && (
											<input
												className="set-input"
												placeholder={t("schedulerCronPlaceholder")}
												value={draft.cron}
												onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
											/>
										)}
									</div>
								</div>
							) : (
								<div className="set-mode-row">
									<label className="set-field-label">{t("schedulerKindInterval")}</label>
									<input
										className="set-input"
										type="number"
										min={1}
										placeholder={t("schedulerIntervalMinutes")}
										value={draft.intervalMinutes}
										onChange={(e) => setDraft({ ...draft, intervalMinutes: e.target.value })}
									/>
								</div>
							)}
							<div className="tpl-fields">
								<textarea
									className="set-input"
									rows={4}
									placeholder={t("schedulerPromptPlaceholder")}
									value={draft.prompt}
									onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
								/>
							</div>
							<div className="set-mode-row">
								<label className="set-field-label">{t("schedulerModelLabel")}</label>
								<select
									className="set-select"
									value={draft.model}
									onChange={(e) => setDraft({ ...draft, model: e.target.value })}
								>
									<option value="">{t("subagentFollowMain")}</option>
									{models.map((m) => (
										<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
											{m.label}
										</option>
									))}
								</select>
							</div>
							{models.length === 0 && <p className="set-hint">{t("subagentNoModels")}</p>}
							<div className="set-mode-row">
								<label className="set-field-label">
									{t("schedulerThinkingLabel")} <HintTip text={t("tplThinkingHint")} />
								</label>
								<select
									className="set-select"
									value={draft.thinkingLevel}
									onChange={(e) => setDraft({ ...draft, thinkingLevel: e.target.value })}
								>
									<option value="">{t("tplThinkingFollowMain")}</option>
									{THINKING_VALUES.map((v) => (
										<option key={v} value={v}>
											{t(`thinking.${v}`)}
										</option>
									))}
								</select>
							</div>
							<label className="scheduler-check">
								<input
									type="checkbox"
									checked={draft.catchUp}
									onChange={(e) => setDraft({ ...draft, catchUp: e.target.checked })}
								/>
								<span>
									{t("schedulerCatchUp")} <HintTip text={t("schedulerCatchUpHint")} />
								</span>
							</label>
							<div className="scheduler-foot">
								<button type="button" className="btn" onClick={() => setDraft(null)}>
									{t("schedulerCancelEdit")}
								</button>
								<button
									type="button"
									className="btn primary"
									disabled={!draft.name.trim() || !draft.cwd.trim() || !draft.prompt.trim()}
									onClick={save}
								>
									{t("schedulerSave")}
								</button>
							</div>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
