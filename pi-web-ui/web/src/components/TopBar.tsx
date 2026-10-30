import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
	FiDownload,
	FiEdit2,
	FiFolder,
	FiFolderPlus,
	FiGitBranch,
	FiGlobe,
	FiMenu,
	FiMessageSquare,
	FiSearch,
	FiSun,
	FiPlus,
	FiSettings,
	FiLayers,
	FiList,
	FiTerminal,
} from "react-icons/fi";
import { GoTriangleDown } from "react-icons/go";
import { LuFlaskConical, LuMessageSquareDashed, LuWorkflow } from "react-icons/lu";
import type { ChatState, UpdateAllItem } from "../use-chat";
import type { CommandDef } from "../types";
import { buildUpdateCommand } from "../update-command";
import { randomUuid } from "../uuid";
import { Dropdown, DropdownItem } from "./Dropdown";
import type { ViewName } from "./BarItem";
import { formatCostDisplay } from "../cost-format";
import { isZhLocale, useI18n, localeShort } from "../i18n";
import { REQUIRED_TOPBAR_ITEM_IDS, type UiSlotEntry } from "../ui-slots";
import { fitTopbar, MOBILE_ASIDE_TOPBAR_IDS, sortOverflowMenuItems } from "../topbar-fit";
import {
	appSend,
	useAppField,
	useAppGlobals,
	useEngineCapabilities,
	useIsDsh,
	useIsManaged,
	useServiceInfo,
} from "../app-globals";
import { ProjectPicker } from "./ProjectPicker";
import { LocaleModal } from "./LocaleModal";
import { focusComposer } from "../composer-bridge";
import { useFloatingPanel } from "../use-floating-panel";
import { BarItem } from "./BarItem";
import { appUrl } from "../base-url";
import { openTaskDesk } from "../loop-cockpit";

/** 「安装全局引擎」按钮的目标（issue #321）：buildUpdateCommand 对 pi-core 生成
 *  `npm i -g <name>@latest`，装完重启服务即由 resolve-global-sdk 自动切到更新的那份。 */
const PI_CORE_ITEM: UpdateAllItem = {
	name: "@earendil-works/pi-coding-agent",
	kind: "pi-core",
	current: "",
	latest: null,
	upToDate: false,
};

/**
 * 顶栏「⋯」溢出菜单（issue #162）：portal 到 document.body + `position: fixed`。
 *
 * 为什么：菜单的触发按钮坐在横滑容器里 —— 窄屏（≤768px）的 `.topbar-flow{overflow-x:auto}`
 * 会让纵向也变成裁剪（CSS Overflow 3 §3.1：只写一轴 auto，另一轴的 visible 也算 auto）。
 * 菜单往下展开（`top: 100%+6px`）正好落在被裁剪的轴上，`z-index` 再高也逃不出来。
 * 之前 `ContextMenu.tsx` 已经用同一招（portal + fixed + 实测钳制）解决过右键菜单的裁剪，
 * 这里照抄：视口坐标直接取触发按钮的 `getBoundingClientRect()`，先渲染再实测菜单尺寸后钳制。
 *
 * 行为：点外面 / Esc 关闭（与 Dropdown/ContextMenu 一致）；窗口缩放或滚动时重算锚点
 * （移动端横滑顶栏时菜单跟着走，而不是飘在原地）。
 */
function TopbarOverflowMenu({
	anchorRef,
	open,
	onClose,
	children,
}: {
	anchorRef: React.RefObject<HTMLButtonElement | null>;
	open: boolean;
	onClose: () => void;
	children: ReactNode;
}) {
	const {
		panelRef: menuRef,
		style,
		measure,
	} = useFloatingPanel({
		open,
		anchor: anchorRef,
		onClose,
	});

	// 打开后、内容变化后：绘制前实测一次（layout effect，用户看不到中间态）。
	useLayoutEffect(() => {
		if (open) measure();
	}, [open, children, measure]);

	if (!open) return null;
	return createPortal(
		<div ref={menuRef} className="plugin-topbar-menu portal" role="menu" style={style}>
			{children}
		</div>,
		document.body,
	);
}

/**
 * 手机端断点（与 styles.css 的 mobile ≤768px 同口径）：matchMedia 监听，跨断点实时切换。
 * jsdom / SSR（无 matchMedia）回落 false —— 宁可全画，也不清空顶栏。
 */
function useIsMobileTopbar(): boolean {
	const [isMobile, setIsMobile] = useState(
		() =>
			typeof window !== "undefined" &&
			typeof window.matchMedia !== "undefined" &&
			window.matchMedia("(max-width: 768px)").matches,
	);
	useEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia === "undefined") return;
		const mq = window.matchMedia("(max-width: 768px)");
		const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
		if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
		else mq.addListener(onChange);
		return () => {
			if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", onChange);
			else mq.removeListener(onChange);
		};
	}, []);
	return isMobile;
}

interface TopBarProps {
	chat: ChatState;
	/** Minimal terminal-tab bridge (same shape SCMPanel uses) — updates run there. */
	terminal: {
		create: (meta: {
			id: string;
			conversationId: string;
			title: string;
			cwd: string;
			cols: number;
			rows: number;
			running: boolean;
			exitCode: number | null;
			command?: CommandDef;
		}) => void;
		restart: (id: string) => void;
	};
	view: ViewName;
	onViewChange: (view: ViewName) => void;
	/** 顶栏主栏条目（内置条目的最终结果，已按用户偏好排好；由 App 计算）。 */
	uiPrimary?: UiSlotEntry[];
	/** 溢出菜单条目：被隐藏/被移到 overflow 的条目（用户仍能从这里找回）。 */
	uiOverflow?: UiSlotEntry[];
	/** 点击一个条目：交回 App 分派（view 由宿主切视图；select 切选项时第二个参数带选中的 value）。 */
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
	/** 顶栏右键菜单的条目（contextmenu.topbar 槽位）。 */
	uiContextTopbar?: UiSlotEntry[];
	/** Open a side panel as a mobile drawer ("left" = history). */
	onOpenPanel: (side: "left" | "right") => void;
	/** Open the settings panel. */
	onOpenSettings: () => void;
	/** Open the background-task panel (AI-started servers — stop individually or all). */
	onOpenBgTasks: () => void;
	/** Open the global search panel (sessions / projects / workspace files). */
	onOpenGlobalSearch: () => void;
	/** Theme list + current selection + switch handler (owned by App). */
	themes: {
		id: string;
		name: string;
		builtin: boolean;
		nameEn?: string;
		group?: "classic" | "builtin";
		scheme?: "dark" | "light";
	}[];
	theme: string | null;
	onThemeChange: (id: string | null) => void;
	/** Re-fetch the theme list (called when a theme menu opens with an empty list). */
	reloadThemes: () => void;
	/** 打开「图标编辑」模式（直接拖图标改顶栏/底栏/侧边停靠栏的位置）。 */
	onOpenIconEdit: () => void;
	/** 极简沉浸模式状态与切换回调 */
	/** 打开启动沙盒项目弹窗 */
	onOpenSandboxModal?: () => void;
}

export function TopBar({
	chat,
	terminal,
	view,
	uiPrimary,
	uiOverflow,
	uiContextTopbar,
	onUiAction,
	onViewChange,
	onOpenPanel,
	onOpenSettings,
	onOpenBgTasks,
	onOpenGlobalSearch,
	themes,
	theme,
	onThemeChange,
	reloadThemes,
	onOpenIconEdit,
	onOpenSandboxModal,
}: TopBarProps) {
	const { locale, setLocale, t, packs } = useI18n();
	// 「⋯」溢出菜单的开关（宿主自己的菜单；顺序与设置面板里看到的一致）。
	const [topbarMenuOpen, setTopbarMenuOpen] = useState(false);
	/* 「打开项目」按钮（host:open-project）的项目选择器：与左栏 📁+ 同一个组件、同一套行为
	   （浏览磁盘目录 / 选当前目录 / ＋新建项目后切过去）。cwd 与额外工作区根走全局 store
	   （整棵树都要的值，不再从 App 传参）。 */
	const [projectPickerOpen, setProjectPickerOpen] = useState(false);
	const cwd = useAppField("cwd");
	const workspaceRoots = useAppField("workspaceRoots");
	/* 临时会话能力由引擎底座 capabilities.ephemeralChat 事实源驱动（DSH 不提供，Pi 与 Universal 提供）。 */
	const isDsh = useIsDsh();
	const capabilities = useEngineCapabilities();
	const supportsEphemeral = Boolean(capabilities.ephemeralChat !== false && !isDsh);
	/* 能力关闭的宿主入口（沙盒 / 临时对话）：顶栏直流与「⋯」溢出菜单都不画，
	   被布局页隐藏或本断点放不下时也不会以扁平菜单行的形式漏回来。 */
	const isCapabilityGatedOff = (id: string) =>
		(id === "host:new-sandbox" && !capabilities.sandboxes) || (id === "host:new-ephemeral-chat" && !supportsEphemeral);
	const cwdClickTimerRef = useRef<number | null>(null);
	useEffect(() => {
		return () => {
			if (cwdClickTimerRef.current !== null) {
				window.clearTimeout(cwdClickTimerRef.current);
			}
		};
	}, []);
	// 溢出菜单触发按钮：portal 菜单按它的视口矩形锚定（issue #162）。
	const moreBtnRef = useRef<HTMLButtonElement>(null);
	/* PI_WEB_TABS: an instance can be set up to offer only some tabs — the
	   server refuses the messages of the others anyway (server/tabs.ts), so
	   drawing them would only offer an action that comes back refused. No list
	   means every tab, which is the default. */
	const tabOn = (tab: string) => !chat.tabs || tab === "chat" || chat.tabs.includes(tab);
	/** 常驻溢出菜单的条目：「布局页里被隐藏的宿主条目 ＋ topbar.overflow 声明项」。
	 *  品牌（host:brand）没有动作，进菜单会变成死按钮 —— 直接过滤（布局页仍可勾回来）。
	 *  另外还有「本断点放不下」的条目，那是实测出来的（见下面的 fitTopbar），不在这里。 */
	const pinnedOverflowItems = [...(uiOverflow ?? [])].filter(
		(it) => !(it.source === "host" && (it.id === "host:brand" || isCapabilityGatedOff(it.id))),
	);
	/**
	 * 顶栏统一渲染（方案 A：**完全扁平**，桌面与手机同一份 slot 数据）——
	 * 所有条目都是 `.topbar-flow` 的直接子节点，**没有任何按种类包裹的容器**
	 * （不再有 .brand / .view-switch / .topbar-desktop，也不再有两端贴边的例外）：
	 * 宿主条目查 `hostNodes` 节点工厂，
	 * align 只决定它落在两个 spacer 划出的三段（start / center / end）里的哪一段。
	 * 可见性/顺序/对齐/文案对**每一个**条目都生效（布局页勾选框、↑↓、align）。
	 *
	 * `uiPrimary` 完全没给（未接线 / 单测）时回退内置默认顺序、全部落 start 区：
	 * 没拿到 slot 数据就把顶栏清空是最糟的降级（与旧版 hostOn 同口径）。
	 */
	const FALLBACK_TOPBAR_IDS = [
		"host:history",
		"host:brand",
		"host:open-project",
		"host:chat",
		"host:terminal",
		"host:search",
		"host:tasks",
		"host:settings",
		"host:language",
		"host:theme",
		"host:update",
		"host:new-chat",
		"host:new-ephemeral-chat",
		"host:new-sandbox",
	];
	const topEntries: { id: string; entry: UiSlotEntry | null }[] =
		uiPrimary !== undefined
			? uiPrimary.map((e) => ({ id: e.id, entry: e }))
			: FALLBACK_TOPBAR_IDS.map((id) => ({ id, entry: null }));
	// 视图门禁 / 白名单门禁在统一的条目流里过滤（见下面的 flowItems）。
	/**
	 * 溢出菜单里的**宿主内置动作**：点下去得真干活。
	 *
	 * 主路径是原样渲染（菜单里直接画 hostNodes 的 chip/tab，点它就是点顶栏本身，
	 * 不需要分派）。这里只服务两条后备：hostNodes 返回 null 的条目
	 * （门禁/条件不满足，如终端视图里的 ☰，扁平行保证找得回来）与 select 行。
	 * 宿主自己的入口实现全在 TopBar 里（与 T1 的教训一致：`host:*` 的实现留在拥有
	 * 它的组件内），所以这里按 id 映射到本地处理器；返回 false = 不认识
	 * 这个 id（比如 kind="view" 的条目）→ 交回 onUiAction。
	 */
	const dispatchHostOverflow = (entry: UiSlotEntry): boolean => {
		if (entry.source !== "host") return false;
		switch (entry.id) {
			case "host:history":
				onOpenPanel("left");
				return true;
			case "host:new-chat":
				onViewChange("chat");
				appSend({ type: "new_chat" });
				focusComposer();
				return true;
			case "host:new-ephemeral-chat":
				onViewChange("chat");
				appSend({ type: "new_chat", ephemeral: true });
				focusComposer();
				return true;
			case "host:new-sandbox":
				onOpenSandboxModal?.();
				return true;
			case "host:open-project":
				setProjectPickerOpen(true);
				return true;
			case "host:search":
				onOpenGlobalSearch();
				return true;
			case "host:task-desk":
				openTaskDesk();
				return true;
			case "host:tasks":
				onOpenBgTasks();
				return true;
			case "host:settings":
				onOpenSettings();
				return true;
			default:
				// 视图条目（chat/terminal）交给 App 的 onUiAction（视图由它自己 setView）；
				// 菜单型宿主条目不会走到这里（它们整块搬进菜单，见 OVERFLOW_AS_NODE_IDS）。
				return false;
		}
	};

	// 受管标记与自身版本号：走全局（web/src/app-globals.ts），整个连接内不变。
	const { appVersion } = useAppGlobals();
	const managed = useIsManaged();
	// 由 pi-web-ui 服务启动的实例（launchd/systemd/Windows watchdog）：退出后会被
	// supervisor 拉起，所以更新面板给出「重启服务」按钮；前台/dev 实例没有值。
	const service = useServiceInfo();
	const [restarting, setRestarting] = useState(false);
	// 「重启服务」会断开连接（进程退出→supervisor 拉起）：重新连上（open）后
	// 把按钮恢复可用，否则它会永远停在「重启中…」。
	useEffect(() => {
		if (restarting && chat.status === "open") setRestarting(false);
	}, [restarting, chat.status]);
	const [langOpen, setLangOpen] = useState(false);
	const [themeOpen, setThemeOpen] = useState(false);
	const [updateOpen, setUpdateOpen] = useState(false);
	const [localeModalOpen, setLocaleModalOpen] = useState(false);

	/** Run `npm i -g pi-web-ui@latest` in a visible terminal tab (SCM-style):
	 *  reuse the tab with the same title, otherwise create one; switch to the
	 *  terminal view so the user watches the install live. */
	const updateTermIdsRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		if (updateTermIdsRef.current.size === 0) return;
		let finished = false;
		for (const tid of Array.from(updateTermIdsRef.current)) {
			const tm = chat.terminals.find((t) => t.id === tid);
			if (tm && !tm.running) {
				updateTermIdsRef.current.delete(tid);
				finished = true;
			}
		}
		if (finished && chat.ready) {
			appSend({ type: "check_update" });
			appSend({ type: "check_updates_all", force: true });
		}
	}, [chat.terminals, chat.ready]);

	const runUpdate = () => {
		if (!chat.ready) return;
		const title = t("updateTabTitle");
		const cmd: CommandDef = {
			name: title,
			command: "npm i -g pi-web-ui@latest",
			cwd: "${pwd}",
		};
		const existing = chat.terminals.find((tm) => tm.title === title);
		if (existing) {
			updateTermIdsRef.current.add(existing.id);
			terminal.restart(existing.id);
			appSend({
				type: "run_command",
				terminalId: existing.id,
				conversationId: existing.conversationId,
				command: cmd,
				cols: 80,
				rows: 24,
			});
		} else {
			const tid = randomUuid();
			updateTermIdsRef.current.add(tid);
			terminal.create({
				id: tid,
				conversationId: chat.activeConversationId || chat.state?.conversationId || "",
				title,
				cwd: chat.state?.cwd ?? "",
				cols: 80,
				rows: 24,
				running: true,
				exitCode: null,
				command: cmd,
			});
		}
		setUpdateOpen(false);
		onViewChange("terminal");
	};

	/** Run the right update command for one or more components in a visible
	 *  terminal tab (same SCM-style pattern as the self-update above): pi
	 *  extensions go through `pi update npm:<name>` (they live under
	 *  <agentDir>/npm), everything globally installed via `npm i -g`.
	 *  Multi-target runs are chained with `;` so one failing step never
	 *  blocks the rest. Reuses the tab with the same title, else creates one. */
	const runPkgUpdate = (items: UpdateAllItem[], title: string) => {
		if (!chat.ready || items.length === 0) return;
		const cmd: CommandDef = {
			name: title,
			command: buildUpdateCommand(items),
			cwd: "${pwd}",
		};
		const existing = chat.terminals.find((tm) => tm.title === title);
		if (existing) {
			updateTermIdsRef.current.add(existing.id);
			terminal.restart(existing.id);
			appSend({
				type: "run_command",
				terminalId: existing.id,
				conversationId: existing.conversationId,
				command: cmd,
				cols: 80,
				rows: 24,
			});
		} else {
			const tid = randomUuid();
			updateTermIdsRef.current.add(tid);
			terminal.create({
				id: tid,
				conversationId: chat.activeConversationId || chat.state?.conversationId || "",
				title,
				cwd: chat.state?.cwd ?? "",
				cols: 80,
				rows: 24,
				running: true,
				exitCode: null,
				command: cmd,
			});
		}
		setUpdateOpen(false);
		onViewChange("terminal");
	};

	// Shared by the desktop update dropdown and the mobile "⋯" panel.
	const allUpdates = chat.updatesAll ?? [];
	// issue #321：pi SDK 副本状态（服务随 update_status_all 下发）。
	// pi-core 行显示的是全局 CLI 的版本 —— 「已是最新」只对那份成立；会话实际跑哪份
	// （自带 or 跟随的全局）由此处下发，行和面板都要把差距说出来。
	const sdkInfo = chat.updatesSdk;
	const sdkSplit =
		sdkInfo && sdkInfo.newerInstalled ? { running: sdkInfo.running, installed: sdkInfo.newerInstalled } : null;
	// 本进程跑的是随包自带那份 → 面板亮「安装全局引擎并切换」入口。
	const bundledInUse = sdkInfo?.bundledInUse === true;
	// 入口只在有行动价值时出现：没装全局 pi（没有 pi-core 行），或全局比 npm 最新版旧
	// （pi-core 行有更新）。全局与自带同版本且都最新时完全安静 —— 此时安装全局带不来
	// 任何切换，提了是噪音；行级「更新」按钮（同一条 npm i -g）已覆盖另一情形。
	const coreRow = allUpdates.find((i) => i.kind === "pi-core" && !i.error);
	const bundledRelevant = bundledInUse && (!coreRow || !coreRow.upToDate);
	const bundledButton = bundledRelevant && !coreRow;
	// Pure errors don't count as "updates" — they're shown as failed rows.
	const updatesCount = allUpdates.filter((i) => !i.upToDate && !i.error).length;
	// Packages (+ the pi core) with a real newer version — targets of the
	// per-row and "update all" buttons. The web UI itself is excluded: it has
	// its own dedicated update flow above the all-components section.
	const updatable = allUpdates.filter((i) => !i.upToDate && !i.error && i.kind !== "webui");
	// Git-source rows show `host/path` (what the user put in settings.json and
	// what `pi update` takes) instead of the clone's package.json name, which
	// is often generic and unrecognizable. Full identity stays in the tooltip.
	const gitDisplayName = (item: UpdateAllItem) =>
		item.kind === "git-extension" && item.source ? item.source : item.name;
	const gitNameTitle = (item: UpdateAllItem) =>
		item.kind === "git-extension" && item.source && item.source !== item.name
			? `${item.source} (${item.name})`
			: item.name;
	// Git SHAs carry no signal for users (`0.1.0 (aaa → bbb)`), so they are
	// hidden from the version cell: outdated rows already stand out via the
	// warn highlight + update button. Full values stay in the tooltip.
	const stripGitSha = (v: string) => {
		const s = v.replace(/ \([0-9a-f]{7}\)$/, "");
		return /^[0-9a-f]{7}$/.test(s) ? "" : s;
	};
	const extractGitSha = (v: string) => {
		const m = v.match(/\(([0-9a-f]{7})\)$/) ?? v.match(/^([0-9a-f]{7})$/);
		return m?.[1] ?? null;
	};
	const shortGitRange = (current: string, latest: string | null) => {
		if (!latest) return stripGitSha(current);
		const c = stripGitSha(current);
		const l = stripGitSha(latest);
		if (c !== l) return `${c} → ${l}`;
		const cSha = extractGitSha(current);
		const lSha = extractGitSha(latest);
		if (cSha && lSha && cSha !== lSha) {
			return c ? `${c} (${cSha} → ${lSha})` : `${cSha} → ${lSha}`;
		}
		return c;
	};
	const renderAllUpdatesBody = () => (
		<div className="dd-updates-all">
			<div className="dd-header">{t("updatesAllTitle")}</div>
			{chat.updatesAll === null ? (
				<div className="dd-note">{t("checkingUpdate")}</div>
			) : allUpdates.length === 0 ? (
				<div className="dd-note">{t("updatesAllUpToDate")}</div>
			) : (
				<ul className="dd-all-list">
					{allUpdates.map((item) => {
						// pi-core 行在分裂时即使「已是最新」也亮警示：行里的版本是全局 CLI 的，
						// 不是会话实际加载的那份。
						const splitRow = sdkSplit != null && item.kind === "pi-core";
						const warn = !item.error && (!item.upToDate || splitRow);
						return (
							<li
								key={`${item.kind}:${item.name}`}
								className={`dd-all-item${item.error ? " err" : warn ? " warn" : ""}`}
							>
								{item.kind !== "webui" && !item.upToDate && !item.error && (
									<button
										type="button"
										className="dd-update-btn"
										onClick={() => runPkgUpdate([item], t("updatePkgTabTitle", { name: item.name }))}
									>
										{t("updateBtn")}
									</button>
								)}
								<span className="dd-all-name" title={gitNameTitle(item)}>
									{gitDisplayName(item)}
								</span>
								<span className="dd-all-meta">
									<span className="dd-all-kind">
										{item.kind === "webui"
											? t("kindWebUi")
											: item.kind === "pi-core"
												? t("kindPiCore")
												: item.kind === "engine"
													? t("kindEngine")
													: item.kind === "git-extension"
														? t("kindGitExtension")
														: t("kindPackage")}
									</span>
									<span
										className="dd-all-vers"
										title={
											item.error
												? item.error
												: item.kind === "git-extension"
													? item.upToDate
														? item.current
														: `${item.current} → ${item.latest}`
													: undefined
										}
									>
										{item.error ? (
											item.kind === "pi-core" && item.current === "unknown" ? (
												t("piCoreUndetected")
											) : (
												t("updateCheckFailed")
											)
										) : item.kind === "git-extension" ? (
											item.upToDate ? (
												stripGitSha(item.current)
											) : (
												shortGitRange(item.current, item.latest)
											)
										) : item.upToDate ? (
											`v${item.current}`
										) : (
											<>
												v{item.current} → v{item.latest}
											</>
										)}
									</span>
									{splitRow && !item.error && (
										<span className="dd-split-run">{t("piCoreSplitRun", { running: sdkSplit.running })}</span>
									)}
								</span>
							</li>
						);
					})}
				</ul>
			)}
			{sdkSplit && (
				<div className="dd-note warn">
					{t("piSdkSplitNote", { running: sdkSplit.running, installed: sdkSplit.installed })}
				</div>
			)}
			{bundledRelevant && <div className="dd-note">{t("piSdkBundledNote", { running: sdkInfo!.running })}</div>}
			<div className="dd-actions">
				{bundledButton && (
					<button
						type="button"
						className="dd-refresh accent"
						style={{ flex: 1 }}
						onClick={() => runPkgUpdate([PI_CORE_ITEM], t("installGlobalEngineTabTitle"))}
					>
						{t("installGlobalEngineBtn")}
					</button>
				)}
				{updatable.length > 0 && (
					<button
						type="button"
						className="dd-refresh accent"
						style={{ flex: 1 }}
						onClick={() => runPkgUpdate(updatable, t("updateAllTabTitle"))}
					>
						{t("updateAllBtn")}
					</button>
				)}
				<button
					type="button"
					className="dd-refresh"
					style={updatable.length > 0 ? { flex: 1 } : undefined}
					onClick={() => appSend({ type: "check_updates_all", force: true })}
				>
					{t("updatesAllRefresh")}
				</button>
			</div>
		</div>
	);
	const renderUpdateBody = () => (
		<>
			<div className="dd-update">
				<div className="dd-row">
					<span>{t("currentVersion")}</span>
					<b>v{chat.update?.current ?? "…"}</b>
				</div>
				<div className="dd-row">
					<span>{t("latestVersion")}</span>
					<b>
						{chat.update === null
							? t("checkingUpdate")
							: chat.update.error
								? chat.update.error
								: chat.update.latest
									? `v${chat.update.latest}`
									: t("checkingUpdate")}
					</b>
				</div>
				{chat.update && chat.update.upToDate && <div className="dd-note ok">{t("upToDate")}</div>}
				{chat.update && !chat.update.upToDate && chat.update.latest && (
					<div className="dd-note warn">{t("updateAvailable", { version: chat.update.latest })}</div>
				)}
				{chat.update?.latestPublishedAt &&
					Date.now() - new Date(chat.update.latestPublishedAt).getTime() < 30 * 60_000 && (
						<div className="dd-note warn">
							{t("updateJustPublished", {
								version: chat.update.latest ?? "",
							})}
						</div>
					)}
				{/* 更新走 npm 终端命令（可见终端里跑安装，全程可看） */}
				{chat.update && !chat.update.upToDate && chat.update.latest && (
					<div className="dd-note">{t("updateTerminalHint")}</div>
				)}
			</div>
			<div className="dd-actions">
				<button type="button" className="dd-refresh" onClick={() => appSend({ type: "check_update" })}>
					{chat.update === null ? t("checkingUpdate") : t("checkUpdate")}
				</button>
				{chat.update && !chat.update.upToDate && chat.update.latest && (
					<button type="button" className="dd-refresh accent" onClick={runUpdate}>
						{t("updateNow")}
					</button>
				)}
				{service && (
					<button
						type="button"
						className="dd-refresh accent"
						disabled={restarting}
						title={t("restartServiceTip", { name: service.name })}
						onClick={() => {
							if (restarting) return;
							setRestarting(true);
							appSend({ type: "restart_service" });
						}}
					>
						{restarting ? t("restartingService") : t("restartService")}
					</button>
				)}
			</div>
		</>
	);

	/** 手机端断点（见 useIsMobileTopbar）：旁置/实测按断点切（mobileAsideItems/fitInput）。 */
	const isMobile = useIsMobileTopbar();
	/**
	 * 顶栏宿主内置条目的节点工厂（与 FooterBar 的 hostNodes 同模式）：`renderZoneFlow`
	 * 按 slot 顺序逐条查表，查不到 / 条件不满足（返回 null）即跳过、不占位。
	 * 可见性（slot 显隐）由调用方的条目流决定，TABS 白名单与视图门禁留在各工厂里。
	 */
	const hostNodes: Record<string, ReactNode> = {
		"host:brand": (
			<span className="brand">
				<img
					className="brand-logo"
					src={appUrl("/icons/icon-192.png")}
					alt="训推引擎组 Harness"
					width={26}
					height={26}
					draggable={false}
				/>
				<span className="brand-name">训推引擎组 Harness</span>
			</span>
		),
		// 打开项目：切整个工作区（set_cwd），与视图无关 —— 终端 / Git 视图里同样常驻可点。
		"host:open-project": (
			<button
				type="button"
				className="chip open-project"
				data-tip={t("openProject")}
				onClick={() => setProjectPickerOpen(true)}
			>
				<FiFolderPlus />
				<span className="chip-sub">{t("openProject")}</span>
			</button>
		),
		// 面板抽屉开关只在 chat 视图渲染：抽屉节点躺在 chat 视图的面板树里
		// （App.tsx 的 .panel-drawer 是 `.view-pane` 的子节点，非 chat 视图整棵
		// display:none），所以终端 / Git 视图里点它只会拉出一层遮罩、
		// 抽屉永远不出现 —— 而且顶栏这个 ☰ 会和终端面板自己的 ☰ 并排成两个。
		"host:history":
			view === "chat" && tabOn("history") ? (
				<button
					type="button"
					className="panel-toggle"
					data-tip={t("openHistory")}
					// 纯图标按钮：可访问名称只能走 aria-label（title 会和 data-tip
					// 的即时气泡叠成双提示，故顶栏直流内一律不用原生 title）。
					aria-label={t("openHistory")}
					onClick={() => onOpenPanel("left")}
				>
					<FiMenu />
				</button>
			) : null,
		"host:new-chat": tabOn("new-chat") ? (
			<button
				type="button"
				className="chip newchat"
				data-tip={t("newChatTip")}
				onClick={() => {
					onViewChange("chat");
					appSend({ type: "new_chat" });
					focusComposer();
				}}
			>
				<FiPlus />
				<span>{t("newChat")}</span>
			</button>
		) : null,
		"host:new-ephemeral-chat": !supportsEphemeral ? null : (
			<button
				type="button"
				className="chip newchat ephemeral-chat-btn"
				data-tip={t("newChatEphemeralTip")}
				onClick={() => {
					onViewChange("chat");
					appSend({ type: "new_chat", ephemeral: true });
					focusComposer();
				}}
			>
				<LuMessageSquareDashed />
				<span>{t("newChatEphemeral")}</span>
			</button>
		),
		"host:new-sandbox": (
			<button
				type="button"
				className="chip newchat sandbox-chip"
				data-tip={t("newSandboxTip")}
				aria-label={t("newSandboxTip")}
				onClick={() => onOpenSandboxModal?.()}
			>
				<LuFlaskConical />
				<span>{t("newSandbox")}</span>
			</button>
		),
		"host:chat": (
			<button
				type="button"
				role="tab"
				aria-selected={view === "chat"}
				className={`tb-tab${view === "chat" ? " active" : ""}`}
				data-tip={t("chat")}
				onClick={() => onViewChange("chat")}
			>
				<FiMessageSquare />
				<span>{t("chat")}</span>
			</button>
		),
		"host:terminal": tabOn("terminal") ? (
			<button
				type="button"
				role="tab"
				aria-selected={view === "terminal"}
				className={`tb-tab${view === "terminal" ? " active" : ""}`}
				data-tip={t("terminal")}
				onClick={() => onViewChange("terminal")}
			>
				<FiTerminal />
				<span>{t("terminal")}</span>
			</button>
		) : null,
		"host:search": (
			<button type="button" className="chip" data-tip={t("searchGlobalTip")} onClick={onOpenGlobalSearch}>
				<FiSearch />
				<span className="chip-sub">{t("searchGlobal")}</span>
			</button>
		),
		"host:task-desk": (
			<button type="button" className="chip task-desk-chip" data-tip={t("taskDeskTip")} onClick={openTaskDesk}>
				<FiList />
				<span className="chip-sub">{t("taskDesk")}</span>
			</button>
		),
		"host:tasks": (
			<button type="button" className="chip bg-task-chip" data-tip={t("bgTasksTip")} onClick={onOpenBgTasks}>
				<FiLayers />
				<span className="chip-sub">{t("bgTasks")}</span>
				{chat.bgServers.length > 0 && <span className="bg-task-badge">{chat.bgServers.length}</span>}
			</button>
		),
		"host:settings": (
			<button type="button" className="chip" data-tip={t("settingsTitle")} onClick={onOpenSettings}>
				<FiSettings />
				<span className="chip-sub">{t("settings")}</span>
			</button>
		),
		"host:language": (
			<Dropdown
				trigger={
					<>
						<FiGlobe />
						<span className="chip-sub">{localeShort(locale)}</span>
					</>
				}
				tip={t("language")}
				open={langOpen}
				onOpenChange={setLangOpen}
				caret={false}
			>
				<div className="dd-header">{t("language")}</div>
				{packs.map((l) => (
					<DropdownItem
						key={l.code}
						active={locale === l.code}
						onClick={() => {
							setLocale(l.code);
							setLangOpen(false);
						}}
					>
						{l.nativeName}
					</DropdownItem>
				))}
				<DropdownItem
					onClick={() => {
						setLangOpen(false);
						setLocaleModalOpen(true);
					}}
				>
					<FiDownload /> {t("localeGetMore")}
				</DropdownItem>
			</Dropdown>
		),
		"host:theme": (
			<Dropdown
				trigger={
					<>
						<FiSun />
						<span className="chip-sub">{t("theme")}</span>
					</>
				}
				tip={t("theme")}
				open={themeOpen}
				caret={false}
				onOpenChange={(v) => {
					setThemeOpen(v);
					// 挂载那次拉取若撞上服务端重启会扑空：打开时列表还空就补拉一次
					if (v && themes.length === 0) reloadThemes();
				}}
			>
				{(() => {
					const classics = themes.filter((th) => th.group === "classic");
					const builtins = themes.filter((th) => th.group !== "classic");
					const themeLabel = (th: (typeof themes)[number]) => {
						const base = isZhLocale(locale) ? th.name : (th.nameEn ?? th.name);
						// 括号后缀必须走 i18n：themeLight/themeDark 已经在 zh/en + 各语言包里
						// 备好（与 themeDefault 的「深色（默认）」/「Dark (default)」同一套约定），
						// 写死中文全角括号会让其它语言看到中英混排。
						const scheme = th.scheme === "light" ? t("themeLight") : th.scheme === "dark" ? t("themeDark") : "";
						if (!scheme) return base;
						return isZhLocale(locale) ? `${base}（${scheme}）` : `${base} (${scheme})`;
					};
					return (
						<>
							{classics.length > 0 && (
								<>
									<div className="dd-header">{t("themeGroupClassics")}</div>
									{classics.map((th) => (
										<DropdownItem
											key={th.id}
											active={theme === th.id}
											onClick={() => {
												onThemeChange(th.id);
												setThemeOpen(false);
											}}
										>
											{themeLabel(th)}
										</DropdownItem>
									))}
								</>
							)}
							<div className="dd-header">{classics.length > 0 ? t("themeGroupBuiltin") : t("theme")}</div>
							<DropdownItem
								active={theme === null}
								onClick={() => {
									onThemeChange(null);
									setThemeOpen(false);
								}}
							>
								{t("themeDefault")}
							</DropdownItem>
							{builtins.map((th) => (
								<DropdownItem
									key={th.id}
									active={theme === th.id}
									onClick={() => {
										onThemeChange(th.id);
										setThemeOpen(false);
									}}
								>
									{themeLabel(th)}
								</DropdownItem>
							))}
						</>
					);
				})()}
			</Dropdown>
		),
		"host:update": managed ? (
			<span className="chip" data-tip={t("updatesManaged")}>
				<FiDownload />
				<span className="chip-sub">v{appVersion ?? chat.update?.current ?? "…"}</span>
			</span>
		) : (
			<Dropdown
				trigger={
					<>
						<FiDownload />
						<span className="chip-sub">v{chat.update?.current ?? "…"}</span>
						{chat.update && !chat.update.upToDate && (
							<span
								className="update-dot"
								title={t("updateAvailable", {
									version: chat.update.latest ?? "",
								})}
							/>
						)}
						{updatesCount > 0 && <span className="update-badge">{t("updatesAllBadge", { n: updatesCount })}</span>}
					</>
				}
				tip={t("update")}
				open={updateOpen}
				caret={false}
				onOpenChange={(v) => {
					setUpdateOpen(v);
					if (v) {
						appSend({ type: "check_update" });
						appSend({ type: "check_updates_all" });
					}
				}}
				fit
			>
				<div className="dd-header">{t("update")}</div>
				{renderUpdateBody()}
				{renderAllUpdatesBody()}
			</Dropdown>
		),
		"host:conn": (
			<span className="chip" data-tip={chat.status}>
				<span className={`status-dot ${chat.status === "open" ? "ok" : "busy"}`} />
				<span className="chip-sub">{chat.status}</span>
			</span>
		),

		"host:ctx": (
			<span className="chip" data-tip={t("contextUsage")}>
				<span className="chip-sub">
					{(chat.state?.stats?.contextUsage?.tokens ?? 0) > 0
						? `${chat.state?.stats?.contextUsage?.tokens}`
						: t("contextUsage")}
				</span>
			</span>
		),
		"host:cost": (() => {
			const chipCost = formatCostDisplay(chat.state?.stats?.cost ?? 0, { fixedDigits: 4 });
			return (
				<span className="chip" data-tip={chipCost.tooltip || t("cumulativeCost")}>
					<span className="chip-sub">
						{chipCost.symbol}
						{chipCost.value}
					</span>
				</span>
			);
		})(),
		"host:cwd": (
			<button
				type="button"
				className="chip"
				data-tip={chat.state?.cwd ?? ""}
				onClick={() => {
					if (cwdClickTimerRef.current !== null) {
						window.clearTimeout(cwdClickTimerRef.current);
						cwdClickTimerRef.current = null;
					}
					cwdClickTimerRef.current = window.setTimeout(() => {
						setProjectPickerOpen(true);
						cwdClickTimerRef.current = null;
					}, 220);
				}}
				onDoubleClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					if (cwdClickTimerRef.current !== null) {
						window.clearTimeout(cwdClickTimerRef.current);
						cwdClickTimerRef.current = null;
					}
					appSend({ type: "new_chat" });
					focusComposer();
				}}
			>
				<FiFolder />
				<span className="chip-sub">{chat.state?.cwd?.split(/[/\\]/).pop() || chat.state?.cwd}</span>
			</button>
		),
	};

	/** 桌面工具 chips 的可见性历史口径（不扩大）：只有 search / tasks / settings 这几个成员
	 *  的显隐还受 PI_WEB_TABS 白名单管（服务端会拒绝对应的消息，画出来只会给一个点了没反应用的按钮）。 */
	const TABS_GATED_IDS = new Set(["host:search", "host:tasks", "host:settings"]);
	/** 溢出菜单里**整块搬进来**的宿主条目（菜单型：下拉/外链/自带面板）。
	 *  其余宿主条目（history / files / new-chat / search / tasks / settings）在菜单里是一条扁平
	 *  菜单项，由 dispatchHostOverflow 分派到本地处理器 —— 扁平的更像菜单，整块的才需要搬组件。 */
	const OVERFLOW_AS_NODE_IDS = new Set(["host:language", "host:theme", "host:update"]);
	/** TABS 白名单门禁（历史口径，不扩大）：search/tasks/settings 的显隐还受白名单管，
	 *  其余宿主入口只看 slot（各节点工厂内部自行判断，见 hostNodes）。 */
	const isTabGatedOff = (id: string) => TABS_GATED_IDS.has(id) && !tabOn(id.slice("host:".length));
	/**
	 * 最终要画的条目，**按 slot 顺序**（= 布局页里看到的顺序）：
	 * 宿主条目查节点工厂；门禁（TABS 白名单 / 视图门禁）不满足或节点工厂
	 * 返回 null 的条目**不占位**。这就是顶栏的全部内容 —— 没有第二阶段的分组/重排。
	 */
	const flowItems: { id: string; entry: UiSlotEntry | null; node: ReactNode }[] = [];
	for (const it of topEntries) {
		if (it.entry?.hidden) continue; // uiPrimary 已滤过 hidden；这里只防脏数据
		if (isTabGatedOff(it.id) || isCapabilityGatedOff(it.id)) continue;
		let node: ReactNode = null;
		if (it.entry) {
			node = (
				<BarItem
					key={it.id}
					entry={it.entry}
					bar="top"
					chat={chat}
					view={view}
					onViewChange={onViewChange}
					onOpenPanel={onOpenPanel}
					onOpenSettings={onOpenSettings}
					onOpenGlobalSearch={onOpenGlobalSearch}
					onOpenBgTasks={onOpenBgTasks}
					onOpenProjectPicker={() => setProjectPickerOpen(true)}
					isProjectPickerOpen={projectPickerOpen}
					onUiAction={onUiAction}
					uiContextEntries={uiContextTopbar}
					onOpenSandboxModal={onOpenSandboxModal}
					dropdownProps={{
						theme,
						themes,
						onThemeChange,
						reloadThemes,
						onLocaleModalOpen: () => setLocaleModalOpen(true),
						renderUpdateBody,
						renderAllUpdatesBody,
						updatesCount,
						managed,
						appVersion,
					}}
				/>
			);
		} else if (it.id.startsWith("host:") && hostNodes[it.id]) {
			node = hostNodes[it.id];
		}
		if (!node) continue;
		flowItems.push({ id: it.id, entry: it.entry, node });
	}
	/** 条目自己的对齐段（脏值回落 start，与合并引擎同口径）。 */
	const zoneOf = (it: { entry: UiSlotEntry | null }): "start" | "center" | "end" => it.entry?.align ?? "start";
	/** 本断点放不下的条目（实测宽度算出来的，见 web/src/topbar-fit.ts）：退进「⋯」菜单。 */
	const [droppedIds, setDroppedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
	const flowRef = useRef<HTMLDivElement>(null);
	/** 条目宽度缓存（id → 实测 px）。被丢进溢出的条目已不在 DOM 里、量不到宽度 —— 用上一次的
	 *  实测值，窗口变宽时它们才能按真实宽度回来（否则会「一旦被丢就再也回不来」）。 */
	const widthCacheRef = useRef(new Map<string, number>());
	/** 桌面与手机同一套实测溢出：放不下的条目（droppedIds）退进「⋯」，放得下全留
	 *  （手机端不再按名单强制折叠 —— 搜索等能放下就直接显示）。 */
	const keptItems = flowItems.filter((it) => !droppedIds.has(it.id));
	/** 手机端固定位（MOBILE_ASIDE_TOPBAR_IDS）：移出主直流、渲染在 ⋯ 右边最右，
	 *  不参与实测溢出。桌面端为空，直流保持单一扁平（slot 顺序直排，不动）。 */
	const mobileAsideItems = isMobile ? keptItems.filter((it) => MOBILE_ASIDE_TOPBAR_IDS.has(it.id)) : [];
	/** 主直流里实际渲染的条目（手机端 = kept 去掉固定位）。 */
	const flowKeptItems = isMobile ? keptItems.filter((it) => !MOBILE_ASIDE_TOPBAR_IDS.has(it.id)) : keptItems;
	/** 实测与溢出的视觉顺序（左段→中段→右段，段内仍是 slot 顺序）：渲染层按这个顺序落位，
	 *  fitTopbar 必须吃同样顺序才能做到「从视觉最右边开始收」。直接喂 slot 顺序会在
	 *  align 混排时把视觉左边的条目先丢掉 —— 窄屏下排第 2 的都可能进 ⋯。手机端固定位
	 *  （📁 挂在直流外面，不占直流宽度）同样不参与实测。 */
	const fitBase = isMobile ? flowItems.filter((it) => !MOBILE_ASIDE_TOPBAR_IDS.has(it.id)) : flowItems;
	const visualAll = [
		...fitBase.filter((it) => zoneOf(it) === "start"),
		...fitBase.filter((it) => zoneOf(it) === "center"),
		...fitBase.filter((it) => zoneOf(it) === "end"),
	];
	/** 直流子节点（已滤掉 spacer）就是按这个顺序排的，宽度缓存必须按它一一对应 ——
	 *  按 slot 顺序对应会在混排时把别人的宽度记到自己名下。 */
	const keptVisual = visualAll.filter((it) => !droppedIds.has(it.id));
	// 审查 #6：measure 被 ResizeObserver 的 effect 捕获（只在 measureKey 变化时重建），
	// 闭包里的 visualAll/keptVisual 会过期。条目集挂 ref，measure 一律读 ref ——
	// RO 回调永远量到当前渲染的条目（ref 同步声明在 measure 的 layout effect 之前，
	// 保证同一次提交里先更新再测量）。
	const visualAllRef = useRef(visualAll);
	const keptVisualRef = useRef(keptVisual);
	useLayoutEffect(() => {
		visualAllRef.current = visualAll;
		keptVisualRef.current = keptVisual;
	});
	const measure = () => {
		const flow = flowRef.current;
		// jsdom / 未挂载（没有 ResizeObserver）：不丢任何条目 —— 宁可全画，也不清空顶栏。
		if (!flow || typeof ResizeObserver === "undefined") return;
		const kids = Array.from(flow.children).filter((el) => !el.classList.contains("tb-spacer"));
		// 每个条目恰好渲染一个元素（宿主条目都是单根元素）；数量对不上就不猜了 —— 全保留。
		// 手机端固定位（📁）挂在直流外面：只比对直流内的条目数（keptVisual）。
		const kept = keptVisualRef.current;
		if (kids.length === kept.length) {
			kept.forEach((it, i) => widthCacheRef.current.set(it.id, (kids[i] as HTMLElement).offsetWidth));
		}
		for (const child of kids) {
			const el = child as HTMLElement;
			if (
				el.offsetWidth > 0 &&
				flow.clientWidth > 0 &&
				el.offsetLeft + el.offsetWidth / 2 < Math.min(220, flow.clientWidth / 2)
			) {
				el.setAttribute("data-tip-align", "right");
			} else {
				el.removeAttribute("data-tip-align");
			}
		}
		const gap = Number.parseFloat(getComputedStyle(flow).columnGap) || 0;
		// 「⋯」按钮是流容器的**兄弟**节点：flex 已经把它占的宽度从 clientWidth 里扣掉了，
		// 所以这里不用为它预留（reserve = 0）。没有 slot 元数据的条目（回退模式）不参与溢出
		// （宽度传 0 = 不可丢），否则菜单里会出现画不出来的幽灵项。
		// 极窄屏下放不下的视觉尾部条目退进溢出，而不是把顶栏撑成两行。
		const fitInput = visualAllRef.current;
		const next = fitTopbar(
			fitInput.map((it) => ({ id: it.id, width: it.entry ? (widthCacheRef.current.get(it.id) ?? 0) : 0 })),
			flow.clientWidth,
			gap,
			0,
			REQUIRED_TOPBAR_ITEM_IDS,
		);
		setDroppedIds((prev) => (prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next));
	};
	// 条目集合 / 文案 / 视图 / 语言 / 断点变了就重算一次（绘制前实测，用户看不到中间态）；窗口尺寸变化由
	// 下面的 ResizeObserver 兜。**不**随快照流每次渲染都量（那会变成 60ms 一次的强制重排）。
	const measureKey = `${keptItems.map((it) => `${it.id}:${it.entry?.label ?? ""}`).join("|")}|${view}|${(
		chat.tabs ?? []
	).join(",")}|${isMobile ? "m" : "d"}`;
	useLayoutEffect(measure, [measureKey]); // eslint-disable-line react-hooks/exhaustive-deps
	useEffect(() => {
		const flow = flowRef.current;
		if (!flow || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => measure());
		ro.observe(flow);
		return () => ro.disconnect();
	}, [measureKey]); // eslint-disable-line react-hooks/exhaustive-deps
	/** 三段落位（段内仍是 slot 顺序 → 布局页 ↑↓ 的效果与界面一致；手机端固定位不在直流里）。 */
	const segStart = flowKeptItems.filter((it) => zoneOf(it) === "start");
	const segCenter = flowKeptItems.filter((it) => zoneOf(it) === "center");
	const segEnd = flowKeptItems.filter((it) => zoneOf(it) === "end");
	/** 溢出菜单 = 被隐藏/常驻条目 ＋ 本断点放不下的条目（同一个「⋯」，手机上也只有一个入口）。
	 *  顺序与顶栏视觉一致（左→中→右，段内按 slot 顺序），见 sortOverflowMenuItems。 */
	const droppedEntries = flowItems.filter((it) => droppedIds.has(it.id) && it.entry).map((it) => it.entry!);
	const slotRank = new Map<string, number>();
	[...(uiPrimary ?? []), ...(uiOverflow ?? [])].forEach((e, i) => {
		if (!slotRank.has(e.id)) slotRank.set(e.id, i);
	});
	const overflowMenuItems = sortOverflowMenuItems(
		[...pinnedOverflowItems, ...droppedEntries],
		(id) => slotRank.get(id) ?? 999999,
	);

	/** 溢出菜单行首的图标字：只认「非拉丁字母」的（emoji / 符号）—— 拉丁词表名
	 *  （如 "mic"）当图标画出来是乱码，直接当标签文字用。抽成函数是因为 select 行
	 *  与扁平行两处都要判，且要拿到同一个字形去渲染成独立的图标格（见菜单里的
	 *  「图标槽」CSS：图标独占一格，文字左缘才对得齐）。 */
	const menuIcon = (it: UiSlotEntry): string | null => (it.icon && !/[a-z]/i.test(it.icon) ? it.icon : null);

	// 顶栏按钮文字总开关（设置 → 界面布局 → 顶栏，默认开）：关掉后顶栏只剩图标
	// （数字角标保留；溢出菜单里仍带文字；实现见 styles.css 的 .topbar.no-labels）。
	const hideTopbarText = chat.settings?.uiLayout?.topbarText === false;
	return (
		<header className={`topbar${hideTopbarText ? " no-labels" : ""}`} data-pi-anchor="topbar">
			{/* 单一扁直流：所有条目同级（没有按种类包裹的容器，也没有两端贴边的例外）。
			    两个 spacer 把条目分成 start / center / end 三段 —— 就是布局页里的「对齐方向」。 */}
			<div className="topbar-flow" ref={flowRef} role="toolbar" aria-label={t("viewSwitch")}>
				{segStart.map((it) => (
					<Fragment key={it.id}>{it.node}</Fragment>
				))}
				{(segCenter.length > 0 || segEnd.length > 0) && (
					<span
						className={`tb-spacer${segCenter.length === 0 && segEnd.length > 0 ? " tb-spacer-end" : ""}`}
						aria-hidden="true"
					/>
				)}
				{segCenter.map((it) => (
					<Fragment key={it.id}>{it.node}</Fragment>
				))}
				{segCenter.length > 0 && (
					<span className={`tb-spacer${segEnd.length > 0 ? " tb-spacer-end" : ""}`} aria-hidden="true" />
				)}
				{segEnd.map((it) => (
					<Fragment key={it.id}>{it.node}</Fragment>
				))}
			</div>
			{/* 溢出菜单现在只要**顶栏有东西**就常驻：它除了「隐藏/放不下的条目」，还兼着「编辑图标」
			    这个入口 —— 所有条目都放得下时把 ⋯ 藏掉，用户就再也进不了图标编辑了。
			    顶栏真的一条条目都没有时不画（没什么可编辑的，也不留空壳）。 */}
			{(overflowMenuItems.length > 0 || flowItems.length > 0) && (
				<div className="plugin-topbar-more">
					<button
						ref={moreBtnRef}
						type="button"
						className="plugin-topbar-item"
						aria-haspopup="menu"
						aria-expanded={topbarMenuOpen}
						aria-label={t("pluginTopbarMore")}
						data-tip={t("pluginTopbarMore")}
						onClick={() => setTopbarMenuOpen((v) => !v)}
					>
						<GoTriangleDown />
					</button>
					{/* issue #162：菜单 portal 到 body（fixed），不再挂在会被祖先 overflow 裁剪的容器里。 */}
					<TopbarOverflowMenu anchorRef={moreBtnRef} open={topbarMenuOpen} onClose={() => setTopbarMenuOpen(false)}>
						{overflowMenuItems.map((it) => {
							// 被隐藏的**宿主菜单型**条目（声音/语言/主题/版本/GitHub）：
							// 它们不是一次性动作，扁平按钮点了没意义 —— 把整块组件搬进溢出菜单，
							// 这样「隐藏」只是换了个位置，功能一点不少（与内建条目的实现留在组件内一致）。
							const asNode = it.source === "host" && OVERFLOW_AS_NODE_IDS.has(it.id) ? hostNodes[it.id] : undefined;
							if (asNode !== undefined) {
								return <Fragment key={it.id}>{asNode}</Fragment>;
							}
							// 折叠按钮保持折叠前样式（只统一宽度顶满菜单，不重绘成扁平行）：
							// 宿主走 hostNodes（与顶栏同一套 chip/tab/panel-toggle）。
							// 包一层关菜单（点后关 ⋯，与扁平行一致）。节点为 null（门禁/条件不满足，
							// 如终端视图里的 ☰）才回落扁平行，保证条目找得回来。
							if (it.source === "host") {
								const node = hostNodes[it.id];
								if (node) {
									return (
										<div key={it.id} className="plugin-topbar-menu-keep" onClick={() => setTopbarMenuOpen(false)}>
											{node}
										</div>
									);
								}
							}
							// kind="select" 在溢出菜单里同样落成下拉（label + select 一行）。
							if (it.kind === "select" && it.options?.length) {
								return (
									<label key={it.id} className="plugin-topbar-overflow-select tb-row" title={it.hint ?? it.label}>
										{/* 图标独占一格（.plugin-icon-glyph）；没有图标时由 CSS ::before 补同宽占位，
									    文字左缘才能和带图标的行对齐（见 styles.css「菜单行的图标槽」）。 */}
										{menuIcon(it) ? <span className="plugin-icon-glyph">{menuIcon(it)}</span> : null}
										<span className="tb-row-text">{it.label}</span>
										<select
											aria-label={it.label}
											value={it.options.some((o) => o.value === it.value) ? (it.value as string) : it.options[0]!.value}
											onChange={(e) => {
												setTopbarMenuOpen(false);
												if (!dispatchHostOverflow(it)) onUiAction?.(it, e.target.value);
											}}
										>
											{it.options.map((o) => (
												<option key={o.value} value={o.value}>
													{o.label}
												</option>
											))}
										</select>
									</label>
								);
							}
							return (
								<button
									key={it.id}
									type="button"
									role="menuitem"
									className="tb-row"
									title={it.hint ?? it.label}
									onClick={() => {
										setTopbarMenuOpen(false);
										// 宿主内置动作在本地分派（见 dispatchHostOverflow），其余交回 onUiAction。
										if (!dispatchHostOverflow(it)) onUiAction?.(it);
									}}
								>
									{menuIcon(it) ? <span className="plugin-icon-glyph">{menuIcon(it)}</span> : null}
									<span className="tb-row-text">{it.label}</span>
								</button>
							);
						})}
						{/* 图标编辑入口：拖动改四个栏的位置（见 components/IconEditor.tsx 与 ui-layout-edit.ts）。 */}
						<div className="tb-menu-divider" aria-hidden="true" />
						<button
							type="button"
							role="menuitem"
							className="tb-row"
							onClick={() => {
								setTopbarMenuOpen(false);
								onOpenIconEdit();
							}}
						>
							<FiEdit2 />
							<span className="tb-row-text">{t("uiIconEdit")}</span>
						</button>
					</TopbarOverflowMenu>
				</div>
			)}

			{/* 手机端固定位：📁 纯图标钉在 ⋯ 右边（整条顶栏最右），直流/溢出都不含它。 */}
			{mobileAsideItems.map((it) => (
				<Fragment key={it.id}>{it.node}</Fragment>
			))}

			{localeModalOpen && <LocaleModal onClose={() => setLocaleModalOpen(false)} />}
			{projectPickerOpen && (
				<ProjectPicker
					open
					currentCwd={cwd}
					pathCompletions={chat.pathCompletions ?? []}
					workspaceRoots={workspaceRoots}
					onClose={() => setProjectPickerOpen(false)}
					onSelectDirectory={(path) => appSend({ type: "set_cwd", path })}
					onCreateProject={(path) => appSend({ type: "make_dir", path, setAsCwd: true })}
				/>
			)}
		</header>
	);
}
