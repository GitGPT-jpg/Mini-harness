/**
 * 跨进程租约竞争：真实独立进程调用 acquireLease，打印 WIN / LOSE。
 * 用于「两个真实进程竞争同一个过期租约，只有一个成功」的确定性交错验证。
 *
 * 用法：node --import tsx lease-race.ts <runDir> <owner> <generation> [observe-before-lock]
 * 可选 IPC 屏障仅属于 fixture：锁外报告 observed-expired，收到 continue 后才进入真实 run 锁，
 * 再报告锁内 checked 记录。生产 acquireLease 不含屏障或故障注入。
 */
import { acquireLease, getLease, leaseExpired, withRunLockSync } from "../../server/loop/recovery.js";

const [dir, owner, generationStr, mode] = process.argv.slice(2);
const generation = Number(generationStr) || 1;

async function beforeLock(): Promise<void> {
	if (!process.send) throw new Error("fixture requires IPC");
	const previous = getLease(dir);
	if (!previous || !leaseExpired(previous)) throw new Error("fixture expected expired lease");
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error("fixture IPC barrier timeout")), 8000);
		const disconnected = () => finish(new Error("fixture parent disconnected"));
		const continued = (message: unknown) => {
			if (message === "continue") finish();
		};
		function finish(error?: Error) {
			clearTimeout(timer);
			process.off("message", continued);
			process.off("disconnect", disconnected);
			if (error) reject(error);
			else resolve();
		}
		process.on("message", continued);
		process.once("disconnect", disconnected);
		process.send!({ type: "observed-expired", generation: previous.generation, owner: previous.owner });
	});
}

try {
	if (mode === "observe-before-lock") await beforeLock();
	let checked: { owner: string; generation: number } | null = null;
	const locked = withRunLockSync(dir, () => {
		const current = getLease(dir);
		if (current) checked = { owner: current.owner, generation: current.generation };
		const nowIso = new Date().toISOString();
		return acquireLease(dir, {
			owner,
			pid: process.pid,
			generation,
			startedAt: nowIso,
			heartbeatAt: nowIso,
			remoteJobId: null,
		});
	});
	if (!locked.ok) throw new Error(locked.error);
	if (process.send) {
		await new Promise<void>((resolve, reject) => {
			process.send!({ type: "checked", lease: checked, acquired: locked.value }, (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}
	console.log(locked.value ? "WIN:" + owner : "LOSE:" + owner);
} finally {
	if (process.connected) process.disconnect();
}
