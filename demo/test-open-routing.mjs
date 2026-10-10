#!/usr/bin/env node
// 打开路由回归（qa H1）：插件在线时 CLI 会话固定走 Terminal 续接，不得被送进插件；
// DSH 会话与目录外 ID 才交插件。隔离 HOME + 假插件 socket + osascript 桩，不触碰真实终端/DSH。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeModelFixture } from './test-model-fixture.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-open-'));
const fixture = writeModelFixture(home);
const osaLog = path.join(home, 'osascript.log');
const osaStub = path.join(home, 'bin', 'osascript');
fs.writeFileSync(osaStub, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> ' + JSON.stringify(osaLog) + '\nexit 0\n');
fs.chmodSync(osaStub, 0o755);

// DSH 目录证据：单帧 zstd 会话日志（header + 一条消息）；/api/open 对它必须走插件通道。
const dshSid = 'sess_dsh_fixture';
const dshDir = path.join(home, '.dsh', 'sessions', '--tmp-open--', dshSid);
fs.mkdirSync(dshDir, { recursive: true });
fs.writeFileSync(path.join(dshDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(
  [{ v: 1, type: 'session', id: dshSid, cwd: home, createdAt: Date.now(), version: '9.9.9' },
    { v: 1, type: 'user/message', seq: 1, time: Date.now(), data: { text: 'hi' } }]
    .map((o) => JSON.stringify(o)).join('\n') + '\n')));

// 假插件：HTTP-over-UnixSocket 最小实现；记录收到的请求供断言。
const requests = [];
const sockPath = path.join(home, 'plugin.sock');
const pluginServer = net.createServer((sock) => {
  let buf = '';
  sock.on('data', (c) => {
    buf += c.toString('utf8');
    const idx = buf.indexOf('\r\n\r\n');
    if (idx < 0) return;
    const head = buf.slice(0, idx);
    const method = (head.match(/^([A-Z]+) /) || [])[1] || '';
    const urlPath = (head.match(/^[A-Z]+ (\S+)/) || [])[1] || '';
    const len = Number((head.match(/content-length: (\d+)/i) || [])[1] || 0);
    const rawBody = buf.slice(idx + 4);
    if (rawBody.length < len) return;
    buf = '';
    if (urlPath === '/events') { sock.write('HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nConnection: keep-alive\r\n\r\n' + JSON.stringify({ ctl: 'hello', contract: 3 }) + '\n'); return; }
    let body = {};
    try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { /* 非 JSON：按空处理 */ }
    requests.push({ method, path: urlPath, body });
    const reply = urlPath === '/health'
      ? { ok: true, contract: 3, capabilities: { canInput: true, canCatalog: true, canOpen: true, canCreate: true }, modelSelection: { provider: 'p', model: 'm', reasoningEffort: 'high' } }
      : urlPath === '/open'
        ? { ok: false, code: 'open-rejected', detail: 'stub：DSH 不认识该 ID' }
        : { ok: true };
    const text = JSON.stringify(reply);
    sock.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(text) + '\r\nConnection: close\r\n\r\n' + text);
  });
  sock.on('error', () => {});
});
await new Promise((resolve) => pluginServer.listen(sockPath, resolve));

const port = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const child = spawn(process.execPath, [fileURLToPath(new URL('./framed.mjs', import.meta.url)), '--port', String(port)], {
  env: { ...process.env, ...fixture, HOME: home, PET_PLUGIN_SOCK: sockPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });
const base = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error('服务提前退出：' + output.slice(-500));
    try {
      const r = await fetch(base + '/api/state');
      if (r.ok) { const j = await r.json(); if (j.capabilities?.plugin?.available) { ready = true; break; } }
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, '服务或插件连线未就绪：' + output.slice(-500));
  const token = fs.readFileSync(path.join(home, '.agent-pet', 'token'), 'utf8').trim();
  const open = async (sessionId) => {
    const r = await fetch(base + '/api/open', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-pet-token': token },
      body: JSON.stringify({ sessionId }),
    });
    return { status: r.status, body: await r.json() };
  };

  // ① CLI 会话（Claude）：必须走 Terminal 续接，不能进插件
  const cli = await open('sess_fixture_cc');
  assert.equal(cli.status, 200, JSON.stringify(cli.body));
  assert.equal(cli.body.via, 'terminal', 'CLI 会话被非 Terminal 通道处理：' + JSON.stringify(cli.body));
  assert.equal(cli.body.opened, true);
  assert.ok(!requests.some((r2) => r2.path === '/open' && r2.body.sessionId === 'sess_fixture_cc'), '插件不得收到 CLI 会话的打开请求');
  const osaText = fs.readFileSync(osaLog, 'utf8');
  assert.ok(osaText.includes('Terminal') && osaText.includes('--resume') && osaText.includes('sess_fixture_cc'), 'osascript 未执行 CLI 续接：' + osaText.slice(0, 200));

  // ② DSH 会话：仍交插件（不误走 Terminal）
  const dsh = await open(dshSid);
  assert.equal(dsh.body.via, 'plugin', JSON.stringify(dsh.body));
  assert.ok(requests.some((r2) => r2.path === '/open' && r2.body.sessionId === dshSid), '插件未收到 DSH 会话的打开请求');

  // ③ 目录外 ID：仍交插件（保持旧回落语义）
  const unknown = await open('sess-not-in-any-catalog-zzz');
  assert.equal(unknown.body.via, 'plugin', JSON.stringify(unknown.body));
  console.log('打开路由：CLI 走 Terminal、DSH/未知 ID 交插件（qa H1）通过');
} finally {
  child.kill('SIGKILL');
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2500).unref(); }
  });
  pluginServer.close();
  fs.rmSync(home, { recursive: true, force: true });
}
