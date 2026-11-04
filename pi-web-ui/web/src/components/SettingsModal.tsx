import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
	FiArchive,
	FiChevronDown,
	FiChevronUp,
	FiClock,
	FiCpu,
	FiEdit2,
	FiEdit3,
	FiEye,
	FiMessageSquare,
	FiPlus,
	FiRefreshCw,
	FiSearch,
	FiSend,
	FiSettings,
	FiShield,
	FiVolume2,
	FiSliders,
	FiTool,
	FiTrash2,
	FiUpload,
	FiUsers,
	FiX,
} from "react-icons/fi";
import { HintTip } from "./HintTip";
import { presetText } from "./DshPresetBar";
import { DSH_PERMISSION_ORDER, permLabelKey } from "./DshPermissionBar";
import { ToolPromptEditor } from "./ToolPromptEditor";
import type {
	CommandDef,
	DshPermissionOption,
	RemoteSkillSummary,
	SchedulerTaskView,
	UiAgentPreset,
	UiAlign,
	UiApprovalRule,
	UiLayoutPrefs,
	UiSlotId,
	UiSettingsState,
	UiSkillInfo,
	UiSubagentTemplate,
	UiToolPromptOverride,
} from "../types";
import { SchedulerPanel } from "./SchedulerPanel";
import { NotifyToggle } from "./NotifyToggle";
import {
	clearPromptHistory,
	loadPromptHistory,
	loadPromptHistorySettings,
	savePromptHistorySettings,
} from "../prompt-history";
import { randomUuid } from "../uuid";
import { THINKING_VALUES } from "../thinking-levels";
import { formatTokenDraft, parseTokenInput } from "../token-input";
import { useWideChat, saveChatWidthSettings, useHideModelRow, saveHideModelRowSettings } from "../chat-width-settings";
import { usePresentAutoOpen, savePresentAutoOpen } from "../present-settings";
import { type SendKey, saveSendKeyPref, useEffectiveSendKey } from "../composer-keys";
import { useProjectTitle, saveTitleSettings } from "../title-settings";
import { sanitizeWallpaperUrl, fileToWallpaperUrl, saveWallpaperSettings, useWallpaperSettings } from "../wallpaper";
import { isZhLocale, useT, useI18n } from "../i18n";
import { useEscapeKey } from "../shortcut-stack";
import {
	buildUiSlots,
	HIDDEN_FROM_LAYOUT_ITEM_IDS,
	REQUIRED_TOPBAR_ITEM_IDS,
	restoreAllUi,
	restoreUiItem,
	type UiDiagnostic,
	type UiSlotEntry,
} from "../ui-slots";
import { ICON_EDIT_ALIGNS, sideAlignLabel } from "../ui-layout-edit";
import { appSend } from "../app-globals";
import { QUICK_PHRASE_DEFAULTS } from "../quick-phrases";
import {
	AGENT_TOOL_CATALOG,
	CORE_BUILTIN_TOOL_NAMES,
	filterToolsByPreset,
	presetShowsSkillCatalog,
	SUBAGENT_TOOL_NAMES,
	TERMINAL_TOOL_NAMES,
} from "../../../server/tool-manager.js";

/**
 * 设置页「其他」组开关行的渲染口径：目录即页面。目录里加一行，页面自动多一行
 * （文案走目录项的 descKey/offHintKey）；不再手写 ToggleRow。
 */
const OTHER_AGENT_TOOLS = AGENT_TOOL_CATALOG.filter((e) => e.group === "other");

interface SettingsModalProps {
	/** Optional direct entry (e.g. a status-bar item opening a specific section). */
	initialSection?: SettingsTab;
	chat: {
		settings: UiSettingsState | null;
		/** DSH engine: Agent 预设名录（null/空 = legacy，隐藏预设区）。 */
		dshPresets: { presets: UiAgentPreset[]; defaultPreset: string } | null;
		/** DSH engine: 权限预设选项表 + 新会话默认（null = 未就绪/legacy，隐藏权限区）。 */
		dshPermission: { options: DshPermissionOption[]; defaultPreset: string } | null;
		/** Engine id ("pi" | "dsh") 与 PI_WEB_MANAGED 已移到全局（web/src/app-globals.ts）。 */
		terminals: {
			id: string;
			title: string;
			conversationId: string;
			running: boolean;
			exitCode: number | null;
			command?: CommandDef;
		}[];
		/** 轻量会话状态的窄投影（只列设置页要用的字段）。 */
		state?: { cwd: string; conversationId: string; delegateMode?: boolean } | null;
		activeConversationId?: string | null;
		/** 内置定时任务（issue #184，全局列表；DSH 引擎下为空） */
		schedulerTasks: SchedulerTaskView[];
		/** 公开远程 Skill 技能仓库检索结果 */
		skillMarketResult?: {
			ok: boolean;
			skills: RemoteSkillSummary[];
			repo: string;
			error?: string;
		} | null;
		/** 远程单个技能的 SKILL.md 内容拉取结果 */
		skillContentResult?: {
			ok: boolean;
			skillId: string;
			content: string;
			error?: string;
		} | null;
	};
	onClose: () => void;
	/** Open icon drag-and-drop editor mode (issue: quick access from layout settings). */
	onOpenIconEdit?: () => void;
	/** 打开模型与服务商管理面板（弹窗） */
	onOpenManageModels?: () => void;
}

/** A row with an enable/disable switch (skill / extension). */

function ToggleRow({
	title,
	subtitle,
	tip,
	enabled,
	onToggle,
	action,
	disabled,
}: {
	title: React.ReactNode;
	subtitle?: string;
	/** 长解释走「？」悬浮提示，不再平铺（subtitle 与 tip 二选一）。 */
	tip?: string;
	enabled: boolean;
	onToggle: () => void;
	/** Optional extra control rendered left of the switch (e.g. uninstall). */
	action?: React.ReactNode;
	/** 被默认预设过滤时禁用开关（展示实效 off，底层禁用名单原样保留）。 */
	disabled?: boolean;
}) {
	const t = useT();
	return (
		<div className="set-row">
			<div className="set-row-info">
				<div className="set-row-name">
					{title}
					{tip && <HintTip text={tip} />}
				</div>
				{subtitle && <div className="set-row-desc">{subtitle}</div>}
			</div>
			{action}
			<button
				type="button"
				className={`set-switch ${enabled ? "on" : ""}`}
				role="switch"
				aria-checked={enabled}
				disabled={disabled}
				title={enabled ? t("settingsEnabled") : t("settingsDisabled")}
				onClick={disabled ? undefined : onToggle}
			>
				<span className="set-switch-knob" />
			</button>
		</div>
	);
}

/** 工具行右端的「编辑文案」按钮（设置→工具区每个工具行都用；有覆盖时高亮）。 */
function ToolPromptButton({ name, edited, onEdit }: { name: string; edited: boolean; onEdit: (name: string) => void }) {
	const t = useT();
	return (
		<button
			type="button"
			className={`set-icon-btn tool-prompt-edit${edited ? " edited" : ""}`}
			title={edited ? t("toolPromptEdited") : t("toolPromptEdit")}
			aria-label={t("toolPromptEdit")}
			onClick={() => onEdit(name)}
		>
			<FiEdit3 />
		</button>
	);
}

/** 一行式表单行：标签左、控件（数字框/下拉）右，与开关共用右对齐线。 */
function FieldRow({
	label,
	tip,
	htmlFor,
	children,
}: {
	label: string;
	tip?: string;
	htmlFor?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="set-row set-field-row">
			<label className="set-row-name" htmlFor={htmlFor}>
				{label}
				{tip && <HintTip text={tip} />}
			</label>
			{children}
		</div>
	);
}

/** 通用提示词覆盖区块（计划模式、视觉桥等共用）：包含模式选择、草稿防抖与默认值契约。 */
function PromptOverrideEditor({
	mode,
	onModeChange,
	draft,
	onDraftChange,
	defaultPrompt,
	placeholder,
	rows = 4,
	onCommit,
	modeLabel,
	hint,
	focusRef,
}: {
	mode: "append" | "replace";
	onModeChange: (m: "append" | "replace") => void;
	draft: string;
	onDraftChange: (v: string) => void;
	defaultPrompt?: string;
	placeholder?: string;
	rows?: number;
	onCommit: (mode: "append" | "replace", text: string) => void;
	modeLabel?: string;
	hint?: React.ReactNode;
	focusRef?: React.MutableRefObject<boolean>;
}) {
	const t = useT();

	const commit = (targetMode: "append" | "replace", targetDraft: string) => {
		const text = targetMode === "replace" && defaultPrompt && targetDraft === defaultPrompt ? "" : targetDraft;
		onCommit(targetMode, text);
	};

	return (
		<>
			<FieldRow label={modeLabel ?? t("visionBridgePromptMode")}>
				<select
					className="set-select"
					value={mode}
					onChange={(e) => {
						const m = e.target.value as "append" | "replace";
						onModeChange(m);
						commit(m, draft);
					}}
				>
					<option value="append">{t("promptModeAppend")}</option>
					<option value="replace">{t("promptModeReplace")}</option>
				</select>
			</FieldRow>
			<textarea
				className="set-prompt-input"
				rows={rows}
				placeholder={placeholder}
				value={draft}
				onFocus={() => {
					if (focusRef) focusRef.current = true;
				}}
				onBlur={() => {
					if (focusRef) focusRef.current = false;
					commit(mode, draft);
				}}
				onChange={(e) => onDraftChange(e.target.value)}
			/>
			{hint && <p className="set-hint">{hint}</p>}
		</>
	);
}

/** 设置弹窗的左侧分组导航（一次只显示一个区块，消灭长滚动）。 */
export type SettingsTab =
	| "models"
	| "prompt-history"
	| "scheduler"
	| "tools"
	| "approval-rules"
	| "display"
	| "sound"
	| "quick"
	| "markers"
	| "skills"
	| "layout"
	| "vision"
	| "subagent-templates";

/** set_settings 允许的字段（原 setPartial 内联类型提出为具名类型，供乐观合并层复用）。 */
interface SettingsPatch {
	promptMode?: "append" | "replace";
	customSystemPrompt?: string;
	promptTemplate?: string;
	promptOverrides?: Record<string, string>;
	/** 逐工具文案覆盖（工具名 → description/snippet/guidelines；空对象 = 清除该工具覆盖）。 */
	toolPromptOverrides?: Record<string, UiToolPromptOverride>;
	disabledSkills?: string[];
	disabledExtensions?: string[];
	/** 宿主 UI 布局偏好（内置条目的隐藏/排序/分组；纯 UI，per-client）。 */
	uiLayout?: UiLayoutPrefs;
	/** 统一工具禁用名单（工具 tab 逐工具开关；遗留单开关仍可用，会折回此名单）。 */
	disabledAgentTools?: string[];
	terminalToolsEnabled?: boolean;
	terminalBash?: boolean;
	terminalBashIdleMs?: number;
	terminalBashMaxForegroundMs?: number;
	toolWatchdogTimeoutMs?: number;
	/** read 工具读目录开关（默认开；行为开关，live 生效无需 reload，见 server/read-tool.ts）。 */
	readDirEnabled?: boolean;
	/** 工具延迟加载开关（默认开）：只影响新会话与之后的门控重放。 */
	toolLazyLoading?: boolean;
	/** codemode 执行模式："on"（常规模式，默认）| "only"（严格代码模式）。 */
	codemodeMode?: "on" | "only";
	/** codemode 系统提示词中内联工具声明的预算 Token（默认 3000）。 */
	codemodeInlineBudget?: number;
	/** 工具执行审批总开关（默认开；纯运行开关，live 生效无需 reload）。 */
	toolApprovalEnabled?: boolean;
	editSoftEnabled?: boolean;
	questionnaireEnabled?: boolean;
	goalModeEnabled?: boolean;
	parallelReminderEnabled?: boolean;
	thinkingWrap?: boolean;
	toolsWrap?: boolean;
	toolImagesEnabled?: boolean;
	/** 消息列表尾部常驻渲染的消息条数（纯 UI 偏好，默认 15）。 */
	keepRecentMessages?: number;
	/** 向上分页加载开关（纯 UI 偏好，默认关）。 */
	reversePagination?: boolean;
	/** 历史对话列表中是否显示已被 fork 派生的父会话（默认 false = 仅显示链尾最新分支）。 */
	showForkedParentSessions?: boolean;
	/** 结束的对话切换时不自动从运行列表移出（默认 false）。 */
	retainFinishedConversations?: boolean;
	/** 切换项目时是否打开该项目最近的会话（默认 true 开）。关 → 切换项目时始终创建空白新对话。 */
	openRecentSessionOnProjectSwitch?: boolean;
	devNoCache?: boolean;
	autoReload?: boolean;
	skillsFullText?: string[];
	skillsCatalogMaxDesc?: number;
	skillsCatalogShowLocation?: boolean;
	skillsCatalogBudget?: number;
	quickPhrases?: string[];
	quickPhrasesEnabled?: boolean;
	minimalNewChat?: boolean;
	preserveDraftAcrossConversations?: boolean;
	visionBridgeEnabled?: boolean;
	visionBridgeModel?: string | null;
	visionBridgePromptMode?: "append" | "replace";
	visionBridgePrompt?: string;
	planModePromptMode?: "append" | "replace";
	planModePrompt?: string;
	planModeDefaultPrompt?: string;
	subagentDefaultModel?: string | null;
	retryMaxAttempts?: number;
	softCapTokens?: number;
	softCapByModel?: Record<string, number>;
	reviewPrompt?: string;
	reviewDisabledSkills?: string[];
	markersEnabled?: boolean;
	disabledMarkers?: string[];
}

/** 结构相等（乐观补丁对账用）：同值或 JSON 形态一致（覆盖数组/对象字段）。 */
function looseEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}

/** 未确认补丁的最长存活时间：超过后以服务端为准落层（服务端会归一化部分字段，
 *  或同值被另一端覆盖 —— 乐观值不能永久遮蔽真实状态）。 */
const PENDING_MAX_AGE_MS = 10_000;

export function SettingsModal({
	chat,
	initialSection,
	onClose,
	onOpenIconEdit,
	onOpenManageModels,
}: SettingsModalProps) {
	const t = useT();
	const { locale } = useI18n();
	// {{token}} 元数据文案键是动态的（promptTok_<token>[,_desc]），用 tt 跳过字面量类型。
	const tt = (k: string) => t(k as Parameters<typeof t>[0]);
	// 审查 #2：服务端快照是异步回程的，快速连续操作时（如连点两个技能开关）第二次
	// 点击若直接从旧快照计算全量新值，会把第一次的修改覆盖回去（丢更新）。这里维护
	// 一层「未确认补丁」：组件内所有显示与计算统一走 `settings` = 最新快照 + 补丁
	// （原始快照留作 serverSettings 供对账）。
	const serverSettings = chat.settings;
	const [pendingSettings, setPendingSettings] = useState<Record<string, { value: unknown; at: number }>>({});
	const settings = useMemo<UiSettingsState | null>(() => {
		if (!serverSettings) return null;
		if (Object.keys(pendingSettings).length === 0) return serverSettings;
		const merged = { ...serverSettings } as UiSettingsState & Record<string, unknown>;
		for (const [k, { value }] of Object.entries(pendingSettings)) merged[k] = value;
		return merged;
	}, [serverSettings, pendingSettings]);
	// 快照回程 rebase：补丁值被服务端确认（原始快照追平）即落层；超过
	// PENDING_MAX_AGE_MS 仍未追平的也落层 —— 服务端会归一化部分字段（trim/钳制/
	// 去重）或值已被他端改写，以服务端为准，避免乐观值永久遮蔽真实状态。
	useEffect(() => {
		if (!serverSettings) return;
		setPendingSettings((prev) => {
			if (Object.keys(prev).length === 0) return prev;
			const next: Record<string, { value: unknown; at: number }> = {};
			const now = Date.now();
			for (const [k, { value, at }] of Object.entries(prev)) {
				const confirmed = looseEqual((serverSettings as unknown as Record<string, unknown>)[k], value);
				if (!confirmed && now - at < PENDING_MAX_AGE_MS) next[k] = { value, at };
			}
			return Object.keys(next).length === Object.keys(prev).length ? prev : next;
		});
	}, [serverSettings]);
	// 审批放行策略（仅内存、随对话走；审批弹窗的「允许同类 / 全部允许」在这里撤销）。
	const approvalPolicy = settings?.approvalPolicy;
	// 全局运行态（引擎 / 受管）：不再从 App 一路传进来，见 web/src/app-globals.ts。
	// 默认分区：模型与服务商
	const defaultTab: SettingsTab = "models";
	const [tab, setTab] = useState<SettingsTab>(initialSection ?? defaultTab);
	// 内容滚动容器：切换分组后回到顶部（各组高度不同，停留旧滚动位置会像没切换）。
	const bodyRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		bodyRef.current?.scrollTo({ top: 0 });
	}, [tab]);
	// 窄屏横滑导航：切换分组后把当前 chip 滚进可见区。
	const railRef = useRef<HTMLElement>(null);
	useEffect(() => {
		railRef.current?.querySelector(".settings-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [tab]);

	// 技能市场子页签、远程仓库与筛选
	const [skillSubTab] = useState<"installed">("installed");

	// 打开设置面板或当前工作区/会话切换时，主动拉取一次最新设置快照（确保 {{context}}、生效提示词与 token 估算为当前项目最新值）。
	useEffect(() => {
		appSend({ type: "get_settings" });
	}, [chat.state?.cwd, chat.activeConversationId]);

	// Vision-bridge prompt draft — local edit, re-synced from settings when not focused.
	const [vbPromptDraft, setVbPromptDraft] = useState("");
	const [vbPromptMode, setVbPromptMode] = useState<"append" | "replace">("append");
	const vbPromptFocus = useRef(false);
	// 正在编辑的子代理模板草稿（新建 = 空模板；null = 关闭编辑表单，表单在独立弹窗里渲染）。
	const [tplDraft, setTplDraft] = useState<UiSubagentTemplate | null>(null);
	// 弹窗标题用：新建 vs 编辑（draft 本身区分不出来）。
	const [tplIsNew, setTplIsNew] = useState(false);
	// 删除子代理模板的两步确认。
	const [confirmTplDelete, setConfirmTplDelete] = useState<string | null>(null);
	// 正在编辑的审批规则草稿。
	const [ruleDraft, setRuleDraft] = useState<UiApprovalRule | null>(null);
	const [ruleIsNew, setRuleIsNew] = useState(false);
	const [ruleToolsText, setRuleToolsText] = useState("");
	const [ruleError, setRuleError] = useState<string | null>(null);
	const [confirmRuleDelete, setConfirmRuleDelete] = useState<string | null>(null);
	const [confirmRuleReset, setConfirmRuleReset] = useState<string | null>(null);
	// 逐工具文案编辑器：当前正在编辑的工具名（null = 未打开）。
	const [editingToolPrompt, setEditingToolPrompt] = useState<string | null>(null);
	const toolPromptEdits = settings?.toolPromptOverrides ?? {};
	const editedToolNames = useMemo(() => new Set(Object.keys(toolPromptEdits)), [toolPromptEdits]);
	// 工具内嵌子配置的展开/收起集合（默认全部折叠，空 Set）
	const [expandedToolConfigs, setExpandedToolConfigs] = useState<Set<string>>(() => new Set());
	const toggleToolConfigExpand = (name: string) => {
		setExpandedToolConfigs((prev) => {
			const next = new Set(prev);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	};
	/** 工具行右端的「编辑文案」按钮（三个工具列表共用）。 */
	const toolEditAction = (name: string) => (
		<ToolPromptButton name={name} edited={editedToolNames.has(name)} onEdit={setEditingToolPrompt} />
	);
	/** 保存/清除某工具的文案覆盖（空对象 = 清除，服务端逐工具合并）。 */
	const applyToolPromptOverride = (name: string, override: UiToolPromptOverride | null) =>
		setPartial({ toolPromptOverrides: { [name]: override ?? {} } });
	// 宽屏聊天列开关（纯前端 localStorage，见 chat-width-settings.ts）。
	const wideChat = useWideChat();
	const hideModelRow = useHideModelRow();
	// 输入框回车行为（纯前端 localStorage，见 composer-keys.ts）。
	const effectiveSendKey = useEffectiveSendKey();
	// present_files 卡片：AI 标了「先看这个」时要不要自动弹预览窗（纯前端偏好，localStorage）。
	const presentAutoOpen = usePresentAutoOpen();
	const projectTitle = useProjectTitle();
	// 聊天背景图（纯前端 localStorage，见 wallpaper.ts）：地址输入框用本地草稿，
	// 失焦/回车才提交（避免边输边校验）；压暗/模糊滑杆直接提交即时预览。
	const wallpaper = useWallpaperSettings();
	const [wallpaperDraft, setWallpaperDraft] = useState(wallpaper.url);
	const wallpaperFocus = useRef(false);
	const wallpaperFileRef = useRef<HTMLInputElement>(null);
	const [wallpaperUploading, setWallpaperUploading] = useState(false);
	const [wallpaperUploadError, setWallpaperUploadError] = useState(false);
	useEffect(() => {
		// data: 图不回填输入框（太长），下方缩略预览即表示生效中。
		if (!wallpaperFocus.current) setWallpaperDraft(wallpaper.url.startsWith("data:") ? "" : wallpaper.url);
	}, [wallpaper.url]);
	const onPickWallpaperFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (!file) return;
		setWallpaperUploading(true);
		setWallpaperUploadError(false);
		try {
			const url = await fileToWallpaperUrl(file);
			const clean = url ? sanitizeWallpaperUrl(url) : "";
			if (!clean) {
				setWallpaperUploadError(true);
				return;
			}
			setWallpaperDraft("");
			saveWallpaperSettings({ ...wallpaper, url: clean });
		} finally {
			setWallpaperUploading(false);
		}
	};
	// Prompt history settings (纯前端 localStorage，不经过 server).
	const [phSettings, setPhSettings] = useState(() => loadPromptHistorySettings());
	const [phCount, setPhCount] = useState(() => {
		try {
			return loadPromptHistory().length;
		} catch {
			return 0;
		}
	});
	const [phClearConfirm, setPhClearConfirm] = useState(false);
	const refreshPhCount = () => {
		try {
			setPhCount(loadPromptHistory().length);
		} catch {
			setPhCount(0);
		}
	};
	useEffect(() => {
		if (tab === "prompt-history") refreshPhCount();
	}, [tab]);
	useEffect(() => {
		if (!phClearConfirm) return;
		const id = window.setTimeout(() => setPhClearConfirm(false), 3000);
		return () => window.clearTimeout(id);
	}, [phClearConfirm]);
	// 快捷短语新增输入框草稿（Enter / 添加按钮提交）。
	const [quickNew, setQuickNew] = useState("");
	// 快捷短语行内编辑（null = 未在编辑；输入框受控于 value，回显不打断输入）。
	const [quickEdit, setQuickEdit] = useState<{ index: number; value: string } | null>(null);
	// DSH 插件市场子面板（探索 / 已安装）与搜索分类状态

	useEffect(() => {
		if (!settings) return;
		setVbPromptMode(settings.visionBridgePromptMode);
		if (vbPromptFocus.current) return;
		setVbPromptDraft(
			vbPromptMode === "append" || settings.visionBridgePrompt
				? settings.visionBridgePrompt
				: settings.visionBridgeDefaultPrompt || "",
		);
	}, [settings, vbPromptMode]);

	const [idleMsDraft, setIdleMsDraft] = useState<string>(String(settings?.terminalBashIdleMs ?? 15000));
	useEffect(() => {
		setIdleMsDraft(String(settings?.terminalBashIdleMs ?? 15000));
	}, [settings?.terminalBashIdleMs]);
	const [maxMsDraft, setMaxMsDraft] = useState<string>(String(settings?.terminalBashMaxForegroundMs ?? 60000));
	useEffect(() => {
		setMaxMsDraft(String(settings?.terminalBashMaxForegroundMs ?? 60000));
	}, [settings?.terminalBashMaxForegroundMs]);
	// 工具看门狗超时（分钟，默认 20 分钟；0 = 禁用）。
	const [watchdogMinDraft, setWatchdogMinDraft] = useState<string>(
		String(Math.round((settings?.toolWatchdogTimeoutMs ?? 1200000) / 60_000)),
	);
	useEffect(() => {
		setWatchdogMinDraft(String(Math.round((settings?.toolWatchdogTimeoutMs ?? 1200000) / 60_000)));
	}, [settings?.toolWatchdogTimeoutMs]);
	// 模型报错自动重试次数：本地草稿（失焦/回车提交，0 = 失败即停）。
	const [retryDraft, setRetryDraft] = useState<string>(String(settings?.retryMaxAttempts ?? 6));
	useEffect(() => {
		setRetryDraft(String(settings?.retryMaxAttempts ?? 6));
	}, [settings?.retryMaxAttempts]);
	// 常驻渲染消息数：本地草稿（失焦/回车提交，默认 15）。
	const [keepRecentDraft, setKeepRecentDraft] = useState<string>(String(settings?.keepRecentMessages ?? 15));
	useEffect(() => {
		setKeepRecentDraft(String(settings?.keepRecentMessages ?? 15));
	}, [settings?.keepRecentMessages]);
	const [skillsMaxDescDraft, setSkillsMaxDescDraft] = useState<string>(String(settings?.skillsCatalogMaxDesc ?? 250));
	useEffect(() => {
		setSkillsMaxDescDraft(String(settings?.skillsCatalogMaxDesc ?? 250));
	}, [settings?.skillsCatalogMaxDesc]);
	// 压缩软上限：本地草稿（空 = 关闭；失焦/回车提交）。
	const [softCapDraft, setSoftCapDraft] = useState<string>(
		settings?.softCapTokens && settings.softCapTokens > 0 ? formatTokenDraft(settings.softCapTokens) : "",
	);
	useEffect(() => {
		setSoftCapDraft(
			settings?.softCapTokens && settings.softCapTokens > 0 ? formatTokenDraft(settings.softCapTokens) : "",
		);
	}, [settings?.softCapTokens]);
	// 按模型覆盖的新增行草稿。
	const [newCapModel, setNewCapModel] = useState<string>("");
	const [newCapTokens, setNewCapTokens] = useState<string>("");

	/** 宿主 UI 布局（issue #146）：所有挂载点的最终条目 = 内置 + 用户偏好。
	 *  设置面板与 TopBar 用同一份计算，看到的顺序永远一致。 */
	// 合并诊断（P0-1）：被纠正的偏好 / 槽位冲突都产出一条带归因的记录，布局页顶部横幅展示（可折叠）。
	const uiDiagnostics: UiDiagnostic[] = [];
	const uiSlots = buildUiSlots({
		t: (key: string) => t(key as Parameters<typeof t>[0]),
		layout: chat.settings?.uiLayout,
		diagnostics: uiDiagnostics,
	});

	if (!settings) return null;

	// 统一工具禁用名单（工具 tab 唯一写入口；旧 tab 的遗留单开关已迁入）。
	const disabledTools = new Set(settings.disabledAgentTools ?? []);
	const disabledToolsCount = disabledTools.size;

	// pi 引擎默认预设的二次过滤（server/tool-manager.ts filterToolsByPreset）：预设是
	// 禁用名单之外的第二层门控。默认预设为极简/代码/只读/纯对话时，大批开关看似开着
	// 实则对新对话不生效——此处算出实效，被过滤的行置灰并在顶部挂横幅（一键切回全功能）。
	const piPresetId = chat.dshPresets?.defaultPreset ?? null;
	const piPresetFiltering = !!piPresetId && piPresetId !== "standard";
	const piPresetAllowed: Set<string> = piPresetFiltering
		? new Set(
				filterToolsByPreset(
					[...AGENT_TOOL_CATALOG.map((e) => e.name), "bash", "read", "edit", "write"],
					piPresetId ?? undefined,
				),
			)
		: new Set(AGENT_TOOL_CATALOG.map((e) => e.name));
	const piPresetName = presetText(
		chat.dshPresets?.presets.find((pp) => pp.id === piPresetId) ?? {
			id: piPresetId ?? "",
			trust: "system",
			isDefault: false,
		},
		locale,
		t,
	).name;
	const isBlockedByPreset = (name: string) => piPresetFiltering && !piPresetAllowed.has(name);
	const blockedPresetCount = piPresetFiltering
		? AGENT_TOOL_CATALOG.filter((e) => !piPresetAllowed.has(e.name)).length
		: 0;

	const tabs: {
		id: SettingsTab;
		icon: React.ReactNode;
		label: string;
		/** 有计数徽标（与各区块标题里的 set-count 同源）。 */
		count?: number;
		/** 状态指示红点。 */
		dot?: boolean;
		/** 悬浮提示。 */
		hint?: string;
	}[] = [
		// 模型与服务商（全引擎通用：统一管理 BaseURL、API Key 与自定义中转模型）
		...(onOpenManageModels
			? [
					{
						id: "models" as const,
						icon: <FiCpu />,
						label: t("settingsModelsAndProviders"),
					},
				]
			: []),
		// 输入历史（全引擎通用）
		{
			id: "prompt-history",
			icon: <FiClock />,
			label: t("settingsPromptHistory"),
			count: phCount,
		},
		// 定时任务（仅 Pi 引擎具备后台执行通道）
		{
			id: "scheduler" as const,
			icon: <FiClock />,
			label: t("settingsScheduler"),
			count: chat.schedulerTasks.length || undefined,
		},
		// 工具 & 审批规则
		{
			id: "tools" as const,
			icon: <FiTool />,
			label: t("settingsTools"),
			count: disabledToolsCount + (settings.disabledMarkers?.length ?? 0) || undefined,
		},
		{
			id: "approval-rules" as const,
			icon: <FiShield />,
			label: t("settingsApprovalRules"),
			count: (settings.approvalRules ?? []).length || undefined,
		},
		// 对话展示（全引擎通用）
		{ id: "display", icon: <FiMessageSquare />, label: t("settingsMessageDisplay") },
		// 声音与语音（全引擎通用）
		{ id: "sound", icon: <FiVolume2 />, label: t("settingsNotifyTab") },
		// 快捷短语（全引擎通用）
		{ id: "quick", icon: <FiSend />, label: t("quickPhrases"), count: settings.quickPhrases.length },
		// 技能（仅 Pi 引擎支持 .pi/skills）
		{ id: "skills" as const, icon: <FiCpu />, label: t("settingsSkills"), count: settings.skills.length },
		// 界面布局（全引擎通用）
		{ id: "layout", icon: <FiSliders />, label: t("uiLayoutTitle") },
		// 视觉桥（仅 Pi 引擎支持）
		{ id: "vision" as const, icon: <FiEye />, label: t("settingsVisionBridge") },
		// 子代理模板（仅 Pi 引擎支持）
		{
			id: "subagent-templates" as const,
			icon: <FiUsers />,
			label: t("settingsSubagentTemplates"),
			count: settings.subagentTemplates.length,
		},
	];

	// 侧栏搜索与四维分组（方案 1: Linear 风格）
	const [tabSearchQuery, setTabSearchQuery] = useState("");

	const TAB_GROUPS: Record<string, "core" | "tools" | "ui" | "advanced"> = {
		models: "core",
		"subagent-templates": "core",

		tools: "tools",
		"approval-rules": "tools",
		skills: "tools",

		layout: "ui",
		display: "ui",
		sound: "ui",
		quick: "ui",
		vision: "ui",

		"prompt-history": "advanced",
		scheduler: "advanced",
	};

	const GROUP_LABELS = {
		core: t("settingsGroupCore"),
		tools: t("settingsGroupTools"),
		ui: t("settingsGroupUi"),
		advanced: t("settingsGroupAdvanced"),
	};

	const GROUP_KEYS: Array<"core" | "tools" | "ui" | "advanced"> = ["core", "tools", "ui", "advanced"];

	const filteredTabs = useMemo(() => {
		const q = tabSearchQuery.trim().toLowerCase();
		if (!q) return tabs;
		return tabs.filter((t) => t.label.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
	}, [tabs, tabSearchQuery]);

	/** 导航纠偏：若当前 tab 不在当前引擎可用的分区列表（例如切换引擎）→ 自动回落到该引擎的首个可用分区。 */
	useEffect(() => {
		if (tabs.length === 0) return;
		if (!tabs.some((t) => t.id === tab)) {
			setTab(tabs[0].id);
		}
	}, [tabs, tab]);

	const disabledSkills = new Set(settings.disabledSkills);

	const setPartial = (patch: SettingsPatch) => {
		// 审查 #2：先把补丁盖进本地未确认层（显示立即生效，下一次点击的「全量新值」
		// 计算也基于它），再原样发服务端（服务端只合并给出的字段）。快照回程后由
		// 上方 rebase effect 对账落层。
		const now = Date.now();
		setPendingSettings((prev) => {
			const stamped = { ...prev };
			for (const [k, v] of Object.entries(patch)) stamped[k] = { value: v, at: now };
			return stamped;
		});
		appSend({ type: "set_settings", ...patch });
	};

	/** 提交快捷短语行内编辑（空 = 取消；与原值相同 = 无操作；其余走服务端归一化）。 */
	const commitQuickEdit = () => {
		if (!quickEdit || !settings) return;
		const v = quickEdit.value.trim();
		const i = quickEdit.index;
		setQuickEdit(null);
		if (!v || v === settings.quickPhrases[i]) return;
		const next = [...settings.quickPhrases];
		next[i] = v;
		setPartial({ quickPhrases: next });
	};

	const toggleSkill = (s: UiSkillInfo) => {
		const next = new Set(disabledSkills);
		if (next.has(s.name)) next.delete(s.name);
		else next.add(s.name);
		setPartial({ disabledSkills: [...next] });
	};

	// skill 全文注入名单：按技能单独勾选（空 = 名录模式）。
	const fullTextSkills = new Set(settings.skillsFullText ?? []);
	const toggleSkillFullText = (name: string) => {
		const next = new Set(fullTextSkills);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		setPartial({ skillsFullText: [...next] });
	};

	// 子代理各工具的「?」说明（key 与 tool-manager.ts 的 SUBAGENT_TOOL_NAMES 对齐）。
	const SUBAGENT_TOOL_TIPS: Record<string, string> = {
		subagent: t("toolDescSubagent"),
		subagent_spawn: t("toolDescSubagentSpawn"),
		subagent_get_result: t("toolDescSubagentGetResult"),
		subagent_steer: t("toolDescSubagentSteer"),
		subagent_list: t("toolDescSubagentList"),
		subagent_stop: t("toolDescSubagentStop"),
		subagent_wait_all: t("toolDescSubagentWaitAll"),
		subagent_templates: t("toolDescSubagentTemplates"),
	};
	// 核心内置工具的「?」说明（key 与 tool-manager.ts 的 CORE_BUILTIN_TOOL_NAMES 对齐）。
	const CORE_TOOL_TIPS: Record<string, string> = {
		bash: t("toolCoreBashDesc"),
		read: t("toolCoreReadDesc"),
		edit: t("toolCoreEditDesc"),
		write: t("toolCoreWriteDesc"),
		powershell: t("toolCorePowershellDesc"),
		ls: t("toolCoreLsDesc"),
		grep: t("toolCoreGrepDesc"),
		find: t("toolCoreFindDesc"),
	};
	// 统一工具开关（工具 tab 逐工具；与 toggleSkill 同模式）。
	const toggleAgentTool = (name: string) => {
		const next = new Set(disabledTools);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		setPartial({ disabledAgentTools: [...next] });
	};

	// ---- markers ----
	const markersEnabled = settings.markersEnabled ?? true;
	const disabledMarkers = new Set(settings.disabledMarkers ?? []);
	const toggleMarker = (name: string) => {
		const next = new Set(disabledMarkers);
		const currentlyEnabled = !next.has(name);
		if (currentlyEnabled) next.add(name);
		else next.delete(name);
		setPartial({ disabledMarkers: [...next] });
	};

	/** 布局页按界面位置分组的挂载点（30 个全量：与 ui-slots.ts 的 SLOT_IDS 同顺序，
	 *  严格按实际界面的 DOM/视觉顺序：顶栏 → 通知 → 左栏 → 主列（头部/空态/消息/目标条/
	 *  输入框） → 右栏 → 终端/Git 视图 → 底栏 → 悬浮层 → 右键菜单 → 设置页 → 对话框）。 */
	const uiLayoutSections: { slot: UiSlotId; labelKey: string }[] = [
		{ slot: "topbar.primary", labelKey: "uiLayoutTopbar" },
		{ slot: "topbar.overflow", labelKey: "uiLayoutTopbarOverflow" },
		{ slot: "notice.actions", labelKey: "uiLayoutNotice" },
		{ slot: "leftpanel.sections", labelKey: "uiLayoutLeftSections" },
		{ slot: "leftpanel.projects.actions", labelKey: "uiLayoutLeftProjectsActions" },
		{ slot: "leftpanel.project", labelKey: "uiLayoutLeftProject" },
		{ slot: "leftpanel.running.actions", labelKey: "uiLayoutLeftRunningActions" },
		{ slot: "leftpanel.running", labelKey: "uiLayoutLeftRunning" },
		{ slot: "leftpanel.history.actions", labelKey: "uiLayoutLeftHistoryActions" },
		{ slot: "leftpanel.history", labelKey: "uiLayoutLeftHistory" },
		{ slot: "leftpanel.sessions", labelKey: "uiLayoutLeftSessions" },
		{ slot: "chat.header", labelKey: "uiLayoutChatHeader" },
		{ slot: "chat.empty", labelKey: "uiLayoutChatEmpty" },
		{ slot: "message.actions", labelKey: "uiLayoutMessage" },
		{ slot: "goalbar.actions", labelKey: "uiLayoutGoalbar" },
		{ slot: "composer.leading", labelKey: "uiLayoutComposerLeading" },
		{ slot: "composer.actions", labelKey: "uiLayoutComposer" },
		{ slot: "terminal.toolbar", labelKey: "uiLayoutTerminal" },
		{ slot: "bottombar", labelKey: "uiLayoutBottombar" },
		{ slot: "file.preview.toolbar", labelKey: "uiLayoutFilePreview" },
		{ slot: "contextmenu.topbar", labelKey: "uiLayoutContextTopbar" },
		{ slot: "contextmenu.message", labelKey: "uiLayoutContextMessage" },
		{ slot: "contextmenu.session", labelKey: "uiLayoutContextSession" },
		{ slot: "contextmenu.project", labelKey: "uiLayoutContextProject" },
		{ slot: "contextmenu.toolcall", labelKey: "uiLayoutContextToolcall" },
		{ slot: "settings.pages", labelKey: "uiLayoutSettingsPages" },
		{ slot: "tasks.panel", labelKey: "uiLayoutTasksPanel" },
		{ slot: "modal.dialog", labelKey: "uiLayoutModal" },
		{ slot: "sidebar.left", labelKey: "uiLayoutSidebarLeft" },
		{ slot: "sidebar.right", labelKey: "uiLayoutSidebarRight" },
	];
	/** 渲染层真正按 align 分区的槽位（其余槽位的 align 存了也无处生效，布局页就不提供了）。
	 *  顶栏与底栏/输入框动作区同口径：顶栏可受管条目的 align 均生效（手机端特有的对话折叠
	 *  按钮 host:history 是左侧列表的唯一入口，不可被管理显示，已从设置页中去掉）。
	 *  侧边停靠栏同属「真分区」，只是轴是竖的（靠上/居中/靠下）。 */
	const uiAlignSlots: UiSlotId[] = ["bottombar", "composer.actions", "topbar.primary", "sidebar.left", "sidebar.right"];
	/** 该槽位的 align 是竖轴：分段头与下拉用「靠上/居中/靠下」而非 start/center/end。 */
	const verticalAlignSlot = (slot: string) => slot === "sidebar.left" || slot === "sidebar.right";
	/** 可自由在上下和两侧切换位置的槽位 */
	const uiPositionSlots: UiSlotId[] = ["topbar.primary", "bottombar", "sidebar.left", "sidebar.right"];
	const [uiLayoutFilter, setUiLayoutFilter] = useState("");
	/** 槽位 id → 布局页分区标题（movedFrom「移自哪」的显示用）。 */
	const uiSlotTitle = (slot: UiSlotId): string => {
		const found = uiLayoutSections.find((s) => s.slot === slot);
		return found ? t(found.labelKey as Parameters<typeof t>[0]) : slot;
	};
	const layout = chat.settings?.uiLayout;
	const setLayout = (patch: UiLayoutPrefs) => setPartial({ uiLayout: { ...layout, ...patch } });
	/** 取消勾选＝用户隐藏；勾回＝用户显式显示（覆盖内置默认的 hidden）。 */
	const toggleUiHidden = (entry: UiSlotEntry) => {
		const hidden = new Set(layout?.hidden ?? []);
		const shown = new Set(layout?.shown ?? []);
		if (entry.hidden) {
			hidden.delete(entry.id);
			shown.add(entry.id);
		} else {
			hidden.add(entry.id);
			shown.delete(entry.id);
		}
		setLayout({ hidden: [...hidden], shown: [...shown] });
	};
	/** ↑/↓：把顺序写进全局 order，同时保留其他槽位已有的自定义顺序。
	 *  layout.order 是跨槽位共享的一维数组（合并引擎按槽位内相对次序用），直接用本槽位
	 *  的全量 id 覆盖它会把其他槽位的调序洗掉 —— 所以先摘掉本槽位的旧痕迹，再把新顺序
	 *  接在其他槽位顺序之后（跨槽位的前后关系不影响渲染，只影响同槽位内的相对次序）。
	 *  顶栏/底栏/输入框动作区在界面上按对齐段分组渲染（左 start → 中 center → 右 end，
	 *  见 TopBar 的 segStart/segCenter/segEnd、FooterBar 的左右分区、ChatInput 的
	 *  composerGroups），布局页同口径按段展示、↑↓ 只在段内移动：调用方传全槽位
	 *  allEntries 与当前段 rowItems，段内新顺序就地写回全槽位顺序（段外条目原位不动 ——
	 *  跨段的前后本来就不影响渲染，换段走对齐下拉）。其余槽位整槽一段，与旧行为一致。 */
	const moveUiEntry = (allEntries: UiSlotEntry[], rowItems: UiSlotEntry[], id: string, delta: number) => {
		const groupKeys = rowItems.map((e) => e.id);
		const idx = groupKeys.indexOf(id);
		const target = idx + delta;
		if (idx < 0 || target < 0 || target >= groupKeys.length) return;
		const nextGroup = [...groupKeys];
		const [moved] = nextGroup.splice(idx, 1);
		if (moved === undefined) return;
		nextGroup.splice(target, 0, moved);
		// 段内新顺序就地写回全槽位顺序：属于本段的位置按新顺序依次填入，段外条目不动。
		const groupSet = new Set(groupKeys);
		const queue = [...nextGroup];
		const next = allEntries.map((e) => (groupSet.has(e.id) ? (queue.shift() as string) : e.id));
		const inSlot = new Set(allEntries.map((e) => e.id));
		const others = (layout?.order ?? []).filter((x) => !inSlot.has(x));
		setLayout({ order: [...others, ...next] });
	};
	/** 对齐：只给渲染层真分区的槽位提供（start/center/end，脏值由合并引擎兜底）。 */
	const setUiAlign = (id: string, align: string) => {
		if (align !== "start" && align !== "center" && align !== "end") return;
		setLayout({ align: { ...layout?.align, [id]: align } });
	};
	/** 位置：支持在顶栏、底栏、左侧悬浮、右侧悬浮自由切换。 */
	const setUiSlot = (id: string, targetSlot: UiSlotId) => {
		const slots = { ...layout?.slots, [id]: targetSlot };
		setLayout({ slots });
	};
	/** 改名：空串 = 清掉用户文案、回到合并文案（60 字截断与协议同口径）。 */
	const setUiLabel = (id: string, label: string) => {
		const labels = { ...layout?.labels };
		const name = label.trim().slice(0, 60);
		if (!name) delete labels[id];
		else labels[id] = name;
		setLayout({ labels });
	};
	/** 恢复单条：清掉该条目上的全部用户覆盖（隐藏/显示/顺序/分组/文案）。 */
	const restoreUi = (id: string) => setPartial({ uiLayout: restoreUiItem(layout, id) });
	/** 一键恢复：用户偏好全部作废，回到宿主默认布局。 */
	const restoreUiAll = () => setPartial({ uiLayout: restoreAllUi() });

	const handleClose = () => onClose();

	const handleTabChange = (nextTab: SettingsTab) => setTab(nextTab);

	// 按 Escape 键退出；子弹窗开启时放行给子弹窗。
	useEscapeKey(handleClose, !tplDraft && !ruleDraft && !editingToolPrompt);

	return (
		<div className="modal-backdrop" onClick={handleClose}>
			<div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
				<button type="button" className="modal-close" aria-label={t("close")} onClick={handleClose}>
					<FiX />
				</button>
				<div className="modal-head">
					<FiSettings className="modal-head-icon" />
					<h2>{t("settingsTitle")}</h2>
					{/* 长说明收起为「？」悬浮提示，不再平铺占版面 */}
					<HintTip text={t("settingsDesc")} />
				</div>

				{/* Scrollable body — head above and the actions bar below stay
				    fixed; only these sections scroll. */}
				<div className="settings-layout">
					<nav className="settings-rail" aria-label={t("settingsTitle")} ref={railRef}>
						<div className="settings-search-wrap">
							<FiSearch className="settings-search-icon" />
							<input
								type="text"
								className="settings-search-input"
								placeholder={t("settingsSearchPlaceholder")}
								value={tabSearchQuery}
								onChange={(e) => setTabSearchQuery(e.target.value)}
							/>
							{tabSearchQuery && (
								<button
									type="button"
									className="settings-search-clear"
									aria-label="Clear search"
									onClick={() => setTabSearchQuery("")}
								>
									<FiX />
								</button>
							)}
						</div>
						{tabSearchQuery.trim() ? (
							filteredTabs.length > 0 ? (
								filteredTabs.map((tb) => (
									<button
										key={tb.id}
										type="button"
										data-tab={tb.id}
										className={`settings-tab${tab === tb.id ? " active" : ""}`}
										aria-current={tab === tb.id ? "true" : undefined}
										title={tb.hint ?? tb.label}
										onClick={() => handleTabChange(tb.id)}
									>
										<span className="settings-tab-icon">{tb.icon}</span>
										<span className="settings-tab-label">{tb.label}</span>
										{tb.count !== undefined && <span className="set-count">{tb.count}</span>}
										{tb.dot && <span className="update-dot" style={{ marginLeft: 4 }} />}
									</button>
								))
							) : (
								<div className="settings-search-empty">{t("settingsSearchEmpty")}</div>
							)
						) : (
							GROUP_KEYS.map((grpKey) => {
								const grpTabs = tabs.filter((tb) => (TAB_GROUPS[tb.id] ?? "ui") === grpKey);
								if (grpTabs.length === 0) return null;
								return (
									<div key={grpKey} className="settings-group">
										<div className="settings-group-title">{GROUP_LABELS[grpKey]}</div>
										{grpTabs.map((tb) => (
											<button
												key={tb.id}
												type="button"
												data-tab={tb.id}
												className={`settings-tab${tab === tb.id ? " active" : ""}`}
												aria-current={tab === tb.id ? "true" : undefined}
												title={tb.hint ?? tb.label}
												onClick={() => handleTabChange(tb.id)}
											>
												<span className="settings-tab-icon">{tb.icon}</span>
												<span className="settings-tab-label">{tb.label}</span>
												{tb.count !== undefined && <span className="set-count">{tb.count}</span>}
												{tb.dot && <span className="update-dot" style={{ marginLeft: 4 }} />}
											</button>
										))}
									</div>
								);
							})
						)}
					</nav>
					<div className="modal-body" ref={bodyRef}>
						{/* ---- models & providers (all engines) ------------------------ */}
						{tab === "models" && (
							<div className="set-section">
								<div className="set-section-title" style={{ marginTop: 0 }}>
									<FiCpu className="set-section-icon" />
									{t("settingsModelsAndProviders")}
									<HintTip text={t("settingsModelsDesc")} />
								</div>
								<p className="set-desc" style={{ marginTop: 4, marginBottom: 12 }}>
									{t("enginePiModelDesc")}
								</p>

								{onOpenManageModels && (
									<div className="set-block" style={{ marginTop: 8 }}>
										<div className="set-row">
											<div>
												<div className="set-label">{t("manageModelsAndProviders")}</div>
												<div className="set-desc">{t("manageModelsAndProvidersHint")}</div>
											</div>
											<button
												type="button"
												className="set-btn accent"
												style={{
													display: "inline-flex",
													alignItems: "center",
													gap: 6,
													padding: "6px 14px",
													flexShrink: 0,
												}}
												onClick={onOpenManageModels}
											>
												<FiCpu />
												<span>{t("openModelManager")}</span>
											</button>
										</div>
									</div>
								)}
							</div>
						)}

						{/* ---- prompt history -------------------------------------------- */}
						{tab === "scheduler" && (
							<SchedulerPanel
								tasks={chat.schedulerTasks}
								cwd={chat.state?.cwd ?? ""}
								models={settings.subagentModels}
							/>
						)}
						{tab === "prompt-history" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiClock className="set-section-icon" />
									{t("settingsPromptHistory")}
									<HintTip text={t("settingsPromptHistoryDesc")} />
									<span className="set-count">{t("promptHistoryCount", { n: String(phCount) })}</span>
								</div>
								{phCount === 0 ? (
									<p className="set-empty">{t("promptHistoryEmpty")}</p>
								) : (
									<p className="set-hint">{t("promptHistoryCount", { n: String(phCount) })}</p>
								)}
								<FieldRow label={t("promptHistoryMax")} tip={t("promptHistoryMaxHint")} htmlFor="ph-max">
									<input
										id="ph-max"
										className="set-input"
										type="number"
										min={1}
										max={500}
										step={1}
										value={String(phSettings.maxEntries)}
										onChange={(e) => {
											const v = Math.floor(Number(e.target.value) || 0);
											const next = { ...phSettings, maxEntries: v };
											setPhSettings(next);
										}}
										onBlur={() => {
											const norm = { ...phSettings };
											if (!Number.isFinite(norm.maxEntries) || norm.maxEntries < 1) norm.maxEntries = 1;
											if (norm.maxEntries > 500) norm.maxEntries = 500;
											norm.maxEntries = Math.floor(norm.maxEntries);
											setPhSettings(norm);
											savePromptHistorySettings(norm);
											refreshPhCount();
										}}
									/>
								</FieldRow>
								<ToggleRow
									title={t("promptHistoryCharLimit")}
									tip={t("promptHistoryCharLimitHint")}
									enabled={phSettings.charLimitEnabled}
									onToggle={() => {
										const next = { ...phSettings, charLimitEnabled: !phSettings.charLimitEnabled };
										setPhSettings(next);
										savePromptHistorySettings(next);
										refreshPhCount();
									}}
								/>
								{phSettings.charLimitEnabled && (
									<FieldRow label={t("promptHistoryCharLimit")} htmlFor="ph-char-limit">
										<input
											id="ph-char-limit"
											className="set-input"
											type="number"
											min={100}
											max={20000}
											step={100}
											placeholder={t("promptHistoryCharLimitPlaceholder")}
											value={String(phSettings.charLimit)}
											onChange={(e) => {
												const v = Math.floor(Number(e.target.value) || 0);
												setPhSettings({ ...phSettings, charLimit: v });
											}}
											onBlur={() => {
												let v = Math.floor(Number(phSettings.charLimit) || 0);
												if (!Number.isFinite(v) || v < 100) v = 100;
												if (v > 20000) v = 20000;
												const norm = { ...phSettings, charLimit: v };
												setPhSettings(norm);
												savePromptHistorySettings(norm);
												refreshPhCount();
											}}
										/>
									</FieldRow>
								)}
								<div className="set-field" style={{ marginTop: 12 }}>
									<button
										type="button"
										className={`set-uninstall${phClearConfirm ? " confirm" : ""}`}
										disabled={phCount === 0}
										title={phCount === 0 ? t("promptHistoryEmpty") : t("promptHistoryClear")}
										onClick={() => {
											if (!phClearConfirm) {
												setPhClearConfirm(true);
												return;
											}
											clearPromptHistory();
											setPhClearConfirm(false);
											refreshPhCount();
										}}
									>
										<FiTrash2 /> {phClearConfirm ? t("promptHistoryClearConfirm") : t("promptHistoryClear")}
									</button>
									{phCount > 0 && (
										<span className="set-hint" style={{ marginLeft: 8 }}>
											{t("promptHistoryCount", { n: String(phCount) })}
										</span>
									)}
								</div>
								<p className="set-hint">
									<FiArchive style={{ verticalAlign: "-2px", marginRight: 4 }} />
									{t("settingsPromptHistoryDesc")}
								</p>
							</div>
						)}

						{/* ---- agent tools (unified tool_manage) ------------------------- */}
						{tab === "tools" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiTool className="set-section-icon" />
									{t("settingsTools")}
								</div>
								{piPresetFiltering && (
									<p className="set-catalog-hint warn">
										{t("toolsPresetBanner", { name: piPresetName, count: blockedPresetCount })}{" "}
										<button
											type="button"
											className="chip"
											onClick={() => appSend({ type: "dsh_preset_default", preset: "standard" })}
										>
											{t("toolsBackToStandard")}
										</button>
									</p>
								)}
								<ToggleRow
									title={t("readDirEnabled")}
									tip={t("readDirEnabledDesc")}
									enabled={settings.readDirEnabled !== false}
									onToggle={() => setPartial({ readDirEnabled: settings.readDirEnabled === false })}
								/>
								{/* 工具延迟加载：开 = 只有核心工具常驻，
								    其余工具在提示词里只有名字 + 一行摘要，模型用 load_tools 按需拉取。 */}
								<ToggleRow
									title={t("toolLazyLoading")}
									tip={t("toolLazyLoadingDesc")}
									enabled={settings.toolLazyLoading === true}
									onToggle={() => setPartial({ toolLazyLoading: settings.toolLazyLoading !== true })}
								/>
								<ToggleRow
									title={t("toolApprovalEnabled")}
									tip={t("toolApprovalEnabledDesc")}
									enabled={settings.toolApprovalEnabled !== false}
									onToggle={() => setPartial({ toolApprovalEnabled: settings.toolApprovalEnabled === false })}
									action={
										<button
											type="button"
											className="tpl-chip"
											onClick={() => setTab("approval-rules")}
											title={t("settingsApprovalRulesDesc")}
										>
											<FiShield /> {t("manageApprovalRules")}
										</button>
									}
								/>
								{chat.dshPermission && chat.dshPermission.options.length > 0 && (
									<div className="set-mode-row" style={{ marginTop: 8, marginBottom: 8 }}>
										<label className="set-field-label">
											{t("dshPermDefault")}
											<HintTip text={t("dshPermDefaultDesc")} />
										</label>
										<select
											className="set-select"
											value={chat.dshPermission.defaultPreset}
											onChange={(e) => appSend({ type: "dsh_permission_default", preset: e.target.value })}
										>
											{DSH_PERMISSION_ORDER.filter((v) => chat.dshPermission!.options.some((o) => o.value === v)).map(
												(v) => (
													<option key={v} value={v}>
														{t(permLabelKey(v))}
													</option>
												),
											)}
										</select>
									</div>
								)}
								{/* 已记住的放行（本对话）：只存内存，撤销就在设置里（审批弹窗本身不再出现） */}
								{approvalPolicy?.allowAll || (approvalPolicy?.categories.length ?? 0) > 0 ? (
									<div className="set-field" style={{ marginTop: 8 }}>
										<div className="set-field-label">
											{t("toolApprovalPolicyTitle")}
											<HintTip text={t("toolApprovalPolicyHint")} />
										</div>
										{approvalPolicy?.allowAll && (
											<div className="set-row">
												<span className="set-hint">{t("toolApprovalPolicyAllowAll")}</span>
												<button
													type="button"
													className="btn"
													onClick={() => appSend({ type: "set_approval_policy", allowAll: false })}
												>
													{t("toolApprovalPolicyRevoke")}
												</button>
											</div>
										)}
										{(approvalPolicy?.categories ?? []).map((c) => (
											<div className="set-row" key={c.id}>
												<span className="set-hint">{isZhLocale(locale) ? c.label : c.labelEn}</span>
												<button
													type="button"
													className="btn"
													onClick={() =>
														appSend({
															type: "set_approval_policy",
															categories: (approvalPolicy?.categories ?? [])
																.filter((x) => x.id !== c.id)
																.map((x) => x.id),
														})
													}
												>
													{t("toolApprovalPolicyRevoke")}
												</button>
											</div>
										))}
									</div>
								) : null}
								<FieldRow
									label={t("toolWatchdogTimeout")}
									tip={t("toolWatchdogTimeoutDesc")}
									htmlFor="tool-watchdog-timeout"
								>
									<input
										id="tool-watchdog-timeout"
										className="set-input"
										type="number"
										min={0}
										step={1}
										placeholder={t("toolWatchdogOff")}
										value={watchdogMinDraft}
										onChange={(e) => setWatchdogMinDraft(e.target.value)}
										onBlur={() => {
											const raw = watchdogMinDraft.trim();
											const min = raw === "" ? 20 : Math.max(0, Math.floor(Number(raw) || 0));
											setWatchdogMinDraft(String(min));
											const ms = min * 60_000;
											if (ms !== settings.toolWatchdogTimeoutMs) {
												setPartial({ toolWatchdogTimeoutMs: ms });
											}
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") (e.target as HTMLInputElement).blur();
										}}
									/>
								</FieldRow>
								<div className="set-field-label">
									{t("toolsSectionCore")}
									<HintTip text={t("toolsCoreHint")} />
								</div>
								{CORE_BUILTIN_TOOL_NAMES.map((n) => {
									const blocked = isBlockedByPreset(n);
									return (
										<ToggleRow
											key={n}
											title={n}
											tip={CORE_TOOL_TIPS[n]}
											action={toolEditAction(n)}
											subtitle={blocked ? t("toolsBlockedByPreset", { name: piPresetName }) : undefined}
											enabled={!blocked && !disabledTools.has(n)}
											disabled={blocked}
											onToggle={() => toggleAgentTool(n)}
										/>
									);
								})}
								<div className="set-field-label">{t("toolsSectionTerminal")}</div>
								{TERMINAL_TOOL_NAMES.map((n) => {
									const blocked = isBlockedByPreset(n);
									return (
										<ToggleRow
											key={n}
											title={n}
											tip={t("settingsTerminalToolsDesc")}
											action={toolEditAction(n)}
											subtitle={blocked ? t("toolsBlockedByPreset", { name: piPresetName }) : undefined}
											enabled={!blocked && !disabledTools.has(n)}
											disabled={blocked}
											onToggle={() => toggleAgentTool(n)}
										/>
									);
								})}
								<ToggleRow
									title={t("terminalBashTakeover")}
									tip={t("terminalBashTakeoverDesc")}
									enabled={settings.terminalBash}
									onToggle={() => setPartial({ terminalBash: !settings.terminalBash })}
								/>
								{settings.terminalBash && (
									<>
										<FieldRow label={t("terminalBashIdleMs")} tip={t("terminalBashIdleMsDesc")} htmlFor="tb-idle-ms">
											<input
												id="tb-idle-ms"
												className="set-input"
												type="number"
												min={0}
												step={1000}
												value={idleMsDraft}
												onChange={(e) => setIdleMsDraft(e.target.value)}
												onBlur={() => {
													const n = Math.max(0, Math.floor(Number(idleMsDraft) || 0));
													setIdleMsDraft(String(n));
													if (n !== settings.terminalBashIdleMs) {
														setPartial({ terminalBashIdleMs: n });
													}
												}}
											/>
										</FieldRow>
										<FieldRow
											label={t("terminalBashMaxForegroundMs")}
											tip={t("terminalBashMaxForegroundMsDesc")}
											htmlFor="tb-max-ms"
										>
											<input
												id="tb-max-ms"
												className="set-input"
												type="number"
												min={0}
												step={1000}
												value={maxMsDraft}
												onChange={(e) => setMaxMsDraft(e.target.value)}
												onBlur={() => {
													const n = Math.max(0, Math.floor(Number(maxMsDraft) || 0));
													setMaxMsDraft(String(n));
													if (n !== settings.terminalBashMaxForegroundMs) {
														setPartial({ terminalBashMaxForegroundMs: n });
													}
												}}
											/>
										</FieldRow>
									</>
								)}
								<div className="set-field-label">
									{t("toolsSectionSubagent")} <HintTip text={t("toolsSubagentDepHint")} />
								</div>
								{SUBAGENT_TOOL_NAMES.map((n) => {
									const blocked = isBlockedByPreset(n);
									return (
										<ToggleRow
											key={n}
											title={n}
											tip={SUBAGENT_TOOL_TIPS[n]}
											action={toolEditAction(n)}
											subtitle={blocked ? t("toolsBlockedByPreset", { name: piPresetName }) : undefined}
											enabled={!blocked && !disabledTools.has(n)}
											disabled={blocked}
											onToggle={() => toggleAgentTool(n)}
										/>
									);
								})}
								<div className="set-field-label">
									{t("settingsMarkers")}
									<HintTip text={`${t("settingsMarkersDesc")}\n${t("markerRenameTip")}`} />
								</div>
								<ToggleRow
									title={t("markersEnabled")}
									tip={`${t("markersEnabledDesc")}\n${t("markersOffHint")}`}
									enabled={markersEnabled}
									onToggle={() => setPartial({ markersEnabled: !markersEnabled })}
								/>
								{markersEnabled && (settings.markers?.length ?? 0) === 0 && (
									<p className="set-empty">{t("loading")}...</p>
								)}
								{markersEnabled &&
									settings.markers &&
									settings.markers.length > 0 &&
									settings.markers.map((m) => (
										<ToggleRow
											key={m.name}
											title={
												m.label
													? m.label
													: m.name === "notify"
														? t("markerGroupNotify")
														: m.name === "conv"
															? t("markerGroupRename")
															: m.name === "action"
																? t("markerGroupAction")
																: m.name
											}
											tip={m.guidance.join("\n")}
											enabled={m.enabled}
											onToggle={() => toggleMarker(m.name)}
										/>
									))}
								<div className="set-field-label">{t("toolsSectionOther")}</div>
								{OTHER_AGENT_TOOLS.map((tool) => {
									const blocked = isBlockedByPreset(tool.name);
									const isCodemodeActive = tool.name === "codemode" && !blocked && !disabledTools.has(tool.name);
									const isConfigExpanded = expandedToolConfigs.has(tool.name);

									const configToggleBtn = isCodemodeActive ? (
										<button
											type="button"
											className={`set-icon-btn tool-sub-config-btn${isConfigExpanded ? " active" : ""}`}
											title={isConfigExpanded ? t("collapseSection") : t("expandSection")}
											aria-expanded={isConfigExpanded}
											aria-label={isConfigExpanded ? t("collapseSection") : t("expandSection")}
											onClick={() => toggleToolConfigExpand(tool.name)}
										>
											<FiSliders />
										</button>
									) : null;

									return (
										<div key={tool.name}>
											<ToggleRow
												title={tool.name}
												tip={`${tt(tool.descKey ?? tool.name)}\n${tt(tool.offHintKey ?? tool.name)}`}
												action={
													<div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
														{configToggleBtn}
														{toolEditAction(tool.name)}
													</div>
												}
												subtitle={blocked ? t("toolsBlockedByPreset", { name: piPresetName }) : undefined}
												enabled={!blocked && !disabledTools.has(tool.name)}
												disabled={blocked}
												onToggle={() => toggleAgentTool(tool.name)}
											/>
											{isCodemodeActive && isConfigExpanded && (
												<div className="tool-sub-config-card">
													<div className="tool-sub-config-row">
														<label className="set-field-label">
															{t("codemodeModeLabel")}
															<HintTip text={t("codemodeModeHint")} />
														</label>
														<select
															className="set-select"
															style={{ width: "auto", minWidth: 140 }}
															value={settings.codemodeMode ?? "on"}
															onChange={(e) => setPartial({ codemodeMode: e.target.value as "on" | "only" })}
														>
															<option value="on">{t("codemodeModeOn")}</option>
															<option value="only">{t("codemodeModeOnly")}</option>
														</select>
													</div>
													<div className="tool-sub-config-row">
														<label className="set-field-label">
															{t("codemodeInlineBudgetLabel")}
															<HintTip text={t("codemodeInlineBudgetHint")} />
														</label>
														<input
															type="number"
															className="set-input"
															style={{ width: 100, textAlign: "right" }}
															min={500}
															max={50000}
															step={500}
															value={settings.codemodeInlineBudget ?? 3000}
															onChange={(e) => {
																const val = parseInt(e.target.value, 10);
																if (!isNaN(val) && val > 0) {
																	setPartial({ codemodeInlineBudget: val });
																}
															}}
														/>
													</div>
												</div>
											)}
										</div>
									);
								})}
							</div>
						)}

						{/* ---- message display ----------------------------------------- */}
						{tab === "display" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiMessageSquare className="set-section-icon" />
									{t("settingsMessageDisplay")}
								</div>
								<FieldRow label={t("softCapTokens")} tip={t("softCapHint")} htmlFor="soft-cap-max">
									<input
										id="soft-cap-max"
										className="set-input"
										type="text"
										placeholder={t("softCapOff")}
										value={softCapDraft}
										onChange={(e) => setSoftCapDraft(e.target.value)}
										onBlur={() => {
											const n = parseTokenInput(softCapDraft);
											setSoftCapDraft(formatTokenDraft(n));
											if (n !== (settings.softCapTokens ?? 0)) {
												setPartial({ softCapTokens: n });
											}
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") (e.target as HTMLInputElement).blur();
										}}
									/>
								</FieldRow>
								{/* 按模型覆盖：key = provider/id，优先于全局（issue #229）。 */}
								<div className="set-section-title">
									{t("softCapByModel")}
									<HintTip text={t("softCapByModelHint")} />
								</div>
								<div className="set-preset-save">
									<input
										className="set-input"
										placeholder={t("softCapModelId")}
										value={newCapModel}
										maxLength={200}
										onChange={(e) => setNewCapModel(e.target.value)}
									/>
									<input
										className="set-input"
										type="text"
										placeholder={t("softCapTokens")}
										value={newCapTokens}
										onChange={(e) => setNewCapTokens(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter" && newCapModel.trim() && parseTokenInput(newCapTokens) > 0) {
												const n = parseTokenInput(newCapTokens);
												setPartial({
													softCapByModel: {
														...settings.softCapByModel,
														[newCapModel.trim()]: n,
													},
												});
												setNewCapModel("");
												setNewCapTokens("");
											}
										}}
									/>
									<button
										type="button"
										className="set-save-btn"
										disabled={!newCapModel.trim() || parseTokenInput(newCapTokens) <= 0}
										onClick={() => {
											const id = newCapModel.trim();
											const n = parseTokenInput(newCapTokens);
											if (!id || n <= 0) return;
											setPartial({ softCapByModel: { ...settings.softCapByModel, [id]: n } });
											setNewCapModel("");
											setNewCapTokens("");
										}}
									>
										<FiPlus /> {t("softCapAdd")}
									</button>
								</div>
								<div className="set-list">
									{Object.entries(settings.softCapByModel).map(([model, cap]) => (
										<div className="set-row" key={model}>
											<span className="set-row-name">{model}</span>
											<input
												className="set-input"
												type="text"
												defaultValue={formatTokenDraft(cap)}
												key={`${model}:${cap}`}
												onBlur={(e) => {
													const n = parseTokenInput(e.target.value);
													e.target.value = formatTokenDraft(n);
													const next = { ...settings.softCapByModel };
													if (n > 0) next[model] = n;
													else delete next[model];
													setPartial({ softCapByModel: next });
												}}
												onKeyDown={(e) => {
													if (e.key === "Enter") (e.target as HTMLInputElement).blur();
												}}
											/>
											<button
												type="button"
												className="chip"
												title={t("softCapRemove")}
												onClick={() => {
													const next = { ...settings.softCapByModel };
													delete next[model];
													setPartial({ softCapByModel: next });
												}}
											>
												<FiX /> {t("softCapRemove")}
											</button>
										</div>
									))}
								</div>
								<FieldRow label={t("modelRetryAttempts")} tip={t("modelRetryHint")} htmlFor="model-retry-max">
									<input
										id="model-retry-max"
										className="set-input"
										type="number"
										min={0}
										max={100}
										step={1}
										value={retryDraft}
										onChange={(e) => setRetryDraft(e.target.value)}
										onBlur={() => {
											const n = Math.min(100, Math.max(0, Math.floor(Number(retryDraft) || 0)));
											setRetryDraft(String(n));
											if (n !== settings.retryMaxAttempts) {
												setPartial({ retryMaxAttempts: n });
											}
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") (e.target as HTMLInputElement).blur();
										}}
									/>
								</FieldRow>
								<ToggleRow
									title={t("thinkingWrap")}
									tip={t("thinkingWrapDesc")}
									enabled={settings.thinkingWrap ?? true}
									onToggle={() => setPartial({ thinkingWrap: !(settings.thinkingWrap ?? true) })}
								/>
								<ToggleRow
									title={t("toolsWrap")}
									tip={t("toolsWrapDesc")}
									enabled={settings.toolsWrap ?? true}
									onToggle={() => setPartial({ toolsWrap: !(settings.toolsWrap ?? true) })}
								/>
								<ToggleRow
									title={t("toolImages")}
									tip={t("toolImagesDesc")}
									enabled={settings.toolImagesEnabled ?? true}
									onToggle={() => setPartial({ toolImagesEnabled: !(settings.toolImagesEnabled ?? true) })}
								/>
								<FieldRow label={t("keepRecent")} tip={t("keepRecentDesc")} htmlFor="keep-recent">
									<input
										id="keep-recent"
										className="set-input"
										type="number"
										min={5}
										max={100}
										step={1}
										value={keepRecentDraft}
										onChange={(e) => setKeepRecentDraft(e.target.value)}
										onBlur={() => {
											const n = Math.min(100, Math.max(5, Math.floor(Number(keepRecentDraft) || 15)));
											setKeepRecentDraft(String(n));
											if (n !== settings.keepRecentMessages) {
												setPartial({ keepRecentMessages: n });
											}
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") (e.target as HTMLInputElement).blur();
										}}
									/>
								</FieldRow>
								<ToggleRow
									title={t("reversePagination")}
									tip={t("reversePaginationDesc")}
									enabled={settings.reversePagination ?? false}
									onToggle={() => setPartial({ reversePagination: !(settings.reversePagination ?? false) })}
								/>
								<ToggleRow
									title={t("showForkedParents")}
									tip={t("showForkedParentsDesc")}
									enabled={settings.showForkedParentSessions ?? false}
									onToggle={() =>
										setPartial({ showForkedParentSessions: !(settings.showForkedParentSessions ?? false) })
									}
								/>
								<ToggleRow
									title={t("retainFinishedConversations")}
									tip={t("retainFinishedConversationsDesc")}
									enabled={settings.retainFinishedConversations ?? false}
									onToggle={() =>
										setPartial({
											retainFinishedConversations: !(settings.retainFinishedConversations ?? false),
										})
									}
								/>
								<ToggleRow
									title={t("openRecentSessionOnProjectSwitch")}
									tip={t("openRecentSessionOnProjectSwitchDesc")}
									enabled={settings.openRecentSessionOnProjectSwitch ?? true}
									onToggle={() =>
										setPartial({
											openRecentSessionOnProjectSwitch: !(settings.openRecentSessionOnProjectSwitch ?? true),
										})
									}
								/>
								<ToggleRow
									title={t("minimalNewChat")}
									tip={t("minimalNewChatDesc")}
									enabled={settings.minimalNewChat ?? false}
									onToggle={() => setPartial({ minimalNewChat: !(settings.minimalNewChat ?? false) })}
								/>
								<ToggleRow
									title={t("preserveDraftAcrossConversations")}
									tip={t("preserveDraftAcrossConversationsDesc")}
									enabled={settings.preserveDraftAcrossConversations ?? false}
									onToggle={() =>
										setPartial({
											preserveDraftAcrossConversations: !(settings.preserveDraftAcrossConversations ?? false),
										})
									}
								/>
								<FieldRow label={t("sendKeyMode")} tip={t("sendKeyModeDesc")} htmlFor="send-key-mode">
									<select
										id="send-key-mode"
										className="set-select"
										value={effectiveSendKey}
										onChange={(e) => saveSendKeyPref(e.target.value as SendKey)}
									>
										<option value="enter">{t("sendKeyEnter")}</option>
										<option value="mod-enter">{t("sendKeyModEnter")}</option>
									</select>
								</FieldRow>
								<ToggleRow
									title={t("presentAutoOpen")}
									tip={t("presentAutoOpenDesc")}
									enabled={presentAutoOpen}
									onToggle={() => savePresentAutoOpen(!presentAutoOpen)}
								/>
								<ToggleRow
									title={t("parallelReminderEnabled")}
									tip={`${t("parallelReminderEnabledDesc")}\n${t("parallelReminderOffHint")}`}
									enabled={settings.parallelReminderEnabled ?? true}
									onToggle={() => setPartial({ parallelReminderEnabled: !(settings.parallelReminderEnabled ?? true) })}
								/>
								<ToggleRow
									title={t("devNoCache")}
									tip={t("devNoCacheDesc")}
									enabled={settings.devNoCache ?? true}
									onToggle={() => setPartial({ devNoCache: !(settings.devNoCache ?? true) })}
								/>
								<ToggleRow
									title={t("autoReload")}
									tip={t("autoReloadDesc")}
									enabled={settings.autoReload ?? true}
									onToggle={() => setPartial({ autoReload: !(settings.autoReload ?? true) })}
								/>
								<hr className="set-sep" />
								<ToggleRow
									title={t("wideChat")}
									tip={t("wideChatDesc")}
									enabled={wideChat}
									onToggle={() => saveChatWidthSettings({ wide: !wideChat })}
								/>
								<ToggleRow
									title={t("hideModelRow")}
									tip={t("hideModelRowDesc")}
									enabled={hideModelRow}
									onToggle={() => saveHideModelRowSettings({ hide: !hideModelRow })}
								/>
								<ToggleRow
									title={t("projectTitle")}
									tip={t("projectTitleDesc")}
									enabled={projectTitle}
									onToggle={() => saveTitleSettings({ projectName: !projectTitle })}
								/>
								<hr className="set-sep" />
								<div className="set-row">
									<div className="set-row-info">
										<div className="set-row-name">
											{t("wallpaperTitle")}
											<HintTip text={t("wallpaperDesc")} />
										</div>
										<div className="wallpaper-url-row">
											<input
												className="set-input wallpaper-url"
												placeholder={t("wallpaperUrlPh")}
												value={wallpaperDraft}
												maxLength={2000}
												spellCheck={false}
												onFocus={() => {
													wallpaperFocus.current = true;
												}}
												onChange={(e) => setWallpaperDraft(e.target.value)}
												onBlur={() => {
													wallpaperFocus.current = false;
													// 已上传的 data: 图不占输入框：空输入 = 未改动，不断然清空。
													if (!wallpaperDraft.trim() && wallpaper.url.startsWith("data:")) {
														setWallpaperDraft("");
														return;
													}
													const url = sanitizeWallpaperUrl(wallpaperDraft);
													setWallpaperDraft(url);
													if (url !== wallpaper.url) saveWallpaperSettings({ ...wallpaper, url });
												}}
												onKeyDown={(e) => {
													if (e.key === "Enter") (e.target as HTMLInputElement).blur();
													else if (e.key === "Escape") {
														setWallpaperDraft(wallpaper.url.startsWith("data:") ? "" : wallpaper.url);
														(e.target as HTMLInputElement).blur();
													}
												}}
											/>
											<button
												type="button"
												className="set-save-btn"
												disabled={wallpaperUploading}
												onClick={() => wallpaperFileRef.current?.click()}
											>
												<FiUpload /> {t("wallpaperUpload")}
											</button>
											<input
												ref={wallpaperFileRef}
												type="file"
												accept="image/*"
												hidden
												onChange={onPickWallpaperFile}
											/>
										</div>
										{wallpaperUploadError && <p className="set-hint">{t("wallpaperUploadFailed")}</p>}
										<div className="wallpaper-sliders">
											<label className="wallpaper-slider">
												<span>{t("wallpaperDim")}</span>
												<input
													type="range"
													min={0}
													max={95}
													step={1}
													value={wallpaper.dim}
													onChange={(e) => saveWallpaperSettings({ ...wallpaper, dim: Number(e.target.value) })}
												/>
												<output>{wallpaper.dim}%</output>
											</label>
											<label className="wallpaper-slider">
												<span>{t("wallpaperBlur")}</span>
												<input
													type="range"
													min={0}
													max={24}
													step={1}
													value={wallpaper.blur}
													onChange={(e) => saveWallpaperSettings({ ...wallpaper, blur: Number(e.target.value) })}
												/>
												<output>{wallpaper.blur}px</output>
											</label>
										</div>
									</div>
									{wallpaper.url && (
										<div className="wallpaper-current">
											<img className="wallpaper-preview" src={wallpaper.url} alt="" />
											<button
												type="button"
												className="wallpaper-clear"
												onClick={() => {
													setWallpaperDraft("");
													saveWallpaperSettings({ ...wallpaper, url: "" });
												}}
											>
												{t("wallpaperClear")}
											</button>
										</div>
									)}
								</div>
							</div>
						)}

						{/* ---- 通知（系统桌面通知；提示音与本地 TTS 已随精简发行版移除） ---- */}
						{tab === "sound" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiVolume2 className="set-section-icon" />
									{t("settingsNotifyTab")}
								</div>
								<NotifyToggle />
							</div>
						)}

						{/* ---- 快捷短语（输入框上方一键发送） ------------------------------ */}
						{tab === "quick" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiSend className="set-section-icon" />
									{t("quickPhrases")}
									<HintTip text={t("quickPhrasesDesc")} />
									<span className="set-count">{settings.quickPhrases.length}</span>
								</div>
								<ToggleRow
									title={t("quickPhrasesEnabled")}
									tip={t("quickPhrasesDesc")}
									enabled={settings.quickPhrasesEnabled}
									onToggle={() => setPartial({ quickPhrasesEnabled: !settings.quickPhrasesEnabled })}
								/>
								<ToggleRow
									title={t("minimalNewChat")}
									tip={t("minimalNewChatDesc")}
									enabled={settings.minimalNewChat ?? false}
									onToggle={() => setPartial({ minimalNewChat: !(settings.minimalNewChat ?? false) })}
								/>
								<ToggleRow
									title={t("preserveDraftAcrossConversations")}
									tip={t("preserveDraftAcrossConversationsDesc")}
									enabled={settings.preserveDraftAcrossConversations ?? false}
									onToggle={() =>
										setPartial({
											preserveDraftAcrossConversations: !(settings.preserveDraftAcrossConversations ?? false),
										})
									}
								/>
								{!settings.quickPhrasesEnabled && <p className="set-hint">{t("quickPhrasesOffHint")}</p>}
								<div className="set-preset-save">
									<input
										className="set-input"
										placeholder={t("quickPhrasesPlaceholder")}
										value={quickNew}
										maxLength={200}
										onChange={(e) => setQuickNew(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter" && quickNew.trim()) {
												setPartial({ quickPhrases: [...settings.quickPhrases, quickNew.trim()] });
												setQuickNew("");
											}
										}}
									/>
									<button
										type="button"
										className="set-save-btn"
										disabled={!quickNew.trim()}
										onClick={() => {
											setPartial({ quickPhrases: [...settings.quickPhrases, quickNew.trim()] });
											setQuickNew("");
										}}
									>
										<FiPlus /> {t("quickPhrasesAdd")}
									</button>
								</div>
								{settings.quickPhrases.length === 0 ? (
									<p className="set-empty">{t("quickPhrasesEmpty")}</p>
								) : (
									<div className="set-list">
										{settings.quickPhrases.map((p, i) => (
											<div className="set-row" key={`${i}:${p}`}>
												{quickEdit?.index === i ? (
													<div className="set-row-info">
														<input
															className="set-input"
															autoFocus
															value={quickEdit.value}
															maxLength={200}
															placeholder={t("quickPhrasesEditPh")}
															onChange={(e) => setQuickEdit({ index: i, value: e.target.value })}
															onKeyDown={(e) => {
																if (e.key === "Enter") commitQuickEdit();
																else if (e.key === "Escape") setQuickEdit(null);
															}}
															onBlur={commitQuickEdit}
														/>
													</div>
												) : (
													<>
														<div className="set-row-info">
															<div className="set-row-name" title={p}>
																{p}
															</div>
														</div>
														<div className="set-row-actions">
															<button
																type="button"
																className="set-icon-btn"
																title={t("quickPhrasesEdit")}
																onClick={() => setQuickEdit({ index: i, value: p })}
															>
																<FiEdit3 />
															</button>
															<button
																type="button"
																className="set-icon-btn"
																title={t("quickPhrasesMoveUp")}
																disabled={i === 0}
																onClick={() => {
																	const next = [...settings.quickPhrases];
																	[next[i - 1], next[i]] = [next[i], next[i - 1]];
																	setPartial({ quickPhrases: next });
																}}
															>
																↑
															</button>
															<button
																type="button"
																className="set-icon-btn"
																title={t("quickPhrasesMoveDown")}
																disabled={i === settings.quickPhrases.length - 1}
																onClick={() => {
																	const next = [...settings.quickPhrases];
																	[next[i], next[i + 1]] = [next[i + 1], next[i]];
																	setPartial({ quickPhrases: next });
																}}
															>
																↓
															</button>
															<button
																type="button"
																className="set-icon-btn danger"
																title={t("quickPhrasesDelete")}
																onClick={() =>
																	setPartial({ quickPhrases: settings.quickPhrases.filter((_, j) => j !== i) })
																}
															>
																<FiTrash2 />
															</button>
														</div>
													</>
												)}
											</div>
										))}
									</div>
								)}
								<div className="compose-toolbar">
									<button
										type="button"
										className="dd-refresh"
										onClick={() => {
											setQuickEdit(null);
											setPartial({ quickPhrases: QUICK_PHRASE_DEFAULTS[locale] ?? QUICK_PHRASE_DEFAULTS.en });
										}}
									>
										{t("quickPhrasesReset")}
									</button>
								</div>
							</div>
						)}

						{/* ---- skills --------------------------------------------------- */}
						{tab === "skills" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiCpu className="set-section-icon" />
									{t("settingsSkills")}
									<HintTip text={`${t("skillFullTextLabel")}：${t("skillFullTextDesc")}`} />
									<span className="set-count">{settings.skills.length}</span>
								</div>

								{/* 1. 已安装技能列表 */}
								{skillSubTab === "installed" && (
									<>
										{piPresetFiltering && !presetShowsSkillCatalog(piPresetId ?? undefined) && (
											<p className="set-catalog-hint warn">{t("skillsHiddenByPreset", { name: piPresetName })}</p>
										)}
										<div className="set-catalog-opts">
											<FieldRow
												label={t("skillsCatalogMaxDesc")}
												tip={t("skillsCatalogMaxDescTip")}
												htmlFor="skills-max-desc"
											>
												<input
													id="skills-max-desc"
													className="set-input"
													type="number"
													min={0}
													max={2000}
													step={50}
													value={skillsMaxDescDraft}
													onChange={(e) => setSkillsMaxDescDraft(e.target.value)}
													onBlur={() => {
														const raw = Math.floor(Number(skillsMaxDescDraft));
														const n = Number.isFinite(raw) && raw >= 0 ? raw : 250;
														setSkillsMaxDescDraft(String(n));
														if (n !== settings.skillsCatalogMaxDesc) {
															setPartial({ skillsCatalogMaxDesc: n });
														}
													}}
													onKeyDown={(e) => {
														if (e.key === "Enter") (e.target as HTMLInputElement).blur();
													}}
												/>
											</FieldRow>
											<ToggleRow
												title={t("skillsCatalogShowLocation")}
												tip={t("skillsCatalogShowLocationTip")}
												enabled={settings.skillsCatalogShowLocation ?? false}
												onToggle={() =>
													setPartial({
														skillsCatalogShowLocation: !(settings.skillsCatalogShowLocation ?? false),
													})
												}
											/>
										</div>
										{settings.skills.length === 0 ? (
											<div className="mcp-empty-card">
												<div className="mcp-empty-icon">
													<FiCpu />
												</div>
												<div className="mcp-empty-title">{t("noSkills")}</div>
												<div className="mcp-empty-desc">{t("skillEmptyDesc")}</div>
											</div>
										) : (
											<div className="set-list">
												{settings.skills.map((s) => (
													<ToggleRow
														key={s.name}
														title={s.name}
														subtitle={s.description}
														enabled={s.enabled}
														onToggle={() => toggleSkill(s)}
														action={
															<button
																type="button"
																className={`tpl-chip${fullTextSkills.has(s.name) ? " on" : ""}`}
																title={t("skillFullTextDesc")}
																onClick={() => toggleSkillFullText(s.name)}
															>
																{t("skillFullTextShort")}
															</button>
														}
													/>
												))}
											</div>
										)}
									</>
								)}
							</div>
						)}

						{/* 界面布局（issue #146）：用户随时能改回来 ——
							    隐藏的条目仍可在顶栏溢出菜单里点到，改过的条目会显示「恢复」。 */}
						{tab === "layout" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiSliders className="set-section-icon" />
									{t("uiLayoutTitle")}
									{onOpenIconEdit && (
										<button
											type="button"
											className="set-uninstall"
											style={{ marginLeft: "auto" }}
											title={t("uiIconEditHint")}
											onClick={onOpenIconEdit}
										>
											<FiEdit2 />
											{t("uiIconEdit")}
										</button>
									)}
									<button
										type="button"
										className="set-uninstall"
										style={onOpenIconEdit ? undefined : { marginLeft: "auto" }}
										onClick={restoreUiAll}
									>
										{t("uiLayoutRestoreAll")}
									</button>
								</div>
								<div className="set-note">{t("uiLayoutHint")}</div>
								{/* 侧边图标停靠栏形态：默认「贴边槽位」（占宽、不遮挡面板按钮）；勾上 = 旧的
								    悬浮浮层（不占宽，但会盖住面板竖中央那条）。 */}
								<label className="set-toggle" title="sideDockFloat">
									<input
										type="checkbox"
										checked={layout?.sideDockFloat === true}
										onChange={(e) => setLayout({ sideDockFloat: e.target.checked })}
									/>
									<span>{t("uiLayoutSideDockFloat")}</span>
								</label>
								{uiDiagnostics.length > 0 &&
									(() => {
										const hasIssues = uiDiagnostics.some((d) => d.level === "warn" || d.level === "error");
										return (
											<details
												className={`set-ui-diag${hasIssues ? "" : " info-only"}`}
												open={uiDiagnostics.some((d) => d.level === "error")}
											>
												<summary>
													{hasIssues ? "⚠ " : "ℹ "}
													{t("uiLayoutDiagTitle", { n: uiDiagnostics.length })}
												</summary>
												<ul className="set-ui-diag-list">
													{uiDiagnostics.map((d, i) => (
														<li key={`host:${d.entryId ?? i}`} className={`set-ui-diag-item ${d.level}`}>
															{d.entryId ? <code>{d.entryId}</code> : null}
															<span>{d.message}</span>
														</li>
													))}
												</ul>
												<div className="set-ui-diag-hint">{t("uiLayoutDiagHint")}</div>
											</details>
										);
									})()}
								<input
									className="set-ui-filter"
									value={uiLayoutFilter}
									placeholder={t("uiLayoutSearch")}
									aria-label={t("uiLayoutSearch")}
									onChange={(e) => setUiLayoutFilter(e.target.value)}
								/>
								{uiLayoutSections.map(({ slot, labelKey }) => {
									const entries = (uiSlots[slot] ?? []).filter(
										(e) =>
											(e.id !== "host:composer-dsh-perm" &&
												e.id !== "host:composer-dsh-preset" &&
												// 计划模式靠 pi 引擎的工具硬闸门 → 不列。
												e.id !== "host:goal-plan") &&
											!HIDDEN_FROM_LAYOUT_ITEM_IDS.has(e.id),
									);
									const q = uiLayoutFilter.trim().toLowerCase();
									// 按实际界面分组展示：顶栏/底栏/输入框动作区在界面上按对齐段
									// （左 start → 中 center → 右 end）分段渲染，布局页同口径按段
									// 列出（段头即界面上的段），↑↓ 只在段内移动；搜索时展平
									// （看到的是子集，此时 ↑↓ 禁用，免得挪了看不见的邻居）。
									const grouped = !q && uiAlignSlots.includes(slot);
									const segments: { align: string | null; items: UiSlotEntry[] }[] = grouped
										? (["start", "center", "end"] as const)
												.map((align) => ({ align, items: entries.filter((e) => e.align === align) }))
												.filter((g) => g.items.length > 0)
										: [
												{
													align: null,
													items: q
														? entries.filter((e) => `${e.label} ${e.id} ${e.source}`.toLowerCase().includes(q))
														: entries,
												},
											];
									const total = segments.reduce((n, g) => n + g.items.length, 0);
									// 搜索时藏掉无命中的分区（30 个分区全展开翻不动）。
									if (q && total === 0) return null;
									const renderRow = (it: UiSlotEntry, rowItems: UiSlotEntry[]) => {
										const idx = rowItems.findIndex((e) => e.id === it.id);
										const required = REQUIRED_TOPBAR_ITEM_IDS.has(it.id);
										return (
											<div key={it.id} className="set-row">
												<label className="set-toggle" title={required ? t("uiLayoutRequired") : it.id}>
													<input
														type="checkbox"
														checked={!it.hidden}
														disabled={required}
														onChange={() => toggleUiHidden(it)}
													/>
													<span>
														{it.icon ? `${it.icon} ` : ""}
														{it.label}
													</span>
												</label>
												<div className="set-row-actions">
													{it.movedFrom && (
														<span className="set-ui-source" title={it.id}>
															{t("uiLayoutMovedFrom")}: {uiSlotTitle(it.movedFrom)}
														</span>
													)}
													{uiPositionSlots.includes(slot) && (
														<label className="set-ui-align" title={t("uiLayoutPosition")}>
															<select
																value={slot}
																onChange={(e) => setUiSlot(it.id, e.target.value as UiSlotId)}
																aria-label={t("uiLayoutPosition")}
															>
																<option value="topbar.primary">{t("uiLayoutPosTop")}</option>
																<option value="bottombar">{t("uiLayoutPosBottom")}</option>
																<option value="sidebar.left">{t("uiLayoutPosLeft")}</option>
																<option value="sidebar.right">{t("uiLayoutPosRight")}</option>
															</select>
														</label>
													)}
													{uiAlignSlots.includes(slot) && (
														<label className="set-ui-align" title={t("uiLayoutAlign")}>
															<select
																value={it.align}
																onChange={(e) => setUiAlign(it.id, e.target.value)}
																aria-label={t("uiLayoutAlign")}
															>
																{verticalAlignSlot(slot) ? (
																	ICON_EDIT_ALIGNS.map((al) => (
																		<option key={al} value={al}>
																			{sideAlignLabel(t, al)}
																		</option>
																	))
																) : (
																	<>
																		<option value="start">start</option>
																		<option value="center">center</option>
																		<option value="end">end</option>
																	</>
																)}
															</select>
														</label>
													)}
													<input
														key={`${it.id}:${layout?.labels?.[it.id] ?? ""}`}
														className="set-ui-label"
														defaultValue={layout?.labels?.[it.id] ?? ""}
														placeholder={t("uiLayoutRename")}
														title={t("uiLayoutRename")}
														aria-label={t("uiLayoutRename")}
														onBlur={(e) => {
															if (e.target.value !== (layout?.labels?.[it.id] ?? "")) setUiLabel(it.id, e.target.value);
														}}
														onKeyDown={(e) => {
															if (e.key === "Enter" && !e.nativeEvent.isComposing)
																(e.target as HTMLInputElement).blur();
														}}
													/>
													{it.userOverrides.length > 0 && (
														<button type="button" className="set-uninstall" onClick={() => restoreUi(it.id)}>
															{t("uiLayoutRestore")}
														</button>
													)}
													<button
														type="button"
														className="set-uninstall"
														disabled={!!q || idx <= 0}
														onClick={() => moveUiEntry(entries, rowItems, it.id, -1)}
													>
														↑
													</button>
													<button
														type="button"
														className="set-uninstall"
														disabled={!!q || idx < 0 || idx >= rowItems.length - 1}
														onClick={() => moveUiEntry(entries, rowItems, it.id, 1)}
													>
														↓
													</button>
												</div>
											</div>
										);
									};
									return (
										<div key={slot} className="set-ui-slot">
											<div className="set-ui-slot-title">{t(labelKey as Parameters<typeof t>[0])}</div>
											{/* 顶栏按钮文字总开关：关掉后顶栏只剩图标（角标保留，溢出菜单仍带文字）。 */}
											{slot === "topbar.primary" && (
												<label className="set-toggle" title="topbarText">
													<input
														type="checkbox"
														checked={layout?.topbarText !== false}
														onChange={(e) => setLayout({ topbarText: e.target.checked })}
													/>
													<span>{t("uiLayoutTopbarText")}</span>
												</label>
											)}
											{entries.length === 0 ? (
												<div className="set-empty">{t("uiLayoutEmpty")}</div>
											) : (
												segments.map((seg) => (
													<Fragment key={seg.align ?? "all"}>
														{seg.align && (
															<div className="set-ui-slot-title set-ui-seg">
																{verticalAlignSlot(slot) ? sideAlignLabel(t, seg.align as UiAlign) : seg.align}
															</div>
														)}
														{seg.items.map((it) => renderRow(it, seg.items))}
													</Fragment>
												))
											)}
										</div>
									);
								})}
							</div>
						)}
						{/* ---- vision bridge ---------------------------------------------- */}
						{tab === "vision" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiEye className="set-section-icon" />
									{t("settingsVisionBridge")}
								</div>
								<ToggleRow
									title={t("visionBridgeEnabled")}
									tip={`${t("settingsVisionBridgeDesc")}\n${t("visionBridgeOffHint")}`}
									enabled={settings.visionBridgeEnabled}
									onToggle={() => setPartial({ visionBridgeEnabled: !settings.visionBridgeEnabled })}
								/>
								{settings.visionBridgeEnabled && (
									<FieldRow label={t("visionBridgeModel")}>
										<select
											className="set-select"
											value={settings.visionBridgeModel ?? ""}
											onChange={(e) => setPartial({ visionBridgeModel: e.target.value || null })}
										>
											<option value="">{t("visionBridgeAuto")}</option>
											{settings.visionModels.map((m) => (
												<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
													{m.label}
												</option>
											))}
										</select>
									</FieldRow>
								)}
								{settings.visionBridgeEnabled && (
									<PromptOverrideEditor
										mode={vbPromptMode}
										onModeChange={setVbPromptMode}
										draft={vbPromptDraft}
										onDraftChange={setVbPromptDraft}
										defaultPrompt={settings.visionBridgeDefaultPrompt}
										placeholder={t("visionBridgePromptPlaceholder")}
										rows={4}
										onCommit={(mode, text) => {
											setPartial({
												visionBridgePromptMode: mode,
												visionBridgePrompt: text,
											});
										}}
										hint={
											settings.visionModels.length === 0
												? t("visionBridgeNoModels")
												: t("visionBridgeCurrent", {
														model: settings.visionBridgeModel ?? t("visionBridgeAuto"),
													})
										}
										focusRef={vbPromptFocus}
									/>
								)}
							</div>
						)}

						{/* ---- subagent templates（全局共享；DSH 引擎隐藏该分区） ---------- */}
						{tab === "subagent-templates" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiUsers className="set-section-icon" />
									{t("settingsSubagentTemplates")}
									<HintTip text={t("settingsSubagentTemplatesDesc")} />
									<span className="set-count">{settings.subagentTemplates.length}</span>
									<button
										type="button"
										className="set-save-btn"
										title={t("subagentTemplateNew")}
										onClick={() => {
											setTplDraft({
												name: "",
												description: "",
												promptMode: "replace",
												systemPrompt: "",
												enabledSkills: [],
												enabledExtensions: [],
												model: "",
												thinkingLevel: "",
												enabled: true,
											});
											setTplIsNew(true);
										}}
									>
										<FiPlus /> {t("subagentTemplateNew")}
									</button>
								</div>

								{/* ---- 默认模型：全部子代理的兜底（模板/显式 model 参数优先） ---------- */}
								<FieldRow label={t("subagentDefaultModelLabel")} tip={t("subagentDefaultModelHint")}>
									<select
										className="set-select"
										value={settings.subagentDefaultModel ?? ""}
										onChange={(e) => setPartial({ subagentDefaultModel: e.target.value || null })}
									>
										<option value="">{t("subagentFollowMain")}</option>
										{settings.subagentModels.map((m) => (
											<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
												{m.label}
											</option>
										))}
									</select>
								</FieldRow>
								{settings.subagentModels.length === 0 && <p className="set-hint">{t("subagentNoModels")}</p>}

								{/* ---- 编辑器：独立弹窗（新建 / 编辑同表单，列表页保持干净） ---------- */}
								{tplDraft && (
									<div className="modal-backdrop tpl-modal-backdrop" onClick={() => setTplDraft(null)}>
										<div className="modal tpl-modal" onClick={(e) => e.stopPropagation()}>
											<button
												type="button"
												className="modal-close"
												aria-label={t("close")}
												onClick={() => setTplDraft(null)}
											>
												<FiX />
											</button>
											<div className="modal-head">
												<FiUsers className="modal-head-icon" />
												<h2>
													{tplIsNew ? t("subagentTemplateNew") : `${t("subagentTemplateEdit")} · ${tplDraft.name}`}
												</h2>
											</div>
											<div className="modal-body">
												<div className="tpl-fields">
													<input
														className="set-input"
														placeholder={t("tplNamePlaceholder")}
														value={tplDraft.name}
														onChange={(e) => setTplDraft({ ...tplDraft, name: e.target.value })}
													/>
													<input
														className="set-input"
														placeholder={t("tplDescriptionPlaceholder")}
														value={tplDraft.description}
														onChange={(e) => setTplDraft({ ...tplDraft, description: e.target.value })}
													/>
													<input
														className="set-input"
														placeholder={t("tplDescriptionEnPlaceholder")}
														value={tplDraft.descriptionEn ?? ""}
														onChange={(e) => setTplDraft({ ...tplDraft, descriptionEn: e.target.value })}
													/>
												</div>
												<div className="set-mode-row">
													<label className="set-field-label">{t("tplPromptModeLabel")}</label>
													<select
														className="set-select"
														value={tplDraft.promptMode}
														onChange={(e) =>
															setTplDraft({ ...tplDraft, promptMode: e.target.value as "append" | "replace" })
														}
													>
														<option value="replace">{t("promptModeReplace")}</option>
														<option value="append">{t("promptModeAppend")}</option>
													</select>
												</div>
												<div className="set-mode-row">
													<label className="set-field-label">{t("tplModelLabel")}</label>
													<select
														className="set-select"
														value={tplDraft.model ?? ""}
														onChange={(e) => setTplDraft({ ...tplDraft, model: e.target.value })}
													>
														<option value="">{t("subagentFollowMain")}</option>
														{settings.subagentModels.map((m) => (
															<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
																{m.label}
															</option>
														))}
													</select>
												</div>
												<div className="set-mode-row">
													<label className="set-field-label">
														{t("tplThinkingLabel")} <HintTip text={t("tplThinkingHint")} />
													</label>
													<select
														className="set-select"
														value={tplDraft.thinkingLevel ?? ""}
														onChange={(e) => setTplDraft({ ...tplDraft, thinkingLevel: e.target.value })}
													>
														<option value="">{t("tplThinkingFollowMain")}</option>
														{THINKING_VALUES.map((v) => (
															<option key={v} value={v}>
																{t(`thinking.${v}`)}
															</option>
														))}
													</select>
												</div>
												<textarea
													className="set-prompt-input"
													rows={4}
													placeholder={`${t("tplSystemPromptLabel")}${isZhLocale(locale) ? "：" : ": "}${t(
														"tplSystemPromptPlaceholder",
													)}`}
													value={tplDraft.systemPrompt}
													onChange={(e) => setTplDraft({ ...tplDraft, systemPrompt: e.target.value })}
												/>
												<textarea
													className="set-prompt-input"
													rows={4}
													placeholder={`${t("tplSystemPromptLabel")}: ${t("tplSystemPromptEnPlaceholder")}`}
													value={tplDraft.systemPromptEn ?? ""}
													onChange={(e) => setTplDraft({ ...tplDraft, systemPromptEn: e.target.value })}
												/>
												<div className="tpl-pick-block">
													<div className="tpl-pick-head">
														<span>
															{t("tplSkillsLabel")} · {t("tplWhitelistHint")}
														</span>
													</div>
													{settings.skills.length === 0 ? (
														<p className="set-hint">{t("noSkills")}</p>
													) : (
														<div className="tpl-pick">
															{settings.skills.map((s) => (
																<label
																	key={s.name}
																	className={`tpl-chip${tplDraft.enabledSkills.includes(s.name) ? " on" : ""}`}
																>
																	<input
																		type="checkbox"
																		checked={tplDraft.enabledSkills.includes(s.name)}
																		onChange={(e) => {
																			const on = e.target.checked;
																			setTplDraft({
																				...tplDraft,
																				enabledSkills: on
																					? [...tplDraft.enabledSkills, s.name]
																					: tplDraft.enabledSkills.filter((n) => n !== s.name),
																			});
																		}}
																	/>
																	{s.name}
																</label>
															))}
														</div>
													)}
												</div>
												<div className="tpl-pick-block">
													<div className="tpl-pick-head">
														<span>
															{t("tplExtensionsLabel")} · {t("tplWhitelistHint")}
														</span>
													</div>
													{settings.extensions.length === 0 ? (
														<p className="set-hint">{t("noExtensions")}</p>
													) : (
														<div className="tpl-pick">
															{settings.extensions.map((x) => (
																<label
																	key={x.id}
																	className={`tpl-chip${tplDraft.enabledExtensions.includes(x.id) ? " on" : ""}`}
																>
																	<input
																		type="checkbox"
																		checked={tplDraft.enabledExtensions.includes(x.id)}
																		onChange={(e) => {
																			const on = e.target.checked;
																			setTplDraft({
																				...tplDraft,
																				enabledExtensions: on
																					? [...tplDraft.enabledExtensions, x.id]
																					: tplDraft.enabledExtensions.filter((id) => id !== x.id),
																			});
																		}}
																	/>
																	{x.name}
																</label>
															))}
														</div>
													)}
												</div>
											</div>
											<div className="modal-actions">
												<button
													type="button"
													className="set-save-btn"
													disabled={!tplDraft.name.trim()}
													onClick={() => {
														appSend({
															type: "save_subagent_template",
															template: { ...tplDraft, name: tplDraft.name.trim() },
														});
														setTplDraft(null);
													}}
												>
													{t("tplSave")}
												</button>
												<button type="button" className="dd-refresh" onClick={() => setTplDraft(null)}>
													{t("tplCancel")}
												</button>
											</div>
										</div>
									</div>
								)}

								{/* ---- 模板列表 ------------------------------------------------ */}
								{settings.subagentTemplates.length === 0 ? (
									<p className="set-empty">{t("noSubagentTemplates")}</p>
								) : (
									<div className="set-list set-list-flat">
										{settings.subagentTemplates.map((tp) => (
											<div className="set-row" key={tp.name}>
												<div className="set-row-info">
													<div className="set-row-name">
														{tp.name}
														{settings.subagentDefaultTemplates.includes(tp.name) && (
															<span className="tpl-badge default">{t("tplDefaultBadge")}</span>
														)}
														{!tp.enabled && <span className="tpl-badge">{t("subagentTemplateClosed")}</span>}
													</div>
													<div className="set-row-desc">
														{(!isZhLocale(locale) && tp.descriptionEn ? tp.descriptionEn : tp.description) ||
															`${tp.promptMode === "replace" ? t("promptModeReplace") : t("promptModeAppend")}`}
														{tp.model ? ` · ${t("tplModelLabel")} ${tp.model}` : ` · ${t("subagentFollowMain")}`}
														{tp.thinkingLevel
															? ` · ${t("tplThinkingLabel")} ${tt(`thinking.${tp.thinkingLevel}`)}`
															: ""}
														{tp.enabledSkills.length > 0 && ` · ${t("tplSkillsLabel")} ${tp.enabledSkills.length}`}
														{tp.enabledExtensions.length > 0 &&
															` · ${t("tplExtensionsLabel")} ${tp.enabledExtensions.length}`}
														{!tp.description &&
															tp.enabledSkills.length === 0 &&
															tp.enabledExtensions.length === 0 &&
															` · ${t("tplInherit")}`}
													</div>
												</div>
												<div className="set-row-actions">
													<button
														type="button"
														className={`set-switch${tp.enabled ? " on" : ""}`}
														role="switch"
														aria-checked={tp.enabled}
														title={`${tp.enabled ? t("subagentTemplateDisable") : t("subagentTemplateEnable")} · ${t(
															"subagentTemplateOffHint",
														)}`}
														onClick={() =>
															appSend({ type: "save_subagent_template", template: { ...tp, enabled: !tp.enabled } })
														}
													>
														<span className="set-switch-knob" />
													</button>
													<button
														type="button"
														className="set-uninstall"
														title={t("subagentTemplateEdit")}
														onClick={() => {
															setTplDraft({ ...tp });
															setTplIsNew(false);
														}}
													>
														{t("subagentTemplateEdit")}
													</button>
													{confirmTplDelete === tp.name ? (
														<button
															type="button"
															className="set-uninstall confirm"
															title={t("uninstallConfirmHint")}
															onClick={() => {
																appSend({ type: "delete_subagent_template", name: tp.name });
																setConfirmTplDelete(null);
															}}
														>
															{t("uninstallConfirm")}
														</button>
													) : (
														<button
															type="button"
															className="set-icon-btn danger"
															title={t("tplDelete")}
															onClick={() => setConfirmTplDelete(tp.name)}
														>
															<FiTrash2 />
														</button>
													)}
												</div>
											</div>
										))}
									</div>
								)}
							</div>
						)}

						{/* ---- approval rules（全局共享） ---------- */}
						{tab === "approval-rules" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiShield className="set-section-icon" />
									{t("settingsApprovalRules")}
									<HintTip text={t("settingsApprovalRulesDesc")} />
									<span className="set-count">{settings.approvalRules?.length ?? 0}</span>
									<button
										type="button"
										className="set-save-btn"
										title={t("approvalRuleNew")}
										onClick={() => {
											setRuleDraft({
												id: `custom.${randomUuid().slice(0, 8)}`,
												enabled: true,
												tools: ["bash"],
												field: "command",
												match: "regex",
												value: "",
												action: "ask",
												label: "",
												labelEn: "",
												reason: "",
												reasonEn: "",
											});
											setRuleToolsText("bash");
											setRuleIsNew(true);
											setRuleError(null);
										}}
									>
										<FiPlus /> {t("approvalRuleNew")}
									</button>
								</div>

								{/* ---- 编辑 / 新建表单 ---------- */}
								{ruleDraft && (
									<div className="rule-editor">
										<div className="set-section-title" style={{ fontSize: 13, marginBottom: 4 }}>
											{ruleIsNew ? t("approvalRuleNew") : `${t("approvalRuleEdit")} · ${ruleDraft.label}`}
										</div>
										<FieldRow label={t("approvalRuleLabel")}>
											<input
												className="set-input"
												value={ruleDraft.label}
												placeholder={t("approvalRuleLabelPlaceholder")}
												onChange={(e) => setRuleDraft({ ...ruleDraft, label: e.target.value })}
											/>
										</FieldRow>
										<FieldRow label={t("approvalRuleLabelEn")}>
											<input
												className="set-input"
												value={ruleDraft.labelEn ?? ""}
												placeholder="e.g. Block dangerous Docker commands"
												onChange={(e) => setRuleDraft({ ...ruleDraft, labelEn: e.target.value })}
											/>
										</FieldRow>
										<FieldRow label={t("approvalRuleTools")} tip={t("approvalRuleToolsTip")}>
											<input
												className="set-input"
												value={ruleToolsText}
												placeholder={t("approvalRuleToolsPlaceholder")}
												onChange={(e) => {
													setRuleToolsText(e.target.value);
													const arr = e.target.value
														.split(",")
														.map((x) => x.trim().toLowerCase())
														.filter(Boolean);
													setRuleDraft({ ...ruleDraft, tools: arr.length > 0 ? arr : ["*"] });
												}}
											/>
										</FieldRow>
										<div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
											<div style={{ flex: 1, minWidth: 160 }}>
												<FieldRow label={t("approvalRuleField")}>
													<select
														className="set-select"
														value={ruleDraft.field}
														onChange={(e) =>
															setRuleDraft({
																...ruleDraft,
																field: e.target.value as "command" | "path" | "params",
															})
														}
													>
														<option value="command">{t("approvalRuleFieldCommand")}</option>
														<option value="path">{t("approvalRuleFieldPath")}</option>
														<option value="params">{t("approvalRuleFieldParams")}</option>
													</select>
												</FieldRow>
											</div>
											<div style={{ flex: 1, minWidth: 160 }}>
												<FieldRow label={t("approvalRuleMatch")}>
													<select
														className="set-select"
														value={ruleDraft.match}
														onChange={(e) =>
															setRuleDraft({
																...ruleDraft,
																match: e.target.value as "regex" | "glob" | "contains" | "prefix" | "outside_workspace",
															})
														}
													>
														<option value="regex">{t("approvalRuleMatchRegex")}</option>
														<option value="glob">{t("approvalRuleMatchGlob")}</option>
														<option value="contains">{t("approvalRuleMatchContains")}</option>
														<option value="prefix">{t("approvalRuleMatchPrefix")}</option>
														<option value="outside_workspace">{t("approvalRuleMatchOutsideWs")}</option>
													</select>
												</FieldRow>
											</div>
											<div style={{ flex: 1, minWidth: 160 }}>
												<FieldRow label={t("approvalRuleActionLabel")}>
													<select
														className="set-select"
														value={ruleDraft.action}
														onChange={(e) =>
															setRuleDraft({
																...ruleDraft,
																action: e.target.value as "ask" | "deny" | "allow",
															})
														}
													>
														<option value="ask">{t("approvalRuleActionAsk")}</option>
														<option value="deny">{t("approvalRuleActionDeny")}</option>
														<option value="allow">{t("approvalRuleActionAllow")}</option>
													</select>
												</FieldRow>
											</div>
										</div>
										{ruleDraft.match !== "outside_workspace" && (
											<FieldRow label={t("approvalRuleValue")} tip={t("approvalRuleValueTip")}>
												<input
													className="set-input"
													value={ruleDraft.value}
													placeholder={t("approvalRuleValuePlaceholder")}
													onChange={(e) => setRuleDraft({ ...ruleDraft, value: e.target.value })}
												/>
											</FieldRow>
										)}
										<FieldRow label={t("approvalRuleReason")}>
											<input
												className="set-input"
												value={ruleDraft.reason ?? ""}
												placeholder={t("approvalRuleReasonPlaceholder")}
												onChange={(e) => setRuleDraft({ ...ruleDraft, reason: e.target.value })}
											/>
										</FieldRow>
										<FieldRow label={t("approvalRuleReasonEn")}>
											<input
												className="set-input"
												value={ruleDraft.reasonEn ?? ""}
												placeholder="e.g. Detected docker image/container removal"
												onChange={(e) => setRuleDraft({ ...ruleDraft, reasonEn: e.target.value })}
											/>
										</FieldRow>
										<div className="set-row">
											<label
												className="set-checkbox-label"
												style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
											>
												<input
													type="checkbox"
													checked={ruleDraft.enabled}
													onChange={(e) => setRuleDraft({ ...ruleDraft, enabled: e.target.checked })}
												/>
												{t("approvalRuleEnabled")}
											</label>
										</div>
										{ruleError && <div style={{ color: "var(--red, #ef4444)", fontSize: 12 }}>{ruleError}</div>}
										<div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
											<button
												type="button"
												className="btn"
												onClick={() => {
													setRuleDraft(null);
													setRuleError(null);
												}}
											>
												{t("cancel")}
											</button>
											<button
												type="button"
												className="btn btn-primary"
												onClick={() => {
													if (!ruleDraft.label.trim()) {
														setRuleError(t("approvalRuleLabelRequired"));
														return;
													}
													if (ruleDraft.match === "regex") {
														try {
															new RegExp(ruleDraft.value);
														} catch (err) {
															setRuleError(t("approvalRuleRegexInvalid", { msg: (err as Error).message }));
															return;
														}
													}
													appSend({ type: "save_approval_rule", rule: ruleDraft });
													setRuleDraft(null);
													setRuleError(null);
												}}
											>
												{t("save")}
											</button>
										</div>
									</div>
								)}

								{/* ---- 规则列表 ---------- */}
								{(settings.approvalRules ?? []).length === 0 ? (
									<p className="set-hint">{t("approvalRuleEmpty")}</p>
								) : (
									<div className="set-list set-list-flat">
										{(settings.approvalRules ?? []).map((rule, idx) => {
											const isBuiltin = rule.builtin === true;
											return (
												<div
													className={`set-row${rule.enabled ? "" : " rule-row-disabled"}`}
													key={rule.id}
													style={{ alignItems: "flex-start", padding: "12px 0" }}
												>
													<div className="set-row-info">
														<div
															className="set-row-name"
															style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}
														>
															<span className={`rule-badge ${rule.action}`}>
																{rule.action === "deny"
																	? t("approvalRuleActionDeny")
																	: rule.action === "allow"
																		? t("approvalRuleActionAllow")
																		: t("approvalRuleActionAsk")}
															</span>
															<strong style={{ fontSize: 13 }}>
																{isZhLocale(locale) ? rule.label : rule.labelEn || rule.label}
															</strong>
															{isBuiltin && <span className="tpl-badge">{t("approvalRuleBuiltin")}</span>}
															<span className="rule-meta-code">{rule.tools.join(", ")}</span>
														</div>
														<div
															className="set-hint"
															style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}
														>
															<div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
																<span style={{ opacity: 0.85, fontSize: 11, fontFamily: "var(--mono)" }}>
																	[{rule.field} · {rule.match}]
																</span>
																{rule.match !== "outside_workspace" && (
																	<code className="rule-pattern-code">{rule.value}</code>
																)}
															</div>
															{(rule.reason || rule.reasonEn) && (
																<div style={{ opacity: 0.75, fontSize: 11 }}>
																	{isZhLocale(locale) ? rule.reason : rule.reasonEn || rule.reason}
																</div>
															)}
														</div>
													</div>
													<div className="set-row-actions" style={{ marginLeft: 12, flexShrink: 0 }}>
														{/* 启用/停用开关 */}
														<button
															type="button"
															className={`set-switch${rule.enabled ? " on" : ""}`}
															role="switch"
															aria-checked={rule.enabled}
															title={rule.enabled ? t("settingsEnabled") : t("settingsDisabled")}
															onClick={() =>
																appSend({
																	type: "save_approval_rule",
																	rule: { ...rule, enabled: !rule.enabled },
																})
															}
														>
															<span className="set-switch-knob" />
														</button>
														{/* 排序上移下移（自定义规则） */}
														{!isBuiltin && idx > 0 && (
															<button
																type="button"
																className="set-icon-btn"
																title={t("approvalRuleMoveUp")}
																onClick={() => {
																	const list = [...(settings.approvalRules ?? [])];
																	const temp = list[idx - 1];
																	list[idx - 1] = list[idx];
																	list[idx] = temp;
																	appSend({ type: "save_approval_rules", rules: list });
																}}
															>
																<FiChevronUp />
															</button>
														)}
														{!isBuiltin && idx < (settings.approvalRules?.length ?? 0) - 1 && (
															<button
																type="button"
																className="set-icon-btn"
																title={t("approvalRuleMoveDown")}
																onClick={() => {
																	const list = [...(settings.approvalRules ?? [])];
																	const temp = list[idx + 1];
																	list[idx + 1] = list[idx];
																	list[idx] = temp;
																	appSend({ type: "save_approval_rules", rules: list });
																}}
															>
																<FiChevronDown />
															</button>
														)}
														{isBuiltin &&
															(confirmRuleReset === rule.id ? (
																<button
																	type="button"
																	className="set-uninstall confirm"
																	onClick={() => {
																		appSend({ type: "reset_builtin_approval_rule", id: rule.id });
																		setConfirmRuleReset(null);
																	}}
																>
																	{t("uninstallConfirm")}
																</button>
															) : (
																<button
																	type="button"
																	className="set-icon-btn"
																	title={t("approvalRuleReset")}
																	onClick={() => setConfirmRuleReset(rule.id)}
																>
																	<FiRefreshCw />
																</button>
															))}
														<button
															type="button"
															className="set-icon-btn"
															title={t("approvalRuleEdit")}
															onClick={() => {
																setRuleDraft({ ...rule });
																setRuleToolsText(rule.tools.join(", "));
																setRuleIsNew(false);
																setRuleError(null);
															}}
														>
															<FiEdit3 />
														</button>
														{!isBuiltin &&
															(confirmRuleDelete === rule.id ? (
																<button
																	type="button"
																	className="set-uninstall confirm"
																	onClick={() => {
																		appSend({ type: "delete_approval_rule", id: rule.id });
																		setConfirmRuleDelete(null);
																	}}
																>
																	{t("uninstallConfirm")}
																</button>
															) : (
																<button
																	type="button"
																	className="set-icon-btn danger"
																	title={t("approvalRuleDelete")}
																	onClick={() => setConfirmRuleDelete(rule.id)}
																>
																	<FiTrash2 />
																</button>
															))}
													</div>
												</div>
											);
										})}
									</div>
								)}
							</div>
						)}

						{/* ---- 逐工具文案编辑器（工具 tab 的「编辑文案」入口） ------------- */}
						{editingToolPrompt && (
							<ToolPromptEditor
								name={editingToolPrompt}
								override={toolPromptEdits[editingToolPrompt] ?? null}
								onApply={applyToolPromptOverride}
								onClose={() => setEditingToolPrompt(null)}
							/>
						)}
					</div>
				</div>

				<div className="modal-actions settings-modal-actions">
					<div className="settings-status-info">
						<span className="settings-status-dot" />
						<span className="settings-status-text">{t("settingsAutoSavedTip")}</span>
					</div>
					<div className="settings-action-btns">
						<button type="button" className="dd-refresh set-close-btn" onClick={handleClose}>
							{t("close")}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
