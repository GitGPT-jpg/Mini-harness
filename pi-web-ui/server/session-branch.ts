/**
 * Session branch evaluation, leaf calibration, and transcript topological reordering.
 *
 * Background (issue #567):
 * When multiple devices access the same session, or when extensions append metadata
 * (e.g. type: "custom" such as plannotator entries) pointing to an older ancestor node,
 * the appended entries appear at the physical tail of the JSONL file.
 *
 * In the SDK's SessionManager._buildIndex():
 *   for (const entry of this.fileEntries) {
 *     if (entry.type === "session") continue;
 *     this.byId.set(entry.id, entry);
 *     this.leafId = entry.id; // file tail becomes the active leaf!
 *   }
 *
 * If metadata was appended to an older branch (e.g. node 292 while the main branch
 * continued to 557), reopening the session or restarting the backend will restore
 * the older branch (292), making later task history (293..557) invisible even though
 * it is still safely stored in the JSONL file.
 *
 * This module provides:
 * 1. selectBestSessionLeaf: Evaluates branch candidates by message count, freshness,
 *    and depth, detecting metadata-only hijacking or stale branch reversion.
 * 2. calibrateSessionLeaf: In-memory leaf calibration for any SessionManager instance.
 * 3. reorderEntriesForMainBranch: Topological reordering of session entries to ensure
 *    the active main branch leaf resides at the physical tail of the transcript file
 *    without losing or modifying any custom/metadata entries.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type AnySessionEntry =
	| SessionEntry
	| {
			id?: string;
			parentId?: string | null;
			type?: string;
			timestamp?: string;
			customType?: string;
			[key: string]: unknown;
	  };

export interface BranchCandidate {
	leafId: string;
	leafEntry: AnySessionEntry;
	totalEntries: number;
	messageCount: number;
	lastMessageTimestamp: number;
	tailTimestamp: number;
	pathIds: string[];
}

export interface LeafCalibrationResult {
	bestLeafId: string;
	currentLeafId: string | null;
	changed: boolean;
	reason?: string;
}

function parseEntryTimestamp(ts?: unknown): number {
	if (typeof ts === "string") {
		const parsed = Date.parse(ts);
		if (!Number.isNaN(parsed)) return parsed;
	} else if (typeof ts === "number" && !Number.isNaN(ts)) {
		return ts;
	}
	return 0;
}

/**
 * Identify all branch leaves and compute branch metrics (from root to leaf).
 */
export function findBranchCandidates(entries: AnySessionEntry[]): BranchCandidate[] {
	const validEntries: AnySessionEntry[] = [];
	const byId = new Map<string, AnySessionEntry>();
	const childCount = new Map<string, number>();

	for (const entry of entries) {
		if (!entry || typeof entry.id !== "string" || !entry.id) continue;
		if (entry.type === "session") continue;
		validEntries.push(entry);
		byId.set(entry.id, entry);
	}

	for (const entry of validEntries) {
		const pid = typeof entry.parentId === "string" ? entry.parentId : null;
		if (pid && byId.has(pid)) {
			childCount.set(pid, (childCount.get(pid) ?? 0) + 1);
		}
	}

	const leaves: AnySessionEntry[] = [];
	for (const entry of validEntries) {
		const id = entry.id as string;
		if ((childCount.get(id) ?? 0) === 0) {
			leaves.push(entry);
		}
	}

	if (leaves.length === 0) return [];

	const candidates: BranchCandidate[] = [];

	for (const leaf of leaves) {
		const leafId = leaf.id as string;
		const path: AnySessionEntry[] = [];
		const visited = new Set<string>();
		let cur: string | null = leafId;

		while (cur !== null && byId.has(cur) && !visited.has(cur)) {
			visited.add(cur);
			const node: AnySessionEntry = byId.get(cur)!;
			path.push(node);
			cur = typeof node.parentId === "string" ? node.parentId : null;
		}

		path.reverse(); // root -> ... -> leaf

		let messageCount = 0;
		let lastMessageTimestamp = 0;

		for (const node of path) {
			if (node.type === "message") {
				messageCount += 1;
				const ts = parseEntryTimestamp(node.timestamp);
				if (ts > lastMessageTimestamp) {
					lastMessageTimestamp = ts;
				}
			}
		}

		const tailTimestamp = parseEntryTimestamp(leaf.timestamp);

		candidates.push({
			leafId,
			leafEntry: leaf,
			totalEntries: path.length,
			messageCount,
			lastMessageTimestamp,
			tailTimestamp,
			pathIds: path.map((n) => n.id as string),
		});
	}

	return candidates;
}

/**
 * Find the lowest common ancestor (LCA) entry ID of two branches.
 */
function findLowestCommonAncestor(branchA: BranchCandidate, branchB: BranchCandidate): string | null {
	const setA = new Set(branchA.pathIds);
	let lca: string | null = null;
	for (const id of branchB.pathIds) {
		if (setA.has(id)) {
			lca = id;
		} else {
			break;
		}
	}
	return lca;
}

/**
 * Select the best branch leaf from all branch candidates.
 *
 * If multiple leaves exist, compares the currently selected leaf against the candidate
 * pool. If the current leaf is on an abandoned metadata-only branch (e.g. extension
 * wrote to an older node after a completed task) or significantly lags behind the main
 * conversation in message count, selects the main branch leaf.
 */
export function selectBestSessionLeaf(
	entries: AnySessionEntry[],
	currentLeafId?: string | null,
): LeafCalibrationResult | null {
	const candidates = findBranchCandidates(entries);
	if (candidates.length === 0) return null;

	if (candidates.length === 1) {
		const single = candidates[0];
		return {
			bestLeafId: single.leafId,
			currentLeafId: currentLeafId ?? null,
			changed: currentLeafId !== undefined && currentLeafId !== null && currentLeafId !== single.leafId,
		};
	}

	// Sort candidates by preference:
	// 1. Message count (descending)
	// 2. Last message timestamp (descending)
	// 3. Total entry depth (descending)
	// 4. Leaf timestamp (descending)
	const sorted = [...candidates].sort((a, b) => {
		if (b.messageCount !== a.messageCount) return b.messageCount - a.messageCount;
		if (b.lastMessageTimestamp !== a.lastMessageTimestamp) return b.lastMessageTimestamp - a.lastMessageTimestamp;
		if (b.totalEntries !== a.totalEntries) return b.totalEntries - a.totalEntries;
		return b.tailTimestamp - a.tailTimestamp;
	});

	const bestCandidate = sorted[0];

	if (!currentLeafId) {
		return {
			bestLeafId: bestCandidate.leafId,
			currentLeafId: null,
			changed: true,
			reason: "No current leaf specified; selected deepest candidate",
		};
	}

	const currentCandidate = candidates.find((c) => c.leafId === currentLeafId);
	if (!currentCandidate) {
		return {
			bestLeafId: bestCandidate.leafId,
			currentLeafId,
			changed: true,
			reason: `Current leaf "${currentLeafId}" not found in branch leaves`,
		};
	}

	if (currentCandidate.leafId === bestCandidate.leafId) {
		return {
			bestLeafId: bestCandidate.leafId,
			currentLeafId,
			changed: false,
		};
	}

	// Check if current leaf is a hijacked/stale branch:
	const lca = findLowestCommonAncestor(currentCandidate, bestCandidate);
	const lcaIndexCurrent = lca ? currentCandidate.pathIds.indexOf(lca) : -1;
	const currentEntriesAfterLca = lcaIndexCurrent >= 0 ? currentCandidate.pathIds.slice(lcaIndexCurrent + 1) : [];

	const byId = new Map<string, AnySessionEntry>();
	for (const e of entries) {
		if (e && typeof e.id === "string") byId.set(e.id, e);
	}

	let currentMessagesAfterLca = 0;
	for (const id of currentEntriesAfterLca) {
		const node = byId.get(id);
		if (node?.type === "message") currentMessagesAfterLca += 1;
	}

	const lcaIndexBest = lca ? bestCandidate.pathIds.indexOf(lca) : -1;
	const bestEntriesAfterLca = lcaIndexBest >= 0 ? bestCandidate.pathIds.slice(lcaIndexBest + 1) : [];
	let bestMessagesAfterLca = 0;
	for (const id of bestEntriesAfterLca) {
		const node = byId.get(id);
		if (node?.type === "message") bestMessagesAfterLca += 1;
	}

	// Pattern A: Metadata-only branch hijacking (issue #567)
	// Current branch has 0 messages after LCA (only custom / extension metadata),
	// while best branch has real messages after LCA.
	if (currentMessagesAfterLca === 0 && bestMessagesAfterLca > 0) {
		return {
			bestLeafId: bestCandidate.leafId,
			currentLeafId,
			changed: true,
			reason: `Current branch has no messages after divergence (LCA=${lca}), while main branch has ${bestMessagesAfterLca} messages`,
		};
	}

	// Pattern B: Substantial message gap (stale branch restored after task completed elsewhere)
	if (bestCandidate.messageCount > currentCandidate.messageCount) {
		return {
			bestLeafId: bestCandidate.leafId,
			currentLeafId,
			changed: true,
			reason: `Main branch has ${bestCandidate.messageCount} messages vs current branch's ${currentCandidate.messageCount}`,
		};
	}

	// Otherwise, current branch has equal or valid intentional message history
	return {
		bestLeafId: currentCandidate.leafId,
		currentLeafId,
		changed: false,
	};
}

/**
 * Calibrate the active leaf of a SessionManager in memory.
 */
export function calibrateSessionLeaf(sessionManager: {
	getEntries(): AnySessionEntry[];
	getLeafId(): string | null;
	branch(id: string): void;
}): { changed: boolean; calibratedLeafId?: string; previousLeafId?: string | null; reason?: string } {
	try {
		const entries = sessionManager.getEntries();
		const currentLeafId = sessionManager.getLeafId();
		const result = selectBestSessionLeaf(entries, currentLeafId);
		if (result && result.changed && result.bestLeafId) {
			sessionManager.branch(result.bestLeafId);
			return {
				changed: true,
				calibratedLeafId: result.bestLeafId,
				previousLeafId: currentLeafId,
				reason: result.reason,
			};
		}
		return { changed: false, calibratedLeafId: currentLeafId ?? undefined };
	} catch (err) {
		return { changed: false, calibratedLeafId: sessionManager.getLeafId() ?? undefined, reason: String(err) };
	}
}

/**
 * Reorder entries topologically so that the main branch's leaf is at the tail of the transcript.
 *
 * Preserves all entries and valid parent-child relationships (every node still appears after
 * its parent). Side-branch metadata attached to older nodes is placed before the main branch's
 * continuing path so SDK SessionManager's sequential scan lands on the main branch leaf.
 */
export function reorderEntriesForMainBranch<T extends AnySessionEntry>(
	entries: T[],
): { entries: T[]; changed: boolean; reason?: string } {
	if (entries.length <= 1) return { entries, changed: false };

	const nonHeader = entries.filter((e) => e && e.type !== "session" && typeof e.id === "string");
	if (nonHeader.length <= 1) return { entries, changed: false };

	const tail = nonHeader[nonHeader.length - 1];
	const calibration = selectBestSessionLeaf(nonHeader, tail.id);
	if (!calibration || !calibration.changed || !calibration.bestLeafId) {
		return { entries, changed: false };
	}

	const bestLeafId = calibration.bestLeafId;
	const candidates = findBranchCandidates(nonHeader);
	const bestCandidate = candidates.find((c) => c.leafId === bestLeafId);
	if (!bestCandidate) return { entries, changed: false };

	const bestPathSet = new Set(bestCandidate.pathIds);

	// Separate entries into:
	// 1. Header (type === "session")
	// 2. Entries on the best path
	// 3. Entries on side branches
	const headerEntries: T[] = [];
	const sideEntries: T[] = [];
	const mainEntries: T[] = [];

	for (const e of entries) {
		if (e.type === "session") {
			headerEntries.push(e);
		} else if (e.id && bestPathSet.has(e.id)) {
			mainEntries.push(e);
		} else {
			sideEntries.push(e);
		}
	}

	// If no side entries exist or main entries are empty, nothing to reorder
	if (sideEntries.length === 0 || mainEntries.length === 0) {
		return { entries, changed: false };
	}

	// We want to interleave side entries after their respective parent in main entries,
	// BUT ensure that the continuation of the main branch ends with bestCandidate.leafId.
	// A robust topological sort:
	// Each side entry must come after its parent.
	// Since side branches branched off an ancestor in mainEntries, we can place side entries
	// as early as possible (immediately after their parent) so that the deep main branch entries
	// remain at the end of the file.
	const result: T[] = [...headerEntries];
	const placedIds = new Set<string>();
	const placedRefs = new Set<T>(headerEntries);

	// Helper to place a side entry and its side descendants
	const sideChildrenOf = new Map<string, T[]>();
	for (const s of sideEntries) {
		const pid = typeof s.parentId === "string" ? s.parentId : "";
		if (!pid) continue;
		let list = sideChildrenOf.get(pid);
		if (!list) {
			list = [];
			sideChildrenOf.set(pid, list);
		}
		list.push(s);
	}

	const canPlace = (entry: T): boolean => {
		if (placedRefs.has(entry)) return false;
		if (typeof entry.id === "string" && entry.id && placedIds.has(entry.id)) return false;
		return true;
	};

	const markPlaced = (entry: T) => {
		placedRefs.add(entry);
		if (typeof entry.id === "string" && entry.id) {
			placedIds.add(entry.id);
		}
	};

	const placeSideDescendants = (parentId: string) => {
		const children = sideChildrenOf.get(parentId);
		if (!children) return;
		for (const child of children) {
			if (canPlace(child)) {
				markPlaced(child);
				result.push(child);
				if (typeof child.id === "string" && child.id) {
					placeSideDescendants(child.id);
				}
			}
		}
	};

	for (const m of mainEntries) {
		markPlaced(m);
		result.push(m);
		if (typeof m.id === "string" && m.id) {
			placeSideDescendants(m.id);
		}
	}

	// Any dangling side entries (including valid JSON entries without an `id` field, #601)
	// are placed before the final main entry so that ZERO transcript lines are ever dropped.
	for (const s of sideEntries) {
		if (!placedRefs.has(s)) {
			markPlaced(s);
			// Insert before the last entry (which is the best leaf)
			if (result.length > headerEntries.length + 1) {
				result.splice(result.length - 1, 0, s);
			} else {
				result.push(s);
			}
		}
	}

	// Verify that no entries were lost (#601) and the new last non-header entry with id is bestLeafId
	if (result.length !== entries.length) {
		return { entries, changed: false };
	}
	const newNonHeader = result.filter((e) => e && e.type !== "session" && typeof e.id === "string");
	const newTail = newNonHeader[newNonHeader.length - 1];
	const successfullyReordered = newTail?.id === bestLeafId;

	if (!successfullyReordered) {
		// Fallback: don't alter if topological sort couldn't guarantee tail
		return { entries, changed: false };
	}

	return {
		entries: result,
		changed: true,
		reason: calibration.reason,
	};
}
