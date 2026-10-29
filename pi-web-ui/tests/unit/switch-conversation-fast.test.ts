import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("switchConversation 性能与快速切换优化 (#switch-conv-perf)", () => {
	it("源码保证 switchConversation 先 flushSnapshot 和 transition_progress done，后 pushSettings", () => {
		const src = readFileSync(join(__dirname, "../../server/agent-service.ts"), "utf-8");
		const switchConvStart = src.indexOf("async switchConversation(id: string): Promise<void> {");
		expect(switchConvStart).toBeGreaterThan(0);
		const switchConvEnd = src.indexOf("private shownInRunningList(conv: Conversation): boolean {", switchConvStart);
		expect(switchConvEnd).toBeGreaterThan(switchConvStart);

		const switchConvBody = src.slice(switchConvStart, switchConvEnd);

		// 检查 1: 遇到不存在的对话发送 transition_progress error 提示
		expect(switchConvBody).toContain('type: "transition_progress"');
		expect(switchConvBody).toContain('phase: "error"');

		// 检查 2: 快照优先，先 flushSnapshot，再 transition_progress done，最后才 pushSettings
		const flushIdx = switchConvBody.indexOf("this.flushSnapshot();");
		const doneIdx = switchConvBody.indexOf('phase: "done"');
		const pushSettingsIdx = switchConvBody.indexOf("this.pushSettings();");

		expect(flushIdx).toBeGreaterThan(0);
		expect(doneIdx).toBeGreaterThan(flushIdx);
		expect(pushSettingsIdx).toBeGreaterThan(doneIdx);

		// 检查 3: 跨项目切换时调用 unwatchGit 释放旧工作区 Git watcher
		expect(switchConvBody).toContain("this.files.unwatchGit()");
	});

	it("refreshSessionsOnSwitch 使用 SESSION_INFO_CACHE_TTL (30s) 而不是粗暴的 2 秒", () => {
		const src = readFileSync(join(__dirname, "../../server/agent-service.ts"), "utf-8");
		const refreshStart = src.indexOf("private refreshSessionsOnSwitch(): void {");
		expect(refreshStart).toBeGreaterThan(0);
		const refreshEnd = src.indexOf("private async pushSessions(): Promise<void> {", refreshStart);
		const refreshBody = src.slice(refreshStart, refreshEnd);

		expect(refreshBody).toContain("ClientSession.SESSION_INFO_CACHE_TTL");
		expect(refreshBody).not.toContain("2_000");
	});

	it("switchSession 在跨项目打开历史会话时也会调用 unwatchGit", () => {
		const src = readFileSync(join(__dirname, "../../server/agent-service.ts"), "utf-8");
		const switchSessionStart = src.indexOf("async switchSession(path: string, sessionId?: string): Promise<void> {");
		expect(switchSessionStart).toBeGreaterThan(0);
		const targetCwdIdx = src.indexOf("this.cwd = targetCwd;", switchSessionStart);
		expect(targetCwdIdx).toBeGreaterThan(switchSessionStart);

		const sliceAroundTargetCwd = src.slice(targetCwdIdx, targetCwdIdx + 200);
		expect(sliceAroundTargetCwd).toContain("this.files.unwatchGit();");
	});
});
