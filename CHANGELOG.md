Changelog
===
以下记录项目中值得关注的变更。格式基于 [Keep a Changelog]，版本遵守 [Semantic Versioning]。

[Unreleased]
---
### Changed
- 定制全部并入 `pi-web-ui/` 源码：`setup.sh` 直接构建源码，`start-hardened.sh` 运行 `pi-web-ui/dist`，访问口令由服务端生成（`PI_WEB_TOKEN=auto`）
- Loop 自主化：调研向导先提问 + 计划确认门禁、目标暂停/继续、Loop 任务台、代码 loop 启动弹窗、连接集群（kubeconfig 实测）

### Removed
- `harden.mjs`（npm 包补丁脚本）、`verify-hardened.mjs`、旧 `harness-server/`

0.1.0 - 2026-10-26
---
### Added
- 训推引擎组 Harness：将开源 pi 驾驶舱（pi-web-ui）定制为可移植推理底座
- `harden.mjs`：幂等、可逆的加固与定制脚本（路径运行时自推导）
- `setup.sh`：一键安装（固定 pi@1.4.0、装领域 skill、种 One API 服务商、生成桌面 .app）
- 首次 One API Key 配置门禁
- 内置 pi-llm-wiki（已安全审查）、7 个提示词模板、5 个推理子代理、7 个领域 skill

[Keep a Changelog]: https://keepachangelog.com/zh-CN/1.0.0/
[Semantic Versioning]: https://semver.org/lang/zh-CN/
