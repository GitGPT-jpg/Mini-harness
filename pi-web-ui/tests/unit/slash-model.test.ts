import { describe, expect, it, vi } from "vitest";
import { SlashCommandsService } from "../../server/slash-commands.js";

const makeHost = (over: Record<string, unknown> = {}) => ({
	emit: vi.fn(),
	cwd: () => "/tmp",
	getSession: () =>
		({
			modelRuntime: {
				getAvailable: vi.fn(async () => []),
			},
		}) as never,
	newChat: vi.fn(async () => {}),
	setModel: vi.fn(async () => {}),
	setCwd: vi.fn(async () => {}),
	setThinking: vi.fn(),
	...over,
});

describe("/model slash command", () => {
	it("bare /model prints current model and usage info", async () => {
		const h = makeHost({
			getModel: () => ({ id: "mock-model", name: "Mock Model", provider: "mock" }),
		});
		const svc = new SlashCommandsService(h as never);
		expect(await svc.exec("model", "")).toBe(true);
		expect(h.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "notice",
				level: "info",
				text: expect.stringContaining("当前模型：Mock Model（mock/mock-model）"),
			}),
		);
		expect(h.setModel).not.toHaveBeenCalled();
	});

	it("emits error notice and does not call setModel when available models list is empty", async () => {
		const h = makeHost({
			getSession: () =>
				({
					modelRuntime: {
						getAvailable: vi.fn(async () => []),
					},
				}) as never,
		});
		const svc = new SlashCommandsService(h as never);
		expect(await svc.exec("model", "这个模型必然不存在xyz")).toBe(true);
		expect(h.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "notice",
				level: "error",
				text: expect.stringContaining("没有匹配到模型：这个模型必然不存在xyz"),
			}),
		);
		expect(h.setModel).not.toHaveBeenCalled();
	});

	it("emits error notice when available models are present but none match query", async () => {
		const h = makeHost({
			getAvailableModels: vi.fn(async () => [
				{ id: "gpt-4o", name: "GPT-4o", provider: "openai" },
				{ id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", provider: "anthropic" },
			]),
		});
		const svc = new SlashCommandsService(h as never);
		expect(await svc.exec("model", "non-existent-model")).toBe(true);
		expect(h.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "notice",
				level: "error",
				text: expect.stringContaining("没有匹配到模型：non-existent-model"),
			}),
		);
		expect(h.setModel).not.toHaveBeenCalled();
	});

	it("picks matching model and calls setModel when matched", async () => {
		const h = makeHost({
			getAvailableModels: vi.fn(async () => [
				{ id: "gpt-4o", name: "GPT-4o", provider: "openai" },
				{ id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", provider: "anthropic" },
			]),
		});
		const svc = new SlashCommandsService(h as never);
		expect(await svc.exec("model", "claude")).toBe(true);
		expect(h.setModel).toHaveBeenCalledWith("anthropic/claude-3-5-sonnet");
	});

	it("falls back to calling setModel directly when no model lister is provided by host", async () => {
		const h = makeHost({
			getSession: undefined,
			getAvailableModels: undefined,
		});
		const svc = new SlashCommandsService(h as never);
		expect(await svc.exec("model", "custom-driver-model")).toBe(true);
		expect(h.setModel).toHaveBeenCalledWith("custom-driver-model");
	});
});
