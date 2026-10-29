/**
 * server/plan-manager.ts
 *
 * 结构化任务计划看板与步骤状态机（Plan Mode / Step State Machine）。
 *
 * 借鉴 DeepSeek Harness (DSH) 的 dsh-plan-mode：
 * 1. 任务步骤状态机（Step State Machine）：
 *    - 步骤字段：id, title, status ("pending" | "in_progress" | "done" | "failed"), description
 *    - 总体进度与当前执行中步骤
 * 2. 计划管理与更新（PlanManager）：
 *    - 模型可通过 customTool `plan_update` 更新
 *    - 客户端也可通过协议消息 `plan_update` 调整
 *    - 状态自动同步到快照 `UiState.plan`
 *
 * 存储模型与隔离设计（防新会话串台）：
 * - 持久化源（plansBySession）：以真实唯一的 SDK sessionId 为主键，落盘至 plans.json。
 * - 运行时缓存（plansByConv）：以会话槽位 conversationId 为主键，仅存活于进程内存，绝不落盘。
 * - 历史文件清洗：严格过滤形如 /^c\d+$/ 的易变短 ID，防止服务重启后新会话被上一个会话的任务附体。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PlanState, PlanStep, PlanStepStatus } from "./protocol.js";

const VALID_STATUSES = new Set<PlanStepStatus>(["pending", "in_progress", "done", "failed"]);

/** 判断是否为易变的临时 conversationId（如 c1, c2, c99 等）。此类短 ID 绝不入持久化文件。 */
function isEphemeralConvId(id: string): boolean {
	return /^c\d+$/.test(id);
}

export class PlanManager {
	/** 按持久化 sessionId 存储的真实计划状态（落盘至 plans.json）。 */
	private plansBySession = new Map<string, PlanState>();
	/** 按运行时 conversationId 存储的临时计划缓存（进程内存态，不落盘）。 */
	private plansByConv = new Map<string, PlanState>();
	/** conversationId 到 sessionId 的映射。 */
	private convToSession = new Map<string, string>();

	constructor(private readonly filePath?: string) {
		if (filePath) {
			this.load();
		}
	}

	private load(): void {
		if (!this.filePath) return;
		try {
			const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, unknown>;
			for (const [key, val] of Object.entries(raw)) {
				// 严格过滤：形如 c1, c2 的临时 conversationId 绝不作为持久化会话键载入，
				// 防止服务重启或历史残留时污染新分配的相同 ID 对话。
				if (isEphemeralConvId(key)) continue;
				if (val && typeof val === "object" && Array.isArray((val as { steps?: unknown }).steps)) {
					this.plansBySession.set(key, val as PlanState);
				}
			}
		} catch {
			// 文件不存在或格式异常，以空状态起步
		}
	}

	private save(): void {
		if (!this.filePath) return;
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
			const obj: Record<string, PlanState> = {};
			for (const [k, v] of this.plansBySession.entries()) {
				// 双重防护：临时 conversationId 绝不落盘
				if (isEphemeralConvId(k)) continue;
				obj[k] = v;
			}
			const tmp = `${this.filePath}.tmp.${Date.now()}`;
			writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
			renameSync(tmp, this.filePath);
		} catch {
			// 持久化失败绝不阻断主流程
		}
	}

	/** 绑定 conversationId 与 sessionId。若 sessionId 已有落盘计划，立即恢复给 conversationId。 */
	bindSession(conversationId: string, sessionId: string): PlanState | null {
		this.convToSession.set(conversationId, sessionId);
		// 绑定（或重新绑定）session 时，先清除当前 conversationId 上次残留的内存状态
		this.plansByConv.delete(conversationId);
		const existing = this.plansBySession.get(sessionId);
		if (existing) {
			this.plansByConv.set(conversationId, existing);
			return existing;
		}
		// 绝不从 conversationId 逆向污染全新 sessionId！全新会话以空状态起步。
		return null;
	}

	/** 解绑并清理指定 conversationId 的运行时内存计划与映射（在会话移除/销毁时调用）。 */
	unbindConversation(conversationId: string): void {
		this.plansByConv.delete(conversationId);
		this.convToSession.delete(conversationId);
	}

	/** 获取指定会话的计划状态。优先使用 conversationId，若无则回退查找绑定的 sessionId。 */
	getPlan(id: string): PlanState | null {
		const directConv = this.plansByConv.get(id);
		if (directConv) return directConv;
		const sessionId = this.convToSession.get(id);
		if (sessionId) {
			const bySession = this.plansBySession.get(sessionId);
			if (bySession) {
				this.plansByConv.set(id, bySession);
				return bySession;
			}
		}
		// 兼容以 sessionId 直接查询
		const directSession = this.plansBySession.get(id);
		if (directSession) return directSession;
		return null;
	}

	/** 设置/全量更新指定会话的计划（可选绑定 sessionId 进行稳定落盘）。 */
	setPlan(conversationId: string, steps: PlanStep[], activeStepId?: string | null, sessionId?: string): PlanState {
		const normalizedSteps: PlanStep[] = (Array.isArray(steps) ? steps : []).map((s, idx) => {
			const status = (VALID_STATUSES.has(s.status) ? s.status : "pending") as PlanStepStatus;
			return {
				id: String(s.id || `step-${idx + 1}`),
				title: String(s.title || "").slice(0, 200),
				status,
				...(s.description ? { description: String(s.description).slice(0, 1000) } : {}),
			};
		});

		// 自动推断 activeStepId：优先显式传参；否则推断第一个 in_progress 的步骤
		let effectiveActiveId = activeStepId;
		if (effectiveActiveId === undefined) {
			const inProg = normalizedSteps.find((s) => s.status === "in_progress");
			effectiveActiveId = inProg ? inProg.id : null;
		}

		const state: PlanState = {
			steps: normalizedSteps,
			activeStepId: effectiveActiveId,
			updatedAt: Date.now(),
		};

		this.plansByConv.set(conversationId, state);

		const effectiveSessionId = sessionId ?? this.convToSession.get(conversationId);
		if (effectiveSessionId) {
			this.convToSession.set(conversationId, effectiveSessionId);
			if (normalizedSteps.length === 0) {
				this.plansBySession.delete(effectiveSessionId);
			} else {
				this.plansBySession.set(effectiveSessionId, state);
			}
			this.save();
		}

		return state;
	}

	/** 增量更新单个步骤的状态或内容。 */
	updateStep(conversationId: string, stepId: string, patch: Partial<PlanStep>): PlanState | null {
		const current = this.getPlan(conversationId);
		if (!current) return null;

		const idx = current.steps.findIndex((s) => s.id === stepId);
		if (idx === -1) return null;

		const currentStep = current.steps[idx];
		const nextStatus = patch.status && VALID_STATUSES.has(patch.status) ? patch.status : currentStep.status;

		// patch 里剥掉 id：步骤 id 是 activeStepId / first-match 推进的锚点，
		// 被改掉会让 activeStepId 悬空（指向不存在的步骤）。
		const { id: _ignored, ...rest } = patch;
		const nextStep: PlanStep = {
			...currentStep,
			...rest,
			status: nextStatus,
			// title/description 与 setPlan 同口径截断（200/1000），防超长内容撑爆快照。
			title: String(rest.title ?? currentStep.title ?? "").slice(0, 200),
		};
		const description = String(rest.description ?? currentStep.description ?? "").slice(0, 1000);
		if (description) nextStep.description = description;
		else delete nextStep.description;

		const nextSteps = [...current.steps];
		nextSteps[idx] = nextStep;

		let nextActive = current.activeStepId;
		if (patch.status === "in_progress") {
			nextActive = stepId;
		} else if (current.activeStepId === stepId && patch.status) {
			// 当前活动步骤已完成或失败，自动推进到下一个待执行步骤
			const nextPending = nextSteps.find((s) => s.status === "pending" || s.status === "in_progress");
			nextActive = nextPending ? nextPending.id : null;
		}

		const nextState: PlanState = {
			steps: nextSteps,
			activeStepId: nextActive,
			updatedAt: Date.now(),
		};

		this.plansByConv.set(conversationId, nextState);
		const sessId = this.convToSession.get(conversationId);
		if (sessId) {
			this.plansBySession.set(sessId, nextState);
			this.save();
		}
		return nextState;
	}

	/** 增量删除单个步骤。 */
	deleteStep(conversationId: string, stepId: string): PlanState | null {
		const current = this.getPlan(conversationId);
		if (!current) return null;

		const idx = current.steps.findIndex((s) => s.id === stepId);
		if (idx === -1) return current;

		const nextSteps = current.steps.filter((s) => s.id !== stepId);
		let nextActive = current.activeStepId;
		if (current.activeStepId === stepId) {
			const nextPending = nextSteps.find((s) => s.status === "pending" || s.status === "in_progress");
			nextActive = nextPending ? nextPending.id : null;
		}

		const nextState: PlanState = {
			steps: nextSteps,
			activeStepId: nextActive,
			updatedAt: Date.now(),
		};

		this.plansByConv.set(conversationId, nextState);
		const sessId = this.convToSession.get(conversationId);
		if (sessId) {
			this.plansBySession.set(sessId, nextState);
			this.save();
		}
		return nextState;
	}

	/** 增量新增步骤。 */
	addStep(conversationId: string, step: PlanStep, afterStepId?: string): PlanState | null {
		const current = this.getPlan(conversationId);
		const existingSteps = current?.steps ?? [];

		const normalized: PlanStep = {
			id: String(step.id ?? `step-${Date.now()}`),
			title: String(step.title ?? "").slice(0, 200),
			status: step.status && VALID_STATUSES.has(step.status) ? step.status : "pending",
		};
		const description = String(step.description ?? "").slice(0, 1000);
		if (description) normalized.description = description;

		let nextSteps: PlanStep[];
		if (afterStepId) {
			const idx = existingSteps.findIndex((s) => s.id === afterStepId);
			if (idx !== -1) {
				nextSteps = [...existingSteps.slice(0, idx + 1), normalized, ...existingSteps.slice(idx + 1)];
			} else {
				nextSteps = [...existingSteps, normalized];
			}
		} else {
			nextSteps = [...existingSteps, normalized];
		}

		let nextActive = current?.activeStepId ?? null;
		if (!nextActive && normalized.status === "in_progress") {
			nextActive = normalized.id;
		}

		const nextState: PlanState = {
			steps: nextSteps,
			activeStepId: nextActive,
			updatedAt: Date.now(),
		};

		this.plansByConv.set(conversationId, nextState);
		const sessId = this.convToSession.get(conversationId);
		if (sessId) {
			this.plansBySession.set(sessId, nextState);
			this.save();
		}
		return nextState;
	}

	/** 清除指定会话的计划。 */
	clearPlan(conversationId: string): void {
		this.plansByConv.delete(conversationId);
		const sessId = this.convToSession.get(conversationId);
		if (sessId) {
			this.plansBySession.delete(sessId);
			this.convToSession.delete(conversationId);
		}
		this.save();
	}

	/** 格式化计划为简洁文本，供模型上下文或诊断使用。 */
	describePlan(conversationId: string): string {
		const plan = this.getPlan(conversationId);
		if (!plan || plan.steps.length === 0) return "No active plan.";

		const doneCount = plan.steps.filter((s) => s.status === "done").length;
		const total = plan.steps.length;
		const lines = [`Plan Progress: ${doneCount}/${total} completed`];

		for (let i = 0; i < plan.steps.length; i++) {
			const s = plan.steps[i];
			const icon =
				s.status === "done" ? "[x]" : s.status === "in_progress" ? "[>]" : s.status === "failed" ? "[!]" : "[ ]";
			const activeTag = s.id === plan.activeStepId ? " (current)" : "";
			lines.push(`${icon} ${i + 1}. ${s.title}${activeTag}`);
			if (s.description) {
				lines.push(`     ${s.description}`);
			}
		}

		return lines.join("\n");
	}
}
