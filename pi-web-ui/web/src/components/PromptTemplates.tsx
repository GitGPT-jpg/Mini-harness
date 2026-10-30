import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiEdit2, FiPlus, FiRotateCcw, FiSend, FiTrash2, FiX } from "react-icons/fi";
import { useT } from "../i18n";
import { randomUuid } from "../uuid";
import { appSend } from "../app-globals";
import { recordModelUsage } from "../model-usage";

/* ------------------------------------------------------------------ */
/* 提示词模板（prompt templates）                                        */
/*                                                                     */
/* 一套可复用的完整提示词，不只在「新对话空态」可用——通过 TemplateProvider    */
/* 把数据与弹窗提升到全局：空态显示推荐卡片，对话中途也能随时从输入框工具条    */
/* 打开同一个模板库。增删改在任意入口都可用：                               */
/*   - 模板库卡片 hover 直接出现 🗑（内置模板=移出模板库，自定义=删除）        */
/*   - 点卡片打开编辑弹窗：改内容→保存修改；内置可移出、自定义可删除；        */
/*   - 保存/删除后自动回到模板库列表，能看到变化。                           */
/* 持久化在 localStorage（pi-web-ui:prompt-templates）。                  */
/* 内置模板是训推引擎组推理 workflow 的启动提示词（见 BUILTIN_DEFS）。      */
/* ------------------------------------------------------------------ */

interface Template {
	id: string;
	icon: string;
	/** 卡片上显示的短标题。 */
	title: string;
	/** 卡片上的一句话说明。 */
	desc: string;
	/** 完整的复杂提示词（与按钮文字不同，比标题长得多）。 */
	prompt: string;
	/** 内置模板（本地化默认值，可被 localStorage 覆盖 / 移出）。 */
	builtin?: boolean;
	/** 表单校验错误（仅在 modal 内短暂存在）。 */
	error?: string;
}

/** localStorage 里的一条：要么是完整模板（自定义 / 内置覆盖），要么是内置的
 *  移出标记 { id, hidden: true }。 */
interface StoredTemplate {
	id: string;
	icon?: string;
	title?: string;
	desc?: string;
	prompt?: string;
	hidden?: boolean;
}

interface BuiltinDef {
	id: string;
	icon: string;
	title: string;
	desc: string;
	prompt: string;
}

/** 内置模板：训推引擎组推理 workflow 的启动提示词（沉淀自 5 个 workflow skill 的 SKILL.md
 *  与 Ku「AI Loop 异步化任务跟踪表」里的真实启动 prompt；task 级参数用 <尖括号> 占位，
 *  发送前替换）。点卡片填入输入框，✏️ 可编辑/移出。 */
const BUILTIN_DEFS: BuiltinDef[] = [
	{
		id: "inf-harness-start",
		icon: "🧭",
		title: "Harness 通用启动",
		desc: "infer-forge-harness 通用 AI Loop：先读规范、复用原子任务、每步 verify、留证据",
		prompt:
			"使用 inference-harness skill 启动一次推理服务 AI Loop。先用 icode 拉取 baidu/hac-aiacc/infer-forge-harness 并进入仓库，按顺序先读 AGENTS.md、目标 workflow 定义、task 合约、tasks/REGISTRY.yaml、catalog/tool_catalog.yaml、SKILL.md 与 validator，再动手。明确本次 workflow 与目标模型（如 deepseek-v4.1-flash）。优先复用 REGISTRY 已有原子任务，没有合适的才新增、新增后更新 REGISTRY 并重新生成 CATALOG。每步都要有明确 verify，以 validator 判定为准（返回码/PASS 字样/manifest 都不算通过）。每步产出 run id、artifact root、节点状态、validator 结论、Journal 路径、证据路径，并与 baseline 对比。失败保留原始证据，不打补丁绕过、不静默重试。安全红线：删除实例/资源、缩减副本、杀进程、改端口拓扑/MODEL_ID/配置等高危操作一律先说明理由并等确认；只操作自己的 Pod，共享/线上实例变更必须人工确认。",
	},
	{
		id: "inf-prefill",
		icon: "⚡",
		title: "Prefill 性能优化",
		desc: "sglang prefill/ttft 的 5 步 loop（base→profile→subagent→回归→循环）",
		prompt:
			"本项目是推理服务的 harness，里面有定义了 prefill 性能优化的工作流 prefill-optimization。请先进入本地 harness 代码库，再帮我运行这个工作流来优化 <目标模型，如 Deepseek v4.1-Flash>。\n步骤：1) 建立 base——指定 sglang 服务镜像，通过 perf-test-graph-prefill 部署并测试典型数据长度（如 60K）下的 prefill 性能与 ttft，保存 logits 作为精度标准；2) 性能 profile——用 torch profile 或 nsys 抓相同数据 trace，从算子/引擎/显存维度挖掘可优化点；3) subagent 优化——每个可优化点起一个 subagent 拉分支优化，保证优化后 logits 与基准在容差内且问题解决，再合并回主分支；4) 回归测试——集成后跑基准数据集，对比性能与 logits、解决冲突、保证正确并输出结果；5) 回到 2→3→4 循环，默认 3 次或无新优化点为止。每个 task 都要有明确 verify。\n环境（按实际替换）：集群 kubeconfig=<kubeconfig 路径>，prefill 启动 yaml=<prefill yaml 路径>，已启动实例=<pod 名>（内含 sglang 代码与模型权重）。请开始整个工作流并做好完整记录与回顾。",
	},
	{
		id: "inf-cache-adapt",
		icon: "🧩",
		title: "Cache 适配（AttentionStore）",
		desc: "新模型从零接入 AS-Cache，跑通 MLA / MLA+SWA / MLA+KDA",
		prompt:
			"本项目是推理服务的 harness，里面定义了 attention-store 适配的 workflow。请从头开始完整运行这个工作流，实现 <目标模型，如 ds v4.1-flash> 的 as-cache 适配，跑通 MLA、MLA+SWA、MLA+KDA，并支持自动组合适配与自动进化。\n环境（按实际替换）：集群 kubeconfig=<kubeconfig 路径>；未适配的 P 侧 yaml=<prefill yaml 路径>，owner=<owner>；相关代码路径：sglang_root=<aiak_sglang 路径>，sdk_root=<attentionstore/sdk 路径>，agent_root=<attentionstore/agent 路径，只读参考，用于确认接口与参数>。\n请开始整个工作流并做好完整记录与回顾（每步 run id / artifact root / validator 结论 / Journal / 证据路径）。",
	},
	{
		id: "inf-cache-loss",
		icon: "📉",
		title: "Cache 损耗优化",
		desc: "80k/96% 命中下把 cache 损耗降到 20% 以内（bench_ascache 两阶段压测）",
		prompt:
			'帮我创建一个优化 cache 性能损耗的任务，目标：<输入长度，如 80k(81920)> 输入、<命中率，如 96%> 命中率场景下 cache 损耗达到 20% 以下。\ncache 损耗定义：开启 ASCache 场景 uncache itps 相对 disable-radix-cache 场景 uncache itps 缩减的比例（1 - ascache uncache itps / disable-radix-cache uncache itps）。损耗分计算损耗、间隙损耗（通常高优关注）、以及有 PP 时的 bubble 损耗。\n环境（按实际替换）：引擎 sglang 代码=<sglang 路径>，模型路径=<模型 tokenizer/权重路径>，可用 pod=<pod 名>，SDK=<attentionstore/sdk 路径>，启动脚本=<start.sh 路径>，无基线 ITPS=<基线值>。\n压测用自研 bench_ascache.py（两阶段：先充 cache 再实际发压，抓 nsys/profile 只抓实际发压阶段，据引擎日志 hit_rate 判断是否真命中）：\npython3 benchmark/bench_ascache.py --host 127.0.0.1 --port 8000 --total-len 81920 --target-hit-rates "0.96" --batch-size 64 --num-rounds 1 --tokenizer <模型路径> --output-file ascache_80k.json\n允许优化引擎源码、重启/杀引擎、改引擎配置与 SDK（仅限自己的测试实例；共享/线上实例一律停下确认）。trace 与 loop 证据输出目录自定。可参考引擎历史 cache 损耗留档与 harness cache 损耗优化 loop 里的提示词。',
	},
	{
		id: "inf-hitrate",
		icon: "🎯",
		title: "Cache 命中率定位修复",
		desc: "线上命中率下跌定位与修复，validator 判定、留完整证据链",
		prompt:
			"使用 cache-hitrate-debug skill 定位并修复线上 cache 命中率下跌问题，目标解决 9 成以上命中率下跌并支持自动迭代。复用 harness 原子任务（tasks/REGISTRY.yaml），没有合适的才新增、新增后更新 REGISTRY 并重新生成 CATALOG。用 bench_ascache.py 两阶段压测复现，用 nsys/torch profile 抓 trace，据引擎日志 hit_rate 判断是否真正命中 cache。定位与修复都要有明确 verify、以 validator 判定为准，保留完整证据链（run id / artifact root / Journal / 证据路径），失败不静默重试。环境（按实际替换）：模型=<目标模型>，集群/实例=<kubeconfig 与 pod>。",
	},
	{
		id: "inf-cudaipc",
		icon: "🔗",
		title: "AS-SDK CudaIPC 传输改造验证",
		desc: "KVCache 传输 PosixSHM→CudaIPC(as-mover)，优化 Prefill 启动时间、不劣化精度/吞吐",
		prompt:
			"基于 infer-forge-harness 设计并执行一个验证工作流：attention-store-sdk 的 KVCache 传输从 PosixSHM 改为独立进程 as-mover 用 CudaIPC（共享显存）。核心目标是优化 Prefill 启动时间，同时保证功能、精度与 Cache 吞吐损耗不劣化。采用最小可用版本、分步推进，每步跟我确认后再进入下一步。\n工作方式：先读 AGENTS.md、目标 workflow、task 合约、SKILL.md 与 validator 再动手；优先复用 REGISTRY 原子任务。代码改动落在 Pod 内代码库（本地写→kubectl cp 进 Pod→Pod 内编译测试），改动通过 PYTHONPATH 注入不改镜像（AS_SDK_ROOT=<sdk 路径>，SGLANG_ROOT=<sglang 路径>）。先不提交代码，留给我 review。\n环境（按实际替换）：kubeconfig=<kubeconfig>，引擎版本=<版本>，线上配置（权威只读不 apply）=<线上 yaml>，线下测试配置=<线下 yaml>，专用实例=<prefill/decode pod>。\n阶段：0 环境证明+部署注册（端口与线上一致，引擎 HTTP_PORT=8000、PD router 30000）→1 Baseline（吞吐损耗 + Prefill 启动时间，bench_ascache.py 重复≥3 次）→2 as-mover 单测（先给方案我 review）→3 Prefill 单点（先起 as-mover 再起引擎，对比 baseline）→4 完整 PD 回归（迁到 Decode，千帆网关打通完整推理，功能+OpenCompass 精度回归）→5 压测（aiakperf 经网关，QPS 1.0）。\n每步交付：run id、artifact root、节点状态、validator 结论、Journal 路径、证据路径、与 baseline 对比（损耗% / Prefill 启动时间）。以 validator 判定为准，失败保留证据不静默重试。\n安全红线：删除实例/资源、缩副本一律停下由我执行（kubectl delete 与缩副本外其他 kubectl 已授权）；只操作自己的 Pod；不擅改端口/拓扑/MODEL_ID，一切以线上 yaml 为准、要改先确认。",
	},
	{
		id: "inf-kvcache-nextgen",
		icon: "🧱",
		title: "下一代 KV Cache 架构（radix/allocator/overlap）",
		desc: "harness 跑通 radix tree 拆分 / allocator 拆分 / cache 操作与 forward overlap",
		prompt:
			"基于 infer-forge-harness 推进下一代 KV Cache 架构改造，里程碑：1) 与方案对齐关键路径和实现；2) Harness 平台初步跑通流程；3) 基于 Harness 跑通业务结果——完成 radix tree 拆分并验收通过、完成 allocator 拆分并验收通过、完成 cache 操作与 forward 并行 overlap 并验收通过。\n工作方式：先读 AGENTS.md / 目标 workflow / task 合约 / SKILL.md / validator 再动手，优先复用 REGISTRY 原子任务，产物与 Journal 放仓库外，每步有明确 verify、以 validator 判定为准。环境（按实际替换）：kubeconfig=<kubeconfig>，实例=<pod>，代码路径=<sglang/sdk 路径>。每步产出 run id / artifact root / validator 结论 / Journal / 证据路径并与 baseline 对比。安全红线同 harness 总纲（高危操作先确认、只动自己的 Pod）。",
	},
	{
		id: "inf-runtime-loop",
		icon: "🛡️",
		title: "受控 Loop（validator 门禁 + 自动迭代）",
		desc: "用运行时启动任务：validator 不通过自动带证据进入下一轮，通过才算完成，可断点续跑",
		prompt:
			"用 mini-harness 运行时启动一个受 validator 约束的任务（不要用普通对话硬跑）。\n\n调用 loop_start：\n- goal：<要达成的目标，写清可验证的完成条件>\n- validateCmd：<validator 命令，例如 python3 validate.py 或 infer-forge-harness 的 validate.py 路径>\n- harnessRoot：<可选，harness 仓库根目录>\n- maxRounds：<默认 5>\n\n然后 loop_plan 写出计划并直接修改工作区；完成每轮时调用 loop_done(summary)。\n规则：运行时会自动执行 validator；不通过会带着证据自动进入下一轮，直到通过或达到最大轮数。不要自行宣布完成，不要向用户提问，不要重复已完成的步骤。",
	},
];

const STORAGE_KEY = "pi-web-ui:prompt-templates";

function loadStored(): StoredTemplate[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(c): c is StoredTemplate => !!c && typeof c === "object" && typeof (c as StoredTemplate).id === "string",
		);
	} catch {
		return [];
	}
}

function isBuiltinId(id: string): boolean {
	return BUILTIN_DEFS.some((b) => b.id === id);
}

/** 该 stored 条目是否为「完整模板」（区别于内置移出标记）。 */
function isFullTemplate(s: StoredTemplate): s is StoredTemplate & { title: string } {
	return typeof s.title === "string";
}

/* ------------------------------------------------------------------ */
/* context                                                              */
/* ------------------------------------------------------------------ */

interface TemplateApi {
	/** 有效模板：内置（未移出，应用覆盖）+ 自定义，按序排列。 */
	templates: Template[];
	/** 把一段提示词填入输入框（dispatch pi-web:fill）。 */
	fill: (text: string) => void;
	/** 打开模板库弹窗（对话中输入框按钮入口）。 */
	openPicker: () => void;
	/** 打开某个模板的编辑弹窗；无参 = 新建。 */
	openEdit: (tpl?: Template) => void;
	/** 「恢复默认模板」两步确认状态。 */
	resetConfirm: boolean;
	/** 「恢复默认模板」：第一次点进入确认态，确认态下再点清空自定义/覆盖/移出。 */
	toggleReset: () => void;
}

const TemplateCtx = createContext<TemplateApi | null>(null);

/** 在 TemplateProvider 内读取模板库能力。 */
export function useTemplates(): TemplateApi {
	const v = useContext(TemplateCtx);
	if (!v) throw new Error("useTemplates must be used within TemplateProvider");
	return v;
}

/* ------------------------------------------------------------------ */
/* Provider：数据 + 选择器弹窗 + 编辑弹窗                                */
/* ------------------------------------------------------------------ */

export function TemplateProvider({
	children,
	currentModelId,
}: {
	/** 发送消息（来自 useChat；socket 未就绪时返回 false）。 */
	children: ReactNode;
	/** 当前模型的 "provider/id" 复合键（模板编辑弹窗直接发送时记一次使用次数）。 */
	currentModelId: string | null;
}) {
	/** 持久化的自定义 / 内置覆盖 / 内置移出标记。 */
	const [stored, setStored] = useState<StoredTemplate[]>(loadStored);
	/** 模板库（选择器）弹窗是否打开。 */
	const [pickerOpen, setPickerOpen] = useState(false);
	/** 正在编辑的模板（modal 工作副本）；null = 关闭。 */
	const [editing, setEditing] = useState<Template | null>(null);
	/** 是否「新建」模式（区别于编辑已有模板）。 */
	const [isNew, setIsNew] = useState(false);
	/** 「恢复默认模板」两步确认。 */
	const [resetConfirm, setResetConfirm] = useState(false);
	/** 编辑弹窗是否由模板库发起（保存/删除后应回到列表）。 */
	const [fromPicker, setFromPicker] = useState(false);

	// 持久化：localStorage 里存的是自定义 + 内置覆盖 + 移出标记。
	useEffect(() => {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
		} catch {
			/* storage 不可用则忽略 */
		}
	}, [stored]);

	// 有效模板 = 内置（未移出，应用覆盖） + 自定义。
	const templates = useMemo(() => {
		const overrides = new Map<string, StoredTemplate>();
		const hiddenIds = new Set<string>();
		for (const s of stored) {
			if (s.hidden) hiddenIds.add(s.id);
			else if (isFullTemplate(s) && !isBuiltinId(s.id)) overrides.set(s.id, s);
			else if (isFullTemplate(s)) overrides.set(s.id, s); // 内置覆盖
		}
		const builtins: Template[] = BUILTIN_DEFS.filter((d) => !hiddenIds.has(d.id)).map((d) => {
			const o = overrides.get(d.id);
			return {
				id: d.id,
				icon: o?.icon ?? d.icon,
				title: o?.title ?? d.title,
				desc: o?.desc ?? d.desc,
				prompt: o?.prompt ?? d.prompt,
				builtin: true,
			};
		});
		const extras = stored
			.filter((s) => isFullTemplate(s) && !isBuiltinId(s.id))
			.map((s) => ({
				id: s.id,
				icon: s.icon ?? "📌",
				title: s.title ?? "",
				desc: s.desc ?? "",
				prompt: s.prompt ?? "",
			}));
		return [...builtins, ...extras];
	}, [stored]);

	const openPicker = useCallback(() => setPickerOpen(true), []);
	const fill = useCallback((text: string) => {
		window.dispatchEvent(new CustomEvent("pi-web:fill", { detail: text }));
	}, []);
	const openEdit = useCallback((tpl?: Template, from = false) => {
		setFromPicker(from);
		if (tpl) {
			setIsNew(false);
			setEditing({ ...tpl });
		} else {
			setIsNew(true);
			setEditing({
				id: randomUuid(),
				icon: "📌",
				title: "",
				desc: "",
				prompt: "",
			});
		}
	}, []);
	const closeAll = useCallback(() => {
		setPickerOpen(false);
		setEditing(null);
		setFromPicker(false);
	}, []);
	const toggleReset = useCallback(() => {
		if (resetConfirm) {
			setStored([]);
			setResetConfirm(false);
		} else {
			setResetConfirm(true);
		}
	}, [resetConfirm]);
	// 审查 #5：5s 复位走 effect（可在卸载/再次点击时清理，不再裸 setTimeout 悬挂）。
	useEffect(() => {
		if (!resetConfirm) return;
		const id = setTimeout(() => setResetConfirm(false), 5000);
		return () => clearTimeout(id);
	}, [resetConfirm]);

	// 选择器里：点卡片 = 直接填入输入框；点 ✏️ = 进编辑弹窗；点「新建」= 新建。
	const pickFill = useCallback(
		(tpl: Template) => {
			setPickerOpen(false);
			fill(tpl.prompt);
		},
		[fill],
	);
	const pickEdit = useCallback(
		(tpl: Template) => {
			setPickerOpen(false);
			openEdit(tpl, true);
		},
		[openEdit],
	);
	const pickNew = useCallback(() => {
		setPickerOpen(false);
		openEdit(undefined, true);
	}, [openEdit]);

	// 保存：校验后的清理值写入 stored。
	const saveEdit = useCallback(
		(cleaned: Template) => {
			setStored((prev) => {
				const idx = prev.findIndex((c) => c.id === cleaned.id);
				if (idx >= 0) {
					const next = [...prev];
					next[idx] = cleaned;
					return next;
				}
				return [...prev, cleaned];
			});
			setEditing(null);
			if (fromPicker) {
				setPickerOpen(true);
				setFromPicker(false);
			}
		},
		[fromPicker],
	);

	// 删除：自定义 = 移除；内置 = 移出模板库（打 hidden 标记，可在「恢复默认」找回）。
	const removeTemplate = useCallback(
		(tpl: Template) => {
			setStored((prev) => {
				if (tpl.builtin) {
					const rest = prev.filter((c) => c.id !== tpl.id);
					return [...rest, { id: tpl.id, hidden: true }];
				}
				return prev.filter((c) => c.id !== tpl.id);
			});
			setEditing(null);
			if (fromPicker) {
				setPickerOpen(true);
				setFromPicker(false);
			}
		},
		[fromPicker],
	);

	// 恢复默认：撤掉内置模板的覆盖（保留在列表，显示内置默认；不取消移出标记）。
	const restoreOverride = useCallback(
		(tpl: Template) => {
			setStored((prev) => prev.filter((c) => c.id !== tpl.id || c.hidden));
			setEditing(null);
			if (fromPicker) {
				setPickerOpen(true);
				setFromPicker(false);
			}
		},
		[fromPicker],
	);

	const api = useMemo<TemplateApi>(
		() => ({
			templates,
			fill,
			openPicker,
			openEdit,
			resetConfirm,
			toggleReset,
		}),
		[templates, fill, openPicker, openEdit, resetConfirm, toggleReset],
	);

	const hasOverride = editing ? stored.some((c) => c.id === editing.id && !c.hidden && isFullTemplate(c)) : false;

	return (
		<TemplateCtx.Provider value={api}>
			{children}

			{pickerOpen && (
				<PickerModal
					templates={templates}
					resetConfirm={resetConfirm}
					onFill={pickFill}
					onEditTpl={pickEdit}
					onNew={pickNew}
					onResetToggle={toggleReset}
					onClose={closeAll}
				/>
			)}

			{editing && (
				<EditModal
					editing={editing}
					isNew={isNew}
					hasOverride={hasOverride}
					onDraft={setEditing}
					onSave={saveEdit}
					onRestore={() => restoreOverride(editing)}
					onRemove={() => removeTemplate(editing)}
					onFill={() => {
						window.dispatchEvent(new CustomEvent("pi-web:fill", { detail: editing.prompt }));
						closeAll();
					}}
					onSend={() => {
						const text = editing.prompt.trim();
						// 模板直发同样算一次当前模型的使用（下拉按次数排序）。
						if (text && appSend({ type: "prompt", text, queue: false })) {
							if (currentModelId) recordModelUsage(currentModelId);
							closeAll();
						}
					}}
					onClose={closeAll}
				/>
			)}
		</TemplateCtx.Provider>
	);
}

/* ------------------------------------------------------------------ */
/* 空态推荐卡片（新对话 welcome 页）                                     */
/* ------------------------------------------------------------------ */

export function EmptyTemplateCards() {
	const t = useT();
	const { templates, fill, openEdit, toggleReset, resetConfirm } = useTemplates();

	return (
		<div className="empty-templates">
			<div className="empty-templates-head">
				<span className="empty-templates-title">{t("tpl.title")}</span>
				<span className="empty-templates-hint">{t("tpl.hint")}</span>
			</div>
			<div className="empty-templates-grid">
				{templates.map((tpl) => (
					<TemplateCard
						key={tpl.id}
						tpl={tpl}
						title={t("tpl.clickCard")}
						onFill={() => fill(tpl.prompt)}
						onEdit={() => openEdit(tpl)}
						editTitle={t("tpl.editTpl")}
					/>
				))}
				<button type="button" className="empty-template add" onClick={() => openEdit()} title={t("tpl.add")}>
					<span className="empty-template-icon">
						<FiPlus />
					</span>
					<span className="empty-template-main">
						<span className="empty-template-title">{t("tpl.add")}</span>
						<span className="empty-template-desc">{t("tpl.addDesc")}</span>
					</span>
				</button>
			</div>
			<div className="empty-templates-foot">
				<button type="button" className="empty-templates-reset" onClick={toggleReset}>
					<FiRotateCcw />
					{resetConfirm ? t("tpl.resetConfirm") : t("tpl.reset")}
				</button>
			</div>
		</div>
	);
}

/** 单张模板卡片（空态与选择器弹窗共用）：点卡片 = 填入输入框；✏️ = 编辑/删除。 */
function TemplateCard({
	tpl,
	title,
	onFill,
	onEdit,
	editTitle,
}: {
	tpl: Template;
	title?: string;
	onFill: () => void;
	onEdit: () => void;
	editTitle?: string;
}) {
	const t = useT();
	return (
		<button type="button" className="empty-template" title={title} onClick={onFill}>
			<span className="empty-template-icon">{tpl.icon}</span>
			<span className="empty-template-main">
				<span className="empty-template-title">{tpl.title}</span>
				<span className="empty-template-desc">{tpl.desc}</span>
			</span>
			<span
				className="template-card-ops"
				role="button"
				title={editTitle ?? t("tpl.editTpl")}
				onClick={(e) => {
					e.stopPropagation();
					onEdit();
				}}
			>
				<FiEdit2 />
			</span>
		</button>
	);
}

/* ------------------------------------------------------------------ */
/* 模板库（选择器）弹窗                                                  */
/* ------------------------------------------------------------------ */

function PickerModal({
	templates,
	resetConfirm,
	onFill,
	onEditTpl,
	onNew,
	onResetToggle,
	onClose,
}: {
	templates: Template[];
	resetConfirm: boolean;
	onFill: (tpl: Template) => void;
	onEditTpl: (tpl: Template) => void;
	onNew: () => void;
	onResetToggle: () => void;
	onClose: () => void;
}) {
	const t = useT();

	// Esc 关闭。
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal template-picker" onClick={(e) => e.stopPropagation()}>
				{/* 顶栏（标题 + 关闭）固定，不随卡片列表滚动 */}
				<div className="template-picker-top">
					<div className="template-picker-head">
						<span className="template-picker-title">{t("tpl.pickerTitle")}</span>
						<button type="button" className="btn template-modal-close" title={t("close")} onClick={onClose}>
							<FiX />
						</button>
					</div>
					<div className="template-picker-hint">{t("tpl.pickerHint")}</div>
				</div>
				{/* 只有卡片列表滚动 */}
				<div className="template-picker-scroll">
					<div className="template-picker-grid">
						{templates.map((tpl) => (
							<TemplateCard
								key={tpl.id}
								tpl={tpl}
								title={t("tpl.clickCard")}
								onFill={() => onFill(tpl)}
								onEdit={() => onEditTpl(tpl)}
								editTitle={t("tpl.editTpl")}
							/>
						))}
						<button type="button" className="empty-template add" onClick={onNew} title={t("tpl.add")}>
							<span className="empty-template-icon">
								<FiPlus />
							</span>
							<span className="empty-template-main">
								<span className="empty-template-title">{t("tpl.add")}</span>
								<span className="empty-template-desc">{t("tpl.addDesc")}</span>
							</span>
						</button>
					</div>
				</div>
				<div className="template-picker-foot">
					<button type="button" className="empty-templates-reset" onClick={onResetToggle}>
						<FiRotateCcw />
						{resetConfirm ? t("tpl.resetConfirm") : t("tpl.reset")}
					</button>
				</div>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/* 编辑弹窗                                                             */
/* ------------------------------------------------------------------ */

function EditModal({
	editing,
	isNew,
	hasOverride,
	onDraft,
	onSave,
	onRestore,
	onRemove,
	onFill,
	onSend,
	onClose,
}: {
	editing: Template;
	isNew: boolean;
	hasOverride: boolean;
	onDraft: (t: Template) => void;
	onSave: (cleaned: Template) => void;
	onRestore: () => void;
	onRemove: () => void;
	onFill: () => void;
	onSend: () => void;
	onClose: () => void;
}) {
	const t = useT();
	const taRef = useRef<HTMLTextAreaElement>(null);

	// Esc 关闭。
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// modal 里提示词 textarea 的自适应高度（复用输入框同款逻辑）。
	useEffect(() => {
		const ta = taRef.current;
		if (!ta) return;
		ta.style.height = "auto";
		const capped = ta.scrollHeight > 300;
		ta.style.height = `${Math.min(ta.scrollHeight, 300)}px`;
		ta.style.overflowY = capped ? "auto" : "hidden";
	}, [editing.prompt]);

	const save = () => {
		const title = editing.title.trim();
		const prompt = editing.prompt.trim();
		if (!title || !prompt) {
			onDraft({ ...editing, error: t("tpl.required") });
			return;
		}
		onSave({
			id: editing.id,
			icon: editing.icon.trim() || "📌",
			title,
			desc: editing.desc.trim(),
			prompt,
		});
	};

	const isBuiltin = !!editing.builtin && !isNew;

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal template-modal" onClick={(e) => e.stopPropagation()}>
				<div className="template-modal-head">
					<span className="template-modal-icon">{editing.icon}</span>
					<span className="template-modal-badge">{isBuiltin ? t("tpl.builtin") : t("tpl.custom")}</span>
					<span className="template-modal-title">{isNew ? t("tpl.newTitle") : t("tpl.editTitle")}</span>
					<button type="button" className="btn template-modal-close" title={t("close")} onClick={onClose}>
						<FiX />
					</button>
				</div>

				{/* 字段区可滚动，头（标题）/ 尾（操作）固定 */}
				<div className="template-modal-body">
					<label className="template-field">
						<span className="template-field-label">{t("tpl.fieldIcon")}</span>
						<input
							className="template-field-input icon"
							value={editing.icon}
							maxLength={4}
							onChange={(e) => onDraft({ ...editing, icon: e.target.value })}
						/>
					</label>

					<label className="template-field">
						<span className="template-field-label">{t("tpl.fieldTitle")}</span>
						<input
							className="template-field-input"
							value={editing.title}
							placeholder={t("tpl.fieldTitlePh")}
							onChange={(e) => onDraft({ ...editing, title: e.target.value })}
						/>
					</label>

					<label className="template-field">
						<span className="template-field-label">{t("tpl.fieldDesc")}</span>
						<input
							className="template-field-input"
							value={editing.desc}
							placeholder={t("tpl.fieldDescPh")}
							onChange={(e) => onDraft({ ...editing, desc: e.target.value })}
						/>
					</label>

					<label className="template-field">
						<span className="template-field-label">{t("tpl.fieldPrompt")}</span>
						<textarea
							ref={taRef}
							className="template-field-prompt"
							value={editing.prompt}
							placeholder={t("tpl.fieldPromptPh")}
							onChange={(e) => onDraft({ ...editing, prompt: e.target.value })}
						/>
					</label>
				</div>

				{editing.error && <div className="template-error">{editing.error}</div>}

				<div className="template-modal-actions">
					<div className="template-modal-actions-left">
						{!isNew && isBuiltin && hasOverride && (
							<button type="button" className="btn template-btn ghost" title={t("tpl.restoreTip")} onClick={onRestore}>
								{t("tpl.restore")}
							</button>
						)}
						{!isNew && isBuiltin && (
							<button
								type="button"
								className="btn template-btn ghost danger"
								title={t("tpl.removeTip")}
								onClick={onRemove}
							>
								<FiTrash2 /> {t("tpl.remove")}
							</button>
						)}
						{!isNew && !isBuiltin && (
							<button
								type="button"
								className="btn template-btn ghost danger"
								title={t("tpl.deleteTip")}
								onClick={onRemove}
							>
								<FiTrash2 /> {t("tpl.delete")}
							</button>
						)}
					</div>
					<div className="template-modal-actions-right">
						<button type="button" className="btn template-btn" onClick={save}>
							{t("tpl.save")}
						</button>
						<button type="button" className="btn template-btn fill" onClick={onFill} title={t("tpl.fillTip")}>
							{t("tpl.fill")}
						</button>
						<button type="button" className="btn template-btn send" onClick={onSend} title={t("tpl.sendTip")}>
							<FiSend /> {t("tpl.sendNow")}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
