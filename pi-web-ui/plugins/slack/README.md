# Slack 机器人与工作台 (Slack Plugin)

> Slack 机器人插件，基于 Slack 官方 Socket Mode 出站 WebSocket 长连接，支持双向会话对话（零公网 IP / 免反代）、结构感知 Markdown (mrkdwn) 智能分块、白名单安全准入与频道/线程消息推送。零外部第三方包依赖（Node 内建 fetch + node:crypto + 全局 WebSocket）。

## 功能特性

- 🤖 **Socket Mode 出站 WebSocket 双工对话**：基于 Slack 官方 Socket Mode，客户端主动发起长连接，**零公网 IP、免域名、免反向代理、免开放入站端口**，在局域网或个人电脑即可即开即用！
- 📦 **结构感知 Markdown 分块**：针对 Slack 消息长度限制，采用类似 `dsh-im` 的智能分块算法，保证代码块（\`\`\`）自动闭合与语法高亮不破损。
- ⚡ **斜杠快捷指令**：支持 `/help`、`/clear` 或 `/new`（清空上下文开启全新对话）、`/status`（查看机器人在线指标）。
- 🛡️ **安全白名单控制**：支持设置允许对话的 Slack User ID 白名单，未授权人员友好拦截，防止 Bot 被陌生人滥用。
- 💬 **线程会话回复**：支持在频道线程（Thread）中跟进回复，保持频道界面整洁。
- 🛠️ **AI 工具**：向 AI 助手注册 `slack` 工具，AI 可自主向 Slack 频道推送消息与通知。

## 配置指南

1. 打开 [Slack API 开发者后台](https://api.slack.com/apps) 并创建应用（Create New App → From scratch）；
2. 进入「Socket Mode」页面，开启 **Enable Socket Mode**，生成包含 `connections:write` 权限的 **App-Level Token**（以 `xapp-` 开头）；
3. 进入「OAuth & Permissions」页面，在 **Bot Token Scopes** 中添加权限：
   - `chat:write`
   - `app_mentions:read`
   - `channels:history`
   - `im:history`
4. 点击「Install to Workspace」完成安装，复制生成的 **Bot User OAuth Token**（以 `xoxb-` 开头）；
5. 进入「Event Subscriptions」开启事件订阅，在 **Subscribe to bot events** 中添加 `app_mention` 与 `message.im`；
6. 在 pi-web-ui 的 Slack 面板点击「⚙️ 配置凭证」，填入 Bot Token 与 App-Level Token，勾选「启用 Slack Socket Mode 机器人双向对话服务」即可！
