# 精简发行版交付清单（阶段 A-E + D-9 至 D-12）

基于上游 [xing-shuyin/pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) @ **v0.111.0**（tag `7c40b44`，MIT）源码裁剪。来源/版本/许可见 `PROVENANCE.md`。

## 一、保留清单（五项，实测可用）

| # | 功能 | 实现 | 验证 |
|---|---|---|---|
| ① | 聊天 | `agent-service.ts` / `dispatch-domain-handlers.ts` | E 阶段 Playwright：输入框存在、无 pageerror |
| ② | 真实交互式终端（PTY/xterm） | `server/terminals.ts`（node-pty，110KB）+ `patch-node-pty.ts` + xterm.js | node-pty 依赖保留；`TerminalManager` 注释明示 "conversation-owned PTY sessions (node-pty)" |
| ③ | Skills | `server/skill-discovery.ts` / `skill-tool.ts` / `install_skill`/`uninstall_skill` dispatch | 保留（C 阶段已验） |
| ④ | 状态栏 | `FooterBar`/`BarItem`（连接状态/工作目录/执行状态）+ `host:loop` Loop 段 | C-3c `loop-bar-test` 9/9 + E 回归 |
| ⑤ | Loop | LLM=`server/goal-service.ts`；代码=`server/loop/extension.ts`（含 6 项正确性修复） | C 阶段 WS 全链路 + 单测 13/13 |

## 二、删除清单（D-1 至 D-8，全部 typecheck+build+vitest 三连验）

| 阶段 | 删除内容 | 提交 |
|---|---|---|
| D-1 | Electron 桌面壳（desktop/launcher/WindowControls/electron-updater） | e9af0bd |
| D-2 | 语音/TTS/提示音（tts/sounds/SoundSettings/朗读按钮 + tts·voice-input 插件） | 3636c4e |
| D-3 | Canvas 画布（server/canvas + web canvas + canvas 工具） | 2340533 |
| D-4 | 插件/MCP/技能市场（market-service/plugin-catalog 三层合并 + 市场 UI/协议） | 4a69be1 |
| D-4b | 38 个无关官方插件（仅留 page-picker 浏览器扩展桥） | c6587ce |
| D-5 | SSH 远程工作区（remote-ssh-service 连接层/SFTP/PTY + SSH UI + ssh2） | a5c751d |
| D-6 | Git 面板（SCMPanel + git 视图 + SCM 工具栏槽位） | 6731244 |
| D-6b | 文件树（RightPanel 常驻文件树 tab + host:files/host:right-files 入口） | 58b37af |
| D-7 | 多引擎（DSH/Claude/Durable + 引擎切换/探测/更新全链路） | 5c62fdc |
| D-8 | Plan/Delegate 入口（GoalBar 计划按钮 + PlanBoard + 审查者委派开关/徽标） | 2be7a90 |
| D-10 | 插件 UI 入口（顶栏「插件」+ 插件面板/管理弹窗 + 设置页「界面插件」页）与右侧空栏（RightPanel 及 D-6b 残留的文件树代码、FileTransferDialog、SlotTabs、对应 CSS），清理 106 个无引用 i18n key；插件运行时与 MCP 保留（D-11 已删） | 7f8a39f |
| D-11 | 设置页「系统提示词 / 预设 / 扩展 / MCP 服务器 / 目标审查」五个分区；插件运行时整套（`server/plugins.ts` 等 20 个服务端模块、前端插件宿主/视图/围栏/图标、`plugins/` 目录含 page-picker、`plugin-sdk/`、CLI 插件子命令、`browser_page` 工具与网页引用附件）；MCP（自带 MCP 桥 + `mcp_manage` 工具，SDK 自带的 `builtin:mcp` 扩展用 `disabledBuiltinExtensions` 关掉）；设置预设（保存/应用/导入/导出/分享）。清理 270 个无引用 i18n key、313 条无引用 CSS 规则。pi-llm-wiki 扩展、定时任务、审批、内置布局保留 | 70f90bd、2aec462 |
| D-12 | 删除已不引用的 `pi-web-cockpit/vendor/mini-harness-runtime/` 与 `pi-web-cockpit/config/client-state.seed.json` 以及旧 `CodeLoopModal.tsx`（由统一 `TaskModal.tsx` 取代） | b4ca3dd + D-12b |

**净删除 325,784 行源码**（D-1 至 D-8，`git diff --stat 30902c1..HEAD`），当时 `server/` 3.7M、`web/src/` 3.5M。D-11 又删 74,661 行（含测试与语言包；`git diff --histogram` 统计），`server/` 降到 3.0M、`web/src/` 降到 2.8M。

## 三、验证证据位置

- **单元测试**：`npx vitest run` → 313 个文件全过（3367 过 / 0 失败 / 9 跳过，2026-10-30，D-12 后；新增 `loop-status.test.ts` 56 条，扩充 `loop-extension` / `loop-routes` / `loop-cockpit-ui` 等）。
- **零 token 冒烟套件**：`node tests/run-smoke.mjs --no-build` → D-11 后清单 59 条（删了 15 条只测插件/MCP 的用例），58/59 通过（核心 16/16 全过）；唯一偶发是 `terminal-smoke-test`，本机 zsh 交互 shell 偶尔在用例的 3 秒窗口内没退出，单独重跑可过。
- **Loop 正确性**：`tests/unit/loop-extension.test.ts`（25 用例，mock 零 token）、`tests/unit/loop-routes.test.ts`（8 用例）、`tests/unit/loop-status.test.ts`（56 用例）、`tests/unit/loop-cockpit-ui.test.ts`（26 用例）。
- **Loop 前端渲染**：`tests/loop-bar-test.mjs`（26/26，Playwright：单枚「新任务」胶囊、`TaskModal` 三选一验收方式分流、弹窗打开时隐藏胶囊、预设填充与门控）与 `tests/run-detail-ui-test.mjs`（31/31，Playwright：人话状态、`RunDetailModal` 证据/日志/diff/时间线展示、裁判掉线恢复 `loop_resume` / `loop_accept`）。
- **E 阶段回归**：五项保留 + 删除项不渲染 + 无 pageerror（Playwright，隔离端口 8941，`PI_WEB_SDK=bundled`）。
- **真实模型 E2E**（C 阶段）：代码 loop done/verdict=pass/code=0/review=pass；LLM loop done；续跑互斥/停止不复活/taskId 绑定均 live 验证。

## 四、性能数据（裁剪效果）

- 源码：净 -325,784 行。
- 官方插件：39 → 1（仅 page-picker）。
- 引擎：4（pi/dsh/claude/durable）→ 1（pi）。
- 依赖：删 electron/electron-builder/electron-updater/ssh2。
- 启动：`/api/health` 返回 `{"ok":true,"engine":"pi","piVersion":"1.4.0"}`。

## 五、遗留问题

1. ~~上游自带 1 个单测失败~~（D-9f 已修）：`goalbar-collapsed-pill.test.ts` 的断言停留在 @layer 改造之前（要求 `!important`），与 `css-layers` 契约（整份 styles.css 的 `!important` ≤ 1）冲突；已改为断言规则位于无层区。
2. ~~D-9 未完成~~（已在本 worktree 完成，见第七节）：统一启动/安装入口、退役 `harden.mjs`、删除旧 `harness-server/`。
3. **惰性死码（可后续清理）**：`useIsDsh` 恒 false（DSH UI 分支）、`handleScmMessage`/`scm.ts` 后端（终端 SCM 只读 + AI 提交信息仍用）、dsh patches dispatch 方法——均不影响 pi 引擎运行，属「删除界面≠删除 Agent 执行能力」的保留边界。

## 六、如何运行

```bash
./setup.sh                              # 仓库根目录：装 pi@1.4.0、skills、One API 服务商，构建 pi-web-ui
pi-web-cockpit/start-hardened.sh        # 跑 pi-web-ui/dist（127.0.0.1:8787，PI_WEB_TOKEN=auto）
open "http://localhost:8787/?token=$(cat ~/.pi-web/pi-web-token)"
node pi-web-cockpit/verify-cockpit.mjs  # 浏览器 E2E（可选 KEY_FILE / SHOTS / PORT）
```

只调前端/服务端时：`cd pi-web-ui && npm run build && PI_WEB_SDK=bundled node dist/server/index.js`。

## 七、D-9：退役 harden.mjs，驾驶舱定制全部入源码

原来驾驶舱 = npm 装的 pi-web-ui 包 + `harden.mjs` 往 `dist/` 里打补丁、往 `index.html` 注入 DOM 脚本。D-9 把补丁里的每一项都改成了源码实现，补丁脚本、旧验证脚本与旧 `harness-server/` 一并删除。

| 阶段 | 内容 | 提交 |
|---|---|---|
| D-9a | 安全项：绝对路径读取白名单（403）、`defaultOn=false` 工具不再被打开、codemode 按需注册、技能硬禁名单 | 5483c64 |
| D-9b | 能力与默认值（关非推理能力、vision/toolImages 默认关、工具延迟加载默认开）；品牌（标题/manifest/顶栏/PWA 图标）；领域灵魂 `BUILTIN_SOUL`；首次配置预选 oneapi | 95eba81、81bc05e、1268962 |
| D-9c | 去掉 CSS 隐藏的残余入口（沙盒/临时对话按能力门控、删极简模式与 GitHub 外链、去音视频播放器）；8 个推理启动模板、子代理模板收敛 | bba6b31 |
| D-9d | Loop 自主化：调研向导只留 `goal_ask` 并先提问、计划确认门禁（取消回 `CANCELLED` 不开跑）、目标暂停/继续、执行者 sessionId、LLM loop 永久目录 `goal-history.jsonl`、`/api/mini-harness/*`；前端双胶囊、代码 loop 弹窗（`criteria`/`artifactRoots`）、任务台、连接集群、状态栏拆分、目标条改名 | 6875645、a5f9a05 |
| D-9e | `PI_WEB_TOKEN=auto`（口令落 `<DATA_DIR>/pi-web-token`，0600）；`start-hardened.sh` 入库直接跑 `pi-web-ui/dist`；`setup.sh` 构建源码 + 停用 7 个风险 skill + pi-llm-wiki 配置；删除 `harden.mjs`、`verify-hardened.mjs`、`harness-server/` | fc74f04、7412e68 |
| D-9f | 测试全绿：删 FRP 子命令（`bin/frp-manager.mjs` 仍 import D-5 已移除的 ssh2，CLI 加载即崩）、折叠目标条用例对齐 @layer 契约；干净 HOME 实测发现并修复两处首装问题（首次配置弹窗不弹；填 key 后同一页第一句话没人接）；`pi-web-cockpit/verify-cockpit.mjs` | 04a695d、eee6e64、b787b1f、c67b634 |

**验证（2026-10-30）**

- `npm run typecheck` 0 错误；`npm run build` 通过；`npm run lint` 0 错误（98 条 warning 为既有）；`npx vitest run` 373/373 文件通过。
- 干净 HOME 实测：`git clone` 本分支到临时目录，临时 HOME + 临时 npm 全局前缀跑 `./setup.sh` → 退出码 0；再跑一次仍为 0（幂等：pi 跳过、oneapi 不覆盖、依赖 up to date）。随后 `start-hardened.sh`（`PI_WEB_PORT=8934`）起服务：口令文件 0600，无口令 401、带口令 200，图标/manifest 200。
- 浏览器 E2E（首装状态，headless Chrome）14/14：品牌与图标、首次配置弹窗预选 oneapi 并保存 key、状态栏「API 已连接 / 集群未连接」、两枚胶囊按输入框中轴居中、代码 loop 弹窗（模型下拉、胶囊收起）、连接集群（空 kubeconfig 被拦）、任务台、LLM loop 编辑器、真实模型对话往返（同一标签页，3.7s）、PTY 回显、领域 skill 可发现、无 pageerror。`verify-cockpit.mjs` 对隔离实例 15/15。

**仍需注意**

- 默认分支没有改动（是否把 `harness-cockpit` 设为默认分支需要人来定）。
- `pi-web-cockpit/vendor/mini-harness-runtime/` 与 `config/client-state.seed.json` 已在 D-12 删除（运行时已并入 `server/loop/`，默认值已入源码）；服务端仍会忽略 `~/.pi/agent` 里登记的旧运行时包。
- 设 key 后自动补选模型只作用于保存 key 的那个页面；同时开着的其他标签页仍要手动选一次模型。

## 八、D-12：Loop 完成态可信度、服务端结构化启动、成果查看器与统一任务入口

对照四阶段架构基调补齐 Loop 闭环体验与可信度：

| 阶段 | 内容 | 提交 |
|---|---|---|
| D-12-1 | 完成态可信度：代码 Loop 在 validator 通过但 reviewer 出错时停在 `stopped` / `review-error`（`stopReason=reviewer-error`），不再误报完成；`state.json` 引入 `acceptance`（`passed` / `passed-validator-only` / `self-declared`），支持评审掉线后「重试评审」（`loop_resume`）或「按代码验证收下」（`loop_accept`） | b4ca3dd |
| D-12-2 | 服务端结构化启动：`createLoopRun` 在点击开始时直接生成 `runId`、落盘 `state.json`（绑定 `sessionId`、`setupPending=true`）并立即推送前端快照，不再依赖模型首轮自觉调 `loop_start`（同会话已有活跃 run 时 `loop_start` 幂等返回） | b4ca3dd |
| D-12-3 | 成果与证据查看器 + 人话状态：新增 `GET /api/mini-harness/runs/:runId/detail`（各轮评审报告、validator 日志、diff、journal）；前端 `loop-status.ts` 统一人话文案与色调，`RunDetailModal.tsx` 展示两行验收结论、各轮折叠报告、终端输出、着色 diff 与恢复操作 | b4ca3dd + D-12b |
| D-12-4 | 统一任务入口：输入框上沿合并为单枚「新任务」胶囊（`host:task-new`），`TaskModal.tsx`（取代 `CodeLoopModal.tsx`）通过三选一验收方式（代码验证 + 模型评审 / 仅代码验证 / 仅模型评审）自动分流代码 Loop 与 LLM Loop | D-12b |
| D-12-5 | 清理与收尾验证：删除 `vendor/mini-harness-runtime` 与 `client-state.seed.json`；全量 vitest 313/313、核心冒烟 16/16、`loop-bar-test.mjs` 与 `run-detail-ui-test.mjs` 浏览器 E2E 全绿 | b4ca3dd + D-12b |
