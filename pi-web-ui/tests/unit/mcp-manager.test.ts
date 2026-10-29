import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	deleteMcpServer,
	getGlobalMcpPath,
	getProjectMcpPath,
	isValidMcpServerName,
	listAllMcpServers,
	readMcpConfigFile,
	saveMcpServer,
	toggleMcpServer,
	writeMcpConfigFile,
} from "../../server/mcp-manager.js";
import type { UiMcpServer } from "../../server/protocol.js";

function makeTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("mcp-manager", () => {
	it("isValidMcpServerName 校验服务器名", () => {
		expect(isValidMcpServerName("filesystem")).toBe(true);
		expect(isValidMcpServerName("my-server_1")).toBe(true);
		expect(isValidMcpServerName("invalid server")).toBe(false);
		expect(isValidMcpServerName("server:1")).toBe(false);
		expect(isValidMcpServerName("")).toBe(false);
	});

	it("readMcpConfigFile / writeMcpConfigFile 读写与保持格式", () => {
		const dir = makeTempDir("mcp-test-");
		try {
			const file = join(dir, "mcp.json");
			// 1. 写入标准 mcpServers 格式
			writeMcpConfigFile(file, {
				git: { command: "node", args: ["git.js"] },
			});
			const read1 = readMcpConfigFile(file);
			expect(read1.exists).toBe(true);
			expect(read1.legacy).toBe(false);
			expect(read1.servers.git.command).toBe("node");

			// 2. 写入遗留 servers 格式
			writeMcpConfigFile(
				file,
				{
					git: { command: "node", args: ["git.js"] },
				},
				true,
			);
			const read2 = readMcpConfigFile(file);
			expect(read2.legacy).toBe(true);
			expect(read2.servers.git.command).toBe("node");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("listAllMcpServers 能分别汇总全局和项目级服务器", () => {
		const agentDir = makeTempDir("mcp-agent-");
		const cwd = makeTempDir("mcp-proj-");
		try {
			// 写全局
			writeMcpConfigFile(join(agentDir, "mcp.json"), {
				globalSrv: { command: "node", args: ["g.js"], description: "Global Server" },
			});
			// 写项目级
			writeMcpConfigFile(join(cwd, ".pi", "mcp.json"), {
				projSrv: { command: "python", args: ["p.py"], description: "Project Server" },
			});

			const res = listAllMcpServers({ agentDir, cwd });
			expect(res.servers.length).toBe(2);

			const g = res.servers.find((s) => s.name === "globalSrv");
			expect(g).toBeDefined();
			expect(g?.scope).toBe("global");
			expect(g?.command).toBe("node");

			const p = res.servers.find((s) => s.name === "projSrv");
			expect(p).toBeDefined();
			expect(p?.scope).toBe("project");
			expect(p?.command).toBe("python");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("saveMcpServer 支持新增、修改、重命名跨作用域移动", () => {
		const agentDir = makeTempDir("mcp-agent-");
		const cwd = makeTempDir("mcp-proj-");
		try {
			// 1. 新增全局服务器
			const srv1: UiMcpServer = {
				name: "test-global",
				scope: "global",
				command: "npx",
				args: ["-y", "mcp-pkg"],
				enabled: true,
			};
			const res1 = saveMcpServer({ agentDir, cwd, server: srv1 });
			expect(res1.ok).toBe(true);

			const list1 = listAllMcpServers({ agentDir, cwd });
			expect(list1.servers.find((s) => s.name === "test-global")?.scope).toBe("global");

			// 2. 将其修改为项目级并改名
			const srv2: UiMcpServer = {
				name: "test-proj",
				scope: "project",
				command: "npx",
				args: ["-y", "mcp-pkg-v2"],
				enabled: true,
			};
			const res2 = saveMcpServer({
				agentDir,
				cwd,
				server: srv2,
				prevName: "test-global",
				prevScope: "global",
			});
			expect(res2.ok).toBe(true);

			const list2 = listAllMcpServers({ agentDir, cwd });
			// 原全局应被删除
			expect(list2.servers.find((s) => s.name === "test-global")).toBeUndefined();
			// 新项目级应存在
			const projHit = list2.servers.find((s) => s.name === "test-proj");
			expect(projHit).toBeDefined();
			expect(projHit?.scope).toBe("project");
			expect(projHit?.args).toEqual(["-y", "mcp-pkg-v2"]);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("toggleMcpServer 与 deleteMcpServer", () => {
		const agentDir = makeTempDir("mcp-agent-");
		const cwd = makeTempDir("mcp-proj-");
		try {
			// 写全局服务器
			writeMcpConfigFile(join(agentDir, "mcp.json"), {
				srv: { command: "node", args: ["s.js"], enabled: true },
			});

			// 切换停用
			const togRes = toggleMcpServer({ agentDir, cwd, name: "srv", scope: "global", enabled: false });
			expect(togRes.ok).toBe(true);

			const afterTog = listAllMcpServers({ agentDir, cwd });
			expect(afterTog.servers.find((s) => s.name === "srv")?.enabled).toBe(false);

			// 项目级对全局服务器进行局部禁用覆盖
			const projTog = toggleMcpServer({ agentDir, cwd, name: "srv", scope: "project", enabled: false });
			expect(projTog.ok).toBe(true);
			const projCfg = readMcpConfigFile(join(cwd, ".pi", "mcp.json"));
			expect(projCfg.servers.srv?.enabled).toBe(false);

			// 删除全局服务器
			const delRes = deleteMcpServer({ agentDir, cwd, name: "srv", scope: "global" });
			expect(delRes.ok).toBe(true);
			const afterDel = listAllMcpServers({ agentDir, cwd });
			expect(afterDel.servers.find((s) => s.scope === "global" && s.name === "srv")).toBeUndefined();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
