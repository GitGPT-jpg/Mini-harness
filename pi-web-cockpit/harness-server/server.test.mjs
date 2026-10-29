// 离线单测：不花模型钱，验证 server.mjs 核心控制流
// （启动→run 落盘→存活→重启孤儿→resume→停止→输入校验）。
// 运行：cd pi-web-cockpit && node harness-server/server.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在 import server.mjs 之前设置：server 在模块加载期读这些环境变量
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-srv-test-'));
process.env.MINI_HARNESS_RUNTIME_ROOT = path.join(tmp, 'runs');
process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'agent');
process.env.HARNESS_PORT = '0'; // 不进监听分支（isMain=false）

const { startRun, resumeRun, stopRun, collectRuns, sessions } = await import('./server.mjs');

const RUNS = process.env.MINI_HARNESS_RUNTIME_ROOT;
fs.mkdirSync(RUNS, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error('  ✗', msg);
  } else {
    console.log('  ✓', msg);
  }
}

function writeState(runId, sessionId, status) {
  const dir = path.join(RUNS, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      runId,
      sessionId,
      stage: 'run',
      round: 1,
      maxRounds: 5,
      status,
      lastVerdict: null,
      lastCode: null,
      goal: 'test goal',
      baseWorkspace: '/tmp/ws',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2),
  );
}

// mock 会话：prompt 立即落盘一个 active run（模拟模型调 loop_start）
function fakeSession(sessionId, runId) {
  return {
    sessionId,
    prompt: () => { writeState(runId, sessionId, 'active'); return Promise.resolve(); },
    abort: async () => {},
    dispose: () => {},
  };
}

console.log('用例 1：启动（异步）→ 202 + sessionId，run 落盘后 alive=true');
let mkCalls = 0;
const r1 = await startRun(
  { goal: 'test goal' },
  { makeSession: async () => { mkCalls += 1; return fakeSession('sess-1', 'run-1'); } },
);
assert(r1.status === 202, 'start 返回 202');
assert(r1.body.sessionId === 'sess-1', 'sessionId 正确');
assert(r1.body.pending === true, 'pending 标记');
assert(mkCalls === 1, 'makeSession 恰好调用一次');
let runs = collectRuns();
assert(runs.length === 1 && runs[0].alive === true && runs[0].runId === 'run-1', 'start 后 alive=true 且 runId 正确');

console.log('用例 2：模拟服务重启（清空会话表）→ alive=false');
sessions.clear();
runs = collectRuns();
assert(runs.length === 1 && runs[0].alive === false, '重启后 active run 标 alive=false');

console.log('用例 3：resume 活跃 run → 202 且会话重新注册');
const r2 = await resumeRun('run-1', {
  resumeSession: async (ws, sid) => {
    assert(sid === 'sess-1', 'resume 传入正确的 sessionId');
    return fakeSession('sess-1', 'run-1');
  },
});
assert(r2.status === 202 && r2.body.resumed === true, 'resume 返回 202/resumed');
assert(sessions.has('sess-1'), 'resume 后会话重新注册');
runs = collectRuns();
assert(runs[0].alive === true, 'resume 后 alive=true');

console.log('用例 4：停止 → stopped/user-stop');
const rStop = await stopRun('run-1');
assert(rStop.status === 200 && rStop.body.status === 'stopped' && rStop.body.stopReason === 'user-stop', '停止生效');

console.log('用例 5：resume 非活跃 run → 409');
const r3 = await resumeRun('run-1', { resumeSession: async () => { throw new Error('不应调用'); } });
assert(r3.status === 409, '非活跃态 resume 返回 409');

console.log('用例 6：resume 不存在的 run → 404');
const r4 = await resumeRun('nope', { resumeSession: async () => null });
assert(r4.status === 404, '不存在 run 404');

console.log('用例 7：resume 但找不到会话文件 → 404');
writeState('run-2', 'sess-2', 'active');
const r5 = await resumeRun('run-2', { resumeSession: async () => null });
assert(r5.status === 404, '会话文件缺失 404');

console.log('用例 8：空 goal → 400，且不触发建会话');
let called = 0;
const r6 = await startRun({}, { makeSession: async () => { called += 1; return fakeSession('x', 'y'); } });
assert(r6.status === 400, '空 goal 返回 400');
assert(called === 0, '未调用 makeSession');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
