import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
// 路径全部运行时自推导（可移植）：harden.mjs 位于 <BASE>/pi-web-cockpit/ 下。
const COCKPIT = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.dirname(COCKPIT);
const DIST = path.join(COCKPIT, "node_modules/pi-web-ui/dist/server");
const log = (...a) => console.log("[harden]", ...a);

// 首装兜底：干净机器上 ~/.pi-web / ~/.pi/agent 可能还不存在，后续写 token / client-state / 子代理模板 / settings 都需要它们。
try {
  fs.mkdirSync(path.join(HOME, ".pi-web"), { recursive: true });
  fs.mkdirSync(path.join(HOME, ".pi/agent"), { recursive: true });
} catch {}

// 品牌图标：左上角 logo 用 icon1111（brand-logo.png），浏览器页签 favicon 用紫色 C（brand-favicon.png）。
// 两者分开，均读仓库内 PNG -> data URI（可逆）。
let BRAND_LOGO = "";
let BRAND_FAVICON = "";
try {
  const toData = (f) => (fs.existsSync(f) ? "data:image/png;base64," + fs.readFileSync(f).toString("base64") : "");
  BRAND_LOGO = toData(path.join(COCKPIT, "assets", "brand-logo.png"));
  BRAND_FAVICON = toData(path.join(COCKPIT, "assets", "brand-favicon.png"));
} catch {}

// 领域「灵魂」提示词：覆盖 pi 组合模板的 {{soul}} token（替换 pi 默认"编码助手"身份，
// 其余 {{tools}}/{{guidelines}}/{{pi_docs}} 等脚手架 token 保持自动生成不动）。
// 内容源自 5 个 workflow skill 的身份/核心原则/安全红线。
const DOMAIN_SOUL = [
  "你是训推引擎组的推理服务优化 agent，运行在 pi（一个编码智能体框架）中，工作围绕 infer-forge-harness（icode 仓库 baidu/hac-aiacc/infer-forge-harness）。你通过读取文件、执行命令、编辑代码和新建文件，帮助团队完成 sglang / AttentionStore / prefill / decode / cache 的优化与模型适配。",
  "",
  "工作准则：",
  "- 涉及 sglang / AttentionStore / prefill / decode / cache 优化或模型适配时，先用 inference-harness skill，并先读 AGENTS.md、目标 workflow 定义、tasks/REGISTRY.yaml、catalog/tool_catalog.yaml、SKILL.md 与 validator，再动手。",
  "- 优先复用 REGISTRY 已有原子任务，没有合适的才新增、新增后更新 REGISTRY 并重新生成 CATALOG；不过度设计。",
  "- 每步都要有明确 verify，以 validator 判定为准（返回码 / PASS 字样 / manifest 都不算通过）；产出 run id、artifact root、validator 结论、Journal 路径、证据路径，并与 baseline 对比。",
  "- 运行产物、Journal、run state 一律放源码仓库之外；失败保留原始证据，不打补丁绕过、不静默重试。",
  "",
  "安全红线（必须遵守）：",
  "- 删除实例 / 删除资源 / 缩减副本 / 杀共享进程 / 改端口拓扑 / 改 MODEL_ID / 改部署配置等高危操作，一律先说明理由并等人工确认。",
  "- 只能操作自己的 Pod；K8s 工作负载的删除、缩容、驱逐交给人类。",
  "- 联调环境团队共用：apply 后 Pod 长时间 Pending 多为资源不足，立即通知人类腾挪，不动别人的实例。",
].join("\n");

// ---- 1) 禁用 7 个风险技能（移出 Pi 技能发现目录，可逆）----
const skillsDir = path.join(HOME, ".pi/agent/skills");
const disabledDir = path.join(HOME, ".pi/agent/skills.disabled");
const toDisable = [
  "browser-tools",
  "transcribe",
  "brave-search",
  "gccli",
  "gdcli",
  "gmcli",
  "youtube-transcript",
];
fs.mkdirSync(disabledDir, { recursive: true });
for (const s of toDisable) {
  const src = path.join(skillsDir, "pi-skills", s);
  const dst = path.join(disabledDir, s);
  if (fs.existsSync(src)) {
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(src, dst);
    log("已禁用技能:", s);
  } else {
    log("技能已禁用/不存在:", s);
  }
}

// ---- 2) 关闭远程 SSH 能力声明（pi 引擎）----
const capFile = path.join(DIST, "engine-capabilities.js");
let cap = fs.readFileSync(capFile, "utf8");
if (cap.includes("remoteSsh: true,")) {
  cap = cap.replace("remoteSsh: true,", "remoteSsh: false,");
  fs.writeFileSync(capFile, cap);
  log("已关闭 remoteSsh 能力");
} else {
  log("remoteSsh 已关闭（跳过）");
}

// ---- 2b) 推理场景精简：关 Pi 引擎 sandbox / planMode / delegateMode / subagents / pageRef ----
// 这些 UI 模式与 inference-harness skill 里的 AI Loop 编排功能重叠；pageRef 对应 Page Picker 入口。
// 仅改 DEFAULT_PI_CAPABILITIES 块，presentFiles 保留 true（推理产出 report/chart 成果卡片需要）。
{
  cap = fs.readFileSync(capFile, "utf8");
  const piStart = cap.indexOf("DEFAULT_PI_CAPABILITIES = Object.freeze({");
  const piEnd = piStart === -1 ? -1 : cap.indexOf("});", piStart);
  if (piStart !== -1 && piEnd !== -1) {
    let block = cap.slice(piStart, piEnd);
    const off = ["sandboxes", "planMode", "delegateMode", "subagents", "pageRef"];
    let changed = false;
    for (const k of off) {
      const re = new RegExp(`(${k}:\\s*)true`);
      if (re.test(block)) { block = block.replace(re, `$1false`); changed = true; }
    }
    if (changed) {
      cap = cap.slice(0, piStart) + block + cap.slice(piEnd);
      fs.writeFileSync(capFile, cap);
      log("已精简 Pi 能力: sandbox/planMode/delegateMode/subagents/pageRef -> false (presentFiles 保留)");
    } else log("Pi 能力已精简（跳过）");
  } else log("WARN: 未找到 DEFAULT_PI_CAPABILITIES 块");
}

// ---- 2c) 只允许 pi 引擎：前端引擎清单裁成单个 pi（去掉 dsh/claude/durable 卡片与热切）----
// 引擎清单是前端 bundle 里的硬编码数组 ls=[{id:`pi`...},{id:`dsh`...},...]。
// 把 pi 之后的三个引擎对象删掉，设置页只剩 pi、底栏引擎选择器也只有 pi 一项。
{
  const bundleDir = path.join(DIST, "..", "..", "web", "dist", "assets");
  const files = fs.readdirSync(bundleDir).filter((n) => /^index-.*\.js$/.test(n));
  let done = false;
  for (const fn of files) {
    const fp = path.join(bundleDir, fn);
    let js = fs.readFileSync(fp, "utf8");
    // 锚点：pi 定义结尾 → durable 数组结尾。把中间(含 dsh/claude/durable)整体替成 "}]"
    const head = "@earendil-works/pi-coding-agent`},{id:`dsh`";
    const tail = "@earendil-works/pi-durable`}];";
    if (js.includes("@earendil-works/pi-coding-agent`}];")) { log("引擎清单已裁为 pi-only（跳过）"); done = true; break; }
    const hi = js.indexOf(head);
    const ti = js.indexOf(tail);
    if (hi !== -1 && ti !== -1 && ti > hi) {
      // 保留到 pi 的 installCommand 闭合 "}`}"，然后直接 "];"
      const keepUpto = js.indexOf("`}", hi) + 2; // 指向 pi 对象的 "}" 之后
      const rest = js.slice(ti + tail.length);
      js = js.slice(0, keepUpto) + "];" + rest;
      fs.writeFileSync(fp, js);
      log(`引擎清单已裁为 pi-only（${fn}）`);
      done = true;
      break;
    }
  }
  if (!done) log("WARN: 未在 bundle 中定位引擎清单（可能已变更）");
}

// ---- 2e) 彻底关闭 codemode：SDK 的 CodemodeMode 只有 on/only，无法用设置关闭，
//         故把它的扩展工厂换成空实现（不再注册 codemode 工具）。幂等可逆。----
try {
  const agentFile = path.join(DIST, "agent-service.js");
  let js = fs.readFileSync(agentFile, "utf8");
  const codeMarker = "HARDENED:codemode-off";
  if (!js.includes(codeMarker)) {
    const needle = "factory: createCodemodeExtension(),";
    if (js.includes(needle)) {
      js = js.replace(needle, `factory: () => {}, /* ${codeMarker} */`);
      fs.writeFileSync(agentFile, js);
      log("已关闭 codemode 扩展（空实现，工具不再注册）");
    } else log("WARN: 未定位 createCodemodeExtension 工厂");
  } else log("codemode 已关闭（跳过）");
} catch (e) {
  log("WARN: codemode 关闭失败", e.message);
}

// ---- 3) 服务端彻底拒绝远程 SSH 消息 ----
const dispFile = path.join(DIST, "dispatch-domain-handlers.js");
let disp = fs.readFileSync(dispFile, "utf8");
const sshMarker = "/* HARDENED:remote-ssh-off */";
if (!disp.includes(sshMarker)) {
  const needle = "export function handleRemoteSshMessage(msg, remoteSshSvc, send) {";
  if (disp.includes(needle)) {
    disp = disp.replace(
      needle,
      needle +
        "\n    " +
        sshMarker +
        '\n    if (typeof msg.type === "string" && msg.type.startsWith("remote_ssh_")) {\n        try { send({ type: "remote_ssh_disabled", reqId: msg.reqId, error: "remote SSH disabled by security hardening" }); } catch {}\n        return true;\n    }',
    );
    fs.writeFileSync(dispFile, disp);
    log("已禁用远程 SSH 消息处理");
  } else log("WARN: 未找到 handleRemoteSshMessage");
} else log("远程 SSH 已禁用（跳过）");

// ---- 4) 封禁 /api/preview/__abs__ 任意文件读 ----
const idxFile = path.join(DIST, "index.js");
let idx = fs.readFileSync(idxFile, "utf8");
const absMarker = "/* HARDENED:abs-preview-off */";
if (!idx.includes(absMarker)) {
  const needle = 'const ABS_MARKER = "__abs__/";';
  if (idx.includes(needle)) {
    idx = idx.replace(
      needle,
      needle +
        "\n        " +
        absMarker +
        '\n        if (captured === "__abs__" || captured.startsWith(ABS_MARKER)) { res.status(403).end("absolute preview disabled"); return; }',
    );
    fs.writeFileSync(idxFile, idx);
    log("已封禁 __abs__ 任意文件读");
  } else log("WARN: 未找到 ABS_MARKER");
} else log("__abs__ 已封禁（跳过）");

// ---- 4b) 运行状态只读接口：GET /api/mini-harness/runs（多 loop 灵动岛轮询）----
try {
  let idx2 = fs.readFileSync(idxFile, "utf8");
  const runMarker = "/* HARDENED:mini-harness-runs-api */";
  const anchor = 'app.get("/api/attachment/:hash", async (req, res) => {';
  const route =
    `// ${runMarker} 返回所有活跃/近期运行的公开状态（round/stage/verdict），仅供前端状态条轮询。\n` +
    `async function __mhCollectRuns() {\n` +
    `  const fsM = await import("node:fs");\n` +
    `  const pathM = await import("node:path");\n` +
    `  const osM = await import("node:os");\n` +
    `  const dir = pathM.join(osM.homedir(), ".mini-harness", "runs");\n` +
    `  const out = [];\n` +
    `  let ids = [];\n` +
    `  try { ids = fsM.readdirSync(dir); } catch { return out; }\n` +
    `  for (const id of ids) {\n` +
    `    const p = pathM.join(dir, id, "state.json");\n` +
    `    if (!fsM.existsSync(p)) continue;\n` +
    `    let st;\n` +
    `    try { st = JSON.parse(fsM.readFileSync(p, "utf8")); } catch { continue; }\n` +
    `    const t = Date.parse(st.updatedAt || 0) || 0;\n` +
    `    const active = st.status === "active";\n` +
    `    if (!active && Date.now() - t >= 5 * 60 * 1000) continue;\n` +
    `    const ws = String(st.baseWorkspace || st.workspace || "");\n` +
    `    out.push({\n` +
    `      runId: st.runId || id,\n` +
    `      stage: st.stage,\n` +
    `      round: st.round,\n` +
    `      maxRounds: st.maxRounds,\n` +
    `      status: st.status,\n` +
    `      lastVerdict: st.lastVerdict,\n` +
    `      goal: String(st.goal || "").slice(0, 200),\n` +
    `      project: ws ? pathM.basename(ws) : "",\n` +
    `      models: { main: st.mainModel?.id || null, planner: st.plannerModel?.id || null, reviewer: st.reviewerModel?.id || null },\n` +
    `      updatedAt: st.updatedAt || null,\n` +
    `    });\n` +
    `  }\n` +
    `  out.sort((a, b) => ((b.status === "active") - (a.status === "active")) || ((Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0)));\n` +
    `  return out.slice(0, 8);\n` +
    `}\n` +
    `// 代码 loop 表单的规划/评审模型下拉：只返回 provider/id/family，不含 baseUrl/密钥。家族规则与 mini-harness-runtime familyOf 一致。\n` +
    `function __mhFamilyOf(id) {\n` +
    `  const s = String(id || "").toLowerCase();\n` +
    `  const rules = [[/^(gpt|o[1-9])/, "openai"], [/claude|opus|sonnet|haiku/, "anthropic"], [/gemini/, "google"], [/glm/, "zhipu"], [/kimi|moonshot/, "moonshot"], [/deepseek/, "deepseek"], [/grok/, "xai"], [/minimax|abab/, "minimax"], [/qwen|tongyi/, "alibaba"], [/llama/, "meta"], [/mistral|mixtral/, "mistral"], [/ernie/, "baidu"], [/doubao/, "bytedance"]];\n` +
    `  for (const [re, fam] of rules) if (re.test(s)) return fam;\n` +
    `  return "other";\n` +
    `}\n` +
    `async function __mhCollectModels() {\n` +
    `  const fsM = await import("node:fs");\n` +
    `  const pathM = await import("node:path");\n` +
    `  const osM = await import("node:os");\n` +
    `  let cfg;\n` +
    `  try { cfg = JSON.parse(fsM.readFileSync(pathM.join(osM.homedir(), ".pi", "agent", "models.json"), "utf8")); } catch { return []; }\n` +
    `  const out = [];\n` +
    `  for (const [provider, p] of Object.entries(cfg?.providers || {})) {\n` +
    `    for (const m of (Array.isArray(p?.models) ? p.models : [])) {\n` +
    `      if (m && m.id) out.push({ provider, id: String(m.id), family: __mhFamilyOf(m.id) });\n` +
    `    }\n` +
    `  }\n` +
    `  return out;\n` +
    `}\n` +
    `app.get("/api/mini-harness/models", async (req, res) => {\n` +
    `  if (!tokenOk(req)) { res.status(403).end("unauthorized"); return; }\n` +
    `  try { res.json({ models: await __mhCollectModels() }); } catch (e) { res.status(500).end(String(e)); }\n` +
    `});\n` +
    `// 任务台：读执行者会话（session jsonl）尾部，返回工具调用时间线（只读）\n` +
    `app.get("/api/mini-harness/task", async (req, res) => {\n` +
    `  if (!tokenOk(req)) { res.status(403).end("unauthorized"); return; }\n` +
    `  try {\n` +
    `    const fsT = await import("node:fs");\n` +
    `    const pathT = await import("node:path");\n` +
    `    const osT = await import("node:os");\n` +
    `    const sid = String((req.query && req.query.session) || "").replace(/[^A-Za-z0-9-]/g, "");\n` +
    `    if (!sid) { res.status(400).json({ error: "session required" }); return; }\n` +
    `    const root = pathT.join(osT.homedir(), ".pi", "agent", "sessions");\n` +
    `    let file = "";\n` +
    `    try {\n` +
    `      for (const d of fsT.readdirSync(root)) {\n` +
    `        const hit = fsT.readdirSync(pathT.join(root, d)).find((n) => n.includes("_" + sid + ".jsonl"));\n` +
    `        if (hit) { file = pathT.join(root, d, hit); break; }\n` +
    `      }\n` +
    `    } catch {}\n` +
    `    if (!file) { res.json({ found: false, events: [] }); return; }\n` +
    `    let lines = [];\n` +
    `    try { lines = fsT.readFileSync(file, "utf8").trim().split("\\n").slice(-500); } catch {}\n` +
    `    const calls = new Map();\n` +
    `    const events = [];\n` +
    `    for (const l of lines) {\n` +
    `      let o; try { o = JSON.parse(l); } catch { continue; }\n` +
    `      const m = o && o.message; if (!m) continue;\n` +
    `      if (m.role === "assistant" && Array.isArray(m.content)) {\n` +
    `        for (const b of m.content) {\n` +
    `          if (b && b.type === "toolCall") {\n` +
    `            const a = b.arguments || {};\n` +
    `            const brief = String(a.command || a.path || a.file_path || a.pattern || a.query || a.url || a.goal || "").replace(/\\s+/g, " ").slice(0, 180);\n` +
    `            const ev = { id: b.id, name: b.name, arg: brief, at: o.timestamp || null, status: "running", ms: null, out: "" };\n` +
    `            calls.set(b.id, ev); events.push(ev);\n` +
    `          }\n` +
    `        }\n` +
    `      } else if (m.role === "toolResult") {\n` +
    `        const ev = calls.get(m.toolCallId);\n` +
    `        if (ev) {\n` +
    `          ev.status = m.isError ? "error" : "done";\n` +
    `          ev.ms = m.durationMs || null;\n` +
    `          const t = (Array.isArray(m.content) ? m.content : []).map((c) => (c && c.text) || "").join(" ").replace(/\\s+/g, " ").trim();\n` +
    `          ev.out = t.slice(0, 240);\n` +
    `        }\n` +
    `      }\n` +
    `    }\n` +
    `    res.json({ found: true, events: events.slice(-40) });\n` +
    `  } catch (e) { res.status(500).end(String(e)); }\n` +
    `});\n` +
    `app.get("/api/mini-harness/runs", async (req, res) => {\n` +
    `  if (!tokenOk(req)) { res.status(403).end("unauthorized"); return; }\n` +
    `  try { res.json({ runs: await __mhCollectRuns() }); } catch (e) { res.status(500).end(String(e)); }\n` +
    `});\n` +
    `app.get("/api/mini-harness/runs/latest", async (req, res) => {\n` +
    `  if (!tokenOk(req)) { res.status(403).end("unauthorized"); return; }\n` +
    `  try { res.json((await __mhCollectRuns())[0] || null); } catch (e) { res.status(500).end(String(e)); }\n` +
    `});\n\n`;
  const markIdx = idx2.indexOf("// " + runMarker);
  const anchorIdx = idx2.indexOf(anchor);
  if (anchorIdx !== -1) {
    if (markIdx === -1) {
      const updated = idx2.slice(0, anchorIdx) + route + idx2.slice(anchorIdx);
      fs.writeFileSync(idxFile, updated);
      log("已注入运行状态只读接口 /api/mini-harness/runs");
    } else if (markIdx < anchorIdx) {
      // 旧版只返回 latest；整段替换为多 loop 列表接口
      const updated = idx2.slice(0, markIdx) + route + idx2.slice(anchorIdx);
      if (updated !== idx2) {
        fs.writeFileSync(idxFile, updated);
        log("已更新运行状态接口（多 loop 列表 + 模型列表）");
      }
    }
  } else log("WARN: 未找到 attachment 路由锚点（接口未注入）");
} catch (e) {
  log("WARN: 运行状态接口注入失败", e.message);
}

// ---- 5) 驾驶舱设置：禁 eval、关 codemode、禁技能 + 推理场景精简开关（纵深防御）----
// 首装时 client-state.json 尚不存在（由浏览器连接后才生成）；先播种一份 sanitized 的默认设置，
// 否则下面的开关与领域身份在首装会被跳过（这正是干净机器上"定制丢失"的根因）。
const csFile = path.join(HOME, ".pi-web/client-state.json");
const csSeed = path.join(COCKPIT, "config", "client-state.seed.json");
try {
  if (!fs.existsSync(csFile) && fs.existsSync(csSeed)) {
    fs.copyFileSync(csSeed, csFile);
    log("已播种 client-state（首装默认设置）");
  }
} catch (e) {
  log("WARN: client-state 播种失败", e.message);
}
try {
  const cs = JSON.parse(fs.readFileSync(csFile, "utf8"));
  const st = cs.__settings__?.settings;
  if (st) {
    const tools = new Set(st.disabledAgentTools || []);
    tools.add("eval");
    st.disabledAgentTools = [...tools];
    st.codemodeMode = "off";
    const sk = new Set(st.disabledSkills || []);
    for (const s of toDisable) sk.add(s);
    st.disabledSkills = [...sk];
    st.terminalToolsEnabled = false;
    st.terminalBash = false;
    // 推理场景精简：关多模态/目标模式/工具图像，开工具懒加载（省 token、稳 prompt cache 前缀）
    st.visionBridgeEnabled = false;
    st.goalModeEnabled = true;
    st.toolImagesEnabled = false;
    st.toolLazyLoading = true;
    // A) 领域身份：只覆盖组合模板的 {{soul}} token（替换 pi 默认"编码助手"身份），
    //    其余 tools/guidelines/pi_docs 等脚手架 token 保持自动生成。清掉旧的整体 append。
    st.customSystemPrompt = "";
    st.promptMode = "append";
    st.promptTemplate = st.promptTemplate || "";
    st.promptOverrides = { ...(st.promptOverrides || {}), soul: DOMAIN_SOUL };
    fs.writeFileSync(csFile, JSON.stringify(cs, null, 2));
    log("已更新 client-state：eval off + codemode off + 禁技能 + 推理精简开关 + 领域 soul 覆盖");
  } else log("WARN: client-state 缺少 __settings__");
} catch (e) {
  log("WARN: client-state 更新失败", e.message);
}

// ---- 6) 生成访问口令 + 加固启动脚本 ----
const tokenFile = path.join(HOME, ".pi-web/pi-web-token");
if (!fs.existsSync(tokenFile)) {
  fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString("hex"), { mode: 0o600 });
  log("已生成访问口令 ->", tokenFile);
} else log("口令已存在（跳过）");

const startSh = path.join(COCKPIT, "start-hardened.sh");
fs.writeFileSync(
  startSh,
  `#!/usr/bin/env bash
set -euo pipefail
# 路径运行时自推导（可移植）：脚本在 <BASE>/pi-web-cockpit/ 下，cwd 取 <BASE>。
HERE="$(cd "$(dirname "\${BASH_SOURCE[0]:-$0}")" && pwd)"
BASE="$(cd "$HERE/.." && pwd)"
export PI_WEB_TOKEN="$(cat "$HOME/.pi-web/pi-web-token")"
export PI_WEB_LOCALE="zh"
export PI_WEB_ENGINE="pi"
export PI_WEB_MANAGED="1"
# 若已建堡垒机隧道（~/.mini-harness/proxy.env 存在），继承代理环境，子进程 kubectl 才能连内网
[ -f "$HOME/.mini-harness/proxy.env" ] && . "$HOME/.mini-harness/proxy.env"
# Finder/LaunchServices 双击启动时 PATH 很精简，可能找不到 node；补上常见位置
for d in "$HOME/.local/share/pi-node/current/bin" /usr/local/bin /opt/homebrew/bin; do
  [ -x "$d/node" ] && PATH="$d:$PATH"
done
export PATH
command -v node >/dev/null 2>&1 || { echo "错误：未找到 node（需要 Node.js 22.19+）。" >&2; exit 1; }
exec "$HERE/node_modules/.bin/pi-web-ui" --host 127.0.0.1 --port 8787 --cwd "$BASE" --no-browser "$@"
`,
  { mode: 0o700 },
);
log("已写启动脚本:", startSh);

// ---- 7) 前端入口精简：隐藏不受 capability 门控的入口（CSS 注入，可逆）----
// capabilities 已关 sandbox/plan/delegate/subagents/pageRef，但部分入口仍由前端直渲，
// 用一段 <style> 把它们隐掉，不动 bundle 逻辑。保留 <img> 图片与 present_files 成果卡片。
const htmlFile = path.join(DIST, "..", "..", "web", "dist", "index.html");
try {
  let html = fs.readFileSync(htmlFile, "utf8");
  const trimMarker = "HARDENED:trim-entries";
  const styleBlock =
    `\t\t<!-- ${trimMarker} 推理场景精简：隐藏不需要的入口（可逆）。 -->\n` +
    `\t\t<style id="pi-trim-entries">\n` +
    `\t\t\t/* 沙盒入口：顶栏 + 最近项目区 */\n` +
    `\t\t\t[data-bar-item="host:new-sandbox"],\n` +
    `\t\t\t.sandbox-chip,\n` +
    `\t\t\t.lp-sandbox-action { display: none !important; }\n` +
    `\t\t\t/* 顶栏入口：画布协同 / 极简模式 / 临时对话 */\n` +
    `\t\t\t[data-bar-item="host:canvas"],\n` +
    `\t\t\t[data-bar-item="host:zen-mode"],\n` +
    `\t\t\t[data-bar-item="host:new-ephemeral-chat"] { display: none !important; }\n` +
    `\t\t\t/* 底栏引擎切换器：锁定单引擎 pi，关掉"点击切换智能体引擎"入口 */\n` +
    `\t\t\t[data-bar-item="host:engine"] { display: none !important; }\n` +
    `\t\t\t/* 顶栏「更多功能与布局」菜单里的 GitHub 入口 */\n` +
    `\t\t\ta.chip.github, [role="menuitem"].chip.github { display: none !important; }\n` +
    `\t\t\t/* 富媒体音视频播放：砍播放器，保留图片(<img>)与 present_files 成果卡片 */\n` +
    `\t\t\taudio, video,\n` +
    `\t\t\t.present-media-video, .present-media-audio,\n` +
    `\t\t\t.fp-audio-wrap, .fp-audio-element { display: none !important; }\n` +
    `\t\t\t/* 品牌名替换：pi-web-ui -> 训推引擎组 Harness（字面量隐藏 + ::after 覆盖，可逆） */\n` +
    `\t\t\t.brand-name { font-size: 0 !important; }\n` +
    `\t\t\t.brand-name::after { content: "训推引擎组 Harness"; font-size: 12px; font-weight: 600; letter-spacing: 0.2px; white-space: nowrap; }\n` +
    (BRAND_LOGO
      ? `\t\t\t/* 左上角 pi logo 换成 icon1111（content 覆盖 <img> 渲染，可逆） */\n` +
        `\t\t\t.brand-logo { content: url("${BRAND_LOGO}") !important; object-fit: contain !important; }\n`
      : "") +
    `\t\t</style>\n\t`;
  if (!html.includes(trimMarker)) {
    html = html.replace("</head>", styleBlock + "</head>");
    fs.writeFileSync(htmlFile, html);
    log("已注入前端入口精简 CSS（隐藏沙盒入口 + 音视频播放器）");
  } else {
    // 幂等更新：若标记已存在但内容过时，整体替换 style 块
    const re = /\t*<!-- HARDENED:trim-entries[\s\S]*?<\/style>\n\t?/;
    const updated = html.replace(re, styleBlock);
    if (updated !== html) {
      fs.writeFileSync(htmlFile, updated);
      log("已更新前端入口精简 CSS（同步最新规则）");
    } else log("前端入口精简已是最新（跳过）");
  }
} catch (e) {
  log("WARN: 前端入口精简注入失败", e.message);
}

// ---- 7b) 页签标题 + favicon 品牌化（标题是前端动态设置的，用脚本锁定+观察，可逆）----
try {
  let html = fs.readFileSync(htmlFile, "utf8");
  const brandMarker = "HARDENED:brand-fix";
  const scriptBlock =
    `\t\t<!-- ${brandMarker} 页签标题与 favicon 品牌化（可逆）。 -->\n` +
    `\t\t<script id="pi-brand-fix">\n` +
    `\t\t(function(){try{\n` +
    `\t\t\t// 清除 PWA 残留：注销 SW + 清 caches，确保始终加载最新品牌态\n` +
    `\t\t\ttry{if("serviceWorker" in navigator){navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister();});}).catch(function(){});}}catch(e){}\n` +
    `\t\t\ttry{if(window.caches&&caches.keys){caches.keys().then(function(ks){ks.forEach(function(k){caches.delete(k);});}).catch(function(){});}}catch(e){}\n` +
    `\t\t\tvar T="训推引擎组 Harness";var ICON=${JSON.stringify(BRAND_FAVICON)};\n` +
    `\t\t\tfunction setFav(){try{if(!ICON)return;var ls=document.querySelectorAll('link[rel*="icon"]');if(ls.length)ls.forEach(function(l){if(l.href!==ICON)l.href=ICON;});else{var l=document.createElement("link");l.rel="icon";l.href=ICON;document.head.appendChild(l);}}catch(e){}}\n` +
    `\t\t\tfunction setTitle(){try{var t=document.querySelector("title");if(!t){t=document.createElement("title");document.head.appendChild(t);}if(t.textContent!==T)t.textContent=T;if(document.title!==T)document.title=T;}catch(e){}}\n` +
    `\t\t\tfunction start(){setTitle();setFav();var t=document.querySelector("title");if(t){new MutationObserver(setTitle).observe(t,{childList:true,characterData:true,subtree:true});}}\n` +
    `\t\t\tif(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();\n` +
    `\t\t\tsetInterval(function(){if(document.hidden)return;setTitle();setFav();},5000);\n` +
    `\t\t}catch(e){}})();\n` +
    `\t\t</script>\n\t`;
  if (!html.includes(brandMarker)) {
    html = html.replace("</head>", scriptBlock + "</head>");
    fs.writeFileSync(htmlFile, html);
    log("已注入页签标题 + favicon 品牌化");
  } else {
    const re = /\t*<!-- HARDENED:brand-fix[\s\S]*?pi-brand-fix">[\s\S]*?<\/script>\n\t?/;
    const updated = html.replace(re, scriptBlock);
    if (updated !== html) { fs.writeFileSync(htmlFile, updated); log("已更新页签标题/favicon 品牌化"); }
    else log("页签标题/favicon 品牌化已是最新（跳过）");
  }
} catch (e) {
  log("WARN: 页签/favicon 品牌化注入失败", e.message);
}

// ---- 7c) 改写静态 <title> 与 favicon：消除刷新时首帧闪回 pi-web-ui（直接改 index.html，随 harden 重放）----
// 7b 的脚本是在页面加载后才改标题/图标，首帧仍是 index.html 里写死的 pi-web-ui，刷新时会闪一下。
// 这里把 index.html 里的静态 <title> 和 favicon 链接直接改掉，首帧就是品牌态，无闪回。
try {
  let html = fs.readFileSync(htmlFile, "utf8");
  let changed = false;
  const newTitle = "<title>训推引擎组 Harness</title>";
  if (/<title>[^<]*<\/title>/.test(html) && !html.includes(newTitle)) {
    html = html.replace(/<title>[^<]*<\/title>/, newTitle);
    changed = true;
  }
  if (BRAND_FAVICON) {
    const favLink = `<link rel="icon" href="${BRAND_FAVICON}" />`;
    const appleLink = `<link rel="apple-touch-icon" href="${BRAND_FAVICON}" />`;
    const h2 = html
      .replace(/<link\b[^>]*\brel="icon"[^>]*>/, favLink)
      .replace(/<link\b[^>]*\brel="apple-touch-icon"[^>]*>/, appleLink);
    if (h2 !== html) { html = h2; changed = true; }
  }
  if (changed) { fs.writeFileSync(htmlFile, html); log("已改写静态标题/favicon（消除刷新闪回）"); }
  else log("静态标题/favicon 已是最新（跳过）");
} catch (e) {
  log("WARN: 静态标题/favicon 改写失败", e.message);
}

// ---- 7d) 覆盖磁盘图标文件：兜住浏览器直接请求 /favicon.svg、PWA/apple 图标与 brand-logo 原生 src ----
// 仅改 <link> 挡不住浏览器对 favicon 的顽固缓存与直连请求；把磁盘上被请求到的图标字节也换成品牌图标。
try {
  const webDist = path.join(DIST, "..", "..", "web", "dist");
  const logoFile = path.join(COCKPIT, "assets", "brand-logo.png");
  const favFile = path.join(COCKPIT, "assets", "brand-favicon.png");
  if (fs.existsSync(logoFile) && fs.existsSync(favFile)) {
    const logoPng = fs.readFileSync(logoFile);
    const favPng = fs.readFileSync(favFile);
    const favB64 = favPng.toString("base64");
    let n = 0;
    // icon-192 是左上角 brand-logo 的原生 src，放 icon1111；其余 PWA/图标放紫色 C
    for (const rel of ["icons/icon-192.png", "icons/icon-512.png", "icons/icon-1024.png",
                        "icons/maskable-192.png", "icons/maskable-512.png", "icons/maskable-1024.png"]) {
      const fp = path.join(webDist, rel);
      if (fs.existsSync(fp)) { fs.writeFileSync(fp, rel === "icons/icon-192.png" ? logoPng : favPng); n++; }
    }
    const favSvg = path.join(webDist, "favicon.svg");
    fs.writeFileSync(favSvg, `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><image href="data:image/png;base64,${favB64}" width="128" height="128"/></svg>\n`);
    log(`已覆盖磁盘图标文件（${n} 个 PNG + favicon.svg）`);
  } else log("WARN: 缺 brand-logo.png / brand-favicon.png，跳过磁盘图标覆盖");
} catch (e) {
  log("WARN: 磁盘图标覆盖失败", e.message);
}

// ---- 7e) 停用 Service Worker：PWA 的 SW 会缓存旧 app shell（旧 logo/标题/favicon），
// 导致改了磁盘/HTML 浏览器仍显示旧的。把 sw.js 换成"自毁"版：激活即清空所有 cache、
// 注销自身并刷新页面 => 浏览器下次导航拉到新 sw.js 后自愈，之后永远走网络拿最新。
try {
  const webDist = path.join(DIST, "..", "..", "web", "dist");
  const swFile = path.join(webDist, "sw.js");
  const killSw =
    `/* HARDENED:sw-kill 自毁 Service Worker，禁用 PWA 离线缓存，保证始终加载最新 */\n` +
    `self.addEventListener("install", function(e){ self.skipWaiting(); });\n` +
    `self.addEventListener("activate", function(e){ e.waitUntil((async function(){\n` +
    `  try { var ks = await caches.keys(); await Promise.all(ks.map(function(k){return caches.delete(k);})); } catch(e){}\n` +
    `  try { await self.registration.unregister(); } catch(e){}\n` +
    `  try { var cs = await self.clients.matchAll({type:"window"}); cs.forEach(function(c){ try{c.navigate(c.url);}catch(e){} }); } catch(e){}\n` +
    `})()); });\n` +
    `/* 不注册 fetch 处理器 => 所有请求直连网络，永不走缓存 */\n`;
  if (fs.existsSync(swFile)) {
    const cur = fs.readFileSync(swFile, "utf8");
    if (!cur.includes("HARDENED:sw-kill")) { fs.writeFileSync(swFile, killSw); log("已将 sw.js 换成自毁版（停用 PWA 缓存，首次导航自愈）"); }
    else log("sw.js 自毁版已就位（跳过）");
  } else { fs.writeFileSync(swFile, killSw); log("已写入自毁版 sw.js"); }
} catch (e) {
  log("WARN: sw.js 停用失败", e.message);
}

// ---- 7f) 双 Loop 入口：目标条改名为「LLM loop」，旁边加「代码 loop」按钮（validator 门禁运行时）----
try {
  let html = fs.readFileSync(htmlFile, "utf8");
  const loopMarker = "HARDENED:loop-modes";
  const loopBlock =
    `\t\t<!-- ${loopMarker} 双 Loop 入口：LLM loop（目标条改名）+ 代码 loop（受控运行时）。 -->\n` +
    `\t\t<style id="pi-loop-modes-style">\n` +
    `\t\t\t.mh-code-loop-btn{align-self:center;display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 9px;margin-left:6px;font-size:12px;border-radius:6px;cursor:pointer;color:#c4b5fd;background:rgba(168,85,247,.12);border:1px solid rgba(168,85,247,.45);white-space:nowrap;}\n` +
    `\t\t\t.mh-code-loop-btn:hover{background:rgba(168,85,247,.22);color:#ddd6fe;}\n` +
    `\t\t\t.goalbar-collapsed.mh-loop-tabs{display:flex!important;gap:8px!important;width:100%!important;align-items:stretch!important;}\n` +
    `\t\t\t.goalbar-collapsed.mh-loop-tabs .goalbar-hint{flex:1;height:auto!important;min-height:46px;display:flex!important;flex-direction:column!important;align-items:flex-start!important;justify-content:center!important;gap:2px;padding:7px 11px!important;border-radius:10px!important;background:rgba(21,24,30,.96)!important;border:1px solid #2b313b!important;color:#c4b5fd!important;font-size:12.5px!important;font-weight:700!important;box-sizing:border-box;}\n` +
    `\t\t\t.goalbar-collapsed.mh-loop-tabs .goalbar-hint:hover{border-color:rgba(168,85,247,.65)!important;background:rgba(168,85,247,.10)!important;}\n` +
    `\t\t\t.goalbar-collapsed.mh-loop-tabs .goalbar-hint svg{display:none;}\n` +
    `\t\t\t.goalbar-collapsed.mh-loop-tabs .goalbar-hint::after{content:"AI 自己判断完成，开放式任务";font-size:10.5px;font-weight:400;color:#7f8897;}\n` +
    `\t\t\t.mh-loop-tabs{display:flex;gap:8px;box-sizing:border-box;}\n` +
    `\t\t\t.mh-loop-tab{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;align-items:flex-start;padding:7px 11px;border-radius:10px;cursor:pointer;background:rgba(21,24,30,.94);backdrop-filter:blur(6px);border:1px solid #2b313b;color:#e7e9ee;text-align:left;transition:border-color .15s,background .15s;}\n` +
    `\t\t\t.mh-loop-tab:hover{background:rgba(168,85,247,.10);border-color:rgba(168,85,247,.6);}\n` +
    `\t\t\t.mh-loop-tab .t{font-size:12.5px;font-weight:700;line-height:1.3;}\n` +
    `\t\t\t.mh-loop-tab .d{font-size:10.5px;color:#7f8897;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}\n` +
    `\t\t\t.mh-loop-tab.llm .t{color:#c4b5fd;}\n` +
    `\t\t\t.mh-loop-tab.code .t{color:#7dd3fc;}\n` +
    `\t\t\t.mh-loop-tab.task .t{color:#9aa3b2;}\n` +
    `\t\t\t.mh-loop-tab.llm .t::before{content:"◎ ";}\n` +
    `\t\t\t.mh-loop-tab.code .t::before{content:"⌘ ";}\n` +
    `\t\t\t.mh-loop-tab.task .t::before{content:"▤ ";}\n` +
    `\t\t\t.mh-quick-actions{display:flex;gap:6px;align-items:center;margin-left:6px;}\n` +
    `\t\t\t.mh-quick-actions button{font-size:11.5px;border-radius:999px;padding:2px 10px;cursor:pointer;color:#c4b5fd;background:rgba(168,85,247,.12);border:1px solid rgba(168,85,247,.45);}\n` +
    `\t\t\t.mh-quick-actions button:hover{background:rgba(168,85,247,.24);}\n` +
    `\t\t\t.mh-llm-hint{font-size:11px;color:#7f8897;padding:6px 2px 0;line-height:1.5;}\n` +
    `\t\t\t.goalbar-active.wizard{position:relative;overflow:hidden;}\n` +
    `\t\t\t.goalbar-active.wizard::after{content:"";position:absolute;left:-45%;bottom:0;height:2px;width:45%;border-radius:2px;background:linear-gradient(90deg,transparent,#a855f7,#c084fc,transparent);animation:mhWizSweep 1.7s linear infinite;}\n` +
    `\t\t\t@keyframes mhWizSweep{0%{left:-45%;}100%{left:100%;}}\n` +
    `\t\t\t.goalbar-active.wizard .goalbar-detail.mh-wiz-wait{color:#34d399;font-weight:600;}\n` +
    `\t\t\t#mh-code-loop-modal{position:fixed;inset:0;z-index:2147483500;display:flex;align-items:center;justify-content:center;background:rgba(15,17,21,.72);backdrop-filter:blur(3px);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}\n` +
    `\t\t\t#mh-code-loop-modal .cl-card{width:min(560px,92vw);background:#1b1e24;color:#e7e9ee;border:1px solid #333a45;border-radius:14px;padding:24px 26px;box-shadow:0 18px 60px rgba(0,0,0,.5);}\n` +
    `\t\t\t#mh-code-loop-modal h2{margin:0 0 6px;font-size:17px;font-weight:700;}\n` +
    `\t\t\t#mh-code-loop-modal .cl-sub{margin:0 0 16px;font-size:12px;color:#9aa3b2;}\n` +
    `\t\t\t#mh-code-loop-modal .cl-env-note{font-size:11.5px;color:#8b93a1;background:#11141a;border:1px solid #262c35;border-radius:8px;padding:7px 10px;margin-bottom:12px;}\n` +
    `\t\t\t#mh-code-loop-modal .cl-env-note code{color:#8fd0ff;}\n` +
    `\t\t\t#mh-code-loop-modal label{display:block;font-size:12px;color:#9aa3b2;margin:10px 0 4px;}\n` +
    `\t\t\t#mh-code-loop-modal textarea,#mh-code-loop-modal input,#mh-code-loop-modal select{width:100%;box-sizing:border-box;background:#11141a;border:1px solid #2b313b;border-radius:7px;color:#e7e9ee;padding:8px 10px;font-size:13px;font-family:inherit;}\n` +
    `\t\t\t#mh-code-loop-modal .cl-models{display:flex;gap:10px;}\n` +
    `\t\t\t#mh-code-loop-modal .cl-models>div{flex:1;min-width:0;}\n` +
    `\t\t\t#mh-code-loop-modal .cl-model-note{font-size:11px;color:#7f8897;margin-top:4px;line-height:1.5;}\n` +
    `\t\t\t#mh-code-loop-modal .cl-model-note.bad{color:#f87171;}\n` +
    `\t\t\t#mh-code-loop-modal textarea{min-height:70px;resize:vertical;}\n` +
    `\t\t\t#mh-code-loop-modal .cl-row{display:flex;gap:10px;justify-content:flex-end;margin-top:18px;}\n` +
    `\t\t\t#mh-code-loop-modal button{font-size:13px;border-radius:8px;padding:8px 16px;cursor:pointer;border:1px solid transparent;}\n` +
    `\t\t\t#mh-code-loop-modal .cl-cancel{background:#2b313b;color:#d8dde6;border-color:#3a414d;}\n` +
    `\t\t\t#mh-code-loop-modal .cl-start{background:#a855f7;color:#fff;}\n` +
    `\t\t\t#mh-code-loop-modal details.cl-adv{margin-top:12px;border-top:1px dashed #333a45;padding-top:10px;}\n` +
    `\t\t\t#mh-code-loop-modal details.cl-adv summary{cursor:pointer;font-size:12px;color:#8b93a1;user-select:none;outline:none;}\n` +
    `\t\t\t#mh-code-loop-modal details.cl-adv[open] summary{margin-bottom:6px;}\n` +
    `\t\t\t#mh-code-loop-modal .cl-card{animation:mhClPop .18s ease-out;}\n` +
    `\t\t\t@keyframes mhClPop{from{opacity:0;transform:scale(.96) translateY(6px);}to{opacity:1;transform:none;}}\n` +
    `\t\t\t#mh-code-loop-modal .cl-presets{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 10px;}\n` +
    `\t\t\t#mh-code-loop-modal .cl-preset{font-size:11.5px;border-radius:14px;padding:4px 10px;cursor:pointer;color:#c4b5fd;background:rgba(168,85,247,.10);border:1px solid rgba(168,85,247,.35);}\n` +
    `\t\t\t#mh-code-loop-modal .cl-preset:hover{background:rgba(168,85,247,.2);}\n` +
    `\t\t\t#mh-code-loop-modal .cl-start:disabled{opacity:.45;cursor:not-allowed;}\n` +
    `\t\t\t#mh-code-loop-modal .cl-start.loading{pointer-events:none;}\n` +
    `\t\t\t#mh-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483600;background:#181b22;color:#e7e9ee;border:1px solid #333a45;border-radius:10px;padding:10px 16px;font-size:13px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5);animation:mhClPop .18s ease-out;}\n` +
    `\t\t\t#mh-loop-stack{position:fixed;left:14px;bottom:14px;z-index:2147483540;display:none;flex-direction:column-reverse;align-items:flex-start;gap:6px;max-height:70vh;}\n` +
    `\t\t\t.mh-loop-pill{position:relative;display:flex;align-items:center;gap:7px;height:30px;max-width:min(340px,80vw);padding:0 12px;border-radius:999px;background:rgba(24,26,32,.9);backdrop-filter:blur(8px);border:1px solid #333a45;color:#e7e9ee;font-size:12px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45);cursor:pointer;animation:mhClPop .2s ease-out;overflow:hidden;}\n` +
    `\t\t\t.mh-loop-pill .lp-name{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9aa3b2;font-size:11px;flex:none;}\n` +
    `\t\t\t.mh-loop-pill .lp-text{white-space:nowrap;}\n` +
    `\t\t\t.mh-loop-pill .lp-dot{width:8px;height:8px;border-radius:50%;background:#a855f7;flex:none;}\n` +
    `\t\t\t.mh-loop-pill.running .lp-dot{animation:mhPulse 1.1s ease-in-out infinite;}\n` +
    `\t\t\t.mh-loop-pill.done .lp-dot{background:#34d399;}\n` +
    `\t\t\t.mh-loop-pill.stopped .lp-dot{background:#f87171;}\n` +
    `\t\t\t.mh-loop-pill .lp-bar{position:absolute;left:0;bottom:0;height:3px;border-radius:999px;background:linear-gradient(90deg,#a855f7,#7c3aed);transition:width .4s ease;}\n` +
    `\t\t\t.mh-loop-pop{position:fixed;left:14px;bottom:52px;z-index:2147483530;width:280px;max-height:60vh;overflow:auto;background:#1b1e24;color:#e7e9ee;border:1px solid #333a45;border-radius:12px;padding:12px 14px;font-size:12px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5);animation:mhClPop .18s ease-out;}\n` +
    `\t\t\t.mh-loop-pop .sc-title{display:flex;align-items:center;gap:6px;font-weight:600;margin-bottom:6px;}\n` +
    `\t\t\t.mh-loop-pop .sc-line{color:#9aa3b2;line-height:1.6;}\n` +
    `\t\t\t.mh-loop-pop .sc-ok{color:#34d399;}\n` +
    `\t\t\t.mh-loop-pop .sc-bad{color:#f87171;}\n` +
    `\t\t\t#mh-code-loop-modal.closing{opacity:0;transition:opacity .15s ease;}\n` +
    `\t\t\t@keyframes mhPulse{0%,100%{opacity:1;}50%{opacity:.3;}}\n` +
    `\t\t</style>\n` +
    `\t\t<script id="pi-loop-modes-script">\n` +
    `\t\t(function(){try{\n` +
    `\t\t\tfunction replaceText(root,from,to){try{var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null,false),n;while(n=w.nextNode()){if(n.nodeValue&&n.nodeValue.indexOf(from)!==-1)n.nodeValue=n.nodeValue.split(from).join(to);}}catch(e){}}\n` +
    `\t\t\t// LLM loop（pi 目标模式 2.0）里审查者就是主对话本身，没有独立的评审模型配置；\n` +    `\t\t\t// 这里补一个「评审模型」胶囊：显示主对话当前模型，点击打开输入框下方的模型选择器去切换。\n` +
    `\t\t\tfunction composerModelBtn(){return document.querySelector('.composer-tools-left .dropdown.left > button.chip');}\n` +
    `\t\t\tfunction ensureQuickActions(slot){\n` +
    `\t\t\t\tvar opts=slot.querySelector('.goalbar-opts');if(!opts||opts.querySelector('.mh-quick-actions'))return;\n` +
    `\t\t\t\tvar q=document.createElement('div');q.className='mh-quick-actions';\n` +
    `\t\t\t\tq.innerHTML='<button type="button" title="启动受控代码 Loop（validator 门禁）">代码 loop</button><button type="button" title="查看 Loop 进度、工具调用，暂停/继续">任务台</button>';\n` +
    `\t\t\t\tq.children[0].addEventListener('click',function(e){e.stopPropagation();openModal();});\n` +
    `\t\t\t\tq.children[1].addEventListener('click',function(e){e.stopPropagation();if(window.__mhOpenTask)window.__mhOpenTask();});\n` +
    `\t\t\t\topts.appendChild(q);\n` +
    `\t\t\t}\n` +
    `\t\t\tfunction ensureReviewChip(slot){\n` +
    `\t\t\t\tvar opts=slot.querySelector('.goalbar-opts');if(!opts)return;\n` +
    `\t\t\t\tvar mb=composerModelBtn(),name=mb?((mb.textContent||'').trim()||'—'):'—';\n` +
    `\t\t\t\tvar chip=opts.querySelector('.mh-review-chip');\n` +
    `\t\t\t\tif(!chip){\n` +
    `\t\t\t\t\tvar wrap=document.createElement('div');wrap.className='dropdown right dd-up mh-review-wrap';\n` +
    `\t\t\t\t\tchip=document.createElement('button');chip.type='button';chip.className='chip mh-review-chip';\n` +
    `\t\t\t\t\tchip.title='评审模型＝主对话当前模型（LLM loop 由主对话审查每轮结果）。点击打开输入框下方的模型选择器切换；切换后本对话后续聊天也用这个模型。';\n` +
    `\t\t\t\t\tchip.innerHTML='<span class="goalbar-opt"><span class="goalbar-opt-label">评审模型:</span><b class="mh-review-name"></b></span>';\n` +
    `\t\t\t\t\tchip.addEventListener('click',function(e){e.stopPropagation();var b=composerModelBtn();if(b)b.click();});\n` +
    `\t\t\t\t\twrap.appendChild(chip);\n` +
    `\t\t\t\t\tvar first=opts.querySelector('.dropdown');opts.insertBefore(wrap,first?first.nextSibling:opts.firstChild);\n` +
    `\t\t\t\t}\n` +
    `\t\t\t\tvar nb=chip.querySelector('.mh-review-name');if(nb&&nb.textContent!==name)nb.textContent=name;\n` +
    `\t\t\t\tvar exec='';opts.querySelectorAll('.goalbar-opt').forEach(function(o){var l=o.querySelector('.goalbar-opt-label');if(l&&/执行模型/.test(l.textContent||'')){var bb=o.querySelector('b');exec=bb?(bb.textContent||'').trim():'';}});\n` +
    `\t\t\t\tvar same=!exec||exec==='使用主模型'||exec===name;\n` +
    `\t\t\t\tvar warn=slot.querySelector('.mh-llm-same');\n` +
    `\t\t\t\tif(same&&!warn){warn=document.createElement('div');warn.className='mh-llm-hint mh-llm-same';warn.style.color='#fbbf24';warn.textContent='执行模型与评审模型相同（自己审自己），建议给「执行模型」选另一家的模型。';slot.appendChild(warn);}\n` +
    `\t\t\t\telse if(!same&&warn){warn.remove();}\n` +
    `\t\t\t}\n` +
    `\t\t\tfunction relabel(){\n` +
    `\t\t\t\ttry{\n` +
    `\t\t\t\t\tdocument.querySelectorAll('.goalbar-hint span').forEach(function(s){if((s.textContent||'').trim()==='目标')s.textContent='LLM loop';});\n` +
    `\t\t\t\t\tvar hintBtn=document.querySelector('.goalbar-hint');if(hintBtn){hintBtn.title='LLM loop：由 AI 自己判断是否完成，适合开放式任务（可能提前结束）';if(!hintBtn.__mhBound){hintBtn.__mhBound=true;hintBtn.addEventListener('click',function(){setTimeout(tick,60);setTimeout(tick,300);});}}\n` +
    `\t\t\t\t\tvar inp=document.querySelector('.goalbar-input');\n` +
    `\t\t\t\t\tif(inp&&/输入要达成的目标/.test(inp.placeholder||''))inp.placeholder='描述你想让 AI 完成的事…';\n` +
    `\t\t\t\t\tvar slot=document.querySelector('.goalbar-slot');\n` +
    `\t\t\t\t\tif(slot){\n` +
    `\t\t\t\t\t\tslot.querySelectorAll('button').forEach(function(b){var t=(b.textContent||'').trim();if(t==='提炼')b.textContent='帮我细化';else if(t==='发送')b.textContent='开始';});\n` +
    `\t\t\t\t\t\treplaceText(slot,'调研模型','规划模型');replaceText(slot,'细化模型','规划模型');replaceText(slot,'最大轮数','最多尝试');\n` +
    `\t\t\t\t\t\tvar wc=document.querySelector('.goalbar-active.wizard .goalbar-chip');if(wc&&(wc.textContent||'').indexOf('轮')!==-1)wc.textContent=wc.textContent.replace('轮','题');\n` +
    `\t\t\t\t\t\tvar wa=document.querySelector('.goalbar-active.wizard');\n` +
    `\t\t\t\t\t\tif(wa){var det=wa.querySelector('.goalbar-detail');\n` +
    `\t\t\t\t\t\t\tif(det){var tx=(det.textContent||'').trim();var mm=tx.match(/第\\s*(\\d+)\\s*题/);\n` +
    `\t\t\t\t\t\t\t\tif(/请回答/.test(tx)&&mm){if(det.textContent!=='等你选择第 '+mm[1]+' 题')det.textContent='等你选择第 '+mm[1]+' 题';det.classList.add('mh-wiz-wait');}\n` +
    `\t\t\t\t\t\t\t\telse if(/调研中/.test(tx)){det.classList.remove('mh-wiz-wait');if(det.textContent!=='AI 正在调研，请稍候…')det.textContent='AI 正在调研，请稍候…';}\n` +
    `\t\t\t\t\t\t\t}\n` +
    `\t\t\t\t\t\t}\n` +
    `\t\t\t\t\t\tensureReviewChip(slot);\n` +
    `\t\t\t\t\t\tensureQuickActions(slot);\n` +
    `\t\t\t\t\t\tif(!slot.querySelector('.goalbar')){slot.querySelectorAll('.mh-llm-hint').forEach(function(h){h.remove();});}\n` +
    `\t\t\t\t\t\tif(slot.querySelector('.goalbar')&&!slot.querySelector('.mh-llm-hint:not(.mh-llm-same)')){\n` +
    `\t\t\t\t\t\t\tvar d=document.createElement('div');d.className='mh-llm-hint';d.textContent='LLM loop：由 AI 自己判断是否完成，可能提前结束；需要严格验收请点旁边的「代码 loop」。';\n` +
    `\t\t\t\t\t\t\tslot.appendChild(d);\n` +
    `\t\t\t\t\t\t}\n` +
    `\t\t\t\t\t}\n` +
    `\t\t\t\t}catch(e){}\n` +
    `\t\t\t}\n` +
    `\t\t\tfunction sendPrompt(text){\n` +
    `\t\t\t\ttry{\n` +
    `\t\t\t\t\tvar ta=document.querySelector('textarea[placeholder^="给 pi 发送消息"]');\n` +
    `\t\t\t\t\tif(!ta){return false;}\n` +
    `\t\t\t\t\tvar setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;\n` +
    `\t\t\t\t\tsetter.call(ta,text);\n` +
    `\t\t\t\t\tta.dispatchEvent(new Event('input',{bubbles:true}));\n` +
    `\t\t\t\t\tta.focus();\n` +
    `\t\t\t\t\tsetTimeout(function(){ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));},200);\n` +
    `\t\t\t\t\treturn true;\n` +
    `\t\t\t\t}catch(e){return false;}\n` +
    `\t\t\t}\n` +
    `\t\t\tfunction escapeHtml(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;}\n` +
    `\t\t\tfunction showToast(msg){var t=document.getElementById('mh-toast');if(!t){t=document.createElement('div');t.id='mh-toast';document.body.appendChild(t);}t.textContent=msg;t.style.display='block';clearTimeout(t.__tm);t.__tm=setTimeout(function(){t.style.display='none';},2600);}\n` +
    `\t\t\tvar __mhRuns={},__mhOpenRunId=null,__mhDismissed={};\n` +
    `\t\t\tfunction hidePop(){var p=document.getElementById('mh-loop-pop');if(p)p.remove();window.__mhPillOpen=false;__mhOpenRunId=null;}\n` +
    `\t\t\tfunction ensureStack(){var s=document.getElementById('mh-loop-stack');if(!s){s=document.createElement('div');s.id='mh-loop-stack';document.body.appendChild(s);}return s;}\n` +
    `\t\t\tfunction pillFor(runId){var s=document.getElementById('mh-loop-stack');return s?s.querySelector('.mh-loop-pill[data-run="'+runId+'"]'):null;}\n` +
    `\t\t\tfunction positionPop(){var p=document.getElementById('mh-loop-pop'),s=document.getElementById('mh-loop-stack');if(!p||!s)return;var r=s.getBoundingClientRect();p.style.bottom=Math.max(40,Math.round(window.innerHeight-r.top+8))+'px';}\n` +
    `\t\t\tfunction renderPop(st){\n` +
    `\t\t\t\tvar p=document.getElementById('mh-loop-pop');if(!p||!st)return;\n` +
    `\t\t\t\tvar v=st.lastVerdict==='pass'?'<span class="sc-ok">已通过</span>':(st.lastVerdict==='fail'?'<span class="sc-bad">未通过</span>':'—');\n` +
    `\t\t\t\tvar ok=st.status==='done', stop=st.status==='stopped';\n` +
    `\t\t\t\tp.innerHTML='<div class="sc-title"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'+(ok?'#34d399':stop?'#f87171':'#a855f7')+'"></span>'+(ok?'代码 loop 已完成':stop?'代码 loop 已停止':'代码 loop 运行中')+'</div>'+\n` +
    `\t\t\t\t\t'<div class="sc-line">项目：'+escapeHtml(st.project||'未知')+'</div>'+\n` +
    `\t\t\t\t\t'<div class="sc-line">第 '+st.round+'/'+st.maxRounds+' 轮 · '+escapeHtml(String(st.stage||''))+' · 校验 '+v+'</div>'+\n` +
    `\t\t\t\t\t(st.models?('<div class="sc-line">执行 '+escapeHtml(st.models.main||'—')+' · 规划 '+escapeHtml(st.models.planner||'—')+' · 评审 '+escapeHtml(st.models.reviewer||'不评审')+'</div>'):'')+\n` +
    `\t\t\t\t\t(st.goal?('<div class="sc-line" style="color:#6b7280">'+escapeHtml(st.goal)+'</div>'):'');\n` +
    `\t\t\t}\n` +
    `\t\t\tfunction togglePop(runId){\n` +
    `\t\t\t\tif(__mhOpenRunId===runId){hidePop();return;}\n` +
    `\t\t\t\tvar st=__mhRuns[runId];if(!st)return;\n` +
    `\t\t\t\thidePop();\n` +
    `\t\t\t\t__mhOpenRunId=runId;window.__mhPillOpen=true;\n` +
    `\t\t\t\tvar p=document.createElement('div');p.id='mh-loop-pop';p.className='mh-loop-pop';document.body.appendChild(p);\n` +
    `\t\t\t\trenderPop(st);positionPop();\n` +
    `\t\t\t}\n` +
    `\t\t\tfunction makePill(runId){\n` +
    `\t\t\t\tvar el=document.createElement('div');el.className='mh-loop-pill';el.setAttribute('data-run',runId);\n` +
    `\t\t\t\tel.innerHTML='<span class="lp-dot"></span><span class="lp-name"></span><span class="lp-text">Loop …</span><span class="lp-bar"></span>';\n` +
    `\t\t\t\tel.addEventListener('click',function(){togglePop(runId);});\n` +
    `\t\t\t\treturn el;\n` +
    `\t\t\t}\n` +
    `\t\t\tfunction updatePill(el,st){\n` +
    `\t\t\t\tvar ok=st.status==='done',stop=st.status==='stopped';\n` +
    `\t\t\t\tel.className='mh-loop-pill '+(ok?'done':stop?'stopped':'running');\n` +
    `\t\t\t\tvar nm=el.querySelector('.lp-name');\n` +
    `\t\t\t\tif(nm){nm.textContent=st.project||'';nm.style.display=st.project?'inline':'none';}\n` +
    `\t\t\t\tvar v=st.lastVerdict==='pass'?'通过':(st.lastVerdict==='fail'?'未通过':'—');\n` +
    `\t\t\t\tel.querySelector('.lp-text').textContent=(ok?'完成 ✓':stop?'停止 ✗':(st.round+'/'+st.maxRounds+' · '+v));\n` +
    `\t\t\t\tvar bar=el.querySelector('.lp-bar');if(bar)bar.style.width=(ok||stop?'100%':(Math.min(100,Math.round((st.round||1)/(st.maxRounds||1)*100))+'%'));\n` +
    `\t\t\t\tel.title=(st.goal||'')+(st.project?('（'+st.project+'）'):'');\n` +
    `\t\t\t}\n` +
    `\t\t\tfunction schedulePoll(ms){var s=document.getElementById('mh-loop-stack');if(!s)return;clearTimeout(s.__poll);s.__poll=setTimeout(pollStatus,ms);}\n` +
    `\t\t\tfunction pollStatus(){\n` +
    `\t\t\t\tvar stack=ensureStack();\n` +
    `\t\t\t\tif(stack.__busy)return;stack.__busy=true;\n` +
    `\t\t\t\tif(document.hidden){stack.__busy=false;schedulePoll(30000);return;}\n` +
    `\t\t\t\tvar tok=new URLSearchParams(location.search).get('token')||'';\n` +
    `\t\t\t\tfetch('/api/mini-harness/runs'+(tok?('?token='+encodeURIComponent(tok)):''),{headers:tok?{'x-pi-token':tok}:{}})\n` +
    `\t\t\t\t\t.then(function(r){return r.ok?r.json():null;})\n` +
    `\t\t\t\t\t.then(function(j){\n` +
    `\t\t\t\t\t\tstack.__busy=false;\n` +
    `\t\t\t\t\t\tvar list=(j&&Array.isArray(j.runs))?j.runs:[];\n` +
    `\t\t\t\t\t\tif(!list.length){stack.style.display='none';stack.innerHTML='';__mhRuns={};hidePop();schedulePoll(10000);return;}\n` +
    `\t\t\t\t\t\tvar seen={},anyActive=false;\n` +
    `\t\t\t\t\t\tlist.forEach(function(st){\n` +
    `\t\t\t\t\t\t\tif(!st||!st.runId||__mhDismissed[st.runId])return;\n` +
    `\t\t\t\t\t\t\tseen[st.runId]=1;__mhRuns[st.runId]=st;\n` +
    `\t\t\t\t\t\t\tvar el=pillFor(st.runId);\n` +
    `\t\t\t\t\t\t\tif(!el){el=makePill(st.runId);stack.appendChild(el);}\n` +
    `\t\t\t\t\t\t\tupdatePill(el,st);\n` +
    `\t\t\t\t\t\t\tvar ok=st.status==='done',stop=st.status==='stopped';\n` +
    `\t\t\t\t\t\t\tif(ok||stop){\n` +
    `\t\t\t\t\t\t\t\tif(!el.__hide){el.__hide=setTimeout(function(){__mhDismissed[st.runId]=1;delete __mhRuns[st.runId];if(__mhOpenRunId===st.runId)hidePop();if(el.parentNode)el.remove();var s2=document.getElementById('mh-loop-stack');if(s2&&!s2.children.length)s2.style.display='none';},8000);}\n` +
    `\t\t\t\t\t\t\t}else{anyActive=true;clearTimeout(el.__hide);el.__hide=null;}\n` +
    `\t\t\t\t\t\t});\n` +
    `\t\t\t\t\t\tArray.prototype.slice.call(stack.children).forEach(function(el){if(!seen[el.getAttribute('data-run')])el.remove();});\n` +
    `\t\t\t\t\t\tif(stack.children.length){stack.style.display='flex';}else{stack.style.display='none';}\n` +
    `\t\t\t\t\t\tif(__mhOpenRunId&&__mhRuns[__mhOpenRunId]){renderPop(__mhRuns[__mhOpenRunId]);positionPop();}else if(__mhOpenRunId){hidePop();}\n` +
    `\t\t\t\t\t\tschedulePoll(anyActive?3000:10000);\n` +
    `\t\t\t\t\t}).catch(function(){stack.__busy=false;schedulePoll(8000);});\n` +
    `\t\t\t}\n` +
    `\t\t\twindow.addEventListener('resize',function(){if(__mhOpenRunId)positionPop();});\n` +
    `\t\t\tfunction showStatusCard(){ensureStack();pollStatus();}\n` +
    `\t\t\tfunction openModal(){\n` +
    `\t\t\t\tif(document.getElementById('mh-code-loop-modal'))return;\n` +
    `\t\t\t\tvar o=document.createElement('div');o.id='mh-code-loop-modal';\n` +
    `\t\t\t\to.innerHTML='<div class="cl-card"><h2>代码 loop（自动验证）</h2><p class="cl-sub">说清想完成什么，系统会自动检查是否完成；不通过会带着原因重试，中途关页面也能回来继续。</p>'+\n` +
    `\t\t\t\t\t'<div class="cl-env-note">环境：连集群需 <code>kubectl</code> + <code>kubeconfig</code>；检查命令留空会自动准备。</div>'+\n` +
    `\t\t\t\t\t'<div class="cl-presets">'+\n` +
    `\t\t\t\t\t'<button class="cl-preset" data-goal="跑 harness 的 perf-012g gate，生成 db_gap_gate.json 且 gate_state=ESTIMATE_READY" data-crit="db_gap_gate.json 存在且 gate_state=ESTIMATE_READY">harness 门禁任务</button>'+\n` +
    `\t\t\t\t\t'<button class="cl-preset" data-goal="在当前目录创建 result.txt，内容为 DONE" data-crit="result.txt 存在且内容为 DONE">创建并验收文件</button>'+\n` +
    `\t\t\t\t\t'<button class="cl-preset" data-goal="运行测试直到全部通过" data-crit="测试命令退出码为 0">跑测试直到通过</button>'+\n` +
    `\t\t\t\t\t'</div>'+\n` +
    `\t\t\t\t\t'<label>你想完成什么？</label><textarea id="cl-goal" placeholder="例如：用 harness 跑 perf-012g gate，生成 db_gap_gate.json，gate_state 为 ESTIMATE_READY"></textarea>'+\n` +
    `\t\t\t\t\t'<label>怎么算完成？（可选，写你能检查的条件）</label><textarea id="cl-criteria" style="min-height:54px" placeholder="例如：文件存在且 gate_state=ESTIMATE_READY；或命令 python3 check.py 返回 0"></textarea>'+\n` +
    `\t\t\t\t\t'<div class="cl-models"><div><label>规划模型</label><select id="cl-planner"><option value="">自动（跨厂商）</option></select></div>'+\n` +
    `\t\t\t\t\t'<div><label>评审模型</label><select id="cl-reviewer"><option value="">自动（跨厂商）</option><option value="__none__">不评审（只看检查命令）</option></select></div></div>'+\n` +
    `\t\t\t\t\t'<div class="cl-model-note" id="cl-model-note">执行模型＝对话框当前所选模型；规划、评审需与执行模型及彼此属于不同厂商。</div>'+\n` +
    `\t\t\t\t\t'<details class="cl-adv"><summary>高级选项</summary>'+\n` +
    `\t\t\t\t\t'<label>检查命令（留空=自动准备）</label><input id="cl-cmd" placeholder="留空则由系统根据目标准备，例如 python3 validate.py" />'+\n` +
    `\t\t\t\t\t'<label>产物目录（可选，逗号分隔）</label><input id="cl-roots" placeholder="/external/runs/xxx" />'+\n` +
    `\t\t\t\t\t'<label>最多尝试次数</label><input id="cl-rounds" type="number" value="5" min="1" max="20" />'+\n` +
    `\t\t\t\t\t'</details>'+\n` +
    `\t\t\t\t\t'<div class="cl-row"><button class="cl-cancel">取消</button><button class="cl-start" disabled>启动代码 loop</button></div></div>';\n` +
    `\t\t\t\tdocument.body.appendChild(o);\n` +
    `\t\t\t\tvar goal=o.querySelector('#cl-goal'),start=o.querySelector('.cl-start');\n` +
    `\t\t\t\tvar selP=o.querySelector('#cl-planner'),selR=o.querySelector('#cl-reviewer'),note=o.querySelector('#cl-model-note'),noteDefault=note.textContent;\n` +
    `\t\t\t\tfunction famOf(sel){var op=sel.options[sel.selectedIndex];return op?(op.getAttribute('data-family')||''):'';}\n` +
    `\t\t\t\tfunction modelConflict(){var a=famOf(selP),b=famOf(selR);return !!(a&&b&&a===b);}\n` +
    `\t\t\t\tfunction sync(){var c=modelConflict();note.textContent=c?('规划和评审都是 '+famOf(selP)+' 家的模型，请换一个不同厂商的'):noteDefault;note.classList.toggle('bad',c);start.disabled=!(goal.value||'').trim()||c;}\n` +
    `\t\t\t\tselP.addEventListener('change',sync);selR.addEventListener('change',sync);\n` +
    `\t\t\t\t(function(){var tok=new URLSearchParams(location.search).get('token')||'';\n` +
    `\t\t\t\t\tfetch('/api/mini-harness/models'+(tok?('?token='+encodeURIComponent(tok)):''),{headers:tok?{'x-pi-token':tok}:{}}).then(function(r){return r.ok?r.json():null;}).then(function(j){\n` +
    `\t\t\t\t\t\tvar list=(j&&Array.isArray(j.models))?j.models:[];\n` +
    `\t\t\t\t\t\tlist.forEach(function(m){[selP,selR].forEach(function(sel){var op=document.createElement('option');op.value=m.provider+'/'+m.id;op.textContent=m.id+'（'+m.family+'）';op.setAttribute('data-family',m.family);sel.appendChild(op);});});\n` +
    `\t\t\t\t\t\tif(!list.length){note.textContent='未读到模型列表，规划/评审将自动选择。';}\n` +
    `\t\t\t\t\t}).catch(function(){note.textContent='未读到模型列表，规划/评审将自动选择。';});\n` +
    `\t\t\t\t})();\n` +
    `\t\t\t\tgoal.addEventListener('input',sync);\n` +
    `\t\t\t\to.querySelectorAll('.cl-preset').forEach(function(b){b.addEventListener('click',function(){o.querySelector('#cl-goal').value=b.getAttribute('data-goal')||'';o.querySelector('#cl-criteria').value=b.getAttribute('data-crit')||'';sync();goal.focus();});});\n` +
    `\t\t\t\to.querySelector('.cl-cancel').addEventListener('click',function(){o.remove();});\n` +
    `\t\t\t\to.addEventListener('click',function(e){if(e.target===o)o.remove();});\n` +
    `\t\t\t\to.querySelector('.cl-start').addEventListener('click',function(){\n` +
    `\t\t\t\t\tvar g=(goal.value||'').trim();\n` +
    `\t\t\t\t\tif(!g){goal.focus();return;}\n` +
    `\t\t\t\t\tvar criteria=(o.querySelector('#cl-criteria').value||'').trim();\n` +
    `\t\t\t\t\tvar cmd=(o.querySelector('#cl-cmd').value||'').trim();\n` +
    `\t\t\t\t\tvar roots=(o.querySelector('#cl-roots').value||'').split(',').map(function(s){return s.trim();}).filter(Boolean);\n` +
    `\t\t\t\t\tvar rounds=parseInt(o.querySelector('#cl-rounds').value,10)||5;\n` +
    `\t\t\t\t\tvar p='用 loop_start 启动受控代码 Loop（自动验证）。\\ngoal='+JSON.stringify(g);\n` +
    `\t\t\t\t\tif(criteria)p+='\\n验收标准：'+criteria;\n` +
    `\t\t\t\t\tif(cmd){p+='\\nvalidateCmd='+JSON.stringify(cmd)+'（直接使用这个检查命令）';}\n` +
    `\t\t\t\t\telse{p+='\\n验收方式：如果当前工作区没有真正可用的 validate.py，请先根据目标和验收标准写一个 validate.py（必须真正检查，不能恒通过），然后用 validateCmd="python3 validate.py" 启动。';}\n` +
    `\t\t\t\t\tif(roots.length)p+='\\nartifactRoots='+JSON.stringify(roots);\n` +
    `\t\t\t\t\tvar pv=selP.value,rv=selR.value;\n` +
    `\t\t\t\t\tif(pv)p+='\\nplannerModel='+JSON.stringify(pv);\n` +
    `\t\t\t\t\tif(rv==='__none__')p+='\\nuseReviewer=false';else if(rv)p+='\\nreviewerModel='+JSON.stringify(rv);\n` +
    `\t\t\t\t\tif(pv||rv)p+='\\n若 loop_start 报模型家族冲突或无法解析模型，直接把报错原文告诉用户并停止，不要自行更换模型。';\n` +
    `\t\t\t\t\tp+='\\nmaxRounds='+rounds+'。然后 loop_plan 并直接完成工作，完成时调用 loop_done。不要向用户提问。';\n` +
    `\t\t\t\t\tstart.disabled=true;start.classList.add('loading');start.textContent='启动中…';\n` +
    `\t\t\t\t\tvar ok=sendPrompt(p);\n` +
    `\t\t\t\t\to.remove();\n` +
    `\t\t\t\t\tshowToast('已提交，AI 正在执行代码 loop');\n` +
    `\t\t\t\t\tshowStatusCard();\n` +
    `\t\t\t\t});\n` +
    `\t\t\t\tsetTimeout(function(){goal.focus();},80);\n` +
    `\t\t\t}\n` +
    `\t\t\tfunction ensureBtn(){\n` +
    `\t\t\t\ttry{\n` +
    `\t\t\t\t\tvar slot=document.querySelector('.goalbar-slot');if(!slot)return;\n` +
    `\t\t\t\t\t// 原生折叠行是悬浮在输入框上方的容器：把它变成三栏并列入口\n` +
    `\t\t\t\t\tvar row=slot.querySelector('.goalbar-collapsed')||slot;\n` +
    `\t\t\t\t\trow.classList.add('mh-loop-tabs');\n` +
    `\t\t\t\t\tvar expanded=!!slot.querySelector('.goalbar');\n` +
    `\t\t\t\t\trow.querySelectorAll('.mh-loop-tab').forEach(function(b){b.style.display=expanded?'none':'';});\n` +
    `\t\t\t\t\tif(expanded||row.querySelector('.mh-loop-tab'))return;\n` +
    `\t\t\t\t\tvar code=document.createElement('button');code.type='button';code.className='mh-loop-tab code';\n` +
    `\t\t\t\t\tcode.innerHTML='<span class="t">代码 loop</span><span class="d">validator 门禁，不过自动重试</span>';\n` +
    `\t\t\t\t\tcode.addEventListener('click',function(e){e.stopPropagation();openModal();});\n` +
    `\t\t\t\t\tvar task=document.createElement('button');task.type='button';task.className='mh-loop-tab task';\n` +
    `\t\t\t\t\ttask.innerHTML='<span class="t">任务台</span><span class="d">进度 · 工具调用 · 暂停</span>';\n` +
    `\t\t\t\t\ttask.addEventListener('click',function(e){e.stopPropagation();if(window.__mhOpenTask)window.__mhOpenTask();});\n` +
    `\t\t\t\t\trow.appendChild(code);row.appendChild(task);\n` +
    `\t\t\t\t}catch(e){}\n` +
    `\t\t\t}\n` +
    `\t\t\tfunction tick(){relabel();ensureBtn();}\n` +
    `\t\t\tif(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){setTimeout(tick,700);setTimeout(showStatusCard,900);});else setTimeout(tick,700);\n` +
    `\t\t\tsetTimeout(showStatusCard,900);\n` +
    `\t\t\tif(!window.__mhTickTimer){window.__mhTickTimer=setInterval(function(){if(document.hidden)return;tick();},3000);}\n` +
    `\t\t\tif(!window.__mhClickTick){window.__mhClickTick=true;document.addEventListener('click',function(){if(document.querySelector('.goalbar-opts'))setTimeout(relabel,300);},true);}\n` +
    `\t\t}catch(e){}})();\n` +
    `\t\t</script>\n\t`;
  if (!html.includes(loopMarker)) {
    html = html.replace("</head>", loopBlock + "</head>");
    fs.writeFileSync(htmlFile, html);
    log("已注入双 Loop 入口（LLM loop 改名 + 代码 loop 按钮）");
  } else {
    const re = /\t*<!-- HARDENED:loop-modes[\s\S]*?pi-loop-modes-script">[\s\S]*?<\/script>\n\t?/;
    const updated = html.replace(re, loopBlock);
    if (updated !== html) { fs.writeFileSync(htmlFile, updated); log("已更新双 Loop 入口"); }
    else log("双 Loop 入口已是最新（跳过）");
  }
} catch (e) {
  log("WARN: 双 Loop 入口注入失败", e.message);
}

// ---- 7g) 目标调研向导（帮我细化）：先问问题，别先翻工作区 ----
// 原版给向导挂了 read/ls/find/grep，并允许"先做 1-3 次只读检查"，实测会连续翻目录/读文件
// 40 秒才弹第一题。这里把工具裁到只剩 goal_ask，并把提示词改成"先问、不要探索"。幂等。
try {
  const gsFile = path.join(DIST, "goal-service.js");
  let gs = fs.readFileSync(gsFile, "utf8");
  const before = gs;
  const oldTools = 'tools: ["goal_ask", "read", "ls", "find", "grep"],';
  const newTools = 'tools: ["goal_ask"], /* HARDENED:wizard-ask-first */';
  if (gs.includes(oldTools)) gs = gs.split(oldTools).join(newTools);
  const oldGuide =
    "`- If you need to verify a specific file or directory in the workspace, do at most 1 to 3 quick read-only checks (read/ls/find/grep), then IMMEDIATELY call goal_ask. Never do exhaustive exploration or attempt the actual task during scoping.`, // eslint-disable-line max-len";
  const newGuide =
    "`- Call goal_ask FIRST: this session has no read/ls/find/grep tools. Base every question on the requirement and the conversation context above. Never attempt the actual task during scoping.`, // eslint-disable-line max-len";
  if (gs.includes(oldGuide)) gs = gs.split(oldGuide).join(newGuide);
  // 7g-2) 计划确认门禁：调研完不直接开跑，先给「计划大纲」让用户 check，确认后才输出 GOAL。
  const tailRe = /^ {8}`Once you have enough to write an unambiguous[\s\S]*?what you already know\.`, \/\/ eslint-disable-line max-len\n/m;
  const newTail = [
    "        'Once you have enough information, do NOT emit the goal yet: the plan MUST be approved by the user first.',",
    "        'PLAN CHECK (mandatory, never skip): call goal_ask one final time to present the plan outline and get explicit approval.',",
    "        '- question: begin with \"计划大纲：\" then one goal line and 2 to 6 numbered steps, each with how to verify, for example:',",
    "        '  计划大纲：',",
    "        '  目标：<一句话说清交付物与验收标准>',",
    "        '  步骤：1) <做什么> -- <怎么验证> 2) <做什么> -- <怎么验证>',",
    "        '  确认后开始执行。',",
    "        '- options, recommended first: \"开始执行：按上面的计划跑\" / \"我要修改：先调整目标或步骤\" / \"取消：不执行\"',",
    "        '- If the user picks 开始执行, reply with EXACTLY this format and nothing else (no preamble, no bullets):',",
    "        'GOAL: <one concrete, verifiable sentence describing the deliverable and its acceptance criteria>',",
    "        'STEPS:',",
    "        '1. <first step title> | <brief description / acceptance check>',",
    "        '2. <second step title> | <brief description / acceptance check>',",
    "        '(include 2 to 6 concrete, sequential steps for executing the goal)',",
    "        '- If the user picks 我要修改, ask what to change via goal_ask, apply it, then present the plan outline again.',",
    "        '- If the user picks 取消, reply with exactly CANCELLED and nothing else.',",
  ].join("\n") + "\n";
  if (!gs.includes("PLAN CHECK (mandatory")) gs = gs.replace(tailRe, newTail);
  // 7g-3) 取消语义：用户点「取消」或关掉对话框 => 只回 CANCELLED，不再自动设目标开跑。
  const rawAnchor = "const rawAssistantText = wizard.getLastAssistantText()?.trim() ?? \"\";";
  const rawPatched = rawAnchor + "\n            if (/^\\s*CANCELLED\\b/i.test(rawAssistantText)) { this.wizardCancelled = true; /* HARDENED:wizard-cancel */ }";
  if (gs.includes(rawAnchor) && !gs.includes("HARDENED:wizard-cancel")) gs = gs.split(rawAnchor).join(rawPatched);
  const cancelledZh = "\"(用户已取消调研，请直接给出你当前收敛的目标文本作为最终答案)\"";
  const cancelledEn = "\"(The user cancelled the survey — reply with your best-effort goal text as the final answer)\"";
  if (gs.includes(cancelledZh)) gs = gs.split(cancelledZh).join("\"(用户关闭了对话框，请直接回复 CANCELLED 结束调研)\"");
  if (gs.includes(cancelledEn)) gs = gs.split(cancelledEn).join("\"(The user dismissed the dialog — reply with exactly CANCELLED and end the survey)\"");
  const ok = gs.includes("HARDENED:wizard-ask-first") && gs.includes("Call goal_ask FIRST")
    && gs.includes("PLAN CHECK (mandatory") && gs.includes("HARDENED:wizard-cancel");
  if (gs !== before) { fs.writeFileSync(gsFile, gs); log("目标调研向导：先提问 + 计划确认门禁已生效"); }
  else log(ok ? "目标调研向导：已是先提问 + 计划确认（跳过）" : "WARN: 目标调研向导锚点未命中（pi-web-ui 可能升级，需重新适配）");
} catch (e) {
  log("WARN: 目标调研向导加固失败", e.message);
}

// ---- 7h) Loop 任务台后端：暂停/继续 + 执行者工具调用时间线 ----
// 目标模式 2.0 里执行者是独立对话，只有切过去才能看到工具调用；这里补：① pause/resume 消息；
// ② 读执行者 session jsonl 的只读接口，供任务台轮询工具调用。
try {
  const gsFile2 = path.join(DIST, "goal-service.js");
  let gs2 = fs.readFileSync(gsFile2, "utf8");
  const before2 = gs2;
  // 1) pause/resume 方法：插在 clearGoal 前
  const clearAnchor = "    /** Clear the active goal (cancels the review loop AND aborts a running\n     *  goal wizard — truly terminating its in-flight dialog + agent run). */\n    async clearGoal() {";
  const pauseMethods = [
    "    /** HARDENED:goal-pause 暂停：停掉当前执行回合，保留目标与产物，不再自动派下一轮。 */",
    "    async pauseGoal() {",
    "        const conv = this.host.activeConv();",
    "        const g = conv && conv.goal;",
    "        if (!conv || !g || !g.goal) return;",
    "        g.paused = true;",
    "        g.reviewing = false;",
    "        g.phase = \"paused\";",
    "        g.status = \"已暂停（点继续接着跑）\";",
    "        g.statusEn = \"Paused\";",
    "        this.emitGoalStatus();",
    "        const execId = conv.roleExec && conv.roleExec.convId;",
    "        if (execId) { try { await this.host.stopRoleAgent?.(execId); } catch { } }",
    "        this.host.emit({ type: \"notice\", level: \"info\", text: \"⏸ 已暂停：当前回合已停止，目标与产物保留。\", textEn: \"Paused: current turn stopped, goal and artifacts kept.\" });",
    "    }",
    "    /** HARDENED:goal-pause 继续：解除暂停并从当前轮次接着派活。 */",
    "    async resumeGoal() {",
    "        const conv = this.host.activeConv();",
    "        const g = conv && conv.goal;",
    "        if (!conv || !g || !g.goal || !g.paused) return;",
    "        g.paused = false;",
    "        g.phase = \"executing\";",
    "        g.status = \"继续执行…\";",
    "        this.emitGoalStatus();",
    "        this.host.emit({ type: \"notice\", level: \"info\", text: \"▶ 继续执行。\", textEn: \"Resumed.\" });",
    "        this.startDelegatedLoop(conv, conv.goalGeneration, g.goal);",
    "    }",
  ].join("\n") + "\n";
  if (!gs2.includes("HARDENED:goal-pause") && gs2.includes(clearAnchor)) {
    gs2 = gs2.replace(clearAnchor, pauseMethods + clearAnchor);
  }
  // 2) 循环顶部：暂停态不派活
  const loopHead = "            const g = conv.goal;\n            // quiesce（服务排空）：中途不再派单";
  const loopHeadNew = "            const g = conv.goal;\n            if (g.paused) { g.phase = \"paused\"; g.status = \"已暂停（点继续接着跑）\"; g.reviewing = false; this.emitGoalStatus(); return; }\n            // quiesce（服务排空）：中途不再派单";
  if (!gs2.includes("if (g.paused) { g.phase") && gs2.includes(loopHead)) gs2 = gs2.split(loopHead).join(loopHeadNew);
  // 3) 执行者被暂停停掉（canceled）→ 记为暂停而不是受阻
  const cancelBranch = "                if (outcome === \"gone\" || outcome === \"canceled\") {";
  const cancelBranchNew = "                if (conv.goal.paused) { conv.goal.phase = \"paused\"; conv.goal.status = \"已暂停（点继续接着跑）\"; conv.goal.reviewing = false; this.emitGoalStatus(); return; }\n" + cancelBranch;
  if (!gs2.includes("if (conv.goal.paused) { conv.goal.phase") && gs2.includes(cancelBranch)) gs2 = gs2.split(cancelBranch).join(cancelBranchNew);
  // 4) 执行者 sessionId 进 goal_status.roles：任务台据此找 session 文件
  const roleLine = "        g.roles = { ...g.roles, executor: { ...role, streaming, activity, activityEn } };";
  const roleLineNew = "        let __sid = null; try { __sid = this.host.getConv?.(execId)?.session?.sessionId ?? null; } catch { }\n" + roleLine.replace("{ ...role, streaming, activity, activityEn }", "{ ...role, streaming, activity, activityEn, sessionId: __sid }");
  if (!gs2.includes("sessionId: __sid") && gs2.includes(roleLine)) gs2 = gs2.split(roleLine).join(roleLineNew);
  if (gs2 !== before2) { fs.writeFileSync(gsFile2, gs2); log("任务台后端：pause/resume + 执行者 sessionId 已注入"); }
  else log(gs2.includes("HARDENED:goal-pause") ? "任务台后端：已是最新（跳过）" : "WARN: 任务台后端锚点未命中");

  // 5) ClientSession 代理
  const asFile = path.join(DIST, "agent-service.js");
  let as = fs.readFileSync(asFile, "utf8");
  const asAnchor = "    async setGoal(goalText, opts) {\n        return this.goalSvc.setGoal(goalText, opts);\n    }";
  const asProxy = asAnchor + "\n    async pauseGoal() {\n        return this.goalSvc.pauseGoal();\n    }\n    async resumeGoal() {\n        return this.goalSvc.resumeGoal();\n    }";
  if (!as.includes("async pauseGoal()") && as.includes(asAnchor)) { as = as.replace(asAnchor, asProxy); fs.writeFileSync(asFile, as); log("任务台后端：ClientSession.pauseGoal/resumeGoal 已注入"); }

  // 6) WS 消息分发
  const dhFile = path.join(DIST, "dispatch-domain-handlers.js");
  let dh = fs.readFileSync(dhFile, "utf8");
  const dhAnchor = "        case \"clear_goal\":\n            void cs.clearGoal();\n            return true;";
  const dhNew = dhAnchor + "\n        case \"pause_goal\":\n            void cs.pauseGoal();\n            return true;\n        case \"resume_goal\":\n            void cs.resumeGoal();\n            return true;";
  if (!dh.includes("case \"pause_goal\"") && dh.includes(dhAnchor)) { dh = dh.replace(dhAnchor, dhNew); fs.writeFileSync(dhFile, dh); log("任务台后端：pause_goal/resume_goal 消息已注册"); }
} catch (e) {
  log("WARN: 任务台后端注入失败", e.message);
}

// ---- 7i) Loop 任务台（前端）：目标条「任务台」按钮 + 右侧任务面板（进度 / 工具调用 / 暂停）----
try {
  let htmlTask = fs.readFileSync(htmlFile, "utf8");
  const taskMarker = "HARDENED:task-panel";
  const taskBlock =
    `\t\t<!-- ${taskMarker} Loop 任务台：进度、实时工具调用、暂停/继续/停止。 -->\n` +
    `\t\t<style id="mh-task-style">\n` +
    `\t\t\t#mh-task{position:fixed;top:0;right:0;height:100vh;width:min(460px,92vw);z-index:2147483560;display:none;flex-direction:column;background:#15181e;border-left:1px solid #2b313b;box-shadow:-18px 0 60px rgba(0,0,0,.5);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#e7e9ee;}\n` +
    `\t\t\t#mh-task.open{display:flex;}\n` +
    `\t\t\t#mh-task .tk-head{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid #262c35;}\n` +
    `\t\t\t#mh-task .tk-title{font-size:14px;font-weight:700;flex:1;}\n` +
    `\t\t\t#mh-task .tk-x{background:transparent;border:none;color:#8b93a1;font-size:18px;cursor:pointer;}\n` +
    `\t\t\t#mh-task .tk-body{padding:14px 16px;overflow:auto;flex:1;}\n` +
    `\t\t\t#mh-task .tk-goal{font-size:13px;line-height:1.6;background:#11141a;border:1px solid #262c35;border-radius:8px;padding:10px 12px;}\n` +
    `\t\t\t#mh-task .tk-meta{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0;font-size:11.5px;color:#9aa3b2;}\n` +
    `\t\t\t#mh-task .tk-chip{background:#1b1f26;border:1px solid #2b313b;border-radius:999px;padding:2px 9px;}\n` +
    `\t\t\t#mh-task .tk-steps{display:flex;gap:4px;margin:12px 0 14px;}\n` +
    `\t\t\t#mh-task .tk-step{flex:1;text-align:center;font-size:10.5px;color:#6b7280;padding-top:7px;border-top:3px solid #2b313b;}\n` +
    `\t\t\t#mh-task .tk-step.on{color:#c4b5fd;border-top-color:#a855f7;}\n` +
    `\t\t\t#mh-task .tk-step.done{color:#34d399;border-top-color:#34d399;}\n` +
    `\t\t\t#mh-task .tk-sec{font-size:11.5px;color:#7f8897;margin:14px 0 6px;display:flex;justify-content:space-between;}\n` +
    `\t\t\t#mh-task .tk-ev{border-left:2px solid #2b313b;padding:4px 0 6px 10px;margin-left:2px;font-size:12px;line-height:1.5;}\n` +
    `\t\t\t#mh-task .tk-ev .nm{color:#8fd0ff;font-weight:600;}\n` +
    `\t\t\t#mh-task .tk-ev .ar{color:#9aa3b2;word-break:break-all;}\n` +
    `\t\t\t#mh-task .tk-ev .out{color:#6b7280;font-size:11px;word-break:break-all;}\n` +
    `\t\t\t#mh-task .tk-ev.run{border-left-color:#a855f7;}\n` +
    `\t\t\t#mh-task .tk-ev.err{border-left-color:#f87171;}\n` +
    `\t\t\t#mh-task .tk-ev.ok{border-left-color:#34d399;}\n` +
    `\t\t\t#mh-task .tk-acts{display:flex;gap:8px;padding:12px 16px;border-top:1px solid #262c35;}\n` +
    `\t\t\t#mh-task .tk-btn{flex:1;font-size:12.5px;border-radius:8px;padding:8px 10px;cursor:pointer;border:1px solid #3a414d;background:#2b313b;color:#e7e9ee;}\n` +
    `\t\t\t#mh-task .tk-btn.pri{background:#a855f7;border-color:#a855f7;color:#fff;}\n` +
    `\t\t\t#mh-task .tk-btn.danger{background:transparent;border-color:#f87171;color:#f87171;}\n` +
    `\t\t\t#mh-task .tk-btn:disabled{opacity:.4;cursor:not-allowed;}\n` +
    `\t\t\t#mh-task .tk-empty{color:#7f8897;font-size:12.5px;line-height:1.7;padding:10px 0;}\n` +
    `\t\t</style>\n` +
    `\t\t<script id="mh-task-script">\n` +
    `\t\t(function(){try{\n` +
    `\t\t\t// 只读观测：挂住页面 WS，拿到服务端广播的 goal_status（不改任何业务数据）\n` +
    `\t\t\tif(!window.__mhWsHooked){var O=window.WebSocket;if(O){var H=function(u,p){var ws=new O(u,p);(window.__mhWsList=window.__mhWsList||[]).push(ws);try{ws.addEventListener('message',function(ev){try{var j=JSON.parse(ev.data);if(j&&j.type==='goal_status'){window.__mhGoal=j.status;if(window.__mhTaskTick)window.__mhTaskTick();}}catch(_){}});}catch(_){}return ws;};H.prototype=O.prototype;['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k){try{H[k]=O[k];}catch(_){}});window.WebSocket=H;window.__mhWsHooked=1;}}\n` +
    `\t\t\tfunction send(o){var L=window.__mhWsList||[];for(var i=L.length-1;i>=0;i--){try{if(L[i].readyState===1){L[i].send(JSON.stringify(o));return true;}}catch(_){}}return false;}\n` +
    `\t\t\tfunction tok(){return new URLSearchParams(location.search).get('token')||'';}\n` +
    `\t\t\tfunction esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}\n` +
    `\t\t\tfunction el(){var p=document.getElementById('mh-task');\n` +
    `\t\t\t\tif(!p){p=document.createElement('div');p.id='mh-task';p.innerHTML='<div class="tk-head"><span class="tk-title">Loop 任务台</span><button class="tk-x" title="关闭">✕</button></div><div class="tk-body"></div><div class="tk-acts"></div>';document.body.appendChild(p);p.querySelector('.tk-x').addEventListener('click',close);}\n` +
    `\t\t\t\treturn p;}\n` +
    `\t\t\tvar timer=null,evTimer=null,sessionId=null;\n` +
    `\t\t\tfunction open(){var p=el();p.classList.add('open');render();pollEvents();if(!evTimer)evTimer=setInterval(function(){if(p.classList.contains('open'))pollEvents();},1500);timer=setInterval(render,1500);}\n` +
    `\t\t\tfunction close(){var p=document.getElementById('mh-task');if(p)p.classList.remove('open');clearInterval(timer);timer=null;clearInterval(evTimer);evTimer=null;}\n` +
    `\t\t\twindow.__mhOpenTask=open;window.__mhTaskTick=function(){var p=document.getElementById('mh-task');if(p&&p.classList.contains('open'))render();};\n` +
    `\t\t\tfunction phaseOf(g){var ph=String(g.phase||'');var st=String(g.status||'');if(/暂停/.test(st)||ph==='paused')return 'paused';if(ph==='reviewing')return 'reviewing';if(ph==='executing')return 'executing';if(ph==='done'||/完成|通过/.test(st))return 'done';if(ph==='blocked'||ph==='exhausted')return 'blocked';if(g.wizard&&g.wizard.active)return 'surveying';return 'idle';}\n` +
    `\t\t\tfunction render(){var p=document.getElementById('mh-task');if(!p)return;var g=window.__mhGoal;var body=p.querySelector('.tk-body'),acts=p.querySelector('.tk-acts');\n` +
    `\t\t\t\tvar runsHtml='<div class="tk-sec"><span>代码 loop 运行</span></div><div id="mh-tk-runs"><div class="tk-empty">无</div></div>';\n` +
    `\t\t\t\tif(!g||(!g.goal&&!(g.wizard&&g.wizard.active))){body.innerHTML='<div class="tk-empty">当前没有进行中的 LLM loop。<br>在目标条里开始一个，或点「代码 loop」跑受控任务。</div>'+runsHtml;acts.innerHTML='';sessionId=null;fetchRuns();return;}\n` +
    `\t\t\t\tvar ph=phaseOf(g);var steps=[['调研','surveying'],['执行','executing'],['审查','reviewing'],['完成','done']];var idx={idle:-1,surveying:0,executing:1,reviewing:2,done:3,blocked:3,paused:-1}[ph];if(idx==null)idx=-1;\n` +
    `\t\t\t\tvar stepHtml='';steps.forEach(function(s,i){stepHtml+='<div class="tk-step '+(idx>i?'done':(idx===i?'on':''))+'">'+s[0]+'</div>';});\n` +
    `\t\t\t\tvar rounds=(g.round||0)+'/'+((g.maxRounds>0)?g.maxRounds:'不限');\n` +
    `\t\t\t\tbody.innerHTML='<div class="tk-goal">'+esc(g.goal||g.wizard&&g.wizard.draft||'')+'</div>'+\n` +
    `\t\t\t\t\t'<div class="tk-meta"><span class="tk-chip">'+esc(g.status||ph)+'</span><span class="tk-chip">轮次 '+rounds+'</span>'+(g.execModel?'<span class="tk-chip">执行 '+esc(g.execModel.split('/').pop())+'</span>':'')+(g.reviewModel?'<span class="tk-chip">评审 '+esc(g.reviewModel.split('/').pop())+'</span>':'')+'</div>'+\n` +
    `\t\t\t\t\t'<div class="tk-steps">'+stepHtml+'</div>'+\n` +
    `\t\t\t\t\t'<div class="tk-sec"><span>工具调用</span><span id="mh-tk-count"></span></div><div id="mh-tk-events"><div class="tk-empty">等待执行者动作…</div></div>'+runsHtml;\n` +
    `\t\t\t\tvar paused=ph==='paused'||/暂停/.test(String(g.status||''));\n` +
    `\t\t\t\tacts.innerHTML='<button class="tk-btn pri" data-act="pause">'+(paused?'继续':'暂停')+'</button><button class="tk-btn danger" data-act="stop">停止 Loop</button>';\n` +
    `\t\t\t\tacts.querySelector('[data-act=pause]').addEventListener('click',function(){send({type:paused?'resume_goal':'pause_goal'});});\n` +
    `\t\t\t\tacts.querySelector('[data-act=stop]').addEventListener('click',function(){if(confirm('停止这个 Loop？目标会被清除，产物保留。'))send({type:'clear_goal'});});\n` +
    `\t\t\t\tvar r=(g.roles&&g.roles.executor)||null;if(r&&r.sessionId){sessionId=r.sessionId;}else if(!r||!r.spawned){sessionId=null;}\n` +
    `\t\t\t\tfetchRuns();\n` +
    `\t\t\t}\n` +
    `\t\t\tvar runsBusy=false;\n` +
    `\t\t\tfunction fetchRuns(){var box=document.getElementById('mh-tk-runs');if(!box||runsBusy)return;runsBusy=true;var t=tok();\n` +
    `\t\t\t\tfetch('/api/mini-harness/runs'+(t?('?token='+encodeURIComponent(t)):''),{headers:t?{'x-pi-token':t}:{}}).then(function(x){return x.ok?x.json():null;}).then(function(j){\n` +
    `\t\t\t\t\tvar list=(j&&Array.isArray(j.runs))?j.runs:[];if(!list.length){box.innerHTML='<div class="tk-empty">无</div>';return;}\n` +
    `\t\t\t\t\tvar h='';list.forEach(function(r){var v=r.lastVerdict==='pass'?'通过':(r.lastVerdict==='fail'?'未通过':'—');var done=r.status!=='active';h+='<div class="tk-ev '+(done?'ok':'run')+'"><span class="nm">'+esc(r.project||'未知')+'</span> <span class="ar">第 '+r.round+'/'+r.maxRounds+' 轮 · '+esc(r.stage||'')+'</span><div class="out">'+(done?'已结束':'运行中')+' · 校验 '+v+'</div></div>';});box.innerHTML=h;\n` +
    `\t\t\t\t}).catch(function(){}).then(function(){runsBusy=false;});\n` +
    `\t\t\t}\n` +
    `\t\t\tfunction pollEvents(){var p=document.getElementById('mh-task');if(!p||!p.classList.contains('open'))return;var g=window.__mhGoal;var r=g&&g.roles&&g.roles.executor;var sid=(r&&r.sessionId)||sessionId;if(!sid)return;var t=tok();\n` +
    `\t\t\t\tfetch('/api/mini-harness/task?session='+encodeURIComponent(sid)+(t?('&token='+encodeURIComponent(t)):''),{headers:t?{'x-pi-token':t}:{}}).then(function(x){return x.ok?x.json():null;}).then(function(j){\n` +
    `\t\t\t\t\tif(!j||!Array.isArray(j.events))return;var box=document.getElementById('mh-tk-events');if(!box)return;var cnt=document.getElementById('mh-tk-count');if(cnt)cnt.textContent=j.events.length+' 次';\n` +
    `\t\t\t\t\tif(!j.events.length)return;\n` +
    `\t\t\t\t\tvar h='';j.events.slice().reverse().forEach(function(e){var cls=e.status==='running'?'run':(e.status==='error'?'err':'ok');var st=e.status==='running'?'运行中':(e.status==='error'?'失败':'完成'+(e.ms!=null?(' · '+e.ms+'ms'):''));h+='<div class="tk-ev '+cls+'"><span class="nm">'+esc(e.name)+'</span> <span class="ar">'+esc(e.arg)+'</span><div class="out">'+st+(e.out?(' · '+esc(e.out.slice(0,140))):'')+'</div></div>';});\n` +
    `\t\t\t\t\tbox.innerHTML=h;\n` +
    `\t\t\t\t}).catch(function(){});\n` +
    `\t\t\t}\n` +
    `\t\t}catch(e){try{console.error('[mh-task]',e);}catch(_){}}})();\n` +
    `\t\t</script>\n\t`;
  if (!htmlTask.includes(taskMarker)) {
    htmlTask = htmlTask.replace("</head>", taskBlock + "</head>");
    fs.writeFileSync(htmlFile, htmlTask);
    log("已注入 Loop 任务台");
  } else {
    const re = /\t*<!-- HARDENED:task-panel[\s\S]*?mh-task-script">[\s\S]*?<\/script>\n\t?/;
    const upd = htmlTask.replace(re, taskBlock);
    if (upd !== htmlTask) { fs.writeFileSync(htmlFile, upd); log("已更新 Loop 任务台"); }
    else log("Loop 任务台已是最新（跳过）");
  }
} catch (e) {
  log("WARN: Loop 任务台注入失败", e.message);
}

// ---- 8) 提示词模板：隐藏 25 个 pi 内置模板，灌入从 harness+Ku 沉淀的多个可直接用模板 ----
// 模板落在浏览器 localStorage['pi-web-ui:prompt-templates']。内置模板靠 {id,hidden:true} 隐藏；
// 自定义模板用完整 {id,icon,title,desc,prompt}。版本化 seed 标志 => 改内容后能重新应用。
// 内容沉淀自 5 个 workflow skill 的 SKILL.md + Ku「AI Loop 异步化任务跟踪表」里的真实启动 prompt。
// pi 自带 25 个内置模板 id（用于 hidden 标记，源自 bundle 的 ev 数组）
const BUILTIN_TPL_IDS = [
  "setup-matt-pocock-skills", "ask-matt", "grill-with-docs", "to-spec", "to-tickets",
  "implement", "code-review", "wayfinder", "prototype", "research",
  "improve-codebase-architecture", "diagnosing-bugs", "resolving-merge-conflicts", "triage", "wizard",
  "grill-me", "handoff", "to-questionnaire", "teach", "wait-what",
  "writing-for-agents", "codebase-design", "domain-modeling", "grilling", "tdd",
];
// 本插件管理的模板 id 全集（升级时先按这些 id 清掉旧条目再重灌，保留用户自建）
const MANAGED_TPL_IDS = [
  "inf-harness-start", "inf-prefill", "inf-cache-adapt", "inf-cache-loss",
  "inf-hitrate", "inf-cudaipc", "inf-kvcache-nextgen", "inf-runtime-loop",
];
// 从 harness + Ku 沉淀的可直接使用模板（task 级参数用 <尖括号> 占位，发送前替换）
const MANAGED_TPL = [
  {
    id: "inf-harness-start", icon: "🧭", title: "Harness 通用启动",
    desc: "infer-forge-harness 通用 AI Loop：先读规范、复用原子任务、每步 verify、留证据",
    prompt: "使用 inference-harness skill 启动一次推理服务 AI Loop。先用 icode 拉取 baidu/hac-aiacc/infer-forge-harness 并进入仓库，按顺序先读 AGENTS.md、目标 workflow 定义、task 合约、tasks/REGISTRY.yaml、catalog/tool_catalog.yaml、SKILL.md 与 validator，再动手。明确本次 workflow 与目标模型（如 deepseek-v4.1-flash）。优先复用 REGISTRY 已有原子任务，没有合适的才新增、新增后更新 REGISTRY 并重新生成 CATALOG。每步都要有明确 verify，以 validator 判定为准（返回码/PASS 字样/manifest 都不算通过）。每步产出 run id、artifact root、节点状态、validator 结论、Journal 路径、证据路径，并与 baseline 对比。失败保留原始证据，不打补丁绕过、不静默重试。安全红线：删除实例/资源、缩减副本、杀进程、改端口拓扑/MODEL_ID/配置等高危操作一律先说明理由并等确认；只操作自己的 Pod，共享/线上实例变更必须人工确认。",
  },
  {
    id: "inf-prefill", icon: "⚡", title: "Prefill 性能优化",
    desc: "sglang prefill/ttft 的 5 步 loop（base→profile→subagent→回归→循环）",
    prompt: "本项目是推理服务的 harness，里面有定义了 prefill 性能优化的工作流 prefill-optimization。请先进入本地 harness 代码库，再帮我运行这个工作流来优化 <目标模型，如 Deepseek v4.1-Flash>。\n步骤：1) 建立 base——指定 sglang 服务镜像，通过 perf-test-graph-prefill 部署并测试典型数据长度（如 60K）下的 prefill 性能与 ttft，保存 logits 作为精度标准；2) 性能 profile——用 torch profile 或 nsys 抓相同数据 trace，从算子/引擎/显存维度挖掘可优化点；3) subagent 优化——每个可优化点起一个 subagent 拉分支优化，保证优化后 logits 与基准在容差内且问题解决，再合并回主分支；4) 回归测试——集成后跑基准数据集，对比性能与 logits、解决冲突、保证正确并输出结果；5) 回到 2→3→4 循环，默认 3 次或无新优化点为止。每个 task 都要有明确 verify。\n环境（按实际替换）：集群 kubeconfig=<kubeconfig 路径>，prefill 启动 yaml=<prefill yaml 路径>，已启动实例=<pod 名>（内含 sglang 代码与模型权重）。请开始整个工作流并做好完整记录与回顾。",
  },
  {
    id: "inf-cache-adapt", icon: "🧩", title: "Cache 适配（AttentionStore）",
    desc: "新模型从零接入 AS-Cache，跑通 MLA / MLA+SWA / MLA+KDA",
    prompt: "本项目是推理服务的 harness，里面定义了 attention-store 适配的 workflow。请从头开始完整运行这个工作流，实现 <目标模型，如 ds v4.1-flash> 的 as-cache 适配，跑通 MLA、MLA+SWA、MLA+KDA，并支持自动组合适配与自动进化。\n环境（按实际替换）：集群 kubeconfig=<kubeconfig 路径>；未适配的 P 侧 yaml=<prefill yaml 路径>，owner=<owner>；相关代码路径：sglang_root=<aiak_sglang 路径>，sdk_root=<attentionstore/sdk 路径>，agent_root=<attentionstore/agent 路径，只读参考，用于确认接口与参数>。\n请开始整个工作流并做好完整记录与回顾（每步 run id / artifact root / validator 结论 / Journal / 证据路径）。",
  },
  {
    id: "inf-cache-loss", icon: "📉", title: "Cache 损耗优化",
    desc: "80k/96% 命中下把 cache 损耗降到 20% 以内（bench_ascache 两阶段压测）",
    prompt: "帮我创建一个优化 cache 性能损耗的任务，目标：<输入长度，如 80k(81920)> 输入、<命中率，如 96%> 命中率场景下 cache 损耗达到 20% 以下。\ncache 损耗定义：开启 ASCache 场景 uncache itps 相对 disable-radix-cache 场景 uncache itps 缩减的比例（1 - ascache uncache itps / disable-radix-cache uncache itps）。损耗分计算损耗、间隙损耗（通常高优关注）、以及有 PP 时的 bubble 损耗。\n环境（按实际替换）：引擎 sglang 代码=<sglang 路径>，模型路径=<模型 tokenizer/权重路径>，可用 pod=<pod 名>，SDK=<attentionstore/sdk 路径>，启动脚本=<start.sh 路径>，无基线 ITPS=<基线值>。\n压测用自研 bench_ascache.py（两阶段：先充 cache 再实际发压，抓 nsys/profile 只抓实际发压阶段，据引擎日志 hit_rate 判断是否真命中）：\npython3 benchmark/bench_ascache.py --host 127.0.0.1 --port 8000 --total-len 81920 --target-hit-rates \"0.96\" --batch-size 64 --num-rounds 1 --tokenizer <模型路径> --output-file ascache_80k.json\n允许优化引擎源码、重启/杀引擎、改引擎配置与 SDK（仅限自己的测试实例；共享/线上实例一律停下确认）。trace 与 loop 证据输出目录自定。可参考引擎历史 cache 损耗留档与 harness cache 损耗优化 loop 里的提示词。",
  },
  {
    id: "inf-hitrate", icon: "🎯", title: "Cache 命中率定位修复",
    desc: "线上命中率下跌定位与修复，validator 判定、留完整证据链",
    prompt: "使用 cache-hitrate-debug skill 定位并修复线上 cache 命中率下跌问题，目标解决 9 成以上命中率下跌并支持自动迭代。复用 harness 原子任务（tasks/REGISTRY.yaml），没有合适的才新增、新增后更新 REGISTRY 并重新生成 CATALOG。用 bench_ascache.py 两阶段压测复现，用 nsys/torch profile 抓 trace，据引擎日志 hit_rate 判断是否真正命中 cache。定位与修复都要有明确 verify、以 validator 判定为准，保留完整证据链（run id / artifact root / Journal / 证据路径），失败不静默重试。环境（按实际替换）：模型=<目标模型>，集群/实例=<kubeconfig 与 pod>。",
  },
  {
    id: "inf-cudaipc", icon: "🔗", title: "AS-SDK CudaIPC 传输改造验证",
    desc: "KVCache 传输 PosixSHM→CudaIPC(as-mover)，优化 Prefill 启动时间、不劣化精度/吞吐",
    prompt: "基于 infer-forge-harness 设计并执行一个验证工作流：attention-store-sdk 的 KVCache 传输从 PosixSHM 改为独立进程 as-mover 用 CudaIPC（共享显存）。核心目标是优化 Prefill 启动时间，同时保证功能、精度与 Cache 吞吐损耗不劣化。采用最小可用版本、分步推进，每步跟我确认后再进入下一步。\n工作方式：先读 AGENTS.md、目标 workflow、task 合约、SKILL.md 与 validator 再动手；优先复用 REGISTRY 原子任务。代码改动落在 Pod 内代码库（本地写→kubectl cp 进 Pod→Pod 内编译测试），改动通过 PYTHONPATH 注入不改镜像（AS_SDK_ROOT=<sdk 路径>，SGLANG_ROOT=<sglang 路径>）。先不提交代码，留给我 review。\n环境（按实际替换）：kubeconfig=<kubeconfig>，引擎版本=<版本>，线上配置（权威只读不 apply）=<线上 yaml>，线下测试配置=<线下 yaml>，专用实例=<prefill/decode pod>。\n阶段：0 环境证明+部署注册（端口与线上一致，引擎 HTTP_PORT=8000、PD router 30000）→1 Baseline（吞吐损耗 + Prefill 启动时间，bench_ascache.py 重复≥3 次）→2 as-mover 单测（先给方案我 review）→3 Prefill 单点（先起 as-mover 再起引擎，对比 baseline）→4 完整 PD 回归（迁到 Decode，千帆网关打通完整推理，功能+OpenCompass 精度回归）→5 压测（aiakperf 经网关，QPS 1.0）。\n每步交付：run id、artifact root、节点状态、validator 结论、Journal 路径、证据路径、与 baseline 对比（损耗% / Prefill 启动时间）。以 validator 判定为准，失败保留证据不静默重试。\n安全红线：删除实例/资源、缩副本一律停下由我执行（kubectl delete 与缩副本外其他 kubectl 已授权）；只操作自己的 Pod；不擅改端口/拓扑/MODEL_ID，一切以线上 yaml 为准、要改先确认。",
  },
  {
    id: "inf-kvcache-nextgen", icon: "🧱", title: "下一代 KV Cache 架构（radix/allocator/overlap）",
    desc: "harness 跑通 radix tree 拆分 / allocator 拆分 / cache 操作与 forward overlap",
    prompt: "基于 infer-forge-harness 推进下一代 KV Cache 架构改造，里程碑：1) 与方案对齐关键路径和实现；2) Harness 平台初步跑通流程；3) 基于 Harness 跑通业务结果——完成 radix tree 拆分并验收通过、完成 allocator 拆分并验收通过、完成 cache 操作与 forward 并行 overlap 并验收通过。\n工作方式：先读 AGENTS.md / 目标 workflow / task 合约 / SKILL.md / validator 再动手，优先复用 REGISTRY 原子任务，产物与 Journal 放仓库外，每步有明确 verify、以 validator 判定为准。环境（按实际替换）：kubeconfig=<kubeconfig>，实例=<pod>，代码路径=<sglang/sdk 路径>。每步产出 run id / artifact root / validator 结论 / Journal / 证据路径并与 baseline 对比。安全红线同 harness 总纲（高危操作先确认、只动自己的 Pod）。",
  },
  {
    id: "inf-runtime-loop", icon: "🛡️", title: "受控 Loop（validator 门禁 + 自动迭代）",
    desc: "用运行时启动任务：validator 不通过自动带证据进入下一轮，通过才算完成，可断点续跑",
    prompt: "用 mini-harness 运行时启动一个受 validator 约束的任务（不要用普通对话硬跑）。\n\n调用 loop_start：\n- goal：<要达成的目标，写清可验证的完成条件>\n- validateCmd：<validator 命令，例如 python3 validate.py 或 infer-forge-harness 的 validate.py 路径>\n- harnessRoot：<可选，harness 仓库根目录>\n- maxRounds：<默认 5>\n\n然后 loop_plan 写出计划并直接修改工作区；完成每轮时调用 loop_done(summary)。\n规则：运行时会自动执行 validator；不通过会带着证据自动进入下一轮，直到通过或达到最大轮数。不要自行宣布完成，不要向用户提问，不要重复已完成的步骤。",
  },
];
try {
  let html = fs.readFileSync(htmlFile, "utf8");
  const seedMarker = "HARDENED:prompt-seed";
  const payload = JSON.stringify({
    managed: MANAGED_TPL,
    managedIds: MANAGED_TPL_IDS,
    builtins: BUILTIN_TPL_IDS,
  });
  const scriptBlock =
    `\t\t<!-- ${seedMarker} 提示词模板：隐藏 25 内置 + 灌入 harness/Ku 沉淀的多个可直接用模板（版本化 seed，可逆）。 -->\n` +
    `\t\t<script id="pi-prompt-seed">\n` +
    `\t\t(function(){try{\n` +
    `\t\t\tvar K="pi-web-ui:prompt-templates",F="pi-web-ui:prompt-templates-seeded";\n` +
    `\t\t\tvar VER="v4";\n` +
    `\t\t\tif(localStorage.getItem(F)===VER)return;\n` +
    `\t\t\tvar P=${payload};\n` +
    `\t\t\tvar cur=[];try{cur=JSON.parse(localStorage.getItem(K)||"[]")}catch(e){}\n` +
    `\t\t\tif(!Array.isArray(cur))cur=[];\n` +
    `\t\t\tvar drop={};P.managedIds.forEach(function(x){drop[x]=1;});\n` +
    `\t\t\t// 去掉本插件管理的旧条目（升级/收敛），保留用户自建\n` +
    `\t\t\tcur=cur.filter(function(t){return t&&!drop[t.id];});\n` +
    `\t\t\t// 为每个内置模板补 hidden 标记（用户若已显式改过同 id 则不动）\n` +
    `\t\t\tvar have={};cur.forEach(function(t){if(t&&t.id)have[t.id]=1;});\n` +
    `\t\t\tP.builtins.forEach(function(id){if(!have[id])cur.push({id:id,hidden:true});});\n` +
    `\t\t\t// 放入沉淀的多个可直接用模板\n` +
    `\t\t\tP.managed.forEach(function(t){cur.push(t);});\n` +
    `\t\t\tlocalStorage.setItem(K,JSON.stringify(cur));localStorage.setItem(F,VER);\n` +
    `\t\t}catch(e){}})();\n` +
    `\t\t</script>\n\t`;
  if (!html.includes(seedMarker)) {
    html = html.replace("</head>", scriptBlock + "</head>");
    fs.writeFileSync(htmlFile, html);
    log(`已注入提示词模板 seed（隐藏 25 内置 + ${MANAGED_TPL.length} 个 harness/Ku 沉淀模板）`);
  } else {
    const re = /\t*<!-- HARDENED:prompt-seed[\s\S]*?<\/script>\n\t?/;
    const updated = html.replace(re, scriptBlock);
    if (updated !== html) {
      fs.writeFileSync(htmlFile, updated);
      log(`已更新提示词模板 seed（v4：隐藏内置 + ${MANAGED_TPL.length} 个沉淀模板）`);
    } else log("提示词模板 seed 已是最新（跳过）");
  }
} catch (e) {
  log("WARN: 提示词模板 seed 注入失败", e.message);
}

// ---- 9) 子代理模板：保留 explore/review/implement，其余换成 5 个推理 workflow 模板 ----
// 模板是全局配置（<dataDir>/subagent-templates.json），所有客户端共用。
// seeded sidecar 记已播种的内置名；把全部 13 个内置名写进去 => 被删的 10 个不再回灌。
const dataDir = path.join(HOME, ".pi-web");
const KEEP = new Set(["explore", "review", "implement"]);
const infTemplates = [
  {
    name: "harness-runner",
    description: "推理 Harness 执行者：拉起 infer-forge-harness，按 workflow 定义逐步执行并留证据",
    promptMode: "replace",
    systemPrompt: "你是训推引擎组的 Harness 执行子代理。使用 inference-harness skill。用 icode 拉取 baidu/hac-aiacc/infer-forge-harness，先读 AGENTS.md、目标 workflow 定义、tasks/REGISTRY.yaml、catalog/tool_catalog.yaml、SKILL.md 与 validator，再动手。优先复用 REGISTRY 已有原子任务，没有合适的才新增（新增后更新 REGISTRY 并重新生成 CATALOG）。每步产出 run id / artifact root / validator 结论 / Journal 路径 / 证据路径，并与 baseline 对比；以 validator 判定为准，失败不静默重试。安全红线：删除实例/资源、缩减副本、改端口拓扑/MODEL_ID 等一律先说明理由并等确认；只操作自己的 Pod。",
    enabledSkills: ["inference-harness", "baidu-devops", "baidu-ku-doc"],
    enabledExtensions: [], model: "", thinkingLevel: "", enabled: true,
  },
  {
    name: "prefill-opt",
    description: "Prefill 性能优化：sglang prefill/ttft 的 5 步 loop（base→profile→优化→回归→循环）",
    promptMode: "replace",
    systemPrompt: "你是 prefill 性能优化子代理。使用 prefill-optimization skill 跑 prefill-optimization workflow，优化 sglang 在典型数据长度（如 60K）下的 prefill 性能与 ttft。①用 perf-test-graph-prefill 部署指定镜像建 base，保存 logits 作精度标准；②用 torch profile/nsys 抓同数据 trace，从算子/引擎/显存维度定位可优化点；③每个优化点起分支优化，保证优化后 logits 与基准在容差内、问题解决后再合并；④集成后跑基准集回归，对比性能与 logits、解决冲突；⑤回第 2 步循环，默认 3 次或无新优化点为止。每个 task 都要有明确 verify。",
    enabledSkills: ["prefill-optimization", "inference-harness"],
    enabledExtensions: [], model: "", thinkingLevel: "", enabled: true,
  },
  {
    name: "cache-adapt",
    description: "AttentionStore 模型适配：新模型接入 ASCache，跑通 MLA / MLA+SWA / MLA+KDA",
    promptMode: "replace",
    systemPrompt: "你是 AttentionStore 适配子代理。使用 cache-adaptation skill 跑 attention-store 适配 workflow，把目标模型（如 deepseek-v4.1-flash）从零接入 AttentionStore/ASCache，跑通 MLA、MLA+SWA、MLA+KDA 并支持自动组合适配与自动进化。关键路径：引擎 aiak_sglang（sglang_root）、SDK attentionstore/sdk（sdk_root）、Agent attentionstore/agent（agent_root，只读参考）。集群配置用任务提供的 kubeconfig；未适配的 P 侧 yaml 与 owner 以任务启动 prompt 为准。每步完整记录 run id / artifact root / validator 结论 / Journal / 证据路径。",
    enabledSkills: ["cache-adaptation", "inference-harness"],
    enabledExtensions: [], model: "", thinkingLevel: "", enabled: true,
  },
  {
    name: "cache-loss",
    description: "Cache 损耗优化：80k/96% 命中下把 cache 损耗降到 20% 以内",
    promptMode: "replace",
    systemPrompt: "你是 cache 性能损耗优化子代理。使用 cache-loss-optimization skill，目标：输入 80k(81920)、命中率 96% 下把 cache 损耗降到 20% 内（损耗 = 1 - ascache uncache itps / disable-radix-cache uncache itps）。分别排查计算/间隔/bubble 损耗，重点关注间隔损耗。用 benchmark/bench_ascache.py 两阶段压测（先充 cache 再实际发压，据引擎日志 hit_rate 确认真正命中），用 nsys 抓实际发压阶段 trace。允许改 sglang 引擎与 attentionstore/sdk 源码、重启自己的测试实例；共享/线上实例的重启、杀进程、改配置一律先确认。",
    enabledSkills: ["cache-loss-optimization", "inference-harness"],
    enabledExtensions: [], model: "", thinkingLevel: "", enabled: true,
  },
  {
    name: "hitrate-debug",
    description: "Cache 命中率定位：线上命中率下跌定位与修复，validator 判定",
    promptMode: "replace",
    systemPrompt: "你是 cache 命中率问题定位与修复子代理。使用 cache-hitrate-debug skill 定位并修复线上 cache 命中率下跌，目标解决 9 成以上下跌并支持自动迭代。复用 harness 原子任务（tasks/REGISTRY.yaml），没有合适的才新增、新增后更新 REGISTRY 并重新生成 CATALOG。用 bench_ascache.py 两阶段压测复现，用 nsys/torch profile 抓 trace，看引擎日志 hit_rate 判断是否真正命中。定位与修复都要有明确 verify、以 validator 判定为准，保留完整证据链（run id / artifact root / Journal / 证据路径），失败不静默重试。",
    enabledSkills: ["cache-hitrate-debug", "inference-harness"],
    enabledExtensions: [], model: "", thinkingLevel: "", enabled: true,
  },
];
try {
  const mod = await import(
    path.join(DIST, "subagent-templates.js").replace(/\\/g, "/")
  );
  const defaults = mod.DEFAULT_TEMPLATES || [];
  const kept = defaults
    .filter((t) => KEEP.has(t.name))
    .map((t) => ({ ...t, enabledSkills: [...t.enabledSkills], enabledExtensions: [...t.enabledExtensions] }));
  const finalTemplates = [...kept, ...infTemplates];
  const tplFile = path.join(dataDir, "subagent-templates.json");
  fs.writeFileSync(tplFile, JSON.stringify(finalTemplates, null, 2));
  // seeded sidecar：写全部内置名 => 被删的内置模板不会在重启后复活
  const seededFile = path.join(dataDir, "subagent-templates.seeded.json");
  const allBuiltinNames = defaults.map((t) => t.name);
  fs.writeFileSync(seededFile, JSON.stringify(allBuiltinNames, null, 2));
  log(`子代理模板已重建：保留 ${[...KEEP].join("/")} + ${infTemplates.length} 个推理模板（共 ${finalTemplates.length}）`);
} catch (e) {
  log("WARN: 子代理模板重建失败", e.message);
}

// ---- 10) 工具精简：禁用 page-picker（browser_page）——pageRef 已关，工具一并禁 ----
try {
  const csFile2 = path.join(dataDir, "client-state.json");
  const cs = JSON.parse(fs.readFileSync(csFile2, "utf8"));
  const st = cs.__settings__?.settings;
  if (st) {
    const tools = new Set(st.disabledAgentTools || []);
    tools.add("browser_page");
    st.disabledAgentTools = [...tools];
    fs.writeFileSync(csFile2, JSON.stringify(cs, null, 2));
    log("已禁用 browser_page 工具（page-picker）");
  }
} catch (e) {
  log("WARN: 工具精简失败", e.message);
}

// ---- 11) pi-llm-wiki extension：登记 + 静默自动配置 + 删高危可选依赖子树（幂等可逆）----
// vendor 目录是审查过的 @zosmaai/pi-llm-wiki@0.12.5 本地副本。此段只做"配置与清理"，
// 不重装依赖（依赖体积大、需联网）；若 vendor/node_modules 缺失会提示手动 npm install。
{
  const wikiVendor = path.join(COCKPIT, "vendor", "pi-llm-wiki");
  const agentSettings = path.join(HOME, ".pi", "agent", "settings.json");
  try {
    if (!fs.existsSync(path.join(wikiVendor, "package.json"))) {
      log("WARN: pi-llm-wiki vendor 缺失，跳过（需先放置 vendor/pi-llm-wiki 源）");
    } else {
      // a0) 前置自愈：vendor 依赖缺失则自动 npm install（禁脚本、仅 prod、legacy-peer）
      const nmDir = path.join(wikiVendor, "node_modules");
      const depProbe = path.join(nmDir, "node-html-markdown");
      if (!fs.existsSync(depProbe)) {
        log("pi-llm-wiki：vendor 依赖缺失，自动 npm install（--omit=dev --ignore-scripts --legacy-peer-deps）…");
        try {
          execSync("npm install --omit=dev --ignore-scripts --legacy-peer-deps --no-audit --no-fund", {
            cwd: wikiVendor, stdio: "inherit",
          });
          log("pi-llm-wiki：依赖安装完成");
        } catch (e) {
          log("WARN: pi-llm-wiki 依赖自动安装失败，请手动在 vendor/pi-llm-wiki 跑 npm install", e.message);
        }
      } else log("pi-llm-wiki：vendor 依赖已就绪（跳过安装）");

      // a1) 前置自愈：未登记到 pi packages 则自动 pi install（幂等）
      let stProbe = {};
      try { stProbe = JSON.parse(fs.readFileSync(agentSettings, "utf8")); } catch {}
      const already = (stProbe.packages || []).some((p) => p.includes("vendor/pi-llm-wiki"));
      if (!already) {
        log("pi-llm-wiki：未登记，自动 pi install…");
        try {
          execSync(`pi install ${JSON.stringify(wikiVendor)} --no-approve`, { stdio: "inherit" });
          log("pi-llm-wiki：pi install 完成");
        } catch (e) {
          log("WARN: pi install 失败（pi CLI 不在 PATH？），将仅写 settings 登记兜底", e.message);
        }
      } else log("pi-llm-wiki：package 已登记（跳过 pi install）");

      // a) 删高危可选依赖子树（@tobilu/qmd → node-llama-cpp → simple-git 的命令执行 CVE）
      const nm = path.join(wikiVendor, "node_modules");
      const risky = ["@tobilu", "node-llama-cpp", "simple-git", "@simple-git", "better-sqlite3", "sqlite-vec", "web-tree-sitter"];
      let removed = 0;
      for (const r of risky) {
        const rp = path.join(nm, r);
        if (fs.existsSync(rp)) { fs.rmSync(rp, { recursive: true, force: true }); removed++; }
      }
      // tree-sitter-* 通配
      if (fs.existsSync(nm)) {
        for (const d of fs.readdirSync(nm)) {
          if (d.startsWith("tree-sitter-")) { fs.rmSync(path.join(nm, d), { recursive: true, force: true }); removed++; }
        }
      }
      if (removed) log(`pi-llm-wiki：已移除 ${removed} 个高危可选依赖目录（qmd/llama/simple-git 子树）`);
      else log("pi-llm-wiki：高危可选依赖已清理（跳过）");

      // b) 登记到 pi 全局 settings.json packages（绝对路径，可移植；去重）
      // 首装时 settings.json 可能尚不存在（pi install 未成功时），用空对象兜底，保证其余配置仍能写入。
      let st = {};
      try { st = JSON.parse(fs.readFileSync(agentSettings, "utf8")); } catch {}
      const pkgs = new Set(st.packages || []);
      // 清掉任何 /tmp 的旧登记，以及任何旧的 pi-llm-wiki 相对/硬编码登记
      for (const p of [...pkgs]) {
        if (p.includes("/tmp/")) pkgs.delete(p);
        if (p.includes("pi-llm-wiki") && p !== wikiVendor) pkgs.delete(p);
      }
      pkgs.add(wikiVendor);
      st.packages = [...pkgs];

      // c) 静默自动配置：后台自动召回/沉淀，不弹提示；不配 embedding => 纯本地不外联
      st["llm-wiki"] = {
        notices: false,
        autoRecall: true,
        trajectories: true,
        ambientPersonalVault: true,
        wikilinkValidation: "warn",
      };
      fs.writeFileSync(agentSettings, JSON.stringify(st, null, 2));
      log("pi-llm-wiki：已登记 package + 写静默自动配置（notices=off / autoRecall / trajectories / 无 embedding）");
    }
  } catch (e) {
    log("WARN: pi-llm-wiki 配置失败", e.message);
  }
}

// ---- 12) 首次使用 API Key 门禁：一打开就弹窗要求填写 Baidu One API（可逆，localStorage 记已读）----
// 可移植场景下别人 git clone 后没有 auth.json，必须显式引导其填 One API。门禁为自建 DOM，
// 不依赖 bundle 选择器；并尽力打开"设置"。用户点"我已配置"后落 localStorage 标志，不再弹。
try {
  let html = fs.readFileSync(htmlFile, "utf8");
  const gateMarker = "HARDENED:apikey-gate";
  const gateBlock =
    `\t\t<!-- ${gateMarker} 首次使用 One API Key 门禁（可逆）。 -->\n` +
    `\t\t<style id="pi-apikey-gate-style">\n` +
    `\t\t\t#pi-apikey-gate{position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(15,17,21,.72);backdrop-filter:blur(3px);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}\n` +
    `\t\t\t#pi-apikey-gate .pg-card{width:min(520px,92vw);background:#1b1e24;color:#e7e9ee;border:1px solid #333a45;border-radius:14px;padding:26px 28px;box-shadow:0 18px 60px rgba(0,0,0,.5);}\n` +
    `\t\t\t#pi-apikey-gate h2{margin:0 0 6px;font-size:18px;font-weight:700;}\n` +
    `\t\t\t#pi-apikey-gate .pg-sub{margin:0 0 16px;font-size:12.5px;color:#9aa3b2;}\n` +
    `\t\t\t#pi-apikey-gate ol{margin:0 0 14px;padding-left:18px;font-size:13px;line-height:1.75;}\n` +
    `\t\t\t#pi-apikey-gate code{background:#11141a;border:1px solid #2b313b;border-radius:5px;padding:1px 6px;font-size:12px;color:#8fd0ff;}\n` +
    `\t\t\t#pi-apikey-gate .pg-note{font-size:11.5px;color:#7f8897;margin:0 0 18px;line-height:1.6;}\n` +
    `\t\t\t#pi-apikey-gate .pg-row{display:flex;gap:10px;justify-content:flex-end;}\n` +
    `\t\t\t#pi-apikey-gate button{font-size:13px;border-radius:8px;padding:8px 16px;cursor:pointer;border:1px solid transparent;}\n` +
    `\t\t\t#pi-apikey-gate .pg-open{background:#2b313b;color:#d8dde6;border-color:#3a414d;}\n` +
    `\t\t\t#pi-apikey-gate .pg-ok{background:#3b82f6;color:#fff;}\n` +
    `\t\t</style>\n` +
    `\t\t<script id="pi-apikey-gate-script">\n` +
    `\t\t(function(){try{\n` +
    `\t\t\tvar ACK="pi-harness:apikey-ack";\n` +
    `\t\t\tfunction openSettings(){try{var sel=['[data-bar-item="host:settings"]','[aria-label="设置"]','[aria-label="Settings"]','[title="设置"]','[title="Settings"]'];for(var i=0;i<sel.length;i++){var el=document.querySelector(sel[i]);if(el){el.click();return true;}}}catch(e){}return false;}\n` +
    `\t\t\tfunction mount(){\n` +
    `\t\t\t\tif(localStorage.getItem(ACK)==="1")return;\n` +
    `\t\t\t\tif(document.getElementById("pi-apikey-gate"))return;\n` +
    `\t\t\t\tvar o=document.createElement("div");o.id="pi-apikey-gate";\n` +
    `\t\t\t\to.innerHTML='<div class="pg-card"><h2>训推引擎组 Harness · 首次配置</h2><p class="pg-sub">使用前只需填入你自己的 One API Key（Base URL 已默认配好，无需修改）。</p><ol><li>点下方「打开设置」，进入 <b>设置 → 模型服务商</b></li><li>在 API Key 处填入你自己的 Key 并保存</li></ol><p class="pg-note">Key 仅保存在本机 <code>~/.pi/agent/auth.json</code>，不会提交到代码库，也不会外传。</p><div class="pg-row"><button class="pg-open">打开设置</button><button class="pg-ok">我已配置，进入</button></div></div>';\n` +
    `\t\t\t\tdocument.body.appendChild(o);\n` +
    `\t\t\t\to.querySelector(".pg-open").addEventListener("click",function(){openSettings();localStorage.setItem(ACK,"1");o.remove();});\n` +
    `\t\t\t\to.querySelector(".pg-ok").addEventListener("click",function(){localStorage.setItem(ACK,"1");o.remove();});\n` +
    `\t\t\t}\n` +
    `\t\t\tif(document.readyState==="loading")document.addEventListener("DOMContentLoaded",function(){setTimeout(mount,600);});else setTimeout(mount,600);\n` +
    `\t\t}catch(e){}})();\n` +
    `\t\t</script>\n\t`;
  if (!html.includes(gateMarker)) {
    html = html.replace("</head>", gateBlock + "</head>");
    fs.writeFileSync(htmlFile, html);
    log("已注入 One API Key 首次配置门禁");
  } else {
    const re = /\t*<!-- HARDENED:apikey-gate[\s\S]*?pi-apikey-gate-script">[\s\S]*?<\/script>\n\t?/;
    const updated = html.replace(re, gateBlock);
    if (updated !== html) {
      fs.writeFileSync(htmlFile, updated);
      log("已更新 One API Key 门禁（同步最新）");
    } else log("One API Key 门禁已是最新（跳过）");
  }
} catch (e) {
  log("WARN: One API Key 门禁注入失败", e.message);
}

// ---- 11b) mini-harness-runtime：薄运行时扩展（状态机 + validator 准入 + 自动下一轮 + 续跑）----
{
  const rtVendor = path.join(COCKPIT, "vendor", "mini-harness-runtime");
  const agentSettings = path.join(HOME, ".pi", "agent", "settings.json");
  try {
    if (!fs.existsSync(path.join(rtVendor, "package.json"))) {
      log("WARN: mini-harness-runtime vendor 缺失，跳过");
    } else {
      let st = {};
      try { st = JSON.parse(fs.readFileSync(agentSettings, "utf8")); } catch {}
      const pkgs = new Set(st.packages || []);
      for (const p of [...pkgs]) if (p.includes("mini-harness-runtime") && p !== rtVendor) pkgs.delete(p);
      const already = pkgs.has(rtVendor);
      if (!already) {
        log("mini-harness-runtime：未登记，自动 pi install…");
        try { execSync(`pi install ${JSON.stringify(rtVendor)} --no-approve`, { stdio: "inherit" }); }
        catch (e) { log("WARN: pi install 失败，将仅写 settings 登记兜底", e.message); }
      }
      let st2 = {};
      try { st2 = JSON.parse(fs.readFileSync(agentSettings, "utf8")); } catch {}
      const pkgs2 = new Set(st2.packages || []);
      for (const p of [...pkgs2]) if (p.includes("mini-harness-runtime") && p !== rtVendor) pkgs2.delete(p);
      pkgs2.add(rtVendor);
      st2.packages = [...pkgs2];
      fs.writeFileSync(agentSettings, JSON.stringify(st2, null, 2));
      log("mini-harness-runtime：已登记（" + rtVendor + "）");
    }
  } catch (e) {
    log("WARN: mini-harness-runtime 登记失败", e.message);
  }
}

// ---- 结果汇总 ----
const remaining = fs.existsSync(path.join(skillsDir, "pi-skills"))
  ? fs.readdirSync(path.join(skillsDir, "pi-skills")).filter((n) => fs.existsSync(path.join(skillsDir, "pi-skills", n, "SKILL.md")))
  : [];
log("剩余启用的 pi-skills:", remaining.join(", ") || "(无)");
log("DONE");
