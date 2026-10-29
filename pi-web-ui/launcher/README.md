# Pi Web UI 便携版 (Portable Edition)

这是一个专为随身携带（如放入 U 盘、移动硬盘）设计的便携版架构。

## 目录结构

```text
PiWebUI-Portable/
│
├── PiPortable.bat             # 便携版启动脚本（英文名）
├── 启动Pi.bat                 # 便携版启动脚本（中文快捷入口，调用 PiPortable.bat）
├── 创建桌面快捷方式.bat       # 一键在桌面生成带官方图标的快捷方式
├── CreateDesktopShortcut.bat  # 快捷方式创建脚本（英文入口）
├── Portable.flag              # 便携标记（主程序识别此标记后自动进入便携模式）
│
├── app/                       # 桌面主程序目录（解压后的 Electron 程序）
│   ├── pi-web-ui-desktop.exe
│   └── ...
│
├── runtime/                   # 独立运行时
│   ├── git/                   # 内置 PortableGit（放置解压后的 PortableGit 文件，提供 bash/git/ssh）
│   │   ├── cmd/
│   │   ├── usr/
│   │   └── ...
│   └── node/                  # 内置 Portable Node.js（提供 node.exe, npm, npx）
│       ├── node.exe
│       ├── npm.cmd
│       └── ...
│
├── data/                      # 核心数据隔离目录（拔掉 U 盘不留任何痕迹）
│   ├── agent/                 # pi 智能体配置与会话（auth.json, models.json, 会话历史）
│   ├── web/                   # WebUI 配置、审批规则、插件、上传文件
│   ├── git/                   # Git 全局配置（.gitconfig）
│   ├── home/                  # 虚拟便携用户家目录（存放 .ssh 密钥等）
│   ├── workspace/             # 默认便携工作空间
│   ├── electron/              # Electron 窗口配置与 Cookies
│   ├── npm-global/            # 便携版全局 npm 包与命令（如 claude, dsh, pi CLI）
│   └── npm-cache/             # 便携版 npm 下载缓存
│
└── checks/                    # 启动器探测提示文件（支持 UTF-8 与 GBK 代码页）
    ├── fatal-app.*.txt
    ├── warn-git.*.txt
    └── run-info.*.txt
```

## 使用方法

1. **一键启动**：
   双击根目录下的 `启动Pi.bat`（或 `PiPortable.bat`）。
2. **创建桌面快捷方式（可选）**：
   双击根目录下的 `创建桌面快捷方式.bat`，即可一键在当前电脑桌面上生成带有官方图标、静默启动的「Pi Web UI」桌面快捷方式，拔掉 U 盘后如不需要直接删除该快捷方式即可。
3. **完全自包含与多引擎扩展**：
   - 便携版内置了 PortableGit 与 Portable Node.js，无需宿主机安装 Git、Node 或 npm。
   - 在便携版内置终端中，可直接执行 `npm i -g @anthropic-ai/claude-code` 或 `npm i -g @deepseek-ai/dsh` 安装并体验其他引擎。
   - 所有通过 npm 全局安装的命令和包体均自动隔离在 `data/npm-global` 中，随 U 盘一起携带，换电脑即插即用，不污染宿主机。
4. **迁移历史配置（可选）**：
   可将现有电脑上的 `~/.pi/agent` 中的 `auth.json`、`models.json` 复制到 `data/agent/` 中。
