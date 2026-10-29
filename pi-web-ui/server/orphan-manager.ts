/**
 * orphan-manager — 残留会话认领与同工作区比对工具。
 *
 * 负责：
 * - pickAdoptableOrphan: 选一个断开连接的残留会话给新标签页认领（纯函数）
 * - sameCwd: 跨平台工作区路径一致性比对（纯函数）
 *
 * 从 agent-service.ts 抽出为独立模块。
 */
import { normalizePathKey } from "./client-state.js";

/**
 * 浏览器重启认领（orphan adoption）的候选快照 —— 纯数据，决策逻辑见
 * pickAdoptableOrphan（纯函数，可单测）。live = 还有浏览器连着（sinkCount>0）；
 * pseudo = 插件/调度伪客户端（sink 常驻，不能按浏览器存活判断，永远不参与认领）。
 */
export interface OrphanCandidate {
	id: string;
	live: boolean;
	pseudo: boolean;
	/** 正在跑的对话数（主对话 + 子代理都算）。 */
	streaming: number;
	/** 是否有值得认领的内容（跑着 / 后台挂着 / 有消息历史；纯空白会话不算）。 */
	adoptable: boolean;
	/** 最近活跃时间（各对话 lastActiveAt/lastSdkEventAt 的最大值）。 */
	activity: number;
}

/**
 * 选一个断开的残留会话给新标签认领（纯函数）：
 * - 还有别的在线浏览器（非伪客户端且 live）→ 不认领（新标签是第二块屏，
 *   issue #10 的隔离必须保留，跑着的对话继续走 elsewhere 只读感知）。
 * - 否则在断开 + 非伪 + 有内容的候选中按（streaming 多 → 最近活跃）取最优；
 *   没有返回 null（调用方走正常新建流程）。
 */
export function pickAdoptableOrphan(cands: OrphanCandidate[]): string | null {
	if (cands.some((c) => !c.pseudo && c.live)) return null;
	let best: OrphanCandidate | null = null;
	for (const c of cands) {
		if (c.pseudo || c.live || !c.adoptable) continue;
		if (!best || c.streaming > best.streaming || (c.streaming === best.streaming && c.activity > best.activity)) {
			best = c;
		}
	}
	return best?.id ?? null;
}

/** 同项目判定（纯函数）：调度视口回退与 id 唤醒的 cwd 护栏用。
 *  Windows 大小写/分隔符差异归一，空串永不相等。 */
export function sameCwd(a: string, b: string): boolean {
	const x = String(a ?? "").trim();
	const y = String(b ?? "").trim();
	if (!x || !y) return false;
	try {
		return normalizePathKey(x) === normalizePathKey(y);
	} catch {
		return false;
	}
}
