#!/usr/bin/env node
// Local API regression: isolated HOME and socket, no real Agent input.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { writeModelFixture } from './test-model-fixture.mjs';
import { isolatedEnv } from './test-env.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-input-test-'));
const modelEnv = writeModelFixture(home);
const binDir = path.join(home, 'bin');
const zcodeBin = path.join(binDir, 'zcode');
fs.copyFileSync(fileURLToPath(new URL('./mock-zcode.cjs', import.meta.url)), zcodeBin);
fs.chmodSync(zcodeBin, 0o755);
const calls = path.join(home, 'zcode-calls.jsonl');
const unsafeFallback = path.join(home, 'unsafe-dsh-fallback');
const claudeDir = path.join(home, '.claude', 'projects', 'mock-project');
fs.mkdirSync(claudeDir, { recursive: true });
fs.writeFileSync(path.join(claudeDir, 'mock-claude.jsonl'),
  JSON.stringify({ type: 'user', cwd: home, entrypoint: 'cli', timestamp: new Date().toISOString(),
    isSidechain: false, message: { content: 'test project' } }) + '\n');
const codexDir = path.join(home, '.codex', 'sessions', '2026', '10', '09');
fs.mkdirSync(codexDir, { recursive: true });
fs.writeFileSync(path.join(codexDir, 'rollout-2026-10-09T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'),
  JSON.stringify({ type: 'session_meta', timestamp: new Date().toISOString(),
    payload: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd: home, originator: 'codex-cli' } }) + '\n');
const kimiDir = path.join(home, '.kimi-code', 'sessions', 'wd_mock', 'session_mock');
fs.mkdirSync(kimiDir, { recursive: true });
fs.writeFileSync(path.join(kimiDir, 'state.json'),
  JSON.stringify({ id: 'session_mock', cwd: home, title: 'test project', createdAt: Date.now(), updatedAt: Date.now() }));
const dbFile = path.join(home, '.zcode', 'cli', 'db', 'db.sqlite');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new DatabaseSync(dbFile);
db.exec(`CREATE TABLE session (
  id TEXT PRIMARY KEY, parent_id TEXT, path TEXT, directory TEXT, title TEXT,
  version TEXT, task_type TEXT, title_source TEXT,
  time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
  CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  CREATE TABLE part (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  CREATE TABLE session_entry (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, data TEXT, time_created INTEGER, time_updated INTEGER);`);
for (const sid of ['sess_mock_target_a', 'sess_mock_target_b']) {
  db.prepare('INSERT INTO session (id, path, title, task_type, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sid, home, sid, 'main', Date.now(), Date.now());
  db.prepare('INSERT INTO session_entry (id, session_id, type, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sid + ':runtime-model-selection', sid, 'runtime/model_selection',
      JSON.stringify({ modelSelection: { providerId: 'account:plan', modelId: 'glm', options: { reasoningLevel: 'max' } } }), Date.now(), Date.now());
}
db.close();
fs.mkdirSync(path.join(home, '.agent-pet'), { recursive: true });
fs.writeFileSync(path.join(home, '.agent-pet', 'input-queue.jsonl'),
  JSON.stringify({ id: 'in-restart', text: 'already accepted', at: Date.now(),
    status: 'pending', accepted: true, sessionId: 'sess_mock_missing',
    source: 'zcode', targetKey: 'sess:sess_mock_missing' }) + '\n'
  + JSON.stringify({ id: 'in-stale-model', text: 'must not create', at: Date.now(),
    status: 'queued', accepted: false, source: 'codex', model: 'removed-model',
    reasoningEffort: 'high', targetKey: 'new:codex:' + home }) + '\n');
const port = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const child = spawn(process.execPath, [fileURLToPath(new URL('./framed.mjs', import.meta.url)), '--port', String(port)], {
  env: isolatedEnv(home, { ...modelEnv, PATH: binDir + path.delimiter + process.env.PATH,
    PET_PLUGIN_SOCK: path.join(home, 'missing.sock'), PET_INPUT_CMD: 'touch ' + unsafeFallback,
    PET_ZCODE_PIPE_MODEL: 'personal/mock-model', MOCK_ZCODE_CALLS: calls, MOCK_ZCODE_DB: dbFile }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', d => { output += d; });
child.stderr.on('data', d => { output += d; });
const base = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('服务提前退出：' + output.slice(-500));
    try { const r = await fetch(base + '/api/state'); if (r.ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready, '服务未启动：' + output.slice(-500));
  const token = fs.readFileSync(path.join(home, '.agent-pet', 'token'), 'utf8').trim();
  const post = async (route, body) => {
    const r = await fetch(base + route, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-pet-token': token },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const state = async () => (await (await fetch(base + '/api/state')).json()).inputs;
  const interrupted = (await state()).find(i => i.id === 'in-restart');
  assert.equal(interrupted.id, 'in-restart');
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.accepted, true);
  assert.equal((await post('/api/input/in-restart/resend', {})).status, 409);
  const missingLegacyTarget = await post('/api/input/in-restart/resend', { confirm: true });
  assert.equal(missingLegacyTarget.status, 502);
  assert.ok(missingLegacyTarget.body.item.detail.includes('原目标不可用'));
  assert.ok(!fs.existsSync(calls), '旧队列目标不可用时不可调用 Agent');
  const staleRetry = await post('/api/input/in-stale-model/resend', {});
  assert.equal(staleRetry.status, 502);
  assert.ok(staleRetry.body.item.detail.includes('不在该 Agent'));
  assert.ok(!fs.existsSync(modelEnv.MOCK_CLI_CALLS), 'removed model retry must not invoke the CLI');
  await post('/api/queue/clear', {});

  assert.equal((await post('/api/new', { source: 'dsh', cwd: home })).status, 400);
  assert.equal((await post('/api/new', { source: 'codex', cwd: home, text: 'hello' })).status, 400);
  assert.equal((await post('/api/new', { source: 'codex', cwd: home, model: 'test-model', text: 'hello' })).body.error, 'reasoning-required');
  assert.equal((await post('/api/new', { source: 'codex', cwd: home, model: 'not-registered', reasoningEffort: 'high', text: 'hello' })).body.error, 'model-not-registered');
  assert.equal((await post('/api/new', { source: 'codex', cwd: home, model: 'test-model', reasoningEffort: 'bogus', text: 'hello' })).body.error, 'reasoning-not-supported');
  assert.equal((await post('/api/new', { source: 'codex', cwd: '/tmp', model: 'test-model', reasoningEffort: 'high', text: 'hello' })).body.error, 'cwd-not-registered');
  assert.equal((await post('/api/new', { source: 'codex', model: 'test-model', reasoningEffort: 'high', text: 'hello' })).body.error, 'cwd-required');
  assert.equal((await post('/api/input', { sessionId: 'new:codex:/tmp', model: 'test-model', reasoningEffort: 'high', text: 'hello' })).status, 400);
  assert.equal((await post('/api/new', { source: 'unknown', cwd: home, text: 'hello' })).status, 400);
  assert.equal((await post('/api/new', { source: 'dsh', model: 'unknown', reasoningEffort: 'high', text: 'hello' })).body.error, 'model-registry-unavailable');
  assert.equal((await post('/api/new', { source: 'zcode', cwd: home, model: 'account:plan/glm', reasoningEffort: 'enabled', text: 'hello' })).body.error, 'model-not-creatable');
  assert.equal((await post('/api/input', { sessionId: 'new:zcode:' + home, text: 'hello' })).status, 400);
  assert.equal((await post('/api/input', { sessionId: 'new:zcode:' + home, model: 'personal/mock-model', text: 'hello' })).status, 400);
  assert.equal((await post('/api/input', { sessionId: 'sess_mock_target_', text: 'ambiguous' })).status, 404);
  assert.equal((await state()).length, 0, '非法新建不能生成队列项');
  const cliCreations = [
    { source: 'claude-code', model: 'sonnet', reasoningEffort: 'xhigh', text: 'claude first' },
    { source: 'codex', model: 'test-model', reasoningEffort: 'ultra', text: 'codex first' },
    { source: 'kimi-code', model: 'kimi-code/k3', reasoningEffort: 'high', text: 'kimi first' },
  ];
  for (const body of cliCreations) {
    const created = await post('/api/new', { ...body, cwd: home });
    assert.equal(created.status, 200, body.source + ': ' + (created.body.item?.detail || created.body.error));
    assert.equal(created.body.item.model, body.model, 'queue metadata keeps canonical registry id');
  }
  const cliCalls = fs.readFileSync(modelEnv.MOCK_CLI_CALLS, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(cliCalls.find(c => c.binary === 'codex').args.includes('model_reasoning_effort="ultra"'));
  assert.deepEqual(cliCalls.find(c => c.binary === 'kimi').args, ['-m', 'kimi-code/k3', '-p', 'kimi first']);
  assert.equal((await post('/api/input', { sessionId: 'new:kimi-code:' + home, model: 'k3', reasoningEffort: 'high', text: 'bare alias' })).body.error, 'model-not-registered');
  const exact = await post('/api/input', { sessionId: 'sess_mock_target_b', text: 'exact' });
  assert.equal(exact.status, 202);
  assert.equal(exact.body.item.sessionId, 'sess_mock_target_b');
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)
    .find(c => c.method === 'session/send').params.sessionId, 'sess_mock_target_b');
  for (let i = 0; i < 15 && (await state()).some(item => item.status === 'pending'); i++)
    await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await state()).length, 0);

  const withoutTarget = await post('/api/input', { text: '不得自动投递' });
  assert.equal(withoutTarget.status, 400);
  assert.equal(withoutTarget.body.error, 'target-required');
  assert.ok(!fs.existsSync(unsafeFallback), 'DSH 离线时不可执行未绑定 session ID 的旧命令');
  assert.deepEqual((await state()).map(i => i.id), [], '无目标请求不能生成队列项');
  assert.ok(!fs.existsSync(unsafeFallback), 'DSH 离线时不能调用旧命令');
  const clear = await post('/api/queue/group/clear', { key: 'new:dsh:-' });
  assert.equal(clear.body.cleared, 0);
  assert.equal((await state()).length, 0);
  const rejected = await post('/api/new', { source: 'zcode', cwd: home, model: 'personal/mock-model', reasoningEffort: 'high', text: 'reject' });
  assert.equal(rejected.status, 502);
  assert.equal(rejected.body.sessionId, 'sess_mock_create');
  assert.equal(rejected.body.item.targetKey, 'sess:sess_mock_create');
  assert.equal(rejected.body.item.accepted, true, '发送结果不明时应保守标记可能已接收');
  const failedId = rejected.body.item.id;
  assert.equal((await post(`/api/input/${failedId}/resend`, {})).status, 409);
  const recheck = await post(`/api/input/${failedId}/resend`, { confirm: true });
  assert.equal(recheck.body.item.id !== failedId, true);
  assert.equal(recheck.body.item.reasoningEffort, 'high');
  assert.deepEqual((await state()).map(i => i.id), [failedId], '新建后首条发送失败时仍原位重试');
  const methods = fs.readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l).method);
  assert.equal(methods.filter(m => m === 'session/create').length, 1, '重试必须续接已创建会话');
  assert.ok(methods.includes('session/resume'));
  await post('/api/queue/clear', {});

  const slash = await post('/api/new', { source: 'zcode', cwd: home, model: 'personal/vendor/model', reasoningEffort: 'high', text: 'slash model' });
  assert.equal(slash.status, 202);
  const slashCall = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).filter(c => c.method === 'session/create').at(-1);
  assert.equal(slashCall.params.model.providerId, 'personal');
  assert.equal(slashCall.params.model.modelId, 'vendor/model');
  for (let i = 0; i < 15 && (await state()).some(item => item.status === 'pending'); i++)
    await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await state()).length, 0);

  const late = await post('/api/new', { source: 'zcode', cwd: home, model: 'personal/mock-model', reasoningEffort: 'low', text: 'late-fail' });
  assert.equal(late.status, 202);
  assert.equal(late.body.item.status, 'pending');
  assert.equal((await state()).length, 1, '已接收回合在终态前仍可见');
  for (let i = 0; i < 30 && (await state())[0]?.status !== 'failed'; i++)
    await new Promise(resolve => setTimeout(resolve, 150));
  const [lateItem] = await state();
  assert.equal(lateItem.status, 'failed');
  assert.equal(lateItem.accepted, true);
  assert.equal((await post(`/api/input/${lateItem.id}/resend`, {})).status, 409, '已接收消息须确认才能重发');
  assert.equal((await state()).length, 1);
  console.log('输入 API：新建必填、同 ID 重发、ZCode 终态失败与重复发送保护通过');
} finally {
  child.kill();
  await new Promise(resolve => {
    if (child.exitCode !== null) resolve();
    else { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000).unref(); }
  });
  fs.rmSync(home, { recursive: true, force: true });
}
