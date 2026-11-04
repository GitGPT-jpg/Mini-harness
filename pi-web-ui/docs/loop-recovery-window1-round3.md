# 恢复闭环第三轮（窗口一）：四项修复执行记录

基线：`harness-cockpit@33e80e5e06a6110592b6ddbafbd529be6ea97b21`（PR #1 源分支）。
本轮由窗口一负责四项（冻结内容、index 协调、目标回合停止、旧实体续跑阻断），
窗口二并行负责集群绑定与审查模型接线。共享文件改动记录到具体函数便于合入。

## 1. P1 验收、评审与提交使用同一份冻结内容

- 基线缺陷（可复现）：`captureAttemptIdentity` 先取影子快照树 A（`createWorkspaceSnapshot`），
  随后 `runValidationOnce` 对工作树再算内容指纹；若窗口内工作树已变为 B，指纹是 B、
  validator 读的也是 B，而 `commitVerifiedWorktreeTree` 最终提交的仍是快照树 A——
  「B 的通过证据提交 A」。`validationFromOperation`（有 opId 的生产主路径）只比指纹不比树。
- 修改（`server/loop/extension.ts`）：
  - `AttemptIdentity` 增加 `treeSha`；`captureAttemptIdentity` 冻结快照后解析并保存
    `snapshotSha^{tree}`；git 工作区（`isGitWorkspaceAt`）无法生成/读取冻结快照时抛错
    明确受阻，不再退化为不可检测漂移的验收；非 git 工作区维持原指纹语义。
  - `syncCurrentTreeSha`（影子 index、同步重建当前工作树 tree，不触碰真实 index）与
    `frozenContentMatches`：有冻结树时用「当前树 == 冻结树」判定，无冻结树的旧状态回退
    内容指纹。`evidenceStillValid` 复用同一判定。
  - `validationFromOperation`、`runValidationOnce` 执行后校验、`handleVerdict` reviewer
    返回后校验、`acceptRunValidatorOnly` 收下校验全部消费同一冻结身份。
  - 旧证据只有可证明绑定当前内容才复用（agent_end/loop_validate 复用路径同门禁），否则重验。
- 回归（`tests/unit/loop-frozen-content.test.ts`，真实 Git + worktree）：
  1. 验证窗口内 A→B（validator 记录实际读到的内容）：不判完成、不产生提交（分支 tip 树保持基线）、
     validator 读到的是 A、journal 含 workspace-changed-during-validation。
  2. 稳定快照：完成并提交，提交树中文件 blob == validator 实际读到的内容。
  3. git 工作区冻结快照失败（只读 gitdir）：stopped/runtime-error 明确受阻。
- 备注：reviewer 输入身份与最终提交树绑定同一次冻结；验证期间任何内容变化按现有流程进下一轮或等待重验。

## 2. P2 收下后协调 Git index

- 基线缺陷：自动/手动收下用 commit-tree + update-ref 推进分支后，真实 index 未动，
  旧 HEAD 与新 HEAD 之间出现「反向暂存差异」；用户 staged 内容也可能被后续提交撤销。
- 修改（`server/loop/extension.ts`，自动收下 `commitVerifiedWorktreeTree` 与手动收下
  `acceptRunValidatorOnly` 共用 `finalizeVerifiedCommit`）：
  1. 更新引用前校验预期旧 SHA：tip 不同且树不同 → 明确拒绝（不覆盖并发提交）；tip 树相同 → 幂等接续。
  2. 冲突预检：用户 staged 与「收下改动」同路径且内容不同 → 更新引用前拒绝，分支与 index 均不动。
  3. commit-tree + update-ref 提交已验证树（树相同则跳过提交）。
  4. index 协调：新 index = 收下树 + 用户额外 staged（相对收下前旧 HEAD 判定）；
     用户 unstaged 改动与工作树不动；真实 index 原子拷贝写入。中断后重入幂等
     （tip 树已等于收下树时只做 index 协调）。
- 回归（`tests/unit/loop-frozen-content.test.ts` 的 P2 部分，真实 Git）：
  干净暂存区、已有用户 staged（保留、无反向差异、后续提交不撤销收下内容）、
  同路径 staged+unstaged（冲突前置拒绝）、引用并发推进与同内容幂等重入。

## 3. P1 停止只取消目标回合，并核验退出

- 基线缺陷：`stopLoop` 找不到目标会话时 `?? conv` 回退到当前聊天；宿主重启后
  内存回合标记消失，可能仅因「没有标记」就确认停止。
- 修改：
  - `server/loop/extension.ts`：`LoopState.turnActive`（`{owner,since}`）持久回合在途证据，
    `before_agent_start` 置位、`agent_end` 清除（`clearPersistedTurnActive`）；
    `stopRunExternal` 无控制器时按持久证据判定：旧宿主进程已死 → 回合随宿主结束不计在途；
    旧宿主仍活 → 无法核验保持 stop-unconfirmed。取消只作用于该 run 注册的控制器（runId 隔离）。
  - `server/agent-service.ts` `stopLoop`：只对真正绑定本对话（含派生执行者）的会话注册控制器，
    不再回退到当前聊天。
- 回归（`tests/unit/loop-turn-stop-p4.test.ts` P3 部分）：
  旧宿主死 → 停止确认；旧宿主活 → 待确认、回合结束核对后确认；run 绑定其它会话 →
  当前聊天 interruptRun 零调用；绑定当前会话 → 取消目标回合且未确认（回合在途）。

## 4. P1 旧执行实体未核实前阻断续跑

- 基线缺陷：接管可成功且 `resumeEligible=true`，旧协议 taskPid 无 operation 时服务仍会
  投递续跑提示词；旧进程可能在未核实身份的情况下并行执行。
- 修改：
  - `server/loop/extension.ts`：`unverifiedLegacyEntities`（存活、无对应 operation 的
    legacyExecutionEntities 条目）与 `canResumeLoopDelivery` 导出门禁；
    `recoverRun` 接管成功后若存在未核实旧实体 → `blockedReason` + `resumeEligible=false`
    （控制权仍保留用于核对/停止）；stop 侧继续不向这些 PID 发信号。
  - `server/agent-service.ts` `resumeLoop` 投递前 `canResumeLoopDelivery` 门禁：
    自动与手动入口共用，阻断时只通知、不投递。
- 回归（`tests/unit/loop-turn-stop-p4.test.ts` P4 部分）：
  真实子进程仅旧 taskPid 跨宿主接管 → 证据保留、进程不误杀、resumeEligible=false、
  投递门禁 false；实体退出后恢复可续跑；PID 复用（存活即未核实）阻断；fake ClientSession
  的 `resumeLoop` 实际投递次数为零。

## 验证范围与剩余

- 全量 Vitest、typecheck、lint、协议 v40、双端构建、格式与 `git diff --check` 均通过；
  真实浏览器停止链（`loop-recovery-browser-stop-test.mjs --source --pending-stop`）通过；
  真实宿主跨进程恢复（`loop-core-restart.test.ts` 七模式）通过。
- 未覆盖：容器重建端到端（本机无 Docker）；Linux 实机；真实模型评审输入的内容绑定
  （reviewer 返回后的门禁已覆盖，评审输入的逐字内容仍以 diff 快照为界）。

## 5. 第二批·停止只取消「已注册且对应本回合」的实体

- 基线缺陷：控制器只在 startLoop/resumeLoop 注册一次且带随机 turnId；A 回合结束后同会话
  普通聊天 B 开始时，停止 A 会经旧控制器把 B 的回合一起取消；stopLoop 还会临时把控制器
  绑到当前聊天；回合结束事件不清理控制器。
- 修改（`server/loop/extension.ts`）：
  1. 投递登记 → 回合启动两段式：服务层/扩展投递 run 回合前 `markRunTurnDispatch`
     （持久「回合在途」证据含 turnId），`before_agent_start` 经 `beginLoopTurn` 消费登记
     并注册绑定本回合的控制器（abort 取消本运行时当前回合，turnEnded 只在可核验 idle 时
     判结束）；普通聊天回合无登记 → 不置位、不注册。
  2. `agent_end` 经 `endLoopTurnsForSession` 只清理属于本会话本回合的标记与控制器。
  3. 停止绑定发起时登记的回合（`stopTurnId`）：登记回合已更换 → 不取消新回合、不计在途；
     租约代次变化（接管）后旧控制器失效，无法核验的退出保持未确认。
  4. 投递被拒时 `unmarkRunTurnDispatch` 撤销登记，不留下虚假在途证据。
- 回归（`tests/unit/loop-turn-entity-batch2.test.ts`）：A 结束→同会话聊天 B 不被取消且停止
  立即确认；活跃 A 仍可取消；登记回合更换不取消新回合；跨会话结束事件互不清理；接管代次
  失效不取消且保持未确认。

## 6. 第二批·旧执行实体逐实体判定

- 基线缺陷：旧实现只要存在「当前 round/attempt 未消费 operation」就把全部旧实体视为已核实
  （`!pending` 一刀切）；同一 PID 或 PID 复用可解除门禁；运行中（无退出证据）也放行。
- 修改（`server/loop/extension.ts`）：
  1. `unverifiedLegacyEntities` 逐实体判定：PID + 宿主 + 进程启动身份 + 可信退出证据
     （result 已发布）全匹配才算核实；同 PID/PID 复用/缺身份/仍在运行都不能单独解除门禁。
  2. `pendingUnconsumedOp` 统一恢复观察与接续投递的「当前 round/attempt 未消费 operation」
     选择规则：观察仅消费一次，消费后不再被选中。
  3. `recoverRun` 允许在持权状态下观察在途实体（running + inFlightOpId）；投递门禁
     `canResumeLoopDelivery` 在无关旧实体未核实期间保持不放行。
- 回归（`tests/unit/loop-turn-entity-batch2.test.ts`）：旧 PID A 真实存活 + 独立 operation B
  （真实执行、可信退出证据）→ B 的退出证据只核实 B，A 未核实期间投递门禁不放行、A 退出后放行；
  同一实体（身份全匹配 + 退出证据）不双重阻断；startId 不符/仍在运行均阻断、退出证据落地后放行。

## 验证范围与剩余（Round 5 追加）

- 两批次分开提交：`f60bf61`（第一批：验收与Git收尾）、`bed48cd`（第二批：停止与旧实体续跑）；
  两提交合计与全量改动逐字节一致（`git apply --reverse --check` 核对）。
- 全量 Vitest 340 文件 3568 通过、typecheck、lint、协议 v40、双端构建、浏览器 pending-stop
  （10 项全过）、跨宿主恢复（loop-core-restart / loop-recovery-process / loop-running-takeover）通过。
- 未覆盖：容器重建端到端（本机无 Docker）；Linux 实机；窗口二整合（cluster A + import B +
  restart restore A 的组合回归）待 W2-HANDOFF.md 后执行。
