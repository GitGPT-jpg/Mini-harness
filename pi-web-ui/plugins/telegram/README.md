# Telegram 机器人与工作台 (Telegram Plugin)

> Telegram Bot 出站长轮询双工对话插件，支持双向会话对话（零公网 IP / 免反代）、结构感知 Markdown 智能分块、白名单安全准入与消息推送。零外部依赖（Node 内建 fetch + node:crypto）。

## 功能特性

- 🤖 **出站长轮询双工对话**：基于官方原生的 `getUpdates` 长轮询协议，全程客户端主动发起出站长连接，**零公网 IP、免域名、免反向代理、免开放入站端口**，在局域网或个人电脑即可即开即用！
- 📦 **结构感知 Markdown 分块**：针对 Telegram 单条消息上限（4096 字符），采用类似 `dsh-im` 的智能分块算法，保证代码块（\`\`\`）自动闭合与语法高亮完好。
- ⚡ **斜杠快捷指令**：支持 `/help`、`/clear` 或 `/new`（清空上下文开新会话）、`/status`（查看机器人在线指标）。
- 🛡️ **安全白名单控制**：支持设置允许对话的 Telegram User ID 白名单，未授权人员友好提示，防止 Bot 被陌生人滥用。
- 💬 **即时状态感知**：收到消息自动触发 `typing` 正在输入指示，消除等待焦虑。
- 🛠️ **AI 工具**：向 AI 助手注册 `telegram` 工具，AI 可自主向 Telegram 用户或频道推送消息。

## 配置指南

1. 打开 Telegram，在搜索栏查找官方账号 [@BotFather](https://t.me/BotFather)；
2. 发送 `/newbot` 指令，按照提示为机器人设置名称（Name）和用户名（Username，需以 `bot` 结尾）；
3. 复制 BotFather 返回的 `Bot Token`（形如 `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ`）；
4. 在 pi-web-ui 的 Telegram 面板点击「⚙️ 配置凭证」，填入 Bot Token 并勾选「启用 Telegram 机器人双向对话服务」；
5. 点击「🔌 测试连接」验证通过后点击「💾 保存配置」即可开始对话。
