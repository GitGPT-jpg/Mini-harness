---
name: inference-harness
description: 推理服务 harness（infer-forge-harness）使用总纲。当任务涉及 sglang/AttentionStore/prefill/decode/cache 优化或模型适配时，先读本 skill。规定 AI-Loop 工作方式、AGENTS.md/tasks/REGISTRY.yaml/catalog/tool_catalog.yaml/SKILL.md/validator 的读取顺序、cli/graph.py 受管执行、原子任务复用与新增规则、产物落位与安全红线。
---

# 推理服务 Harness（infer-forge-harness）

本 skill 指导如何基于 `infer-forge-harness`（icode 仓库 `baidu/hac-aiacc/infer-forge-harness`）执行推理服务优化与模型适配任务。

## 一、核心原则（严格遵循 AGENTS.md）

1. **先读再动手（Source of Truth）**：
   - 进入 harness 代码库后，必须先按顺序读取：
     `AGENTS.md` → 目标 `workflows/<workflow>.yaml` → 节点对应的 `tasks/<task>/task.yaml` → `tasks/REGISTRY.yaml` → `catalog/tool_catalog.yaml` → 任务的 `SKILL.md` 与 `validate.py`。
   - 不要仅凭相似任务名或过期 Wiki 猜测行为；仓库内的契约（`task.yaml`）、工作流（`workflows/*.yaml`）、独立 `validator` 和 `Journal` 事实是唯一执行真源。
2. **受管图执行（Graph-Managed Execution）**：
   - 所有声明了 `spec.execution.requires_graph: true` 的任务必须通过 `cli/graph.py` 显式传入 `--workflow`、`--subject`、`--run-id` 与外部 `--artifact-root` 运行，禁止绕过 Graph 直接裸调脚本伪造成功。
3. **产物彻底外置（External State Root）**：
   - 严禁在源码仓库目录内写入运行产物、`journal.jsonl`、Task Memory 或 run state。
   - 必须设置 `INFER_FORGE_STATE_ROOT` 环境变量或通过 `--artifact-root /absolute/external/runs/<run-id>` 指定仓库外持久化目录。
4. **独立 Validator 裁决（Validator Verdict Only）**：
   - 进程返回码 `0`、`PASS` 字符串或 manifest 本身不代表通过；必须由任务契约绑定的独立 `validate.py` 校验通过，且状态文件、必需产物、Journal 事实及环境指纹一致才算通过。
   - `Graph` 是唯一合法的 `Journal` 写入者；任务脚本只写自身状态与证据文件，禁止篡改状态或手写 Journal 伪造完成。
5. **保留现场，禁止静默重试**：
   - 失败节点保留原始日志与证据；重试分配新的 attempt 目录，保留历史 attempt 记录。
   - 严禁把模拟/合成数据报告为真机硬件就绪。
6. **优先复用与扩展闭环**：
   - 新增原子任务前先查 `tasks/REGISTRY.yaml`；已有同族相似任务时优先扩展复用。
   - 新增任务后必须更新 `tasks/REGISTRY.yaml`，并执行生成与引用检查命令。

---

## 二、标准 CLI 入口与调用模板

命令均在 `infer-forge-harness` 仓库根目录下运行：

### 1. 计划、执行与断点续跑（`cli/graph.py`）

```bash
WORKFLOW='workflows/<workflow>.yaml'
SUBJECT='<model-or-pod-subject>'
RUN_ID='<run-id>'
RUN_ROOT='/absolute/external/runs/<run-id>'

# 1) 仅生成并检查执行计划（不执行真实命令）
python3 cli/graph.py --workflow "$WORKFLOW" \
  --subject "$SUBJECT" --run-id "$RUN_ID" --artifact-root "$RUN_ROOT" \
  --env chip=<chip> --set pod=<pod> --json

# 2) 确认输入与权限后正式受管执行
python3 cli/graph.py --workflow "$WORKFLOW" \
  --subject "$SUBJECT" --run-id "$RUN_ID" --artifact-root "$RUN_ROOT" \
  --env chip=<chip> --set pod=<pod> --execute --json

# 3) 中断后恢复（复用环境指纹与契约匹配的成功 Journal 事实，其余节点分配新 attempt）
python3 cli/graph.py --workflow "$WORKFLOW" \
  --subject "$SUBJECT" --run-id "$RUN_ID" --artifact-root "$RUN_ROOT" \
  --env chip=<chip> --set pod=<pod> --execute --resume --json

# 4) 局部节点范围执行（如跳过已部署 Pod 直接从压测/采集节点开始）
python3 cli/graph.py --workflow "$WORKFLOW" \
  --subject "$SUBJECT" --run-id "$RUN_ID" --artifact-root "$RUN_ROOT" \
  --from-node <start-node-id> --until-node <end-node-id> \
  --env chip=<chip> --set pod_name=<existing-pod> --execute --json
```

- **节点级参数隔离**：`--set [NODE:]KEY=VALUE` 支持加节点前缀（如 `--set perf-016-sglang-prefill-perf-optimize:progress=/path/to/ledger.json`），防止同名 key 污染其他节点。
- **自动恢复与 Agent 决策**：启用 `--auto-recover`（默认 `--brain agent`、`--recovery-budget 3`）时，若未传 `--decide-command`，失败节点会在 attempt 目录写 `decision_request.json` 并等待驱动 Agent 写入 `decision.json`（包含合法的 `next_action` 与非空 `diagnosis`）。

### 2. 查询事实与证据链（`cli/journal.py`）

```bash
# 列出当前 run 记录的所有节点事实与证据路径
python3 cli/journal.py --journal "$RUN_ROOT/journal.jsonl" list

# 按事实类型（如 ServingBaseline / PrefillPerfTrace / CacheTraceManifest）查询
python3 cli/journal.py --journal "$RUN_ROOT/journal.jsonl" query \
  --kind <FactKind> --subject "$SUBJECT"
```

### 3. 实时观察进度与排障（`cli/observe.py` & `cli/task_memory.py`）

```bash
# 启动本地只读可视化看板（默认 http://127.0.0.1:8765，不改状态、不重跑验收）
python3 cli/observe.py --run-id "$RUN_ID" --artifact-root "$RUN_ROOT" \
  --workflow "$WORKFLOW" --host 127.0.0.1 --port 8765

# 查看 Agent Loop 协调上下文（Task Memory）
python3 cli/task_memory.py --path "$RUN_ROOT/task_memory.json" \
  --task-id <task-id> --subject "$SUBJECT" --show
```

### 4. 经验蒸馏与仓库维护校验（`cli/promote.py` & `cli/maintenance/`）

```bash
# 从完成的 run 中提取可沉淀的知识候选（输出到 <run-root>/candidates.jsonl）
python3 cli/promote.py distill --artifact-root "$RUN_ROOT" --run-id "$RUN_ID"

# 新增/修改 Task 后重新生成 tasks/CATALOG.md 并校验
python3 cli/maintenance/generate_catalog.py
python3 cli/maintenance/generate_catalog.py --check

# 校验仓库内契约、Workflow 与源码引用完整性
python3 cli/maintenance/check_repo_references.py
```

---

## 三、每步交付报告规范（Handoff Contract）

每完成一个节点或向用户/上游汇报时，必须明确给出以下 7 项信息：
1. `run_id`：当前运行唯一标识
2. `artifact_root`：外部产物根目录路径
3. `node_states`：各节点当前状态（如 `BASELINE_READY`、`BENCHMARK_PROFILED`、`DELIVERED`、`BLOCKED`）
4. `validator_verdicts`：独立 `validate.py` 的校验结论与 `validation.json` 路径
5. `journal_path`：`$RUN_ROOT/journal.jsonl` 路径
6. `evidence_paths`：关键日志、trace manifest、报告 JSON/Markdown 路径
7. **与 Baseline 对比数据**：吞吐（ITPS / QPS）、TTFT、损耗率或精度对比（logits / top-k / greedy tokens byte-identical）

---

## 四、相关领域 Workflow Skill 索引

- `prefill-optimization`：SGLang Prefill 性能优化工作流（覆盖 `sglang-prefill-perf-campaign.yaml`、`sglang-prefill-framework-opt.yaml`、`sglang-prefill-operator-opt.yaml`、`perf-test-graph-prefill.yaml`、`b200/pro6000-prefill-optimization.yaml`）
- `cache-adaptation`：AttentionStore / ASCache 模型适配工作流（MLA / MLA+SWA / MLA+KDA）
- `cache-loss-optimization`：Cache 性能损耗优化 6 阶段 10 步闭环（`workflows/sglang-cache-loss-optimization.yaml`）
- `cache-hitrate-debug`：Cache 命中率下跌问题定位与修复 AI Loop

---

## 五、安全红线（必须遵守）

- **高危集群操作停机交人**：删除实例、删除资源、缩减副本数、驱逐 Pod 等高危操作一律停下，交由人类执行。
- **实例归属隔离**：只能操作分配给自己或当前任务明确授权的 Pod；禁止触碰共享集群中他人的实例（即使 `PodAdapter` 有归属守卫，Agent 侧也必须先核对）。
- **配置变更先确认**：不擅自修改端口、并行拓扑、MODEL_ID、线上流量路由等部署配置；确需修改时先说明理由并等待人类确认。
- **联调集群资源阻塞处理**：`kubectl apply` 后若 Pod 处于 `Pending` 等未调度状态超过 60s，多为共享集群资源不足，立即停止并通知人类腾挪资源，严禁自行抢占或清理他人 Pod。
- **严禁敏感信息入库**：禁止将密钥、内部 Token、私有端点、模型权重或大体积原始 trace 提交到版本库。
