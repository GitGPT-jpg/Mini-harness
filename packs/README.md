# 能力模板（Capability Packs）

能力模板是服务端源码中固化的任务语义预设。它只复用目标、验收语义、主指标与优化方向，不携带 shell
命令、可执行路径或产物目录，避免工作目录内容影响 Loop 的执行边界。

## 清单

| id | 方向 | 主指标 | 说明 |
|---|---|---|---|
| `inference-perf` | maximize | `tps` | 推理吞吐优化（`ttft_ms` 仅观察） |
| `cache-loss` | minimize | `loss_pct` | 缓存损耗优化（`cache_hit` 仅观察）——第二方向 |

仓库中的 reference fixture：

```
packs/<id>.json              # 说明性配置样例，不会被运行时读取
packs/<id>/validate.py       # reference validator（HARNESS_METRIC 契约，可无 GPU 复现）
```

运行时注册表位于 `pi-web-ui/server/loop/packs.ts`，并由
`GET /api/mini-harness/packs` 以只读语义字段提供给任务弹窗。

## 使用方式

1. 在任务弹窗选择模板，预填 goal、criteria、主指标和方向。
2. 由发起者明确填写 L0 `precheckCmd`、L1 `validateCmd` 和 artifact roots；这些值绝不来自模板。
3. 启动请求带 `packId` 时服务端只接受已注册的模板 ID，并拒绝未知 ID。
4. 若声明了主指标，validator 必须输出相应的 `HARNESS_METRIC` 值；缺少该值的轮次不会成为 best checkpoint。

reference validator 可复制到目标 Harness 仓库，或作为真实压测/采集脚本的输出契约参考。

## 已验证的最小闭环

单测 `pi-web-ui/tests/unit/loop-packs.test.ts`：

- 注册表只暴露两个服务端固化模板，且不含可执行命令；
- 两个 reference validator 真实跑出 `HARNESS_METRIC`，`parseHarnessMetrics` 正确提取主指标；
- 用各包声明的方向喂 `pickBetterRound`，能选出正确的最优轮次（tps 越大越好 / loss_pct 越小越好）。

真实 GPU / 真实模型的「能力包」端到端任务仍需在推理侧集群上验证（本仓无法离线复现）。

真实 GPU / 真实模型的端到端任务仍需在推理侧集群上验证（本仓无法离线复现）。
