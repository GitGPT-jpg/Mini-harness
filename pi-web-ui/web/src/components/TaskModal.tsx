import { memo, useEffect, useMemo, useState } from "react";
import { FiPlus } from "react-icons/fi";
import type { GoalStatus } from "../types";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { closeTaskModal, mhGet, mhPost, openTaskModal, useCockpit, type TaskAcceptance } from "../loop-cockpit";
import { Modal } from "./Modal";

/** 模型下拉项（GET /api/mini-harness/models：只有 provider/id/family）。下拉值一律 "provider/id"。 */
interface LoopModel {
	provider: string;
	id: string;
	family: string;
}

/** 能力模板（GET /api/mini-harness/packs）：一键填充任务语义与主指标，不携带可执行命令。 */
interface CapabilityPack {
	id: string;
	title: string;
	summary: string;
	goal: string;
	criteria: string;
	primaryMetric?: string | null;
	metricDirection?: "maximize" | "minimize" | null;
	maxRounds?: number;
	useReviewer?: boolean;
}

/** POST /api/mini-harness/discover 的响应（只读上下文发现）。 */
interface DiscoveryInput {
	id: string;
	label: string;
	required?: boolean;
	source: string;
	value: string | null;
	sourceOf: string;
}
interface DiscoveryResult {
	summary: string;
	context?: {
		packVersion?: string | null;
		error?: string | null;
		inputs?: DiscoveryInput[];
		missing?: DiscoveryInput[];
		conflicts?: Array<{ inputId: string; defaultValue: string; resolvedValue: string; source: string }>;
	} | null;
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

type RoleName = "planner" | "executor" | "reviewer";
interface RoleModelView {
	provider?: string;
	id: string;
	family: string;
	source: "explicit" | "main" | "auto";
}
type RoleSuggestion = { role: RoleName; provider?: string; id: string; family: string };
/** POST /api/mini-harness/roles（server/loop/model-roles.ts）：各角色实际生效的模型与家族冲突。 */
interface RoleResolution {
	ok: boolean;
	roles: Record<RoleName, RoleModelView | null>;
	conflicts: Array<{ roles: [RoleName, RoleName]; family: string; models: [string, string] }>;
	error: { code: "unresolved" | "no-candidate" | "no-main"; role: RoleName } | null;
	suggestion: RoleSuggestion | null;
	executorSuggestion?: RoleSuggestion | null;
}
const isResolution = (v: unknown): v is RoleResolution =>
	!!v && typeof (v as RoleResolution).ok === "boolean" && Array.isArray((v as RoleResolution).conflicts);
const specOf = (m: { provider?: string; id: string }) => (m.provider ? `${m.provider}/${m.id}` : m.id);
/** 选择器里的「自动」：与服务端 model-roles.ts 的 AUTO_MODEL 同值。 */
const AUTO = "auto";
/** 各验收方式里必须两两不同家族的角色对（与服务端 model-roles.ts 的 ISOLATED 一致）。 */
const ROLE_PAIRS: Record<TaskAcceptance, Array<[RoleName, RoleName]>> = {
	"code-review": [
		["executor", "planner"],
		["executor", "reviewer"],
		["planner", "reviewer"],
	],
	code: [["executor", "planner"]],
	llm: [["executor", "reviewer"]],
};

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
	const [goal, setGoal] = useState("");
	const [criteria, setCriteria] = useState("");
	const [acceptance, setAcceptance] = useState<TaskAcceptance>("code-review");
	// 代码 loop（mini-harness）
	// 三个角色的选择：AUTO = 联立自动分配（服务端按家族规则两两隔离），其余为 "provider/id"。
	const [planner, setPlanner] = useState(AUTO);
	const [executor, setExecutor] = useState(AUTO);
	const [reviewer, setReviewer] = useState(AUTO);
	const [precheck, setPrecheck] = useState("");
	const [cmd, setCmd] = useState("");
	const [roots, setRoots] = useState("");
	const [rounds, setRounds] = useState(5);
	const [primaryMetric, setPrimaryMetric] = useState("");
	const [metricDirection, setMetricDirection] = useState<"" | "maximize" | "minimize">("");
	const [metricPrecision, setMetricPrecision] = useState("");
	const [packs, setPacks] = useState<CapabilityPack[] | null>(null);
	const [packId, setPackId] = useState("");
	const [worktree, setWorktree] = useState(true);
	// 上下文发现（A 链路）：项目位置 + 能力模板 → 只读发现 → 只问缺口。
	const [workspace, setWorkspace] = useState("");
	const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
	const [discovering, setDiscovering] = useState(false);
	const [extraInputs, setExtraInputs] = useState<Record<string, string>>({});
	// LLM loop（GoalService 偏好；空 = 使用主模型，轮数 0 = 不限）
	const [llmPlanner, setLlmPlanner] = useState(AUTO);
	const [execModel, setExecModel] = useState(AUTO);
	const [llmReviewer, setLlmReviewer] = useState(AUTO);
	const [llmRounds, setLlmRounds] = useState(0);
	const [models, setModels] = useState<LoopModel[] | null>(null);
	const [resolved, setResolved] = useState<{ key: string; r: RoleResolution } | null>(null);
	// 服务端 goal_status 带 reviewerModel 字段 = 审查角色可选且会传到真正审查的主对话回合；
	// 旧服务端没有该字段时不显示审查下拉（否则选了也不生效），审查仍是主对话当前模型。
	const reviewerSelectable = "reviewerModel" in goalStatus;

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
		// 旧偏好里的空值（跟随主对话）一律显示为「自动」：自动分配同样优先主对话模型。
		setLlmPlanner(goalStatus.reviewModel || AUTO);
		setExecModel(goalStatus.execModel || AUTO);
		setLlmReviewer(goalStatus.reviewerModel || AUTO);
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

	useEffect(() => {
		if (!open) return;
		let alive = true;
		void mhGet<{ packs: CapabilityPack[] }>("packs").then((j) => {
			if (alive) setPacks(j?.packs ?? []);
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

	// 只读上下文发现：包 + 项目位置 → 服务端返回「已确认 / 缺失 / 冲突」，只问缺口。
	// 注意：hooks 必须落在 `if (!open) return null` 之前，否则挂载/重渲染的 hook 数不一致。
	useEffect(() => {
		if (!packId || !workspace.trim()) {
			setDiscovery(null);
			return;
		}
		let alive = true;
		const id = setTimeout(() => {
			void mhPost<DiscoveryResult>("discover", {
				packId,
				workspace: workspace.trim(),
				inputs: extraInputs,
				validateCmd: cmd,
				precheckCmd: precheck,
			}).then((r) => {
				if (!alive) return;
				setDiscovering(false);
				setDiscovery(r?.data ?? null);
			});
		}, 300);
		setDiscovering(true);
		return () => {
			alive = false;
			clearTimeout(id);
		};
	}, [packId, workspace, extraInputs, cmd, precheck]);

	// 目标模式关着时「仅模型评审」不可选（上次留下的选择也回落到默认）。
	const mode: TaskAcceptance = acceptance === "llm" && !goalModeEnabled ? "code-review" : acceptance;
	const mainSpec = mainModel ? `${mainModel.provider}/${mainModel.id}` : "";
	// 各角色实际生效的模型与家族冲突由服务端按启动时同一套规则解析（显式选择 / 主模型默认 / 自动挑选）。
	const roleKey = JSON.stringify(
		mode === "llm"
			? {
					mode,
					main: mainSpec,
					planner: llmPlanner,
					executor: execModel,
					reviewer: reviewerSelectable ? llmReviewer : "",
				}
			: { mode, main: mainSpec, planner, executor, reviewer: mode === "code-review" ? reviewer : "" },
	);
	useEffect(() => {
		if (!open) return;
		let alive = true;
		const id = setTimeout(() => {
			void mhPost<RoleResolution>("roles", JSON.parse(roleKey)).then((res) => {
				if (alive && res?.ok && isResolution(res.data)) setResolved({ key: roleKey, r: res.data });
			});
		}, 150);
		return () => {
			alive = false;
			clearTimeout(id);
		};
	}, [open, roleKey]);

	if (!open) return null;

	const codeMode = mode !== "llm";
	const resolution = resolved?.key === roleKey ? resolved.r : null;
	// 服务端结果没到（或旧服务端没有该接口）时，先用模型列表里服务端给的家族比较显式选择与主模型。
	const famOf = (spec: string) => familyOf.get(spec) ?? "";
	const mainFam = famOf(mainSpec);
	// 只比较已确定的模型：显式选择，以及旧服务端上固定为主对话的审查；「自动」交给服务端联立分配。
	const famOfChoice = (v: string) => (v && v !== AUTO ? famOf(v) : "");
	const localConflict = ((): { roles: [RoleName, RoleName]; family: string } | null => {
		const picked: Record<RoleName, string> =
			mode === "llm"
				? {
						planner: "",
						// 旧服务端：审查固定是主对话，执行的「自动」也按跟随主对话发出
						executor: !reviewerSelectable && execModel === AUTO ? mainFam : famOfChoice(execModel),
						reviewer: reviewerSelectable ? famOfChoice(llmReviewer) : mainFam,
					}
				: {
						planner: famOfChoice(planner),
						executor: famOfChoice(executor),
						reviewer: mode === "code-review" ? famOfChoice(reviewer) : "",
					};
		for (const [a, b] of ROLE_PAIRS[mode]) {
			if (picked[a] && picked[a] === picked[b]) return { roles: [a, b], family: picked[a] };
		}
		return null;
	})();
	const blocked = resolution ? !resolution.ok : !!localConflict;
	const g = goal.trim();
	const c = criteria.trim();
	const canStart = !!g && !blocked;

	/** 下拉项：模型列表；当前值不在列表里（旧偏好 / 列表没读到）时补一项，不悄悄改掉用户的选择。 */
	const modelOptions = (current: string) => (
		<>
			{current && current !== AUTO && !familyOf.has(current) && <option value={current}>{current}</option>}
			{(models ?? []).map((m) => (
				<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
					{`${m.id}（${m.family}）`}
				</option>
			))}
		</>
	);

	/** 一个角色的选择器：「自动」（联立分配）+ 模型列表。三个角色并排。 */
	const roleSelect = (id: string, label: string, value: string, onChange: (v: string) => void, tip?: string) => (
		<div>
			<label className="cockpit-label" htmlFor={id} title={tip}>
				{label}
			</label>
			<select id={id} className="cockpit-input" value={value} onChange={(e) => onChange(e.target.value)}>
				<option value={AUTO}>{t("taskRoleAutoOption")}</option>
				{modelOptions(value)}
			</select>
		</div>
	);

	const finish = () => {
		setGoal("");
		setCriteria("");
		closeTaskModal();
	};

	/** 选中能力模板：一键填充任务语义与主指标，验收命令仍由用户明确填写。 */
	const applyPack = (id: string) => {
		setPackId(id);
		if (!id) return;
		const p = (packs ?? []).find((x) => x.id === id);
		if (!p) return;
		setGoal(p.goal);
		setCriteria(p.criteria);
		setPrimaryMetric(p.primaryMetric ?? "");
		setMetricDirection(p.metricDirection ?? "");
		if (p.maxRounds) setRounds(p.maxRounds);
		if (p.useReviewer != null) setAcceptance(p.useReviewer ? "code-review" : "code");
	};

	/** LLM loop：先把本次选的偏好记下（同旧编辑器的 set_goal_prefs），再发目标 / 启动细化向导。 */
	// 规划（细化向导）的「自动」= 主对话模型，线上仍用空值；旧服务端不认识 auto，执行的自动也退回空值（跟随主对话）。
	const wirePlanner = llmPlanner === AUTO ? "" : llmPlanner;
	const wireExec = execModel === AUTO && !reviewerSelectable ? "" : execModel;
	const sendLlmPrefs = (maxRounds: number) =>
		appSend({
			type: "set_goal_prefs",
			maxRounds,
			reviewModel: wirePlanner,
			execModel: wireExec,
			...(reviewerSelectable ? { reviewerModel: llmReviewer } : {}),
		});

	const start = () => {
		if (!canStart) return;
		if (mode === "llm") {
			const maxRounds = Math.max(0, Math.min(llmRounds, 50));
			sendLlmPrefs(maxRounds);
			appSend({
				type: "set_goal",
				goal: withCriteria(g, c),
				...(wirePlanner ? { reviewModel: wirePlanner } : {}),
				maxRounds,
				locked: true,
				...(wireExec ? { execModel: wireExec } : {}),
				...(reviewerSelectable && llmReviewer ? { reviewerModel: llmReviewer } : {}),
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
				...(precheck.trim() ? { precheckCmd: precheck } : {}),
				...(cmd.trim() ? { validateCmd: cmd } : {}),
				...(artifactRoots.length ? { artifactRoots } : {}),
				...(planner !== AUTO ? { plannerModel: planner } : {}),
				executorModel: executor,
				useReviewer: mode === "code-review",
				...(mode === "code-review" && reviewer !== AUTO ? { reviewerModel: reviewer } : {}),
				...(primaryMetric.trim() ? { primaryMetric: primaryMetric.trim() } : {}),
				...(metricDirection ? { metricDirection } : {}),
				...(metricPrecision.trim() ? { metricPrecision: Number(metricPrecision) } : {}),
				...(packId ? { packId } : {}),
				...(workspace.trim() ? { workspace: workspace.trim() } : {}),
				...(Object.keys(extraInputs).filter((k) => extraInputs[k]?.trim()).length
					? { inputs: Object.fromEntries(Object.entries(extraInputs).filter(([, v]) => v?.trim())) }
					: {}),
				worktree,
			});
		}
		finish();
	};

	/** 「帮我细化」：交给目标调研向导（先提问、再给计划确认），弹窗关掉让目标条显示向导进度。 */
	const refine = () => {
		if (!g || mode !== "llm" || blocked) return;
		const maxRounds = Math.max(0, Math.min(llmRounds, 50));
		sendLlmPrefs(maxRounds);
		appSend({
			type: "start_goal_wizard",
			text: withCriteria(g, c),
			...(wirePlanner ? { wizardModel: wirePlanner } : {}),
			maxRounds,
			locked: true,
		});
		finish();
	};

	const roleLabel = (r: RoleName) =>
		t(r === "planner" ? "taskRolePlanner" : r === "executor" ? "taskRoleExecutor" : "taskRoleReviewer");
	const roleModel = (m: RoleModelView | null) =>
		m
			? t("taskRoleModel", {
					id: m.id,
					family: m.family,
					source: t(m.source === "auto" ? "taskRoleAuto" : m.source === "main" ? "taskRoleMain" : "taskRoleExplicit"),
				})
			: t("taskRoleNone");
	/** 冲突 / 解析失败时指出具体角色与模型；否则给角色说明。 */
	const problem = ((): string | null => {
		const e = resolution?.error;
		if (e?.code === "unresolved") return t("taskRoleUnresolved", { role: roleLabel(e.role) });
		if (e?.code === "no-candidate") {
			// 只列出与该角色隔离、且已分到模型的角色的家族
			const avoid = new Set<string>();
			for (const [a, b] of ROLE_PAIRS[mode]) {
				const other = a === e.role ? b : b === e.role ? a : null;
				const fam = other ? resolution?.roles[other]?.family : undefined;
				if (fam) avoid.add(fam);
			}
			return t("taskRoleNoCandidate", { role: roleLabel(e.role), families: [...avoid].join(" / ") });
		}
		if (e?.code === "no-main") return t("taskRoleNoMain");
		const cf = resolution?.conflicts[0];
		if (cf)
			return t("taskRoleConflict", {
				a: roleLabel(cf.roles[0]),
				am: cf.models[0],
				b: roleLabel(cf.roles[1]),
				bm: cf.models[1],
				family: cf.family,
			});
		if (!resolution && localConflict)
			return t("taskRoleConflictShort", {
				a: roleLabel(localConflict.roles[0]),
				b: roleLabel(localConflict.roles[1]),
				family: localConflict.family,
			});
		return null;
	})();
	// 一键修正：只替换可在本面板里调整的那个角色（审查不可选时改执行模型）。
	const setRole = (role: RoleName, spec: string) => {
		if (mode === "llm")
			(role === "planner" ? setLlmPlanner : role === "executor" ? setExecModel : setLlmReviewer)(spec);
		else (role === "planner" ? setPlanner : role === "executor" ? setExecutor : setReviewer)(spec);
	};
	const fix = ((): { label: string; apply: () => void } | null => {
		if (!resolution || resolution.ok) return null;
		// 建议替换冲突里的后一个角色；旧服务端上审查不可选时改执行。
		const s = resolution.suggestion;
		const usable =
			s && !(mode === "llm" && s.role === "reviewer" && !reviewerSelectable) ? s : resolution.executorSuggestion;
		if (!usable) return null;
		return {
			label: t("taskRoleUseSuggestion", { role: roleLabel(usable.role), model: usable.id }),
			apply: () => setRole(usable.role, specOf(usable)),
		};
	})();
	const summary =
		resolution && !resolution.error
			? [
					t("taskRoleItem", { role: roleLabel("planner"), model: roleModel(resolution.roles.planner) }),
					t("taskRoleItem", { role: roleLabel("executor"), model: roleModel(resolution.roles.executor) }),
					t("taskRoleItem", {
						role: roleLabel("reviewer"),
						model: mode === "code" ? t("taskRoleNoReview") : roleModel(resolution.roles.reviewer),
					}),
				].join(" · ")
			: null;
	const note =
		problem ??
		(models && models.length === 0
			? t("codeLoopModelsMissing")
			: codeMode
				? t("codeLoopModelNote")
				: reviewerSelectable
					? t("taskLlmRoleNote")
					: t("taskLlmReviewer", { name: mainModel?.name ?? "—" }));
	const roleNotes = (
		<>
			{mode === "llm" && !reviewerSelectable && problem && (
				<div className="cockpit-model-note">{t("taskLlmReviewer", { name: mainModel?.name ?? "—" })}</div>
			)}
			<div className={`cockpit-model-note${problem ? " bad" : ""}`}>{note}</div>
			{fix && (
				<button type="button" className="btn sm task-role-fix" onClick={fix.apply}>
					{fix.label}
				</button>
			)}
			{summary && (
				<div className="cockpit-model-note task-role-summary">{t("taskRoleSummary", { roles: summary })}</div>
			)}
		</>
	);
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
				{codeMode && (packs?.length ?? 0) > 0 && (
					<>
						<label className="cockpit-label" htmlFor="task-pack">
							{t("taskPackLabel")}
						</label>
						<select id="task-pack" className="cockpit-input" value={packId} onChange={(e) => applyPack(e.target.value)}>
							<option value="">{t("taskPackNone")}</option>
							{packs!.map((p) => (
								<option key={p.id} value={p.id} title={p.summary}>
									{p.title}
								</option>
							))}
						</select>
						<label className="cockpit-label" htmlFor="task-workspace">
							{t("taskWorkspaceLabel")}
						</label>
						<input
							id="task-workspace"
							className="cockpit-input"
							value={workspace}
							placeholder={t("taskWorkspacePh")}
							onChange={(e) => setWorkspace(e.target.value)}
						/>
						{discovering && <div className="cockpit-hint">{t("taskDiscovering")}</div>}
						{!discovering && discovery?.summary && (
							<div className="cockpit-hint task-discovery" title={discovery.summary}>
								{discovery.summary}
							</div>
						)}
						{!discovering && discovery?.context?.missing && discovery.context.missing.length > 0 && (
							<div className="task-discovery-missing">
								{discovery.context.missing.map((m) => (
									<label key={m.id} className="cockpit-label">
										{m.label || m.id}
										<input
											className="cockpit-input"
											value={extraInputs[m.id] ?? ""}
											placeholder={m.sourceOf || m.id}
											onChange={(e) => setExtraInputs((prev) => ({ ...prev, [m.id]: e.target.value }))}
										/>
									</label>
								))}
							</div>
						)}
					</>
				)}
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
						<div className="cockpit-models three">
							{roleSelect("task-planner", t("codeLoopPlanner"), planner, setPlanner)}
							{roleSelect("task-executor", t("goalBarExecModel"), executor, setExecutor, t("taskExecutorTip"))}
							{mode === "code-review" && roleSelect("task-reviewer", t("codeLoopReviewer"), reviewer, setReviewer)}
						</div>
						{roleNotes}
					</>
				) : (
					<>
						<div className="cockpit-models three">
							{roleSelect("task-llm-planner", t("codeLoopPlanner"), llmPlanner, setLlmPlanner)}
							{roleSelect("task-exec", t("goalBarExecModel"), execModel, setExecModel, t("taskExecutorTip"))}
							{reviewerSelectable &&
								roleSelect("task-llm-reviewer", t("codeLoopReviewer"), llmReviewer, setLlmReviewer)}
						</div>
						{roleNotes}
					</>
				)}
				<details className="cockpit-adv">
					<summary>{t("codeLoopAdvanced")}</summary>
					{codeMode && (
						<>
							<label className="cockpit-label" htmlFor="task-worktree">
								<input
									id="task-worktree"
									type="checkbox"
									checked={worktree}
									onChange={(e) => setWorktree(e.target.checked)}
								/>{" "}
								{t("codeLoopWorktree")}
							</label>
							<div className="cockpit-note">{t("codeLoopWorktreeNote")}</div>
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
							<label className="cockpit-label" htmlFor="task-metric">
								{t("codeLoopPrimaryMetric")}
							</label>
							<input
								id="task-metric"
								className="cockpit-input"
								value={primaryMetric}
								placeholder={t("codeLoopPrimaryMetricPh")}
								onChange={(e) => setPrimaryMetric(e.target.value)}
							/>
							<div className="cockpit-models">
								<div>
									<label className="cockpit-label" htmlFor="task-metric-dir">
										{t("codeLoopMetricDirection")}
									</label>
									<select
										id="task-metric-dir"
										className="cockpit-input"
										value={metricDirection}
										onChange={(e) => setMetricDirection(e.target.value as "" | "maximize" | "minimize")}
									>
										<option value="">{t("codeLoopMetricDirectionAuto")}</option>
										<option value="maximize">{t("codeLoopMetricDirectionMax")}</option>
										<option value="minimize">{t("codeLoopMetricDirectionMin")}</option>
									</select>
								</div>
								<div>
									<label className="cockpit-label" htmlFor="task-metric-prec">
										{t("codeLoopMetricPrecision")}
									</label>
									<input
										id="task-metric-prec"
										className="cockpit-input"
										type="number"
										step="any"
										value={metricPrecision}
										onChange={(e) => setMetricPrecision(e.target.value)}
									/>
								</div>
							</div>
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
						<button
							type="button"
							className="btn task-refine"
							disabled={!g || blocked}
							title={t("goalWizardTip")}
							onClick={refine}
						>
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
