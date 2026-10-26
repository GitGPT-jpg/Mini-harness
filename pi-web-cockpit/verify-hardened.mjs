import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const token = fs.readFileSync(path.join(os.homedir(), ".pi-web/pi-web-token"), "utf8").trim();
const URL = `http://localhost:8787/?token=${token}`;
const MARK = "HARDEN_OK_5521";

const b = await chromium.launch({ channel: "chrome", headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
// 预置 API Key 门禁的"已确认"标志，自动化验证时不弹门禁（真实用户首次会看到）。
await p.addInitScript(() => { try { localStorage.setItem("pi-harness:apikey-ack", "1"); } catch {} });
const errs = [];
p.on("pageerror", (e) => errs.push("pageerror: " + String(e)));
const out = { ok: false };
try {
  await p.goto(URL, { waitUntil: "networkidle", timeout: 45000 });
  await p.waitForTimeout(2500);
  out.title = await p.title();
  out.hasModel = await p.evaluate(() => (document.body.innerText || "").includes("DeepSeek"));
  const composer = p.locator('textarea[placeholder^="给 pi 发送消息"]');
  await composer.waitFor({ state: "visible", timeout: 15000 });
  await composer.click();
  await p.keyboard.type(`reply with exactly: ${MARK}`);
  await p.keyboard.press("Enter");
  await p.waitForFunction(
    (m) => ((document.body.innerText || "").match(new RegExp(m, "g")) || []).length >= 2,
    MARK,
    { timeout: 90000 },
  );
  out.replyOk = true;
  out.ok = true;
} catch (e) {
  out.error = String(e?.message || e);
} finally {
  out.pageErrors = errs;
  out.bodyTail = (await p.evaluate(() => document.body.innerText || "")).replace(/\s+/g, " ").trim().slice(-260);
  console.log(JSON.stringify(out, null, 2));
  await b.close();
}
