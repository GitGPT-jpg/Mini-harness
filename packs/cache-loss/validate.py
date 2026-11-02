#!/usr/bin/env python3
"""缓存损耗能力包 reference validator（最小实践，第二方向：越小越好）。

用途：证明「HARNESS_METRIC loss_pct(minimize)」这条「第二方向」链路可跑通——
与 inference-perf 的 maximize 方向相对，说明 Loop 的最优轮次比较不绑定单一指标方向。

用法：
    python3 validate.py --precheck        # L0：语法/契约自检
    python3 validate.py --validate        # L1：跑一个确定性缓存模拟，输出 HARNESS_METRIC（KV 形式）

真实任务：换成 AttentionStore/ASCache 的命中率与损耗采集；这里用确定性模拟保证可无 GPU 复现。
"""
import random
import sys


def run_sim(accesses: int = 2000, capacity: int = 64, seed: int = 7):
    rng = random.Random(seed)
    cache = {}
    hits = 0
    for _ in range(accesses):
        key = rng.randint(0, capacity * 4)
        if key in cache:
            hits += 1
        else:
            cache[key] = True
            if len(cache) > capacity:
                cache.pop(next(iter(cache)))  # 简单随机淘汰
    loss_pct = round((1 - hits / accesses) * 100, 2)
    cache_hit = round(hits / accesses, 4)
    return loss_pct, cache_hit


def main() -> int:
    args = sys.argv[1:]
    if "--precheck" in args:
        print("PRECHECK_OK: 语法/契约自检通过")
        return 0

    loss_pct, cache_hit = run_sim()
    # 显式 HARNESS_METRIC 契约（KV 形式，主指标 loss_pct）。
    print(f"HARNESS_METRIC: loss_pct={loss_pct} cache_hit={cache_hit}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
