#!/usr/bin/env node
// 服务健壮性回归：请求体上限（Content-Length / chunked）、业务异常与畸形 ID 响应、
// zcode 日志目录不可写（M2）、无 DSH 日志仍有 2s SSE 心跳（M4）。
// 隔离 HOME + mock zcode + 合成 DB，不触碰真实数据与真实 Agent。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { writeModelFixture } from './test-model-fixture.mjs';
import { isolatedEnv } from './test-env.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-harden-'));
const fixture = writeModelFixture(home);
const zcodeBin = path.join(home, 'bin', 'zcode');
fs.copyFileSync(fileURLToPath(new URL('./mock-zcode.cjs', import.meta.url)), zcodeBin);
fs.chmodSync(zcodeBin, 0o755);
const calls = path.join(home, 'zcode-calls.jsonl');
const dbFile = path.join(home, '.zcode', 'cli', 'db', 'db.sqlite');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new DatabaseSync(dbFile);
db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, path TEXT, directory TEXT, title TEXT,
    version TEXT, task_type TEXT, title_source TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
  CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  CREATE TABLE part (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  CREATE TABLE session_entry (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, data TEXT, time_created INTEGER, time_updated INTEGER);`);
db.prepare('INSERT INTO session (id, path, title, task_type, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
  .run('sess_fixture_zc', home, 'fixture zcode', 'main', Date.now(), Date.now());
db.close();

// M2 场景：管道日志目录被占成普通文件 → fs.mkdirSync(CONTROL_DIR) 必然失败
fs.mkdirSync(path.join(home, '.agent-pet'), { recursive: true });
fs.writeFileSync(path.join(home, '.agent-pet', 'cli-control'), 'not-a-dir');
fs.writeFileSync(path.join(home, '.agent-pet', 'input-queue.jsonl'), JSON.stringify({
  id: 'in-retry-error', text: 'hello', at: Date.now(), status: 'queued', accepted: false,
  sessionId: 'sess_fixture_zc', source: 'zcode', targetKey: 'sess:sess_fixture_zc',
}) + '\n');

const port = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const child = spawn(process.execPath, [fileURLToPath(new URL('./framed.mjs', import.meta.url)), '--port', String(port)], {
  env: isolatedEnv(home, { ...fixture, MOCK_ZCODE_CALLS: calls, MOCK_ZCODE_DB: dbFile, PET_ZCODE_PIPE_MODEL: 'personal/mock-model' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });
const base = `http://127.0.0.1:${port}`;

/** 连 /api/stream，数 ms 窗口内收到的快照条数（初始帧 + 心跳）。 */
async function countSnapshots(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  let n = 0;
  try {
    const res = await fetch(base + '/api/stream', { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n'); buf = parts.pop() ?? '';
      for (const p of parts) if (p.startsWith('data: ')) n++;
    }
  } catch { /* abort 结束读取 */ }
  clearTimeout(timer);
  return n;
}

try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error('服务提前退出：' + output.slice(-500));
    try { const r = await fetch(base + '/api/state'); if (r.ok) { ready = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, '服务未就绪：' + output.slice(-500));
  const token = fs.readFileSync(path.join(home, '.agent-pet', 'token'), 'utf8').trim();
  const coldPlan = await (await fetch(base + '/api/plan-usage')).json();
  assert.equal(coldPlan.pending, true, '无参首次调用 /api/plan-usage 只能读缓存，不得自行重算计划层');

  const bodyRoutes = ['/api/open', '/api/new', '/api/input', '/api/queue/group/clear', '/api/input/missing/resend'];
  for (const route of bodyRoutes) {
    const oversized = await fetch(base + route, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-pet-token': token },
      body: JSON.stringify({ padding: 'x'.repeat(8193) }),
    });
    assert.equal(oversized.status, 413, route + ' 必须在读取完整请求体前拒绝超限输入');
    assert.equal((await oversized.json()).error, 'oversized', route);
  }
  const chunked = await new Promise((resolve, reject) => {
    const request = http.request(base + '/api/open', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-pet-token': token },
    }, response => {
      let raw = '';
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(raw) }));
    });
    request.on('error', reject);
    request.write('{"sessionId":"');
    request.write('x'.repeat(8193));
    request.end('"}');
  });
  assert.equal(chunked.status, 413, '无 Content-Length 的 chunked 请求也必须按实际字节拒绝');
  assert.equal(chunked.body.error, 'oversized');
  const invalidJson = await fetch(base + '/api/open', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-pet-token': token },
    body: '{"sessionId":',
  });
  assert.equal(invalidJson.status, 400, '损坏 JSON 不得被当成空会话 ID 交给打开路由');
  assert.equal((await invalidJson.json()).error, 'invalid-json');

  const retryTmp = path.join(home, '.agent-pet', 'input-queue.jsonl.tmp');
  fs.mkdirSync(retryTmp);
  let retryResult = null, retryError = null;
  try {
    const r = await fetch(base + '/api/input/in-retry-error/resend', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-pet-token': token },
      body: '{}', signal: AbortSignal.timeout(3000),
    });
    retryResult = { status: r.status, body: await r.json() };
  } catch (e) { retryError = e; }
  fs.rmSync(retryTmp, { recursive: true, force: true });
  assert.equal(retryResult?.status, 500, '业务异常必须返回响应，不能让客户端等待超时：' + String(retryError || ''));
  assert.equal(retryResult?.body.error, 'internal-error');

  let malformedResult = null, malformedError = null;
  try {
    const r = await fetch(base + '/api/input/%E0%A4%A', {
      method: 'DELETE', headers: { 'x-pet-token': token }, signal: AbortSignal.timeout(3000),
    });
    malformedResult = { status: r.status, body: await r.json() };
  } catch (e) { malformedError = e; }
  assert.equal(malformedResult?.status, 400, '畸形会话 ID 必须返回 400，不能让客户端等待超时：' + String(malformedError || ''));
  assert.equal(malformedResult?.body.error, 'invalid-session-id');
  const malformedResend = await fetch(base + '/api/input/%E0%A4%A/resend', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-pet-token': token }, body: '{}',
  });
  assert.equal(malformedResend.status, 400, '重发路径也应把畸形 ID 视为客户端错误');
  assert.equal((await malformedResend.json()).error, 'invalid-session-id');

  // ① M2：日志目录不可写时的新建投递 → 服务必须活着并给出正常 JSON 响应
  let created = null, postErr = null;
  try {
    const r = await fetch(base + '/api/new', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-pet-token': token },
      body: JSON.stringify({ source: 'zcode', cwd: home, model: 'personal/mock-model', reasoningEffort: 'high', text: 'hello' }),
    });
    created = { status: r.status, body: await r.json() };
  } catch (e) { postErr = e; }
  assert.ok(created, 'M2：zcode 新建请求未得到响应（服务疑似崩溃）' + (postErr ? '：' + postErr.message : '')
    + ' · 服务输出尾部：' + output.slice(-300));
  assert.ok([200, 202].includes(created.status), 'M2：应为 202/200，实际 ' + created.status + ' ' + JSON.stringify(created.body).slice(0, 200));
  assert.equal(child.exitCode, null, 'M2：服务进程不得退出');
  const alive = await (await fetch(base + '/api/state')).json();
  assert.ok(alive && Array.isArray(alive.sessions), 'M2：异常后服务仍应可查');

  // ② M4：无 DSH 会话日志 → SSE 仍需 2s 心跳（3.2s 窗口至少 2 帧：初始帧 + ≥1 心跳）
  const snaps = await countSnapshots(3200);
  assert.ok(snaps >= 2, 'M4：SSE 快照数不足（' + snaps + '）——无 DSH 日志时计时会冻结');

  console.log('服务健壮性：写路由 body 上限（含 chunked）+ 异常/畸形 ID 响应 + 日志目录容错（M2）+ SSE 心跳（M4，3.2s 内 ' + snaps + ' 帧）通过');
} finally {
  child.kill('SIGKILL');
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2500).unref(); }
  });
  fs.rmSync(home, { recursive: true, force: true });
}
