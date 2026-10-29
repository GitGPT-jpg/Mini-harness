import { describe, expect, it, vi } from "vitest";
import { handleSettingsMessage } from "../../server/dispatch-domain-handlers.js";
import type { ClientMessage } from "../../server/protocol.js";
import type { DispatchSession } from "../../server/index.js";
import { PUBLIC_SKILLS } from "../../web/src/skill-catalog.js";
import { PUBLIC_MCP_SERVERS } from "../../web/src/mcp-catalog.js";

describe("Skill 技能市场消息分发与清单体检", () => {
	it("分发 install_skill 消息", () => {
		const installSkill = vi.fn();
		const mockSession = {
			installSkill,
		} as unknown as DispatchSession;

		const msg: ClientMessage = {
			type: "install_skill",
			name: "code-review",
			scope: "global",
			content: "---\nname: code-review\n---\n# Guide",
		};

		const handled = handleSettingsMessage(msg, mockSession);
		expect(handled).toBe(true);
		expect(installSkill).toHaveBeenCalledWith("code-review", "global", msg.content);
	});

	it("分发 uninstall_skill 消息", () => {
		const uninstallSkill = vi.fn();
		const mockSession = {
			uninstallSkill,
		} as unknown as DispatchSession;

		const msg: ClientMessage = {
			type: "uninstall_skill",
			name: "code-review",
			scope: "project",
		};

		const handled = handleSettingsMessage(msg, mockSession);
		expect(handled).toBe(true);
		expect(uninstallSkill).toHaveBeenCalledWith("code-review", "project");
	});

	it("PUBLIC_SKILLS 目录清单规范性校验", () => {
		expect(PUBLIC_SKILLS.length).toBeGreaterThanOrEqual(10);
		for (const sk of PUBLIC_SKILLS) {
			expect(/^[a-zA-Z0-9_-]+$/.test(sk.id)).toBe(true);
			expect(sk.name.trim().length).toBeGreaterThan(0);
			expect(sk.nameZh.trim().length).toBeGreaterThan(0);
			expect(sk.description.trim().length).toBeGreaterThan(0);
			expect(sk.descriptionZh.trim().length).toBeGreaterThan(0);
			expect(sk.content.startsWith("---")).toBe(true);
			expect(sk.content).toContain(`name: ${sk.id}`);
		}
	});

	it("PUBLIC_MCP_SERVERS 目录清单规范性校验", () => {
		expect(PUBLIC_MCP_SERVERS.length).toBeGreaterThanOrEqual(12);
		for (const srv of PUBLIC_MCP_SERVERS) {
			expect(/^[a-zA-Z0-9_-]+$/.test(srv.id)).toBe(true);
			expect(srv.name.trim().length).toBeGreaterThan(0);
			expect(srv.package.trim().length).toBeGreaterThan(0);
			expect(srv.description.trim().length).toBeGreaterThan(0);
			expect(srv.descriptionZh.trim().length).toBeGreaterThan(0);
		}
	});
});
