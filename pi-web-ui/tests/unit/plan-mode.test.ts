/**
 * 计划模式闸门单测（纯函数，无 IO）。
 */
import { describe, expect, it } from "vitest";
import {
	bashCommandIsReadOnly,
	buildPlanModePrompt,
	planModeDenial,
	PLAN_MODE_BLOCKED_TOOL_NAMES,
	PLAN_MODE_SYSTEM_PROMPT,
} from "../../server/plan-mode.js";

describe("bashCommandIsReadOnly", () => {
	it("放行只读命令", () => {
		for (const cmd of [
			"ls -la",
			"cat server/index.ts",
			"git status",
			"git diff --stat",
			"git log --oneline -5",
			"rg -n set_plan_mode server",
			"grep -rn foo . | head -20",
			"wc -l *.ts",
			"jq .name package.json",
			"find . -name '*.ts' -newer package.json",
			"node --version",
			"pwd && ls",
			"cat a.txt | grep x | wc -l",
			"LC_ALL=C sort f.txt",
		]) {
			expect(bashCommandIsReadOnly(cmd), cmd).toBe(true);
		}
	});

	it("拒绝写操作与命令替换", () => {
		for (const cmd of [
			"",
			"rm -rf dist",
			"mkdir -p out",
			"git commit -m x",
			"git push",
			"npm install",
			"npm run build",
			'node -e \'require("fs").rmSync("x")\'',
			"echo hi > out.txt",
			"cat f | tee g",
			"sed -i 's/a/b/' f.ts",
			"awk '{print > \"f\"}'",
			"find . -name '*.log' -delete",
			"find . -exec touch pwned {} +",
			"find . -name '*.tmp' -execdir rm {} \\;",
			"find . -fprintf /tmp/pwn x",
			"ls $(git rev-parse HEAD)",
			"sleep 5 &",
			"cat <<EOF",
			"python3 script.py",
		]) {
			expect(bashCommandIsReadOnly(cmd), cmd).toBe(false);
		}
	});

	it("任何一段写命令即整条拒绝", () => {
		expect(bashCommandIsReadOnly("ls && rm -rf /")).toBe(false);
		expect(bashCommandIsReadOnly("git status; git push")).toBe(false);
		expect(bashCommandIsReadOnly("cat f | tee g")).toBe(false);
	});
});

describe("planModeDenial", () => {
	it("放行只读工具", () => {
		for (const t of ["read", "grep", "ls", "plan_update", "present_files", "scm", "conversation_read", "skill"]) {
			expect(planModeDenial(t, {}), t).toBeUndefined();
		}
	});

	it("拒绝写类工具并给出计划替代路径", () => {
		const d = planModeDenial("write", { path: "a.ts", content: "x" });
		expect(d?.kind).toBe("write-tool");
		expect(d?.reason).toContain("plan_update");
		expect(d?.reasonEn).toContain("Plan mode");
		expect(planModeDenial("edit_soft", {})?.kind).toBe("write-tool");
		expect(planModeDenial("patch", {})?.kind).toBe("write-tool");
		expect(planModeDenial("git", { command: "commit" })?.kind).toBe("write-tool");
		// 回归 #436：eval 沙箱的 execute 直接 kernel.execute 可写真实文件系统。
		expect(planModeDenial("eval", { code: "require('fs').writeFileSync('x','y')" })?.kind).toBe("write-tool");
		// codemode 沙箱代码执行可嵌套调用写工具与执行命令，计划模式禁止。
		expect(planModeDenial("codemode", { code: "tools.write({ path: 'a.txt', content: 'x' })" })?.kind).toBe(
			"write-tool",
		);
	});

	it("bash 只放行只读命令", () => {
		expect(planModeDenial("bash", { command: "git diff" })).toBeUndefined();
		const d = planModeDenial("bash", { command: "npm run build" });
		expect(d?.kind).toBe("bash");
		expect(d?.reasonEn).toContain("read-only");
		expect(planModeDenial("bash", {})?.kind).toBe("bash");
	});

	it("拒绝旁路工具（会在别的会话实施）", () => {
		expect(planModeDenial("delegate_task", {})?.kind).toBe("bypass-tool");
		// 回归 #436：schedule 是真实注册的排程工具（单 action），到期唤醒对话执行 prompt。
		expect(planModeDenial("schedule", {})?.kind).toBe("bypass-tool");
	});

	// 回归 #436：subagent 此前只拒 spawn，steer/handoff 全放行 —— 向运行中的
	// 子代理会话投指令让它继续写代码，而子代理 planMode=false 工具齐全。
	// 对齐 goal-review-gate 口径：只读 action 放行，其余（含未知/未传）一律拒。
	it("subagent 只放行只读 action，写向 action 一律拒", () => {
		for (const readonly of ["get_result", "list", "templates"]) {
			expect(planModeDenial("subagent", { action: readonly }), readonly).toBeUndefined();
		}
		for (const action of ["spawn", "steer", "stop", "wait_all", "handoff", "erase"]) {
			const d = planModeDenial("subagent", { action });
			expect(d, action).toBeDefined();
			expect(d!.kind).toBe("bypass-tool");
		}
		expect(planModeDenial("subagent", { action: "" })?.kind).toBe("bypass-tool");
		expect(planModeDenial("subagent", {})?.kind).toBe("bypass-tool");
		expect(planModeDenial("subagent", undefined)?.kind).toBe("bypass-tool");
	});

	// 回归 #436：terminal_input 只在自带换行时才过 checkSafety，terminal_key 的
	// Enter 连检查都没有 —— 「input(无换行) + key(Enter)」即可绕过 bash 只读白名单。
	it("拒绝常驻终端写向工具（terminal_input/terminal_key）", () => {
		for (const [name, params] of [
			["terminal_input", { terminalId: "t1", data: "rm -rf dist" }],
			["terminal_input", { terminalId: "t1", data: "y" }],
			["terminal_key", { terminalId: "t1", key: "Enter" }],
		] as const) {
			const d = planModeDenial(name, params);
			expect(d, name).toBeDefined();
			expect(d!.kind).toBe("write-tool");
			expect(d!.reasonEn).toContain("Plan mode");
		}
	});
});

describe("PLAN_MODE_BLOCKED_TOOL_NAMES（活跃集剥离名单）", () => {
	it("终端写向工具在剥离名单里（只读的 read/list/wait 不在）", () => {
		expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has("terminal_input")).toBe(true);
		expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has("terminal_key")).toBe(true);
		expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has("codemode")).toBe(true);
		for (const readonly of ["terminal_read", "terminal_list", "terminal_wait", "read", "grep"]) {
			expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has(readonly), readonly).toBe(false);
		}
	});

	// 回归 #436：eval 用户可开（默认关），开了就必须随计划模式一起剥离。
	it("eval 在剥离名单里", () => {
		expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has("eval")).toBe(true);
	});

	// 回归 #436：名单以 server/tool-manager.ts 实际注册的工具名为事实源 ——
	// 幽灵名（协议消息/从未注册）全部清掉，真实的 schedule 补进来。
	it("幽灵名不再出现在剥离名单，真实旁路工具在", () => {
		for (const ghost of [
			"spawn",
			"spawn_agent",
			"subagent_spawn",
			"schedule_agent",
			"host_schedule",
			"create_goal",
			"set_goal",
			"start_goal_wizard",
			"create_conversation",
			"fork_conversation",
			"set_plan_mode",
		]) {
			expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has(ghost), ghost).toBe(false);
		}
		expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has("delegate_task")).toBe(true);
		expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has("schedule")).toBe(true);
	});
});

describe("PLAN_MODE_SYSTEM_PROMPT", () => {
	it("纯英文且含关键约束（工具提示词卫生口径）", () => {
		expect(/[一-鿿]/.test(PLAN_MODE_SYSTEM_PROMPT)).toBe(false);
		expect(PLAN_MODE_SYSTEM_PROMPT).toContain("plan_update");
		expect(PLAN_MODE_SYSTEM_PROMPT).toContain("do NOT implement");
	});

	// 回归：模型在计划模式下写不出文件，于是把整份实现当正文吐出来（烧 token
	// 又没落地）。这两条是内置提示词真正的载荷，别在改写时删掉。
	it("禁止把实现代码写进回复（禁倾倒整文件/完整函数）", () => {
		expect(PLAN_MODE_SYSTEM_PROMPT).toContain("NEVER write the implementation");
		expect(PLAN_MODE_SYSTEM_PROMPT).toContain("No file dumps");
	});

	it("小需求可跳过 plan_update 走短计划", () => {
		expect(PLAN_MODE_SYSTEM_PROMPT).toContain("skip plan_update entirely");
	});
});

describe("buildPlanModePrompt", () => {
	it("空自定义 = 纯内置默认（两种模式都是）", () => {
		expect(buildPlanModePrompt("append", "")).toBe(PLAN_MODE_SYSTEM_PROMPT);
		expect(buildPlanModePrompt("replace", "   ")).toBe(PLAN_MODE_SYSTEM_PROMPT);
	});

	it("追加模式：内置默认 + 空行 + 自定义", () => {
		expect(buildPlanModePrompt("append", "extra")).toBe(`${PLAN_MODE_SYSTEM_PROMPT}\n\nextra`);
	});

	it("替换模式：只发自定义（非空时）", () => {
		expect(buildPlanModePrompt("replace", "only this")).toBe("only this");
	});
});
