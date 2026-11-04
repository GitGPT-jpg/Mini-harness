<div align="center">

# Training & Inference Engine Team Harness

**English** | [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [Harness repository guide](../README.md)

_Browser cockpit for inference engineering, powered by pi and Baidu One API._

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

</div>

This directory contains the customized browser cockpit for **训推引擎组 Harness (mini-harness)**, derived from [xing-shuyin/pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) v0.111.0. It uses the pi coding agent SDK (`@earendil-works/pi-coding-agent`) with Baidu One API. Install this repository through its root [setup.sh](../setup.sh); upstream npm packages and releases do not include these customizations. See [PROVENANCE.md](PROVENANCE.md) for the source record.

---

## Current Harness capabilities

### 💬 Intelligent Dialogue & Interaction

- **Snapshot-Driven Real-time Streaming**: Sub-60ms incremental snapshots via WebSocket. Displays live agent thought chains (Thinking/Reasoning), tool calls, elapsed execution times, and interactive terminal output.
- **Human-in-the-Loop Questionnaires (`ask_user_question`)**: The model can pose structured questions (single/multi-select, rich option previews, freeform text) in interactive dialogs, exempt from watchdog timeouts and recoverable across page refreshes.
- **Multi-Conversation Concurrency**: Run multiple parallel agent conversations in the same workspace; conversations run continuously in the background with support for edit-and-fork, message withdrawal (↩), and live migration.
- **Conversation tools**: Slash commands, inference prompt templates, context compression summaries, error retries and desktop notifications.

### Local workspace and artifacts

- **Local projects**: Open a working directory and attach file references to conversations. The backend retains multi-root workspace support; the former sidebar file tree has been removed.
- **File preview and editing**: Browse code, Markdown and images, edit local files, and attach file references to conversations.
- **Cluster access**: Supply kubeconfig through the cluster button; Harness checks connectivity with `kubectl cluster-info`. See the repository guide for K8s access.
- **Interactive Artifact Cards (`present_files`)**: Visually surface charts, reports, web pages, and generated files as rich cards with native reveal and quick opening.

### 💻 Integrated Terminal and Change Evidence

- **Server PTY Terminals**: Built on `node-pty` and `xterm.js` with multi-tab support and persistent `ai-bash` sessions, allowing the AI to run commands in visible, interactive terminals.
- **Git and change evidence**: Run Git commands in the terminal and inspect captured diffs in run details. The former visual Git panel has been removed.
- **Seamless Theme Integration**: Terminal colors automatically align with the active theme; supports native text selection and drag-and-drop file path pasting.

### pi engine and domain workflows

- **pi-only runtime**: First-run setup selects Baidu One API. Enter your own API key; it is stored locally in `~/.pi/agent/auth.json`.
- **Unified task entry**: The “New task” capsule offers code validation with model review, code validation only, or model review only.
- **LLM loop**: AI self-evaluation for open-ended tasks; the research wizard collects requirements and asks you to confirm the plan.
- **Code loop**: A persisted `intake → plan → run → validate` workflow with a validator gate, iteration limits and resume support. Optional planner/reviewer models help define and review acceptance; a reviewer cannot override a failed validator.
- **Task desk**: Inspect progress, tool timelines, run details and artifacts; pause, continue or stop tasks.
- **Domain resources**: Inference prompt templates, workflow subagents, skills and the local `pi-llm-wiki` knowledge extension, configured by the root installer.
- **Context management**: On-demand tool loading and context compression reduce context overhead.

The plugin runtime/market, MCP integration, settings preset sharing, Page Picker, Electron/portable desktop distribution and multi-engine switching have been removed. Remote SSH workspaces, Sandbox, Delegate, Plan and the native subagent UI entry points are disabled in this Harness configuration.

### 🎨 Themes & Internationalization

- **Built-in themes**: Light and dark themes with matching terminal colors.
- **Comprehensive Internationalization**: Built-in support for English, Simplified Chinese, Traditional Chinese (TW/HK), and custom community locale packs.

---

## Upstream historical screenshots and video

The following media is retained as upstream reference material. It shows the original pi-web-ui, including desktop, multi-engine, sandbox and wallpaper features that are removed or disabled here; it does not describe the current Harness feature set.

### 🎬 Demo Video

<p align="center">
  <a href="https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/demo-video.mp4">
    <img src="https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/demo-video-poster.png" alt="pi-web-ui demo video (click to play)" width="100%" style="max-width: 900px; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.35);" />
  </a>
  <br>
  <em>🎬 Click the preview above to play the full demo video directly in your browser (or right-click to save)</em>
</p>

### 📸 Feature Highlights

<p align="center">
  <img src="https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/portable-edition.png" alt="Portable edition cockpit interface" width="100%" style="max-width: 900px; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.25);" />
  <br>
  <em>Portable Edition desktop cockpit (with frosted-glass dynamic wallpaper and prompt templates)</em>
</p>

|                                              Chat with Prompt Templates                                              |                                             Run Trajectory Timeline                                             |
| :------------------------------------------------------------------------------------------------------------------: | :-------------------------------------------------------------------------------------------------------------: |
| ![Chat with prompt templates](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/chat-prompts.jpeg) | ![Run trajectory timeline](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/trajectory.jpeg) |

|                                             Multi-Agent Engine Hot-Switching                                              |                                             Hard-Fenced Sandbox Projects                                              |
| :-----------------------------------------------------------------------------------------------------------------------: | :-------------------------------------------------------------------------------------------------------------------: |
| ![Multi-Agent Engine Hot-Switching](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/multi-engine.png) | ![Hard-Fenced Sandbox Projects](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/sandbox-mode.png) |

|                                                Full File Context Menu                                                |                                               Wallpaper Engine Integration                                                |
| :------------------------------------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------------------------------------------------: |
| ![Full File Context Menu](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/file-context-menu.png) | ![Wallpaper Engine Integration](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/wallpaper-engine.png) |

|                                            Settings Panel                                            |                                            Built-in Terminal                                            |                                            Git Source Control                                             |
| :--------------------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------------------------------: | :-------------------------------------------------------------------------------------------------------: |
| ![Settings panel](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/settings.jpeg) | ![Built-in terminal](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/terminal.jpeg) | ![Git source control panel](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/git.jpeg) |

---

## 📦 Installation

### Requirements and recommended installation

- macOS / Linux, **Node.js >= 22.19.0**, npm, and access to npm and Baidu One API.
- On macOS, install Xcode Command Line Tools if `node-pty` needs compilation.

Clone the **current Harness repository** using its actual URL in place of the placeholder:

```bash
git clone <current-repository-url> mini-harness
cd mini-harness
./setup.sh
```

The root installer pins pi, builds this cockpit and configures domain skills, model metadata and the knowledge extension. On macOS it also creates a browser launcher. Packaging and first-run configuration are documented in the [repository guide](../README.md).

### Docker Container (cockpit only)

Build from this checkout, with `pi-web-ui/` as the Docker build context. The container does not run the root installer; prepare the pi configuration and domain resources first. Because the config mount below is read-only, configure credentials on the host before starting it.

> **Security**: Binding `0.0.0.0` exposes the full cockpit (chat, terminal, file access) to anyone who can reach the port. Set a strong `PI_WEB_TOKEN` before deploying.

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

- `pi-web-data:/app/.pi-web` persists chat sessions and UI state across restarts (the image sets `PI_WEB_DATA_DIR=/app/.pi-web`).
- `~/.pi/agent:/pi-agent:ro` mounts your pi config (`auth.json` / `models.json` / skills) read-only via `PI_CODING_AGENT_DIR`.
- `$(pwd):/workspace` + `PI_WEB_CWD=/workspace` mounts your project as the agent's workspace.

> **Compose deployment**: From `pi-web-ui/`, set a strong token and the project/config mounts in the bundled `docker-compose.yml`, then run `docker compose up -d --build` (named data volume + `restart: unless-stopped`).

### Build from Source

After completing setup, run from the current Harness repository root to rebuild the cockpit:

```bash
cd pi-web-ui
npm ci
npm run build
npm start        # starts the compiled server on http://127.0.0.1:8787
```

`npm start` runs the cockpit server directly. For normal Harness use, start it with the hardened launcher described below.

For development with hot reload (`npm run dev`), see [docs/development.md](docs/development.md).

### 🐧 Linux Build Prerequisites

The `node-pty` module requires C/C++ compilation tools on Linux. If installation fails with `g++` or `make` errors, install the build toolchain:

```bash
# Ubuntu / Debian
sudo apt-get install -y build-essential python3
# Fedora / RHEL
sudo dnf install -y python3 make gcc-c++
# Arch Linux
sudo pacman -S --needed base-devel python
```

---

## 🚀 Quick Start & Usage

### Starting Harness

Run from the repository root:

```bash
./pi-web-cockpit/start-hardened.sh
# Optional alternative port:
PI_WEB_PORT=9000 ./pi-web-cockpit/start-hardened.sh
```

The launcher binds to `127.0.0.1:8787`, uses the bundled pi SDK and enables token authentication. On macOS, the desktop launcher created by setup opens the browser with the token. For command-line startup, use the token stored in `~/.pi-web/pi-web-token` when opening the page.

On first launch, enter your Baidu One API key in the setup dialog. The default Base URL is `https://oneapi-comate.baidu-int.com/v1`. Use the cluster button to configure kubeconfig for K8s work.

### Updates and local data

Update this Harness checkout, rerun the root `./setup.sh`, then restart the service. Conversation/configuration data lives in `~/.pi/agent/` and `~/.pi-web/`. See the [repository guide](../README.md) for installation, packaging and maintenance.

---

## Documentation and upstream source

- [Harness repository guide](../README.md): installation, first-run configuration, cluster access and packaging.
- [Development workflow](docs/development.md): local development and checks.
- [Provenance](PROVENANCE.md): upstream version and import record.
- [Upstream pi-web-ui](https://github.com/xing-shuyin/pi-web-ui): original project; its product documentation describes the upstream feature set.

Report Harness-specific issues in the current repository.

## License

[MIT](LICENSE). Copyright (c) 2026 xing-shuyin. The upstream attribution and license are retained.
