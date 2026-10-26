---
name: cache-hitrate-debug
description: 基于 infer-forge-harness 的 cache 命中率问题定位与修复 AI Loop。基于 AttentionStore 定位并修复线上/评测 cache 命中率下跌问题，复用 sglang_cache_instrument/sglang_ascache_benchmark 等原子任务，目标解决 9 成以上命中率下跌并支持自动进化。
---

# Cache 命中率问题定位与修复工作流

基于 `infer-forge-harness` 与 `AttentionStore`，针对线上或评测场景出现的 ASCache 命中率下跌问题执行“测量复现 → 探针定位 → 根因验证 → 修复回归 → 经验蒸馏”的受管 AI Loop。

## 一、核心目标与里程碑

1. **闭环拆解**：基于 AttentionStore 完成 Cache 命中率问题定位和修复 Loop 拆解。
2. **真机跑通**：AI Loop 跑通至少一个模型的线上命中率下跌问题定位和修复。
3. **持续自进化**：通过 `cli/promote.py distill` 将每次定位出的根因模式与修复规则沉淀回能力包，解决 90% 以上的命中率下跌问题。

---

## 二、常见命中率下跌根因分类与排查方向

| 根因维度 | 典型现象 | 关键排查证据 |
|---|---|---|
| **Tokenizer / 前缀不一致** | 相同业务请求产生不同 token 序列（chat template、system prompt 时间戳/随机 ID、特殊 token 边界） | 对比请求级 input_ids 前缀 hash 与 radix tree match 长度 |
| **Radix / ASRadix Tree 匹配与淘汰异常** | page/block size 对齐截断、eviction 策略过早淘汰热前缀、并发 lock 冲突导致跳过查找 | `perf-028` 插桩 `match_prefix` / `insert` / `evict` span 计数与命中深度 |
| **AttentionStore SDK / 远端存储层未命中** | 本地 radix tree 命中或 miss 后向 ASCache lookup 失败、key 命名空间/模型版本指纹不匹配、超时降级为重算 | 引擎日志 `hit_rate` vs SDK lookup/fetch 统计、ASCache agent 连接与返回码 |
| **PD 分离 / 多实例路由漂移** | 同一会话/同前缀请求被路由到未共享缓存池的不同实例，或 prefill 写 cache 未完成即触发后续请求 | 路由层 session affinity 配置、ASCache 写入完成回调时序 |

---

## 三、基于 Harness 的 5 步受管定位与修复流程

1. **复现与基线对照（`perf-030-sglang-ascache-benchmark`）**：
   - 使用 `bench_ascache.py`（两阶段：先充 cache，再实际发压）或脱敏重放流量，在受控测试 Pod 上复现期望 `target-hit-rates` 与引擎日志实际 `hit_rate` 的偏差。
   - 严禁仅凭客户端参数假设命中，必须以引擎日志输出的真实 served-request `hit_rate` 为准（`require_hit_rates_observed: true`）。
2. **AST 细粒度探针注入（`perf-028-sglang-cache-instrument`）**：
   - 调用 `skills/sglang_cache_probe`（`--mode apply`）在 SGLang 的 radix cache / ASRadixCache 查找、插入、淘汰及 SDK 交互边界打入 `# cache-probes:v1` NVTX 探针。
3. **Trace 与日志联合归因**：
   - 在实际发压阶段抓取 trace（`perf-018` / `perf-030`）与引擎/SDK 详细日志，定位 miss 发生在哪一层（token 前缀截断、page 对齐边界、tree 淘汰还是 SDK lookup 失败）。
4. **修复与回归验证**：
   - 针对根因修改 `aiak_sglang` 或 `attentionstore/sdk`（仅限独立测试分支与测试 Pod），`pkill -9 sglang` 重启引擎。
   - 重新运行 `perf-030-sglang-ascache-benchmark` 验证引擎日志 `hit_rate` 恢复至目标值，并通过 `mat-013-accuracy-differential` 确认输出 token / logits 精度零退化。
   - 验证通过后可执行 `perf-028` 的 `--mode remove` 还原探针，保留干净修复补丁。
5. **经验蒸馏与自进化（`cli/promote.py distill`）**：
   - 运行 `python3 cli/promote.py distill --artifact-root "$RUN_ROOT" --run-id "$RUN_ID"` 提取本次排障的 `candidates.jsonl`，将新发现的命中率下跌模式补充到 `tasks/REGISTRY.yaml` 或领域知识库。

---

## 四、执行纪律与安全红线

- **以独立 Validator 为准**：定位结论必须有可重放的日志/trace 证据支撑；修复必须通过 `validate.py` 校验，禁止静默重试或口头宣布修复。
- **数据与集群安全红线**：
  - 严禁将线上原始用户敏感流量或密钥写入版本库。
  - 只允许在自己的测试 Pod 内修改代码与重启引擎；线上或共享实例的任何变更必须停下交由人类执行。
