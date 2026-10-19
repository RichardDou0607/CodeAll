#!/usr/bin/env node
// 分钟兜底刷新回归（2026-10-19 用户反馈：mini 条状态 / 日历桶计数空闲期滞留）：
//   M1  有 SSE 客户端 → 分钟兜底自动触发用量重扫（generatedAt 翻新）+ 全量快照推送；
//   M2  无客户端 → 同窗口内零后台重扫（PERF-3 懒触发口径不变，perf-verify P3③ 同语义）；
//   M3  有客户端 → 目录五源强制重扫兜底：新会话文件 ≤ REFRESH_MS+2s 节拍 可见于全量快照
//       （可见性上界断言——四态 15s mtime 轮询若先捕获同样满足上界，两机制并存）。
// 隔离 HOME + 合成 claude 用量语料，PET_REFRESH_MS=5000（允许的最短周期）注入，不触碰真实数据。
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
/** 谓词支持 async：轮询至返回真值（返回该值）或超时（返回 null）。 */
async function waitUntil(fn, timeoutMs, stepMs = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 >= timeoutMs) return null;
    await sleep(stepMs);
  }
}
const usageOf = async (base) => (await (await fetch(base + '/api/state')).json()).usage;

// ---------- 语料：claude 用量文件（mtime 置旧，避免四态 45s 连接新鲜度边界引入额外 full） ----------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-minrefresh-'));
const fixture = writeModelFixture(home);
const OLD = Date.now() - 300_000;
const ccDir = path.join(home, '.claude', 'projects', '-minrefresh');
fs.mkdirSync(ccDir, { recursive: true });
const ccFile = path.join(ccDir, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl');
const ccLine = (n) => JSON.stringify({ type: 'assistant', timestamp: new Date(OLD - 60_000 + n * 1000).toISOString(), message: { role: 'assistant', model: 'glm-5.3', usage: { input_tokens: 1000 + n, output_tokens: 200, cache_read_input_tokens: 5000 } } });
fs.writeFileSync(ccFile, Array.from({ length: 10 }, (_, i) => ccLine(i)).join('\n') + '\n');
fs.utimesSync(ccFile, OLD, OLD);

const port = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const child = spawn(process.execPath, [fileURLToPath(new URL('./framed.mjs', import.meta.url)), '--port', String(port)], {
  env: isolatedEnv(home, { ...fixture, PET_PLUGIN_SOCK: path.join(home, 'no.sock'), PET_REFRESH_MS: '5000' }),
  stdio: ['ignore', 'ignore', 'pipe'],
});
let err = '';
child.stderr.on('data', (d) => { err += d; });
const base = `http://127.0.0.1:${port}`;

/** SSE 记录器：跨 chunk 解析（同 perf-verify openSse），msgs 元素带 tick 标记与到达时刻。 */
function openSse() {
  const ctrl = new AbortController();
  const msgs = [];
  const done = (async () => {
    try {
      const res = await fetch(base + '/api/stream', { signal: ctrl.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const part = buf.slice(0, idx); buf = buf.slice(idx + 2);
          if (!part.startsWith('data: ')) continue;
          let obj = null; try { obj = JSON.parse(part.slice(6)); } catch { /* ignore */ }
          msgs.push({ tick: !!(obj && obj.tick), obj, at: Date.now() });
        }
      }
    } catch { /* abort */ }
  })();
  return { msgs, close: async () => { try { ctrl.abort(); } catch {} await done.catch(() => {}); } };
}

let pass = 0, fail = 0;
const check = (name, ok, detail) => { (ok ? pass++ : fail++); console.log((ok ? '✅ PASS' : '❌ FAIL') + '  ' + name + (detail ? ' — ' + detail : '')); };

try {
  await waitUntil(async () => { try { return (await fetch(base + '/api/state')).ok; } catch { return false; } }, 15_000, 100);

  // ---------- M1：有客户端 → 分钟兜底触发用量重扫 + 全量推送（不碰 /api/usage*，排除懒触发通路） ----------
  const rec = openSse();
  await waitUntil(() => rec.msgs.length > 0, 5_000, 50);
  const firstScan = await waitUntil(async () => { const u = await usageOf(base); return u && !u.pending && u.generatedAt ? u.generatedAt : false; }, 15_000, 250);
  check('M1-a 有客户端：分钟兜底自动完成首轮用量扫描（非 pending，未触碰 /api/usage*）', !!firstScan,
    firstScan ? 'generatedAt=' + new Date(firstScan).toISOString().slice(11, 19) : '15s 内仍 pending');

  const baseIdx = rec.msgs.length;
  fs.appendFileSync(ccFile, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'glm-5.3', usage: { input_tokens: 999999, output_tokens: 1, cache_read_input_tokens: 0 } } }) + '\n');
  const genBefore = (await usageOf(base)).generatedAt;
  const genAfter = await waitUntil(async () => { const g = (await usageOf(base)).generatedAt; return g !== genBefore ? g : false; }, 12_000, 250);
  const fullPushed = rec.msgs.slice(baseIdx).find((m) => !m.tick);   // baseIdx 取自追加前 → 窗口即「追加之后」
  check('M1-b 有客户端：追加用量后 ≤1 周期+节拍内 generatedAt 翻新（重扫吸收新数据）', !!genAfter,
    genAfter ? new Date(genBefore).toISOString().slice(11, 19) + '→' + new Date(genAfter).toISOString().slice(11, 19) : '12s 内未重扫（分钟兜底未生效！）');
  check('M1-c 有客户端：同窗口收到全量（非 tick）快照推送', !!fullPushed,
    fullPushed ? '窗口内 full ' + rec.msgs.slice(baseIdx).filter((m) => !m.tick).length + ' 条' : '只有 tick，无全量推送');

  // ---------- M2：无客户端 → 同窗口零后台重扫 ----------
  await rec.close();
  fs.appendFileSync(ccFile, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'glm-5.3', usage: { input_tokens: 888888, output_tokens: 1, cache_read_input_tokens: 0 } } }) + '\n');
  const quietBefore = (await usageOf(base)).generatedAt;
  await sleep(12_000);   // ≥2 个刷新周期，期间只碰 /api/state（不触发懒触发端点）
  const quietAfter = (await usageOf(base)).generatedAt;
  check('M2 无客户端：≥2 周期窗口内零后台重扫（PERF-3 懒触发口径不变）', quietAfter === quietBefore,
    quietAfter === quietBefore ? 'generatedAt 稳定' : 'generatedAt 变化 ' + quietBefore + '→' + quietAfter + '（无客户端仍周期扫描！）');

  // ---------- M3：有客户端 → 目录强制重扫兜底（新会话可见性上界 = REFRESH_MS + 2s 节拍 + 余量） ----------
  const rec3 = openSse();
  await waitUntil(() => rec3.msgs.length > 0, 5_000, 50);
  await sleep(200);
  const baseIdx3 = rec3.msgs.length;
  const sid = 'bbbbbbbb-0000-4000-8000-000000000002';
  const t3 = Date.now();
  fs.writeFileSync(path.join(ccDir, sid + '.jsonl'),
    JSON.stringify({ type: 'user', cwd: '/tmp/minrefresh', timestamp: new Date().toISOString(), message: { content: 'm3' } }) + '\n');
  const seen = await waitUntil(() => rec3.msgs.slice(baseIdx3).find((m) => {
    if (m.tick || !m.obj) return false;
    return ((m.obj.catalog || {}).history || []).some((h) => String(h.sessionId).includes(sid))
      || (m.obj.sessions || []).some((x) => String(x.id).includes(sid));
  }), 10_000, 100);
  await rec3.close();
  check('M3 有客户端：新会话文件 ≤ 周期+节拍+余量（10s@5000ms 周期）内出现在全量快照', !!seen,
    seen ? ((Date.now() - t3) / 1000).toFixed(1) + 's 可见（SSE-only）' : '10s 内 SSE 未见（目录兜底失效！）');

  console.log('\n# 汇总：' + pass + '/' + (pass + fail) + ' 通过' + (fail ? '，' + fail + ' 失败' : ''));
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error('测试异常：' + (e?.stack || e) + '\n服务 stderr：' + err.slice(-400));
  process.exitCode = 1;
} finally {
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  fs.rmSync(home, { recursive: true, force: true });
}
