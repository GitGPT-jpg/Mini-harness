# Mini-harness A/B 双链路交付报告

> 仓库：`GitGPT-jpg/Mini-harness`，分支 `harness-cockpit`，基线 `e5105490ba599df58680f1e714fab0d59603e4e4`。
> 本轮在 HEAD `0bf80ea`（上轮「最小实现」）之上完成 A 链（发现→缺口→知识→执行）与 B 链（中断→恢复→唯一执行者→继续）的真实接线，并补齐/修复验证。

---

## 1. 起始提交 / 最终代码状态 / 实际变更

- **起始（基线）**：`e5105490ba599df58680f1e714fab0d59603e4e4`
- **上一轮交付 HEAD**：`0bf80ea`（`luno-5578 feat(harness-loop): 三层任务默认知识 + 隔夜长任务持久化/恢复最小实现`）
- **本轮最终代码状态**：工作区未提交（相对 `0bf80ea` 有未提交变更），全部改动已通过下述 6 项校验。
- **实际变更规模**（相对基线，服务端 + 前端 + 测试）：

| 区域 | 文件 | 变更 |
|---|---|---|
| 服务端链路 | `server/loop/discovery.ts` | +58（`resolveTaskContext` 区分「未知包/工作区不存在」error，`discoverInputValue` 真读 manifest 取 namespace，`probeWorkspace` 扫 deploy 清单） |
| 服务端链路 | `server/loop/extension.ts` | +360（`loopExec` 生产用 `runCommand` 进程组执行器 + `onSpawn→recordTaskPid` 真实 pid 记录，`recoverRun` 重写为分类/接管/唯一执行者，`createLoopRun` 加租约+心跳） |
| 服务端链路 | `server/loop/recovery.ts` | +87（租约心跳、原子接管、`classifyRecovery`、`buildRecoverySummary`） |
| 服务端链路 | `server/loop/run-command.ts` | +11（`RunCommandResult.pid`、`RunCommandOptions.onSpawn`，进程组执行器补 pid 暴露） |
| 服务端接线 | `server/agent-service.ts` | +74（`startLoop` 发现+注入知识+传 cwd；`resumeLoop` 先 `recoverRun`、拒绝不可续、接管后重载、注入恢复摘要） |
| 服务端接线 | `server/dispatch-domain-handlers.ts` / `index.ts` / `protocol.ts` | 各 +8/+8/+4（`loop_start_request` 透传 `workspace/inputs/metric*`/硬约束字段） |
| 服务端接线 | `server/loop/routes.ts` | +4（`/discover` 404 带 error/context/summary） |
| 前端 | `web/src/components/TaskModal.tsx` | +86（项目位置输入、自动发现、缺失输入动态表单、启动透传） |
| 前端 | `web/src/components/TaskDesk.tsx` / `loop-status.ts` / `i18n.tsx` / `styles.css` | 恢复徽章 + 发现摘要样式 + zh/en 文案 |
| 测试 | 新增 `tests/unit/loop-recovery-process.test.ts`、`tests/unit/loop-bestround-gate.test.ts`、`tests/fixtures/lease-contender.ts`；扩展 `loop-knowledge`/`loop-status`；修复 `permission-persistence`、`force-reset-session` 隔离 | — |

---

## 2. 知识链路（A）证据：用户填位置与目标 → 自动发现 → 只问缺口 → 加载知识 → 执行

**接线（非纯接口，全部挂到真实任务入口）：**

1. **入口**：`TaskModal` 新增「项目位置」输入；选中能力包后 300ms 防抖调 `mhPost("discover", {packId, workspace, inputs})`（只读探测，不跑命令）。
2. **服务端发现**：`/api/mini-harness/discover` → `resolveTaskContext(packId, workspace, inputs)`：
   - 未知包 → `error:"未知能力包：<id>"`；工作区不存在 → `error:"工作区不存在：<path>"`（**不再静默启动**，`startLoop` 收到 `ctx.error` 直接 `request-failed`）。
   - 已满足的输入 → `"confirmed"`（`deploy_yaml` 循环真实 deploy 清单、`namespace` 真实读 manifest `namespace:` 字段，而非写死「取自 manifest」）。
   - 缺失 → `missing`，前端按 `pack.inputs` 动态渲染输入框（**只问缺口**）。
3. **知识注入**：`startLoop` 在真正执行前把 `<mini_harness_pack_knowledge>`（指标契约 / 硬约束 / 证据产物）与 `<mini_harness_discovery>`（确认/缺失/冲突摘要）写入执行提示词 `lines`，并把 `cwd: workspace` 传给 `createLoopRun`。
4. **执行**：`loop_start_request → dispatch-domain-handlers → ClientSession.startLoop → createLoopRun → before_agent_start 注入 stateBlock → validator（生产走 `runCommand`）→ reviewer（开启评审时）。

**证据（源码审查 + 单测）：**

- `tests/unit/loop-knowledge.test.ts`：deploy 清单发现 + `metadata.namespace` 解析出 `prod-infer`、顶层 `decode.yaml` 解析出 `radix-cache`、未知包/缺工作区 error。
- `tests/unit/loop-cockpit-ui.test.ts`（28 项全过）：模板一键填充只发语义字段、不注入命令/产物路径；开始键在「做什么」缺失时置灰。
- `server/loop/discovery.ts` + `server/agent-service.ts` 逐行核对：`resolveTaskContext` error 分支、`discoveryLines` 拼接、`pack_knowledge` 注入均在 `createLoopRun` 之前。

---

## 3. 恢复链路（B）证据：中断 → 服务恢复 → 核对现场 → 唯一执行者接管 → 正确继续

**接线（真实恢复流程）：**

1. **持久化现场**：`~/.mini-harness/runs/<runId>/`（`state.json` + `journal.jsonl` + `lease.json`）；根目录可经 `MINI_HARNESS_RUNTIME_ROOT` 覆盖。
2. **唯一执行者**：`lease.json` 记录 `owner`/`generation`/`pid`(服务进程)/`taskPid`(真实执行实体)/`heartbeatAt`；`createLoopRun` 建租约并启动 5s 心跳；接管用 `acquireLease`（`wx` 原子创建 + rename 替换）保证 `generation+1` 单调、失败即拒绝。
3. **真实执行实体 pid**：生产 `runValidation` 经 `loopExec→runCommand`，`onSpawn` 回调 `recordTaskPid(st.runId, pid)` 写入 `lease.taskPid`，执行完清零；**taskPid 是 validator/precheck 子进程组 pid，与租约里的服务 `pid` 严格区分**。
4. **核对现场**：`recoverRun` 载入 state → 读租约 → 算环境指纹 → `isPidAlive(taskPid)` → `classifyRecovery(leaseHeld, environmentChanged, pidAlive, lastRoundPassed, inFlight)` → 分类 `completed-valid / running / failed-retryable / unknown / cancelled`。
5. **继续**：`resumeLoop` 先 `recoverRun`；`resumeEligible=false` → `emitNotice` 警告并**拒绝**；`takeover=true` → 重载 fresh state；把 `recovery.summary` + 「不要重复已完成步骤/不要重复启动有副作用或昂贵的操作」注入续跑提示词。
6. **不盲目重放副作用**：`unknown`（进程失联但可能仍活）/ 环境变化 / 他人持权 / 已取消 → **不接管**，`blockedReason` 写明「先核对证据」。

**证据（单测 + 故障注入 + 真实跨进程）：**

- `tests/unit/loop-recovery-process.test.ts`（真实跨进程 3 项）：
  - 2 个真实 `tsx` 子进程竞争同一租约 → **恰好一个 WIN**；
  - 持权租约不被抢占；过期后 `acquireLease` 接管成功且 `releaseLease` 有守卫；
  - 真实 detached `sleep 30` 子进程 → `pidAlive=true` → `classifyRecovery="running"`；`process.kill(-pid, SIGKILL)` 杀整组 → `"unknown"`（`needRecheck:true`）。
- `tests/unit/loop-bestround-gate.test.ts`（5 项）：reviewer block 不进 `bestRound`、pass 才进、非法阈值/算子/硬约束字段在 `createLoopRun` 被拒绝并报字段名。
- `tests/unit/loop-cancel.test.ts`（已存在，仍绿）：真实 `runCommand` 进程组在 `stopRunExternal` 时 `SIGKILL` 整个 validator 进程组、状态保持 `stopped`、`stopConfirmedAt` 落地、轮次不推进。

---

## 4. 所有权机制 + 支持拓扑

- **单写者**：租约 `owner` 唯一；`acquireLease` 用 `wx` + `rename` 原子替换，任何进程拿到即 `generation+1`，旧代次（含心跳、迟到回调）按 `epoch`/`generation` 双重失效。
- **心跳**：持有者每 5s 续租（`heartbeatAt`），TTL 30s；`process.once("exit")` 停全部心跳。
- **拓扑**：`TaskModal/TaskDesk(web)` → `loop_start_request/loop_resume(ws)` → `dispatch-domain-handlers` → `agent-service.ClientSession` → `loop/extension.ts`（状态机+租约+心跳）→ `loop/recovery.ts`（租约原语）+ `loop/run-command.ts`（进程组执行器）→ `~/.mini-harness/runs/` 持久化。执行者会话（worktree 子代理）与主对话分离，续跑提示词投递到 `loopExecutorConv`，`loopResuming` 互斥 + `await` 投递落定避免双投递。

---

## 5. 每项测试命令 / 结果 / 日志 / 跳过

全部在 `pi-web-ui` 目录执行。

| 命令 | 结果 | 备注 |
|---|---|---|
| `npm run typecheck` | ✅ PASS（server + web + tests 三份 tsc） | — |
| `npm run check:protocol` | ✅ PASS（协议有改动且已 bump，`PROTOCOL_VERSION` 有 diff） | — |
| `npm run lint` | ✅ 0 warnings / 0 errors | 修复了 `extension.ts:145` 的 `unicorn(no-useless-spread)` |
| `npm run build` | ✅ PASS（web vite + `tsc -p tsconfig.server.json`） | chunk>500kB 为既有 warning，非错误 |
| `npm test`（`npx vitest run`） | ✅ **318 files / 3366 passed / 8 skipped** | 0 失败 |
| `npm run i18n:sync` | ✅ PASS（12 locales，+8 键 zh/en 同步） | — |
| `npm run test:smoke` | ⏭️ **未运行** | 需真实服务+浏览器，本轮未启动（见 §6） |

**关于此前上报的 4 个全量失败**：已查明为 **测试隔离问题，非产品缺陷**——`permission-persistence.test.ts`(3) + `force-reset-session.test.ts`(1) 均因 `SessionManager.create` 写真实 `~/.pi/agent/sessions/` 触发沙箱 `EPERM`。修复方式：`beforeEach` 注入 `process.env.PI_CODING_AGENT_DIR = <临时目录>`，`afterEach` 清理并还原（**合法的测试隔离修复，未删断言、未放宽断言、未吞异常**）。修复后 5/5 通过。

---

## 6. 证据类型区分（诚实标注）

| 证据类型 | 覆盖内容 | 状态 |
|---|---|---|
| **源码审查** | 发现/知识注入、恢复分类/接管、续跑提示词、UI 渲染、协议字段透传 | ✅ 已做（§2/§3 逐行核对） |
| **单元测试（mock）** | 状态机/门禁/非法约束拒绝/UI(jsdom)/知识解析/恢复徽章 | ✅ 318 文件全绿 |
| **故障注入** | reviewer block 不升 bestRound；L0 预检期间停止短路；停止杀进程组后 validator 迟到回调被丢弃 | ✅ loop-bestround-gate / loop-extension 回归#7 / loop-cancel |
| **真实跨进程** | 双进程租约竞争（单赢家）、过期接管、真实子进程 pidAlive→classifyRecovery、SIGKILL 进程组 | ✅ loop-recovery-process（3 项，真实 spawn） |
| **真实本地执行** | 生产 `runValidation` 走 `runCommand` 进程组执行器 + `recordTaskPid` 真实 pid 记录；loop-cancel 真实 `sleep 300` validator 被进程组杀掉 | ✅ 单测内真实 spawn 验证 |
| **浏览器（真实 E2E）** | TaskModal 发现表单、TaskDesk 恢复徽章在真实浏览器渲染 | ⚠️ **未验证**（仅 jsdom/RTL 覆盖，未跑 Playwright/test:smoke） |
| **真实模型** | planner/reviewer/executor 的真实 LLM 调用、真实续跑一轮 | ⚠️ **未验证**（离线，无模型额度；所有模型调用为 mock） |
| **真实集群/GPU** | k8s/kubectl/curl 对真实集群的能力包验证 | ⚠️ **未验证**（离线无法访问集群） |

> 结论：**不声称「全量全绿」**。单元/跨进程/故障注入/真实本地执行已绿；真实浏览器、真实模型、真实集群三项为「已实现未验证」，见 §8。

---

## 7. 用户操作示例

1. 任务台点「新任务」→ 填「做什么」（如「降低推理延迟 loss_pct 到 20 以内」）。
2. 填「项目位置」（如 `/path/to/workspace`）。
3. 选能力包（如 `inference-perf`）→ 弹窗自动发现：已确认项打 ✓，缺失项（如 `kubeconfig`/`deploy_yaml`）只问缺口。
4. 补缺失输入 → 「开始」→ `loop_start_request` 携带 `workspace/inputs/metric*`。
5. 服务端解析上下文 → 注入包知识与发现摘要 → 建租约/心跳 → 执行者开始改代码。
6. 每轮 `loop_done` 自动跑 validator（生产为进程组执行器并记录真实 pid）；开启评审时 reviewer 把关，block 不进 bestRound。
7. 若长任务中断 → 服务重启后点「继续/重试」→ `recoverRun` 核对现场 → 唯一执行者接管（`generation+1`）→ 续跑提示词带恢复摘要 → 从断点继续，不重复已完成/昂贵/有副作用步骤。

---

## 8. 已完成 / 已实现未验证 / 未完成

**✅ 已完成（实现 + 验证）**

- A 链：项目位置+目标 → 自动发现（真读 manifest/deploy）→ 只问缺口 → 注入包知识 → 真实执行入口接线。
- B 链：租约/心跳/原子接管 → `recordTaskPid` 真实 pid 记录 → `recoverRun` 分类 → `resumeLoop` 拒绝/接管/续跑提示词接线。
- 唯一执行者：双进程竞争单赢家（真实跨进程验证）、`generation`/`epoch` 不互相绕过。
- 测试隔离修复：`permission-persistence` + `force-reset-session`（EPERM→`PI_CODING_AGENT_DIR`）。
- 全量 `npm test` 318 文件 3366 通过 8 跳过；typecheck/lint/build/protocol/i18n 全过。

**⚠️ 已实现未验证（诚实标注）**

- 真实浏览器渲染（TaskModal 发现、TaskDesk 徽章）——仅 jsdom 覆盖。
- 真实模型执行（planner/reviewer/executor 及真实续跑一轮）。
- 真实集群/GPU 能力包验证（`service-config-verify`/`inference-perf` 对真实 k8s/推理服务的校验）。

**❌ 未完成 / 遗留**

- 上轮 `RECOVERY-KNOWLEDGE-DELIVERABLES.md` 中仍标「known not-yet-done」的个别项需复核（本轮已解决其中：恢复链路接线、任务 pid 记录、前端发现/徽章、测试隔离）。
- 工作区变更未提交（`git commit` 未做）。

---

## 9. 剩余问题 + 下一步优先级

1. **提交**：`git commit` 本轮全部改动（含 2 个新测试文件 + `tests/fixtures/`）。
2. **浏览器验证**：`npm run test:smoke` / Playwright，人工核对 TaskModal 发现表单与 TaskDesk 恢复徽章在 `http://127.0.0.1:54763` 的真实渲染（当前仅 jsdom 覆盖）。
3. **真实模型验证**：接入真实 planner/reviewer/executor 模型，跑一条端到端 loop（含一次人为中断→恢复）验证续跑提示词与恢复摘要。
4. **真实集群验证**：在可访问 k8s/推理服务的环境跑 `service-config-verify`/`inference-perf` 的完整 discovery→执行→验收。
5. **可选清理**：`loop-cancel.test.ts` 中 `pi.exec` mock 现已不再被 validator 路径消费（validator 走 `loopExec→runCommand`），可简化该 mock 语义注释；`setLoopExecForTest` 是模块级全局，跨测试文件由 vitest 每文件独立 worker 隔离，暂无污染，但如需同文件多实例并行可改为 per-run 注入。
