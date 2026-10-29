# Matrix (去中心化) 机器人与工作台 (Matrix Plugin)

> Matrix 机器人插件（实验功能），基于 Matrix Client-Server API (v3) 出站 Sync 长轮询，支持双向会话对话（零公网 IP / 免反代）、结构感知 Markdown 智能分块、白名单安全准入与房间消息推送。零外部第三方包依赖（Node 内建 fetch + node:crypto）。

## 功能特性

- 🤖 **去中心化 Matrix 出站 Sync 双工长轮询**：基于 Matrix Client-Server 官方规范，客户端主动发起出站长轮询，**零公网 IP、免域名备案、免反向代理、免开放入站端口**，支持连接自建 Synapse 或公共 Matrix 服务器（如 matrix.org）！
- 📦 **结构感知 Markdown 分块**：针对消息长度限制，采用类似 `dsh-im` 的智能分块算法，保证代码块（\`\`\`）自动闭合与语法高亮不破损。
- ⚡ **斜杠快捷指令**：支持 `/help`、`/clear` 或 `/new`（清空上下文开启全新对话）、`/status`（查看机器人在线指标）。
- 🛡️ **安全白名单控制**：支持设置允许对话的 Matrix User ID 白名单（形如 `@user:matrix.org`），未授权人员友好拦截，防止 Bot 被陌生人滥用。
- 💬 **多房间与群聊支持**：支持在 Matrix 房间中接收消息并回复，自动维护独立用户会话隔离与多轮上下文。
- 🛠️ **AI 工具**：向 AI 助手注册 `matrix` 工具，AI 可自主向 Matrix 房间推送消息与通知。

## 配置指南

1. 拥有一个 Matrix 账号（可在 [matrix.org](https://matrix.org/) 注册，或使用私有部署的 Synapse / Conduit 服务器）；
2. 使用 Element Web 或其他客户端登录后，在「个人设置」→「帮助与关于」中复制你的 **Access Token** 与 **Homeserver URL**；
3. 将该机器人账号邀请到你的目标 Matrix 房间；
4. 在 pi-web-ui 的 Matrix 面板点击「⚙️ 配置凭证」，填入 Homeserver URL 与 Access Token，勾选「启用 Matrix 机器人双向对话服务」；
5. 点击「🔌 测试连接」验证通过后点击「💾 保存配置」即可开始对话。
