---
name: prefill-optimization
description: 基于 infer-forge-harness 的 prefill 性能优化工作流（prefill-optimization）。覆盖双路并存闭环（sglang-prefill-perf-campaign.yaml）、框架侧闭环（sglang-prefill-framework-opt.yaml）、算子侧闭环（sglang-prefill-operator-opt.yaml）与单节点压测（perf-test-graph-prefill.yaml），优化 sglang 推理服务 prefill 吞吐与 TTFT。
---

# Prefill 性能优化工作流

对应 `infer-forge-harness` 中的 SGLang Prefill 性能优化工作流族，优化典型上下文长度（如 60K / 80K）下的 Prefill 吞吐与 TTFT，并严格守住输出 token / top-k logits 精度一致。

## 一、可用 Workflow 矩阵（按场景选择）

| Workflow 文件 | 适用场景 | 节点链路概览 |
|---|---|---|
| `workflows/sglang-prefill-perf-campaign.yaml` | **算子桥 + 框架层双路并存闭环**（推荐全量优化） | `kdp-002` (部署) → `perf-017` (压测基线) → `perf-018` (抓 trace) → `perf-019` (分析排序) → `ops-004` (XSpeedGate 算子桥) → `perf-016` (框架层插件/环境变量优化) → `perf-021` (门禁路由) → `perf-023` (汇总报告) |
| `workflows/sglang-prefill-framework-opt.yaml` | **纯框架侧优化闭环**（只改 `sglang-kunlun` 插件与环境变量，不碰算子） | `kdp-002` → `perf-018` → `perf-019` → `perf-016` → `perf-021` (未收敛回环 `perf-018`) → `mat-001` → `mat-013` (端到端精度校验，失败走 `acc-001`→`acc-002`) → `perf-017` → `perf-022` (自动提交/回滚) |
| `workflows/sglang-prefill-operator-opt.yaml` | **纯 XSpeedGate 算子侧优化闭环**（选靶、生成/复用、Roofline 估算、Pod 内编译安装 wheel） | `kdp-002` → `perf-018` → `perf-019` → `ops-005` (选靶) → `obs-001` (shape dump) → `ops-001` (生成/复用算子) → `ops-003` (Roofline 估算) → `ops-004` (编译安装复测) → `perf-021` → `mat-001` → `mat-013` → `perf-017` → `perf-022` |
| `workflows/perf-test-graph-prefill.yaml` | **单节点 Prefill 网格压测**（TP × Chunk × CtxLen 或 QPS/SLO 扫描） | `perf-017-perf-test-graph-prefill` (`tasks/perf_test_graph_prefill/task.yaml`) |
| `workflows/b200-prefill-optimization.yaml` / `workflows/pro6000-prefill-optimization.yaml` | **GPU 单 Pod 交互式 LLM Driver 优化会话** | `kdp-001c` / `kdp-001d` (8 卡空闲环境证明) → `perf-015` / `perf-015b` (LLM driver 按轮优化，每轮镜像提交到 `src/` 供 `git log -p` 审查) |

---

## 二、核心原子任务与 Journal 事实契约

在 `sglang-prefill-perf-campaign.yaml` 中，各节点通过 `Journal` 事实（Fact）严格串联：

1. **Step 0 部署或复用（`kdp-002-sglang-pd-deploy` → 产出 `PDServiceProof`）**：
   - 新部署单 Prefill 待命 Pod：`--set mode=perf --set perf_role=prefill --set sleep_entry=true`
   - **复用已有运行中 Pod**：用 `--from-node perf-017-perf-test-graph-prefill --set pod_name=<existing-pod>`（或在 `framework-opt` / `operator-opt` 中 `--from-node perf-018-sglang-torch-profile --set pod_name=<existing-pod>`）跳过部署节点。
2. **Step 1 建立压测基线（`perf-017-perf-test-graph-prefill` → 产出 `PrefillPerfSweepReport`）**：
   - 在典型数据长度（如 60K）下扫描 TP × Chunk × CtxLen 网格，记录种子吞吐（seed throughput）与 `perf_summary_aggregate.csv`。
   - 常用参数：`--set perf_mode=throughput --set access_mode=k8s --set keep_engine_alive=true --set force=true`。
3. **Step 2 抓取性能 Trace（`perf-018-sglang-torch-profile` → 产出 `PrefillPerfTrace`）**：
   - 对运行中的 Prefill 引擎抓取有界窗口的 PyTorch Profiler / `aiakperf` trace，校验每个 rank 的 `.gz` trace 并生成 `trace_manifest.json`（可选配 `--set bos_ak=<AK> --set bos_sk=<SK>` 自动同步至 BOS）。
4. **Step 3 折叠算子表与瓶颈排序（`perf-019-sglang-prefill-report` → 产出 `PrefillPerfReport`）**：
   - 将所有 rank 的 trace 折叠为统一算子表 + 计算/通信/访存分桶，与原始 trace 自检统计一致性，按耗时排序输出 `targets.json`。
5. **Step 4 & 5 双路并存优化**：
   - **算子桥路（`ops-004-xpu-operator-prefill-opt` → 产出 `PrefillOperatorOptimizationReport`）**：将重度 kernel 映射到 `XSpeedGate` 算子（复用已有源码或调用 `ops-001`/`ops-002` 生成优化），在 Pod 内编译安装 wheel 并重启引擎复测，维护独立的算子侧累积账本（`--set ops-004-xpu-operator-prefill-opt:progress=<operator_ledger.json>`）。
   - **框架优化路（`perf-016-sglang-prefill-perf-optimize` → 产出 `PrefillPerfOptimizationReport`）**：针对 host↔device 同步 bubble 或框架瓶颈叠加插件与环境变量，单次重启复测，自检三项硬门禁：**① 目标算子/间隙耗时下降 ② 端到端吞吐不回退 ③ greedy tokens 字节级完全一致（byte-identical）**，维护框架侧累积账本（`--set perf-016-sglang-prefill-perf-optimize:progress=<framework_ledger.json>`）。
6. **Step 6 门禁路由与循环控制（`perf-021-sglang-prefill-gate`）**：
   - 读取累积账本，若所有路径已达标（`cumulative_ratio >= target_ratio`）或候选靶点已穷尽，进入汇总/终验；否则走故意设计的 failure 边回跳至压测/采集节点进入下一轮。
   - Graph 单次运行每个节点最多访问 3 次（`FAILURE_EDGE_CYCLE` 保护，对应默认 3 轮迭代）；如需更多轮次，使用 `--execute --resume` 续跑。

---

## 三、标准受管调用示例

```bash
WORKFLOW='workflows/sglang-prefill-perf-campaign.yaml'
SUBJECT='deepseek-v4.1-flash'
RUN_ID='prefill-opt-001'
RUN_ROOT="/tmp/infer-forge-runs/${RUN_ID}"

# 复用已运行的 Prefill Pod 启动双路闭环（注意必须传非空 --env 供 perf-021 解析 Journal 事实）
python3 cli/graph.py --workflow "$WORKFLOW" \
  --subject "$SUBJECT" --run-id "$RUN_ID" --artifact-root "$RUN_ROOT" \
  --from-node perf-017-perf-test-graph-prefill \
  --env chip=p800 --env model="$SUBJECT" \
  --set pod_name=<existing-prefill-pod> \
  --set kubeconfig=<kubeconfig-path> \
  --set perf-016-sglang-prefill-perf-optimize:progress="$RUN_ROOT/framework_ledger.json" \
  --set ops-004-xpu-operator-prefill-opt:progress="$RUN_ROOT/operator_ledger.json" \
  --execute --json
```

## 四、执行纪律与安全要求

- **必须传非空 `--env`**：`perf-021-sglang-prefill-gate` 绑定上游优化报告作为必需的 Journal 输入，空 `--env` 会拒绝解析。
- **每个 Task 独立 Verify**：以 `validate.py` 产出的 `validation.json` 为准；框架与算子优化步必须保证 greedy tokens 字节级一致，终验必须通过 `mat-013-accuracy-differential`。
- **集群安全红线**：`kubeconfig` 与部署 manifest 路径按任务提供（如 `<kubeconfig-path>` / `<prefill-yaml-path>`）；只操作自己的测试 Pod，高危删除/缩容操作一律交由人类执行。
