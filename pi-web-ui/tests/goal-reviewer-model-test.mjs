// goal-reviewer-model — 「仅模型评审」的审查模型真的用在审查请求上，主对话聊天模型不变。
//
// 做法：临时 agentDir 装替身 provider（openai-completions SSE），记录每个请求的 model 与
// 最后一条 user 消息。主对话模型 = glm-mock（zhipu），执行 = glm-mock，审查 = gpt-mock（openai）。
// 断言：
//   A. 带审查契约（"verdict"）的请求用的是 gpt-mock，主对话之后的普通聊天仍是 glm-mock；
//   B. goal_status 回读 reviewerModel = mock/gpt-mock，目标通过；
//   C. 执行与审查同家族（glm-mock / glm-mock-2）的 set_goal 直接被服务端拒绝，没有新的模型请求；
//   D. 旧请求格式（不带 reviewerModel、执行=gpt-mock）：审查仍由主对话（glm-mock）完成。
// 全程替身模型，不调用真实模型。
//
// 用法: npm run build:server && node tests/goal-reviewer-model-test.mjs [port]
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const PORT = Number(process.argv[2] || 8946);
const MOCK_PORT = PORT + 2;
freePort(PORT);
freePort(MOCK_PORT);

const base = mkdtempSync(join(tmpdir(), "pi-web-goal-reviewer-"));
const projDir = join(base, "proj");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const dir of [projDir, dataDir, agentDir]) mkdirSync(dir, { recursive: true });

/** 替身 provider 收到的请求：model + 最后一条 user 文本。 */
const requests = [];
const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
};
const delta = (model, d, finish = null) => ({
	id: "goal-reviewer-mock",
	object: "chat.completion.chunk",
	created: Date.now(),
	model,
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});
const textOf = (m) =>
	typeof m?.content === "string"
		? m.content
		: Array.isArray(m?.content)
			? m.content.map((p) => p?.text ?? "").join("")
			: "";

const mock = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${MOCK_PORT}`);
	if (!url.pathname.endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body || "{}");
	const users = (payload.messages ?? []).filter((m) => m.role === "user");
	const last = textOf(users.at(-1));
	const review = /"verdict"/.test(last);
	requests.push({ model: payload.model, review, last: last.slice(0, 80) });
	const reply = review ? '{"verdict":"pass","feedback":"审查通过"}' : "OK";
	sse(res, [delta(payload.model, { content: reply }), delta(payload.model, {}, "stop")]);
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

const model = (id) => ({ id, name: id, input: ["text"], contextWindow: 32000, maxTokens: 4096 });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "mock-key",
				models: [model("glm-mock"), model("glm-mock-2"), model("gpt-mock")],
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
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: projDir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "ignore", "pipe"],
});
server.stderr?.on("data", (d) => process.stderr.write("[srv] " + d.toString()));

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

async function waitFor(predicate, timeout = 60000) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const v = predicate();
		if (v) return v;
		await sleep(50);
	}
	return null;
}

let ws;
try {
	const started = Date.now();
	while (Date.now() - started < 20000) {
		try {
			if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
		} catch {
			/* starting */
		}
		await sleep(100);
	}
	ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((r, j) => {
		ws.once("open", r);
		ws.once("error", j);
	});
	const received = [];
	let state = null;
	ws.on("message", (data) => {
		const m = JSON.parse(data.toString());
		received.push(m);
		if (m.type === "snapshot") state = m.state;
		else if (m.type === "snapshot_delta" && state && state.rev === m.baseRev) state = { ...state, ...m.state };
	});
	const send = (m) => ws.send(JSON.stringify(m));
	send({ type: "hello", clientId: "goal-reviewer-model-client", locale: "zh" });
	await waitFor(() => received.some((m) => m.type === "snapshot"));
	send({ type: "set_model", modelId: "mock/glm-mock" });
	await waitFor(() => state?.model?.id === "glm-mock", 20000);
	check("主对话模型 = glm-mock", state?.model?.id === "glm-mock", state?.model?.id ?? "(无)");

	// ---- A/B：显式审查模型 ------------------------------------------------
	send({
		type: "set_goal",
		goal: "在当前目录写一句话说明",
		maxRounds: 1,
		locked: true,
		execModel: "mock/glm-mock",
		reviewerModel: "mock/gpt-mock",
	});
	const passed = await waitFor(
		() => received.find((m) => m.type === "goal_status" && m.status?.verdict === "pass"),
		90000,
	);
	check("目标按显式审查者通过", !!passed);
	const statusWithReviewer = received.find(
		(m) => m.type === "goal_status" && m.status?.reviewerModel === "mock/gpt-mock",
	);
	check("goal_status 回读实际审查模型 mock/gpt-mock", !!statusWithReviewer);
	const reviews = requests.filter((r) => r.review);
	check(
		"审查请求全部用 gpt-mock",
		reviews.length > 0 && reviews.every((r) => r.model === "gpt-mock"),
		JSON.stringify(reviews.map((r) => r.model)),
	);
	const execs = requests.filter((r) => !r.review);
	check(
		"执行请求用 glm-mock",
		execs.length > 0 && execs.every((r) => r.model === "glm-mock"),
		JSON.stringify(execs.map((r) => r.model)),
	);
	await sleep(500);
	send({ type: "prompt", text: "普通聊天：你好" });
	const chat = await waitFor(() => requests.find((r) => r.last.includes("普通聊天")), 30000);
	check("之后的普通聊天仍用 glm-mock", chat?.model === "glm-mock", chat?.model ?? "(无请求)");
	check("主对话模型没被改动", state?.model?.id === "glm-mock", state?.model?.id ?? "(无)");
	await waitFor(() => state && !state.isStreaming, 20000);

	// ---- C：同家族组合直接请求 -------------------------------------------
	send({ type: "clear_goal" });
	await sleep(500);
	const before = requests.length;
	send({
		type: "set_goal",
		goal: "同家族组合",
		maxRounds: 1,
		locked: true,
		execModel: "mock/glm-mock",
		reviewerModel: "mock/glm-mock-2",
	});
	const rejected = await waitFor(
		() => received.find((m) => m.type === "notice" && /目标未设置/.test(m.text ?? "") && /zhipu/.test(m.text ?? "")),
		10000,
	);
	check(
		"同家族组合被服务端拒绝并点名两个角色",
		!!rejected && /执行模型.*审查模型/.test(rejected.text ?? ""),
		rejected?.text ?? "(无通知)",
	);
	await sleep(1000);
	check("被拒后没有发出任何模型请求", requests.length === before, `${before} → ${requests.length}`);

	// ---- D：旧请求格式（无 reviewerModel） -------------------------------
	send({ type: "set_goal_prefs", reviewerModel: "" });
	await sleep(300);
	const mark = requests.length;
	send({ type: "set_goal", goal: "旧格式目标", maxRounds: 1, locked: true, execModel: "mock/gpt-mock" });
	const passedOld = await waitFor(
		() => received.filter((m) => m.type === "goal_status" && m.status?.verdict === "pass").length >= 2,
		90000,
	);
	check("旧格式：目标通过", !!passedOld);
	const oldReviews = requests.slice(mark).filter((r) => r.review);
	check(
		"旧格式：审查由主对话（glm-mock）完成",
		oldReviews.length > 0 && oldReviews.every((r) => r.model === "glm-mock"),
		JSON.stringify(oldReviews.map((r) => r.model)),
	);
} catch (error) {
	console.error("✗ 异常:", error instanceof Error ? error.message : error);
	failures++;
} finally {
	try {
		ws?.close();
	} catch {
		/* ignore */
	}
	server.kill();
	mock.close();
	await sleep(300);
	freePort(PORT);
	freePort(MOCK_PORT);
}

console.log(`  替身 provider 请求：${JSON.stringify(requests.map((r) => `${r.model}${r.review ? "(review)" : ""}`))}`);
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
