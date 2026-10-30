/**
 * 任务详情（D-12-3 成果与证据查看器）浏览器用例，零 token：
 * 1. 临时 MINI_HARNESS_RUNTIME_ROOT 里预置 run：done/passed（两轮证据 + 评审报告 + journal + diff）、
 *    stopped/reviewer-error（代码验证已过、评审超时），外加一条点开前就被删掉的 run（走 404 空状态）；
 * 2. 顶栏「任务台」→ 每行显示人话状态（交卷了 · 查看成果 / 裁判掉线了 · 等待重试）；
 * 3. 逐行点开详情：状态、代码验证 / 模型评审两行、理由、各轮记录、验收输出、diff、时间线、模型与分支都在；
 *    这些 run 不是当前对话发起的 → 不给停止 / 重试评审，只给提示；Escape 先关详情、任务台还在；
 * 4. routeWebSocket 把评审掉线的 run 注入快照的 conv.loop（等同「本对话发起的 run」）：LoopBar 终态行
 *    「⚠ 裁判掉线了 · 等待重试」+ 重试评审 / 按代码验证收下；点状态文字打开详情，动作按钮出现；
 *    点按钮发出 loop_resume / loop_accept（在路由里拦下，不进服务端）；
 * 5. 全程没有页面错误。
 * 隔离：端口 8931 起找空闲（≥8900，不碰 8787/8788）；PI_WEB_DATA_DIR / PI_WEB_CWD / PI_CODING_AGENT_DIR /
 * MINI_HARNESS_RUNTIME_ROOT 全在一个 mkdtemp 目录里，结束删掉。agent 目录只有一个指向 127.0.0.1:1 的假
 * provider：万一有东西想调模型也会立刻失败，不花 token。界面语言 zh-CN。
 * 截图：设 RUN_DETAIL_SHOTS=<目录> 时写 d12-detail-*.png。需要已构建的 dist（npm run build）。
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const SHOTS = process.env.RUN_DETAIL_SHOTS || "";

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

const BASE = mkdtempSync(join(tmpdir(), "pi-web-rundetail-"));
const DATA = join(BASE, "data");
const WORK = join(BASE, "work");
const AGENT = join(BASE, "agent");
const RUNS = join(BASE, "runs");
for (const d of [DATA, WORK, AGENT, RUNS]) mkdirSync(d, { recursive: true });

// 假 provider：models.json 自带 apiKey（首次配置弹窗不弹），baseUrl 指向不可连的端口。
writeFileSync(join(AGENT, "auth.json"), JSON.stringify({ fastfail: { type: "api_key", key: "dummy" } }));
writeFileSync(
	join(AGENT, "models.json"),
	JSON.stringify({
		providers: {
			fastfail: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1",
				apiKey: "dummy",
				models: [{ id: "glm-4.6", name: "GLM-4.6" }],
			},
		},
	}),
);

// ---- 预置 run（state.json 字段与 server/loop/extension.ts 的 LoopState 一致） ----
const RUN_OK = "20261030120000-aaa111";
const RUN_ERR = "20261030121500-bbb222";
const RUN_GONE = "20261030110000-ccc333";
const T0 = Date.now() - 30 * 60_000;
const iso = (offsetMin) => new Date(T0 + offsetMin * 60_000).toISOString();

function baseState(runId, p) {
	return {
		runId,
		taskId: `loop-${runId.slice(-6)}`,
		workspace: WORK,
		baseWorkspace: WORK,
		worktreeDir: null,
		worktreeBranch: null,
		worktreeCommitted: false,
		harnessRoot: null,
		artifactRoots: [],
		maxRounds: 5,
		auto: true,
		mode: "code",
		epoch: 0,
		sessionId: `seeded-${runId.slice(-6)}`,
		mainModel: { provider: "fastfail", id: "glm-4.6", family: "glm" },
		plannerModel: { provider: "fastfail", id: "deepseek-v3", family: "deepseek" },
		reviewerModel: { provider: "fastfail", id: "qwen3", family: "qwen" },
		plannerOutput: "",
		plan: "",
		summary: "",
		validatedRound: 0,
		useReviewer: true,
		...p,
	};
}

function seedRun(st, evidence, journal) {
	const dir = join(RUNS, st.runId);
	mkdirSync(join(dir, "evidence"), { recursive: true });
	writeFileSync(join(dir, "state.json"), JSON.stringify(st, null, 2));
	for (const [name, text] of Object.entries(evidence)) writeFileSync(join(dir, "evidence", name), text);
	writeFileSync(
		join(dir, "journal.jsonl"),
		journal.map((j) => JSON.stringify({ runId: st.runId, ...j })).join("\n") + "\n",
	);
}

// 1) 交卷了（代码验证 + 模型评审都过）：第 1 轮验证没过，第 2 轮通过、评审通过、worktree 已提交。
seedRun(
	baseState(RUN_OK, {
		goal: "在当前目录创建 result.txt，内容为 DONE",
		criteria: "result.txt 存在且内容为 DONE",
		validateCmd: "python3 validate.py",
		worktreeBranch: `mini-harness/${RUN_OK}`,
		worktreeCommitted: true,
		round: 2,
		stage: "done",
		status: "done",
		acceptance: "passed",
		lastVerdict: "pass",
		lastCode: 0,
		lastEvidence: "$ python3 validate.py\nPASS: result.txt == DONE\n",
		lastReview: { verdict: "pass", reasons: ["result.txt 内容为 DONE，与目标一致"] },
		lastDiff:
			"diff --git a/result.txt b/result.txt\nnew file mode 100644\n--- /dev/null\n+++ b/result.txt\n@@ -0,0 +1 @@\n+DONE\n",
		summary: "已创建 result.txt（内容 DONE），validate.py 通过。",
		history: [
			{ round: 1, verdict: "fail", code: 1, at: iso(3), evidence: null },
			{ round: 2, verdict: "pass", code: 0, at: iso(6), evidence: null },
		],
		createdAt: iso(0),
		updatedAt: iso(7),
	}),
	{
		"round-1-review.md":
			`# mini-harness 运行报告 · ${RUN_OK}\n- round: 1 | stage: run | mode: code\n- verdict: FAIL（exit 1）\n\n` +
			"## validator 输出\n```\nFAIL: result.txt missing\n```\n",
		"round-1-1761825780000.log": "$ python3 validate.py\nFAIL: result.txt missing\n",
		"round-2-review.md":
			`# mini-harness 运行报告 · ${RUN_OK}\n- round: 2 | stage: validate | mode: code\n- verdict: PASS（exit 0）\n` +
			"- reviewer: pass\n- reviewer reasons:\n  - result.txt 内容为 DONE，与目标一致\n",
		"round-2-1761825960000.log": "$ python3 validate.py\nPASS: result.txt == DONE\n",
	},
	[
		{ at: iso(0), round: 1, event: "start", source: "server" },
		{ at: iso(1), round: 1, event: "plan" },
		{ at: iso(3), round: 1, event: "validate-fail", code: 1, failedRound: 1, nextRound: 2 },
		{ at: iso(6), round: 2, event: "review", verdict: "pass" },
		{ at: iso(6), round: 2, event: "validate-pass", code: 0, review: "pass", acceptance: "passed" },
		{ at: iso(7), round: 2, event: "worktree-commit", branch: `mini-harness/${RUN_OK}` },
	],
);

// 2) 裁判掉线了：代码验证已过，评审请求超时，停在 review-error 等用户处理。
const ERR_STATE = baseState(RUN_ERR, {
	goal: "运行测试直到全部通过",
	criteria: "npm test 退出码 0",
	validateCmd: "npm test",
	round: 1,
	stage: "review-error",
	status: "stopped",
	stopReason: "reviewer-error",
	epoch: 1,
	acceptance: null,
	lastVerdict: "pass",
	lastCode: 0,
	lastEvidence: "> npm test\n\n Test Files  3 passed (3)\n      Tests  42 passed (42)\n",
	lastReview: { verdict: "error", reasons: ["reviewer 请求超时（60s 无响应）"] },
	lastDiff:
		"diff --git a/src/sum.ts b/src/sum.ts\n--- a/src/sum.ts\n+++ b/src/sum.ts\n@@ -1,3 +1,3 @@\n" +
		" export function sum(a: number, b: number) {\n-\treturn a - b;\n+\treturn a + b;\n }\n",
	history: [{ round: 1, verdict: "pass", code: 0, at: iso(14), evidence: null }],
	createdAt: iso(10),
	updatedAt: iso(15),
});
seedRun(
	ERR_STATE,
	{
		"round-1-review.md":
			`# mini-harness 运行报告 · ${RUN_ERR}\n- round: 1 | stage: validate | mode: code\n- verdict: PASS（exit 0）\n` +
			"- reviewer: error\n- reviewer reasons:\n  - reviewer 请求超时（60s 无响应）\n",
		"round-1-1761826440000.log": "> npm test\n\n Test Files  3 passed (3)\n      Tests  42 passed (42)\n",
	},
	[
		{ at: iso(10), round: 1, event: "start", source: "server" },
		{ at: iso(11), round: 1, event: "plan" },
		{ at: iso(15), round: 1, event: "review", verdict: "error" },
		{ at: iso(15), round: 1, event: "reviewer-error", mode: "code", code: 0, epoch: 1 },
	],
);

// 3) 点开前就被删掉的 run：详情接口 404 → 友好空状态。
seedRun(
	baseState(RUN_GONE, {
		goal: "一条马上会被删掉的记录",
		round: 1,
		stage: "stopped",
		status: "stopped",
		stopReason: "user-stop",
		acceptance: null,
		lastVerdict: null,
		lastCode: null,
		lastEvidence: "",
		lastReview: null,
		history: [],
		createdAt: iso(-20),
		updatedAt: iso(-19),
	}),
	{},
	[{ at: iso(-20), round: 1, event: "start" }],
);

// ---- 起服务（只清理自己起的进程） ----
let server = null;
async function pickPort() {
	for (let p = 8931; p < 8950; p++) if (!(await portUp(p))) return p;
	throw new Error("no free port in 8931-8949");
}
async function startServer(port) {
	const env = {
		...process.env,
		PI_WEB_PORT: String(port),
		PI_WEB_DATA_DIR: DATA,
		PI_WEB_CWD: WORK,
		PI_CODING_AGENT_DIR: AGENT,
		MINI_HARNESS_RUNTIME_ROOT: RUNS,
	};
	delete env.PI_WEB_TOKEN;
	server = spawn("node", ["dist/server/index.js"], { cwd: REPO_ROOT, env, stdio: "ignore" });
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		try {
			const r = await fetch(`http://127.0.0.1:${port}/api/health`);
			if (r.ok) return;
		} catch {
			/* retry */
		}
	}
	throw new Error("server did not start");
}
function cleanup() {
	try {
		server?.kill("SIGTERM");
	} catch {
		/* ignore */
	}
	try {
		rmSync(BASE, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

/** 截图（设了 RUN_DETAIL_SHOTS 才拍）。 */
async function shot(page, name, locator) {
	if (!SHOTS) return;
	const path = join(SHOTS, `d12-detail-${name}.png`);
	if (locator) await locator.screenshot({ path });
	else await page.screenshot({ path });
	console.log(`  · screenshot ${path}`);
}

const text = async (loc) => ((await loc.count()) > 0 ? ((await loc.first().innerText()) ?? "").trim() : "");
const lines = async (page) => (await page.locator(".run-detail .run-detail-line").allInnerTexts()).map((s) => s.trim());

async function run() {
	if (!CHROME_PATH || !existsSync(CHROME_PATH)) {
		console.log("SKIP run-detail-ui-test: no Chrome (set PI_WEB_CHROME)");
		cleanup();
		process.exit(0);
	}
	const port = await pickPort();
	await startServer(port);
	const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
	const page = await context.newPage();
	const pageErrors = [];
	page.on("pageerror", (err) => pageErrors.push(String(err?.message ?? err)));
	await page.addInitScript(() => localStorage.setItem("pi-web-ui:lang", "zh"));

	// WS 代理：injectLoop 非空时把它写进每份快照的 conv.loop；loop_resume / loop_accept / loop_stop 在这里截下不转发。
	let injectLoop = null;
	let toServer = null;
	const intercepted = [];
	await page.routeWebSocket(
		(url) => url.pathname === "/ws",
		(ws) => {
			const srv = ws.connectToServer();
			toServer = srv;
			ws.onMessage((message) => {
				if (typeof message === "string") {
					try {
						const m = JSON.parse(message);
						if (m && /^loop_(resume|accept|stop)$/.test(m.type)) {
							intercepted.push(m);
							return;
						}
					} catch {
						/* not JSON */
					}
				}
				srv.send(message);
			});
			srv.onMessage((message) => {
				if (injectLoop && typeof message === "string" && message.includes('"snapshot')) {
					try {
						const m = JSON.parse(message);
						if ((m.type === "snapshot" || m.type === "snapshot_delta") && m.state && typeof m.state === "object") {
							m.state.loop = injectLoop;
							ws.send(JSON.stringify(m));
							return;
						}
					} catch {
						/* pass through */
					}
				}
				ws.send(message);
			});
		},
	);

	await page.goto(`http://localhost:${port}`);
	await page.waitForSelector(".goalbar-collapsed", { timeout: 20000 });
	await page.waitForSelector(".boot-wait", { state: "detached", timeout: 20000 }).catch(() => {});
	await sleep(800);
	check("idle: no LoopBar status line yet", (await page.locator(".loopbar-status").count()) === 0);

	// ---- 任务台：三行都在，人话状态 ----
	await page.locator(".task-desk-chip").first().click();
	await page.waitForSelector(".task-desk .task-desk-run", { timeout: 10000 });
	await page.waitForFunction(() => document.querySelectorAll(".task-desk .task-desk-run").length >= 3, null, {
		timeout: 10000,
	});
	const row = (id) => page.locator(`.task-desk-run[data-run-id="${id}"]`);
	check("task desk lists the seeded runs", (await page.locator(".task-desk-run").count()) === 3);
	const okStatus = await text(row(RUN_OK).locator(".task-desk-run-status"));
	const errStatus = await text(row(RUN_ERR).locator(".task-desk-run-status"));
	check("passed run row: 交卷了 · 查看成果", okStatus === "交卷了 · 查看成果", okStatus);
	check("reviewer-error run row: 裁判掉线了 · 等待重试", errStatus === "裁判掉线了 · 等待重试", errStatus);
	check("user-stop run row: 已停止", (await text(row(RUN_GONE).locator(".task-desk-run-status"))) === "已停止");
	check(
		"LLM loop history section kept",
		(await page.locator(".task-desk-sec", { hasText: "LLM loop 历史" }).count()) === 1,
	);
	await shot(page, "taskdesk");

	// ---- 详情：交卷了 ----
	await row(RUN_OK).click();
	await page.waitForSelector(".run-detail .run-detail-status", { timeout: 8000 });
	const okHead = await text(page.locator(".run-detail .run-detail-status"));
	check("passed detail header: 交卷了 · 查看成果", okHead === "交卷了 · 查看成果", okHead);
	const okLines = await lines(page);
	check(
		"passed detail lines: 代码验证：通过 / 模型评审：通过",
		okLines.join("|") === "代码验证：通过|模型评审：通过",
		okLines.join("|"),
	);
	const okModal = page.locator(".run-detail");
	check("passed detail shows goal + criteria", (await okModal.innerText()).includes("result.txt 存在且内容为 DONE"));
	check(
		"passed detail shows review reasons",
		(await text(okModal.locator(".run-detail-reasons"))).includes("与目标一致"),
	);
	const rounds = (await okModal.locator(".run-detail-round > summary").allInnerTexts()).map((s) => s.trim());
	check(
		"passed detail rounds: 第 1 轮 · 未通过（exit 1） / 第 2 轮 · 通过",
		rounds.join("|") === "第 1 轮 · 未通过（exit 1）|第 2 轮 · 通过",
		rounds.join("|"),
	);
	check(
		"latest round open with review report + validator log",
		(await okModal.locator(".run-detail-round[open] pre").count()) >= 2 &&
			(await okModal.locator(".run-detail-round[open]").innerText()).includes("round-2-1761825960000.log"),
	);
	check(
		"validator output block present",
		(await text(okModal.locator(".run-detail-validator"))).includes("PASS: result.txt == DONE"),
	);
	check(
		"diff block present (+DONE)",
		(await okModal.locator(".run-detail-diff .add", { hasText: "+DONE" }).count()) === 1,
	);
	check("journal timeline present", (await okModal.locator(".run-detail-journal li").count()) === 6);
	const foot = await text(okModal.locator(".run-detail-foot"));
	check(
		"models / project / branch line",
		foot.includes("执行 glm-4.6") &&
			foot.includes("评审 qwen3") &&
			foot.includes(`分支 mini-harness/${RUN_OK} · 已提交`),
		foot,
	);
	const okActs = (await okModal.locator(".run-detail-acts button").allInnerTexts()).map((s) => s.trim());
	check(
		"done run (not this conversation): only 重新开始 + 关闭",
		okActs.join("|") === "用同一目标重新开始|关闭",
		okActs.join("|"),
	);
	await shot(page, "passed");

	// Escape 先关详情，任务台还开着
	await page.keyboard.press("Escape");
	await page.waitForSelector(".run-detail", { state: "detached", timeout: 5000 });
	check("Escape closes the detail panel, task desk stays", (await page.locator(".task-desk").count()) === 1);

	// ---- 详情：裁判掉线了（不是当前对话发起的） ----
	await row(RUN_ERR).click();
	await page.waitForSelector(".run-detail .run-detail-status", { timeout: 8000 });
	const errHead = await text(page.locator(".run-detail .run-detail-status"));
	check("reviewer-error detail header: 裁判掉线了 · 等待重试", errHead === "裁判掉线了 · 等待重试", errHead);
	const errLines = await lines(page);
	check(
		"reviewer-error lines: 代码验证：通过 / 模型评审：掉线（出错）",
		errLines.join("|") === "代码验证：通过|模型评审：掉线（出错）",
		errLines.join("|"),
	);
	const errModal = page.locator(".run-detail");
	check(
		"error reasons listed under 出错原因",
		(await errModal.innerText()).includes("出错原因") &&
			(await text(errModal.locator(".run-detail-reasons"))).includes("reviewer 请求超时"),
	);
	check(
		"validator output block (42 passed)",
		(await text(errModal.locator(".run-detail-validator"))).includes("42 passed"),
	);
	check("diff block (+\treturn a + b;)", (await errModal.locator(".run-detail-diff .add").count()) === 1);
	check(
		"not this conversation: hint instead of 重试评审 / 按代码验证收下",
		(await text(errModal.locator(".run-detail-hint"))).includes("不是当前对话发起的") &&
			(await errModal.getByRole("button", { name: "重试评审" }).count()) === 0 &&
			(await errModal.getByRole("button", { name: "按代码验证收下" }).count()) === 0,
	);
	await shot(page, "reviewer-error");
	await page.keyboard.press("Escape");
	await page.waitForSelector(".run-detail", { state: "detached", timeout: 5000 });

	// ---- 详情：记录已被删掉（404）→ 友好空状态 ----
	rmSync(join(RUNS, RUN_GONE), { recursive: true, force: true });
	await row(RUN_GONE).click();
	await page.waitForSelector(".run-detail .run-detail-missing", { timeout: 8000 });
	check(
		"404: friendly empty state + only 关闭",
		(await text(page.locator(".run-detail .run-detail-missing"))).includes("找不到这个任务的记录") &&
			(await page.locator(".run-detail .run-detail-acts button").count()) === 1,
	);
	await page.keyboard.press("Escape");
	await page.waitForSelector(".run-detail", { state: "detached", timeout: 5000 });
	await page.keyboard.press("Escape");
	await page.waitForSelector(".task-desk", { state: "detached", timeout: 5000 });
	check("second Escape closes the task desk", (await page.locator(".task-desk").count()) === 0);

	// ---- 本对话的评审掉线 run：注入快照 conv.loop，LoopBar 终态行 + 详情动作 ----
	injectLoop = {
		kind: "run",
		taskId: ERR_STATE.taskId,
		goal: ERR_STATE.goal,
		runId: RUN_ERR,
		mode: "code",
		stage: "review-error",
		round: 1,
		maxRounds: 5,
		status: "stopped",
		stopReason: "reviewer-error",
		lastVerdict: "pass",
		acceptance: null,
		review: { verdict: "error", reasons: ["reviewer 请求超时（60s 无响应）"] },
		reviewerEnabled: true,
		setupPending: false,
		criteria: ERR_STATE.criteria,
		createdAt: ERR_STATE.createdAt,
	};
	toServer?.send(JSON.stringify({ type: "get_state" }));
	await page.waitForSelector(".loopbar-status", { timeout: 8000 });
	const barText = await text(page.locator(".loopbar-status"));
	check("LoopBar terminal line: ⚠ 裁判掉线了 · 等待重试", barText === "⚠ 裁判掉线了 · 等待重试", barText);
	const bar = page.locator(".goalbar", { has: page.locator(".loopbar-status") });
	const barBtns = (await bar.locator(".goalbar-btn").allInnerTexts()).map((s) => s.trim());
	check(
		"LoopBar actions: 重试评审 + 按代码验证收下 (no 重试)",
		barBtns.join("|") === "重试评审|按代码验证收下",
		barBtns.join("|"),
	);
	await shot(page, "loopbar");
	await shot(page, "loopbar-crop", bar);

	await page.locator(".loopbar-status").click();
	await page.waitForSelector(".run-detail .run-detail-status", { timeout: 8000 });
	const ownModal = page.locator(".run-detail");
	const ownActs = (await ownModal.locator(".run-detail-acts button").allInnerTexts()).map((s) => s.trim());
	check(
		"own run detail: 重试评审 / 按代码验证收下 / 重新开始 / 关闭, no hint",
		ownActs.join("|") === "重试评审|按代码验证收下|用同一目标重新开始|关闭" &&
			(await ownModal.locator(".run-detail-hint").count()) === 0,
		ownActs.join("|"),
	);
	check("loop capsules hidden while the detail panel is open", (await page.locator(".loop-capsule").count()) === 0);
	await shot(page, "reviewer-error-owned");
	await ownModal.getByRole("button", { name: "重试评审" }).click();
	await ownModal.getByRole("button", { name: "按代码验证收下" }).click();
	await page.keyboard.press("Escape");
	await page.waitForSelector(".run-detail", { state: "detached", timeout: 5000 });
	await bar.getByRole("button", { name: "重试评审" }).click();
	await sleep(300);
	const sentTypes = intercepted.map((m) => `${m.type}:${m.runId}`);
	check(
		"buttons send loop_resume / loop_accept with the runId (intercepted, never reached the server)",
		sentTypes.join("|") === `loop_resume:${RUN_ERR}|loop_accept:${RUN_ERR}|loop_resume:${RUN_ERR}`,
		sentTypes.join("|"),
	);
	check("capsule back after closing the panel", (await page.locator(".loop-capsule").count()) === 1);

	check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
	await browser.close();
	cleanup();
	console.log(failures === 0 ? "PASS run-detail-ui-test" : `FAIL run-detail-ui-test (${failures})`);
	process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
	console.error("run-detail-ui-test crashed:", err);
	cleanup();
	process.exit(1);
});
