import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { TopBar } from "./components/TopBar";
import { LeftPanel } from "./components/LeftPanel";
import { MessageList } from "./components/MessageList";
import { ChatInput } from "./components/ChatInput";
import { GoalBar } from "./components/GoalBar";
import { LoopBar } from "./components/LoopBar";
import { TaskModal } from "./components/TaskModal";
import { ClusterModal } from "./components/ClusterControls";
import { TaskDesk } from "./components/TaskDesk";
import { RunDetailModal } from "./components/RunDetailModal";
import { SandboxModal } from "./components/SandboxModal";
import { WorktreeBanner } from "./components/WorktreeBanner";
import { FiRefreshCw, FiFeather } from "react-icons/fi";
import { useEscapeKey } from "./shortcut-stack";

import { FooterBar } from "./components/FooterBar";
import { formatSessionHash, parseSessionHash } from "./session-url";
import { SideDock } from "./components/SideDock";
import { Dialog } from "./components/Dialog";
import { DshQuestionDialog } from "./components/DshQuestionDialog";
import { presetText } from "./components/DshPresetBar";
// 终端视图懒加载：xterm.js 体积大且只在切到终端时才需要，拆出主包
const TerminalPanel = lazy(() => import("./components/TerminalPanel").then((m) => ({ default: m.TerminalPanel })));
import { buildUiSlots, HIDDEN_FROM_LAYOUT_ITEM_IDS, type UiDiagnostic, type UiSlotEntry } from "./ui-slots";
import { renderSlotToolbar } from "./slot-toolbar";
import { ContextMenu } from "./components/ContextMenu";
import { BannerContainer } from "./components/BannerContainer";
import { IconEditor } from "./components/IconEditor";
import { showBanner, dismissBanner, dismissBannersWhere } from "./banner-notice";
import {
	registerAttachmentSink,
	insertTextAtCursor,
	removeMentionFromComposer,
	focusComposer,
} from "./composer-bridge";
import { appendDraftAttachments } from "./composer-draft";
import { useComposerSessionReset } from "./use-composer-session";
import { splitQuotedPrompt } from "../../server/text-quote.js";
import { PiSetupModal } from "./components/PiSetupModal";
import { ModelConfigModal } from "./components/ModelConfigModal";

import { SettingsModal, type SettingsTab } from "./components/SettingsModal";
import { BgTasksModal } from "./components/BgTasksModal";
import { RollbackDialog } from "./components/RollbackDialog";
import { openRollbackDialog } from "./rollback-state";
import { ToolApprovalDialog } from "./components/ToolApprovalDialog";
import { TuiOverlayModal } from "./components/TuiOverlayModal";
// 工具定义说明弹窗（工具卡右键 → 「显示工具详细信息」）：状态在 tool-info-state.ts 的模块级 store 里，
// 这里只挂一份渲染（触发点在消息流里的每张工具卡）。
import { ToolInfoDialog } from "./components/ToolInfoDialog";
import { ToolInspectorModal } from "./components/ToolInspectorModal";
import { GlobalSearchModal } from "./components/GlobalSearchModal";
import { TemplateProvider } from "./components/PromptTemplates";
import { FilePreview, type PreviewFile } from "./components/FilePreview";
import { useChat } from "./use-chat";
import { useSwipeDrawer } from "./use-swipe-drawer";
import { appUrl } from "./base-url";
import type { ClientMessage, PromptAttachment, UiMessage } from "./types";
import { isZhLocale, useT, useI18n } from "./i18n";
import { QUICK_PHRASE_DEFAULTS } from "./quick-phrases";
import {
	FiAlertCircle,
	FiAlertTriangle,
	FiBookmark,
	FiCheck,
	FiChevronLeft,
	FiChevronRight,
	FiInfo,
	FiTrash2,
	FiUpload,
	FiX,
} from "react-icons/fi";
import { LuFlaskConical } from "react-icons/lu";
import type { Notice } from "./use-chat";
import { fileToProcessedImage, isRasterImage, type ProcessedImage } from "./image-paste";
import { randomUuid } from "./uuid";
import { recordModelUsage } from "./model-usage";
import { useWideChat, useHideModelRow } from "./chat-width-settings";
import { registerFilePreviewHost } from "./file-preview-bridge";
import { projectNameFromCwd, useProjectTitle } from "./title-settings";
import { notify } from "./notify";
import { diffStreamingCues } from "./streaming-cues";
import { getNoticeDurationMs } from "./notice-policy";
import { useTheme } from "./theme";
import { useWallpaperEffect } from "./wallpaper";

export interface PendingAttachment {
	path: string;
	name: string;
	/** "conversation" = 引用的另一个对话：path 不用，引用走 conversationId
	 *  （运行中，含子代理）或 sessionPath（历史转录），AI 经 conversation_read 读取。
	 *  "reference"/"lines" = 工作区路径引用（文件内容不进 prompt）。
	 *  "inline" = 旧版「全文注入」的遗留值（服务端按 reference 处理）；粘贴图片 /
	 *  上传文件没有 mode（path 为空，模式对它们无意义）。 */
	mode?: "inline" | "reference" | "lines" | "conversation" | "quote";
	quote?: import("./types").TextQuote;
	/** mode "conversation" + 引用运行中对话的 id（如 "c3"）。 */
	conversationId?: string;
	/** mode "conversation" + 引用历史会话的转录文件 path。 */
	sessionPath?: string;
	/** Folder path link (always reference mode). */
	isDir?: boolean;
	/** 1-based inclusive line range (mode "lines" only). */
	lines?: { start: number; end: number };
	/** Raw pasted/dropped/uploaded image (no workspace path — `path` is ""). */
	imageData?: string;
	mimeType?: string;
	/** Raw uploaded file bytes (no workspace path — `path` is ""). */
	fileData?: string;
	size?: number;
	/** Stable dedupe/removal key for pasted images. */
	key?: string;
}

/** A single notice toast. Auto-dismisses after a level-dependent delay (info 2.4s /
 *  warning 4.2s / error 6.5s); hovering pauses the timer, and clicking the toast
 *  body (when not selecting text) or the × button dismisses it immediately. */
function NoticeToast({ notice, onDismiss }: { notice: Notice; onDismiss: (id: number) => void }) {
	const t = useT();
	const { locale } = useI18n();
	const text = !isZhLocale(locale) && notice.textEn ? notice.textEn : notice.text;
	const [paused, setPaused] = useState(false);
	useEffect(() => {
		if (paused) return;
		const timer = setTimeout(() => onDismiss(notice.id), getNoticeDurationMs(notice.level));
		return () => clearTimeout(timer);
	}, [paused, notice.id, notice.level, onDismiss]);
	const Icon = notice.level === "error" ? FiAlertCircle : notice.level === "warning" ? FiAlertTriangle : FiInfo;
	return (
		<div
			className={`notice notice-${notice.level}${paused ? " paused" : ""}`}
			role="status"
			onMouseEnter={() => setPaused(true)}
			onMouseLeave={() => setPaused(false)}
			onClick={() => {
				if (window.getSelection?.()?.toString()) return;
				onDismiss(notice.id);
			}}
		>
			<Icon className="notice-icon" />
			<span className="notice-text">{text}</span>
			<button
				type="button"
				className="notice-close"
				title={t("close")}
				onClick={(e) => {
					e.stopPropagation();
					onDismiss(notice.id);
				}}
			>
				<FiX />
			</button>
		</div>
	);
}
/** Stable empty messages array — keeps the memoized ChatInput prop comparison
 *  cheap before the first snapshot arrives. */
const EMPTY_MESSAGES: UiMessage[] = [];

// ---- 可拖拽面板宽度（桌面端；≤768px 抽屉模式固定宽度不受影响）----
const PANEL_MIN = 180;
const PANEL_MAX = 520;
const PANEL_DEFAULT = 240;
type PanelSide = "left" | "right";
const panelWidthKey = (side: PanelSide) => `pi-web-ui:${side}-panel-width`;
function readPanelWidth(side: PanelSide): number {
	try {
		const v = Number(localStorage.getItem(panelWidthKey(side)));
		return Number.isFinite(v) && v >= PANEL_MIN && v <= PANEL_MAX ? v : PANEL_DEFAULT;
	} catch {
		// storage 不可用（隐私模式等）：回默认宽度。这两个读在 useState 初始化器里，
		// 抛错会让整个 App 首帧白屏 —— 与 use-chat.ts/theme.ts 的兜底风格一致。
		return PANEL_DEFAULT;
	}
}
const panelCollapsedKey = (side: PanelSide) => `pi-web-ui:${side}-panel-collapsed`;
function readPanelCollapsed(side: PanelSide): boolean {
	try {
		return localStorage.getItem(panelCollapsedKey(side)) === "1";
	} catch {
		return false;
	}
}

/** 面板与主区之间的拖拽分隔条：拖动改宽度，双击复位。 */
function ResizeHandle({ side, width, onResize }: { side: PanelSide; width: number; onResize: (w: number) => void }) {
	const t = useT();
	const onPointerDown = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			const startX = e.clientX;
			const startW = width;
			let last = startW;
			const move = (ev: PointerEvent) => {
				// 左侧手柄向右拖变宽，右侧相反
				const delta = side === "left" ? ev.clientX - startX : startX - ev.clientX;
				last = Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(startW + delta)));
				onResize(last);
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				document.body.classList.remove("panel-resizing");
				try {
					localStorage.setItem(panelWidthKey(side), String(last));
				} catch {
					/* storage 不可用：本次拖拽照常生效，只是不持久化 */
				}
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
			document.body.classList.add("panel-resizing");
		},
		[side, width, onResize],
	);
	return (
		<div
			className={`resize-handle resize-${side}`}
			title={t("dragToResize")}
			onPointerDown={onPointerDown}
			onDoubleClick={() => onResize(PANEL_DEFAULT)}
		/>
	);
}

/** 面板折叠后悬浮在边缘的展开按钮：贴在主区边缘，点击恢复面板。
 *  只在桌面端出现（移动端抽屉由顶栏按钮控制）。 */
function PanelRail({ side, onClick }: { side: PanelSide; onClick: () => void }) {
	const t = useT();
	return (
		<button type="button" className={`panel-rail panel-rail-${side}`} title={t("expandPanel")} onClick={onClick}>
			{side === "left" ? <FiChevronRight /> : <FiChevronLeft />}
		</button>
	);
}

/** 顶栏视图：对话 / 终端。 */
type ViewName = "chat" | "terminal";

export function App() {
	const t = useT();
	const { locale } = useI18n();
	const { chat, send, dismissNotice, pushNotice, terminal } = useChat();
	// 快捷短语 seeding：首次看到空列表 → 按界面语言填一批内置常用短语，之后即为用户
	// 数据（增删改/恢复默认/关闭都在设置里）。「已 seed」标记存服务端全局
	// （settings.quickPhrasesSeeded，非浏览器 localStorage）——clientId 在
	// sessionStorage、每次新会话都是新 id，若按浏览器记 seed，重启后删掉的默认
	// 短语又会被填回默认；存服务端则跨会话/跨浏览器一致。
	const quickSeedRef = useRef(false);
	useEffect(() => {
		if (!chat.ready || !chat.settings) return;
		if (quickSeedRef.current || chat.settings.quickPhrasesSeeded) return;
		quickSeedRef.current = true;
		if (chat.settings.quickPhrases.length === 0) {
			send({
				type: "set_settings",
				quickPhrases: QUICK_PHRASE_DEFAULTS[locale] ?? QUICK_PHRASE_DEFAULTS.en,
				quickPhrasesSeeded: true,
			});
		}
	}, [chat.ready, chat.settings, send, locale]);
	// 浏览器标题：开关开启时显示当前项目（工作目录文件夹名），否则固定应用名。
	const cwd = chat.state?.cwd ?? "";
	const projectTitle = useProjectTitle();
	useEffect(() => {
		const name = projectTitle ? projectNameFromCwd(cwd) : "";
		document.title = name ? `${name} — 训推引擎组 Harness` : t("docTitle");
	}, [cwd, projectTitle, t]);
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	// 宿主注入的待发附件（composeToComposer：对话引用等）：
	// 只追加不覆盖，判重口径与下面的 attach() 一致（见 composer-draft.ts）。
	useEffect(() => {
		registerAttachmentSink((items) => setAttachments((prev) => appendDraftAttachments(prev, items)));
		return () => registerAttachmentSink(null);
	}, []);
	const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
	// 文件预览桥（present_files 卡片 → 预览弹窗）：弹窗的开关状态在本组件，
	// 而调用方在消息流最深处的工具卡片，中间隔好几层。同 composer-bridge 的做法，
	// 只走一个模块级 sink；ref 给 isOpen 用，避免 effect 依赖 previewFile 而反复重注册。
	const previewOpenRef = useRef(false);
	useEffect(() => {
		previewOpenRef.current = previewFile !== null;
	}, [previewFile]);
	const openFile = useCallback((path: string, name: string) => {
		setPreviewFile({ path, name });
	}, []);
	useEffect(() => {
		registerFilePreviewHost({
			open: (f) => openFile(f.path, f.name),
			isOpen: () => previewOpenRef.current,
		});
		return () => registerFilePreviewHost(null);
	}, [openFile]);
	/** Full-window file drag in progress (issue #19) — shows the app-wide
	 *  drop overlay; drop anywhere attaches, the input bar keeps priority via
	 *  its own stopPropagation handlers. */
	const [appDragOver, setAppDragOver] = useState(false);
	// 嵌套落点（输入条 / 消息编辑器）的 onDrop 会 stopPropagation（保优先级），
	// 父级 onDrop 就收不到 → 全屏遮罩会一直挂着。在 window 捕获阶段兜底复位：
	// 捕获先于任何子 handler 执行，只清提示、不碰落点处理。
	useEffect(() => {
		const clear = () => setAppDragOver(false);
		window.addEventListener("drop", clear, true);
		return () => window.removeEventListener("drop", clear, true);
	}, []);
	const [viewChosen, setView] = useState<ViewName>("chat");
	/* PI_WEB_TABS: a tab this instance does not offer cannot be shown, even if
	   something else asks for it — a panel's "open this in a terminal" button.
	   The server refuses those messages anyway, so the pane would sit there
	   empty. No list means every tab, which is the default. */
	const tabOn = (tab: string) => !chat.tabs || tab === "chat" || chat.tabs.includes(tab);
	const view: ViewName = tabOn(viewChosen) ? viewChosen : "chat";
	// 宿主 UI 扩展点全量计算（issue #146）：内置条目 + 用户偏好（最高优先级）→ 每个 slot 的
	// 最终条目。渲染层只负责摆位置；顺序与设置面板里看到的一致。
	const [uiSlots, uiDiagnostics] = useMemo(() => {
		// 合并诊断（P0-1：失败不许静默）：被纠正的偏好 / 槽位冲突 → 带归因的 diagnostics，
		// 设置面板「界面布局」页展示给用户，控制台按级别分流输出（避免无意义的黄色警告与重复刷屏）。
		const diagnostics: UiDiagnostic[] = [];
		const slots = buildUiSlots({
			// Translate 的 key 是字面量联合类型，ui-slots 收的是 (key: string) => string
			t: (key: string) => t(key as Parameters<typeof t>[0]),
			layout: chat.settings?.uiLayout,
			diagnostics,
		});
		return [slots, diagnostics] as const;
	}, [chat.settings?.uiLayout, t]);

	const lastUiDiagFingerprintRef = useRef("");
	useEffect(() => {
		const fp = uiDiagnostics.map((d) => `${d.level}:${d.entryId ?? ""}:${d.message}`).join("\n");
		if (fp === lastUiDiagFingerprintRef.current) return;
		lastUiDiagFingerprintRef.current = fp;
		for (const d of uiDiagnostics) {
			const prefix = "[ui-slot] ";
			if (d.level === "error") {
				console.error(`${prefix}${d.message}`);
			} else if (d.level === "warn") {
				console.warn(`${prefix}${d.message}`);
			} else {
				console.debug(`${prefix}${d.message}`);
			}
		}
	}, [uiDiagnostics]);
	// 顶栏：主栏 = 非 hidden 的 topbar.primary；溢出 = hidden 的 primary + topbar.overflow。
	// 这样被隐藏的条目仍在溢出菜单/布局页里找得回来（锁不死用户）。
	const uiPrimary = useMemo(() => uiSlots["topbar.primary"].filter((e) => !e.hidden), [uiSlots]);
	const uiOverflow = useMemo(
		() => [...uiSlots["topbar.primary"].filter((e) => e.hidden), ...uiSlots["topbar.overflow"]],
		[uiSlots],
	);
	// 面板槽位（收尾接线）：非 hidden 条目直传面板，空数组时面板返回 null，DOM 与旧版一致。
	const uiLeftSessions = useMemo(() => uiSlots["leftpanel.sessions"].filter((e) => !e.hidden), [uiSlots]);
	// 左栏 P1 挂载点（项目 / 运行 / 历史三个分区标题栏 + 项目行）：hidden 滤掉，无条目时 LeftPanel 不画。
	const uiLeftProjectsActions = useMemo(
		() => uiSlots["leftpanel.projects.actions"].filter((e) => !e.hidden),
		[uiSlots],
	);
	const uiLeftProject = useMemo(() => uiSlots["leftpanel.project"].filter((e) => !e.hidden), [uiSlots]);
	const uiLeftRunningActions = useMemo(() => uiSlots["leftpanel.running.actions"].filter((e) => !e.hidden), [uiSlots]);
	const uiLeftHistoryActions = useMemo(() => uiSlots["leftpanel.history.actions"].filter((e) => !e.hidden), [uiSlots]);
	// P2：分区本身不滤 hidden（隐藏也要在布局页里找得回来），由 LeftPanel 按 hidden 计划。
	const uiLeftSections = uiSlots["leftpanel.sections"];
	const uiLeftRunning = useMemo(() => uiSlots["leftpanel.running"].filter((e) => !e.hidden), [uiSlots]);
	const uiLeftHistory = useMemo(() => uiSlots["leftpanel.history"].filter((e) => !e.hidden), [uiSlots]);
	const uiTerminalToolbar = useMemo(() => uiSlots["terminal.toolbar"].filter((e) => !e.hidden), [uiSlots]);
	const uiGoalbarActions = useMemo(() => uiSlots["goalbar.actions"].filter((e) => !e.hidden), [uiSlots]);
	// P0 幽灵槽位接线：无宿主内置条目，无条目时各渲染层返回 null，DOM 与旧版一致。
	const uiChatHeader = useMemo(() => uiSlots["chat.header"].filter((e) => !e.hidden), [uiSlots]);
	const uiChatEmpty = useMemo(() => uiSlots["chat.empty"].filter((e) => !e.hidden), [uiSlots]);
	const uiFilePreviewToolbar = useMemo(() => uiSlots["file.preview.toolbar"].filter((e) => !e.hidden), [uiSlots]);
	// 预设名录 id→显示名（左栏徽标；dshPresets 对象不变时引用稳定，不破坏 LeftPanel memo）。
	// 徽标文案随界面语言定（内置五档走 i18n，其余取服务端 nameEn ?? name）——locale 进
	// 依赖：切语言要重算，否则徽标留着上一种语言的文案。
	const presetNames = useMemo(
		() => Object.fromEntries((chat.dshPresets?.presets ?? []).map((p) => [p.id, presetText(p, locale, t).name])),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[chat.dshPresets, locale],
	);
	const uiNoticeActions = useMemo(() => uiSlots["notice.actions"].filter((e) => !e.hidden), [uiSlots]);
	const uiSidebarLeft = useMemo(() => uiSlots["sidebar.left"] ?? [], [uiSlots]);
	const uiSidebarRight = useMemo(() => uiSlots["sidebar.right"] ?? [], [uiSlots]);
	/** 点一个槽位条目：消息右键菜单的分叉 / 回滚，与 kind="view" 的视图切换由宿主处理；
	 *  其余宿主条目由各自的渲染层就地实现，不经过这里。 */
	const onUiAction = useCallback(
		(item: UiSlotEntry, _value?: string, target?: { id: string; kind?: string; label?: string }) => {
			if (item.id === "host:msg-fork") {
				if (target?.id) {
					send({ type: "fork_session", messageId: target.id, position: "before" });
				}
				return;
			}
			if (item.id === "host:msg-rollback") {
				if (target?.id) {
					openRollbackDialog({ messageId: target.id });
				}
				return;
			}
			// kind="view"：宿主自己切视图。
			if (item.kind === "view" && (item.view === "chat" || item.view === "terminal")) {
				setView(item.view);
			}
		},
		[send],
	);
	// 左栏可拖拽宽度（桌面端）：localStorage 持久化，双击手柄复位。
	const [leftWidth, setLeftWidth] = useState(() => readPanelWidth("left"));
	const resizeLeft = useCallback((w: number) => setLeftWidth(w), []);
	// 左栏折叠状态（桌面端）：localStorage 持久化，点击面板内收起按钮折叠，
	// 靠边缘的展开条恢复；移动端抽屉不受影响（始终由顶栏按钮开关）。
	const [leftCollapsed, setLeftCollapsed] = useState(() => readPanelCollapsed("left"));
	const toggleLeft = useCallback(() => {
		setLeftCollapsed((v) => {
			try {
				localStorage.setItem(panelCollapsedKey("left"), v ? "0" : "1");
			} catch {
				/* storage 不可用（隐私模式等）：折叠照常，只是不持久化 */
			}
			return !v;
		});
	}, []);
	// Mobile: which side panel is open as a drawer (null = both closed).
	const [drawer, setDrawer] = useState<"left" | "right" | null>(null);
	// 抽屉手势的监听容器（移动端 `.layout` 整屏）。
	const layoutRef = useRef<HTMLDivElement | null>(null);
	// Viewport class: ≤768px turns the side panels into sliding drawers
	// (matches the CSS breakpoint) — used to lazy-load panel data only when
	// a drawer is actually open on mobile.
	const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 768px)").matches);
	useEffect(() => {
		const mq = window.matchMedia("(max-width: 768px)");
		const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);
	// 手机端侧栏手势：从左右边缘往里横滑 = 拉出该侧列表，列表开着时往外横滑 = 收回去。
	// 只在 chat 视图挂（左右面板就长在这个 view-pane 里；终端视图的抽屉是另一套）。
	// 判定纯函数见 `swipe-drawer.ts`，DOM 粘合见 `use-swipe-drawer.ts`。
	useSwipeDrawer({
		enabled: isMobile && view === "chat",
		open: drawer,
		onOpenChange: setDrawer,
		container: layoutRef,
		// 必须点名 `.persistent`：终端视图的抽屉也用 `.drawer-backdrop`（常驻但 display:none
		// 的 pane 里照样能被 querySelector 查到），不加限定会去改那道看不见的遮罩。
		backdropSelector: ".drawer-backdrop.persistent",
	});
	// Setup modal: one-time prompt when the pi agent config is missing.
	const [setupDismissed, setSetupDismissed] = useState(() => {
		try {
			return localStorage.getItem("pi_web_setup_dismissed") === "1";
		} catch {
			return false;
		}
	});
	const dismissSetup = () => {
		setSetupDismissed(true);
		try {
			localStorage.setItem("pi_web_setup_dismissed", "1");
		} catch {
			/* ignore */
		}
	};
	// Custom model config panel (model dropdown → 管理模型).
	const [manageModelsOpen, setManageModelsOpen] = useState(false);
	// Settings panel (skills / tools / layout …).
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsTab | undefined>();
	const [sandboxModalMode, setSandboxModalMode] = useState<"create" | "promote" | "apply" | null>(null);
	// Wide chat column (client-local, default off).
	const wide = useWideChat();
	const hideModelRow = useHideModelRow();
	const isMinimalEmpty =
		!!chat.settings?.minimalNewChat && (chat.state?.messages?.length ?? 0) === 0 && !chat.state?.streamingMessage;
	// Background-task panel (AI-started servers — stop individually or all).
	const [bgTasksOpen, setBgTasksOpen] = useState(false);
	// Global search panel (sessions / projects / workspace files).
	const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
	// 图标编辑模式（顶栏「⋯」→ 编辑图标）：直接拖图标改四个栏的位置。
	const [iconEditOpen, setIconEditOpen] = useState(false);
	/** 全局搜索「会话」结果点击后的跳转目标：切到该会话并定位到命中消息。
	 *  由 MessageList 消费（消息载入即跳转+高亮），跳完后置空。 */
	const [searchJump, setSearchJump] = useState<{
		path: string;
		role: string;
		timestamp: number;
	} | null>(null);
	// 兜底：跳转请求应在下次快照载入时即被 MessageList 消费；超过 15s 未消费
	//（用户中途切走会话等）则清空，避免陈旧目标挂起、日后误触发。
	useEffect(() => {
		if (!searchJump) return;
		const t = setTimeout(() => setSearchJump(null), 15_000);
		return () => clearTimeout(t);
	}, [searchJump]);

	// ---- 会话与消息 URL 深链（#s=<sessionId>&m=<messageId>，issue #587）----
	const [urlJump, setUrlJump] = useState<{ sessionId: string; messageId: string } | null>(null);
	const pendingHashSessionRef = useRef<string | null>(null);
	const awaitingHashSessionRef = useRef<string | null>(null);
	const activeSessionId = chat.state?.sessionId ?? "";
	const activeSessionIdRef = useRef(activeSessionId);
	activeSessionIdRef.current = activeSessionId;
	const readyRef = useRef(chat.ready);
	readyRef.current = chat.ready;

	useEffect(() => {
		const applyFromLocation = () => {
			const parsed = parseSessionHash(window.location.hash);
			if (!parsed) return;
			if (parsed.messageId) {
				setUrlJump({ sessionId: parsed.sessionId, messageId: parsed.messageId });
			} else {
				setUrlJump(null);
			}
			if (!readyRef.current || !activeSessionIdRef.current) {
				pendingHashSessionRef.current = parsed.sessionId;
				return;
			}
			if (activeSessionIdRef.current !== parsed.sessionId) {
				awaitingHashSessionRef.current = parsed.sessionId;
				setView("chat");
				send({ type: "switch_session", path: "", sessionId: parsed.sessionId });
			}
		};
		applyFromLocation();
		window.addEventListener("hashchange", applyFromLocation);
		window.addEventListener("popstate", applyFromLocation);
		return () => {
			window.removeEventListener("hashchange", applyFromLocation);
			window.removeEventListener("popstate", applyFromLocation);
		};
	}, [send]);

	// 当请求的目标会话不存在（服务端返回 warning notice）或超时时，解除 awaiting 状态并回退到当前会话 URL。
	useEffect(() => {
		const awaiting = awaitingHashSessionRef.current;
		if (!awaiting) return;
		const notFound = chat.notices.some(
			(n) => n.text.includes(awaiting) && (n.text.includes("未找到会话") || n.text.includes("Session not found")),
		);
		if (notFound) {
			awaitingHashSessionRef.current = null;
			setUrlJump(null);
			if (activeSessionId) {
				const nextHash = formatSessionHash({ sessionId: activeSessionId });
				if (window.location.hash !== nextHash) {
					window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
				}
			}
		}
	}, [chat.notices, activeSessionId]);

	// 首载连接就绪后：若 URL hash 指定了目标会话则切过去；否则保持地址栏 hash 跟随当前活跃会话。
	useEffect(() => {
		if (!chat.ready || !activeSessionId) return;
		if (pendingHashSessionRef.current) {
			const wantSid = pendingHashSessionRef.current;
			pendingHashSessionRef.current = null;
			if (wantSid !== activeSessionId) {
				awaitingHashSessionRef.current = wantSid;
				setView("chat");
				send({ type: "switch_session", path: "", sessionId: wantSid });
				return;
			}
		}
		if (awaitingHashSessionRef.current) {
			if (activeSessionId === awaitingHashSessionRef.current) {
				awaitingHashSessionRef.current = null;
			} else {
				return;
			}
		}
		const currentParsed = parseSessionHash(window.location.hash);
		const keepMsgId = currentParsed?.sessionId === activeSessionId ? currentParsed.messageId : undefined;
		const nextHash = formatSessionHash({
			sessionId: activeSessionId,
			...(keepMsgId ? { messageId: keepMsgId } : {}),
		});
		if (window.location.hash !== nextHash) {
			window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
		}
	}, [chat.ready, activeSessionId, send]);

	useEffect(() => {
		// 派单卡片的「查看子代理」按钮：切到对应的子代理对话（与左栏点击同效果）。
		const onSwitchConversation = (e: Event) => {
			const id = (e as CustomEvent<string>).detail;
			if (typeof id === "string" && id) {
				setView((prev) => (prev !== "chat" ? "chat" : prev));
				send({ type: "switch_conversation", id });
				focusComposer();
			}
		};
		window.addEventListener("pi-web-ui:switch-conversation", onSwitchConversation);
		return () => {
			window.removeEventListener("pi-web-ui:switch-conversation", onSwitchConversation);
		};
	}, [send]);

	// Ctrl+K / Cmd+K opens global search (also reachable via the topbar button).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
			e.preventDefault();
			setGlobalSearchOpen((v) => !v);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// -- zen mode (focus mode) ------------------------------------------------
	const [zenMode, setZenMode] = useState<boolean>(() => {
		try {
			return localStorage.getItem("pi_zen_mode") === "1";
		} catch {
			return false;
		}
	});

	useEffect(() => {
		try {
			if (zenMode) {
				localStorage.setItem("pi_zen_mode", "1");
			} else {
				localStorage.removeItem("pi_zen_mode");
			}
		} catch {
			/* ignore */
		}
	}, [zenMode]);

	const toggleZenMode = useCallback(() => {
		setZenMode((prev) => {
			const next = !prev;
			if (next && view !== "chat") {
				setView("chat");
			}
			return next;
		});
	}, [view]);

	useEscapeKey(() => {
		if (zenMode) {
			setZenMode(false);
			return true;
		}
		return false;
	}, zenMode);

	// Alt+Z / Ctrl+Shift+F / Cmd+Shift+F toggles focus / zen mode
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const isAltZ = e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "z";
			const isCtrlShiftF = (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f";
			if (isAltZ || isCtrlShiftF) {
				e.preventDefault();
				toggleZenMode();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [toggleZenMode]);

	// -- theme (whole stylesheet swap) ---------------------------------------
	const { themes, theme, switchTheme, reloadThemes } = useTheme();
	// -- chat wallpaper (message-list background image, issue #100) -------------
	useWallpaperEffect();
	const prevStreamingMapRef = useRef<Map<string, boolean> | null>(null);
	const prevActiveIdRef = useRef<string | null>(null);
	const latestMessagesRef = useRef(chat.state?.messages);
	latestMessagesRef.current = chat.state?.messages;
	const notifiedDialogIds = useRef<Set<number>>(new Set());
	const notifiedQuestionIds = useRef<Set<string>>(new Set());
	const notifiedApprovalIds = useRef<Set<string>>(new Set());
	const lastErrorNotice = useRef(0);
	// Remembers a terminal-view click made before the WebSocket is ready.
	const terminalOpenRequested = useRef(false);
	// Previous terminal list — drives the uninstall-finished watcher below.
	const prevTerminalsRef = useRef(chat.terminals);

	// Maintenance watcher: when a `pi remove …` / `npm i -g …` command tab
	// transitions running → exited, re-discover extensions/skills (extensions_reload).
	useEffect(() => {
		const prev = prevTerminalsRef.current;
		prevTerminalsRef.current = chat.terminals;
		for (const tm of chat.terminals) {
			const cmd = tm.command?.command ?? "";
			const before = prev.find((p) => p.id === tm.id);
			if (!before?.running || tm.running) continue;
			if (cmd.startsWith("pi remove ")) {
				send({ type: "extensions_reload" });
			} else if (cmd.startsWith("npm i -g ")) {
				// A component update ran in the visible terminal (per-row "更新"
				// or "全部更新" buttons): re-discover extensions and re-check
				// versions so the dropdown reflects the new state.
				send({ type: "extensions_reload" });
				send({ type: "check_updates_all", force: true });
			}
		}
	}, [chat.terminals, send]);

	// Run start / end cues (streaming edge transitions).
	// 按会话 id 独立跟踪状态跳变，彻底杜绝切换对话时将其他会话的状态误判为本会话的 start/done，
	// 并在后台对话完成时及时提示（issue：切换对话误报完成、后台对话延迟到切换才提醒）。
	useEffect(() => {
		const activeId = chat.state?.conversationId ?? null;
		const cues = diffStreamingCues(
			prevStreamingMapRef.current,
			activeId,
			chat.state?.isStreaming ?? false,
			chat.conversations,
			prevActiveIdRef.current,
		);
		prevStreamingMapRef.current = cues.nextMap;
		prevActiveIdRef.current = activeId;

		if (cues.finishedConvs.length > 0) {
			const activeFinished = cues.finishedConvs.find((c) => c.isActive);
			if (activeFinished) {
				// 前台活动对话完成
				void notify(t("notifyDoneTitle"), t("notifyDoneBody"));
			}
			// 后台对话完成（可能与其他会话同批）：逐条弹通知带标题。
			for (const bg of cues.finishedConvs.filter((c) => !c.isActive)) {
				const body = bg.title ? `${bg.title}：${t("notifyDoneBody")}` : t("notifyDoneBody");
				void notify(t("notifyDoneTitle"), body);
			}
		}
	}, [chat.state?.conversationId, chat.state?.isStreaming, chat.conversations, t]);

	// Questionnaire cue — each new dialog id + each new DSH question id.
	// dialog = 扩展 select/confirm/input；question = ask_user_question 问卷。
	// 按 ID 集合去重，彻底避免在不同对话间切换时重复响铃和弹通知。
	useEffect(() => {
		const id = chat.dialog?.id ?? null;
		if (id !== null && !notifiedDialogIds.current.has(id)) {
			notifiedDialogIds.current.add(id);
			if (notifiedDialogIds.current.size > 64) {
				const oldest = notifiedDialogIds.current.values().next().value;
				if (oldest !== undefined) notifiedDialogIds.current.delete(oldest);
			}
			void notify(t("notifyQuestionTitle"), t("notifyQuestionBody"));
		}
	}, [chat.dialog, t]);

	useEffect(() => {
		const qid = chat.question?.id ?? null;
		const rid = chat.remoteQuestion ? `${chat.remoteQuestion.owner}:${chat.remoteQuestion.id}` : null;
		let shouldCue = false;

		if (qid !== null && !notifiedQuestionIds.current.has(qid)) {
			notifiedQuestionIds.current.add(qid);
			shouldCue = true;
		}
		if (rid !== null && !notifiedQuestionIds.current.has(rid)) {
			notifiedQuestionIds.current.add(rid);
			shouldCue = true;
		}

		// 后台会话的问卷：弹窗不跨会话打扰，但提示音与系统通知照旧（避免只剩静默角标）。
		// 遇到新的后台问卷时，将其 ID 记入已提醒 Set，防止用户切入该会话时二次响铃。
		for (const c of chat.conversations) {
			if (!c.hasQuestion) continue;
			const qKey = c.questionId ? `q:${c.questionId}` : `conv-q:${c.id}`;
			if (!notifiedQuestionIds.current.has(qKey)) {
				notifiedQuestionIds.current.add(qKey);
				if (c.questionId) notifiedQuestionIds.current.add(c.questionId);
				if (qid !== c.questionId) {
					shouldCue = true;
				}
			}
		}

		if (notifiedQuestionIds.current.size > 64) {
			const oldest = notifiedQuestionIds.current.values().next().value;
			if (oldest !== undefined) notifiedQuestionIds.current.delete(oldest);
		}

		if (shouldCue) {
			void notify(t("notifyQuestionTitle"), t("notifyQuestionBody"));
		}
	}, [chat.question, chat.remoteQuestion, chat.conversations, t]);

	// Tool-approval cue (issue #288)：高危操作等待用户批准 —— 此前是唯一静默的
	// 拦截事件（done/question/error 都有提示音 + 桌面通知，唯独审批没有），AI 会
	// 在后台干等。补齐同款三通道：提示音 + 桌面通知 + TTS 播报。
	// 按 ID 集合去重，切换会话核对代码后再切回时绝不重复响铃。
	useEffect(() => {
		const approval = chat.approval;
		const id = approval?.id ?? null;
		if (id !== null && !notifiedApprovalIds.current.has(id)) {
			notifiedApprovalIds.current.add(id);
			if (notifiedApprovalIds.current.size > 64) {
				const oldest = notifiedApprovalIds.current.values().next().value;
				if (oldest !== undefined) notifiedApprovalIds.current.delete(oldest);
			}
			const tool = typeof approval?.toolName === "string" ? approval.toolName : "";
			void notify(t("notifyApprovalTitle"), tool ? t("notifyApprovalBodyTool", { tool }) : t("notifyApprovalBody"));
		}
	}, [chat.approval, t]);

	// Error cue — new error notices only.
	useEffect(() => {
		const err = [...chat.notices].reverse().find((n) => n.level === "error");
		if (err && err.id !== lastErrorNotice.current) {
			lastErrorNotice.current = err.id;
			void notify(t("notifyErrorTitle"), t("notifyErrorBody"));
		}
	}, [chat.notices, t]);
	// live-preview 工具的自动开页：工具结果末尾的确定性链接行即标记（渲染出来本身
	// 也是可点兜底）。消息 id 去重（重连重放不二次开）；多标签页只让当前聚焦的开，
	// 没焦点/弹窗被拦时推一条带地址的 notice（聊天里的链接照样可点）。
	const openedPreviewIds = useRef<Set<string>>(new Set());
	useEffect(() => {
		const msgs = chat.state?.messages ?? [];
		for (const m of msgs) {
			if (m.toolName !== "live_preview" || openedPreviewIds.current.has(m.id)) continue;
			openedPreviewIds.current.add(m.id);
			let url = "";
			for (const b of m.content ?? []) {
				if ((b as { type?: string }).type !== "text") continue;
				// (\/(?!\/) 拒绝 // 开头：协议相对 URL（//evil.com/x）会被浏览器按当前
				// 协议解析成站外地址，根部署下 appUrl 又原样返回，挡不住跳站外。
				const hit = /🔗 已自动在浏览器打开\]\((\/(?!\/)[^)\s]+)\)/.exec((b as { text?: string }).text ?? "");
				if (hit?.[1]) {
					url = hit[1];
					break;
				}
			}
			if (!url) continue;
			let opened: Window | null = null;
			try {
				// 打开前再校验最终 URL 与应用同源（第二道闸）：不同源一律不自动开，
				// 只推带地址的 notice —— 聊天里的链接照样可点，用户自己决定去不去。
				const finalUrl = new URL(appUrl(url), window.location.href);
				if (finalUrl.origin === window.location.origin && document.hasFocus()) {
					opened = window.open(finalUrl.href, "_blank", "noopener");
				}
			} catch {
				opened = null;
			}
			if (!opened) pushNotice("info", url);
		}
	}, [chat.state?.messages, pushNotice]);

	const attach = (
		path: string,
		name: string,
		mode: "inline" | "reference" | "lines",
		isDir = false,
		lines?: { start: number; end: number },
		silent = false,
	) => {
		// Dedupe on path + mode + line range so the same file can be attached
		// multiple ways (e.g. full content AND a line range) without doubling.
		const key = `${path}|${mode}|${lines ? `${lines.start}-${lines.end}` : ""}`;
		setAttachments((prev) =>
			prev.some((a) => `${a.path}|${a.mode}|${a.lines ? `${a.lines.start}-${a.lines.end}` : ""}` === key)
				? prev
				: [...prev, { path, name, mode, isDir, ...(lines ? { lines } : {}) }],
		);
		// 联动在输入框光标处插入 @提及（文件/目录/页签等所有带名引用统一行为）。
		// silent（@ 选单 acceptAt）：正文已由 ChatInput 亲自插好，这里不再插；
		// 重复点同一文件：ChatInput 的 insert sink 会判正文已有该 @提及而跳过。
		// 文件/目录类引用正文写相对路径而非 basename：同名条目（根目录 报告/ 与
		// 方案/报告/）靠路径才能区分，linkify 也按相对路径渲染文件药丸。
		const mention = path;
		if (!silent && mention) {
			insertTextAtCursor(`@${mention} `);
		}
	};
	const removeAttachment = (pathOrKey: string) => {
		let removedName = "";
		setAttachments((prev) =>
			prev.filter((a) => {
				const isHit = a.key
					? a.key === pathOrKey
					: a.mode === "conversation"
						? `conv|${a.conversationId ?? ""}|${a.sessionPath ?? ""}` === pathOrKey
						: a.path === pathOrKey;
				// 移除口径与 attach 插入一致：文件类提及正文是相对路径，conversation 是标题。
				if (isHit && !removedName) removedName = a.mode === "conversation" ? a.name : a.path;
				return !isHit;
			}),
		);
		if (removedName) {
			removeMentionFromComposer(`@${removedName}`);
		}
	};

	// Side panels live in mobile drawers — any action inside them (session
	// switch, cwd change, file list…) should close the drawer. Stable wrapper
	// so RightPanel's polling effect doesn't churn (send is stable).
	const panelSend = useCallback(
		(msg: ClientMessage) => {
			// Only close the mobile drawer on an explicit navigation/action. Mounting
			// LeftPanel fires read-only list_* probes that must NOT collapse the
			// freshly-opened drawer (they run through panelSend too). Otherwise the
			// drawer opens and immediately snaps shut.
			if (!msg.type.startsWith("list_") && !msg.type.startsWith("get_")) {
				setDrawer(null);
			}
			if (msg.type === "new_chat" || msg.type === "switch_conversation" || msg.type === "switch_session") {
				setView((prev) => (prev !== "chat" ? "chat" : prev));
				focusComposer();
			}
			return send(msg);
		},
		[send],
	);

	// 后台会话问卷的右上角常驻横幅通知：展示 对话名字 + 问卷名字，点击切换到对应会话，对应横幅消失，其他对话横幅不变。
	const dismissedQuestionIdsRef = useRef<Set<string>>(new Set());
	const activeConvId = chat.activeConversationId || chat.state?.conversationId || "";

	useEffect(() => {
		const convsWithQuestion = chat.conversations.filter((c) => c.hasQuestion);
		const currentQuestionConvIds = new Set(convsWithQuestion.map((c) => c.id));
		const currentQuestionIds = new Set(convsWithQuestion.map((c) => c.questionId).filter(Boolean) as string[]);

		// 清理已解决问卷的 dismissed 标记（同会话未来新问卷可再次弹出）
		for (const qid of dismissedQuestionIdsRef.current) {
			if (!currentQuestionIds.has(qid)) {
				dismissedQuestionIdsRef.current.delete(qid);
			}
		}

		// 后台会话的问卷弹常驻横幅
		for (const c of convsWithQuestion) {
			const bannerId = `question-${c.id}`;
			// 当前激活的会话不显示后台横幅（它由中央模态对话框处理）
			if (c.id === activeConvId) {
				dismissBanner(bannerId, { silent: true });
				continue;
			}
			// 已被用户主动关闭的该次问卷不再重复弹出
			if (c.questionId && dismissedQuestionIdsRef.current.has(c.questionId)) {
				continue;
			}
			showBanner({
				id: bannerId,
				type: "question",
				title: c.title || t("chat"),
				message: c.questionTitle || t("waitingQuestionBadge"),
				persistent: true,
				dismissible: true,
				data: { conversationId: c.id, questionId: c.questionId },
				onClose: () => {
					if (c.questionId) dismissedQuestionIdsRef.current.add(c.questionId);
				},
				onClick: () => {
					panelSend({ type: "switch_conversation", id: c.id });
					dismissBanner(bannerId, { silent: true });
				},
			});
		}

		// 会话已无问卷或已被移除时，自动收起对应横幅
		dismissBannersWhere(
			(b) => {
				const convId = b.data?.conversationId as string | undefined;
				if (!convId) return false;
				return !currentQuestionConvIds.has(convId) || convId === activeConvId;
			},
			{ silent: true },
		);
	}, [chat.conversations, activeConvId, panelSend, t]);

	// -- pasted / dropped / uploaded images (no workspace path) ---------------
	const pasteImageId = useRef(0);
	const lastVisionWarn = useRef(0);
	// 以下四个函数都要作为 props 传给 memo 化的 ChatInput：流式重渲染期间引用必须
	// 稳定，否则 shallow 比较失效、输入框整棵重渲染。之前用 useCallback(fn, [fn])
	// 包普通函数 —— 依赖每次渲染都是新的，包装形同虚设；这里改成依赖正确的
	// useCallback（deps 里的 chat.state?.model 是服务端跨快照复用的稳定引用）。
	const attachImage = useCallback(
		(img: ProcessedImage) => {
			// Warn when the current model can't see images — the image would still
			// be attached but silently ignored by the provider. Throttled so adding
			// several images at once produces one notice, not a stack.
			const now = Date.now();
			if (chat.state?.model && !chat.state.model.vision) {
				if (now - lastVisionWarn.current > 10000) {
					lastVisionWarn.current = now;
					pushNotice("warning", t("imageNotSupported"));
				}
			}
			const key = `paste-${++pasteImageId.current}`;
			setAttachments((prev) => [
				...prev,
				{
					path: "",
					key,
					name: img.name,
					imageData: img.data,
					mimeType: img.mimeType,
				},
			]);
		},
		[chat.state?.model, pushNotice, t],
	);
	const addImageFiles = useCallback(
		async (files: File[]) => {
			for (const f of files) {
				const img = await fileToProcessedImage(f);
				if (!img) {
					pushNotice("error", t("imageLoadFailed", { name: f.name }));
					continue;
				}
				attachImage(img);
			}
		},
		[attachImage, pushNotice, t],
	);

	// -- dropped / uploaded files (any type, no workspace path) ---------------
	/** Keep in sync with MAX_UPLOAD_BYTES in agent-service.ts. */
	const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
	const uploadId = useRef(0);
	const attachLocalFile = useCallback(
		async (f: File) => {
			if (f.size > MAX_UPLOAD_BYTES) {
				pushNotice("warning", t("fileTooLarge", { name: f.name, size: MAX_UPLOAD_BYTES / 1024 / 1024 }));
				return;
			}
			let base64: string;
			try {
				const dataUrl = await new Promise<string>((res, rej) => {
					const r = new FileReader();
					r.onload = () => res(r.result as string);
					r.onerror = () => rej(r.error ?? new Error("read failed"));
					r.readAsDataURL(f);
				});
				base64 = dataUrl.replace(/^data:[^;]*;base64,/, "");
			} catch {
				pushNotice("error", t("fileLoadFailed", { name: f.name }));
				return;
			}
			const key = `upload-${++uploadId.current}`;
			setAttachments((prev) => [
				...prev,
				{
					path: "",
					key,
					name: f.name,
					fileData: base64,
					size: f.size,
					mimeType: f.type || undefined,
				},
			]);
		},
		[MAX_UPLOAD_BYTES, pushNotice, t],
	);
	const addLocalFiles = useCallback(
		async (files: File[]) => {
			for (const f of files) {
				// Raster images go through the resize/encode pipeline (vision content);
				// everything else — including SVG — is uploaded raw and attached by path.
				if (isRasterImage(f.type)) {
					await addImageFiles([f]);
				} else {
					await attachLocalFile(f);
				}
			}
		},
		[addImageFiles, attachLocalFile],
	);

	// Edit-and-re-ask: the server forks a new session at that message and re-asks
	// the edited text there (stable callback — Message is memoized). Attachments
	// carry the question's original images (fork drops their aside cards) plus
	// any newly pasted/dropped ones — same pipeline as a normal prompt.
	const onEditMessage = useCallback(
		(messageId: string, text: string, attachments?: PromptAttachment[]) => {
			send({ type: "edit_message", messageId, text, attachments });
		},
		[send],
	);

	// Remove one queued prompt (the ✕ on a pending bubble). `index` = bubble position.
	const onRemoveQueued = useCallback(
		(kind: "steer" | "followUp", text: string, index: number) => {
			send({ type: "queue_remove", kind, text, index });
		},
		[send],
	);

	// 撤回一条排队/插队消息：先从队列移除（同 ✕ 的协议），再把文字放回输入框。
	// ChatInput 内部持有 text state，这里用数组递过去（seq 递增；数组保证连续点两条不丢第一条）。
	const [recallDrafts, setRecallDrafts] = useState<{ text: string; seq: number }[]>([]);
	const recallSeqRef = useRef(0);
	const onRecallQueued = useCallback(
		(kind: "steer" | "followUp", text: string, index: number) => {
			send({ type: "queue_remove", kind, text, index });
			recallSeqRef.current += 1;
			const parsed = splitQuotedPrompt(text);
			const item = { text: parsed.text, seq: recallSeqRef.current };
			if (parsed.quotes.length)
				setAttachments((prev) =>
					appendDraftAttachments(
						prev,
						parsed.quotes.map((quote) => ({ path: "", name: "", mode: "quote", quote, key: randomUuid() })),
					),
				);
			if (parsed.attachments?.length) {
				const restored = parsed.attachments
					.filter((att) => att.type !== "vision-bridge")
					.map((att) => ({
						path: att.path || att.url || "",
						name: att.name,
						mode: (att.type === "conversation"
							? "conversation"
							: att.lines
								? "lines"
								: "reference") as PromptAttachment["mode"],
						lines: att.lines,
						key: randomUuid(),
					}));
				if (restored.length) {
					setAttachments((prev) => appendDraftAttachments(prev, restored));
				}
			}
			setRecallDrafts((prev) => [...prev.slice(-9), item]);
		},
		[send],
	);

	// Stable callbacks for memoized panels (LeftPanel/RightPanel/ChatInput/
	// GoalBar skip re-render while tokens stream in — inline closures here
	// would break their shallow prop comparison every render).
	const openManageModels = useCallback(() => setManageModelsOpen(true), []);
	const clearAttachments = useCallback(() => setAttachments([]), []);
	// 待发附件跟会话走：会话身份一变（新建对话 / 切对话 / 过户 / 切项目）就清空，
	// 与正文草稿同口径 —— 正文是按 sessionId 存的（切会话即清空再恢复该会话的草稿），
	// 附件只在内存里；不清就会「正文已被新对话清掉、chips 还挂着旧对话的文件」，
	// 且那排 chips 会随下一条消息一起发出去。
	// 判定：composer-draft.ts 的 advanceComposerSession；接线：use-composer-session.ts
	//（两者都有单测，空 sessionId 的瞬时态不清）。
	useComposerSessionReset(chat.state?.sessionId ?? "", clearAttachments);
	const removeAttachmentCb = useCallback(removeAttachment, []);
	// addImageFiles/addLocalFiles 本体已是依赖正确的 useCallback（见上），引用在
	// 流式重渲染期间稳定，直接传给 memo 化的 ChatInput，无需再包一层。
	const addImageFilesCb = addImageFiles;
	const addLocalFilesCb = addLocalFiles;
	const searchFilesCb = useCallback(
		(reqId: number, query: string) => send({ type: "search_files", reqId, query }),
		[send],
	);
	// `@` 提及命中带的路径附件（mode 缺省 reference；去重由 attach 内处理）。
	const addPathAttachmentCb = useCallback(
		(a: {
			path: string;
			name: string;
			mode?: "inline" | "reference" | "lines";
			isDir?: boolean;
			lines?: { start: number; end: number };
			silent?: boolean;
		}) => attach(a.path, a.name, a.mode ?? "reference", a.isDir ?? false, a.lines, a.silent ?? false),
		// eslint-disable-next-line react-hooks/exhaustive-deps -- attach 只用 setAttachments（稳定），跟随其余 Cb 同口径
		[],
	);

	// Narrow snapshot of the model/thinking fields for the memoized ChatInput →
	// ModelThinking chain; identity is stable while tokens stream in.
	const model = chat.state?.model;
	const thinkingLevel = chat.state?.thinkingLevel;
	const availableThinkingLevels = chat.state?.availableThinkingLevels;
	const modelState = useMemo(
		() =>
			model
				? {
						model,
						thinkingLevel: thinkingLevel ?? "off",
						availableThinkingLevels: availableThinkingLevels ?? [],
					}
				: null,
		// Deps are the STABLE inner refs (server reuses them across snapshots),
		// so the object identity survives token deltas and ChatInput's memo holds.
		[model, thinkingLevel, availableThinkingLevels],
	);

	const createShell = useCallback(() => {
		if (!chat.ready || chat.terminals.length !== 0) return false;
		terminal.create({
			id: randomUuid(),
			conversationId: chat.activeConversationId || chat.state?.conversationId || "",
			title: t("terminalTitle", { n: 1 }),
			cwd: chat.state?.cwd ?? "",
			cols: 80,
			rows: 24,
			running: true,
			exitCode: null,
		});
		return true;
	}, [chat.ready, chat.state?.cwd, chat.terminals.length, t, terminal]);

	// If the user clicked Terminal while the initial connection was still
	// loading, complete that request as soon as the session becomes ready.
	useEffect(() => {
		if (!terminalOpenRequested.current) return;
		if (view !== "terminal" || chat.terminals.length !== 0) {
			terminalOpenRequested.current = false;
			return;
		}
		if (createShell()) terminalOpenRequested.current = false;
	}, [chat.terminals.length, createShell, view]);

	return (
		// Whole window is a drop target (issue #19): dragover highlights + any
		// drop attaches. The plain preventDefault used to merely stop the browser
		// navigating away; children with their own handlers (input bar / edit
		// composer) call stopPropagation and keep priority.
		<div
			className={`app${zenMode ? " zen-mode" : ""}`}
			data-pi-anchor="app"
			onDragOver={(e) => {
				if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
				e.preventDefault();
				setAppDragOver(true);
			}}
			onDragLeave={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node)) setAppDragOver(false);
			}}
			onDrop={(e) => {
				setAppDragOver(false);
				if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
				e.preventDefault();
				const files = Array.from(e.dataTransfer?.files ?? []);
				if (files.length === 0) {
					pushNotice("warning", t("foldersNotSupported"));
					return;
				}
				// Same split as ChatInput.handleFiles: raster images go through
				// the vision pipeline, everything else uploads as a raw file.
				const images = files.filter((f) => isRasterImage(f.type));
				const others = files.filter((f) => !isRasterImage(f.type));
				if (images.length > 0) void addImageFiles(images);
				if (others.length > 0) void addLocalFiles(others);
			}}
		>
			{zenMode && (
				<button
					type="button"
					className="zen-exit-pill"
					onClick={toggleZenMode}
					title={t("zenModeExitTip")}
					aria-label={t("zenModeExit")}
				>
					<FiFeather />
					<span>{t("zenModeExit")}</span>
				</button>
			)}
			{appDragOver && (
				<div className="app-drop-overlay" aria-hidden>
					<span>📎 {t("dropHereToAttach")}</span>
				</div>
			)}
			<TopBar
				chat={chat}
				terminal={terminal}
				view={view}
				uiPrimary={uiPrimary}
				uiOverflow={uiOverflow}
				uiContextTopbar={uiSlots["contextmenu.topbar"]}
				onUiAction={onUiAction}
				onViewChange={(v: ViewName) => {
					// The terminal panel stays mounted while hidden. Create the first
					// shell on the user's terminal-view click, not on initial mount.
					terminalOpenRequested.current = v === "terminal" && chat.terminals.length === 0;
					if (terminalOpenRequested.current && createShell()) {
						terminalOpenRequested.current = false;
					}
					setView(v);
					setDrawer(null);
				}}
				onOpenPanel={setDrawer}
				onOpenSettings={() => {
					setSettingsInitialSection(undefined);
					setSettingsOpen(true);
				}}
				onOpenBgTasks={() => setBgTasksOpen(true)}
				onOpenGlobalSearch={() => setGlobalSearchOpen(true)}
				onOpenIconEdit={() => setIconEditOpen(true)}
				onOpenSandboxModal={() => setSandboxModalMode("create")}
				themes={themes}
				theme={theme}
				onThemeChange={switchTheme}
				reloadThemes={reloadThemes}
			/>
			{iconEditOpen && (
				<IconEditor
					slots={uiSlots}
					layout={chat.settings?.uiLayout}
					exclude={HIDDEN_FROM_LAYOUT_ITEM_IDS}
					onClose={() => setIconEditOpen(false)}
				/>
			)}
			{chat.protocolMismatch && <div className="protocol-banner">⚠ {t("protocolMismatch")}</div>}
			<div className="notices">
				{chat.notices.map((n) => (
					<NoticeToast key={n.id} notice={n} onDismiss={dismissNotice} />
				))}
				{/* 通知条目（notice.actions 槽位）：常驻快捷按钮，无条目时不渲染。select 落成小下拉。 */}
				{uiNoticeActions.length > 0 && (
					<div className="notice-actions" role="toolbar">
						{uiNoticeActions.map((entry) =>
							entry.kind === "select" && entry.options?.length ? (
								<select
									key={entry.id}
									className="btn btn-slot notice-select"
									title={entry.hint ?? entry.label}
									aria-label={entry.label}
									value={
										entry.options.some((o) => o.value === entry.value)
											? (entry.value as string)
											: entry.options[0]!.value
									}
									onChange={(e) => onUiAction(entry, e.target.value)}
								>
									{entry.options.map((o) => (
										<option key={o.value} value={o.value}>
											{o.label}
										</option>
									))}
								</select>
							) : (
								<button
									key={entry.id}
									type="button"
									className="btn btn-slot"
									title={entry.hint ?? entry.label}
									onClick={() => onUiAction(entry)}
								>
									{entry.icon ? `${entry.icon} ` : ""}
									{entry.badge ?? entry.label}
								</button>
							),
						)}
					</div>
				)}
			</div>
			<TemplateProvider currentModelId={model ? `${model.provider}/${model.id}` : null}>
				<div ref={layoutRef} className="layout" style={{ "--left-w": `${leftWidth}px` } as CSSProperties}>
					{/* 遮罩：移动端**常驻**（否则关着的抽屉被手势拉出来时没有可渐变的遮罩，见
					    `use-swipe-drawer.ts`），靠 `.on` 类控制显隐与可点；桌面端仍按需挂载。 */}
					{isMobile ? (
						<div className={`drawer-backdrop persistent${drawer ? " on" : ""}`} onClick={() => setDrawer(null)} />
					) : (
						drawer && <div className="drawer-backdrop" onClick={() => setDrawer(null)} />
					)}
					{/* 悬浮停靠栏是**布局内的贴边槽位**（不再是覆盖一切的 fixed 浮层）：夹在屏幕边缘与
					    面板之间，面板与主区自动向内让出它的宽度 —— 面板里的按钮再也不会被压住；该侧没有
					    图标时整条不渲染，连宽度都不占。 */}
					<SideDock
						side="left"
						items={uiSidebarLeft}
						chat={chat}
						view={view}
						dropdownProps={{
							theme,
							themes,
							onThemeChange: switchTheme,
							reloadThemes,
						}}
						onViewChange={(v: ViewName) => {
							terminalOpenRequested.current = v === "terminal" && chat.terminals.length === 0;
							if (terminalOpenRequested.current && createShell()) {
								terminalOpenRequested.current = false;
							}
							setView(v);
							setDrawer(null);
						}}
						onOpenPanel={setDrawer}
						onOpenSettings={(sec) => {
							setSettingsInitialSection(sec as any);
							setSettingsOpen(true);
						}}
						onOpenBgTasks={() => setBgTasksOpen(true)}
						onOpenGlobalSearch={() => setGlobalSearchOpen(true)}
						onUiAction={onUiAction}
						uiContextTopbar={uiSlots["contextmenu.topbar"]}
						onThemeToggle={() => switchTheme(theme === "light" ? null : "light")}
					/>
					<div className={`view-pane ${view === "chat" ? "" : "hidden"}`}>
						{!isMobile && leftCollapsed && <PanelRail side="left" onClick={toggleLeft} />}
						<div
							className={`panel-drawer drawer-left ${drawer === "left" ? "open" : ""}${
								isMobile ? "" : leftCollapsed ? " hidden" : ""
							}`}
						>
							<LeftPanel
								collapsible={!isMobile}
								onToggleCollapse={toggleLeft}
								panelSend={panelSend}
								active={!isMobile || drawer === "left"}
								sessionFile={chat.state?.sessionFile ?? null}
								conversations={chat.conversations}
								elsewhere={chat.elsewhere}
								sessions={chat.sessions}
								projects={chat.projects}
								pathCompletions={chat.pathCompletions}
								activeConversationId={chat.activeConversationId}
								/* 宿主 UI 扩展点（contextmenu.session）：条目由 buildUiSlots 算好，左栏只管开菜单 +
								   分派它自己的两条内置项（host:conv-dismiss-subagents / host:conv-force-dismiss）。 */
								uiContextSession={uiSlots["contextmenu.session"]}
								uiLeftSessions={uiLeftSessions}
								uiContextProject={uiSlots["contextmenu.project"]}
								uiProjectsActions={uiLeftProjectsActions}
								uiLeftProject={uiLeftProject}
								uiRunningActions={uiLeftRunningActions}
								uiHistoryActions={uiLeftHistoryActions}
								uiSections={uiLeftSections}
								uiLeftRunning={uiLeftRunning}
								uiLeftHistory={uiLeftHistory}
								onUiAction={onUiAction}
								presetNames={presetNames}
								transition={chat.transition}
								onOpenSandboxModal={() => setSandboxModalMode("create")}
							/>
						</div>
						{!isMobile && !leftCollapsed && <ResizeHandle side="left" width={leftWidth} onResize={resizeLeft} />}
						<main
							className={`${wide ? "main wide-chat" : "main"}${hideModelRow ? " hide-model-row" : ""}${
								chat.transition && !chat.transition.previewMessages?.length ? " main-transitioning" : ""
							}${isMinimalEmpty ? " main-minimal-empty" : ""}`}
						>
							{chat.transition && (
								<div
									className={`workspace-transition-bar phase-${chat.transition.phase}`}
									role="status"
									aria-live="polite"
								>
									<div className="workspace-transition-track">
										<div
											className="workspace-transition-fill"
											style={{ width: `${Math.min(100, Math.max(8, chat.transition.progress))}%` }}
										/>
									</div>
									<div className="workspace-transition-pill">
										<span className="workspace-transition-spinner" aria-hidden="true" />
										<span className="workspace-transition-text">
											{!isZhLocale(locale) && chat.transition.textEn ? chat.transition.textEn : chat.transition.text}
										</span>
										<span className="workspace-transition-pct">{chat.transition.progress}%</span>
									</div>
								</div>
							)}
							{/* 对话头部条（chat.header 槽位）：无条目时不渲染。 */}
							{uiChatHeader.length > 0 && (
								<div className="chat-header" role="toolbar">
									{renderSlotToolbar(uiChatHeader, onUiAction)}
								</div>
							)}
							{chat.state ? (
								<>
									{chat.state.sandbox && (
										<div className="sandbox-banner" role="region" aria-label={chat.state.sandbox.name}>
											<div className="sandbox-banner-info">
												<span className="sandbox-banner-title">
													<LuFlaskConical className="sandbox-banner-icon" aria-hidden />
													{t("sandboxBannerTitle", { name: chat.state.sandbox.name })}
													<span
														className={`lp-sandbox-badge ${chat.state.sandbox.ephemeral ? "ephemeral" : "permanent"}`}
													>
														{chat.state.sandbox.ephemeral ? t("sandboxBadgeEphemeral") : t("sandboxBadgePermanent")}
													</span>
												</span>
												<span className="sandbox-banner-desc">
													{chat.state.sandbox.sourcePath
														? t("sandboxBannerSourceDesc", { source: chat.state.sandbox.sourcePath })
														: t("sandboxBannerBlankDesc")}
												</span>
											</div>
											<div className="sandbox-banner-actions">
												{chat.state.sandbox.ephemeral && (
													<button
														type="button"
														className="sandbox-banner-btn"
														title={t("sandboxActionPersistTip")}
														onClick={() => send({ type: "persist_sandbox", path: chat.state?.sandbox?.path })}
													>
														<FiBookmark aria-hidden /> {t("sandboxActionPersist")}
													</button>
												)}
												{chat.state.sandbox.sourcePath && (
													<button
														type="button"
														className="sandbox-banner-btn primary"
														title={t("sandboxActionApplySourceTip")}
														onClick={() => setSandboxModalMode("apply")}
													>
														<FiCheck aria-hidden /> {t("sandboxActionApplySource")}
													</button>
												)}
												<button
													type="button"
													className="sandbox-banner-btn"
													title={t("sandboxActionPromoteTip")}
													onClick={() => setSandboxModalMode("promote")}
												>
													<FiUpload aria-hidden /> {t("sandboxActionPromote")}
												</button>
												<button
													type="button"
													className="sandbox-banner-btn"
													title={t("sandboxActionResetTip")}
													onClick={() => {
														const sbx = chat.state?.sandbox;
														if (!sbx) return;
														if (window.confirm(t("sandboxActionResetConfirm", { name: sbx.name }))) {
															send({ type: "reset_sandbox", path: sbx.path });
														}
													}}
												>
													<FiRefreshCw aria-hidden /> {t("sandboxActionReset")}
												</button>
												<button
													type="button"
													className="sandbox-banner-btn danger"
													title={t("sandboxActionDestroyTip")}
													onClick={() => {
														const sbx = chat.state?.sandbox;
														if (!sbx) return;
														if (window.confirm(t("sandboxActionDestroyConfirm", { name: sbx.name }))) {
															send({ type: "destroy_sandbox", path: sbx.path });
														}
													}}
												>
													<FiTrash2 aria-hidden /> {t("sandboxActionDestroy")}
												</button>
											</div>
										</div>
									)}
									{chat.state.worktree && (
										<WorktreeBanner
											worktree={chat.state.worktree}
											onSwitch={(path) => send({ type: "switch_worktree", path })}
											onRemove={(path, force) => send({ type: "remove_worktree", path, force })}
										/>
									)}
									{chat.state.isEphemeral && (
										<div className="ephemeral-banner">
											<span>🎭 {t("ephemeralBannerText")}</span>
											<button
												type="button"
												className="ephemeral-save"
												onClick={() => send({ type: "persist_conversation", id: activeConvId })}
											>
												💾 {t("saveEphemeral")}
											</button>
										</div>
									)}
									<MessageList
										uiMessageActions={uiSlots["message.actions"]}
										uiContextMessage={uiSlots["contextmenu.message"]}
										/* 工具调用卡片的工具名右键菜单（contextmenu.toolcall）：条目已合并好，
										   工具卡只管开菜单 + 分派它自己的 host:tool-info。 */
										uiContextToolCall={uiSlots["contextmenu.toolcall"]}
										uiChatEmpty={uiChatEmpty}
										onUiAction={onUiAction}
										key={
											chat.transition?.previewMessages?.length
												? `preview:${chat.transition.target}`
												: (chat.state.conversationId ?? "boot")
										}
										state={
											chat.transition?.previewMessages?.length
												? {
														...chat.state,
														messages: chat.transition.previewMessages,
														streamingMessage: null,
														isStreaming: false,
													}
												: chat.state
										}
										liveOutputs={chat.liveOutputs}
										toolStatuses={chat.toolStatuses}
										onEdit={onEditMessage}
										onKillBash={() => send({ type: "abort_bash" })}
										onRetry={() => {
											// 重试沿用当前模型续跑上一轮请求，同样算一次模型使用（下拉按次数排序）。
											if (send({ type: "retry_last" })) {
												const m = chat.state?.model;
												if (m) recordModelUsage(`${m.provider}/${m.id}`);
											}
										}}
										onRemoveQueued={onRemoveQueued}
										onRecallQueued={onRecallQueued}
										thinkingWrap={chat.settings?.thinkingWrap ?? true}
										toolsWrap={chat.settings?.toolsWrap ?? true}
										toolImages={chat.settings?.toolImagesEnabled ?? true}
										keepRecent={chat.settings?.keepRecentMessages}
										reversePagination={chat.settings?.reversePagination ?? false}
										minimalNewChat={chat.settings?.minimalNewChat ?? false}
										jumpTarget={searchJump}
										onJumpDone={() => setSearchJump(null)}
										urlJumpMessageId={urlJump && urlJump.sessionId === chat.state.sessionId ? urlJump.messageId : null}
										onUrlJumpDone={() => setUrlJump(null)}
									/>
								</>
							) : (
								<div className="boot-wait">{chat.ready ? t("loadingSession") : t("connectingServer")}</div>
							)}

							{/* 目标条宿主槽：只包 GoalBar。折叠态时槽高 0（药丸脱离文档流），
						    展开态就是原来那一条（.goalbar 自带 margin）。 */}
							{chat.settings?.goalModeEnabled !== false && (
								<div className="goalbar-slot">
									<GoalBar
										goal={chat.goal}
										activeConversationId={chat.activeConversationId}
										uiGoalbarActions={uiGoalbarActions}
										onUiAction={onUiAction}
									/>
								</div>
							)}
							{/* Loop 紧凑入口：与目标条同一带子（复用 .goalbar-slot/.goalbar 视觉语言），
						    闲置是居中小药丸，运行中是「阶段·轮次·耗时+停止」状态条。 */}
							<div className="goalbar-slot">
								<LoopBar loop={chat.state?.loop ?? null} goalModeEnabled={chat.settings?.goalModeEnabled !== false} />
							</div>
							{/* 驾驶舱弹层（Portal 到 body）：新任务（统一任务入口）/ 连接集群 / Loop 任务台 / 任务详情。 */}
							<TaskModal
								goal={chat.goal}
								mainModel={chat.state?.model ?? null}
								goalModeEnabled={chat.settings?.goalModeEnabled !== false}
							/>
							<ClusterModal />
							<TaskDesk goal={chat.goal} activeConversationId={chat.activeConversationId} />
							<RunDetailModal currentLoop={chat.state?.loop ?? null} />
							{/* 扩展问卷：非模态内联面板，插在输入框上方，对话内容保持可见 */}
							{/* 通用右键菜单（contextmenu.* 槽位）：各处的 onContextMenu 打开它。 */}
							<ContextMenu onAction={(entry, target, value) => onUiAction(entry, value, target)} />
							{chat.dialog && <Dialog dialog={chat.dialog} />}
							{chat.question && (
								<DshQuestionDialog
									question={chat.question}
									conversationTitle={
										chat.question.conversationTitle ||
										chat.conversations.find((c) => c.id === (chat.question?.conversationId || activeConvId))?.title
									}
								/>
							)}
							{/* 跨页作答：别处会话的问卷在本页弹框（id 对方会话作用域，提交带 owner）。 */}
							{chat.remoteQuestion && (
								<DshQuestionDialog
									question={chat.remoteQuestion}
									owner={chat.remoteQuestion.owner}
									conversationTitle={
										chat.remoteQuestion.conversationTitle ||
										chat.conversations.find((c) => c.id === chat.remoteQuestion?.convId)?.title
									}
								/>
							)}
							<ChatInput
								composerActions={uiSlots["composer.actions"]}
								streaming={chat.state?.isStreaming ?? false}
								planMode={chat.state?.planMode ?? false}
								messages={chat.state?.messages ?? EMPTY_MESSAGES}
								slashCommands={chat.slashCommands}
								modelState={modelState}
								models={chat.models}
								modelsLoading={chat.modelsLoading}
								providerKeys={chat.providerKeys}
								defaultModel={chat.defaultModel ?? undefined}
								attachments={attachments}
								onRemoveAttachment={removeAttachmentCb}
								onAddImageFiles={addImageFilesCb}
								onAddLocalFiles={addLocalFilesCb}
								onAddPathAttachment={addPathAttachmentCb}
								fileSearch={chat.fileSearch}
								onSearchFiles={searchFilesCb}
								onNotice={pushNotice}
								onManageModels={openManageModels}
								onSent={clearAttachments}
								quickPhrases={chat.settings?.quickPhrases ?? []}
								quickPhrasesEnabled={
									zenMode
										? false
										: (chat.settings?.quickPhrasesEnabled ?? true) &&
											(!chat.settings?.minimalNewChat ||
												(chat.state?.messages?.length ?? 0) > 0 ||
												!!chat.state?.streamingMessage)
								}
								recallDrafts={recallDrafts}
								dshPermCurrent={chat.state?.permission ?? null}
								dshPermOptions={chat.dshPermission?.options ?? undefined}
								dshPermDefault={chat.dshPermission?.defaultPreset}
								dshPreset={chat.state?.agentPreset ?? null}
								dshPresets={chat.dshPresets?.presets ?? undefined}
								dshPresetDefault={chat.dshPresets?.defaultPreset}
								dshBlank={(chat.state?.messages?.length ?? 0) === 0}
								conversationId={chat.activeConversationId || chat.state?.conversationId || ""}
								sessionDraft={chat.state?.draft ?? null}
								sessionId={chat.state?.sessionId ?? ""}
								preserveDraftAcrossConversations={chat.settings?.preserveDraftAcrossConversations ?? false}
							/>
						</main>
					</div>
					<div className={`view-pane ${view === "terminal" ? "" : "hidden"}`}>
						<Suspense fallback={null}>
							<TerminalPanel
								chat={chat}
								terminal={terminal}
								uiTerminalToolbar={uiTerminalToolbar}
								onUiAction={onUiAction}
							/>
						</Suspense>
					</div>
					<SideDock
						side="right"
						items={uiSidebarRight}
						chat={chat}
						view={view}
						dropdownProps={{
							theme,
							themes,
							onThemeChange: switchTheme,
							reloadThemes,
						}}
						onViewChange={(v: ViewName) => {
							terminalOpenRequested.current = v === "terminal" && chat.terminals.length === 0;
							if (terminalOpenRequested.current && createShell()) {
								terminalOpenRequested.current = false;
							}
							setView(v);
							setDrawer(null);
						}}
						onOpenPanel={setDrawer}
						onOpenSettings={(sec) => {
							setSettingsInitialSection(sec as any);
							setSettingsOpen(true);
						}}
						onOpenBgTasks={() => setBgTasksOpen(true)}
						onOpenGlobalSearch={() => setGlobalSearchOpen(true)}
						onUiAction={onUiAction}
						uiContextTopbar={uiSlots["contextmenu.topbar"]}
						onThemeToggle={() => switchTheme(theme === "light" ? null : "light")}
					/>
				</div>
			</TemplateProvider>
			<FooterBar
				chat={chat}
				bottombarItems={uiSlots["bottombar"]}
				onUiAction={onUiAction}
				onOpenSettings={() => {
					setSettingsInitialSection(undefined);
					setSettingsOpen(true);
				}}
				onViewChange={(v: ViewName) => {
					terminalOpenRequested.current = v === "terminal" && chat.terminals.length === 0;
					if (terminalOpenRequested.current && createShell()) {
						terminalOpenRequested.current = false;
					}
					setView(v);
					setDrawer(null);
				}}
				onOpenGlobalSearch={() => setGlobalSearchOpen(true)}
				onOpenBgTasks={() => setBgTasksOpen(true)}
			/>
			{previewFile && (
				<FilePreview
					file={previewFile}
					content={chat.fileContent}
					onAddLines={(path, name, start, end) => attach(path, name, "lines", false, { start, end })}
					onAttach={(path, name, mode) => attach(path, name, mode)}
					onClose={() => setPreviewFile(null)}
					uiFilePreviewToolbar={uiFilePreviewToolbar}
					onUiAction={onUiAction}
				/>
			)}
			{chat.ready && chat.state && chat.state.piConfigured === false && !setupDismissed && !manageModelsOpen && (
				<PiSetupModal
					piConfigured={chat.state.piConfigured}
					piAgentInstalled={chat.state.piAgentInstalled}
					providers={chat.providers}
					providerOAuthFlows={chat.providerOAuthFlows}
					providerOAuthResults={chat.providerOAuthResults}
					installResult={chat.installResult}
					onClose={dismissSetup}
				/>
			)}
			{manageModelsOpen && (
				<ModelConfigModal
					providers={chat.modelsConfig}
					providerStatus={chat.providers}
					providerKeys={chat.providerKeys}
					providerOAuthFlows={chat.providerOAuthFlows}
					providerOAuthResults={chat.providerOAuthResults}
					fetchModelsResult={chat.fetchModelsResult}
					testModelConnectionResult={chat.testModelConnectionResult}
					enrichModelsResult={chat.enrichModelsResult}
					enrichModelsProgress={chat.enrichModelsProgress}
					refreshBuiltinResult={chat.refreshBuiltinResult}
					refreshProviderResult={chat.refreshProviderResult}
					appendBuiltinResult={chat.appendBuiltinResult}
					cloneProviderResult={chat.cloneProviderResult}
					defaultModel={chat.defaultModel}
					onClose={() => setManageModelsOpen(false)}
				/>
			)}
			{settingsOpen && (
				<SettingsModal
					chat={chat}
					initialSection={settingsInitialSection}
					onClose={() => setSettingsOpen(false)}
					onOpenIconEdit={() => setIconEditOpen(true)}
					onOpenManageModels={() => {
						setSettingsOpen(false);
						setManageModelsOpen(true);
					}}
				/>
			)}
			{bgTasksOpen && (
				<BgTasksModal
					servers={chat.bgServers}
					autoCleanupMin={chat.settings?.bgAutoCleanupMin ?? 0}
					onClose={() => setBgTasksOpen(false)}
				/>
			)}
			{/* 工具定义说明弹窗（工具卡右键菜单 host:tool-info）：自己订阅 store，无 props。 */}
			<ToolInfoDialog />
			{/* 工具执行详情与思考流检查器弹窗（极简行文模式微胶囊点击弹窗） */}
			<ToolInspectorModal />
			{/* 会话回滚确认弹窗（Dual-State Rollback） */}
			<RollbackDialog />
			{/* 人机协同拦截与「改写执行」审批弹窗 */}
			<ToolApprovalDialog approval={chat.approval} />
			{/* TUI 扩展模态弹窗（ctx.ui.custom 虚拟终端桥） */}
			{chat.tuiOverlay && <TuiOverlayModal overlay={chat.tuiOverlay} />}
			<GlobalSearchModal
				open={globalSearchOpen}
				projects={chat.projects}
				fileSearch={chat.fileSearch}
				sessionSearch={chat.sessionSearch}
				onClose={() => setGlobalSearchOpen(false)}
				onSwitchSession={(path, anchors) => {
					void send({ type: "switch_session", path });
					// 跳到命中消息位置（锚点取自服务端返回；无锚点则只切换会话）
					const a = anchors && anchors[0];
					setSearchJump(a ? { path, role: a.role, timestamp: a.timestamp } : null);
				}}
				onSwitchProject={(path) => {
					void send({ type: "set_cwd", path });
				}}
				onPreviewFile={(path, name) => {
					openFile(path, name);
				}}
			/>
			{sandboxModalMode && (
				<SandboxModal
					mode={sandboxModalMode}
					currentCwd={chat.state?.cwd}
					currentSandbox={chat.state?.sandbox}
					sandboxDiff={chat.sandboxDiff}
					projects={chat.projects}
					send={send}
					onClose={() => setSandboxModalMode(null)}
				/>
			)}
			<BannerContainer />
		</div>
	);
}
