#!/usr/bin/env node
// PERF-5（docs/25）：CLI 无头投递并发上限 + 在途台账 + busy 入队自动重试回归。
//  ① 默认 cap=2 + mock CLI 挂起：/api/state 暴露 inFlight 台账（pid/来源/开始时间/日志文件）；
//  ② 第 3 条投递返回 busy 并入队（queued + autoRetry），不误标 failed，且 busy 不 spawn、不建会话；
//  ③ 杀在途进程 → 台账随进程退出释放，后续新投递立即可用（不等 flush）；
//  ④ 【自动重试回归】PET_FLUSH_MS=1500 + cap=1：续会话 busy 入队的条目在槽位释放后由 flush 真正重投
//     （此前 readInputFile 白名单重建丢失 autoRetry → 续会话条目永不自动重试，只有 new: 幸免）；
//  ⑤ 【重启持久化】queued+autoRetry 条目跨服务重启仍保留标记，重启后由 flush 自动重投。
// 隔离 HOME + demo/test-env isolatedEnv（DSH_* 指向临时 home，不读真实 ~/.dsh）+ mock CLI，不触碰真实 Agent。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeModelFixture } from './test-model-fixture.mjs';
import { isolatedEnv } from './test-env.mjs';

const framed = fileURLToPath(new URL('./framed.mjs', import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-headless-cap-'));
const fixture = writeModelFixture(home);
const callsFile = fixture.MOCK_CLI_CALLS;
const queueFile = path.join(home, '.agent-pet', 'input-queue.jsonl');
const tokenFile = path.join(home, '.agent-pet', 'token');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const services = new Set();

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function readCalls() {
  try { return fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}
/** 某条消息触发的 claude --resume 投递次数（mock CLI 记录 argv）。 */
function resumeCalls(text) {
  return readCalls().filter((c) => c.binary === 'claude' && Array.isArray(c.args)
    && c.args.includes('--resume') && c.args.includes(text)).length;
}
function readQueue() {
  try { return fs.readFileSync(queueFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}
async function startService(extraEnv) {
  const port = await freePort();
  const child = spawn(process.execPath, [framed, '--port', String(port)], {
    env: isolatedEnv(home, { ...fixture, PET_PLUGIN_SOCK: path.join(home, 'missing.sock'), MOCK_CLI_MODE: 'hang', ...extraEnv }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  services.add(child);
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const base = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error('服务提前退出：' + output.slice(-500));
    try { const r = await fetch(base + '/api/state'); if (r.ok) { ready = true; break; } } catch { /* 未就绪 */ }
    await sleep(100);
  }
  assert.ok(ready, '服务未启动：' + output.slice(-500));
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  return { child, base, token, port };
}
async function post(svc, route, body) {
  const r = await fetch(svc.base + route, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-pet-token': svc.token },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: await r.json() };
}
async function state(svc) { return (await (await fetch(svc.base + '/api/state')).json()); }
function killPid(pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
async function killInflight(svc) {
  try { const st = await state(svc); for (const x of st.inFlight || []) killPid(x.pid); } catch { /* 服务已停 */ }
}
async function stopService(svc) {
  await killInflight(svc);
  try { svc.child.kill('SIGKILL'); } catch { /* 已退出 */ }
  await new Promise((resolve) => {
    if (svc.child.exitCode !== null) resolve();
    else { svc.child.once('exit', resolve); setTimeout(resolve, 2500).unref(); }
  });
  services.delete(svc.child);
  await sleep(100);
}

/** 轮询直到 pred(st) 为真（默认 10s 上限）；失败时打印队列快照。 */
async function waitState(svc, pred, ms, what) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await state(svc);
    if (pred(last)) return last;
    await sleep(150);
  }
  assert.fail(what + '（超时 ' + ms + 'ms）：' + JSON.stringify({ inputs: (last && last.inputs || []).map((i) => ({ id: i.id, status: i.status, autoRetry: i.autoRetry, targetKey: i.targetKey })) }));
}

try {
  // ---------- ①②③ 默认 cap=2：台账 / busy 入队 / 退出释放 ----------
  let svc = await startService({});   // 不设 PET_HEADLESS_CAP：断言默认值 2
  const one = await post(svc, '/api/input', { sessionId: 'sess_fixture_cc', text: 'cap-1' });
  const two = await post(svc, '/api/input', { sessionId: 'sess_fixture_cc', text: 'cap-2' });
  assert.ok([200, 202].includes(one.status) && [200, 202].includes(two.status), '前两条应正常受理（202/200），实际 ' + one.status + '/' + two.status);
  assert.ok(one.body.item && two.body.item, '前两条应正常受理');

  const st1 = await state(svc);
  assert.equal(st1.inFlight.length, 2, '默认并发上限应为 2，实际 ' + JSON.stringify(st1.inFlight));
  assert.ok(st1.inFlight.every((x) => Number.isInteger(x.pid) && x.source === 'claude-code' && x.logFile), '台账字段齐全');
  const callsBefore = readCalls().length;

  // 第 3 条：busy → queued + autoRetry（不得误标 failed）；busy 在 spawn 前返回，不得产生进程
  const three = await post(svc, '/api/input', { sessionId: 'sess_fixture_cc', text: 'cap-3' });
  assert.ok([200, 202].includes(three.status), '第 3 条应正常响应，实际 ' + three.status);
  assert.equal(three.body.item.status, 'queued', '第 3 条应入队，实际 ' + JSON.stringify(three.body.item));
  assert.ok(three.body.item.detail.includes('并发已满'), '入队原因应说明并发已满');
  assert.equal(three.body.item.autoRetry, true, 'busy 入队条目应带 autoRetry 标记');
  const queuedRow = (await state(svc)).inputs.find((i) => i.id === three.body.item.id);
  assert.ok(queuedRow && queuedRow.autoRetry, '队列条目保留 autoRetry 标记');
  assert.equal(readCalls().length, callsBefore, 'busy 不应 spawn CLI（并发上限必须在 spawn 前返回）');

  // 杀掉两个在途 mock → 台账随进程退出释放 → 第 4 条立即可投（不等 flush）
  for (const x of st1.inFlight) killPid(x.pid);
  await sleep(1500);
  assert.equal((await state(svc)).inFlight.length, 0, '进程退出后台账应清空');
  const four = await post(svc, '/api/input', { sessionId: 'sess_fixture_cc', text: 'cap-4' });
  assert.ok([200, 202].includes(four.status), '释放后新投递应受理，实际 ' + four.status);
  assert.ok(['delivered', 'pending'].includes(four.body.item.status), '释放后新投递应受理，实际 ' + JSON.stringify(four.body.item));
  await stopService(svc);

  // ---------- ④ PET_FLUSH_MS=1500 + cap=1：续会话 busy 条目由 flush 自动重投 ----------
  fs.rmSync(queueFile, { force: true });   // 清掉上一段遗留的 queued cap-3，避免干扰本段节奏
  svc = await startService({ PET_HEADLESS_CAP: '1', PET_FLUSH_MS: '1500' });
  const fill = await post(svc, '/api/input', { sessionId: 'sess_fixture_cc', text: 'retry-fill' });
  assert.equal(fill.body.item.status, 'delivered', '占满 cap 的投递应送达（异步），实际 ' + JSON.stringify(fill.body.item));
  const stFill = await state(svc);
  assert.equal(stFill.inFlight.length, 1, 'cap=1 时应有 1 条在途，实际 ' + JSON.stringify(stFill.inFlight));
  const busyItem = await post(svc, '/api/input', { sessionId: 'sess_fixture_cc', text: 'retry-target' });
  assert.equal(busyItem.body.item.status, 'queued', 'cap=1 时第 2 条应 busy 入队，实际 ' + JSON.stringify(busyItem.body.item));
  assert.equal(busyItem.body.item.autoRetry, true, 'busy 入队条目应带 autoRetry 标记');
  // 磁盘队列必须写入 autoRetry（修复回归点：readInputFile 白名单重建此前会丢弃该字段）
  const diskRow = readQueue().find((i) => i.id === busyItem.body.item.id);
  assert.ok(diskRow && diskRow.autoRetry === true, '磁盘队列条目应保留 autoRetry 字段：' + JSON.stringify(diskRow));
  const inflightPid = stFill.inFlight[0].pid;
  const resumeBefore = resumeCalls('retry-target');
  assert.equal(resumeBefore, 0, 'busy 条目此时不应已 spawn');
  killPid(inflightPid);   // 释放唯一槽位；flush（PET_FLUSH_MS=1500）应自动重投 queued 条目
  await waitState(svc, (st) => {
    const row = (st.inputs || []).find((i) => i.id === busyItem.body.item.id);
    return resumeCalls('retry-target') > resumeBefore && (!row || row.status === 'delivered');
  }, 10_000, '续会话 busy 条目未被 flush 自动重投（仍 queued）');
  assert.ok(resumeCalls('retry-target') > resumeBefore, 'flush 重投后 mock CLI 应收到 --resume 调用');
  await stopService(svc);

  // ---------- ⑤ 重启持久化：queued+autoRetry 跨重启保留，并由 flush 重投 ----------
  fs.rmSync(queueFile, { force: true });
  svc = await startService({ PET_HEADLESS_CAP: '1', PET_FLUSH_MS: '1500' });
  const fill2 = await post(svc, '/api/input', { sessionId: 'sess_fixture_cc', text: 'persist-fill' });
  assert.equal(fill2.body.item.status, 'delivered', '持久化段占满投递应送达');
  const stFill2 = await state(svc);
  assert.equal(stFill2.inFlight.length, 1, '持久化段应有 1 条在途');
  const persistItem = await post(svc, '/api/input', { sessionId: 'sess_fixture_cc', text: 'persist-target' });
  assert.equal(persistItem.body.item.status, 'queued', '持久化段第 2 条应 busy 入队');
  assert.equal(persistItem.body.item.autoRetry, true, '持久化段条目应带 autoRetry');
  const diskPersist = readQueue().find((i) => i.id === persistItem.body.item.id);
  assert.ok(diskPersist && diskPersist.autoRetry === true, '重启前磁盘应保留 autoRetry：' + JSON.stringify(diskPersist));
  killPid(stFill2.inFlight[0].pid);          // 释放槽位（模拟服务带队列重启前槽位已空）
  await stopService(svc);                    // 停服务但不清队列（模拟重启）

  const resumeBeforeRestart = resumeCalls('persist-target');
  svc = await startService({ PET_HEADLESS_CAP: '1', PET_FLUSH_MS: '1500' });
  const stRestart = await state(svc);
  const restoredRow = (stRestart.inputs || []).find((i) => i.id === persistItem.body.item.id);
  assert.ok(restoredRow && restoredRow.status === 'queued', '重启后 queued 条目应恢复，实际 ' + JSON.stringify(restoredRow));
  assert.equal(restoredRow.autoRetry, true, '重启后 autoRetry 标记不得丢失（readInputFile 必须保留）');
  await waitState(svc, (st) => {
    const row = (st.inputs || []).find((i) => i.id === persistItem.body.item.id);
    return resumeCalls('persist-target') > resumeBeforeRestart && (!row || row.status === 'delivered');
  }, 10_000, '重启后 queued+autoRetry 条目未被 flush 自动重投');
  await stopService(svc);

  console.log('PERF-5 并发上限：默认 2 在途封顶、busy 入队 autoRetry 且不 spawn、退出即释放台账；'
    + 'PET_FLUSH_MS=1500 下续会话 busy 条目被 flush 自动重投、跨重启仍重投 —— 全部通过');
} finally {
  for (const child of [...services]) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  // 无头投递是 detached spawn：清掉残留 mock CLI，避免挂满 60s
  try { spawnSync('pkill', ['-f', path.join(home, 'bin') + path.sep]); } catch { /* 无残留 */ }
  await sleep(100);
  fs.rmSync(home, { recursive: true, force: true });
}
