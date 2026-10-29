// 离线单测：验证 watcher 的终态判定 findRunForTask（不调模型、不 spawn pi）。
// 运行：cd pi-web-cockpit && node vendor/mini-harness-runtime/watcher.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-watcher-test-'));
process.env.MINI_HARNESS_RUNTIME_ROOT = path.join(tmp, 'runs');

const { findRunForTask } = await import('./watcher.mjs');

const RUNS = process.env.MINI_HARNESS_RUNTIME_ROOT;
const cwd = path.join(tmp, 'ws');
fs.mkdirSync(cwd, { recursive: true });
const resolved = fs.realpathSync(cwd);

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures += 1; console.error('  ✗', msg); }
  else console.log('  ✓', msg);
}

function reset() { fs.rmSync(RUNS, { recursive: true, force: true }); fs.mkdirSync(RUNS, { recursive: true }); }
function writeRun(id, { status, lastVerdict, workspace, ts }) {
  const dir = path.join(RUNS, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    runId: id, sessionId: 's-' + id, stage: 'run', round: 1, maxRounds: 5,
    status, lastVerdict, lastCode: lastVerdict === 'pass' ? 0 : 1,
    goal: 'g', workspace, baseWorkspace: workspace,
    createdAt: new Date(ts).toISOString(), updatedAt: new Date(ts).toISOString(),
  }, null, 2));
}

const NOW = Date.now();

console.log('用例 1：done + pass → done-pass');
reset();
writeRun('a', { status: 'done', lastVerdict: 'pass', workspace: resolved, ts: NOW });
assert(findRunForTask(cwd, NOW) === 'done-pass', 'done+pass 判成功');

console.log('用例 2：stopped（达最大轮数）→ not-pass');
reset();
writeRun('b', { status: 'stopped', lastVerdict: 'fail', workspace: resolved, ts: NOW });
const v2 = findRunForTask(cwd, NOW);
assert(v2.startsWith('not-pass:stopped/'), 'stopped 判失败：' + v2);

console.log('用例 3：active（pi 退出但 run 还在跑/卡住）→ not-pass');
reset();
writeRun('c', { status: 'active', lastVerdict: null, workspace: resolved, ts: NOW });
const v3 = findRunForTask(cwd, NOW);
assert(v3.startsWith('not-pass:active/'), 'active 判失败：' + v3);

console.log('用例 4：无任何 run → no-run');
reset();
assert(findRunForTask(cwd, NOW) === 'no-run', '空 runs 目录判 no-run');

console.log('用例 5：workspace 不匹配 → no-run');
reset();
writeRun('d', { status: 'done', lastVerdict: 'pass', workspace: resolved + '-other', ts: NOW });
assert(findRunForTask(cwd, NOW) === 'no-run', '不同 workspace 被忽略');

console.log('用例 6：createdAt 早于任务开始（陈旧 run）→ no-run');
reset();
writeRun('e', { status: 'done', lastVerdict: 'pass', workspace: resolved, ts: NOW - 60000 });
assert(findRunForTask(cwd, NOW) === 'no-run', '陈旧 run 被忽略');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
