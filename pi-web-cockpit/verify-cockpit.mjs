#!/usr/bin/env node
/**
 * 驾驶舱浏览器 E2E 验证（Playwright，headless Chrome）：品牌 / 首次配置 / 状态栏 / Loop 胶囊 /
 * 代码 loop 弹窗 / 连接集群 / 任务台 / LLM loop 编辑器 / 对话 / PTY 终端 / Skills / 页面报错。
 *
 * 用法（服务需已启动，例如 pi-web-cockpit/start-hardened.sh）：
 *   node pi-web-cockpit/verify-cockpit.mjs
 * 环境变量：
 *   PORT=8787                    驾驶舱端口
 *   TOKEN_FILE=~/.pi-web/pi-web-token
 *   KEY_FILE=<auth.json 路径>     可选：出现首次配置弹窗时从这里取 oneapi 的 key 填入（只在本机读）
 *   SHOTS=<目录>                  可选：截图输出目录
 *   PI_WEB_CHROME=<chrome 路径>   可选：覆盖 Chrome 探测
 * 注意：对话一步会真实调用当前模型发一句话；PTY 一步会在新终端里 echo 一行。
 * 依赖 pi-web-ui 的 devDependencies（playwright-core），setup.sh 装好后即可用。
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = join(HERE, "..", "pi-web-ui");
const { chromium } = await import(
  pathToFileURL(join(UI, "node_modules/playwright-core/index.mjs")).href
);
const { CHROME_PATH } = await import(
  pathToFileURL(join(UI, "tests/lib/chrome.mjs")).href
);

const port = process.env.PORT || "8787";
const tokenFile =
  process.env.TOKEN_FILE || join(homedir(), ".pi-web", "pi-web-token");
const token = existsSync(tokenFile)
  ? readFileSync(tokenFile, "utf8").trim()
  : "";
const keyFile = process.env.KEY_FILE || "";
const shots = process.env.SHOTS || "";
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: join(shots, name) });
};

const results = [];
const ok = (name, pass, detail = "") =>
  results.push({ name, pass: !!pass, detail: String(detail).slice(0, 160) });
const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  headless: true,
});
const page = await (
  await browser.newContext({
    viewport: { width: 1280, height: 820 },
    locale: "zh-CN",
  })
).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    ok(name, false, e.message);
  }
};

await page.goto(
  `http://127.0.0.1:${port}/${token ? `?token=${encodeURIComponent(token)}` : ""}`,
  {
    waitUntil: "domcontentloaded",
  },
);
await page.waitForSelector(".inputbox", { timeout: 30000 });
await page.waitForTimeout(1500);

await step("branding", async () => {
  const title = await page.title();
  const icon = await page.$eval('link[rel="icon"]', (l) =>
    l.getAttribute("href"),
  );
  const brand = await page
    .$eval(".brand-name", (e) => e.textContent.trim())
    .catch(() => "");
  const logo = await page
    .$eval(".brand img, img.brand-logo, .brand-logo img", (i) => i.naturalWidth)
    .catch(() => 0);
  // 品牌名称和标题检查
  ok(
    "品牌：标题 / 品牌名",
    title === "训推引擎组 Harness" && brand.includes("训推引擎组 Harness"),
    `${title} | ${brand}`,
  );
  // 图标检查
  ok(
    "品牌：favicon 可取",
    icon === "/icons/icon-192.png?v=4" || icon === "/favicon.png?v=2",
    icon,
  );
  ok("品牌：左上角 logo 加载", logo > 0, `naturalWidth=${logo}`);
  const icons = await page.evaluate(async () =>
    Promise.all(
      ["/favicon.png", "/icons/icon-192.png"].map(async (u) =>
        (await fetch(u)).headers.get("content-type"),
      ),
    ),
  );
  ok(
    "品牌：favicon 与 PWA 图标可取",
    icons.every((c) => c === "image/png"),
    icons.join(","),
  );
});

await step("first-run", async () => {
  const dialog = await page
    .waitForSelector(".setup-modal", { timeout: 5000 })
    .catch(() => null);
  if (!dialog) {
    ok("首次配置：已配置过（未弹窗）", true);
    return;
  }
  const sel = await page.$eval(".setup-modal select", (s) => s.value);
  await shot(page, "1-setup.png");
  ok("首次配置：弹窗预选 oneapi", sel === "oneapi", sel);
  if (!keyFile) {
    ok("首次配置：未提供 KEY_FILE，跳过填 key（对话一步会失败）", false);
    return;
  }
  await page.fill(
    '.setup-modal input[type="password"]',
    JSON.parse(readFileSync(keyFile, "utf8")).oneapi.key,
  );
  await page.click(".setup-modal .btn.primary");
  await page.waitForSelector(".setup-modal", {
    state: "detached",
    timeout: 20000,
  });
  ok("首次配置：保存 key 后弹窗关闭", true);
  await page.waitForTimeout(1500);
});

await step("status bar", async () => {
  const api = await page.$eval(".status-conn-label", (e) =>
    e.textContent.trim(),
  );
  const cl = await page.$eval(".status-cluster", (e) => e.textContent.trim());
  ok(
    "状态栏：API / 集群分开显示",
    api.startsWith("API ") && cl.includes("集群"),
    `${api} | ${cl}`,
  );
});

await step("capsules", async () => {
  const caps = await page.$$eval(".goalbar-collapsed .loop-capsule", (els) =>
    els.map((e) => ({
      t: e.textContent.trim(),
      l: e.getBoundingClientRect().left,
      r: e.getBoundingClientRect().right,
    })),
  );
  const mid = await page.$eval(
    ".inputbox",
    (e) =>
      (e.getBoundingClientRect().left + e.getBoundingClientRect().right) / 2,
  );
  const pillMid = caps.length === 1 ? (caps[0].l + caps[0].r) / 2 : -1;
  ok(
    "Loop 胶囊：单枚任务胶囊、按输入框中轴居中",
    caps.length === 1 && Math.abs(pillMid - mid) < 3,
    caps.map((c) => c.t).join(" / "),
  );
});

await step("task modal", async () => {
  await page.click(".goalbar-collapsed .loop-capsule.task");
  await page.waitForSelector(".task-modal");
  await page.waitForFunction(
    () => document.querySelectorAll("#task-planner option").length > 1,
    null,
    { timeout: 8000 },
  );
  const hidden = await page.$$eval(
    ".goalbar-collapsed .loop-capsule",
    (e) => e.length,
  );
  await shot(page, "2-taskmodal.png");
  ok("统一任务弹窗：有模型下拉、胶囊收起", hidden === 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
});

await step("cluster modal", async () => {
  await page.click(".inputbox .cluster-btn");
  await page.waitForSelector(".cluster-modal");
  await page.click(".cluster-modal .btn.primary");
  const msg = await page.$eval(".cockpit-state", (e) => e.textContent);
  ok("连接集群：弹窗打开、空 kubeconfig 被拦", msg.includes("请先粘贴"), msg);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
});

await step("task desk", async () => {
  await page.click(".task-desk-chip");
  await page.waitForSelector(".task-desk");
  await page.waitForTimeout(1200);
  const txt = await page.$eval(".task-desk", (e) => e.textContent);
  const headTop = await page.$eval(
    ".task-desk .modal-head",
    (e) => e.getBoundingClientRect().top,
  );
  await shot(page, "3-taskdesk.png");
  ok("任务台：抽屉打开、目录在", txt.includes("Loop 目录") && headTop >= 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
});

await step("llm loop editor", async () => {
  await page.click(".goalbar-collapsed .loop-capsule.task");
  await page.waitForSelector(".task-modal");
  await page.click('.task-accept-opt input[value="llm"]');
  await page.waitForSelector("#task-llm-planner");
  const txt = await page.$eval(".task-modal", (e) => e.textContent);
  const expectedText = ["帮我细化", "执行模型", "规划模型"];
  ok(
    "LLM loop 编辑器：细化按钮 / 模型下拉 / 说明行",
    expectedText.every((s) => txt.includes(s)),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
});

await step("chat", async () => {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".inputbox textarea", { timeout: 20000 });
  await page.waitForTimeout(1500);
  const nonce = "回执" + (1000 + Math.floor(Math.random() * 9000));
  await page.fill(".inputbox textarea", `只回复这几个字，不要别的：${nonce}`);
  await page.keyboard.press("Enter");
  const t0 = Date.now();
  await page.waitForFunction(
    (n) =>
      [...document.querySelectorAll(".messages *")].some(
        (el) => el.children.length === 0 && (el.textContent || "").trim() === n,
      ),
    nonce,
    { timeout: 120000 },
  );
  await shot(page, "4-chat.png");
  ok("对话：真实模型往返", true, `${nonce} ${Date.now() - t0}ms`);
});

await step("pty", async () => {
  await page.click(
    '[data-bar-item="host:terminal"], .topbar button:has-text("终端")',
  );
  await page.waitForSelector(".xterm", { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.click(".xterm");
  await page.keyboard.type("echo pty-$((40+2))-ok\n");
  await page.waitForFunction(
    () =>
      (document.querySelector(".xterm-rows")?.textContent || "").includes(
        "pty-42-ok",
      ),
    null,
    {
      timeout: 15000,
    },
  );
  await shot(page, "5-pty.png");
  ok("PTY：交互式终端回显", true);
});

await step("skills", async () => {
  await page
    .click('[data-bar-item="host:chat"], .topbar button:has-text("对话")')
    .catch(() => {});
  await page.waitForTimeout(500);
  await page.fill(".inputbox textarea", "/skill");
  await page.waitForTimeout(1200);
  const txt = await page.evaluate(() => document.body.innerText);
  const found = [
    "inference-harness",
    "prefill-optimization",
    "cache-adaptation",
  ].filter((s) => txt.includes(s));
  ok("Skills：领域 skill 可发现", found.length >= 2, found.join(","));
  await page.fill(".inputbox textarea", "");
});

ok("页面无 pageerror", errors.length === 0, errors.join(" | "));
await browser.close();
for (const r of results)
  console.log(
    `${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`,
  );
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
