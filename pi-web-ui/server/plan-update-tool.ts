/**
 * plan_update customTool：结构化任务执行计划更新工具（Plan Mode / Step State Machine）。
 *
 * 跟踪决策就绪步骤、文件改动清单（File Touch List）与状态机流转。
 * 从 agent-service.ts 抽出为独立模块。
 */
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PlanState, PlanStep, ServerMessage } from "./protocol.js";
import type { PlanManager } from "./plan-manager.js";
import { PLAN_UPDATE_TOOL_NAME } from "./tool-manager.js";

/**
 * 将 SoL-Pi 的 update_plan 步骤结构（{ id, goal, status }）标准化为 pi-web-ui 的 PlanStep[] 结构。
 */
export function normalizeSolPlanToPlanSteps(steps: unknown[]): {
	steps: PlanStep[];
	activeStepId?: string | null;
} {
	if (!Array.isArray(steps)) return { steps: [] };
	let activeStepId: string | null = null;
	const normalizedSteps: PlanStep[] = steps.map((s, idx) => {
		const step = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
		const id = typeof step.id === "string" && step.id ? step.id : String(idx + 1);
		const rawTitle =
			typeof step.goal === "string" ? step.goal : typeof step.title === "string" ? step.title : `Step ${id}`;
		const rawStatus = typeof step.status === "string" ? step.status : "pending";
		let status: "pending" | "in_progress" | "done" | "failed" = "pending";
		if (rawStatus === "completed" || rawStatus === "done") {
			status = "done";
		} else if (rawStatus === "in_progress") {
			status = "in_progress";
			if (!activeStepId) activeStepId = id;
		} else if (rawStatus === "failed") {
			status = "failed";
		}
		const description = typeof step.description === "string" ? step.description : undefined;
		return { id, title: rawTitle, status, ...(description ? { description } : {}) };
	});
	return { steps: normalizedSteps, activeStepId };
}

/**
 * 结构化任务执行计划更新工具（plan_update）— Plan Mode / Step State Machine。
 */
export function makePlanUpdateTool(
	planManager: PlanManager,
	getActiveConvTarget: () => string | { id: string; sessionId?: string; sessionManager?: unknown },
	emit: (msg: ServerMessage) => void,
	flushSnapshot: () => void,
	onPersist?: (convId: string, plan: PlanState) => void,
): ToolDefinition {
	return {
		name: PLAN_UPDATE_TOOL_NAME,
		label: "plan_update",
		description:
			"Update the structured task plan / step state machine (Plan Mode) and track progress (pending -> in_progress -> done/failed).",
		promptSnippet: "track decision-ready steps, file touch list, and live status",
		promptGuidelines: [
			"Use plan_update early on non-trivial tasks to outline decision-ready steps before coding",
			"Per step: discovery conclusions, files to be touched (File Touch List), rollback strategy",
			"Update step status as work progresses for real-time visibility",
		],
		parameters: Type.Object({
			steps: Type.Array(
				Type.Object({
					id: Type.String({ description: "Unique step ID, e.g. '1', 'step-1'" }),
					title: Type.String({ description: "Short step title" }),
					status: Type.Optional(
						Type.Unsafe<"pending" | "in_progress" | "done" | "failed">({
							type: "string",
							enum: ["pending", "in_progress", "done", "failed"],
							description: "Step status: pending | in_progress | done | failed (default: pending)",
						}),
					),
					description: Type.Optional(
						Type.String({
							description: "Optional step detail: acceptance criteria, files touched, rollback note.",
						}),
					),
				}),
				{ description: "List of plan steps" },
			),
			activeStepId: Type.Optional(Type.String({ description: "ID of the step currently being executed" })),
		}),
		execute: async (toolCallId: string, params: unknown) => {
			const target = getActiveConvTarget();
			const convId = typeof target === "string" ? target : target.id;
			const sessionId = typeof target === "string" ? undefined : target.sessionId;
			const p = params as { steps: PlanStep[]; activeStepId?: string | null };
			const plan = planManager.setPlan(convId, p.steps, p.activeStepId, sessionId);
			if (typeof target !== "string" && target.sessionManager) {
				try {
					const sm = target.sessionManager as { appendCustomEntry?: (type: string, data: unknown) => void };
					sm?.appendCustomEntry?.("plan/update", { plan });
				} catch {
					// 转录追加失败不影响主流程
				}
			}
			onPersist?.(convId, plan);
			emit({
				type: "plan_updated",
				conversationId: convId,
				plan,
			});
			flushSnapshot();
			const summary = planManager.describePlan(convId);
			return {
				content: [{ type: "text", text: `Plan updated successfully.\n\n${summary}` }],
				details: { plan },
			};
		},
	};
}
