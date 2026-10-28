# mini-harness-runtime（薄运行时扩展）

给 Pi 补上"公共运行时"：**任务状态机 + validator 准入 + 失败自动下一轮 + 断点续跑**。

## 状态机

```
intake → plan → run → validate ──pass──→ done
                          │
                          └─fail→ iterate（round+1）→ run → …
                                  └─ 达到 maxRounds → stopped
```

- **准入只认 validator**：默认 `workspace/validate.py`，或 `$HARNESS_ROOT/validate.py`，也可显式传 `validateCmd`。
- **失败自动下一轮**：把 validator 的 stdout/stderr 证据带回给模型，自动发起下一轮（`sendUserMessage` followUp）。
- **断点续跑**：状态落盘在仓库之外（默认 `~/.mini-harness/runs/<runId>/`），进程重启后按 session/workspace 自动接续。
- **不污染主提示词**：每轮状态作为隐藏尾消息注入，保持 provider 的 prompt cache 前缀稳定。

## 多角色：planner / reviewer（强制跨家族）

- **planner**（可选）：开工前由一个**不同家族**的模型产出拆解步骤与机器可验证的验收条件。
- **reviewer**（可选，有否决权）：validator 通过后，由另一个**不同家族**的模型基于
  「运行时采集的真实证据：工作区快照（git status/diff/未跟踪文件；非 git 目录回退目录快照）+
  artifactRoots 产物目录快照 + validator 输出」做审计。
  - **只能 block，不能 approve**：validator 未通过时无权放行。
  - block → 带 reviewer 理由进入下一轮（受 maxRounds 约束）。
  - 产物在 workspace 之外时，用 `artifactRoots` 显式告知运行时（例如 harness 的 `/external/runs/<id>`）。
- **家族约束**：`planner` 与主模型不同家族；`reviewer` 与主模型、`planner` 都不同家族。
  用户可显式指定，未指定时运行时自动挑选；显式冲突直接拒绝，不创建运行。
  家族按模型 id 识别：openai / anthropic / google / zhipu / moonshot / deepseek / xai / minimax / alibaba …

## 工具

| 工具 | 作用 |
|---|---|
| `loop_start(goal, validateCmd?, harnessRoot?, artifactRoots?, maxRounds?, auto?, plannerModel?, reviewerModel?, useReviewer?, worktree?)` | 创建运行（含家族校验与 planner；可选 worktree 隔离） |
| `loop_plan(plan)` | 记录计划，进入 `run` |
| `loop_done(summary)` | 声明本轮完成，触发运行时验证 |
| `loop_validate()` | 手动执行 validator（通过时同步跑 reviewer 并完结） |
| `loop_status(runId?)` | 查看状态/最近证据 |
| `loop_review(runId?)` | 查看审阅报告（goal/自述/计划/validator 输出/变更快照/reviewer 结论） |
| `loop_timeline(runId?)` | 查看事件时间线（start/plan/validate/review/…） |
| `loop_stop(reason?)` | 停止运行 |

## 并行 + worktree 隔离

- `loop_start(..., worktree: true)`：在 git 仓库里开一个独立 `git worktree`（分支 `mini-harness/<runId>`），
  任务在隔离工作树中执行，**验证通过后自动提交到该分支**（不自动合并，留给你 review 后 merge）。
  适合并行跑多个任务、互不污染主 checkout。
- watcher 支持并发：`WATCH_CONCURRENCY=N`（默认 1）。任务 JSON 可加 `"worktree": true`。

## 审阅与时间线（可读证据）

- 每轮自动写 `evidence/round-<n>-review.md`：goal / 自述 / 计划 / validator 输出 / 变更快照 / reviewer 结论。
- `loop_review` / `loop_timeline` 工具可随时把最新报告和时间线拉出来看。

## watcher（最小任务队列）

`watcher.mjs` 轮询 inbox 里的 `*.json` 任务，逐个交给 `pi --print` 执行，完成后归档到 `done/` 或 `failed/`：

```bash
MINI_HARNESS_INBOX=~/.mini-harness/inbox \
MINI_HARNESS_RUNTIME_ROOT=~/.mini-harness/runs \
node vendor/mini-harness-runtime/watcher.mjs
```

任务 JSON：`{goal, validateCmd, cwd?, artifactRoots?, maxRounds?, plannerModel?, reviewerModel?, useReviewer?, instructions?}`；
`instructions` 会追加到执行提示词（可放具体命令）；日志在 `inbox/logs/<task>.log`。
不引入 LangChain/AWS/Qdrant 等重依赖。

## 落盘结构

```
~/.mini-harness/runs/<runId>/
  state.json      # 状态机 + 历史
  journal.jsonl   # 事件流
  evidence/       # 每轮 validator 输出
```

可用 `MINI_HARNESS_RUNTIME_ROOT` 覆盖根目录。

## 安装

由 `pi-web-cockpit/harden.mjs` 自动 `pi install` 并登记到 `~/.pi/agent/settings.json`。

## 已验证

- 一次通过：round 1 → validate pass → reviewer pass → done
- 失败自动迭代：round 1 fail → 带证据 round 2 → pass → done
- 最大轮数：连续失败到 maxRounds → stopped（不无限循环）
- 断点续跑：进程重启后从 `state.json` 接续同一 runId 并完成
- 家族约束：同家族 planner 被拒绝且不创建运行；缺省自动挑选不同家族的 planner/reviewer
- reviewer 否决：validator 放水（恒通过）时 reviewer 能连续 block 并驱动修复；真实工作区快照可见后放行
- watcher：任务投递 → 自动执行 → validator+reviewer 通过 → 归档 `done/`（约 1 分钟/任务）
- **真实 harness 端到端**：在 `infer-forge-harness` 仓库内用 `cli/graph.py` 受管执行
  `perf-012g-decode-sim-db-gap-gate`，产物写入外部 artifact root，
  `tasks/decode_sim_db_gap_gate/validate.py` 真实通过，跨家族 reviewer 依据 artifact 快照通过；
  第 1 轮收敛，约 3 分钟（含 planner + reviewer）。
