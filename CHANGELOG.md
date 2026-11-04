Changelog
===
以下记录项目中值得关注的变更。格式基于 [Keep a Changelog]，版本遵守 [Semantic Versioning]。

1.5.0 - 2026-11-04
---
### Added
- 新任务三模型：规划 / 执行 / 评审三个角色选择器（默认「自动（联立分配）」），执行与评审按家族隔离规则解析；执行模型不同于主对话模型时，任务在独立执行会话运行；仅模型评审的审查模型接入真正的审查回合。
- 首页关联工作树：默认只突出当前任务的工作树与有未提交改动的工作树；删除任务后横幅即时刷新。
- 任务详情删除：确认页说明会移除与保留的内容；UI 拦截运行中、停止待确认与脏工作树；run detail 提供工作树只读状态（path/exists/dirty/uncommitted）。
- 集群：按服务实际可见配置探测（封住凭据回显）；运行中任务绑定启动时的集群配置，重启后 Bash 与 validator 仍用原集群。
- 窗口一两条核心链路：冻结候选验收（命令启动 / 即时消费 / 重启后消费共用同一执行契约，精确树物化不再受 export-ignore 影响，验收内容与收下树一致）；停止后确认退出（回合与进程组退出确认后才显示已停止，停止与续跑共用实体核对规则）。

### Changed
- 协议版本 40 → 41（`loop_start_request.executorModel`）。
- Git 收尾区分「已收下 / 同树无需提交 / 收尾受阻」，收尾受阻不提前报完成、任务台展示受阻原因，移除 `git add -A` 回退提交。

### Known Limitations
- Git 收尾在分支引用已被并发推进后重试，可能留下反向暂存差异（可重试「按代码验证收下」恢复）。
- 删除接口仍可能强删带未提交改动的工作树。**删除须知：只对已确认停止且工作树干净的任务执行删除**；工作树有未提交改动时，任务详情确认页会默认拦截并给出提交命令。

### Validation
- 类型检查、协议检查（v41）、lint（0 错误）、生产构建通过；全量 Vitest 348 文件 3639 通过、8 跳过。
- 联合冒烟：59/59 通过（含 task-three-models、goal-reviewer-model、goal-delegated、goal、cluster-binding-loop；terminal-smoke 首轮偶发、重跑通过，与本机既有慢机时序记录一致）。
- 浏览器停止确认（pending-stop）10/10；删除验证（真实服务 + 真实 git）6/6；集群 A 绑定 → 导入 B → 重启仍用 A（cluster-binding-loop 冒烟）。
- 本轮未重建 DMG、未验证 Docker 镜像与真实模型 / 真实集群。

1.0.1 - 2026-11-02
---
### Changed
- 1.0 系列收尾版：统一根 VERSION 与运行包版本；上游来源仍为 pi-web-ui v0.111.0，pi SDK 固定 1.4.0。已发布的 v1.0.0 标签保留。
- CLI 前台启动与服务安装只接受 pi 引擎；开发、部署与三语言 README 对齐当前源码。
- 浏览器标题默认仅显示应用名，favicon 与品牌 logo 同源；Safari 无 cookie 获取公开图标时可正常显示，其他接口继续鉴权。

### Removed
- 17 个失效脚本、孤立测试和退役文档；两个 DSH 直接依赖及 38 个锁文件包条目。
- Docker 中的 DSH 全局安装与 Compose 退役引擎示例。

### Validation
- 类型检查、lint、生产构建、协议与语言包检查通过；全量单测 313 个文件通过（3362 条通过、9 条跳过）。
- 任务入口与运行详情浏览器用例通过；全量冒烟 58/59，终端时序用例独立重跑 55/55。保留并发时序偶发记录。
- 本次为源码交付；未重建 DMG、未验证 Docker 镜像，未重跑干净 HOME 安装、真实模型或真实集群。

1.0.0 - 2026-10-30
---
### Added
- 统一「新任务」入口，按代码验证与模型评审方式分流；任务台与运行详情展示验收证据、日志、diff 和恢复操作。
- 服务端在执行前创建并绑定 run；评审错误明确停止，支持重试评审或用户显式按代码验证收下。
- HARNESS_* 环境变量与独立 CLI、L0/L1 分级验收、结构化指标与最优轮次、经验卡片沉淀。

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
