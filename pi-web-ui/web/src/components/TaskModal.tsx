import { memo, useEffect, useMemo, useState } from "react";
import { FiPlus } from "react-icons/fi";
import type { GoalStatus } from "../types";
import { useT } from "../i18n";
import { appSend, useIsDsh } from "../app-globals";
import { closeTaskModal, mhGet, openTaskModal, useCockpit, type TaskAcceptance } from "../loop-cockpit";
import { Modal } from "./Modal";

/** 模型下拉项（GET /api/mini-harness/models：只有 provider/id/family）。下拉值一律 "provider/id"。 */
interface LoopModel {
	provider: string;
	id: string;
	family: string;
}

/** 模板：领域里最常见的三类任务（做什么 + 可检查的完成条件）。 */
const PRESETS: Array<{
	key: "codeLoopPresetHarness" | "codeLoopPresetFile" | "codeLoopPresetTests";
	goal: string;
	crit: string;
}> = [
	{
		key: "codeLoopPresetHarness",
		goal: "跑 harness 的 perf-012g gate，生成 db_gap_gate.json 且 gate_state=ESTIMATE_READY",
		crit: "db_gap_gate.json 存在且 gate_state=ESTIMATE_READY",
	},
	{ key: "codeLoopPresetFile", goal: "在当前目录创建 result.txt，内容为 DONE", crit: "result.txt 存在且内容为 DONE" },
	{ key: "codeLoopPresetTests", goal: "运行测试直到全部通过", crit: "测试命令退出码为 0" },
];

const ACCEPT_OPTIONS: Array<{
	key: TaskAcceptance;
	label: "taskAcceptCodeReview" | "taskAcceptCode" | "taskAcceptLlm";
	desc: "taskAcceptCodeReviewDesc" | "taskAcceptCodeDesc" | "taskAcceptLlmDesc";
}> = [
	{ key: "code-review", label: "taskAcceptCodeReview", desc: "taskAcceptCodeReviewDesc" },
	{ key: "code", label: "taskAcceptCode", desc: "taskAcceptCodeDesc" },
	{ key: "llm", label: "taskAcceptLlm", desc: "taskAcceptLlmDesc" },
];

/** 「仅模型评审」把验收标准并进目标正文：与服务端 startLoop 拼启动提示词同一写法（另起一行「验收标准：…」）。 */
const withCriteria = (goal: string, criteria: string): string => (criteria ? `${goal}\n验收标准：${criteria}` : goal);

/** 输入框上沿的「新任务」胶囊：目标条折叠行（目标模式开）与 LoopBar（目标模式关）共用一份。 */
export function TaskCapsule({ label }: { label?: string }) {
	const t = useT();
	return (
		<button
			type="button"
			className="goalbar-hint loop-capsule task"
			title={t("taskPillTip")}
			onClick={() => openTaskModal()}
		>
			<FiPlus /> <span>{label ?? t("taskNew")}</span>
		</button>
	);
}

interface Props {
	/** LLM loop 的记忆偏好（规划模型 / 最多轮数 / 执行模型）从 goal_status 回填。 */
	goal: GoalStatus;
	/** 主对话当前模型：「仅模型评审」时它就是评审者。 */
	mainModel?: { id: string; name: string; provider: string } | null;
	/** 目标模式关掉时 LLM loop 不可用（服务端拒绝 set_goal），「仅模型评审」置灰。 */
	goalModeEnabled: boolean;
}

/** 统一任务入口：模板 → 做什么 → 怎么算完成 → 验收方式三选一 → 高级项。
 *  前两种验收走 mini-harness 代码 loop（loop_start_request，useReviewer 开/关）；
 *  「仅模型评审」走 GoalService 的 LLM loop（set_goal_prefs + set_goal，或「帮我细化」= start_goal_wizard）。 */
export const TaskModal = memo(function TaskModal({ goal: goalStatus, mainModel, goalModeEnabled }: Props) {
	const open = useCockpit("taskOpen");
	const prefill = useCockpit("taskPrefill");
	const t = useT();
	const isDsh = useIsDsh();
	const [goal, setGoal] = useState("");
	const [criteria, setCriteria] = useState("");
	const [acceptance, setAcceptance] = useState<TaskAcceptance>("code-review");
	// 代码 loop（mini-harness）
	const [planner, setPlanner] = useState("");
	const [reviewer, setReviewer] = useState("");
	const [precheck, setPrecheck] = useState("");
	const [cmd, setCmd] = useState("");
	const [roots, setRoots] = useState("");
	const [rounds, setRounds] = useState(5);
	// LLM loop（GoalService 偏好；空 = 使用主模型，轮数 0 = 不限）
	const [llmPlanner, setLlmPlanner] = useState("");
	const [execModel, setExecModel] = useState("");
	const [llmRounds, setLlmRounds] = useState(0);
	const [models, setModels] = useState<LoopModel[] | null>(null);

	// 带预填打开（终态条「重试」/ 详情面板「用同一目标重新开始」）：换成那条任务的目标与验收标准
	// （没带验收标准就清空），带了验收方式就切过去；不带预填就沿用上次没提交的草稿。
	useEffect(() => {
		if (!open || prefill?.goal === undefined) return;
		setGoal(prefill.goal);
		setCriteria(prefill.criteria ?? "");
		if (prefill.acceptance) setAcceptance(prefill.acceptance);
	}, [open, prefill]);

	// 每次打开都按服务端记住的 LLM loop 偏好回填（与旧目标条编辑器同源）；开着时不被推送覆盖。
	useEffect(() => {
		if (!open) return;
		setLlmPlanner(goalStatus.reviewModel ?? "");
		setExecModel(goalStatus.execModel ?? "");
		setLlmRounds(goalStatus.maxRounds > 0 ? goalStatus.maxRounds : 0);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	useEffect(() => {
		if (!open) return;
		let alive = true;
		void mhGet<{ models: LoopModel[] }>("models").then((j) => {
			if (alive) setModels(j?.models ?? []);
		});
		return () => {
			alive = false;
		};
	}, [open]);

	const familyOf = useMemo(() => {
		const m = new Map<string, string>();
		for (const x of models ?? []) m.set(`${x.provider}/${x.id}`, x.family);
		return m;
	}, [models]);

	if (!open) return null;

	// 目标模式关着时「仅模型评审」不可选（上次留下的选择也回落到默认）。
	const mode: TaskAcceptance = acceptance === "llm" && !goalModeEnabled ? "code-review" : acceptance;
	const codeMode = mode !== "llm";
	const plannerFamily = familyOf.get(planner) ?? "";
	const conflict = mode === "code-review" && !!plannerFamily && plannerFamily === (familyOf.get(reviewer) ?? "");
	const g = goal.trim();
	const c = criteria.trim();
	const canStart = !!g && !conflict;
	// 执行模型跟随主对话（空）或就选了主对话那个 = 自己审自己。
	const sameModel =
		!isDsh &&
		(!execModel ||
			(!!mainModel && (execModel === mainModel.id || execModel === `${mainModel.provider}/${mainModel.id}`)));

	/** 下拉项：模型列表；当前值不在列表里（旧偏好 / 列表没读到）时补一项，不悄悄改掉用户的选择。 */
	const modelOptions = (current: string) => (
		<>
			{current && !familyOf.has(current) && <option value={current}>{current}</option>}
			{(models ?? []).map((m) => (
				<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
					{`${m.id}（${m.family}）`}
				</option>
			))}
		</>
	);

	const finish = () => {
		setGoal("");
		setCriteria("");
		closeTaskModal();
	};

	/** LLM loop：先把本次选的偏好记下（同旧编辑器的 set_goal_prefs），再发目标 / 启动细化向导。 */
	const sendLlmPrefs = (maxRounds: number) =>
		appSend({ type: "set_goal_prefs", maxRounds, ...(isDsh ? {} : { reviewModel: llmPlanner, execModel }) });

	const start = () => {
		if (!canStart) return;
		if (mode === "llm") {
			const maxRounds = Math.max(0, Math.min(llmRounds, 50));
			sendLlmPrefs(maxRounds);
			appSend({
				type: "set_goal",
				goal: withCriteria(g, c),
				...(!isDsh && llmPlanner ? { reviewModel: llmPlanner } : {}),
				maxRounds,
				locked: true,
				...(!isDsh && execModel ? { execModel } : {}),
			});
		} else {
			const artifactRoots = roots
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			appSend({
				type: "loop_start_request",
				goal: g,
				mode: "code",
				maxRounds: rounds > 0 ? Math.min(rounds, 20) : 5,
				...(c ? { criteria: c } : {}),
				...(precheck.trim() ? { precheckCmd: precheck.trim() } : {}),
				...(cmd.trim() ? { validateCmd: cmd.trim() } : {}),
				...(artifactRoots.length ? { artifactRoots } : {}),
				...(planner ? { plannerModel: planner } : {}),
				useReviewer: mode === "code-review",
				...(mode === "code-review" && reviewer ? { reviewerModel: reviewer } : {}),
			});
		}
		finish();
	};

	/** 「帮我细化」：交给目标调研向导（先提问、再给计划确认），弹窗关掉让目标条显示向导进度。 */
	const refine = () => {
		if (!g || mode !== "llm") return;
		const maxRounds = Math.max(0, Math.min(llmRounds, 50));
		sendLlmPrefs(maxRounds);
		appSend({
			type: "start_goal_wizard",
			text: withCriteria(g, c),
			...(!isDsh && llmPlanner ? { wizardModel: llmPlanner } : {}),
			maxRounds,
			locked: true,
		});
		finish();
	};

	const note = conflict
		? t("codeLoopModelConflict", { family: plannerFamily })
		: models && models.length === 0
			? t("codeLoopModelsMissing")
			: t("codeLoopModelNote");
	return (
		<Modal className="cockpit-modal task-modal" onClose={closeTaskModal} title={t("taskNew")} icon={<FiPlus />}>
			<div className="cockpit-body">
				<p className="cockpit-sub">{t("taskDesc")}</p>
				{codeMode && <div className="cockpit-note">{t("codeLoopEnvNote")}</div>}
				<div className="cockpit-presets">
					{PRESETS.map((p) => (
						<button
							key={p.key}
							type="button"
							className="cockpit-preset"
							onClick={() => {
								setGoal(p.goal);
								setCriteria(p.crit);
							}}
						>
							{t(p.key)}
						</button>
					))}
				</div>
				<label className="cockpit-label" htmlFor="task-goal">
					{t("codeLoopGoalLabel")}
				</label>
				<textarea
					id="task-goal"
					className="cockpit-input"
					rows={3}
					autoFocus
					value={goal}
					placeholder={t("codeLoopGoalPh")}
					onChange={(e) => setGoal(e.target.value)}
				/>
				<label className="cockpit-label" htmlFor="task-criteria">
					{t("codeLoopCriteriaLabel")}
				</label>
				<textarea
					id="task-criteria"
					className="cockpit-input"
					rows={2}
					value={criteria}
					placeholder={t("codeLoopCriteriaPh")}
					onChange={(e) => setCriteria(e.target.value)}
				/>
				<div className="cockpit-label" id="task-accept-label">
					{t("taskAcceptLabel")}
				</div>
				<div className="task-accept" role="radiogroup" aria-labelledby="task-accept-label">
					{ACCEPT_OPTIONS.map((o) => {
						const off = o.key === "llm" && !goalModeEnabled;
						return (
							<label
								key={o.key}
								className={`task-accept-opt${mode === o.key ? " on" : ""}${off ? " off" : ""}`}
								title={off ? t("taskLlmOff") : undefined}
							>
								<input
									type="radio"
									name="task-accept"
									value={o.key}
									checked={mode === o.key}
									disabled={off}
									onChange={() => setAcceptance(o.key)}
								/>
								<span className="task-accept-text">
									<span className="task-accept-name">
										{t(o.label)}
										{o.key === "code-review" && <em className="task-accept-tag">{t("taskAcceptRecommended")}</em>}
									</span>
									<span className="task-accept-desc">{off ? t("taskLlmOff") : t(o.desc)}</span>
								</span>
							</label>
						);
					})}
				</div>
				{codeMode ? (
					<>
						<div className="cockpit-models">
							<div>
								<label className="cockpit-label" htmlFor="task-planner">
									{t("codeLoopPlanner")}
								</label>
								<select
									id="task-planner"
									className="cockpit-input"
									value={planner}
									onChange={(e) => setPlanner(e.target.value)}
								>
									<option value="">{t("codeLoopAuto")}</option>
									{modelOptions(planner)}
								</select>
							</div>
							{mode === "code-review" && (
								<div>
									<label className="cockpit-label" htmlFor="task-reviewer">
										{t("codeLoopReviewer")}
									</label>
									<select
										id="task-reviewer"
										className="cockpit-input"
										value={reviewer}
										onChange={(e) => setReviewer(e.target.value)}
									>
										<option value="">{t("codeLoopAuto")}</option>
										{modelOptions(reviewer)}
									</select>
								</div>
							)}
						</div>
						<div className={`cockpit-model-note${conflict ? " bad" : ""}`}>{note}</div>
					</>
				) : isDsh ? (
					<div className="cockpit-model-note">{t("dshNoReviewModel")}</div>
				) : (
					<>
						<div className="cockpit-models">
							<div>
								<label className="cockpit-label" htmlFor="task-llm-planner">
									{t("codeLoopPlanner")}
								</label>
								<select
									id="task-llm-planner"
									className="cockpit-input"
									value={llmPlanner}
									onChange={(e) => setLlmPlanner(e.target.value)}
								>
									<option value="">{t("goalBarUseMainModel")}</option>
									{modelOptions(llmPlanner)}
								</select>
							</div>
							<div>
								<label className="cockpit-label" htmlFor="task-exec" title={t("goalBarExecModelTip")}>
									{t("goalBarExecModel")}
								</label>
								<select
									id="task-exec"
									className="cockpit-input"
									value={execModel}
									onChange={(e) => setExecModel(e.target.value)}
								>
									<option value="">{t("goalBarUseMainModel")}</option>
									{modelOptions(execModel)}
								</select>
							</div>
						</div>
						<div className="cockpit-model-note">{t("taskLlmReviewer", { name: mainModel?.name ?? "—" })}</div>
						{sameModel && <div className="cockpit-model-note warn">{t("goalSameModelWarn")}</div>}
					</>
				)}
				<details className="cockpit-adv">
					<summary>{t("codeLoopAdvanced")}</summary>
					{codeMode && (
						<>
							<label className="cockpit-label" htmlFor="task-precheck">
								{t("codeLoopPrecheck")}
							</label>
							<input
								id="task-precheck"
								className="cockpit-input"
								value={precheck}
								placeholder={t("codeLoopPrecheckPh")}
								onChange={(e) => setPrecheck(e.target.value)}
							/>
							<label className="cockpit-label" htmlFor="task-cmd">
								{t("codeLoopCmd")}
							</label>
							<input
								id="task-cmd"
								className="cockpit-input"
								value={cmd}
								placeholder={t("codeLoopCmdPh")}
								onChange={(e) => setCmd(e.target.value)}
							/>
							<label className="cockpit-label" htmlFor="task-roots">
								{t("codeLoopRoots")}
							</label>
							<input
								id="task-roots"
								className="cockpit-input"
								value={roots}
								placeholder="/external/runs/xxx"
								onChange={(e) => setRoots(e.target.value)}
							/>
						</>
					)}
					<label
						className="cockpit-label"
						htmlFor="task-rounds"
						title={codeMode ? undefined : t("goalBarMaxRoundsTip")}
					>
						{t("codeLoopRounds")}
					</label>
					{codeMode ? (
						<input
							id="task-rounds"
							className="cockpit-input"
							type="number"
							min={1}
							max={20}
							value={rounds}
							onChange={(e) => {
								const v = parseInt(e.target.value, 10);
								setRounds(Number.isNaN(v) ? 5 : Math.max(1, Math.min(20, v)));
							}}
						/>
					) : (
						<input
							id="task-rounds"
							className="cockpit-input"
							type="number"
							min={0}
							max={50}
							value={llmRounds || ""}
							placeholder={t("goalBarUnlimitedShort")}
							title={t("goalBarMaxRoundsTip")}
							onChange={(e) => {
								const v = parseInt(e.target.value, 10);
								setLlmRounds(Number.isNaN(v) ? 0 : Math.max(0, Math.min(50, v)));
							}}
						/>
					)}
				</details>
				<div className="cockpit-row">
					<button type="button" className="btn" onClick={closeTaskModal}>
						{t("cancel")}
					</button>
					{mode === "llm" && (
						<button type="button" className="btn task-refine" disabled={!g} title={t("goalWizardTip")} onClick={refine}>
							{t("goalWizardBtn")}
						</button>
					)}
					<button type="button" className="btn primary" disabled={!canStart} onClick={start}>
						{t("goalBarSet")}
					</button>
				</div>
			</div>
		</Modal>
	);
});
