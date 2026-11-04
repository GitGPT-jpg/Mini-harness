// task-three-models — 新任务的规划 / 执行 / 评审三个模型从请求一路接到实际角色调用。
//
// 替身 provider 有四个不同家族的模型：glm-mock（主聊天）、deepseek-mock（规划）、gpt-mock（执行）、
// qwen-mock（评审），按请求特征记下「哪个角色用了哪个模型 ID」。零 token，不调用真实模型。
//   A. 代码验证 + 模型评审：规划 / 执行 / 评审分别收到 deepseek / gpt / qwen；之后普通聊天仍是 glm，
//      主对话模型未变；run 记录里的三个模型与之一致；
//   B. 仅模型评审（经细化向导）：规划（向导）deepseek、执行 gpt、评审 qwen；目标结果交回主对话的那一轮
//      和之后的普通聊天仍是 glm；
//   C. 直接请求绕过 UI：规划与执行同家族 → 启动前拒绝，不建 run、不发模型请求；仅模型评审同理；
//   D. 旧请求缺 executorModel：执行仍是主对话模型。
// 用法：npm run build && node tests/task-three-models-test.mjs [port]；MOCK_TRACE=1 逐条打印替身收到的请求。
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const PORT = Number(process.argv[2] || 8980);
const MOCK_PORT = PORT + 2;
freePort(PORT);
freePort(MOCK_PORT);
const REPO = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-web-three-models-"));
const [proj, dataDir, agentDir, home] = ["proj", "data", "agent", "home"].map((d) => join(base, d));
for (const d of [proj, dataDir, agentDir, home]) mkdirSync(d, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: proj });
writeFileSync(join(proj, "README.md"), "demo\n");
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: proj });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: proj });

/** { model, role }：role 按请求特征判断（系统提示词 / 工具 / 审查契约）。 */
const requests = [];
const text = (m) =>
	typeof m?.content === "string"
		? m.content
		: Array.isArray(m?.content)
			? m.content.map((p) => p?.text ?? "").join("")
			: "";
const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
};
const chunk = (model, d, finish = null) => ({
	id: "x",
	object: "chat.completion.chunk",
	created: Date.now(),
	model,
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});
const say = (res, model, content) => sse(res, [chunk(model, { content }), chunk(model, {}, "stop")]);
const call = (res, model, name, args) =>
	sse(res, [
		chunk(model, {
			tool_calls: [
				{ index: 0, id: `c_${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
			],
		}),
		chunk(model, {}, "tool_calls"),
	]);
const mock = createServer(async (req, res) => {
	if (!String(req.url).endsWith("/chat/completions")) return void res.writeHead(404).end();
	let body = "";
	for await (const c of req) body += c;
	const p = JSON.parse(body || "{}");
	const msgs = p.messages ?? [];
	const system = msgs
		.filter((m) => m.role === "system")
		.map(text)
		.join("\n");
	const tools = (p.tools ?? []).map((t) => t?.function?.name);
	const lastUser = text(msgs.filter((m) => m.role === "user").at(-1));
	const last = msgs.at(-1);
	const record = (role) => requests.push({ model: p.model, role, hint: lastUser.slice(0, 80).replace(/\s+/g, " ") });
	if (/你是任务规划者/.test(system)) return (record("planner"), say(res, p.model, "1. 写文件 2. 验证"));
	if (/你是独立审查者/.test(system))
		return (record("reviewer"), say(res, p.model, '{"verdict":"pass","reasons":["ok"]}'));
	if (tools.includes("goal_ask")) {
		record("planner");
		if (!msgs.some((m) => m.role === "tool"))
			return call(res, p.model, "goal_ask", {
				question: "计划大纲：目标：写说明 步骤：1) 写 -- 看",
				options: ["开始执行：按上面的计划跑", "取消：不执行"],
			});
		return say(res, p.model, "GOAL: 写一句说明\nSTEPS:\n1. 写 | 检查");
	}
	if (/普通聊天/.test(lastUser)) return (record("chat"), say(res, p.model, "OK"));
	// 目标通过后服务端把结果作为一条消息交回主对话，这一轮属于主对话本身
	if (/目标已达成/.test(lastUser)) return (record("main"), say(res, p.model, "收到"));
	if (/"verdict"/.test(lastUser)) return (record("reviewer"), say(res, p.model, '{"verdict":"pass","feedback":"ok"}'));
	if (tools.includes("loop_done")) {
		record("executor");
		if (last?.role === "tool") return say(res, p.model, "本轮完成");
		return call(res, p.model, "loop_done", { summary: "done" });
	}
	return (record("executor"), say(res, p.model, "已完成"));
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
				models: ["glm-mock", "deepseek-mock", "gpt-mock", "qwen-mock"].map(model),
			},
		},
	}),
);

const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: REPO,
	env: {
		...process.env,
		HOME: home,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: proj,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "ignore", "pipe"],
});
let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};
async function waitFor(fn, ms = 60000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const v = fn();
		if (v) return v;
		await sleep(100);
	}
	return null;
}
const models = (role, from = 0) => [
	...new Set(
		requests
			.slice(from)
			.filter((r) => r.role === role)
			.map((r) => r.model),
	),
];
let ws;
try {
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
		} catch {}
		await sleep(100);
	}
	ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
	const st = { snapshot: null, msgs: [] };
	ws.on("message", (d) => {
		const m = JSON.parse(d.toString());
		st.msgs.push(m);
		if (m.type === "snapshot") st.snapshot = m.state;
		else if (m.type === "snapshot_delta" && st.snapshot && st.snapshot.rev === m.baseRev)
			st.snapshot = { ...st.snapshot, ...m.state };
	});
	const send = (m) => ws.send(JSON.stringify(m));
	send({ type: "hello", clientId: "three-models", locale: "zh" });
	await waitFor(() => st.snapshot);
	send({ type: "set_model", modelId: "mock/glm-mock" });
	await waitFor(() => st.snapshot?.model?.id === "glm-mock", 20000);

	// ---- A：代码验证 + 模型评审 -------------------------------------------------
	send({
		type: "loop_start_request",
		goal: "写一句说明",
		mode: "code",
		maxRounds: 2,
		useReviewer: true,
		worktree: false,
		validateCmd: "true",
		plannerModel: "mock/deepseek-mock",
		executorModel: "mock/gpt-mock",
		reviewerModel: "mock/qwen-mock",
	});
	const runA = await waitFor(() => st.snapshot?.loop?.runId, 20000);
	await waitFor(() => st.snapshot?.loop?.status === "done", 60000);
	check("代码任务通过", st.snapshot?.loop?.status === "done", String(st.snapshot?.loop?.status));
	check(
		"规划只用 deepseek-mock",
		JSON.stringify(models("planner")) === '["deepseek-mock"]',
		JSON.stringify(models("planner")),
	);
	check("执行只用 gpt-mock", JSON.stringify(models("executor")) === '["gpt-mock"]', JSON.stringify(models("executor")));
	check(
		"评审只用 qwen-mock",
		JSON.stringify(models("reviewer")) === '["qwen-mock"]',
		JSON.stringify(models("reviewer")),
	);
	const detail = await (await fetch(`http://127.0.0.1:${PORT}/api/mini-harness/runs/${runA}/detail`)).json();
	check(
		"run 记录的三个模型与实际调用一致",
		detail.models?.main === "gpt-mock" &&
			detail.models?.planner === "deepseek-mock" &&
			detail.models?.reviewer === "qwen-mock",
		JSON.stringify(detail.models),
	);
	let mark = requests.length;
	send({ type: "prompt", text: "普通聊天：你好" });
	await waitFor(() => requests.slice(mark).some((r) => r.role === "chat"), 20000);
	check(
		"之后的普通聊天仍用主聊天模型 glm-mock",
		JSON.stringify(models("chat", mark)) === '["glm-mock"]',
		JSON.stringify(models("chat", mark)),
	);
	check("主对话模型未变", st.snapshot?.model?.id === "glm-mock", st.snapshot?.model?.id);
	await waitFor(() => !st.snapshot?.isStreaming, 20000);

	// ---- B：仅模型评审（经细化向导） ------------------------------------------
	send({ type: "new_chat" });
	await sleep(800);
	send({ type: "set_model", modelId: "mock/glm-mock" });
	await sleep(300);
	mark = requests.length;
	send({
		type: "set_goal_prefs",
		reviewModel: "mock/deepseek-mock",
		execModel: "mock/gpt-mock",
		reviewerModel: "mock/qwen-mock",
		maxRounds: 1,
	});
	send({
		type: "start_goal_wizard",
		text: "写一句说明",
		wizardModel: "mock/deepseek-mock",
		maxRounds: 1,
		locked: true,
	});
	const dialog = await waitFor(() => st.msgs.find((m) => m.type === "dialog"), 30000);
	if (dialog) send({ type: "dialog_response", id: dialog.id, value: "开始执行：按上面的计划跑" });
	const passed = await waitFor(
		() => st.msgs.find((m) => m.type === "goal_status" && m.status?.verdict === "pass"),
		60000,
	);
	check("仅模型评审目标通过", !!passed);
	check(
		"规划（细化向导）只用 deepseek-mock",
		JSON.stringify(models("planner", mark)) === '["deepseek-mock"]',
		JSON.stringify(models("planner", mark)),
	);
	check(
		"执行只用 gpt-mock",
		JSON.stringify(models("executor", mark)) === '["gpt-mock"]',
		JSON.stringify(models("executor", mark)),
	);
	check(
		"评审只用 qwen-mock",
		JSON.stringify(models("reviewer", mark)) === '["qwen-mock"]',
		JSON.stringify(models("reviewer", mark)),
	);
	await waitFor(() => requests.slice(mark).some((r) => r.role === "main"), 15000);
	check(
		"目标结果交回主对话时用主聊天模型 glm-mock",
		JSON.stringify(models("main", mark)) === '["glm-mock"]',
		JSON.stringify(models("main", mark)),
	);
	const withRoles = st.msgs.filter((m) => m.type === "goal_status" && m.status?.goal).at(-1)?.status;
	check(
		"目标状态读回实际执行 / 审查模型",
		withRoles?.execModel === "mock/gpt-mock" && withRoles?.reviewerModel === "mock/qwen-mock",
		JSON.stringify({ exec: withRoles?.execModel, reviewer: withRoles?.reviewerModel }),
	);
	mark = requests.length;
	send({ type: "prompt", text: "普通聊天：再问一句" });
	await waitFor(() => requests.slice(mark).some((r) => r.role === "chat"), 20000);
	check(
		"之后的普通聊天仍用 glm-mock",
		JSON.stringify(models("chat", mark)) === '["glm-mock"]',
		JSON.stringify(models("chat", mark)),
	);
	await waitFor(() => !st.snapshot?.isStreaming, 20000);

	// ---- C：直接请求绕过 UI ---------------------------------------------------
	send({ type: "new_chat" });
	await sleep(800);
	send({ type: "set_model", modelId: "mock/glm-mock" });
	await sleep(300);
	mark = requests.length;
	const runsBefore = (await (await fetch(`http://127.0.0.1:${PORT}/api/mini-harness/runs?history=1`)).json()).runs
		.length;
	send({
		type: "loop_start_request",
		goal: "同家族",
		mode: "code",
		useReviewer: true,
		worktree: false,
		validateCmd: "true",
		plannerModel: "mock/glm-mock",
	});
	const failed = await waitFor(() => (st.snapshot?.loop?.kind === "request-failed" ? st.snapshot.loop : null), 10000);
	check(
		"规划与执行同家族的直接请求在启动前被拒，并点名角色",
		!!failed && /执行模型.*规划模型.*zhipu/.test(failed.reason ?? ""),
		failed?.reason ?? "(无)",
	);
	await sleep(800);
	const runsAfter = (await (await fetch(`http://127.0.0.1:${PORT}/api/mini-harness/runs?history=1`)).json()).runs
		.length;
	check(
		"被拒后没有建 run、没有模型请求",
		runsAfter === runsBefore && requests.length === mark,
		`runs ${runsBefore}→${runsAfter}, requests ${mark}→${requests.length}`,
	);
	send({
		type: "set_goal",
		goal: "同家族目标",
		maxRounds: 1,
		locked: true,
		execModel: "mock/glm-mock",
		reviewerModel: "mock/glm-mock",
	});
	const rejected = await waitFor(
		() => st.msgs.find((m) => m.type === "notice" && /目标未设置/.test(m.text ?? "")),
		10000,
	);
	check("仅模型评审的同家族直接请求被拒", !!rejected, rejected?.text ?? "(无)");

	// ---- D：旧请求缺 executorModel ---------------------------------------------
	mark = requests.length;
	send({
		type: "loop_start_request",
		goal: "旧请求",
		mode: "code",
		useReviewer: false,
		worktree: false,
		validateCmd: "true",
	});
	await waitFor(() => st.snapshot?.loop?.kind === "run" && st.snapshot.loop.status === "done", 60000);
	check(
		"旧请求缺 executorModel：执行仍是主对话 glm-mock",
		JSON.stringify(models("executor", mark)) === '["glm-mock"]',
		JSON.stringify(models("executor", mark)),
	);
} catch (e) {
	console.error("✗ 异常:", e instanceof Error ? e.message : e);
	failures++;
} finally {
	try {
		ws?.close();
	} catch {}
	server.kill();
	mock.close();
	await sleep(300);
	freePort(PORT);
	freePort(MOCK_PORT);
}
console.log(`  替身记录（角色 → 模型）：${JSON.stringify(requests.map((r) => `${r.role}:${r.model}`))}`);
if (process.env.MOCK_TRACE) for (const r of requests) console.log(`    ${r.role}:${r.model}  ${r.hint}`);
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
