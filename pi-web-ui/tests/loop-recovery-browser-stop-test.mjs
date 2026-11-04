/**
 * Run with --source. Never builds; uses the existing web/dist bundle.
 * A is the deterministic loop-core-host adapter (no real model/session transport).
 * B is the unmodified, complete server/index.ts with real HTTP and browser UI.
 * Recovery must use the UI's loop_resume WebSocket message; stop must use the
 * UI's real HTTP request. Missing controls fail, without a fetch fallback.
 * --pending-stop pauses only this test's recorded runner to exercise HTTP 202.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fork, spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

assert.ok(process.argv.includes("--source"), "Only --source is supported; no build is performed");
const project = fileURLToPath(new URL("../", import.meta.url));
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "harness-browser-stop-"));
const dirs = Object.fromEntries(
	["data", "agent", "workspace", "runtime", "screenshots"].map((name) => {
		const dir = path.join(evidence, name);
		fs.mkdirSync(dir);
		return [name, dir];
	}),
);
const token = crypto.randomBytes(24).toString("hex");
const nonce = crypto.randomUUID();
const counter = path.join(evidence, "starts.jsonl");
const quote = (text) => "'" + text.replace(/'/g, "'\\''") + "'";
// Explicit allowlist: do not inherit HOME, provider keys, proxy or SDK settings.
const env = {
	PATH: process.env.PATH,
	TMPDIR: process.env.TMPDIR,
	LANG: "en_US.UTF-8",
	MINI_HARNESS_RUNTIME_ROOT: dirs.runtime,
	PI_WEB_DATA_DIR: dirs.data,
	PI_CODING_AGENT_DIR: dirs.agent,
	PI_CODING_AGENT_SESSION_DIR: path.join(dirs.agent, "sessions"),
	HARNESS_CWD: dirs.workspace,
	PI_WEB_CWD: dirs.workspace,
	HARNESS_SDK: "bundled",
	PI_WEB_SDK: "bundled",
};
const report = {
	boundaries: ["Host A uses the existing deterministic model/session adapter; B is complete server/index.ts"],
	checks: [],
	defects: [],
	requests: [],
	responses: [],
	dialogs: [],
	websocket: [],
	pageErrors: [],
	cleanup: [],
	nonce,
	evidence,
	dirs,
	environmentKeys: Object.keys(env),
};
let a;
let b;
let browser;
let page;
let runId;
let base;
let original;
let start;
let pausedRunner;
let acceptDialog = true;
const logFds = [];
const writeJson = (name, value) =>
	fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const check = (label) => {
	report.checks.push(label);
	console.log(`PASS ${label}`);
};
async function until(read, label, timeout = 20000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await read();
		if (value) return value;
		await pause(100);
	}
	throw new Error(`Timed out: ${label}`);
}
function alive(pid) {
	try {
		const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
		return !!stat && !stat.startsWith("Z");
	} catch {
		return false;
	}
}
function identity(pid) {
	try {
		return execFileSync("ps", ["-o", "lstart=,command=", "-p", String(pid)], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}
const owned = new Map();
function remember(pid) {
	assert.ok(Number.isSafeInteger(pid) && pid > 1);
	const value = identity(pid);
	assert.ok(value, `Missing process identity: ${pid}`);
	owned.set(pid, value);
}
async function killHost(child, signal = "SIGTERM") {
	if (!child || child.exitCode !== null || child.signalCode) return;
	const exited = once(child, "exit");
	child.kill(signal);
	const escalation = setTimeout(() => {
		if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
	}, 5000);
	await exited;
	clearTimeout(escalation);
}
function log(name) {
	const fd = fs.openSync(path.join(evidence, name), "w", 0o600);
	logFds.push(fd);
	return fd;
}
async function http(action, method = "GET") {
	const response = await fetch(`${base}/api/mini-harness/runs/${runId}/${action}`, {
		method,
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(15000),
	});
	return { status: response.status, body: await response.json() };
}
async function browserPost(action) {
	return page.evaluate(async (url) => {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		return { status: response.status, body: await response.json() };
	}, `/api/mini-harness/runs/${runId}/${action}`);
}
async function screenshot(name) {
	await page.screenshot({ path: path.join(dirs.screenshots, `${name}.png`), fullPage: true });
}
async function uiAction(action, name) {
	const button = page.locator(".run-detail").getByRole("button", { name });
	await button.first().waitFor();
	assert.ok(await button.first().isEnabled(), `${action} button must be enabled`);
	if (action === "recover") {
		await button.first().click();
		await until(
			() => report.websocket.some((message) => message.type === "loop_resume" && message.runId === runId),
			"UI sends loop_resume via WebSocket",
		);
		await screenshot("recover-requested");
		return {
			via: "UI WebSocket",
			detail: await until(async () => {
				const response = await http("detail");
				return response.body.generation > original.state.generation ? response.body : false;
			}, "backend accepts recovery and advances generation"),
		};
	}
	{
		const response = page.waitForResponse(
			(r) => new URL(r.url()).pathname.endsWith(`/${runId}/${action}`) && r.request().method() === "POST",
			{ timeout: 20000 },
		);
		await button.first().click();
		await screenshot(`${action}-requested`);
		if (action === "stop") {
			const state = readJson(path.join(dirs.runtime, runId, "state.json"));
			const text = await page.locator(".run-detail-status").innerText();
			report.stopRequestUi = {
				text,
				stopRequestedAt: state.stopRequestedAt ?? null,
				stopConfirmedAt: state.stopConfirmedAt ?? null,
			};
			if (!state.stopConfirmedAt) assert.ok(!/^已停止/.test(text), "UI claimed stopped before confirmation");
		}
		const result = await response;
		return { status: result.status(), body: await result.json(), via: "UI click" };
	}
}

try {
	assert.ok(CHROME_PATH, "Chrome unavailable; set PI_WEB_CHROME");
	const index = path.join(project, "web/dist/index.html");
	report.webBuild = {
		mtime: fs.statSync(index).mtime.toISOString(),
		sha256: crypto.createHash("sha256").update(fs.readFileSync(index)).digest("hex"),
	};
	const fd = log("host-a.log");
	a = fork(path.join(project, "tests/fixtures/loop-core-host.ts"), [], {
		cwd: project,
		execArgv: ["--import", "tsx"],
		env: { ...env, FIXTURE_WORKSPACE: dirs.workspace, FIXTURE_DATA: dirs.data, FIXTURE_TOKEN: token },
		stdio: ["ignore", fd, fd, "ipc"],
	});
	report.hostA = { pid: a.pid };
	let ready;
	const pending = new Map();
	a.on("message", (message) => {
		if (message.ready) ready = message;
		const waiter = pending.get(message.id);
		if (waiter) {
			pending.delete(message.id);
			if (message.error) waiter.reject(new Error(message.error));
			else waiter.resolve(message.result);
		}
	});
	const rpc = (action, args = {}) =>
		new Promise((resolve, reject) => {
			const id = crypto.randomUUID();
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`Host A RPC timeout: ${action}`));
			}, 20000);
			pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			a.send({ id, action, ...args });
		});
	await until(() => ready, "fixture A ready");
	assert.ok(ready.port >= 8900);
	report.hostA.port = ready.port;
	// Real parent and child both resist TERM, exercising production group KILL.
	// A hard deadline prevents indefinite leftovers even on a harness crash.
	const childCode = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);setTimeout(()=>process.exit(2),180000)";
	const program = `
		const fs=require("node:fs"), cp=require("node:child_process");
		process.on("SIGTERM",()=>{});
		const child=cp.spawn(process.execPath,["-e",${JSON.stringify(childCode)}],{stdio:"ignore"});
		fs.appendFileSync(${JSON.stringify(counter)},JSON.stringify({pid:process.pid,child:child.pid,nonce:${JSON.stringify(nonce)}})+"\\n");
		setInterval(()=>{},1000);
		setTimeout(()=>{child.kill("SIGKILL");process.exit(2)},180000);
	`;
	const created = await rpc("start", { command: `${quote(process.execPath)} -e ${quote(program)}` });
	assert.equal(created.ok, true);
	runId = created.runId;
	report.runId = runId;
	start = await until(() => {
		if (!fs.existsSync(counter)) return;
		try {
			return JSON.parse(fs.readFileSync(counter, "utf8").trim());
		} catch {
			return;
		}
	}, "real validator parent/child startup");
	assert.equal(start.nonce, nonce);
	remember(start.pid);
	remember(start.child);
	original = await rpc("inspect", { runId });
	assert.equal(original.operations.length, 1);
	for (const entity of [original.operations[0].runner, original.operations[0].entity]) {
		if (entity?.pid) remember(entity.pid);
	}
	writeJson("original.json", original);
	// The deterministic A adapter has no SDK session transport. Seed its
	// original session header/message so full B can restore that exact identity.
	const sessionDir = env.PI_CODING_AGENT_SESSION_DIR;
	fs.mkdirSync(sessionDir, { recursive: true });
	const timestamp = new Date().toISOString();
	const sessionFile = path.join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${original.state.sessionId}.jsonl`);
	fs.writeFileSync(
		sessionFile,
		[
			{ type: "session", version: 3, id: original.state.sessionId, timestamp, cwd: original.state.workspace },
			{
				type: "message",
				id: "fixture-user",
				parentId: null,
				timestamp,
				message: { role: "user", content: [{ type: "text", text: "restart acceptance" }], timestamp: Date.now() },
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n") + "\n",
		{ mode: 0o600 },
	);
	report.boundaries.push(
		"A's original SDK-compatible session header/user message is seeded; B restores it without a model call",
	);
	report.sessionFile = sessionFile;
	report.processes = { ...start, identities: Object.fromEntries(owned) };
	check("Host A production createLoopRun/extension starts exactly one real parent/child command");
	await killHost(a, "SIGKILL");
	assert.equal(a.signalCode, "SIGKILL");
	assert.ok(alive(start.pid) && alive(start.child));
	check("SIGKILL A leaves original parent and child running");

	const probe = net.createServer();
	probe.listen(0, "127.0.0.1");
	await once(probe, "listening");
	const port = probe.address().port;
	assert.ok(port >= 8900);
	await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
	base = `http://127.0.0.1:${port}`;
	const bLog = log("server-b.log");
	b = spawn(process.execPath, ["--import", "tsx", "server/index.ts", "--no-browser"], {
		cwd: project,
		env: {
			...env,
			HARNESS_HOST: "127.0.0.1",
			HARNESS_PORT: String(port),
			HARNESS_DATA_DIR: dirs.data,
			HARNESS_AGENT_DIR: dirs.agent,
			HARNESS_CWD: dirs.workspace,
			HARNESS_TOKEN: token,
			HARNESS_SDK: "bundled",
			PI_WEB_MANAGED: "1",
		},
		stdio: ["ignore", bLog, bLog],
	});
	report.hostB = { pid: b.pid, port, entry: "server/index.ts --import tsx" };
	await until(
		async () => {
			assert.ok(b.exitCode === null && !b.signalCode, "Full server B exited");
			try {
				return (await http("detail")).status === 200;
			} catch {
				return false;
			}
		},
		"full server B HTTP ready",
		30000,
	);
	const unauthorized = await fetch(`${base}/api/mini-harness/runs/${runId}/detail`);
	assert.equal(unauthorized.status, 401);
	report.before = await http("detail");
	assert.equal(report.before.body.runId, runId);
	assert.equal(report.before.body.status, "active");
	check("Full authenticated server B reads the same persisted run");

	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, env });
	page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
	page.on("websocket", (socket) => {
		socket.on("framesent", ({ payload }) => {
			try {
				const message = JSON.parse(String(payload));
				if (message.type === "loop_resume" || message.type === "loop_stop") report.websocket.push(message);
			} catch {}
		});
		socket.on("framereceived", ({ payload }) => {
			try {
				const message = JSON.parse(String(payload));
				if (message.type === "notice") report.websocket.push(message);
			} catch {}
		});
	});
	await page.route("**/*", (route) => {
		const url = new URL(route.request().url());
		if (url.origin === base) return route.continue();
		// Never contact model providers or load external services during this test.
		return route.abort();
	});
	page.on("pageerror", (error) => report.pageErrors.push(error.message));
	page.on("console", (message) => {
		fs.appendFileSync(path.join(evidence, "browser.log"), `[${message.type()}] ${message.text()}\n`);
	});
	page.on("dialog", async (dialog) => {
		report.dialogs.push({ type: dialog.type(), message: dialog.message(), accepted: acceptDialog });
		if (acceptDialog) await dialog.accept();
		else await dialog.dismiss();
	});
	page.on("request", (request) => {
		const pathname = new URL(request.url()).pathname;
		if (pathname.includes("/api/mini-harness/")) {
			report.requests.push({
				at: new Date().toISOString(),
				method: request.method(),
				pathname,
				body: request.postData(),
			});
		}
	});
	page.on("response", async (response) => {
		const pathname = new URL(response.url()).pathname;
		if (pathname.includes(`/runs/${runId}/`)) {
			report.responses.push({ at: new Date().toISOString(), pathname, status: response.status() });
		}
	});
	await page.addInitScript(() => {
		localStorage.setItem("pi-web-ui:lang", "zh");
		localStorage.setItem("pi_web_setup_dismissed", "1");
	});
	await page.goto(`${base}/?token=${token}`);
	await page.waitForLoadState("networkidle");
	await page.locator(".task-desk-chip").click({ timeout: 30000 });
	const row = page.locator(`[data-run-id="${runId}"]`);
	await row.waitFor();
	assert.match(await row.innerText(), /restart acceptance/);
	await screenshot("task-desk-before");
	await row.click();
	await page.locator(".run-detail .run-detail-text").first().waitFor();
	await screenshot("detail-before");
	check("Real browser task desk opens the persisted run detail");

	report.recovered = await uiAction("recover", /恢复|核对|recover/i);
	// Restoring the original session may close cockpit panels via the normal
	// workspace transition. Reopen through the actual task desk if necessary.
	if (!(await page.locator(".run-detail").isVisible())) {
		if (!(await row.isVisible())) await page.locator(".task-desk-chip").click();
		await row.click();
		await page.locator(".run-detail .run-detail-text").first().waitFor();
	}
	report.afterRecovery = await http("detail");
	assert.equal(report.afterRecovery.body.attemptId, original.state.attemptId);
	assert.ok(report.afterRecovery.body.generation > original.state.generation);
	assert.ok(alive(start.pid) && alive(start.child));
	check("Recovery retains original operation and attempt, advances generation, and does not rerun");
	await screenshot("detail-recovered");

	const stopRequests = () =>
		report.requests.filter((request) => request.method === "POST" && request.pathname.endsWith(`/${runId}/stop`))
			.length;
	const beforeCancel = stopRequests();
	acceptDialog = false;
	await page.locator(".run-detail").getByRole("button", { name: "停止", exact: true }).click();
	assert.equal(report.dialogs.at(-1)?.accepted, false);
	assert.equal(stopRequests(), beforeCancel);
	assert.ok(alive(start.pid) && alive(start.child));
	acceptDialog = true;
	check("Dismissing the stop confirmation sends no request and leaves original processes alive");
	const detailReads = () =>
		report.requests.filter((request) => request.method === "GET" && request.pathname.endsWith(`/${runId}/detail`))
			.length;
	const readsBeforeStop = detailReads();
	if (process.argv.includes("--pending-stop")) {
		pausedRunner = original.operations[0].runner.pid;
		assert.equal(identity(pausedRunner), owned.get(pausedRunner));
		process.kill(pausedRunner, "SIGSTOP");
		report.boundaries.push("HTTP 202 scenario pauses only the owned durable runner; command parent/child stay alive");
	}
	report.stop = await uiAction("stop", /^停止$|请求停止|确认停止|stop/i);
	if (process.argv.includes("--pending-stop")) assert.equal(report.stop.status, 202);
	assert.ok([200, 202].includes(report.stop.status), JSON.stringify(report.stop));
	assert.ok(report.stop.body.stopRequestedAt);
	if (report.stop.status === 200) assert.ok(report.stop.body.stopConfirmedAt);
	else {
		assert.ok(!report.stop.body.stopConfirmedAt);
		await until(
			async () => /已请求停止|退出尚未确认/.test(await page.locator(".run-detail").innerText()),
			"pending stop UI",
		);
		await screenshot("stop-pending");
		assert.ok(alive(start.pid) && alive(start.child), "Pending must not claim process exit");
		const pendingDetail = await http("detail");
		assert.ok(pendingDetail.body.stopRequestedAt && !pendingDetail.body.stopConfirmedAt);
		assert.equal(await page.locator(".run-detail-restart").count(), 0);
		await until(() => detailReads() >= readsBeforeStop + 2, "pending stop continues browser detail polling");
		check("HTTP 202 shows unconfirmed stop and keeps polling without offering restart");
		if (pausedRunner) {
			process.kill(pausedRunner, "SIGCONT");
			pausedRunner = undefined;
		}
	}
	// No test signal is sent before this assertion. Only production stop may kill.
	await until(() => !alive(start.pid) && !alive(start.child), "production stop kills original parent and child");
	const opDir = path.join(dirs.runtime, runId, "operations", original.operations[0].opId);
	const result = await until(
		() => fs.existsSync(path.join(opDir, "result.json")) && readJson(path.join(opDir, "result.json")),
		"durable runner result",
	);
	assert.equal(result.groupGone, true);
	assert.equal(result.killed, true);
	writeJson("runner-result.json", result);
	check("Actual stop API kills original TERM-resistant parent/child and persists groupGone");
	if (report.stop.status === 202) {
		report.stopRecheck = await uiAction("stop", /核对停止结果/);
		assert.equal(report.stopRecheck.status, 200);
	}
	report.final = await until(async () => {
		const detail = await http("detail");
		return detail.body.stopConfirmedAt ? detail : false;
	}, "confirmed stop persisted");
	assert.equal(report.final.body.status, "stopped");
	assert.ok(report.final.body.stopRequestedAt);
	assert.equal(report.final.body.history.length, 0);
	assert.equal(report.final.body.round, 1);
	assert.equal(report.final.body.acceptance, null);
	assert.equal(fs.readFileSync(counter, "utf8").trim().split("\n").length, 1);
	const persisted = readJson(path.join(dirs.runtime, runId, "state.json"));
	assert.equal(persisted.stopConfirmedAt, report.final.body.stopConfirmedAt);
	check("HTTP, persisted state and runner facts agree: stopped, no acceptance, no duplicate execution");
	await until(
		async () => /^已停止/.test(await page.locator(".run-detail-status").innerText()),
		"live detail refreshes to confirmed stop",
	);
	const validatorLabel = await page.locator(".run-detail-accept").innerText();
	report.finalAcceptanceUi = validatorLabel;
	assert.match(validatorLabel, /已启动后停止/);
	assert.equal(
		await page.locator("[data-stop-requested-at]").getAttribute("data-stop-requested-at"),
		persisted.stopRequestedAt,
	);
	assert.equal(
		await page.locator("[data-stop-confirmed-at]").getAttribute("data-stop-confirmed-at"),
		persisted.stopConfirmedAt,
	);
	if (report.stop.status === 200) {
		report.boundaries.push("Stop returned 200 with exit confirmation; HTTP 202 pending-state branch was not exercised");
	}
	await screenshot("detail-stopped-live");
	// Refresh the actual UI via normal navigation, never inject component state.
	await page.reload();
	await page.waitForLoadState("networkidle");
	await page.locator(".task-desk-chip").click({ timeout: 30000 });
	await row.waitFor();
	assert.match(await row.locator(".task-desk-run-status").innerText(), /已停止/);
	await screenshot("task-desk-stopped");
	await row.click();
	await until(
		async () => /已停止/.test(await page.locator(".run-detail-status").innerText()),
		"confirmed stopped detail",
	);
	await screenshot("detail-stopped");
	report.duplicateStop = await browserPost("stop");
	assert.equal(report.duplicateStop.status, 200);
	assert.equal(report.duplicateStop.body.stopConfirmedAt, report.final.body.stopConfirmedAt);
	assert.deepEqual(report.pageErrors, []);
	check("Browser task desk/detail show confirmed stop; duplicate HTTP stop is idempotent");
	report.backendPassed = true;
	report.passed = report.recovered.via === "UI WebSocket" && report.stop.via === "UI click";
	if (!report.passed) {
		process.exitCode = 1;
		console.error("INCOMPLETE UI chain: see evidence boundaries; backend chain passed");
	}
} catch (error) {
	process.exitCode = 1;
	report.passed = false;
	report.error = String(error.stack ?? error);
	console.error(error);
	if (page) {
		await screenshot("failure").catch(() => {});
		fs.writeFileSync(path.join(evidence, "failure.html"), await page.content().catch(() => ""));
	}
} finally {
	// Cleanup is explicitly outside the pass criteria; record every action.
	if (pausedRunner && identity(pausedRunner) === owned.get(pausedRunner)) process.kill(pausedRunner, "SIGCONT");
	if (b && base && runId && b.exitCode === null && !b.signalCode) {
		try {
			report.cleanup.push({ action: "production stop", result: await http("stop", "POST") });
		} catch (error) {
			report.cleanup.push({ error: String(error) });
		}
	}
	await browser?.close();
	await killHost(a);
	await killHost(b);
	for (const [pid, expected] of [...owned].reverse()) {
		if (alive(pid) && identity(pid) === expected) {
			process.kill(pid, "SIGKILL");
			report.cleanup.push({ action: "exact recorded identity SIGKILL fallback", pid });
		}
	}
	report.cleanupSurvivors = [...owned.keys()].filter(alive);
	if (report.cleanupSurvivors.length) {
		report.passed = false;
		process.exitCode = 1;
	}
	for (const fd of logFds) fs.closeSync(fd);
	writeJson("evidence.json", report);
	console.log(`Evidence: ${evidence}`);
}
