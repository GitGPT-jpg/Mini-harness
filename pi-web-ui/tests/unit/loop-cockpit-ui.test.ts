// @vitest-environment jsdom
/**
 * 驾驶舱统一任务入口（D-12-4）：输入框上沿只剩一枚「新任务」胶囊，点开统一任务弹窗 TaskModal。
 * - 目标条折叠态画一枚胶囊；任一驾驶舱弹层（新任务 / 连接集群 / 任务台 / 任务详情）打开时收起，关掉恢复；
 * - 目标模式关掉（目标条不渲染）时 LoopBar 补一枚同款胶囊，入口不丢；
 * - 弹窗三种验收方式各自露出对应字段，并发出对应的 WS 消息（只断言 appSend 收到的消息，不碰模型）。
 * 成果与证据查看器（D-12-3）：LoopBar 的人话状态与终态动作、任务详情面板、任务台的代码 loop 行。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { GoalBar } from "../../web/src/components/GoalBar.js";
import { LoopBar } from "../../web/src/components/LoopBar.js";
import { RunDetailModal } from "../../web/src/components/RunDetailModal.js";
import { TaskDesk } from "../../web/src/components/TaskDesk.js";
import { TaskModal } from "../../web/src/components/TaskModal.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { setAppSend } from "../../web/src/app-globals.js";
import {
	closeCluster,
	closeRunDetail,
	closeTaskDesk,
	closeTaskModal,
	openCluster,
	openRunDetail,
	openTaskDesk,
	openTaskModal,
} from "../../web/src/loop-cockpit.js";
import type { ClientMessage, GoalStatus, LoopUiState } from "../../web/src/types.js";
import type { LoopRunBrief, LoopRunDetail } from "../../server/loop/routes.js";

const goal = {
	conversationId: "c1",
	goal: null,
	reviewModel: null,
	maxRounds: 3,
	locked: false,
	execModel: null,
	reviewing: false,
	round: 0,
	status: "",
	verdict: "pending",
	wizard: null,
} as unknown as GoalStatus;

const MODELS = [
	{ provider: "oneapi", id: "glm-4.6", family: "glm" },
	{ provider: "other", id: "glm-4.5", family: "glm" },
	{ provider: "oneapi", id: "qwen3", family: "qwen" },
	{ provider: "oneapi", id: "deepseek-v4", family: "deepseek" },
];

const PACKS = [
	{
		id: "inference-perf",
		title: "推理性能（吞吐最大化）",
		summary: "以 tps 为主指标的吞吐优化任务",
		goal: "优化推理吞吐",
		criteria: "tps 越大越好",
		primaryMetric: "tps",
		metricDirection: "maximize",
		maxRounds: 6,
		useReviewer: true,
	},
];

let root: Root | null = null;
let sent: ClientMessage[] = [];

function mount(node: ReturnType<typeof createElement>): HTMLElement {
	localStorage.setItem("pi-web-ui:lang", "zh");
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(createElement(LanguageProvider, null, node));
	});
	return container;
}

const goalBar = () => createElement(GoalBar, { goal, activeConversationId: "c1" });
const taskModal = (goalModeEnabled = true) =>
	createElement(TaskModal, {
		goal,
		mainModel: { id: "glm-4.6", name: "GLM-4.6", provider: "oneapi" },
		goalModeEnabled,
	});

const capsules = (c: ParentNode) =>
	Array.from(c.querySelectorAll(".goalbar-collapsed .loop-capsule")).map((b) => b.textContent?.trim());

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

function click(el: Element | null) {
	act(() => {
		el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

/** React 受控输入：走原生 setter 再派发 input/change，onChange 才收得到。 */
function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null, value: string) {
	if (!el) throw new Error("field missing");
	const proto = Object.getPrototypeOf(el) as object;
	act(() => {
		Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
		el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
	});
}

async function openModal() {
	await act(async () => {
		openTaskModal();
		await new Promise((r) => setTimeout(r, 0));
	});
}

const startBtn = () => $<HTMLButtonElement>(".task-modal .cockpit-row .btn.primary");

beforeEach(() => {
	sent = [];
	setAppSend((msg) => {
		sent.push(msg);
		return true;
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, json: async () => ({ models: MODELS }) })),
	);
});

afterEach(() => {
	act(() => {
		root?.unmount();
		closeTaskModal();
		closeCluster();
		closeTaskDesk();
		closeRunDetail();
	});
	root = null;
	setAppSend(null);
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
	document.body.innerHTML = "";
});
describe("「新任务」胶囊", () => {
	it("目标条折叠态只画一枚「新任务」胶囊", () => {
		const c = mount(goalBar());
		expect(capsules(c)).toEqual(["新任务"]);
		expect(c.querySelector(".loop-capsule.task")?.getAttribute("title")).toContain("验收方式");
		// 旧的 LLM loop 内联编辑器不在了
		expect(c.querySelector(".goalbar-input")).toBeNull();
	});

	it("任一驾驶舱弹层打开时收起，关掉恢复；点胶囊 = 打开新任务弹窗", () => {
		const c = mount(goalBar());
		act(() => openCluster());
		expect(capsules(c)).toEqual([]);
		act(() => closeCluster());
		expect(capsules(c)).toHaveLength(1);
		act(() => openTaskDesk());
		expect(capsules(c)).toEqual([]);
		act(() => closeTaskDesk());
		act(() => openRunDetail("20261030120000-aaa111"));
		expect(capsules(c)).toEqual([]);
		act(() => closeRunDetail());
		expect(capsules(c)).toHaveLength(1);
		click(c.querySelector(".loop-capsule.task"));
		expect(capsules(c)).toEqual([]);
		act(() => closeTaskModal());
		expect(capsules(c)).toEqual(["新任务"]);
	});

	it("目标模式关掉时 LoopBar 补一枚同款胶囊；开着时不重复画", () => {
		const off = mount(createElement(LoopBar, { loop: null, goalModeEnabled: false }));
		expect(capsules(off)).toEqual(["新任务"]);
		act(() => root?.unmount());
		const on = mount(createElement(LoopBar, { loop: null, goalModeEnabled: true }));
		expect(on.querySelectorAll(".loop-capsule")).toHaveLength(0);
	});
});

describe("新任务弹窗：验收方式三选一", () => {
	it("默认「代码验证 + 模型评审」：规划/评审两只下拉 + 检查命令；开始键等「做什么」填了才亮", async () => {
		mount(taskModal());
		await openModal();
		const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="task-accept"]'));
		expect(radios.map((r) => r.value)).toEqual(["code-review", "code", "llm"]);
		expect(radios[0]!.checked).toBe(true);
		expect($("#task-planner")).not.toBeNull();
		expect($("#task-reviewer")).not.toBeNull();
		expect($("#task-cmd")).not.toBeNull();
		expect($(".task-refine")).toBeNull();
		expect(startBtn()!.disabled).toBe(true);
		setValue($("#task-goal"), "修复单测");
		expect(startBtn()!.disabled).toBe(false);
	});

	it("同厂商的规划 + 评审 → 冲突提示、开始键置灰", async () => {
		mount(taskModal());
		await openModal();
		setValue($("#task-goal"), "修复单测");
		setValue($("#task-planner"), "oneapi/qwen3");
		setValue($("#task-reviewer"), "oneapi/qwen3");
		expect($(".cockpit-model-note.bad")!.textContent).toContain("规划模型与审查模型同属 qwen 家族");
		expect(startBtn()!.disabled).toBe(true);
		// 执行显式选 GLM-4.6 后，审查选同家族（换 provider 也算同家族）→ 执行 / 审查冲突
		setValue($("#task-executor"), "oneapi/glm-4.6");
		setValue($("#task-reviewer"), "other/glm-4.5");
		expect($(".cockpit-model-note.bad")!.textContent).toContain("执行模型与审查模型同属 glm 家族");
		expect(startBtn()!.disabled).toBe(true);
		setValue($("#task-reviewer"), "oneapi/deepseek-v4");
		expect($(".cockpit-model-note.bad")).toBeNull();
		expect(startBtn()!.disabled).toBe(false);
	});

	it("代码验证 + 模型评审 → loop_start_request（mode=code，useReviewer=true）", async () => {
		mount(taskModal());
		await openModal();
		setValue($("#task-goal"), "修复单测");
		setValue($("#task-criteria"), "npm test 退出码 0");
		setValue($("#task-reviewer"), "oneapi/qwen3");
		click(startBtn());
		expect(sent).toEqual([
			{
				type: "loop_start_request",
				goal: "修复单测",
				mode: "code",
				maxRounds: 5,
				criteria: "npm test 退出码 0",
				executorModel: "auto",
				useReviewer: true,
				reviewerModel: "oneapi/qwen3",
				worktree: true,
			},
		]);
		expect($(".task-modal")).toBeNull();
	});

	it("仅代码验证 → 评审下拉收起，默认隔离可显式关闭", async () => {
		mount(taskModal());
		await openModal();
		click($('input[name="task-accept"][value="code"]'));
		expect($("#task-reviewer")).toBeNull();
		expect($("#task-cmd")).not.toBeNull();
		setValue($("#task-goal"), "跑测试直到通过");
		setValue($("#task-cmd"), "npm test");
		click($("#task-worktree"));
		click(startBtn());
		expect(sent).toEqual([
			{
				type: "loop_start_request",
				goal: "跑测试直到通过",
				mode: "code",
				maxRounds: 5,
				validateCmd: "npm test",
				executorModel: "auto",
				useReviewer: false,
				worktree: false,
			},
		]);
	});

	it("高级项填主指标/方向/精度 → loop_start_request 带 primaryMetric/metricDirection/metricPrecision", async () => {
		mount(taskModal());
		await openModal();
		setValue($("#task-goal"), "优化吞吐");
		setValue($("#task-metric"), "tps");
		setValue($("#task-metric-dir"), "maximize");
		setValue($("#task-metric-prec"), "0.5");
		click(startBtn());
		expect(sent).toEqual([
			{
				type: "loop_start_request",
				goal: "优化吞吐",
				mode: "code",
				maxRounds: 5,
				executorModel: "auto",
				useReviewer: true,
				primaryMetric: "tps",
				metricDirection: "maximize",
				metricPrecision: 0.5,
				worktree: true,
			},
		]);
	});

	it("能力模板一键填充 → 只发送语义字段，不注入命令或产物路径", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, json: async () => ({ models: MODELS, packs: PACKS }) })),
		);
		mount(taskModal());
		await openModal();
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		const packSel = $<HTMLSelectElement>("#task-pack");
		expect(packSel).not.toBeNull();
		setValue(packSel, "inference-perf");
		expect(($("#task-metric") as HTMLInputElement).value).toBe("tps");
		expect(($("#task-metric-dir") as HTMLSelectElement).value).toBe("maximize");
		click(startBtn());
		expect(sent).toEqual([
			{
				type: "loop_start_request",
				goal: "优化推理吞吐",
				mode: "code",
				maxRounds: 6,
				criteria: "tps 越大越好",
				executorModel: "auto",
				useReviewer: true,
				primaryMetric: "tps",
				metricDirection: "maximize",
				packId: "inference-perf",
				worktree: true,
			},
		]);
	});

	it("仅模型评审 → 先 set_goal_prefs 再 set_goal（验收标准并进目标正文）", async () => {
		mount(taskModal());
		await openModal();
		click($('input[name="task-accept"][value="llm"]'));
		expect($("#task-cmd")).toBeNull();
		expect($("#task-roots")).toBeNull();
		expect($("#task-exec")).not.toBeNull();
		expect($("#task-rounds")).not.toBeNull();
		expect(document.body.textContent).toContain("GLM-4.6");
		// 旧服务端（goal_status 没有 reviewerModel）：审查=主对话，不出审查下拉；
		// 执行跟随主对话 = 执行与审查同家族 → 冲突、开始键置灰
		expect($("#task-llm-reviewer")).toBeNull();
		setValue($("#task-goal"), "写一份发布说明");
		setValue($("#task-criteria"), "覆盖全部改动");
		expect($(".cockpit-model-note.bad")!.textContent).toContain("执行模型与审查模型同属 glm 家族");
		expect(startBtn()!.disabled).toBe(true);
		setValue($("#task-exec"), "oneapi/qwen3");
		expect($(".cockpit-model-note.bad")).toBeNull();
		click(startBtn());
		expect(sent).toEqual([
			{ type: "set_goal_prefs", maxRounds: 3, reviewModel: "", execModel: "oneapi/qwen3" },
			{
				type: "set_goal",
				goal: "写一份发布说明\n验收标准：覆盖全部改动",
				maxRounds: 3,
				locked: true,
				execModel: "oneapi/qwen3",
			},
		]);
	});

	it("仅模型评审的「帮我细化」→ start_goal_wizard 并关掉弹窗", async () => {
		mount(taskModal());
		await openModal();
		click($('input[name="task-accept"][value="llm"]'));
		expect($<HTMLButtonElement>(".task-refine")!.disabled).toBe(true);
		setValue($("#task-goal"), "做个小工具");
		// 执行与审查同家族时细化也不放行（向导结束会自动开跑）
		expect($<HTMLButtonElement>(".task-refine")!.disabled).toBe(true);
		setValue($("#task-exec"), "oneapi/qwen3");
		click($(".task-refine"));
		expect(sent).toEqual([
			{ type: "set_goal_prefs", maxRounds: 3, reviewModel: "", execModel: "oneapi/qwen3" },
			{ type: "start_goal_wizard", text: "做个小工具", maxRounds: 3, locked: true },
		]);
		expect($(".task-modal")).toBeNull();
	});

	it("目标模式关掉时「仅模型评审」置灰", async () => {
		mount(taskModal(false));
		await openModal();
		expect($<HTMLInputElement>('input[name="task-accept"][value="llm"]')!.disabled).toBe(true);
	});

	it("「重试」预填：openTaskModal({ goal }) 带回目标；取消关窗不发消息", async () => {
		mount(taskModal());
		await act(async () => {
			openTaskModal({ goal: "上次的目标" });
			await new Promise((r) => setTimeout(r, 0));
		});
		expect($<HTMLTextAreaElement>("#task-goal")!.value).toBe("上次的目标");
		click($(".task-modal .cockpit-row .btn:not(.primary):not(.task-refine)"));
		expect($(".task-modal")).toBeNull();
		expect(sent).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// D-12-3 成果与证据查看器：LoopBar 人话状态与终态动作 / 任务详情面板 / 任务台代码 loop 行
// ---------------------------------------------------------------------------

const RUN_ERR = "20261030121500-bbb222";
const RUN_OK = "20261030120000-aaa111";
const AT = new Date().toISOString();

const loopRun = (p: Partial<LoopUiState> = {}): LoopUiState => ({
	kind: "run",
	taskId: null,
	goal: "运行测试直到全部通过",
	runId: RUN_ERR,
	mode: "code",
	stage: "run",
	round: 1,
	maxRounds: 5,
	status: "active",
	lastVerdict: null,
	acceptance: null,
	reviewerEnabled: true,
	createdAt: AT,
	...p,
});

/** 评审掉线：代码验证已过，评审出错停下。 */
const REVIEWER_DOWN = loopRun({
	status: "stopped",
	stage: "review-error",
	stopReason: "reviewer-error",
	lastVerdict: "pass",
	criteria: "npm test 退出码 0",
	review: { verdict: "error", reasons: ["reviewer 请求超时（60s）"] },
});

const detailOf = (p: Partial<LoopRunDetail> = {}): LoopRunDetail => ({
	runId: RUN_ERR,
	goal: "运行测试直到全部通过",
	criteria: "npm test 退出码 0",
	mode: "code",
	status: "stopped",
	stage: "review-error",
	round: 1,
	maxRounds: 5,
	stopReason: "reviewer-error",
	acceptance: null,
	setupError: null,
	validator: { cmd: "npm test", verdict: "pass", code: 0, evidenceTail: "Tests: 42 passed" },
	review: { enabled: true, verdict: "error", reasons: ["reviewer 请求超时（60s）"] },
	models: { main: "glm-4.6", planner: "deepseek-v3", reviewer: "qwen3" },
	project: "demo",
	workspace: "/tmp/demo",
	worktreeBranch: null,
	worktreeCommitted: false,
	worktree: null,
	plannerOutput: "",
	plan: "",
	summary: "",
	history: [{ round: 1, verdict: "pass", code: 0, at: AT }],
	rounds: [
		{
			round: 1,
			review: "# mini-harness 运行报告\n- verdict: PASS（exit 0）\n- reviewer: error",
			logs: [{ file: "round-1-1730000000000.log", tail: "Tests: 42 passed" }],
		},
	],
	diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-bug\n+fixed\n",
	journal: [
		{ at: AT, event: "start", round: 1 },
		{ at: AT, event: "reviewer-error", round: 1 },
	],
	createdAt: AT,
	updatedAt: AT,
	...p,
});

/** 按 URL 应答的 fetch 桩；返回值记录每次请求的 URL。 */
function stubFetch(answer: (url: string) => { status?: number; body: unknown }): string[] {
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown) => {
			const url = String(input);
			calls.push(url);
			const r = answer(url);
			const status = r.status ?? 200;
			return { ok: status >= 200 && status < 300, status, json: async () => r.body };
		}),
	);
	return calls;
}

/** 详情接口按 runId 应答（其余请求给模型列表）。 */
const detailFetch = (byId: Record<string, LoopRunDetail>) =>
	stubFetch((url) => {
		const m = /runs\/([^/]+)\/detail/.exec(url);
		if (!m) return { body: { models: MODELS } };
		const d = byId[decodeURIComponent(m[1]!)];
		return d ? { body: d } : { status: 404, body: { error: "run not found" } };
	});

const tick = () =>
	act(async () => {
		await new Promise((r) => setTimeout(r, 0));
	});

const btn = (text: string, scope: ParentNode = document) =>
	Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === text) ?? null;
const btnTexts = (scope: ParentNode) =>
	Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).map((b) => b.textContent?.trim());
const both = (...nodes: ReturnType<typeof createElement>[]) => createElement("div", null, ...nodes);
const runDetail = (currentLoop: LoopUiState | null) => createElement(RunDetailModal, { currentLoop });

async function openDetail(runId: string) {
	await act(async () => {
		openRunDetail(runId);
		await new Promise((r) => setTimeout(r, 0));
	});
	await tick();
}

describe("LoopBar（D-12-3）：人话状态与终态动作", () => {
	it("运行中：人话状态 · 轮次 · 耗时；停止 → loop_stop（带 runId）", () => {
		const c = mount(createElement(LoopBar, { loop: loopRun({ round: 2 }), goalModeEnabled: true }));
		expect(c.querySelector(".loopbar-status")?.textContent).toMatch(/^正在干活 · 第 2\/5 轮 · \d+s$/);
		click(c.querySelector(".goalbar-x.stopping"));
		expect(sent).toEqual([{ type: "loop_stop", runId: RUN_ERR }]);
	});

	it("服务端刚建 run（setupPending）→ 正在准备", () => {
		const c = mount(
			createElement(LoopBar, { loop: loopRun({ stage: "intake", setupPending: true }), goalModeEnabled: true }),
		);
		expect(c.querySelector(".loopbar-status")?.textContent).toMatch(/^正在准备 · \d+s$/);
	});

	it("评审掉线：重试评审 → loop_resume，按代码验证收下 → loop_accept；不出「重试」", () => {
		const c = mount(createElement(LoopBar, { loop: REVIEWER_DOWN, goalModeEnabled: true }));
		expect(c.querySelector(".loopbar-status")?.textContent).toBe("⚠ 裁判掉线了 · 等待重试");
		expect(btnTexts(c.querySelector(".goalbar-row")!).slice(1)).toEqual(["重试评审", "按代码验证收下"]);
		click(btn("重试评审", c));
		click(btn("按代码验证收下", c));
		expect(sent).toEqual([
			{ type: "loop_resume", runId: RUN_ERR },
			{ type: "loop_accept", runId: RUN_ERR },
		]);
	});

	it("评审掉线但代码验证没过 / LLM 模式：只给「重试评审」", () => {
		for (const loop of [
			{ ...REVIEWER_DOWN, lastVerdict: "fail" },
			{ ...REVIEWER_DOWN, mode: "llm" as const, lastVerdict: "error" },
		]) {
			const c = mount(createElement(LoopBar, { loop, goalModeEnabled: true }));
			expect(c.querySelectorAll(".goalbar-btn")).toHaveLength(1);
			expect(btn("重试评审", c)).not.toBeNull();
			act(() => root?.unmount());
		}
	});

	it("其它终态只有「重试」：重开新任务弹窗，带回目标、验收标准与验收方式（没开评审 → 仅代码验证）", async () => {
		const loop = loopRun({
			status: "stopped",
			stage: "stopped",
			stopReason: "validate-fail",
			round: 5,
			criteria: "npm test 退出码 0",
			reviewerEnabled: false,
		});
		const c = mount(both(createElement(LoopBar, { loop, goalModeEnabled: true }), taskModal()));
		expect(c.querySelector(".loopbar-status")?.textContent).toBe("✗ 还没过关 · 查看失败证据");
		expect(c.querySelectorAll(".goalbar-btn")).toHaveLength(1);
		await act(async () => {
			btn("重试", c)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 0));
		});
		expect($<HTMLTextAreaElement>("#task-goal")!.value).toBe("运行测试直到全部通过");
		expect($<HTMLTextAreaElement>("#task-criteria")!.value).toBe("npm test 退出码 0");
		expect($<HTMLInputElement>('input[name="task-accept"][value="code"]')!.checked).toBe(true);
		expect(sent).toEqual([]);
	});

	it("交卷了（仅代码验证）：终态行带 ✓ 与轮次", () => {
		const loop = loopRun({
			status: "done",
			stage: "done",
			acceptance: "passed-validator-only",
			lastVerdict: "pass",
			round: 2,
		});
		const c = mount(createElement(LoopBar, { loop, goalModeEnabled: true }));
		expect(c.querySelector(".loopbar-status")?.textContent).toBe("✓ 交卷了（仅代码验证） · 查看成果");
		expect(c.querySelector(".goalbar-detail")?.textContent).toMatch(/^· 第 2\/5 轮 · /);
	});

	it("启动失败（没有 runId）：状态不可点，只给「重试」", () => {
		const loop: LoopUiState = {
			kind: "request-failed",
			taskId: "t1",
			goal: "g",
			reason: "同会话已有活跃 run",
			createdAt: AT,
		};
		const c = mount(createElement(LoopBar, { loop, goalModeEnabled: true }));
		const status = c.querySelector(".loopbar-status");
		expect(status?.tagName).toBe("SPAN");
		expect(status?.textContent).toBe("✗ 没启动起来：同会话已有活跃 run");
		expect(c.querySelectorAll(".goalbar-btn")).toHaveLength(1);
	});

	it("点终态文字 = 打开任务详情；新任务胶囊在详情打开时收起", async () => {
		detailFetch({ [RUN_ERR]: detailOf() });
		const c = mount(
			both(
				createElement(LoopBar, { loop: REVIEWER_DOWN, goalModeEnabled: false }),
				createElement(LoopBar, { loop: null, goalModeEnabled: false }),
				runDetail(REVIEWER_DOWN),
			),
		);
		expect(c.querySelectorAll(".loop-capsule")).toHaveLength(1);
		await act(async () => {
			c.querySelector(".loopbar-status")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 0));
		});
		await tick();
		expect($(".run-detail .run-detail-status")?.textContent).toBe("裁判掉线了 · 等待重试");
		expect(c.querySelectorAll(".loop-capsule")).toHaveLength(0);
	});
});

describe("任务详情面板（D-12-3）", () => {
	it("本对话的评审掉线 run：两行结论、出错原因、各轮记录、验收输出、diff、时间线、模型；重试评审 / 按代码验证收下", async () => {
		detailFetch({ [RUN_ERR]: detailOf() });
		mount(runDetail(REVIEWER_DOWN));
		await openDetail(RUN_ERR);
		const modal = $(".run-detail")!;
		const text = modal.textContent ?? "";
		expect(modal.querySelector(".run-detail-status")?.textContent).toBe("裁判掉线了 · 等待重试");
		expect(text).toContain("运行测试直到全部通过");
		expect(text).toContain("npm test 退出码 0");
		const lines = Array.from(modal.querySelectorAll(".run-detail-line")).map((l) => l.textContent);
		expect(lines).toEqual(["代码验证：通过", "模型评审：掉线（出错）"]);
		expect(text).toContain("出错原因");
		expect(modal.querySelector(".run-detail-reasons")?.textContent).toBe("reviewer 请求超时（60s）");
		expect(modal.querySelector(".run-detail-round summary")?.textContent).toBe("第 1 轮 · 通过");
		expect(text).toContain("round-1-1730000000000.log");
		expect(text).toContain("检查命令：npm test");
		expect(modal.querySelector(".run-detail-validator")?.textContent).toBe("Tests: 42 passed");
		expect(modal.querySelector(".run-detail-diff .add")?.textContent?.trim()).toBe("+fixed");
		expect(modal.querySelector(".run-detail-diff .del")?.textContent?.trim()).toBe("-bug");
		expect(modal.querySelectorAll(".run-detail-journal li")).toHaveLength(2);
		expect(text).toContain("执行 glm-4.6 · 规划 deepseek-v3 · 评审 qwen3");
		expect(text).toContain("项目 demo");
		expect(modal.querySelector(".run-detail-hint")).toBeNull();
		expect(btn("停止", modal)).toBeNull();
		click(btn("重试评审", modal));
		click(btn("按代码验证收下", modal));
		expect(sent).toEqual([
			{ type: "loop_resume", runId: RUN_ERR },
			{ type: "loop_accept", runId: RUN_ERR },
		]);
		// Escape 关闭
		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect($(".run-detail")).toBeNull();
	});

	it("不是本对话发起的 run：不给停止 / 重试评审等动作，给一句提示；「用同一目标重新开始」照样可用", async () => {
		detailFetch({ [RUN_ERR]: detailOf() });
		mount(both(runDetail(loopRun({ runId: "20261030000000-other1" })), taskModal()));
		await openDetail(RUN_ERR);
		const modal = $(".run-detail")!;
		expect(modal.querySelector(".run-detail-hint")?.textContent).toContain("不是当前对话发起的");
		expect(btn("重试评审", modal)).toBeNull();
		expect(btn("按代码验证收下", modal)).toBeNull();
		await act(async () => {
			btn("用同一目标重新开始", modal)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 0));
		});
		expect($(".run-detail")).toBeNull();
		expect($<HTMLTextAreaElement>("#task-goal")!.value).toBe("运行测试直到全部通过");
		expect($<HTMLTextAreaElement>("#task-criteria")!.value).toBe("npm test 退出码 0");
		expect($<HTMLInputElement>('input[name="task-accept"][value="code-review"]')!.checked).toBe(true);
		expect(sent).toEqual([]);
	});

	it("交卷了（两道验收都过）：评审理由、分支已提交；终态没有提示也没有停止", async () => {
		const ok = detailOf({
			runId: RUN_OK,
			goal: "在当前目录创建 result.txt，内容为 DONE",
			status: "done",
			stage: "done",
			stopReason: null,
			acceptance: "passed",
			review: { enabled: true, verdict: "pass", reasons: ["产物与目标一致"] },
			worktreeBranch: "mini-harness/20261030120000-aaa111",
			worktreeCommitted: true,
		});
		detailFetch({ [RUN_OK]: ok });
		mount(runDetail(null));
		await openDetail(RUN_OK);
		const modal = $(".run-detail")!;
		expect(modal.querySelector(".run-detail-status")?.textContent).toBe("交卷了 · 查看成果");
		expect(Array.from(modal.querySelectorAll(".run-detail-line")).map((l) => l.textContent)).toEqual([
			"代码验证：通过",
			"模型评审：通过",
		]);
		expect(modal.textContent).toContain("评审理由");
		expect(modal.textContent).toContain("分支 mini-harness/20261030120000-aaa111 · 已提交");
		expect(modal.querySelector(".run-detail-hint")).toBeNull();
		expect(btnTexts(modal.querySelector(".run-detail-acts")!)).toEqual(["用同一目标重新开始", "删除任务", "关闭"]);
	});

	it("LLM 模式：代码验证不适用，不画验收输出", async () => {
		detailFetch({
			[RUN_ERR]: detailOf({ mode: "llm", validator: { cmd: null, verdict: "error", code: null, evidenceTail: "" } }),
		});
		mount(runDetail(REVIEWER_DOWN));
		await openDetail(RUN_ERR);
		const modal = $(".run-detail")!;
		expect(modal.querySelector(".run-detail-line")?.textContent).toBe("代码验证：不适用（LLM 模式）");
		expect(modal.querySelector(".run-detail-validator")).toBeNull();
		// LLM 模式评审掉线不能按代码验证收下（服务端同样拒绝）
		expect(btn("重试评审", modal)).not.toBeNull();
		expect(btn("按代码验证收下", modal)).toBeNull();
	});

	it("拿不到记录（404）：友好的空状态，只剩关闭", async () => {
		detailFetch({});
		mount(runDetail(null));
		await openDetail("20261030999999-gone00");
		const modal = $(".run-detail")!;
		expect(modal.querySelector(".run-detail-missing")?.textContent).toBe("找不到这个任务的记录（可能已被删除）。");
		expect(btnTexts(modal.querySelector(".run-detail-acts")!)).toEqual(["关闭"]);
	});

	it("失联任务：恢复走 WS，确认停止走 HTTP；202 继续轮询，关掉就不再请求", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const flushMicro = () =>
			act(async () => {
				for (let i = 0; i < 20; i++) await Promise.resolve();
			});
		let detail = detailOf({
			status: "active",
			stage: "run",
			round: 2,
			stopReason: null,
			validator: { cmd: "npm test", verdict: "fail", code: 1, evidenceTail: "1 failed" },
			review: { enabled: true, verdict: null, reasons: [] },
		});
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		const calls = stubFetch((url) => {
			if (url.endsWith(`/runs/${RUN_ERR}/stop`)) {
				detail = { ...detail, status: "stopped", stage: "stopping", stopRequestedAt: AT };
				return { status: 202, body: { ok: true, status: "stopping", stopRequestedAt: AT } };
			}
			return { body: detail };
		});
		const detailCalls = () => calls.filter((u) => u.includes("/detail")).length;
		mount(runDetail(null));
		await act(async () => {
			openRunDetail(RUN_ERR);
		});
		await flushMicro();
		expect(detailCalls()).toBe(1);
		const modal = $(".run-detail")!;
		expect(modal.querySelector(".run-detail-status")?.textContent).toBe("正在干活 · 第 2/5 轮");
		expect(Array.from(modal.querySelectorAll(".run-detail-line")).map((l) => l.textContent)).toEqual([
			"代码验证：未通过（exit 1）",
			"模型评审：未运行",
		]);
		expect(btn("用同一目标重新开始", modal)).toBeNull();
		expect(btn("恢复任务", modal)).not.toBeNull();
		click(btn("恢复任务", modal));
		await flushMicro();
		expect(sent).toEqual([{ type: "loop_resume", runId: RUN_ERR }]);
		click(btn("停止", modal));
		expect(calls.filter((u) => u.endsWith("/stop"))).toHaveLength(0);
		confirm.mockReturnValue(true);
		click(btn("停止", modal));
		await flushMicro();
		expect(fetch).toHaveBeenCalledWith(
			expect.stringContaining(`/runs/${RUN_ERR}/stop`),
			expect.objectContaining({ method: "POST", body: "{}" }),
		);
		expect(calls.filter((u) => u.endsWith("/stop"))).toHaveLength(1);
		expect(modal.querySelector(".run-detail-status")?.textContent).toContain("退出尚未确认");
		expect(btn("核对停止结果", modal)).not.toBeNull();
		expect(btn("用同一目标重新开始", modal)).toBeNull();
		const beforePoll = detailCalls();
		await act(async () => {
			vi.advanceTimersByTime(3000);
		});
		await flushMicro();
		expect(detailCalls()).toBe(beforePoll + 1);
		act(() => closeRunDetail());
		await act(async () => {
			vi.advanceTimersByTime(9000);
		});
		await flushMicro();
		expect(detailCalls()).toBe(beforePoll + 1);
	});
});

describe("任务详情：删除（复用任务台的 runs/delete）", () => {
	const TREE = `/data/mini-harness/runs/${RUN_ERR}/worktree`;
	type Answer = { status: number; body: unknown } | "network";
	/** 详情按 detail() 应答；删除请求记下 body，按 answer() 应答（network = fetch 抛错）。 */
	const deleteFetch = (detail: () => LoopRunDetail, answer: () => Answer) => {
		const posts: unknown[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: { body?: string }) => {
				const url = String(input);
				if (url.includes("runs/delete")) {
					posts.push(JSON.parse(init?.body ?? "{}"));
					const r = answer();
					if (r === "network") throw new Error("offline");
					return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
				}
				if (/runs\/[^/]+\/detail/.test(url)) return { ok: true, status: 200, json: async () => detail() };
				return { ok: true, status: 200, json: async () => ({ models: MODELS }) };
			}),
		);
		return posts;
	};
	const openDelete = async () => {
		await openDetail(RUN_ERR);
		click(btn("删除任务", $(".run-detail")!));
		return $(".run-detail-delete")!;
	};
	const confirmBtn = () => $<HTMLButtonElement>(".run-detail-delete-confirm")!;
	const press = (el: HTMLElement | null) =>
		act(async () => {
			el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 0));
		});

	it("干净的已停止任务：确认页列出会移除与会保留的内容，确认后发 runs/delete 并关闭详情", async () => {
		const posts = deleteFetch(
			() =>
				detailOf({
					worktreeBranch: `mini-harness/${RUN_ERR}`,
					worktree: { path: TREE, exists: true, dirty: false, uncommitted: 0 },
					clusterBinding: { status: "pinned", context: "dev-cluster" },
				} as Partial<LoopRunDetail>),
			() => ({ status: 200, body: { ok: true, runId: RUN_ERR, worktreeRemoved: true, checkpointRefsRemoved: [] } }),
		);
		mount(runDetail(null));
		const panel = await openDelete();
		const text = panel.textContent ?? "";
		expect(text).toContain("运行记录：状态、各轮验收证据、过程记录和操作记录");
		expect(text).toContain(`任务工作树目录 ${TREE}`);
		expect(text).toContain(`refs/mini-harness/checkpoints/${RUN_ERR}-*`);
		expect(text).toContain("这个任务固定的集群配置快照（context dev-cluster）");
		expect(text).toContain(
			`会保留：分支 mini-harness/${RUN_ERR} 及其已提交的内容；项目目录 /tmp/demo 里的文件不受影响。`,
		);
		expect(text).toContain("删除后不能撤销。");
		expect(confirmBtn().disabled).toBe(false);
		await press(confirmBtn());
		await tick();
		expect(posts).toEqual([{ runId: RUN_ERR }]);
		expect(sent).toContainEqual({ type: "refresh_worktree" });
		expect($(".run-detail")).toBeNull();
	});

	it("停止待确认：说明还在等什么，确认按钮不可用，不发删除请求", async () => {
		const posts = deleteFetch(
			() =>
				detailOf({
					status: "active",
					stage: "stopping",
					stopReason: "user-stop",
					stopRequestedAt: AT,
					journal: [
						{
							at: AT,
							event: "stop-requested",
							cancellation: {
								hadActive: true,
								allConfirmed: false,
								cancelledOpIds: [],
								blockedReasons: ["op-1: exit unconfirmed"],
							},
							turn: { inFlight: true, abortError: null },
							legacyUnverified: [4242],
						},
					],
				}),
			() => ({ status: 200, body: { ok: true } }),
		);
		mount(runDetail(null));
		const panel = await openDelete();
		const block = panel.querySelector(".run-detail-delete-block")!.textContent ?? "";
		expect(block).toContain("还在等：执行回合结束 · 1 个验证 / 评审进程确认退出 · 旧执行进程（PID 4242）核实身份");
		expect(block).toContain("确认退出后才能删除");
		expect(confirmBtn().disabled).toBe(true);
		await press(confirmBtn());
		expect(posts).toEqual([]);
	});

	it("工作树有未提交改动：默认拦下并给出保留改动的办法；提交后「重新检查」即可删除；状态不明同样拦下", async () => {
		let tree: { path: string; exists: boolean; dirty: boolean | null; uncommitted: number } = {
			path: TREE,
			exists: true,
			dirty: true,
			uncommitted: 2,
		};
		const posts = deleteFetch(
			() =>
				detailOf({
					worktreeBranch: `mini-harness/${RUN_ERR}`,
					worktree: tree,
					clusterBinding: { status: "none", context: null },
				} as Partial<LoopRunDetail>),
			() => ({ status: 200, body: { ok: true } }),
		);
		mount(runDetail(null));
		const panel = await openDelete();
		const block = panel.querySelector(".run-detail-delete-block")!.textContent ?? "";
		expect(panel.textContent).not.toContain("集群配置快照");
		expect(block).toContain(`任务工作树 ${TREE} 有 2 处未提交改动，默认不删除`);
		expect(block).toContain(`先提交到分支 mini-harness/${RUN_ERR}（删除任务不会删这个分支）`);
		expect(panel.querySelector(".run-detail-delete-cmd")!.textContent).toBe(
			`git -C "${TREE}" add -A && git -C "${TREE}" commit -m "保留任务改动"`,
		);
		expect(confirmBtn().disabled).toBe(true);
		tree = { ...tree, dirty: null, uncommitted: 0 };
		await press($(".run-detail-delete-recheck"));
		await tick();
		expect($(".run-detail-delete-block")!.textContent).toContain(`无法确认任务工作树 ${TREE} 有没有未提交改动`);
		expect(confirmBtn().disabled).toBe(true);
		tree = { ...tree, dirty: false };
		await press($(".run-detail-delete-recheck"));
		await tick();
		expect($(".run-detail-delete-block")).toBeNull();
		expect(confirmBtn().disabled).toBe(false);
		expect(posts).toEqual([]);
	});

	it("确认页打开后工作树变脏：点确认时先重拉详情并拦下，不发删除请求", async () => {
		let dirty = false;
		const posts = deleteFetch(
			() =>
				detailOf({
					worktreeBranch: `mini-harness/${RUN_ERR}`,
					worktree: { path: TREE, exists: true, dirty, uncommitted: dirty ? 1 : 0 },
				}),
			() => ({ status: 200, body: { ok: true } }),
		);
		mount(runDetail(null));
		await openDelete();
		await tick();
		expect(confirmBtn().disabled).toBe(false);
		dirty = true;
		await press(confirmBtn());
		await tick();
		expect(posts).toEqual([]);
		expect($(".run-detail-delete-block")!.textContent).toContain("有 1 处未提交改动，默认不删除");
		expect($(".run-detail")).not.toBeNull();
	});

	it("删除失败：显示服务端拒绝原因与已移除的部分，详情和记录都还在；新错误码原样显示", async () => {
		let answer: Answer = { status: 409, body: { ok: false, code: "active", runId: RUN_ERR, error: "run is active" } };
		const posts = deleteFetch(
			() => detailOf(),
			() => answer,
		);
		mount(runDetail(null));
		await openDelete();
		await press(confirmBtn());
		await tick();
		const error = () => $(".run-detail-delete-error")?.textContent;
		expect(error()).toBe("删除失败：服务端拒绝，任务仍是运行状态（active）。记录仍保留，处理后可以重试。");
		expect($(".run-detail")).not.toBeNull();
		answer = {
			status: 500,
			body: {
				ok: false,
				code: "cleanup-error",
				runId: RUN_ERR,
				error: "EBUSY: resource busy",
				worktreeRemoved: true,
				checkpointRefsRemoved: [`refs/mini-harness/checkpoints/${RUN_ERR}-1`],
			},
		};
		await press(confirmBtn());
		await tick();
		expect(error()).toBe(
			"删除失败：清理时出错（cleanup-error）：EBUSY: resource busy。记录仍保留，处理后可以重试。 已移除：工作树目录 · 1 个检查点引用。",
		);
		answer = { status: 409, body: { ok: false, code: "dirty-worktree", error: "worktree has 2 uncommitted changes" } };
		await press(confirmBtn());
		await tick();
		expect(error()).toContain("服务端拒绝（dirty-worktree）：worktree has 2 uncommitted changes");
		answer = "network";
		await press(confirmBtn());
		await tick();
		expect(error()).toBe("删除请求没有送到服务端（网络或服务不可用），记录未删除。");
		expect(posts).toHaveLength(4);
		expect($(".run-detail")).not.toBeNull();
	});
});

describe("任务台：代码 loop 的行（D-12-3）", () => {
	const brief = (p: Partial<LoopRunBrief>): LoopRunBrief => ({
		runId: RUN_OK,
		stage: "done",
		round: 2,
		maxRounds: 5,
		status: "done",
		lastVerdict: "pass",
		goal: "在当前目录创建 result.txt，内容为 DONE",
		project: "demo",
		models: { main: null, planner: null, reviewer: null },
		updatedAt: "2026-10-30T12:05:00.000Z",
		mode: "code",
		stopReason: null,
		acceptance: "passed",
		reviewVerdict: "pass",
		reviewReasons: [],
		reviewerEnabled: true,
		createdAt: "2026-10-30T12:00:00.000Z",
		...p,
	});

	it("每行显示人话状态；点行打开任务详情；点删除打开删除确认，确认后才删", async () => {
		const RUNS = [
			brief({}),
			brief({
				runId: RUN_ERR,
				goal: "运行测试直到全部通过",
				status: "stopped",
				stage: "review-error",
				stopReason: "reviewer-error",
				acceptance: null,
				reviewVerdict: "error",
			}),
		];
		const calls = stubFetch((url) => {
			if (url.includes("runs/delete")) return { body: { ok: true } };
			if (url.includes("runs?history=1")) return { body: { runs: RUNS } };
			if (url.includes("/goals")) return { body: { goals: [] } };
			const m = /runs\/([^/]+)\/detail/.exec(url);
			if (m) return { body: detailOf({ runId: decodeURIComponent(m[1]!) }) };
			return { body: {} };
		});
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		mount(both(createElement(TaskDesk, { goal, activeConversationId: "c1" }), runDetail(null)));
		await act(async () => {
			openTaskDesk();
			await new Promise((r) => setTimeout(r, 0));
		});
		await tick();
		const rows = Array.from(document.querySelectorAll<HTMLElement>(".task-desk-run"));
		expect(rows.map((r) => r.dataset.runId)).toEqual([RUN_OK, RUN_ERR]);
		expect(rows.map((r) => r.querySelector(".task-desk-run-status")?.textContent)).toEqual([
			"交卷了 · 查看成果",
			"裁判掉线了 · 等待重试",
		]);
		expect(rows[0]!.className).toContain("ok");
		expect(rows[1]!.className).toContain("warn");
		// 删除：先打开任务详情里的删除确认（说明会移除什么），确认后才发删除请求；成功后详情关掉
		await act(async () => {
			rows[1]!.querySelector(".task-desk-del")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 0));
		});
		await tick();
		expect(confirm).not.toHaveBeenCalled();
		expect(calls.some((u) => u.includes("runs/delete"))).toBe(false);
		const panel = $(".run-detail .run-detail-delete")!;
		expect(panel.textContent).toContain("运行记录：状态、各轮验收证据、过程记录和操作记录");
		await act(async () => {
			panel.querySelector(".run-detail-delete-confirm")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 0));
		});
		await tick();
		expect(calls.some((u) => u.includes("runs/delete"))).toBe(true);
		expect($(".run-detail")).toBeNull();
		// 点行：打开详情
		await act(async () => {
			rows[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 0));
		});
		await tick();
		expect($(".run-detail")).not.toBeNull();
		expect(calls.some((u) => u.includes(`runs/${RUN_OK}/detail`))).toBe(true);
		// Escape 先关详情，任务台还在
		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect($(".run-detail")).toBeNull();
		expect($(".task-desk")).not.toBeNull();
		// 键盘：Enter 也能打开
		await act(async () => {
			rows[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			await new Promise((r) => setTimeout(r, 0));
		});
		expect($(".run-detail")).not.toBeNull();
	});
});

describe("新任务弹窗：审查模型可选（服务端支持 reviewerModel）", () => {
	const roleStub = (body: { executor?: string; reviewer?: string }) => {
		const fam0 = (s: string) => (s.includes("glm") ? "glm" : s.includes("qwen") ? "qwen" : "deepseek");
		// 与服务端联立分配同口径：执行自动 = 主对话 GLM-4.6；审查自动 = 避开执行家族的第一个
		const executor = !body.executor || body.executor === "auto" ? "oneapi/glm-4.6" : body.executor;
		const reviewer =
			!body.reviewer || body.reviewer === "auto"
				? fam0(executor) === "glm"
					? "oneapi/qwen3"
					: "oneapi/glm-4.6"
				: body.reviewer;
		const fam = (s: string) => (s.includes("glm") ? "glm" : s.includes("qwen") ? "qwen" : "deepseek");
		const view = (s: string, explicit: boolean) => ({
			provider: "oneapi",
			id: s.split("/")[1],
			family: fam(s),
			source: explicit ? "explicit" : s === "oneapi/glm-4.6" ? "main" : "auto",
		});
		const same = fam(reviewer) === fam(executor);
		return {
			ok: !same,
			roles: {
				planner: view("oneapi/glm-4.6", false),
				executor: view(executor, !!body.executor && body.executor !== "auto"),
				reviewer: view(reviewer, !!body.reviewer && body.reviewer !== "auto"),
			},
			conflicts: same ? [{ roles: ["executor", "reviewer"], family: fam(executor), models: [executor, reviewer] }] : [],
			error: null,
			suggestion: same ? { role: "reviewer", provider: "oneapi", id: "qwen3", family: "qwen" } : null,
		};
	};

	it("三个角色都可选：自动联立出三个实际模型；显式执行与审查同家族 → 指出冲突并一键改选；set_goal 带执行与审查", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: { body?: string }) => ({
				ok: true,
				json: async () =>
					String(url).includes("/roles") ? roleStub(JSON.parse(init?.body ?? "{}")) : { models: MODELS },
			})),
		);
		const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 220))));
		mount(
			createElement(TaskModal, {
				goal: { ...goal, reviewerModel: null } as GoalStatus,
				mainModel: { id: "glm-4.6", name: "GLM-4.6", provider: "oneapi" },
				goalModeEnabled: true,
			}),
		);
		await openModal();
		click($('input[name="task-accept"][value="llm"]'));
		setValue($("#task-goal"), "写一份发布说明");
		expect($("#task-llm-planner")).not.toBeNull();
		expect($<HTMLSelectElement>("#task-exec")!.value).toBe("auto");
		expect($<HTMLSelectElement>("#task-llm-reviewer")!.value).toBe("auto");
		await settle();
		// 全自动：执行 = 主对话 GLM-4.6，审查自动避开到 qwen3
		expect($(".cockpit-model-note.bad")).toBeNull();
		expect($(".task-role-summary")!.textContent).toContain("审查：qwen3（qwen · 自动）");
		setValue($("#task-exec"), "oneapi/glm-4.6");
		setValue($("#task-llm-reviewer"), "other/glm-4.5");
		await settle();
		expect($(".cockpit-model-note.bad")!.textContent).toContain(
			"执行模型 oneapi/glm-4.6 与审查模型 other/glm-4.5 同属 glm 家族",
		);
		expect(startBtn()!.disabled).toBe(true);
		expect($(".task-role-fix")!.textContent).toBe("审查改用 qwen3");
		click($(".task-role-fix"));
		expect($<HTMLSelectElement>("#task-llm-reviewer")!.value).toBe("oneapi/qwen3");
		await settle();
		expect($(".cockpit-model-note.bad")).toBeNull();
		expect($(".task-role-summary")!.textContent).toContain("审查：qwen3（qwen · 指定）");
		expect(startBtn()!.disabled).toBe(false);
		click(startBtn());
		expect(sent).toEqual([
			{
				type: "set_goal_prefs",
				maxRounds: 3,
				reviewModel: "",
				execModel: "oneapi/glm-4.6",
				reviewerModel: "oneapi/qwen3",
			},
			{
				type: "set_goal",
				goal: "写一份发布说明",
				maxRounds: 3,
				locked: true,
				execModel: "oneapi/glm-4.6",
				reviewerModel: "oneapi/qwen3",
			},
		]);
	});

	it("可用家族不足：点名缺哪个角色、列出要避开的家族，启动保持禁用", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => ({
				ok: true,
				json: async () =>
					String(url).includes("/roles")
						? {
								ok: false,
								mode: "code-review",
								roles: {
									planner: { provider: "oneapi", id: "qwen3", family: "qwen", source: "auto" },
									executor: { provider: "oneapi", id: "glm-4.6", family: "glm", source: "main" },
									reviewer: null,
								},
								conflicts: [],
								error: { code: "no-candidate", role: "reviewer" },
								suggestion: null,
							}
						: { models: MODELS },
			})),
		);
		mount(taskModal());
		await openModal();
		setValue($("#task-goal"), "跑测试");
		await act(async () => void (await new Promise((r) => setTimeout(r, 220))));
		expect($(".cockpit-model-note.bad")!.textContent).toBe(
			"没有可用的审查模型：需要一个不属于 glm / qwen 家族的模型，请在「模型与服务商」里添加并配置密钥。",
		);
		expect($(".task-role-fix")).toBeNull();
		expect(startBtn()!.disabled).toBe(true);
	});

	it("切到仅代码验收：残留的审查选择不进请求、不阻断启动", async () => {
		mount(taskModal());
		await openModal();
		setValue($("#task-goal"), "跑测试");
		setValue($("#task-executor"), "oneapi/glm-4.6");
		setValue($("#task-reviewer"), "other/glm-4.5");
		expect(startBtn()!.disabled).toBe(true);
		click($('input[name="task-accept"][value="code"]'));
		expect($("#task-reviewer")).toBeNull();
		expect(startBtn()!.disabled).toBe(false);
		click(startBtn());
		expect(sent[0]).toMatchObject({ type: "loop_start_request", useReviewer: false, executorModel: "oneapi/glm-4.6" });
		expect(sent[0]).not.toHaveProperty("reviewerModel");
	});
});
