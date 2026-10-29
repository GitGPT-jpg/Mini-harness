// 手动过户 take_over_conversation（零 token）：右键「另一处」行把对话（含等答复
// 的问卷）整体搬到本页。
//
// 假模型（question-bridge 同款）：第 1 回合回 ask_user_question 工具调用，第 2 回合
// （过户之后）**再回一次** ask_user_question，第 3 回合回 browser_page，第 4 回合把
// 全部工具结果回显成 assistant 文本。
//
// 验证：
//   1. A 提问挂起（question_pending + streaming）时，B（全新 clientId，A 还在线）
//      右键过户 → B 落到同一对话（含历史）、问卷在 B 页重新弹出（新 id、同题目）、
//      快照 pendingQuestion 就位、elsewhere 清空；
//   2. A 页该对话消失 + 收到去向通知（源会话 active 自动修好）；
//   3. B 回答问卷 → 工具结果回到模型（回显含所选 label），run 在 B 页继续；
//   4. **过户后新提出的问卷/页面调用归持有方**：桥接工具（ask_user_question /
//      browser_page）是建 runtime 时把当时的 ClientSession + conversationId 闭包
//      进去的，过户只搬对话搬不动闭包 —— 曾经过户后新提问的 question_pending 与
//      page_request 都推给了**过户前那台设备**（持有方收不到；老设备上那张问卷还
//      不进它的快照 → 刷新即丢，而 pi 引擎问卷不超时，run 永远挂住）。回归：两者
//      都必须落在 B，且任何一张都不许漂到 A；
//   5. id 冲突改名：A/B 两边首对话都是 c1，搬入方自动换新 id 不踩旧行（回归也顺带
//      盖住「旧 id 已不再指向这条对话」，所以归属解析不能靠建时的 conversationId）。
//
// Usage: npm run build && node tests/takeover-test.mjs [port]
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const PORT = Number(process.argv[2] || 8987);
const MOCK_PORT = PORT + 1;
freePort(PORT);
freePort(MOCK_PORT);
const base = mkdtempSync(join(tmpdir(), "pi-web-takeover-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const MODEL_ID = "takeover-mock";
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
	id: "takeover-mock",
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
	const toolMsgs = messages.filter((m) => m.role === "tool");
	const askCall = (payload, callId) => [
		delta(payload.model, {
			tool_calls: [
				{
					index: 0,
					id: callId,
					type: "function",
					function: { name: "ask_user_question", arguments: JSON.stringify({ questions: QUESTIONS }) },
				},
			],
		}),
		delta(payload.model, {}, "tool_calls"),
	];
	const pageCall = (payload) => [
		delta(payload.model, {
			tool_calls: [
				{
					index: 0,
					id: "call_page_1",
					type: "function",
					function: { name: "browser_page", arguments: JSON.stringify({ op: "read", what: "title" }) },
				},
			],
		}),
		delta(payload.model, {}, "tool_calls"),
	];
	if (toolMsgs.length === 0) {
		if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
			sse(res, [delta(payload.model, { content: "ok" }), delta(payload.model, {}, "stop")]);
			return;
		}
		sse(res, askCall(payload, "call_ask_1"));
		return;
	}
	// 过户之后提出的第二张问卷（回归：必须送到新持有方）。
	if (toolMsgs.length === 1) {
		sse(res, askCall(payload, "call_ask_2"));
		return;
	}
	// 再过一轮：过户之后调 browser_page（同一根因，page_request 也必须送到新持有方）。
	if (toolMsgs.length === 2) {
		sse(res, pageCall(payload));
		return;
	}
	sse(res, [
		delta(payload.model, {
			content: `ANSWERED:${toolMsgs.map((m) => String(m.content ?? "")).join(" | ")}`,
		}),
		delta(payload.model, {}, "stop"),
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
/** 等运行列表里出现符合谓词的行（conversations 推送驱动）。 */
const waitRow = async (c, pred, what, timeout = 15000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const row = c.conversations.find(pred);
		if (row) return row;
		await sleep(100);
	}
	throw new Error(`[${c.name}] timeout waiting for row: ${what}`);
};
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

	// A：提问挂起（run 阻塞在等人类回答，streaming 中）。
	clientA = await openClient("takeover-A");
	clientA.send({ type: "prompt", text: "先问我几个问题" });
	const pendingA = await clientA.waitForType("question_pending", () => true, 40000);
	check("A 问卷挂起", pendingA.questions?.length === 2, `id=${pendingA.id}`);
	await clientA.waitForState((s) => s.isStreaming === true, 15000);
	const convA = clientA.state.conversationId;
	// 运行列表给等问卷的对话挂「?」角标（自有行；elsewhere 行同信息已在下面断言）。
	const rowAq = await waitRow(clientA, (c) => c.id === convA && c.hasQuestion === true, "A row hasQuestion");
	check("运行列表标出等问卷（A 页自有行）", !!rowAq);

	// B：全新页面（A 还在线），elsewhere 行带齐过户定位 + 问卷标记。
	clientB = await openClient("takeover-B", false);
	let row = null;
	{
		const started = Date.now();
		while (Date.now() - started < 15000) {
			row = clientB.elsewhere.find((w) => w.isStreaming);
			if (row?.owner && row?.convId) break;
			row = null;
			await sleep(100);
		}
	}
	check("B 的 elsewhere 行带 owner/convId", !!row, JSON.stringify(row ?? clientB.elsewhere));
	check("elsewhere 行标出等答复问卷", row?.hasQuestion === true, `hasQuestion=${row?.hasQuestion}`);
	check("elsewhere 指回 A 的对话", row?.convId === convA, `convId=${row?.convId} owner=${row?.owner}`);

	// B 右键过户（A 在线也不拦：搬 runtime，单 writer 不变）。
	clientB.send({ type: "take_over_conversation", owner: row.owner, id: row.convId });
	const pendingB = await clientB.waitForType("question_pending", (m) => m.questions?.length === 2, 20000);
	check("问卷在 B 页重新弹出（同题目）", pendingB.questions?.[0]?.id === "scope", `newId=${pendingB.id}`);
	// 问卷 id 是会话内作用域（两边计数器都从 q-1 起，撞号正常）；真正的转移证据是
	// A 页不再挂起同一张问卷（搬走，不是复制）。
	{
		const started = Date.now();
		let cleared = false;
		while (Date.now() - started < 15000) {
			if (clientA.state?.pendingQuestion == null) {
				cleared = true;
				break;
			}
			await sleep(100);
		}
		check("A 页的问卷已搬走（不再挂起）", cleared);
	}
	await clientB.waitForState((s) => s.pendingQuestion?.id === pendingB.id, 15000);
	check("B 快照 pendingQuestion 就位（切过去了）", true);
	const rowB = await waitRow(
		clientB,
		(c) => !c.isSubagent && c.messageCount > 0 && c.hasQuestion === true,
		"B row hasQuestion",
	);
	check("B 运行列表里有搬过来的对话", !!rowB, `conv=${rowB?.id} streaming=${rowB?.isStreaming}`);
	check("过户把等问卷状态一起带过来", rowB?.hasQuestion === true);
	check("搬过来的 run 还在跑", rowB?.isStreaming === true);
	check("B 落在搬过来的对话上", clientB.state.conversationId === rowB?.id, clientB.state.conversationId);
	check("B 的 elsewhere 已清空", clientB.elsewhere.length === 0, JSON.stringify(clientB.elsewhere));
	check(
		"B 收到过户成功通知",
		clientB.notices().some((m) => (m.text ?? "").includes("过户到当前页面")),
	);
	// A 页：对话消失 + 去向通知（源会话 active 自动修好，不断连）。
	{
		const started = Date.now();
		let gone = false;
		while (Date.now() - started < 15000) {
			if (!clientA.conversations.some((c) => c.id === convA)) {
				gone = true;
				break;
			}
			await sleep(100);
		}
		check("A 页该对话已消失", gone);
	}
	// 源页面的旧对话框必须是即时通道弹出的（live），快照为 null 收不掉 ——
	// 服务端搬问卷时同步下发 question_retracted，源页凭它收起。
	const retracted = await clientA.waitForType("question_retracted", (m) => m.id === pendingA.id, 15000);
	check("A 页旧问卷被撤回（对话框收起）", retracted.id === pendingA.id, `id=${retracted.id}`);
	check(
		"A 收到去向通知",
		clientA.notices().some((m) => (m.text ?? "").includes("过户到另一处")),
	);
	check("A 的会话没被搬空（active 自动修好）", !!clientA.state?.conversationId, clientA.state?.conversationId);

	// B 回答问卷 → 工具结果回到模型，run 在 B 页继续（转移的不只是查看权）。
	clientB.send({
		type: "question_answer",
		id: pendingB.id,
		answers: [
			{ id: "scope", selected: ["完整实现"] },
			{ id: "note", selected: [], custom: "别动图标" },
		],
	});
	// 过户之后模型再提问：这张问卷是**过户后**提出的，必须落在当前持有方 B ——
	// 桥接工具里闭包捕获的是建 runtime 的那个 ClientSession（A），不是“现在谁持有”。
	const pendingB2 = await clientB.waitForType("question_pending", (m) => m.id !== pendingB.id, 30000);
	check("过户后新问卷送达持有方 B", pendingB2.questions?.length === 2, `id=${pendingB2.id}`);
	await clientB.waitForState((s) => s.pendingQuestion?.id === pendingB2.id, 15000);
	check("过户后新问卷进 B 的快照（刷新/重连可恢复）", true);
	{
		// 给漂移留出窗口：A 页此刻不该再收到任何问卷（它已经不持有这条对话了）。
		await sleep(2500);
		const stray = clientA.received.find((m) => m.type === "question_pending");
		check("新问卷没有误发给过户前的设备 A", !stray, stray ? `id=${stray.id}` : "无");
	}
	clientB.send({
		type: "question_answer",
		id: pendingB2.id,
		answers: [{ id: "scope", selected: ["完整实现"] }],
	});

	// 同一根因的第二条通道：过户之后调 browser_page，page_request 也必须送到 B。
	const pageReq = await clientB.waitForType("page_request", () => true, 30000);
	check("过户后 page_request 送达持有方 B", typeof pageReq.id === "string", `id=${pageReq.id} op=${pageReq.op}`);
	{
		await sleep(1500);
		const stray = clientA.received.find((m) => m.type === "page_request");
		check("page_request 没有误发给过户前的设备 A", !stray, stray ? `id=${stray.id}` : "无");
	}
	clientB.send({ type: "page_response", id: pageReq.id, ok: true, result: { title: "Mock page" } });

	{
		const started = Date.now();
		let echoed = "";
		while (Date.now() - started < 30000) {
			const texts = (clientB.messages ?? [])
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
		check("B 答卷后模型收到答案并继续", echoed.includes("别动图标"), echoed.slice(-200));
	}
	// 回答后角标消失（pending 清掉后的 conversations 推送不再带 hasQuestion）。
	{
		const started = Date.now();
		let cleared = false;
		while (Date.now() - started < 30000) {
			const r = clientB.conversations.find((c) => c.id === clientB.state?.conversationId);
			if (r && !r.hasQuestion) {
				cleared = true;
				break;
			}
			await sleep(100);
		}
		check("回答后等问卷角标消失", cleared);
	}

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
