#!/usr/bin/env node
// v0.1.1 真优化验证（docs/25 附录 C）：逐项证明 PERF-1～6 的机制真实生效。
// 不是「测试绿」，而是「优化在跑」——每项断言都直接对应 docs/25 §3 的原始目的：
//   P1-a 心跳变轻：稳态空闲 SSE 平均字节 / 全量条数
//   P1-b① 脏标记不漏推：先挂持久 SSE 记录器，再追加事件；只统计追加后到达的 full，
//         且断言 lastEvent.ts≈追加时刻（合成事件用当前时间，不再有"未来时间戳恒真"）
//   P2   增量读：8MB 日志 20s 空闲窗口探针 readBytes 增量 <1MB（旧整文件读量级 ≈8MB×25≈200MB）
//         + 1MB/8MB 空闲 CPU 差断言（旧实现随体积线性放大）+ 半帧跨追加 / 轮转正确性
//   P3   用量懒触发：启动 2s 内 pending（旧代码启动即扫）+ 70s 无后台重扫（无客户端时分钟兜底不运行；
//         有客户端的分钟兜底语义由 demo/test-minute-refresh.mjs 覆盖，本套件 PET_REFRESH_MS=10min 隔离）
//   P4-a 静默信号驱动可见：先挂 SSE，再写新 claude 会话文件（活动目录 mtime 变化 → 四态 15s 轮询捕获
//         → forceCatalogRescan + 脏标记 → 2s 节拍 full），等 full 快照包含新会话（8～18s；
//         不用 /api/state 轮询，避免把客户端轮询当触发器；不改 mtime 的变化才由 15s 惰性 TTL 兜底）
//   P4-b ZCode 退避：stats.gaps 暴露的轮询间隔显著增长（至 ≥10× 基准），取到新行后回基准
//         （替代仅"轮数"断言；固定慢轮询实现不再能蒙混通过）
//   P4-a2 注册表静默变化：改写 workspace.json 的 workspace title → 5s mtime 探测 + 2s 节拍 → ≤10s 收到含新 title 的 full
//   P5   并发上限：调用 demo/test-headless-cap.mjs（2 在途封顶 / 第 3 条入队 / 释放即恢复）
//   P6-a 指纹去重：同数据 touch 不重放 / 改数据重放
//   P6-b 差分内存：「只建库」基线子进程 vs「挂 follower 处理 2.5 万行×6KB」子进程 live heapUsed 增量 <8MB
//         （多轮 --expose-gc 后取 heapUsed；RSS 只作参考——V8 高水位不回缩，测的是查询翻腾不是 seen 留存），
//         并断言 follower rows===25000（防止查询报错空转；旧全文本实现按 ~5000×6KB≈30MB 会失败）
//   P7   用量检查点（PERF-7，2026-10-19）：P7-a 冷扫不阻塞（64MB 语料首轮全量期间 SSE 最大间隔 <2500ms，
//         只测 elapsed/readBytes 证明不了这点）；P7-b kill -9 → 追加 → 重启：追加吸收 + 未变文件零重读
//         （readBytes 实际读取口径=P0-1）；P7-c 无检查点对照（readBytes == corpusBytes，证明 P7-b 省读来源）。
// 全部隔离：bootService 显式把 DSH_HOME/DSH_SESSIONS/DSH_WORKSPACES 指向临时 HOME 并清掉
// DSH_SESSION_ID/DSH_PROFILE*（DSH 进程环境会覆盖 ~/.dsh 解析，不 scrub 会跟随真实用户会话），
// 不消耗模型额度。运行约 4～5 分钟，任一失败退出码非零。
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { writeModelFixture } from '../demo/test-model-fixture.mjs';
import { isolatedEnv } from '../demo/test-env.mjs';
import { followZcodeLogs } from '../adapters/zcode-adapter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (id, name, pass, detail) => {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? '✅ PASS' : '❌ FAIL'}  ${id} ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeoutMs, stepMs = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (fn()) return Date.now() - t0; await sleep(stepMs); }
  return null;
}
const zstdFrame = (objs) => zlib.zstdCompressSync(Buffer.from(objs.map((o) => JSON.stringify(o)).join('\n') + '\n'));

// ---------- 语料：DSH 主日志（体积可调，mtime 置旧避免验收窗口内状态翻转）+ claude 用量文件 ----------
function buildCorpus(home, bigMB) {
  const OLD = Date.now() - 300_000;
  const dshRoot = path.join(home, '.dsh', 'sessions');
  const dir = path.join(dshRoot, '--verify', 'sess-verify-main');
  fs.mkdirSync(dir, { recursive: true });
  const chunks = [zstdFrame([{ type: 'session', id: 'sess-verify-main', cwd: '/tmp/verify', createdAt: OLD, version: 4 }])];
  const targetBytes = bigMB * 1048576;
  let n = 0, written = 0;
  while (written < targetBytes) {
    const blk = zstdFrame([
      { type: 'turn/start', time: OLD + n * 1000, data: { turnId: 't' + n } },
      { type: 'assistant/message', time: OLD + n * 1000 + 50, data: { turnId: 't' + n, text: 'verify entropy ' + n + ' ' + Buffer.from(String(n * 7919 + 13).padStart(4, '0')).toString('hex').repeat(24) } },
      { type: 'turn/end', time: OLD + n * 1000 + 100, data: { turnId: 't' + n, status: 'ok' } },
    ]);
    chunks.push(blk); written += blk.length; n++;
  }
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(chunks));
  const bigLog = path.join(dir, 'session.v4.jsonl.zstd');
  // claude 用量文件（P3）：mtime 置旧
  const ccDir = path.join(home, '.claude', 'projects', '-verify');
  fs.mkdirSync(ccDir, { recursive: true });
  const ccFile = path.join(ccDir, '11111111-0000-4000-8000-000000000001.jsonl');
  const ccLines = [];
  for (let i = 0; i < 30; i++) ccLines.push(JSON.stringify({ type: 'assistant', timestamp: new Date(OLD - 60_000 + i * 1000).toISOString(), message: { role: 'assistant', model: 'glm-5.3', usage: { input_tokens: 1000 + i, output_tokens: 200, cache_read_input_tokens: 5000 } } }));
  fs.writeFileSync(ccFile, ccLines.join('\n') + '\n');
  // mtime 同样置旧（2026-10-18：P1-a 曾因四态「连接新鲜度 45s 窗口」边界恰落进空闲窗口多出 1 条 full 而假失败——
  // ccFile 是 claude 活动目录的 fileRe 之一，mtime=写入时刻会在 +45s 翻转四态连接态触发 markDirty）
  fs.utimesSync(ccFile, OLD, OLD);
  return { bigLog, ccFile, dshRoot };
}

// ---------- 隔离环境（docs/25「全隔离合成语料」的硬保证） ----------
// DSH 会话/审查环境自带 DSH_HOME、DSH_SESSION_ID 等；session-catalog 的 DSH_HOME=process.env.DSH_HOME||HOME/.dsh
// → 只隔离 HOME 不够，子服务会跟随真实用户 ~/.dsh（合成语料被忽略、断言恒真/假失败）。
// 2026-10-18 审查 S2：与 demo 各隔离测试同用 demo/test-env.mjs 的 isolatedEnv（含 TMPDIR/DSH_* 清理）。

// ---------- 服务挂具 ----------
async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function bootService(home, extraEnv = {}, readyTimeoutMs = 20_000) {
  const fixture = writeModelFixture(home);
  const probeFile = path.join(home, 'probe.jsonl');
  const port = await freePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../demo/framed.mjs', import.meta.url)), '--port', String(port)], {
    // PET_REFRESH_MS=10min：分钟兜底刷新（有客户端时强制重扫+全量推送）拉长到套件窗口之外——
    // P1-a 平均字节 / P4-a 的 8s 下界 / P3③ 的 generatedAt 稳定断言各自只测自己的机制；
    // 分钟刷新自身的门控语义（有客户端→刷新 / 无客户端→静默）由 demo/test-minute-refresh.mjs 覆盖。
    env: isolatedEnv(home, { ...fixture, PET_PERF_PROBE: probeFile, PET_PLUGIN_SOCK: path.join(home, 'no.sock'), PET_REFRESH_MS: '600000', ...extraEnv }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = ''; child.stderr.on('data', (d) => { err += d; });
  const base = 'http://127.0.0.1:' + port;
  const t0 = Date.now();
  const rounds = Math.ceil(readyTimeoutMs / 100);
  for (let i = 0; i < rounds; i++) {
    if (child.exitCode !== null) throw new Error('服务提前退出：' + err.slice(-400));
    try { const r = await fetch(base + '/api/state'); if (r.ok) break; } catch {}
    await sleep(100);
    if (i === rounds - 1) throw new Error('服务未就绪：' + err.slice(-400));
  }
  return { child, base, probeFile, bootMs: Date.now() - t0, kill: () => { try { child.kill('SIGKILL'); } catch {} } };
}

// ---------- SSE 记录器：跨 chunk 稳健解析（buffer 拼接，不假设一 chunk 一帧）+ 先挂后触发 ----------
function openSse(base) {
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
          if (!part.startsWith('data: ')) continue;      // 忽略注释/空帧，保留剩余 buffer
          const text = part.slice(6);
          let obj = null; try { obj = JSON.parse(text); } catch {}
          msgs.push({ tick: !!(obj && obj.tick), bytes: Buffer.byteLength(text), obj, at: Date.now() });
        }
      }
    } catch { /* abort */ }
  })();
  return {
    msgs,
    /** 关闭连接并返回窗口内全部消息（含 at 收到时刻）。 */
    close: async () => { try { ctrl.abort(); } catch {} await done.catch(() => {}); return msgs; },
  };
}
/** 兼容旧用法：开一个窗口 ms 毫秒的记录器。 */
async function sseRecord(base, ms) { const rec = openSse(base); await sleep(ms); return await rec.close(); }

// ---------- 探针：PET_PERF_PROBE 行 {t, cpuU, cpuS, fsRead, fsWrite, rss[, readBytes, readOps]} ----------
const readProbe = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
/** [fromTs, toTs] 窗口内累计量差分（cpu ms / readBytes / readOps）；字段缺失返回 null。 */
function probeDelta(file, fromTs, toTs) {
  const rows = readProbe(file).filter((r) => r.t >= fromTs - 6000 && r.t <= toTs + 1500);
  if (rows.length < 2) return { cpu: null, readBytes: null, readOps: null };
  const first = rows[0], last = rows[rows.length - 1];
  const num = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? b - a : null);
  return {
    cpu: Math.round(((last.cpuU + last.cpuS) - (first.cpuU + first.cpuS)) / 1000),
    readBytes: num(first.readBytes, last.readBytes),
    readOps: num(first.readOps, last.readOps),
  };
}

// ---------- P1-a / P1-b / P3 / P4-a：同一台小语料服务 ----------
async function suiteService() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-verify-'));
  const corpus = buildCorpus(home, 1);
  // 注册表（workspace.json）：P4-a2「静默注册表变化 → SSE 推送」用（Lead B4：5s 廉价 mtime 探测 + forceCatalogRescan）
  const wsFile = path.join(home, '.dsh', 'storages', 'workspace.json');
  fs.mkdirSync(path.dirname(wsFile), { recursive: true });
  const writeWs = (title) => fs.writeFileSync(wsFile, JSON.stringify({
    global: { workspaceIds: ['w1'] },
    tables: { workspaces: { w1: { path: '/tmp/verify', title, sessionIds: ['sess-verify-main'] } } },
  }));
  writeWs('VERIFY');
  const svc = await bootService(home);
  try {
    // P1-a：稳态空闲——先静置让启动期状态翻转全部落定
    await sleep(12_000);
    const winT0 = Date.now();
    const msgs = await sseRecord(svc.base, 20_000);
    const full = msgs.filter((m) => !m.tick);
    const avg = msgs.length ? Math.round(msgs.reduce((s, m) => s + m.bytes, 0) / msgs.length) : 0;
    check('P1-a', '空闲心跳为轻量 tick（平均字节 / 全量条数）',
      msgs.length >= 6 && full.length <= 2 && avg < 5000,
      `消息 ${msgs.length} 条（全量 ${full.length}、tick ${msgs.length - full.length}），平均 ${avg}B/条（窗口 ${Date.now() - winT0}ms）`);

    // P1-b①：先挂持久 SSE 记录器 → 再追加事件；只统计追加后收到的 full，断言 lastEvent.ts≈追加时刻
    {
      const rec = openSse(svc.base);
      await waitUntil(() => rec.msgs.length > 0, 3000, 50);   // 等连接首帧（忽略其旧 lastEvent）
      await sleep(200);
      const baseIdx = rec.msgs.length;
      const t = Date.now();
      fs.appendFileSync(corpus.bigLog, zstdFrame([
        { type: 'turn/start', time: t, data: { turnId: 'p1b' } },
        { type: 'turn/end', time: t + 10, data: { turnId: 'p1b', status: 'ok' } },
      ]));
      let pushed = null;
      await waitUntil(() => {
        pushed = rec.msgs.slice(baseIdx).find((m) => !m.tick && m.obj && m.obj.lastEvent
          && m.obj.lastEvent.ts >= t && m.obj.lastEvent.ts <= t + 1500);   // 追加时刻 ~ 追加后 1.5s 内
        return !!pushed;
      }, 6000, 50);
      await rec.close();
      const dt = pushed ? pushed.obj.lastEvent.ts - t : null;
      check('P1-b①', '事件追加 → 全量推送（脏冲刷不漏推，lastEvent.ts≈追加时刻）', !!pushed,
        pushed ? `追加后 ${pushed.at - t}ms 收到含新事件 full；lastEvent.ts-追加时刻=${dt}ms` : '6s 内未见含新事件的全量推送（漏推！）');
    }

    // P3①：启动不扫描——就绪后立刻查用量必须 pending（旧代码启动即扫，小语料早已非 pending）
    {
      const u = await (await fetch(svc.base + '/api/usage')).json();
      check('P3①', '启动不扫用量（readiness 后即查为 pending）', u.pending === true,
        u.pending ? 'pending:true（首轮未发生）' : '已有数据——启动即扫回归！');
    }

    // P3②：视图打开触发 → 完成且数字入册
    {
      await fetch(svc.base + '/api/usage/calendar');
      let done = null;
      for (let i = 0; i < 40; i++) { await sleep(500); const s = await (await fetch(svc.base + '/api/state')).json(); if (s.usage && !s.usage.pending && s.usage.generatedAt) { done = s.usage; break; } }
      check('P3②', '用量端点触发重扫并完成', !!done,
        done ? `generatedAt=${new Date(done.generatedAt).toISOString().slice(11, 19)}` : '20s 未完成');
      // P3③：70s 无后台重扫（期间只碰 /api/state；向用量文件追加一条「诱饵」——旧 60s 周期必然吸收它）
      fs.appendFileSync(corpus.ccFile, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'glm-5.3', usage: { input_tokens: 999999, output_tokens: 1, cache_read_input_tokens: 0 } } }) + '\n');
      const genBefore = (await (await fetch(svc.base + '/api/state')).json()).usage.generatedAt;
      let genAfter = genBefore;
      for (let i = 0; i < 15; i++) { await sleep(5000); genAfter = (await (await fetch(svc.base + '/api/state')).json()).usage.generatedAt; if (genAfter !== genBefore) break; }
      check('P3③', '70s 内无后台重扫（无客户端时分钟兜底不运行，懒触发口径不变）', genAfter === genBefore,
        genAfter === genBefore ? `generatedAt 稳定 ${genBefore}` : `generatedAt 变化 ${genBefore}→${genAfter}（无客户端仍周期扫描回归！）`);
    }

    // P4-a：SSE-only——先挂 SSE，再写新 claude 会话文件；等 full 快照包含新会话（8～18s；旧代码 5s 内即见）
    // 不轮询 /api/state：可见性必须由服务自身静默信号（四态活动目录 mtime 15s 轮询 + WORKSPACE_STORE 5s）驱动，
    // 否则测的是客户端轮询而非优化（2026-10-18 审查 P3：原「目录 TTL」命名名不副实——TTL 是惰性缓存，不主动触发）。
    {
      const rec = openSse(svc.base);
      await waitUntil(() => rec.msgs.length > 0, 3000, 50);
      await sleep(200);
      const baseIdx = rec.msgs.length;
      const sid = '22222222-0000-4000-8000-000000000002';
      const t = Date.now();
      fs.writeFileSync(path.join(home, '.claude', 'projects', '-verify', sid + '.jsonl'),
        JSON.stringify({ type: 'user', cwd: '/tmp/verify', timestamp: new Date().toISOString(), message: { content: 'p4a' } }) + '\n');
      let seenAt = null;
      await waitUntil(() => {
        const hit = rec.msgs.slice(baseIdx).find((m) => {
          if (m.tick || !m.obj) return false;
          const hist = (m.obj.catalog && m.obj.catalog.history) || [];
          return hist.some((h) => String(h.sessionId).includes(sid)) || (m.obj.sessions || []).some((x) => String(x.id).includes(sid));
        });
        if (hit) { seenAt = hit.at - t; return true; }
        return false;
      }, 25_000, 100);
      await rec.close();
      check('P4-a', '静默新会话信号驱动可见（四态活动目录 mtime 15s 轮询 + 2s 节拍，8～18s 出现在 SSE 全量快照）', seenAt !== null && seenAt >= 8000 && seenAt <= 18000,
        seenAt === null ? '25s 内 SSE 未见（漏推/无静默节拍驱动 TTL！）' : `${(seenAt / 1000).toFixed(1)}s 可见（SSE-only）`);
    }
    // P4-a2：注册表静默变化——先挂 SSE，再改写 workspace.json 的 workspace title；
    // B4 修复靠 5s 廉价 mtime 探测 → forceCatalogRescan + 脏标记 → 2s 节拍 full（不靠 /api/state 轮询）。
    {
      const rec = openSse(svc.base);
      await waitUntil(() => rec.msgs.length > 0, 3000, 50);
      await sleep(200);
      const baseIdx = rec.msgs.length;
      const t = Date.now();
      writeWs('VERIFY-RENAMED');
      let seenAt = null;
      await waitUntil(() => {
        const hit = rec.msgs.slice(baseIdx).find((m) => !m.tick && m.obj && JSON.stringify(m.obj).includes('VERIFY-RENAMED'));
        if (hit) { seenAt = hit.at - t; return true; }
        return false;
      }, 12_000, 100);
      await rec.close();
      check('P4-a2', '注册表静默变化 → SSE 全量推送（workspace.json title 改写 ≤10s 可见）',
        seenAt !== null && seenAt <= 10_000,
        seenAt === null ? '12s 内 SSE 未见含新 title 的 full（注册表静默信号漏推！）' : `${(seenAt / 1000).toFixed(1)}s 可见（SSE-only，B4）`);
    }
  } finally {
    svc.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ---------- P2：8MB 日志 20s 空闲 readBytes（原口径）+ 1MB/8MB CPU 差 + 半帧/轮转正确性 + 64MB 档 ----------
async function suiteRead() {
  const run = async (mb, readyTimeoutMs = 20_000) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `codeall-verify-r${mb}-`));
    const corpus = buildCorpus(home, mb);
    const svc = await bootService(home, {}, readyTimeoutMs);
    try {
      await sleep(10_000);                       // 启动期落定（整文件首读在 boot read() 一次性完成）
      const t0 = Date.now();
      const rec = openSse(svc.base);              // 保持一个客户端在线（真实挂机形态；SSE 不轮询快照）
      await sleep(20_000);
      await rec.close();
      return probeDelta(svc.probeFile, t0, Date.now());
    } finally { svc.kill(); fs.rmSync(home, { recursive: true, force: true }); }
  };
  const small = await run(1);
  const big = await run(8);
  const cpuDiff = small.cpu != null && big.cpu != null ? big.cpu - small.cpu : null;
  const bytesOk = big.readBytes != null && big.readBytes >= 0 && big.readBytes < 1048576;
  check('P2-diff', '增量读：8MB 日志 20s 空闲 readBytes 增量 <1MB（旧实现线性放大）+ CPU 不随体积涨',
    small.cpu != null && big.cpu != null && cpuDiff !== null && cpuDiff <= 400 && bytesOk,
    `1MB CPU=${small.cpu}ms/20s，8MB CPU=${big.cpu}ms/20s，差 ${cpuDiff}ms（阈 400）；`
    + (big.readBytes == null ? '8MB readBytes=null（探针无 readBytes 字段，检查 framed.mjs PET_PERF_PROBE 是否就绪）'
      : `8MB 空闲 20s readBytes 增量 ${big.readBytes}B（readOps ${big.readOps}，阈 1MB，旧实现量级≈8MB×25≈200MB）`));

  // P2-large（2026-10-18 审查 P1 补）：docs/25 附录 C 原声称「>50MB 独立测量 0 B vs 旧 ~2.64GB」但无脚本/产物
  // 入册——本检查把 >50MB 档实测补进套件（64MB 合成日志，20s 空闲窗口 readBytes 增量 ≈0）。
  // 旧整文件实现同窗口的读量为**算术推算**（旧代码已不在树上，无法实测）：800ms 定时整读 ≈25 次 × 64MB ≈ 1.6GB，
  // fs.watch 触发再整读近似翻倍 → GB 量级/窗口；启动就绪耐心放宽（64MB 首读在 boot 一次性完成）。
  const huge = await run(64, 90_000);
  check('P2-large', '增量读不随体积放大：64MB（>50MB 档）日志 20s 空闲 readBytes 增量 <1KB（旧整文件读推算 GB 量级/窗口）',
    huge.readBytes != null && huge.readBytes >= 0 && huge.readBytes < 1024,
    huge.readBytes == null ? '64MB readBytes=null（探针无 readBytes 字段，检查 framed.mjs PET_PERF_PROBE 是否就绪）'
      : `64MB 空闲 20s readBytes 增量 ${huge.readBytes}B（readOps ${huge.readOps}，阈 1KB）；CPU ${huge.cpu}ms/20s；旧实现推算 ≈64MB×25≈1.6GB（800ms 定时整读）+ watch 双触发 GB 量级（非实测）`);

  // 半帧跨追加 + 轮转重读（正确性，确定性断言）
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-verify-p2c-'));
  const corpus = buildCorpus(home, 1);
  const svc = await bootService(home);
  try {
    // 半帧：先写半帧，再补齐——事件必须完整到达（去抖/兜底轮读齐缓冲后解码）
    const t1 = Date.now();
    const frameBuf = zstdFrame([{ type: 'turn/start', time: t1, data: { turnId: 'half-frame' } }, { type: 'turn/end', time: t1 + 5, data: { turnId: 'half-frame', status: 'ok' } }]);
    fs.appendFileSync(corpus.bigLog, frameBuf.subarray(0, Math.floor(frameBuf.length / 2)));
    await sleep(1500);
    fs.appendFileSync(corpus.bigLog, frameBuf.subarray(Math.floor(frameBuf.length / 2)));
    let halfOk = false;
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      const s = await (await fetch(svc.base + '/api/state')).json();
      const sess = (s.sessions || []).find((x) => String(x.id).includes('sess-verify-main'));
      if (sess && sess.lastActiveMs >= t1) { halfOk = true; break; }   // 半帧补齐后事件已入状态机
    }
    // 轮转：写入更小的同名文件（截断）→ 跟随器重置重读，事件重新可见
    let rotateOk = false;
    {
      const t2 = Date.now();
      fs.writeFileSync(corpus.bigLog, Buffer.concat([
        zstdFrame([{ type: 'session', id: 'sess-verify-main', cwd: '/tmp/verify', createdAt: t2, version: 4 }]),
        zstdFrame([{ type: 'turn/start', time: t2, data: { turnId: 'after-rotate' } }]),
      ]));
      for (let i = 0; i < 12; i++) {
        await sleep(1000);
        const s = await (await fetch(svc.base + '/api/state')).json();
        const sess = (s.sessions || []).find((x) => String(x.id).includes('sess-verify-main'));
        if (sess && sess.lastActiveMs >= t2) { rotateOk = true; break; }
      }
    }
    // 坏帧（2026-10-18 审查 P1 补，对齐 docs/25 PERF-2 完成条件「乱序/坏帧/半帧/轮转」）：
    // 无魔数垃圾字节后接合法帧——decodeFrames 按魔数重同步，合法帧事件必须照常到达（不因坏帧丢后续）
    let badFrameOk = false;
    {
      const t3 = Date.now();
      fs.appendFileSync(corpus.bigLog, Buffer.concat([
        Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee]),
        zstdFrame([{ type: 'turn/start', time: t3, data: { turnId: 'after-badframe' } }]),
      ]));
      for (let i = 0; i < 12; i++) {
        await sleep(1000);
        const s = await (await fetch(svc.base + '/api/state')).json();
        const sess = (s.sessions || []).find((x) => String(x.id).includes('sess-verify-main'));
        if (sess && sess.lastActiveMs >= t3) { badFrameOk = true; break; }
      }
    }
    // 乱序：追加 time 早于既有事件的合法帧——事件照常入状态机（lastEvent 反映该帧 ts），
    // 且 lastActiveMs（事件到达时刻口径）不回退（framed.mjs lastAt=Date.now()）
    let outOfOrderOk = false;
    {
      const tOld = Date.now() - 120_000;
      const sBefore = await (await fetch(svc.base + '/api/state')).json();
      const sessBefore = (sBefore.sessions || []).find((x) => String(x.id).includes('sess-verify-main'));
      const activeBefore = sessBefore ? sessBefore.lastActiveMs : 0;
      fs.appendFileSync(corpus.bigLog, zstdFrame([
        { type: 'turn/start', time: tOld, data: { turnId: 'out-of-order' } },
        { type: 'turn/end', time: tOld + 5, data: { turnId: 'out-of-order', status: 'ok' } },
      ]));
      for (let i = 0; i < 12; i++) {
        await sleep(1000);
        const s = await (await fetch(svc.base + '/api/state')).json();
        const le = s.lastEvent;
        const sess = (s.sessions || []).find((x) => String(x.id).includes('sess-verify-main'));
        if (le && Math.abs(Number(le.ts) - tOld) <= 2000 && sess && sess.lastActiveMs >= activeBefore) { outOfOrderOk = true; break; }
      }
    }
    check('P2-correct', '跟随正确性：半帧跨追加完整解码 + 截断轮转重读 + 坏帧重同步 + 乱序不丢不回退', halfOk && rotateOk && badFrameOk && outOfOrderOk,
      `半帧补齐 ${halfOk ? '✓' : '✗'} / 轮转重读 ${rotateOk ? '✓' : '✗'} / 坏帧后合法帧 ${badFrameOk ? '✓' : '✗'} / 乱序帧入机 ${outOfOrderOk ? '✓' : '✗'}`);
  } finally { svc.kill(); fs.rmSync(home, { recursive: true, force: true }); }
}

// ---------- P4-b / P6：zcode 跟随器单元直测 ----------
function zcodeDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, path TEXT, directory TEXT, title TEXT,
      version TEXT, task_type TEXT, title_source TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE session_entry (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, data TEXT, time_created INTEGER, time_updated INTEGER);`);
  return db;
}
async function suiteZcodeUnits() {
  // P4-b：退避——100ms 基准，空闲间隔应显著增长（gaps 暴露：最大 ≥10× 基准），取到新行后回基准，
  // 下一行 ≤600ms 取到。100ms 注入 + 硬编码 10s 上限的组合让 5s 窗口即可观察到多轮增长。
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-verify-zb-'));
    const dbFile = path.join(home, 'db.sqlite');
    const db = zcodeDb(dbFile);
    const now = Date.now();
    db.prepare('INSERT INTO session (id, path, title, task_type, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)').run('s1', '/tmp/v', 't', 'main', now, now);
    db.prepare('INSERT INTO part (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run('p0', 's1', now, now, JSON.stringify({ type: 'text', text: 'seed' }));
    db.close();
    const f = followZcodeLogs({ dbPath: dbFile, intervalMs: 100, maxRows: 5000, lookbackMs: 30_000, onEvent: () => {} });
    await sleep(5000);
    const idle = f.stats();
    const idleGaps = idle.gaps.slice();
    const maxGap = idleGaps.length ? Math.max(...idleGaps) : 0;
    // 第一行新数据：退避间隔已放大；取到后 backoff 应回基准，下一轮实际间隔应回到基准量级
    const t1 = Date.now();
    const db2 = new DatabaseSync(dbFile);
    db2.prepare('INSERT INTO part (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run('p1', 's1', t1, t1, JSON.stringify({ type: 'text', text: 'fresh' }));
    db2.close();
    const rowsBefore = f.stats().rows;
    await waitUntil(() => f.stats().rows > rowsBefore, 8000, 20);
    const rows1 = f.stats().rows;
    const backoffAfterDetect = f.stats().currentBackoffMs;
    const pollsAtDetect = f.stats().polls;
    await waitUntil(() => f.stats().polls > pollsAtDetect, 3000, 20);   // 等回基准后的下一轮
    const afterReset = f.stats();
    // 第二行新数据：回基准后 ≤600ms 应取到
    const t2 = Date.now();
    const db3 = new DatabaseSync(dbFile);
    db3.prepare('INSERT INTO part (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run('p2', 's1', t2, t2, JSON.stringify({ type: 'text', text: 'fresh2' }));
    db3.close();
    const rows2Before = f.stats().rows;
    const resetMs = await waitUntil(() => f.stats().rows > rows2Before, 6000, 20);
    const rows2 = f.stats().rows;
    f.stop();
    check('P4-b', 'ZCode 空闲间隔显著增长（gaps 最大 ≥10× 基准）+ 取到新行后回基准（下一行 ≤600ms）',
      idle.polls <= 12 && idleGaps.length >= 3 && maxGap >= 1000
        && backoffAfterDetect === 100 && afterReset.lastGapMs <= 350
        && rows1 > 0 && rows2 > rows1 && resetMs !== null && resetMs <= 600,
      `空闲 5s ${idle.polls} 轮，间隔 [${idleGaps.join(',')}]ms（最大 ${maxGap}）；新行1 已取到；回基准 backoff=${backoffAfterDetect}ms/实际间隔 ${afterReset.lastGapMs}ms；新行2 ${resetMs === null ? '未取到' : resetMs + 'ms'} 取到`);
    fs.rmSync(home, { recursive: true, force: true });
  }

  // P6-a：指纹去重正确性——同数据 touch 不重放、改数据重放
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-verify-z6-'));
    const dbFile = path.join(home, 'db.sqlite');
    const db = zcodeDb(dbFile);
    const now = Date.now();
    db.prepare('INSERT INTO session (id, path, title, task_type, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)').run('s1', '/tmp/v', 't', 'main', now, now);
    db.prepare('INSERT INTO part (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run('p0', 's1', now, now, JSON.stringify({ type: 'text', text: 'v1' }));
    db.close();
    const f = followZcodeLogs({ dbPath: dbFile, intervalMs: 80, maxRows: 5000, lookbackMs: 30_000, onEvent: () => {} });
    await sleep(400);
    const afterFirst = f.stats().events;
    const db2 = new DatabaseSync(dbFile);
    db2.prepare('UPDATE part SET time_updated = ? WHERE id = ?').run(Date.now(), 'p0');          // 同数据 touch
    db2.close();
    await sleep(800);
    const afterTouch = f.stats().events;
    const db3 = new DatabaseSync(dbFile);
    db3.prepare("UPDATE part SET time_updated = ?, data = ? WHERE id = 'p0'").run(Date.now(), JSON.stringify({ type: 'text', text: 'v2' }));  // 行内 UPDATE
    db3.close();
    let afterUpdate = afterTouch;
    for (let i = 0; i < 30 && afterUpdate === afterTouch; i++) { await sleep(100); afterUpdate = f.stats().events; }   // 退避间隔内取到即可（≤3s）
    f.stop();
    check('P6-a', '指纹去重：同数据 touch 不重放、行内 UPDATE 重放',
      afterTouch === afterFirst && afterUpdate > afterTouch,
      `首播 ${afterFirst} → touch 后 ${afterTouch}（应相等）→ 改数据后 ${afterUpdate}（应增加）`);
    fs.rmSync(home, { recursive: true, force: true });
  }

  // P6-b：差分内存——同一 2.5 万行×6KB 数据，两个子进程：
  //   A=只建库（不挂 follower，基线）  B=建库 + followZcodeLogs 处理完全部行（rows 必须=25000，防空转）
  //   判据用 **live heapUsed**（两个子进程都 --expose-gc，多轮 gc 后取 process.memoryUsage().heapUsed）：
  //   B-A 增量 <8MB（指纹表 ~5000 条 × 64B hex 应≈1-3MB；旧全文本实现 5000×6KB≈30MB 会失败）。
  //   不用 RSS 差分：follower 每轮 STMT.all(maxRows=400) 会把 400×6KB 的 data 字符串送进 JS 堆，
  //   瞬态但 V8 高水位不回缩（实测 RSS 差 +38MB 而 heapUsed 差 +0.86MB）——RSS 测的是查询翻腾，不是留存。
  //   子进程 sqlite 必须含 message 表（跟随 SQL 是 message/part UNION；缺表会让查询报错→rows 恒 0 的空转，
  //   这正是旧版 P6-b 的缺陷——旧断言在 rows=0 下也能"通过"，什么也没证明）。
  {
    const childCode = [
      "import { DatabaseSync } from 'node:sqlite';",
      "import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';",
      "const withFollower = process.argv.includes('1');",
      "const { followZcodeLogs } = await import(process.env.PV_ADAPTER);",
      "const home = fs.mkdtempSync(path.join(os.tmpdir(), withFollower ? 'vzF-' : 'vzB-'));",
      "const dbFile = path.join(home, 'db.sqlite');",
      "const db = new DatabaseSync(dbFile);",
      "db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, path TEXT, title TEXT, task_type TEXT, time_created INTEGER, time_updated INTEGER);' +",
      "  'CREATE TABLE part (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);' +",
      "  'CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);');",
      "const now = Date.now();",
      "db.prepare('INSERT INTO session (id, path, task_type, time_created, time_updated) VALUES (?,?,?,?,?)').run('s1','/tmp/v','main',now,now);",
      "const ins = db.prepare('INSERT INTO part (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)');",
      "const data = JSON.stringify({ type: 'reasoning', text: 'x'.repeat(6000) });",   // reasoning 不产事件：只测 seen 表内存
      "const base = now - 25_000_000;",
      "for (let i = 0; i < 25000; i++) ins.run('p-' + i, 's1', base + i * 1000, base + i * 1000, data);",
      "db.close();",
      "let rows = null;",
      "if (withFollower) {",
      "  const f = followZcodeLogs({ dbPath: dbFile, intervalMs: 50, maxRows: 400, lookbackMs: 30_000_000, onEvent: () => {} });",
      "  for (let i = 0; i < 300 && f.stats().rows < 25000; i++) await new Promise((r) => setTimeout(r, 100));",
      "  rows = f.stats().rows; f.stop();",
      "}",
      "for (let k = 0; k < 4; k++) { if (global.gc) global.gc(); await new Promise((r) => setTimeout(r, 250)); }",
      "const m = process.memoryUsage();",
      "console.log(JSON.stringify({ rss: Math.round(m.rss), heapUsed: Math.round(m.heapUsed), rows: rows }));",
      "fs.rmSync(home, { recursive: true, force: true });",
    ].join('\n');
    const runChild = (withFollower) => {
      const r = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', childCode, '--', withFollower ? '1' : '0'], {
        encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, PV_ADAPTER: path.join(ROOT, 'adapters', 'zcode-adapter.mjs') },
      });
      const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
      let j = null; try { j = JSON.parse(lines[lines.length - 1]); } catch {}
      return { rss: j?.rss ?? null, heapUsed: j?.heapUsed ?? null, rows: j?.rows ?? null, status: r.status, stderr: (r.stderr || '').slice(-300) };
    };
    const baseline = runChild(false);
    const follower = runChild(true);
    const heapGrowthMB = baseline.heapUsed && follower.heapUsed ? (follower.heapUsed - baseline.heapUsed) / 1048576 : null;
    const rssGrowthMB = baseline.rss && follower.rss ? (follower.rss - baseline.rss) / 1048576 : null;
    check('P6-b', '指纹表瘦身：2.5 万行×6KB 差分内存（live heapUsed 增量 <8MB，rows===25000）',
      follower.rows === 25000 && heapGrowthMB !== null && heapGrowthMB >= 0 && heapGrowthMB < 8,
      `live heapUsed 基线 ${baseline.heapUsed ? (baseline.heapUsed / 1048576).toFixed(2) + 'MB' : '?'} → 挂 follower ${follower.heapUsed ? (follower.heapUsed / 1048576).toFixed(2) + 'MB' : '?'}，`
      + `增量 ${heapGrowthMB === null ? '?' : heapGrowthMB.toFixed(2) + 'MB'}（阈 8；旧全文本留存 ≈+30MB 应失败）；`
      + `RSS 参考 ${rssGrowthMB === null ? '?' : rssGrowthMB.toFixed(1) + 'MB（非判据：V8 高水位不回缩）'}；follower rows=${follower.rows}（应 25000）`
      + (follower.status !== 0 ? `；子进程 exit=${follower.status} stderr=${follower.stderr}` : ''));
  }
}

// ---------- P5：并发上限（复用专项回归） ----------
function suiteCap() {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../demo/test-headless-cap.mjs', import.meta.url))], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  check('P5', '无头并发上限 2 + 台账 + busy 入队（test-headless-cap）', r.status === 0,
    (r.stdout || '').trim().split('\n').pop() || ('exit=' + r.status));
}

// ---------- P7：用量检查点（PERF-7）——冷扫让出 + 重启复用 + 无检查点对照 ----------
// 语料 = buildCorpus(64MB DSH zstd + claude 用量)。三个断言：
//   P7-a 冷扫期间 SSE tick 不停顿（让出生效）：首轮全量扫描 dsh elapsedMs ≥ 200ms 且 SSE 消息最大间隔 < 2500ms
//        （tick 节拍 2s；无让出时单个数百 ms 同步块会把间隔拉到 ≥2.4s——只测 elapsed/readBytes 证明不了这点）；
//   P7-b kill -9 → 追加用量行 → 重启：追加被吸收，且未变文件零重读（readBytes ≪ corpusBytes，证据=P0-1 实际读字节口径）；
//   P7-c 对照组（全新 HOME、同语料同追加、无检查点）：readBytes == corpusBytes（证明 P7-b 的省读来自检查点）。
async function suiteCheckpoint() {
  const ccSid = '11111111-0000-4000-8000-000000000001';
  const mkHome = (tag) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-cp-' + tag + '-'));
    return { home, corpus: buildCorpus(home, 64) };
  };
  const triggerAndAwait = async (base) => {
    await fetch(base + '/api/usage/calendar');                       // 懒触发（无需客户端）
    let u = null;
    for (let i = 0; i < 120; i++) { await sleep(250); u = (await (await fetch(base + '/api/state')).json()).usage; if (u && !u.pending && u.generatedAt) return u; }
    return null;
  };
  try {
    // ---- A：冷扫 + SSE 让出 ----
    {
      const { home, corpus } = mkHome('a');
      const svc = await bootService(home);
      try {
        const rec = openSse(svc.base);
        await waitUntil(() => rec.msgs.length > 0, 3000, 50);
        const t0 = Date.now();
        const u = await triggerAndAwait(svc.base);
        const detail = await (await fetch(svc.base + '/api/usage')).json();
        const dsh = detail.perSource?.dsh ?? {};
        const win = rec.msgs.filter((m) => m.at >= t0 - 100);
        let maxGap = 0;
        for (let i = 1; i < win.length; i++) maxGap = Math.max(maxGap, win[i].at - win[i - 1].at);
        await rec.close();
        check('P7-a', '冷扫不阻塞事件循环（64MB 语料首轮全量：dsh elapsed≥200ms 且 SSE 最大间隔 <2500ms）',
          !!u && (dsh.elapsedMs ?? 0) >= 200 && win.length >= 2 && maxGap < 2500,
          u ? `dsh elapsed=${dsh.elapsedMs}ms · SSE ${win.length} 条最大间隔 ${maxGap}ms` : '30s 未完成首轮扫描');
      } finally { svc.kill(); fs.rmSync(home, { recursive: true, force: true }); }
    }
    // ---- B：重启复用（同一 HOME 两段启动） ----
    {
      const { home, corpus } = mkHome('b');
      const s1 = await bootService(home);
      const g1 = await triggerAndAwait(s1.base);
      s1.kill();                                                       // SIGKILL：检查点必须已落盘
      const decoy = JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'glm-5.3', usage: { input_tokens: 999999, output_tokens: 1, cache_read_input_tokens: 0 } } }) + '\n';
      fs.appendFileSync(corpus.ccFile, decoy);
      const s2 = await bootService(home);
      try {
        const g2 = await triggerAndAwait(s2.base);
        const detail = await (await fetch(s2.base + '/api/usage')).json();
        const cc = detail.perSource?.['claude-code'] ?? {}, dsh = detail.perSource?.dsh ?? {};
        const absorbed = (cc.bySession?.[ccSid]?.input ?? 0) >= 999999;
        check('P7-b', '检查点跨重启复用（追加被吸收 + 未变文件零重读 readBytes ≪ corpusBytes）',
          !!g1 && !!g2 && g2.generatedAt > g1.generatedAt && absorbed
            && (dsh.stats?.readBytes ?? 1e9) === 0 && (cc.stats?.readBytes ?? 1e9) <= (cc.stats?.corpusBytes ?? 1),
          `absorbed=${absorbed} · dsh read=${dsh.stats?.readBytes}/${dsh.stats?.corpusBytes} · cc read=${cc.stats?.readBytes}`);
      } finally { s2.kill(); fs.rmSync(home, { recursive: true, force: true }); }
    }
    // ---- C：对照组（无检查点的新 HOME） ----
    {
      const { home, corpus } = mkHome('c');
      fs.appendFileSync(corpus.ccFile, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'glm-5.3', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } } }) + '\n');
      const svc = await bootService(home);
      try {
        await triggerAndAwait(svc.base);
        const detail = await (await fetch(svc.base + '/api/usage')).json();
        const dsh = detail.perSource?.dsh ?? {};
        check('P7-c', '对照组（无检查点）：首轮全量 readBytes == corpusBytes（P7-b 省读证据成立的前提）',
          (dsh.stats?.readBytes ?? 0) === (dsh.stats?.corpusBytes ?? -1) && (dsh.stats?.corpusBytes ?? 0) > 50 * 1048576,
          `read=${dsh.stats?.readBytes} corpus=${dsh.stats?.corpusBytes}`);
      } finally { svc.kill(); fs.rmSync(home, { recursive: true, force: true }); }
    }
  } catch (e) {
    check('P7', '用量检查点套件异常', false, String(e?.message || e).slice(0, 160));
  }
}

// ---------- 主流程 ----------
console.log(`# v0.1.1 真优化验证（${new Date().toISOString()} · node ${process.version}）\n`);
const t0 = Date.now();
await suiteService();
await suiteRead();
await suiteZcodeUnits();
suiteCap();
await suiteCheckpoint();
const failed = results.filter((r) => !r.pass);
console.log(`\n# 汇总：${results.length - failed.length}/${results.length} 通过，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (failed.length) { console.log('失败项：' + failed.map((f) => f.id).join(', ')); process.exit(1); }
