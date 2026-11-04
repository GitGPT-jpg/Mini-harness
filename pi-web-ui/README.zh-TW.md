# 訓推引擎組 Harness

[English](README.md) | [簡體中文](README.zh-CN.md) · **繁體中文** · [Harness 倉庫指南](../README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> 基於 pi 與 Baidu One API、面向推理工程任務的瀏覽器駕駛艙。

本目錄是**訓推引擎組 Harness（mini-harness）** 的定製駕駛艙原始碼，源自 [xing-shuyin/pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) v0.111.0，使用 pi 代理 SDK（`@earendil-works/pi-coding-agent`）與 Baidu One API。請透過目前倉庫根目錄的 [setup.sh](../setup.sh) 安裝；上游 npm 套件和發行版不包含這些定製。來源記錄見 [PROVENANCE.md](PROVENANCE.md)。

---

## 目前 Harness 能力

### 💬 智慧對話與互動體驗

- **快照驅動與毫秒級流式回應**：基於 WebSocket 的快照增量推流，思考鏈（Thinking/Reasoning）、工具呼叫狀態、執行耗時與終端機輸出即時呈現。
- **人機協同結構化問卷 (`ask_user_question`)**：模型可主動向使用者發起結構化問卷（單選/多選/富文字選項/自由輸入），以優雅對話框展示；支援逾時豁免與頁面重新整理自動恢復。
- **並行多工作階段與獨立執行態**：單專案支援多對話平行執行，背景工作階段持續執行；支援對話分支重問（Fork）、排隊訊息撤回（↩）與工作階段轉移。
- **對話輔助**：斜槓命令、推理提示詞範本、上下文壓縮卡片、錯誤自動重試與桌面通知。

### 本地工作區與成果

- **本地專案**：開啟工作目錄，將檔案引用帶入對話。後端保留多根工作區能力，原側欄檔案樹已移除。
- **檔案預覽與編輯**：瀏覽程式碼、Markdown 和圖片，編輯本地檔案，並將檔案引用帶入對話。
- **連接叢集**：透過叢集按鈕填寫 kubeconfig，用 `kubectl cluster-info` 實測連線；K8s 存取說明見倉庫指南。
- **成果卡片呈現 (`present_files`)**：代理產出的圖表、報告、網頁及編譯產物自動產生互動式預覽卡片，支援本地喚起與一鍵匯出。

### 💻 內建終端機與變更證據

- **服務端 PTY 終端機**：基於 node-pty 與 xterm.js，提供多分頁、全功能互動式終端機，代理可在可見的 `ai-bash` 終端機中互動式執行命令。
- **Git 與變更證據**：在終端機執行 Git 命令，在任務詳情檢視執行記錄中的 diff。原視覺化 Git 面板已移除。
- **終端機樣式與主題統一**：終端機配色即時跟隨選定主題，支援選擇文字自動複製、拖曳檔案直接貼上路徑。

### pi 引擎與領域工作流程

- **僅 pi 引擎**：首次設定預選 Baidu One API，填寫自己的 API Key，憑據儲存在本機 `~/.pi/agent/auth.json`。
- **統一任務入口**：「新任務」膠囊提供「程式碼驗證 + 模型審查」「僅程式碼驗證」「僅模型審查」三種驗收方式。
- **LLM loop**：適合開放式任務的 AI 自評循環；調研精靈先收集需求，計畫經使用者確認後執行。
- **程式碼 loop**：`intake → plan → run → validate` 狀態寫入磁碟，支援 validator 閘門、迭代上限與斷點續跑。可選 planner/reviewer 輔助制定和審查驗收條件；reviewer 不能放行驗證失敗的任務。
- **任務台**：檢視進度、工具呼叫時間線、執行詳情與成果，暫停、繼續或停止任務。
- **領域資源**：推理提示詞範本、workflow 子代理、skills 和本地 `pi-llm-wiki` 知識庫擴充功能，由根安裝腳本設定。
- **上下文管理**：工具按需延遲載入與上下文壓縮，降低上下文開銷。

外掛執行時與市集、MCP 整合、設定預設集分享、Page Picker、Electron/便攜桌面發行版及多引擎切換已移除。目前 Harness 設定關閉遠端 SSH 工作區、Sandbox、Delegate、Plan 和子代理原生 UI 入口。

### 🎨 主題與無縫多語言

- **內建主題**：提供深淺色主題，終端機配色隨主題變化。
- **全介面國際化**：內建簡體中文、繁體中文（臺灣/香港/通用）、English 等語言支援，語言包自動回落。

---

## 上游歷史截圖與影片

以下媒體保留作上游參考，展示的是原始 pi-web-ui，包含目前已移除或關閉的桌面、多引擎、沙盒和桌布功能，不代表目前 Harness 的功能範圍。

### 🎬 演示影片

<p align="center">
  <a href="https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/demo-video.mp4">
    <img src="https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/demo-video-poster.png" alt="pi-web-ui 操作演示影片（點選播放）" width="100%" style="max-width: 900px; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.35);" />
  </a>
  <br>
  <em>🎬 點選上方預覽圖直接在瀏覽器中播放完整操作演示影片（或右鍵另存為下載）</em>
</p>

### 📸 功能截圖

<p align="center">
  <img src="https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/portable-edition.png" alt="便攜版全功能駕駛艙介面" width="100%" style="max-width: 900px; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.25);" />
  <br>
  <em>便攜版全功能桌面工作臺（毛玻璃動態桌布與提示詞面板）</em>
</p>

|                                              智慧對話與提示詞範本                                              |                                             執行軌跡時間線                                             |
| :------------------------------------------------------------------------------------------------------------: | :----------------------------------------------------------------------------------------------------: |
| ![智慧對話與提示詞範本](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/chat-prompts.jpeg) | ![執行軌跡時間線](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/trajectory.jpeg) |

|                                             多代理引擎無縫切換                                              |                                             獨立硬圍欄安全沙盒                                              |
| :---------------------------------------------------------------------------------------------------------: | :---------------------------------------------------------------------------------------------------------: |
| ![多代理引擎無縫切換](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/multi-engine.png) | ![獨立硬圍欄安全沙盒](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/sandbox-mode.png) |

|                                                檔案列表全功能右鍵選單                                                |                                               Wallpaper Engine 桌布聯動                                                |
| :------------------------------------------------------------------------------------------------------------------: | :--------------------------------------------------------------------------------------------------------------------: |
| ![檔案列表全功能右鍵選單](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/file-context-menu.png) | ![Wallpaper Engine 桌布聯動](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/wallpaper-engine.png) |

|                                       設定面板與模型管理                                       |                                         內建 PTY 終端機                                          |                                         Git 原始碼管理                                          |
| :--------------------------------------------------------------------------------------------: | :----------------------------------------------------------------------------------------------: | :---------------------------------------------------------------------------------------------: |
| ![設定面板](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/settings.jpeg) | ![內建終端機](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/terminal.jpeg) | ![Git 原始碼管理](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/git.jpeg) |

---

## 📦 安裝方式

### 環境要求與推薦安裝

- macOS / Linux、**Node.js >= 22.19.0**、npm，可存取 npm 與 Baidu One API。
- macOS 若需編譯 `node-pty`，請先安裝 Xcode Command Line Tools。

克隆**目前 Harness 倉庫**，將佔位符替換為實際倉庫位址：

```bash
git clone <目前倉庫位址> mini-harness
cd mini-harness
./setup.sh
```

根安裝腳本固定 pi 版本、建置駕駛艙並設定領域 skills、模型目錄與知識庫擴充功能；macOS 還會產生瀏覽器啟動器。安裝包與首次設定說明見[倉庫指南](../README.md)。

### Docker 容器部署（僅駕駛艙）

在目前檢出的 `pi-web-ui/` 目錄建置本地映像。容器不執行根安裝腳本，需要先準備 pi 設定與領域資源。以下設定掛載為唯讀，請先在宿主機設定好憑據。

> **安全提示**：綁定 `0.0.0.0` 會把完整駕駛艙（對話、終端機、檔案讀寫）暴露給所有能存取該連接埠的人，部署前務必設定強口令 `PI_WEB_TOKEN`。

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

- `pi-web-data:/app/.pi-web` 持久化各用戶端會話與 UI 狀態（映像已把 `PI_WEB_DATA_DIR` 設為 `/app/.pi-web`）。
- `~/.pi/agent:/pi-agent:ro` 以唯讀方式掛載你的 pi 設定（`auth.json` / `models.json` / skills），經 `PI_CODING_AGENT_DIR` 指定。
- `$(pwd):/workspace` + `PI_WEB_CWD=/workspace` 把你的專案掛載為智慧代理工作區。

> **Compose 部署**：在 `pi-web-ui/` 自帶的 `docker-compose.yml` 中設定強口令及專案/設定掛載，再執行 `docker compose up -d --build`（命名資料卷 + `restart: unless-stopped` 開機自啟）。

### 從原始碼建置

完成安裝後，從目前 Harness 倉庫根目錄執行以下命令，重新建置駕駛艙：

```bash
cd pi-web-ui
npm ci
npm run build
npm start        # 啟動編譯產物，預設監聽 http://127.0.0.1:8787
```

`npm start` 直接啟動駕駛艙服務；日常使用 Harness 請使用下文的加固啟動腳本。

開發模式（熱重載 `npm run dev`）見 [docs/development.md](docs/development.md)。

### 🐧 Linux 編譯依賴說明

`node-pty` 原生模組在 Linux 上需要 C/C++ 編譯工具鏈，若安裝時提示找不到 `g++` 或 `make`，請先安裝：

```bash
# Ubuntu / Debian
sudo apt-get install -y build-essential python3
# Fedora / RHEL
sudo dnf install -y python3 make gcc-c++
# Arch Linux
sudo pacman -S --needed base-devel python
```

---

## 🚀 啟動與使用

### 啟動 Harness

在倉庫根目錄執行：

```bash
./pi-web-cockpit/start-hardened.sh
# 可選：改用其他連接埠
PI_WEB_PORT=9000 ./pi-web-cockpit/start-hardened.sh
```

啟動腳本預設監聽 `127.0.0.1:8787`，固定使用隨包 pi SDK，並啟用 token 鑑權。macOS 可按兩下安裝時產生的桌面啟動器，自動攜帶 token 開啟瀏覽器；命令列啟動時，使用 `~/.pi-web/pi-web-token` 中的口令存取頁面。

首次開啟時在設定對話框填寫自己的 Baidu One API Key，預設 Base URL 為 `https://oneapi-comate.baidu-int.com/v1`。存取 K8s 時，透過叢集按鈕設定 kubeconfig。

### 更新與本地資料

更新目前 Harness 倉庫後，重新執行根目錄 `./setup.sh` 並重新啟動服務。工作階段與設定儲存在 `~/.pi/agent/` 和 `~/.pi-web/`。安裝、打包與維護說明見[倉庫指南](../README.md)。

---

## 文件與上游來源

- [Harness 倉庫指南](../README.md)：安裝、首次設定、叢集存取與打包。
- [開發流程](docs/development.md)：本地開發與檢查。
- [來源記錄](PROVENANCE.md)：上游版本及引入方式。
- [上游 pi-web-ui](https://github.com/xing-shuyin/pi-web-ui)：原始專案，其產品文件描述上游功能範圍。

Harness 定製相關問題請在目前倉庫回報。

## 開源許可證

本專案保留 [MIT License](LICENSE) 及上游歸屬：Copyright (c) 2026 xing-shuyin。
