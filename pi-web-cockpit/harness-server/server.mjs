/**
 * Mini Harness 独立薄后端（harness-server）
 *
 * 不依赖 pi-web-ui：直接用 @earendil-works/pi-coding-agent 创建会话，
 * 通过 ~/.pi/agent/settings.json 的 packages 自动加载 mini-harness-runtime 扩展与 skills，
 * 提供 token 鉴权的 JSON API（结构化启动 / 状态 / 详情 / 停止 / 模型列表），
 * 并托管自有驾驶舱静态页。
 *
 * 一个 run = 一个会话（sessionId 绑定），runId 由运行时在 loop_start 里落盘，
 * 本服务在会话回合结束后从 runs 目录回读 runId 返回给前端，做到「点启动 → 有 runId 确认」。
 *
 * 环境：
 *   HARNESS_PORT                默认 8790
 *   MINI_HARNESS_RUNTIME_ROOT   默认 ~/.mini-harness/runs（与 runtime 一致）
 *   HARNESS_CWD                 未指定 cwd 时的默认工作区
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
const RUNS_ROOT = process.env.MINI_HARNESS_RUNTIME_ROOT || path.join(os.homedir(), '.mini-harness', 'runs');
const TOKEN_FILE = path.join(os.homedir(), '.pi-web', 'pi-web-token');
const PORT = Number(process.env.HARNESS_PORT || 8790);
const DEFAULT_CWD = process.env.HARNESS_CWD || os.homedir();
const PUBLIC_DIR = path.join(HERE, 'public');

// ---------- 工具 ----------

function log(...a) {
  console.log(`[harness-server ${new Date().toISOString()}]`, ...a);
}

function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

function tokenOk(req) {
  const t = readToken();
  if (!t) return true; // 未配置口令则放行（与 pi-web-ui 一致）
  const fromQuery = new URL(req.url, 'http://x').searchParams.get('token');
  return fromQuery === t || (req.headers['x-pi-token'] || '') === t;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---------- 模型家族与列表（与 mini-harness-runtime familyOf 保持一致） ----------

function familyOf(id) {
  const s = String(id || '').toLowerCase();
  const rules = [
    [/^(gpt|o[1-9])/, 'openai'],
    [/claude|opus|sonnet|haiku/, 'anthropic'],
    [/gemini/, 'google'],
    [/glm/, 'zhipu'],
    [/kimi|moonshot/, 'moonshot'],
    [/deepseek/, 'deepseek'],
    [/grok/, 'xai'],
    [/minimax|abab/, 'minimax'],
    [/qwen|tongyi/, 'alibaba'],
    [/llama/, 'meta'],
    [/mistral|mixtral/, 'mistral'],
    [/ernie/, 'baidu'],
    [/doubao/, 'bytedance'],
  ];
  for (const [re, fam] of rules) if (re.test(s)) return fam;
  return 'other';
}

function collectModels() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, 'models.json'), 'utf8'));
  } catch {
    return [];
  }
  const out = [];
  for (const [provider, p] of Object.entries(cfg?.providers || {})) {
    for (const m of Array.isArray(p?.models) ? p.models : []) {
      if (m && m.id) out.push({ provider, id: String(m.id), family: familyOf(m.id) });
    }
  }
  return out;
}

// ---------- 配置读写（替代 pi-web-ui 的「模型与服务商」设置页） ----------

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(p, o) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(o, null, 2));
}

const modelsFile = () => path.join(AGENT_DIR, 'models.json');
const authFile = () => path.join(AGENT_DIR, 'auth.json');

/** 只返回 provider 元信息与是否有 key，绝不回传 key 本身。 */
function getConfig() {
  const models = readJson(modelsFile());
  const auth = readJson(authFile());
  const out = [];
  for (const [provider, p] of Object.entries(models?.providers || {})) {
    out.push({
      provider,
      name: p?.name || null,
      baseUrl: p?.baseUrl || null,
      api: p?.api || null,
      modelCount: Array.isArray(p?.models) ? p.models.length : 0,
      hasKey: !!auth?.[provider]?.key,
    });
  }
  return out;
}

/** 新增/更新一个 provider 的 baseUrl/name/api/key；不覆盖已有 models 列表。 */
function putConfig(body) {
  const provider = String(body.provider || '').trim();
  if (!provider) return { status: 400, body: { error: 'provider 不能为空' } };
  const models = readJson(modelsFile()) || {};
  const providers = models.providers || (models.providers = {});
  const p = providers[provider] || (providers[provider] = {});
  if (body.name) p.name = String(body.name);
  if (body.baseUrl) p.baseUrl = String(body.baseUrl);
  if (body.api) p.api = String(body.api);
  const auth = readJson(authFile()) || {};
  if (body.apiKey && String(body.apiKey).trim()) {
    auth[provider] = { ...(auth[provider] || {}), type: 'api_key', key: String(body.apiKey).trim() };
  }
  writeJson(modelsFile(), models);
  writeJson(authFile(), auth);
  return {
    status: 200,
    body: {
      provider,
      name: p.name || null,
      baseUrl: p.baseUrl || null,
      modelCount: Array.isArray(p.models) ? p.models.length : 0,
      hasKey: !!auth[provider]?.key,
    },
  };
}

// ---------- 运行状态读取 ----------

function loadState(runId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(RUNS_ROOT, runId, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}

function collectRuns() {
  let ids = [];
  try {
    ids = fs.readdirSync(RUNS_ROOT);
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    const st = loadState(id);
    if (!st) continue;
    const t = Date.parse(st.updatedAt || 0) || 0;
    const active = st.status === 'active';
    if (!active && Date.now() - t >= 5 * 60 * 1000) continue;
    const ws = String(st.baseWorkspace || st.workspace || '');
    out.push({
      runId: st.runId || id,
      sessionId: st.sessionId || null,
      alive: sessions.has(st.sessionId),
      stage: st.stage,
      round: st.round,
      maxRounds: st.maxRounds,
      status: st.status,
      stopReason: st.stopReason || null,
      lastVerdict: st.lastVerdict,
      lastCode: st.lastCode,
      lastReview: st.lastReview?.verdict || null,
      goal: String(st.goal || '').slice(0, 200),
      project: ws ? path.basename(ws) : '',
      models: {
        main: st.mainModel?.id || null,
        planner: st.plannerModel?.id || null,
        reviewer: st.reviewerModel?.id || null,
      },
      createdAt: st.createdAt || null,
      updatedAt: st.updatedAt || null,
    });
  }
  out.sort(
    (a, b) =>
      (b.status === 'active') - (a.status === 'active') ||
      (Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0),
  );
  return out.slice(0, 50);
}

function runDetail(runId) {
  const st = loadState(runId);
  if (!st) return null;
  const dir = path.join(RUNS_ROOT, runId);
  let journal = [];
  try {
    const jp = path.join(dir, 'journal.jsonl');
    if (fs.existsSync(jp)) {
      journal = fs
        .readFileSync(jp, 'utf8')
        .trim()
        .split('\n')
        .slice(-100)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { raw: l };
          }
        });
    }
  } catch {}
  let evidence = [];
  try {
    const ed = path.join(dir, 'evidence');
    if (fs.existsSync(ed)) evidence = fs.readdirSync(ed);
  } catch {}
  return { state: st, alive: sessions.has(st.sessionId), journal, evidence };
}

// ---------- 会话注册表（run -> session，供停止/续跑） ----------

const sessions = new Map(); // sessionId -> { session, cwd, startedAt, runId }

// ---------- 结构化启动 ----------

function buildStartPrompt(p) {
  const lines = [
    '用 loop_start 启动一个受控运行，然后 loop_plan 并直接完成工作，最后 loop_done。',
    `goal: ${p.goal}`,
  ];
  if (p.validateCmd) lines.push(`validateCmd: ${p.validateCmd}`);
  if (p.harnessRoot) lines.push(`harnessRoot: ${p.harnessRoot}`);
  if (Array.isArray(p.artifactRoots) && p.artifactRoots.length)
    lines.push(`artifactRoots: ${JSON.stringify(p.artifactRoots)}`);
  if (p.maxRounds) lines.push(`maxRounds: ${p.maxRounds}`);
  if (p.plannerModel) lines.push(`plannerModel: ${p.plannerModel}`);
  if (p.reviewerModel === '__none__') lines.push('useReviewer: false');
  else if (p.reviewerModel) lines.push(`reviewerModel: ${p.reviewerModel}`);
  if (p.worktree) lines.push('worktree: true');
  if (p.mode === 'llm') {
    lines.push('mode: llm');
    lines.push('不要向用户提问；完成后 loop_done，运行时会让 reviewer 判定，不通过会自动进入下一轮。');
  } else {
    lines.push('不要向用户提问；运行时会自动验证，失败自动进入下一轮。');
  }
  if (p.instructions) lines.push('', '具体要求/命令：', p.instructions);
  return lines.join('\n');
}

async function makeSession(cwd) {
  const created = await createAgentSession({
    cwd,
    sessionManager: SessionManager.create(cwd),
  });
  return created.session;
}

function captureRunId(session) {
  let runId = null;
  try {
    const mine = [];
    for (const id of fs.readdirSync(RUNS_ROOT)) {
      const st = loadState(id);
      if (!st) continue;
      if (st.sessionId === session.sessionId) {
        mine.push({ id, createdAt: Date.parse(st.createdAt || 0) || 0 });
      }
    }
    mine.sort((a, b) => b.createdAt - a.createdAt);
    if (mine[0]) runId = mine[0].id;
  } catch {}
  if (runId) {
    const rec = sessions.get(session.sessionId);
    if (rec) rec.runId = runId;
  }
  return runId;
}

async function startRun(payload, deps = {}) {
  const goal = String(payload.goal || '').trim();
  if (!goal) {
    return { status: 400, body: { error: 'goal 不能为空' } };
  }
  const cwd = payload.cwd ? String(payload.cwd) : DEFAULT_CWD;
  const mk = deps.makeSession || makeSession;
  let session;
  try {
    session = await mk(cwd);
  } catch (e) {
    return { status: 500, body: { error: '创建会话失败：' + String(e?.message || e) } };
  }

  sessions.set(session.sessionId, { session, cwd, startedAt: Date.now(), runId: null });

  // 后台跑完整 loop，不阻塞 HTTP 响应；前端轮询 /api/runs 发现 run。
  // runId 由运行时在 loop_start 落盘，这里在回合结束后回读补记（best-effort）。
  session
    .prompt(buildStartPrompt(payload))
    .then(() => captureRunId(session))
    .catch((e) => {
      log('start prompt 出错：', String(e?.message || e));
      sessions.delete(session.sessionId);
      try {
        session.dispose();
      } catch {}
    });

  return { status: 202, body: { sessionId: session.sessionId, cwd, pending: true } };
}

async function defaultResumeSession(workspace, sessionId) {
  const file = SessionManager.findById(workspace, sessionId);
  if (!file) return null;
  const created = await createAgentSession({ cwd: workspace, sessionManager: SessionManager.open(file) });
  return created.session;
}

async function resumeRun(runId, deps = {}) {
  const st = loadState(runId);
  if (!st) return { status: 404, body: { error: 'run 不存在' } };
  if (st.status !== 'active') {
    return { status: 409, body: { error: 'run 不是活跃态，无需续跑', status: st.status } };
  }
  const workspace = st.baseWorkspace || st.workspace;
  const sid = st.sessionId;
  const resume = deps.resumeSession || defaultResumeSession;
  let session;
  try {
    session = await resume(workspace, sid);
  } catch (e) {
    return { status: 500, body: { error: '重开会话失败：' + String(e?.message || e) } };
  }
  if (!session) {
    return { status: 404, body: { error: '找不到对应会话文件（可能已被清理）' } };
  }
  sessions.set(session.sessionId, { session, cwd: workspace, startedAt: Date.now(), runId });
  session
    .prompt('继续执行当前运行：先查看当前状态，从上次中断处继续，完成后调用 loop_done。不要重复已完成步骤，不要向用户提问。')
    .then(() => captureRunId(session))
    .catch((e) => {
      log('resume prompt 出错：', String(e?.message || e));
    });
  return { status: 202, body: { runId, sessionId: session.sessionId, resumed: true } };
}

async function stopRun(runId) {
  const st = loadState(runId);
  if (!st) return { status: 404, body: { error: 'run 不存在' } };
  const sid = st.sessionId;
  // 1) 会话在注册表里 → abort 正在跑的回合
  const rec = sid ? sessions.get(sid) : null;
  if (rec) {
    try {
      await rec.session.abort();
    } catch {}
  }
  // 2) 落一个停止标记，供还在推进的 agent_end 尊重（同时把非活跃态直接置停）
  if (st.status === 'active') {
    st.status = 'stopped';
    st.stopReason = 'user-stop';
    st.updatedAt = new Date().toISOString();
    try {
      fs.writeFileSync(path.join(RUNS_ROOT, runId, 'state.json'), JSON.stringify(st, null, 2));
    } catch {}
  }
  return { status: 200, body: { runId, status: st.status, stopReason: st.stopReason } };
}

// ---------- 自由对话（基本对话框） ----------

const chatSessions = new Map(); // sessionId -> session（与 run 会话分开的持久聊天会话）

async function chatSend(payload, deps = {}) {
  const message = String(payload.message || '').trim();
  if (!message) {
    return { status: 400, body: { error: '消息不能为空' } };
  }
  const cwd = payload.cwd ? String(payload.cwd) : DEFAULT_CWD;
  const mk = deps.makeSession || makeSession;

  let session = payload.sessionId ? chatSessions.get(payload.sessionId) : null;
  if (!session) {
    try {
      session = await mk(cwd);
    } catch (e) {
      return { status: 500, body: { error: '创建会话失败：' + String(e?.message || e) } };
    }
    chatSessions.set(session.sessionId, session);
  }

  // 非流式：订阅 text_delta 累积完整回复，prompt 结束后一次性返回
  let reply = '';
  const unsub = session.subscribe?.((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      reply += event.assistantMessageEvent.delta;
    }
  });
  try {
    await session.prompt(message);
  } catch (e) {
    return { status: 500, body: { error: '对话失败：' + String(e?.message || e) } };
  } finally {
    if (unsub) unsub();
  }
  return { status: 200, body: { sessionId: session.sessionId, reply } };
}

// ---------- 终端（命令运行器，非交互） ----------

function execCommand(payload) {
  const command = String(payload.command || '').trim();
  if (!command) {
    return { status: 400, body: { error: '命令不能为空' } };
  }
  const cwd = payload.cwd ? String(payload.cwd) : DEFAULT_CWD;
  const timeout = Math.min(120000, Math.max(1000, Number(payload.timeout) || 30000));
  return new Promise((resolve) => {
    exec(command, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, shell: '/bin/bash' }, (err, stdout, stderr) => {
      resolve({
        status: 200,
        body: {
          code: err ? (err.code ?? 1) : 0,
          killed: err?.killed ?? false,
          signal: err?.signal ?? null,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        },
      });
    });
  });
}

// ---------- 路由 ----------

async function handle(req, res) {
  if (!tokenOk(req)) {
    return json(res, 403, { error: 'unauthorized' });
  }
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const method = req.method;

  if (method === 'GET' && p === '/api/health') {
    return json(res, 200, { ok: true, runsRoot: RUNS_ROOT, agentDir: AGENT_DIR, sessions: sessions.size });
  }
  if (method === 'GET' && p === '/api/models') {
    return json(res, 200, { models: collectModels() });
  }
  if (method === 'GET' && p === '/api/config') {
    return json(res, 200, { providers: getConfig() });
  }
  if (method === 'PUT' && p === '/api/config/provider') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const r = putConfig(body);
    return json(res, r.status, r.body);
  }
  if (method === 'GET' && p === '/api/runs') {
    return json(res, 200, { runs: collectRuns() });
  }
  const runMatch = p.match(/^\/api\/runs\/([^/]+)$/);
  if (method === 'GET' && runMatch) {
    const d = runDetail(runMatch[1]);
    return d ? json(res, 200, d) : json(res, 404, { error: 'run 不存在' });
  }
  const resumeMatch = p.match(/^\/api\/runs\/([^/]+)\/resume$/);
  if (method === 'POST' && resumeMatch) {
    const r = await resumeRun(resumeMatch[1]);
    return json(res, r.status, r.body);
  }
  if (method === 'POST' && runMatch) {
    const body = JSON.parse((await readBody(req)) || '{}');
    const r = await stopRun(runMatch[1]);
    return json(res, r.status, r.body);
  }
  if (method === 'POST' && p === '/api/runs') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const r = await startRun(body);
    return json(res, r.status, r.body);
  }
  if (method === 'POST' && p === '/api/chat') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const r = await chatSend(body);
    return json(res, r.status, r.body);
  }
  if (method === 'POST' && p === '/api/exec') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const r = await execCommand(body);
    return json(res, r.status, r.body);
  }

  // 静态页（自有驾驶舱占位）
  if (method === 'GET') {
    let file = path.join(PUBLIC_DIR, u.pathname === '/' ? 'index.html' : u.pathname);
    if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(file));
    }
  }
  return json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => json(res, 500, { error: String(e?.message || e) }));
});

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  server.listen(PORT, '127.0.0.1', () => {
    log(`harness-server 监听 http://127.0.0.1:${PORT}`);
    log(`runsRoot=${RUNS_ROOT} agentDir=${AGENT_DIR} token=${readToken() ? 'on' : 'off'}`);
  });
}

export {
  startRun,
  resumeRun,
  stopRun,
  chatSend,
  execCommand,
  collectRuns,
  runDetail,
  getConfig,
  putConfig,
  collectModels,
  makeSession,
  defaultResumeSession,
  sessions,
};
