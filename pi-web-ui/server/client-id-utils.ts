/**
 * client-id-utils — 伪客户端 ID 判断与插件调用工作区校验。
 *
 * 负责：
 * - isPseudoClientId: 判断是否为插件或定时任务的无头伪客户端（sink 常驻）
 * - checkPluginCwd: 校验插件指定的工作目录合法性（防止 Windows SystemRoot 误操作）
 *
 * 从 agent-service.ts 抽出为独立模块。
 */
import { statSync } from "node:fs";
import { resolve, sep } from "node:path";

/** issue #226：插件无头调用的工作目录校验（纯函数，可单测）。
 *  存在性语义与定时任务一致（须存在且为目录，不默默跑错目录）；另在
 *  Windows 下拒绝 SystemRoot 及其子树（如 C:\Windows\System32）——后台服务/
 *  快捷方式启动时宿主 cwd 常飘到 system32，直接跑就是高危误操作。 */
export function checkPluginCwd(cwd: string): { ok: boolean; abs?: string; error?: string } {
	const trimmed = String(cwd ?? "").trim();
	if (!trimmed) return { ok: false, error: "工作目录为空" };
	let abs: string;
	try {
		abs =
			process.platform === "win32" && /^[A-Za-z]:$/.test(trimmed) ? `${trimmed.toUpperCase()}${sep}` : resolve(trimmed);
	} catch {
		return { ok: false, error: `工作目录非法：${trimmed}` };
	}
	try {
		if (!statSync(abs).isDirectory()) throw new Error("not-a-dir");
	} catch {
		return { ok: false, error: `目标项目不存在或不是目录：${trimmed}` };
	}
	if (process.platform === "win32") {
		const sysRoot = (process.env.SystemRoot || process.env.windir || "C:\\Windows")
			.replace(/\//g, "\\")
			.replace(/\\+$/, "");
		const norm = abs.replace(/\//g, "\\").replace(/\\+$/, "");
		const low = norm.toLowerCase();
		const rootLow = sysRoot.toLowerCase();
		if (low === rootLow || low.startsWith(`${rootLow}\\`)) {
			return { ok: false, error: `拒绝在系统目录执行：${abs}（请在插件设置里指定项目工作目录）` };
		}
	}
	return { ok: true, abs };
}

/** 插件/调度/Canvas伪客户端：sink 常驻或后台辅助专用通道，不参与聊天会话认领与感知。 */
export function isPseudoClientId(id: string): boolean {
	return (
		id.startsWith("plugin:") || id.startsWith("scheduler:") || id.startsWith("canvas:") || id.startsWith("canvas-")
	);
}
