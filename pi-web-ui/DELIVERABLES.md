# 精简发行版交付清单（阶段 A-E）

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

**净删除 325,784 行源码**（`git diff --stat 30902c1..HEAD`），`server/` 3.7M、`web/src/` 3.5M。

## 三、验证证据位置

- **单元测试**：`npx vitest run tests/unit/` → 4394 过 / 1 失败（上游自带，见「遗留问题」）。
- **Loop 正确性**：`tests/unit/loop-extension.test.ts`（13 用例，mock 零 token）。
- **Loop 前端渲染**：`tests/loop-bar-test.mjs`（9/9，Playwright）。
- **E 阶段回归**：五项保留 + 删除项不渲染 + 无 pageerror（Playwright，隔离端口 8941，`PI_WEB_SDK=bundled`）。
- **真实模型 E2E**（C 阶段）：代码 loop done/verdict=pass/code=0/review=pass；LLM loop done；续跑互斥/停止不复活/taskId 绑定均 live 验证。

## 四、性能数据（裁剪效果）

- 源码：净 -325,784 行。
- 官方插件：39 → 1（仅 page-picker）。
- 引擎：4（pi/dsh/claude/durable）→ 1（pi）。
- 依赖：删 electron/electron-builder/electron-updater/ssh2。
- 启动：`/api/health` 返回 `{"ok":true,"engine":"pi","piVersion":"1.4.0"}`。

## 五、遗留问题

1. **上游自带 1 个单测失败**：`goalbar-collapsed-pill.test.ts`「兜底把 .goalbar 面板皮从折叠态抹掉」——在无本分支改动的基线同样失败（上游 CSS 兜底规则缺失，非本裁剪引入）。
2. **D-9 未完成（主工作树收尾，不属本 worktree）**：统一启动/安装入口、逐步退出 `harden.mjs`（旧驾驶舱业务补丁）、废弃旧 `harness-server/`（自有 chat/exec 路线）——这三项在**主工作树** `/Users/zhangteng14/ComateProjects/pi agent 的定制化`（分支 `1`，另一 AI 窗口负责），本 worktree（`mini-harness-cockpit` 分支 `harness-cockpit`）只做 `pi-web-ui/` 源码裁剪。
3. **惰性死码（可后续清理）**：`useIsDsh` 恒 false（DSH UI 分支）、`handleScmMessage`/`scm.ts` 后端（终端 SCM 只读 + AI 提交信息仍用）、dsh patches dispatch 方法——均不影响 pi 引擎运行，属「删除界面≠删除 Agent 执行能力」的保留边界。

## 六、如何运行

```bash
cd pi-web-ui
npm install
npm run build
PI_WEB_SDK=bundled npm start   # 或 node dist/server/index.js
# 浏览器打开 http://127.0.0.1:8787
```
