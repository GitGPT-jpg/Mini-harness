# WhatsApp 机器人与工作台 (WhatsApp Plugin)

> WhatsApp 机器人插件，基于 Meta 官方 WhatsApp Business Cloud API（Graph API v20.0），支持双向会话对话、结构感知 Markdown 智能分块、白名单安全准入与消息推送。零外部第三方包依赖（Node 内建 fetch + node:crypto）。

## 功能特性

- 🤖 **WhatsApp 官方 Cloud API 双工对话**：基于 Meta 官方 Cloud API，全球通用，稳定合规零封号风险。支持多用户独立上下文隔离与多轮对话。
- 📦 **结构感知 Markdown 分块**：针对 WhatsApp 单条消息上限（4096 字符），采用类似 `dsh-im` 的智能分块算法，保证代码块（\`\`\`）自动闭合与语法高亮不破损。
- ⚡ **斜杠快捷指令**：支持 `/help`、`/clear` 或 `/new`（清空上下文开启全新对话）、`/status`（查看机器人在线指标）。
- 🛡️ **安全白名单控制**：支持设置允许对话的手机号码白名单，未授权号码友好拦截，防止 Bot 被陌生人滥用。
- 💬 **即时状态感知**：收到消息自动派发独立 session，完成时流式回包。
- 🛠️ **AI 工具**：向 AI 助手注册 `whatsapp` 工具，AI 可自主向 WhatsApp 联系人推送消息与通知。

## 配置指南

1. 打开 [Meta for Developers](https://developers.facebook.com/) 并登录 Facebook 开发者账号；
2. 进入「My Apps」创建应用，选择应用类型为「Business」；
3. 在应用产品列表中添加「WhatsApp」并进入「API Setup」；
4. 复制 Meta 提供的测试用或已认证的 **Phone number ID**；
5. 在「System Users」中生成具有 `whatsapp_business_messaging` 权限的永久 **System Access Token**；
6. 在 pi-web-ui 的 WhatsApp 面板点击「⚙️ 配置凭证」，填入 Phone Number ID 与 System Access Token，勾选「启用 WhatsApp 机器人双向对话回复服务」；
7. 点击「🔌 测试连接」验证通过后点击「💾 保存配置」即可开始对话。
