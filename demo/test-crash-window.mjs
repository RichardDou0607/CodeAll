#!/usr/bin/env node
// V05 崩溃窗口回归（CORE-4）：投递动作执行前必须先落盘 pending——执行中 kill -9 后重启，
// 队列条目仍在、标「结果未确认」、原文/目标保留、不增殖、不自动重发。
// 覆盖四条路径：CLI 续会话无头投递、DSH 插件（4s 超时窗口）、投递即新建、失败条目重发；
// 顺带断言 cli-exit 快速失败（V04：立即退出的 CLI 回报可辨失败，不当「已投递」）。
// 隔离 HOME + mock CLI + 假插件 socket，不触碰真实 Agent、不消耗额度。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeModelFixture } from './test-model-fixture.mjs';
import { isolatedEnv } from './test-env.mjs';

const framed = fileURLToPath(new URL('./framed.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readQueue(home) {
  const file = path.join(home, '.agent-pet', 'input-queue.jsonl');
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
async function waitReady(child, base, home, wantPlugin = false) {
  let output = '';
  child.stdout?.on('data', (d) => { output += d; });
  child.stderr?.on('data', (d) => { output += d; });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error('服务提前退出：' + output.slice(-500));
    try {
      const r = await fetch(base + '/api/state');
      if (r.ok) {
        const j = await r.json();
        if (!wantPlugin || j.capabilities?.plugin?.available) return;
      }
    } catch { /* 未就绪 */ }
    await sleep(100);
  }
  throw new Error('服务未就绪：' + output.slice(-500));
}
async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function startService(home, fixture, port, cliMode = '') {
  const child = spawn(process.execPath, [framed, '--port', String(port)], {
    env: isolatedEnv(home, { ...fixture, PET_PLUGIN_SOCK: path.join(home, 'missing.sock'),
      PET_INPUT_CMD: '', MOCK_CLI_MODE: cliMode }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}
async function killService(child, home) {
  child.kill('SIGKILL');
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else { child.once('exit', resolve); setTimeout(resolve, 2500).unref(); }
  });
  // 无头投递是 detached spawn：杀掉服务后清掉残留的 mock CLI，避免挂满 60s
  if (home) { try { spawnSync('pkill', ['-f', path.join(home, 'bin') + path.sep]); } catch { /* 无残留 */ } }
  await sleep(150);
}
async function post(base, token, route, body) {
  const r = await fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-pet-token': token }, body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function pollPending(home, match) {
  for (let i = 0; i < 120; i++) {
    const hit = readQueue(home).find(match);
    if (hit && hit.status === 'pending') return hit;
    await sleep(50);
  }
  throw new Error('执行前 pending 落盘未出现：' + JSON.stringify(readQueue(home)));
}
function readCalls(file) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}
async function pollCalls(file, pred) {
  for (let i = 0; i < 100; i++) {
    const calls = readCalls(file);
    if (pred(calls)) return calls;
    await sleep(50);
  }
  throw new Error('mock CLI 未记录到预期调用');
}
async function assertUnconfirmedAfterRestart(home, match, extra) {
  const entries = readQueue(home).filter(match);
  assert.equal(entries.length, 1, '同一消息不得增殖队列记录：' + JSON.stringify(readQueue(home).map((i) => i.id)));
  const entry = entries[0];
  assert.equal(entry.status, 'failed', '重启后应标失败待核对：' + JSON.stringify(entry));
  assert.ok(entry.detail.includes('结果未确认'), '缺少「结果未确认」提示：' + entry.detail);
  if (extra) extra(entry);
}
async function restartAndAssert(home, fixture, port, match, extra) {
  const child = startService(home, fixture, port);
  await waitReady(child, `http://127.0.0.1:${port}`, home);
  try { await assertUnconfirmedAfterRestart(home, match, extra); }
  finally { await killService(child, home); }
  return child;
}

// ---------- 场景 A：CLI 续会话投递执行中 kill -9 ----------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-crash-cli-'));
  const fixture = writeModelFixture(home);
  const port = await freePort();
  const marker = 'cli crash window A';
  const child = startService(home, fixture, port, 'hang');
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitReady(child, base, home);
    const token = fs.readFileSync(path.join(home, '.agent-pet', 'token'), 'utf8').trim();
    post(base, token, '/api/input', { sessionId: 'sess_fixture_cc', text: marker }).catch(() => null);
    const pre = await pollPending(home, (i) => i.text === marker);
    assert.equal(pre.sessionId, 'sess_fixture_cc', 'pending 记录须带目标会话');
    await pollCalls(fixture.MOCK_CLI_CALLS, (cs) => cs.some((c) => c.args.includes(marker)));
    await killService(child, home);
    await restartAndAssert(home, fixture, port, (i) => i.text === marker,
      (entry) => { assert.equal(entry.sessionId, 'sess_fixture_cc'); assert.equal(entry.source, 'claude-code'); });
    const calls = readCalls(fixture.MOCK_CLI_CALLS);
    assert.equal(calls.filter((c) => c.args.includes(marker)).length, 1, '重启后不得自动重发失败条目');
    console.log('崩溃窗口 A：CLI 续会话投递中 kill -9 → 重启后「结果未确认」且不自动重发 ✓');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ---------- 场景 B：DSH 插件 4s 窗口内 kill -9（假插件收到请求但永不响应） ----------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-crash-dsh-'));
  const fixture = writeModelFixture(home);
  const dshSid = 'sess_dsh_crash_b';
  const dshDir = path.join(home, '.dsh', 'sessions', '--tmp-crash--', dshSid);
  fs.mkdirSync(dshDir, { recursive: true });
  fs.writeFileSync(path.join(dshDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(
    [{ v: 1, type: 'session', id: dshSid, cwd: home, createdAt: Date.now(), version: '9.9.9' },
      { v: 1, type: 'user/message', seq: 1, time: Date.now(), data: { text: 'hi' } }]
      .map((o) => JSON.stringify(o)).join('\n') + '\n')));
  const inputs = [];
  const sockets = new Set();
  const sockPath = path.join(home, 'plugin.sock');
  const pluginServer = net.createServer((sock) => {
    sockets.add(sock);
    let buf = '';
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = buf.slice(0, idx);
      const urlPath = (head.match(/^[A-Z]+ (\S+)/) || [])[1] || '';
      if (urlPath === '/events') { sock.write('HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nConnection: keep-alive\r\n\r\n' + JSON.stringify({ ctl: 'hello', contract: 3 }) + '\n'); buf = ''; return; }
      if (urlPath === '/health') {
        const text = JSON.stringify({ ok: true, contract: 3, capabilities: { canInput: true, canCatalog: true, canOpen: true, canCreate: true }, modelSelection: { provider: 'p', model: 'm', reasoningEffort: 'high' } });
        sock.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(text) + '\r\nConnection: close\r\n\r\n' + text);
        buf = ''; return;
      }
      // /input：记录后保持连接不响应——制造「可能已送达但调用方无痕」的 4s 窗口
      inputs.push(urlPath);
      buf = '';
    });
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise((resolve) => pluginServer.listen(sockPath, resolve));
  const port = await freePort();
  const marker = 'dsh crash window B';
  const baseEnv = isolatedEnv(home, { ...fixture, PET_PLUGIN_SOCK: sockPath, PET_INPUT_CMD: '', MOCK_CLI_MODE: '' });
  const child = spawn(process.execPath, [framed, '--port', String(port)], { env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitReady(child, base, home, true);
    const token = fs.readFileSync(path.join(home, '.agent-pet', 'token'), 'utf8').trim();
    post(base, token, '/api/input', { sessionId: dshSid, text: marker }).catch(() => null);
    await pollPending(home, (i) => i.text === marker);
    await killService(child, null);
    for (const s of sockets) s.destroy();
    await sleep(100);
    // 重启时假插件仍在（只回 /health），不重发未确认条目
    const child2 = spawn(process.execPath, [framed, '--port', String(port)], { env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await waitReady(child2, base, home, true);
      await assertUnconfirmedAfterRestart(home, (i) => i.text === marker,
        (entry) => { assert.equal(entry.sessionId, dshSid); });
      assert.equal(inputs.filter((p) => p === '/input').length, 1, '重启后不得向插件重发未确认消息');
    } finally { await killService(child2, null); }
    console.log('崩溃窗口 B：插件 4s 窗口内 kill -9 → 重启后「结果未确认」且不重发 ✓');
  } finally {
    await killService(child, null);   // 失败路径也要回收服务进程，避免隔离测试泄漏端口占用
    for (const s of sockets) s.destroy();
    pluginServer.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ---------- 场景 C：投递即新建执行中 kill -9 ----------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-crash-new-'));
  const fixture = writeModelFixture(home);
  const port = await freePort();
  const marker = 'create crash window C';
  const child = startService(home, fixture, port, 'hang');
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitReady(child, base, home);
    const token = fs.readFileSync(path.join(home, '.agent-pet', 'token'), 'utf8').trim();
    post(base, token, '/api/new', { source: 'codex', cwd: home, model: 'test-model', reasoningEffort: 'high', text: marker }).catch(() => null);
    const pre = await pollPending(home, (i) => i.text === marker);
    assert.equal(pre.targetKey, 'new:codex:' + home, '新建目标的 pending 记录须保留来源与目录');
    await killService(child, home);
    await restartAndAssert(home, fixture, port, (i) => i.text === marker,
      (entry) => { assert.equal(entry.source, 'codex'); assert.equal(entry.targetKey, 'new:codex:' + home); });
    console.log('崩溃窗口 C：投递即新建执行中 kill -9 → 重启后「结果未确认」且目标保留 ✓');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ---------- 场景 D：cli-exit 快速失败可辨（V04）+ 失败条目重发执行中 kill -9 ----------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-crash-retry-'));
  const fixture = writeModelFixture(home);
  const port = await freePort();
  const marker = 'retry crash window D';
  const base = `http://127.0.0.1:${port}`;
  // D1：早期退出的 CLI 必须回报可辨失败，不得谎报已投递
  const child1 = startService(home, fixture, port, 'early-fail');
  await waitReady(child1, base, home);
  const token = fs.readFileSync(path.join(home, '.agent-pet', 'token'), 'utf8').trim();
  const failed = await post(base, token, '/api/input', { sessionId: 'sess_fixture_cc', text: marker });
  assert.equal(failed.status, 502, JSON.stringify(failed.body));
  assert.equal(failed.body.item.status, 'failed');
  assert.ok(/Not logged in \(mock\)|启动后立即退出/.test(failed.body.item.detail), 'cli-exit 须回报日志尾巴或退出码：' + failed.body.item.detail);
  await killService(child1, home);
  // D2：重发执行中崩溃——原条目应原位置为 pending，重启后标「结果未确认」（仍是同一条，不新建）
  const failedId = failed.body.item.id;
  const child2 = startService(home, fixture, port, 'hang');
  await waitReady(child2, base, home);
  post(base, token, `/api/input/${failedId}/resend`, {}).catch(() => null);
  const pre = await pollPending(home, (i) => i.id === failedId);
  assert.equal(pre.text, marker, '重发不得新建队列条目');
  await pollCalls(fixture.MOCK_CLI_CALLS, (cs) => cs.filter((c) => c.args.includes(marker)).length >= 2);
  await killService(child2, home);
  await restartAndAssert(home, fixture, port, (i) => i.text === marker,
    (entry) => { assert.equal(entry.id, failedId, '重发崩溃后仍是原条目'); });
  const calls = readCalls(fixture.MOCK_CLI_CALLS);
  assert.equal(calls.filter((c) => c.args.includes(marker)).length, 2, '原始投递 + 一次重发，重启后不再自动重发');
  console.log('崩溃窗口 D：cli-exit 快速失败可辨 + 重发执行中 kill -9 → 原条目「结果未确认」 ✓');
  fs.rmSync(home, { recursive: true, force: true });
}
console.log('崩溃窗口（V05）：四条投递路径执行前落盘 pending，kill -9 后重启均有「结果未确认」记录，不增殖、不自动重发');
