/**
 * sftp 引擎「可取消 + 扫描并行」单测 —— 纯本地纯函数，零端口零 token。
 *
 * 现场问题（用户可见）：
 *   - **同步停不下来**：任务只有 `running` 标志，没有任何取消通道，`runPool` 也不看信号 ——
 *     按下去没反应，只能重启服务；
 *   - **扫描太慢**：老实现是一条 `await` 链串到底（目录 → 文件 → 下一个目录），远端更狠，
 *     一次 readdir 一个往返，500 个目录串行 = 几百秒，界面还全程「扫描中…」没有进度。
 *
 * 这里锁住三件事：
 *   1. `runPool` 收到中止后不再领新任务（已在跑的不强杀，由各自的 signal 收尾）；
 *   2. `scanLocal` 层序扫完整棵树（含 ignore / 内部护栏 / 深度上限），中止信号立刻抛；
 *   3. `applyPlan` 被中止时返回 `cancelled: true`、已完成的保留、**不把取消算成失败**。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	SCAN_CONCURRENCY,
	abortError,
	applyPlan,
	isAbortError,
	runPool,
	scanLocal,
	throwIfAborted,
} from "../../plugins/sftp/lib/engine.mjs";

const cleanups: (() => void)[] = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function tempDir(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `sftp-${name}-`));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

describe("runPool 可取消", () => {
	it("中止后不再领新任务（已启动的不强杀）", async () => {
		const ctrl = new AbortController();
		let started = 0;
		await runPool(
			Array.from({ length: 40 }, (_, i) => i),
			4,
			async (n: number) => {
				started++;
				if (n === 0) ctrl.abort(abortError());
				await new Promise((r) => setTimeout(r, 2));
			},
			{ signal: ctrl.signal },
		);
		// 4 个 worker 最多各多领一个任务，绝不可能跑满 40 个
		expect(started).toBeLessThanOrEqual(8);
		expect(started).toBeGreaterThan(0);
	});

	it("信号一开始就是中止态 → 一个任务都不跑", async () => {
		let started = 0;
		await runPool([1, 2, 3], 2, async () => void started++, { signal: AbortSignal.abort(abortError()) });
		expect(started).toBe(0);
	});

	it("默认并发不是 1（串行是当年慢的根因）", async () => {
		expect(SCAN_CONCURRENCY).toBeGreaterThan(1);
		let peak = 0;
		let live = 0;
		await runPool(
			Array.from({ length: 16 }, (_, i) => i),
			SCAN_CONCURRENCY,
			async () => {
				live++;
				peak = Math.max(peak, live);
				await new Promise((r) => setTimeout(r, 5));
				live--;
			},
		);
		expect(peak).toBeGreaterThan(1);
	});
});

describe("取消工具函数", () => {
	it("throwIfAborted：没中止不抛，中止抛同一个 reason", () => {
		expect(() => throwIfAborted(undefined)).not.toThrow();
		const ctrl = new AbortController();
		expect(() => throwIfAborted(ctrl.signal)).not.toThrow();
		ctrl.abort(abortError("停下了"));
		expect(() => throwIfAborted(ctrl.signal)).toThrow(/停下了/);
	});

	it("isAbortError：认 AbortError/ABORT_ERR，也认「信号已中止」这个事实", () => {
		expect(isAbortError(abortError(), undefined)).toBe(true);
		expect(isAbortError(Object.assign(new Error("x"), { code: "ABORT_ERR" }), undefined)).toBe(true);
		expect(isAbortError(new Error("boom"), undefined)).toBe(false);
		const ctrl = new AbortController();
		ctrl.abort();
		expect(isAbortError(new Error("被流的 signal 掐断"), ctrl.signal)).toBe(true);
	});
});

describe("scanLocal", () => {
	function seed(): string {
		const root = tempDir("scan");
		mkdirSync(join(root, "src", "deep", "deeper"), { recursive: true });
		mkdirSync(join(root, "node_modules", "junk"), { recursive: true });
		mkdirSync(join(root, ".sftp-trash", "old"), { recursive: true });
		writeFileSync(join(root, "top.txt"), "top");
		writeFileSync(join(root, "src", "a.ts"), "aaa");
		writeFileSync(join(root, "src", "deep", "b.ts"), "bb");
		writeFileSync(join(root, "src", "deep", "deeper", "c.ts"), "c");
		writeFileSync(join(root, "node_modules", "junk", "index.js"), "junk");
		writeFileSync(join(root, ".sftp-trash", "old", "gone.txt"), "old");
		return root;
	}

	it("层序扫完整棵树：相对路径、大小、mtime 都在", async () => {
		const root = seed();
		const { files, truncated } = await scanLocal(root, (rel: string) => rel.startsWith("node_modules"));
		expect([...files.keys()].sort()).toEqual(["src/a.ts", "src/deep/b.ts", "src/deep/deeper/c.ts", "top.txt"]);
		expect(truncated).toBe(false);
		expect(files.get("src/a.ts")?.size).toBe(3);
		expect(typeof files.get("src/a.ts")?.mtime).toBe("number");
	});

	it("内部护栏（垃圾桶）不可被规则放回", async () => {
		const root = seed();
		const { files } = await scanLocal(root, () => false);
		expect([...files.keys()].some((k) => k.includes(".sftp-trash"))).toBe(false);
	});

	it("进度回调给出文件名/目录数，且随层推进", async () => {
		const root = seed();
		const seen: number[] = [];
		await scanLocal(root, () => false, { onProgress: (p: object) => seen.push((p as { files: number }).files) });
		expect(seen.length).toBeGreaterThan(1);
		// 5 个真实文件（含 node_modules 里的）；.sftp-trash 被内部护栏挡掉
		expect(seen[seen.length - 1]).toBe(5);
	});

	it("已中止的信号：立刻抛，一个目录都不读", async () => {
		const root = seed();
		let progressCalls = 0;
		await expect(
			scanLocal(root, () => false, {
				signal: AbortSignal.abort(abortError()),
				onProgress: () => void progressCalls++,
			}),
		).rejects.toThrow(/已取消/);
		expect(progressCalls).toBe(0);
	});
});

describe("applyPlan 取消", () => {
	/** 一份只有「本地进垃圾桶」动作的计划：不碰 sftp，纯本地即可验证取消语义。 */
	function makePlan(cwd: string, rels: string[]) {
		for (const rel of rels) writeFileSync(join(cwd, rel), rel);
		return {
			profile: "mock",
			cwd,
			direction: "up",
			roots: [
				{
					index: 0,
					localRel: "",
					localAbs: cwd,
					remoteAbs: "/remote",
					remoteRoot: "/remote",
					base: "",
					entries: rels.map((rel) => ({ rel, action: "trash-local", absLocal: join(cwd, rel) })),
				},
			],
		};
	}

	it("中途取消：已完成的保留、剩下的不做、不计入失败", async () => {
		const cwd = tempDir("apply");
		const plan = makePlan(cwd, ["a.txt", "b.txt", "c.txt"]);
		const ctrl = new AbortController();
		let ticks = 0;
		const result = await applyPlan({
			sftp: {} as never,
			plan: plan as never,
			concurrency: 1,
			signal: ctrl.signal,
			onProgress: () => {
				if (++ticks === 1) ctrl.abort(abortError());
			},
		});
		expect(result.cancelled).toBe(true);
		expect(result.ok).toBe(false);
		expect(result.done.trashLocal).toBe(1); // 第一个真的做完了
		expect(result.failed).toEqual([]); // 取消不是失败
	});

	it("还没开始就取消：一个动作都不执行", async () => {
		const cwd = tempDir("apply2");
		const plan = makePlan(cwd, ["a.txt", "b.txt"]);
		const result = await applyPlan({
			sftp: {} as never,
			plan: plan as never,
			concurrency: 4,
			signal: AbortSignal.abort(abortError()),
		});
		expect(result.cancelled).toBe(true);
		expect(result.done.trashLocal).toBe(0);
		expect(result.failed).toEqual([]);
	});

	it("没有信号时行为不变（全部完成、ok=true）", async () => {
		const cwd = tempDir("apply3");
		const plan = makePlan(cwd, ["a.txt", "b.txt"]);
		const result = await applyPlan({ sftp: {} as never, plan: plan as never, concurrency: 2 });
		expect(result.cancelled).toBe(false);
		expect(result.ok).toBe(true);
		expect(result.done.trashLocal).toBe(2);
	});
});
