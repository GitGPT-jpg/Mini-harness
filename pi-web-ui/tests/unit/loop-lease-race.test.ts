/**
 * 租约 CAS 并发正确性（Prompt §4 / 验证矩阵 A）：
 *  - A.2 两个真实进程竞争同一「过期」租约，只有一个成功（屏障控制交错：A 判过期后暂停，B 先接管，A 再继续）；
 *  - A.3 旧 owner 心跳不得覆盖新 owner 租约；
 *  - A.4 旧 owner 释放不得删除新 owner 租约；
 *  - A.5 generation 单调、旧代次 mutate 永久失效。
 *
 * 与 loop-recovery-process.test.ts 的「空目录双进程」不同：这里覆盖的是「检查→接管」整个操作的原子性，
 * 而不是只用 O_EXCL 独占创建文件。
 */
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { acquireLease, getLease, heartbeat, mutateLease, releaseLease, LEASE_TTL_MS, type Lease } from "../../server/loop/recovery.js";

const execFileP = promisify(execFile);
const TSBIN = join(process.cwd(), "node_modules", ".bin", "tsx");
const RACE = join(import.meta.dirname, "..", "fixtures", "lease-race.ts");

const DIRS: string[] = [];
function tmpDir(): string {
	const d = mkdtempSync(join(tmpdir(), "loop-lease-race-"));
	DIRS.push(d);
	return d;
}
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

function leaseOf(owner: string, generation: number, heartbeatAt = new Date().toISOString()): Lease {
	return { owner, pid: process.pid, generation, startedAt: heartbeatAt, heartbeatAt, remoteJobId: null };
}

function writeLeaseFile(dir: string, lease: Lease): void {
	writeFileSync(join(dir, "lease.json"), JSON.stringify(lease, null, 2));
}

async function waitFor(fn: () => boolean, ms = 8000, step = 20): Promise<void> {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (fn()) return;
		await new Promise((r) => setTimeout(r, step));
	}
	throw new Error("waitFor timeout");
}

describe("租约接管原子性（过期接管竞争）", () => {
	it("两个真实进程竞争同一过期租约：只有一个成功（A 判过期后暂停、B 先接管、A 再继续）", async () => {
		const dir = tmpDir();
		const barrierDir = tmpDir();
		// 预置一份过期租约（old，gen1，10 分钟前心跳）
		writeLeaseFile(dir, leaseOf("old@host", 1, new Date(Date.now() - LEASE_TTL_MS - 60_000).toISOString()));

		// A：带 CAS 屏障。它会在「判定过期」后暂停，等 barrierDir/go 出现才继续放置。
		const aChild = spawn(TSBIN, [RACE, dir, "a@host", "2"], {
			env: { ...process.env, MINI_HARNESS_CAS_BARRIER_DIR: barrierDir },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let aOut = "";
		aChild.stdout!.on("data", (c: Buffer) => (aOut += c.toString()));
		aChild.stderr!.on("data", (c: Buffer) => (aOut += c.toString()));
		const aExit = new Promise<number | null>((res) => aChild.on("close", res));
		// 等 A 进入屏障（tsx 会再派生子进程，pid 与 aChild.pid 不同；屏障目录里任何 ready.* 都来自 A）。
		await waitFor(() => existsSync(join(barrierDir, "go")) || readdirSync(barrierDir).some((f) => f.startsWith("ready.")), 8000);

		// B：无屏障，先完成接管（gen2）。
		const b = await execFileP(TSBIN, [RACE, dir, "b@host", "2"]);
		expect(b.stdout.trim()).toBe("WIN:b@host");

		// 放行 A：它应当发现 lease.json 已被 B 重建（link EEXIST），判负且不覆盖 B。
		writeFileSync(join(barrierDir, "go"), "go");
		await aExit;
		expect(aOut.trim()).toBe("LOSE:a@host");

		// 最终只有一个赢家：B 的 gen2 租约仍在。
		expect(getLease(dir)?.owner).toBe("b@host");
		expect(getLease(dir)?.generation).toBe(2);
	}, 30_000);

	it("A.3 旧 owner 心跳不得覆盖新 owner 租约", () => {
		const dir = tmpDir();
		expect(acquireLease(dir, leaseOf("a@host", 1))).toBe(true);
		// a 失联 → 过期 → b 接管 gen2
		writeLeaseFile(dir, leaseOf("a@host", 1, new Date(Date.now() - LEASE_TTL_MS - 60_000).toISOString()));
		expect(acquireLease(dir, leaseOf("b@host", 2))).toBe(true);
		const before = getLease(dir)!;
		// a 的旧心跳（gen1）必须失败，且不能改动 b 的租约（连 heartbeatAt 都不变）。
		expect(heartbeat(dir, "a@host", 1)).toBe(false);
		expect(getLease(dir)).toEqual(before);
	});

	it("A.4 旧 owner 释放不得删除新 owner 租约", () => {
		const dir = tmpDir();
		expect(acquireLease(dir, leaseOf("a@host", 1))).toBe(true);
		writeLeaseFile(dir, leaseOf("a@host", 1, new Date(Date.now() - LEASE_TTL_MS - 60_000).toISOString()));
		expect(acquireLease(dir, leaseOf("b@host", 2))).toBe(true);
		expect(releaseLease(dir, "a@host")).toBe(false); // 旧 owner 释放被拒
		expect(getLease(dir)?.owner).toBe("b@host");
		expect(getLease(dir)?.generation).toBe(2);
	});

	it("A.5 generation 单调，旧代次 mutate 永久失效（不能清空新 owner 的 taskPid）", () => {
		const dir = tmpDir();
		expect(acquireLease(dir, leaseOf("a@host", 1))).toBe(true);
		// 当前代次可写 taskPid
		expect(mutateLease(dir, { owner: "a@host", generation: 1 }, (cur) => ({ ...cur, taskPid: 42 }))).toBe(true);
		expect(getLease(dir)?.taskPid).toBe(42);
		// 旧代次（gen0）写被拒，不能清空 taskPid
		expect(mutateLease(dir, { owner: "a@host", generation: 0 }, (cur) => ({ ...cur, taskPid: 0 }))).toBe(false);
		expect(getLease(dir)?.taskPid).toBe(42);
		// 释放后重新取得：generation 继续（此处断言新取得者显式给了 gen3，旧 gen1 token 仍失效）
		expect(releaseLease(dir, "a@host")).toBe(true);
		expect(acquireLease(dir, leaseOf("b@host", 3))).toBe(true);
		expect(mutateLease(dir, { owner: "a@host", generation: 1 }, (cur) => ({ ...cur, taskPid: 7 }))).toBe(false);
		expect(getLease(dir)?.owner).toBe("b@host");
		expect(getLease(dir)?.generation).toBe(3);
	});
});
