# pi-web-ui

[English](https://github.com/xing-shuyin/pi-web-ui/blob/main/README.md) | [簡體中文](https://github.com/xing-shuyin/pi-web-ui/blob/main/README.zh-CN.md) · **繁體中文** · 🌐 [**官方網站**](https://xing-shuyin.github.io/pi-web-ui-site/) · 📖 [**詳細文件中心**](https://xing-shuyin.github.io/pi-web-ui-site/docs.html)

[![npm 版本](https://img.shields.io/npm/v/pi-web-ui?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-web-ui)
[![Node.js](https://img.shields.io/node/v/pi-web-ui?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> 開啟瀏覽器，完成所有工作 —— 面向 AI 編碼代理的全功能 Web 駕駛艙（對話、程式碼、檔案樹、終端機、Git 盡在一屏）。

pi-web-ui 是基於 pi 代理 SDK（`@earendil-works/pi-coding-agent`）與 DeepSeek Harness (DSH) 的現代 Web 介面與桌面端工作臺。它將本地命令列代理轉化為具備豐富視覺化、多工併發、完整檔案與終端機互動的一站式程式設計座艙，並原生支援直接開啟與協同遠端 SSH 伺服器專案。

---

## 🌟 全面功能特性

### 💬 智慧對話與互動體驗

- **快照驅動與毫秒級流式回應**：基於 WebSocket 的快照增量推流，思考鏈（Thinking/Reasoning）、工具呼叫狀態、執行耗時與終端機輸出即時呈現。
- **人機協同結構化問卷 (`ask_user_question`)**：模型可主動向使用者發起結構化問卷（單選/多選/富文字選項/自由輸入），以優雅對話框展示；支援逾時豁免與頁面重新整理自動恢復。
- **網頁元素互動 (`Page Picker`)**：配套 Chrome 瀏覽器擴充功能，一鍵在真實網頁中點選 DOM 元素，將視覺快照與精確選擇器無縫帶入對話供代理分析。
- **並行多工作階段與獨立執行態**：單專案支援多對話平行執行，背景工作階段持續執行；支援對話分支重問（Fork）、排隊訊息撤回（↩）與工作階段轉移。
- **豐富對話輔助**：全域斜槓命令 picker（`/new`、`/model`、`/compact` 等）、一鍵提示詞範本庫、上下文壓縮卡片、錯誤自動重試與桌面聲音提醒。

### 📁 工作區、多模態與 🌐 遠端 SSH 專案

- **多根工作區（Multi-Root）與豐富檔案樹**：支援主工作區及最多 8 個外部根目錄，即時監控工作區變動與快速檔案過濾；配備全功能檔案右鍵選單，支援一鍵在資源管理器中顯示、作為新專案/工作區根開啟、整目錄打包壓縮並下載、路徑一鍵連結到對話等。
- **🌐 遠端 SSH 伺服器專案**：支援直接開啟遠端 Linux 伺服器專案（`ssh://user@host:port/path`）：
  - **憑據與連線**：支援密碼、SSH 私鑰（`~/.ssh/id_rsa` / `id_ed25519`）及 SSH-Agent，設定經 AES-256-GCM 本地加密儲存；
  - **遠端環境探針**：自動探測遠端 OS 架構及 Git/Node/Bash 依賴，缺失工具一鍵遠端安裝；
  - **無縫遠端全棧開發**：SFTP 驅動的檔案樹瀏覽、線上預覽與即時編輯（`Ctrl+S`）、AI 工具遠端執行、互動式遠端 PTY 終端機；本地自動持久化對話記錄。
- **多功能富媒體檔案預覽**：支援語法高亮、Markdown 渲染、圖片/音影片媒體播放，並在預覽視窗中直接編輯與一鍵儲存（`Ctrl+S`）。
- **智慧附件與多模態視覺橋（Vision Bridge）**：拖曳任意檔案上傳；對圖片及文件自動轉寫為多模態視覺載荷，兼具純文字引用模式與區域性行擷取。
- **成果卡片呈現 (`present_files`)**：代理產出的圖表、報告、網頁及編譯產物自動產生互動式預覽卡片，支援本地喚起與一鍵匯出。

### 💻 內建終端機與 Git 原始碼管理

- **服務端 PTY 終端機**：基於 node-pty 與 xterm.js，提供多分頁、全功能互動式終端機，代理可在可見的 `ai-bash` 終端機中互動式執行命令。
- **視覺化 Git 駕駛艙**：程式碼變更一覽無餘，支援單檔案 Diff 檢視、Stage/Unstage 暫存、一鍵 Commit 提交、分支切換與快進合併（Fetch/Pull）。
- **終端機樣式與主題統一**：終端機配色即時跟隨選定主題，支援選擇文字自動複製、拖曳檔案直接貼上路徑。

### 🤖 多引擎與模型靈活路由

- **多代理引擎無縫熱切換**：原生深度整合 pi 編碼代理 SDK、DeepSeek Harness (DSH) 引擎以及 Claude 官方代理底座，支援零重新啟動秒級切換引擎，不同分頁與工作階段可併發執行不同引擎。
- **多供應商通用相容**：支援 OpenAI、Anthropic (Claude)、Google Gemini、DeepSeek、Ollama、OpenRouter、Azure 等任意標準 API。
- **零洩密憑據架構**：API Key 與敏感鑑權 Header 僅在服務端持久化並注入請求，絕對不下發至瀏覽器端。
- **智慧上下文預算與軟上限**：動態注入軟上限壓縮閾值（Soft-Cap），配合 20 分鐘死鎖看門狗守護，避免工作階段卡死與 Token 浪費。

### 🧭 進階代理協作模式

- **硬圍欄安全沙盒模式 (Sandbox Project)**：在受保護的獨立副本中自由實驗原型、執行破壞性命令或測試重構，一切修改絕不觸碰原專案；支援從現有專案快照克隆或建立純淨空白沙盒，提供臨時（用完即刪）與永久雙重生命週期。
- **目標模式 2.0 (Goal Mode)**：主工作階段擔任審查者（Reviewer），服務端自動編排背景寫入磁碟執行者（Executor）；具備執行證據注入與停滯熔斷機制。
- **審查者委派模式 (Delegate Mode)**：主工作階段專注規劃與審查，Prompt 自動委派至常駐執行對話，寫操作實施硬閘門攔截。
- **計畫模式 (Plan Mode)**：目標條一鍵開啟「只規劃」模式，硬閘門動態攔截寫工具與大段程式碼傾倒，確認計畫後一鍵轉入實施。
- **子代理系統 (Subagents)**：支援背景派發多角色平行子代理，內建標準化範本體系與獨立工作階段隔離。

### 🧩 外掛生態與高度可擴充套件性

- **官方外掛市集與一鍵安裝**：內建應用程式市集，覆蓋通訊機器人（飛書/釘釘/微信/Slack/Discord）、資料庫用戶端、Mermaid 流程圖、Office 預覽等擴充套件。
- **33+ 宿主 UI 擴充套件插槽**：提供靈活的 UI 插槽體系，支援外掛注入側邊欄、頂欄、底欄、浮層及快捷工具。
- **工具按需延遲載入 (Lazy Loading)**：保持模型 Prompt Cache 字首硬約束的前提下，按需掛載工具能力，降低上下文開銷。
- **預設集安全分享**：支援設定與環境的一鍵匯出/匯入，具備嚴格白名單欄位淨化。

### 🎨 主題與無縫多語言

- **25+ 套內建調色盤與桌布引擎聯動**：內建深色、淺色、Cyberpunk、Dracula 等豐富主題，支援自訂 CSS 熱重新載入；深度支援 **Wallpaper Engine** 動態桌布庫外掛，介面透明度、毛玻璃模糊度、自動輪播與音樂頻譜隨心定製。
- **全介面國際化**：內建簡體中文、繁體中文（臺灣/香港/通用）、English 等語言支援，語言包自動回落。

---

## 🖼️ 介面預覽

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

### 環境要求

- **Node.js**：`>= 22.19.0`（便攜版除外，便攜版免裝 Node.js 與 Git）
- 支援系統：Linux、macOS、Windows（或 Android Termux）

### 1. npm 全域安裝（推薦）

```bash
npm i -g pi-web-ui
```

> **提示（npm ≥ 12）**：npm 12+ 預設阻止本地原生模組的編譯腳本。`node-pty` 是終端機原生模組，安裝時請允許腳本執行：
>
> ```bash
> npm i -g --allow-scripts=node-pty,@google/genai,protobufjs pi-web-ui@latest
> ```

### 2. npx 免安裝即時執行

無需預先安裝，每次自動取得最新版本啟動：

```bash
npx pi-web-ui
```

### 3. 🖥️ Windows U 盤便攜版（Portable Edition，開箱即用零依賴）

專為隨身攜帶（U 盤、行動硬碟）打造的完全自包含便攜版：

<p align="center">
  <img src="https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/portable-edition.png" alt="Windows 便攜版" width="100%" style="max-width: 800px; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.25);" />
</p>

- **[⬇️ 前往 Releases 下載 `pi-web-ui-desktop-<版本>-portable.zip`](https://github.com/xing-shuyin/pi-web-ui/releases/latest)**
- **開箱即用 / 零開發環境依賴**：內建完整 PortableGit 與 bash/Linux 工具鏈，目標電腦**無需安裝 Node.js、Git 或任何開發環境**。
- **100% 資料隔離自包含**：所有設定、模型憑據（`auth.json` / `models.json`）、工作階段歷史、外掛與快取統統存放在便攜目錄下的 `data/` 目錄，完全不寫入宿主機的登錄檔或使用者目錄，拔掉 U 盤不留任何痕跡。
- **動態磁碟機代號自適應**：相對路徑動態計算，換插不同電腦即使磁碟機代號變動也能直接執行。
- **啟動方式**：解壓縮後按兩下根目錄下的 **`啟動Pi.bat`**（或 `PiPortable.bat`）；附帶 `建立桌面快捷方式.bat` 可一鍵在宿主機桌面產生無黑框官方快捷方式。
- **本地製作**：執行 `npm run desktop:portable:full` 即可在本地製作內建 Git 的完整便攜版。

### 4. 桌面用戶端安裝包（Electron 獨立應用程式）

偏好獨立桌面視窗的使用者可下載自動建置的安裝程式：

- **[⬇️ 前往 Releases 頁面下載安裝包](https://github.com/xing-shuyin/pi-web-ui/releases/latest)**
- 提供 Windows 安裝程式（`.exe`）、macOS（`.dmg`）及 Linux（`.AppImage`）。

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

### 常用啟動命令

```bash
pi-web-ui                                 # 預設在目前目錄啟動，監聽 http://127.0.0.1:8787
pi-web-ui --port 9000 --cwd /path/to/repo # 指定埠與工作區目錄
pi-web-ui --no-browser                    # 啟動服務但不自動彈出瀏覽器
```

### 🌐 開啟遠端 SSH 伺服器專案

可以通過兩種方式直接協同遠端伺服器專案：

1. **介面操作**：在頁面頂欄工作區下拉選單中點選「切換目錄」→ 切換到「遠端 (SSH)」選項卡，輸入伺服器位址（如 `192.168.1.100`）、埠、使用者名稱及密碼/私鑰，點選「連線並探測環境」，隨後瀏覽並選定遠端專案目錄即可。已存設定會自動加密儲存在本地設定列表中，下次一鍵連線。
2. **命令列啟動**：
   ```bash
   pi-web-ui --cwd ssh://ubuntu@192.168.1.100:22/var/www/my-project
   ```

### 核心參數與環境變數

| CLI 參數             | 環境變數          | 預設值      | 說明                                                                     |
| :------------------- | :---------------- | :---------- | :----------------------------------------------------------------------- |
| `--port <n>`         | `PI_WEB_PORT`     | `8787`      | HTTP 服務監聽埠                                                          |
| `--host <addr>`      | `PI_WEB_HOST`     | `127.0.0.1` | 監聽位址（遠端/區域網存取設為 `0.0.0.0`）                                |
| `--cwd <dir>`        | `PI_WEB_CWD`      | 目前目錄    | 工作區根（支援本地路徑或 `ssh://user@host:port/path`）                   |
| `--data-dir <dir>`   | `PI_WEB_DATA_DIR` | `~/.pi-web` | 資料目錄（設定、外掛、上傳、主題等）                                     |
| `--engine <pi\|dsh>` | `PI_WEB_ENGINE`   | `pi`        | 代理引擎：`pi` 原生或 `dsh` (DeepSeek Harness)                           |
| `--no-browser`       | —                 | 否          | 啟動後不自動在系統瀏覽器中開啟網頁                                       |
| _僅環境變數_         | `PI_WEB_TOKEN`    | 空          | 存取共享口令鑑權                                                         |
| _僅環境變數_         | `PI_WEB_SDK`      | `global`    | 預設跟隨祖先鏈上更新的 pi SDK（多份取最高）；設為 `bundled` 鎖定內建副本 |

### 背景守護服務管理 (`pi-web-ui server`)

pi-web-ui 內建系統服務管理，免配開機自啟（macOS launchd / Linux systemd / Windows 登入自啟）：

```bash
pi-web-ui server install --port 9000 --cwd /path/to/project  # 安裝並開機自啟
pi-web-ui server status                                    # 檢視服務執行狀態與連線數
pi-web-ui server restart                                   # 重新啟動背景服務
pi-web-ui server stop                                      # 停止執行中的服務
pi-web-ui server uninstall                                 # 徹底解除安裝系統服務
```

### 版本升級與解除安裝

```bash
# 升級到最新版
npm i -g pi-web-ui@latest
pi-web-ui server restart

# 解除安裝程式（保留對話歷史與設定資料）
npm uninstall -g pi-web-ui
```

---

## 🧩 外掛生態與擴充套件

pi-web-ui 擁有完整的外掛開發與擴充套件執行時：

- **外掛市集**：在網頁端「設定」→「外掛市集」一鍵搜尋、安裝與啟用官方內建與社群貢獻的外掛。
- **CLI 一鍵安裝**：支援直接從 GitHub 儲存庫或本地目錄安裝外掛：
  ```bash
  pi-web-ui install owner/repo
  ```
- **Page Picker 網頁拾取器**：前往 [Releases](https://github.com/xing-shuyin/pi-web-ui/releases/latest) 下載 `page-picker-extension.zip`，解壓縮後在 Chrome/Edge 的擴充功能中「載入已解壓縮的擴充功能」即可使用。

### 🚀 歡迎提交第三方社群外掛（全自動審查 · 秒級上架）

無論你開發了特色 AI 工具、自訂檢視、第三方通訊機器人（Telegram/Discord/Slack等）還是主題桌布，都非常歡迎將外掛提交至官方社群清單！

- 📦 **社群外掛清單官方儲存庫**：👉 [**xing-shuyin/pi-web-ui-plugins**](https://github.com/xing-shuyin/pi-web-ui-plugins)
- 📖 **極簡提交流程（支援網頁端一鍵提交）**：
  1. 準備你的開源外掛 GitHub 儲存庫（包含合法的開源協定與 `manifest.json`）；
  2. 造訪並 Fork [xing-shuyin/pi-web-ui-plugins](https://github.com/xing-shuyin/pi-web-ui-plugins) 儲存庫；
  3. 新增目錄 `plugins/<你的外掛id>/plugin.json` 並填寫元資料（名稱、來源、功能描述，可直接在 GitHub 網頁端點選「Add file」完成）；
  4. 發起 Pull Request 即可！

#### 🌟 提交到官方社群清單的核心優勢

| 優勢特性                               | 說明                                                                                                                                                                         |
| :------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⚡ **無人值守全自動合併 (Auto-Merge)** | 普通工具/檢視外掛（低風險）提交 PR 後，GitHub Actions 機器人即時觸發全自動安全審計，**校驗通過後機器人自動 Approve 並秒級自動合併**，無需等待人工排隊審批。                  |
| 🌐 **全球用戶端即時曝光上架**          | 本清單是 `pi-web-ui` 伺服器端的**原廠預設訂閱源**。PR 一經合併，約 1 分鐘內全球所有使用者的「外掛市集」便能直接搜尋並一鍵安裝你的外掛，享受龐大的使用者生態。                |
| 🛡️ **全流程安全審查與信譽背書**        | 提交以及後續的**每一次修改與更新**，CI 機器人均會自動執行嚴格的程式碼安全掃描（JSON Schema 檢驗、SVG 圖示 XSS 過濾、敏感權限審查及原作者防冒用篡改保護），讓使用者放心安裝。 |
| 🧩 **獨立目錄架構零衝突**              | 採用 `plugins/<id>/plugin.json` 獨立隔離設計，多位開發者同時提交或更新不同外掛絕不產生 Git 合併衝突。                                                                        |

---

## 📖 完整線上文件

更詳盡的進階設定、部署方案與二次開發指南，請查閱官方文件中心：

👉 **[前往詳細文件中心 (Documentation Portal)](https://xing-shuyin.github.io/pi-web-ui-site/docs.html)**

- 🌐 [官方主頁與功能導覽](https://xing-shuyin.github.io/pi-web-ui-site/)
- 🌐 [遠端 SSH 工作區與伺服器設定指南](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#remote-ssh)
- 🖥️ [桌面便攜版與定製製作手冊](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#portable)
- 🛡️ [安全規範與反向代理部署 (Nginx / frp / SSL)](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#reverse-proxy)
- 🔌 [外掛系統與 Plugin SDK 開發手冊](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#plugin-sdk)
- ⚙️ [全量環境變數與高階參數參考表](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#environment-variables)
- 🏗️ [系統架構與即時 WebSocket 協定設計](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#architecture)
- 🐋 [Docker、Systemd 與守護行程進階部署](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#deployment)

---

## 🤝 參與貢獻與社群交流

歡迎提交 Issue、功能建議或貢獻程式碼！每一個改進與回饋都讓 pi-web-ui 變得更好。

- 💬 **QQ 交流群**：`1126050727`
- 💡 **問題回饋與需求建議**：[GitHub Issues](https://github.com/xing-shuyin/pi-web-ui/issues)
- 🗣️ **社群探討**：[GitHub Discussions](https://github.com/xing-shuyin/pi-web-ui/discussions)
- 🔗 **作者相關專案**：[dsh-ui-tools](https://github.com/xing-shuyin/dsh-ui-tools)（DSH 生態 UI 工具集）

## 📄 開源許可證

本專案採用 [MIT License](LICENSE) 開源協定。
