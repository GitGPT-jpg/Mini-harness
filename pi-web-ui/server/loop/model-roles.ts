/**
 * 任务角色与模型解析：「新任务」各验收方式里规划 / 执行 / 审查分别由谁担任、实际生效哪个模型，
 * 以及家族约束是否满足。前端预检（POST /api/mini-harness/roles）与服务端启动前校验共用这里，
 * 家族归类只用 extension.ts 的 familyOf。
 *
 * 角色映射（产品契约）：
 *  - code-review（代码验证 + 模型评审）：执行 = 主对话当前模型；规划、审查可指定或自动；
 *    规划 ≠ 执行家族，审查 ≠ 执行家族且 ≠ 规划家族（loop 运行时既有约束）。
 *  - code（仅代码验证）：没有审查角色；规划 ≠ 执行家族。残留的审查选择不参与解析。
 *  - llm（仅模型评审，GoalService）：规划（细化向导，历史字段 reviewModel）、执行（execModel）、
 *    审查（reviewerModel）缺省都跟随主对话；唯一约束是执行 ≠ 审查家族。
 */
import { familyOf } from "./extension.js";

export type TaskMode = "code-review" | "code" | "llm";
export type TaskRole = "planner" | "executor" | "reviewer";

/** 解析出的一个角色：source 说明它从哪来（指定 / 跟随主对话 / 自动挑选）。 */
export interface RoleModel {
	provider?: string;
	id: string;
	family: string;
	source: "explicit" | "main" | "auto";
}

export interface RoleConflict {
	roles: [TaskRole, TaskRole];
	family: string;
	models: [string, string];
}

export interface RoleResolution {
	ok: boolean;
	mode: TaskMode;
	roles: Record<TaskRole, RoleModel | null>;
	conflicts: RoleConflict[];
	/** 解析失败：哪个角色、什么原因（unresolved = 指定的模型不存在；no-candidate = 没有可用的不同家族模型）。 */
	error: { code: "unresolved" | "no-candidate" | "no-main"; role: TaskRole } | null;
	/** 有冲突或缺候选时，给可启用审查的那个角色推荐一个合规模型（只是建议，不自动替换）。 */
	suggestion: { role: TaskRole; provider?: string; id: string; family: string } | null;
	/** 仅模型评审：审查角色不可选（旧服务端）时，改执行模型是唯一的页面内修正方式。 */
	executorSuggestion?: { role: "executor"; provider?: string; id: string; family: string } | null;
	/** 给人看的固定文案（中文 / 英文）；前端按结构化字段本地化，服务端拒绝启动时用它发通知。 */
	message: string;
	messageEn: string;
}

/** 与 SDK ModelRegistry / loop 的 ctx.modelRegistry 同形的最小接口。 */
export interface RoleRegistry {
	find(provider: string, id: string): { provider?: string; id: string } | undefined | null;
	getAll(): Array<{ provider?: string; id: string }>;
	getAvailable?(): Array<{ provider?: string; id: string }>;
}

const PREFER_FAMILIES = ["openai", "anthropic", "zhipu", "deepseek", "moonshot", "google", "xai", "minimax", "alibaba"];

const ROLE_NAME: Record<TaskRole, string> = { planner: "规划", executor: "执行", reviewer: "审查" };
const ROLE_NAME_EN: Record<TaskRole, string> = { planner: "planner", executor: "executor", reviewer: "reviewer" };

/** "provider/id" 或裸 id → 注册表里的模型（与 loop 运行时 resolveModel 同规则）。 */
export function findModel(
	reg: RoleRegistry,
	spec: string | null | undefined,
): { provider?: string; id: string } | null {
	const s = String(spec ?? "").trim();
	if (!s) return null;
	const i = s.indexOf("/");
	if (i > 0) return reg.find(s.slice(0, i), s.slice(i + 1)) || null;
	const all = reg.getAll();
	return all.find((m) => m.id === s) || all.find((m) => m.id.toLowerCase() === s.toLowerCase()) || null;
}

/** 按家族偏好挑一个不在 exclude 里的可用模型（与 loop 运行时 pickModelByFamily 同规则）。 */
export function pickByFamily(reg: RoleRegistry, exclude: Set<string>): { provider?: string; id: string } | null {
	const models = reg.getAvailable?.() ?? reg.getAll();
	for (const fam of PREFER_FAMILIES) {
		if (exclude.has(fam)) continue;
		const m = models.find((x) => familyOf(x.id) === fam);
		if (m) return m;
	}
	return models.find((m) => !exclude.has(familyOf(m.id))) || null;
}

const brief = (m: { provider?: string; id: string }, source: RoleModel["source"]): RoleModel => ({
	...(m.provider ? { provider: m.provider } : {}),
	id: m.id,
	family: familyOf(m.id),
	source,
});

const label = (m: RoleModel) => (m.provider ? `${m.provider}/${m.id}` : m.id);

/** 选择器的「自动」值：参与联立分配。空 / 缺省是旧请求的默认来源（见 resolveTaskRoles）。 */
export const AUTO_MODEL = "auto";

export interface RoleRequest {
	mode: TaskMode;
	planner?: string | null;
	executor?: string | null;
	reviewer?: string | null;
}

/** 各验收方式里必须两两不同家族的角色对（产品契约；顺序决定冲突时建议替换哪一个：取后者）。 */
const ISOLATED: Record<TaskMode, Array<[TaskRole, TaskRole]>> = {
	"code-review": [
		["executor", "planner"],
		["executor", "reviewer"],
		["planner", "reviewer"],
	],
	code: [["executor", "planner"]],
	llm: [["executor", "reviewer"]],
};

/** role 必须避开的家族：与它隔离的角色当前已分配到的家族。 */
function excludedFamilies(mode: TaskMode, role: TaskRole, roles: Record<TaskRole, RoleModel | null>): Set<string> {
	const out = new Set<string>();
	for (const [a, b] of ISOLATED[mode]) {
		const other = a === role ? b : b === role ? a : null;
		const fam = other ? roles[other]?.family : undefined;
		if (fam) out.add(fam);
	}
	return out;
}

/**
 * 解析某个验收方式下各角色的实际模型并校验家族约束。main = 主对话当前模型。
 *  - 显式 "provider/id"：原样使用，不在目录里报 unresolved；
 *  - "auto"：联立分配 —— 先定显式角色，再按 执行 → 规划 → 审查 的顺序为自动角色挑模型，
 *    执行优先用主对话模型，其余按家族偏好，只避开与之隔离的角色已用的家族；
 *  - 空 / 缺省（旧请求）：代码模式执行 = 主对话、规划 / 审查 = 自动；仅模型评审三者都跟随主对话。
 * 显式与默认来源之间的冲突不自动改写，结果里列出冲突角色并给出可替换的建议。
 * 代码模式下规划找不到候选时为 null（运行时跳过规划）；执行、审查找不到候选报 no-candidate。
 */
export function resolveTaskRoles(
	reg: RoleRegistry,
	main: { provider?: string; id: string } | null,
	req: RoleRequest,
): RoleResolution {
	const roles: Record<TaskRole, RoleModel | null> = { planner: null, executor: null, reviewer: null };
	const out = (extra: Partial<RoleResolution>): RoleResolution => {
		const r: RoleResolution = {
			ok: true,
			mode: req.mode,
			roles,
			conflicts: [],
			error: null,
			suggestion: null,
			message: "",
			messageEn: "",
			...extra,
		};
		r.ok = !r.error && r.conflicts.length === 0;
		if (!r.message) r.message = describeResolution(r);
		if (!r.messageEn) r.messageEn = describeResolutionEn(r);
		return r;
	};
	const mainModel = main ? brief(main, "main") : null;
	const active: TaskRole[] = req.mode === "code" ? ["planner", "executor"] : ["planner", "executor", "reviewer"];
	const pending: TaskRole[] = [];
	for (const role of active) {
		const v = String(req[role] ?? "").trim();
		if (v && v !== AUTO_MODEL) {
			const m = findModel(reg, v);
			if (!m) return out({ error: { code: "unresolved", role } });
			roles[role] = brief(m, "explicit");
		} else if (!v && (req.mode === "llm" || role === "executor")) {
			if (!mainModel) return out({ error: { code: "no-main", role } });
			roles[role] = mainModel;
		} else {
			pending.push(role);
		}
	}
	const conflicts: RoleConflict[] = [];
	for (const [a, b] of ISOLATED[req.mode]) {
		const ma = roles[a];
		const mb = roles[b];
		if (ma && mb && ma.family === mb.family)
			conflicts.push({ roles: [a, b], family: ma.family, models: [label(ma), label(mb)] });
	}
	for (const role of (["executor", "planner", "reviewer"] as const).filter((r) => pending.includes(r))) {
		const exclude = excludedFamilies(req.mode, role, roles);
		if ((role === "executor" || req.mode === "llm") && mainModel && !exclude.has(mainModel.family)) {
			roles[role] = mainModel;
			continue;
		}
		const pick = pickByFamily(reg, exclude);
		if (pick) roles[role] = brief(pick, "auto");
		else if (role !== "planner" || req.mode === "llm") return out({ conflicts, error: { code: "no-candidate", role } });
	}
	// 冲突时给后一个角色推荐一个合规模型（只是建议）；仅模型评审另给执行角色一个（审查不可选的旧服务端用）。
	const first = conflicts[0];
	const target = first?.roles[1];
	const alt = target ? pickByFamily(reg, excludedFamilies(req.mode, target, { ...roles, [target]: null })) : null;
	const execAlt =
		req.mode === "llm" && first && roles.reviewer ? pickByFamily(reg, new Set([roles.reviewer.family])) : null;
	return out({
		conflicts,
		suggestion: alt && target ? { role: target, ...brief(alt, "auto") } : null,
		...(req.mode === "llm"
			? { executorSuggestion: execAlt ? { role: "executor" as const, ...brief(execAlt, "auto") } : null }
			: {}),
	});
}

/** 固定中文说明：指出冲突的两个角色、实际模型与家族；缺候选时说明缺哪个角色、要补什么配置。 */
export function describeResolution(r: RoleResolution): string {
	if (r.error?.code === "unresolved")
		return `${ROLE_NAME[r.error.role]}模型无法解析：所选模型不在当前模型目录里，请重新选择。`;
	if (r.error?.code === "no-main") return "主对话还没有可用模型：请先在输入框下方选择模型。";
	if (r.error?.code === "no-candidate")
		return `没有可用的${ROLE_NAME[r.error.role]}模型：需要一个与已用家族（${[
			...excludedFamilies(r.mode, r.error.role, r.roles),
		].join("、")}）都不同的模型，请在「模型与服务商」中添加另一家族的模型并配置密钥。`;
	const c = r.conflicts[0];
	if (c)
		return `${ROLE_NAME[c.roles[0]]}模型 ${c.models[0]} 与${ROLE_NAME[c.roles[1]]}模型 ${c.models[1]} 同属 ${c.family} 家族，请为其中一个角色换一个不同家族的模型。`;
	return "";
}

/** describeResolution 的英文版（服务端通知的 textEn）。 */
export function describeResolutionEn(r: RoleResolution): string {
	if (r.error?.code === "unresolved")
		return `The ${ROLE_NAME_EN[r.error.role]} model can't be resolved: it is not in the current model catalog. Pick another one.`;
	if (r.error?.code === "no-main") return "The main chat has no model yet: pick one below the input box.";
	if (r.error?.code === "no-candidate")
		return `No ${ROLE_NAME_EN[r.error.role]} model available: add a model from a family other than ${[
			...excludedFamilies(r.mode, r.error.role, r.roles),
		].join("/")} under Models & providers, with its key.`;
	const c = r.conflicts[0];
	if (c)
		return `The ${ROLE_NAME_EN[c.roles[0]]} model ${c.models[0]} and the ${ROLE_NAME_EN[c.roles[1]]} model ${c.models[1]} are both ${c.family}: pick a model from another family for one of them.`;
	return "";
}
