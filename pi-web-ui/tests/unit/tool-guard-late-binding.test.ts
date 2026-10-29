/**
 * 插件工具守卫的**延迟绑定**回归（P1-5 的真实缺口）。
 *
 * 背景：`withToolGuard` 在建工具定义时就把 `opts.guard` 捕进闭包；而 runtime 是在
 * `ClientSession.create()` 里建的，`cs.toolGuard` 却在 `AgentService.attach()` 末尾才赋值。
 * 直接传 `this.toolGuard` → `undefined` 被永久固化进工具闭包 → **attach 时恢复出来的那条
 * 对话永远不受插件 onToolPre/onToolPost 约束**（只有新建/切换对话才带上）。
 *
 * 这里覆盖 `makeLateToolGuard`：无论守卫是「先建定义后赋值」还是「始终没注入」，行为都必须
 * 与「直接传真实守卫」/「直通」一致。
 */
import { describe, expect, it, vi } from "vitest";
import { makeLateToolGuard, withToolGuard, type ToolGuardHook } from "../../server/agent-service.js";

const allowVerdict = { verdict: { decision: "allow" as const } };

/** 最小 ToolDefinition 壳：只关心 execute 会不会被调到。 */
function fakeTool() {
	return {
		name: "bash",
		label: "bash",
		description: "test",
		parameters: { type: "object", properties: {} },
		execute: vi.fn(async () => ({ content: [{ type: "text", text: "ran" }] })),
	};
}

describe("makeLateToolGuard", () => {
	it("调用时才解析真正的守卫（赋值晚于建定义也没问题）", async () => {
		let guard: ToolGuardHook | undefined;
		const late = makeLateToolGuard(() => guard);
		const inner = fakeTool();
		const tool = withToolGuard(inner as never, {
			toolName: "bash",
			guard: late,
			getLang: () => "zh",
		}) as unknown as { execute: (id: string, params: unknown) => Promise<unknown> };

		// ① 还没注入守卫（= 建定义那一刻的 this.toolGuard）：直通，命令真的跑了
		await tool.execute("c1", { command: "npm run build" });
		expect(inner.execute).toHaveBeenCalledTimes(1);

		// ② 之后才注入（模拟 attach 末尾的 cs.toolGuard = ...）：同一个工具定义立刻受约束
		const pre = vi.fn(async () => ({ verdict: { decision: "deny" as const }, pluginId: "pm2-manager" }));
		guard = { pre, post: async () => undefined };
		const out = (await tool.execute("c2", { command: "npm run dev &" })) as {
			content?: Array<{ text?: string }>;
		};
		expect(pre).toHaveBeenCalledTimes(1);
		expect(inner.execute).toHaveBeenCalledTimes(1); // 被拦住了，没有第二次真执行
		const text = out?.content?.map((c) => c.text ?? "").join("\n") ?? "";
		expect(text).toContain("pm2-manager");
		expect(text).toContain("拒绝");
	});

	it("未注入守卫时逐字等价于直通（allow / 无 post 编辑）", async () => {
		const late = makeLateToolGuard(() => undefined);
		expect(await late.pre({ toolName: "bash", params: {} }, "zh")).toEqual(allowVerdict);
		expect(await late.post({ toolName: "bash", params: {}, result: {} }, "zh")).toBeUndefined();
	});

	it("每次调用都重新取守卫（reload 后换成新实例也生效）", async () => {
		const a = vi.fn(async () => allowVerdict);
		const b = vi.fn(async () => allowVerdict);
		let current: ToolGuardHook | undefined = { pre: a, post: async () => undefined };
		const late = makeLateToolGuard(() => current);
		await late.pre({ toolName: "bash", params: {} }, "en");
		current = { pre: b, post: async () => undefined };
		await late.pre({ toolName: "bash", params: {} }, "en");
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
	});
});
