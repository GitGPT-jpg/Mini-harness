# AGENTS.md — Harness 源码开发指南

> 本目录是训推引擎组 Harness 的 Web 服务源码。修改项目指令后，在 pi 中运行 `/reload`。
> 上游为 xing-shuyin/pi-web-ui v0.111.0（MIT）；来源与引入提交见 [PROVENANCE.md](PROVENANCE.md)，许可证见 [LICENSE](LICENSE)。历史规则来自上游开发经验，现行功能以本仓库源码为准。

## 1. 当前边界

仅使用 `@earendil-works/pi-coding-agent` SDK（随包固定 1.4.0），Node >=22.19.0。
后端 Node ESM + Express + ws；前端 React 19 + Vite 8；终端 node-pty + xterm.js。
主要功能是对话、模型配置、附件与成果预览、终端、任务台和受控 Loop。

Electron 桌面壳、DSH 等其他引擎、界面插件运行时及 plugin-sdk、MCP bridge、设置预设分享已删除。
SDK 资源加载器还通过 `disabledBuiltinExtensions: ["mcp"]` 禁用 SDK 自带 MCP 扩展。
pi 扩展与界面插件不是同一套机制：内置 Loop 扩展和安装的 pi-llm-wiki 仍可加载。

**不能按关键词删代码**：`GoalService`、系统提示词组合与覆盖、工具集预设、权限预设、子代理模板、
内置 UI 布局、定时任务和多根工作区仍有实现。Plan/Delegate 的产品入口已裁剪，底层门禁仍保留。
设置中移除系统提示词/目标审查分区，不代表运行时不再读取对应配置。

## 2. 入口与事实源

| 模块         | 入口与约束                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| 启动         | 仓库根 `setup.sh`、`pi-web-cockpit/start-hardened.sh`；本目录 `bin/harness.mjs` 转交兼容 CLI                      |
| HTTP / WS    | `server/index.ts`；协议唯一事实源 `server/protocol.ts`，`web/src/types.ts` 只 re-export                           |
| 会话         | `server/agent-service.ts` 的 `ClientSession`；每个对话独立 runtime                                                |
| 统一任务入口 | `web/src/components/TaskModal.tsx` / `TaskCapsule`：一枚「新任务」胶囊                                            |
| 代码验收任务 | `loop_start_request` → `ClientSession.startLoop()` → `server/loop/extension.ts` 的 `createLoopRun()`              |
| 模型评审任务 | TaskModal 的「仅模型评审」→ `set_goal_prefs` / `set_goal` → `server/goal-service.ts`；细化走 `start_goal_wizard`  |
| 运行证据     | `server/loop/routes.ts` 的 run detail/distill 接口；`RunDetailModal.tsx`、`TaskDesk.tsx`、`LoopBar.tsx`           |
| 工具         | `server/tool-manager.ts` 的 `AGENT_TOOL_CATALOG`；定义提示词 `tool-prompts.ts`；覆盖基底 `tool-overrides.ts`      |
| 配置与安全   | `client-state.ts`、`settings-service.ts`、`tool-approval.ts`、`approval-rules.ts`、`permission-preset.ts`         |
| 提示词       | `prompt-composer.ts`、`prompt-assembler.ts`、`persona-chain.ts` 与 agent-service 的内联扩展                       |
| 前端状态     | `use-chat.ts`（快照/reducer/WS）；`app-globals.ts`（低频全局 store / `appSend`）；`loop-cockpit.ts`（驾驶舱弹层） |
| 内置布局     | `server/ui-slots.ts`、`web/src/ui-slots.ts`；宿主默认条目 + 用户偏好                                              |
| 样式与文案   | `web/src/styles.css` 为共享样式基线；`i18n.tsx` 为前端 zh/en 核心文案                                             |

## 3. 文档索引

- [核心架构](docs/architecture-core.md)：快照、协议、安全边界、运行态。
- [附件与预览](docs/architecture-attachments.md)、[终端](docs/architecture-terminal.md)。
- [内置布局与多根工作区](docs/architecture-plugins.md)：沿用历史文件名，内容已不再是插件 API。
- [系统提示词](docs/architecture-system-prompt.md)、[工具上下文预算](docs/tool-context-budget.md)。
- [GoalService 设计](docs/goal-conversation-design.md)：保留设计沿革，当前入口见文首说明。
- [开发与测试](docs/development.md)、[部署](docs/deployment.md)、[发布](docs/release.md)。
- [环境变量](docs/env-vars.md)、[目录索引](docs/directory-reference.md)、[反代模型接入](docs/antigravity-proxy.md)。
- 仓库级当前状态和历史记录见 [HANDOFF.md](../HANDOFF.md)。

## 4. Loop 与会话约束

- 点击启动先创建 run、绑定 `sessionId` 并写 `state.json`，随后才向模型发送执行提示词。
  `setupPending` 的规划/模型解析由 `before_agent_start` 完成；不要恢复“等模型主动调用 loop_start 才有 run”的实现。
- `createLoopRun()` 拒绝同会话重复活跃 run；工具 `loop_start` 遇到该会话已有活跃 run 时返回已有记录。
  异步回调必须校验 run/session 与 epoch，防止停止后迟到的结果推进旧状态。
- validator 通过不等于评审通过。评审错误应为 `stopped/review-error`，`stopReason=reviewer-error`；
  `acceptance` 区分 `passed`、`passed-validator-only`、`self-declared`。
  「重试评审」与用户显式「按代码验证收下」不可混为自动成功。
- 可选 L0 `precheckCmd` 失败时跳过 L1 `validateCmd` 和模型评审；指标/最优轮次见 `loop/metrics.ts`，
  经验卡片见 `loop/distill.ts`。成果视图读取服务端证据，不根据界面文案推断完成。
- GoalService 中主对话审查、服务端另起执行对话；轮数、代次、停滞熔断由服务端管理。
  审查注入 `goal-evidence.ts` 的执行证据，停止/关闭不得无限续轮；暂停保留目标与执行者，继续重做被打断轮。
- `take_over_conversation` 迁移 runtime 必须保持事务性，接入失败原样回滚（上游 #556）。
  `ask_user_question` 使用创建时的会话对象，跨页答复带 owner；断连宽限期内的运行对话仍可过户。
- 服务端快照是唯一事实源；保持消息对象引用稳定与 rev/baseRev 校验，缺口走 `get_state`。
  高频快照流禁止放进 `app-globals.ts`；组件发送用 `appSend`。

## 5. 安全与工具规则

- 保持 loopback 默认、Host/Origin 校验、quiesce 准入和 HTTP token 鉴权；provider headers/密钥不下发浏览器。
  `pi_web_token` cookie 先经 `decodeCookieToken` 解码后校验。
- 浏览器请求服务端的 URL（WS/API/themes）必须经 `appUrl()`，鉴权请求按既有路径带 token。
  不把家目录根设为工作区，避免递归扫描坏挂载。
- 工具 `details` 控制在 64KB 内，使用摘录预算，前端必须支持没有 details 的结果（`present-items.ts`）。
  文本预览用 `decodeText`；`countLines` 不计末尾空行。
- 远期定时器使用 `armDelay` 分片，避免 Node 超过 2^31-1 ms 后溢出为 1ms；
  当前实现见 `server/scheduler-tasks.ts`，cron 解析见 `server/cron-spec.ts`。
- 工具定义提示词使用精简英文：description 说明功能与边界（≤600 字符），promptSnippet 只说明触发条件
  （≤80 字符、不重复工具名），promptGuidelines 说明顺序/禁令/跨工具路由，不在三处复述。
  守卫为 `tests/unit/tool-prompt-hygiene.test.ts`。
- bash 原生/终端/自适应路径共用 `tool-prompts.ts`；只覆盖 execute 的实现不得复制提示词。
  新增可开关工具同步目录、customTools 注册和 `tests/unit/tool-registration.test.ts`；内置覆盖走 `tool-overrides.ts`。
- 延迟加载不能破坏前缀缓存：系统提示词 `{{tools}}` 保持完整目录，不随已加载状态变化；
  要点随 `load_tools` 回执进入对话，注册表按 `toolsAdded` 追加，不就地改删。
- `toolPromptOverrides` 是偏好；新增维度同步补丁逻辑、wire 协议和编辑器。
  工具集预设及 `permission-preset.ts` 的权限门禁不属于已删除的设置预设分享。
- SDK/typebox 的扩展宿主声明保留在 `peerDependencies`；独立服务自带副本放 `optionalDependencies`，
  避免嵌套运行时绕开加载器注入（`tests/unit/extension-host-packages.test.ts`）。
- SDK 模型目录补丁走 `patch-remote-catalog.ts` 的幂等整表替换，升级后重新应用。

## 6. UI 与国际化规则

- CSS 变量先定义后引用。强调色实底用 `--accent-contrast`，语义色实底用 `--on-*`；
  半透明染色底用正文色。保留 css-tokens、accent-contrast、semantic-contrast、theme-text-contrast 守卫。
  内联代码对比度至少 2:1；`TEXT_FLOORS` 的主题文字明暗下限不可随意降低。
- 长路径容器设 `min-width: 0` / `max-width: 100%`；可换行文本用 `overflow-wrap: anywhere`；
  单行用 ellipsis。独立面板可用 `overscroll-behavior: contain`，流内工具输出不可设成滚轮黑洞。
- 卡头右端只放自身复制键，提示文本吸收缩放且不 flex-wrap；消息操作栏紧随最后一个正文块。
- 下拉菜单 Portal 到 body + fixed；浮层用 `useFloatingPanel`，滚动只重算锚点，点击外部/Escape 才关闭。
  SideDock 保持流内 flex，浮动由 `sideDockFloat` 控制。
- 输入框上方带子属于消息区；`--composer-strip` 同时约束 messages-wrap 负 margin、messages 底部留白、
  scroll-bottom/qn-rail 底部偏移。快捷短语行不可改回 absolute（`messages-behind-composer.test.ts`）。
- 图标编辑/拖拽用 Pointer 事件，内置图标在 `host-icon.tsx` 登记；菜单行字号保持既有规范。
  手机横滑避开系统侧滑区，手势中直写 transform，结束清理内联值（`swipe-drawer.test.ts`）。
- 新建/切换会话经 `focusComposer()` 聚焦（触屏除外），非 chat 视图切回；待发附件随会话清空。
- 用户布局改名必须落到真实渲染层：`labelExplicit` 生效时名字型替换文案、数值型保留实时值
  （上游 #555，`bar-item-unified.test.ts`）。布局页与顶/底栏使用同一份 slot 计算。
- Windows 最小化通知通过 `isCollapsedWindow` 判断；通知不携带可能被系统吞掉的 tag。
- 前端文案走 `useT()`；zh/en 同步修改，再 `npm run i18n:sync` 同步语言包。
  `i18n.tsx` 词条值必须是字符串字面量（可 `+` 拼接），保留 dead-keys/locales 守卫。
  服务端 `pick` 的 key 全局唯一，多行用 `getServerBlock`；notice 带 text/textEn。

## 7. 开发与验证

在本目录运行：`npm run dev`（默认后端 8788 / Vite 5173）、`npm run typecheck`、
`npm run check:protocol`、`npm run lint`、`npm test`、`npm run build`、`npm run test:smoke`。
脚本清单以 `package.json` 为准；构建只有 build:web + build:server。

代码交付前检查改动文件格式、typecheck 和相关 vitest；涉及协议跑对应冒烟，涉及 UI 验证浏览器交互。
纯文档修改检查引用、源码一致性与 `git diff --check`，不把历史测试数量当作当前验证结果。
格式化限定改动文件；用户限定 apply_patch 时，格式修正也用 apply_patch。

- 测试端口 ≥8900，先确认空闲；独立临时 data-dir 和必要的 agent-dir，不能污染真实会话/凭据。
- 不占用或杀掉用户的 8787 服务；只清理自己启动并记录的 PID，禁止 `pkill -f`。
- 冒烟用例不得自行并行 build；使用 `tests/lib/ensure-build.mjs`，跑器先串行构建，已有产物用 `--no-build`。
- Playwright 路径走 `tests/lib/chrome.mjs`（`PI_WEB_CHROME` 可覆盖）；仓库路径用 `fileURLToPath`，
  不用 Windows 不兼容的 URL.pathname；win32 清理参考 `tests/lib/port-utils.mjs`。
- 测试 try 内不直接 `process.exit`，确保 finally 清理；mock 按实际接口提供必要字段，不能用裸空对象绕过契约。
- 真模型/集群验证与零 token 冒烟分开报告；没有运行的检查明确记为未运行。

## 8. 环境、部署与发布

`server/harness-env.ts` 列出的非空 `HARNESS_*` 值会映射并覆盖兼容变量；
显式 CLI 参数仍优先。不要假定所有 `PI_WEB_*` 都有 HARNESS 别名。
常用项为 PORT/HOST/CWD/DATA_DIR/TOKEN/SDK/AGENT_DIR，详情见环境变量文档。
源码启动脚本默认 token=auto、SDK=bundled、managed=1；直接启动服务的默认值与脚本有区别。

发布与推送按当前仓库的明确任务执行，勿照搬上游 npm 包的发布目标。
版本变更须同步 package.json/package-lock.json，保留 provenance 和许可证。
发布前检查示例无密钥/真实公网地址；更新磁盘构建产物后需重启服务才更换内存中的后端代码。
