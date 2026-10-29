// question-bridge — 标准 pi 引擎的 ask_user_question 问卷桥（零 token）。
//
// 本地假模型（openai-completions SSE）第一回合固定回一个 ask_user_question
// 工具调用，第二回合把工具结果原样回显成 assistant 文本 —— 整条链路不需要真模型。
//
// 验证：
//   1. 模型调 ask_user_question → question_pending（id + questions 透传）
//   2. 快照携带 pendingQuestion（UiState）→ 重连/刷新能恢复对话框
//      （第二个同 clientId 的连接 = 刷新页面；它的首帧快照必须带回问卷）
//   3. 【本测试的核心】问卷豁免工具挂死看门狗：PI_WEB_TOOL_TIMEOUT_MS=2000，
//      问卷挂着不答 5s 后仍然没有「工具执行超过…已自动终止」通知、run 还活着
//      （改动前：2s 到点 abort 整轮对话）
//   4. 问卷挂着不算「失联」：PI_WEB_STALL_NOTIFY_MS=2000，等待超过一个 stall
//      检查周期（30s 定时器）也不会收到「无任何响应…可能已失联」警告
//   5. 回答 → 工具结果回到模型（回显文本含所选 label 与自定义文本），
//      快照的 pendingQuestion 清空
//
// 用法: npm run build && node tests/question-bridge-test.mjs
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const PORT = Number(process.argv[2] || 8985);
const MOCK_PORT = PORT + 1;
// 上一轮残留的 server / mock 会占着端口（Windows 下进程组清理不适用）。
freePort(PORT);
freePort(MOCK_PORT);
const base = mkdtempSync(join(tmpdir(), "pi-web-question-"));
const projDir = join(base, "proj");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(projDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

/** 问卷豁免看门狗的核心参数：2s 就该触发（若未被豁免）。 */
const TOOL_TIMEOUT_MS = 2000;
/** stall 检查定时器固定 30s 一轮，阈值压到 2s，等待一轮即可判定。 */
const STALL_NOTIFY_MS = 2000;

const CLIENT_ID = "question-bridge-client";
const MODEL_ID = "mock-model";

const QUESTIONS = [
	{
		id: "scope",
		header: "范围",
		question: "要做到什么程度？",
		options: [{ label: "最小可用" }, { label: "完整实现" }],
	},
	{
		id: "note",
		header: "补充",
		question: "还有什么要交代的？",
	},
];

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

// ---------------------------------------------------------------------------
// 假模型：第 1 回合（无 tool 消息）回 ask_user_question 工具调用；
// 第 2 回合（messages 里已有 role=tool）把工具结果回显成 assistant 文本。
// ---------------------------------------------------------------------------
const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
};
const delta = (model, d, finish = null) => ({
	id: "qmock",
	object: "chat.completion.chunk",
	created: Date.now(),
	model,
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});

const mock = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${MOCK_PORT}`);
	if (url.pathname.endsWith("/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				object: "list",
				data: [{ id: MODEL_ID, object: "model", name: "Mock", input: ["text"] }],
			}),
		);
		return;
	}
	if (!url.pathname.endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body || "{}");
	const messages = Array.isArray(payload.messages) ? payload.messages : [];
	const toolMsg = [...messages].reverse().find((m) => m.role === "tool");

	// 第二回合：模型看到工具结果 → 回显它（便于断言答案真的回到了模型）。
	if (toolMsg) {
		if (process.env.PI_WEB_TEST_DEBUG) console.error("[mock] tool result:", JSON.stringify(toolMsg.content));
		sse(res, [
			delta(payload.model, { content: `ANSWERED:${String(toolMsg.content ?? "")}` }),
			delta(payload.model, {}, "stop"),
		]);
		return;
	}
	// 没有工具定义的请求（标题生成/摘要等）→ 回普通文本，避免误触发问卷。
	if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
		sse(res, [delta(payload.model, { content: "ok" }), delta(payload.model, {}, "stop")]);
		return;
	}
	// 第一回合：调 ask_user_question。
	sse(res, [
		delta(payload.model, {
			tool_calls: [
				{
					index: 0,
					id: "call_ask",
					type: "function",
					function: { name: "ask_user_question", arguments: JSON.stringify({ questions: QUESTIONS }) },
				},
			],
		}),
		delta(payload.model, {}, "tool_calls"),
	]);
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "mock-key",
				models: [{ id: MODEL_ID, name: "Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
			},
		},
	}),
);

const repoRoot = realpathSync(new URL("../", import.meta.url));
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repoRoot,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		// 本测试只验其它功能；工具延迟加载默认开会让非核心工具不活跃，这里按部署默认关掉它。
		PI_WEB_TOOL_LAZY_LOADING: "0",
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: projDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_TOOL_TIMEOUT_MS: String(TOOL_TIMEOUT_MS),
		PI_WEB_STALL_NOTIFY_MS: String(STALL_NOTIFY_MS),
	},
	stdio: ["ignore", "ignore", "pipe"],
});
server.stderr?.on("data", (d) => process.stderr.write("[srv] " + d.toString()));

const waitForPort = async (port, timeout = 20000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`);
			if (response.ok) return;
		} catch {
			/* starting */
		}
		await sleep(100);
	}
	throw new Error(`server did not start on ${port}`);
};

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") {
				this.state = message.state;
			} else if (message.type === "snapshot_delta" && this.state && this.state.rev === message.baseRev) {
				// 与前端 use-chat 的 reducer 同样合并：appended 是增量追加的消息。
				this.state = {
					...this.state,
					...message.state,
					messages: [...this.state.messages, ...(message.appended ?? [])],
				};
			}
		});
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	/** 已收到的某类型消息（不移除）——用于「某类消息从未出现」的断言。 */
	seen(type, predicate = () => true) {
		return this.received.filter((m) => m.type === type && predicate(m));
	}
	async waitForType(type, predicate = () => true, timeout = 30000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const message = this.received[i];
				if (message.type !== type || !predicate(message)) continue;
				this.received.splice(i, 1);
				return message;
			}
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
	async waitForState(predicate, timeout = 30000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error("timeout waiting for state");
	}
}

const connect = async (clientId) => {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const client = new Client(ws);
	client.send({ type: "hello", clientId, locale: "zh" });
	await client.waitForType("ready");
	return client;
};

const textOf = (messages) =>
	messages
		.filter((m) => m.role === "assistant")
		.flatMap((m) => m.content ?? [])
		.map((b) => b.text ?? "")
		.join("\n");

let wsA;
let wsB;
/** 诊断用：出错时打印最后看到的 state（CI 上超时也能定位）。 */
let dbg;
try {
	await waitForPort(PORT);
	const a = await connect(CLIENT_ID);
	dbg = a;
	wsA = a.ws;
	await a.waitForType("snapshot");
	a.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
	await a.waitForState((s) => s.model?.id === MODEL_ID);

	a.send({ type: "prompt", text: "先问我几个问题" });
	const pending = await a.waitForType("question_pending", () => true, 40000);
	check(
		"模型 ask_user_question → question_pending（题目透传）",
		pending.questions?.[0]?.id === "scope" && pending.questions?.[1]?.id === "note",
		`id=${pending.id} n=${pending.questions?.length}`,
	);

	// 快照侧的事实源：重连的客户端靠它恢复对话框。
	const stateWithQuestion = await a.waitForState((s) => s.pendingQuestion?.id === pending.id, 10000);
	check(
		"快照携带 pendingQuestion（id/题目与 question_pending 一致）",
		stateWithQuestion.pendingQuestion.questions?.length === 2,
		JSON.stringify(stateWithQuestion.pendingQuestion.questions?.map((q) => q.id)),
	);

	// 刷新页面 = 同 clientId 再连一条（sessionStorage 保留 clientId）。
	// 服务端 attach 时的 flushSnapshot() 可能是增量快照（新 socket 没有 rev 链，
	// 落不了地）——真实前端这时会按 rev 不匹配发 get_state 重同步，这里走同一条路。
	const b = await connect(CLIENT_ID);
	wsB = b.ws;
	b.send({ type: "get_state" });
	const reloadSnapshot = await b.waitForType("snapshot", () => true, 15000);
	check(
		"刷新/重连后的快照带回同一张问卷（对话框可恢复）",
		reloadSnapshot.state.pendingQuestion?.id === pending.id,
		reloadSnapshot.state.pendingQuestion?.id ?? "none",
	);

	// —— 核心：挂着不答，超过 PI_WEB_TOOL_TIMEOUT_MS 也不能被看门狗剁掉 ——
	const waitStarted = Date.now();
	await sleep(TOOL_TIMEOUT_MS + 3000);
	const aborted = [...a.seen("notice"), ...b.seen("notice")].filter((m) =>
		/工具执行超过|auto-terminated/.test((m.text ?? "") + (m.textEn ?? "")),
	);
	check(
		`问卷挂着 ${Math.round((Date.now() - waitStarted) / 1000)}s（看门狗阈值 ${TOOL_TIMEOUT_MS}ms）未被自动终止`,
		aborted.length === 0,
		aborted.map((m) => m.text).join("; ") || "无通知",
	);
	const midState = await a.waitForState((s) => s.pendingQuestion?.id === pending.id, 5000);
	check(
		"等待期间 run 仍在跑（isStreaming 未中断）",
		midState.isStreaming === true,
		`isStreaming=${midState.isStreaming}`,
	);

	// —— 等用户回答不算「失联」：跨过一个 30s 的 stall 检查周期 ——
	const stallWaited = Date.now() - waitStarted;
	if (stallWaited < 32_000) await sleep(32_000 - stallWaited);
	const stallNotices = [...a.seen("notice"), ...b.seen("notice")].filter((m) =>
		/失联|disconnected/.test((m.text ?? "") + (m.textEn ?? "")),
	);
	check(
		"等待期间无「无任何响应…可能已失联」误报",
		stallNotices.length === 0,
		stallNotices.map((m) => m.text).join("; ") || "无通知",
	);

	// —— 回答 → 工具结果回到模型 → pendingQuestion 清空 ——
	a.send({
		type: "question_answer",
		id: pending.id,
		answers: [
			{ id: "scope", selected: ["最小可用"] },
			{ id: "note", selected: [], custom: "别动图标" },
		],
	});
	const done = await a.waitForState(
		// 等到第二回合（模型看到工具结果）真的落盘：仅看 isStreaming=false 会在
		// 「工具结束→下一次请求」的空隙提前返回。
		(s) => s.pendingQuestion == null && textOf(s.messages).includes("ANSWERED:"),
		30000,
	);
	check("回答后 pendingQuestion 从快照清空", done.pendingQuestion == null);
	const echoed = textOf(done.messages);
	check(
		"模型收到答案（工具结果回显含所选 label 与自定义文本）",
		echoed.includes("最小可用") && echoed.includes("别动图标"),
		echoed || JSON.stringify(done.messages.slice(-2)),
	);

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
} catch (err) {
	console.error("ERR", err);
	if (dbg?.state) {
		console.error("[d] isStreaming:", dbg.state.isStreaming, "messages:", JSON.stringify(dbg.state.messages.slice(-3)));
		console.error("[d] notices:", JSON.stringify(dbg.seen("notice").map((m) => m.text ?? m.textEn)));
		console.error(
			"[d] errorMessage:",
			dbg.state.errorMessage,
			"streaming:",
			JSON.stringify(dbg.state.streamingMessage),
		);
		const counts = {};
		for (const m of dbg.received) counts[m.type] = (counts[m.type] ?? 0) + 1;
		console.error("[d] received:", JSON.stringify(counts));
	}
	failures++;
} finally {
	try {
		wsA?.close();
		wsB?.close();
		server.kill("SIGTERM");
		mock.close();
	} catch {
		/* ignore */
	}
}
process.exit(failures === 0 ? 0 : 1);
