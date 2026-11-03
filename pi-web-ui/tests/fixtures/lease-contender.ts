/**
 * 跨进程租约竞争者：真实独立进程调用 acquireLease，打印 WIN / LOSE。
 * 用于「两个真实进程同时争抢同一 run，只有一个获得有效执行权」的故障注入验证。
 * 用法：tsx lease-contender.ts <runDir> <owner>
 */
import { acquireLease } from "../../server/loop/recovery.js";

const [dir, owner] = process.argv.slice(2);
const nowIso = new Date().toISOString();
const ok = acquireLease(dir, {
	owner,
	pid: process.pid,
	generation: 1,
	startedAt: nowIso,
	heartbeatAt: nowIso,
	remoteJobId: null,
});
// 稳定输出供父进程断言
console.log(ok ? "WIN:" + owner : "LOSE:" + owner);
