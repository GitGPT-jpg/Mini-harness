/**
 * subagent-templates.ts — 子代理模板库（全局共享，<dataDir>/subagent-templates.json）。
 *
 * 模板 = 派生子代理时套用的预设：角色系统提示词（replace/append 同主设置语义）+
 * 技能白名单 + 扩展白名单 + 可选模型 + 可选思考强度。白名单空数组 = 该维度不限定，
 * 子代理跟随主会话设置。
 * `model` 为 "provider/id"（与 subagent_spawn 的 model 参数、设置面板子代理默认模型
 * 同格式）；空字符串 = 跟随主对话当前模型。
 * `thinkingLevel` 为 SDK 的思考强度（off…max，见 THINKING_LEVELS）；空字符串 = 跟随
 * 主对话当前思考强度（与 model 的「跟随主对话」同语义）。
 * 带 `enabled: false` 的模板停用：设置面板仍可见、可重新启用，但 AI 工具
 * （subagent_templates / subagent_spawn）查询不到它、也不能选择它——「关闭 =
 * 对 AI 不可见」。
 *
 * 与 per-client 的 client-state.json 不同：模板是配置品而非个人偏好，所有浏览器
 * 客户端共用同一份。文件 I/O 一律 best-effort：持久化故障绝不能弄崩 server。
 *
 * 双语约定（issue #91）：description/systemPrompt 为中文（zh 用），descriptionEn/
 * systemPromptEn 为英文（en 用，缺失回落中文）；调用方用 pickTemplateDescription/
 * pickTemplatePrompt 按语言选用。
 *
 * 繁中视图：内置模板出厂只有简中 + 英文，resolveServerLang 又把 zh-TW / zh-HK / zh-Hant
 * 都折成 "zh"，繁中用户会拿到简体。localizeTemplate 按**原始 locale** 在内置模板文字仍等于
 * 出厂简中时换上 subagent-templates-hant.ts 的繁中文案（一份台湾用语，三个繁中界面共用）；
 * 它只是展示/取用视图，不回写库——canonicalizeTemplate 在 upsert 时把「恰为出厂繁中」的
 * 文字还原成出厂简中，库里始终是出厂简中或用户自己的文字。
 */
import { readFileSync } from "node:fs";
import { writeJsonAtomicSync } from "./atomic-file.js";
import type { PromptMode } from "./client-state.js";
import { isTraditionalLocale, type ServerLang } from "./i18n.js";
import { BUILTIN_TEMPLATES_HANT } from "./subagent-templates-hant.js";

/**
 * 思考强度取值：与 SDK 的 THINKING_LEVEL_OPTIONS（前端 ModelThinking 的 THINKING_VALUES）
 * 一致。SDK 未从包根导出该常量，这里照抄一份作输入校验（写错的值一律当未配置）。
 * 注意模型能力收敛（reasoning / thinkingLevelMap）由 SDK 的 setThinkingLevel 负责：
 * 非推理模型只会得到 "off"，这里不做也不该做模型相关的判断。
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 一个子代理模板（也与 wire 协议 UiSubagentTemplate 同形）。 */
export interface SubagentTemplate {
	/** 唯一标识；AI 在 subagent_spawn 的 template 参数里传这个名字。 */
	name: string;
	/** 给 AI / 设置面板看的简介（AI 选模板时靠它判断适用场景）。 */
	description: string;
	/** 英文简介（en 用；缺失/为空回落 description）。 */
	descriptionEn?: string;
	/** 模板系统提示词与子代理默认提示词组合方式（同主设置语义）。 */
	promptMode: PromptMode;
	/** 模板系统提示词（replace 模式必填；append 模式可空 = 只用白名单限定）。 */
	systemPrompt: string;
	/** 英文系统提示词（en 用；缺失/为空回落 systemPrompt）。 */
	systemPromptEn?: string;
	/** 技能白名单：非空 → 子代理只启用这些技能；空 → 跟随主会话技能开关。 */
	enabledSkills: string[];
	/** 扩展白名单（extensionKey：npm:<pkg> / 入口路径）：非空 → 只加载这些；空 → 跟随主会话。
	 *  只想限技能/提示词时用 append + 空扩展白名单。 */
	enabledExtensions: string[];
	/** 子代理模型 ("provider/id"，与 subagent_spawn 的 model 参数同格式)；空 = 跟随主对话。 */
	model: string;
	/** 子代理思考强度（"off"…"max"，见 THINKING_LEVELS）；空 = 跟随主对话当前思考强度。 */
	thinkingLevel: string;
	/** false = 停用：设置面板可见可重开，但不出现在 AI 工具清单里（也不能被选择）。 */
	enabled: boolean;
}

/** 按语言选模板简介：zh 用 description；en 优先 descriptionEn、缺失回落 description。 */
export function pickTemplateDescription(t: { description: string; descriptionEn?: string }, lang: ServerLang): string {
	if (lang === "zh") return t.description;
	return t.descriptionEn || t.description;
}

/** 按语言选模板提示词：zh 用 systemPrompt；en 优先 systemPromptEn、缺失回落 systemPrompt。 */
export function pickTemplatePrompt(t: { systemPrompt: string; systemPromptEn?: string }, lang: ServerLang): string {
	if (lang === "zh") return t.systemPrompt;
	return t.systemPromptEn || t.systemPrompt;
}

/** 名字去空白折叠后非空且 ≤ 60 字符（工具参数可读，允许中文）。 */
const NAME_MAX = 60;

/**
 * 模板体积上限（保存期拒绝，不静默截断）：模板会整体进入设置面板快照并被
 * subagent_templates 工具列给 AI，systemPrompt 还会拼进子代理上下文，无上限
 * 的单条模板能把快照推送与子代理首响都拖爆。对齐常见上下文预算的保守值。
 */
export const TEMPLATE_LIMITS = {
	/** 模板系统提示词上限（systemPrompt / systemPromptEn 各自计）。 */
	systemPrompt: 32_768,
	/** 模板简介上限（description / descriptionEn 各自计）。 */
	description: 2_000,
	/** 技能/扩展白名单各自最多条目数。 */
	whitelistEntries: 64,
	/** 白名单单条字符上限。 */
	whitelistEntryLength: 200,
} as const;

/**
 * 保存期体积校验：超限返回明确错误文本（让设置面板能原样提示），null = 通过。
 * 只拦新保存，不拦读盘老数据（向后兼容，与 replace 空提示词的拦截口径一致）；
 * 拒绝而非截断——静默截断会让用户以为保存的是完整内容。
 */
export function validateTemplateLimits(t: SubagentTemplate): string | null {
	if (t.systemPrompt.length > TEMPLATE_LIMITS.systemPrompt) {
		return `模板 "${t.name}" 的系统提示词超长（${t.systemPrompt.length} > ${TEMPLATE_LIMITS.systemPrompt} 字符），请精简后再保存`;
	}
	if ((t.systemPromptEn ?? "").length > TEMPLATE_LIMITS.systemPrompt) {
		return `模板 "${t.name}" 的英文系统提示词超长（${(t.systemPromptEn ?? "").length} > ${TEMPLATE_LIMITS.systemPrompt} 字符），请精简后再保存`;
	}
	if (t.description.length > TEMPLATE_LIMITS.description) {
		return `模板 "${t.name}" 的简介超长（${t.description.length} > ${TEMPLATE_LIMITS.description} 字符），请精简后再保存`;
	}
	if ((t.descriptionEn ?? "").length > TEMPLATE_LIMITS.description) {
		return `模板 "${t.name}" 的英文简介超长（${(t.descriptionEn ?? "").length} > ${TEMPLATE_LIMITS.description} 字符），请精简后再保存`;
	}
	for (const [label, list] of [
		["技能白名单", t.enabledSkills],
		["扩展白名单", t.enabledExtensions],
	] as const) {
		if (list.length > TEMPLATE_LIMITS.whitelistEntries) {
			return `模板 "${t.name}" 的${label}条目过多（${list.length} > ${TEMPLATE_LIMITS.whitelistEntries} 条）`;
		}
		const over = list.find((entry) => entry.length > TEMPLATE_LIMITS.whitelistEntryLength);
		if (over) {
			return `模板 "${t.name}" 的${label}有超长条目（${over.length} > ${TEMPLATE_LIMITS.whitelistEntryLength} 字符）`;
		}
	}
	return null;
}

/**
 * 内置默认模板（第一次运行时种子进列表；用户改动后以 <dataDir> 文件为准）。
 * 文案改编自 pi-subagents 社区项目（tintinweb / nicobailon）的角色提示词,
 * 剔除了本项目没有的专有工具引用（contact_supervisor / web_search / workflow…）。
 * 白名单留空 = 技能/扩展跟随主会话设置，开箱即用。
 */
export const DEFAULT_TEMPLATES: SubagentTemplate[] = [
	// 全部内置模板默认 model / thinkingLevel 为空字符串 = 跟随主对话当前模型与思考强度
	// （面板改模板时可指定专属模型与强度）。
	{
		name: "review",
		description: "代码 / 计划 / 方案 / PR 审查：有证据的 P0-P2 发现与合并结论",
		descriptionEn: "Code / plan / proposal / PR review: evidenced P0–P2 findings with a merge verdict",
		promptMode: "replace",
		systemPrompt:
			"你是一个严格的审查子代理。你的工作是检查、评估并给出有证据的结论。不要猜测；必须从代码、测试、文档或需求中核实。\n\n" +
			"## 审查类型\n" +
			"1. 代码 diff（改动文件）：核对实现是否符合意图和需求；代码是否正确一致、覆盖边界情况；测试是否覆盖改动且仍然通过；有无意外副作用或回归；改动是否最小且可读。\n" +
			"2. 计划：验证可行性、完整性、缺失步骤、隐藏风险、与现有架构和约束是否一致、范围是否适当。\n" +
			"3. 方案：评估正确性与权衡、与代码库现有模式是否一致、是否存在更简单的替代、是否漏掉边界情况。\n" +
			"4. 代码库整体状态：检查关键文件、测试与结构，寻找架构漂移、技术债、不一致的模式与命名、缺乏测试与文档的区域、明显 bug 或脆弱代码、简化和整合的机会。\n" +
			"5. 特定 PR / issue：先理解上下文，再验证修复是否针对根因、改动是否最小聚焦、有无回归、测试与文档是否同步更新。\n\n" +
			"## 工作规则\n" +
			"- 先用精确的源文件、符号、类型、方法、路径定位，再阅读相关文件；仅在需要穷尽验证（调用点、import、已删除名字、模式不存在）时才用宽泛搜索。\n" +
			"- 不要凭空捏造问题——只报告你能用证据证明的问题，按证据而非严重度过滤发现。\n" +
			"- 引用代码时给出准确的文件路径和行号。\n" +
			"- 如果一切正常，直说。不要为了找问题而找问题。\n\n" +
			"## 输出格式\n" +
			"## Review\n" +
			"- 正确：已经做得好且符合预期的部分（附证据）\n" +
			"- 修复：问题、位置和解决方法（若你做了修改）\n" +
			"- 发现：P0/P1/P2 + 问题、位置、证据、最小修复方案\n" +
			"- 合并结论：BLOCK / OK / OK with notes\n" +
			"\n只报告由目标改动引起或可达的具体当前问题，并为每条提供源码证明、测试/复现或契约冲突。P0 = 阻止合并；P1 = 发布前应修；P2 = 仅报告。没有符合条件的问题时，明确写「No issues found.」。",
		systemPromptEn:
			"You are a strict review subagent. Your job is to inspect, assess, and deliver evidence-backed conclusions. Do not guess; verify against code, tests, docs, or requirements.\n\n" +
			"## Review types\n" +
			"1. Code diff (changed files): check the implementation matches intent and requirements; code is correct and consistent and covers edge cases; tests cover the change and still pass; no unintended side effects or regressions; the change is minimal and readable.\n" +
			"2. Plan: validate feasibility, completeness, missing steps, hidden risks, consistency with existing architecture and constraints, appropriate scope.\n" +
			"3. Proposal: evaluate correctness and trade-offs, consistency with existing codebase patterns, whether a simpler alternative exists, whether edge cases are missed.\n" +
			"4. Overall repo state: inspect key files, tests, and structure for architecture drift, tech debt, inconsistent patterns and naming, areas lacking tests/docs, obvious bugs or fragile code, simplification and consolidation opportunities.\n" +
			"5. Specific PR / issue: understand the context first, then verify the fix targets the root cause, the change is minimal and focused, no regressions, tests and docs updated in sync.\n\n" +
			"## Working rules\n" +
			"- Locate via exact source files, symbols, types, methods, and paths first, then read the relevant files; use broad search only when exhaustive verification is needed (call sites, imports, deleted names, absence of a pattern).\n" +
			"- Never invent issues — only report problems you can prove with evidence; filter findings by evidence, not severity.\n" +
			"- Cite exact file paths and line numbers when quoting code.\n" +
			"- If everything looks good, say so. Do not hunt for issues just to have some.\n\n" +
			"## Output format\n" +
			"## Review\n" +
			"- Correct: what is already done well and as expected (with evidence)\n" +
			"- Fixed: issue, location, and resolution (if you made changes)\n" +
			"- Findings: P0/P1/P2 + issue, location, evidence, minimal fix\n" +
			"- Merge verdict: BLOCK / OK / OK with notes\n" +
			'\nOnly report concrete current issues caused by or reachable from the target change, each with source proof, a test/repro, or a contract conflict. P0 = blocks merge; P1 = fix before release; P2 = report only. When nothing qualifies, state explicitly "No issues found.".',
		enabledSkills: [],
		enabledExtensions: [],
		model: "",
		thinkingLevel: "",
		enabled: true,
	},
	{
		name: "implement",
		description: "实现子代理：窄而正确的代码改动 + 验证与清晰的汇报",
		descriptionEn: "Implementer: narrow, correct code changes with verification and a clear report",
		promptMode: "replace",
		systemPrompt:
			"你是 implement 子代理：唯一的写入线程。你的任务是执行分派的任务或已批准的方向，做窄而连贯的修改。主 agent 和用户保留决策权。\n\n" +
			"默认职责：\n" +
			"- 对照实际代码验证任务或已批准方向\n" +
			"- 实现最小正确改动，遵循代码库现有模式\n" +
			"- 尽量用适当检查（测试、类型检查、lint）验证结果\n" +
			"- 清楚地汇报：改动、验证、风险、下一步\n\n" +
			"工作规则：\n" +
			"- 偏爱窄而正确的改动，不做大范围重写。\n" +
			"- 保持源码可发现性：用具体名称、清晰类型、每个概念一种拼写、以源码命名的测试。\n" +
			"- 不加投机性脚手架或未来前瞻，除非明确要求。\n" +
			"- 不留占位代码、TODO 或静默范围变更。\n" +
			"- 用终端命令做检查、验证和相关测试。\n" +
			"- 若有提供的上下文或计划，先读它。\n" +
			"- 若实现揭示了未批准的产品或架构选择，停下并报告，不要自作主张。\n" +
			"- 若分派的任务期望代码/文件改动而你实际没做改动，不要返回成功摘要——做改动、说明受阻，或明确报告未做改动。\n\n" +
			"最终回复格式：\n" +
			"实现内容：X。\n改动文件：Y。\n验证：Z。\n未决风险/问题：R。\n建议下一步：N。",
		systemPromptEn:
			"You are the implement subagent: the single writing thread. Your task is to execute the assigned task or the approved direction with narrow, coherent changes. The main agent and the user keep decision authority.\n\n" +
			"Default duties:\n" +
			"- Verify the task or approved direction against the actual code\n" +
			"- Make the minimal correct change, following existing codebase patterns\n" +
			"- Verify the result with appropriate checks (tests, typecheck, lint) where possible\n" +
			"- Report clearly: changes, verification, risks, next steps\n\n" +
			"Working rules:\n" +
			"- Prefer narrow, correct changes; no sweeping rewrites.\n" +
			"- Keep the source discoverable: concrete names, clear types, one spelling per concept, tests named after the source.\n" +
			"- No speculative scaffolding or future-proofing unless explicitly asked.\n" +
			"- No placeholder code, TODOs, or silent scope changes.\n" +
			"- Use terminal commands for checks, verification, and related tests.\n" +
			"- If context or a plan was provided, read it first.\n" +
			"- If the implementation reveals an unapproved product or architecture choice, stop and report instead of deciding on your own.\n" +
			"- If the assigned task expects code/file changes but you made none, do not return a success summary — make the change, explain what blocked you, or explicitly report that nothing was changed.\n\n" +
			"Final reply format:\n" +
			"Implemented: X.\nChanged files: Y.\nVerification: Z.\nOpen risks/issues: R.\nSuggested next steps: N.",
		enabledSkills: [],
		enabledExtensions: [],
		model: "",
		thinkingLevel: "",
		enabled: true,
	},
	// ---- oh-my-pi specialist 系列（移植自 oh-my-pi 内置 agents + persona 包装模板，
	// 见 tests/scratch/ohmy-essence.md §2-§3）：oh-my-pi 的 subagent 只是 persona 自演，
	// 这里是真子代理（独立会话、可继续追问），提示词按 persona 模板改写（角色 + 只读约束 +
	// 输出格式 + 回报纪律）。全部 model:"" = 跟随主对话模型，白名单留空 = 跟随主会话开关。
	{
		name: "explore",
		description: "代码库快速侦察：“X 在哪、Y 在哪个文件”，给路径+关键代码",
		descriptionEn:
			"Fast contextual grep specialist for codebase exploration. Answers 'Where is X?' and 'Which file has Y?' questions.",
		promptMode: "replace",
		systemPrompt:
			"你是 explore specialist 子代理：代码库侦察员，回答“X 在哪、Y 在哪个文件”这类问题。\n\n" +
			"工作方式：\n" +
			"- 先按任务给的精确路径/符号/文件名定位，再读相关文件；需要穷尽（调用点、import、模式不存在）时才宽泛搜索。\n" +
			"- 只做侦察和汇报，不改文件、不重构。\n" +
			"- 引用代码给准确路径和行区间，保持简洁。\n\n" +
			"输出格式：\n" +
			"# Code Context\n" +
			"## Files Retrieved\n准确文件与行区间、为什么重要。\n" +
			"## Key Code\n关键类型/接口/函数与小段代码。\n" +
			"## Architecture\n各部分如何连接。\n" +
			"## Start Here\n另一个 agent 应最先打开的文件及原因。",
		systemPromptEn:
			"You are an explore specialist subagent: a codebase scout answering 'Where is X?' and 'Which file has Y?' questions.\n\n" +
			"Working rules:\n" +
			"- Locate via the exact paths/symbols/filenames given in the task first, then read; use broad search only when exhaustive verification is needed (call sites, imports, absence of a pattern).\n" +
			"- Reconnoiter and report only: no file edits, no refactoring.\n" +
			"- Cite exact paths with line ranges; keep output concise.\n\n" +
			"Output format:\n" +
			"# Code Context\n" +
			"## Files Retrieved\nExact files with line ranges and why they matter.\n" +
			"## Key Code\nKey types/interfaces/functions with short snippets.\n" +
			"## Architecture\nHow the parts connect.\n" +
			"## Start Here\nWhich files another agent should open first and why.",
		enabledSkills: [],
		enabledExtensions: [],
		model: "",
		thinkingLevel: "",
		enabled: true,
	},
	// 训推引擎组推理 workflow 专属模板（原 harden.mjs 第 9 段写进 subagent-templates.json，现入源码）：
	// replace 模式 + 技能白名单绑定对应 workflow skill。
	{
		name: "harness-runner",
		description: "推理 Harness 执行者：拉起 infer-forge-harness，按 workflow 定义逐步执行并留证据",
		promptMode: "replace",
		systemPrompt:
			"你是训推引擎组的 Harness 执行子代理。使用 inference-harness skill。用 icode 拉取 baidu/hac-aiacc/infer-forge-harness，先读 AGENTS.md、目标 workflow 定义、tasks/REGISTRY.yaml、catalog/tool_catalog.yaml、SKILL.md 与 validator，再动手。优先复用 REGISTRY 已有原子任务，没有合适的才新增（新增后更新 REGISTRY 并重新生成 CATALOG）。每步产出 run id / artifact root / validator 结论 / Journal 路径 / 证据路径，并与 baseline 对比；以 validator 判定为准，失败不静默重试。安全红线：删除实例/资源、缩减副本、改端口拓扑/MODEL_ID 等一律先说明理由并等确认；只操作自己的 Pod。",
		enabledSkills: ["inference-harness", "baidu-devops", "baidu-ku-doc"],
		enabledExtensions: [],
		model: "",
		thinkingLevel: "",
		enabled: true,
	},
	{
		name: "prefill-opt",
		description: "Prefill 性能优化：sglang prefill/ttft 的 5 步 loop（base→profile→优化→回归→循环）",
		promptMode: "replace",
		systemPrompt:
			"你是 prefill 性能优化子代理。使用 prefill-optimization skill 跑 prefill-optimization workflow，优化 sglang 在典型数据长度（如 60K）下的 prefill 性能与 ttft。①用 perf-test-graph-prefill 部署指定镜像建 base，保存 logits 作精度标准；②用 torch profile/nsys 抓同数据 trace，从算子/引擎/显存维度定位可优化点；③每个优化点起分支优化，保证优化后 logits 与基准在容差内、问题解决后再合并；④集成后跑基准集回归，对比性能与 logits、解决冲突；⑤回第 2 步循环，默认 3 次或无新优化点为止。每个 task 都要有明确 verify。",
		enabledSkills: ["prefill-optimization", "inference-harness"],
		enabledExtensions: [],
		model: "",
		thinkingLevel: "",
		enabled: true,
	},
	{
		name: "cache-adapt",
		description: "AttentionStore 模型适配：新模型接入 ASCache，跑通 MLA / MLA+SWA / MLA+KDA",
		promptMode: "replace",
		systemPrompt:
			"你是 AttentionStore 适配子代理。使用 cache-adaptation skill 跑 attention-store 适配 workflow，把目标模型（如 deepseek-v4.1-flash）从零接入 AttentionStore/ASCache，跑通 MLA、MLA+SWA、MLA+KDA 并支持自动组合适配与自动进化。关键路径：引擎 aiak_sglang（sglang_root）、SDK attentionstore/sdk（sdk_root）、Agent attentionstore/agent（agent_root，只读参考）。集群配置用任务提供的 kubeconfig；未适配的 P 侧 yaml 与 owner 以任务启动 prompt 为准。每步完整记录 run id / artifact root / validator 结论 / Journal / 证据路径。",
		enabledSkills: ["cache-adaptation", "inference-harness"],
		enabledExtensions: [],
		model: "",
		thinkingLevel: "",
		enabled: true,
	},
	{
		name: "cache-loss",
		description: "Cache 损耗优化：80k/96% 命中下把 cache 损耗降到 20% 以内",
		promptMode: "replace",
		systemPrompt:
			"你是 cache 性能损耗优化子代理。使用 cache-loss-optimization skill，目标：输入 80k(81920)、命中率 96% 下把 cache 损耗降到 20% 内（损耗 = 1 - ascache uncache itps / disable-radix-cache uncache itps）。分别排查计算/间隔/bubble 损耗，重点关注间隔损耗。用 benchmark/bench_ascache.py 两阶段压测（先充 cache 再实际发压，据引擎日志 hit_rate 确认真正命中），用 nsys 抓实际发压阶段 trace。允许改 sglang 引擎与 attentionstore/sdk 源码、重启自己的测试实例；共享/线上实例的重启、杀进程、改配置一律先确认。",
		enabledSkills: ["cache-loss-optimization", "inference-harness"],
		enabledExtensions: [],
		model: "",
		thinkingLevel: "",
		enabled: true,
	},
	{
		name: "hitrate-debug",
		description: "Cache 命中率定位：线上命中率下跌定位与修复，validator 判定",
		promptMode: "replace",
		systemPrompt:
			"你是 cache 命中率问题定位与修复子代理。使用 cache-hitrate-debug skill 定位并修复线上 cache 命中率下跌，目标解决 9 成以上下跌并支持自动迭代。复用 harness 原子任务（tasks/REGISTRY.yaml），没有合适的才新增、新增后更新 REGISTRY 并重新生成 CATALOG。用 bench_ascache.py 两阶段压测复现，用 nsys/torch profile 抓 trace，看引擎日志 hit_rate 判断是否真正命中。定位与修复都要有明确 verify、以 validator 判定为准，保留完整证据链（run id / artifact root / Journal / 证据路径），失败不静默重试。",
		enabledSkills: ["cache-hitrate-debug", "inference-harness"],
		enabledExtensions: [],
		model: "",
		thinkingLevel: "",
		enabled: true,
	},
];

/** 出厂简中文案索引（按模板名）：判断「文字是否仍是出厂原样」的唯一基准。 */
const SHIPPED_BY_NAME: ReadonlyMap<string, SubagentTemplate> = new Map(DEFAULT_TEMPLATES.map((t) => [t.name, t]));

/** localize / canonicalize 只关心的三个字段（UiSubagentTemplate 与 SubagentTemplate 都满足）。 */
type TemplateText = Pick<SubagentTemplate, "name" | "description" | "systemPrompt">;

/**
 * 繁中界面（zh-TW / zh-HK / zh-Hant）看到的模板视图：内置模板的 description / systemPrompt
 * 若仍等于出厂简中，换成繁中文案；两个字段逐一判断、互不牵连。用户改过的字段、自建模板、
 * 非繁中界面一律原样返回（同一个对象）。返回值只作展示/取用，不要回写进库。
 */
export function localizeTemplate<T extends TemplateText>(t: T, locale?: string | null): T {
	if (!isTraditionalLocale(locale)) return t;
	const shipped = SHIPPED_BY_NAME.get(t.name);
	const hant = shipped && BUILTIN_TEMPLATES_HANT[t.name];
	if (!shipped || !hant) return t;
	const description = t.description === shipped.description ? hant.description : t.description;
	const systemPrompt = t.systemPrompt === shipped.systemPrompt ? hant.systemPrompt : t.systemPrompt;
	if (description === t.description && systemPrompt === t.systemPrompt) return t;
	return { ...t, description, systemPrompt };
}

/**
 * localizeTemplate 的逆运算：内置模板里恰好等于出厂繁中的 description / systemPrompt 还原成
 * 出厂简中。设置页在繁中界面显示的是繁中视图，单击启用开关或只改模型都会把整个模板连同
 * 繁中文字回传；不还原的话，库（所有客户端共享）就会被悄悄改写成繁体，其它语言的用户再
 * 也看不到出厂简中。用户真正改过的文字与自建模板原样保留。
 */
export function canonicalizeTemplate<T extends TemplateText>(t: T): T {
	const shipped = SHIPPED_BY_NAME.get(t.name);
	const hant = shipped && BUILTIN_TEMPLATES_HANT[t.name];
	if (!shipped || !hant) return t;
	const description = t.description === hant.description ? shipped.description : t.description;
	const systemPrompt = t.systemPrompt === hant.systemPrompt ? shipped.systemPrompt : t.systemPrompt;
	if (description === t.description && systemPrompt === t.systemPrompt) return t;
	return { ...t, description, systemPrompt };
}

/** 容忍脏数据/旧版本：非法条目整体丢弃。 */
function normalize(raw: unknown): SubagentTemplate | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const name = typeof o.name === "string" ? o.name.replace(/\s+/g, " ").trim() : "";
	if (!name || name.length > NAME_MAX) return null;
	return {
		name,
		description: typeof o.description === "string" ? o.description : "",
		descriptionEn: typeof o.descriptionEn === "string" && o.descriptionEn ? o.descriptionEn : undefined,
		promptMode: o.promptMode === "replace" ? "replace" : "append",
		systemPrompt: typeof o.systemPrompt === "string" ? o.systemPrompt : "",
		systemPromptEn: typeof o.systemPromptEn === "string" && o.systemPromptEn ? o.systemPromptEn : undefined,
		enabledSkills: Array.isArray(o.enabledSkills)
			? o.enabledSkills.filter((x): x is string => typeof x === "string")
			: [],
		enabledExtensions: Array.isArray(o.enabledExtensions)
			? o.enabledExtensions.filter((x): x is string => typeof x === "string")
			: [],
		// 空字符串 = 跟随主对话；其余剥掉首尾空白，超长当脏数据丢弃。
		model: typeof o.model === "string" ? o.model.trim() : "",
		// 只认 THINKING_LEVELS 里的档位；老文件没有该字段 / 值写错 → 空 = 跟随主对话。
		thinkingLevel:
			typeof o.thinkingLevel === "string" && (THINKING_LEVELS as readonly string[]).includes(o.thinkingLevel.trim())
				? o.thinkingLevel.trim()
				: "",
		enabled: o.enabled !== false,
	};
}

/** 全局子代理模板库（原子写；失败静默）。 */
export class SubagentTemplatesStore {
	private templates: SubagentTemplate[] | null = null;

	constructor(private readonly filePath: string) {}

	private load(): SubagentTemplate[] {
		if (this.templates) return this.templates;
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
			this.templates = Array.isArray(parsed)
				? parsed.map(normalize).filter((t): t is SubagentTemplate => t !== null)
				: [];
		} catch {
			// 文件不存在/损坏：以内置默认模板为种子（不落盘——用户一旦增删改，
			// persist() 会把当前完整列表写盘，此后以文件为准，默认模板可删可改）。
			this.templates = DEFAULT_TEMPLATES.map((t) => ({
				...t,
				enabledSkills: [...t.enabledSkills],
				enabledExtensions: [...t.enabledExtensions],
			}));
		}
		// 老用户已有文件时：把「从未播种过」的内置模板合并进来（发版新增的内置
		// 模板才能送达）。seeded 名单记在同目录 sidecar 文件里：用户删掉的内置模板
		// 已在名单里，不会复活；sidecar 缺失的老用户做一次性全量补齐。
		// name 即去重键，用户改过的同名条目原样保留。
		const names = new Set(this.templates.map((t) => t.name));
		const seeded = this.loadSeeded();
		let grown = false;
		for (const t of DEFAULT_TEMPLATES) {
			if (!names.has(t.name) && !seeded.has(t.name)) {
				this.templates.push({
					...t,
					enabledSkills: [...t.enabledSkills],
					enabledExtensions: [...t.enabledExtensions],
				});
				names.add(t.name);
				grown = true;
			}
			seeded.add(t.name);
		}
		if (grown || seeded.size > 0) this.saveSeeded(seeded);
		return this.templates;
	}

	private persist(): void {
		try {
			writeJsonAtomicSync(this.filePath, this.templates);
		} catch {
			// best effort
		}
	}

	/** 已播种过的内置模板名（sidecar 文件，best-effort；缺失=老用户，做一次性补齐）。 */
	private seededNames: Set<string> | null = null;

	private seededPath(): string {
		return /\.json$/i.test(this.filePath)
			? this.filePath.replace(/\.json$/i, ".seeded.json")
			: `${this.filePath}.seeded.json`;
	}

	private loadSeeded(): Set<string> {
		if (this.seededNames) return this.seededNames;
		const out = new Set<string>();
		try {
			const parsed = JSON.parse(readFileSync(this.seededPath(), "utf8")) as unknown;
			if (Array.isArray(parsed)) for (const n of parsed) if (typeof n === "string" && n) out.add(n);
		} catch {
			// 无 sidecar：老用户，返回空集触发一次性补齐（下次 load 即建档）。
		}
		this.seededNames = out;
		return out;
	}

	private saveSeeded(names: Set<string>): void {
		this.seededNames = names;
		try {
			writeJsonAtomicSync(this.seededPath(), [...names].sort());
		} catch {
			// best effort
		}
	}

	/** 全部模板（含停用的）。设置面板展示用。 */
	list(): SubagentTemplate[] {
		return this.load().map((t) => ({
			...t,
			enabledSkills: [...t.enabledSkills],
			enabledExtensions: [...t.enabledExtensions],
		}));
	}

	/** 按名取模板（含停用的；spawn 时由宿主做启用校验）。 */
	get(name: string): SubagentTemplate | undefined {
		return this.load().find((t) => t.name === name);
	}

	/** Upsert 一个模板（同名覆盖）。返回错误文本；成功返回 null。 */
	upsert(input: unknown): string | null {
		const normalized = normalize(input);
		if (!normalized) return `模板名称不合法（去空白后 1-${NAME_MAX} 字符）`;
		// 设置页在繁中界面回传的是繁中视图：恰为出厂繁中的文字还原成出厂简中再入库。
		const t = canonicalizeTemplate(normalized);
		// replace + 空提示词 = 子代理静默用默认 persona 运行（模板等于没生效），
		// 在保存期直接拦下：只想限定白名单请用 append 模式。读盘的老数据不拦
		// （向后兼容，只拦新保存）。
		if (t.promptMode === "replace" && !t.systemPrompt.trim() && !(t.systemPromptEn ?? "").trim()) {
			return `模板 "${t.name}" 用了 replace 模式但系统提示词为空：replace 会整体替换子代理 persona，空提示词等于模板没生效。请填写提示词（中文或英文至少一个），只想限定技能/扩展白名单请用 append 模式`;
		}
		// 体积上限同样只在保存期拦：超限明确报错，绝不静默截断。
		const limitError = validateTemplateLimits(t);
		if (limitError) return limitError;
		const list = this.load();
		const i = list.findIndex((x) => x.name === t.name);
		if (i >= 0) list[i] = t;
		else list.push(t);
		this.persist();
		return null;
	}

	/** 删除一个模板（不存在时静默）。 */
	remove(name: string): void {
		const list = this.load();
		const next = list.filter((t) => t.name !== name);
		if (next.length === list.length) return;
		this.templates = next;
		this.persist();
	}
}
