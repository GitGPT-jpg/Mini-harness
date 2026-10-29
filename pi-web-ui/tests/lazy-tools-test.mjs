/**
 * 工具延迟加载（load_tools）端到端回归 —— 零 token（本地 mock LLM，openai-completions SSE）。
 *
 * 验证四件事，最后一件是硬约束（缓存不能被我们打坏）：
 *   0. 按需加载**默认关**（#652 起）：显式打开后才只有核心工具（bash/read/edit/write）+
 *      load_tools 常驻；其余工具在系统提示词里**只有名字 + 一行摘要**（目录），没有 schema。
 *   1. 模型调 load_tools(["patch"]) 之后，patch 出现在下一次请求的 tools 里
 *      （参数 schema 到位），并能在同一对话后续轮次继续用。
 *   2. **系统提示词逐字节不变**：加载前后两次请求的 system 文本必须完全一致
 *      （它一变，供应商的前缀缓存就整段失效）；tools 数组只允许**追加**——
 *      第二次的 tools 必须以第一次的 tools 为前缀（顺序/内容都不许动）。
 *   3. 关掉开关后 load_tools 彻底不出现；模型直呼未加载工具时该工具**自动激活**，
 *      原样重试即成功（#652 的死路）。
 *
 * 端口 8975，临时 data-dir / 工作区 / agent 目录，结束自行清理。
 */
import { createServer } from "node:http";
import { portUp, freePort } from "./lib/port-utils.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = Number(process.argv[2] || 8987);
const MOCK_PORT = PORT + 1;
const BASE = mkdtempSync(join(tmpdir(), "pi-lazy-tools-"));
const WS_DIR = join(BASE, "work");
const DATA_DIR = join(BASE, "data");
const AGENT_DIR = join(BASE, "agent");
for (const d of [WS_DIR, DATA_DIR, AGENT_DIR]) mkdirSync(d, { recursive: true });

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

// ── mock LLM：第 1 轮回 load_tools 工具调用，之后回纯文本 ──────────────────
const requests = [];
const delta = (model, d, finish = null) => ({
	id: "chatcmpl-lazy",
	object: "chat.completion.chunk",
	created: Math.floor(Date.now() / 1000),
	model,
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});
const toolCall = (model, name, args) =>
	delta(model, {
		tool_calls: [
			{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
		],
	});
const mock = createServer((req, res) => {
	if (req.method === "GET") {
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] }));
		return;
	}
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		let payload = {};
		try {
			payload = JSON.parse(body || "{}");
		} catch {
			/* ignore */
		}
		requests.push(payload);
		const messages = Array.isArray(payload.messages) ? payload.messages : [];
		const lastUser = messages.map((m) => m.role).lastIndexOf("user");
		const tail = messages.slice(lastUser + 1);
		const alreadyCalled = tail.some((m) => m.role === "tool");
		const lastUserContent = messages[lastUser]?.content;
		const lastUserText = typeof lastUserContent === "string" ? lastUserContent : JSON.stringify(lastUserContent ?? "");
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		// issue #652：模型**直接**调用目录里尚未加载的工具（不走 load_tools），然后原样重试一次。
		const jit = lastUserText.includes("jit direct call");
		const toolResults = tail.filter((m) => m.role === "tool").length;
		const chunks = jit
			? toolResults >= 2
				? [delta(payload.model ?? "mock-model", { content: "done" })]
				: [toolCall(payload.model ?? "mock-model", "find", { pattern: "*", path: WS_DIR })]
			: alreadyCalled
				? [delta(payload.model ?? "mock-model", { content: "done" })]
				: [toolCall(payload.model ?? "mock-model", "load_tools", { tools: ["patch", "read"] })];
		for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
		res.write(
			`data: ${JSON.stringify({
				...delta(payload.model ?? "mock-model", {}),
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
			})}\n\n`,
		);
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

writeFileSync(join(AGENT_DIR, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "lazy-tools-test" } }));
writeFileSync(
	join(AGENT_DIR, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "lazy-tools-test",
				models: [
					{ id: "lazy-tools-mock", name: "Lazy Tools Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 },
				],
			},
		},
	}),
);

try {
	ensureBuild(REPO_ROOT, "lazy-tools-test");
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}
try {
	await freePort(PORT);
} catch {}
await sleep(300);
const server = spawn("node", ["dist/server/index.js"], {
	cwd: REPO_ROOT,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: WS_DIR,
		PI_WEB_DATA_DIR: DATA_DIR,
		PI_CODING_AGENT_DIR: AGENT_DIR,
		PI_WEB_SDK: "bundled",
		PI_WEB_PLUGIN_CATALOG_URL: "",
	},
	stdio: ["ignore", "ignore", "pipe"],
});
let serverErr = "";
server.stderr.on("data", (d) => (serverErr += d.toString()));
for (let i = 0; i < 100 && !(await portUp(PORT)); i++) await sleep(250);
if (!(await portUp(PORT))) {
	console.error(`server did not start (exitCode=${server.exitCode})\n${serverErr.trim() || "(no stderr)"}`);
	process.exit(1);
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
let state = null;
let settings = null;
ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return;
	}
	if (m.type === "snapshot") state = m.state;
	if (m.type === "snapshot_delta" && state && state.rev === m.baseRev) state = { ...state, ...m.state };
	if (m.type === "settings_state") settings = m.settings;
});
await new Promise((r) => ws.once("open", r));
ws.send(JSON.stringify({ type: "hello", clientId: randomUUID() }));
for (let i = 0; i < 100 && !state?.conversationId; i++) await sleep(100);
check("会话已就绪", Boolean(state?.conversationId), `conv=${state?.conversationId}`);

/** 等一次模型请求（按索引）。 */
async function waitRequest(index, timeout = 30000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout && requests.length <= index) await sleep(100);
	return requests[index];
}
const toolNames = (req) => (req?.tools ?? []).map((t) => t.function?.name).filter(Boolean);
const systemText = (req) => {
	const sys = (req?.messages ?? []).find((m) => m.role === "system" || m.role === "developer");
	return typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? "");
};
/** 最后一条 tool 结果消息的文本。 */
const lastToolText = (req) => {
	const tools = (req?.messages ?? []).filter((m) => m.role === "tool");
	const c = tools[tools.length - 1]?.content;
	return typeof c === "string" ? c : JSON.stringify(c ?? "");
};

ws.send(JSON.stringify({ type: "set_model", modelId: "main/lazy-tools-mock" }));
for (let i = 0; i < 100 && state?.model?.id !== "lazy-tools-mock"; i++) await sleep(100);
check("已切到 mock 模型", state?.model?.id === "lazy-tools-mock", `model=${state?.model?.id}`);

// 按需加载**默认关**（#652 起）：刚启动的实例应当已经把全部工具挂在活跃集里，没有 load_tools。
ws.send(JSON.stringify({ type: "get_settings" }));
for (let i = 0; i < 50 && typeof settings?.toolLazyLoading !== "boolean"; i++) await sleep(50);
check(
	"默认关：开箱即用全部工具，load_tools 不出现",
	settings?.toolLazyLoading === false &&
		Array.isArray(state?.tools) &&
		!state.tools.includes("load_tools") &&
		state.tools.includes("patch"),
	`lazy=${settings?.toolLazyLoading} tools=${state?.tools?.join(",")}`,
);

// 按需加载**默认关**（#652 起）：先显式打开，再验证「开」时的目录与缓存行为。
// 新会话才有空种子（老会话按当时活跃集做种子，不会被反向清空），所以打开后另起一个对话。
ws.send(JSON.stringify({ type: "set_settings", toolLazyLoading: true }));
for (let i = 0; i < 50 && settings?.toolLazyLoading !== true; i++) await sleep(50);
check("默认关：显式打开按需加载后设置生效", settings?.toolLazyLoading === true, `value=${settings?.toolLazyLoading}`);
ws.send(JSON.stringify({ type: "new_chat" }));
const lazPrevConv = state?.conversationId;
for (let i = 0; i < 50 && state?.conversationId === lazPrevConv; i++) await sleep(50);
for (let i = 0; i < 50 && !state?.tools?.includes("load_tools"); i++) await sleep(50);
check(
	"按需加载开的会话里，只有核心工具 + load_tools 常驻",
	state?.tools?.includes("load_tools") && !state?.tools?.includes("patch"),
	`tools=${state?.tools?.join(",")}`,
);

// 模型列表里应该只有目录（名字 + 摘要），没有完整 schema。
ws.send(JSON.stringify({ type: "prompt", text: "load the patch tool" }));
const first = await waitRequest(0);
check("已发出第一次模型请求", Boolean(first), `requests=${requests.length}`);
const firstTools = toolNames(first);
check(
	"按需加载开：只常驻核心工具 + load_tools",
	["bash", "read", "edit", "write", "load_tools"].every((n) => firstTools.includes(n)),
	firstTools.join(","),
);
check(
	"未加载的工具（patch/lsp）不在 tools 里",
	!firstTools.includes("patch") && !firstTools.includes("lsp"),
	firstTools.join(","),
);
const firstSystem = systemText(first);
check(
	"系统提示词里列了目录工具（名称 + 一行摘要）",
	firstSystem.includes("- patch:") && firstSystem.includes("- lsp:"),
	`system len=${firstSystem.length}`,
);
check("系统提示词带「先 load_tools」的说明", /load_tools/.test(firstSystem));

// 等 load_tools 执行完 → 第二次请求
const second = await waitRequest(1);
check("load_tools 执行后又发了一次请求", Boolean(second), `requests=${requests.length}`);
const toolResult = (second?.messages ?? []).find((m) => m.role === "tool");
const toolContent =
	typeof toolResult?.content === "string" ? toolResult.content : JSON.stringify(toolResult?.content ?? "");
check(
	"load_tools 拒绝对核心常驻工具 read 的加载请求（提示无需加载）",
	/read: (always available|常驻)/.test(toolContent),
	`toolContent=${toolContent}`,
);
const secondTools = toolNames(second);
check("patch 已被加载进 tools", secondTools.includes("patch"), secondTools.join(","));

// 缓存硬约束：system 逐字节不变；tools 以前一次的为前缀（纯追加）。
const secondSystem = systemText(second);
check(
	"加载前后系统提示词逐字节相同（不破坏前缀缓存）",
	secondSystem === firstSystem,
	`before=${firstSystem.length} after=${secondSystem.length}`,
);
const prefixOk = firstTools.length <= secondTools.length && firstTools.every((n, i) => secondTools[i] === n);
check(
	"tools 数组只追加（第一次的序列是第二次的前缀）",
	prefixOk,
	`before=[${firstTools.join(",")}] after=[${secondTools.join(",")}]`,
);
check("加载后目录里 patch 的描述仍在提示词里（列表不随加载变化）", secondSystem.includes("- patch:"));

// 设置快照里的生效提示词也保持稳定（设置页预览口径）。
const promptBefore = settings?.effectiveSystemPrompt ?? "";
ws.send(JSON.stringify({ type: "get_settings" }));
await sleep(800);
check(
	"settings_state.effectiveSystemPrompt 不随加载变化",
	(settings?.effectiveSystemPrompt ?? "") === promptBefore,
	`len=${(settings?.effectiveSystemPrompt ?? "").length}`,
);

// ---------------------------------------------------------------------------
// 验证：工具按需加载关闭时，绝不暴露 load_tools 工具
// ---------------------------------------------------------------------------
ws.send(JSON.stringify({ type: "set_settings", toolLazyLoading: false }));
for (let i = 0; i < 50 && (state?.tools?.includes("load_tools") || settings?.toolLazyLoading !== false); i++) {
	await sleep(50);
}
ws.send(JSON.stringify({ type: "get_settings" }));
await sleep(400);

check(
	"关闭按需加载后，snapshot.tools 中不再包含 load_tools",
	Array.isArray(state?.tools) && !state.tools.includes("load_tools"),
	`tools=${state?.tools?.join(",")}`,
);
check(
	"关闭按需加载后，effectiveSystemPrompt 不再提及 load_tools",
	!/load_tools/.test(settings?.effectiveSystemPrompt ?? ""),
	`promptPreview=${(settings?.effectiveSystemPrompt ?? "").slice(0, 200)}...`,
);

// 发起一次新会话并请求模型，验证发给模型的 tools 和 systemPrompt 均无 load_tools
ws.send(JSON.stringify({ type: "new_chat" }));
const prevConv = state?.conversationId;
for (let i = 0; i < 50 && state?.conversationId === prevConv; i++) await sleep(50);
check("已新建会话", Boolean(state?.conversationId && state.conversationId !== prevConv));

ws.send(JSON.stringify({ type: "prompt", text: "test tools without lazy loading" }));
const third = await waitRequest(2);
check("已发出第三次模型请求", Boolean(third), `requests=${requests.length}`);
const thirdTools = toolNames(third);
check(
	"关闭按需加载时，模型请求的 tools 数组绝不包含 load_tools",
	!thirdTools.includes("load_tools"),
	`thirdTools=${thirdTools.join(",")}`,
);
check(
	"关闭按需加载时，核心工具依然正常暴露",
	["bash", "read", "edit", "write"].every((n) => thirdTools.includes(n)),
	`thirdTools=${thirdTools.join(",")}`,
);
const thirdSystem = systemText(third);
check(
	"关闭按需加载时，系统提示词绝不包含 load_tools 说明",
	!/load_tools/.test(thirdSystem),
	`system len=${thirdSystem.length}`,
);

// ---------------------------------------------------------------------------
// 验证：模型直接调用目录里尚未加载的工具 → 自动激活，重试即成功（issue #652）
// ---------------------------------------------------------------------------
ws.send(JSON.stringify({ type: "set_settings", toolLazyLoading: true }));
for (let i = 0; i < 50 && settings?.toolLazyLoading !== true; i++) await sleep(50);
ws.send(JSON.stringify({ type: "new_chat" }));
const prevJitConv = state?.conversationId;
for (let i = 0; i < 50 && state?.conversationId === prevJitConv; i++) await sleep(50);
check("已新建 JIT 会话", Boolean(state?.conversationId && state.conversationId !== prevJitConv));

ws.send(JSON.stringify({ type: "prompt", text: "jit direct call" }));
const jitBase = requests.length;
const jit1 = await waitRequest(jitBase);
check(
	"JIT：首次请求里 find 尚未加载（不在活跃 tools 里）",
	Boolean(jit1) && !toolNames(jit1).includes("find"),
	`tools=${toolNames(jit1).join(",")}`,
);
const jit2 = await waitRequest(jitBase + 1);
const firstFindResult = lastToolText(jit2);
check(
	"JIT：直呼未加载工具时 SDK 仍回 not found（这是 SDK 侧行为，不是我们的死路）",
	/not found/i.test(firstFindResult),
	firstFindResult.slice(0, 120),
);
check(
	"JIT：该工具已被自动激活（下一次请求的 tools 里已经出现）",
	toolNames(jit2).includes("find"),
	`tools=${toolNames(jit2).join(",")}`,
);
const jit3 = await waitRequest(jitBase + 2);
const secondFindResult = lastToolText(jit3);
check(
	"JIT：原样重试即成功，不再回 not found（issue #652 的死路已解除）",
	secondFindResult.length > 0 && !/not found/i.test(secondFindResult),
	secondFindResult.slice(0, 120),
);

check("服务进程仍然存活", server.exitCode === null, `exitCode=${server.exitCode}`);

ws.close();
server.kill("SIGKILL");
mock.close();
rmSync(BASE, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
