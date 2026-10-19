#!/usr/bin/env node
// 用量检查点跨重启回归（第 2 步，PERF-7）：
//   C1  首轮扫描后落盘 ~/.agent-pet/usage-checkpoint.json（0600、JSON 含版本号）；
//   C2  kill -9 → 追加用量行 → 重启：新会话数据被吸收（变了 size/mtime 的文件整读），
//       未变文件走检查点缓存（cachedFiles ≥1、readBytes 只计被重读文件 ≪ corpusBytes）；
//   C3  重启后「检查点加载」日志可见（排障口径：版本/载入条目数）。
// 隔离 HOME + 合成 claude 语料（两个项目文件：一个追加、一个保持不变），PET_REFRESH_MS=5000 注入。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeModelFixture } from './test-model-fixture.mjs';
import { isolatedEnv } from './test-env.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeoutMs, stepMs = 100) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 >= timeoutMs) return null; await sleep(stepMs); }
}
const usageOf = async (base) => (await (await fetch(base + '/api/state')).json()).usage;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-usagecp-'));
const fixture = writeModelFixture(home);
const OLD = Date.now() - 300_000;

// 语料：pA 文件较大且重启间保持不变（应命中检查点）；pB 文件小、重启前追加一行（应整读并吸收新账）
const ccA = path.join(home, '.claude', 'projects', '-a', 'aaaaaaaa-0000-4000-8000-000000000001.jsonl');
const ccB = path.join(home, '.claude', 'projects', '-b', 'bbbbbbbb-0000-4000-8000-000000000002.jsonl');
const line = (i, ts) => JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), message: { role: 'assistant', model: 'glm-5.3', usage: { input_tokens: 1000 + i, output_tokens: 200, cache_read_input_tokens: 50 } } });
fs.mkdirSync(path.dirname(ccA), { recursive: true });
fs.mkdirSync(path.dirname(ccB), { recursive: true });
fs.writeFileSync(ccA, Array.from({ length: 400 }, (_, i) => line(i, OLD - 400_000 + i * 1000)).join('\n') + '\n');
fs.writeFileSync(ccB, Array.from({ length: 10 }, (_, i) => line(i, OLD - 20_000 + i * 1000)).join('\n') + '\n');
fs.utimesSync(ccA, OLD, OLD);
fs.utimesSync(ccB, OLD, OLD);

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

/** 起服务并挂一个 SSE 客户端（分钟兜底在首个周期后触发扫描）；返回句柄与 stdout+stderr 累积。
 *  SSE 用「持续消费 body」的挂法（同 perf-verify openSse）——不消费的流式响应在 abort 后会
 *  污染 undici 连接池，导致本测试第二阶段的 SSE 连不上（clients.size=0 → 扫描永不触发）。 */
async function boot() {
  const port = await freePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./framed.mjs', import.meta.url)), '--port', String(port)], {
    env: isolatedEnv(home, { ...fixture, PET_PLUGIN_SOCK: path.join(home, 'no.sock'), PET_REFRESH_MS: '5000' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stdout.on('data', (d) => { err += d; });   // 常规日志走 stdout（console.log），一并累积
  child.stderr.on('data', (d) => { err += d; });
  const base = `http://127.0.0.1:${port}`;
  await waitUntil(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } }, 15_000, 100);
  const ctrl = new AbortController();
  const pump = (async () => {
    try {
      const res = await fetch(base + '/api/stream', { signal: ctrl.signal });
      const reader = res.body.getReader();
      for (;;) { const { done } = await reader.read(); if (done) break; }
    } catch { /* abort/断开 */ }
  })();
  // 注意：err 是持续重绑的字符串——用 getter 暴露当前值（直接放属性会固化返回时刻的快照）
  return { base, child, get err() { return err; }, close: async () => { ctrl.abort(); await pump.catch(() => {}); try { child.kill('SIGKILL'); } catch { /* ignore */ } } };
}

let pass = 0, fail = 0;
const check = (name, ok, detail) => { (ok ? pass++ : fail++); console.log((ok ? '✅ PASS' : '❌ FAIL') + '  ' + name + (detail ? ' — ' + detail : '')); };

try {
  // ---------- 阶段一：首轮扫描 + 检查点落盘 ----------
  const s1 = await boot();
  const g1 = await waitUntil(async () => { const u = await usageOf(s1.base); return u && !u.pending && u.generatedAt ? u.generatedAt : false; }, 20_000, 250);
  check('C1-a 有客户端：首轮扫描完成（generatedAt 就绪）', !!g1, g1 ? new Date(g1).toISOString().slice(11, 19) : '20s 未完成');
  const cpFile = path.join(home, '.agent-pet', 'usage-checkpoint.json');
  let cpStat = null; try { cpStat = fs.statSync(cpFile); } catch { /* 未落盘 */ }
  let cpOk = false, cpVersion = null;
  if (cpStat) { try { const j = JSON.parse(fs.readFileSync(cpFile, 'utf8')); cpVersion = j.version; cpOk = typeof cpVersion === 'number' && Object.keys(j.sources || {}).length > 0; } catch { /* 坏文件 */ } }
  check('C1-b 检查点落盘（JSON 有效、含版本号、0600）', !!cpStat && cpOk && (cpStat.mode & 0o777) === 0o600,
    cpStat ? 'mode=' + (cpStat.mode & 0o777).toString(8) + ' version=' + cpVersion + ' size=' + cpStat.size : '文件不存在');
  await s1.close();   // kill -9（SIGKILL：模拟崩溃退出，检查点必须已在此前写好）

  // ---------- 阶段二：追加用量 → 重启 → 吸收 + 缓存复用 ----------
  const sizeB = fs.statSync(ccB).size;
  fs.appendFileSync(ccB, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'glm-5.3', usage: { input_tokens: 7777, output_tokens: 111, cache_read_input_tokens: 0 } } }) + '\n');
  const s2 = await boot();
  const g2 = await waitUntil(async () => { const u = await usageOf(s2.base); return u && !u.pending && u.generatedAt && u.generatedAt > (g1 || 0) ? u.generatedAt : false; }, 20_000, 250);
  check('C2-a 重启后首轮扫描完成（generatedAt 前进）', !!g2, g2 ? new Date(g2).toISOString().slice(11, 19) : '20s 未完成');
  const detail = await (await fetch(s2.base + '/api/usage')).json();
  const cc = detail.perSource?.['claude-code'];
  const got7777 = cc && ((cc.bySession?.['bbbbbbbb-0000-4000-8000-000000000002']?.input ?? 0) >= 7777 + 1000);
  check('C2-b 追加行被吸收（该会话 in ≥ 7777+首屏基数）', !!got7777, 'in=' + (cc?.bySession?.['bbbbbbbb-0000-4000-8000-000000000002']?.input ?? '?'));
  const stats = cc?.stats ?? {};
  const corpus = stats.corpusBytes || 0, read = stats.readBytes || 0;
  // 多轮分钟刷新下本响应可能是第 2 轮（全命中 read=0）；核心不变量 = 未变文件被缓存复用（read < corpus）
  check('C2-c 检查点复用（未变文件零重读：cachedFiles≥1 且 readBytes < corpusBytes）',
    (stats.cachedFiles || 0) >= 1 && read < corpus,
    'files=' + stats.files + ' cached=' + stats.cachedFiles + ' readBytes=' + read + ' corpusBytes=' + corpus + '（ccB 原大小 ' + sizeB + '）');
  check('C3 重启日志含检查点载入记录', s2.err.includes('用量检查点'), (s2.err.match(/用量检查点[^\n]*/) || ['（无）'])[0].slice(0, 120));
  await s2.close();

  console.log('\n# 汇总：' + pass + '/' + (pass + fail) + ' 通过' + (fail ? '，' + fail + ' 失败' : ''));
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error('测试异常：' + (e?.stack || e));
  process.exitCode = 1;
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
