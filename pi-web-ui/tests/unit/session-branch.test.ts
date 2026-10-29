import { describe, expect, it } from "vitest";
import {
	calibrateSessionLeaf,
	findBranchCandidates,
	reorderEntriesForMainBranch,
	selectBestSessionLeaf,
	type AnySessionEntry,
} from "../../server/session-branch.js";

describe("session-branch (issue #567)", () => {
	it("returns unchanged for linear single-branch conversation", () => {
		const entries: AnySessionEntry[] = [
			{ id: "h1", type: "session" },
			{ id: "m1", parentId: null, type: "message", timestamp: "2026-10-08T10:00:00.000Z" },
			{ id: "m2", parentId: "m1", type: "message", timestamp: "2026-10-08T10:01:00.000Z" },
			{ id: "m3", parentId: "m2", type: "message", timestamp: "2026-10-08T10:02:00.000Z" },
		];

		const candidates = findBranchCandidates(entries);
		expect(candidates).toHaveLength(1);
		expect(candidates[0].leafId).toBe("m3");
		expect(candidates[0].messageCount).toBe(3);

		const result = selectBestSessionLeaf(entries, "m3");
		expect(result).not.toBeNull();
		expect(result?.bestLeafId).toBe("m3");
		expect(result?.changed).toBe(false);

		const reordered = reorderEntriesForMainBranch(entries);
		expect(reordered.changed).toBe(false);
	});

	it("detects and corrects metadata-only branch hijacking (issue #567)", () => {
		// Simulate the exact situation from issue #567:
		// 1. History up to m292 (id: "8775fb27")
		// 2. Phone completed task up to m557 (id: "c9560bdb")
		// 3. Computer reopened and appended custom plannotator entries branching off m292
		const entries: AnySessionEntry[] = [
			{ id: "h1", type: "session" },
			{ id: "m1", parentId: null, type: "message", timestamp: "2026-10-08T10:00:00.000Z" },
			{ id: "8775fb27", parentId: "m1", type: "message", timestamp: "2026-10-08T10:30:00.000Z" },
		];

		// Add phone's subsequent messages (m3..m557)
		let prev = "8775fb27";
		for (let i = 293; i <= 556; i++) {
			const id = `m${i}`;
			entries.push({
				id,
				parentId: prev,
				type: "message",
				timestamp: `2026-10-08T11:00:${String(i % 60).padStart(2, "0")}.000Z`,
			});
			prev = id;
		}
		// Phone's final response
		entries.push({
			id: "c9560bdb",
			parentId: prev,
			type: "message",
			timestamp: "2026-10-08T11:14:41.139Z",
		});

		// Appended extension custom entries branching from older 8775fb27
		entries.push({
			id: "plan-entry-1",
			parentId: "8775fb27",
			type: "custom",
			customType: "plannotator",
			timestamp: "2026-10-08T11:53:01.358Z",
		});
		entries.push({
			id: "plan-entry-2",
			parentId: "plan-entry-1",
			type: "custom",
			customType: "plannotator",
			timestamp: "2026-10-08T11:53:01.400Z",
		});

		// Default SDK behavior: file tail is "plan-entry-2"
		const currentTailId = "plan-entry-2";

		const candidates = findBranchCandidates(entries);
		expect(candidates).toHaveLength(2);

		const sideCand = candidates.find((c) => c.leafId === "plan-entry-2");
		const mainCand = candidates.find((c) => c.leafId === "c9560bdb");
		expect(sideCand?.messageCount).toBe(2); // m1 + 8775fb27
		expect(mainCand?.messageCount).toBe(267); // m1 + 8775fb27 + 264 intermediate + c9560bdb

		// Leaf calibration test
		const calibrated = selectBestSessionLeaf(entries, currentTailId);
		expect(calibrated?.changed).toBe(true);
		expect(calibrated?.bestLeafId).toBe("c9560bdb");
		expect(calibrated?.currentLeafId).toBe("plan-entry-2");

		// In-memory calibrateSessionLeaf mock
		let activeLeaf = currentTailId;
		const mockManager = {
			getEntries: () => entries,
			getLeafId: () => activeLeaf,
			branch: (newId: string) => {
				activeLeaf = newId;
			},
		};
		const memResult = calibrateSessionLeaf(mockManager);
		expect(memResult.changed).toBe(true);
		expect(memResult.calibratedLeafId).toBe("c9560bdb");
		expect(activeLeaf).toBe("c9560bdb");

		// Topological reordering test
		const reordered = reorderEntriesForMainBranch(entries);
		expect(reordered.changed).toBe(true);
		const nonHeader = reordered.entries.filter((e) => e.type !== "session");
		expect(nonHeader[nonHeader.length - 1].id).toBe("c9560bdb");

		// Ensure all entries are preserved
		expect(reordered.entries).toHaveLength(entries.length);
		expect(reordered.entries.find((e) => e.id === "plan-entry-1")).toBeDefined();
		expect(reordered.entries.find((e) => e.id === "plan-entry-2")).toBeDefined();

		// Ensure topological causal invariant: parent comes before child
		const indexMap = new Map<string, number>();
		reordered.entries.forEach((e, idx) => {
			if (e.id) indexMap.set(e.id, idx);
		});
		for (const e of reordered.entries) {
			if (e.parentId && indexMap.has(e.parentId)) {
				expect(indexMap.get(e.parentId)!).toBeLessThan(indexMap.get(e.id!)!);
			}
		}
	});

	it("preserves intentional branching with active message continuation", () => {
		const entries: AnySessionEntry[] = [
			{ id: "h1", type: "session" },
			{ id: "m1", parentId: null, type: "message", timestamp: "2026-10-08T10:00:00.000Z" },
			{ id: "m2", parentId: "m1", type: "message", timestamp: "2026-10-08T10:01:00.000Z" },
			// Old branch
			{ id: "m3_old", parentId: "m2", type: "message", timestamp: "2026-10-08T10:02:00.000Z" },
			{ id: "m4_old", parentId: "m3_old", type: "message", timestamp: "2026-10-08T10:03:00.000Z" },
			// User intentionally branched from m2 and sent new messages
			{ id: "m3_fork", parentId: "m2", type: "message", timestamp: "2026-10-08T10:05:00.000Z" },
			{ id: "m4_fork", parentId: "m3_fork", type: "message", timestamp: "2026-10-08T10:06:00.000Z" },
		];

		// If the user's current leaf is m4_fork, it should NOT be overridden
		// even though m4_old is an earlier branch with same message count
		const result = selectBestSessionLeaf(entries, "m4_fork");
		expect(result?.changed).toBe(false);
		expect(result?.bestLeafId).toBe("m4_fork");
	});

	it("selects deepest branch when no currentLeafId is provided", () => {
		const entries: AnySessionEntry[] = [
			{ id: "h1", type: "session" },
			{ id: "m1", parentId: null, type: "message", timestamp: "2026-10-08T10:00:00.000Z" },
			{ id: "m2_short", parentId: "m1", type: "message", timestamp: "2026-10-08T10:01:00.000Z" },
			{ id: "m2_long", parentId: "m1", type: "message", timestamp: "2026-10-08T10:02:00.000Z" },
			{ id: "m3_long", parentId: "m2_long", type: "message", timestamp: "2026-10-08T10:03:00.000Z" },
		];

		const result = selectBestSessionLeaf(entries, null);
		expect(result?.bestLeafId).toBe("m3_long");
		expect(result?.changed).toBe(true);
	});

	it("preserves valid JSON transcript entries without an id field during reordering (#601)", () => {
		const entries: AnySessionEntry[] = [
			{ type: "session", id: "sess_1", timestamp: "2026-10-08T10:00:00.000Z" },
			{ id: "m1", parentId: null, type: "message", timestamp: "2026-10-08T10:01:00.000Z" },
			// Valid JSON lines without an `id` field (e.g. third-party extension or manual repair)
			{ type: "custom_note", parentId: "m1", note: "attached-to-m1" },
			{ type: "DiagnosticLog", note: "dangling-no-id-no-parent" },
			{ id: "m2", parentId: "m1", type: "message", timestamp: "2026-10-08T10:02:00.000Z" },
			{ id: "m3", parentId: "m2", type: "message", timestamp: "2026-10-08T10:03:00.000Z" },
			// Metadata hijacking entry at the physical tail pointing to m1
			{ id: "ext_tail", parentId: "m1", type: "custom", timestamp: "2026-10-08T10:04:00.000Z" },
		];

		const reordered = reorderEntriesForMainBranch(entries);
		expect(reordered.changed).toBe(true);
		// Must never silently drop id-less entries
		expect(reordered.entries.length).toBe(entries.length);
		expect(reordered.entries).toContain(entries[2]);
		expect(reordered.entries).toContain(entries[3]);
		// Physical tail with id must still be the main branch leaf m3
		const nonHeaderWithId = reordered.entries.filter((e) => e.type !== "session" && typeof e.id === "string");
		expect(nonHeaderWithId[nonHeaderWithId.length - 1]?.id).toBe("m3");
	});
});
