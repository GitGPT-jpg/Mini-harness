# 训推引擎组 Harness

[English](README.md) | **简体中文** · [繁體中文](README.zh-TW.md) · [Harness 仓库指南](../README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> 基于 pi 与 Baidu One API、面向推理工程任务的浏览器驾驶舱。

本目录是**训推引擎组 Harness（mini-harness）** 的定制驾驶舱源码，源自 [xing-shuyin/pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) v0.111.0，使用 pi 智能体 SDK（`@earendil-works/pi-coding-agent`）与 Baidu One API。请通过当前仓库根目录的 [setup.sh](../setup.sh) 安装；上游 npm 包和发行版不包含这些定制。来源记录见 [PROVENANCE.md](PROVENANCE.md)。

---

## 当前 Harness 能力

### 💬 智能对话与交互体验

- **快照驱动与毫秒级流式响应**：基于 WebSocket 的快照增量推流，思考链（Thinking/Reasoning）、工具调用状态、执行耗时与终端输出实时呈现。
- **人机协同结构化问卷 (`ask_user_question`)**：模型可主动向用户发起结构化问卷（单选/多选/富文本选项/自由输入），以优雅对话框展示；支持超时豁免与页面刷新自动恢复。
- **并发多会话与独立运行态**：单项目支持多对话并行执行，后台会话持续运行；支持对话分支重问（Fork）、排队消息撤回（↩）与会话过户。
- **对话辅助**：斜杠命令、推理提示词模板、上下文压缩卡片、报错自动重试与桌面通知。

### 本地工作区与成果

- **本地项目**：打开工作目录，将文件引用带入对话。后端保留多根工作区能力，原侧栏文件树已移除。
- **文件预览与编辑**：浏览代码、Markdown 和图片，编辑本地文件，并将文件引用带入对话。
- **连接集群**：通过集群按钮填写 kubeconfig，用 `kubectl cluster-info` 实测连接；K8s 访问说明见仓库指南。
- **成果卡片呈现 (`present_files`)**：智能体产出的图表、报告、网页及编译产物自动生成交互式预览卡片，支持本地唤起与一键导出。

### 💻 内置终端与变更证据

- **服务端 PTY 终端**：基于 node-pty 与 xterm.js，提供多标签页、全功能交互式终端，智能体可在可见的 `ai-bash` 终端中交互式执行命令。
- **Git 与变更证据**：在终端执行 Git 命令，在任务详情查看运行记录中的 diff。原可视化 Git 面板已移除。
- **终端样式与主题统一**：终端配色实时跟随选定主题，支持选择文本自动复制、拖拽文件直接粘贴路径。

### pi 引擎与领域工作流

- **仅 pi 引擎**：首次配置预选 Baidu One API，填写自己的 API Key，凭据保存在本机 `~/.pi/agent/auth.json`。
- **统一任务入口**：「新任务」胶囊提供「代码验证 + 模型评审」「仅代码验证」「仅模型评审」三种验收方式。
- **LLM loop**：适合开放式任务的 AI 自评循环；调研向导先收集需求，计划经用户确认后执行。
- **代码 loop**：`intake → plan → run → validate` 状态落盘，支持 validator 门禁、迭代上限与断点续跑。可选 planner/reviewer 辅助制定和评审验收条件；reviewer 不能放行验证失败的任务。
- **任务台**：查看进度、工具调用时间线、运行详情与成果，暂停、继续或停止任务。
- **领域资源**：推理提示词模板、workflow 子代理、skills 和本地 `pi-llm-wiki` 知识库扩展，由根安装脚本配置。
- **上下文管理**：工具按需延迟加载与上下文压缩，降低上下文开销。

插件运行时与市场、MCP 集成、设置预设分享、Page Picker、Electron/便携桌面发行版及多引擎切换已移除。当前 Harness 配置关闭远程 SSH 工作区、Sandbox、Delegate、Plan 和子代理原生 UI 入口。

### 🎨 主题与无缝多语言

- **内置主题**：提供深浅色主题，终端配色随主题变化。
- **全界面国际化**：内置简体中文、繁體中文（台灣/香港/通用）、English 等语言支持，语言包自动回落。

---

## 上游历史截图与视频

以下媒体保留作上游参考，展示的是原始 pi-web-ui，包含当前已移除或关闭的桌面、多引擎、沙盒和壁纸功能，不代表当前 Harness 的功能范围。

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

### 环境要求与推荐安装

- macOS / Linux、**Node.js >= 22.19.0**、npm，可访问 npm 与 Baidu One API。
- macOS 若需编译 `node-pty`，请先安装 Xcode Command Line Tools。

克隆**当前 Harness 仓库**，将占位符替换为实际仓库地址：

```bash
git clone <当前仓库地址> mini-harness
cd mini-harness
./setup.sh
```

根安装脚本固定 pi 版本、构建驾驶舱并配置领域 skills、模型目录与知识库扩展；macOS 还会生成浏览器启动器。安装包与首次配置说明见[仓库指南](../README.md)。

### Docker 容器部署（仅驾驶舱）

在当前检出的 `pi-web-ui/` 目录构建本地镜像。容器不执行根安装脚本，需要先准备 pi 配置与领域资源。以下配置挂载为只读，请先在宿主机配置好凭据。

> **安全提示**：绑定 `0.0.0.0` 会把完整驾驶舱（对话、终端、文件读写）暴露给所有能访问该端口的人，部署前务必设置强口令 `PI_WEB_TOKEN`。

```bash
docker build -t mini-harness-cockpit:local .
docker run -d \
  --name pi-web-ui \
  -p 8787:8787 \
  -e PI_WEB_HOST=0.0.0.0 \
  -e PI_WEB_TOKEN=change-me \
  -e PI_WEB_CWD=/workspace \
  -e PI_CODING_AGENT_DIR=/pi-agent \
  -v pi-web-data:/app/.pi-web \
  -v ~/.pi/agent:/pi-agent:ro \
  -v "$(pwd):/workspace" \
  mini-harness-cockpit:local
```

- `pi-web-data:/app/.pi-web` 持久化各客户端会话与 UI 状态（镜像已把 `PI_WEB_DATA_DIR` 设为 `/app/.pi-web`）。
- `~/.pi/agent:/pi-agent:ro` 以只读方式挂载你的 pi 配置（`auth.json` / `models.json` / skills），经 `PI_CODING_AGENT_DIR` 指定。
- `$(pwd):/workspace` + `PI_WEB_CWD=/workspace` 把你的项目挂载为智能体工作区。

> **Compose 部署**：在 `pi-web-ui/` 自带的 `docker-compose.yml` 中设置强口令及项目/配置挂载，再运行 `docker compose up -d --build`（命名数据卷 + `restart: unless-stopped` 开机自启）。

### 从源码构建

完成安装后，从当前 Harness 仓库根目录执行以下命令，重新构建驾驶舱：

```bash
cd pi-web-ui
npm ci
npm run build
npm start        # 启动编译产物，默认监听 http://127.0.0.1:8787
```

`npm start` 直接启动驾驶舱服务；日常使用 Harness 请使用下文的加固启动脚本。

开发模式（热重载 `npm run dev`）见 [docs/development.md](docs/development.md)。

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

### 启动 Harness

在仓库根目录运行：

```bash
./pi-web-cockpit/start-hardened.sh
# 可选：改用其他端口
PI_WEB_PORT=9000 ./pi-web-cockpit/start-hardened.sh
```

启动脚本默认监听 `127.0.0.1:8787`，固定使用随包 pi SDK，并启用 token 鉴权。macOS 可双击安装时生成的桌面启动器，自动携带 token 打开浏览器；命令行启动时，使用 `~/.pi-web/pi-web-token` 中的口令访问页面。

首次打开时在配置对话框填写自己的 Baidu One API Key，默认 Base URL 为 `https://oneapi-comate.baidu-int.com/v1`。访问 K8s 时，通过集群按钮配置 kubeconfig。

### 更新与本地数据

更新当前 Harness 仓库后，重新运行根目录 `./setup.sh` 并重启服务。会话与配置保存在 `~/.pi/agent/` 和 `~/.pi-web/`。安装、打包与维护说明见[仓库指南](../README.md)。

---

## 文档与上游来源

- [Harness 仓库指南](../README.md)：安装、首次配置、集群访问与打包。
- [开发流程](docs/development.md)：本地开发与检查。
- [来源记录](PROVENANCE.md)：上游版本及引入方式。
- [上游 pi-web-ui](https://github.com/xing-shuyin/pi-web-ui)：原始项目，其产品文档描述上游功能范围。

Harness 定制相关问题请在当前仓库反馈。

## 开源许可证

本项目保留 [MIT License](LICENSE) 及上游归属：Copyright (c) 2026 xing-shuyin。
