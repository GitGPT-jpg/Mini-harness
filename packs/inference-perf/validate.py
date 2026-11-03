#!/usr/bin/env python3
"""推理性能能力包 reference validator（最小实践）。

用途：证明「L0 预检 → L1 验收 → HARNESS_METRIC → 主指标 input_throughput(maximize) → 最优轮次」链路可跑通。

主指标对齐 infer-forge perf-016：input_throughput（prefill 端到端吞吐，tokens/s，越大越好）。
硬约束：span_regression<=0.02、tokens_parity>=1、acc_drop<=0.01，缺一不可。

本文件是无 GPU 的契约参考实现：用 CPU 计算负载代理「吞吐」，硬约束输出契约形状的确定性值
（span_regression=0.0、tokens_parity=1、acc_drop=0.0），只保证契约正确、可无 GPU 复现；
真实任务把这些值换成 sglang 压测与逐 token 对照的实测结果，不得用模拟值冒充实测通过。
"""
import json
import sys
import time


def _work(iterations: int) -> float:
    """一个可被模型通过改代码/算法来优化的可计算负载（吞吐的代理基准）。"""
    acc = 0.0
    for i in range(iterations):
        acc += (i * 2654435761) % 1000
    return acc


def run_benchmark(iterations: int):
    t0 = time.perf_counter()
    _work(iterations)
    dt = time.perf_counter() - t0
    input_throughput = iterations / dt if dt > 0 else 0.0  # 每秒迭代数（吞吐代理指标）
    ttft_ms = dt * 1000.0                                  # 端到端耗时（代理 TTFT，观察项）
    return input_throughput, ttft_ms


def main() -> int:
    args = sys.argv[1:]
    iterations = 3_000_000
    if "--iterations" in args:
        i = args.index("--iterations")
        try:
            iterations = max(1, int(args[i + 1]))
        except (ValueError, IndexError):
            pass

    if "--precheck" in args:
        _work(10)
        print("PRECHECK_OK: 语法/契约自检通过")
        return 0

    input_throughput, ttft_ms = run_benchmark(iterations)
    span_regression = 0.0
    tokens_parity = 1
    acc_drop = 0.0
    print(json.dumps({
        "input_throughput": round(input_throughput, 1),
        "ttft_ms": round(ttft_ms, 2),
        "span_regression": span_regression,
        "tokens_parity": tokens_parity,
        "acc_drop": acc_drop,
    }))
    # 显式 HARNESS_METRIC 契约：Loop 从这里取主指标与硬约束（JSON 形式）。
    print(
        f'HARNESS_METRIC: {{"input_throughput": {round(input_throughput, 1)}, '
        f'"ttft_ms": {round(ttft_ms, 2)}, "span_regression": {span_regression}, '
        f'"tokens_parity": {tokens_parity}, "acc_drop": {acc_drop}}}'
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
