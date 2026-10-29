// 跨页作答 remote-answer（零 token）：别处会话的问卷在本页直接回答，不搬迁对话。
//
// 假模型（question-bridge 同款）：第 1 回合固定回 ask_user_question 工具调用，
// 第 2 回合把工具结果回显成 assistant 文本。
//
// 验证：
//   1. A 提问挂起时，B（全新页面，A 还在线）点 elsewhere 行的 `?`
//      （peek_elsewhere_question）→ B 收到 elsewhere_question（同题目），
//      本页弹框；A 的对话原地不动（未被过户）；
//   2. B 跨页提交（question_answer 带 owner）→ A 的 run 继续（回显含答案），
//      A 页问卷收起（question_retracted），B 页 elsewhere 角标消失；
//   3. 问卷已不在时再 peek → 明确通知（答案不吞不丢）；
//   4. 本页 answered 集合不受跨页 id 污染（回归：两边计数器都从 q1 起）。
//
// Usage: npm run build && node tests/remote-answer-test.mjs [port]
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const PORT = Number(process.argv[2] || 8992);
const MOCK_PORT = PORT + 1;
freePort(PORT);
freePort(MOCK_PORT);
const base = mkdtempSync(join(tmpdir(), "pi-web-remote-answer-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const MODEL_ID = "remote-mock";
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

const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
};
const delta = (model, d, finish = null) => ({
	id: "remote-mock",
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
			JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model", name: "Mock", input: ["text"] }] }),
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
	if (toolMsg) {
		sse(res, [
			delta(payload.model, { content: `ANSWERED:${String(toolMsg.content ?? "")}` }),
			delta(payload.model, {}, "stop"),
		]);
		return;
	}
	if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
		sse(res, [delta(payload.model, { content: "ok" }), delta(payload.model, {}, "stop")]);
		return;
	}
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
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
		// 显式清空：测试必须与 ambient shell 的 PI_WEB_TOKEN 无关。
		PI_WEB_TOKEN: "",
	},
	stdio: "ignore",
	windowsHide: true,
});

const waitForPort = async (port, timeout = 20000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/health`);
			if (response.ok) return;
		} catch {
			/* starting */
		}
		await sleep(100);
	}
	throw new Error(`server did not start on ${port}`);
};

class Client {
	constructor(ws, name) {
		this.ws = ws;
		this.name = name;
		this.received = [];
		this.state = null;
		this.messages = [];
		this.conversations = [];
		this.elsewhere = [];
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") {
				this.state = message.state;
				this.messages = message.state.messages ?? [];
			} else if (
				message.type === "snapshot_delta" &&
				this.state &&
				this.state.rev === message.baseRev &&
				message.conversationId === this.state.conversationId
			) {
				this.state = { ...this.state, ...message.state };
				this.messages = [...this.messages, ...message.appended];
			} else if (message.type === "conversations") {
				this.conversations = message.conversations;
				this.elsewhere = message.elsewhere ?? [];
			}
		});
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	async waitForType(type, predicate = () => true, timeout = 20000) {
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
		throw new Error(`[${this.name}] timeout waiting for ${type}`);
	}
	async waitForState(predicate, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error(`[${this.name}] timeout waiting for state`);
	}
	notices() {
		return this.received.filter((m) => m.type === "notice");
	}
}

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

let clientA;
let clientB;
try {
	await waitForPort(PORT);

	const openClient = async (clientId, withModel = true) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		await new Promise((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		const c = new Client(ws, clientId);
		c.send({ type: "hello", clientId, locale: "zh" });
		await c.waitForType("ready");
		c.send({ type: "get_state" });
		await c.waitForState((s) => Boolean(s.conversationId));
		if (withModel) {
			c.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
			await c.waitForState((s) => s.model?.id === MODEL_ID);
		}
		return c;
	};

	// A 先上线待命；B 全新页面先看着（A 还空闲，elsewhere 应为空）。
	clientA = await openClient("remote-A");
	clientB = await openClient("remote-B", false);
	await clientB.waitForType("conversations", () => true, 15000); // 首推到达
	check("A 空闲时 B 看不到 elsewhere", clientB.elsewhere.length === 0, JSON.stringify(clientB.elsewhere));

	// A 提问挂起（run 阻塞在等人类回答）→ 已打开的 B 页必须实时看到 `?`。
	// 回归：问卷挂起/解决不改变流式集合，签名不变就不推，别处页面永远看不到。
	clientA.send({ type: "prompt", text: "先问我几个问题" });
	const pendingA = await clientA.waitForType("question_pending", () => true, 40000);
	check("A 问卷挂起", pendingA.questions?.length === 2, `id=${pendingA.id}`);
	await clientA.waitForState((s) => s.isStreaming === true, 15000);
	const convA = clientA.state.conversationId;
	let row = null;
	{
		const started = Date.now();
		while (Date.now() - started < 15000) {
			row = clientB.elsewhere.find((w) => w.isStreaming && w.owner && w.convId && w.hasQuestion);
			if (row) break;
			await sleep(100);
		}
	}
	check("已打开的 B 页实时看到 elsewhere 问卷标记", !!row, `hasQuestion=${row?.hasQuestion}`);
	clientB.send({ type: "peek_elsewhere_question", owner: row.owner, id: row.convId });
	const preview = await clientB.waitForType(
		"elsewhere_question",
		(m) => m.convId === row.convId && m.questions?.length === 2,
		15000,
	);
	check("B 收到问卷原文（本页弹框）", preview.id === pendingA.id, `id=${preview.id} owner=${preview.owner}`);
	check("对话没被搬走（仍在 A 手里）", clientA.state.conversationId === convA, clientA.state.conversationId);

	// B 跨页提交 → A 的 run 继续，A 页问卷收起，B 页角标消失。
	clientB.send({
		type: "question_answer",
		id: preview.id,
		owner: row.owner,
		answers: [
			{ id: "scope", selected: ["完整实现"] },
			{ id: "note", selected: [], custom: "别动图标" },
		],
	});
	{
		const started = Date.now();
		let echoed = "";
		while (Date.now() - started < 30000) {
			const texts = (clientA.messages ?? [])
				.filter((m) => m.role === "assistant")
				.flatMap((m) => m.content ?? [])
				.map((b) => b.text ?? "")
				.join("\n");
			if (texts.includes("ANSWERED:") && texts.includes("完整实现")) {
				echoed = texts;
				break;
			}
			await sleep(100);
		}
		check("A 的模型收到跨页答案并继续", echoed.includes("别动图标"), echoed.slice(-160));
	}
	{
		const started = Date.now();
		let retracted = false;
		while (Date.now() - started < 15000) {
			if (clientA.received.some((m) => m.type === "question_retracted" && m.id === pendingA.id)) {
				retracted = true;
				break;
			}
			await sleep(100);
		}
		check("A 页旧对话框同步收起", retracted);
	}
	{
		const started = Date.now();
		let cleared = false;
		while (Date.now() - started < 30000) {
			const r = clientB.elsewhere.find((w) => w.convId === row.convId);
			if (!r || !r.hasQuestion) {
				cleared = true;
				break;
			}
			await sleep(100);
		}
		check("B 页 elsewhere 角标消失", cleared);
	}
	check(
		"A 仍持有对话（无过户发生）",
		clientA.conversations.some((c) => c.id === convA),
	);

	// 问卷已不在时再 peek → 明确通知，不静默。
	clientB.send({ type: "peek_elsewhere_question", owner: row.owner, id: row.convId });
	const gone = await clientB.waitForType("notice", (m) => (m.text ?? "").includes("问卷已不在"), 15000);
	check("问卷消失后 peek 给出明确通知", !!gone);

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
} catch (err) {
	failures++;
	console.error("💥", err.message ?? err);
} finally {
	clientA?.ws.close();
	clientB?.ws.close();
	server.kill();
	mock.close();
	await sleep(500);
	await freePort(PORT);
	await freePort(MOCK_PORT);
	process.exit(failures === 0 ? 0 : 1);
}
