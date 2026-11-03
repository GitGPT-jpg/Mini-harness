/**
 * 跨进程租约竞争（可注入 CAS 屏障）：真实独立进程调用 acquireLease，打印 WIN / LOSE。
 * 用于「两个真实进程竞争同一个过期租约，只有一个成功」的确定性交错验证。
 *
 * 用法：tsx lease-race.ts <runDir> <owner> <generation> [expiredHeartbeat]
 *  - expiredHeartbeat 非空：先写一份「已过期」旧租约（owner=old、generation=generation-1），再竞争接管。
 *  - 环境变量 MINI_HARNESS_CAS_BARRIER_DIR 指向目录时，CAS 判定后会暂停等待 <dir>/go（由父进程控制交错）。
 */
import fs from "node:fs";
import path from "node:path";
import { acquireLease } from "../../server/loop/recovery.js";

const [dir, owner, generationStr, expiredHeartbeat] = process.argv.slice(2);
const generation = Number(generationStr) || 1;

// 可选：预置一份过期旧租约（供接管竞争；owner 固定 old、generation 固定 1、心跳取 10 分钟前）。
if (expiredHeartbeat) {
	fs.mkdirSync(dir, { recursive: true });
	const oldLease = {
		owner: "old@host",
		pid: 99999,
		generation: 1,
		startedAt: new Date(Date.now() - 600_000).toISOString(),
		heartbeatAt: new Date(Date.now() - 600_000).toISOString(),
		remoteJobId: null,
	};
	fs.writeFileSync(path.join(dir, "lease.json"), JSON.stringify(oldLease, null, 2));
}

const nowIso = new Date().toISOString();
const ok = acquireLease(dir, {
	owner,
	pid: process.pid,
	generation,
	startedAt: nowIso,
	heartbeatAt: nowIso,
	remoteJobId: null,
});
// 稳定输出供父进程断言
console.log(ok ? "WIN:" + owner : "LOSE:" + owner);
