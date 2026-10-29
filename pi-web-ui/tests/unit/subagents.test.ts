import { describe, expect, it, vi } from "vitest";
import {
	collectSubagentDescendantIds,
	computeWaitCapMs,
	makeSubagentTool,
	makeSubagentTools,
	subagentTitle,
	withSubagentOwner,
	SUBAGENT_ACTIONS,
	type SubagentToolHost,
} from "../../server/subagents.js";
import { MAX_SUBAGENTS, getMaxSubagents } from "../../server/agent-formatters.js";
import { countActiveSubagents, isSubagentActive, toSubagentSnapshot } from "../../server/subagent-helpers.js";
import type { Conversation } from "../../server/agent-service.js";
import { SUBAGENT_TOOL_NAMES } from "../../server/tool-manager.js";

/** 一个假的 host，工具调用不会真正执行会话（只验证走通与参数透传）。 */
function makeHostSpies() {
	const host: SubagentToolHost = {
		spawnSubagent: vi.fn(async (_prompt, type, _cwd) => `sa-${type}-abc`),
		getSubagent: vi.fn(() => undefined),
		listSubagents: vi.fn(() => []),
		steerSubagent: vi.fn(async () => {}),
		stopSubagent: vi.fn(async () => {}),
		handoffSubagent: vi.fn(async () => {}),
		listTemplates: vi.fn(() => [{ name: "reviewer", description: "只读审查" }]),
		isTemplateUsable: vi.fn((name: string) => name === "reviewer"),
	};
	return host;
}

describe("subagents tools", () => {
	it("computeWaitCapMs 计算阻塞上限（#449）", () => {
		// 默认看门狗 20 分钟 -> 0.8 * 20min = 16 分钟 = 960,000ms
		expect(computeWaitCapMs()).toBe(960_000);
		// 自定义看门狗 100s -> 80,000ms
		expect(computeWaitCapMs(100_000)).toBe(80_000);
		// 看门狗极小 -> 5s 兜底
		expect(computeWaitCapMs(2_000)).toBe(5_000);

		// 环境变量覆盖
		const oldEnv = process.env.PI_WEB_SUBAGENT_WAIT_CAP_SECONDS;
		try {
			process.env.PI_WEB_SUBAGENT_WAIT_CAP_SECONDS = "120";
			expect(computeWaitCapMs(1000_000)).toBe(120_000);
		} finally {
			if (oldEnv === undefined) delete process.env.PI_WEB_SUBAGENT_WAIT_CAP_SECONDS;
			else process.env.PI_WEB_SUBAGENT_WAIT_CAP_SECONDS = oldEnv;
		}
	});

	it("SUBAGENT_TOOL_NAMES 只包含单个 subagent 工具，SUBAGENT_ACTIONS 包含 8 种 action", () => {
		expect(SUBAGENT_TOOL_NAMES).toEqual(["subagent"]);
		expect(SUBAGENT_ACTIONS).toEqual([
			"spawn",
			"get_result",
			"steer",
			"list",
			"stop",
			"wait_all",
			"templates",
			"handoff",
		]);
		const host = makeHostSpies();
		const tools = makeSubagentTools(host);
		expect(tools.map((t) => t.name)).toEqual(["subagent"]);
		const [subagent] = tools;
		expect(subagent.description.length).toBeGreaterThan(10);
		expect(subagent.description.length).toBeLessThan(700);
		expect(subagent.parameters).toBeDefined();
	});

	it("缺少 action 或未知 action 时给出明确提示", async () => {
		const host = makeHostSpies();
		const tool = makeSubagentTool(host, () => "zh");
		const r1 = (await tool.execute!("t1", {} as never, undefined, undefined, {} as never)) as {
			content: { text: string }[];
		};
		expect(r1.content[0].text).toContain("缺少 action 参数");

		const r2 = (await tool.execute!("t1", { action: "invalid_act" } as never, undefined, undefined, {} as never)) as {
			content: { text: string }[];
		};
		expect(r2.content[0].text).toContain("未知 action：invalid_act");
	});

	it("subagent action=spawn 透传 prompt/type/cwd/template/model 给 host", async () => {
		const host = makeHostSpies();
		const [subagent] = makeSubagentTools(host, () => "zh");
		const ctx = { cwd: "/root/proj" } as never;
		const result = (await subagent.execute!(
			"t1",
			{
				action: "spawn",
				prompt: "调研",
				type: "explore",
				template: "reviewer",
				cwd: "/other",
				model: "anthropic/claude-opus-4-5",
			} as never,
			undefined,
			undefined,
			ctx as never,
		)) as { content: { text: string }[] };
		expect(host.spawnSubagent).toHaveBeenCalledWith(
			"调研",
			"explore",
			"/other",
			"reviewer",
			"anthropic/claude-opus-4-5",
			undefined,
			undefined,
		);
		const text = result.content[0].text;
		expect(text).toContain("sa-explore-abc");
		expect(text).toContain("模板：reviewer");
		expect(text).toContain("模型：anthropic/claude-opus-4-5");
	});

	it("subagent action=spawn 缺少 prompt 时报错", async () => {
		const host = makeHostSpies();
		const tool = makeSubagentTool(host, () => "zh");
		const result = (await tool.execute!("t1", { action: "spawn" } as never, undefined, undefined, {} as never)) as {
			content: { text: string }[];
		};
		expect(result.content[0].text).toContain("缺少 prompt 参数");
	});

	it("subagent action=spawn 未传 cwd 时用 ctx.cwd；不传 template/model 时按缺省", async () => {
		const host = makeHostSpies();
		const [subagent] = makeSubagentTools(host);
		await subagent.execute!("t1", { action: "spawn", prompt: "p" } as never, undefined, undefined, {
			cwd: "/root/proj",
		} as never);
		expect(host.spawnSubagent).toHaveBeenCalledWith(
			"p",
			"general",
			"/root/proj",
			undefined,
			undefined,
			undefined,
			undefined,
		);
	});

	it("subagent action=spawn 支持 persist=true 创建普通持久化对话", async () => {
		const host = makeHostSpies();
		const [subagent] = makeSubagentTools(host, () => "zh");
		const result = (await subagent.execute!(
			"t1",
			{ action: "spawn", prompt: "架构重构", persist: true } as never,
			undefined,
			undefined,
			{ cwd: "/root/proj" } as never,
		)) as { content: { text: string }[] };
		expect(host.spawnSubagent).toHaveBeenCalledWith(
			"架构重构",
			"general",
			"/root/proj",
			undefined,
			undefined,
			undefined,
			true,
		);
		expect(result.content[0].text).toContain("普通持久化对话已启动");
	});

	it("subagent action=spawn 模板不存在/停用时不启动并提示", async () => {
		const host = makeHostSpies();
		const [subagent] = makeSubagentTools(host, () => "zh");
		const result = (await subagent.execute!(
			"t1",
			{ action: "spawn", prompt: "p", template: "ghost" } as never,
			undefined,
			undefined,
			{ cwd: "/x" } as never,
		)) as { content: { text: string }[] };
		expect(host.spawnSubagent).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain("不可用");
		expect(result.content[0].text).toContain("ghost");
	});

	it("subagent action=spawn 启动失败转返回文本（不直接抛异常）", async () => {
		const host = makeHostSpies();
		(host.spawnSubagent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("子代理数量已达上限（16 个）"));
		const [subagent] = makeSubagentTools(host, () => "zh");
		const result = (await subagent.execute!("t1", { action: "spawn", prompt: "p" } as never, undefined, undefined, {
			cwd: "/x",
		} as never)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("启动失败");
		expect(result.content[0].text).toContain("16");
	});

	it("subagent action=get_result 缺少 runId 报参数缺失；未知 runId 提示未找到", async () => {
		const host = makeHostSpies();
		const [subagent] = makeSubagentTools(host, () => "zh");
		const rMissing = (await subagent.execute!(
			"t1",
			{ action: "get_result" } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(rMissing.content[0].text).toContain("缺少 runId 参数");

		const result = (await subagent.execute!(
			"t1",
			{ action: "get_result", runId: "nope" } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("未找到");
	});

	it("subagent action=steer / stop 透传 runId", async () => {
		const host = makeHostSpies();
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
			id === "sa-1"
				? {
						convId: "sa-1",
						type: "general",
						title: "t",
						prompt: "",
						state: "running",
						streaming: true,
						messageCount: 1,
						output: "",
					}
				: undefined,
		);
		const [subagent] = makeSubagentTools(host);
		await subagent.execute!(
			"t1",
			{ action: "steer", runId: "sa-1", message: "改方向" } as never,
			undefined,
			undefined,
			{} as never,
		);
		await subagent.execute!("t1", { action: "stop", runId: "sa-1" } as never, undefined, undefined, {} as never);
		expect(host.steerSubagent).toHaveBeenCalledWith("sa-1", "改方向");
		expect(host.stopSubagent).toHaveBeenCalledWith("sa-1");
	});

	it("subagent action=steer / stop 对未知 runId 报未找到（不谎报成功）", async () => {
		const host = makeHostSpies();
		const [subagent] = makeSubagentTools(host, () => "zh");
		const r1 = (await subagent.execute!(
			"t1",
			{ action: "steer", runId: "ghost", message: "hi" } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(r1.content[0].text).toContain("未找到");
		expect(host.steerSubagent).not.toHaveBeenCalled();

		const r2 = (await subagent.execute!(
			"t1",
			{ action: "stop", runId: "ghost" } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(r2.content[0].text).toContain("未找到");
		expect(host.stopSubagent).not.toHaveBeenCalled();
	});

	it("subagent action=list 汇总 host 返回", async () => {
		const host = makeHostSpies();
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				convId: "sa-1",
				type: "explore",
				title: "调研",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 3,
				output: "…",
			},
		]);
		const [subagent] = makeSubagentTools(host);
		const result = (await subagent.execute!("t1", { action: "list" } as never, undefined, undefined, {} as never)) as {
			content: { text: string }[];
		};
		const text = result.content[0].text;
		expect(text).toContain("sa-1");
		expect(text).toContain("explore");
		expect(text).toContain("running");
	});

	it("subagent action=templates 列出宿主返回的可用模板", async () => {
		const host = makeHostSpies();
		(host.listTemplates as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "reviewer", description: "只读审查" },
			{ name: "reporter", description: "报告整理" },
		]);
		const [subagent] = makeSubagentTools(host);
		const result = (await subagent.execute!(
			"t1",
			{ action: "templates" } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		const text = result.content[0].text;
		expect(text).toContain("reviewer");
		expect(text).toContain("reporter");
		expect(text).toContain("subagent");
	});

	it("subagent action=templates 报出模型与思考强度（空值说「跟随主对话」）", async () => {
		const host = makeHostSpies();
		(host.listTemplates as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "thinker", description: "审查", model: "anthropic/claude-opus-4-5", thinkingLevel: "high" },
			{ name: "plain", description: "默认" },
		]);
		const [zh] = makeSubagentTools(host, () => "zh");
		const zhText = (
			(await zh.execute!("t1", { action: "templates" } as never, undefined, undefined, {} as never)) as {
				content: { text: string }[];
			}
		).content[0].text;
		expect(zhText).toContain("思考强度：high");
		expect(zhText).toContain("模型：anthropic/claude-opus-4-5");
		expect(zhText).toContain("跟随主对话模型，跟随主对话思考强度");

		const [en] = makeSubagentTools(host, () => "en");
		const enText = (
			(await en.execute!("t1", { action: "templates" } as never, undefined, undefined, {} as never)) as {
				content: { text: string }[];
			}
		).content[0].text;
		expect(enText).toContain("thinking: high");
		expect(enText).toContain("follows the main conversation thinking level");
	});

	it("subagent action=templates 空清单给出引导文案", async () => {
		const host = makeHostSpies();
		(host.listTemplates as ReturnType<typeof vi.fn>).mockReturnValue([]);
		const [subagent] = makeSubagentTools(host, () => "zh");
		const result = (await subagent.execute!(
			"t1",
			{ action: "templates" } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("当前没有");
	});

	it("subagent action=get_result 报错子代理明确标出错误文本", async () => {
		const host = makeHostSpies();
		(host.getSubagent as ReturnType<typeof vi.fn>).mockReturnValue({
			convId: "sa-err",
			type: "general",
			title: "调研",
			prompt: "",
			state: "done",
			streaming: false,
			error: "Error from provider (Console Go): Upstream request failed: [400] Provider returned error",
			messageCount: 2,
			output: "",
		});
		const [subagent] = makeSubagentTools(host, () => "zh");
		const result = (await subagent.execute!(
			"t1",
			{ action: "get_result", runId: "sa-err" } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("error（报错）");
		expect(result.content[0].text).toContain("400");
	});

	it("subagent action=wait_all 等到全部终态后汇总结果（含错误标记）", async () => {
		const host = makeHostSpies();
		const sa1 = {
			convId: "sa-1",
			type: "explore",
			title: "调研 A",
			prompt: "",
			state: "done",
			streaming: false,
			messageCount: 3,
			output: "结论 A",
		};
		const sa2 = {
			convId: "sa-2",
			type: "review",
			title: "审查 B",
			prompt: "",
			state: "done",
			streaming: false,
			error: "provider 400",
			messageCount: 2,
			output: "",
		};
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) => (id === "sa-2" ? sa2 : sa1));
		const [subagent] = makeSubagentTools(host, () => "zh");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", runIds: ["sa-1", "sa-2"], timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("全部 2 个子代理已收口");
		expect(result.content[0].text).toContain("结论 A");
		expect(result.content[0].text).toContain("provider 400");
	});

	it("subagent action=wait_all 调用者自身永不计入等待（防 self-wait deadlock）", async () => {
		const host = makeHostSpies();
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				convId: "sa-self",
				type: "general",
				title: "我自己",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 1,
				output: "",
				parentId: "c-main",
			},
			{
				convId: "sa-other",
				type: "explore",
				title: "别人",
				prompt: "",
				state: "done",
				streaming: false,
				messageCount: 1,
				output: "已完成",
				parentId: "sa-self",
			},
		]);
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
			(host.listSubagents() as { convId: string }[]).find((x) => x.convId === id),
		);
		const [subagent] = makeSubagentTools(host, () => "zh", "sa-self");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("全部 1 个子代理已收口");
		expect(result.content[0].text).not.toContain("我自己");
		expect(result.content[0].text).toContain("别人");
	});

	it("subagent action=wait_all 排除自身后为空时直接返回（不等超时）", async () => {
		const host = makeHostSpies();
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				convId: "sa-self",
				type: "general",
				title: "我自己",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 1,
				output: "",
			},
		]);
		const [subagent] = makeSubagentTools(host, () => "zh", "sa-self");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("没有需要等待的子代理");
	});

	it("subagent action=wait_all 显式 runIds 里含自身时同样排除", async () => {
		const host = makeHostSpies();
		const other = {
			convId: "sa-other",
			type: "general",
			title: "同伴",
			prompt: "",
			state: "done",
			streaming: false,
			messageCount: 1,
			output: "ok",
		};
		(host.getSubagent as ReturnType<typeof vi.fn>).mockReturnValue(other);
		const [subagent] = makeSubagentTools(host, () => "zh", "sa-self");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", runIds: ["sa-self", "sa-other"], timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("全部 1 个子代理已收口");
		expect(result.content[0].text).toContain("sa-other");
	});

	it("subagent action=wait_all 长输出留头留尾（结论在尾部不能丢）", async () => {
		const host = makeHostSpies();
		const longLines = [
			"TASK: 重构鉴权模块",
			...Array.from({ length: 100 }, (_, i) => `中间日志 ${i + 1}：处理中…`),
			"VERDICT: 重构成功完成，全量单测通过",
		].join("\n");
		(host.getSubagent as ReturnType<typeof vi.fn>).mockReturnValue({
			convId: "sa-long",
			type: "implement",
			title: "重构",
			prompt: "",
			state: "done",
			streaming: false,
			messageCount: 2,
			output: longLines,
		});
		const [subagent] = makeSubagentTools(host, () => "zh");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", runIds: ["sa-long"], timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		const text = result.content[0].text;
		expect(text).toContain("TASK: 重构鉴权模块");
		expect(text).toContain("VERDICT: 重构成功完成");
		expect(text).toContain("中间省略");
	});

	it("subagent action=wait_all 短输出原样返回（不加省略标记）", async () => {
		const host = makeHostSpies();
		const shortOutput = "第一行\n第二行\n结论：OK";
		(host.getSubagent as ReturnType<typeof vi.fn>).mockReturnValue({
			convId: "sa-short",
			type: "review",
			title: "审查",
			prompt: "",
			state: "done",
			streaming: false,
			messageCount: 2,
			output: shortOutput,
		});
		const [subagent] = makeSubagentTools(host, () => "zh");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", runIds: ["sa-short"], timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain(shortOutput);
		expect(result.content[0].text).not.toContain("省略");
	});

	it("subagent action=wait_all 空 runIds 时等当前全部运行中的子代理", async () => {
		const host = makeHostSpies();
		const runningList = [
			{
				convId: "sa-a",
				type: "explore",
				title: "A",
				prompt: "",
				state: "done" as const,
				streaming: false,
				messageCount: 1,
				output: "done A",
			},
			{
				convId: "sa-b",
				type: "implement",
				title: "B",
				prompt: "",
				state: "running" as const,
				streaming: true,
				messageCount: 1,
				output: "",
			},
		];
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue(runningList);
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
			runningList.find((x) => x.convId === id),
		);
		const [subagent] = makeSubagentTools(host, () => "zh");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		const text = result.content[0].text;
		expect(text).toContain("超时");
		expect(text).toContain("1 个仍在运行");
		expect(text).toContain("sa-b");
	});

	it("subagent action=wait_all 两层嵌套：子代理无参只等后代，不等父级/无关兄弟", async () => {
		const host = makeHostSpies();
		const all = [
			{
				convId: "sa-root",
				type: "explore",
				title: "爷爷",
				prompt: "",
				state: "running" as const,
				streaming: true,
				messageCount: 1,
				output: "",
			},
			{
				convId: "sa-uncle",
				type: "explore",
				title: "叔叔",
				prompt: "",
				state: "running" as const,
				streaming: true,
				messageCount: 1,
				output: "",
				parentId: "sa-root",
			},
			{
				convId: "sa-parent",
				type: "implement",
				title: "父级",
				prompt: "",
				state: "running" as const,
				streaming: true,
				messageCount: 1,
				output: "",
				parentId: "sa-root",
			},
			{
				convId: "sa-child",
				type: "review",
				title: "孩子",
				prompt: "",
				state: "done" as const,
				streaming: false,
				messageCount: 1,
				output: "孩子完成",
				parentId: "sa-parent",
			},
			{
				convId: "sa-grandchild",
				type: "review",
				title: "孙子",
				prompt: "",
				state: "done" as const,
				streaming: false,
				messageCount: 1,
				output: "孙子完成",
				parentId: "sa-child",
			},
		];
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue(all);
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) => all.find((x) => x.convId === id));
		const [subagent] = makeSubagentTools(host, () => "zh", "sa-parent");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		const text = result.content[0].text;
		expect(text).toContain("全部 2 个子代理已收口");
		expect(text).toContain("sa-child");
		expect(text).toContain("sa-grand");
		expect(text).not.toContain("sa-root");
		expect(text).not.toContain("sa-uncle");
		expect(text).not.toContain("父级");
	});

	it("subagent action=wait_all 叶子无参等待父级时直接返回空（不等超时）", async () => {
		const host = makeHostSpies();
		const all = [
			{
				convId: "sa-parent",
				type: "implement",
				title: "父级",
				prompt: "",
				state: "running" as const,
				streaming: true,
				messageCount: 1,
				output: "",
			},
			{
				convId: "sa-leaf",
				type: "review",
				title: "叶子",
				prompt: "",
				state: "running" as const,
				streaming: true,
				messageCount: 1,
				output: "",
				parentId: "sa-parent",
			},
		];
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue(all);
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) => all.find((x) => x.convId === id));
		const [subagent] = makeSubagentTools(host, () => "zh", "sa-leaf");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(result.content[0].text).toContain("没有需要等待的子代理");
	});

	it("subagent action=wait_all 显式 runIds 含祖先时剔除祖先（不死锁）", async () => {
		const host = makeHostSpies();
		const all = [
			{
				convId: "sa-parent",
				type: "implement",
				title: "父级",
				prompt: "",
				state: "running" as const,
				streaming: true,
				messageCount: 1,
				output: "",
			},
			{
				convId: "sa-leaf",
				type: "review",
				title: "叶子",
				prompt: "",
				state: "running" as const,
				streaming: true,
				messageCount: 1,
				output: "",
				parentId: "sa-parent",
			},
			{
				convId: "sa-other",
				type: "review",
				title: "同辈",
				prompt: "",
				state: "done" as const,
				streaming: false,
				messageCount: 1,
				output: "同辈搞定",
			},
		];
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue(all);
		(host.getSubagent as ReturnType<typeof vi.fn>).mockImplementation((id: string) => all.find((x) => x.convId === id));
		const [subagent] = makeSubagentTools(host, () => "zh", "sa-leaf");
		const result = (await subagent.execute!(
			"t1",
			{ action: "wait_all", runIds: ["sa-parent", "sa-other"], timeoutSeconds: 1 } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		const text = result.content[0].text;
		expect(text).toContain("全部 1 个子代理已收口");
		expect(text).toContain("sa-other");
		expect(text).not.toContain("sa-parent");
	});
});

describe("collectSubagentDescendantIds 纯函数", () => {
	it("树状后代收集：含嵌套的嵌套，不含自身，不含无关兄弟", () => {
		const items = [
			{ id: "root", isSubagent: true },
			{ id: "c1", parentId: "root", isSubagent: true },
			{ id: "c2", parentId: "root", isSubagent: true },
			{ id: "gc1", parentId: "c1", isSubagent: true },
			{ id: "other", isSubagent: true },
			{ id: "not-sa", parentId: "root", isSubagent: false },
		];
		const desc = collectSubagentDescendantIds(items, "root");
		expect(desc.sort()).toEqual(["c1", "c2", "gc1"].sort());
	});

	it("parentId 环按 visited 截断，不死循环", () => {
		const items = [
			{ id: "a", parentId: "b", isSubagent: true },
			{ id: "b", parentId: "a", isSubagent: true },
		];
		expect(() => collectSubagentDescendantIds(items, "root")).not.toThrow();
		expect(collectSubagentDescendantIds(items, "root")).toEqual([]);
	});
});

describe("subagentTitle 辅助函数", () => {
	it("取首行并截断 40 字符", () => {
		expect(subagentTitle("短标题")).toBe("短标题");
		expect(subagentTitle("第一行\n第二行")).toBe("第一行");
		expect(subagentTitle("x".repeat(80))).toHaveLength(41);
	});
});

describe("subagents language (issue #91)", () => {
	it("默认英文：未知 runId / 空模板清单返回英文", async () => {
		const host = makeHostSpies();
		(host.listTemplates as ReturnType<typeof vi.fn>).mockReturnValue([]);
		const [subagent] = makeSubagentTools(host);
		const r1 = (await subagent.execute!(
			"t1",
			{ action: "get_result", runId: "nope" } as never,
			undefined,
			undefined,
			{} as never,
		)) as { content: { text: string }[] };
		expect(r1.content[0].text).toContain("not found");

		const r2 = (await subagent.execute!("t1", { action: "templates" } as never, undefined, undefined, {} as never)) as {
			content: { text: string }[];
		};
		expect(r2.content[0].text).toContain("No subagent templates");
	});

	it("工具 definition 为纯英文（无双语内联）", () => {
		const host = makeHostSpies();
		const [subagent] = makeSubagentTools(host);
		expect(subagent.description).toContain("subagent");
		expect(subagent.description).not.toMatch(/[\u4e00-\u9fff]/);
	});
});

describe("withSubagentOwner (issue #95)", () => {
	it("包装后 spawn 自动把 ownerId（真正的派发会话）作为父对话传入", async () => {
		const host = makeHostSpies();
		const owned = withSubagentOwner(host, "c1");
		const [subagent] = makeSubagentTools(owned);
		await subagent.execute!("t1", { action: "spawn", prompt: "p" } as never, undefined, undefined, {
			cwd: "/p1",
		} as never);
		expect(host.spawnSubagent).toHaveBeenCalledWith("p", "general", "/p1", undefined, undefined, "c1", undefined);
	});

	it("包装不影响其余 host 方法透传", async () => {
		const host = makeHostSpies();
		const owned = withSubagentOwner(host, "c1");
		expect(owned.listTemplates()).toEqual([{ name: "reviewer", description: "只读审查" }]);
		expect(owned.isTemplateUsable("reviewer")).toBe(true);
		expect(owned.isTemplateUsable("ghost")).toBe(false);
	});
});

describe("subagent parent retention", () => {
	it("有存活子代理指向父对话时保留父对话", () => {
		type Conv = { id: string; parentId?: string };
		const convs = new Map<string, Conv>([
			["c1", { id: "c1" }],
			["sa-1", { id: "sa-1", parentId: "c1" }],
		]);
		const hasLiveChild = (id: string) => [...convs.values()].some((child) => child.parentId === id);
		expect(hasLiveChild("c1")).toBe(true);
		convs.delete("sa-1");
		expect(hasLiveChild("c1")).toBe(false);
	});
});

describe("active subagent quota & retention decoupling (issue #589)", () => {
	function makeFakeConv(opts: {
		id: string;
		isSubagent?: boolean;
		isStreaming?: boolean;
		promptInFlight?: boolean;
		stopReason?: string;
	}): Conversation {
		return {
			id: opts.id,
			title: opts.id,
			isSubagent: opts.isSubagent ?? true,
			promptInFlight: opts.promptInFlight ?? false,
			subagentType: "explore",
			subagentPrompt: "task",
			createdAt: 1,
			session: {
				isStreaming: opts.isStreaming ?? false,
				agent: {
					state: {
						messages: opts.stopReason ? [{ role: "assistant", stopReason: opts.stopReason }] : [],
					},
				},
				getSessionStats: () => ({ totalMessages: 2 }),
				getLastAssistantText: () => "done text",
			},
		} as unknown as Conversation;
	}

	it("isSubagentActive 仅将流式中或首轮投递中的子代理计为活跃，已终态子代理与普通对话不占名额", () => {
		const runningSa = makeFakeConv({ id: "sa-run", isSubagent: true, isStreaming: true });
		const bootingSa = makeFakeConv({ id: "sa-boot", isSubagent: true, isStreaming: false, promptInFlight: true });
		const doneSa = makeFakeConv({ id: "sa-done", isSubagent: true, isStreaming: false, stopReason: "end_turn" });
		const canceledSa = makeFakeConv({ id: "sa-cancel", isSubagent: true, isStreaming: false, stopReason: "aborted" });
		const regularRunning = makeFakeConv({ id: "conv-1", isSubagent: false, isStreaming: true });

		expect(isSubagentActive(runningSa)).toBe(true);
		expect(isSubagentActive(bootingSa)).toBe(true);
		expect(isSubagentActive(doneSa)).toBe(false);
		expect(isSubagentActive(canceledSa)).toBe(false);
		expect(isSubagentActive(regularRunning)).toBe(false);

		// 即使存在 20 个已终态子代理保留在左栏，活跃名额只计 running + booting + 在途 spawning
		const finishedBatch = Array.from({ length: 20 }, (_, i) =>
			makeFakeConv({ id: `sa-fin-${i}`, isSubagent: true, isStreaming: false, stopReason: "end_turn" }),
		);
		const all = [...finishedBatch, runningSa, bootingSa, regularRunning];
		expect(countActiveSubagents(all)).toBe(2);
		expect(countActiveSubagents(all, 3)).toBe(5);
	});

	it("toSubagentSnapshot 在首轮 promptInFlight 窗口内保持 running，落定后转为 done/canceled", () => {
		const booting = makeFakeConv({ id: "sa-boot", isSubagent: true, isStreaming: false, promptInFlight: true });
		const snapBoot = toSubagentSnapshot(booting);
		expect(snapBoot.streaming).toBe(true);
		expect(snapBoot.state).toBe("running");

		booting.promptInFlight = false;
		const snapDone = toSubagentSnapshot(booting);
		expect(snapDone.streaming).toBe(false);
		expect(snapDone.state).toBe("done");
	});

	it("getMaxSubagents 默认返回 MAX_SUBAGENTS (16)，支持 PI_WEB_MAX_SUBAGENTS 覆盖", () => {
		const prev = process.env.PI_WEB_MAX_SUBAGENTS;
		try {
			delete process.env.PI_WEB_MAX_SUBAGENTS;
			expect(getMaxSubagents()).toBe(MAX_SUBAGENTS);
			expect(getMaxSubagents()).toBe(16);

			process.env.PI_WEB_MAX_SUBAGENTS = "32";
			expect(getMaxSubagents()).toBe(32);

			process.env.PI_WEB_MAX_SUBAGENTS = "0";
			expect(getMaxSubagents()).toBe(16);

			process.env.PI_WEB_MAX_SUBAGENTS = "invalid";
			expect(getMaxSubagents()).toBe(16);
		} finally {
			if (prev === undefined) delete process.env.PI_WEB_MAX_SUBAGENTS;
			else process.env.PI_WEB_MAX_SUBAGENTS = prev;
		}
	});
});
