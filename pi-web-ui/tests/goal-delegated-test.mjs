/**
 * 目标模式 2.0 的端到端冒烟（唯一路径：执行对话干活 + 当前对话验收）。
 *
 * 只验证**服务端接线**（不需要真模型）：左栏角色对话真的被拉起、主对话不再收到
 * 「请开始实现」kick、清目标时执行对话被收掉。审查/执行判定逻辑由
 * tests/unit/goal-delegated.test.ts（fake GoalHost）覆盖。
 *
 * 跑法：node tests/goal-delegated-test.mjs（端口 8907）
 */
import { portUp } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = Number(process.argv[2] || 8907);
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-goal-delegated-"));
// 隔离的模型目录：执行与审查必须属于不同家族，主对话 glm-mock（zhipu）审查、执行用 gpt-mock（openai）。
// 端口 9 无服务：模型请求必败，本测只验角色对话接线（零 token）。
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-goal-delegated-agent-"));
const mockModel = (id) => ({ id, name: id, input: ["text"], contextWindow: 32000, maxTokens: 4096 });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:9",
				apiKey: "mock-key",
				models: [mockModel("glm-mock"), mockModel("gpt-mock")],
			},
		},
	}),
);

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

const server = spawn("node", ["dist/server/index.js"], {
	cwd: REPO_ROOT,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: REPO_ROOT,
		PI_CODING_AGENT_DIR: agentDir,
		// 角色轮等待上限跟着工具看门狗走：压小它，免在无凭据环境里等模型的整轮重试。
		PI_WEB_TOOL_TIMEOUT_MS: "12000",
	},
	stdio: "ignore",
});
for (let i = 0; i < 60 && !(await portUp(PORT)); i++) await sleep(250);

const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
let seq = 0;
const send = (msg) => ws.send(JSON.stringify({ ...msg, seq: ++seq }));

let snapshot = null;
let conversations = [];
let goalStatus = null;
ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return; // malformed frame
	}
	if (m.type === "snapshot") snapshot = m.state;
	else if (m.type === "snapshot_delta") {
		if (snapshot && snapshot.rev === m.baseRev) {
			snapshot = { ...snapshot, ...m.state, messages: [...(snapshot.messages ?? []), ...m.appended] };
		}
	} else if (m.type === "conversations") conversations = m.conversations;
	else if (m.type === "goal_status") goalStatus = m.status;
});

const waitFor = async (pred, what, timeout = 15000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		if (pred()) return true;
		await sleep(100);
	}
	console.error(`TIMEOUT waiting for ${what}`);
	return false;
};

// 目标模式 2.0：执行对话是**落盘**普通对话（isSubagent=false），靠 parentId 挂到主对话下。
const execRows = (parentId) => (conversations ?? []).filter((c) => c.parentId === parentId);

try {
	ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId: randomUUID() })));
	await waitFor(() => snapshot !== null, "initial snapshot");
	const mainId = snapshot?.conversationId;
	check("主对话已就绪", typeof mainId === "string" && mainId.length > 0, mainId ?? "(none)");

	send({ type: "set_model", modelId: "mock/glm-mock" });
	await waitFor(() => snapshot?.model?.id === "glm-mock", "main model glm-mock");
	send({
		type: "set_goal",
		goal: "把 README 的安装说明补全",
		maxRounds: 1,
		locked: true,
		execModel: "mock/gpt-mock",
	});
	await waitFor(
		() => goalStatus?.goal === "把 README 的安装说明补全" && !!goalStatus?.roles?.executor?.convId,
		"goal_status with executor",
	);

	check(
		"reviewMode 已从协议移除（只剩一条路径）",
		goalStatus?.reviewMode === undefined,
		String(goalStatus?.reviewMode),
	);
	check("execModel 按请求生效（新后端标志）", goalStatus?.execModel === "mock/gpt-mock", String(goalStatus?.execModel));
	check(
		"reviewerModel 键恒下发（null = 主对话审查）",
		goalStatus?.reviewerModel === null,
		String(goalStatus?.reviewerModel),
	);
	const execId = goalStatus?.roles?.executor?.convId;
	check("服务端拉起了常驻执行对话", typeof execId === "string" && execId.length > 0, execId ?? "(none)");
	check(
		"循环相位已进入执行/审查",
		goalStatus?.phase === "executing" || goalStatus?.phase === "reviewing" || goalStatus?.phase === "blocked",
		String(goalStatus?.phase),
	);

	await waitFor(() => execRows(mainId).some((r) => r.id === execId), "executor row in conversations");
	const row = execRows(mainId).find((r) => r.id === execId);
	check("左栏出现执行对话（挂在主对话下）", !!row, row ? `${row.id} · ${row.title}` : "(missing)");
	check(
		"执行对话是落盘对话（无「子代理」微标 + 带目标执行标题）",
		!!row && row.isSubagent === false && /^\[(目标执行|Goal executor)\]/.test(String(row.title)),
		row ? `${row.isSubagent} · ${row.title}` : "",
	);

	const mainTexts = (snapshot?.messages ?? [])
		.filter((m) => m.role === "user")
		.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
		.join("\n");
	check("主对话没收到「请开始实现」kick（它是审查者）", !mainTexts.includes("请现在开始实现"));

	// 清目标 → 执行对话被移出左栏（转录保留在历史里：落盘的代价）
	send({ type: "clear_goal" });
	await waitFor(() => goalStatus?.goal === null, "goal_status cleared");
	const removed = await waitFor(() => !execRows(mainId).some((r) => r.id === execId), "executor row removed");
	check("清目标后执行对话被移出左栏", removed);
} catch (err) {
	check(`冒烟异常：${err instanceof Error ? err.message : String(err)}`, false);
} finally {
	try {
		ws.close();
	} catch {
		/* ignore */
	}
	server.kill();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
