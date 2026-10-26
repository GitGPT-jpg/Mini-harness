---
name: cache-adaptation
description: 基于 infer-forge-harness 的 AttentionStore 适配工作流（attention-store 适配），把新模型接入 ASCache。目标跑通 MLA、MLA+SWA、MLA+KDA 三类注意力，复用 sglang_pd_deploy/accuracy_differential/sglang_ascache_benchmark 等原子任务并支持自动组合适配与自动进化。
---

# AttentionStore / ASCache 模型适配工作流

对应 `infer-forge-harness` 中的 AttentionStore（ASCache）模型适配场景，将新模型（如 `deepseek-v4.1-flash`）接入 AttentionStore 缓存体系，跑通三类注意力结构并完成精度与功能验收。

## 一、目标与里程碑

1. **三类注意力结构全覆盖**：
   - **MLA**（Multi-head Latent Attention）
   - **MLA + SWA**（Sliding Window Attention）
   - **MLA + KDA**（Key-Driven / 稀疏或混合注意力变体）
2. **闭环拆解与自动组合**：基于 `infer-forge-harness` 完成 Cache 适配 Loop 拆解，支持按模型的注意力拓扑自动组合适配步骤并持续自进化。

---

## 二、关联代码库与工作流参数

| 仓库/模块 | 对应 Workflow 参数 | 仓库标识 / 路径 | 读写权限与用途 |
|---|---|---|---|
| **推理引擎** | `sglang_root` / `repo_root` | `baidu/hac-aiacc/aiak_sglang` | **读写**：适配模型 RadixCache / ASRadixCache 层、KV 传输与 attention backend 接线 |
| **ASCache SDK** | `sdk_root` | `baidu/hac-aiacc/attentionstore` (`attentionstore/sdk`) | **读写**：适配 SDK 侧 Block/Page 布局、多层 KV 描述符与传输接口 |
| **ASCache Agent** | `agent_root` | `baidu/hac-aiacc/attentionstore` (`attentionstore/agent`) | **只读参考**：核对存储侧接口协议、配置项与参数契约，默认不修改 |
| **Harness 底座** | — | `baidu/hac-aiacc/infer-forge-harness` | **编排与验收**：通过 `cli/graph.py` 调度原子任务、记录 `Journal` 事实与独立 `validate.py` 裁决 |

---

## 三、Harness 可复用原子任务与适配链路

在 `infer-forge-harness` 中组装或运行 AttentionStore 适配 Workflow 时，优先复用 `tasks/REGISTRY.yaml` 中的以下受管原子任务：

1. **环境与基础服务拉起**：
   - `kdp-002-sglang-pd-deploy`（`tasks/sglang_pd_deploy/task.yaml`）：部署或验证 Prefill/Decode 服务就绪，产出 `PDServiceProof`。
   - `pro6000-sglang-pod-launch.yaml`（`kdp-001d` → `kdp-003-sglang-launch-session`）：在空闲 Pod 内由 LLM 会话拉起并排障 SGLang 服务，通过独立 readiness 校验。
   - `workflows/sglang-adapt-basic.yaml` / `sglang-adapt-prefill-cp.yaml` / `sglang-adapt-deepep.yaml`：模型基础适配与并行特性启用参考。
2. **ASCache 启用、插桩与命中验证**：
   - `perf-028-sglang-cache-instrument`（`tasks/sglang_cache_instrument/task.yaml`）：注入 `# cache-probes:v1` NVTX 探针，验证 cache tree 与 `run_batch` 路径覆盖。
   - `perf-030-sglang-ascache-benchmark`（`tasks/sglang_ascache_benchmark/task.yaml`）：开启 `--enable-asradix-cache` 重启引擎，运行 `bench_ascache.py`（充 cache + 实际发压），从引擎日志核验目标 `hit_rates` 真实命中。
3. **精度对齐与排障闭环**：
   - `mat-001-model-intake` → `mat-013-accuracy-differential`（`tasks/accuracy_differential/task.yaml`）：对比开启 ASCache 后的服务输出（top-k / greedy tokens）与基准参考是否一致。
   - `workflows/accuracy-diagnosis.yaml`（`acc-001` → `acc-002` → `acc-003`）：若开启 ASCache 后出现精度发散（如 SWA 窗口边界或 KDA 稀疏块索引偏移），进入诊断会话定位并修复，再回到 `mat-013` 或 GSM8K 门禁复验。
   - `tasks/long_context_sparse_correctness/task.yaml`：验证长上下文跨块选择边界的稀疏注意力正确性。

> 若现有原子任务未覆盖某类新型注意力（如特定 KDA 状态缓存布局校验），按 `AGENTS.md` 规范在 `tasks/` 下新增契约，更新 `tasks/REGISTRY.yaml` 并执行 `python3 cli/maintenance/generate_catalog.py` 与 `python3 cli/maintenance/check_repo_references.py`。

---

## 四、执行要求与安全红线

- **受管执行与产物外置**：一律通过 `python3 cli/graph.py --workflow <workflow.yaml> --subject <model> --run-id <id> --artifact-root <external-dir> --execute --json` 运行，产物严禁写入源码目录。
- **每步完整证据交付**：记录并汇报 `run_id`、`artifact_root`、节点状态、`validate.py` 结论、`journal.jsonl` 路径、引擎日志 `hit_rate` 证据及精度对比结论。
- **集群安全红线**：集群配置文件（`<kubeconfig-path>`）与未适配的 P 侧 YAML 按任务启动 prompt 提供；只操作自己的 Pod，禁止删除/缩容/修改他人实例。
