/**
 * 任务经验沉淀（D-12c 方向二）：一键把受控 Loop 的目标、验收结论、最优指标、各轮演化与关键改动
 * 归档为结构化 Markdown 知识卡片（落盘于 <dataDir>/knowledge/loop-<runId>.md 与 run 目录本身）。
 */
import fs from "node:fs";
import path from "node:path";
import type { LoopState } from "./extension.js";
import { runsRoot } from "./extension.js";

export interface DistillResult {
	ok: true;
	runId: string;
	filePath: string;
	markdown: string;
}

export function buildDistilledMarkdown(st: LoopState): string {
	const ws = st.baseWorkspace || st.workspace || "";
	const project = ws ? path.basename(ws) : "unknown";
	const metricsLine = st.lastMetrics
		? Object.entries(st.lastMetrics)
				.map(([k, v]) => `${k}=${v}`)
				.join(", ")
		: "";
	const bestLine = st.bestRound
		? `第 ${st.bestRound.round} 轮（${st.bestRound.verdict}${st.bestRound.commitSha ? ` · commit ${st.bestRound.commitSha}` : ""}${
				st.bestRound.snapshotRef ? ` · 快照 ${st.bestRound.snapshotRef}` : ""
			}${
				st.bestRound.metrics
					? ` · ${Object.entries(st.bestRound.metrics)
							.map(([k, v]) => `${k}=${v}`)
							.join(", ")}`
					: ""
			}）`
		: "";
	const lines: string[] = [
		`# 任务经验卡片 · ${st.runId}`,
		"",
		`- **项目**：${project}（\`${ws}\`）`,
		`- **状态**：${st.status}（stage=${st.stage}${st.acceptance ? `，acceptance=${st.acceptance}` : ""}${st.stopReason ? `，stopReason=${st.stopReason}` : ""}）`,
		`- **轮次**：${st.round}/${st.maxRounds}（mode=${st.mode}）`,
		`- **模型组合**：主模型 ${st.mainModel?.id ?? "—"} · 规划 ${st.plannerModel?.id ?? "—"} · 评审 ${st.reviewerModel?.id ?? "—"}`,
		st.precheckCmd ? `- **快速预检（L0）**：\`${st.precheckCmd}\`` : "",
		st.validateCmd ? `- **验收命令（L1）**：\`${st.validateCmd}\`` : "",
		metricsLine ? `- **最新指标**：${metricsLine}` : "",
		bestLine ? `- **最优 Checkpoint**：${bestLine}` : "",
		`- **时间**：${st.createdAt} → ${st.updatedAt ?? st.createdAt}`,
		"",
		"## 1. 目标与验收标准",
		"",
		st.goal,
		...(st.criteria ? ["", `**验收标准**：${st.criteria}`] : []),
		"",
		"## 2. 执行计划与自述总结",
		"",
		st.plan ? `**计划**：\n${st.plan}` : "",
		st.summary ? `\n**执行者总结**：\n${st.summary}` : "",
		"",
		"## 3. 评审结论",
		"",
		st.lastReview
			? `- **结论**：${st.lastReview.verdict}\n` +
				((st.lastReview.reasons ?? []).length ? (st.lastReview.reasons ?? []).map((r) => `  - ${r}`).join("\n") : "")
			: "- 未执行模型评审或已跳过",
		"",
		"## 4. 轮次演进记录",
		"",
		...(st.history?.length
			? st.history.map((h) => {
					const m = h.metrics
						? ` | metrics: ${Object.entries(h.metrics)
								.map(([k, v]) => `${k}=${v}`)
								.join(", ")}`
						: "";
					const sha = h.commitSha ? ` | sha: ${h.commitSha}` : "";
					const snap = h.snapshotRef ? ` | 快照: ${h.snapshotRef}` : "";
					return `- 第 ${h.round} 轮：${h.verdict}${h.code !== null ? ` (exit ${h.code})` : ""}${m}${sha}${snap} (${h.at})`;
				})
			: ["- 暂无轮次验证记录"]),
	];
	return (
		lines
			.filter((x) => x !== undefined)
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim() + "\n"
	);
}

export function distillLoopRun(st: LoopState, dataDir: string): DistillResult {
	const markdown = buildDistilledMarkdown(st);
	const knowledgeDir = path.join(dataDir, "knowledge");
	fs.mkdirSync(knowledgeDir, { recursive: true });
	const filePath = path.join(knowledgeDir, `loop-${st.runId}.md`);
	fs.writeFileSync(filePath, markdown, "utf8");
	try {
		const runFile = path.join(runsRoot(), st.runId, "distilled.md");
		fs.writeFileSync(runFile, markdown, "utf8");
	} catch {}
	return { ok: true, runId: st.runId, filePath, markdown };
}
