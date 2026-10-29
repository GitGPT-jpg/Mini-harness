import { describe, expect, it, vi } from "vitest";
import { SlashCommandsService, parseSlash, type SlashHost } from "../../server/slash-commands.js";

function makeHost(overrides: Partial<SlashHost> = {}): SlashHost {
	return {
		emit: vi.fn(),
		cwd: () => "/workspace",
		getSession: () => ({}) as any,
		newChat: vi.fn(async () => {}),
		setModel: vi.fn(async () => {}),
		setCwd: vi.fn(async () => {}),
		setThinking: vi.fn(),
		refreshSessions: vi.fn(async () => {}),
		...overrides,
	};
}

describe("/plan slash command (#435)", () => {
	it("/plan on 开启计划模式", async () => {
		const setPlanMode = vi.fn();
		const host = makeHost({
			setPlanMode,
			getPlanMode: () => false,
		});
		const svc = new SlashCommandsService(host);
		const parsed = parseSlash("/plan on")!;
		const handled = await svc.exec(parsed.name, parsed.args);
		expect(handled).toBe(true);
		expect(setPlanMode).toHaveBeenCalledWith(true);
	});

	it("/plan off 关闭计划模式", async () => {
		const setPlanMode = vi.fn();
		const host = makeHost({
			setPlanMode,
			getPlanMode: () => true,
		});
		const svc = new SlashCommandsService(host);
		const parsed = parseSlash("/plan off")!;
		const handled = await svc.exec(parsed.name, parsed.args);
		expect(handled).toBe(true);
		expect(setPlanMode).toHaveBeenCalledWith(false);
	});

	it("/plan 无参数翻转当前状态", async () => {
		let current = false;
		const setPlanMode = vi.fn((next: boolean) => {
			current = next;
		});
		const host = makeHost({
			setPlanMode,
			getPlanMode: () => current,
		});
		const svc = new SlashCommandsService(host);

		const p1 = parseSlash("/plan")!;
		await svc.exec(p1.name, p1.args);
		expect(setPlanMode).toHaveBeenLastCalledWith(true);

		const p2 = parseSlash("/plan")!;
		await svc.exec(p2.name, p2.args);
		expect(setPlanMode).toHaveBeenLastCalledWith(false);
	});
});
