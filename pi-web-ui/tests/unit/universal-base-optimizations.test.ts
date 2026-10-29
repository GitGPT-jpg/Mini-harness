/**
 * universal-base-optimizations.test.ts — 通用 Agent 底座核心优化单元测试
 *
 * 覆盖：
 *   1. 临时会话（Ephemeral Chat）与一键转正（Persist Conversation）；
 *   2. 会话历史全文检索（Session Search）；
 *   3. 历史消息编辑重试与会话分叉（Edit Message & Fork Session）；
 *   4. 输入框草稿跨会话持久化记忆（Composer Draft Update）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	UniversalSessionStore,
	UniversalSession,
	MockAgentDriver,
	type UniversalConversation,
} from "../../server/universal/index.js";
import type { ServerMessage, SessionSearchResult, UiMessage } from "../../server/protocol.js";

type SnapshotMsg = Extract<ServerMessage, { type: "snapshot" }>;
type SearchResultsMsg = Extract<ServerMessage, { type: "session_search_results" }>;

describe("Universal Agent 底座核心优化单测", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-universal-opt-test-"));
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
			} catch {
				/* Windows 下文件句柄释放可能有延迟，静默忽略清理异常 */
			}
		}
	});

	describe("1. 临时会话（Ephemeral Chat）与一键转正（Persist Conversation）", () => {
		it("创建临时会话并验证内存常驻与快照 isEphemeral 标记，不写入磁盘 store", async () => {
			const store = new UniversalSessionStore(tempDir);
			const sentMessages: ServerMessage[] = [];
			const driver = new MockAgentDriver(tempDir);

			const session = new UniversalSession({
				clientId: "test-client-ephemeral",
				cwd: tempDir,
				send: (msg) => sentMessages.push(msg),
				store,
				driver,
			});

			// 创建临时会话
			await session.newChat(undefined, true);

			const latestSnapshot = sentMessages.filter((m): m is SnapshotMsg => m.type === "snapshot").pop();
			expect(latestSnapshot).toBeDefined();
			expect(latestSnapshot?.state.isEphemeral).toBe(true);

			const ephemeralConvId = latestSnapshot!.state.conversationId;

			// 验证不写入磁盘 store
			expect(store.loadConversation(tempDir, ephemeralConvId)).toBeNull();

			// 验证在临时会话中交互后，依然只保留在内存中，不落盘
			await session.prompt("你好，临时提问");
			expect(store.loadConversation(tempDir, ephemeralConvId)).toBeNull();

			session.flushSnapshot();
			const afterPromptSnapshot = sentMessages.filter((m): m is SnapshotMsg => m.type === "snapshot").pop();
			expect(afterPromptSnapshot?.state.isEphemeral).toBe(true);

			session.dispose();
		});

		it("支持一键转正 persistConversation，落盘并清除 isEphemeral 标记", async () => {
			const store = new UniversalSessionStore(tempDir);
			const sentMessages: ServerMessage[] = [];
			const driver = new MockAgentDriver(tempDir);

			const session = new UniversalSession({
				clientId: "test-client-persist",
				cwd: tempDir,
				send: (msg) => sentMessages.push(msg),
				store,
				driver,
			});

			// 创建临时会话并发送内容
			await session.newChat(undefined, true);
			const ephemeralSnapshot = sentMessages.filter((m): m is SnapshotMsg => m.type === "snapshot").pop();
			const convId = ephemeralSnapshot!.state.conversationId;

			await session.prompt("临时对话要保存的内容");
			expect(store.loadConversation(tempDir, convId)).toBeNull();

			// 执行转正
			await session.persistConversation(convId);

			// 磁盘应成功落盘
			const loadedFromDisk = store.loadConversation(tempDir, convId);
			expect(loadedFromDisk).toBeDefined();
			expect(loadedFromDisk?.isEphemeral).toBe(false);
			expect(loadedFromDisk?.messages.length).toBeGreaterThan(0);

			// 最新快照中的 isEphemeral 应变为 false
			const persistedSnapshot = sentMessages.filter((m): m is SnapshotMsg => m.type === "snapshot").pop();
			expect(persistedSnapshot?.state.isEphemeral).toBe(false);

			// 重复对已持久化会话调用给出友好 notice
			await session.persistConversation(convId);
			const noticeMsg = sentMessages.filter((m) => m.type === "notice").pop();
			expect(noticeMsg).toBeDefined();

			session.dispose();
		});
	});

	describe("2. 会话历史全文检索（Session Search）", () => {
		it("能够通过标题与消息内容全文检索命中会话并返回锚点信息", async () => {
			const store = new UniversalSessionStore(tempDir);
			const sentMessages: ServerMessage[] = [];
			const driver = new MockAgentDriver(tempDir);

			// 预置一个落盘的会话 A
			const convA: UniversalConversation = {
				id: "uconv-search-a",
				title: "架构设计探讨",
				createdAt: 1000,
				updatedAt: 1000,
				messages: [
					{
						id: "msg-a-1",
						role: "user",
						content: [{ type: "text", text: "探讨微服务体系与通信协议" }],
						timestamp: 1000,
					},
					{
						id: "msg-a-2",
						role: "assistant",
						content: [{ type: "text", text: "微服务架构的关键在于 RPC 协议与服务发现" }],
						timestamp: 1005,
					},
				],
			};
			store.saveConversation(tempDir, convA);

			const session = new UniversalSession({
				clientId: "test-client-search",
				cwd: tempDir,
				send: (msg) => sentMessages.push(msg),
				store,
				driver,
			});

			// 在内存中新建一个会话 B
			await session.newChat();
			await session.prompt("前端性能优化指南");

			// 1. 标题匹配
			await session.searchSessions("架构设计", 101);
			const titleSearchResult = sentMessages
				.filter((m): m is SearchResultsMsg => m.type === "session_search_results" && m.reqId === 101)
				.pop();
			expect(titleSearchResult).toBeDefined();
			expect(titleSearchResult?.ok).toBe(true);
			expect(titleSearchResult?.results.some((r: SessionSearchResult) => r.sessionId === "uconv-search-a")).toBe(true);

			// 2. 消息内容全文匹配
			await session.searchSessions("服务发现", 102);
			const contentSearchResult = sentMessages
				.filter((m): m is SearchResultsMsg => m.type === "session_search_results" && m.reqId === 102)
				.pop();
			expect(contentSearchResult).toBeDefined();
			expect(contentSearchResult?.results.length).toBeGreaterThan(0);
			const hitA = contentSearchResult?.results.find((r: SessionSearchResult) => r.sessionId === "uconv-search-a");
			expect(hitA).toBeDefined();
			expect(hitA?.anchors.length).toBeGreaterThan(0);
			expect(hitA?.anchors[0].role).toBe("assistant");

			// 3. 内存新建会话匹配
			await session.searchSessions("性能优化", 103);
			const memorySearchResult = sentMessages
				.filter((m): m is SearchResultsMsg => m.type === "session_search_results" && m.reqId === 103)
				.pop();
			expect(memorySearchResult).toBeDefined();
			expect(memorySearchResult?.results.length).toBeGreaterThan(0);

			// 4. 空关键词返回空结果
			await session.searchSessions("   ", 104);
			const emptySearchResult = sentMessages
				.filter((m): m is SearchResultsMsg => m.type === "session_search_results" && m.reqId === 104)
				.pop();
			expect(emptySearchResult?.results).toEqual([]);

			session.dispose();
		});
	});

	describe("3. 历史消息编辑重试与会话分叉（Edit Message & Fork Session）", () => {
		it("forkSession 从指定节点分叉并保留截断之前的上下文", async () => {
			const store = new UniversalSessionStore(tempDir);
			const sentMessages: ServerMessage[] = [];
			const driver = new MockAgentDriver(tempDir);

			const session = new UniversalSession({
				clientId: "test-client-fork",
				cwd: tempDir,
				send: (msg) => sentMessages.push(msg),
				store,
				driver,
			});

			await session.prompt("第一轮问题");
			await session.prompt("第二轮问题");

			session.flushSnapshot();
			const baseSnapshot = sentMessages.filter((m): m is SnapshotMsg => m.type === "snapshot").pop();
			const originalMessages: UiMessage[] = baseSnapshot!.state.messages;
			expect(originalMessages.length).toBeGreaterThanOrEqual(2);

			const secondUserMsg = originalMessages.filter((m: UiMessage) => m.role === "user")[1];
			expect(secondUserMsg).toBeDefined();

			// 从第二条用户提问之前截断分叉 ("before")
			await session.forkSession(secondUserMsg.id, "before");

			const forkedSnapshot = sentMessages.filter((m): m is SnapshotMsg => m.type === "snapshot").pop();
			expect(forkedSnapshot).toBeDefined();
			expect(forkedSnapshot!.state.conversationId).not.toBe(baseSnapshot!.state.conversationId);

			// 分叉后会话的消息列表应不包含第二条用户消息
			const forkedMessages: UiMessage[] = forkedSnapshot!.state.messages;
			expect(forkedMessages.some((m: UiMessage) => m.id === secondUserMsg.id)).toBe(false);

			// 包含第一条提问
			const firstUserMsg = originalMessages.filter((m: UiMessage) => m.role === "user")[0];
			expect(forkedMessages.some((m: UiMessage) => m.id === firstUserMsg.id)).toBe(true);

			session.dispose();
		});

		it("editMessage 截断历史并在新分支上投递编辑后的提示词", async () => {
			const store = new UniversalSessionStore(tempDir);
			const sentMessages: ServerMessage[] = [];
			const driver = new MockAgentDriver(tempDir);

			const session = new UniversalSession({
				clientId: "test-client-edit",
				cwd: tempDir,
				send: (msg) => sentMessages.push(msg),
				store,
				driver,
			});

			await session.prompt("历史提问 1");
			await session.prompt("历史提问 2");

			session.flushSnapshot();
			const origSnapshot = sentMessages.filter((m): m is SnapshotMsg => m.type === "snapshot").pop();
			const userMsgs = origSnapshot!.state.messages.filter((m: UiMessage) => m.role === "user");
			const targetMsg = userMsgs[1];

			// 编辑第二轮提问
			await session.editMessage(targetMsg.id, "修改后的提问 2 内容");

			session.flushSnapshot();
			const editedSnapshot = sentMessages.filter((m): m is SnapshotMsg => m.type === "snapshot").pop();
			expect(editedSnapshot).toBeDefined();
			expect(editedSnapshot!.state.conversationId).not.toBe(origSnapshot!.state.conversationId);

			// 新会话消息验证：第一轮历史保留，第二轮变成修改后的提问
			const newMsgs: UiMessage[] = editedSnapshot!.state.messages;
			const newUsers = newMsgs.filter((m: UiMessage) => m.role === "user");
			expect(newUsers.length).toBe(2);
			expect(newUsers[0].content).toEqual([{ type: "text", text: "历史提问 1" }]);
			expect(newUsers[1].content).toEqual([{ type: "text", text: "修改后的提问 2 内容" }]);

			session.dispose();
		});
	});

	describe("4. 输入框草稿跨会话持久化记忆（Composer Draft Update）", () => {
		it("能够保存草稿并在切换会话时恢复对应草稿，发送后自动清除", async () => {
			const store = new UniversalSessionStore(tempDir);
			const sentMessages: ServerMessage[] = [];
			const driver = new MockAgentDriver(tempDir);

			const session = new UniversalSession({
				clientId: "test-client-draft",
				cwd: tempDir,
				send: (msg) => sentMessages.push(msg),
				store,
				driver,
			});

			session.flushSnapshot();
			const initSnap = sentMessages.filter((m): m is SnapshotMsg => m.type === "snapshot").pop();
			const convAId = initSnap!.state.conversationId;

			// 会话 A 写入草稿
			session.saveDraft(convAId, "未发送的草稿 A", 123456);

			session.flushSnapshot();
			const snapWithDraftA = sentMessages.filter((m): m is SnapshotMsg => m.type === "snapshot").pop();
			expect(snapWithDraftA?.state.draft).toEqual({ text: "未发送的草稿 A", ts: 123456 });

			// 新建会话 B
			await session.newChat();
			const snapConvB = sentMessages.filter((m): m is SnapshotMsg => m.type === "snapshot").pop();
			const convBId = snapConvB!.state.conversationId;
			expect(snapConvB?.state.draft).toBeNull();

			// 切回会话 A，草稿自动恢复
			await session.switchConversation(convAId);
			const snapBackToA = sentMessages.filter((m): m is SnapshotMsg => m.type === "snapshot").pop();
			expect(snapBackToA?.state.draft).toEqual({ text: "未发送的草稿 A", ts: 123456 });

			// 会话 A 发送消息后，草稿自动清除
			await session.prompt("直接发送");
			session.flushSnapshot();
			const snapAfterSend = sentMessages.filter((m): m is SnapshotMsg => m.type === "snapshot").pop();
			expect(snapAfterSend?.state.draft).toBeNull();

			session.dispose();
		});
	});
});
