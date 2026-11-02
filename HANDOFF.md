# 训推引擎组 Harness 交接文档

> 更新于 2026-11-02。当前工作区为 `/Users/zhangteng14/ComateProjects/pi agent 的定制化`，分支 `harness-cockpit`。本轮整理为 1.0.1（1.0 系列收尾版），同步 GitHub 并更新 iCode CR #123037970；推送及合入状态以远端为准。已公开的 v1.0.0 标签保留。
> 读法：先看第 0 节「现状」和第 11 节「待办」；要改代码再看第 3–10 节。

## 0. 现状

- **产品**：「训推引擎组 Harness」是上游 pi-web-ui v0.111.0 的源码裁剪定制版，跑 pi 1.4.0，接 Baidu One API 网关，服务推理侧（sglang / AttentionStore / prefill / cache）的 AI Loop 工作流。
- **D-9 已完成**：旧做法是 npm 装 pi-web-ui 包，再由 `harden.mjs` 改写 `dist/`、往 `index.html` 注入脚本。现在所有定制都在 `pi-web-ui/` 源码里；`harden.mjs`、`verify-hardened.mjs`、`harness-server/` 已删除。
- **能用**：`./setup.sh` 一键安装 → `pi-web-cockpit/start-hardened.sh` 启动 → 首次配置弹窗填 One API Key → 直接对话。干净 HOME 实测通过，setup 可重复跑。
- **本轮测试（2026-11-02）**：typecheck、lint（0 warning / 0 error）、build 通过；vitest 313 个文件全过（3362 通过、9 跳过）；任务入口与详情浏览器用例通过；冒烟 58/59，终端时序用例独立重跑 55/55 通过。首装、真实模型和集群结论仍属历史记录，本轮没有重验。
- **残留清理**：删除失效的 SSH/MCP 测试辅助文件、临时脚本、DSH 探针与社区投票 Worker；移除两个 DSH 直接依赖及 38 个锁文件包条目。CLI 明确拒绝退役引擎，开发说明按当前功能更新。详见 `pi-web-ui/DELIVERABLES.md` 顶部记录。
- **提交方式**：GitHub 保留开发历史；iCode 将同一源码树压成一个评审提交，沿用卡片 luno-5578 与 CR #123037970。提交评审不等于合入 master。

## 1. 仓库与分支

| 项 | 说明 |
|---|---|
| 主工作区（唯一工作树） | `/Users/zhangteng14/ComateProjects/pi agent 的定制化`，分支 `harness-cockpit`（`main` 同构对齐；原关联工作树 `mini-harness-cockpit` 已在转正后清理） |
| GitHub | remote `github` = `https://github.com/GitGPT-jpg/Mini-harness`，`harness-cockpit` 与 `main` 均已推送最新提交 |
| icode | remote `origin` = `icode.baidu.com/baidu/ai/mini-harness`。禁止直推 master，commit 需绑 iCafe 卡（luno-5578）；CR #123037970 用于源码版 1.0 系列评审，需他人审核 |
| 本机在跑的驾驶舱 | `127.0.0.1:8787`，2026-11-02 核查已运行主工作树构建产物。**测试别占这个端口，也别杀这个进程** |
| 上游来源 | 见 `pi-web-ui/PROVENANCE.md`：xing-shuyin/pi-web-ui v0.111.0（tag commit `7c40b44`，MIT），vendor 基线提交 `30902c1` |

## 2. 做过什么

- **A–C 阶段**：vendor 上游源码；SDK 固定 1.4.0；把 Loop 运行时（原 `vendor/mini-harness-runtime`）移植为 `pi-web-ui/server/loop/extension.ts`，修了 6 个正确性问题（显式 sessionId / taskId 绑定、epoch 守卫读盘、续跑互斥、启动挂起记录等）；前端 LoopBar 与状态栏 Loop 段。
- **D-1–D-8**：删除桌面壳、语音/TTS、Canvas、插件/MCP/技能市场、38 个无关插件、SSH 远程、Git 面板、文件树、多引擎、Plan/Delegate 入口，净删约 32.6 万行。
- **E**：交付清单 `pi-web-ui/DELIVERABLES.md`。
- **D-9（本轮，详细说明见各提交信息）**：

| 阶段 | 内容 | 提交 |
|---|---|---|
| D-9a | 安全项：绝对路径读取白名单（工作区、`~/.mini-harness`、系统临时目录，其余 403）；`defaultOn=false` 的工具不再被打开；codemode 按需注册；技能硬禁名单 | 5483c64 |
| D-9b | 能力与默认值（关沙盒 / plan / delegate / 子代理 / pageRef / 远程 SSH，vision 与工具图片默认关，工具延迟加载默认开）；品牌（标题、manifest、顶栏、PWA 图标）；领域灵魂；首次配置预选 oneapi | 95eba81、81bc05e、1268962 |
| D-9c | 去掉 CSS 隐藏的残余入口；8 个推理启动提示词模板；子代理模板收敛为 review / implement / explore + 5 个推理专属 | bba6b31 |
| D-9d | Loop 自主化，服务端 + 前端（见 4.3） | 6875645、a5f9a05 |
| D-9e | 统一启动/安装入口；`PI_WEB_TOKEN=auto`；删除 harden.mjs、verify-hardened.mjs、harness-server/ | fc74f04、7412e68 |
| D-9f | 测试全绿；干净 HOME 实测发现并修复两处首装问题；`verify-cockpit.mjs`；交付文档 | 04a695d、eee6e64、b787b1f、c67b634、9cc13c9 |

- **D-10**（提交 `7f8a39f`，本地未推）：删掉顶栏「插件」入口（插件面板、插件管理弹窗、设置页「界面插件」页、插件任务进度条）和右侧空栏（`RightPanel` 连同 D-6b 后残留的文件树代码、`FileTransferDialog`、`SlotTabs` 和对应 CSS）；清理 106 个已无引用的 i18n key 并同步 12 个语言包；设置页里 pi 扩展那一页改名「扩展」（列的是 pi-llm-wiki 这类 pi 扩展包，不是界面插件）。插件运行时、MCP、page-picker 浏览器扩展保留。
- **D-11**（提交 `70f90bd` + 其后一笔，本地未推）：用户看过设置页后要求删掉「系统提示词 / 预设 / 插件（扩展）/ MCP / 目标审查」，并说插件只要 wiki 就够。删了这五个设置分区；插件运行时整套（服务端 20 个 `plugin*` 模块与 `browser-page-tool`、前端插件宿主/视图/围栏/图标/浏览器操作按钮、`plugins/`（含 page-picker）、`plugin-sdk/`、CLI 插件子命令、网页引用附件）；MCP（自带 MCP 桥、`mcp_manage` 工具，并给 SDK 资源加载器传 `disabledBuiltinExtensions: ["mcp"]` 关掉 SDK 自带的 MCP 扩展）；设置预设（保存/应用/导入/导出/分享与 `preset-share`/`preset-fields`/`net-guard`）。保留并改名的：`plugin-schedule.ts` → `cron-spec.ts`（定时任务的 cron 解析）、`plugin-conversation-view.ts` → `conversation-view.ts`（定时任务读对话）、`readConversationForPlugins` → `readConversationForScheduler`。pi-llm-wiki 扩展照常加载（18 个 `wiki_` 工具在会话里可用），只是设置里不再有列出它的页面。系统提示词按已存配置组装，LLM loop 的目标审查用默认配置。旧 `client-state.json` 里的 `presets`/`disabledPlugins`/`disabledPluginTools` 字段被忽略，不迁移不删除。

## 3. 仓库地图

```
仓库根/
├── setup.sh              一键安装：Node 校验 → pi@1.4.0 → 领域 skill → One API 服务商 → 构建 pi-web-ui
│                         → 停用 7 个风险 skill → pi-llm-wiki → 桌面 .app（可重复跑）
├── install.sh            命令行安装入口（等价 setup.sh）
├── build/package.sh      打 tarball + macOS DMG（DMG 启动器以 pi-web-ui/dist/server/index.js 判断是否装好）
├── tunnel/tunnel.sh      可选 SSH 隧道兜底（kubectl 直连不通才用），写 ~/.mini-harness/proxy.env
├── skills/               7 个领域 skill 源（setup.sh 拷到 ~/.pi/agent/skills）
├── assets/icon.jpg       桌面 .app 图标源
├── pi-web-cockpit/
│   ├── start-hardened.sh            启动脚本（已入库）
│   ├── verify-cockpit.mjs           浏览器 E2E 验证
│   ├── config/models.oneapi.json    One API 服务商 + 模型目录种子（无密钥）
│   ├── assets/brand-*.png           品牌图源（logo = icon1111，favicon = 紫色 C）
│   ├── vendor/pi-llm-wiki/          审查过的知识库扩展（setup.sh 装依赖并登记）
│   └── package.json                 只剩 SDK / typebox / playwright-core，setup.sh 不再在这里 npm install
└── pi-web-ui/            驾驶舱源码。开发规矩看 AGENTS.md，交付清单看 DELIVERABLES.md
```

## 4. 定制点在源码哪里

### 4.1 安全与精简

- 绝对路径读取白名单：`server/index.ts` 的 `absReadAllowed`。
- 能力开关：`server/engine-capabilities.ts` 的 `DEFAULT_PI_CAPABILITIES`；顶栏按能力门控：`web/src/components/TopBar.tsx` 的 `isCapabilityGatedOff`。
- 客户端默认值：`server/client-state.ts`（vision / 工具图片关、`DEFAULT_TOOL_LAZY_LOADING` 默认开、terminalBash 关）。
- 工具默认关（eval / browser_page / codemode 等）：`server/tool-manager.ts` 的 `AGENT_TOOL_CATALOG`。
- 技能硬禁名单（browser-tools、transcribe、brave-search、gccli、gdcli、gmcli、youtube-transcript）：`server/agent-service.ts` 约 2974 行；codemode 按需注册也在 agent-service。

### 4.2 品牌、灵魂、模板、首次配置

- 领域灵魂：`server/prompt-composer.ts` 的 `BUILTIN_SOUL` / `BUILTIN_SOUL_ZH`。
- 品牌：`web/index.html`（title、favicon）、`web/public/manifest.webmanifest`、`web/public/icons/*.png`、`web/public/favicon.png|svg`；顶栏品牌名在 `web/src/components/BarItem.tsx` 的 `host:brand`。
- 提示词模板：`web/src/components/PromptTemplates.tsx`（8 个 `inf-*` 模板）。
- 子代理模板：`server/subagent-templates.ts` + `subagent-templates-hant.ts`（繁中视图有守卫测试：行数、ASCII token 序列必须一致，不能出现简体专用字）。
- 首次配置弹窗：`web/src/components/PiSetupModal.tsx`（`PREFERRED_PROVIDER = "oneapi"`）。弹不弹由 `server/agent-service.ts` 的 `isPiConfigured()` 决定，其中 models.json 一路走 `server/pi-setup-state.ts`（只认内联 apiKey 的服务商）。填完 key 后补选模型：`server/model-admin.ts` 的 `adoptModelAfterKey` 钩子，实现在 agent-service。

### 4.3 Loop 自主化

服务端：

- `server/goal-service.ts`
  - `wizardPrompt()`：调研向导只给 `goal_ask` 工具，先提问；收敛后必须用 PLAN CHECK 把计划大纲交给用户确认（开始执行 / 我要修改 / 取消），确认后才输出 `GOAL:`；取消或关对话框时向导回复 `CANCELLED`，不设目标、不开跑。
  - `pauseGoal()` / `resumeGoal()`：暂停 = 作废循环代次 + 停掉执行者当前回合，保留目标、执行者与产物；继续时从被打断的那一轮重做。
  - `snapshotExecutor()`：执行者 sessionId 写进 `goal.roles.executor`，任务台据此读工具调用。
  - `logGoal()`：设目标记一条 `created`，收尾追加 `finished:<kind>`（复用同一 id）。
- `server/goal-history-log.ts`：LLM loop 永久目录 `<DATA_DIR>/goal-history.jsonl`，只有 `index.ts` 调过 `configureGoalLog()` 才落盘。
- `server/loop/extension.ts`：代码 loop 运行时（状态机 + validator 门禁 + 自动下一轮 + 续跑），导出 `listRuns` / `familyOf` / `runsRoot` 供路由用。
- `server/loop/routes.ts`：`/api/mini-harness/*`（见第 7 节）。
- `server/agent-service.ts` 的 `startLoop()`：收到 `loop_start_request` 后先调用 `createLoopRun()` 绑定会话并落盘，立即推送状态，再发送执行提示词；模型准备由 `before_agent_start` 处理。没有检查命令时要求模型编写真正检查成果的 `validate.py`。

前端：

- `web/src/loop-cockpit.ts`：三个弹层的开关、集群状态 store、`mhGet` / `mhPost`（`appUrl()` + `withToken()`）。
- `web/src/components/GoalBar.tsx`：显示 LLM loop 运行状态；空闲时使用统一的 `TaskCapsule`，相关弹层打开时收起入口。
- `web/src/components/LoopBar.tsx`：代码 loop 状态与终态动作；复用 `loop-status.ts`，评审出错时支持重试评审或按代码验证收下。
- `web/src/components/TaskModal.tsx`：统一「新任务」弹窗，选择代码验证 + 模型评审 / 仅代码验证 / 仅模型评审，按验收方式分流；原 CodeLoopModal 已删除。
- `web/src/components/RunDetailModal.tsx`：显示验收结论、各轮报告、validator 输出、diff、时间线、指标与经验沉淀入口。
- `web/src/components/TaskDesk.tsx`：任务台抽屉（四段进度、工具调用时间线、暂停/继续/停止、LLM loop 历史、代码 loop 运行列表，可删除）。
- `web/src/components/ClusterControls.tsx`：输入框里的集群按钮、底栏「集群已连接」指示、kubeconfig 弹窗。6 秒一次的状态轮询挂在 App 级的弹窗组件上。
- 插槽 `web/src/ui-slots.ts`：新增 `host:task-desk`（顶栏，排在「后台任务」前）和 `host:cluster`（底栏，紧跟连接状态）。底栏连接文案改为「API 已连接」。
- 样式在 `web/src/styles.css` 的「驾驶舱 Loop 体验」一段；i18n 在 `web/src/i18n.tsx`（`codeLoop*`、`cluster*`、`taskDesk*`、`api*` 等 84 个 key，已同步 12 个语言包）。

### 4.4 启动与口令

- `server/index.ts` 的 `resolveAuthToken()`：`PI_WEB_TOKEN=auto` 时口令落在 `<DATA_DIR>/pi-web-token`（不存在就生成 24 字节随机 hex，权限 0600，重启复用）。不设 `PI_WEB_TOKEN` 时行为与上游一致。
- `pi-web-cockpit/start-hardened.sh`：设好环境后 `exec node pi-web-ui/dist/server/index.js --host 127.0.0.1 --port ${PI_WEB_PORT:-8787}`。

## 5. 怎么跑

```bash
./setup.sh                                   # 仓库根目录；装过再跑也安全
pi-web-cockpit/start-hardened.sh             # 或双击桌面「训推引擎组 Harness.app」
open "http://localhost:8787/?token=$(cat ~/.pi-web/pi-web-token)"
```

`start-hardened.sh` 设置的环境：

- `PI_WEB_TOKEN`：默认 `auto`，已设置则沿用。
- `PI_WEB_LOCALE`：默认 `zh`。
- `PI_WEB_MANAGED=1`：关插件市场与应用内自更新。
- `PI_WEB_SDK=bundled`：固定用随包的 pi SDK 1.4.0，不跟随机器上的全局 pi。
- `PI_WEB_PORT`：默认 8787。端口只能用它改，不能在命令后追加 `--port`（服务端取第一个 `--port`）。
- 有 `~/.mini-harness/proxy.env` 就 source 它；有 `~/.pi-web/kubeconfig` 就导出 `KUBECONFIG`。

开发时：`cd pi-web-ui && npm run dev`（后端 8788 + vite 5173）。改完源码要 `npm run build` 再重启服务，或重跑 `./setup.sh`。

## 6. 运行时数据在哪

- `~/.pi/agent/`
  - `models.json`：setup 种入 oneapi（已有则不覆盖）。
  - `auth.json`、`provider-keys.json`：API key，权限 0600。
  - `settings.json`：`packages` 里登记 pi-llm-wiki，`llm-wiki` 段是静默配置（不配 embedding，不外联）。
  - `skills/`：领域 skill；`skills.disabled/`：被停用的 7 个风险 skill，移回即恢复。
  - `sessions/`：会话转录。
- `~/.pi-web/`
  - `pi-web-token`：访问口令（0600）。
  - `client-state.json`：客户端设置。**改它之前先停服务**，否则运行中的服务会用内存态回写覆盖。
  - `kubeconfig`：「连接集群」保存的配置（0600）。
  - `goal-history.jsonl`：LLM loop 永久目录（只在任务台里删除才会消失）。
- `~/.mini-harness/runs/<runId>/`：代码 loop 的 `state.json` 与 `journal.jsonl`。`~/.mini-harness/proxy.env`：隧道代理环境。

## 7. 接口与协议变更

HTTP（都受 `PI_WEB_TOKEN` 全局中间件鉴权，实现在 `server/loop/routes.ts`）：

- `GET /api/mini-harness/runs[?history=1]`、`GET /runs/latest`：代码 loop 运行列表（非历史视图只给活跃和 5 分钟内结束的）。
- `POST /api/mini-harness/runs/delete {runId}`：runId 须匹配 `^[0-9]{8,}-[a-z0-9]{4,}$`，防路径穿越。
- `GET /api/mini-harness/models`：只回 provider / id / family，不含 baseUrl 和 key。
- `GET /api/mini-harness/task?session=<sessionId>`：读执行者会话 jsonl 尾部 1MB，返回最近 40 条工具调用。
- `GET /api/mini-harness/goals`、`POST /goals/delete {id}`：LLM loop 永久目录。
- `GET /api/mini-harness/cluster`（结果缓存 8 秒）、`POST /cluster {kubeconfig}`（≤256KB，写 0600 后立即跑 `kubectl cluster-info --request-timeout=5s`，并设置服务进程的 `KUBECONFIG`）、`POST /cluster/clear`。

WebSocket（`server/protocol.ts`）：

- 新增客户端消息 `pause_goal`、`resume_goal`。
- `loop_start_request` 新增 `criteria?`、`artifactRoots?`。
- `GoalStatus` 新增 `paused?`，`phase` 新增 `"paused"`；`GoalRoleRef` 新增 `sessionId?`。

CLI：删除了 `pi-web-ui frp` 子命令（原因见第 9 节）。

## 8. 验证

### 8.1 每次改动的三连验

```bash
cd pi-web-ui
npx prettier --write <改动文件>
npm run typecheck
npx vitest run <相关测试>          # 全量：npx vitest run
```

### 8.2 浏览器 E2E

服务起来后跑 `node pi-web-cockpit/verify-cockpit.mjs`。可设 `PORT`（默认 8787）、`TOKEN_FILE`（默认 `~/.pi-web/pi-web-token`）、`KEY_FILE`（出现首次配置弹窗时从这个 auth.json 取 oneapi key）、`SHOTS`（截图目录）。它会真实调用一次模型，并在新终端里 echo 一行。

### 8.3 干净 HOME 实测

步骤见第 12 节。

### 8.4 本轮结果（2026-10-30）

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 0 错误 |
| `npm run build` | 通过 |
| `npm run lint` | 0 error，98 条既有 warning |
| `npx vitest run` | 312/312 个文件通过（3282 过，9 跳过；D-11 删了只测插件/page-picker/MCP/预设的用例） |
| 干净 HOME 跑 `./setup.sh` | 退出码 0，重跑仍为 0 |
| 首装浏览器 E2E | 14/14，含首次配置填 key 后同一页的真实对话往返 |
| `verify-cockpit.mjs`（隔离实例） | 15/15 |
| `node tests/loop-bar-test.mjs`（双胶囊 + 代码 loop 弹窗） | 14/14 |
| 冒烟 `node tests/run-smoke.mjs`（零 token，各自起服务） | D-10：74/74；D-11 后清单 59 条：58/59，失败的 `terminal-smoke-test` 是本机 zsh 启动偶发，单跑 3 次过 2 次 |

此前冒烟套件的 17 个失败及 `loop-bar-test.mjs` 过期问题已全部修复/清理完毕：

- **D-4 / D-4b / D-5 已删插件与市场的残留测试已清理**：从 `tests/run-smoke.mjs` 移除了 9 个已删插件/SSH/VSCode 条目，删除了 `tests/` 下对应的 14 个废弃测试文件，并移除了 `plugin-test.mjs` 中针对已删市场协议 `plugin_catalog_add` / `plugin_catalog_remove` 的段落。
- **D-9 默认值变更对应的 4 个冒烟用例已对齐**：`lazy-tools-test`（默认开启按需加载 + 改验保留的 `subagent` 目录项）、`vision-bridge-test`（默认关闭视觉桥，测试中显式开启并按需请求 `get_settings`）、`subagent-template-test`（对齐 8 个内置推理/编码子代理模板）、`takeover-test`（显式放行 `disabledAgentTools: []` 以测试 `browser_page` 过户）。
- **补齐与修复其余测试**：恢复了曾被根 `.gitignore` `*token*` 规则吞掉的 `tests/token-auth-test.mjs`（21 项断言全过，并在 `.gitignore` 补齐 `!pi-web-ui/tests/**` 等例外规则）；修复了 `elsewhere-lifecycle-test.mjs` 的伪客户端过户提示断言；重写了 `tests/loop-bar-test.mjs` 以覆盖新的「LLM loop / 代码 loop」双胶囊与 `CodeLoopModal` 弹窗交互（14/14 全过）。

### 8.5 没有实测到的

- 用真实 kubeconfig 连集群：只验了未配置态、空内容拦截、清除。
- 真实模型下「帮我细化」的完整流程（提问 → 计划确认 → 开跑 / 取消），以及暂停与继续。后者目前只有单测（`tests/unit/goal-delegated.test.ts` 的「暂停 / 继续」）。
- 从代码 loop 弹窗发起、跑到 done 的完整一轮：弹窗只验了 UI；Loop 运行时本身在 C 阶段做过真实模型 E2E。
- 任务台在真实执行者会话上的工具调用时间线：接口有单测（`tests/unit/loop-routes.test.ts`）。
- `build/package.sh` 打 DMG / tarball：只改了启动器的「是否已装」判断，没重新打包。
- Linux 上跑 `setup.sh`：只在 macOS 实测过。

## 9. 关键决策与原因

- **暂停的实现**：暂停时作废循环代次并停掉执行者回合，旧循环在下一个代次守卫处静默退出，不走「受阻」收尾；继续时开一个新循环。被打断的那一轮会重做（轮次回退 1），否则有限轮预算会被暂停吃掉，继续后可能直接判「轮次用尽」。
- **LLM loop 永久目录要显式开启**：只有 `index.ts` 调了 `configureGoalLog(DATA_DIR)` 才写盘。单测里直接 `new GoalService` 不会写到真实的 `~/.pi-web`。
- **集群轮询挂在 App 级弹窗上**：按钮和底栏指示只读 store。ChatInput 的单测用假定时器 `runAllTimers`，组件里挂常驻 `setInterval` 会让它判定死循环。
- **代码 loop 走 `loop_start_request`**：服务端先落一条挂起记录再发启动提示词，启动失败有明确原因。不再像旧版那样往输入框里填字再模拟回车。
- **`PI_WEB_TOKEN=auto` 是显式开关**：不改上游默认，不设 token 时行为不变。
- **删掉 FRP 子命令**：`bin/frp-manager.mjs` 依赖的 ssh2 在 D-5 已删，导致整个 CLI 一加载就崩（`systemd-install` 用例连带失败）；FRP 把本地端口暴露到公网，也与驾驶舱只听 127.0.0.1 的安全口径相反。
- **折叠目标条兜底用例改断言**：上游用例要求 `!important`，与 `css-layers` 契约（整份 styles.css 的 `!important` ≤ 1）冲突。改为断言该规则位于无层区（无层规则天然压过 theme 层）。
- **`vendor/mini-harness-runtime/` 已在 D-12 删除**：服务端仍在 `extensionsOverride` 里按路径剔除旧登记；SDK 对 settings.json 里不存在的包路径是跳过的，老用户的旧登记不会报错，也不会和内置版抢工具表。
- **首次配置判定**：models.json 只声明了目录、密钥要填进 auth.json 的服务商（setup.sh 种入的 oneapi 就是）不算「已配置」，否则新机器永远不弹填 key 的弹窗。
- **填 key 后补选模型**：优先设置里的默认模型，其次刚配好的服务商的第一个可用模型；已有真实模型的对话不动。

## 10. 坑与规矩

- **开发规矩全在 `pi-web-ui/AGENTS.md`**：协议只改 `server/protocol.ts`；i18n 改 zh/en 后跑 `npm run i18n:sync`（死 key 守卫会拦没人引用的 key）；CSS 变量先定义后用；`!important` ≤ 1；新增内置条目要在 `web/src/host-icon.tsx` 登记图标名；`tests/unit/ui-slots.test.ts` 钉死了顶栏 / 底栏条目顺序，增删条目要同步改。
- **根 `.gitignore` 有宽规则会吞新文件**：`*token*`、`*.png` 等。D-9b 就被吞过 `auth-token.ts` 和 PWA 图标。新增文件后用 `git check-ignore -v <文件>` 确认；`pi-web-ui/.gitignore` 里有 `!web/public/icons/*.png` 等例外。
- `web/public/manifest.webmanifest` 是 CRLF 换行，**别对它跑 prettier**。
- 提交时 git 钩子会打印几行 `cat: ...` 报错（主仓库路径带空格），无害，Change-Id 照常写入。
- **没有可用模型时 session.model 不是空**：agent-core 会填一个占位模型（provider / id 都是 `"unknown"`），判断「有没有模型」要排除它。
- **测试隔离**：端口用 ≥8900，数据目录用 `mktemp`，不要 `pkill -f`，不要动 8787 上的旧驾驶舱。需要真实 key 时只复制到临时目录，用完连目录删掉。
- **格式检查范围**以 `npm run format:check` 为准；它覆盖不到的目录里有 34 个上游文件本来就不符合 prettier，不用管。
- lint 有 98 条既有 warning（未使用的 import 等），0 个 error，没有清理。

## 11. 待办与建议的下一步

1. **默认分支**：要不要把 `harness-cockpit` 设成 GitHub 默认分支。用户 2026-10-30 明确说先不动。
2. **icode 评审**：源码版沿用 CR #123037970、卡片 luno-5578。从已验证的提交树生成单个评审提交，以 origin/master 为父提交，避免一次推送全部开发历史；无需 stash 或切换主工作区。评审版本的 tree 应与 GitHub 发行提交一致，合入状态以平台为准。
3. ~~**补齐过期测试**~~（已完成：冒烟套件 `run-smoke.mjs` 74/74 全绿、`loop-bar-test.mjs` 14/14 全绿、`token-auth-test.mjs` 21/21 全绿并加入 `.gitignore` 例外）。
4. **补实测**：8.5 列出的几项，尤其是真实集群和真实模型下的「帮我细化」与暂停/继续。
5. **残留清理已进行**：当前清单不再有 `@types/ssh2` 或 DSH 直接依赖，2026-11-02 lint 为 0 warning / 0 error；安装包、wiki 扩展与早期原型等交付物保留。
6. **已知小缺口**：
   - 填 key 后的补选模型只作用于保存 key 的那个页面，同时开着的其他标签页要手动选一次模型。
   - 旧版左下角「多 run 状态药丸」没有移植，由 LoopBar 状态条和任务台的运行列表覆盖。

## 12. 附：干净 HOME 实测步骤

可移植 / 一键安装的结论必须这样验（只验部件会漏掉首装才出现的问题，D-9f 的两处首装 bug 都是这样抓到的）：

```bash
H=$(mktemp -d /tmp/mh-home.XXXX)
git clone -q --no-hardlinks --branch harness-cockpit /Users/zhangteng14/ComateProjects/mini-harness-cockpit "$H/mini-harness"
cd "$H/mini-harness"
CLEAN_ENV=(env -i HOME="$H" USER="$USER" LANG=en_US.UTF-8 TERM=xterm TMPDIR=/tmp \
  PATH="$H/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  npm_config_prefix="$H/.npm-global" npm_config_cache="$HOME/.npm")
"${CLEAN_ENV[@]}" bash ./setup.sh; echo "exit=$?"        # 全局 npm 装到临时前缀，不碰本机
"${CLEAN_ENV[@]}" PI_WEB_PORT=8934 ./pi-web-cockpit/start-hardened.sh &   # 别用 8787
PORT=8934 TOKEN_FILE="$H/.pi-web/pi-web-token" KEY_FILE="$HOME/.pi/agent/auth.json" \
  node pi-web-cockpit/verify-cockpit.mjs
kill %1; rm -rf "$H"                                       # 首次配置弹窗会把 key 写进 $H，务必删掉
```

要点：`env -i` 隔开真实 HOME；`npm_config_prefix` 让 `npm install -g pi` 装进临时目录；共享 npm 缓存只为提速。

## 13. 已完成：D-12（Loop 完成态可信度 / 结构化启动 / 成果查看 / 统一任务入口）

> 2026-10-30 开始。依据用户贴出的评估（对照最初架构基调）分四步做，每步做完在这里打勾并写提交号。中途断了就按这里接着做。

- [x] **D-12-1 完成态可信度**（b4ca3dd）：代码 loop 里 validator 过了但 reviewer 出错（404/超时/非 JSON）时，现在仍是 `status=done` + `lastVerdict=pass`，界面显示「已完成·通过」。改成区分「代码验证 + 模型评审都过」「只有代码验证（没开评审）」「评审掉线」三种；`LoopUiState` / `LoopRunBrief` 带上 `lastReview`（verdict + reasons）和 `stopReason`；LoopBar / TaskDesk 按新语义显示。
- [x] **D-12-2 服务端结构化启动**（b4ca3dd）：用户点启动时服务端直接建 runId、落盘 `state.json`（绑定 sessionId）、立刻推给前端，再让模型干活、干完调 `loop_done`；不再靠模型第一轮自觉调 `loop_start`。
- [x] **D-12-3 成果与证据查看器**（b4ca3dd + 0187103）：`GET /api/mini-harness/runs/:runId/detail` 返回 state、journal 时间线、各轮 review 报告、validator 证据、diff；任务台/状态条点开 run 看详情（目标、各轮结论、失败原因/否决理由、diff、validator 输出、继续/重试/停止）；状态文案改成「正在干活·第 N/M 轮」「还没过关·查看证据」「裁判掉线·等待重试」「交卷了·查看成果」。
- [x] **D-12-4 统一任务入口**（0187103：`TaskModal.tsx` 取代 `CodeLoopModal.tsx`，一枚「新任务」胶囊）：一个「新任务」入口（保留模板），填「做什么」「怎么算完成」，选验收方式（代码验证 + 模型评审 / 仅代码验证 / 仅模型评审），不用先选 LLM loop 还是代码 loop。
- [x] **D-12-5 收尾**（b4ca3dd + 0187103）：删掉已不引用的 `pi-web-cockpit/vendor/mini-harness-runtime/`、`pi-web-cockpit/config/client-state.seed.json`；三连验 + vitest + 冒烟 + 新页面浏览器 E2E（无报错）；更新本文件与 `pi-web-ui/DELIVERABLES.md`；本地提交，不推送。

预览：`PI_WEB_PORT=8788 PI_WEB_DATA_DIR=/tmp/mini-harness-cockpit-preview PI_WEB_TOKEN=auto node pi-web-ui/dist/server/index.js --host 127.0.0.1 --port 8788 --cwd <worktree> --no-browser`（独立数据目录，不碰 8787 旧舱）。

### 13.1 设计约定（D-12 各步共用，改代码前先读）

**完成态语义（D-12-1）**：`state.json` 新增 `acceptance`，只在 `status=done` 时有值。
- 代码 loop、validator 通过：评审通过 → `passed`；没开评审（`useReviewer=false` 或没有可用评审模型，verdict=`skip`）→ `passed-validator-only`；评审否决 → 照旧进下一轮或到上限停（`stopReason=reviewer-block`）；**评审出错 → `status=stopped`、`stage=review-error`、`stopReason=reviewer-error`，不算完成**（`lastVerdict` 仍记 validator 的 `pass`，`lastReview` 记 `error` + 原因）。
- LLM 模式（mini-harness `mode=llm`）：评审通过 → `passed`；关评审 → `self-declared`；评审出错 → 照旧 stopped/reviewer-error。
- 评审出错后两条路：①「重试评审」= `loop_resume`，允许 `stopped + reviewer-error` 的 run 重新激活（`status=active`、`stage=validate`、`epoch+1`），让模型调 `loop_validate` 重新验收；②「按代码验证收下」= 新消息 `loop_accept {runId}` → `acceptance=passed-validator-only`，journal 记 `accepted-validator-only`（by user）。
- `LoopUiState` 与 `LoopRunBrief` 带上 `acceptance`、`stopReason`、`review {verdict, reasons}`（截断）、`reviewerEnabled`、`mode`、`createdAt`；服务层用一个 `loopUiFromState(st)` 组装，事件路由与续跑共用。

**结构化启动（D-12-2）**：`server/loop/extension.ts` 导出 `createLoopRun(input)`，只做文件与 git 操作：建 runId、可选 worktree、落盘 `state.json`（`sessionId` 绑定、`stage=intake`、`setupPending=true`、记下请求的规划/评审模型与 `useReviewer`、`criteria`）。同会话已有活跃 run 时拒绝。`agent-service.startLoop` 先调它：失败 → `conv.loop` 记 `request-failed` + 通知（不经过模型）；成功 → run 立刻出现在界面上，再发提示词让模型干活（明确说 run 已创建、不要再调 `loop_start`，先 `loop_plan`，完成调 `loop_done`；没有 validate.py 先写一个真正检查的）。扩展在 `before_agent_start` 里看到 `setupPending` 就做模型家族解析与规划（原 `loop_start` 的逻辑），完成后清掉标记、`stage=plan`；家族冲突/模型解析失败 → `stopped`、`stopReason=setup-error`、`setupError` 写原因。`loop_start` 工具保留给对话里模型自己发起的任务，但同会话已有活跃 run 时直接返回那个 run，不重复创建。

**成果查看（D-12-3）**：`GET /api/mini-harness/runs/:runId/detail`（runId 正则校验）返回公开状态字段、journal 时间线（尾部若干条）、每轮 `evidence/round-N-review.md` 与 validator 日志尾部、`lastDiff`（截断）。前端加 run 详情面板（任务台点行、状态条点结果都能打开）：目标与验收标准、代码验证/模型评审两行结论、否决或出错原因、各轮记录、validator 输出、diff；按钮：停止 / 重试评审 / 按代码验证收下 / 用同一目标重新开始。人话状态统一由一个函数产出：正在干活·第 N/M 轮；还没过关·查看失败证据；评审没通过·查看理由；裁判掉线了·等待重试；交卷了·查看成果（仅代码验证 / 模型自述时注明）；已停止；运行出错；没启动起来：原因。

**统一任务入口（D-12-4）**：输入框上沿两枚胶囊合成一枚「新任务」，打开统一弹窗（由 CodeLoopModal 演进）：模板、做什么、怎么算完成、验收方式三选一（代码验证 + 模型评审〔默认〕/ 仅代码验证 / 仅模型评审），高级项（检查命令、产物目录、最多轮数、规划/评审模型）。前两种走 mini-harness 代码 loop（`useReviewer` 开/关）；「仅模型评审」走原 LLM loop（GoalService：`set_goal`，保留「帮我细化」、评审模型、最多尝试、暂停/继续）。运行中的状态显示不变（GoalBar 显示 LLM loop 进度，LoopBar 显示代码 loop）。

## 14. 已完成：转正切换、去 `pi-web-ui` 自主化、推理效率增强与 UI 精修（D-12c）

### 14.1 工作树转正与清理
- 已在主仓库 `/Users/zhangteng14/ComateProjects/pi agent 的定制化` 切换到 `harness-cockpit` 并同步 `main` 分支。
- 已通过 `git worktree remove` + 目录清理彻底移除临时关联工作树 `/Users/zhangteng14/ComateProjects/mini-harness-cockpit`，当前主仓库为唯一事实源，本机 `:8787` 直接运行主仓库构建产物。

### 14.2 方向一：去 `pi-web-ui` 化与全自主能力
- **`HARNESS_*` 自主环境变量桥（`pi-web-ui/server/harness-env.ts`）**：支持 `HARNESS_PORT`、`HARNESS_HOST`、`HARNESS_CWD`、`HARNESS_DATA_DIR`、`HARNESS_ENGINE`、`HARNESS_TOKEN`、`HARNESS_SDK`、`HARNESS_SDK_DIR`、`HARNESS_AGENT_DIR`、`HARNESS_ALLOW_HOSTS`、`HARNESS_ALLOW_ORIGINS`、`HARNESS_HISTORY_WINDOW`、`HARNESS_TOOL_TIMEOUT_MS`、`HARNESS_TOOL_LAZY_LOADING`、`HARNESS_SHELL` 等全套自主变量，优先级高于 `PI_WEB_*`，未设置时 100% 兼容旧变量。
- **独立 CLI 入口（`pi-web-ui/bin/harness.mjs`）**：`package.json` 的 `bin` 新增 `harness` 与 `mini-harness`，支持直接以 `harness --port 8787` 启动或管理服务。
- **Loop 子系统模块化（`pi-web-ui/server/loop/`）**：拆分为 `metrics.ts`（指标解析/最优 Checkpoint/前置探测）、`distill.ts`（经验卡片生成与落盘）、`extension.ts`（状态机与工具）、`routes.ts`（HTTP 路由）。

### 14.3 方向二：最大化提升推理任务效率与质量
- **分级 Validator（L0 快速预检 `precheckCmd` + L1 完整验收 `validateCmd`）**：
  - 在 `TaskModal` 高级项、`loop_start_request` 协议、`loop_start` 工具与 `LoopState` 中新增可选 `precheckCmd`。
  - 每轮验收先跑 L0 `precheckCmd`（超时 5 分钟，用于语法检查 `py_compile`、配置校验、轻量冒烟）；一旦失败立即短路并记录 `precheckFailed: true`，**不执行昂贵的 L1 压测命令，也不调用 reviewer 模型**。
- **结构化指标追踪（`HARNESS_METRIC`）与最优轮次 Checkpoint（`bestRound`）**：
  - 自动解析 validator 输出中的 `HARNESS_METRIC: {"tps": 92.5, "ttft_ms": 118}` 或 `HARNESS_METRIC: loss_pct=13.8 cache_hit=0.96`。
  - 每轮记录 git HEAD `commitSha` 与数值指标，自动计算并维护 `bestRound`（通过态优先，同为通过态按吞吐/命中率正向或损耗/延迟反向比较），注入 `<mini_harness_loop>` 与下一轮修复提示词，并在 `RunDetailModal` 头部展示。
- **前置环境探测与一键经验沉淀（Experience Distillation）**：
  - 创建 run 时自动探测 git 分支/HEAD SHA、项目关键文件（`validate.py` / `pyproject.toml` 等）与 `KUBECONFIG` 状态，注入 `<mini_harness_loop>` 的 `preflight` 行，免去首轮盲探。
  - 新增 `POST /api/mini-harness/runs/:runId/distill` 接口与 `RunDetailModal` 底栏「沉淀经验卡片」按钮，一键将任务目标、模型组合、L0/L1 命令、最优指标与轮次演进归档为 `<DATA_DIR>/knowledge/loop-<runId>.md`（同时备份于 `~/.mini-harness/runs/<runId>/distilled.md`）。

### 14.4 驾驶舱 UI/UX 精修
- **LoopBar 状态条重设计（`LoopBar.tsx` + `.goalbar.loopbar-card`）**：告别原本横跨整列、左对齐的生硬大框，改为**居中紧凑毛玻璃胶囊卡**（`width: fit-content; border-radius: 999px; backdrop-filter: blur(12px)`），按运行色调（`tone-busy` 紫 / `tone-ok` 绿 / `tone-warn` 琥珀 / `tone-bad` 红）精细描边，内部动作按钮全部圆角胶囊化。
- **底栏左下角 Loop 状态项重设计（`BarItem.tsx` 的 `host:loop` + `.status-loop`）**：
  - 统一复用 `loopStatus()` 人话状态，升级为可点击的圆角状态胶囊（点击直接打开当前 `RunDetailModal` 或 `TaskDesk`）；
  - 修复非活跃/已停止任务在底栏持续跳秒（如 `56241s`）的问题，仅在 `active` 时实时计时；补齐 `.status-dot.mid` / `.status-dot.idle` 样式。
- **顶栏与底栏细节修复**：
  - 将任务台内部徽标选择器收紧为 `.task-desk-meta .task-desk-chip`，不再污染顶栏「任务台」按钮的 `.topbar .chip` 高度与内边距；
  - 为底栏网络延迟 `.status-latency` 增加左边距，修复 `"API 已连接3ms"` 文字粘连。
