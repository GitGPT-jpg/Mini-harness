/**
 * server/approval-rules.ts
 *
 * 审批规则库与多维匹配引擎（Approval Rules Store & Match Engine）。
 *
 * 功能：
 * 1. 规则数据模型（ApprovalRule / UiApprovalRule）：
 *    - 工具名单（tools：["bash"]、["write", "edit"]、["*"]）
 *    - 匹配字段（field："command" | "path" | "params"）
 *    - 匹配方式（match："regex" | "glob" | "contains" | "prefix" | "outside_workspace"）
 *    - 命中动作（action："ask" | "deny" | "allow"）
 *      - "deny"：直接阻断执行并向模型报错（不弹窗、不产生 pending）
 *      - "ask"：触发人工协同审批（弹窗让用户决定，带档位可「允许同类」）
 *      - "allow"：免审直接放行（白名单，跳过后续规则与内置高危检测）
 *    - 启停开关（enabled）+ 内置标记（builtin）
 *    - 双语名称与拦截原因（label/labelEn, reason/reasonEn）
 *
 * 2. 匹配与判定纯函数（matchApprovalRule / evaluateApprovalRules）：
 *    - 优先级规则：
 *      先按规则列表自顶向下顺序遍历，遇到第一个匹配成功的启用规则即返回其判决；
 *      若命中 "allow"，直接免审放行；
 *      若命中 "deny"，直接拒绝执行；
 *      若命中 "ask"，挂起审批弹窗；
 *      若所有规则均未命中，回落至内置默认安全策略（兼容旧硬编码逻辑）。
 *
 * 3. 存储与多客户端同步（ApprovalRulesStore）：
 *    - 存储路径：<dataDir>/approval-rules.json（所有客户端共享同一份）
 *    - 播种 sidecar：<dataDir>/approval-rules.seeded.json（记录已播种过的内置规则 id，
 *      老用户删掉的内置规则不会在重启后复活；发版新增的内置规则可安全合并进老用户文件）。
 *    - 内存缓存 + 文件 mtime 感知，支持直接编辑 JSON 文件热生效。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { writeJsonAtomicSync } from "./atomic-file.js";
import { DEFAULT_APPROVAL_RULES } from "./approval-default-rules.js";

export { DEFAULT_APPROVAL_RULES };
import type { UiApprovalCategory } from "./protocol.js";

/** 工具调用审批命中动作：需审批 / 直接拒绝 / 直接放行（白名单）。 */
export type ApprovalRuleAction = "ask" | "deny" | "allow";

/** 匹配字段。 */
export type ApprovalRuleField = "command" | "path" | "params";

/** 匹配方式。 */
export type ApprovalRuleMatchKind = "regex" | "glob" | "contains" | "prefix" | "outside_workspace";

/**
 * 跨平台判定 target 路径是否严格位于 root 目录内部或就是 root 本身。
 * 针对 Windows 盘符大小写不敏感及正反斜杠统一进行规范化，防止 .. 路径穿越逃逸。
 */
export function isPathInsideRoot(target: string, root: string): boolean {
	const normTarget = resolve(target);
	const normRoot = resolve(root);
	if (process.platform === "win32") {
		const lowerTarget = normTarget.toLowerCase();
		const lowerRoot = normRoot.toLowerCase();
		return (
			lowerTarget === lowerRoot || lowerTarget.startsWith(lowerRoot + sep) || lowerTarget.startsWith(lowerRoot + "/")
		);
	}
	return normTarget === normRoot || normTarget.startsWith(normRoot + sep);
}

/** 审批规则定义（也与 wire 协议 UiApprovalRule 同形）。 */
export interface ApprovalRule {
	/** 规则唯一标识（内置规则形如 "builtin.bash.rm-rf"，自定义规则形如 "custom.<uuid|slug>"）。 */
	id: string;
	/** 是否启用（默认 true；false = 停用跳过）。 */
	enabled: boolean;
	/** 适用的工具名列表，如 ["bash"]、["write", "edit", "edit_soft"]、["*"] 表示通配。 */
	tools: string[];
	/** 检查的参数字段：command | path | params（params 表示对参数 JSON 字符串全文匹配）。 */
	field: ApprovalRuleField;
	/** 匹配方式：regex（正则）| glob（通配符）| contains（包含子串）| prefix（前缀）| outside_workspace（工作区外）。 */
	match: ApprovalRuleMatchKind;
	/** 匹配目标值/模式串（match 为 outside_workspace 时此字段可空）。 */
	value: string;
	/** 命中后的动作：ask（弹窗审批）| deny（直接拒绝）| allow（免审放行）。 */
	action: ApprovalRuleAction;
	/** 规则显示名称（zh）。 */
	label: string;
	/** 规则英文名称（en；缺失时回落 label）。 */
	labelEn?: string;
	/** 拦截/拒绝时展示的人性化原因（zh）。 */
	reason?: string;
	/** 拦截/拒绝时展示的人性化原因（en）。 */
	reasonEn?: string;
	/** 对应的规则档位 id（用于「允许同类」；缺省时以 rule.id 为档位 id）。 */
	categoryId?: string;
	/** 是否为系统内置规则（true 时设置面板不可删除，但可编辑、停用或恢复默认）。 */
	builtin?: boolean;
}

/** 规则判定结果。 */
export interface RuleEvaluationResult {
	/** 决策动作：ask（弹审批）| deny（直接阻断）| allow（白名单放行）| none（未命中规则）。 */
	action: "ask" | "deny" | "allow" | "none";
	/** 命中的规则。 */
	matchedRule?: ApprovalRule;
	/** 拦截/拒绝原因（zh）。 */
	reason?: string;
	/** 拦截/拒绝原因（en）。 */
	reasonEn?: string;
	/** 规则档位（用于「允许同类审批」）。 */
	category?: UiApprovalCategory;
	/** 命中的规则片段清单（issue #566，带条数上限与单条长度保护）。 */
	hits?: RuleHitDetail[];
}

/** 规则命中区间详情（issue #566）。 */
export interface RuleHitDetail {
	ruleId: string;
	label: string;
	labelEn?: string;
	field: ApprovalRuleField;
	index: number;
	length: number;
	text: string;
}

/**
 * 极简 glob 转 RegExp（只支持 * 单段、? 单字符、** 跨段）。
 * 纯函数，支持正反斜杠统一归一为 /。
 */
export function globToRegex(pattern: string): RegExp {
	const src = String(pattern ?? "")
		.trim()
		.replace(/\\/g, "/");
	let re = "";
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (c === "*") {
			if (src[i + 1] === "*") {
				if (src[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 2;
				} else {
					re += ".*";
					i += 1;
				}
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/, (m) => `\\${m}`);
		}
	}
	return new RegExp(`^${re}$`, "i");
}

/**
 * 从工具参数里取「这次调用动的是哪个文件」。SDK 内置 read/write/edit 用 `path`，read 还有
 * `file_path` 别名，部分扩展（如 pi-better-edit 的 edit）用 `file` —— 三种都认，否则叠在
 * 扩展实现之上的权限沙箱与审批规则会静默放行（取不到 → 空串 → 被判成工作区内）。
 */
export function extractTargetPath(params: unknown): string {
	if (!params || typeof params !== "object") return "";
	const obj = params as Record<string, unknown>;
	for (const key of ["path", "file_path", "file"]) {
		const value = obj[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return "";
}

/**
 * 从工具参数对象中提取待检查文本。
 */
export function extractRuleFieldValue(field: ApprovalRuleField, toolName: string, params: unknown): string {
	if (!params || typeof params !== "object") {
		return typeof params === "string" ? params : "";
	}
	const obj = params as Record<string, unknown>;
	if (field === "command") {
		return String(obj.command ?? "");
	}
	if (field === "path") {
		return extractTargetPath(params);
	}
	if (field === "params") {
		try {
			return JSON.stringify(params);
		} catch {
			return String(params);
		}
	}
	return "";
}

/**
 * 单条规则针对具体工具调用的匹配详情判定（纯函数，issue #566）。
 * 匹配成功时返回匹配区间信息 { index, length, text }，否则返回 null。
 */
/** 单条规则在一段字段文本里的全部命中区间（issue #578）。regex 规则逐次扫描、不只取首个。 */
export function matchApprovalRuleDetails(
	rule: ApprovalRule,
	toolName: string,
	params: unknown,
	cwd: string,
	workspaceRoots: string[] = [],
): { index: number; length: number; text: string }[] {
	if (!rule.enabled) return [];
	const targetTools = rule.tools.map((t) => t.trim().toLowerCase());
	const toolMatches = targetTools.includes("*") || targetTools.includes(toolName.trim().toLowerCase());
	if (!toolMatches) return [];
	if (rule.match === "regex") {
		const fieldValue = extractRuleFieldValue(rule.field, toolName, params);
		if (!fieldValue) return [];
		let re: RegExp;
		try {
			re = new RegExp(rule.value, "gi");
		} catch {
			return [];
		}
		const out: { index: number; length: number; text: string }[] = [];
		for (let m = re.exec(fieldValue); m; m = re.exec(fieldValue)) {
			if (m[0].length === 0) {
				re.lastIndex++; // 空匹配推进一位，防死循环
				continue;
			}
			out.push({ index: m.index, length: m[0].length, text: m[0] });
		}
		return out;
	}
	const single = matchApprovalRuleDetail(rule, toolName, params, cwd, workspaceRoots);
	return single ? [single] : [];
}

export function matchApprovalRuleDetail(
	rule: ApprovalRule,
	toolName: string,
	params: unknown,
	cwd: string,
	workspaceRoots: string[] = [],
): { index: number; length: number; text: string } | null {
	if (!rule.enabled) return null;

	// 1. 工具名匹配
	const targetTools = rule.tools.map((t) => t.trim().toLowerCase());
	const toolMatches = targetTools.includes("*") || targetTools.includes(toolName.trim().toLowerCase());
	if (!toolMatches) return null;

	// 2. 特殊匹配方式：outside_workspace（工作区外路径）
	if (rule.match === "outside_workspace") {
		const targetPath = extractRuleFieldValue("path", toolName, params);
		if (!targetPath) return null;
		// 无论相对或绝对路径，统一经 resolve(cwd, targetPath) 规范化并消除 ".."
		const abs = resolve(cwd, targetPath);
		const allRoots = [resolve(cwd), ...workspaceRoots.map((r) => resolve(r))];
		const inside = allRoots.some((r) => isPathInsideRoot(abs, r));
		if (!inside) {
			return { index: 0, length: targetPath.length, text: targetPath };
		}
		return null;
	}

	// 3. 提取字段文本
	const fieldValue = extractRuleFieldValue(rule.field, toolName, params);
	if (!fieldValue) return null;

	// 4. 按 match kind 进行文本判定并提取命中区间
	switch (rule.match) {
		case "regex": {
			try {
				const re = new RegExp(rule.value, "i");
				const m = re.exec(fieldValue);
				if (m) {
					return {
						index: m.index,
						length: m[0].length,
						text: m[0],
					};
				}
				return null;
			} catch {
				return null;
			}
		}
		case "glob": {
			try {
				const re = globToRegex(rule.value);
				const normalized = fieldValue.replace(/\\/g, "/");
				if (re.test(normalized)) {
					return { index: 0, length: fieldValue.length, text: fieldValue };
				}
				return null;
			} catch {
				return null;
			}
		}
		case "contains": {
			const idx = fieldValue.toLowerCase().indexOf(rule.value.toLowerCase());
			if (idx >= 0) {
				return {
					index: idx,
					length: rule.value.length,
					text: fieldValue.slice(idx, idx + rule.value.length),
				};
			}
			return null;
		}
		case "prefix": {
			if (fieldValue.toLowerCase().startsWith(rule.value.toLowerCase())) {
				return {
					index: 0,
					length: rule.value.length,
					text: fieldValue.slice(0, rule.value.length),
				};
			}
			return null;
		}
		default:
			return null;
	}
}

/**
 * 单条规则针对具体工具调用的匹配判定（纯函数）。
 */
export function matchApprovalRule(
	rule: ApprovalRule,
	toolName: string,
	params: unknown,
	cwd: string,
	workspaceRoots: string[] = [],
): boolean {
	return matchApprovalRuleDetail(rule, toolName, params, cwd, workspaceRoots) !== null;
}

/**
 * 完整评估规则列表对工具调用的决策（纯函数，按列表顺序首个匹配胜出，收集全部命中清单，issue #566）。
 */
export function evaluateApprovalRules(
	rules: ApprovalRule[],
	toolName: string,
	params: unknown,
	cwd: string,
	workspaceRoots: string[] = [],
): RuleEvaluationResult {
	let primary: {
		action: "ask" | "deny" | "allow";
		matchedRule: ApprovalRule;
		reason?: string;
		reasonEn?: string;
		category?: UiApprovalCategory;
	} | null = null;

	const hits: RuleHitDetail[] = [];

	for (const rule of rules) {
		// 同一规则可在一段命令里出现多次（如 `git reset --hard && git clean -fd`），全部列出（#578）。
		for (const detail of matchApprovalRuleDetails(rule, toolName, params, cwd, workspaceRoots)) {
			if (!primary) {
				primary = {
					action: rule.action,
					matchedRule: rule,
					reason: rule.reason || rule.label,
					reasonEn: rule.reasonEn || rule.labelEn || rule.label,
					category: {
						id: rule.categoryId || rule.id,
						label: rule.label,
						labelEn: rule.labelEn || rule.label,
					},
				};
			}
			if (hits.length < 10) {
				// 单条 text 超长时做截断，防止塞满 details 预算（硬限制 ≤64KB）
				const safeText = detail.text.length > 200 ? `${detail.text.slice(0, 200)}…` : detail.text;
				hits.push({
					ruleId: rule.id,
					label: rule.label,
					labelEn: rule.labelEn || rule.label,
					field: rule.field,
					index: detail.index,
					length: detail.length,
					text: safeText,
				});
			}
		}
	}

	if (primary) {
		return {
			...primary,
			hits: hits.length > 0 ? hits : undefined,
		};
	}

	return { action: "none" };
}

export function checkBashCommandDanger(
	command: string,
	rules: ApprovalRule[] = DEFAULT_APPROVAL_RULES,
): RuleHitDetail[] {
	if (!command || typeof command !== "string") return [];
	const res = evaluateApprovalRules(rules, "bash", { command }, "");
	return res.hits ?? [];
}

/** 归一化输入规则。脏数据或非法规则返回 null。 */
export function normalizeApprovalRule(raw: unknown): ApprovalRule | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const id = typeof o.id === "string" ? o.id.trim() : "";
	if (!id || id.length > 120) return null;

	const label = typeof o.label === "string" ? o.label.trim() : "";
	if (!label || label.length > 120) return null;

	const labelEn = typeof o.labelEn === "string" && o.labelEn.trim() ? o.labelEn.trim() : undefined;
	const reason = typeof o.reason === "string" && o.reason.trim() ? o.reason.trim() : undefined;
	const reasonEn = typeof o.reasonEn === "string" && o.reasonEn.trim() ? o.reasonEn.trim() : undefined;

	const action: ApprovalRuleAction = o.action === "deny" ? "deny" : o.action === "allow" ? "allow" : "ask";
	const field: ApprovalRuleField = o.field === "path" ? "path" : o.field === "params" ? "params" : "command";

	const match: ApprovalRuleMatchKind =
		o.match === "glob"
			? "glob"
			: o.match === "contains"
				? "contains"
				: o.match === "prefix"
					? "prefix"
					: o.match === "outside_workspace"
						? "outside_workspace"
						: "regex";

	const value = typeof o.value === "string" ? o.value : "";
	if (match === "regex") {
		try {
			new RegExp(value);
		} catch {
			return null; // 非法正则拒绝
		}
	}

	const tools: string[] = Array.isArray(o.tools)
		? o.tools
				.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
				.map((t) => t.trim().toLowerCase())
		: ["*"];

	return {
		id,
		enabled: o.enabled !== false,
		tools: tools.length > 0 ? tools : ["*"],
		field,
		match,
		value,
		action,
		label,
		...(labelEn ? { labelEn } : {}),
		...(reason ? { reason } : {}),
		...(reasonEn ? { reasonEn } : {}),
		...(typeof o.categoryId === "string" && o.categoryId.trim() ? { categoryId: o.categoryId.trim() } : {}),
		builtin: o.builtin === true,
	};
}

/** 全局审批规则库持久化与操作类。 */
export class ApprovalRulesStore {
	private rules: ApprovalRule[] | null = null;
	private lastMtime = 0;

	constructor(private readonly filePath: string) {}

	private seededPath(): string {
		return /\.json$/i.test(this.filePath)
			? this.filePath.replace(/\.json$/i, ".seeded.json")
			: `${this.filePath}.seeded.json`;
	}

	private loadSeeded(): Set<string> {
		const out = new Set<string>();
		try {
			const parsed = JSON.parse(readFileSync(this.seededPath(), "utf8")) as unknown;
			if (Array.isArray(parsed)) {
				for (const item of parsed) {
					if (typeof item === "string" && item) out.add(item);
				}
			}
		} catch {
			// 文件不存在时返回空集合
		}
		return out;
	}

	private saveSeeded(names: Set<string>): void {
		try {
			writeJsonAtomicSync(this.seededPath(), [...names].sort());
		} catch {
			// best effort
		}
	}

	private load(): ApprovalRule[] {
		let currentMtime = 0;
		try {
			if (existsSync(this.filePath)) {
				currentMtime = statSync(this.filePath).mtimeMs;
			}
		} catch {
			currentMtime = 0;
		}

		if (this.rules && currentMtime > 0 && currentMtime === this.lastMtime) {
			return this.rules;
		}

		let list: ApprovalRule[] = [];
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
			if (Array.isArray(parsed)) {
				list = parsed.map(normalizeApprovalRule).filter((r): r is ApprovalRule => r !== null);
			}
		} catch {
			// 文件不存在或格式损坏，以默认规则初始化
			list = DEFAULT_APPROVAL_RULES.map((r) => ({ ...r, tools: [...r.tools] }));
		}

		// 检查播种：老用户新增内置规则自动合并
		const seeded = this.loadSeeded();
		const existingIds = new Set(list.map((r) => r.id));
		let grown = false;

		for (const def of DEFAULT_APPROVAL_RULES) {
			if (!existingIds.has(def.id) && !seeded.has(def.id)) {
				list.push({ ...def, tools: [...def.tools] });
				existingIds.add(def.id);
				grown = true;
			}
			seeded.add(def.id);
		}

		if (grown || seeded.size > 0) {
			this.saveSeeded(seeded);
		}

		this.rules = list;
		this.lastMtime = currentMtime;
		return this.rules;
	}

	private persist(): void {
		try {
			writeJsonAtomicSync(this.filePath, this.rules ?? []);
			try {
				this.lastMtime = statSync(this.filePath).mtimeMs;
			} catch {
				// ignore
			}
		} catch {
			// best effort
		}
	}

	/** 获取全部有效规则清单（深拷贝返回）。 */
	list(): ApprovalRule[] {
		return this.load().map((r) => ({ ...r, tools: [...r.tools] }));
	}

	/** Upsert 一条规则（同 id 替换，新 id 追加到列表末尾）。返回错误提示，成功返回 null。 */
	upsert(input: unknown): string | null {
		const rule = normalizeApprovalRule(input);
		if (!rule) return "规则格式非法（缺少名称、工具列表或正则格式错误）";

		const list = this.load();
		const idx = list.findIndex((r) => r.id === rule.id);
		if (idx >= 0) {
			// 内置规则保留 builtin 标记
			if (list[idx].builtin) {
				rule.builtin = true;
			}
			list[idx] = rule;
		} else {
			list.push(rule);
		}
		this.persist();
		return null;
	}

	/** 批量重排/替换整份规则（供前端拖拽排序后保存）。 */
	saveAll(inputs: unknown[]): string | null {
		if (!Array.isArray(inputs)) return "规则列表必须是数组";
		const normalized: ApprovalRule[] = [];
		const ids = new Set<string>();

		for (const raw of inputs) {
			const r = normalizeApprovalRule(raw);
			if (!r) return "存在格式非法的规则项";
			if (ids.has(r.id)) return `规则 id 冲突: ${r.id}`;
			ids.add(r.id);
			normalized.push(r);
		}

		// 内置规则是安全底线：整表替换绝不能把它们裁掉（旧客户端 / 并发竞态都
		// 可能送来缺内置规则的清单）。缺失的按默认定义补种、追加到队尾——与
		// load/resetBuiltin 同口径；插队首会改变用户 allow 规则的 first-match
		// 语义。id 命中内置定义的一律强制 builtin 标记（同 upsert 的保护），
		// 防止 remove() 的内置不可删保护被绕过。
		for (const def of DEFAULT_APPROVAL_RULES) {
			if (!ids.has(def.id)) {
				normalized.push({ ...def, tools: [...def.tools] });
				ids.add(def.id);
			} else {
				const i = normalized.findIndex((r) => r.id === def.id);
				normalized[i].builtin = true;
			}
		}

		this.rules = normalized;
		this.persist();
		return null;
	}

	/** 删除一条自定义规则（内置规则不可删除）。 */
	remove(id: string): boolean {
		const list = this.load();
		const idx = list.findIndex((r) => r.id === id);
		if (idx < 0) return false;
		if (list[idx].builtin) return false; // 内置规则不许直接删除，只允许禁用

		list.splice(idx, 1);
		this.persist();
		return true;
	}

	/** 恢复某条内置规则到系统默认设定。 */
	resetBuiltin(id: string): boolean {
		const def = DEFAULT_APPROVAL_RULES.find((r) => r.id === id);
		if (!def) return false;

		const list = this.load();
		const idx = list.findIndex((r) => r.id === id);
		if (idx >= 0) {
			list[idx] = { ...def, tools: [...def.tools] };
		} else {
			list.push({ ...def, tools: [...def.tools] });
		}
		this.persist();
		return true;
	}
}
