#!/usr/bin/env python3
"""推理性能能力包 reference validator（最小实践）。

用途：证明「L0 预检 → L1 验收 → HARNESS_METRIC → 主指标 tps(maximize) → 最优轮次」这条链路可跑通。

用法：
    python3 validate.py --precheck        # L0：语法/契约自检，快速短路（不跑基准）
    python3 validate.py --validate        # L1：跑一个小 CPU 基准，输出 HARNESS_METRIC

真实任务：把 run_benchmark 换成 sglang/benchmark_serving 等真实压测，
并把 HARNESS_METRIC 的 tps/ttft_ms 换成真实采集值；本文件只保证契约正确、可无 GPU 复现。
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
    tps = iterations / dt if dt > 0 else 0.0      # 每秒迭代数（吞吐代理指标）
    ttft_ms = dt * 1000.0                          # 端到端耗时（代理 TTFT，观察项）
    return tps, ttft_ms


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

    tps, ttft_ms = run_benchmark(iterations)
    print(json.dumps({"tps": round(tps, 1), "ttft_ms": round(ttft_ms, 2)}))
    # 显式 HARNESS_METRIC 契约：Loop 从这里取主指标（JSON 形式）。
    print(f'HARNESS_METRIC: {{"tps": {round(tps, 1)}, "ttft_ms": {round(ttft_ms, 2)}}}')
    return 0


if __name__ == "__main__":
    sys.exit(main())
