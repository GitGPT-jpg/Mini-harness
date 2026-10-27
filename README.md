# 训推引擎组 Harness（mini-harness）

把开源 pi 驾驶舱（pi-web-ui）定制成**训推引擎组专用的推理底座**：锁定 pi 引擎 + Baidu One API 网关，精简掉推理场景用不到的功能，固化领域身份与安全红线，内置可直接使用的提示词模板、推理子代理、领域 skill 与自动维护的知识库（pi-llm-wiki）。

> 浏览器驾驶舱 + pi 编码智能体（v1.4.0）。仅本机监听 `127.0.0.1:8787`，带 token 鉴权。

## 一键安装

```bash
git clone <本仓库地址> mini-harness
cd mini-harness
./setup.sh
```

`setup.sh` 会自动：
1. 校验 Node.js（>=22.19）与 npm（若 PATH 无 node，会尝试复用 pi 自带的 Node）；
2. 安装固定版本 `pi@1.4.0`（与验证机一致）；
3. 安装 7 个领域 skill 到 `~/.pi/agent/skills`；
4. 种入「Baidu One API」模型服务商与模型目录（**不含密钥**，不覆盖你已有配置）；
5. 安装驾驶舱依赖，`postinstall` 自动执行 `harden.mjs` 完成全部加固与定制
   （含首装 client-state 播种，保证客户端开关与领域身份在干净机器上同样生效）；
6. 在 **桌面** 生成启动器 `训推引擎组 Harness.app`（macOS）。

> 前置条件：macOS / Linux、Node ≥22.19、可访问 npm 与 One API 网关。
> macOS 若终端组件 node-pty 需要编译，建议先安装 Xcode Command Line Tools（`xcode-select --install`）。
> 若移动了仓库目录，重跑一次 `./setup.sh` 以刷新桌面 `.app` 内的绝对路径。

## 启动与首次配置

- **macOS**：双击桌面「训推引擎组 Harness」图标（无终端黑窗，自动拉起服务并打开浏览器）。
- **命令行**：`pi-web-cockpit/start-hardened.sh`，然后浏览器打开 `http://localhost:8787`。

首次打开会弹出「首次配置」门禁：进入 **设置 → 模型服务商**，Base URL 已预填
`https://oneapi-comate.baidu-int.com/v1`，在 API Key 处填入**你自己的 One API Key** 并保存。
Key 仅保存在本机 `~/.pi/agent/auth.json`，**不会提交到代码库，也不外传**。

> **全新状态**：首次安装是干净的——不包含任何会话/聊天记录、最近项目、任务运行状态或知识库内容。
> 这些数据只存在于各自机器的 `~/.pi/agent/` 与 `~/.pi-web/` 下，且已在 `.gitignore` 中排除。

## 做了哪些定制（全部可逆，集中在 `pi-web-cockpit/harden.mjs`）

- **只保留 pi 引擎**：前端引擎清单裁为 pi-only；底栏引擎切换器隐藏；模型服务商留给用户自填 One API。
- **推理场景精简**：关闭沙盒 / Goal Mode / Delegate / Plan / 子代理原生入口、多模态音视频、Page Picker、codemode 扩展；工具懒加载开启（省 token、稳 prompt cache 前缀）；仅保留 `present_files` 成果卡片。
- **安全加固**：关 remoteSsh、封禁 `__abs__` 任意文件读、禁 `eval`/`browser_page`、关插件市场与自更新（`PI_WEB_MANAGED=1`）。
- **品牌**：左上角为 icon1111 图标 + 「训推引擎组 Harness」；浏览器页签标题同名、favicon 为紫色 C；并停用 PWA Service Worker（避免旧缓存导致界面不更新）。
- **领域身份**：覆盖组合模板的 `{{soul}}` token，注入推理服务 agent 身份、工作准则与安全红线（其余脚手架 token 不动）。
- **提示词模板**：隐藏 25 个 pi 内置模板，灌入 7 个从 harness + Ku 沉淀、可直接用的推理模板。
- **子代理**：保留 explore/review/implement，新增 5 个推理 workflow 子代理。
- **知识库**：内置 `pi-llm-wiki` 扩展（已做安全审查、移除高危可选依赖子树），后台自动召回/沉淀、无感维护，纯本地不外联。
- **薄运行时（`mini-harness-runtime`）**：任务状态机 `intake→plan→run→validate`，**以 validate.py 为唯一准入门禁**，失败自动带证据进入下一轮，达到最大轮数停止，状态落盘可断点续跑。可选 **跨家族 planner / reviewer**：planner 产出可验证的验收条件；reviewer 只能否决、不能放行（validator 通过才算完成）。附最小 watcher 任务队列。对应"公共运行时"那一块，**不依赖模型自觉**。
- **One API Key 门禁**：首次打开弹窗引导配置（见上）。

## 仓库结构

- `setup.sh` — 可移植一键安装脚本
- `pi-web-cockpit/harden.mjs` — 幂等、可逆的加固+定制脚本（`npm install` 时经 `postinstall` 自动重放）
- `pi-web-cockpit/config/models.oneapi.json` — One API 服务商与模型目录种子（无密钥）
- `pi-web-cockpit/config/client-state.seed.json` — 首装驾驶舱设置种子（开关/领域身份，无用户路径）
- `pi-web-cockpit/assets/brand-logo.png` — 左上角 logo（icon1111）
- `pi-web-cockpit/assets/brand-favicon.png` — 页签 favicon（紫色 C）
- `pi-web-cockpit/verify-hardened.mjs` — Playwright E2E 验证（对话/文件/终端/Git 四件套 + 门禁）
- `pi-web-cockpit/vendor/pi-llm-wiki/` — 审查过的知识库扩展源码
- `pi-web-cockpit/vendor/mini-harness-runtime/` — 薄运行时扩展（状态机 + validator 门禁 + 自动迭代 + 续跑）
- `skills/` — 7 个领域 skill（安装到 `~/.pi/agent/skills`）
- `assets/icon.jpg` — 桌面启动器图标源
- `资产清单.md` — 推理底座可利用资产清单

## 维护

- 改完定制后在 `pi-web-cockpit/` 跑 `node harden.mjs` 即可重放（幂等）。
- 校验：`cd pi-web-cockpit && node verify-hardened.mjs`（需服务已启动）。
- 升级 pi 版本：改 `setup.sh` 顶部 `PI_PIN` 后重跑。

## 安全说明

- 服务仅绑定 `127.0.0.1`，并需 URL token；不要把端口暴露到公网。
- `~/.pi/agent/auth.json`、`~/.pi-web/` 下的口令均在仓库外，`.gitignore` 已排除一切密钥/口令。
- 编辑 `~/.pi-web/client-state.json` 前需先停服务（运行中会把内存态写回覆盖磁盘）。
