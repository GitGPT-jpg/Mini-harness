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

export interface RoleRequest {
	mode: TaskMode;
	planner?: string | null;
	executor?: string | null;
	reviewer?: string | null;
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

/**
 * 解析某个验收方式下各角色的实际模型并校验家族约束。main = 主对话当前模型（执行者或默认值）。
 * 纯函数：不落盘、不改选择；冲突与缺候选都在结果里说明，由调用方决定拒绝启动。
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
	const pick = (role: TaskRole, spec: string | null | undefined, fallback: RoleModel | null) => {
		if (!String(spec ?? "").trim()) return { model: fallback };
		const m = findModel(reg, spec);
		return m ? { model: brief(m, "explicit") } : { error: { code: "unresolved" as const, role } };
	};
	const mainModel = main ? brief(main, "main") : null;

	if (req.mode === "llm") {
		for (const role of ["planner", "executor", "reviewer"] as const) {
			const r = pick(role, req[role], mainModel);
			if ("error" in r && r.error) return out({ error: r.error });
			roles[role] = r.model ?? null;
		}
		if (!roles.executor || !roles.reviewer)
			return out({ error: { code: "no-main", role: roles.executor ? "reviewer" : "executor" } });
		if (roles.executor.family === roles.reviewer.family) {
			const alt = pickByFamily(reg, new Set([roles.executor.family]));
			const execAlt = pickByFamily(reg, new Set([roles.reviewer.family]));
			return out({
				executorSuggestion: execAlt ? { role: "executor", ...brief(execAlt, "auto") } : null,
				conflicts: [
					{
						roles: ["executor", "reviewer"],
						family: roles.executor.family,
						models: [label(roles.executor), label(roles.reviewer)],
					},
				],
				suggestion: alt ? { role: "reviewer", ...brief(alt, "auto") } : null,
			});
		}
		return out({});
	}

	// 代码验收：执行者就是主对话当前模型。
	if (!mainModel) return out({ error: { code: "no-main", role: "executor" } });
	roles.executor = mainModel;
	const used = new Set([mainModel.family]);
	const conflicts: RoleConflict[] = [];
	const planner = pick("planner", req.planner, null);
	if ("error" in planner && planner.error) return out({ error: planner.error });
	if (planner.model) {
		roles.planner = planner.model;
		if (used.has(planner.model.family))
			conflicts.push({
				roles: ["executor", "planner"],
				family: planner.model.family,
				models: [label(mainModel), label(planner.model)],
			});
	} else {
		const auto = pickByFamily(reg, used);
		roles.planner = auto ? brief(auto, "auto") : null;
	}
	if (roles.planner) used.add(roles.planner.family);
	if (req.mode === "code") return out({ conflicts });

	const reviewer = pick("reviewer", req.reviewer, null);
	if ("error" in reviewer && reviewer.error) return out({ error: reviewer.error, conflicts });
	if (reviewer.model) {
		roles.reviewer = reviewer.model;
		if (reviewer.model.family === mainModel.family)
			conflicts.push({
				roles: ["executor", "reviewer"],
				family: mainModel.family,
				models: [label(mainModel), label(reviewer.model)],
			});
		else if (roles.planner && reviewer.model.family === roles.planner.family)
			conflicts.push({
				roles: ["planner", "reviewer"],
				family: roles.planner.family,
				models: [label(roles.planner), label(reviewer.model)],
			});
	} else {
		const auto = pickByFamily(reg, used);
		if (!auto) return out({ conflicts, error: { code: "no-candidate", role: "reviewer" } });
		roles.reviewer = brief(auto, "auto");
	}
	const needsReviewer = conflicts.some((c) => c.roles.includes("reviewer"));
	const alt = needsReviewer ? pickByFamily(reg, used) : null;
	return out({ conflicts, suggestion: alt ? { role: "reviewer", ...brief(alt, "auto") } : null });
}

/** 固定中文说明：指出冲突的两个角色、实际模型与家族；缺候选时说明缺哪个角色、要补什么配置。 */
export function describeResolution(r: RoleResolution): string {
	if (r.error?.code === "unresolved")
		return `${ROLE_NAME[r.error.role]}模型无法解析：所选模型不在当前模型目录里，请重新选择。`;
	if (r.error?.code === "no-main") return "主对话还没有可用模型：请先在输入框下方选择模型。";
	if (r.error?.code === "no-candidate")
		return `没有可用的${ROLE_NAME[r.error.role]}模型：需要一个与已用家族（${[r.roles.executor, r.roles.planner]
			.filter(Boolean)
			.map((m) => m!.family)
			.join("、")}）都不同的模型，请在「模型与服务商」中添加另一家族的模型并配置密钥。`;
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
			r.roles.executor,
			r.roles.planner,
		]
			.filter(Boolean)
			.map((m) => m!.family)
			.join("/")} under Models & providers, with its key.`;
	const c = r.conflicts[0];
	if (c)
		return `The ${ROLE_NAME_EN[c.roles[0]]} model ${c.models[0]} and the ${ROLE_NAME_EN[c.roles[1]]} model ${c.models[1]} are both ${c.family}: pick a model from another family for one of them.`;
	return "";
}
