import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * 跨平台安全原子写文件：先写临时文件再 renameSync，进程崩溃不留半截文件。
 * - tmp 文件位于目标文件同目录下（保证处于同物理卷，rename 为原子操作）；
 * - tmp 文件名携带 pid + 时间戳 + 随机串，防止同机多进程互踩；
 * - Windows 下目标文件若被外部临时占用（杀软/文本编辑器锁），rename 失败后退回原地写兜底；
 * - 确保无论成功失败，临时文件在 finally 中及时清理，杜绝残留 .tmp 垃圾文件。
 */
export function writeAtomicSync(file: string, data: string | NodeJS.ArrayBufferView): void {
	const dir = dirname(file);
	mkdirSync(dir, { recursive: true });
	const suffix = `${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
	const tmp = `${file}.${suffix}`;
	try {
		writeFileSync(tmp, data);
		try {
			renameSync(tmp, file);
		} catch {
			writeFileSync(file, data);
		}
	} finally {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// ignore cleanup errors
		}
	}
}

/**
 * 原子写 JSON 辅助函数（默认 2 空格缩进 + 末尾换行）。
 */
export function writeJsonAtomicSync(file: string, data: unknown, indent: number | string = 2): void {
	const text = JSON.stringify(data, null, indent) + "\n";
	writeAtomicSync(file, text);
}
