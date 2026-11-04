# 能力模板（Capability Packs）

能力模板是服务端源码中固化的任务语义预设。它只复用目标、验收语义、主指标与优化方向，不携带 shell
命令、可执行路径或产物目录，避免工作目录内容影响 Loop 的执行边界。

## 清单

| id | 方向 | 主指标 | 说明 |
|---|---|---|---|
| `inference-perf` | maximize | `input_throughput` | prefill 吞吐优化（对齐 infer-forge perf-016；span/token/acc 硬约束） |
| `service-config-verify` | —（布尔） | — | decode 引擎就绪验证（对齐 infer-forge perf-021；无主指标） |
| `cache-loss` | minimize | `loss_pct` | ASCache 损耗优化（ITPS 比值损耗；cache_hit 是独立观测） |

> **指标口径**：cache 损耗（loss_pct）≠ miss rate / 命中率。真实 ASCache 损耗是
> `(1 - ITPS_ascache,uncache / ITPS_disable-radix-cache,uncache) * 100`，命中率（cache_hit）
> 是压测时独立的观测项，不能拿 `(1 - 命中率)` 冒充损耗。

仓库中的 reference fixture：

```
packs/<id>.json              # 说明性配置样例，不会被运行时读取（运行时以 packs.ts 为准）
packs/<id>/validate.py       # reference validator（HARNESS_METRIC 契约，可无 GPU 复现）
```

运行时注册表位于 `pi-web-ui/server/loop/packs.ts`，三层加载：
- 第一层 `GET /api/mini-harness/packs` → 轻量任务目录（选任务）；
- 第二层 `GET /api/mini-harness/packs/:id/knowledge` → 被选中任务的知识（含 provenance）；
- 第三层 `GET /api/mini-harness/packs/:id/references[/:refId]` → 按需参考材料；
- 上下文发现 `POST /api/mini-harness/discover` → 只读扫描 + 只问缺口。

## 使用方式

1. 在任务弹窗选择模板，预填 goal、criteria、主指标和方向（布尔验证包主指标为空）。
2. 由发起者明确填写 L0 `precheckCmd`、L1 `validateCmd` 和 artifact roots；这些值绝不来自模板。
3. 启动请求带 `packId` 时服务端只接受已注册的模板 ID，并拒绝未知 ID。
4. 若声明了主指标，validator 必须输出相应的 `HARNESS_METRIC` 值；缺少该值的轮次不会成为 best checkpoint。

reference validator 可复制到目标 Harness 仓库，或作为真实压测/采集脚本的输出契约参考。

## 已验证的最小闭环

单测 `pi-web-ui/tests/unit/loop-packs.test.ts`、`loop-knowledge.test.ts`、`loop-recovery.test.ts`：

- 注册表暴露三个服务端固化模板，且不含可执行命令；
- reference validator 真实跑出 `HARNESS_METRIC`（input_throughput / loss_pct），
  `parseHarnessMetrics` 正确提取主指标，cache-loss 的 loss_pct 是 ITPS 比值损耗（8.0）而非命中率；
- 用各包声明的方向喂 `pickBetterRound`，能选出正确的最优轮次；
- 三层知识（目录/知识/参考）+ 输入来源合并 + 恢复分类/租约原语（`recovery.ts`）单测通过。

真实 GPU / 真实模型的「能力包」端到端任务仍需在推理侧集群上验证（本仓无法离线复现）。
