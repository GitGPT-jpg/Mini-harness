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

## 工具

| 工具 | 作用 |
|---|---|
| `loop_start(goal, validateCmd?, harnessRoot?, maxRounds?, auto?)` | 创建运行 |
| `loop_plan(plan)` | 记录计划，进入 `run` |
| `loop_done(summary)` | 声明本轮完成，触发运行时验证 |
| `loop_validate()` | 手动执行 validator（通常由运行时自动调用） |
| `loop_status(runId?)` | 查看状态/最近证据 |
| `loop_stop(reason?)` | 停止运行 |

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

- 一次通过：round 1 → validate pass → done
- 失败自动迭代：round 1 fail → 带证据 round 2 → pass → done
- 最大轮数：连续失败到 maxRounds → stopped（不无限循环）
- 断点续跑：进程重启后从 `state.json` 接续同一 runId 并完成
