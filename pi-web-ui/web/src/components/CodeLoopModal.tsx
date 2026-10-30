import { memo, useEffect, useMemo, useState } from "react";
import { FiCode } from "react-icons/fi";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { closeCodeLoop, mhGet, useCockpit } from "../loop-cockpit";
import { Modal } from "./Modal";

/** 代码 loop 表单的模型下拉项（GET /api/mini-harness/models：只有 provider/id/family）。 */
interface LoopModel {
	provider: string;
	id: string;
	family: string;
}

/** 预设：领域里最常见的三类代码 loop（目标 + 可检查的验收条件）。 */
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

const NO_REVIEW = "__none__";

/** 代码 loop（validator 门禁运行时）的启动弹窗：输入框上方「代码 loop」胶囊 / 目标条里的入口打开它。
 *  提交走 loop_start_request（服务端先落挂起记录再发启动提示词，失败有明确原因）。 */
export const CodeLoopModal = memo(function CodeLoopModal() {
	const open = useCockpit("codeLoopOpen");
	const prefill = useCockpit("codeLoopPrefill");
	const t = useT();
	const [goal, setGoal] = useState("");
	const [criteria, setCriteria] = useState("");
	const [planner, setPlanner] = useState("");
	const [reviewer, setReviewer] = useState("");
	const [cmd, setCmd] = useState("");
	const [roots, setRoots] = useState("");
	const [rounds, setRounds] = useState(5);
	const [models, setModels] = useState<LoopModel[] | null>(null);

	useEffect(() => {
		if (open && prefill) setGoal(prefill);
	}, [open, prefill]);

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
	const plannerFamily = familyOf.get(planner) ?? "";
	const reviewerFamily = reviewer === NO_REVIEW ? "" : (familyOf.get(reviewer) ?? "");
	const conflict = !!plannerFamily && plannerFamily === reviewerFamily;

	if (!open) return null;

	const close = () => closeCodeLoop();
	const start = () => {
		const g = goal.trim();
		if (!g || conflict) return;
		const artifactRoots = roots
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		appSend({
			type: "loop_start_request",
			goal: g,
			mode: "code",
			maxRounds: rounds > 0 ? Math.min(rounds, 20) : 5,
			...(criteria.trim() ? { criteria: criteria.trim() } : {}),
			...(cmd.trim() ? { validateCmd: cmd.trim() } : {}),
			...(artifactRoots.length ? { artifactRoots } : {}),
			...(planner ? { plannerModel: planner } : {}),
			...(reviewer === NO_REVIEW ? { useReviewer: false } : reviewer ? { reviewerModel: reviewer } : {}),
		});
		setGoal("");
		setCriteria("");
		close();
	};

	const note = conflict
		? t("codeLoopModelConflict", { family: plannerFamily })
		: models && models.length === 0
			? t("codeLoopModelsMissing")
			: t("codeLoopModelNote");

	return (
		<Modal className="cockpit-modal code-loop-modal" onClose={close} title={t("codeLoopTitle")} icon={<FiCode />}>
			<div className="cockpit-body">
				<p className="cockpit-sub">{t("codeLoopDesc")}</p>
				<div className="cockpit-note">{t("codeLoopEnvNote")}</div>
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
				<label className="cockpit-label" htmlFor="cl-goal">
					{t("codeLoopGoalLabel")}
				</label>
				<textarea
					id="cl-goal"
					className="cockpit-input"
					rows={3}
					autoFocus
					value={goal}
					placeholder={t("codeLoopGoalPh")}
					onChange={(e) => setGoal(e.target.value)}
				/>
				<label className="cockpit-label" htmlFor="cl-criteria">
					{t("codeLoopCriteriaLabel")}
				</label>
				<textarea
					id="cl-criteria"
					className="cockpit-input"
					rows={2}
					value={criteria}
					placeholder={t("codeLoopCriteriaPh")}
					onChange={(e) => setCriteria(e.target.value)}
				/>
				<div className="cockpit-models">
					<div>
						<label className="cockpit-label" htmlFor="cl-planner">
							{t("codeLoopPlanner")}
						</label>
						<select
							id="cl-planner"
							className="cockpit-input"
							value={planner}
							onChange={(e) => setPlanner(e.target.value)}
						>
							<option value="">{t("codeLoopAuto")}</option>
							{(models ?? []).map((m) => (
								<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
									{`${m.id}（${m.family}）`}
								</option>
							))}
						</select>
					</div>
					<div>
						<label className="cockpit-label" htmlFor="cl-reviewer">
							{t("codeLoopReviewer")}
						</label>
						<select
							id="cl-reviewer"
							className="cockpit-input"
							value={reviewer}
							onChange={(e) => setReviewer(e.target.value)}
						>
							<option value="">{t("codeLoopAuto")}</option>
							<option value={NO_REVIEW}>{t("codeLoopNoReview")}</option>
							{(models ?? []).map((m) => (
								<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
									{`${m.id}（${m.family}）`}
								</option>
							))}
						</select>
					</div>
				</div>
				<div className={`cockpit-model-note${conflict ? " bad" : ""}`}>{note}</div>
				<details className="cockpit-adv">
					<summary>{t("codeLoopAdvanced")}</summary>
					<label className="cockpit-label" htmlFor="cl-cmd">
						{t("codeLoopCmd")}
					</label>
					<input
						id="cl-cmd"
						className="cockpit-input"
						value={cmd}
						placeholder={t("codeLoopCmdPh")}
						onChange={(e) => setCmd(e.target.value)}
					/>
					<label className="cockpit-label" htmlFor="cl-roots">
						{t("codeLoopRoots")}
					</label>
					<input
						id="cl-roots"
						className="cockpit-input"
						value={roots}
						placeholder="/external/runs/xxx"
						onChange={(e) => setRoots(e.target.value)}
					/>
					<label className="cockpit-label" htmlFor="cl-rounds">
						{t("codeLoopRounds")}
					</label>
					<input
						id="cl-rounds"
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
				</details>
				<div className="cockpit-row">
					<button type="button" className="btn" onClick={close}>
						{t("cancel")}
					</button>
					<button type="button" className="btn primary" disabled={!goal.trim() || conflict} onClick={start}>
						{t("codeLoopStart")}
					</button>
				</div>
			</div>
		</Modal>
	);
});
