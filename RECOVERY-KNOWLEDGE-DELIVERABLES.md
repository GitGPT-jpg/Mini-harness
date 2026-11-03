# 交付说明：任务默认知识（A）+ 隔夜长任务恢复（B）

> 分支 `harness-cockpit`（HEAD `5050258`），知识源只读参照 infer-forge-harness master `04322f7`。
> 本轮只改 Mini-harness；未改动源仓库 infer-forge-harness（只读 clone `/tmp/ifh`）。

## 0. 结论一句话

A（默认知识）与 B（跨中断恢复）都交付了**可运行的纵向闭环**：
- A：3 个真实能力包 + 三层渐进加载 + 只读上下文发现，服务端注册表唯一事实源，`/packs`/`knowledge`/`references`/`discover` 接口与单测齐全；
- B：`recovery.ts` 提供租约/心跳/代次/环境指纹/恢复分类，`extension.ts` 落盘 attemptId/owner/generation/environmentFingerprint 并原子写 state，`/runs/:runId/recover` 显式按 run 恢复，单测覆盖接管/不接管/取消不复活/环境变化失效。

## 1. 来源与版本

| 仓库 | 版本 | 用途 | 结果 |
|---|---|---|---|
| infer-forge-harness | master `04322f7`（`/tmp/ifh` 浅 clone） | 知识源（只读） | 读取 `tasks/CATALOG.md`、`tasks/REGISTRY.yaml`、`tasks/sglang_prefill_perf_optimize/`、`tasks/decode_perf_service/`、`engine/journal.py`、`engine/recovery.py`、`engine/graph/*` |
| Mini-harness | `harness-cockpit` `5050258` | 落地仓 | 本轮所有代码改动 |
| Mini-harness `skills/cache-loss-optimization/SKILL.md` | 同上 | cache 损耗历史契约 | ITPS 比值损耗公式（见 §4.3） |

## 2. 复用 / 适配 / 不采用清单

| 项 | 处置 | 说明 |
|---|---|---|
| Pi kernel / chat / terminal / Skills / 任务台 / code Loop / LLM Loop | 直接复用 | 未引入第二套运行时 |
| 任务执行 / 验收 / 恢复接口（`extension.ts`、`metrics.ts`、`run-command.ts`） | 直接复用 + 薄适配 | `saveState` 改用既有 `writeJsonAtomicSync`（`atomic-file.ts`） |
| infer-forge `task.yaml`（perf-016 吞吐 / perf-021 就绪） | 薄适配为能力包 | 抽取验收契约与硬约束进 `packs.ts`，不复制其执行器 |
| infer-forge `engine/journal.py` / `graph/facts.py` / `recovery.py` 语义 | 知识参考 | 只借鉴「事实=(种类,主体,环境指纹)→产物」「重试=新 attempt」「恢复=先核对再重试」语义，不搬其 Python 运行时 |
| infer-forge cache 工作流（perf-028..032 / sglang-cache-loss-optimization.yaml） | 不迁移 | 当前 master `04322f7` **已不存在**该工作流/任务；损耗公式来自团队技能（历史契约），已在能力包 references 里显式标记「来源缺口」 |
| 团队/个人实验的路径/模型/pod/集群/脚本参数 | 不作为团队默认 | 只进 `history` 参考层，且历史不覆盖当前事实；冲突显式呈现 |
| 凭据 / 私有会话 | 不导入 | kubeconfig 等只作为用户输入传递，永不落库；环境指纹只取身份键、绝不哈希密钥 |

## 3. 能力包（A 交付物）

服务端唯一事实源：`pi-web-ui/server/loop/packs.ts`（`listCapabilityPacks`/`resolvePack`/`getPackKnowledge`/`listPackReferences`/`getPackReference`）。
三层加载：L1 轻量目录 → L2 被选中任务知识 → L3 按需参考；每条知识带 `provenance`（来源仓库/文件/版本/适用条件）。

### 3.1 能力包 1：推理性能优化 `inference-perf`（development / maximize）

- 来源：`tasks/sglang_prefill_perf_optimize/` @ `04322f7`（perf-016）。
- 必填输入：`pod`（目标 Pod）、`validateCmd`（真实 prefill 压测 `--validate` 命令）；`baseline` 由 discovery 发现（上一 run 的 reference_snapshot）。
- 指标契约：主指标 `input_throughput`（tokens/s，maximize）；硬约束 `span_regression<=0.02`、`tokens_parity>=1`、`acc_drop<=0.01`。
- 复用入口：`run.py`（一 boot 一 run）、`Script/measure_prefill.py`（aiakperf 权威采集）、`validate.py`（读 report 不重跑）。
- 独立验收：validator 输出 `HARNESS_METRIC` 四键（input_throughput/span_regression/tokens_parity/acc_drop），metric gate 分开判定 exit-0 与硬约束。
- 产物/证据：`baseline_trace.json`、`candidate_trace.json`、`signals.json`、`prefill_optimization.json`。

### 3.2 能力包 2：服务配置验证 `service-config-verify`（verification / 布尔，无主指标）

- 来源：`tasks/decode_perf_service/` @ `04322f7`（perf-021）。**执行特征不同于包 1**：布尔就绪验证，无数值指标。
- 必填输入：`kubeconfig`、`deploy_yaml`（manifest）；`namespace` 缺省取 manifest，不一致时拒绝。
- 通过判据：Pod Running + `/health` 200 + `/metrics` 有 `sglang:` series + 启动脚本 `--disaggregation-transfer-backend fake`、`--ep-dispatch-algorithm fake`、`SGLANG_TORCH_PROFILER_DIR` 齐全。
- 失败退出态显式：`health_timeout` / `apply_failed` / `flags_missing` / `metrics_missing` / `profiler_env_missing` / `model_id_unresolved`。
- 副作用边界：Pod 已存在绝不重 apply；只观察不重跑；profiler 目录必须已 live。

### 3.3 能力包 3（附）：缓存损耗 `cache-loss`（development / minimize）—— 口径修正

- 修正前的 reference validator 用的是 **错误公式** `loss_pct=(1-hits/accesses)*100`（miss rate）。
- 修正后：`loss_pct = (1 - ITPS_ascache,uncache / ITPS_disable-radix-cache,uncache) * 100`（ITPS 比值损耗），阈值 `<20`，场景 `ascache-on-vs-radix-off`；
  `cache_hit>=0.96`、`input_len>=81920`、`loss_std<=0.5` 是**独立硬约束**，`cache_hit` 不再参与 loss 计算。
- 单测断言 `lossM.loss_pct ≈ 8.0`（= (1-92000/100000)*100），而非命中率；并核对 `HARNESS_SCENARIO`。

## 4. 三层默认知识 + 上下文发现

`pi-web-ui/server/loop/discovery.ts`：`probeWorkspace`（只读扫描已知标记，不执行工作区文档）、`resolveTaskContext`（输入来源合并：user > discovery/project-config > pack-default，历史只参考不覆盖）、`renderDiscoverySummary`（「只问缺口」gap-only 摘要；冲突显式列出不静默选择）。

接口：`GET /api/mini-harness/packs/:id/knowledge`、`GET /api/mini-harness/packs/:id/references[/:refId]`、`POST /api/mini-harness/discover`。

## 5. 隔夜恢复设计（B 交付物）

`pi-web-ui/server/loop/recovery.ts`（纯函数 + 文件级租约原语）：

- **attempt**：run 内一次执行代次；重试分配新 attemptId，保留旧证据。
- **lease**（`<runDir>/lease.json`）：owner(`pid@host`) + pid + generation + startedAt/heartbeatAt + remoteJobId；
  写入后读回校验 owner+generation，保证两个实例/页面竞争时只有一个赢家；`LEASE_TTL_MS=30s`，心跳续租、过期可接管。
- **environmentFingerprint**：workspace + gitHead + packId/version + 规范化输入 hash + 身份环境变量 hash（绝不含密钥）。
- **classifyRecovery**：`completed-valid`(完成且证据有效→复用) / `running`(仍持权或本地/远端进程存活→重新跟踪不重启) / `failed-retryable`(明确失败→新 attempt) / `unknown`(结果未知→先查预期效果/证据，不盲目重跑) / `cancelled`(已停止→不复活)。

`extension.ts` 落盘：`attemptId`/`owner`/`generation`/`remoteJobId`/`environmentFingerprint`/`recoveryState`（`normalizeState` 向后兼容旧 state.json 缺字段）；`saveState` 改为 `writeJsonAtomicSync` 原子写；`createLoopRun` 建 run 即取租约，`stopRunExternal` 释放租约。

`routes.ts`：`/runs` brief 与 `/runs/:runId/detail` 携带 `recovery`（unit/leaseHeld/environmentChanged/attemptId/generation/owner/remoteJobId）；新增 `POST /api/mini-harness/runs/:runId/recover`（显式按 run 恢复，不按「同 cwd 最新」猜）。

### 5.1 各中断场景的处置（哪些自动续/复核/不可确认）

| 中断 | 处置 |
|---|---|
| 浏览器关闭/刷新 | 服务端会话仍在：run 状态在磁盘，刷新后 `/runs` 直接可见，无需重跑 |
| 网络重连 | 前端快照驱动，重连即重拉快照；run 不丢 |
| 服务重启/异常退出 | 旧租约 owner pid 失效 → 过期；`recoverRun` 接管（generation+1、新 attemptId），从缺失/失效部分继续 |
| 宿主机休眠/重启 | 同上：租约过期后接管；先核对环境指纹 |
| 模型请求中断 | run 状态仍在；续跑提示词只让模型「从上次中断处继续，不重复已完成步骤」 |
| 本地命令仍在跑 | `pidAlive=true` → 重新跟踪，不启动第二份 |
| 本地命令已退出 | `pidAlive=false` + 在途 → **结果未知**，先查证据，不盲目重跑 |
| 远端 job 仍在跑但本地断连 | `remoteJobId` 保留；**本地进程退出≠远端未执行**，先查远端预期效果再决定 |

> 明确不保证：跨中断的「恰好一次」副作用。设计是「记录意图+ID → 幂等化，否则 verify-then-retry」，只声称「不盲目重放」，不声称 exactly-once。

## 6. 代码变更与回归结果

变更：`packs.ts`(375 行重写)、`discovery.ts`(新)、`recovery.ts`(新)、`extension.ts`(+219)、`routes.ts`(+73)、`agent-service.ts`(+6，packId/packVersion 落库)、`TaskModal.tsx`(+8，主指标可空)、两个 reference validator 修正、`packs/*.json` 与 README 对齐。

回归（`pi-web-ui` 下执行，全部通过）：

```
npm run typecheck        # server + web + tests 三段 tsc 全绿
npm run lint            # oxlint 0 warning 0 error
npm run check:protocol  # types.ts 纯 re-export + PROTOCOL_VERSION v40 一致
npm run build           # build:web + build:server 成功
npx vitest run          # 3348 passed / 8 skipped
```

新增/更新单测：`loop-packs.test.ts`(3 包 + 修正后指标)、`loop-knowledge.test.ts`(6)、`loop-recovery.test.ts`(10)；`loop-status`(56)、`loop-cockpit-ui`(28)、`loop-resume-mutex`(1) 仍绿。

> 全量 `vitest run` 有 4 个**与本改动无关**的既有失败（`force-reset-session` / `permission-persistence`），原因是测试向真实家目录 `~/.pi/agent/sessions` 写文件被文件沙箱以 EPERM 拒绝；不在本轮改动范围。

## 7. 真实验证 vs 故障注入 vs 模拟 vs 未验证

| 类别 | 内容 | 状态 |
|---|---|---|
| 真实子进程 | reference validator `packs/inference-perf/validate.py`、`packs/cache-loss/validate.py` 实际 `python3` 跑出 `HARNESS_METRIC` 并被解析 | ✅ 实测（CPU 复现，非 GPU） |
| 真实临时目录/git | `loop-knowledge`/`loop-recovery` 用 `mkdtempSync` 真实建 run/租约/state.json | ✅ 实测 |
| 故障注入 | `loop-recovery`：删 lease 模拟崩溃、改 goal 模拟环境变化、他人持租约模拟多实例竞争 | ✅ 故障注入 |
| 模拟 | cache-loss/inference-perf reference validator 的「吞吐/损耗」是确定性代理值（文档已注明非真实 ASCache/GPU 采集） | ✅ 明确标注为模拟 |
| 真实集群 | 真实 GPU 压测、真实 kubeconfig 集群就绪验证、真实隔夜跨进程恢复 | ⛔ 未验证（本仓无集群/无 GPU；禁止伪造通过） |

## 8. 远端恢复边界（不保证项）

- 无法从「本地进程没了」推出「远端 job 没跑」；`remoteJobId` 保留，恢复时先查远端预期效果/证据。
- 跨进程/跨实例的租约竞争用「写后读回校验」保证只有一个赢家；但两个实例在极端时钟偏移下的心跳判定无强一致保证。
- 不保证 exactly-once；side-effecting 操作记录意图+ID，幂等化优先，否则 verify-then-retry。
- 服务重启后**不会自动**提升鉴权/权限；恢复沿用重启前的用户上下文。

## 9. 同事可用的启动 + 恢复 Runbook

```bash
# 启动（源码，默认后端 8788 / Vite 5173；勿占用已运行的 8787）
cd pi-web-ui && npm run dev

# 拉能力包目录（选任务）
curl -s localhost:8788/api/mini-harness/packs
# 选中的任务知识（第二层）
curl -s localhost:8788/api/mini-harness/packs/inference-perf/knowledge
# 按需参考（第三层）
curl -s localhost:8788/api/mini-harness/packs/cache-loss/references

# 只读上下文发现（只问缺口）
curl -s -X POST localhost:8788/api/mini-harness/discover \
  -H 'content-type: application/json' \
  -d '{"packId":"cache-loss","workspace":"/path/to/repo","inputs":{}}'

# 列 run（每个 run 带 recovery 字段：unit/leaseHeld/environmentChanged）
curl -s 'localhost:8788/api/mini-harness/runs?history=1'

# 显式恢复某个 run（失联才接管；已取消不复活；他人持权不接管）
curl -s -X POST localhost:8788/api/mini-harness/runs/<runId>/recover
```

**恢复决策速查**：
1. `recovery.unit=running`（租约仍有效）→ 重新跟踪即可，不要点第二份。
2. `interrupted`（active 但租约过期、环境未变）→ `POST .../recover` 接管，从缺失部分继续。
3. `needs-review`（环境/代码已变）→ 先人工核对旧证据是否仍适用，再决定续跑或重定范围。
4. `cancelled`（stopped）→ 保持终态；如需重来，另起新 run。
5. 在途执行结果未知（本地进程不在、远端 job 仍在）→ 先查 `remoteJobId` 对应证据，不盲目重跑。

## 10. 已知后续（未在本轮做）

- 任务台 `TaskDesk.tsx` 尚未把 `recovery.unit` 渲染成彩色状态徽标（数据已在下发 payload，前端可直接接）；
- 租约心跳目前未由服务端定时器主动续租（`heartbeat` 原语已实现，接线即可）；
- 真实 GPU/集群的端到端能力包与真实隔夜跨进程恢复需在推理侧集群验证（本仓无法离线复现）。
