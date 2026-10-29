# Discord 机器人与工作台 (Discord Plugin)

> Discord Bot 官方 Gateway WebSocket 出站长连接双工对话插件，支持双向会话对话（零公网 IP / 免反代）、结构感知 Markdown 智能分块、白名单安全准入与消息推送。零外部依赖（Node 内建 fetch + node:crypto + 全局 WebSocket）。

## 功能特性

- 🤖 **Gateway WebSocket 出站长连接双工对话**：基于 Discord 官方 Gateway (v10) 协议，客户端主动发起出站长连接，**零公网 IP、免域名、免反向代理、免开放入站端口**，在局域网或个人电脑即可即开即用！
- 📦 **结构感知 Markdown 分块**：针对 Discord 单条消息上限（2000 字符），采用类似 `dsh-im` 的智能分块算法，保证代码块（\`\`\`）自动闭合与语法高亮不破损。
- ⚡ **斜杠快捷指令**：支持 `/help`、`/clear` 或 `/new`（清空上下文开启全新对话）、`/status`（查看机器人在线指标）。
- 🛡️ **安全白名单控制**：支持设置允许对话的 Discord User ID 白名单，未授权人员友好拦截，防止 Bot 被陌生人滥用。
- 💬 **即时状态感知**：收到消息自动触发 `typing` 正在输入指示，消除等待焦虑。
- 🛠️ **AI 工具**：向 AI 助手注册 `discord` 工具，AI 可自主向 Discord 频道推送消息与通知。

## 配置指南

1. 打开 [Discord Developer Portal](https://discord.com/developers/applications)；
2. 点击「New Application」创建应用，输入应用名称；
3. 进入「Bot」标签页，点击「Add Bot」生成机器人；
4. **重要**：在 Bot 页面向下滚动，开启 **Privileged Gateway Intents** 中的「MESSAGE CONTENT INTENT」与「SERVER MEMBERS INTENT」；
5. 点击「Reset Token」复制生成的 `Bot Token`；
6. 在「OAuth2」→「URL Generator」中勾选 `bot` 范围，并授予 `Send Messages`、`Read Messages/View Channels` 权限，复制生成的链接将机器人邀请到你的服务器中；
7. 在 pi-web-ui 的 Discord 面板点击「⚙️ 配置凭证」，填入 Bot Token 并勾选「启用 Discord 机器人双向对话服务」即可！
