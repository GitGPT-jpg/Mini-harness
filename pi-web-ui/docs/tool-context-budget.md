# 工具上下文预算（tool context budget）

> 模型每轮都要吞下「全部活跃工具」的名字 + 完整参数 schema。工具一多，这是几万字符的
> **固定开销**（哪怕这轮只用 bash）。本文档记录压这块开销的三条手段、各自的取舍，以及
> **延迟加载为什么不会打坏供应商的前缀缓存**（这是实现里最容易踩坏的一条）。
>
> 相关代码：`server/load-tools-tool.ts`（按需加载入口）、`server/tool-manager.ts`（门控 +
> `lazyLoadingDisabledTools`）、`server/prompt-composer.ts`（提示词目录段）、
> `server/tool-prompt-overrides.ts`（逐工具文案覆盖）、`server/agent-service.ts`
> 的 `applyToolGating` / `lazyToolCatalog` / `promptToolCatalog` / `loadLazyTools`。

## 1. 一块开销有多大

以 30 个目录/核心工具为例（设置页「查看工具 schema」能看到实时数字）：

| 组成                                           | 约            |
| ---------------------------------------------- | ------------- |
| 工具文字（description + snippet + guidelines） | 11.3k 字符    |
| 参数 schema（JSON，含参数说明/枚举/默认值）    | 18.6k 字符    |
| **下发工具 schema 合计**                       | **~33k 字符** |

参数 schema 是结构化的**契约**（枚举、默认值、范围、逐 action 语义），删了模型就会传错参数，
所以「抠字」这条路的下限很低（实测全量收敛后只能再降 ~11%）。

## 2. 三条手段

### 2.1 文案精简（已做）

见 `AGENTS.md` 的「工具提示词三处职责分离」。description = 做什么 + 副作用；snippet = 触发
条件（≤80c）；guidelines = 何时用/顺序/禁止。同一件事只说一遍，守卫
`tests/unit/tool-prompt-hygiene.test.ts` 机器把关。

### 2.2 逐工具文案可编辑（已做）

设置 → 工具区「编辑文案」：`description` / `promptSnippet` / `promptGuidelines` 都能覆盖，
留空 = 用出厂默认。存在 `ClientSettings.toolPromptOverrides`，打补丁落在 SDK 合并后的
`_toolRegistry` 上（核心内置 / 本项目工具 / 插件 / MCP 一网打尽）。见
`server/tool-prompt-overrides.ts`。

### 2.3 延迟加载（本机制，**默认关**，可开）

开：只有**核心工具**（`bash` / `read` / `edit` / `write`）与 `load_tools` 常驻；其余工具在
系统提示词的 `{{tools}}` 段里只有**名字 + 一行摘要**（目录），参数 schema 不进上下文。模型
要用时先调 `load_tools(["patch","lsp"])`，那批工具被激活，schema 才随之下发。

- 开关：设置 → 工具区「工具按需加载」（`ClientSettings.toolLazyLoading`，**出厂默认关**）。
  默认关的理由：模型忘加载会先吃一次 `Tool <name> not found`（SDK 只认已声明集），开箱
  即用优先；需要省上下文的实例自己打开，部署级默认可用环境变量 `PI_WEB_TOOL_LAZY_LOADING=1`
  / `true` / `on` / `yes`（只作默认值，用户已存盘的设置优先）。
  关着 = 按开关/预设直接全部活跃（与 pi 命令行一致）。**只影响新会话与之后的门控重放**——
  不会把正在跑的对话里的工具反向清空。
- 门控实现：延迟加载**不引入第二条门控路径**。未加载 = 临时加进禁用名单
  （`lazyLoadingDisabledTools()`），走的还是 `applyAgentToolsGating` 那条链。加载只是把
  名字从名单里拿出来。
- `load_tools` 是**常驻脚手架工具**，不入 `AGENT_TOOL_CATALOG`（不能单独关掉它），
  由 `applyAgentToolsGating` 的 `forceActive` 保证在非 standard 预设下也在活跃集里
  （`ask` 预设本来就无工具，不强加）。
- 已加载集合按 **session 对象**存（`WeakMap`）：过户搬的就是 session 本体，集合跟着走；
  会话从转录恢复时用当时的活跃集做种子（上次加载过什么就还是什么）。
- 加载会**拒绝**：未知名字 / 已被用户关闭 / 当前预设不允许 / 计划模式闸门拦截 / 已经加载过
  —— 原因写回工具结果，模型能自己纠正。
- **模型忘记加载、直接调用目录里的工具**（JIT 自动激活）：SDK 在解析工具之前就派发了
  `tool_execution_start`，随后因该工具不在活跃集回一条 `Tool <name> not found`；服务端在
  这个事件里把该工具补进已加载集**并立刻重放门控**，于是它从下一轮起真的活跃 —— 模型原样
  重试即成功，不必先绕道加载别的工具（issue #652）。
- 「已经加载过」按**活跃集**判断，不只看已加载集合：只标记不激活的半吊子状态会被当成
  重新加载并修正，而不是回一句「已经加载过了」把模型堵死（同 #652）。
- DSH 引擎没有 pi 工具注册面，不适用（设置行不显示，协议字段恒为 false 占位）。

## 3. 硬约束：不能打坏前缀缓存

供应商的 prompt cache（Anthropic `cache_control`、OpenAI/DeepSeek 自动前缀缓存）是按**前缀**
命中的：只要这一段和缓存过的完全一致就命中，哪怕后面追加了新内容。所以我们只允许**追加式**
变化，绝不允许「中间改一个字」。

延迟加载天然踩这个坑：直观实现会把「已加载」的工具从目录段挪到「活跃工具」段——目录段一
变，系统提示词就变，整段缓存报废。**本实现刻意规避**：

1. **系统提示词与已加载集合无关**。`{{tools}}` 永远列**完整目录**（
   `promptToolCatalog()`：全部可用工具，注册表顺序，**不过滤已加载**），末尾只有一段
   **恒定**说明「有一部分工具 schema 未附，先用 `load_tools`」。加载前后逐字节相同。
2. **guidelines 只取基线**。延迟加载下系统提示词的 Guidelines 段只含核心工具 +
   `load_tools` 的要点；被加载工具的要点**随 `load_tools` 的回执文字**进对话（追加，不是
   改前缀）。
3. **tools 数组只追加**。加载只产生 `toolsAdded` 增量（SDK 的 `getToolStateChanges`），
   不会出现 `toolsRemoved`/redefinition；支持中途工具变更的供应商（Anthropic
   `defer_loading`、OpenAI `additional_tools` / `tool_search`）会把新增工具**锚在初始声明
   上**流式注入（`resolveTranscriptTools` 的 `anchorsAdditions`），其余供应商把当前列表
   原样下发，也是「旧前缀 + 新尾巴」。
4. **顺序稳定**。目录与基线名单都按注册表顺序生成，同一设置下重复渲染结果一致。

回归：`tests/lazy-tools-test.mjs`（零 token，mock LLM）直接断言
「加载前后 system 文本**逐字节相同**」与「第二次的 tools 以第一次为**前缀**」，并覆盖
「模型直呼未加载工具 → 该工具自动激活 → 原样重试成功」这条 JIT 路径（#652）。

⚠️ 会破坏缓存的操作（都在我们的控制面内）：改 `toolPromptOverrides`（工具定义变了 →
redefinition）、关掉某个工具（`toolsRemoved` → 该对话之后只能走非锚定路径）。这些是用户
主动操作，一次性代价可接受；但**不要**在自动化路径里改这些。

## 4. 换来的收益与代价

（都是**开启**这个开关之后的口径；出厂默认关，所以下面是「想省上下文时才付的代价」）

- 收益：常驻 schema 33k → **~7k**（核心工具 + load_tools）。用不到的工具体永远不进上下文；
  系统提示词本身也从 ~8.6k 降到 ~6.7k（guidelines 只剩基线）。
- 代价：模型多一步「先加载再用」。目录（名字 + 一行摘要）仍常驻，发现性不丢；加载失败会
  写明原因。弱模型可能忘记加载——所以这个开关**出厂默认是关的**（见 §2.3）。
