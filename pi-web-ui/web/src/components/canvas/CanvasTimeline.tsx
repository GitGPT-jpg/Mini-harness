import { useMemo } from "react";
import type { CanvasEdge, CanvasNode, CanvasNodeLogEntry } from "../../types";

interface Props {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	logs: Record<string, CanvasNodeLogEntry[]>;
	onRunNode: (id: string) => void;
	onLocate: (id: string) => void;
}

/** P1：执行时间线 — 用节点日志起止时间估算耗时，用 currentLoopCount/现状展示重试 */
export function CanvasTimeline({ nodes, edges, logs, onRunNode, onLocate }: Props) {
	const rows = useMemo(() => {
		const loopByTarget = new Map<string, number>();
		edges.forEach((e) => {
			if (e.currentLoopCount) loopByTarget.set(e.targetNodeId, e.currentLoopCount);
		});
		return nodes.map((n) => {
			const entries = logs[n.id] ?? [];
			const ts = entries.map((e) => e.ts).filter(Boolean);
			const start = ts.length > 0 ? Math.min(...ts) : null;
			const end = ts.length > 0 ? Math.max(...ts) : null;
			const dur = start != null && end != null ? Math.max(0, end - start) : null;
			const errs = entries.filter((e) => e.kind === "error").length;
			const lastErr = [...entries].reverse().find((e) => e.kind === "error")?.text ?? n.error ?? "";
			return { node: n, count: entries.length, start, end, dur, errs, lastErr, loops: loopByTarget.get(n.id) ?? 0 };
		});
	}, [nodes, edges, logs]);
	const fmtDur = (ms: number) =>
		ms < 1000
			? `${ms}ms`
			: ms < 60000
				? `${(ms / 1000).toFixed(1)}s`
				: `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
	const fmtTime = (t: number) => new Date(t).toLocaleTimeString();
	const failed = rows.filter((r) => r.node.status === "error");
	return (
		<div className="canvas-timeline">
			<div className="canvas-timeline-head">
				<b>执行时间线</b>
				<span className="canvas-timeline-meta">
					{nodes.length}节点 · {failed.length}失败 · {rows.reduce((a, r) => a + r.count, 0)}条日志
				</span>
				{failed.length > 0 && (
					<button
						type="button"
						className="canvas-btn primary"
						onClick={() => failed.forEach((r) => onRunNode(r.node.id))}
					>
						重试全部失败 ({failed.length})
					</button>
				)}
			</div>
			<div className="canvas-timeline-list">
				{rows.map((r) => (
					<div key={r.node.id} className={`canvas-timeline-row st-${r.node.status}`}>
						<span className="canvas-timeline-dot" />
						<button
							type="button"
							className="canvas-timeline-title"
							onClick={() => onLocate(r.node.id)}
							title="定位到节点"
						>
							{r.node.title}
						</button>
						<span className="canvas-timeline-sub">
							{r.node.status}
							{r.loops > 0 ? ` · 循环${r.loops}轮` : ""}
							{r.count > 0 ? ` · ${r.count}条` : " · 无日志"}
							{r.dur != null ? ` · ${fmtDur(r.dur)}` : ""}
							{r.start != null ? ` · ${fmtTime(r.start)}` : ""}
						</span>
						{r.node.status === "error" && (
							<button
								type="button"
								className="canvas-btn"
								onClick={() => onRunNode(r.node.id)}
								title={r.lastErr || "重试该节点"}
							>
								重试
							</button>
						)}
					</div>
				))}
				{rows.length === 0 && <div className="canvas-timeline-empty">暂无节点</div>}
			</div>
		</div>
	);
}
