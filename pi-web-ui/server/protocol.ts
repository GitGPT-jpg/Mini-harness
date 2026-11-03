/**
 * Wire protocol between the browser client and the pi-web-ui server.
 * Pure JSON over WebSocket. The web frontend mirrors these types in
 * web/src/types.ts (kept in sync by hand — types only, no shared runtime code).
 */

// ---------------------------------------------------------------------------
// Serialized messages (server -> client snapshot)
// ---------------------------------------------------------------------------

export interface UiTextBlock {
	type: "text";
	text: string;
	truncated?: boolean;
}

export interface UiThinkingBlock {
	type: "thinking";
	thinking: string;
}

export interface UiToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	argumentsText?: string;
	argumentsTruncated?: boolean;
}

export interface UiImageBlock {
	type: "image";
	dataUrl?: string;
	mimeType?: string;
}

/** Live bash execution (the `!` command / bashExecution transcript message). */
export interface UiBashBlock {
	type: "bash";
	command: string;
	output: string;
	exitCode?: number;
	cancelled?: boolean;
	truncated?: boolean;
}

export type UiContentBlock =
	UiTextBlock | UiThinkingBlock | UiToolCallBlock | UiImageBlock | UiBashBlock | { type: string; [k: string]: unknown };

export interface UiMessage {
	/** Stable-ish id for React keys: u-<ts>-<seq> / a-<ts>-<seq> / t-<toolCallId>. */
	id: string;
	role: string;
	content: UiContentBlock[];
	timestamp?: number;
	model?: string;
	provider?: string;
	/** Assistant message usage cost in USD (from SDK usage.cost.total). */
	usageCost?: number;
	stopReason?: string;
	errorMessage?: string;
	/** Present on toolResult messages; links to the assistant message's toolCall block. */
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	/** Extension-injected custom messages. */
	customType?: string;
	/** Extension-provided metadata (e.g. attachment file name/path). Also carried on
	 *  toolResult messages (the tool's own `details`, ≤64KB or dropped — serialize.ts):
	 *  present_files' preview cards read kind/size/excerpt from it. */
	details?: unknown;
	/** Present on compactionSummary messages: context size (tokens) before
	 *  compaction — the card header renders "compacted from N tokens" like
	 *  the pi CLI. Absent on older snapshots. */
	tokensBefore?: number;
}

export interface UiModelInfo {
	id: string;
	name: string;
	provider: string;
	/** Whether the model accepts image input (SDK `input` includes "image"). */
	vision: boolean;
}

/** Platform service manager supervising this instance: someone restarts the
 *  process after it exits. Detected at boot by server/launch-origin.ts. */
export type ServiceSupervisor = "launchd" | "systemd" | "windows-watchdog";

/** How this instance was launched, when a supervisor manages it.
 *
 *  `pi-web-ui server start|install` registers a service (launchd / systemd /
 *  Windows watchdog launcher); the browser uses this to offer "restart
 *  service" in the UPDATE panel — meaningless for a foreground `pi-web-ui`
 *  or `npm run dev` instance, whose process would simply be gone. */
export interface UiServiceInfo {
	/** Service name (`server install --name`, default "pi-web-ui"). */
	name: string;
	supervisor: ServiceSupervisor;
}

export interface UiHostMetrics {
	cpuPercent: number | null;
	memoryPercent: number;
}

/**
 * 智能体底座能力声明契约（AgentEngineCapabilities）
 *
 * 作为当前底层引擎（Pi / DSH / 通用基座等）向宿主和前端声明的能力唯一事实源。
 * 前端依据此声明自适应开启、隐藏或降级对应交互入口（如远程 SSH、跨对话引用、计划模式等）。
 */
export interface AgentEngineCapabilities {
	/** 是否支持远程 SSH 目录连接与远程虚拟环境交互（SFTP + SSH2 PTY + 会话隔离） */
	remoteSsh: boolean;
	/** 是否支持工作区沙盒机制（创建/重置/持久化） */
	sandboxes: boolean;
	/** 智能体运行时是否原生感知额外工作区根（多根工作区） */
	workspaceRoots: boolean;

	/** 是否支持跨会话上下文引用（包含配套的 conversation_read 等工具按需回拉转录） */
	conversationRef: boolean;
	/** 是否支持富媒体文件展示卡片工具（present_files 等） */
	presentFiles: boolean;

	/** 是否支持计划模式硬拦截与任务看板驱动（Plan Mode） */
	planMode: boolean;
	/** 是否支持审查者自动委派模式（Delegate Mode） */
	delegateMode: boolean;
	/** 是否支持多任务子代理调度与生命周期管理（subagents / 模板库） */
	subagents: boolean;

	/** 是否支持在设置页逐工具微调提示词（Tool Prompt Overrides） */
	toolPromptOverride: boolean;
	/** 是否支持工具按需延迟加载（Lazy Loading / load_tools / 缓存前缀守卫） */
	lazyTools: boolean;
	/** 是否支持上下文动态软上限与压缩（Soft Cap） */
	softCap: boolean;

	/** 是否支持历史消息树状分叉与在此分叉重跑（Tree Fork） */
	treeFork: boolean;
	/** 是否支持就地修改历史用户消息并重新生成（Message Edit） */
	messageEdit: boolean;
	/** 是否支持单轮生成进行中的插话打断（Mid-run Steering）；false 时仅支持排队等待本轮结束（FollowUp） */
	steer?: boolean;
	/** 是否支持不落盘的临时探索对话（Ephemeral Chat） */
	ephemeralChat?: boolean;
}

/**
 * 支持的智能体底座引擎标识。
 */
export type EngineId = "pi";

export interface UiState {
	clientId: string;
	cwd: string;
	sessionId: string;
	sessionFile?: string;
	/** 当前底层智能体引擎的能力声明（Capabilities）。前端据此动态隐藏不支持的入口。 */
	engineCapabilities?: AgentEngineCapabilities;
	/** 额外工作区根（宿主侧多根，见 set_workspace_roots）：按项目（cwd）持久化。
	 *  AI 仍只在主 cwd 里干活（pi SDK 是单 cwd 模型）；右栏文件树可跨这些根浏览。
	 *  空数组/缺省 = 单根。DSH 引擎不提供该字段。 */
	workspaceRoots?: string[];
	/** 服务进程所在机器的用户主目录（wire 格式，`/` 分隔）：右栏 🏠 一键直达。
	 *  缺省/空串 = 旧服务（不提供）→ 前端不渲染 🏠。DSH 与 pi 双引擎都填。 */
	homeDir?: string;
	/** 桌面目录（wire 格式，同 homeDir 口径）：存在才提供，否则空串/缺省 → 前端不渲染 🖥️。
	 *  DSH 与 pi 双引擎都填。 */
	desktopDir?: string;
	/** Id of the ACTIVE conversation (see `conversations` message). */
	conversationId: string;
	/** 当前对话是临时对话（inMemory、不落盘、关闭即销毁；issue #285）。
	 *  提示条与「保存为正式对话」按钮读它 —— 不能改读 `conversations` 列表，
	 *  因为空白的临时对话不在那个列表里（刚新建时提示条必须就能看到）。 */
	isEphemeral?: boolean;
	/** 当前工作区若属于受管沙盒项目，携带其沙盒元数据（否则为 null/缺省）。 */
	sandbox?: SandboxInfo | null;
	/** 当前工作区关联的 Git 工作树元数据（不在 git 仓库或无工作树时为 null/缺省）。 */
	worktree?: WorktreeInfo | null;
	/** Monotonic snapshot revision — increments on every snapshot/snapshot_delta
	 *  emission. snapshot_delta.baseRev must equal the client's current rev;
	 *  a mismatch means the client missed an update and must get_state resync. */
	rev: number;
	messages: UiMessage[];
	/** 历史窗口起点（服务端按需加载，见 server/message-window.ts）：
	 *  `messages` 是本对话全量消息的一个**尾部窗口**，本字段是该窗口首条消息在
	 *  全量列表中的下标（0 = 窗口包含全部历史）。缺省 = 全量（引擎未做窗口化 /
	 *  窗口化关闭 / 老服务端）。 */
	historyStart?: number;
	/** 窗口覆盖到的全量消息总数——「还有 N 条更早消息」的计数基准。缺省 = 未知。 */
	historyTotal?: number;
	/**
	 * Live partial assistant message while a run is streaming. The SDK keeps the
	 * in-progress message in agent.state.streamingMessage — it only enters
	 * `messages` once the turn finishes (message_end). Null when idle.
	 */
	streamingMessage: UiMessage | null;
	isStreaming: boolean;
	model: UiModelInfo | null;
	thinkingLevel: string;
	/** DSH 当前会话的 Agent 预设（standard/ptc/minimal/cordis/自建；
	 *  pi 引擎不填。locked = 首轮后锁定，空白可切换）。 */
	agentPreset?: { id: string; name: string; locked: boolean } | null;
	/** DSH 当前会话的权限预设值（read-only/workspace-write-never/danger-full-access/custom；
	 *  pi 引擎不填。null = 运行时未就绪/legacy）。 */
	permission?: string | null;
	/**
	 * Thinking levels the CURRENT model actually supports (SDK clamps any
	 * request outside this set). The UI must only offer these — selecting an
	 * unsupported level silently snaps to a nearby one, which reads as "cannot
	 * change the level". Empty/absent → fall back to the full list.
	 */
	availableThinkingLevels: string[];
	/** Queued prompt TEXTS per conversation. steering = 插队（当前回合结算后
	 *  立即注入），followUp = 排队（整个 run 结束后才发送）。UI renders them
	 *  as pending user bubbles in the real message list. */
	queue: { steering: string[]; followUp: string[] };
	errorMessage?: string;
	/**
	 * Transient LLM auto-retry state — set while the SDK backs off and retries
	 *  a failed API call (agent_end willRetry → auto_retry_start → auto_retry_end).
	 *  While present the trailing stopReason=error assistant message is withheld
	 *  from `messages` (it only turns red permanently once retries are exhausted),
	 *  and the UI shows a calm "retrying…" hint instead of a flashing red error.
	 *  Absent/null when idle or on final failure.
	 */
	retry?: {
		/** 1-based attempt about to run (0 = announced by agent_end willRetry, details follow). */
		attempt: number;
		maxAttempts: number;
		delayMs: number;
		errorMessage: string;
	} | null;
	/**
	 * Context compaction in progress (compaction_start arrived, compaction_end
	 *  not yet). While present the UI shows a persistent "compacting…"
	 *  progress banner with elapsed time (a toast would auto-dismiss while
	 *  the summarization LLM call is still running). Absent/null when idle.
	 */
	compaction?: {
		/** Why compaction started: manual (/compact), threshold or overflow. */
		reason: string;
		/** Server-side start timestamp (ms) — drives the elapsed timer. */
		startedAt: number;
	} | null;
	/**
	 * 待用户回答的模型提问（ask_user_question）——对话框的服务端事实源。
	 *  `question_pending` 只在提问发生的那一刻推给「当前激活且匹配该会话」的连接；刷新页面 /
	 *  WS 重连 / 切换会话接入后本字段让快照把属于当前会话的对话框恢复出来（见 web/src/use-chat.ts
	 *  的 syncPendingQuestion）。
	 *  只携带当前对话的提问（切回原对话会重推快照，对话框随之回来）。
	 *  null / 缺省 = 当前对话没有待答提问。
	 */
	pendingQuestion?: UiPendingQuestion | null;
	/**
	 * 期待用户操作的建议按钮列表（由 action/suggest 内联标记产生）。
	 * 渲染在对话最底部，点击即作为用户消息直接发送。
	 * 用户发送新消息后清空。
	 */
	actionSuggestions?: UiActionSuggestion[] | null;
	/**
	 * 待用户审批的高危工具调用（Edit & Run 人机协同）。当前对话有待审批时携带，切会话/刷新恢复。
	 */
	pendingApproval?: UiToolApproval | null;
	/**
	 * 子代理同行交接协同关系链（Peer-to-Peer Handoff relationships: fromRunId -> toRunId）。
	 */
	subagentHandoffs?: Array<{ fromRunId: string; toRunId: string; timestamp: number }>;
	/**
	 * 当前会话的任务计划看板状态（Plan Mode / Step State Machine）。
	 */
	plan?: PlanState | null;
	/**
	 * 当前会话的 mini-harness Loop 状态（受控代码/LLM Loop 运行时，server/loop/）。
	 *  - kind="run"：run 已落盘（D-12-2 起服务端点启动即建 run，之后每次落盘事件驱动刷新）；
	 *  - kind="request-failed"：启动失败（服务端建 run 被拒，如 goal 为空 / 同会话已有活跃 run，带 reason）；
	 *  - kind="pending"：旧流程（模型调 loop_start 之前）的挂起记录，服务端已不再产出。
	 *  null/缺省 = 该会话没有进行中的 Loop。createdAt 起 UI 可算耗时。
	 */
	loop?: LoopUiState | null;
	/**
	 * 当前会话是否处于计划模式（只规划不实施）。会话级开关，随快照下发；
	 * 缺省 = false。会话无内容时恒为 false（新建对话不带过来）。
	 */
	planMode?: boolean;
	/** 审查者模式（自动委派）已开：主对话只审阅，用户请求由服务端转给
	 *  一个常驻落盘执行对话执行（会话级开关，默认关）。 */
	delegateMode?: boolean;
	/** 审查者模式下的常驻执行对话 id（供 UI 「打开执行对话」用；null/缺省 = 还没建）。 */
	delegateConvId?: string | null;
	/**
	 * 当前对话的未发送输入框草稿（issue #166，单中心文件方案）。
	 *  只在**全量快照**里携带（切会话 / new_chat / get_state）：增量
	 *  snapshot_delta 永远不带 —— 同一标签页的草稿本来就是自己打的，不需要
	 *  每 60ms 回显；刷新/重连/切会话时的那次全量快照负责恢复。
	 *  null / 缺省 = 当前会话没有存过的草稿。pi 引擎独有（DSH 不填）。
	 */
	draft?: { text: string; ts: number } | null;
	tools: string[];
	/** Monotonic snapshot sequence — clients can use it to drop stale snapshots. */
	version: number;
	/**
	 * Whether the pi agent has at least one usable model. The SDK resolves
	 * models.json together with auth.json, environment credentials, OAuth, and
	 * runtime API-key overrides. False → offer the one-time setup flow.
	 */
	piConfigured: boolean;
	/**
	 * Whether the pi CLI binary is installed and runnable (`pi --version`
	 * probe). True → the setup modal skips the install step and offers the
	 * API key form directly; false → offer auto-install first.
	 */
	piAgentInstalled: boolean;
	/** Live session stats for the footer status bar. */
	stats: {
		totalMessages: number;
		tokens: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
		cost: number;
		contextUsage: {
			tokens: number | null;
			contextWindow: number;
			percent: number | null;
			/** 遗留字段：现恒为 false（服务端所有分支——含压缩回填——都按当前配置实时
			 *  算出 tokens/percent，不再有「约数」态），前端已不读。保留只为旧客户端兼容。 */
			estimated?: boolean;
			/** 当前模型的生效压缩软上限（tokens；null = 关闭，底栏不画标记线）。 */
			softCap?: number | null;
		};
	};
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

/** A user-defined command shown in the terminal command list (.pi/commands.json). */
export interface CommandDef {
	name: string;
	/** Shell command to run in the terminal. */
	command: string;
	/** Working directory; supports ${pwd} (= the agent's current workspace dir). */
	cwd?: string;
}

/** Metadata for a persistent PTY owned by one conversation. */
export interface TerminalInfo {
	id: string;
	title: string;
	cwd: string;
	cols: number;
	rows: number;
	running: boolean;
	exitCode: number | null;
	/** Command that started this terminal, when it came from the command list. */
	command?: CommandDef;
	/** true = 终端接管 bash 的持久终端（'ai-bash'）：不计入终端数量上限，
	 *  前端把它单独归到「AI bash」折叠分组里。缺省 false = 用户终端。 */
	agentBash?: boolean;
}

/** A slash command available in the chat input (the web counterpart of the
 *  pi CLI's "/" command menu). Names carry no leading slash. */
export interface SlashCommandInfo {
	/** Invokable command name without the leading slash (e.g. "new",
	 *  "skill:review", "templatename"). Extension collisions with builtin
	 *  names are suffixed by the SDK ("new:2"), like the CLI. */
	name: string;
	description?: string;
	descriptionEn?: string;
	/** Argument placeholder shown in the picker (e.g. "<路径>", "[说明]"). */
	argumentHint?: string;
	argumentHintEn?: string;
	/** Where the command comes from: web-native builtin / SDK extension /
	 *  prompt template / skill. */
	source: "builtin" | "extension" | "prompt" | "skill";
}

/** Attachment spec shared by "prompt" and "edit_message" client messages:
 *  workspace-path attachments (reference/lines), raw pasted/dropped images
 *  (imageData) and raw uploaded files (fileData). Files are never injected into the prompt — the model gets a
 *  path reference and reads on demand. */
/** 用户选中的消息原文；发送后保留副本，避免来源消息变化影响引用。 */
export interface TextQuote {
	text: string;
	messageId: string;
	role: string;
	sessionId?: string;
}

export interface PromptAttachment {
	/** Workspace path — except for mode "conversation", where it is unused
	 *  ("") — the reference travels in conversationId/sessionPath instead. */
	path: string;
	/** "reference" = path-only aside（默认；文件内容不进 prompt）。
	 *  "lines" = same reference plus the 1-based inclusive range the user picked.
	 *  "inline" = LEGACY alias of "reference"（旧客户端/旧草稿会发它，服务端不再
	 *  注入内容，按 reference 处理）。
	 *  "conversation" = another conversation quoted by the user (left-panel
	 *  right-click / global-search quote): the server emits a small
	 *  <conversation-ref> aside pointing at it, and the model fetches the
	 *  transcript on demand with the conversation_read tool. */
	mode?: "inline" | "reference" | "lines" | "conversation" | "quote";
	/** mode "quote"：path 留空，引用原文和来源保存在 quote。 */
	quote?: TextQuote;
	/** mode "conversation" + 引用运行中对话：conversation id（如 "c3"，含子代理）。 */
	conversationId?: string;
	/** mode "conversation" + 引用历史会话：会话转录文件 path（左栏历史行 / 全局搜索）。 */
	sessionPath?: string;
	/** 1-based inclusive line range (mode "lines" only). */
	lines?: { start: number; end: number };
	/**
	 * Raw image data (base64, no data: prefix) for images pasted, dropped or
	 * uploaded directly in the browser — no workspace path involved. When
	 * present the server sends it to the model as image content and ignores
	 * path/mode.
	 */
	imageData?: string;
	/**
	 * Raw uploaded file bytes (base64, no data: prefix) for files dropped/
	 * uploaded directly in the browser — no workspace path involved. The
	 * server persists them under the data dir and attaches the absolute
	 * path as a reference (never inlined).
	 */
	fileData?: string;
	/**
	 * Absolute path of a previously-UPLOADED file (fileData) that was
	 * persisted under the data dir's uploads/ folder. When the browser
	 * restores an uploaded file while editing & re-asking a question it
	 * re-sends the server-generated upload path instead of the original
	 * base64 — the server re-reads the bytes from disk (no base64
	 * round-trip / snapshot bloat). Mutually exclusive with imageData /
	 * fileData / path.
	 */
	uploadPath?: string;
	mimeType?: string;
	/** Display name for the attachment card (filename, or "粘贴图片.png"). */
	name?: string;
	/** Decoded byte size, for the card's size hint. */
	size?: number;
}

export type ClientMessage =
	| { type: "hello"; clientId: string; protocolVersion?: number; locale?: string }
	/** Browser UI language changed (or first report after hello) — server
	 *  persists it per client and uses it for tool return values / AI-facing
	 *  prompts. "zh" (zh-CN/…) → Chinese; anything else → English
	 *  (English default, issue #91). */
	| { type: "set_locale"; locale: string }
	/** Re-request the slash-command catalog (also pushed on attach / cwd change). */
	| { type: "get_commands" }
	| {
			type: "prompt";
			text: string;
			/**
			 * While the agent is streaming: queue this prompt and deliver it after
			 * the WHOLE run finishes (followUp) instead of steering (injecting it
			 * right after the current turn settles, skipping remaining tool calls).
			 * The 补充 (supplement) button sends queue=true; plain Enter keeps the
			 * steer semantic.
			 */
			queue?: boolean;
			attachments?: PromptAttachment[];
	  }
	// -- queued prompt management ---------------------------------------------
	/** Remove ONE queued prompt (steer = 插队, followUp = 排队) — the
	 *  ✕ delete button on a pending user bubble. `index` is the bubble's position
	 *  in the snapshot queue the user clicked (identity); `text` is a fallback
	 *  for old clients. Removes the item AT `index` when it still holds `text`,
	 *  else the FIRST occurrence of `text`, and pushes a fresh snapshot so the
	 *  bubble disappears immediately. */
	| {
			type: "queue_remove";
			kind: "steer" | "followUp";
			text: string;
			/** Bubble position in queue.steering / queue.followUp. Optional: old
			 *  clients send text only (first-occurrence fallback). */
			index?: number;
	  }
	// -- unsent composer draft (issue #166, 单中心文件方案) -------------------------
	/** Save the current unsent composer text for the ACTIVE conversation
	 *  (server keys it by sessionId in <dataDir>/composer-drafts.json).
	 *  Debounced client-side; empty text deletes the stored draft. The server
	 *  clears it when a prompt is accepted, and replays it in full snapshots
	 *  (switch/get_state) so refresh/reconnect restores the composer. */
	| {
			type: "draft_update";
			/** 归属会话（uuidv7）：切会话时的「离开刷盘」晚于服务端切换到达，
			 *  不能按 active 会话落键，必须自带 id。 */
			sessionId: string;
			text: string;
			ts: number;
	  }
	// -- terminal ------------------------------------------------------------
	| {
			type: "terminal_create";
			terminalId: string;
			title?: string;
			/** UI locale ("zh" | "en") — server picks the exit-banner language. */
			locale?: string;
			cwd: string;
			cols: number;
			rows: number;
			/** Optional because old UI clients target the active conversation. */
			conversationId?: string;
			/** true = AI bash terminal (terminal-bash takeover). The client echoes it
			 *  back when it re-creates an exited terminal so the rebuilt one keeps its
			 *  identity (issue #147: without it, AI terminals were reborn as user
			 *  terminals and blew the 16-slot cap). Absent = false; the server also
			 *  inherits the prior value from history for old clients. */
			agentBash?: boolean;
	  }
	| { type: "terminal_input"; terminalId: string; data: string; conversationId?: string }
	| { type: "terminal_resize"; terminalId: string; cols: number; rows: number; conversationId?: string }
	| { type: "terminal_kill"; terminalId: string; conversationId?: string }
	| { type: "rename_terminal"; terminalId: string; title: string; conversationId?: string }
	// Runs a command in a new shell; if the terminal already exists it is
	// RESTARTED in place (current process killed, fresh shell runs it again).
	| {
			type: "run_command";
			terminalId: string;
			command: CommandDef;
			cols: number;
			rows: number;
			conversationId?: string;
	  }
	// Re-discover extensions/skills/prompt templates from disk after an
	// external change (e.g. `pi remove npm:<pkg>` finished in the terminal).
	// Streaming-safe: deferred to agent_end while a run is in flight.
	| { type: "extensions_reload" }
	// -- command list (.pi/commands.json) ------------------------------------
	| { type: "list_commands" }
	| { type: "save_commands"; commands: CommandDef[] }
	| { type: "abort" }
	/** Kill only the running bash command(s) — the agent run itself continues. */
	| { type: "abort_bash" }
	/** Manually retry the last failed model call after the auto-retry budget
	 *  (settings retryMaxAttempts) ran out: the turn ended with a red error
	 *  and is idle. Server re-triggers one LLM turn without adding a new user
	 *  message; refused while streaming. */
	| { type: "retry_last" }
	// -- background tasks (AI-started servers) ------------------------------
	/** Kill ONE background server the agent started (by listening port). */
	| { type: "kill_background_server"; port?: number }
	/** Kill EVERY background server the agent started (frees all ports). */
	| { type: "kill_background_servers" }
	/** Re-push the current background-server list (the server also refreshes it
	 *  on its own and prunes entries whose process exited). */
	| { type: "list_bg_servers" }
	/** 钉住 / 取消钉住一个后台实例（自动清理跳过钉住的）。仅端口条目有效；
	 *  端口不在列表里时服务端回一条 info 通知，不报错。 */
	| { type: "set_bg_keep"; port: number; keep: boolean }
	/** 立即按策略清一次遗留实例（未钉住且闲置超阈值的那些）。
	 *  `minutes` 可覆盖阈值（>0 生效；缺省用设置里的策略，策略为关时兼底 30 分钟）——
	 *  面板发当前选中值，运维/脚本也能拿它驱一个任意阈值。 */
	| { type: "clean_bg_leftovers"; minutes?: number }
	/** Global-search recursive filename match across the active workspace.
	 *  Server-side bounded walk; reqId echoes back in search_files_result. */
	| { type: "search_files"; reqId: number; query: string }
	/** Global-search conversation-content match across this workspace's
	 *  persisted session transcripts — every user AND assistant message,
	 *  AI output included. reqId echoes back in session_search_results. */
	| { type: "search_sessions"; reqId: number; query: string }
	/** 历史窗口按需加载（服务端窗口化，见 server/message-window.ts）：把当前对话的
	 *  消息窗口往前扩一页，服务端回 `earlier_messages`（新增的更早一段，客户端前插）。
	 *  `count` 缺省 = 一页；`all: true` = 一路拉到最早（「全部展开」/ 打开页内搜索）。
	 *  `conversationId` 指明要翻页的会话（多标签/后台流式时 lastConversationId 不可靠）；
	 *  缺省时回退服务端最近一次快照的会话（老客户端兼容）。
	 *  窗口化关闭或服务端未实现时该消息被忽略（无回执），前端保持现状。 */
	| { type: "load_earlier_messages"; count?: number; all?: boolean; conversationId?: string }
	| { type: "new_chat"; preset?: string; ephemeral?: boolean }
	/** Edit a past user question and re-ask it (forks a new session at that point). */
	| {
			type: "edit_message";
			messageId: string;
			text: string;
			/**
			 * Attachments to send along with the re-asked question. The editor
			 * pre-fills it with the original message's attachments (images →
			 * imageData, uploaded files → uploadPath, workspace paths →
			 * path+mode; fork drops the persisted attachment asides — they live
			 * on the old branch, past the fork point) and accepts newly
			 * pasted/dropped images and files.
			 */
			attachments?: PromptAttachment[];
	  }
	/** 从历史消息中的指定位置派生新分支会话（Session Fork） */
	| {
			type: "fork_session";
			messageId: string;
			/** "before" 截取该消息之前（默认）；"at" 包含该消息及之前 */
			position?: "before" | "at";
			conversationId?: string;
	  }
	/** 回滚会话至指定消息检查点（丢弃后续轮次，在当前会话继续）。 */
	| {
			type: "rollback_session";
			messageId: string;
			conversationId?: string;
			/** 是否联动还原工作区文件至该检查点时刻（Dual-State Rollback） */
			restoreWorkspace?: boolean;
	  }
	| { type: "get_state" }
	/** 按需取一条工具定义（工具卡右键菜单 → 「显示工具详细信息」）。定义是静态大对象，
	 *  不进快照（否则每次节流推送都要重传一遍），改为点开时现取一次；
	 *  应答 `tool_info`。引擎不支持枚举工具定义时回 `unsupported: true`。 */
	| { type: "get_tool_info"; name: string }
	/** 设置页逐工具编辑文案时取「默认值 + 当前覆盖」（同 get_tool_info，但不弹工具定义弹窗）。
	 *  应答 `tool_prompt`。 */
	| { type: "get_tool_prompt"; name: string }
	| { type: "list_sessions" }
	| { type: "switch_session"; path: string; sessionId?: string }
	| { type: "switch_conversation"; id: string }
	/** 手动过户：把另一处（elsewhere 行，owner/convId 标识）的对话整体搬到本页
	 *  （含等答复的问卷/页调用），搬完自动切过去. */
	| { type: "take_over_conversation"; owner: string; id: string }
	/** 跨页作答预告请求：把另一处的等答复问卷原文取回本页展示（id = 对方 convId）。
	 *  回答仍经 question_answer（带 owner）回去，不搬迁对话. */
	| { type: "peek_elsewhere_question"; owner: string; id: string }
	| { type: "list_projects" }
	/** Read a workspace file for the preview panel (size-capped, binary-safe). */
	| { type: "read_file"; path: string }
	/** Save text edited in the file preview panel. */
	| { type: "write_file"; path: string; text: string }
	/** 在系统资源管理器中定位（issue #187）：文件→打开目录并选中，目录→直接打开。
	 *  只读操作，保护根也允许；远端/headless 主机上服务端会回 warning notice。 */
	| { type: "file_reveal"; path: string }
	/** 用系统默认应用打开文件（issue #187）：仅文件，目录请用 file_reveal。 */
	| { type: "file_open_default"; path: string }
	| { type: "list_models" }
	| { type: "set_model"; modelId: string }
	/** 设全局默认模型（"provider/id"）：无项目记忆的新项目回落到它（项目记忆优先）。
	 *  服务端回 default_model 广播；pi 引擎专有。 */
	| { type: "set_default_model"; modelId: string }
	/** 清除全局默认模型（新项目回落到 SDK 默认）。 */
	| { type: "clear_default_model" }
	| { type: "set_thinking"; level: string }
	| { type: "set_cwd"; path: string }
	| { type: "complete_path"; path: string }
	/** Create a folder for the cwd picker (absolute, ~- or session-relative).
	 *  The server answers with a notice (success/failure) — the picker
	 *  refreshes its own listing afterwards. When setAsCwd is true, switches cwd to it atomically. */
	| { type: "make_dir"; path: string; setAsCwd?: boolean }
	| { type: "dialog_response"; id: number; value: string | boolean | null }
	/** Send terminal input keystrokes to an active TUI overlay component. */
	| { type: "tui_overlay_input"; id: number; data: string }
	/** Notify server that TUI overlay dimensions changed. */
	| { type: "tui_overlay_resize"; id: number; cols: number; rows: number }
	/** Cancel / close an active TUI overlay from the client side. */
	| { type: "tui_overlay_cancel"; id: number }
	// -- self-update ----------------------------------------------------------
	/** Check the npm registry for a newer pi-web-ui version. */
	| { type: "check_update" }
	| { type: "check_updates_all"; force?: true } // webui + direct pi extensions (manifest)
	/** Restart the supervised service (same effect as `pi-web-ui server restart`:
	 *  this process exits and its supervisor brings it back). The server refuses
	 *  when no supervisor manages this instance (foreground / dev / Docker). */
	| { type: "restart_service" }
	// -- pi agent setup ------------------------------------------------------
	/** Auto-install the pi agent (mkdir config dir + npm i -g the CLI). */
	| { type: "install_pi_agent" }
	/** Persist an api-key credential for a provider (auth.json) and apply it now. */
	| { type: "set_provider_api_key"; provider: string; apiKey: string }
	/** Start an SDK-backed OAuth login flow for a built-in provider. */
	| { type: "provider_oauth_start"; provider: string }
	/** Reply to the currently pending prompt in an OAuth flow. */
	| { type: "provider_oauth_reply"; flowId: string; promptId: string; value: string }
	/** Cancel one in-flight OAuth login. */
	| { type: "provider_oauth_cancel"; flowId: string }
	/** Request the public state of in-flight OAuth logins after reconnecting. */
	| { type: "list_provider_oauth_flows" }
	/** Remove the provider's stored OAuth credential through the SDK. */
	| { type: "provider_oauth_logout"; provider: string }
	/** Clear a built-in provider's stored key (auth.json entry + runtime
	 *  override) so it returns to the unconfigured state. Only meaningful for
	 *  keys whose auth status reports source "stored". */
	| { type: "clear_provider_api_key"; provider: string }
	// -- built-in provider multiple keys (one provider, several API keys) -----
	/** List every stored API key for each built-in provider (NICKNAMES only — raw
	 *  apiKey and masked fragments NEVER leave the server). Pushed on attach and
	 *  after any change. */
	| { type: "list_provider_keys" }
	/** Add a SECONDARY API key to a built-in provider's key list. `name` is the
	 *  only thing the frontend ever sees (auto-generated when blank); the key
	 *  value travels here ONCE and is stored server-side. The added key stays
	 *  INACTIVE so the current active key keeps routing; the user switches to it
	 *  by clicking a model under the key's group in the picker — or by name. When
	 *  the provider has no key yet, the added key becomes the active one. */
	| { type: "add_provider_key"; provider: string; apiKey: string; name?: string }
	/** Make a stored API key the ACTIVE one for a built-in provider by NAME
	 *  (syncs auth.json + runtime override + refreshes models). The server
	 *  resolves the stored key value from the name. */
	| { type: "activate_provider_key"; provider: string; keyName: string }
	/** Remove a stored API key from a built-in provider by NAME. If it was the
	 *  active key, the first remaining key becomes active (or the provider
	 *  returns to unconfigured when no key is left). */
	| { type: "remove_provider_key"; provider: string; keyName: string }
	// -- custom model config (agentDir/models.json) ---------------------------
	| { type: "list_models_config" }
	/** Re-read models.json from disk into the model runtime and repush the
	 *  model list — for edits made outside the UI (hand edits, scripts).
	 *  Same refresh tail that save_model_config runs. */
	| { type: "reload_models_config" }
	/** Upsert one provider (api/baseUrl/apiKey + its models) into models.json. */
	| { type: "save_model_config"; providerId: string; config: UiProviderConfig }
	/** Remove a provider from models.json. */
	| { type: "delete_model_config"; providerId: string }
	/** List pi's built-in providers with their auth status (key-only config). */
	| { type: "list_providers" }
	/** Probe a custom provider's OpenAI-compatible /models endpoint and return
	 *  the advertised model ids. Runs SERVER-side (the baseUrl is often a
	 *  LAN/loopback host the browser can't reach cross-origin). reqId is echoed
	 *  back in fetch_models_result so the UI can match concurrent requests. */
	| {
			type: "fetch_models";
			reqId: number;
			baseUrl: string;
			apiKey?: string;
			authHeader?: boolean;
			/** api type: openai-completions / openai-responses / anthropic-messages / google-generative-ai. */
			api?: string;
			/** 正在编辑的服务商 id：apiKey 留空时服务端按它回落到已保存的密钥
			 *  （明文不再下发浏览器，编辑存量服务商的探测靠这个保持可用）。 */
			providerId?: string;
	  }
	/** Lightweight connectivity and auth probe for a provider endpoint.
	 *  Runs SERVER-side and returns latencyMs or error in test_model_connection_result. */
	| {
			type: "test_model_connection";
			reqId: number;
			baseUrl: string;
			apiKey?: string;
			authHeader?: boolean;
			api?: string;
			/** 同 fetch_models：apiKey 留空时按它回落到已保存的密钥。 */
			providerId?: string;
	  }
	/** Re-probe a SAVED provider's /models endpoint and merge the result into
	 *  its models.json entry. Credentials stay server-side (the browser never
	 *  sees apiKey/headers); reqId is echoed in refresh_provider_result. */
	| { type: "refresh_provider_models"; providerId: string; reqId: number }
	/** Force-refresh BUILT-IN providers' official pi.dev catalogs, bypassing
	 *  the SDK's 4h freshness window (mr.refresh force:true). For when a new
	 *  cheap model (e.g. a fresh Union release on opencode) is already on
	 *  pi.dev but the local models-store.json cache is still serving stale
	 *  data. reqId is echoed in refresh_builtin_result. */
	| { type: "refresh_builtin_models"; reqId: number }
	/** Append ONE model to a BUILT-IN provider via a models.json overlay entry
	 *  (first-day access before pi.dev lists it). Only `models[]` is written —
	 *  no baseUrl/api — so the entry stays a pure overlay: api/baseUrl are
	 *  inherited from the provider's existing models at compose time, and a
	 *  later official catalog refresh never drops the row. Only id (+ optional
	 *  display fields) is needed; reqId is echoed in append_builtin_result. */
	| { type: "append_builtin_model"; providerId: string; model: UiModelConfigEntry; reqId: number }
	/** Copy a BUILT-IN provider (baseUrl + current model catalog) into an
	 *  editable custom-provider draft — the point is running a second API key
	 *  alongside the built-in one without overwriting it. Nothing is saved
	 *  until save_model_config; the draft comes back in clone_provider_result
	 *  with a fresh provider id and an EMPTY apiKey for the user to fill. */
	| { type: "clone_provider"; provider: string; reqId: number }
	/** Enrich custom-provider draft rows with catalog params (contextWindow /
	 *  maxTokens / vision input / reasoning) from public directories
	 *  (OpenRouter primary, models.dev secondary). Runs SERVER-side; ids are
	 *  matched fuzzily (proxy aliases like gemini-3-pro-high). `hints` pins
	 *  rows: "draft-id" -> catalog id (e.g. anthropic/claude-sonnet-4-5) or
	 *  model page URL. Only blanks are filled by the UI. reqId is echoed in
	 *  enrich_models_result. */
	| {
			type: "enrich_models";
			reqId: number;
			ids: string[];
			hints?: Record<string, string>;
	  }
	/** Cancel an ongoing enrich_models request. If reqId is provided, aborts
	 *  only if that request is still running; otherwise aborts any active one. */
	| {
			type: "abort_enrich_models";
			reqId?: number;
	  }
	// -- goal / review -------------------------------------------------------
	/** Set (or clear) the active goal. When set, the SERVER drives the loop
	 *  (goal mode 2.0, the only path): it spawns a persistent executor
	 *  conversation, and the MAIN conversation plays the reviewer — it gets a
	 *  read-only verify prompt each round and answers with
	 *  `{"verdict":"pass|fail","feedback":…}`, which the server turns into
	 *  pass / another round / circuit-break. Rounds are capped by `maxRounds`
	 *  (0 = unlimited). `locked: true` keeps the goal active across every
	 *  subsequent turn; `false` clears it after the next turn (single-shot).
	 *  `reviewModel` ("provider/id", optional) is remembered as the goal WIZARD
	 *  model; the reviewer is the main conversation itself (no separate model).
	 *  `execModel` ("provider/id", optional) picks the executor's model. */
	| {
			type: "set_goal";
			goal: string;
			reviewModel?: string;
			maxRounds: number;
			locked: boolean;
			/** 执行者模型（"provider/id"；空 = 跟随主对话）。 */
			execModel?: string;
	  }
	| { type: "clear_goal" }
	/** 暂停目标：停掉执行者当前回合，保留目标与产物，不再自动派下一轮。 */
	| { type: "pause_goal" }
	/** 继续已暂停的目标：从当前轮次接着派活。 */
	| { type: "resume_goal" }
	/** Start the collaborative target wizard: a user requirement goes into an
	 *  ISOLATED wizard session which questions the user (multiple-choice + free
	 *  text bridges) to scope details, then AUTO-SETS the refined goal. `text` is
	 *  the user's raw requirement. `wizardModel` ("provider/id", optional) picks
	 *  a different model for the wizard; default is the main conversation model.
	 *  Mutually exclusive with an active review and with a running wizard. */
	| { type: "start_goal_wizard"; text: string; wizardModel?: string; maxRounds?: number; locked?: boolean }
	/** Persist the client's goal/review preference defaults (model choice, review
	 *  rounds cap, locked) so they survive reload. maxRounds 0 = unlimited.
	 *  Sent by the goal bar whenever a preference changes (model picker, rounds,
	 *  lock toggle). */
	| {
			type: "set_goal_prefs";
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
			/** 执行者模型偏好（"provider/id"；空 = 跟随），全局记忆。 */
			execModel?: string;
	  }
	// -- mini-harness Loop（受控代码/LLM Loop，server/loop/）------------------
	/** 启动受控 Loop（D-12-2 结构化启动）：服务端先建 run 落盘（绑定本会话，快照 loop
	 *  立刻是 kind="run"），再把干活提示词发进当前会话；模型准备（家族解析 + 规划）在
	 *  开跑前由扩展完成。建 run 被拒 → 快照 loop.kind="request-failed" 带原因（不经过模型）。
	 *  validator 缺省自动找 workspace/validate.py。 */
	| {
			type: "loop_start_request";
			goal: string;
			/** L0 快速预检命令（语法/配置检查，失败立即短路，不跑完整 validateCmd）。 */
			precheckCmd?: string;
			validateCmd?: string;
			mode?: "code" | "llm";
			maxRounds?: number;
			plannerModel?: string;
			reviewerModel?: string;
			useReviewer?: boolean;
			worktree?: boolean;
			taskId?: string;
			/** 用户写的验收条件（自然语言；无 validateCmd 时据此写 validate.py）。 */
			criteria?: string;
			/** 产物目录（取证/验收用，原样传给 loop_start）。 */
			artifactRoots?: string[];
			/** 主指标名（如 loss_pct / tps / ttft_ms）；声明后最优轮次只按它比较。 */
			primaryMetric?: string;
			/** 主指标优化方向：maximize / minimize。 */
			metricDirection?: "maximize" | "minimize";
			/** @deprecated 旧「精度/硬约束」字段，仅向后兼容。 */
			metricPrecision?: number;
			/** 主指标声明单位（如 % / tokens/s / ms）。 */
			metricUnit?: string;
			/** 主指标目标阈值（与 metricThresholdOp 成对）。 */
			metricThreshold?: number;
			/** 主指标目标阈值运算符：lt / lte / gt / gte。 */
			metricThresholdOp?: "lt" | "lte" | "gt" | "gte";
			/** 最优轮次比较容差（相对量，仅择优）。 */
			metricTolerance?: number;
			/** 必要场景配置；声明后 validator 必须报出匹配场景。 */
			metricScenario?: string;
			/** 必要硬约束（主指标之外的证据门禁：精度 / 稳定性 / 输入长度等）。 */
			hardConstraints?: Array<{
				name: string;
				metric: string;
				op: "lt" | "lte" | "gt" | "gte";
				value: number;
				unit?: string;
				scenario?: string;
			}>;
			/** 能力包 id：服务端按包内默认值填充未显式提供的字段（显式字段优先）。 */
			packId?: string;
			/** 用户填写的项目/工作区位置（缺省用会话 cwd）。 */
			workspace?: string;
			/** 用户已补全的必要输入（与上下文发现结果合并）。 */
			inputs?: Record<string, string>;
	  }
	/** 停止当前会话的活跃 Loop（不传 runId = 快照 loop 里的当前 run）。停止
	 *  即递增 epoch：在途/迟到回调全部失效，不得把 stopped 翻成 done。 */
	| { type: "loop_stop"; runId?: string }
	/** 显式续跑：按 runId 绑定（run 的 sessionId 必须匹配本会话，否则拒绝——
	 *  不做 cwd 兜底接管）。同一 run 的在途续跑会被互斥拒绝（不重复执行）。
	 *  评审掉线（stopped + stopReason=reviewer-error）的 run 走「重试评审」：重新激活
	 *  到 validate（epoch+1），让模型不改代码直接 loop_validate 重新验收。 */
	| { type: "loop_resume"; runId: string }
	/** 「按代码验证收下」：评审掉线（stopped + reviewer-error、代码验证已通过）的 run
	 *  由用户确认完成 → acceptance=passed-validator-only（run 须属于本会话）。 */
	| { type: "loop_accept"; runId: string }
	// -- settings (system prompt / skills / extensions) ----------------------
	/** Request the current settings state (also pushed automatically on attach). */
	| { type: "get_settings" }
	/** Apply a partial settings update: compose template / per-source overrides or
	 *  skill/extension toggles. Each change is persisted per client; prompt
	 *  template changes reload the runtime, while review changes affect the next review. */
	| {
			type: "set_settings";
			promptMode?: "append" | "replace";
			customSystemPrompt?: string;
			/** 组合模板文本（{{token}} 自由拼装，空 = 默认模板，见 prompt-composer）。 */
			promptTemplate?: string;
			/** 各来源 token 的独立覆盖（空 = 用自动内容）。 */
			promptOverrides?: Record<string, string>;
			/** 逐工具文案覆盖：键 = 工具名，值 = 该工具的 description/promptSnippet/
			 *  promptGuidelines（只合并给出的键；整项给空对象/空字段 = 清除该项覆盖）。 */
			toolPromptOverrides?: Record<string, UiToolPromptOverride>;
			disabledSkills?: string[];
			disabledExtensions?: string[];
			/** 统一 Agent 工具禁用名单（见 server/tool-manager.ts；live 生效无需 reload）。 */
			disabledAgentTools?: string[];
			/** Persistent-terminal tools on/off (default on). Off → terminal_* tools
			 *  are removed from the active tool set and the built-in usage guidance
			 *  disappears from the system prompt. */
			terminalToolsEnabled?: boolean;
			/** 终端接管 bash 开关 + 静默解阻阈值毫秒（0 = 一直等到命令结束）。 */
			terminalBash?: boolean;
			terminalBashIdleMs?: number;
			/** 终端接管 bash 前台最长等待毫秒（0 = 不限；达到后无论是否有输出均自动转后台）。 */
			terminalBashMaxForegroundMs?: number;
			/** 工具执行看门狗超时（毫秒，0 = 禁用；默认 20 分钟即 1200000）。 */
			toolWatchdogTimeoutMs?: number;
			/** read 工具读目录开关（默认开）。开 → read(目录路径) 列出目录条目，
			 *  关 → 原样交回内置 read（目录报 EISDIR）。行为开关（read 本体不可关），
			 *  覆盖定义每次调用实时读取，live 生效无需 reload。 */
			readDirEnabled?: boolean;
			/** 「后台任务」面板的自动清理阈值（分钟；0 = 关，默认关）。 */
			bgAutoCleanupMin?: number;
			/** 工具延迟加载开关（默认开）。 */
			toolLazyLoading?: boolean;
			/** codemode 执行模式："on"（常规模式，默认）| "only"（严格代码模式：其他工具对模型隐藏，所有调用都经由 codemode 脚本）。 */
			codemodeMode?: "on" | "only";
			/** codemode 系统提示词中内联工具声明的预算 Token（默认 3000）。 */
			codemodeInlineBudget?: number;
			/** edit_soft 工具开关（默认关）。开 → AI 可用不严格要求缩进的 edit_soft 工具。 */
			editSoftEnabled?: boolean;
			/** 问卷提问（ask_user_question）开关（默认开）。关 → 模型不再弹问卷。 */
			questionnaireEnabled?: boolean;
			/** 工具执行审批（人机协同）总开关（默认开）。关 → 一切审批都不弹：内置高危
			 *  检测直接放行（纯运行开关，live 生效，无需 reload）。 */
			toolApprovalEnabled?: boolean;
			/** 同项目并行提醒开关（默认开）。关 → 同项目另有对话在跑时不发 notice、不给 AI 注提醒、不通知对端。纯运行开关，无需 reload。 */
			parallelReminderEnabled?: boolean;
			/** 目标模式（目标条 + 调研向导 + 审查循环）总开关（默认开）。关 → 目标条
			 *  隐藏、无法设目标/启动调研/触发审查。纯运行开关，无需 reload。 */
			goalModeEnabled?: boolean;
			/** 思考文本是否换行（默认开）。纯 UI 偏好，不需要 reload runtime。 */
			thinkingWrap?: boolean;
			/** 工具调用是否默认展开（默认开）。纯 UI 偏好，不需要 reload runtime。 */
			toolsWrap?: boolean;
			/** 工具结果里的图片直接显示（默认开）。关 → 工具卡不渲染缩略图
				（快照仍带图，纯 UI 偏好，不需要 reload runtime）。 */
			toolImagesEnabled?: boolean;
			/** 消息列表尾部保持完整渲染的消息条数（默认 15）；更早的折叠为摘要行。
			 *  纯 UI 偏好，不需要 reload runtime。 */
			keepRecentMessages?: number;
			/** 向上分页加载模式（默认关）。纯 UI 偏好，不需要 reload runtime。 */
			reversePagination?: boolean;
			/** 历史对话列表中是否显示已被 fork 派生的父会话（默认 false = 仅显示链尾最新分支）。 */
			showForkedParentSessions?: boolean;
			/** 结束的对话切换时不自动从运行列表移出（默认 false = 切走且未继续对话的会话自动移出）。 */
			retainFinishedConversations?: boolean;
			/** 切换项目时是否打开该项目最近的会话（默认 true 开）。关 → 切换项目时始终创建空白新对话。 */
			openRecentSessionOnProjectSwitch?: boolean;
			/** skill 全文注入名单（默认空 = 名录模式）。名单里的技能 {{skills}} 展开正文。 */
			skillsFullText?: string[];
			/** 技能名录单描述最大字符数截断（默认 250，0 = 不截断）。 */
			skillsCatalogMaxDesc?: number;
			/** 技能名录是否输出 location 物理路径（默认 false = 节省上下文并防止路径泄露）。 */
			skillsCatalogShowLocation?: boolean;
			/** 技能名录总字符预算（默认 20000，超限自动降级为紧凑 names-only 模式；0 = 不设限）。 */
			skillsCatalogBudget?: number;
			/** 子代理默认模型（"provider/id"；null/未设 = 子代理跟随主对话当前模型）。
			 * 不改主会话模型，只在派生子代理时生效。 */
			subagentDefaultModel?: string | null;
			/** Vision bridge on/off + preferred "provider/id" model (null = auto). */
			visionBridgeEnabled?: boolean;
			visionBridgeModel?: string | null;
			/** Vision-bridge transcription prompt: mode (append/replace, same
			 *  semantics as promptMode) + custom text (empty = built-in default). */
			visionBridgePromptMode?: "append" | "replace";
			visionBridgePrompt?: string;
			/** 计划模式提示词：模式（append/replace，语义同 promptMode）+ 自定义
			 *  文本（空 = 内置默认）。仅主会话计划模式注入用（硬闸门不受影响）。 */
			planModePromptMode?: "append" | "replace";
			planModePrompt?: string;
			/** Extra instructions and independently disabled skills for review. */
			reviewPrompt?: string;
			reviewDisabledSkills?: string[];
			/** 大模型 API 出错自动重试次数（默认 6；0 = 失败即停）。即时生效，无需 reload。 */
			retryMaxAttempts?: number;
			/** 上下文压缩软上限（tokens，0 = 关闭）+ 按模型覆盖（"provider/id" → tokens）。
			 *  即时生效（compaction reserveTokens 覆盖），无需 reload。 */
			softCapTokens?: number;
			softCapByModel?: Record<string, number>;
			/** 内置标记总开关 + 按 marker 禁用（markersEnabled=false 时全部停用）。 */
			markersEnabled?: boolean;
			disabledMarkers?: string[];
			/** 宿主 UI 布局的用户偏好（内置条目的隐藏/排序/分组）。
			 *  纯 UI 偏好，per-client 持久化，不触发 reload。 */
			uiLayout?: UiLayoutPrefs;
			/** 输入框上方的快捷短语（点击即发送）。纯 UI 偏好，不需要 reload runtime。 */
			quickPhrases?: string[];
			quickPhrasesEnabled?: boolean;
			/** 极简新对话模式（默认关；开 = 新对话隐藏提示词模板并隐藏快捷短语，呈现现代极简风格）。 */
			minimalNewChat?: boolean;
			/** 输入框文字跨对话保留（默认关；开 = 切换别的会话不清空；关 = 仅保留当前会话文字，切换其他会话时清空或显示该会话已保留文字，切回时恢复当前会话文字）。 */
			preserveDraftAcrossConversations?: boolean;
			/** 上报「已 seed 一次默认快捷短语」（首次见空列表时客户端按语言填一批默认并置位；
			 *  服务端存全局标记，跨会话/跨浏览器生效，避免删除默认后又被填回）。 */
			quickPhrasesSeeded?: boolean;
	  }
	/** Upsert 一个子代理模板（同名覆盖；全局共享，所有客户端一致）。停用标记
	 *  enabled 一起保存 —— 关闭的模板设置面板可见、可重开，但 AI 工具查询不到。 */
	| { type: "save_subagent_template"; template: UiSubagentTemplate }
	/** 删除一个子代理模板。 */
	| { type: "delete_subagent_template"; name: string }
	// -- approval rules (<dataDir>/approval-rules.json) -----------------------
	/** 保存或更新一条审批规则（全局共享）。 */
	| { type: "save_approval_rule"; rule: UiApprovalRule }
	/** 批量更新审批规则列表（重排或批量保存，全局共享）。 */
	| { type: "save_approval_rules"; rules: UiApprovalRule[] }
	/** 删除一条自定义审批规则（内置规则不可删除）。 */
	| { type: "delete_approval_rule"; id: string }
	/** 恢复某条内置审批规则到系统默认设定。 */
	| { type: "reset_builtin_approval_rule"; id: string }
	// -- Skill 技能市场安装与卸载 ----------------------------------------------
	/** 从技能市场安装技能到全局 (~/.pi/agent/skills) 或项目级 (.pi/skills)。 */
	| {
			type: "install_skill";
			name: string;
			scope: "global" | "project";
			content: string;
	  }
	/** 卸载指定作用域下的技能。 */
	| {
			type: "uninstall_skill";
			name: string;
			scope: "global" | "project";
	  }
	/** 设置当前项目的**额外工作区根**（宿主侧多根）：AI 仍只在主 cwd 里干活（pi SDK
	 *  是单 cwd 模型），文件树可跨这些根。空数组 = 回到单根。
	 *  只收绝对路径（相对路径直接丢弃）、去重、最多 8 个；按项目（cwd）持久化在
	 *  client-state.json，改了立刻推一次快照。 */
	| { type: "set_workspace_roots"; roots?: string[] }
	/** 空白会话切换预设（DSH only；首轮后锁定，失败收 warning notice）。 */
	| { type: "dsh_preset_select"; preset: string }
	/** 新会话默认预设（DSH only；非法 id 拒绝并提示）。 */
	| { type: "dsh_preset_default"; preset: string }
	/** 当前会话切换权限预设（DSH only；热切换，无需重启；失败收 warning notice）。 */
	| { type: "dsh_permission_set"; preset: string }
	/** 新会话默认权限预设（DSH only；非法 id 拒绝并提示）。 */
	| { type: "dsh_permission_default"; preset: string }
	/** DSH engine: answer a model ask_user_question dialog (id echoes
	 *  question_pending.id). `cancelled` (user ✗) rejects the pending ask.
	 *  owner = 跨页作答：转给持有方会话（elsewhere_question 预告的那张问卷）。 */
	| {
			type: "question_answer";
			id: string;
			answers: QuestionAnswer[];
			cancelled?: boolean;
			cancelReason?: string;
			owner?: string;
	  }
	/** 用户对高危工具调用的审批答复（tool_approval_pending 回复）。
	 *  decision: "approve" 放行原参数；"deny" 拒绝执行；"edit" 修改参数并放行（Edit & Run）。
	 *  scope（仅 approve 有效，缺省 = 单次）："category" = 顺带记住本对话的该同类档位；
	 *  "all" = 本对话后续全部允许审批（同类/全部记忆都是内存态，重启即失效）。 */
	| {
			type: "tool_approval_response";
			id: string;
			decision: "approve" | "deny" | "edit";
			editedParams?: Record<string, unknown> | unknown;
			reason?: string;
			scope?: "once" | "category" | "all";
	  }
	/** 设置当前对话的审批放行策略（设置面板「已记住的放行」撤销用；纯内存态）。
	 *  conversationId 缺省 = 当前对话；只应用给出的字段：allowAll 直接赋值，
	 *  categories 给出时作为「保留名单」整体替换（空数组 = 清掉全部同类记忆）。 */
	| {
			type: "set_approval_policy";
			conversationId?: string;
			allowAll?: boolean;
			categories?: string[];
	  }
	/** 客户端更新任务计划看板（或清空计划）。 */
	| {
			type: "plan_update";
			conversationId?: string;
			steps: PlanStep[];
			activeStepId?: string | null;
	  }
	/** 增量更新单个步骤的状态或内容。 */
	| {
			type: "plan_step_update";
			conversationId?: string;
			stepId: string;
			patch: Partial<PlanStep>;
	  }
	/** 删除单个步骤。 */
	| {
			type: "plan_step_delete";
			conversationId?: string;
			stepId: string;
	  }
	/** 新增单个步骤。 */
	| {
			type: "plan_step_add";
			conversationId?: string;
			step: PlanStep;
			afterStepId?: string;
	  }
	/** 「✨ 净室执行（Clean-session Handoff）」：
	 *  关闭源会话的计划闸门，新建隔离会话，在新会话中原子设置计划步骤、可选迁移目标，并触发实施轮 prompt。 */
	| {
			type: "plan_clean_handoff";
			steps: PlanStep[];
			prompt: string;
	  }
	/** 计划模式开关（会话级）：开启后本对话**只调研 + 出实施计划，不实施**。
	 *  服务端在写类工具与非常规 bash 上加硬闸门（拒绝并把原因回给模型），
	 *  并向系统提示词追加计划模式约束（先 plan_update 列步骤，再给计划正文）；
	 *  关掉即恢复普通对话。conversationId 缺省 = 当前对话。 */
	| { type: "set_plan_mode"; enabled: boolean; conversationId?: string }
	/** 审查者模式开关（会话级，默认关）：开启后本对话**只审阅不施工**，用户的
	 *  每条 prompt 由服务端转给一个常驻落盘执行对话执行；写类/派发类工具加硬闸门。
	 *  conversationId 缺省 = 当前对话。计划模式优先（两者同开时不自动派活）。 */
	| { type: "set_delegate_mode"; enabled: boolean; conversationId?: string }
	/** Drop one workspace from this client's recent-project list (UI state
	 *  only — nothing on disk is touched). */
	| { type: "remove_project"; path: string }
	// -- sandbox projects -----------------------------------------------------
	/** Create an isolated sandbox project (blank or imported copy of sourcePath) and switch cwd to it. */
	| { type: "create_sandbox"; name?: string; sourcePath?: string; ephemeral?: boolean }
	/** Reset a sandbox project back to its initial state (blank or re-copied from sourcePath). */
	| { type: "reset_sandbox"; path?: string }
	/** Convert an ephemeral sandbox project into a permanent sandbox project. */
	| { type: "persist_sandbox"; path?: string }
	/** Export / promote a sandbox project to a formal project directory outside sandboxes. */
	| { type: "promote_sandbox"; path?: string; targetPath: string; switchToTarget?: boolean }
	/** Compare a sandbox project against its sourcePath and push a `sandbox_diff` summary. */
	| { type: "diff_sandbox"; path?: string }
	/** Sync modified/added files and prune deleted files from an imported sandbox back to its original sourcePath. */
	| { type: "apply_sandbox_to_source"; path?: string }
	/** Permanently destroy a sandbox project directory and remove it from the registry. */
	| { type: "destroy_sandbox"; path: string }
	| { type: "switch_worktree"; path: string }
	| { type: "remove_worktree"; path: string; force?: boolean }
	/** Permanently delete a persisted session transcript file (history list). */
	| { type: "delete_session"; path: string }
	/** Append a session_info name entry to a persisted session transcript (history rename). */
	| { type: "rename_session"; path: string; name: string }
	/** Rename a live conversation: retitle + persist a session_info entry so History matches. */
	| { type: "rename_conversation"; id: string; name: string }
	/** Dismiss a running conversation from the left-panel list (frees its runtime
	 *  but keeps the persisted transcript in history). Only non-streaming
	 *  conversations can be dismissed; streaming ones refuse with a notice.
	 *  withFinishedSubagents = 连带关闭该对话下已结束的子代理（传递后代；运行
	 *  中的子代理仍会阻止关闭，绝不连带 abort）。不传 + 存在已结束子代理后代
	 *  时拒绝并提示（避免静默 orphan，由前端确认框先问用户）。
	 *  force = 强行关闭：中止自身运行（如在跑）+ 中止全部子代理后代
	 *  （运行中的也停）再整体移出；终端/审查/后台唤醒等保留态一并放行。
	 *  active 对话也可关闭（后端自动切到其他对话或新建后再移）。 */
	| { type: "dismiss_conversation"; id: string; withFinishedSubagents?: boolean; force?: boolean }
	/** 将一个内存子代理（inMemory）固化为普通持久化对话：写入磁盘 .jsonl 文件，
	 *  清除 isSubagent 标记，使其进入历史会话列表并长久保留。 */
	| { type: "persist_conversation"; id: string }
	/** 钉住 / 取消钉住运行中的对话：钉住后切换到其他对话也不从「运行的对话」
	 *  释放（空闲无终端亦然），直到显式移出。pinned=false 时取消钉住。 */
	| { type: "pin_conversation"; id: string; pinned: boolean }
	/** 钉住 / 取消钉住历史会话文件（持久化到 client-state.json 并在历史列表展示 📌）。 */
	| { type: "pin_session"; path: string; pinned: boolean }
	/** Bulk-dismiss FINISHED subagents from the running list (right-click menu).
	 *  parentId omitted = all finished subagents; given = the transitive
	 *  subagent descendants of that conversation (children, grandchildren, …),
	 *  plus the parent itself when it is a finished subagent. Running
	 *  (streaming/retained) subagents are never touched. */
	| { type: "dismiss_finished_subagents"; parentId?: string }
	// -- scheduled tasks (issue #184, server/scheduler-tasks.ts) -----------------
	/** Re-push the built-in scheduler task list (also pushed on attach / change). */
	| { type: "schedule_list" }
	/** Create or fully update a scheduled task (same id = overwrite). */
	| { type: "schedule_save"; task: SchedulerTaskInput }
	/** Delete a scheduled task. */
	| { type: "schedule_delete"; id: string }
	/** Manually trigger a task once right now (does not shift its next fire). */
	| { type: "schedule_run"; id: string }
	/** Enable / disable a scheduled task (re-arms its next fire). */
	| { type: "schedule_toggle"; id: string; enabled: boolean }
	// -- compacted history retrieval (issue #398) ----------------------------
	/** 查询被某个上下文压缩卡片折叠的历史消息（按需惰性加载，issue #398）。 */
	| {
			type: "get_compacted_messages";
			compactionMessageId: string;
			conversationId?: string;
	  };

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export interface SessionSummary {
	path: string;
	/** 稳定会话 UUID（转录头 `id` 或目录名，供 `#s=<sessionId>` URL 深链与跨重启定位，issue #587）。 */
	sessionId?: string;
	name?: string;
	/** 引擎权威计算的最终前端展示名称（由引擎自身的回调或解析逻辑定制生成）。 */
	displayName?: string;
	firstMessage: string;
	messageCount: number;
	modified: number;
	/** Where the session lives: this UI's per-client dir, or the pi CLI/TUI dir. */
	source?: "web" | "tui";
	/** 用户钉住（常驻运行列表 / 历史置顶）：带 📌 标记。 */
	pinned?: boolean;
	/** 父会话路径（由编辑重问或分支派生产生的子会话，供历史列表展示分支标记）。 */
	parentSessionPath?: string;
}

/** 会话转录中一条命中消息的定位锚点：会话载入后按 role + timestamp 在
 *  UiMessage[] 里找到对应消息，用于「搜索会话 → 跳到对应位置」。 */
export interface MessageAnchor {
	role: string;
	timestamp: number;
}

/** 会话内容搜索结果：会话摘要 + 命中消息锚点（可能为空 ——
 *  仅元数据/文件名命中时无从定位，跳转退化为直接打开会话）。 */
export interface SessionSearchResult extends SessionSummary {
	/** 按转录顺序排列的命中消息（最多若干条）；客户端取第一条做跳转。 */
	anchors: MessageAnchor[];
}

/**
 * Metadata for an isolated sandbox workspace managed under `<dataDir>/sandboxes/<id>`.
 */
export interface SandboxInfo {
	/** Unique sandbox identifier (e.g. "sbx-m8x9k2a1"). */
	id: string;
	/** Display name of the sandbox project. */
	name: string;
	/** Absolute path to the sandbox workspace directory (`/` normalized wire path). */
	path: string;
	/** Optional source project path when created by importing an existing workspace. */
	sourcePath?: string;
	/** True = temporary sandbox (cleaned up when destroyed/discarded); false = permanent sandbox. */
	ephemeral: boolean;
	/** Creation timestamp (epoch ms). */
	createdAt: number;
}

/**
 * A workspace directory this client has opened before (persisted per client in
 * <dataDir>/client-state.json, merged with cwds found in the session store).
 */
export interface SandboxDiffView {
	sandboxId: string;
	path: string;
	sourcePath?: string;
	added: string[];
	modified: string[];
	deleted: string[];
	unchangedCount: number;
	error?: string;
}

export interface LinkedWorktreeEntry {
	path: string;
	branch?: string;
	isCurrent?: boolean;
	isMain?: boolean;
	isDirty?: boolean;
	uncommittedCount?: number;
	aheadCount?: number;
}

export interface WorktreeInfo {
	/** True if the current active workspace (cwd) is a linked worktree (not the main worktree). */
	isLinkedWorktree: boolean;
	/** Normalized absolute path of the current worktree. */
	currentPath: string;
	/** Branch name for current worktree (e.g. 'feat/pr-12'). */
	branch?: string;
	/** Normalized absolute path of the main worktree (the repository root). */
	mainPath: string;
	/** Branch name for the main worktree (e.g. 'main'). */
	mainBranch?: string;
	/** List of all linked worktrees in this repository. */
	linkedWorktrees: LinkedWorktreeEntry[];
}

export interface ProjectSummary {
	/** Absolute path of the workspace directory. */
	path: string;
	/** Last time this workspace was used (ms epoch) — drives the sort order. */
	lastUsed: number;
	/** Present when this project is a managed sandbox workspace. */
	sandbox?: SandboxInfo;
}

/** 一个可选项：模型的 ask_user_question 问卷选项。preview 为选项被选中后
 *  在右侧展开的富文本（model 自选 markdown 或 HTML，前端走 Markdown(rawHtml)）。 */
export interface UiQuestionOption {
	label: string;
	description?: string;
	preview?: string;
	/** 推荐选项标记（true = 建议用户首选，UI 渲染推荐徽标）。 */
	recommended?: boolean;
}

/** 模型 ask_user_question 的一道题。question/detail/header 允许 markdown/HTML
 *  混排（前端走 Markdown(rawHtml)），由模型自选、信任模型。 */
export interface UiQuestion {
	id: string;
	question: string;
	detail?: string;
	header?: string;
	options?: UiQuestionOption[];
	multiSelect?: boolean;
	/** 级联依赖（Waterfall）：仅当指定 questionId 选中了特定值（未给 value 则表示只要已作答）时本题才展示；不满足则跳过。 */
	dependsOn?: {
		questionId: string;
		value?: string | string[];
	};
	/** 动态级联选项映射：根据前序依赖题的所选值动态提供候选选项列表。 */
	optionsMap?: Record<string, UiQuestionOption[]>;
}

/** 一道题的用户回答（question_answer 回传）。selected 为选中的选项 label
 *  列表；custom 为用户在「Type something」里填的额外文本（可选）。 */
export interface QuestionAnswer {
	id: string;
	selected: string[];
	custom?: string;
}

/** 待用户回答的模型提问（ask_user_question）——服务端侧的事实源。
 *  `question_pending` 是即时通道（模型刚提问时推一次）；本类型同时挂在
 *  UiState.pendingQuestion 上，让重连/刷新/第二个标签页的客户端从快照里把
 *  对话框恢复出来（否则问卷只在「当时在线的那条连接」上可见）。 */
export interface UiPendingQuestion {
	/** 提问 id，question_answer 回传时原样带回。 */
	id: string;
	questions: UiQuestion[];
	/** 服务端超时时间戳（epoch ms）——前端显示倒计时，归零自动取消。
	 *  缺省 = 不限时（标准 pi 引擎：等人回答不设上限）。 */
	deadline?: number;
	/** 所属会话 id（缺省 = 不限会话 / 全局）。用于前端切换会话时自动收起/恢复面板。 */
	conversationId?: string;
	/** 所属会话标题/名称（可选），用于在提问弹窗中展示来源对话。 */
	conversationTitle?: string;
}

/** 期待用户操作的建议按钮选项（由 action/suggest 内联标记产生）。
 *  渲染在对话最底部，点击即作为用户消息直接发送。 */
export interface UiActionSuggestion {
	id: string;
	label: string;
	prompt: string;
}

/** 审批规则档位（「允许同类审批」的粒度）：稳定 id + 双语名（前端按 locale 自选）。
 *  id 是记忆/撤销的键，不得随文案改名（内置档位见 server/tool-approval.ts 的规则表）。 */
export interface UiApprovalCategory {
	id: string;
	label: string;
	labelEn: string;
}

/** 审批规则定义（前后台共享；<dataDir>/approval-rules.json 持久化）。 */
export interface UiApprovalRule {
	id: string;
	enabled: boolean;
	tools: string[];
	field: "command" | "path" | "params";
	match: "regex" | "glob" | "contains" | "prefix" | "outside_workspace";
	value: string;
	action: "ask" | "deny" | "allow";
	label: string;
	labelEn?: string;
	reason?: string;
	reasonEn?: string;
	categoryId?: string;
	builtin?: boolean;
}

/** 当前对话的审批放行策略（仅内存、不落盘；重启/新对话即恢复询问）。 */
export interface UiApprovalPolicyState {
	/** 策略所属对话（设置面板撤销区只展示当前对话的）。 */
	conversationId?: string;
	/** 本对话「全部允许审批」。 */
	allowAll: boolean;
	/** 本对话已记住的同类档位。 */
	categories: UiApprovalCategory[];
}

/** 审批规则命中详情（高危命令片段高亮与命中清单，issue #566）。 */
export interface UiApprovalHit {
	ruleId: string;
	label: string;
	labelEn?: string;
	field: "command" | "path" | "params";
	index: number;
	length: number;
	text: string;
}

/** 待用户审批的高危工具调用（Edit & Run 人机协同）。 */
export interface UiToolApproval {
	id: string;
	toolCallId: string;
	toolName: string;
	params: Record<string, unknown> | unknown;
	reason?: string;
	reasonEn?: string;
	/** 命中的规则档位（有档位时弹窗提供「允许同类」；无档位只能单次批准/本对话全部允许）。 */
	category?: UiApprovalCategory;
	/** 命中的高危规则清单（用于参数框定位与高危片段标记，issue #566）。 */
	hits?: UiApprovalHit[];
	/** 若该工具调用是由某个上层工具嵌套发起（例如 codemode 沙箱脚本调用），记录上层工具名。 */
	parentTool?: string;
	conversationId?: string;
	conversationTitle?: string;
}

/** 任务计划步骤状态。 */
export type PlanStepStatus = "pending" | "in_progress" | "done" | "failed";

/** 任务计划单个步骤（Plan Step）。 */
export interface PlanStep {
	id: string;
	title: string;
	status: PlanStepStatus;
	description?: string;
}

/** 任务步骤状态机看板状态（Plan State）。 */
export interface PlanState {
	steps: PlanStep[];
	activeStepId?: string | null;
	updatedAt?: number;
}

/** mini-harness Loop 的会话级状态（server/loop/ 运行时的对外视图）。 */
export interface LoopUiState {
	/** run=run 已落盘；request-failed=启动失败；pending=旧流程的挂起记录（服务端已不再产出）。 */
	kind: "pending" | "run" | "request-failed";
	taskId: string | null;
	goal: string;
	/** request-failed 的失败原因。 */
	reason?: string;
	runId?: string;
	mode?: "code" | "llm";
	stage?: string;
	round?: number;
	maxRounds?: number;
	status?: "active" | "done" | "stopped";
	/** 停止原因：user-stop / validate-fail / reviewer-block / reviewer-error / setup-error / no-validator 等。 */
	stopReason?: string;
	lastVerdict?: string | null;
	/** 完成态可信度（只在 status=done 时有值）：passed = 代码验证 + 模型评审都过（LLM 模式：评审通过）；
	 *  passed-validator-only = 只有代码验证（没开评审 / 没有可用评审模型 / 评审掉线后用户收下）；
	 *  self-declared = LLM 模式关评审、按模型自述完成。 */
	acceptance?: "passed" | "passed-validator-only" | "self-declared" | null;
	/** 最近一次模型评审结论（verdict = pass / block / error / skip；最多 5 条理由，每条 ≤300 字）。 */
	review?: { verdict: string; reasons: string[] };
	/** 本 run 的模型评审是否生效（开启且有可用评审模型）。 */
	reviewerEnabled?: boolean;
	/** 服务端建了 run、还没做模型准备（家族解析与规划在开跑前完成）。 */
	setupPending?: boolean;
	/** 模型准备失败原因（stopReason=setup-error）。 */
	setupError?: string;
	/** 用户写的验收标准。 */
	criteria?: string;
	/** L0 快速预检命令。 */
	precheckCmd?: string;
	/** 最近一轮提取的 HARNESS_METRIC 数值指标。 */
	lastMetrics?: Record<string, number>;
	/** 历史最优轮次 Checkpoint。 */
	bestRound?: {
		round: number;
		verdict: string;
		commitSha: string | null;
		metrics?: Record<string, number>;
		at: string;
	};
	/** 停止请求发出时间（区分「已发出停止请求」与「本地执行已确认停止」）。 */
	stopRequestedAt?: string;
	/** 本地执行（validator/precheck 子进程组）确认退出时间；未确认 = 仍可能在途或远端未知。 */
	stopConfirmedAt?: string;
	/** 主指标声明单位。 */
	metricUnit?: string;
	/** 主指标目标阈值。 */
	metricThreshold?: number;
	/** 主指标目标阈值运算符。 */
	metricThresholdOp?: "lt" | "lte" | "gt" | "gte";
	/** 最优轮次比较容差（相对量）。 */
	metricTolerance?: number;
	/** 必要场景配置。 */
	metricScenario?: string;
	/** 必要硬约束（主指标之外的证据门禁）。 */
	hardConstraints?: Array<{
		name: string;
		metric: string;
		op: "lt" | "lte" | "gt" | "gte";
		value: number;
		unit?: string;
		scenario?: string;
	}>;
	/** 最近一轮指标门禁结果（命令 exit 0 不等于指标达标）。 */
	lastMetricGate?: {
		ok: boolean;
		missingPrimary: boolean;
		unitUnconfirmed: boolean;
		scenarioMismatch: boolean;
		violations: Array<{ name: string; detail: string }>;
		reasons: string[];
	};
	/** run 创建时间（ISO）；UI 据此算耗时。pending 时为请求发出时间。 */
	createdAt: string;
}

/** A background server the agent left running (listening-port diff around a
 *  bash tool run). Keyed by port. Managed from the 后台任务 panel: each entry
 *  can be stopped individually or all at once, and the list persists even
 *  after the conversation that started them ends. */
export interface BgServer {
	/** Port the server listens on (the stable key for agent-started servers). */
	port?: number;
	/** Process id of the listening process (agent-started servers). */
	pid?: number;
	/** When the server was first detected (ms epoch). */
	since: number;
	/** Best-effort process name (tasklist / ps), undefined when unknown. */
	name?: string;
	/** Best-effort full command line (PowerShell CIM / ps -o command=) so the
	 *  panel can show WHAT is actually running, undefined when unknown. */
	command?: string;
	/** 用户把这个后台实例**钉住**了（`set_bg_keep`）：自动清理永不碰它。 */
	keep?: boolean;
}

/** One run of a built-in scheduled task (issue #184): trigger time, outcome,
 *  duration and the headless conversation it ran in (if any). */
export interface SchedulerRunInfo {
	at: number;
	ok: boolean;
	durationMs: number;
	conversationId?: string;
	error?: string;
	manual?: boolean;
}

/** Built-in scheduled task (CRUD input): cron = 5-field expression,
 *  interval = milliseconds (as string or number, min 60s). */
export interface SchedulerTaskInput {
	id?: string;
	name?: string;
	description?: string;
	cwd?: string;
	kind?: "cron" | "interval";
	spec?: string | number;
	prompt?: string;
	enabled?: boolean;
	model?: string;
	thinkingLevel?: string;
	catchUp?: "skip" | "once";
	/** 发起对话 id（Agent 工具创建时填）：触发时优先唤醒它，找不到再无头执行。空 = 无头。
	 *  注意：内存对话 id（c1/c2…）重启即失效，跨压缩/重启认同一会话靠 sessionFile（issue #231）。 */
	conversationId?: string;
	/** 发起对话的落盘会话文件（压缩/重启后稳定，触发时优先按它重认会话）。 */
	sessionFile?: string;
	/** 单次任务：触发执行一次后自动删除（Agent 工具 recurring=false 时置 true）。 */
	oneShot?: boolean;
}

/** Built-in scheduled task with runtime state (server -> client). */
export interface SchedulerTaskView {
	id: string;
	name: string;
	description: string;
	cwd: string;
	kind: "cron" | "interval";
	spec: string;
	prompt: string;
	enabled: boolean;
	model: string;
	thinkingLevel: string;
	catchUp: "skip" | "once";
	/** 发起对话 id（空 = 无头执行）。易失的内存 id，只做首选唤醒键；稳定键是 sessionFile（issue #231）。 */
	conversationId: string;
	/** 发起对话的落盘会话文件（压缩/重启后依然稳定；空 = 面板任务/老任务）。 */
	sessionFile: string;
	/** 单次任务：触发执行一次后自动删除。 */
	oneShot: boolean;
	createdAt: number;
	updatedAt: number;
	nextFire: number | null;
	lastRun: SchedulerRunInfo | null;
	history: SchedulerRunInfo[];
	running: boolean;
}

/** One filename match from the global-search recursive workspace walk. */
export interface FileSearchResult {
	/** Workspace-relative path ("/"-separated). */
	path: string;
	name: string;
	type: "file" | "dir";
}
export interface FileEntry {
	name: string;
	/** Path relative to the workspace root ('' for the root itself); in machine
	 *  browse mode (files.absolute) this carries the absolute wire path. */
	path: string;
	type: "file" | "dir";
	/**
	 * Preview category (files only; undefined for dirs). "none" files are
	 * never previewed — the UI doesn't open them and read_file refuses them.
	 */
	kind?: "image" | "video" | "audio" | "text" | "none";
}

export interface PptxSlideImagePayload {
	media: string;
	name?: string;
	descr?: string;
}

export interface PptxSlidePayload {
	index: number;
	title: string;
	subtitle?: string;
	paragraphs: string[];
	tables?: string[][][];
	images?: PptxSlideImagePayload[];
	notes?: string;
	bg?: string;
}

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	/** Whether the model accepts image input (SDK `input` includes "image"). */
	vision: boolean;
	/** Whether this model is enabled by the user's `enabledModels` scope pattern in settings.json.
	 *  When omitted or true, the model is enabled. When false, excluded by enabledModels. */
	enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Goal / review status (server -> client snapshot)
// ---------------------------------------------------------------------------

/** 目标模式下的一个「角色对话」（只有执行者槽：审查者就是主对话本身）。 */
export interface GoalRoleRef {
	/** 承载该角色的对话 id（左栏可点开）。 */
	convId: string;
	/** true = 服务端拉起的角色对话（落盘普通对话，完成/清目标时可移出）。 */
	spawned: boolean;
	/** 执行者上次取样时是否正在跑（goal_status 下发时点的值；轮次边界刷新，非每 token）。 */
	streaming?: boolean;
	/** 执行者最近动态（一句话：跑什么工具 / 自述头，≤120 字；轮次边界刷新）。 */
	activity?: string;
	/** activity 的英文版（客户端按 locale 二选一，与 status/statusEn 同口径）。 */
	activityEn?: string;
	/** 执行者会话的 sessionId（任务台据此读 session 文件里的工具调用时间线）。 */
	sessionId?: string | null;
}

/** 一条已终结的目标（目标条「历史」下拉用；内存态，随重启丢失）。 */
export interface GoalHistoryEntry {
	/** 目标全文（截断 200 字）。 */
	goal: string;
	/** 终态：通过 / 未通过（预算用尽）/ 受阻。 */
	verdict: "pass" | "fail" | "blocked";
	/** 跑到的轮次。 */
	rounds: number;
	/** 终态原因（结论/熔断文案，截断 200 字）。 */
	feedback: string;
	/** 终结时间（Date.now()）。 */
	finishedAt: number;
}

/** Current state of the goal-review loop, shown in the goal bar UI. */
export interface GoalStatus {
	/** Conversation that owns this goal; null when no goal is set. */
	conversationId: string | null;
	/** Active goal text; null when no goal is set. */
	goal: string | null;
	/** 模型 id ("provider/id")；pi 引擎语义为**调研（向导）模型**记忆位，DSH 仍用它选审查模型。 */
	reviewModel: string | null;
	/** Maximum number of review rounds per goal run. */
	maxRounds: number;
	/** Whether the goal persists across turns (locked) or just the next one. */
	locked: boolean;
	/** True while a review is running right now. */
	reviewing: boolean;
	/** 1-based round counter for the current goal (review rounds). */
	round: number;
	/** Human-readable status line (e.g. "审查中", "已通过", "本轮不通过"). UI locale at emit time (zh default). */
	status: string;
	/** English status line (client shows it when locale is en). */
	statusEn?: string;
	/** Latest review verdict: "pending" | "pass" | "fail" | "blocked". */
	verdict: "pending" | "pass" | "fail" | "blocked";
	/** Latest review feedback text (reviewer's verdict reason, pass or fail). */
	feedback?: string;
	/** Collaborative target-wizard progress (null when no wizard is running).
	 *  The wizard turns a raw user requirement into a refined goal by asking
	 *  questions, then auto-sets the goal. */
	wizard: WizardStatus;
	/** 2.0：循环相位。 */
	phase?: "idle" | "executing" | "reviewing" | "blocked" | "paused";
	/** 用户暂停了目标（执行者回合已停，目标与产物保留；resume_goal 继续）。 */
	paused?: boolean;
	/** 本目标累计用量（执行者各轮 + 审查者各轮的输入/输出 token；轮次边界累计）。 */
	usage?: { inputTokens: number; outputTokens: number };
	/** 本对话的目标历史（终态落袋，cap 20；内存态，与目标状态同寿命；清目标不清空）。 */
	history?: GoalHistoryEntry[];
	/** 2.0：执行者模型（"provider/id"；null = 跟随主对话）。 */
	execModel?: string | null;
	/** 2.0：角色对话（审查者就是主对话，故这里只有 executor）。 */
	roles?: { executor?: GoalRoleRef };
}

/** Progress of the collaborative target wizard (see GoalStatus.wizard). */
export interface WizardStatus {
	/** True while the wizard session is asking the user questions. */
	active: boolean;
	/** The user's raw requirement being scoped. */
	draft: string;
	/** Wizard model id ("provider/id"), or null for the main model default. */
	model: string | null;
	/** Question count asked so far (UI shows the step). */
	step: number;
	/** Max questions the wizard may ask before forcing a conclusion. */
	maxSteps: number;
	/** Short status line for the goal bar (e.g. "调研中：请回答第 2 题"). UI locale at emit time (zh default). */
	status: string;
	/** English wizard status line (client shows it when locale is en). */
	statusEn?: string;
}

// ---------------------------------------------------------------------------
// Custom model configuration (agentDir/models.json) — browser-editable shape
// ---------------------------------------------------------------------------

/** One enriched row from enrich_models: only fields the catalog actually
 *  provided are present (never invented) — the UI fills blanks. `source` is
 *  a ready-to-display label composed server-side (e.g. "OpenRouter",
 *  "models.dev（别名）", "依据", "网页"). */
export interface UiEnrichResult {
	id: string;
	status: "matched" | "suggested" | "unmatched";
	contextWindow?: number;
	maxTokens?: number;
	input?: string[];
	reasoning?: boolean;
	name?: string;
	source?: string;
	matchType?: "exact" | "normalized" | "family" | "hint" | "hint-url";
	/** Suggested catalog ids for suggested rows (paste as evidence). */
	suggestions?: string[];
	/** Why unmatched / low-confidence note. */
	note?: string;
}
/** One model definition inside a custom provider. */
export interface UiModelConfigEntry {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	/** Per-model override (rarely needed): api type (openai-completions /
	 *  openai-responses / anthropic-messages / google-generative-ai) and/or
	 *  baseUrl. When absent they are inherited from sibling models of the
	 *  same provider at compose time (append_builtin_model relies on this). */
	api?: string;
	baseUrl?: string;
}

/** A custom provider block in models.json (providers.<id>). */
export interface UiProviderConfig {
	providerId: string;
	name?: string;
	/** api type: openai-completions / openai-responses / anthropic-messages / google-generative-ai. */
	api?: string;
	baseUrl?: string;
	/** 【只写】save_model_config 提交的新 apiKey；服务端下发（models_config /
	 *  clone_provider_result）时**永不填充**——明文不回传浏览器。留缺 = 保留
	 *  已存旧值，显式空串 = 清除。 */
	apiKey?: string;
	/** 【只读】服务端下发的"是否已保存 apiKey"，与 headers 一样是单向字段：
	 *  客户端保存时无需也不应携带。 */
	hasApiKey?: boolean;
	authHeader?: boolean;
	/** headers are NOT returned to the browser — they can contain Authorization
	 *  / API-key values; saveModelConfig preserves them server-side. */
	models: UiModelConfigEntry[];
}

// ---------------------------------------------------------------------------
// Host UI layout (built-in slots / user layout preferences)
// ---------------------------------------------------------------------------

/**
 * 宿主支持的**挂载点**（slot）。这是宿主 UI 扩展点的唯一枚举：新增一个挂载点 =
 * 宿主加一个常量 + 一处渲染位置，**插件侧契约不变**（不用再改 manifest 结构）。
 *
 * 命名：`<区域>[.<子区>]`。contextmenu.* 是五处右键菜单。
 */
export type UiSlotId =
	/** 顶栏主栏（与内置 tab 同排）。 */
	| "topbar.primary"
	/** 顶栏溢出菜单（主栏放不下的、以及声明 hidden 的条目）。 */
	| "topbar.overflow"
	/** 底栏（上下文/成本那一条）。 */
	| "bottombar"
	/** 输入框前置区（文件上传按钮左侧，纯插件新增位，无内置条目）。 */
	| "composer.leading"
	/** 输入框动作区（发送按钮旁边）。 */
	| "composer.actions"
	/** 每条消息 hover 时的工具条。 */
	| "message.actions"
	/** 顶栏条目右键菜单。 */
	| "contextmenu.topbar"
	/** 消息右键菜单。 */
	| "contextmenu.message"
	/** 左栏会话右键菜单。 */
	| "contextmenu.session"
	/** 左栏项目行右键菜单（最近项目；target.kind="project"，target.id=项目路径）。 */
	| "contextmenu.project"
	/** 工具调用卡片的**工具名**右键菜单（ToolCallBlock；宿主内置条目只有「显示工具详细信息」）。 */
	| "contextmenu.toolcall"
	/** 设置面板里的一整页（插件用 mount() 自己渲染）。 */
	| "settings.pages"
	/** 左栏「最近项目」分区标题栏按钮（宿主「管理项目」按钮之后追加）。 */
	| "leftpanel.projects.actions"
	/** 左栏项目行内嵌区（项目名旁的徽标/快捷按钮；点击回传 target=项目）。 */
	| "leftpanel.project"
	/** 左栏「运行的对话」分区标题栏按钮。 */
	| "leftpanel.running.actions"
	/** 运行会话行内嵌区（与 leftpanel.sessions 并集，只在运行行上出现）。 */
	| "leftpanel.running"
	/** 历史会话行内嵌区（与 leftpanel.sessions 并集，只在历史行上出现）。 */
	| "leftpanel.history"
	/** 左栏「历史对话」分区标题栏按钮（宿主「新对话」按钮之后追加）。 */
	| "leftpanel.history.actions"
	/** 左栏三个分区（最近项目 / 运行的对话 / 历史对话）的顺序与显隐。
	 *  宿主条目（host:lp-projects / host:lp-running / host:lp-history）可隐藏 / 调序；插件可以用
	 *  kind="view" 新增一个自定义分区（正文由插件 bundle 挂载），但不能替换内置分区。 */
	| "leftpanel.sections"
	/** 左栏会话行内嵌区（运行 / 历史两类会话行共用；会话标题旁的徽标/快捷按钮）。 */
	| "leftpanel.sessions"
	/** 对话头部条（标题旁的操作区）。 */
	| "chat.header"
	/** 空对话占位区（新对话的快捷入口）。 */
	| "chat.empty"
	/** 文件预览工具条。 */
	| "file.preview.toolbar"
	/** 终端工具条。 */
	| "terminal.toolbar"
	/** 目标条动作区。 */
	| "goalbar.actions"
	/** 通知条动作区（notice 上的快捷按钮）。 */
	| "notice.actions"
	/** 「后台任务」面板内容区（BgTasksModal）：插件把管理界面嵌进那个面板。
	 *  `kind="view"` 的条目由面板就地内嵌渲染（同 settings.pages 的挂载方式），
	 *  其余 kind 当普通动作按钮处理 —— 这样「pm2 托管的应用」和宿主自己 diff 出来的
	 *  后台进程就在同一个面板里，不需要另开一个独立视图。 */
	| "tasks.panel"
	/** 弹窗（插件声明 kind="view" 的条目，经宿主桥 openModal 按需打开）。 */
	| "modal.dialog"
	/** 左侧边缘悬浮工具条。 */
	| "sidebar.left"
	/** 右侧边缘悬浮工具条。 */
	| "sidebar.right";

/** 插件 UI 挂载点的组合语义。list 允许多个条目并列；single 只允许一个可见条目。 */
export type UiSlotCardinality = "list" | "single";

/** 宿主对一个挂载点的静态语义描述。挂载点由宿主定义，插件不能自行改变其 cardinality。 */
export interface UiSlotSpec {
	slot: UiSlotId;
	cardinality: UiSlotCardinality;
}

/** 条目行为种类（决定宿主怎么渲染、点击怎么分发）。 */
export type UiItemKind =
	/** 切到某个视图（缺省 `plugin:<id>`）。 */
	| "view"
	/** 触发插件回调（host.onUiAction）。 */
	| "action"
	/** 只显示状态文本/角标（可选点击）。 */
	| "badge"
	/** 展开子菜单（children）。 */
	| "menu"
	/** 插件自定义设置页（slot="settings.pages"）。 */
	| "page"
	/** 整理器：可经 host.ui.arrange() 调整其它条目（含宿主内置）。 */
	| "organizer"
	/** 纯分隔线。 */
	| "divider"
	/** 开关（checked 状态经 host.ui.update 刷新，点击回 onUiAction）。 */
	| "toggle"
	/** 单行输入（value 经 host.ui.update 刷新，回车/失焦回 onUiAction）。 */
	| "input"
	/** 进度条（0-100 经 host.ui.update 刷新，只展示）。 */
	| "progress"
	/** 下拉选择（options 候选 + value 当前值；切换回 onUiAction(itemId, value)）。 */
	| "select";

/** 条目在槽位内的对齐（逻辑方向）：start = 行首组、center = 行中组、end = 行尾组。
 *  缺省 start。是否真分组渲染由各槽位的渲染层决定（当前只有输入框动作区
 *  composer.actions 落成左/中/右三组；composer.leading 与其余槽位按顺序渲染，
 *  align 只参与合并与偏好）。 */
export type UiAlign = "start" | "center" | "end";

/** kind="select" 的一个候选项（value 必填；label 缺省回落 value）。 */
export interface UiSelectOption {
	value: string;
	label?: string;
	labelEn?: string;
}

/** 插件声明的一个 UI 条目（manifest.ui.<slot> 数组元素 / host.ui.register 入参）。 */
export interface UiContribution {
	/** 条目 id（同一插件内唯一；全局 id = `<pluginId>:<id>`）。 */
	id: string;
	/** 挂载点（manifest 里由所在数组决定；运行时注册可显式给）。 */
	slot: UiSlotId;
	/** 文案（中文界面）与英文回落。 */
	label: string;
	labelEn?: string;
	/** emoji/单字符图标 或 宿主图标名。 */
	icon?: string;
	/** 内联 SVG 图标（有则优先于 icon 渲染）。 */
	iconSvg?: string;
	/** 悬浮提示。 */
	hint?: string;
	hintEn?: string;
	/** 行为种类（缺省 "action"；仅 slot="settings.pages" 时缺省为 "page"）。 */
	kind?: UiItemKind;
	/** kind="menu" 的子项（一层足够，宿主不再递归）。 */
	children?: UiContribution[];
	/** 排序权重（小的靠前；缺省 100）。 */
	order?: number;
	/** 对齐组（缺省 start；同组内仍按 order/声明顺序排）。 */
	align?: UiAlign;
	/** 分组标签（同组连续排布并加分隔）。 */
	group?: string;
	/** 默认隐藏（进溢出菜单/布局页，用户可打开）。 */
	hidden?: boolean;
	/** kind="action"/"menu" 子项：点击时回给插件 host.onUiAction(action, itemId)。 */
	action?: string;
	/** kind="view"：目标视图（缺省 `plugin:<id>`）。 */
	view?: string;
	/** 宿主上下文条件（宿主不认识的值直接忽略，不报错）。
	 *  已知词表（右键菜单求值，见 web/src/context-menu-state.ts）：
	 *  `"disabled"`（恒置灰）/ `"always"`（恒可用）/ `"never"`（恒置灰）；
	 *  `"!x"`（要求 x 为真，如 `"!message.hasSelection"`，为假则置灰）；
	 *  肯定形适用条件：`file.isDir` / `file.isFile`（文件菜单）、
	 *  `session.isRunning`（会话菜单）、`message.hasSelection`（消息菜单）——
	 *  为假则置灰。其它槽位暂不求值（保留但不置灰）。 */
	when?: string[];
	/** 角标/状态文案（kind="badge"；插件运行时可经 host.ui.update 刷新）。 */
	badge?: string;
	/** kind="toggle" 的开关态 / kind="input" 的输入值 / kind="progress" 的 0-100 进度
	 *  （运行时经 host.ui.update 刷新；progress 越界由宿主钳制）。
	 *  kind="select" 复用 value 存当前选中值（options 候选见下）。 */
	checked?: boolean;
	value?: string;
	progress?: number;
	/** kind="select" 的候选项（最多 32 个；其它 kind 下忽略）。 */
	options?: UiSelectOption[];
}

/** 插件对**其它条目**（宿主内置 / 其它插件）的整理意图（issue #146 的"顶栏整理器"）。 */
export interface UiArrangeOp {
	/** 目标全局 id：`host:<name>`（内置）或 `<pluginId>:<itemId>`。 */
	id: string;
	/** 移到哪个槽位（缺省 = 目标当前槽位）。 */
	slot?: UiSlotId;
	/** 隐藏 / 显式显示（undefined = 不动）。 */
	hide?: boolean;
	group?: string;
	order?: number;
	/** 改对齐组（undefined = 不动）。 */
	align?: UiAlign;
	label?: string;
	/** 改悬浮提示（与 label 同一路：宿主渲染层把它当 `title`）。 */
	hint?: string;
	icon?: string;
	/** 改内联 SVG 图标（与 icon 同一路；空串 = 清掉）。 */
	iconSvg?: string;
}

/**
 * 宿主 UI 布局的**用户偏好**——优先级最高：用户手动 > 插件 arrange > 宿主默认。
 * key = 全局条目 id（`host:<name>` 内置条目，或 `<pluginId>:<itemId>` 插件条目）。
 * 插件能隐藏/分组任何条目（含宿主内置），但用户随时能在这里覆盖回去，
 * 设置面板「界面布局」页据此列出每一项的**来源**并支持逐条/一键恢复。
 */
export interface UiLayoutPrefs {
	/** 用户手动隐藏的条目（覆盖插件 arrange）。 */
	hidden?: string[];
	/** 用户手动显示的条目（覆盖宿主默认/插件声明的 hidden）。 */
	shown?: string[];
	/** 用户排序（key 列表，靠前的先排；未列出的按插件 order → 声明顺序）。 */
	order?: string[];
	/** 用户自定义分组。 */
	groups?: Record<string, string>;
	/** 用户自定义对齐（最高优先级，覆盖插件声明与 arrange）。 */
	align?: Record<string, UiAlign>;
	/** 用户自定义文案。 */
	labels?: Record<string, string>;
	/** 顶栏按钮文字总开关（默认开；false = 只剩图标，数字角标保留，溢出菜单仍带文字）。 */
	topbarText?: boolean;
	/** 侧边图标停靠栏（SideDock）的形态：默认 false = **贴边槽位**（作为 `.layout` 的 flex
	 *  子项，面板/主区向它让宽，永不遮挡面板按钮）；true = **悬浮**（贴在屏幕左右边缘的
	 *  `position:fixed` 浮层，不占布局宽，但会盖住面板竖中央那一条）。 */
	sideDockFloat?: boolean;
	/** 用户自定义槽位/位置（将条目挪到 topbar.primary / bottombar / sidebar.left / sidebar.right）。 */
	slots?: Record<string, UiSlotId>;
}

/** One of pi's built-in providers, with whether auth is configured. */
export interface ProviderStatus {
	id: string;
	name: string;
	configured: boolean;
	/** Where auth came from: stored / runtime / environment / models_json_key … */
	source?: string;
	/** Whether the provider accepts an API key credential. */
	supportsApiKey: boolean;
	/** Whether the provider supports an OAuth login flow. */
	supportsOAuth: boolean;
	/** Provider-specific account name shown in the OAuth action. */
	oauthName?: string;
	/** Whether the active stored credential is OAuth. */
	usingOAuth: boolean;
}

export type ProviderOAuthPromptPayload =
	| { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| {
			type: "select";
			message: string;
			options: { id: string; label: string; description?: string }[];
	  };

export type ProviderOAuthEventPayload =
	| { type: "info"; message: string; links?: { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

export interface ProviderOAuthFlowState {
	flowId: string;
	provider: string;
	promptId?: string;
	prompt?: ProviderOAuthPromptPayload;
	event?: ProviderOAuthEventPayload;
}

/** One stored API key for a built-in provider (NICKNAME only — the raw apiKey
 *  and any masked fragment never leave the server). A provider can hold several
 *  keys — exactly one is active and routes the provider's requests. The UI groups
 *  models by key name so clicking a model under a key activates that key on the
 *  fly; the server resolves the stored value from the name. */
export interface ProviderKeyInfo {
	/** User-chosen (or auto-generated) name — the ONLY identifier the frontend
	 *  sees. Unique per provider. */
	name: string;
	/** true = this key currently routes requests for the provider. */
	active: boolean;
}
/** ONE RUNNING conversation (each runs its own session in parallel). The
 *  list is GLOBAL across projects — a background run from another workspace
 *  stays visible until it is opened and left without continuing — and holds
 *  every conversation displaced to the background while still streaming
 *  (background-finish keeps them listed, opening-and-leaving-without-
 *  continuing removes them), PLUS the ACTIVE conversation once it has content
 *  (issue #140: the chat you are looking at must not be missing from the list;
 *  a blank new chat stays out). cwd lets the client group by project. */
export interface ConversationSummary {
	id: string;
	/** Display title: first user prompt (truncated) or the default. */
	title: string;
	cwd: string;
	messageCount: number;
	isStreaming: boolean;
	/** 这是子代理对话（左栏带「子代理」徽标；可点开查看/补充/中止）。 */
	isSubagent: boolean;
	/** DSH Agent 预设 id（standard/ptc/minimal/cordis/自建；pi 引擎不填）。 */
	agentPreset?: string;
	/** 预设已锁定（首轮用户发言后；空白会话可切换）。 */
	presetLocked?: boolean;
	/** 子代理最近一次运行报错（左栏红点；普通对话不带）。 */
	error?: string;
	/** 子代理最近一次运行被中止。 */
	canceled?: boolean;
	/** 父对话 id（Running 面板嵌套展示用）。 */
	parentId?: string;
	/** 稳定会话 UUID（供 `#s=<sessionId>` URL 深链与右键「复制会话链接」使用，issue #587）。 */
	sessionId?: string;
	/** 落盘会话文件（persisted conversation 才有；inMemory 子代理缺省）。
	 *  右键「复制会话文件路径」与 AI 按 path 读历史时用。 */
	sessionFile?: string;
	/** 有问卷正在等答复（本会话 + elsewhere 行都挂「?」角标；点进去即可回答）。 */
	hasQuestion?: boolean;
	/** 等答复问卷的 ID（如 q-1），用于客户端去重与精准识别。 */
	questionId?: string;
	/** 等答复问卷的简短标题/题目（首题 header 或 question 文本），供横幅与列表展示。 */
	questionTitle?: string;
	/** 临时会话（不落盘、关闭即销毁、不进历史；不占持久会话名额）。 */
	isEphemeral?: boolean;
	/** 用户钉住（常驻运行列表）：切走也不释放，左栏行带 📌 标记。 */
	pinned?: boolean;
	/** 派生源信息（若本会话是从另一会话的消息派生而来）。 */
	forkFrom?: {
		conversationId: string;
		messageId?: string;
		title?: string;
	};
}

/** A conversation open on ANOTHER client (different tab / device) —
 *  read-only awareness for issue #145. The owning client holds the only
 *  writer for that transcript; this entry lets other tabs discover that
 *  "someone else is running in this project" without creating a second
 *  writer. Finished-but-still-held conversations stay listed (isStreaming:
 *  false) so they can still be taken over and viewed after the run ends.
 *  Rows ARE actionable since manual takeover: owner/convId identify
 *  the takeover target (take_over_conversation); absent = legacy sender
 *  (e.g. DSH engine) that cannot be taken over. */
export interface ElsewhereRunning {
	/** Display title of the remote conversation. */
	title: string;
	/** Workspace it runs in (lets the client group by project). */
	cwd: string;
	isStreaming: boolean;
	/** 落盘会话文件（有则前端可直接按路径打开；缺省 = inMemory/未知）。 */
	sessionFile?: string;
	/** Owning client id (takeover target's holder). Absent = 不可过户. */
	owner?: string;
	/** Conversation id inside the owning client (takeover target). */
	convId?: string;
	/** 有问卷正在等答复 —— 过户后可在本页直接回答. */
	hasQuestion?: boolean;
	/** 等答复问卷的简短标题/题目，供横幅与列表展示。 */
	questionTitle?: string;
	/** 是否为无头伪客户端（定时任务 scheduler:）。
	 *  无头会话不支持过户与跨页作答，前端降级为只读状态展示。 */
	pseudo?: boolean;
	/** 持有方页面已断开（标签页/浏览器关了、手机锁屏后被回收），只剩服务端残留会话。
	 *  行仍可过户（搬 runtime 本体，不造第二个 writer），前端标「离线」以示区别；
	 *  宽限期（PI_WEB_OFFLINE_ROWS_TTL_MS，默认 30 分钟）过后不再下发。 */
	ownerOffline?: boolean;
}

/** DSH Agent 预设名录行（字段以运行时树为准；broken = 名录可见但不可挂载）。 */
export interface UiAgentPreset {
	id: string;
	trust: "system" | "user";
	isDefault: boolean;
	/** 文案（服务端默认语言，pi 内置五档为中文）。非中文界面取 *En ?? *。 */
	name?: string;
	description?: string;
	/** 非中文界面的文案（与审批规则的 labelEn/reasonEn 同一约定）：
	 *  服务端把两种语言都带上，界面按当前语言取，不再把中文硬塞给英文用户。 */
	nameEn?: string;
	descriptionEn?: string;
	order?: number;
	broken?: string;
}

/** DSH 权限预设选项（官方 permissions projection 同源；custom 仅展示，不可切换）。 */
export interface DshPermissionOption {
	/** 预设值（read-only/workspace-write(-never)/danger-full-access/custom）。 */
	value: string;
	/** 文案（服务端默认语言）；非中文界面取 nameEn ?? name。 */
	name: string;
	description?: string;
	/** 非中文界面的文案（见 UiAgentPreset.nameEn）。 */
	nameEn?: string;
	descriptionEn?: string;
}

// ---------------------------------------------------------------------------
// Settings (system prompt / skills / extensions)
// ---------------------------------------------------------------------------

/** One loaded skill, with whether it is currently enabled. Disabled skills are
 *  excluded from the system prompt and from the /skill: command catalog. */
export interface UiSkillInfo {
	name: string;
	description: string;
	enabled: boolean;
}

/** One loaded extension, with whether it is currently enabled. Disabled
 *  extensions are unloaded from the runtime (tools/commands disappear). */
export interface UiExtensionInfo {
	/** Stable identity for the toggle: the npm spec for packages, the resolved
	 *  entry path otherwise. */
	id: string;
	/** Display label: npm package spec (npm:pi-foo) or the path basename. */
	name: string;
	/** Resolved entry path. */
	path: string;
	enabled: boolean;
}

/** 一个子代理模板（设置面板「子代理模板」区的 CRUD 实体，也是 AI 派生子代理
 *  时可选的预设）：角色系统提示词（replace/append）+ 技能/扩展白名单。白名单
 *  空 = 该维度跟随主会话设置。`enabled: false` 的模板停用 —— 设置面板仍可见
 *  可重新启用，但不出现在 AI 工具（subagent_templates / subagent_spawn）里。 */
export interface UiSubagentTemplate {
	/** 唯一标识（AI 在 subagent_spawn 的 template 参数里传这个名字）。 */
	name: string;
	/** 给 AI / 设置面板看的简介（选模板时判断适用场景）。 */
	description: string;
	/** English variant of description (missing/empty = fall back to description;
	 *  server seeds both, panel edits the active UI language's field). */
	descriptionEn?: string;
	promptMode: "append" | "replace";
	/** 模板系统提示词（replace 模式必填；append 模式可空 = 只用白名单限定）。 */
	systemPrompt: string;
	/** English variant of systemPrompt (missing/empty = fall back to
	 *  systemPrompt; subagent_spawn picks by caller language). */
	systemPromptEn?: string;
	/** 技能白名单：非空 → 子代理只启用这些；空 → 跟随主会话技能开关。 */
	enabledSkills: string[];
	/** 扩展白名单（npm:<pkg> / 入口路径）：非空 → 只加载这些；空 → 跟随主会话。 */
	enabledExtensions: string[];
	/** 子代理模型 "provider/id"；空 = 跟随主对话当前模型。 */
	model: string;
	/** 子代理思考强度（"off"…"max"）；空 = 跟随主对话当前思考强度。模型不支持的
	 *  挡位由 SDK 自动收敛（如非推理模型只会是 "off"）。 */
	thinkingLevel: string;
	/** false = 停用（对 AI 不可见）。 */
	enabled: boolean;
}

/** One vision-capable model the vision bridge can use (picker option). */
export interface UiVisionBridgeModel {
	provider: string;
	id: string;
	/** Human-readable label: "qwen3-vl-plus (dashscope)". */
	label: string;
}

/** 从公开 GitHub 仓库检索到的 Skill 技能简要信息 */
export interface RemoteSkillSummary {
	id: string;
	name: string;
	description: string;
	repo: string;
	url?: string;
}

export interface UiMarkerInfo {
	name: string;
	enabled: boolean;
	guidance: string[];
	/** 显示给用户的名称（设置面板中展示；缺省为 name）。 */
	label?: string;
}

/** 单个工具的用户覆盖文案（设置页「工具」区逐工具编辑；空字段/空串 = 用默认）。
 *  三项分别对应 tool schema 的 description、系统提示词 Available tools 的 snippet、
 *  Guidelines 段的要点（见 server/tool-prompt-overrides.ts）。 */
export interface UiToolPromptOverride {
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
}

/** Full settings state pushed to the browser (settings_state). */
export interface UiSettingsState {
	promptMode: "append" | "replace";
	customSystemPrompt: string;
	/** 组合模板 + 各来源覆盖（见 server/prompt-composer.ts）。主会话系统提示词
	 *  = 模板里 {{token}} 展开各来源提示词；覆盖优先于自动内容。 */
	promptTemplate: string;
	promptOverrides: Record<string, string>;
	/** 逐工具文案覆盖（工具名 → description/snippet/guidelines；缺省 = 全部默认）。 */
	toolPromptOverrides: Record<string, UiToolPromptOverride>;
	disabledSkills: string[];
	disabledExtensions: string[];
	/** 统一 Agent 工具禁用名单（单源；live 生效无需 reload）。 */
	disabledAgentTools: string[];
	/** @deprecated 遗留别名（由 disabledAgentTools 推导）：全开才算开。Off → terminal_*
	 *  tools are removed from the active set and the guidance prompt is not injected. */
	terminalToolsEnabled: boolean;
	/** 终端接管 bash（默认关）：bash 执行体改为持久终端（可见/保留状态/静默转后台）。 */
	terminalBash: boolean;
	/** 接管模式下 bash 的静默解阻阈值毫秒数（0 = 一直等到命令结束）。 */
	terminalBashIdleMs: number;
	/** 接管模式下 bash 前台最长等待毫秒数（0 = 不限；达到后自动转后台）。 */
	terminalBashMaxForegroundMs: number;
	/** 工具执行看门狗超时毫秒数（0 = 禁用；默认 20 分钟即 1200000）。 */
	toolWatchdogTimeoutMs: number;
	/** read 工具读目录开关（默认开）：开 → read(目录路径) 列出目录条目（见
	 *  server/read-tool.ts；行为开关，live 生效无需 reload）。DSH 引擎无该覆盖面，恒为 true。 */
	readDirEnabled: boolean;
	/** 「后台任务」面板的自动清理阈值（分钟；0 = 关）。开着时服务端定期把**未钉住**且
	 *  闲置超过该阈值的 AI 起后台实例杀掉并推一条通知（见 server/bg-servers.ts）。 */
	bgAutoCleanupMin: number;
	/** 工具**延迟加载**开关（默认关）：开 → 只有核心工具（bash/read/edit/write）+ `load_tools`
	 *  常驻，其余工具在系统提示词里只有「名字 + 一行摘要」，模型用 `load_tools` 拉取后完整
	 *  参数 schema 才进上下文（见 server/load-tools-tool.ts）。DSH 引擎无 pi 工具注册面，恒为 false。 */
	toolLazyLoading: boolean;
	/** codemode 执行模式："on"（常规模式，默认）| "only"（严格代码模式：其他工具对模型隐藏，所有调用都经由 codemode 脚本）。 */
	codemodeMode: "on" | "only";
	/** codemode 系统提示词中内联工具声明的预算 Token（默认 3000）。 */
	codemodeInlineBudget: number;
	/** @deprecated 遗留别名（由 disabledAgentTools 推导）。开 → AI 可用不严格要求缩进的 edit_soft 工具。 */
	editSoftEnabled: boolean;
	/** 问卷提问开关（默认开）。关 → 模型不再弹问卷对话框。 */
	questionnaireEnabled: boolean;
	/** 工具执行审批（人机协同）总开关（默认开）。关 → 一切审批都不弹：内置高危检测
	 *  直接放行（纯运行开关，无需 reload）。 */
	toolApprovalEnabled: boolean;
	/** 当前对话的审批放行策略（仅内存，不落盘；设置面板「已记住的放行」撤销区）。 */
	approvalPolicy: UiApprovalPolicyState;
	/** 审批规则列表（全局共享；<dataDir>/approval-rules.json；支持自定义拦截/放行/直接拒绝）。 */
	approvalRules: UiApprovalRule[];
	/** 同项目并行提醒开关（默认开）。关 → 同项目并行时不发 notice、不给 AI 注提醒、不通知对端。纯运行开关，无需 reload。 */
	parallelReminderEnabled: boolean;
	/** 目标模式（目标条 + 调研向导 + 审查循环）总开关（默认开）。关 → 目标条
	 *  隐藏、无法设目标/启动调研/触发审查。纯运行开关，无需 reload。 */
	goalModeEnabled: boolean;
	/** 思考文本是否换行（默认开 = pre-wrap；关 = 长行横向滚动）。 */
	thinkingWrap: boolean;
	/** 开发模式：index.html 不缓存。默认跟安装方式（源码开/安装包关），设置可覆盖。 */
	devNoCache?: boolean;
	/** 新构建就绪自动重载页面。默认跟安装方式（源码开/安装包关），设置可覆盖。 */
	autoReload?: boolean;
	/** 工具调用是否默认展开（默认开 = 展开；关 = 折叠）。 */
	toolsWrap: boolean;
	/** 工具结果里的图片直接显示（默认开）。关 → 工具卡不渲染缩略图。
	 *  纯 UI 偏好。 */
	toolImagesEnabled: boolean;
	/** 消息列表尾部保持完整渲染的消息条数（默认 15 = 与原硬编码一致）；更早的消息折叠为摘要行，
	 *  点击摘要行可展开。纯 UI 偏好。 */
	keepRecentMessages: number;
	/** 向上分页加载模式（默认关）。开 → 默认仅挂载最近历史消息，向上滚动或点击加载更早历史，完全跳过视口占位符获得原生流畅度。纯 UI 偏好。 */
	reversePagination?: boolean;
	/** 历史对话列表中是否显示已被 fork 派生的父会话（默认 false = 仅显示链尾最新分支）。 */
	showForkedParentSessions: boolean;
	/** 结束的对话切换时不自动从运行列表移出（默认 false）。 */
	retainFinishedConversations: boolean;
	/** 切换项目时是否打开该项目最近的会话（默认 true 开）。关 → 切换项目时始终创建空白新对话。 */
	openRecentSessionOnProjectSwitch: boolean;
	/** skill 全文注入名单（默认空 = 名录模式）：名单里的技能 {{skills}} 展开正文。 */
	skillsFullText: string[];
	/** 技能名录单描述最大字符数截断（默认 250，0 = 不截断）。 */
	skillsCatalogMaxDesc: number;
	/** 技能名录是否输出 location 物理路径（默认 false = 节省上下文并防止路径泄露）。 */
	skillsCatalogShowLocation: boolean;
	/** 技能名录总字符预算（默认 20000，超限自动降级为紧凑 names-only 模式；0 = 不设限）。 */
	skillsCatalogBudget: number;
	/** Vision bridge on/off (default on). Off → images are sent as-is. */
	visionBridgeEnabled: boolean;
	/** Preferred vision model as "provider/id", or null = auto-detect first. */
	visionBridgeModel: string | null;
	/** Vision-bridge transcription prompt mode: append to the built-in default
	 *  prompt, or replace it entirely (empty text = built-in default). */
	visionBridgePromptMode: "append" | "replace";
	/** Custom vision-bridge transcription prompt text. */
	visionBridgePrompt: string;
	/** 计划模式提示词模式：追加/替换内置默认（空文本 = 内置默认）。 */
	planModePromptMode: "append" | "replace";
	/** 计划模式自定义提示词。 */
	planModePrompt: string;
	/** Extra instructions appended to the built-in goal-review prompt. */
	reviewPrompt: string;
	/** Skills disabled only for the isolated goal-reviewer. */
	reviewDisabledSkills: string[];
	/** 宿主 UI 布局的用户偏好（见 UiLayoutPrefs）。 */
	uiLayout: UiLayoutPrefs;
	/** The FULL system prompt actually in effect for the active conversation
	 *  (compose render: template + per-source overrides + project context +
	 *  skills + tool guidance). Read-only view source for the settings panel;
	 *  empty until the session is ready. */
	effectiveSystemPrompt: string;
	/** 每个来源 token 当前的默认（自动）内容 —— {{token}} 未覆盖时展开成的文本
	 *  （设置面板「各来源」行只读预览用；键 = prompt-composer token，空串 =
	 *  该来源目前无自动内容；会话未就绪时为空对象）。 */
	promptSourceDefaults: Record<string, string>;
	/** 各引擎组装的系统提示词 sections 明细（设置面板查看各段来源与字符数）。 */
	promptSections?: { name: string; text: string; chars: number }[];
	/** 发给模型的 function-calling 工具定义（name + description + parameters
	 *  JSON Schema）只读文本 —— 设置面板「查看当前完整提示词」里与系统提示词
	 *  正文并排展示，方便看到完整初始上下文；会话未就绪时为空串。 */
	toolsSchema: string;
	/** The built-in default vision-bridge transcription prompt. */
	visionBridgeDefaultPrompt: string;
	/** 计划模式的内置默认提示词（设置面板 replace 模式预填用）。 */
	planModeDefaultPrompt: string;
	/** Vision-capable configured models available on this machine. */
	visionModels: UiVisionBridgeModel[];
	skills: UiSkillInfo[];
	/** Same skill catalog with enabled flags evaluated for the reviewer. */
	reviewSkills: UiSkillInfo[];
	extensions: UiExtensionInfo[];
	/** 内置标记工具开关（全局 + 按 marker）。 */
	markersEnabled: boolean;
	disabledMarkers: string[];
	markers: UiMarkerInfo[];
	/** 子代理模板（含停用的；面板据此渲染开关，AI 只在 enabled 的里选）。 */
	subagentTemplates: UiSubagentTemplate[];
	/** 子代理默认模型（"provider/id"；null = 跟随主对话当前模型）。 */
	subagentDefaultModel: string | null;
	/** 大模型 API 出错自动重试次数（默认 6；0 = 失败即停）。 */
	retryMaxAttempts: number;
	/** 上下文压缩软上限（tokens，0 = 关闭）：达到即触发压缩（issue #229）。 */
	softCapTokens: number;
	/** 按模型覆盖软上限（key = "provider/id"）。 */
	softCapByModel: Record<string, number>;
	/** 输入框上方的快捷短语（点击即发送；空 = 不显示）。 */
	quickPhrases: string[];
	/** 快捷短语总开关（默认开；关 = 输入框上方不显示）。 */
	quickPhrasesEnabled: boolean;
	/** 极简新对话开关（默认关；开 = 新对话隐藏提示词模板并隐藏快捷短语）。 */
	minimalNewChat: boolean;
	/** 输入框文字跨对话保留开关（默认关；开 = 切换别的会话不清空；关 = 各会话独立保留）。 */
	preserveDraftAcrossConversations: boolean;
	/** 是否已在服务端 seed 过一次默认快捷短语（跨会话/跨浏览器，用于避免删除后被填回默认）。 */
	quickPhrasesSeeded: boolean;
	/** 已配置鉴权的全部模型（子代理默认模型/模板模型选择器）。 */
	subagentModels: UiVisionBridgeModel[];
	/** 内置默认模板名（settings_state 里供面板标「默认」徽标；用户文件为准时可能
	 *  已删除/改名，长度可与 subagentTemplates 不同）。 */
	subagentDefaultTemplates: string[];
}

export type UpdateItemKind = "webui" | "pi-core" | "package" | "git-extension" | "engine";

export type ServerMessage =
	| {
			/** 子代理同行直接交接协同通知（Peer-to-Peer Handoff Event） */
			type: "subagent_handoff";
			fromRunId: string;
			toRunId: string;
			payload: string;
			timestamp: number;
	  }
	| {
			type: "ready";
			clientId: string;
			serverVersion: string;
			/** 引擎标识（pi）—— 前端据此显示引擎徽标（只读展示）。 */
			engine?: string;
			/** 引擎能力声明（Capabilities）—— 前端据此自适应隐藏不支持的入口。 */
			engineCapabilities?: AgentEngineCapabilities;
			/** Wire-protocol version (server/protocol-version.ts). The client
			 *  compares it against its own copy — a mismatch means the page was
			 *  loaded before an app update and must be refreshed. */
			protocolVersion?: number;
			/** This package's own version (`serverVersion` is the pi SDK's). The
			 *  client used to learn it from the update check, which a managed
			 *  instance never runs. */
			appVersion?: string;
			/** Web-build id (Vite __BUILD_ID__). The client compares it against
			 *  its own baked-in id — a mismatch means the server rebuilt since
			 *  this page loaded and the page should reload itself. */
			buildId?: string;
			/** PI_WEB_MANAGED=1 — updates come from outside, so the client hides
			 *  the update badge and the UPDATE panel. The
			 *  server refuses those messages anyway (server/managed.ts). */
			managed?: boolean;
			/** PI_WEB_TABS — the tabs this instance offers; absent means all of
			 *  them. The client does not draw the others and the server refuses
			 *  their messages (server/tabs.ts). */
			tabs?: string[];
			/** Supervising service manager, when this instance was started by
			 *  `pi-web-ui server start|install` (server/launch-origin.ts). Absent =
			 *  foreground/dev/Docker: no supervisor, so the client hides the
			 *  "restart service" action and the server refuses restart_service. */
			service?: UiServiceInfo;
	  }
	| { type: "snapshot"; state: UiState }
	| {
			/** Incremental snapshot: everything EXCEPT `messages` travels in
			 *  `state`, and only messages appended since baseRev ride in
			 *  `appended`. Persisted messages are content-immutable with stable
			 *  ids, so any mid-array change/truncation (switch session, fork,
			 *  compaction) makes the server fall back to a full snapshot instead.
			 *
			 *  Droppable under backpressure exactly like `snapshot`: a dropped
			 *  delta breaks the client's rev chain, and the next surviving full
			 *  snapshot (or the client's get_state after detecting the gap)
			 *  reconciles — memory stays bounded, correctness self-heals. */
			type: "snapshot_delta";
			conversationId: string;
			rev: number;
			baseRev: number;
			appended: UiMessage[];
			state: Omit<UiState, "messages" | "rev"> & { rev: number };
	  }
	| {
			// Global running-conversation list (see ConversationSummary): all
			// listed conversations across every project, plus the active one once
			// it has content (#140). activeId is the active conversation — the
			// client marks that row as “current” (it is absent from the list only
			// while it is still a blank chat).
			type: "conversations";
			conversations: ConversationSummary[];
			activeId: string;
			/** issue #145：在其他客户端（标签页/设备）上正在跑的对话（只读感知，
			 *  不可点）。为空时缺省（老快照字节一致）。Only set when non-empty. */
			elsewhere?: ElsewhereRunning[];
	  }
	| {
			type: "tool_delta";
			conversationId: string;
			/** Per-conversation monotonic sequence, shared with message_delta —
			 *  a gap tells the client to resync via get_state. */
			seq: number;
			toolCallId: string;
			toolName: string;
			delta: string;
	  }
	/** Live assistant-message increment (thinking/text deltas + usage) that
	 *  deliberately BYPASSES the snapshot channel: send() drops snapshots under
	 *  backpressure, but this message is small and must always get through, so
	 *  big sessions keep rendering live even when full snapshots are dropped.
	 *  seq is per-conversation monotonic — a gap tells the client to resync via
	 *  get_state. The next snapshot remains authoritative and reconciles any
	 *  drift (deltas only patch streamingMessage + stats.tokens). */
	| {
			type: "message_delta";
			conversationId: string;
			seq: number;
			messageId: string;
			usage: { input: number; output: number; total: number } | null;
			assistantMessageEvent: { type: string; contentIndex?: number; delta?: string };
	  }
	/** A tool FINISHED executing (SDK tool_execution_end). Unlike toolResult
	 *  snapshot messages, this arrives the moment the command exits — before
	 *  the model's next response starts — so the UI can show "done, waiting
	 *  for the model" instead of an indefinite "running". */
	| {
			type: "tool_status";
			toolCallId: string;
			toolName: string;
			isError: boolean;
			/** Exit code when the tool result carries one (bash returns it in details). */
			exitCode?: number;
			/** tool_execution_start → tool_execution_end, in ms. */
			durationMs?: number;
	  }
	// -- terminal ------------------------------------------------------------
	| { type: "terminal_output"; conversationId?: string; terminalId: string; data: string }
	| { type: "terminal_exit"; conversationId?: string; terminalId: string; exitCode: number | null }
	| { type: "terminal_list"; conversationId?: string; terminals: TerminalInfo[] }
	// -- command list (.pi/commands.json) ------------------------------------
	| { type: "commands"; commands: CommandDef[]; path: string }
	/** The slash-command catalog for the chat input (builtin + extension +
	 *  prompt template + skill commands). Pushed on attach, on project switch
	 *  and on request (get_commands). */
	| { type: "slash_commands"; commands: SlashCommandInfo[] }
	| { type: "notice"; level: "info" | "warning" | "error"; text: string; textEn?: string }
	/** Sent every ~2s so clients can detect half-open connections and display host metrics / network latency. */
	| { type: "heartbeat"; hostMetrics?: UiHostMetrics; latencyMs?: number }
	| { type: "sessions"; sessions: SessionSummary[] }
	/** Filename matches for the global search panel (reqId echo). Always sent
	 *  in reply to a search_files request — ok:false means the walk failed. */
	| {
			type: "search_files_result";
			reqId: number;
			ok: boolean;
			results: FileSearchResult[];
			/** Walk stopped early (result/time/entry budget hit). */
			truncated?: boolean;
	  }
	/** Conversation-content matches for the global search panel (reqId echo).
	 *  ok:false means the transcript scan failed — treat as no results. */
	| {
			type: "session_search_results";
			reqId: number;
			query: string;
			ok: boolean;
			results: SessionSearchResult[];
	  }
	| { type: "projects"; projects: ProjectSummary[] }
	/** Content of a workspace file for the preview panel. */
	| {
			type: "file_content";
			path: string;
			name: string;
			/**
			 * Preview category: media kinds render via the /api/file HTTP
			 * endpoint (text stays empty); "none" means not previewable.
			 */
			kind: "image" | "video" | "audio" | "text" | "none";
			text: string;
			truncated: boolean;
			binary: boolean;
			/** Total line count of the *read* portion (equal to lines in text). */
			lines: number;
			/** Total file size in bytes. */
			size: number;
			/** 可选：PPT 等富文档的结构化幻灯片数据，前端优先走 PPT 播放器渲染 */
			slides?: PptxSlidePayload[];
	  }
	/** `get_tool_info` 的应答：一条工具的**定义说明**（不含本次调用数据）。
	 *  parameters 是 JSON Schema（SDK 的 TypeBox schema 直接 JSON 化），超限整丢并置
	 *  `parametersDropped`（同 toolResult.details 的口径，见 serialize.ts）。 */
	| {
			type: "tool_info";
			name: string;
			/** 找到定义了没有（没找到时其余字段缺席，前端显示「未找到工具定义」）。 */
			found: boolean;
			/** 当前引擎不支持枚举工具定义（DSH 运行时拿不到时）。 */
			unsupported?: boolean;
			/** SDK 的展示名（label）；缺省时前端用 name。 */
			label?: string;
			description?: string;
			/** 系统提示词里的一行摘要（部分工具才有）。 */
			promptSnippet?: string;
			/** 追加到系统提示词 Guidelines 段的要点。 */
			promptGuidelines?: string[];
			/** 参数 JSON Schema（超 64KB 时缺席，见 parametersDropped）。 */
			parameters?: unknown;
			parametersDropped?: boolean;
			/** 该工具**当前是否启用**（禁用名单里的工具仍在目录里，但模型看不到）。 */
			active?: boolean;
			/** 来源标识（SDK SourceInfo.source，如 builtin / 扩展名 / 插件名）。 */
			source?: string;
			/** 来源作用域：user / project / temporary。 */
			scope?: string;
	  }
	/** `get_tool_prompt` 的应答：一条工具的用户可编辑文案 —— **默认值**（何为出厂）/ 当前覆盖。
	 *  设置页编辑器用它先填进输入框；`found: false` = 引擎里没这个工具（如已卸载）。 */
	| {
			type: "tool_prompt";
			name: string;
			found: boolean;
			/** 当前引擎不支持取工具定义（DSH 未就绪等）。 */
			unsupported?: boolean;
			/** 出厂默认（本模块从不修改的原始定义）。 */
			defaultDescription?: string;
			defaultPromptSnippet?: string;
			defaultPromptGuidelines?: string[];
			/** 用户当前设置的覆盖（缺省 = 没有覆盖）。 */
			override?: UiToolPromptOverride;
	  }
	| { type: "models"; models: ModelInfo[] }
	| { type: "models_config"; providers: UiProviderConfig[] }
	| { type: "providers_status"; providers: ProviderStatus[] }
	| { type: "provider_oauth_started"; flowId: string; provider: string }
	| { type: "provider_oauth_flows"; flows: ProviderOAuthFlowState[] }
	| {
			type: "provider_oauth_prompt";
			flowId: string;
			provider: string;
			promptId: string;
			prompt: ProviderOAuthPromptPayload;
	  }
	| {
			type: "provider_oauth_event";
			flowId: string;
			provider: string;
			event: ProviderOAuthEventPayload;
	  }
	| {
			type: "provider_oauth_result";
			flowId: string;
			provider: string;
			ok: boolean;
			cancelled?: boolean;
			error?: string;
	  }
	| { type: "provider_oauth_logout_result"; provider: string; ok: boolean; error?: string }
	/** All stored API keys per built-in provider (masked). Keyed by providerId. */
	| { type: "provider_keys"; keys: Record<string, ProviderKeyInfo[]> }
	/** 全局默认模型（"provider/id"，null = 未设置）。attach 与每次变更后推送。 */
	| { type: "default_model"; modelId: string | null }
	/** Result of a fetch_models probe: ok + the advertised models (id plus
	 *  whatever metadata the endpoint provided — contextWindow / vision input /
	 *  reasoning / name / maxTokens — same shape as models.json rows), or an
	 *  error string. */
	| {
			type: "fetch_models_result";
			reqId: number;
			ok: boolean;
			models?: UiModelConfigEntry[];
			error?: string;
	  }
	/** Result of a test_model_connection probe: ok + roundtrip latency in ms,
	 *  or an error string. */
	| {
			type: "test_model_connection_result";
			reqId: number;
			ok: boolean;
			latencyMs?: number;
			error?: string;
	  }
	/** Progress notification for enrich_models while downloading catalogs or matching. */
	| {
			type: "enrich_models_progress";
			reqId: number;
			phase: "catalog" | "page" | "matching" | "aborted";
			current?: number;
			total?: number;
			message?: string;
	  }
	/** Result of enrich_models: per-id enrichment (matched fills + suggested
	 *  catalog ids + unmatched notes), or an error string. */
	| {
			type: "enrich_models_result";
			reqId: number;
			ok: boolean;
			results?: UiEnrichResult[];
			error?: string;
	  }
	/** Result of refresh_provider_models: merged into the saved entry; added =
	 *  newly-discovered model ids, total = models now in the saved config. */
	| {
			type: "refresh_provider_result";
			reqId: number;
			ok: boolean;
			added?: number;
			total?: number;
			error?: string;
	  }
	/** Result of refresh_builtin_models: the official pi.dev catalogs were
	 *  re-fetched (force) and the picker was repushed. Per-provider fetch
	 *  failures (if any) are joined into error; the cached catalog still
	 *  applies for those providers. */
	| {
			type: "refresh_builtin_result";
			reqId: number;
			ok: boolean;
			error?: string;
	  }
	/** Result of append_builtin_model: the model row was appended to the
	 *  provider's models.json overlay entry and the picker was repushed.
	 *  The entry also shows up under "custom providers" (same id) where it
	 *  can be edited / removed. */
	| {
			type: "append_builtin_result";
			reqId: number;
			ok: boolean;
			error?: string;
	  }
	/** Result of clone_provider: a ready-to-edit custom-provider draft
	 *  (baseUrl + model catalog copied from the built-in provider; apiKey
	 *  intentionally empty). Not persisted until save_model_config.
	 *  Multi-api providers (e.g. opencode) return `configs` (one per api) —
	 *  `config` is kept as configs[0] for backward compat. */
	| {
			type: "clone_provider_result";
			reqId: number;
			ok: boolean;
			config?: UiProviderConfig;
			configs?: UiProviderConfig[];
			error?: string;
	  }
	/** Result of an install_pi_agent run (npm i -g finished or failed). */
	| { type: "install_result"; ok: boolean; detail: string }
	| {
			type: "path_completions";
			completions: { name: string; path: string; type: "dir" | "file" }[];
	  }
	| { type: "widgets"; widgets: { key: string; lines: string[] }[] }
	| { type: "statuses"; statuses: { key: string; text: string | undefined }[] }
	| {
			type: "dialog";
			id: number;
			kind: "select" | "confirm" | "input";
			title: string;
			args: unknown[];
	  }
	/** The server resolved (or abandoned) a dialog — the client must close it. */
	| { type: "dialog_closed"; id: number }
	/** Open a TUI overlay modal dialog in the web UI. */
	| {
			type: "tui_overlay_open";
			id: number;
			title?: string;
			cols: number;
			rows: number;
			initialAnsi?: string;
	  }
	/** Re-render frame for an active TUI overlay. */
	| { type: "tui_overlay_render"; id: number; ansi: string }
	/** Close the TUI overlay modal dialog. */
	| { type: "tui_overlay_close"; id: number }
	// -- self-update ----------------------------------------------------------
	/** Result of a check_update run (current/latest from the npm registry). */
	| {
			type: "update_status";
			/** Version of the RUNNING process (from its own package.json). */
			current: string;
			latest: string | null;
			/** Publish timestamp (ISO) of the latest version — lets the UI hint
			 * when it was just published and registry caches may lag. */
			latestPublishedAt: string | null;
			upToDate: boolean;
			error?: string;
	  }
	/** Result of a check_updates_all run — one item per checked component
	 *  (webui, the pi core, direct pi extensions). Failed lookups degrade
	 *  per-item. */
	| {
			type: "update_status_all";
			items: {
				name: string;
				kind: UpdateItemKind;
				current: string;
				latest: string | null;
				latestPublishedAt?: string | null;
				upToDate: boolean;
				error?: string;
				/** git-extension only: `host/path` shorthand (prepend `git:` for the `pi update` command). */
				source?: string;
			}[];
			/** issue #321: pi SDK 副本状态快照，随每次 update_status_all 下发。
			 *  `running` = 本进程实际加载的版本（可能是自带副本，也可能是跟随的全局副本）；
			 *  `bundledInUse` = 加载的是随包自带那份（未跟随机器上的全局副本）；
			 *  `newerInstalled` = 机器上比 running 更新的 pi 版本（全局 pi CLI / 被遮蔽副本），
			 *  没有则 null —— 更新面板的 pi-core 行探测的是全局 CLI（`npm i -g` 更新的那份），
			 *  会话实际跑哪份此前在 UI 里不可见，#321 即由此而来。 */
			piSdk?: { running: string; bundledInUse: boolean; newerInstalled: string | null };
	  }
	// -- goal / review -------------------------------------------------------
	/** Goal status pushed whenever it changes (set / review start-end / verdict).
	 *  Review result CARDS are inserted into the main conversation flow as real
	 *  custom messages (rendered like an attachment card), so they persist across
	 *  snapshots/reconnects — this only drives the goal bar status. */
	| { type: "goal_status"; status: GoalStatus }
	/** Current settings state (system prompt mode/text, enabled skills &
	 *  extensions). Pushed on attach and after every settings change. */
	| { type: "settings_state"; settings: UiSettingsState }
	/** DSH Agent 预设名录（DSH only；attach/启动/默认变化后推；legacy 下 presets 空）。 */
	| {
			type: "dsh_presets";
			presets: UiAgentPreset[];
			defaultPreset: string;
	  }
	/** DSH 权限预设选项表 + 新会话默认（DSH only；attach/启动/默认变化后推）。 */
	| { type: "dsh_permission"; options: DshPermissionOption[]; defaultPreset: string }
	/** The model asked the user (ask_user_question tool) — both engines
	 *  (DSH via goal-rpc userQuestions provider, standard pi via the
	 *  pi-web-ui ask_user_question customTool) forward here. The frontend
	 *  shows a dialog and answers via question_answer. Pushed to the active
	 *  conversation; background conversations carry the question in their snapshot
	 *  when switched to. */
	| {
			type: "question_pending";
			id: string;
			/** 服务端超时时间戳（epoch ms，P0-6）；前端显示倒计时，归零自动取消。 */
			deadline?: number;
			questions: UiQuestion[];
			/** 所属会话 id（缺省 = 不限会话 / 全局）。 */
			conversationId?: string;
			/** 所属会话标题/名称（可选），用于在提问弹窗中展示来源对话。 */
			conversationTitle?: string;
	  }
	/** 高危工具拦截触发待审批（Human-in-the-Loop）：弹窗/内联卡片等待用户批准、拒绝或就地修改参数（Edit & Run）。 */
	| {
			type: "tool_approval_pending";
			id: string;
			toolCallId: string;
			toolName: string;
			params: Record<string, unknown> | unknown;
			reason?: string;
			reasonEn?: string;
			/** 命中的规则档位（「允许同类」按它记忆）。 */
			category?: UiApprovalCategory;
			/** 命中的高危规则清单（issue #566）。 */
			hits?: UiApprovalHit[];
			/** 若该工具调用是由某个上层工具嵌套发起（例如 codemode 沙箱脚本调用），记录上层工具名。 */
			parentTool?: string;
			conversationId?: string;
			conversationTitle?: string;
	  }
	/** 审批已完成或被取消/撤回（前端关闭审批弹窗）。 */
	| { type: "tool_approval_resolved"; id: string }
	/** 任务计划更新推送（增量或全量广播）。 */
	| {
			type: "plan_updated";
			conversationId?: string;
			plan: PlanState | null;
	  }
	/** 待答问卷被搬走/取消：前端若正展示该 id 的对话框立即收起（不过户/不恢复）。
	 *  手动过户把问卷搬到另一会话时，源页面靠它收起旧对话框（快照为 null 只能收
	 *  snapshot 来源的面板，即时通道弹出的收不到 —— 见 pending-question.ts）。 */
	| { type: "question_retracted"; id: string }
	/** 跨页作答预告（peek_elsewhere_question 的回包）：另一处问卷的原文，
	 *  本页弹框展示、经 question_answer（带 owner）回去作答。 */
	| {
			type: "elsewhere_question";
			owner: string;
			convId: string;
			id: string;
			questions: UiQuestion[];
			/** 所属会话标题/名称（可选），用于在提问弹窗中展示来源对话。 */
			conversationTitle?: string;
	  }
	// -- background tasks ---------------------------------------------------
	/** The background-server list (servers the agent left running, detected via
	 *  listening-port diffs around bash tool runs). Per CLIENT, not per
	 *  conversation — the list survives conversation switches/ends and only
	 *  empties when the tasks are stopped (individually or all at once) or the
	 *  process exits on its own. Pushed on change, on attach and on request. */
	| { type: "bg_servers"; servers: BgServer[] }
	// -- scheduled tasks (issue #184) ----------------------------------------
	/** Built-in scheduler task list (global, all projects). Pushed on attach,
	 *  on request (schedule_list) and on every change (save/delete/toggle/run). */
	| { type: "scheduler_tasks"; tasks: SchedulerTaskView[] }
	// -- compacted history retrieval (issue #398) ----------------------------
	/** 响应被压缩卡片折叠的历史消息查询（issue #398）。 */
	| {
			type: "compacted_messages_result";
			compactionMessageId: string;
			conversationId: string;
			messages: UiMessage[];
			error?: string;
	  }
	// -- history window paging (on-demand earlier messages) ------------------
	/** `load_earlier_messages` 的回执：`messages` 是比当前窗口更早的一段（前插即可）。
	 *  `messages` 为空 = 已到最早（或服务端无缓存），客户端据此收起加载态。 */
	| {
			type: "earlier_messages";
			conversationId: string;
			messages: UiMessage[];
			historyStart: number;
			historyTotal: number;
	  }
	| {
			type: "transition_progress";
			kind: "cwd" | "session" | "new_chat" | "conversation";
			target: string;
			phase: "fs" | "transcript" | "runtime" | "done" | "error";
			progress: number;
			text: string;
			textEn: string;
			totalMessages?: number;
			previewMessages?: UiMessage[];
	  }
	| { type: "sandbox_diff"; diff: SandboxDiffView };
