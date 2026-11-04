/**
 * Zero-model browser regression for the production TaskModal/discover path.
 * Isolated data/agent/workspace/runtime, authenticated server, owned PID only.
 * Build once before running: npm run build && node tests/loop-recovery-ui-test.mjs
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "harness-recovery-ui-"));
const dirs = Object.fromEntries(
	["data", "agent", "workspace", "runs"].map((name) => {
		const dir = path.join(evidence, name);
		fs.mkdirSync(dir);
		return [name, dir];
	}),
);
const probe = net.createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
assert.ok(port >= 8900);
await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
const token = crypto.randomBytes(24).toString("hex");
const base = `http://127.0.0.1:${port}`;
const log = fs.openSync(path.join(evidence, "server.log"), "w", 0o600);
let server;
let browser;
let page;
const checks = [];
const errors = [];
try {
	assert.ok(CHROME_PATH, "Chrome unavailable; set PI_WEB_CHROME");
	const entry = process.argv.includes("--source")
		? ["--import", "tsx", "server/index.ts", "--no-browser"]
		: ["dist/server/index.js", "--no-browser"];
	server = spawn(process.execPath, entry, {
		cwd: project,
		env: {
			PATH: process.env.PATH,
			TMPDIR: process.env.TMPDIR,
			LANG: process.env.LANG || "en_US.UTF-8",
			HARNESS_HOST: "127.0.0.1",
			HARNESS_PORT: String(port),
			HARNESS_DATA_DIR: dirs.data,
			HARNESS_AGENT_DIR: dirs.agent,
			HARNESS_CWD: dirs.workspace,
			HARNESS_TOKEN: token,
			HARNESS_SDK: "bundled",
			PI_WEB_MANAGED: "1",
			MINI_HARNESS_RUNTIME_ROOT: dirs.runs,
		},
		stdio: ["ignore", log, log],
	});
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}`);
		try {
			const response = await fetch(`${base}/api/mini-harness/packs`, {
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(1000),
			});
			if (response.ok) {
				ready = true;
				break;
			}
		} catch {
			// Wait only for this test's server to become ready.
		}
		await pause(200);
	}
	assert.ok(ready, "isolated server failed to become ready");
	for (const endpoint of ["discover", "runs/unauthenticated-probe/recover", "runs/unauthenticated-probe/stop"]) {
		const unauthorized = await fetch(`${base}/api/mini-harness/${endpoint}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
			signal: AbortSignal.timeout(3000),
		});
		assert.equal(unauthorized.status, 401, `${endpoint} must require authentication`);
	}
	checks.push("Production discover/recover/stop reject unauthenticated HTTP requests");
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
	page.on("pageerror", (error) => errors.push(error.message));
	await page.addInitScript(() => {
		localStorage.setItem("pi-web-ui:lang", "zh");
		localStorage.setItem("pi_web_setup_dismissed", "1");
	});
	await page.goto(`${base}/?token=${token}`);
	await page.waitForFunction(() => document.body.textContent?.includes("API 已连接"));
	await page.locator(".loop-capsule.task").click({ timeout: 30000 });
	await page.locator('input[name="task-accept"][value="code"]').check();
	await page.locator("#task-pack").selectOption("cache-loss");
	await page.locator("#task-workspace").fill(dirs.workspace);
	await page.locator("details.cockpit-adv summary").click();
	const command = "printf 'HARNESS_METRIC.loss_pct=0.10\\n'\\ ";
	const discoveryResponse = page.waitForResponse((response) => {
		if (new URL(response.url()).pathname !== "/api/mini-harness/discover") return false;
		return response.request().postDataJSON()?.validateCmd === command;
	});
	await page.locator("#task-cmd").fill(command);
	const response = await discoveryResponse;
	assert.equal(response.status(), 200);
	const body = await response.json();
	assert.equal(body.context.normalizedInputs.validateCmd, command);
	assert.ok(!body.context.missing.some((entry) => entry.id === "validateCmd"));
	checks.push("TaskModal sends original top-level command; production discover satisfies its missing field");
	const replacement = "printf 'HARNESS_METRIC.loss_pct=0.09\\n'";
	const updated = page.waitForResponse(
		(result) =>
			new URL(result.url()).pathname === "/api/mini-harness/discover" &&
			result.request().postDataJSON()?.validateCmd === replacement,
	);
	await page.locator("#task-cmd").fill(replacement);
	assert.equal((await (await updated).json()).context.normalizedInputs.validateCmd, replacement);
	checks.push("Editing command recomputes preview with the new input");
	const conflict = await page.evaluate(
		async ({ workspace }) => {
			const result = await fetch("/api/mini-harness/discover", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					packId: "cache-loss",
					workspace,
					validateCmd: "printf one",
					inputs: { validateCmd: "printf two" },
				}),
			});
			return { status: result.status, body: await result.json() };
		},
		{ workspace: dirs.workspace },
	);
	assert.equal(conflict.status, 400);
	checks.push("Authenticated production HTTP rejects conflicting explicit commands");
	await page.screenshot({ path: path.join(evidence, "task-discovery.png"), fullPage: true });
	await page.keyboard.press("Escape");
	await page.locator(".loop-capsule.task").waitFor();
	assert.deepEqual(errors, []);
	checks.push("Modal closes normally; browser has no uncaught page errors");
	console.log(`PASS ${checks.length} browser checks; evidence: ${evidence}`);
} catch (error) {
	process.exitCode = 1;
	console.error(error);
	console.error(`Evidence: ${evidence}`);
	if (page) {
		await page.screenshot({ path: path.join(evidence, "failure.png"), fullPage: true }).catch(() => {});
		fs.writeFileSync(path.join(evidence, "failure.html"), await page.content());
	}
} finally {
	await browser?.close();
	if (server && server.exitCode === null) {
		const exited = once(server, "exit");
		server.kill("SIGTERM");
		const escalation = setTimeout(() => server.exitCode === null && server.kill("SIGKILL"), 5000);
		await exited;
		clearTimeout(escalation);
	}
	fs.closeSync(log);
	fs.writeFileSync(
		path.join(evidence, "evidence.json"),
		JSON.stringify({ port, serverPid: server?.pid, checks, errors, passed: !process.exitCode }, null, 2) + "\n",
	);
}
