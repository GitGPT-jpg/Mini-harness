// cluster-binding-loop — 从真正的任务入口（loop_start_request）验证运行中任务的集群绑定。
//
// 替身 kubectl 只记录「目标 server + 调用标签」，不记凭据；替身 provider 扮演执行模型：
//   第 1 轮：bash 调 kubectl → loop_done；precheck / validator 也调 kubectl，validator 第 1 轮故意失败；
//   第 2 轮：在测试放行前挂起（期间导入 B / 重启服务），放行后 bash 调 kubectl 并写 ok.flag → loop_done → 通过。
// 断言：
//   A. 任务 A 以继承的 KUBECONFIG=A 启动；Web 导入 B 后，A 第 2 轮的 Bash / precheck / validator 仍连 A；
//   B. 之后新开的任务 B 连 B；
//   C. 清除 Web 配置后，新任务按当前优先级回到启动时的 A，已结束的任务不受影响；
//   D. 任务 C 第 1 轮后重启服务（这次启动时 KUBECONFIG=B），loop_resume 续跑的 Bash / validator 仍连 A；
//   E. 集群 API 响应、服务日志、替身记录里都没有凭据。
// 零 token；用法：npm run build && node tests/cluster-binding-loop-test.mjs [port]
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const PORT = Number(process.argv[2] || 8970);
const MOCK_PORT = PORT + 2;
freePort(PORT);
freePort(MOCK_PORT);
const REPO = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-web-cluster-loop-"));
const [proj, dataDir, agentDir, home, bin] = ["proj", "data", "agent", "home", "bin"].map((d) => join(base, d));
for (const d of [proj, dataDir, agentDir, home, bin]) mkdirSync(d, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: proj });
writeFileSync(join(proj, "README.md"), "demo\n");
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: proj });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: proj });

const TOKEN_A = "FAKE-TOKEN-LOOP-A1";
const TOKEN_B = "FAKE-TOKEN-LOOP-B2";
const kubeconfig = (server, token) =>
	`apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: ${server}\ncontexts:\n- name: ctx\n  context:\n    cluster: c\n    user: u\nusers:\n- name: u\n  user:\n    token: ${token}\ncurrent-context: ctx\n`;
const cfgA = join(base, "a.yaml");
const cfgB = join(base, "b.yaml");
writeFileSync(cfgA, kubeconfig("https://a.example", TOKEN_A));
writeFileSync(cfgB, kubeconfig("https://b.example", TOKEN_B));
const LOG = join(bin, "calls.log");
const KUBECTL = join(bin, "kubectl");
writeFileSync(
	KUBECTL,
	`#!/bin/sh
cfg=""; prev=""
for a in "$@"; do [ "$prev" = "--kubeconfig" ] && cfg="$a"; prev="$a"; done
[ -z "$cfg" ] && cfg="\${KUBECONFIG:-$HOME/.kube/config}"
case "$*" in
  *"config view"*) cat "$cfg"; exit $?;;
  *"current-context"*) echo ctx; exit 0;;
esac
echo "TAG=\${KTAG:-probe} TARGET=$(grep -m1 'server:' "$cfg" 2>/dev/null | sed 's/.*server: *//')" >> "${LOG}"
echo '{"gitVersion":"v1.28.3"}'
`,
);
chmodSync(KUBECTL, 0o755);
const calls = () => (existsSync(LOG) ? readFileSync(LOG, "utf8") : "");
const tagged = (tag) =>
	calls()
		.split("\n")
		.filter((l) => l.startsWith(`TAG=${tag} `))
		.map((l) => l.replace(/^TAG=\S+ /, ""));

// ---- 替身 provider：按会话历史决定下一步 -------------------------------------
const holds = new Set(); // 被挂起的 run 标签（goal 文本里带 [task:X]）
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
const call = (model, name, args) => [
	chunk(model, {
		tool_calls: [
			{ index: 0, id: `c_${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
		],
	}),
	chunk(model, {}, "tool_calls"),
];
const text = (m) =>
	typeof m?.content === "string"
		? m.content
		: Array.isArray(m?.content)
			? m.content.map((p) => p?.text ?? "").join("")
			: "";
const mock = createServer(async (req, res) => {
	if (!String(req.url).endsWith("/chat/completions")) return void res.writeHead(404).end();
	let body = "";
	for await (const c of req) body += c;
	const p = JSON.parse(body || "{}");
	const msgs = p.messages ?? [];
	const all = msgs.map(text).join("\n");
	const task = /\[task:(\w+)\]/.exec(all)?.[1];
	if (!task || !(p.tools ?? []).some((t) => t?.function?.name === "loop_done")) {
		return sse(res, [chunk(p.model, { content: "OK" }), chunk(p.model, {}, "stop")]);
	}
	const assistantCalls = msgs.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []) : []));
	const nDone = assistantCalls.filter((c) => c.function?.name === "loop_done").length;
	const last = msgs.at(-1);
	const lastCall = assistantCalls.at(-1)?.function?.name;
	const round = nDone + 1;
	if (last?.role === "tool" && lastCall === "bash")
		return sse(res, call(p.model, "loop_done", { summary: `r${round}` }));
	// loop_done 之后结束本回合：运行时在回合结束时跑 precheck / validator，失败再发下一轮
	if ((last?.role === "tool" && lastCall === "loop_done") || nDone >= 2)
		return sse(res, [chunk(p.model, { content: "本轮完成，等待验证" }), chunk(p.model, {}, "stop")]);
	if (nDone === 1) while (holds.has(task)) await sleep(50);
	const cmd =
		round === 1
			? `KTAG=${task}-bash-r1 ${KUBECTL} get --raw=/version`
			: `KTAG=${task}-bash-r2 ${KUBECTL} get --raw=/version; touch ok-${task}.flag`;
	return sse(res, call(p.model, "bash", { command: cmd }));
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "mock-key",
				models: [{ id: "glm-mock", name: "glm-mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
			},
		},
	}),
);

// ---- 服务 ---------------------------------------------------------------------
let server = null;
let srvLog = "";
async function startServer(kubeconfigEnv) {
	server = spawn(process.execPath, ["dist/server/index.js"], {
		cwd: REPO,
		env: {
			...process.env,
			HOME: home,
			KUBECONFIG: kubeconfigEnv,
			PATH: `${bin}:${process.env.PATH}`,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: proj,
			PI_CODING_AGENT_DIR: agentDir,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stdout.on("data", (d) => (srvLog += d));
	server.stderr.on("data", (d) => (srvLog += d));
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return;
		} catch {}
		await sleep(100);
	}
	throw new Error("server did not start");
}
async function stopServer() {
	if (!server) return;
	const s = server;
	server = null;
	s.kill("SIGTERM");
	await new Promise((r) => (s.exitCode !== null ? r() : s.once("exit", r)));
}
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
async function connect() {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
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
	send({ type: "hello", clientId: "cluster-binding-loop", locale: "zh" });
	await waitFor(() => st.snapshot);
	send({ type: "set_model", modelId: "mock/glm-mock" });
	await waitFor(() => st.snapshot?.model?.id === "glm-mock", 20000);
	return { ws, st, send };
}
const startTask = (c, task) =>
	c.send({
		type: "loop_start_request",
		goal: `[task:${task}] 连通性自检`,
		mode: "code",
		maxRounds: 3,
		useReviewer: false,
		worktree: false,
		precheckCmd: `KTAG=${task}-precheck ${KUBECTL} get --raw=/version`,
		validateCmd: `KTAG=${task}-validate ${KUBECTL} get --raw=/version && test -f ok-${task}.flag`,
	});
const api = (path, body) =>
	fetch(`http://127.0.0.1:${PORT}/api/mini-harness/${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	}).then((r) => r.text());
const apiBodies = [];

let c;
try {
	await startServer(cfgA);
	c = await connect();
	apiBodies.push(await api("cluster?refresh=1"));
	check("服务启动时继承的 KUBECONFIG=A 被识别", JSON.parse(apiBodies[0]).source === "env", apiBodies[0].slice(0, 80));

	// ---- A：导入 B 前后 -------------------------------------------------------
	holds.add("A");
	startTask(c, "A");
	const runA = (await waitFor(() => c.st.snapshot?.loop?.runId, 20000)) ?? "";
	await waitFor(() => tagged("A-validate").length >= 1, 60000);
	apiBodies.push(await api("cluster", { kubeconfig: kubeconfig("https://b.example", TOKEN_B) }));
	check("Web 导入 B 生效（新任务的当前配置）", JSON.parse(apiBodies.at(-1)).source === "app");
	holds.delete("A");
	await waitFor(() => c.st.snapshot?.loop?.status === "done", 60000);
	for (const tag of ["A-bash-r1", "A-precheck", "A-validate", "A-bash-r2"]) {
		const t = tagged(tag);
		check(
			`任务 A ${tag} 全部连 A`,
			t.length > 0 && t.every((x) => x === "TARGET=https://a.example"),
			JSON.stringify(t),
		);
	}
	check("任务 A 跑完两轮并通过", c.st.snapshot?.loop?.status === "done", String(c.st.snapshot?.loop?.status));
	const detail = JSON.parse(await api(`runs/${runA}/detail`));
	check(
		"run detail 只带绑定标识",
		detail.clusterBinding?.source === "env" &&
			detail.clusterBinding?.status === "pinned" &&
			!("file" in (detail.clusterBinding ?? {})),
		JSON.stringify(detail.clusterBinding),
	);

	// ---- B：新任务用 B --------------------------------------------------------
	c.send({ type: "new_chat" });
	await sleep(800);
	startTask(c, "B");
	await waitFor(() => tagged("B-validate").length >= 2, 60000);
	check(
		"新任务 B 的 Bash / validator 连 B",
		[...tagged("B-bash-r1"), ...tagged("B-validate")].every((x) => x === "TARGET=https://b.example"),
		JSON.stringify(tagged("B-validate")),
	);

	// ---- C：清除后新任务回到启动时的 A ----------------------------------------
	apiBodies.push(await api("cluster/clear", {}));
	check("清除后回退到启动时继承的 A", JSON.parse(apiBodies.at(-1)).source === "env");

	// ---- D：重启服务后续跑 ------------------------------------------------------
	c.send({ type: "new_chat" });
	await sleep(800);
	holds.add("C");
	startTask(c, "C");
	const runC = (await waitFor(() => c.st.snapshot?.loop?.runId !== runA && c.st.snapshot?.loop?.runId, 20000)) ?? "";
	await waitFor(() => tagged("C-validate").length >= 1, 60000);
	c.ws.close();
	await stopServer();
	await startServer(cfgB); // 这次从「KUBECONFIG=B」的终端启动
	c = await connect();
	apiBodies.push(await api("cluster?refresh=1"));
	check("重启后当前配置是 B", JSON.parse(apiBodies.at(-1)).source === "env" && JSON.parse(apiBodies.at(-1)).connected);
	holds.delete("C");
	// 服务启动时会自动恢复被中断的运行；5 秒内没动静才显式 loop_resume（避免与自动恢复重复投递）。
	let resumed = await waitFor(() => tagged("C-bash-r2").length >= 1, 5000);
	if (!resumed) {
		c.send({ type: "loop_resume", runId: runC });
		resumed = await waitFor(() => tagged("C-bash-r2").length >= 1, 60000);
	}
	check("重启后续跑（自动恢复或 loop_resume）继续执行", !!resumed);
	console.log(
		"  重启后的通知：" +
			c.st.msgs
				.filter((m) => m.type === "notice")
				.map((m) => m.text)
				.join(" | "),
	);
	await waitFor(() => tagged("C-validate").length >= 2, 15000);
	const dC = JSON.parse(await api(`runs/${runC}/detail`));
	console.log(
		"  任务 C 重启续跑后的状态：" +
			JSON.stringify({
				status: dC.status,
				stage: dC.stage,
				round: dC.round,
				stopReason: dC.stopReason,
				binding: dC.clusterBinding?.status,
				recovery: dC.recovery,
				lastJournal: (dC.journal ?? []).slice(-4).map((j) => j.type ?? j.event ?? j.kind),
			}),
	);
	for (const tag of ["C-bash-r1", "C-precheck", "C-validate", "C-bash-r2"]) {
		const t = tagged(tag);
		check(
			`任务 C ${tag} 连 A（bash-r2 发生在以 KUBECONFIG=B 重启之后）`,
			t.length > 0 && t.every((x) => x === "TARGET=https://a.example"),
			JSON.stringify(t),
		);
	}
	// 重启后第 2 轮的 precheck / validator 是否运行取决于恢复链路（窗口一）；这里只如实记录。
	console.log(`  重启后第 2 轮 validator 运行次数：${Math.max(0, tagged("C-validate").length - 1)}`);
} catch (e) {
	console.error("✗ 异常:", e instanceof Error ? e.message : e);
	failures++;
} finally {
	try {
		c?.ws.close();
	} catch {}
	await stopServer();
	mock.close();
	freePort(PORT);
	freePort(MOCK_PORT);
}
const blob = [calls(), srvLog, ...apiBodies].join("\n");
check("替身记录 / 服务日志 / 集群 API 响应里没有凭据", !blob.includes(TOKEN_A) && !blob.includes(TOKEN_B));
console.log(
	"  替身 kubectl 记录（标签 + 目标，无凭据）：\n" +
		calls()
			.trim()
			.split("\n")
			.map((l) => "    " + l)
			.join("\n"),
);
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
