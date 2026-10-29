/**
 * piSessionsRoot 单元测试（零 token、零 server）。
 *
 * 背景：设置了 PI_CODING_AGENT_SESSION_DIR 时，pi 把会话以扁平布局写在根目录
 * 顶层（cwd 是 jsonl 文件内字段）；未设置时走 SDK 默认的 <agentDir>/sessions/
 * --<cwd>--/ 子目录布局。
 *
 * 关键约束：env 未设置时必须返回 undefined（让 SDK list()/listAll() 落回默认
 * 子目录路径），**不能**回退到 <agentDir>/sessions——显式传入根目录会让 SDK 只扫
 * 根顶层，默认子目录布局下顶层为空，历史对话/最近项目全丢（0.84.4 实测回归）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { isInsideSessionsDir, piSessionsRoot } from "../../server/agent-service.js";

const original = process.env.PI_CODING_AGENT_SESSION_DIR;
afterEach(() => {
	if (original === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
	else process.env.PI_CODING_AGENT_SESSION_DIR = original;
});

describe("piSessionsRoot", () => {
	it("returns PI_CODING_AGENT_SESSION_DIR verbatim when set (flat root)", () => {
		process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/custom-sessions";
		expect(piSessionsRoot()).toBe("/tmp/custom-sessions");
	});

	it("returns undefined when unset so the SDK falls back to its default per-cwd layout", () => {
		delete process.env.PI_CODING_AGENT_SESSION_DIR;
		expect(piSessionsRoot()).toBeUndefined();
	});

	it("treats an empty env value as unset", () => {
		process.env.PI_CODING_AGENT_SESSION_DIR = "";
		expect(piSessionsRoot()).toBeUndefined();
	});

	it("never carries the legacy per-cwd suffix", () => {
		process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/custom-sessions";
		expect(piSessionsRoot()).not.toMatch(/--/);
	});
});

describe("isInsideSessionsDir", () => {
	const agentDir = "/tmp/agent";
	const inside = "/tmp/agent/sessions/--cwd--/a.jsonl";

	it("allows a transcript under <agentDir>/sessions", () => {
		expect(isInsideSessionsDir(agentDir, inside)).toBe(true);
	});

	it("rejects /tmp/evil.jsonl outside the sessions root", () => {
		expect(isInsideSessionsDir(agentDir, "/tmp/evil.jsonl")).toBe(false);
	});

	it("rejects a sibling prefix (<agentDir>/sessions-evil/a.jsonl)", () => {
		expect(isInsideSessionsDir(agentDir, "/tmp/agent/sessions-evil/a.jsonl")).toBe(false);
	});

	it("rejects .. traversal escaping the sessions root", () => {
		expect(isInsideSessionsDir(agentDir, "/tmp/agent/sessions/../evil.jsonl")).toBe(false);
	});

	it("rejects the sessions root itself (needs a file inside)", () => {
		expect(isInsideSessionsDir(agentDir, "/tmp/agent/sessions")).toBe(false);
	});

	// 额外会话根（PI_CODING_AGENT_SESSION_DIR）：历史列表就是从这个目录扫的，
	// 打开/删除/改名必须与列表**同口径** —— 否则设了该变量的用户「列得出来、点不开」。
	it("allows a transcript under the extra root when PI_CODING_AGENT_SESSION_DIR is set", () => {
		process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/custom-sessions";
		expect(isInsideSessionsDir(agentDir, "/tmp/custom-sessions/2026-01-01T00-00-00-000Z_a.jsonl")).toBe(true);
	});

	it("does not treat the extra root as a sessions root when the env is unset", () => {
		delete process.env.PI_CODING_AGENT_SESSION_DIR;
		expect(isInsideSessionsDir(agentDir, "/tmp/custom-sessions/a.jsonl")).toBe(false);
	});

	it("still rejects paths outside every root while the extra root is set", () => {
		process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/custom-sessions";
		expect(isInsideSessionsDir(agentDir, "/tmp/evil.jsonl")).toBe(false);
		expect(isInsideSessionsDir(agentDir, "/tmp/custom-sessions-evil/a.jsonl")).toBe(false);
		expect(isInsideSessionsDir(agentDir, "/tmp/custom-sessions")).toBe(false);
	});

	it("keeps accepting the default root while the extra root is set", () => {
		process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/custom-sessions";
		expect(isInsideSessionsDir(agentDir, inside)).toBe(true);
	});
});
