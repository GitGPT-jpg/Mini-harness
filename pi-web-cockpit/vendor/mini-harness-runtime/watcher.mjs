#!/usr/bin/env node
/**
 * mini-harness watcher（最小任务队列）
 *
 * 轮询 inbox 目录里的 *.json 任务，逐个交给 `pi --print` 执行（内部用 loop_start 受控运行），
 * 完成后归档到 done/ 或 failed/。不引入额外守护进程框架。
 *
 * 任务 JSON：
 * {
 *   "goal": "创建 x.txt 内容 X",
 *   "validateCmd": "python3 validate.py",
 *   "cwd": "/abs/workspace",            // 可选，默认=inbox 目录
 *   "maxRounds": 3,                      // 可选
 *   "plannerModel": "oneapi/gpt-6.1-sol",// 可选
 *   "reviewerModel": "oneapi/Claude Haiku 4.5", // 可选
 *   "useReviewer": true                  // 可选
 * }
 *
 * 环境：
 *   MINI_HARNESS_INBOX         默认 ~/.mini-harness/inbox
 *   MINI_HARNESS_RUNTIME_ROOT  传给运行时（默认 ~/.mini-harness/runs）
 *   WATCH_INTERVAL_MS          默认 3000
 *   PI_BIN                     默认 pi
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const INBOX = process.env.MINI_HARNESS_INBOX || path.join(os.homedir(), ".mini-harness", "inbox");
const DONE = path.join(INBOX, "done");
const FAILED = path.join(INBOX, "failed");
const LOGS = path.join(INBOX, "logs");
const INTERVAL = Number(process.env.WATCH_INTERVAL_MS || 3000);
const PI = process.env.PI_BIN || "pi";
const RUNTIME_ROOT = process.env.MINI_HARNESS_RUNTIME_ROOT || path.join(os.homedir(), ".mini-harness", "runs");

for (const d of [INBOX, DONE, FAILED, LOGS]) fs.mkdirSync(d, { recursive: true });

function stamp() {
  return new Date().toISOString();
}

function log(...a) {
  console.log(`[watcher ${stamp()}]`, ...a);
}

function buildPrompt(t) {
  const lines = [
    "用 loop_start 启动一个受控运行，然后 loop_plan 并直接完成工作，最后 loop_done。",
    `goal: ${t.goal}`,
  ];
  if (t.validateCmd) lines.push(`validateCmd: ${t.validateCmd}`);
  if (t.harnessRoot) lines.push(`harnessRoot: ${t.harnessRoot}`);
  if (Array.isArray(t.artifactRoots) && t.artifactRoots.length)
    lines.push(`artifactRoots: ${JSON.stringify(t.artifactRoots)}`);
  if (t.maxRounds) lines.push(`maxRounds: ${t.maxRounds}`);
  if (t.plannerModel) lines.push(`plannerModel: ${t.plannerModel}`);
  if (t.reviewerModel) lines.push(`reviewerModel: ${t.reviewerModel}`);
  if (t.useReviewer === false) lines.push("useReviewer: false");
  lines.push("不要向用户提问；运行时会自动验证、失败自动进入下一轮。");
  if (t.instructions) lines.push("", "具体要求/命令：", t.instructions);
  return lines.join("\n");
}

function runTask(file) {
  return new Promise((resolve) => {
    const base = path.basename(file, ".json").replace(/\.processing$/, "");
    let task;
    try {
      task = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      fs.renameSync(file, path.join(FAILED, base + ".json"));
      log(`任务 JSON 解析失败，已归档 failed: ${base}`, String(e.message || e));
      return resolve(false);
    }
    const cwd = task.cwd || INBOX;
    const logPath = path.join(LOGS, `${base}.log`);
    const out = fs.createWriteStream(logPath, { flags: "a" });
    out.write(`\n===== ${stamp()} start ${base} =====\n`);
    log(`开始任务 ${base} (cwd=${cwd})`);
    const child = spawn(PI, ["--print", "--no-session", buildPrompt(task)], {
      cwd,
      env: { ...process.env, MINI_HARNESS_RUNTIME_ROOT: RUNTIME_ROOT },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on("close", (code) => {
      out.write(`\n===== ${stamp()} exit ${code} =====\n`);
      out.end();
      const ok = code === 0;
      const dest = path.join(ok ? DONE : FAILED, base + ".json");
      try {
        fs.renameSync(file, dest);
      } catch {}
      log(`任务 ${base} 结束 exit=${code} -> ${ok ? "done" : "failed"}（日志 ${logPath}）`);
      resolve(ok);
    });
    child.on("error", (e) => {
      out.write(`\nspawn error: ${String(e.message || e)}\n`);
      out.end();
      try {
        fs.renameSync(file, path.join(FAILED, base + ".json"));
      } catch {}
      log(`任务 ${base} 启动失败`, String(e.message || e));
      resolve(false);
    });
  });
}

let running = false;

async function scanOnce() {
  if (running) return;
  running = true;
  try {
    const files = fs
      .readdirSync(INBOX)
      .filter((n) => n.endsWith(".json") && !n.endsWith(".processing.json"))
      .map((n) => path.join(INBOX, n))
      .sort();
    for (const f of files) {
      // 先原子改名，避免重复处理
      const claimed = f.replace(/\.json$/, ".processing.json");
      try {
        fs.renameSync(f, claimed);
      } catch {
        continue;
      }
      await runTask(claimed);
    }
  } finally {
    running = false;
  }
}

log(`watcher 启动：inbox=${INBOX} interval=${INTERVAL}ms pi=${PI} runtimeRoot=${RUNTIME_ROOT}`);
await scanOnce();
setInterval(scanOnce, INTERVAL);
