# 训推引擎组 Harness（mini-harness）

把开源 pi 驾驶舱（pi-web-ui）定制成**训推引擎组专用的推理底座**：锁定 pi 引擎 + Baidu One API 网关，精简掉推理场景用不到的功能，固化领域身份与安全红线，内置可直接使用的提示词模板、推理子代理、领域 skill 与自动维护的知识库（pi-llm-wiki）。

> 浏览器驾驶舱 + pi 编码智能体（v1.4.0）。仅本机监听 `127.0.0.1:8787`，带 token 鉴权。

当前源码版本 **1.0.1**（1.0 系列收尾版），变更与验证范围见 [CHANGELOG.md](CHANGELOG.md)。上游来源版本与本产品版本分别记录。

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
5. 构建驾驶舱：在 `pi-web-ui/` 里按 lockfile 安装依赖并 `npm run build`（全部定制都在源码里，没有补丁脚本）；
6. 停用推理场景用不到的 7 个风险 skill（移到 `~/.pi/agent/skills.disabled`，移回即恢复）；
7. 配好知识库扩展 `pi-llm-wiki`（禁脚本装依赖、删高危可选依赖、登记到 pi、静默配置）；
8. 在 **桌面** 生成启动器 `训推引擎组 Harness.app`（macOS）。

> 前置条件：macOS / Linux、Node ≥22.19、可访问 npm 与 One API 网关。
> macOS 若终端组件 node-pty 需要编译，建议先安装 Xcode Command Line Tools（`xcode-select --install`）。
> 若移动了仓库目录，重跑一次 `./setup.sh` 以刷新桌面 `.app` 内的绝对路径。

## 启动与首次配置

- **macOS**：双击桌面「训推引擎组 Harness」图标（无终端黑窗，自动拉起服务并打开浏览器）。
- **命令行**：`pi-web-cockpit/start-hardened.sh`，然后浏览器打开 `http://localhost:8787`。

首次打开会弹出「首次配置」对话框（已预选 Baidu One API）：Base URL 已预填
`https://oneapi-comate.baidu-int.com/v1`，在 API Key 处填入**你自己的 One API Key** 并保存。
Key 仅保存在本机 `~/.pi/agent/auth.json`，**不会提交到代码库，也不外传**。

> **全新状态**：首次安装是干净的——不包含任何会话/聊天记录、最近项目、任务运行状态或知识库内容。
> 这些数据只存在于各自机器的 `~/.pi/agent/` 与 `~/.pi-web/` 下，且已在 `.gitignore` 中排除。

## 做了哪些定制（全部在 `pi-web-ui/` 源码里，见 `pi-web-ui/DELIVERABLES.md`）

- **只保留 pi 引擎**：前端引擎清单裁为 pi-only；底栏引擎切换器隐藏；模型服务商留给用户自填 One API。
- **推理场景精简**：关闭沙盒 / Delegate / Plan / 子代理原生入口、多模态音视频、Page Picker、codemode 扩展；工具懒加载开启（省 token、稳 prompt cache 前缀）；仅保留 `present_files` 成果卡片。
- **安全加固**：关 remoteSsh、封禁 `__abs__` 任意文件读、禁 `eval`/`browser_page`、关插件市场与自更新（`PI_WEB_MANAGED=1`）。
- **品牌**：左上角为 icon1111 图标 + 「训推引擎组 Harness」；浏览器页签标题同名、图标与左上角 logo 相同；PWA 图标同源。
- **领域身份**：覆盖组合模板的 `{{soul}}` token，注入推理服务 agent 身份、工作准则与安全红线（其余脚手架 token 不动）。
- **提示词模板**：隐藏 25 个 pi 内置模板，灌入 8 个从 harness + Ku 沉淀、可直接用的推理模板。
- **子代理**：保留 explore/review/implement，新增 5 个推理 workflow 子代理。
- **知识库**：内置 `pi-llm-wiki` 扩展（已做安全审查、移除高危可选依赖子树），后台自动召回/沉淀、无感维护，纯本地不外联。
- **Loop 运行时（`pi-web-ui/server/loop/`）**：服务端先创建 run 并绑定会话，再进入规划、执行与验收；可配置快速预检和完整检查命令，失败带证据迭代。启用模型评审时，检查通过但评审出错仍会停止，支持重试评审或用户明确按代码验证收下。运行详情展示日志、diff、结构化指标与最优轮次，并可沉淀经验卡片。
- **统一任务入口**：输入框上沿单枚居中的「新任务」胶囊，按「代码验证 + 模型评审 / 仅代码验证 / 仅模型评审」分流；模型评审任务保留先提问、确认计划再开跑的调研向导。
- **Loop 任务台**：顶栏「任务台」抽屉——当前目标的进度、执行者工具调用时间线、暂停 / 继续 / 停止，以及 LLM loop 永久目录与代码 loop 运行列表。
- **连接集群**：输入框发送键左侧的集群图标，粘贴 kubeconfig 即用 `kubectl cluster-info` 实测（存 `~/.pi-web/kubeconfig`，权限 600）；底栏分别显示「API 已连接」「集群已连接」。
- **One API Key 首次配置**：首次打开弹窗引导配置（见上）。

## 仓库结构

- `setup.sh` — 可移植一键安装脚本
- `pi-web-ui/` — 驾驶舱源码（pi-web-ui v0.111.0 裁剪定制版，定制清单见 `pi-web-ui/DELIVERABLES.md`）
- `pi-web-cockpit/start-hardened.sh` — 启动脚本（跑 `pi-web-ui/dist`，口令 / 代理 / kubeconfig 环境；`PI_WEB_PORT` 可改端口）
- `pi-web-cockpit/verify-cockpit.mjs` — 浏览器 E2E 验证（品牌 / 首次配置 / Loop / 任务台 / 集群 / 对话 / 终端 / Skills）
- `pi-web-cockpit/config/models.oneapi.json` — One API 服务商与模型目录种子（无密钥）
- `pi-web-cockpit/assets/brand-logo.png` — 左上角 logo（icon1111）
- `pi-web-cockpit/assets/brand-favicon.png` — 紫色 C 图标（备用；页签现用左上角 logo）
- `pi-web-cockpit/vendor/pi-llm-wiki/` — 审查过的知识库扩展源码
- `skills/` — 7 个领域 skill（安装到 `~/.pi/agent/skills`）
- `assets/icon.jpg` — 桌面启动器图标源
- `资产清单.md` — 推理底座可利用资产清单
- `install.sh` — 命令行安装入口（等价 `setup.sh`）
- `build/package.sh` + `build/dmg-background.png` — 打包脚本（产出 tarball 与 macOS DMG）
- `VERSION` — 语义版本号
- `tunnel/` — 可选 SSH 隧道兜底脚本（仅当 kubectl 都到不了集群时用）

## 连接内网（K8s）

harness 任务只需本机有 `kubectl` 和一份可用的 **kubeconfig**（`kubectl get nodes` 能通即可）。
在堡垒机上部署时，把 kubeconfig 放好、`kubectl` 在 PATH，就无需任何额外配置；AI 直接就能连 pod。

仅当某台机器连 `kubectl` 都到不了集群时，才需要用 SSH 隧道兜底（`tunnel/tunnel.sh auto` 会自动检测：kubectl 直连成功就跳过，否则才建隧道）。

## 安装包

```bash
bash build/package.sh
```

- macOS：`dist/Mini-Harness-<版本>.dmg` —— 双击挂载，把「训推引擎组 Harness」拖入 Applications；首次打开自动安装，之后双击即启动。
- Linux / 通用：`dist/mini-harness-<版本>.tar.gz` —— 解压后 `./install.sh`。
- 版本号：优先 `git tag`，其次仓库根 `VERSION` 文件，可用 `VERSION=x.y.z` 覆盖。

## 维护

- 改完 `pi-web-ui/` 源码后：`cd pi-web-ui && npm run build`，再重启服务（或重跑 `./setup.sh`）。
- 校验：`cd pi-web-ui && npm run typecheck && npx vitest run`；服务起来后 `node pi-web-cockpit/verify-cockpit.mjs`（对话一步会真实调用一次模型）。
- 升级 pi 版本：改 `setup.sh` 顶部 `PI_PIN` 后重跑。

## 安全说明

- 服务仅绑定 `127.0.0.1`，并需 URL token（首次启动时生成在 `~/.pi-web/pi-web-token`，权限 600）；不要把端口暴露到公网。
- `~/.pi/agent/auth.json`、`~/.pi-web/` 下的口令均在仓库外，`.gitignore` 已排除一切密钥/口令。
- 编辑 `~/.pi-web/client-state.json` 前需先停服务（运行中会把内存态写回覆盖磁盘）。
