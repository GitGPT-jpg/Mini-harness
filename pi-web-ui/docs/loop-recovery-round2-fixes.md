# 恢复闭环第二轮：六项修复执行记录

基线：`harness-cockpit@bcbc11acf93cc41a6624caf1307b10c2d207ad03`（PR #1 源分支）。
本轮只做六项修复及对应回归；未调用真实模型/集群，未触碰 8787，未重启日常服务。

## 1. P1 验收结果、评审与最终提交绑定同一份代码

- 根因：`runValidationOnce` / `agent_end` / `recordValidationOutcome` 三处复用 `validatedRound === round` 时只认 `lastVerdict`，不核对执行内容身份；reviewer 返回后、`git add -A` 提交前都没有内容核对，模型在消费后/评审期间的改动可以被旧 pass 通过并带进提交。
- 修改：
  - 新增 `evidenceStillValid(st)`：`validationIdentity` 必须对应当前 round/attempt，且指纹（含 FINGERPRINT_VERSION、工作树与 index 内容）与当前实际内容一致；指纹受阻视为不能复用。
  - 三个复用入口都先过 `evidenceStillValid`；不通过则走正常验证路径重新执行。
  - `handleVerdict`：reviewer 返回后再次核对证据，漂移 → `workspace-changed-during-review` 进入下一轮（旧结果保留历史），不判完成、不提交。
  - 最终提交：`commitVerifiedWorktreeTree` 用验收绑定的不可变快照树（`validationIdentity.snapshotSha^{tree}`）经 `commit-tree` + `update-ref` 提交到 worktree 分支，不再 `git add -A` 当前工作树；提交前再次核对证据，核对后的并发改动不会进入提交。无预存快照时才退化为原有 add+commit（仅存在于无法生成快照的工作区）。
  - `acceptRunValidatorOnly`（按代码验证收下）同样要求证据仍有效，并在快照树可用时提交该树；租约/状态每步核对，saveState 失败会抛错，入口统一转成 `ok:false`（本轮发现上轮推送到 PR 的版本缺失了收下围栏与启动迁移，一并恢复）。
- 回归：`tests/unit/loop-evidence-binding.test.ts`（4 项，真实临时 Git 仓库）：
  1. 消费成功后改代码 → agent_end：旧 pass 不通过新版本，进入下一轮且重新验证失败（lastVerdict=fail）。
  2. reviewer 等待期间改代码：旧结论不让新版本通过，无新提交产生。
  3. 提交只包含验收绑定的不可变树：提交后的并发改动不在提交里。
  4. 同一未变快照：agent_end 复用既有结果，不重复消费。

## 2. P1 指纹纳入 build/、dist/ 等目录下的已跟踪源码

- 根因：产物目录排除同时作用于已跟踪文件，修改并重新暂存 `build/code.py` 指纹不变。
- 修改：`fingerprint.ts` 已跟踪内容默认纳入（敏感路径仍排除），产物目录排除只作用于未跟踪文件（`ls-files --others`）；index 身份覆盖已跟踪增删/重暂存；`FINGERPRINT_VERSION = 2` 进入 contentHash 组合——算法变化使旧证据无法对等证明等价，自动触发重新验证（任务与历史保留）。
- 回归：`tests/unit/loop-fingerprint-tracked.test.ts`（2 项）：已跟踪 build/dist 修改/暂存/删除均改变指纹，未跟踪产物仍排除；恢复入口识别环境变化并拒绝复用旧证据。

## 3. P1 停止必须覆盖 run 绑定的 Pi 回合及实际执行实体

- 根因：Pi 在模型回合/工具调用中时（尚无 validator operation），stop 入口直接写 `stopConfirmedAt`，原回合继续运行。
- 修改：
  - `extension.ts` 新增回合控制器注册表 `registerRunTurnController`（服务层注册 abort 与可核验的 turnEnded），并在 `before_agent_start`/`agent_end` 维护回合在途标记兜底。
  - `stopRunExternal`：先持久化停止意图（epoch+1 阻止新调度），再取消绑定会话回合（abort）+ 取消持久 operation；只有 `cancellation.allConfirmed && 无未核实实体 && 回合已结束` 才写 `stopConfirmedAt`，否则保持 `stopping/stop-unconfirmed`。重复 stop 幂等；回合控制器按 runId 隔离，不误停其他 run。
  - `agent-service.ts`：`stopLoop`/`startLoop`/`resumeLoop`/worktree 执行者在回合投递前注册控制器（`interruptRun` 含会话 abort 与卡死强制重置）。
- 回归：`tests/unit/loop-stop-turn.test.ts`（回合在途只受理不确认 → 回合结束后核对确认；两 run 隔离）；原「模型准备期间被停止」用例改为新语义（受理→回合结束→核对确认）。

## 4. P2 接管时保留旧执行实体证据

- 根因：接管替换 lease 时丢掉旧 `taskPid`；旧协议 run（无 operation）在停止时被误判已退出。
- 修改：`acquireRunControl` 接管分支在锁内把旧 lease 的 `taskPid/host/startId/generation` 追加进 `state.legacyExecutionEntities`（去重、最多 8 条）。`stopRunExternal` 把「存活的、无对应 operation 的历史实体」计入未核实实体：不向该 PID 发信号、不确认已停，只保留核对线索；恢复分类不再把仅含旧 taskPid 的 run 当在途（不阻止接管）。
- 回归：`tests/unit/loop-stop-turn.test.ts`（真实子进程、旧租约仅 taskPid → 接管保留证据 → 停止未确认且进程未被误杀 → 实体退出后核对确认）。

## 5. P2 按当前 round/attempt 判断恢复动作

- 根因：上一轮 validator pass 但 reviewer/指标门禁否决后，新一轮已落盘、尚无 operation 时重启，恢复分类拿上一轮 `lastVerdict=pass` 误判 unknown，拒绝接续。
- 修改：`recoverRun` 分类输入改为 `lastRoundPassed = validatedRound === round && lastVerdict === "pass"`（只认当前轮）；在途判定只认当前 round/attempt 的未消费 operation。
- 回归：`tests/unit/loop-core-restart.test.ts` 新增两种真实宿主模式（reviewer 否决转轮 / 指标门禁否决转轮）：第 2 轮落盘后、首次执行前 SIGKILL A → B 分类 `failed-retryable` 并接管 → 接续当前轮，每个 round 各验证一次（启动计数 2、history 2），不重放第 1 轮、不跳过第 2 轮。

## 6. P1 修复默认 Docker Compose 的 Loop 存储路径和错误提示

- 根因：默认 Compose 未设 `MINI_HARNESS_RUNTIME_ROOT`，默认值 `~/.mini-harness/runs` 在容器内落在 OverlayFS 可写层（存储门禁拒绝，且容器重建即丢）；错误入口可能把存储问题误报成租约问题。
- 修改：
  - `docker-compose.yml`：`MINI_HARNESS_RUNTIME_ROOT=/app/.pi-web/loop-runs`（持久卷内），注释说明显式覆盖与旧路径迁移。
  - `Dockerfile`：以 node 用户运行前 `mkdir -p /app/.pi-web && chown node:node /app/.pi-web`，空命名卷初始化时属主正确。
  - 存储门禁保持不变：拓扑/权限/IO 与真实租约竞争的错误信息各自明确（`checkStorageTopology` 报「存储拓扑」，不冒充租约占用）。
- 回归：`tests/unit/loop-docker-compose.test.ts`（3 项：compose 配置解析、Dockerfile 挂载点属主、门禁错误信息区分）。本机无 Docker（`docker info` 不可用），容器端到端（真实镜像 + 重建容器保留 run）未执行，明确标记为待验证。

## 基线修复说明

本轮开工核对发现上一轮推送到 PR 源分支的 `bcbc11a` 缺失三处实现（`migrateMissingLoopStates`、有界 `listRuns`、收下围栏），导致该提交 typecheck/相关测试失败；本轮一并恢复并纳入回归（`loop-recovery.test.ts`、`loop-extension.test.ts`），不再作为「既有限制」处理。

## 复现

```sh
npx vitest run tests/unit/loop-evidence-binding.test.ts \
  tests/unit/loop-fingerprint-tracked.test.ts \
  tests/unit/loop-stop-turn.test.ts \
  tests/unit/loop-core-restart.test.ts \
  tests/unit/loop-docker-compose.test.ts
```

真实跨进程（独立宿主 A/B + HTTP + 真实命令 + append-only 启动计数）见 `loop-core-restart.test.ts`。证据目录为 `/var/folders/gt/c5kp4lp9485309mfts8h66r80000gn/T/loop-core-restart-*/evidence.json`。

## 剩余风险

- 容器端到端未验证（本机无 Docker）；Linux 分支未实机验证。
- 旧协议执行实体（仅 taskPid）身份未核实时不自动信号、不自动重放；残留风险为接管后人工继续执行可能与旧进程并行，需人工核对。
- 退化提交路径（无法生成快照的工作区）仍为 add+commit 序列，仅在非 git 快照失败场景存在；git 工作区的正常提交已改为提交已验证树。
- 外部 reviewer exactly-once、主动逃逸进程组、NFS/多宿主共享仍不在保证范围。
