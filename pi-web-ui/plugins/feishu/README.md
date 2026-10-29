# 🐦 feishu —— pi-web-ui 飞书工作台插件

在 pi-web-ui 界面里提供一个完整的飞书 / Lark 工作台（顶栏 🐦 飞书 标签页）：
支持飞书企业自建应用双向会话收发与自定义群机器人 Webhook 卡片推送，新消息轮询提醒，并将飞书交互能力开放给 AI 直接调度。**零外部依赖**（纯内置 fetch 与 crypto），即装即用。

## 功能

- **会话与通道**：
  - 浏览机器人加入的群聊与单聊会话
  - 支持手动添加自定义快捷接收人（`chat_id` `oc_...`、`open_id` `ou_...`、用户邮箱）
  - 内置虚拟 Webhook 推送通道（`__webhook__`），即使没有企业自建应用，仅凭群机器人 Webhook 也可完整使用
- **消息浏览与阅读**：
  - 支持查看与解析多种飞书消息类型：纯文本（`text`）、富文本（`post`）、交互卡片（`interactive`）、图片、文件、视频、名片等
  - 关键词搜索当前会话或近期聊天记录
  - **一键引用到对话**：一键将飞书消息格式化引用注入主聊天输入框
  - **智能翻译**：支持中英互译、可选特定 AI 模型翻译，自动保护 URL 与代码块，内置 Google GTX 快速回退
  - **原始数据查看**：可展开查看飞书 Open API 下发的原始 JSON 结构
- **消息发送与富交互**：
  - 发送纯文本、富文本（带标题）或飞书交互卡片（支持 Markdown 与 10 种卡片标题配色主题：蓝色、绿色、橙色、红色、紫色等）
  - 支持直接回复或**话题内回复**（reply in thread）
  - 支持一键**撤回**（recall）机器人发送的消息
  - 支持**表情回应**（reactions）：👍 点赞、👌 好的、❤️ 爱心、👏 鼓掌、✅ 完成、🔥 火焰
- **自定义机器人 Webhook**：
  - 支持飞书群自定义机器人 Webhook 地址推送
  - 支持基于 HMAC-SHA256 的签名校验密钥（Secret），自动计算 `timestamp` 与 `sign`
  - 本地自动留存 Webhook 推送历史，方便追溯和排查
- **状态栏与新消息提醒**：
  - 后台周期性轮询监控会话新消息（默认 60s，可自定义）
  - 发现新消息时通过 `host.notify` 弹出桌面/网页通知并触发广播
  - 状态栏实时显示徽标（`🐦 3 未读` / `🐦 ✓` / `🐦 Webhook` / `🐦 未配置`）
- **AI 飞书管理工具 (`feishu`)**：
  - 激活后向宿主注册 action 式 `feishu` 工具：
    - `chats`：列出群聊与会话列表
    - `list`：获取会话近期消息列表
    - `read`：阅读单条消息详情与正文
    - `search`：搜索消息内容
    - `send`：向群或个人发送文本/富文本/卡片消息
    - `reply`：回复指定消息（支持话题内回复）
    - `recall`：撤回机器人发送的消息
    - `react`：为消息添加表情回应
    - `webhook`：直接通过群机器人 Webhook 推送卡片或文本
  - 遵循严格的提示词与安全规范，发送前提示模型先向用户确认目标与内容

## 配置

在工作台点击右上角「⚙ 配置」即可打开设置面板：

| 字段                | 说明                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| 接入模式 / 平台预设 | 飞书国内版 (`open.feishu.cn`) / Lark 国际版 (`open.larksuite.com`) / 仅自定义机器人 Webhook / 自定义私有化网关 |
| App ID (`cli_xxx`)  | 飞书开放平台 → 企业自建应用 → 凭证与基础信息                                                                   |
| App Secret          | 企业自建应用密钥（加密落盘保存，前端回传自动脱敏）                                                             |
| 默认会话 ID         | 可选，如 `oc_xxx`，留空时默认取首个群聊                                                                        |
| 轮询间隔 pollSec    | 新消息检查周期（秒），默认 60s（最低 15s）                                                                     |
| Webhook 地址        | 飞书群机器人 Webhook 地址（如不需要自建应用，仅填此处即可使用卡片推送）                                        |
| Webhook 签名密钥    | 可选，自定义机器人的安全签名密钥（HMAC-SHA256 加密保存）                                                       |

密钥优先存储于宿主的安全机密库（`host.secrets`，AES-256-GCM 加密落盘）。

## 安装 / 卸载 / 更新

```bash
# ── 安装 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/feishu
pi-web-ui install plugins/feishu        # 本地目录开发态

# ── 查看 ──
pi-web-ui plugins                        # 列出已装插件与 id

# ── 更新 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/feishu --force
cp -r plugins/feishu ~/.pi-web/plugins/  # 本地开发直接覆盖

# ── 卸载 ──
pi-web-ui uninstall feishu
```

## 回归测试

- `tests/unit/feishu-features.test.ts`：纯函数单元测试（消息解析、卡片生成、Webhook HMAC 签名、URL 保护与格式转换）
- `tests/unit/feishu-secrets.test.ts`：敏感凭证加密持久化与脱敏测试
