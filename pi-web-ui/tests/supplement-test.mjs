/**
 * 排队（followUp）按钮 test：智能体回复期间，输入 + 点「排队」（运行中发送位那颗
 * 对半胶囊的左半）把消息加队列；本轮回复一结束它立刻出现在聊天里，智能体随后回答。
 * 同时覆盖对半胶囊的两个状态：无输入时两半禁用（胶囊变暗），输入后解锁可点。
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp, freePort } from "./lib/port-utils.mjs";
import { ensureBuild } from "./lib/ensure-build.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
// fileURLToPath: URL.pathname 在 Windows 下是 /E:/... 形式，直接当 cwd 会失败
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const HEADLESS = CHROME_PATH;
const PORT = 8899;
const URL = `http://localhost:${PORT}`;
const PROJ = REPO_ROOT;

const dataDir = mkdtempSync(join(tmpdir(), "pi-supp-data-"));
const agentDir = mkdtempSync(join(tmpdir(), "pi-supp-agent-"));
const WS = mkdtempSync(join(tmpdir(), "pi-supp-"));
writeFileSync(join(WS, "a.txt"), "a");

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

try {
	ensureBuild(PROJ, "supplement-test");
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}
try {
	await freePort(PORT);
} catch {
	/* port free */
}
await sleep(500);
const server = spawn("node", ["dist/server/index.js"], {
	cwd: PROJ,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_CWD: WS,
	},
	stdio: "ignore",
});
for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);
if (!(await portUp(PORT))) {
	console.error("server failed to start");
	process.exit(1);
}

const browser = await chromium.launch({ executablePath: HEADLESS });
const page = await browser.newPage();
await page.goto(URL);
await page.waitForSelector("textarea", { timeout: 15000 });
await sleep(800);

// --- 1. send the first prompt; wait for streaming (stop button) ---
await page.locator("textarea").fill("只回复两个字：好的");
await page.keyboard.press("Enter");
await page
	.waitForSelector(".btn.stop", { timeout: 60000 })
	.then(() => check("first reply streaming", true))
	.catch(() => check("first reply streaming", false, "no stop button"));

// --- 2. 流式中发送位 = 「排队|插队」对半胶囊；空输入时两半禁用，输入后解锁 ---
const pill = page.locator(".split-send");
const queueBtn = page.locator(".split-send .split-queue");
const steerBtn = page.locator(".split-send .split-steer");
check("对半胶囊在流式中出现", (await pill.count()) === 1, `count=${await pill.count()}`);
check("空输入时两半禁用（胶囊 .disabled）", (await queueBtn.isDisabled()) && (await steerBtn.isDisabled()));
await page.locator("textarea").fill("补充一句话：请再说一遍");
await sleep(400);
check("输入后两半解锁", (await queueBtn.isEnabled()) && (await steerBtn.isEnabled()));

// --- 3. 点左半（排队）→ 输入框清空 + 队列提示出现 ---
await queueBtn.click();
await sleep(600);
check("input cleared after 排队", (await page.locator("textarea").inputValue()) === "");
const hint = await page
	.locator(".queue-hint")
	.allTextContents()
	.catch(() => []);
check(
	"queue hint shows queued follow-up",
	hint.some((h) => h.includes("跟进消息排队中") || h.includes("queued")),
	hint.join(" | "),
);

// --- 4. wait for the first reply to finish, then the queued message fires ---
await page
	.waitForSelector(".btn.stop", { state: "detached", timeout: 120000 })
	.then(() => check("first reply finished", true))
	.catch(() => check("first reply finished", false, "still streaming"));

// The queued message delivers immediately after; its user message should
// appear in the chat, then a second reply streams.
const supplementSeen = await page
	.waitForFunction(() => document.body.innerText.includes("补充一句话：请再说一遍"), { timeout: 180000 })
	.then(() => true)
	.catch(() => false);
check("queued message delivered right after reply", supplementSeen);
// The second assistant reply must follow the queued message (count is
// race-free even when the reply is fast).
const secondReply = await page
	.waitForFunction(() => document.querySelectorAll('.msg[data-role="assistant"]').length >= 2, { timeout: 90000 })
	.then(() => true)
	.catch(() => false);
check("agent answered the queued message", secondReply);

await browser.close();
server.kill("SIGKILL");
try {
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(WS, { recursive: true, force: true });
} catch {}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
