#!/usr/bin/env node
/**
 * 本地冒烟验证脚本（第一阶段端到端验收用）。
 *
 * 契约：检查工作目录下指定文件存在且内容匹配，输出结构化指标：
 *   HARNESS_METRIC: {"smoke_ok": 1}   成功
 *   HARNESS_METRIC: {"smoke_ok": 0}   失败
 *   HARNESS_SCENARIO: local-smoke
 *
 * 用法：
 *   node smoke-validator.mjs --workspace <dir> [--expect-file result.txt] [--expect-content SMOKE_OK]
 */
import fs from "node:fs";
import path from "node:path";

function arg(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const args = process.argv.slice(2);
const workspace = arg(args, "--workspace", process.cwd());
const expectFile = arg(args, "--expect-file", "result.txt");
const expectContent = arg(args, "--expect-content", "SMOKE_OK");

const target = path.join(workspace, expectFile);

function emit(ok, detail) {
  console.log(`HARNESS_SCENARIO: local-smoke`);
  console.log(`HARNESS_METRIC: {"smoke_ok": ${ok ? 1 : 0}}`);
  console.log(`SMOKE_DETAIL: ${detail}`);
  if (!ok) {
    console.error(detail);
    process.exit(1);
  }
  process.exit(0);
}

try {
  if (!fs.existsSync(workspace)) {
    emit(false, `workspace not found: ${workspace}`);
  }
  if (!fs.existsSync(target)) {
    emit(false, `missing file: ${target}`);
  }
  const content = fs.readFileSync(target, "utf8");
  if (content.trim() !== expectContent) {
    emit(false, `content mismatch in ${target}: expected ${JSON.stringify(expectContent)}, got ${JSON.stringify(content.trim())}`);
  }
  emit(true, `ok: ${target} matches ${JSON.stringify(expectContent)}`);
} catch (error) {
  emit(false, `validator error: ${error instanceof Error ? error.message : String(error)}`);
}
