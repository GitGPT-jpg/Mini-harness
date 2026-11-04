/**
 * 租约 CAS 并发正确性（Prompt §4 / 验证矩阵 A）：
 *  - A.2 两个真实进程竞争同一「过期」租约，只有一个成功（屏障控制交错：A 判过期后暂停，B 先接管，A 再继续）；
 *  - A.3 旧 owner 心跳不得覆盖新 owner 租约；
 *  - A.4 旧 owner 释放不得删除新 owner 租约；
 *  - A.5 generation 单调、旧代次 mutate 永久失效。
 *
 * 与 loop-recovery-process.test.ts 的「空目录双进程」不同：这里覆盖的是「检查→接管」整个操作的原子性，
 * 生产锁为每 run SQLite BEGIN IMMEDIATE，屏障只存在于 fixture。
 */
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
	acquireLease,
	getLease,
	heartbeat,
	mutateLease,
	releaseLease,
	withRunLockSync,
	LEASE_TTL_MS,
	type Lease,
} from "../../server/loop/recovery.js";

const execFileP = promisify(execFile);
const RACE = join(import.meta.dirname, "..", "fixtures", "lease-race.ts");
const CONTENDER = join(import.meta.dirname, "..", "fixtures", "lease-contender.ts");

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

describe("租约接管原子性（过期接管竞争）", () => {
	it("真实进程的 owner nonce 各自唯一，模块重新加载仍保持同一实例身份", async () => {
		const results = await Promise.all(
			[0, 1].map(() => execFileP(process.execPath, ["--import", "tsx", CONTENDER, "--identity"], { timeout: 8000 })),
		);
		const identities = results.map((result) => JSON.parse(result.stdout));
		for (const identity of identities) {
			expect(identity.again).toBe(identity.owner);
			expect(identity.reloaded).toBe(identity.owner);
			const [pid, host, nonce] = identity.owner.split("@");
			expect(Number(pid)).toBeGreaterThan(0);
			expect(host).toBe(hostname());
			expect(nonce).toMatch(/^[a-f0-9]{32}$/);
		}
		expect(identities[0].owner.split("@")[2]).not.toBe(identities[1].owner.split("@")[2]);
	});

	it("两个真实进程竞争同一过期租约：只有一个成功（A 判过期后暂停、B 先接管、A 再继续）", async () => {
		const dir = tmpDir();
		// 初始化新版存储后，再预置过期数据；不冒充旧活进程离线迁移。
		expect(withRunLockSync(dir, () => true)).toEqual({ ok: true, value: true });
		writeLeaseFile(dir, leaseOf("old@host", 1, new Date(Date.now() - LEASE_TTL_MS - 60_000).toISOString()));

		const aChild = spawn(process.execPath, ["--import", "tsx", RACE, dir, "a@host", "2", "observe-before-lock"], {
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		let aOut = "";
		let aErr = "";
		const messages: unknown[] = [];
		aChild.stdout!.on("data", (c: Buffer) => (aOut += c.toString()));
		aChild.stderr!.on("data", (c: Buffer) => (aErr += c.toString()));
		aChild.on("message", (message) => messages.push(message));
		const aExit = new Promise<number | null>((res) => aChild.on("close", res));
		try {
			await expect
				.poll(() => messages, { timeout: 8000 })
				.toContainEqual({
					type: "observed-expired",
					generation: 1,
					owner: "old@host",
				});
			// B 在 A 的锁外观察之后完成真实事务，随后 A 必须在锁内重读。
			const b = await execFileP(process.execPath, ["--import", "tsx", RACE, dir, "b@host", "2"], { timeout: 8000 });
			expect(b.stdout.trim()).toBe("WIN:b@host");
			await new Promise<void>((resolve, reject) => {
				aChild.send("continue", (error) => (error ? reject(error) : resolve()));
			});
			expect(await aExit, aErr).toBe(0);
			expect(aOut.trim()).toBe("LOSE:a@host");
			expect(messages).toContainEqual({
				type: "checked",
				lease: { owner: "b@host", generation: 2 },
				acquired: false,
			});
			expect(getLease(dir)?.owner).toBe("b@host");
			expect(getLease(dir)?.generation).toBe(2);
		} finally {
			if (aChild.exitCode === null && aChild.signalCode === null) aChild.kill("SIGKILL");
			await aExit;
		}
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
		expect(releaseLease(dir, "a@host", 1)).toBe(false); // 旧 owner 释放被拒
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
		expect(releaseLease(dir, "a@host", 1)).toBe(true);
		expect(acquireLease(dir, leaseOf("b@host", 3))).toBe(true);
		expect(mutateLease(dir, { owner: "a@host", generation: 1 }, (cur) => ({ ...cur, taskPid: 7 }))).toBe(false);
		expect(getLease(dir)?.owner).toBe("b@host");
		expect(getLease(dir)?.generation).toBe(3);
	});
});
