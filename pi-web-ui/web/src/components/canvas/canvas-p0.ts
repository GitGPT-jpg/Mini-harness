import type { CanvasEdge, CanvasNode } from "../../types";

/** P0 小助手：分层自动布局 + 歷史快照（轻量，不引新依赖） */
export function autoLayout(nodes: CanvasNode[], edges: CanvasEdge[]): CanvasNode[] {
	const W = 300;
	const H = 220;
	const indeg = new Map<string, number>();
	nodes.forEach((n) => indeg.set(n.id, 0));
	edges.forEach((e) => indeg.set(e.targetNodeId, (indeg.get(e.targetNodeId) ?? 0) + 1));
	// BFS 分层
	const layers = new Map<string, number>();
	const queue: string[] = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
	if (queue.length === 0 && nodes.length > 0) queue.push(nodes[0].id);
	const adj = new Map<string, string[]>();
	edges.forEach((e) => {
		if (!adj.has(e.sourceNodeId)) adj.set(e.sourceNodeId, []);
		adj.get(e.sourceNodeId)!.push(e.targetNodeId);
	});
	queue.forEach((id) => layers.set(id, 0));
	const visited = new Set(queue);
	while (queue.length > 0) {
		const cur = queue.shift()!;
		const depth = layers.get(cur) ?? 0;
		for (const nxt of adj.get(cur) ?? []) {
			if (!visited.has(nxt)) {
				visited.add(nxt);
				layers.set(nxt, depth + 1);
				queue.push(nxt);
			}
		}
	}
	// 未连通的节点按原顺序追加层
	nodes.forEach((n, i) => {
		if (!layers.has(n.id)) layers.set(n.id, Math.floor(i / 3));
	});
	const byLayer = new Map<number, string[]>();
	layers.forEach((l, id) => {
		if (!byLayer.has(l)) byLayer.set(l, []);
		byLayer.get(l)!.push(id);
	});
	const pos = new Map<string, { x: number; y: number }>();
	[...byLayer.entries()]
		.sort((a, b) => a[0] - b[0])
		.forEach(([l, ids]) => {
			ids.forEach((id, idx) => {
				pos.set(id, { x: 80 + l * (W + 60), y: 80 + idx * (H + 40) });
			});
		});
	return nodes.map((n) => ({ ...n, x: pos.get(n.id)?.x ?? n.x, y: pos.get(n.id)?.y ?? n.y }));
}

export interface GraphSnap {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
}

/** 有界撤销栈 */
export class HistoryStack {
	private past: GraphSnap[] = [];
	private future: GraphSnap[] = [];
	constructor(private limit = 50) {}
	push(s: GraphSnap) {
		this.past.push(structuredClone(s));
		if (this.past.length > this.limit) this.past.shift();
		this.future = [];
	}
	undo(cur: GraphSnap): GraphSnap | null {
		const prev = this.past.pop();
		if (!prev) return null;
		this.future.push(structuredClone(cur));
		return prev;
	}
	redo(cur: GraphSnap): GraphSnap | null {
		const nxt = this.future.pop();
		if (!nxt) return null;
		this.past.push(structuredClone(cur));
		return nxt;
	}
	get canUndo() {
		return this.past.length > 0;
	}
	get canRedo() {
		return this.future.length > 0;
	}
}
