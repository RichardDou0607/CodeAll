#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-zcode-test-'));
const binDir = path.join(home, 'bin');
fs.mkdirSync(binDir);
const bin = path.join(binDir, 'zcode');
fs.copyFileSync(fileURLToPath(new URL('./mock-zcode.cjs', import.meta.url)), bin);
fs.chmodSync(bin, 0o755);
const calls = path.join(home, 'calls.jsonl');
const control = fileURLToPath(new URL('../adapters/cli-control.mjs', import.meta.url));
const run = (script, reject = false) => {
  fs.writeFileSync(calls, '');
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home, PATH: binDir + path.delimiter + process.env.PATH,
      PET_ZCODE_PIPE_MODEL: 'personal/mock-model', PET_ZCODE_UI_DELIVER: '0',
      MOCK_ZCODE_CALLS: calls, MOCK_ZCODE_REJECT: reject ? '1' : '0' },
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(p.status, 0, `signal=${p.signal} ${p.stderr || p.stdout}`);
  return { result: JSON.parse(p.stdout.trim()), calls: fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) };
};
try {
  const created = run(`import { deliverCreateViaZcodePipe } from ${JSON.stringify(control)};
    const r = await deliverCreateViaZcodePipe(${JSON.stringify(home)}, 'hello', 'personal/mock-model', {reasoningLevel:'low'});
    if (r.settle) await r.settle;
    console.log(JSON.stringify({ ok:r.ok, sessionId:r.sessionId }));`);
  assert.deepEqual(created.result, { ok: true, sessionId: 'sess_mock_create' });
  assert.deepEqual(created.calls.filter(c => c.method === 'session/create' || c.method === 'session/send').map(c => c.method), ['session/create', 'session/send']);
  assert.equal(created.calls.find(c => c.method === 'session/send').params.sessionId, 'sess_mock_create');
  assert.equal(created.calls.find(c => c.method === 'session/send').params.content, 'hello');
  assert.equal(created.calls.find(c => c.method === 'session/send').params.modelSelection.options.reasoningLevel, 'low');

  const slashModel = run(`import { deliverCreateViaZcodePipe } from ${JSON.stringify(control)};
    const r = await deliverCreateViaZcodePipe(${JSON.stringify(home)}, 'hello',
      {providerId:'personal',modelId:'vendor/model',reasoningEfforts:['enabled'],canCreate:true},
      {reasoningLevel:'enabled'});
    if(r.settle) await r.settle;
    console.log(JSON.stringify({ok:r.ok}));`);
  assert.equal(slashModel.result.ok, true);
  assert.equal(slashModel.calls.find(c => c.method === 'session/create').params.model.providerId, 'personal');
  assert.equal(slashModel.calls.find(c => c.method === 'session/send').params.modelSelection.modelId, 'vendor/model');
  assert.ok(slashModel.calls.some(c => c.method === 'session/subscribe'));

  const existing = run(`import { deliverViaCli } from ${JSON.stringify(control)};
    const r = await deliverViaCli('zcode', { sessionId:'sess_exact_target', cwd:${JSON.stringify(home)}, provider:'account:mock' }, 'exact');
    if (r.settle) await r.settle;
    console.log(JSON.stringify({ ok:r.ok }));`);
  assert.equal(existing.result.ok, true);
  assert.equal(existing.calls.find(c => c.method === 'session/resume').params.sessionId, 'sess_exact_target');
  assert.equal(existing.calls.find(c => c.method === 'session/send').params.sessionId, 'sess_exact_target');
  assert.equal(existing.calls.find(c => c.method === 'session/send').params.content, 'exact');

  const rejected = run(`import { deliverViaCli } from ${JSON.stringify(control)};
    const r = await deliverViaCli('zcode', { sessionId:'sess_exact_target', cwd:${JSON.stringify(home)}, provider:'account:mock' }, 'reject');
    console.log(JSON.stringify({ ok:r.ok, error:r.error }));`, true);
  assert.equal(rejected.result.ok, false);
  assert.deepEqual(rejected.calls.filter(c => c.method === 'session/send').length, 1);
  assert.ok(!rejected.calls.some(c => c.method === 'session/create'));

  const selected = run(`import { pickZcodePipeModel } from ${JSON.stringify(control)};
    console.log(JSON.stringify(pickZcodePipeModel()));`);
  assert.equal(selected.result.options.reasoningLevel, 'max');
  const dbFile = path.join(home, '.zcode', 'cli', 'db', 'db.sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE session_entry (id TEXT PRIMARY KEY, data TEXT, time_updated INTEGER)');
  const sid = 'sess_rollback';
  const original = JSON.stringify({ modelSelection: { providerId: 'account:plan', modelId: 'glm', options: { reasoningLevel: 'max' } } });
  const pipe = JSON.stringify({ modelSelection: { providerId: 'personal', modelId: 'mock-model', options: { reasoningLevel: 'max' } } });
  const alteredPipe = JSON.stringify({ modelSelection: { modelId: 'mock-model', providerId: 'personal', options: { reasoningLevel: 'max' } } });
  db.prepare('INSERT INTO session_entry (id, data, time_updated) VALUES (?, ?, ?)').run(sid + ':runtime-model-selection', alteredPipe, Date.now());
  const marker = path.join(home, '.agent-pet', 'cli-control', 'zcode-rollback-' + sid + '.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ sessionId: sid, originalRaw: original, pipeRaw: pipe }));
  const recovered = run(`import { recoverZcodePendingRollbacks } from ${JSON.stringify(control)};
    console.log(JSON.stringify({ count:recoverZcodePendingRollbacks() }));`);
  assert.equal(recovered.result.count, 1);
  assert.equal(db.prepare('SELECT data FROM session_entry WHERE id = ?').get(sid + ':runtime-model-selection').data, original);
  assert.equal(fs.existsSync(marker), false);
  db.prepare('UPDATE session_entry SET data = ? WHERE id = ?').run(JSON.stringify({ modelSelection: { providerId: 'personal:user-choice', modelId: 'chosen', options: { reasoningLevel: 'max' } } }), sid + ':runtime-model-selection');
  fs.writeFileSync(marker, JSON.stringify({ sessionId: sid, originalRaw: original, pipeRaw: pipe }));
  const skipped = run(`import { recoverZcodePendingRollbacks } from ${JSON.stringify(control)};
    console.log(JSON.stringify({ count:recoverZcodePendingRollbacks() }));`);
  assert.equal(skipped.result.count, 0);
  assert.equal(JSON.parse(db.prepare('SELECT data FROM session_entry WHERE id = ?').get(sid + ':runtime-model-selection').data).modelSelection.modelId, 'chosen');
  db.close();
  console.log('ZCode 管道：新建+首条消息、指定会话投递、失败不回落通过');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
