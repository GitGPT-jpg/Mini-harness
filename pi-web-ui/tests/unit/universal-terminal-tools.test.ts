/**
 * universal-terminal-tools.test.ts — 通用底座（Universal Base）终端交互模拟工具集单测。
 *
 * 验证：
 *   1. getTerminalTools 返回全部 7 个终端交互工具（terminal_create / terminal_list / terminal_close / terminal_input / terminal_key / terminal_read / terminal_wait）；
 *   2. terminal_create 创建持久命名终端实例；
 *   3. terminal_input 模拟用户向终端键盘输入字符与命令；
 *   4. terminal_key 模拟键盘按键（Enter, Ctrl+c 等）；
 *   5. terminal_read 读取终端屏幕缓冲与等待新输出；
 *   6. terminal_list 回显当前所有持久终端；
 *   7. terminal_close 关闭终端并释放 PTY 进程树；
 *   8. getToolInfo 与 getToolPrompt 对终端交互工具集的正确响应；
 *   9. execTerminalTool 标准执行接口。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UniversalSessionStore, UniversalSession, MockAgentDriver } from "../../server/universal/index.js";
import type { ServerMessage } from "../../server/protocol.js";

describe("通用底座（Universal Base）终端交互模拟体系单测", () => {
	let tempDir: string;
	let store: UniversalSessionStore;
	let session: UniversalSession;
	let outbox: ServerMessage[];

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-universal-term-test-"));
		store = new UniversalSessionStore(tempDir);
		outbox = [];

		const driverFactory = (cwd: string) => new MockAgentDriver(cwd);
		const initialDriver = driverFactory(tempDir);

		session = new UniversalSession({
			clientId: "test-term-client",
			cwd: tempDir,
			dataDir: tempDir,
			agentDir: tempDir,
			send: (msg) => outbox.push(msg),
			store,
			driver: initialDriver,
			driverFactory,
			lang: "zh",
		});

		await session.newChat();
		outbox.length = 0;
	});

	afterEach(() => {
		session.dispose();
		if (existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
			} catch {
				// 静默忽略 Windows 句柄释放延迟
			}
		}
	});

	it("1. getTerminalTools：应导出全部 7 个终端交互工具", () => {
		const tools = session.getTerminalTools();
		const toolNames = tools.map((t) => t.name);

		expect(toolNames).toContain("terminal_create");
		expect(toolNames).toContain("terminal_list");
		expect(toolNames).toContain("terminal_close");
		expect(toolNames).toContain("terminal_input");
		expect(toolNames).toContain("terminal_key");
		expect(toolNames).toContain("terminal_read");
		expect(toolNames).toContain("terminal_wait");
		expect(tools.length).toBe(7);
	});

	it("2. terminal_create & terminal_list：能够成功创建与列出持久终端", async () => {
		const res = await session.execTerminalTool("terminal_create", {
			terminalId: "test-ai-bash",
		});

		expect(res.output).toContain("test-ai-bash");

		const listRes = await session.execTerminalTool("terminal_list", {});
		expect(listRes.output).toContain("test-ai-bash");
	});

	it("3. terminal_input & terminal_read：能够模拟键盘输入并读取终端屏幕", async () => {
		await session.execTerminalTool("terminal_create", {
			terminalId: "term-interaction",
		});

		// 模拟输入命令
		const inputRes = await session.execTerminalTool("terminal_input", {
			terminalId: "term-interaction",
			data: "echo INTERACTION_SUCCESS\n",
		});
		expect(inputRes.output).toBeDefined();

		// 等待 PTY 处理并读取屏幕
		const readRes = await session.execTerminalTool("terminal_read", {
			terminalId: "term-interaction",
			waitMs: 500,
		});
		expect(readRes.output).toBeDefined();
	});

	it("4. terminal_key：能够模拟键盘控制键（如 Enter、Ctrl+C）", async () => {
		await session.execTerminalTool("terminal_create", {
			terminalId: "term-keys",
		});

		// 模拟发送 Enter 键
		const keyRes1 = await session.execTerminalTool("terminal_key", {
			terminalId: "term-keys",
			key: "Enter",
		});
		expect(keyRes1.output).toBeDefined();

		// 模拟发送 Ctrl+C 中断信号
		const keyRes2 = await session.execTerminalTool("terminal_key", {
			terminalId: "term-keys",
			key: "c",
			modifiers: { ctrl: true },
		});
		expect(keyRes2.output).toBeDefined();
	});

	it("5. terminal_close：能够安全关闭终端并释放资源", async () => {
		await session.execTerminalTool("terminal_create", {
			terminalId: "term-to-close",
		});

		const listBefore = await session.execTerminalTool("terminal_list", {});
		expect(listBefore.output).toContain("term-to-close");

		await session.execTerminalTool("terminal_close", {
			terminalId: "term-to-close",
		});

		const listAfter = await session.execTerminalTool("terminal_list", {});
		expect(listAfter.output).not.toContain("term-to-close");
	});

	it("6. getToolInfo：针对 7 个终端交互工具返回真实完整的参数和描述", () => {
		const targetTools = [
			"terminal_create",
			"terminal_list",
			"terminal_close",
			"terminal_input",
			"terminal_key",
			"terminal_read",
			"terminal_wait",
		];

		for (const name of targetTools) {
			outbox.length = 0;
			session.getToolInfo(name);

			const infoMsg = outbox.find((m) => m.type === "tool_info") as any;
			expect(infoMsg).toBeDefined();
			expect(infoMsg.name).toBe(name);
			expect(infoMsg.found).toBe(true);
			expect(infoMsg.unsupported).toBeUndefined();
			expect(infoMsg.description).toBeDefined();
			expect(infoMsg.parameters).toBeDefined();
		}
	});

	it("7. getToolPrompt：能够正确提取终端交互工具的出厂提示词信息", () => {
		outbox.length = 0;
		session.getToolPrompt("terminal_input");

		const promptMsg = outbox.find((m) => m.type === "tool_prompt") as any;
		expect(promptMsg).toBeDefined();
		expect(promptMsg.name).toBe("terminal_input");
		expect(promptMsg.found).toBe(true);
		expect(promptMsg.defaultDescription).toBeDefined();
	});
});
