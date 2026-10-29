# pi-web-ui

[English](https://github.com/xing-shuyin/pi-web-ui/blob/main/README.md) | **简体中文** · [繁體中文](https://github.com/xing-shuyin/pi-web-ui/blob/main/README.zh-TW.md) · 🌐 [**官方网站**](https://xing-shuyin.github.io/pi-web-ui-site/) · 📖 [**详细文档中心**](https://xing-shuyin.github.io/pi-web-ui-site/docs.html)

[![npm 版本](https://img.shields.io/npm/v/pi-web-ui?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-web-ui)
[![Node.js](https://img.shields.io/node/v/pi-web-ui?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> 打开浏览器，完成所有工作 —— 面向 AI 编码智能体的全功能 Web 驾驶舱（对话、代码、文件树、终端、Git 尽在一屏）。

pi-web-ui 是基于 pi 智能体 SDK（`@earendil-works/pi-coding-agent`）与 DeepSeek Harness (DSH) 的现代 Web 界面与桌面端工作台。它将本地命令行智能体转化为具备丰富可视化、多任务并发、完整文件与终端交互的一站式编程座舱，并原生支持直接打开与协同远程 SSH 服务器项目。

---

## 🌟 全面功能特性

### 💬 智能对话与交互体验

- **快照驱动与毫秒级流式响应**：基于 WebSocket 的快照增量推流，思考链（Thinking/Reasoning）、工具调用状态、执行耗时与终端输出实时呈现。
- **人机协同结构化问卷 (`ask_user_question`)**：模型可主动向用户发起结构化问卷（单选/多选/富文本选项/自由输入），以优雅对话框展示；支持超时豁免与页面刷新自动恢复。
- **网页元素交互 (`Page Picker`)**：配套 Chrome 浏览器扩展，一键在真实网页中点选 DOM 元素，将视觉快照与精确选择器无缝带入对话供智能体分析。
- **并发多会话与独立运行态**：单项目支持多对话并行执行，后台会话持续运行；支持对话分支重问（Fork）、排队消息撤回（↩）与会话过户。
- **丰富对话辅助**：全局斜杠命令 picker（`/new`、`/model`、`/compact` 等）、一键提示词模板库、上下文压缩卡片、报错自动重试与桌面声音提醒。

### 📁 工作区、多模态与 🌐 远程 SSH 项目

- **多根工作区（Multi-Root）与丰富文件树**：支持主工作区及最多 8 个外部根目录，实时监控工作区变动与快速文件过滤；配备全功能文件右键菜单，支持一键在资源管理器中显示、作为新项目/工作区根打开、整目录打包压缩并下载、路径一键链接到对话等。
- **🌐 远程 SSH 服务器项目**：支持直接打开远程 Linux 服务器项目（`ssh://user@host:port/path`）：
  - **凭据与连接**：支持密码、SSH 私钥（`~/.ssh/id_rsa` / `id_ed25519`）及 SSH-Agent，配置经 AES-256-GCM 本地加密保存；
  - **远端环境探针**：自动探测远程 OS 架构及 Git/Node/Bash 依赖，缺失工具一键远程安装；
  - **无缝远端全栈开发**：SFTP 驱动的文件树浏览、在线预览与实时编辑（`Ctrl+S`）、AI 工具远端执行、交互式远程 PTY 终端；本地自动持久化对话记录。
- **多功能富媒体文件预览**：支持语法高亮、Markdown 渲染、图片/音视频媒体播放，并在预览窗口中直接编辑与一键保存（`Ctrl+S`）。
- **智能附件与多模态视觉桥（Vision Bridge）**：拖拽任意文件上传；对图片及文档自动转写为多模态视觉载荷，兼具纯文本引用模式与局部行截取。
- **成果卡片呈现 (`present_files`)**：智能体产出的图表、报告、网页及编译产物自动生成交互式预览卡片，支持本地唤起与一键导出。

### 💻 内置终端与 Git 源代码管理

- **服务端 PTY 终端**：基于 node-pty 与 xterm.js，提供多标签页、全功能交互式终端，智能体可在可见的 `ai-bash` 终端中交互式执行命令。
- **可视化 Git 驾驶舱**：代码变更一览无余，支持单文件 Diff 查看、Stage/Unstage 暂存、一键 Commit 提交、分支切换与快进合并（Fetch/Pull）。
- **终端样式与主题统一**：终端配色实时跟随选定主题，支持选择文本自动复制、拖拽文件直接粘贴路径。

### 🤖 多引擎与模型灵活路由

- **多智能体引擎无缝热切换**：原生深度集成 pi 编码智能体 SDK、DeepSeek Harness (DSH) 引擎以及 Claude 官方智能体底座，支持零重启秒级切换引擎，不同标签页与会话可并发运行不同引擎。
- **多服务商通用兼容**：支持 OpenAI、Anthropic (Claude)、Google Gemini、DeepSeek、Ollama、OpenRouter、Azure 等任意标准 API。
- **零泄密凭据架构**：API Key 与敏感鉴权 Header 仅在服务端持久化并注入请求，绝对不下发至浏览器端。
- **智能上下文预算与软上限**：动态注入软上限压缩阈值（Soft-Cap），配合 20 分钟死锁看门狗守护，避免会话卡死与 Token 浪费。

### 🧭 进阶代理协作模式

- **硬围栏安全沙盒模式 (Sandbox Project)**：在受保护的独立副本中自由实验原型、执行破坏性命令或测试重构，一切修改绝不触碰原项目；支持从现有项目快照克隆或建立纯净空白沙盒，提供临时（用完即删）与永久双重生命周期。
- **目标模式 2.0 (Goal Mode)**：主会话担任审查者（Reviewer），服务端自动编排后台落盘执行者（Executor）；具备执行证据注入与停滞熔断机制。
- **审查者委派模式 (Delegate Mode)**：主会话专注规划与审查，Prompt 自动委派至常驻执行对话，写操作实施硬闸门拦截。
- **计划模式 (Plan Mode)**：目标条一键开启「只规划」模式，硬闸门动态拦截写工具与大段代码倾倒，确认计划后一键转入实施。
- **子代理系统 (Subagents)**：支持后台派发多角色并行子代理，内置标准化模板体系与独立会话隔离。

### 🧩 插件生态与高度可扩展性

- **官方插件市场与一键安装**：内置应用市场，覆盖通讯机器人（飞书/钉钉/微信/Slack/Discord）、数据库客户端、Mermaid 流程图、Office 预览等扩展。
- **33+ 宿主 UI 扩展插槽**：提供灵活的 UI 插槽体系，支持插件注入侧边栏、顶栏、底栏、浮层及快捷工具。
- **工具按需延迟加载 (Lazy Loading)**：保持模型 Prompt Cache 前缀硬约束的前提下，按需挂载工具能力，降低上下文开销。
- **预设安全分享**：支持设置与环境的一键导出/导入，具备严格白名单字段净化。

### 🎨 主题与无缝多语言

- **25+ 套内置调色板与壁纸引擎联动**：内置深色、浅色、Cyberpunk、Dracula 等丰富主题，支持自定义 CSS 热重载；深度支持 **Wallpaper Engine** 动态壁纸库插件，界面透明度、毛玻璃模糊度、自动轮播与音乐频谱随心定制。
- **全界面国际化**：内置简体中文、繁體中文（台灣/香港/通用）、English 等语言支持，语言包自动回落。

---

## 🖼️ 界面预览

### 🎬 演示视频

<p align="center">
  <a href="https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/demo-video.mp4">
    <img src="https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/demo-video-poster.png" alt="pi-web-ui 操作演示视频（点击播放）" width="100%" style="max-width: 900px; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.35);" />
  </a>
  <br>
  <em>🎬 点击上方预览图直接在浏览器中播放完整操作演示视频（或右键另存为下载）</em>
</p>

### 📸 功能截屏

<p align="center">
  <img src="https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/portable-edition.png" alt="便携版全功能驾驶舱界面" width="100%" style="max-width: 900px; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.25);" />
  <br>
  <em>便携版全功能桌面工作台（毛玻璃动态壁纸与提示词面板）</em>
</p>

|                                              智能对话与提示词模板                                              |                                             运行轨迹时间线                                             |
| :------------------------------------------------------------------------------------------------------------: | :----------------------------------------------------------------------------------------------------: |
| ![智能对话与提示词模板](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/chat-prompts.jpeg) | ![运行轨迹时间线](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/trajectory.jpeg) |

|                                             多智能体引擎无缝切换                                              |                                             独立硬围栏安全沙盒                                              |
| :-----------------------------------------------------------------------------------------------------------: | :---------------------------------------------------------------------------------------------------------: |
| ![多智能体引擎无缝切换](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/multi-engine.png) | ![独立硬围栏安全沙盒](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/sandbox-mode.png) |

|                                                文件列表全功能右键菜单                                                |                                               Wallpaper Engine 壁纸联动                                                |
| :------------------------------------------------------------------------------------------------------------------: | :--------------------------------------------------------------------------------------------------------------------: |
| ![文件列表全功能右键菜单](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/file-context-menu.png) | ![Wallpaper Engine 壁纸联动](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/wallpaper-engine.png) |

|                                       设置面板与模型管理                                       |                                         内置 PTY 终端                                          |                                         Git 源代码管理                                          |
| :--------------------------------------------------------------------------------------------: | :--------------------------------------------------------------------------------------------: | :---------------------------------------------------------------------------------------------: |
| ![设置面板](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/settings.jpeg) | ![内置终端](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/terminal.jpeg) | ![Git 源代码管理](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/git.jpeg) |

---

## 📦 安装方式

### 环境要求

- **Node.js**：`>= 22.19.0`（便携版除外，便携版免装 Node.js 与 Git）
- 支持系统：Linux、macOS、Windows（或 Android Termux）

### 1. npm 全局安装（推荐）

```bash
npm i -g pi-web-ui
```

> **提示（npm ≥ 12）**：npm 12+ 默认阻止本地原生模块的编译脚本。`node-pty` 是终端原生模块，安装时请允许脚本执行：
>
> ```bash
> npm i -g --allow-scripts=node-pty,@google/genai,protobufjs pi-web-ui@latest
> ```

### 2. npx 免安装即时运行

无需预先安装，每次自动拉取最新版本启动：

```bash
npx pi-web-ui
```

### 3. 🖥️ Windows U 盘便携版（Portable Edition，开箱即用零依赖）

专为随身携带（U 盘、移动硬盘）打造的完全自包含便携版：

<p align="center">
  <img src="https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/portable-edition.png" alt="Windows 便携版" width="100%" style="max-width: 800px; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.25);" />
</p>

- **[⬇️ 前往 Releases 下载 `pi-web-ui-desktop-<版本>-portable.zip`](https://github.com/xing-shuyin/pi-web-ui/releases/latest)**
- **开箱即用 / 零开发环境依赖**：内置完整 PortableGit 与 bash/Linux 工具链，目标电脑**无需安装 Node.js、Git 或任何开发环境**。
- **100% 数据隔离自包含**：所有配置、模型凭据（`auth.json` / `models.json`）、会话历史、插件与缓存统统存放在便携目录下的 `data/` 目录，完全不写入宿主机的注册表或用户目录，拔掉 U 盘不留任何痕迹。
- **动态盘符自适应**：相对路径动态计算，换插不同电脑即使盘符变动也能直接运行。
- **启动方式**：解压后双击根目录下的 **`启动Pi.bat`**（或 `PiPortable.bat`）；附带 `创建桌面快捷方式.bat` 可一键在宿主机桌面生成无黑框官方快捷方式。
- **本地制作**：运行 `npm run desktop:portable:full` 即可在本地制作内置 Git 的完整便携版。

### 4. 桌面客户端安装包（Electron 独立应用）

偏好独立桌面窗口的用户可下载自动构建的安装程序：

- **[⬇️ 前往 Releases 页面下载安装包](https://github.com/xing-shuyin/pi-web-ui/releases/latest)**
- 提供 Windows 安装程序（`.exe`）、macOS（`.dmg`）及 Linux（`.AppImage`）。

### 5. Docker 容器部署

```bash
docker run -d \
  --name pi-web-ui \
  -p 8787:8787 \
  -v ~/.pi-web:/root/.pi-web \
  -v ~/.pi/agent:/root/.pi/agent \
  -v $(pwd):/workspace \
  -e PI_WEB_HOST=0.0.0.0 \
  xing-shuyin/pi-web-ui:latest
```

### 🐧 Linux 编译依赖说明

`node-pty` 原生模块在 Linux 上需要 C/C++ 编译工具链，若安装时提示找不到 `g++` 或 `make`，请先安装：

```bash
# Ubuntu / Debian
sudo apt-get install -y build-essential python3
# Fedora / RHEL
sudo dnf install -y python3 make gcc-c++
# Arch Linux
sudo pacman -S --needed base-devel python
```

---

## 🚀 启动与使用

### 常用启动命令

```bash
pi-web-ui                                 # 默认在当前目录启动，监听 http://127.0.0.1:8787
pi-web-ui --port 9000 --cwd /path/to/repo # 指定端口与工作区目录
pi-web-ui --no-browser                    # 启动服务但不自动弹出浏览器
```

### 🌐 打开远程 SSH 服务器项目

可以通过两种方式直接协同远程服务器项目：

1. **界面操作**：在页面顶栏工作区下拉菜单中点击「切换目录」→ 切换到「远程 (SSH)」选项卡，输入服务器地址（如 `192.168.1.100`）、端口、用户名及密码/私钥，点击「连接并探测环境」，随后浏览并选定远程项目目录即可。已存配置会自动加密保存在本地配置列表中，下次一键连接。
2. **命令行启动**：
   ```bash
   pi-web-ui --cwd ssh://ubuntu@192.168.1.100:22/var/www/my-project
   ```

### 核心参数与环境变量

| CLI 参数             | 环境变量          | 默认值      | 说明                                                                     |
| :------------------- | :---------------- | :---------- | :----------------------------------------------------------------------- |
| `--port <n>`         | `PI_WEB_PORT`     | `8787`      | HTTP 服务监听端口                                                        |
| `--host <addr>`      | `PI_WEB_HOST`     | `127.0.0.1` | 监听地址（远程/局域网访问设为 `0.0.0.0`）                                |
| `--cwd <dir>`        | `PI_WEB_CWD`      | 当前目录    | 工作区根（支持本地路径或 `ssh://user@host:port/path`）                   |
| `--data-dir <dir>`   | `PI_WEB_DATA_DIR` | `~/.pi-web` | 数据目录（配置、插件、上传、主题等）                                     |
| `--engine <pi\|dsh>` | `PI_WEB_ENGINE`   | `pi`        | 智能体引擎：`pi` 原生或 `dsh` (DeepSeek Harness)                         |
| `--no-browser`       | —                 | 否          | 启动后不自动在系统浏览器中打开网页                                       |
| _仅环境变量_         | `PI_WEB_TOKEN`    | 空          | 访问共享口令鉴权                                                         |
| _仅环境变量_         | `PI_WEB_SDK`      | `global`    | 默认跟随祖先链上更新的 pi SDK（多份取最高）；设为 `bundled` 锁定自带副本 |

### 后台守护服务管理 (`pi-web-ui server`)

pi-web-ui 内置系统服务管理，免配开机自启（macOS launchd / Linux systemd / Windows 登录自启）：

```bash
pi-web-ui server install --port 9000 --cwd /path/to/project  # 安装并开机自启
pi-web-ui server status                                    # 查看服务运行状态与连接数
pi-web-ui server restart                                   # 重启后台服务
pi-web-ui server stop                                      # 停止运行中的服务
pi-web-ui server uninstall                                 # 彻底卸载系统服务
```

### 版本升级与卸载

```bash
# 升级到最新版
npm i -g pi-web-ui@latest
pi-web-ui server restart

# 卸载程序（保留对话历史与配置数据）
npm uninstall -g pi-web-ui
```

---

## 🧩 插件生态与扩展

pi-web-ui 拥有完整的插件开发与扩展运行时：

- **插件市场**：在网页端「设置」→「插件市场」一键搜索、安装与启用官方内置与社区贡献的插件。
- **CLI 一键安装**：支持直接从 GitHub 仓库或本地目录安装插件：
  ```bash
  pi-web-ui install owner/repo
  ```
- **Page Picker 网页拾取器**：前往 [Releases](https://github.com/xing-shuyin/pi-web-ui/releases/latest) 下载 `page-picker-extension.zip`，解压后在 Chrome/Edge 的扩展程序中「加载已解压的扩展程序」即可使用。

### 🚀 欢迎提交第三方社区插件（全自动审核 · 秒级上线）

无论你开发了特色 AI 工具、自定义视图、第三方通讯机器人（飞书/企业微信/Telegram等）还是主题壁纸，都非常欢迎将插件提交至官方社区清单！

- 📦 **社区插件清单官方仓库**：👉 [**xing-shuyin/pi-web-ui-plugins**](https://github.com/xing-shuyin/pi-web-ui-plugins)
- 📖 **极简提交流程（支持网页端一键提交）**：
  1. 准备你的开源插件 GitHub 仓库（包含合法的开源协议与 `manifest.json`）；
  2. 访问并 Fork [xing-shuyin/pi-web-ui-plugins](https://github.com/xing-shuyin/pi-web-ui-plugins) 仓库；
  3. 新建目录 `plugins/<你的插件id>/plugin.json` 并填写元数据（名称、来源、功能描述，可直接在 GitHub 网页端点击「Add file」完成）；
  4. 发起 Pull Request 即可！

#### 🌟 提交到官方社区清单的核心优势

| 优势特性                               | 说明                                                                                                                                                                     |
| :------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⚡ **无人值守全自动合并 (Auto-Merge)** | 普通工具/视图插件（低风险）提交 PR 后，GitHub Actions 机器人即时触发全自动安全审计，**校验通过后机器人自动 Approve 并秒级自动合并**，无需等待人工排队审批。              |
| 🌐 **全球客户端即时曝光上线**          | 本清单是 `pi-web-ui` 服务端的**出厂默认订阅源**。PR 一经合并，约 1 分钟内全球所有用户的「插件市场」便能直接搜索并一键安装你的插件，享受庞大的用户生态。                  |
| 🛡️ **全流程安全审查与信誉背书**        | 提交以及后续的**每一次修改与更新**，CI 机器人均会自动执行严格的代码安全扫描（JSON Schema 校验、SVG 图标 XSS 过滤、敏感权限审查及原作者防冒用篡改保护），让用户放心安装。 |
| 🧩 **独立目录架构零冲突**              | 采用 `plugins/<id>/plugin.json` 独立隔离设计，多位开发者同时提交或更新不同插件绝不产生 Git 合并冲突。                                                                    |

---

## 📖 完整在线文档

更详尽的进阶配置、部署方案与二次开发指南，请查阅官方文档中心：

👉 **[前往详细文档中心 (Documentation Portal)](https://xing-shuyin.github.io/pi-web-ui-site/docs.html)**

- 🌐 [官方主页与功能导览](https://xing-shuyin.github.io/pi-web-ui-site/)
- 🌐 [远程 SSH 工作区与服务器配置指南](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#remote-ssh)
- 🖥️ [桌面便携版与定制制作手册](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#portable)
- 🛡️ [安全规范与反向代理部署 (Nginx / frp / SSL)](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#reverse-proxy)
- 🔌 [插件系统与 Plugin SDK 开发手册](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#plugin-sdk)
- ⚙️ [全量环境变量与高级参数参考表](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#environment-variables)
- 🏗️ [系统架构与实时 WebSocket 协议设计](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#architecture)
- 🐋 [Docker、Systemd 与守护进程进阶部署](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#deployment)

---

## 🤝 参与贡献与社区交流

欢迎提交 Issue、功能建议或贡献代码！每一个改进与反馈都让 pi-web-ui 变得更好。

- 💬 **QQ 交流群**：`1126050727`
- 💡 **问题反馈与需求建议**：[GitHub Issues](https://github.com/xing-shuyin/pi-web-ui/issues)
- 🗣️ **社区探讨**：[GitHub Discussions](https://github.com/xing-shuyin/pi-web-ui/discussions)
- 🔗 **作者相关项目**：[dsh-ui-tools](https://github.com/xing-shuyin/dsh-ui-tools)（DSH 生态 UI 工具集）

## 📄 开源许可证

本项目采用 [MIT License](LICENSE) 开源协议。
