/**
 * 工具定义说明（`get_tool_info` → `tool_info`）—— 工具卡右键「显示工具详细信息」的协议回归。
 *
 * 零 token：只发一条协议消息，断言服务端**从引擎现取**的那份工具定义（说明 / 参数 schema /
 * 是否启用 / 来源）能正确归一化回包；顺带覆盖三个容易退化的点：
 *   1. 不存在的工具名要回 `found: false`（前端据此显示「未找到工具定义」），且**不是**
 *      `unsupported`（两者对用户的含义不同）；
 *   2. 被宿主覆盖过的内置工具（read，见 read-tool.ts）照样能取到定义；
 *   3. 定义不进快照 —— 这条请求是只读的，取完服务端要照常活着（后续请求仍通）。
 *
 * 端口 8922（≥8900 约定），临时 data-dir + 临时工作区，结束自行清理。
 */
import { portUp, freePort } from "./lib/port-utils.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8922;
const WS_DIR = mkdtempSync(join(tmpdir(), "pi-toolinfo-"));
const DATA_DIR = mkdtempSync(join(tmpdir(), "pi-toolinfo-data-"));

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

try {
	ensureBuild(REPO_ROOT, "tool-info-test");
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}
try {
	await freePort(PORT);
} catch {}
await sleep(400);
let server = spawn("node", ["dist/server/index.js"], {
	cwd: REPO_ROOT,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: WS_DIR,
		PI_WEB_DATA_DIR: DATA_DIR,
	},
	stdio: ["ignore", "ignore", "pipe"],
});
let serverErr = "";
const attachErr = () => (server.stderr.on("data", (d) => (serverErr += d.toString())), void 0);
attachErr();
for (let attempt = 0; attempt < 2 && !(await portUp(PORT)); attempt++) {
	for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);
	if (await portUp(PORT)) break;
	server.kill("SIGKILL");
	await sleep(300);
	try {
		await freePort(PORT);
	} catch {}
	server = spawn("node", ["dist/server/index.js"], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_CWD: WS_DIR,
			PI_WEB_DATA_DIR: DATA_DIR,
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	attachErr();
}
if (!(await portUp(PORT))) {
	console.error(`server did not start (exitCode=${server.exitCode})\n${serverErr.trim() || "(no stderr)"}`);
	process.exit(1);
}

const clientId = randomUUID();
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
/** tool_info 应答（按工具名归类，取最后一次）。 */
const infos = new Map();
ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return;
	}
	if (m.type === "tool_info") infos.set(m.name, m);
});
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId })));
await sleep(1200);

/** 发一条 get_tool_info 并等它的应答（超时 8s）。 */
async function ask(name) {
	infos.delete(name);
	ws.send(JSON.stringify({ type: "get_tool_info", name }));
	const t0 = Date.now();
	while (Date.now() - t0 < 8000 && !infos.has(name)) await sleep(100);
	return infos.get(name);
}

// 1) 内置 bash：定义齐全（说明 + 参数 schema + 是否启用 + 来源）。
const bash = await ask("bash");
check("bash 有定义（found: true）", bash?.found === true, JSON.stringify(bash && { found: bash.found }));
check(
	"bash 带回说明文字",
	typeof bash?.description === "string" && bash.description.trim().length > 20,
	`len=${bash?.description?.length ?? 0}`,
);
check(
	"bash 带回参数 JSON Schema（command 等属性）",
	bash?.parameters !== undefined &&
		typeof bash.parameters === "object" &&
		bash.parameters !== null &&
		typeof bash.parameters.properties === "object" &&
		bash.parameters.properties !== null &&
		"command" in bash.parameters.properties,
	Object.keys(bash?.parameters?.properties ?? {}).join(","),
);
check("bash 标了「当前启用」", bash?.active === true, `active=${bash?.active}`);
check(
	"bash 带回来源信息（source 非空）",
	typeof bash?.source === "string" && bash.source.length > 0,
	`source=${bash?.source} scope=${bash?.scope}`,
);
check("参数 schema 没被当成超限丢掉", bash?.parametersDropped !== true, `parametersDropped=${bash?.parametersDropped}`);

// 2) 宿主覆盖过的内置工具（read 走 read-tool.ts 的 customTool）照样取得到定义。
const read = await ask("read");
check("被覆盖的 read 也能取到定义", read?.found === true, JSON.stringify(read && { found: read.found }));

// 3) 不存在的工具名 → found:false，且**不是** unsupported。
const missing = await ask("definitely_not_a_real_tool_zzz");
check("不存在的工具名回 found:false", missing?.found === false, JSON.stringify(missing));
check("「没找到」不会被报成「引擎不支持」", missing?.unsupported !== true, `unsupported=${missing?.unsupported}`);
check("应答里的工具名原样回显", missing?.name === "definitely_not_a_real_tool_zzz", missing?.name);

// 4) 只读请求不该影响服务：再问一次仍然通，进程还活着。
const again = await ask("bash");
check(
	"连问两次都能拿到定义（服务没被这次请求搞挂）",
	again?.found === true,
	JSON.stringify(again && { found: again.found }),
);
check("服务进程仍然存活", server.exitCode === null, `exitCode=${server.exitCode}`);

ws.close();
server.kill("SIGKILL");
rmSync(WS_DIR, { recursive: true, force: true });
rmSync(DATA_DIR, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
