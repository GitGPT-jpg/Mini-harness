/**
 * Mini Harness Runtime（薄运行时扩展）
 *
 * 补上"公共运行时"那一块：
 *   intake → plan → run → validate → (pass) done
 *                                   ↘ (fail) iterate → run …
 *
 * 关键点：
 *  - 准入由 validator 判定（默认 ./validate.py 或 $HARNESS_ROOT/validate.py，也可显式传 validateCmd）。
 *  - validator 不通过 → 运行时自动进入下一轮（sendUserMessage followUp），并把证据带回给模型。
 *  - 状态落盘在仓库之外（默认 ~/.mini-harness/runs/<id>/state.json），进程重启后可续跑。
 *  - 只在本会话绑定的 run 上生效，避免影响其它对话。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Type } from "typebox";

const DEFAULT_MAX_ROUNDS = 5;
const CUSTOM_TYPE = "mini-harness-runtime";
const ROOT = process.env.MINI_HARNESS_RUNTIME_ROOT || path.join(os.homedir(), ".mini-harness", "runs");
const ACTIVE_STAGES = new Set(["intake", "plan", "run", "validate"]);

// ---------- 基础工具 ----------

function now() {
  return new Date().toISOString();
}

function runDir(runId) {
  return path.join(ROOT, runId);
}

function statePath(runId) {
  return path.join(runDir(runId), "state.json");
}

function newRunId() {
  const t = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${t}-${crypto.randomBytes(3).toString("hex")}`;
}

function loadState(runId) {
  try {
    return JSON.parse(fs.readFileSync(statePath(runId), "utf8"));
  } catch {
    return null;
  }
}

function saveState(st) {
  st.updatedAt = now();
  fs.mkdirSync(runDir(st.runId), { recursive: true });
  fs.writeFileSync(statePath(st.runId), JSON.stringify(st, null, 2));
}

function journal(st, event, extra = {}) {
  try {
    fs.mkdirSync(runDir(st.runId), { recursive: true });
    fs.appendFileSync(
      path.join(runDir(st.runId), "journal.jsonl"),
      JSON.stringify({ at: now(), runId: st.runId, round: st.round, event, ...extra }) + "\n",
    );
  } catch {}
}

function listRuns() {
  try {
    return fs
      .readdirSync(ROOT)
      .map((n) => loadState(n))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function sessionIdOf(ctx) {
  try {
    return ctx?.sessionManager?.getSessionId?.() || "";
  } catch {
    return "";
  }
}

/** 解析真实路径（macOS /tmp -> /private/tmp），保证 workspace 比较一致。 */
function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * 找到当前会话的活跃 run：优先 sessionId 精确匹配，其次同 workspace 的最新活跃 run。
 * 这样进程重启 / 新会话也能续跑。
 */
function findActiveRun(ctx) {
  const sid = sessionIdOf(ctx);
  const cwd = real(ctx?.cwd || process.cwd());
  const runs = listRuns().filter((r) => r.status === "active" && ACTIVE_STAGES.has(r.stage));
  if (!runs.length) return null;
  runs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (sid) {
    const bySid = runs.find((r) => r.sessionId === sid);
    if (bySid) return bySid;
  }
  return runs.find((r) => real(r.workspace) === cwd) || null;
}

function tail(s, n) {
  const str = String(s || "");
  return str.length > n ? "…" + str.slice(-n) : str;
}

function notify(ctx, message, type = "info") {
  try {
    ctx?.ui?.notify?.(message, type);
  } catch {}
}

// ---------- validator ----------

function resolveValidator(st) {
  if (st.validateCmd) {
    return { cmd: "bash", args: ["-lc", st.validateCmd], label: st.validateCmd };
  }
  const candidates = [];
  if (st.workspace) candidates.push(path.join(st.workspace, "validate.py"));
  if (st.harnessRoot) candidates.push(path.join(st.harnessRoot, "validate.py"));
  if (process.env.HARNESS_ROOT) candidates.push(path.join(process.env.HARNESS_ROOT, "validate.py"));
  for (const p of candidates) {
    if (fs.existsSync(p)) return { cmd: "python3", args: [p], label: p };
  }
  return null;
}

async function runValidation(pi, st) {
  const r = resolveValidator(st);
  if (!r) {
    return {
      pass: false,
      noValidator: true,
      code: null,
      evidence: null,
      output:
        "未找到 validator。请提供 validateCmd（例如 validate.py 的路径），或在 workspace 放置 validate.py，或设置 HARNESS_ROOT。",
    };
  }
  let res;
  try {
    res = await pi.exec(r.cmd, r.args, { cwd: st.workspace || process.cwd(), timeout: 30 * 60 * 1000 });
  } catch (e) {
    res = { stdout: "", stderr: String(e?.message || e), code: -1, killed: false };
  }
  const output =
    `$ ${r.label}\n` +
    `exit=${res.code}${res.killed ? " (killed/timeout)" : ""}\n` +
    `--- stdout (tail) ---\n${tail(res.stdout, 6000)}\n` +
    `--- stderr (tail) ---\n${tail(res.stderr, 4000)}\n`;
  let evidence = "";
  try {
    const dir = path.join(runDir(st.runId), "evidence");
    fs.mkdirSync(dir, { recursive: true });
    evidence = path.join(dir, `round-${st.round}-${Date.now()}.log`);
    fs.writeFileSync(evidence, output);
  } catch {}
  return { pass: res.code === 0, noValidator: false, code: res.code, evidence, output };
}

// ---------- 提示词 ----------

function stateBlock(st) {
  const lines = [
    "<mini_harness_runtime>",
    `runId: ${st.runId}`,
    `stage: ${st.stage} | round: ${st.round}/${st.maxRounds}`,
    `goal: ${st.goal}`,
    st.plan ? `plan: ${tail(st.plan, 600)}` : "",
    st.lastVerdict
      ? `last_verdict: ${st.lastVerdict} (exit ${st.lastCode})`
      : "last_verdict: (none yet)",
    st.lastEvidence ? `last_evidence_tail:\n${tail(st.lastEvidence, 1600)}` : "",
    "规则：",
    "- 完成本轮工作后调用 loop_done(summary) 声明完成；运行时会在本轮结束时自动执行 validator。",
    "- 不要自行宣布完成；只有 validator 通过才算完成。",
    "- 若验证失败：按证据修复，不要重复已完成的步骤，也不要向用户提问。",
    "</mini_harness_runtime>",
  ];
  return lines.filter(Boolean).join("\n");
}

function nextRoundPrompt(st, v) {
  return [
    `【mini-harness · 第 ${st.round} 轮】上一轮 validator 未通过。`,
    `退出码：${v.code}`,
    "证据（尾部）：",
    "```",
    tail(v.output, 3000),
    "```",
    `请修复后再次调用 loop_done(summary)。目标：${st.goal}`,
    "要求：直接修改工作区，不要只在回复里描述；不要向用户提问。",
  ].join("\n");
}

// ---------- 判定处理（pass → done；fail → 下一轮 / 停止）----------

function handleVerdict(pi, ctx, st, v) {
  if (v.pass) {
    st.stage = "done";
    st.status = "done";
    saveState(st);
    journal(st, "validate-pass", { code: v.code });
    notify(ctx, `✅ mini-harness：第 ${st.round} 轮验证通过，目标达成。`, "info");
    return;
  }
  if (v.noValidator) {
    st.stage = "stopped";
    st.status = "stopped";
    st.stopReason = "no-validator";
    saveState(st);
    journal(st, "no-validator");
    notify(ctx, "⚠️ mini-harness：未找到 validator，运行已停止。请提供 validateCmd 或 validate.py。", "warning");
    return;
  }
  if (st.round < st.maxRounds) {
    const failedRound = st.round;
    st.round += 1;
    st.stage = "run";
    st.validatedRound = 0;
    saveState(st);
    journal(st, "validate-fail", { code: v.code, failedRound, nextRound: st.round });
    // 交给下一轮：把 validator 证据带回去。deliverAs=followUp → 当前 run 结束后自动开始。
    pi.sendUserMessage(nextRoundPrompt(st, v), { deliverAs: "followUp" });
  } else {
    st.stage = "stopped";
    st.status = "stopped";
    st.stopReason = "max-rounds";
    saveState(st);
    journal(st, "max-rounds", { code: v.code });
    pi.sendUserMessage(
      `【mini-harness】已达最大轮数 ${st.maxRounds}，停止。最后一次 validator 退出码 ${v.code}。\n` +
        `证据：\n\`\`\`\n${tail(v.output, 2500)}\n\`\`\``,
      { deliverAs: "followUp" },
    );
  }
}

// ---------- 扩展入口 ----------

export default function miniHarnessRuntime(pi) {
  const busy = new Set();

  // ---- 工具：loop_start ----
  pi.registerTool({
    name: "loop_start",
    label: "Loop Start",
    description:
      "启动一个受 validator 约束的任务运行（状态机 intake→plan→run→validate）。validator 不通过会自动进入下一轮。状态落盘，可断点续跑。",
    parameters: Type.Object({
      goal: Type.String({ description: "要达成的目标（写清可验证的完成条件）" }),
      validateCmd: Type.Optional(
        Type.String({ description: "validator 命令（shell）。缺省自动找 workspace/validate.py 或 HARNESS_ROOT/validate.py" }),
      ),
      harnessRoot: Type.Optional(Type.String({ description: "infer-forge-harness 仓库根目录（用于定位 validate.py）" })),
      maxRounds: Type.Optional(Type.Number({ description: `最大轮数，默认 ${DEFAULT_MAX_ROUNDS}` })),
      auto: Type.Optional(Type.Boolean({ description: "是否自动验证并自动下一轮，默认 true" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runId = newRunId();
      const maxRounds = Math.max(1, Math.min(20, Number(params.maxRounds) || DEFAULT_MAX_ROUNDS));
      const st = {
        runId,
        goal: String(params.goal || "").trim(),
        workspace: real(ctx?.cwd || process.cwd()),
        harnessRoot: params.harnessRoot || null,
        validateCmd: params.validateCmd || null,
        maxRounds,
        auto: params.auto !== false,
        round: 1,
        stage: "intake",
        status: "active",
        sessionId: sessionIdOf(ctx),
        plan: "",
        summary: "",
        lastVerdict: null,
        lastCode: null,
        lastEvidence: "",
        validatedRound: 0,
        createdAt: now(),
        history: [],
      };
      saveState(st);
      journal(st, "start", { goal: st.goal });
      return {
        content: [
          {
            type: "text",
            text:
              `已创建运行 ${runId}（stage=intake，最多 ${maxRounds} 轮）。\n` +
              `下一步：先调用 loop_plan 写出计划（会自动进入 run 阶段），然后直接修改工作区。\n` +
              `完成时调用 loop_done(summary)；运行时会自动执行 validator，不通过会带着证据进入下一轮。`,
          },
        ],
        details: { runId, stage: st.stage, round: st.round },
      };
    },
  });

  // ---- 工具：loop_plan ----
  pi.registerTool({
    name: "loop_plan",
    label: "Loop Plan",
    description: "记录本轮计划并进入 run 阶段。",
    parameters: Type.Object({ plan: Type.String({ description: "计划/步骤" }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const st = findActiveRun(ctx);
      if (!st) return { content: [{ type: "text", text: "当前会话没有活跃运行。请先调用 loop_start。" }], details: {} };
      st.plan = String(params.plan || "").trim();
      st.stage = "run";
      saveState(st);
      journal(st, "plan", { plan: tail(st.plan, 400) });
      return {
        content: [{ type: "text", text: `计划已记录，进入 run（第 ${st.round} 轮）。完成后调用 loop_done(summary)。` }],
        details: { runId: st.runId, stage: st.stage },
      };
    },
  });

  // ---- 工具：loop_done ----
  pi.registerTool({
    name: "loop_done",
    label: "Loop Done",
    description: "声明本轮完成。运行时会自动执行 validator；只有 validator 通过才算真正完成。",
    parameters: Type.Object({ summary: Type.String({ description: "本轮改了什么、怎么验证的" }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const st = findActiveRun(ctx);
      if (!st) return { content: [{ type: "text", text: "当前会话没有活跃运行。请先调用 loop_start。" }], details: {} };
      st.summary = String(params.summary || "").trim();
      st.stage = "validate";
      saveState(st);
      journal(st, "done-claimed", { summary: tail(st.summary, 400) });
      return {
        content: [
          {
            type: "text",
            text: `已记录完成声明（第 ${st.round} 轮）。运行时将在本轮结束时自动执行 validator；不通过会带着证据进入下一轮。`,
          },
        ],
        details: { runId: st.runId, stage: st.stage },
      };
    },
  });

  // ---- 工具：loop_validate ----
  pi.registerTool({
    name: "loop_validate",
    label: "Loop Validate",
    description: "手动执行 validator 并记录证据（通常由运行时自动调用）。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const st = findActiveRun(ctx);
      if (!st) return { content: [{ type: "text", text: "当前会话没有活跃运行。" }], details: {} };
      const v = await runValidation(pi, st);
      st.validatedRound = st.round;
      st.lastVerdict = v.pass ? "pass" : "fail";
      st.lastCode = v.code;
      st.lastEvidence = v.output;
      st.history.push({ round: st.round, verdict: st.lastVerdict, code: v.code, at: now(), evidence: v.evidence });
      if (v.pass) {
        st.stage = "done";
        st.status = "done";
      }
      saveState(st);
      journal(st, "manual-validate", { pass: v.pass, code: v.code });
      return {
        content: [{ type: "text", text: `${v.pass ? "PASS" : "FAIL"}（exit ${v.code}）\n${tail(v.output, 2000)}` }],
        details: { runId: st.runId, pass: v.pass, code: v.code, evidence: v.evidence },
      };
    },
  });

  // ---- 工具：loop_status ----
  pi.registerTool({
    name: "loop_status",
    label: "Loop Status",
    description: "查看当前会话的活跃运行状态（或指定 runId）。",
    parameters: Type.Object({ runId: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const st = params.runId ? loadState(params.runId) : findActiveRun(ctx);
      if (!st) return { content: [{ type: "text", text: "没有找到运行。" }], details: {} };
      return {
        content: [
          {
            type: "text",
            text: stateBlock(st) + `\nstatus: ${st.status}\nworkspace: ${st.workspace}`,
          },
        ],
        details: { runId: st.runId, stage: st.stage, round: st.round, status: st.status },
      };
    },
  });

  // ---- 工具：loop_stop ----
  pi.registerTool({
    name: "loop_stop",
    label: "Loop Stop",
    description: "停止当前运行（不再自动验证/迭代）。",
    parameters: Type.Object({ reason: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const st = findActiveRun(ctx);
      if (!st) return { content: [{ type: "text", text: "当前会话没有活跃运行。" }], details: {} };
      st.stage = "stopped";
      st.status = "stopped";
      st.stopReason = String(params.reason || "");
      saveState(st);
      journal(st, "stop", { reason: st.stopReason });
      return { content: [{ type: "text", text: `已停止运行 ${st.runId}。` }], details: { runId: st.runId } };
    },
  });

  // ---- 运行前注入状态（缓存友好：作为隐藏尾消息，不改系统提示词）----
  pi.on("before_agent_start", async (event, ctx) => {
    if (event?.messageType === "custom") return;
    const st = findActiveRun(ctx);
    if (!st || st.status !== "active") return;
    return { message: { customType: CUSTOM_TYPE, content: stateBlock(st), display: false } };
  });

  // ---- 运行结束：自动 validator → 通过则完成；失败则自动下一轮 ----
  pi.on("agent_end", async (_event, ctx) => {
    const st = findActiveRun(ctx);
    if (!st || !st.auto || st.status !== "active") return;
    if (!["run", "validate"].includes(st.stage)) return;
    if (busy.has(st.runId)) return;
    busy.add(st.runId);
    try {
      let v;
      if (st.validatedRound === st.round && st.lastVerdict) {
        // 模型本轮已手动 loop_validate：复用结果，不再重复执行
        v = {
          pass: st.lastVerdict === "pass",
          code: st.lastCode,
          output: st.lastEvidence || "",
          noValidator: false,
          evidence: null,
        };
      } else {
        v = await runValidation(pi, st);
        st.validatedRound = st.round;
        st.lastVerdict = v.pass ? "pass" : "fail";
        st.lastCode = v.code;
        st.lastEvidence = v.output;
        st.history.push({ round: st.round, verdict: st.lastVerdict, code: v.code, at: now(), evidence: v.evidence });
      }
      handleVerdict(pi, ctx, st, v);
    } catch (e) {
      journal(st, "runtime-error", { error: String(e?.message || e) });
    } finally {
      busy.delete(st.runId);
    }
  });
}
