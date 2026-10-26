---
name: cache-loss-optimization
description: 基于 infer-forge-harness 的 cache 性能损耗优化工作流（workflows/sglang-cache-loss-optimization.yaml）。6 阶段 10 步闭环：关 cache 基准采集（perf-029）→ AST 细粒度插桩（perf-028）→ 开 cache 排除预热压测抓 trace（perf-030）→ 损耗拆解与独立重算审查（perf-031）→ 逐轮优化与二次确认门禁（perf-032），目标将 80K 长度、96% 命中率下的 cache 损耗降至 20% 以下。
---

# Cache 性能损耗优化工作流（6 阶段 10 步框架）

对应 `infer-forge-harness` 中的 `workflows/sglang-cache-loss-optimization.yaml`，目标在 80K（81920）输入长度、96% 命中率下将开启 ASCache 后的 uncache ITPS 性能损耗降至 20% 以下。

## 一、损耗定义与分类

开启 ASCache 场景下 `uncache itps` 相对 `disable-radix-cache` 场景下 `uncache itps` 缩减的比例：

$$\text{cache\_loss} = 1 - \frac{\text{ITPS}_{\text{ascache, uncache}}}{\text{ITPS}_{\text{disable-radix-cache, uncache}}}$$

三类核心损耗：
1. **计算损耗（Compute Loss）**：`run_batch` 因命中率变高带来的 GPU 侧 `run_batch` 时间增长。
2. **间隙损耗（Gap Loss）**：命中率提升带来的 kernel 间隙耗时增长（通常为高优关注靶点）。
3. **Bubble 损耗**：存在 PP 时，不同 PP stage 间同步等待带来的耗时增长。

---

## 二、受管 Workflow 拓扑与 5 大原子任务契约

`workflows/sglang-cache-loss-optimization.yaml` 将 6 阶段 10 步沉淀为 5 个受管节点：

```text
perf-029-sglang-perfmap-baseline (步骤 2-3: 关 cache 基准采集 -> ServingBaseline)
  -> perf-028-sglang-cache-instrument (步骤 4: AST 细粒度插桩 -> CacheProbeReport)
       -> perf-030-sglang-ascache-benchmark (步骤 5-6: 开 cache 排除预热压测抓 trace -> CacheTraceManifest)
            -> perf-031-sglang-cache-loss-analysis (步骤 7: 损耗归因 + 独立重算审查 -> LossAttributionReport)
                 |-- on_failure (NEED_DEEPER_PROBES / ANALYSIS_BLOCKED) --> 回退至 perf-028 重新细化插桩（最多 3 次重入）
                 +-- on_success (ANALYSIS_VERIFIED) --> perf-032-sglang-cache-opt-session (步骤 8-10: 逐轮优化 + 2 次复测确认 -> DELIVERED)
```

### 1. `perf-029-sglang-perfmap-baseline`（步骤 2–3：关 Cache 基准采集）
- **动作**：在启动脚本中写入 `--disable-radix-cache`，`pkill -9 sglang` 重启引擎（不重建 Pod），驱动 `perfmap-pro` 重复测量。
- **验收（`validate_baseline_report`）**：`min_runs >= 3`、正数 ITPS、`max_itps_spread <= 0.02`（波动 $\le 2\%$）、引擎日志确认 `--disable-radix-cache` 生效，通过状态为 `BASELINE_READY`，产出 `ServingBaseline` 事实与 `baseline_report.json`。

### 2. `perf-028-sglang-cache-instrument`（步骤 4：AST 细粒度插桩）
- **动作**：调用共享技能 `skills/sglang_cache_probe`，在 SGLang 引擎 cache 子系统、`run_batch` 与 radix cache tree 锚点处原子注入带 `# cache-probes:v1` 归属标记的 `@nvtx_utils.scheduler_nvtx_method` 装饰器。
- **可逆性**：支持 `--mode apply|remove|verify`，`--mode remove` 可字节级还原源码。
- **验收（`validate_probe_report`）**：`missing_total == 0`、`errors_total == 0`，通过状态为 `PROBES_APPLIED`，产出 `CacheProbeReport` 事实与 `probe_report.json`。

### 3. `perf-030-sglang-ascache-benchmark`（步骤 5–6：开 Cache 压测与 Trace 抓取）
- **动作**：将启动脚本切换为 `--enable-asradix-cache` 并重启引擎，运行两阶段压测脚本 `bench_ascache.py`（先充 cache 预热，再正式发压）。
- **关键纪律**：**Profile 窗口必须严格框定在预热后的实际发压（load）阶段**（`--warmup-excluded`），绝不能把充 cache 阶段混入 trace；且每个命中率 arm 使用独立的 profile 窗口。
- **验收（`validate_benchmark_report`）**：所有请求的 `hit_rates` 均有正数 ITPS 与非空 trace，且引擎自身日志证实了实际请求命中率，通过状态为 `BENCHMARK_PROFILED`，产出 `CacheTraceManifest` 事实与 `benchmark_report.json`。

### 4. `perf-031-sglang-cache-loss-analysis`（步骤 7：损耗归因与独立重算审查）
- **动作**：对比 baseline arm 与 target arm 的 span traces，将总损耗拆解为按 span 排序的 `gap_loss` 与 `compute_loss`。
- **防伪造机制**：任务内置独立实现（`verify.py`）从原始 trace 重新推导归因并核对报告（误差容忍 `require_sum_within: 0.01`）；若传入 `--set review=<review.json>`，Agent 审查结论与独立重算必须**同时通过**，且绑定相同的 `evidence_sha256`。
- **回退闭环**：若探针粒度不足（返回 `NEED_DEEPER_PROBES`）或阻塞，自动沿 failure 边回跳至 `perf-028-sglang-cache-instrument` 细化插桩；通过状态为 `ANALYSIS_VERIFIED`，产出 `LossAttributionReport`。

### 5. `perf-032-sglang-cache-opt-session`（步骤 8–10：逐轮优化与确认门禁）
- **动作**：按计划的 `rounds_file` 逐轮应用单行改动、执行 `pkill -9 sglang` 重启引擎、复测目标命中率 ITPS 并抓取当轮 trace。
- **收敛与止损规则**：
  - 使用与步骤 7 一致的分母（优先使用插桩后测得的 `instrumented_no_cache`，否则记录 `clean_baseline`）。
  - 若连续两轮改善幅度不超过噪声带（`--noise-band`，默认 `0.01`），以 `stopped_reason=no_progress` 提前止损。
  - **步骤 10 终验门禁**：达到 `target_loss`（如 `< 0.20`）后，必须连续复测确认（`--confirmations`，默认且最少 `2` 次）且每次均达标，防止单次偶然采样蒙混过关。通过状态为 `OPTIMIZATION_CONVERGED`，产出 `rounds.json`、`loss_comparison_report.json` 与 `checkpoint.json`。

---

## 三、标准受管调用与单步压测命令

### 1. 通过 Graph 启动完整 6 阶段 10 步工作流

```bash
WORKFLOW='workflows/sglang-cache-loss-optimization.yaml'
SUBJECT='deepseek-v4.1-flash'
RUN_ID='cache-loss-80k-001'
RUN_ROOT="/tmp/infer-forge-runs/${RUN_ID}"

python3 cli/graph.py --workflow "$WORKFLOW" \
  --subject "$SUBJECT" --run-id "$RUN_ID" --artifact-root "$RUN_ROOT" \
  --env chip=<chip> --env model="$SUBJECT" \
  --set pod=<pod-name> \
  --set kubeconfig=<kubeconfig-path> \
  --set repo_root=<in-pod-sglang-root> \
  --set launch_script=<launch-script-path> \
  --set engine_log=<engine-log-path> \
  --set perfmap_dir=<perfmap-pro-dir> \
  --set bench_script=benchmark/bench_ascache.py \
  --set tokenizer=<tokenizer-path> \
  --set ctx=81920 --set total_len=81920 \
  --set hit_rates=0.96 --set target_hit_rate=0.96 --set target_loss=0.20 \
  --set trace_dir=<trace-output-dir> \
  --set rounds_file=<rounds-plan.json> \
  --execute --json
```

### 2. 底层 `bench_ascache.py` 压测参考命令

```bash
python3 benchmark/bench_ascache.py \
  --host 127.0.0.1 --port 8000 \
  --total-len 81920 \
  --target-hit-rates "0.96" \
  --batch-size 64 --num-rounds 1 \
  --tokenizer <模型 tokenizer 路径> \
  --output-file ascache_80k.json
```

---

## 四、允许操作与安全红线

- **允许操作范围**：允许优化引擎源码（`sglang`）与 SDK（`sglang/baidu/attentionstore/sdk`），允许在**自己独占的测试 Pod 内**使用 `pkill -9 sglang` 重启引擎、修改启动脚本和抓 `nsys` / PyTorch profiler trace。
- **安全红线**：
  - 严禁重建或删除 Pod；共享/线上实例的重启、杀进程、改配置一律停下交由人类确认。
  - 插桩与源码修改需保持可追溯（`# cache-probes:v1` 标记与 `rounds.json` 逐轮审计记录）。
