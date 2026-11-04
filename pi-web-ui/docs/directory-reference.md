# 目录索引

> 本索引按当前源码列出入口与事实源，不再维护上游全量文件清单。
> 上游来源见 [PROVENANCE.md](../PROVENANCE.md)，开发约束见 [AGENTS.md](../AGENTS.md)。
> 新增或移除架构入口时同步更新；保留的兼容文件不等于产品仍提供对应入口。

## 顶层

| 路径（相对本源码目录）                             | 用途                                              |
| -------------------------------------------------- | ------------------------------------------------- |
| `server/`                                          | Node ESM 后端，构建到 `dist/server/`              |
| `web/`                                             | React/Vite 前端，构建到 `web/dist/`               |
| `bin/harness.mjs`                                  | harness / mini-harness CLI，桥接 HARNESS 环境变量 |
| `bin/pi-web-ui.mjs`                                | 兼容 CLI 和平台服务管理                           |
| `extensions/`                                      | pi 的 `/webui` 扩展入口                           |
| `themes/`、`make-light-theme.mjs`                  | 主题样式与浅色主题生成                            |
| `deploy/`、`Dockerfile`、`docker-compose.yml`      | 部署配置；实际启动方式见部署文档                  |
| `scripts/`                                         | 协议、语言包、发布说明等维护脚本                  |
| `tests/run-smoke.mjs`、`tests/unit/`、`tests/lib/` | 冒烟清单、vitest 与隔离测试辅助                   |
| `.github/workflows/ci.yml`                         | 保留的源码 CI 定义                                |
| `docs/`                                            | 本文末尾的主题文档                                |

仓库级安装/启动/打包入口是 `../setup.sh`、`../pi-web-cockpit/start-hardened.sh`、
`../build/package.sh`；领域技能在 `../skills/`，wiki 扩展源在 `../pi-web-cockpit/vendor/pi-llm-wiki/`。
原 Electron 桌面目录、界面插件和 plugin-sdk、DSH 服务子目录已删除。

## 后端入口

| 模块                                                                                                           | 用途                                         |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `server/index.ts`                                                                                              | HTTP/WS 路由、鉴权、心跳、静态资源、优雅退出 |
| `server/harness-env.ts`                                                                                        | HARNESS 到兼容变量的显式映射表               |
| `server/protocol.ts`、`server/protocol-version.ts`                                                             | wire 协议单源与版本                          |
| `server/agent-service.ts`、`server/agent-service-daemon.ts`                                                    | 客户端/对话运行态、SDK 工具与扩展、过户      |
| `server/serialize.ts`、`server/message-window.ts`                                                              | 消息序列化与历史窗口                         |
| `server/client-state.ts`、`server/settings-service.ts`                                                         | 配置持久化、读取与应用                       |
| `server/engine-capabilities.ts`                                                                                | pi 能力默认值与界面门控                      |
| `server/model-admin.ts`、`server/pi-setup-state.ts`                                                            | 模型配置、首次配置判定                       |
| `server/resolve-global-sdk.ts`、`server/sdk-origin.ts`                                                         | SDK 副本选择与来源诊断                       |
| `server/prompt-composer.ts`、`server/prompt-assembler.ts`、`server/persona-chain.ts`                           | 系统提示词组装及扩展链保留                   |
| `server/tool-manager.ts`、`server/tool-prompts.ts`、`server/tool-overrides.ts`                                 | 工具目录、提示词单源、内置覆盖               |
| `server/load-tools-tool.ts`、`server/tool-prompt-overrides.ts`                                                 | 工具按需加载与逐工具文案                     |
| `server/tool-approval.ts`、`server/approval-rules.ts`、`server/permission-preset.ts`                           | 审批与权限预设                               |
| `server/plan-mode.ts`、`server/delegate-mode.ts`                                                               | 保留的计划/委派门禁，产品入口已裁剪          |
| `server/subagents.ts`、`server/subagent-templates.ts`、`server/subagent-templates-hant.ts`                     | 子代理运行态与模板                           |
| `server/terminals.ts`、`server/bash-tool.ts`、`server/patch-node-pty.ts`                                       | PTY、bash 路径与平台兼容                     |
| `server/attachments.ts`、`server/uploads.ts`、`server/vision-bridge.ts`                                        | 附件、上传与视觉桥                           |
| `server/files-service.ts`、`server/text-sniff.ts`、`server/file-archives.ts`、`server/file-transfer-routes.ts` | 文件读取/嗅探与保留的归档 HTTP 服务          |
| `server/present-files-tool.ts`、`server/conversation-read-tool.ts`                                             | 成果文件与对话按需读取                       |
| `server/scheduler-tasks.ts`、`server/cron-spec.ts`、`server/conversation-view.ts`                              | 内置定时任务及会话读取                       |
| `server/ui-slots.ts`                                                                                           | 内置 UI slot 类型与归一化                    |

## 两条任务执行路径

| 模块                                                    | 用途                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `server/loop/extension.ts`                              | `createLoopRun`、状态机、validator/reviewer、停止/续跑、epoch 守卫 |
| `server/loop/routes.ts`                                 | 运行列表、detail、distill、目标历史、集群 HTTP 接口                |
| `server/loop/metrics.ts`                                | L0/L1 指标解析、最优轮次、前置环境探测                             |
| `server/loop/distill.ts`                                | 经验卡片生成与写盘                                                 |
| `server/goal-service.ts`                                | GoalService：模型评审任务、调研向导、执行者编排、暂停/继续         |
| `server/goal-evidence.ts`、`server/goal-history-log.ts` | GoalService 审查证据和历史目录                                     |

## 前端入口

| 模块                                                                       | 用途                                          |
| -------------------------------------------------------------------------- | --------------------------------------------- |
| `web/src/App.tsx`、`web/src/main.tsx`                                      | 应用布局、弹层装配与初始化                    |
| `web/src/use-chat.ts`、`web/src/types.ts`                                  | WS/reducer 与协议类型 shim                    |
| `web/src/app-globals.ts`                                                   | 低频共享状态和 `appSend`                      |
| `web/src/loop-cockpit.ts`                                                  | 任务/详情/任务台/集群弹层状态、鉴权 HTTP 请求 |
| `web/src/ui-slots.ts`、`web/src/slot-toolbar.tsx`、`web/src/topbar-fit.ts` | 宿主条目 + 用户布局、顶栏溢出                 |
| `web/src/base-url.ts`、`web/src/auth-token.ts`                             | 子路径 URL 与 token                           |
| `web/src/composer-bridge.ts`、`web/src/composer-draft.ts`                  | 草稿/引用与会话切换                           |
| `web/src/use-floating-panel.ts`、`web/src/context-menu-state.ts`           | 浮层与菜单                                    |
| `web/src/styles.css`、`web/src/model-management.css`                       | 共享样式与模型管理样式                        |
| `web/src/i18n.tsx`、`locales/`                                             | zh/en 核心与下载语言包                        |
| `web/src/theme.ts`、`web/src/host-icon.tsx`                                | 主题和内置图标                                |

## 主要组件（web/src/components）

| 组件                                                                  | 用途                                                       |
| --------------------------------------------------------------------- | ---------------------------------------------------------- |
| `TaskModal.tsx`                                                       | 单一「新任务」入口，三种验收方式，L0/L1 高级参数           |
| `RunDetailModal.tsx`                                                  | 每轮评审、validator 日志、diff、指标、重试/接受/经验卡片   |
| `TaskDesk.tsx`、`LoopBar.tsx`、`GoalBar.tsx`                          | 任务目录、代码 Loop 状态、GoalService 进度                 |
| `ClusterControls.tsx`                                                 | kubeconfig 连接弹窗与集群状态                              |
| `TopBar.tsx`、`FooterBar.tsx`、`BarItem.tsx`                          | 顶栏/底栏及其内置动作                                      |
| `LeftPanel.tsx`、`ChatInput.tsx`                                      | 对话导航与输入/附件                                        |
| `Message.tsx`、`MessageList.tsx`、`ToolCallBlock.tsx`                 | 消息、分页与工具结果                                       |
| `FilePreview.tsx`、`PresentedFiles.tsx`                               | 文件预览与成果卡片                                         |
| `TerminalPanel.tsx`、`TermXterm.tsx`                                  | 可见终端                                                   |
| `SettingsModal.tsx`、`ToolPromptEditor.tsx`、`ToolApprovalDialog.tsx` | 设置、工具文案与审批                                       |
| `PiSetupModal.tsx`、`ModelConfigModal.tsx`                            | 首次配置与模型管理                                         |
| `Dialog.tsx`、`DshQuestionDialog.tsx`                                 | pi 扩展对话框与模型问卷；后者沿用旧名字，不代表有 DSH 引擎 |
| `SchedulerPanel.tsx`、`BgTasksModal.tsx`                              | 定时任务与后台进程                                         |

`CodeLoopModal`、右侧文件树/Git 面板和插件组件已移除，不再作为当前开发入口。

## 文档

[核心架构](architecture-core.md) · [附件](architecture-attachments.md) · [终端](architecture-terminal.md) ·
[内置布局/多根](architecture-plugins.md) · [系统提示词](architecture-system-prompt.md) ·
[GoalService](goal-conversation-design.md) · [工具预算](tool-context-budget.md) ·
[开发](development.md) · [部署](deployment.md) · [发布](release.md) ·
[环境变量](env-vars.md) · [模型反代](antigravity-proxy.md)
