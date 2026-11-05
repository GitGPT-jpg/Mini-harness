---
name: inference-tasks
description: 推理任务工作台（Comate 版）：创建并编排推理研发任务（推理性能 / 服务配置验证 / 缓存损耗 / 本地冒烟），用确定性 CLI 管任务状态机与指标门禁，自动多轮「执行→验收→分析失败→再执行」，支持跨会话续跑。当用户要「建一个推理任务」「跑一个冒烟任务」「优化缓存损耗/推理吞吐的任务」「查看/列出/停止/删除推理任务」「继续任务/接着跑」「任务第几轮怎么判定」或提到 inference-workbench / HARNESS_METRIC / 指标门禁 / 任务轮次 / validateCmd 时使用本 skill；用户说「新任务」「任务台」「按模板跑」等推理研发场景也应触发。
version: 1.1.0
---

# 推理任务工作台（inference-tasks）

把推理研发的「任务编排、回合执行、指标验收、证据落盘」做成确定性闭环：CLI 负责状态机与判定（不让模型自由心证），本 skill 负责编排，子代理负责执行。**用户只说一次任务目标，本 skill 在当前会话内自动推进多轮，直到通过 / 预算耗尽 / 用户停止 / 出现确实需要外部输入的阻塞。**

## 架构分工

| 层 | 承担 | 载体 |
| --- | --- | --- |
| 确定性层 | 任务状态机（stage×status×acceptance）、指标门禁、最优轮次、证据落盘、**下一步动作判定** | 本 skill 内 `scripts/cli/cli.mjs`（node ≥ 22，无依赖） |
| 编排层 | 何时调什么命令、如何派发执行、如何向用户汇报 | 本 skill（主对话） |
| 执行层 | 在工作目录内改代码 / 补文件 / 跑命令 | `inference-executor` 子代理；**没有则用 General 子代理 + `references/executor.md`** |

## 数据与路径

- CLI：`node <本 skill 根目录>/scripts/cli/cli.mjs <command>`（下文 `$CLI`）。用 skill 加载时给出的 base directory 拼路径，不硬编码绝对路径。
- 冒烟 validator：`<本 skill 根目录>/scripts/smoke-validator.mjs`。
- 数据（用户级，skill 升级不丢）：`~/.comate/data/inference-workbench/`
  - `tasks/<id>.json` 任务记录；`runs/<id>/round-N.{stdout,stderr}.txt + meta.json` 证据；`clusters/` 集群快照（0600）。
  - `INFERENCE_WORKBENCH_DATA` 可覆盖数据目录。

## 核心命令（判定与下一步动作统一由 CLI 给出）

```bash
node $CLI packs                                    # 模板目录（含 clusterRelevant）
node $CLI create --pack <id> --workspace <dir> [--goal ...] [--input k=v ...] [--max-rounds N]
node $CLI start --id <id>                          # 开始/重开；集群任务自动绑定快照
node $CLI status --id <id>                         # 统一快照 + next（下一步动作，由 CLI 判定）
node $CLI round-begin --id <id>                    # 领下一轮（plan/validate 阶段；产出执行提示词 + env）
node $CLI resume --id <id>                         # 续跑：stage=run 重发在飞轮次（不递增），否则等同 round-begin
node $CLI round-end --id <id> --exit-code N --stdout-file f [--stderr-file f]
node $CLI stop --id <id>                           # 停止
node $CLI delete --id <id> [--force]               # 删除记录与证据
node $CLI list / get --id <id>
node $CLI cluster list|bind|verify|env|unbind      # kubeconfig 发现 / 任务级绑定
```

`status` 返回 `task`（快照）与 `next.action ∈ {start, round-begin, resume-round, report}`，`report` 时带 `next.state ∈ {passed, failed, stopped}`。**下一步该做什么以 `status` 的 `next` 为准，不要凭对话记忆。**

## 自动闭环编排

### 0) 开场：确认目标后一次发起

用户说目标时，先补齐三个必要项再 `create`，缺什么问什么（`create` 返回的 `missingInputs` 翻译成人话）：

- **工作目录**（必须真实存在）
- **验收命令 validateCmd**（须输出 `HARNESS_METRIC: {"k": v}` 行与可选 `HARNESS_SCENARIO`；这是验收条件，任务开始时记录，之后改动要单独说明）
- **任务目标 goal**（验收标准在开始前固定）

`--max-rounds` 默认沿用模板配置（code-smoke=3，其余=6）。**create 后立即向用户展示本次预算**（如「预算 3 轮」），然后 `start`，进入循环，不再逐轮打断用户。

### 1) 循环：按 CLI 的 next 推进

```
loop:
  s = status --id <id>
  switch s.next.action:
    start        → start --id，回到 loop
    round-begin  → 领轮次 + 派发执行 + validator + round-end，回到 loop
    resume-round → resume --id（重发在飞轮次）+ 派发执行 + validator + round-end，回到 loop
    report       → 按 s.next.state 汇报并结束
```

- **每轮**：`round-begin`（或 `resume`）拿到 `prompt` 与 `env`，把执行派发出去（见 §2），子代理结束后**跑任务自己的 validateCmd**（读 `get --id` 里 `inputs[].value`），stdout/stderr 落临时文件，再 `round-end --exit-code <真实退出码> --stdout-file ... --stderr-file ...`。
- `round-end` 返回 `outcome.verdict`：
  - `pass` → 结束，用 `status` 的 report 汇报（含 bestRound）。
  - `fail` → 有指标但未达标；`status` 会给出 `round-begin`，继续下一轮（失败原因已自动进下一轮 prompt）。
  - `blocked` → 无法取得有效验收结果（无指标且命令失败 / 缺主指标 / 场景不匹配 / 缺 validateCmd）。**不盲目重试**：复述 `outcome.reason`，能自行修复的普通错误继续，确实需要外部输入（凭据/集群/依赖）则停并记录阻塞原因。
- **阶段性的进度汇报之后继续执行**，直到 `next.action == report`。

### 2) 执行派发（只装 Skill 也能跑）

按优先级选执行者，**每次派发都读 `<本 skill 根目录>/references/executor.md` 作为角色与边界约束**，连同 `round-begin`/`resume` 的 `prompt` 一起交给执行者：

1. 有 `inference-executor` 子代理 → Agent 工具 agentType=inference-executor。
2. 否则 → General 子代理，query 里先写 executor.md 的约束，再接本轮 `prompt`。
3. 若宿主连 General 子代理都无法调用 → 主对话按同样约束完成本轮，并在汇报里注明「本轮由主 Agent 执行」。

`prompt` 里已含：任务目标、验收标准、工作目录、环境快照、必要输入、当前轮次、上一轮失败原因（非首轮）、集群绑定与 KUBECONFIG（如有）。`round-begin` 的 `env.KUBECONFIG` 要显式写进 query（Comate 的 Agent 调用不能直接设环境变量，让子代理在自己命令里 `KUBECONFIG=<path> kubectl ...`）。

### 3) 结束与报告

- **passed**：报告 `bestRound`（轮次、指标）与证据目录；不夸大。
- **failed（预算耗尽）**：如实报告未达标，展示 `bestRound` 与 `next.gap`（剩余差距），不自行宣布成功。
- **stopped**：报告停止已确认（`stopConfirmedAt`），说明是否还有在飞轮次被取消。

## 续跑（继续任务）

用户说「继续任务」「接着跑」「上次那个任务」时：

1. `list` 看任务；有多个时让用户选 `id`。
2. `status --id` 读持久状态与 `next`：
   - `report/passed` → 已完成，报告已有结果，**不要重跑已完成轮次**。
   - `report/stopped` → 已停止，说明需要 `start` 才能重开。
   - `round-begin` → 有已完成轮次未通过，从正确位置继续（不会重复已通过轮次）。
   - `resume-round` → 上一轮派发后中断（没落盘验收），用 `resume` 重发本轮，不递增、不丢已有产物。
3. 证据在 `~/.comate/data/inference-workbench/runs/<id>/`，续跑前后都能回读。

## 停止

用户要求停止时：先停掉在飞的执行子代理，再 `stop --id`。之后 `round-begin`/`resume`/`round-end` 都会被拒绝（`status=stopped`），迟到结果不能覆盖停止状态——如实报告「已确认停止」。

## 集群配置（kubeconfig 发现 / 任务级绑定）

推理性能 / 服务配置验证 / 缓存损耗模板 `clusterRelevant`。kubeconfig 优先级 **explicit > env(KUBECONFIG) > default(~/.kube/config)**，发现只读。

- `create` 缺 kubeconfig 时自动按 env>default 发现并标 `source: discovery`；用户显式给不会被覆盖。
- `start` 自动把当前配置快照固定到任务（`clusters/bound-<id>-*.yaml`，0600）；之后外部改原文件不影响任务。没有 kubectl 时单文件且无相对凭据引用才按字节复制，否则 blocked。
- 绑定 blocked/none 时任务照常开始，但 KUBECONFIG 指向 `blocked.yaml`（`.invalid` 占位）——任务内 kubectl 必然失败，防误打全局集群，不要绕过。
- 快照含凭据：**不 cat / diff / 复制**。`cluster bind --context` 的 context 不存在会被拒绝并列出 `availableContexts`。

## 边界与红线

- **改动物理边界**：执行者只改任务 workspace 内文件；不做生产/集群操作（模板 knowledge 的 confirmBefore 先问用户）。
- **判定诚实**：`exit 0` ≠ pass；缺主指标就是 blocked。汇报只引用 CLI 的 verdict/acceptance 原文。
- **验收模式**：`code` = 纯指标门禁；`code-review` 要求 reviewer（审查在独立子代理对话里做，不许执行者自审）。
- **不要**用对话记忆代替 CLI 状态：每一步以 `status` / `round-end` 的返回为准。
- 失败输出是 stderr 上的 JSON `{ok:false, error, ...}`，读 `error` 决定问用户还是换路。
