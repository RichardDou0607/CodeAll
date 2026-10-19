#!/usr/bin/env node
// PERF-0（docs/25 §3）：v0.1.1 开销基线测量。
// 隔离 HOME + 合成五源语料（DSH zstd 帧 / Claude 转录 / Codex rollout / Kimi wire / ZCode sqlite），
// 起 demo/framed.mjs，采「空闲」与「合成活跃」两档窗口：
//   CPU 时间（resourceUsage，µs）、读写次数（fsRead/fsWrite ops）、RSS、SSE 推送条数与字节、
//   /api/state（= snapshot() 全量重建 + 序列化）时延与响应字节、启动耗时。
// 说明：framed.mjs 的 PET_PERF_PROBE 现输出 readBytes/readOps（跟随器累计读字节/读次数）；本工具在 JSON 与
// 表格里保留这些列，无该字段时退回「读次数 + CPU」口径。
// 隔离红线：五源根全部落在临时 HOME，且 DSH_HOME/DSH_SESSIONS/DSH_WORKSPACES 显式指向临时 HOME、清掉
// DSH_SESSION_ID/DSH_PROFILE*（否则在 DSH 进程环境里会跟随真实 ~/.dsh）；插件 socket 指向不存在的临时路径；
// 不投递、不消耗模型额度。
// 用法：node scripts/perf-baseline.mjs [--idle-secs 60] [--active-secs 60] [--json <file>] [--keep]
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { writeModelFixture } from '../demo/test-model-fixture.mjs';
import { isolatedEnv } from '../demo/test-env.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const IDLE_SECS = Number(arg('--idle-secs', 60));
const ACTIVE_SECS = Number(arg('--active-secs', 60));
const PURE_SECS = Number(arg('--pure-secs', 0));       // >0 时追加「纯空闲」档：只挂 SSE 客户端（无 /api/state 采样），先老化 90s 让状态翻转落定
const JSON_OUT = arg('--json', null);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- 隔离环境（与 perf-verify 同口径；docs/25「全隔离合成语料」的硬保证） ----------
// 2026-10-18 审查 S2：与 demo 各隔离测试同用 demo/test-env.mjs 的 isolatedEnv（含 TMPDIR/DSH_* 清理）。

// ---------- 合成语料 ----------
const zstdFrame = (objs) => zlib.zstdCompressSync(Buffer.from(objs.map((o) => JSON.stringify(o)).join('\n') + '\n'));
const uuid = (i, tag) => '00000000-0000-4000-8000-' + String(i).padStart(12, '0') + '-' + tag;

function buildCorpus(home) {
  const now = Date.now();
  const sizes = { dshBig: 0, dshRest: 0, cc: 0, cx: 0, km: 0, zcRows: 0 };

  // DSH：6 项目 × 3 会话；p0/s0 是「最新主会话」——跟随器只 tail 它，故意造大（读放大可见）。
  // 事件文本掺入确定性熵（xorshift 种子固定：语料字节数跨运行可复现；zstd 对重复文本压缩比极高，
  // 无熵时 3MB 目标只剩 0.3MB）。
  const dshRoot = path.join(home, '.dsh', 'sessions');
  let rng = 0x9e3779b9;
  const entropy = () => {
    let s = '';
    for (let i = 0; i < 6; i++) {
      rng ^= rng << 13; rng >>>= 0;
      rng ^= rng >>> 17;
      rng ^= rng << 5; rng >>>= 0;
      s += rng.toString(16).padStart(8, '0');
    }
    return s;
  };
  const turnBlock = (sid, n) => [
    { type: 'turn/start', time: now - 3_600_000 + n * 1000, data: { turnId: 't' + n } },
    { type: 'assistant/message', time: now - 3_600_000 + n * 1000 + 50, data: { turnId: 't' + n, text: 'perf baseline synthetic assistant message '.repeat(6) + n + ' ' + entropy() } },
    { type: 'tool/call', time: now - 3_600_000 + n * 1000 + 80, data: { callId: 'c' + n, toolName: 'read_file', input: { path: '/tmp/synthetic-' + n + '.txt' } } },
    { type: 'tool/result', time: now - 3_600_000 + n * 1000 + 120, data: { callId: 'c' + n, status: 'ok' } },
    { type: 'turn/end', time: now - 3_600_000 + n * 1000 + 200, data: { turnId: 't' + n, status: 'ok', durationMs: 180 } },
  ];
  const dshSession = (proj, sess, blocks, headId) => {
    const dir = path.join(dshRoot, '--' + proj, sess);
    fs.mkdirSync(dir, { recursive: true });
    const chunks = [zstdFrame([{ type: 'session', id: headId, cwd: path.join('/tmp', proj), createdAt: now - 3_600_000, version: 4 }])];
    for (let n = 0; n < blocks; n++) chunks.push(zstdFrame(turnBlock(headId, n)));
    const buf = Buffer.concat(chunks);
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), buf);
    return buf.length;
  };
  for (let p = 0; p < 6; p++) for (let s = 0; s < 3; s++) {
    const big = p === 0 && s === 0;
    const bytes = dshSession('perf-p' + p, 'sess-dsh-' + p + '-' + s, big ? 4000 : 60, 'sess-dsh-' + p + '-' + s);
    if (big) sizes.dshBig = bytes; else sizes.dshRest += bytes;
  }
  // 让「最新主会话」的 mtime 最新（newestMainLog 按 mtime 挑）：最后 touch
  const bigLog = path.join(dshRoot, '--perf-p0', 'sess-dsh-0-0', 'session.v4.jsonl.zstd');
  const bigData = fs.readFileSync(bigLog);
  fs.writeFileSync(bigLog, bigData);            // 重写刷新 mtime
  sizes.dshBig = bigData.length;

  // Claude：4 项目 × 5 转录（纯 JSONL，user/assistant 交替 + usage + timestamp）
  const ccRoot = path.join(home, '.claude', 'projects');
  const ccLine = (i, role) => role === 'user'
    ? { type: 'user', timestamp: new Date(now - 3_600_000 + i * 2000).toISOString(), cwd: home, message: { role: 'user', content: 'perf baseline synthetic user input number ' + i + ' ' + 'x'.repeat(120) } }
    : { type: 'assistant', timestamp: new Date(now - 3_600_000 + i * 2000 + 500).toISOString(), message: { role: 'assistant', model: 'glm-5.3', content: [{ type: 'text', text: 'synthetic reply ' + i + ' ' + 'y'.repeat(200) }], usage: { input_tokens: 900 + i, output_tokens: 200 + i % 50, cache_read_input_tokens: 12000 + i } } };
  for (let p = 0; p < 4; p++) {
    const dir = path.join(ccRoot, '-Users-perf-cc-p' + p);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 5; f++) {
      const lines = [];
      for (let i = 0; i < 220; i++) lines.push(ccLine(i, i % 2 ? 'assistant' : 'user'));
      const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
      fs.writeFileSync(path.join(dir, uuid(p * 5 + f, 'cc' + p) + '.jsonl'), text);
      sizes.cc += text.length;
    }
  }

  // Codex：3 日期目录 × 4 rollout（session_meta 头 + response_item/token_count 事件）
  const cxRoot = path.join(home, '.codex', 'sessions');
  for (let d = 0; d < 3; d++) {
    const dir = path.join(cxRoot, '2026', '10', String(10 + d));
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 4; f++) {
      const sid = '01a0d409-0000-4000-8000-' + String(d * 4 + f).padStart(12, '0');
      const lines = [{ timestamp: new Date(now - 7_200_000).toISOString(), type: 'session_meta', payload: { session_id: sid, cwd: path.join('/tmp', 'perf-cx-' + d), cli_version: '9.9.9' } }];
      for (let i = 0; i < 160; i++) {
        const ts = new Date(now - 7_200_000 + i * 3000).toISOString();
        lines.push(i % 10 === 9
          ? { timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 40000 * (i + 1), output_tokens: 5000 * (i + 1) }, last_token_usage: { input_tokens: 40000, output_tokens: 5000 } } } }
          : { timestamp: ts, type: 'response_item', payload: { type: 'message', role: i % 2 ? 'assistant' : 'user', content: [{ type: i % 2 ? 'output_text' : 'input_text', text: 'synthetic codex payload ' + i + ' ' + 'z'.repeat(180) }] } });
      }
      const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
      fs.writeFileSync(path.join(dir, 'rollout-2026-10-' + String(10 + d).padStart(2, '0') + 'T00-00-00-' + sid + '.jsonl'), text);
      sizes.cx += text.length;
    }
  }

  // Kimi：4 工作目录 × 2 会话（state.json + agents/main/wire.jsonl）
  const kmRoot = path.join(home, '.kimi-code', 'sessions');
  for (let w = 0; w < 4; w++) {
    for (let s = 0; s < 2; s++) {
      const sid = 'sess-km-' + w + '-' + s;
      const dir = path.join(kmRoot, 'wd_perf_' + w, 'session_' + sid, 'agents', 'main');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '..', '..', 'state.json'),
        JSON.stringify({ id: sid, cwd: path.join('/tmp', 'perf-km-' + w), createdAt: now - 3_600_000, updatedAt: now - 60_000, title: 'perf ' + sid, archived: false }));
      const lines = [];
      for (let i = 0; i < 150; i++) lines.push(JSON.stringify({ type: i % 2 ? 'turn.end' : 'turn.start', ts: now - 3_600_000 + i * 2000, seq: i, data: { status: 'ok', text: 'synthetic kimi wire ' + i + ' ' + 'k'.repeat(160) } }));
      const text = lines.join('\n') + '\n';
      fs.writeFileSync(path.join(dir, 'wire.jsonl'), text);
      sizes.km += text.length;
    }
  }

  // ZCode sqlite：30 会话 × ~16 行；1 个会话落在 60s 回看窗内（跟随器有事件），其余置旧
  const dbFile = path.join(home, '.zcode', 'cli', 'db', 'db.sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, path TEXT, directory TEXT, title TEXT,
      version TEXT, task_type TEXT, title_source TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE session_entry (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, data TEXT, time_created INTEGER, time_updated INTEGER);`);
  const insSession = db.prepare('INSERT INTO session (id, path, title, task_type, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)');
  const insRow = db.prepare('INSERT INTO part (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
  for (let s = 0; s < 30; s++) {
    const live = s === 0;
    const base = live ? now - 20_000 : now - 86_400_000 * (s + 1);
    insSession.run('sess-zc-' + s, path.join('/tmp', 'perf-zc-' + s), 'perf zc ' + s, 'main', base, base);
    for (let r = 0; r < 16; r++) {
      const t = base + r * 800;
      insRow.run('p-' + s + '-' + r, 'sess-zc-' + s, t, t,
        JSON.stringify({ type: r % 4 === 3 ? 'tool' : 'text', text: 'synthetic zcode part ' + s + '/' + r + ' ' + 'q'.repeat(140) }));
      sizes.zcRows++;
    }
  }
  db.close();
  return { sizes, bigLog, dshRoot, ccFile: path.join(ccRoot, '-Users-perf-cc-p0', uuid(0, 'cc0') + '.jsonl'),
    cxFile: path.join(cxRoot, '2026', '10', '10', 'rollout-2026-10-10T00-00-00-01a0d409-0000-4000-8000-000000000000.jsonl'),
    kmFile: path.join(kmRoot, 'wd_perf_0', 'session_sess-km-0-0', 'agents', 'main', 'wire.jsonl') };
}

// ---------- 采样 ----------
const pct = (arr, p) => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };

async function sseCollect(base, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const stats = { msgs: 0, bytes: 0, maxBytes: 0 };
  const done = (async () => {
    try {
      const res = await fetch(base + '/api/stream', { signal: ctrl.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: d } = await reader.read();
        if (d) break;
        stats.bytes += value.length;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n'); buf = parts.pop() ?? '';
        for (const p of parts) if (p.startsWith('data: ')) { stats.msgs++; stats.maxBytes = Math.max(stats.maxBytes, p.length); }
      }
    } catch { /* 窗口结束 abort */ }
  })();
  await new Promise((r) => setTimeout(r, ms));
  clearTimeout(timer); ctrl.abort();
  await done.catch(() => {});
  return stats;
}

const readProbe = (file) => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

async function measureWindow(base, probeFile, label, secs, activity) {
  const startTs = Date.now();
  const before = readProbe(probeFile);
  const sse = sseCollect(base, secs * 1000);
  const latencies = []; let stateBytes = 0;
  const sampler = (async () => {
    for (;;) {
      const t0 = Date.now();
      try { const r = await fetch(base + '/api/state'); const b = await r.arrayBuffer(); stateBytes = b.byteLength; latencies.push(Date.now() - t0); } catch {}
      if (Date.now() - startTs >= secs * 1000) break;
      await new Promise((r) => setTimeout(r, 2500));
    }
  })();
  let actTimer = null;
  if (activity) actTimer = setInterval(activity, 2000);
  await new Promise((r) => setTimeout(r, secs * 1000));
  clearInterval(actTimer);
  await Promise.all([sse, sampler]);
  await new Promise((r) => setTimeout(r, 1200));            // 等探针最后一行落盘
  const rows = readProbe(probeFile).filter((r) => r.t >= startTs - 6000);
  const first = rows[0] ?? before[before.length - 1];
  const last = rows[rows.length - 1] ?? first;
  const cpuMs = first && last ? Math.round(((last.cpuU + last.cpuS) - (first.cpuU + first.cpuS)) / 1000) : null;
  const fsRead = first && last ? last.fsRead - first.fsRead : null;
  const fsWrite = first && last ? last.fsWrite - first.fsWrite : null;
  const readBytes = first && last && Number.isFinite(first.readBytes) && Number.isFinite(last.readBytes) ? last.readBytes - first.readBytes : null;
  const readOps = first && last && Number.isFinite(first.readOps) && Number.isFinite(last.readOps) ? last.readOps - first.readOps : null;
  const rss0 = first?.rss, rss1 = last?.rss;
  return {
    label, secs,
    cpuMs, cpuPct: cpuMs != null ? +(cpuMs / (secs * 1000) * 100).toFixed(1) : null,
    cpuPerMin: cpuMs != null ? Math.round(cpuMs / secs * 60) : null,
    fsRead, fsReadPerMin: fsRead != null ? Math.round(fsRead / secs * 60) : null,
    fsWrite, readBytes, readOps,
    rssStartMB: rss0 ? (rss0 / 1048576).toFixed(1) : null, rssEndMB: rss1 ? (rss1 / 1048576).toFixed(1) : null,
    sseMsgs: (await sse).msgs, sseBytes: (await sse).bytes, sseMaxBytes: (await sse).maxBytes,
    sseMsgsPerMin: Math.round((await sse).msgs / secs * 60), sseAvgBytes: (await sse).msgs ? Math.round((await sse).bytes / (await sse).msgs) : 0,
    stateP50: pct(latencies, 0.5), stateP95: pct(latencies, 0.95), stateMax: Math.max(...latencies, 0), stateBytes, stateSamples: latencies.length,
  };
}

// ---------- 主流程 ----------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-perf-'));
const fixture = writeModelFixture(home);
const corpus = buildCorpus(home);
const probeFile = path.join(home, 'perf-probe.jsonl');
const port = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const child = spawn(process.execPath, [fileURLToPath(new URL('../demo/framed.mjs', import.meta.url)), '--port', String(port)], {
  env: isolatedEnv(home, { ...fixture, PET_PERF_PROBE: probeFile, PET_PLUGIN_SOCK: path.join(home, 'no-plugin.sock') }),
  stdio: ['ignore', 'ignore', 'pipe'],
});
let serviceLog = '';
child.stderr.on('data', (d) => { serviceLog += d; });
const base = `http://127.0.0.1:${port}`;

try {
  const bootT0 = Date.now();
  let bootMs = null;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error('服务提前退出：' + serviceLog.slice(-500));
    try { const r = await fetch(base + '/api/state'); if (r.ok) { bootMs = Date.now() - bootT0; break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (bootMs == null) throw new Error('服务 20s 内未就绪：' + serviceLog.slice(-500));
  await new Promise((r) => setTimeout(r, 8000));            // 首轮 usage 扫描 + 目录首扫落定

  const idle = await measureWindow(base, probeFile, 'idle', IDLE_SECS, null);

  // 活跃档：每 2s 追加一轮事件——DSH 新 zstd 帧（3 条规范事件→3 次 broadcast）、
  // Claude/Codex/Kimi 各一行（跟随器 tail + 60s 用量扫描把变更文件整读）
  let turn = 1000;
  const activity = () => {
    const t = Date.now(); turn++;
    try {
      fs.appendFileSync(corpus.bigLog, zstdFrame([
        { type: 'turn/start', time: t, data: { turnId: 'act' + turn } },
        { type: 'assistant/message', time: t + 30, data: { turnId: 'act' + turn, text: 'active synthetic reply '.repeat(20) } },
        { type: 'turn/end', time: t + 60, data: { turnId: 'act' + turn, status: 'ok', durationMs: 60 } },
      ]));
    } catch { /* ignore */ }
    try { fs.appendFileSync(corpus.ccFile, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'glm-5.3', usage: { input_tokens: 500, output_tokens: 120, cache_read_input_tokens: 8000 } } }) + '\n'); } catch {}
    try { fs.appendFileSync(corpus.cxFile, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 4e6, output_tokens: 5e5 }, last_token_usage: { input_tokens: 40000, output_tokens: 5000 } } } }) + '\n'); } catch {}
    try { fs.appendFileSync(corpus.kmFile, JSON.stringify({ type: 'turn.end', ts: t, seq: turn, data: { status: 'ok', text: 'active kimi line '.repeat(10) } }) + '\n'); } catch {}
  };
  const active = await measureWindow(base, probeFile, 'active', ACTIVE_SECS, activity);

  // 纯空闲档（可选）：先静置 90s（live→非 live、活跃窗口跨界等一次性状态翻转全部落定），
  // 再只挂 SSE 客户端测一个窗口——不含 /api/state 采样自身的快照重建负载，反映真实挂机成本。
  let pure = null;
  if (PURE_SECS > 0) {
    await new Promise((r) => setTimeout(r, 90_000));
    const startTs = Date.now();
    const before = readProbe(probeFile);
    // 外部 CPU 口径（ps cputime 差分）：不依赖进程内探针，优化前后代码同口径可比
    const psCpu = () => {
      try {
        const out = execFileSync('ps', ['-o', 'cputime=', '-p', String(child.pid)], { encoding: 'utf8' }).trim();
        const m = out.match(/^(?:(\d+):)?(\d+)(?:\.(\d+))?$/);
        if (!m) return null;
        return (Number(m[1] || 0) * 60 + Number(m[2]) + Number('0.' + (m[3] || 0))) * 1000;
      } catch { return null; }
    };
    const cpu0 = psCpu();
    const sse = await sseCollect(base, PURE_SECS * 1000);
    const cpu1 = psCpu();
    const rows = readProbe(probeFile).filter((r) => r.t >= startTs - 6000);
    const first = rows[0] ?? before[before.length - 1];
    const last = rows[rows.length - 1] ?? first;
    const cpuMs = cpu0 != null && cpu1 != null ? Math.round(cpu1 - cpu0)
      : first && last ? Math.round(((last.cpuU + last.cpuS) - (first.cpuU + first.cpuS)) / 1000) : null;
    pure = {
      label: 'pure', secs: PURE_SECS,
      cpuMs, cpuPct: cpuMs != null ? +(cpuMs / (PURE_SECS * 1000) * 100).toFixed(2) : null,
      cpuPerMin: cpuMs != null ? Math.round(cpuMs / PURE_SECS * 60) : null,
      rssEndMB: last?.rss ? (last.rss / 1048576).toFixed(1) : null,
      sseMsgs: sse.msgs, sseBytes: sse.bytes,
      sseFullGuess: sse.msgs ? Math.round(sse.bytes / 135_000) : 0,   // 估算其中全量条数（按 ~135KB/条）
      sseBytesPerMin: Math.round(sse.bytes / PURE_SECS * 60),
    };
  }

  const mb = (n) => (n / 1048576).toFixed(1);
  const report = {
    meta: { date: new Date().toISOString(), node: process.version, platform: process.platform + ' ' + process.arch,
      idleSecs: IDLE_SECS, activeSecs: ACTIVE_SECS, pureSecs: PURE_SECS, bootMs,
      corpus: { dshBigMB: +mb(corpus.sizes.dshBig), dshRestMB: +mb(corpus.sizes.dshRest), ccMB: +mb(corpus.sizes.cc), cxMB: +mb(corpus.sizes.cx), kmMB: +mb(corpus.sizes.km), zcRows: corpus.sizes.zcRows } },
    idle, active, pure, home,
  };
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2) + '\n');

  const c = corpus.sizes;
  console.log(`# PERF-0 基线（${report.meta.date} · node ${process.version} · ${report.meta.platform} · 窗口 idle ${IDLE_SECS}s / active ${ACTIVE_SECS}s）`);
  console.log('');
  console.log(`语料：DSH 大日志 ${mb(c.dshBig)}MB（跟随目标）+ 其余 ${mb(c.dshRest)}MB · Claude ${mb(c.cc)}MB · Codex ${mb(c.cx)}MB · Kimi ${mb(c.km)}MB · ZCode ${c.zcRows} 行；启动→首个 /api/state 200：${bootMs}ms`);
  console.log('');
  console.log('| 指标 | 空闲档 | 合成活跃档 |');
  console.log('|---|---|---|');
  console.log(`| CPU（ms/分钟 · 均值%） | ${idle.cpuPerMin} · ${idle.cpuPct}% | ${active.cpuPerMin} · ${active.cpuPct}% |`);
  console.log(`| 读操作（次/分钟） | ${idle.fsReadPerMin} | ${active.fsReadPerMin} |`);
  if (idle.readBytes != null || active.readBytes != null) console.log(`| 读字节（跟随器探针，窗口合计） | ${idle.readBytes ?? 'n/a'} | ${active.readBytes ?? 'n/a'} |`);
  console.log(`| 写操作（窗口合计） | ${idle.fsWrite} | ${active.fsWrite} |`);
  console.log(`| RSS（起始→结束 MB） | ${idle.rssStartMB} → ${idle.rssEndMB} | ${active.rssStartMB} → ${active.rssEndMB} |`);
  console.log(`| SSE 推送（条/分钟 · 平均/最大字节） | ${idle.sseMsgsPerMin} · ${idle.sseAvgBytes}/${idle.sseMaxBytes}B | ${active.sseMsgsPerMin} · ${active.sseAvgBytes}/${active.sseMaxBytes}B |`);
  console.log(`| /api/state 时延 p50/p95/max（ms · ${idle.stateBytes}B） | ${idle.stateP50}/${idle.stateP95}/${idle.stateMax} | ${active.stateP50}/${active.stateP95}/${active.stateMax} |`);
  if (process.platform === 'darwin') console.log('');
  if (process.platform === 'darwin') console.log('> 读/写次数来自 rusage 的 inblock/oublock（Linux 有值；darwin 恒 0）。macOS 上读放大以 CPU 时间为口径；跟随器读字节用 PET_PERF_PROBE 的 readBytes（累计值差分）计量。');
  if (pure) console.log(`\n纯空闲档（静置 90s 后仅挂 SSE，${PURE_SECS}s）：CPU ${pure.cpuPerMin}ms/分钟（${pure.cpuPct}%）· RSS ${pure.rssEndMB}MB · SSE ${pure.sseMsgs} 条/${PURE_SECS}s（≈${pure.sseFullGuess} 条全量）· 推送 ${pure.sseBytesPerMin}B/分钟`);
  console.log('');
  console.log(`探针/语料目录（复跑对照）：${home}`);
  if (JSON_OUT) console.log(`原始数据：${JSON_OUT}`);
} finally {
  try { child.kill('SIGKILL'); } catch {}
}
