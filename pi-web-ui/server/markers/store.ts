/**
 * store.ts — 标记状态持久化（内置版）。
 *
 * 策略：优先用 SDK 会话的 custom entry（appendCustomEntry + getBranch 扫描），
 * 失败时回退到内存 Map（保证 rename 等轻量标记仍可用）。custom entry 类型与
 * pi-marker-tools 保持兼容（marker-tools/store），便于复用既有会话数据。
 */

export const STORE_CUSTOM_TYPE = "marker-tools/store";

export interface StoreSnapshot {
	namespace: string;
	version: number;
	state: unknown;
	ts: number;
}

const SNAPSHOT_VERSION = 1;

/** 从分支重建某命名空间最新快照；branch 为 SessionManager.getBranch() 返回的数组。 */
export function loadStateFromBranch(branch: unknown[], namespace: string): unknown | undefined {
	let latest: StoreSnapshot | undefined;
	for (const entry of branch as Array<{ type?: string; customType?: string; data?: unknown }>) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== STORE_CUSTOM_TYPE) continue;
		const snap = entry.data as StoreSnapshot | undefined;
		if (!snap || snap.namespace !== namespace || snap.state === undefined) continue;
		if (!latest || snap.ts >= latest.ts) latest = snap;
	}
	return latest?.state;
}

/** 追加快照：优先走 sessionManager.appendCustomEntry，否则回退到回调。 */
export function appendSnapshot(
	mgr: { appendCustomEntry?: (t: string, d: unknown) => unknown; getBranch?: () => unknown[] } | undefined,
	namespace: string,
	state: unknown,
	fallbackSave?: (snap: StoreSnapshot) => void,
): void {
	const snapshot: StoreSnapshot = {
		namespace,
		version: SNAPSHOT_VERSION,
		state,
		ts: Date.now(),
	};
	if (mgr?.appendCustomEntry) {
		try {
			(mgr as { appendCustomEntry: (t: string, d: unknown) => unknown }).appendCustomEntry(STORE_CUSTOM_TYPE, snapshot);
			return;
		} catch {
			// 回退到内存
		}
	}
	fallbackSave?.(snapshot);
}
