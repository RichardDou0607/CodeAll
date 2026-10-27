#!/usr/bin/env node
/**
 * scripts/catalog-check.mjs — 会话目录自检（真实数据 + 断言 + 性能实测）
 *
 * 用法：
 *   node scripts/catalog-check.mjs            # 人类可读报告（真实输出可原样贴文档）
 *   node scripts/catalog-check.mjs --json     # 机器可读（CI 用）
 *   node scripts/catalog-check.mjs --locks    # 附带 flock 占用探测（多花 ~50ms）
 *   node scripts/catalog-check.mjs --runs 20  # 性能轮数（默认 10）
 *
 * 断言清单（本机真实数据 + 固定合成性能基准）：
 *   A1 会话根目录可读，项目数 ≥ 3
 *   A2 会话数 ≥ 12
 *   A3 每条会话都有非空 sessionId 与有限 updatedAt；bytes ≥ 0
 *   A4 model / reasoningEffort 的**来源可追溯**：metaSources 指向已知原生事件；且与
 *      「整文件全量解析」的抽样对照结果一致（这是防回归的关键断言）
 *   A5 agentVersion（应用版本）≠ logFormatVersion（日志格式版本 4）——两者曾被混淆过
 *   A6 title 来源可追溯（session/title 或 subagent/descriptor.label）
 *   A7 activity 摘要**零泄漏**：全部取自固定字典，≤80 字符，且不含真实工具参数/命令原文
 *   A8 解析失败必须降级（合成坏日志：仍返回 sessionId/updatedAt/bytes）
 *   A9 性能：12+ 会话整体扫描中位数 < 300 ms（含真实 2 MB 级日志）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { scanCatalog, toCatalogFrame, pickLogFile, probeLock, encodeProjectDirName, SESSIONS_ROOT } from '../adapters/session-catalog.mjs';
import { decodeZstdFrames, extractMeta, coarseState, firstUserTitleFromEvents, activityOf, ACTIVITY_TEXT, ACTIVITY_TEXT_MAX, AGENT_VERSION } from '../adapters/dsh-meta.mjs';

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const WITH_LOCKS = argv.includes('--locks');
const RUNS = (() => { const i = argv.indexOf('--runs'); return i >= 0 ? Math.max(1, Number(argv[i + 1]) || 10) : 10; })();

const results = [];
function check(id, name, pass, detail) { results.push({ id, name, pass: !!pass, detail }); return pass; }

// ---------------------------------------------------------------- 扫描 + 性能
const times = [];
let catalog;
for (let i = 0; i < RUNS; i++) {
  const t0 = process.hrtime.bigint();
  catalog = scanCatalog();
  times.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
const sorted = [...times].sort((a, b) => a - b);
const perf = { runs: RUNS, min: sorted[0], median: sorted[Math.floor(RUNS / 2)], max: sorted.at(-1), avg: times.reduce((a, b) => a + b, 0) / RUNS };

check('A1', '会话根目录可读且项目数 ≥ 3', catalog.stats.projects >= 3, { root: catalog.root, projects: catalog.stats.projects });
check('A2', '会话数 ≥ 12', catalog.stats.sessions >= 12, { sessions: catalog.stats.sessions, main: catalog.stats.mainSessions, subagent: catalog.stats.subagentSessions });

const badId = catalog.sessions.filter((s) => typeof s.sessionId !== 'string' || !s.sessionId.length);
const badTs = catalog.sessions.filter((s) => !Number.isFinite(s.updatedAt) || s.updatedAt <= 0);
const badBytes = catalog.sessions.filter((s) => !Number.isFinite(s.bytes) || s.bytes < 0);
check('A3', '每条会话都有 sessionId + updatedAt + bytes', badId.length === 0 && badTs.length === 0 && badBytes.length === 0, { badId: badId.length, badTs: badTs.length, badBytes: badBytes.length });

// ---------------------------------------------------------------- 元信息来源可追溯
const KNOWN_SOURCES = /^(request\/header|model\/selection|subagent\/descriptor|agent-preset\/selected|session\/title|header)\b/;
const withModel = catalog.sessions.filter((s) => s.model);
const badSource = withModel.filter((s) => !KNOWN_SOURCES.test(String(s.metaSources.model ?? '')));
check('A4a', 'model 来源可追溯（metaSources.model 指向已知原生事件）', withModel.length > 0 && badSource.length === 0, { withModel: withModel.length, badSource: badSource.map((s) => [s.sessionId, s.metaSources.model]) });
const withEffort = catalog.sessions.filter((s) => s.reasoningEffort);
const badEffort = withEffort.filter((s) => !KNOWN_SOURCES.test(String(s.metaSources.reasoningEffort ?? '')));
check('A4b', 'reasoningEffort 来源可追溯', withEffort.length > 0 && badEffort.length === 0, { withEffort: withEffort.length, badEffort: badEffort.length });

// A4c 抽样全量对照：把整份日志全解一遍，用「最后一个 request/header.config」复核目录里的 model/effort
const sample = [...withModel].sort((a, b) => b.bytes - a.bytes).slice(0, 2);
const crossChecks = [];
for (const s of sample) {
  const log = pickLogFile(s.dir);
  const full = decodeZstdFrames(fs.readFileSync(log.file));
  const header = full.records.find((r) => r.type === 'session') ?? null;
  const meta = extractMeta(full.records, { header });
  crossChecks.push({ sessionId: s.sessionId, frames: full.frames, events: full.records.length, catalog: [s.provider, s.model, s.reasoningEffort], fullScan: [meta.provider, meta.model, meta.reasoningEffort], same: s.model === meta.model && s.reasoningEffort === meta.reasoningEffort && s.provider === meta.provider });
}
check('A4c', '抽样：目录结果与整文件全量解析一致', crossChecks.length > 0 && crossChecks.every((c) => c.same), crossChecks);

// ---------------------------------------------------------------- agentVersion ≠ 日志格式版本
const versionBug = catalog.sessions.filter((s) => String(s.agentVersion) === String(s.logFormatVersion));
check('A5', 'agentVersion（应用版本）≠ logFormatVersion（日志格式版本）', versionBug.length === 0 && AGENT_VERSION === '0.2.0-rc.2', { agentVersion: AGENT_VERSION, logFormatVersions: [...new Set(catalog.sessions.map((s) => s.logFormatVersion))], buggy: versionBug.length });

// ---------------------------------------------------------------- 标题来源
// 口径：标题回退链 session/title → 首条用户消息 → null（前端显示「（未命名）」，不拿项目名冒充）。
// 有标题时来源必须可追溯；无标题时来源必须明确标 'derived:none'。
const KNOWN_TITLE_SOURCES = /^(session\/title|subagent\/descriptor|derived:)/;
const badTitle = catalog.sessions.filter((s) => s.title
  ? !KNOWN_TITLE_SOURCES.test(String(s.metaSources.title ?? ''))
  : String(s.metaSources.title ?? '') !== 'derived:none');
check('A6', 'title 来源可追溯（session/title / 首条用户消息推导；无标题明确标 derived:none）', badTitle.length === 0, { badTitle: badTitle.map((s) => [s.sessionId, s.metaSources.title, s.title]) });

// ---------------------------------------------------------------- activity 零泄漏
const ALLOWED_TEXTS = new Set(Object.values(ACTIVITY_TEXT));
let acts = 0, badText = 0, tooLong = 0, leaked = 0;
const leakNeedles = [];
for (const s of catalog.sessions.slice(0, 8)) {
  const log = pickLogFile(s.dir);
  const full = decodeZstdFrames(fs.readFileSync(log.file), { maxRecords: 4000 });
  // 真实泄漏探针：把日志里出现过的命令/路径片段当"针"，确认它们绝不出现在 activity 文案里
  for (const r of full.records) {
    if (r?.type === 'tool/call') {
      const v = r.data?.input?.command ?? r.data?.input?.file_path ?? r.data?.input?.path ?? r.data?.input?.query;
      if (typeof v === 'string' && v.length >= 12) leakNeedles.push(v.slice(0, 24));
    }
  }
  for (const r of full.records) {
    const a = activityOf(r);
    if (!a) continue;
    acts++;
    if (!ALLOWED_TEXTS.has(a.text)) badText++;
    if (Array.from(a.text).length > ACTIVITY_TEXT_MAX) tooLong++;
    for (const n of leakNeedles) if (a.text.includes(n)) leaked++;
  }
}
check('A7', 'activity 摘要来自固定字典 / ≤80 字符 / 零参数泄漏', acts > 0 && badText === 0 && tooLong === 0 && leaked === 0, { activities: acts, badText, tooLong, leaked, needles: leakNeedles.length });

// ---------------------------------------------------------------- 降级路径（合成坏数据）
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-check-'));
let degradedOk = false, degradedDetail = null;
try {
  const proj = path.join(tmpRoot, '--tmp-broken--');
  const sdir = path.join(proj, 'session-broken-0001');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'session.v4.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x02, 0x03, 0x04, 0x05])); // 非 zstd 有效帧
  const cat = scanCatalog({ root: tmpRoot });
  const s = cat.sessions[0];
  degradedOk = !!s && s.degraded === true && s.sessionId === 'session-broken-0001' && Number.isFinite(s.updatedAt) && Number.isFinite(s.bytes);
  degradedDetail = s ? { sessionId: s.sessionId, degraded: s.degraded, error: s.error, updatedAt: s.updatedAt, bytes: s.bytes } : null;
} finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
check('A8', '坏日志降级：仍给出 sessionId/updatedAt/bytes', degradedOk, degradedDetail);

// ---------------------------------------------------------------- 性能
check('A9', '扫描耗时中位数 < 300 ms', perf.median < 300, perf);

// ---------------------------------------------------------------- 目录名编码（与 DSH 落盘规则对照）
const encBad = catalog.projects.filter((p) => p.cwdSource === 'log-header' && encodeProjectDirName(p.cwd) !== p.projectDirName);
check('A11', '项目目录名与 DSH projectKey 编码规则一致（用真实 cwd 反推）', encBad.length === 0, { checked: catalog.projects.filter((p) => p.cwdSource === 'log-header').length, bad: encBad.map((p) => [p.cwd, p.projectDirName, encodeProjectDirName(p.cwd)]) });

// ---------------------------------------------------------------- 窗口近似度（快扫 vs 深扫，诚实报告）
const deep = scanCatalog({ deep: true });
const keyOf = (s) => [s.provider, s.model, s.reasoningEffort, s.agentPreset, s.title].join('|');
const divergent = [];
for (const s of catalog.sessions) {
  const d = deep.sessions.find((x) => x.sessionId === s.sessionId);
  if (d && keyOf(s) !== keyOf(d)) divergent.push({ sessionId: s.sessionId, window: [s.model, s.reasoningEffort, s.title], deep: [d.model, d.reasoningEffort, d.title] });
}
check('A12', '快扫(前8+末2帧) 与深扫(整文件) 的元信息差异 ≤ 25%（差异=会话中途改模型/标题）', divergent.length / Math.max(1, catalog.sessions.length) <= 0.25, { divergent: divergent.length, total: catalog.sessions.length, detail: divergent.map((d) => d.sessionId.slice(0, 20)) });
{
  const benchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-deep-bench-'));
  const benchFiles = new Map();
  try {
    for (let i = 0; i < 12; i++) {
      const sid = 'bench-deep-' + i;
      const cwd = '/tmp/catalog-bench/project-' + (i % 3);
      const dir = path.join(benchRoot, encodeProjectDirName(cwd), sid);
      fs.mkdirSync(dir, { recursive: true });
      const now = Date.now();
      const events = [
        { type: 'session', id: sid, cwd, createdAt: now, version: 4 },
        { type: 'user/message', time: now + 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '<system-reminder>noise</system-reminder>' }] } },
        { type: 'user/message', time: now + 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '基准用户标题 ' + i }] } },
        { type: 'model/selection', time: now + 3, data: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } },
        { type: 'request/header', time: now + 4, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } } } },
        { type: 'agent-preset/selected', time: now + 5, data: { agentPreset: 'bench' } },
      ];
      if (i % 4 !== 0) events.push({ type: 'session/title', time: now + 6, data: { title: '基准标题 ' + i } });
      events.push({ type: 'turn/start', time: now + 7, data: { turnId: 'turn-1' } });
      for (let j = 0; j < 3000; j++) {
        events.push({ type: 'assistant/message', time: now + 8 + j, data: {
          turnId: 'turn-1', text: 'x'.repeat(1024),
          content: Array.from({ length: 16 }, (_, k) => ({ type: 'text', text: 'y'.repeat(256), meta: { index: k, flags: [true, k] } })),
        } });
      }
      events.push({ type: 'turn/end', time: now + 4000, data: { turnId: 'turn-1', reason: { kind: 'ok' } } });
      if (i % 5 === 0) events.push({ type: 'llm/retry', time: now + 4001, data: {} });
      if (i % 3 === 0) events.push({ type: 'turn/start', time: now + 4002, data: { turnId: 'turn-2' } });
      const file = path.join(dir, 'session.v4.jsonl.zstd');
      fs.writeFileSync(file, Buffer.concat(events.map((event) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n')))));
      benchFiles.set(sid, file);
    }
    const times = [];
    let bench;
    for (let i = 0; i < 3; i++) {
      const t = process.hrtime.bigint();
      bench = scanCatalog({ root: benchRoot, deep: true });
      times.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    const mismatches = [];
    for (const s of bench.sessions) {
      const full = decodeZstdFrames(fs.readFileSync(benchFiles.get(s.sessionId)), { maxRecords: 200000 }).records;
      const header = full.find((event) => event?.type === 'session') ?? null;
      const meta = extractMeta(full, { header });
      const expectedTitle = meta.title ?? firstUserTitleFromEvents(full);
      const expectedState = coarseState(full);
      if (s.title !== expectedTitle || s.provider !== meta.provider || s.model !== meta.model
        || s.reasoningEffort !== meta.reasoningEffort || s.agentPreset !== meta.agentPreset
        || s.state !== expectedState.state || s.stateSource !== expectedState.stateSource) {
        mismatches.push({ sessionId: s.sessionId, expectedTitle, actualTitle: s.title, expectedState, actualState: { state: s.state, stateSource: s.stateSource } });
      }
    }
    const sorted = [...times].sort((a, b) => a - b);
    check('A13', '真实深扫零降级；固定语料结果一致且中位数 <300ms',
      deep.stats.degraded === 0 && mismatches.length === 0 && sorted[1] < 300,
      { realDeepTookMs: Number(deep.tookMs.toFixed(1)), realDegraded: deep.stats.degraded,
        fixtureMedianMs: Number(sorted[1].toFixed(1)), fixtureRunsMs: times.map((n) => Number(n.toFixed(1))),
        fixtureSessions: bench.sessions.length, mismatches });
  } finally { fs.rmSync(benchRoot, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- 会话形态（恒为 desktop）
const variantMains = catalog.sessions.filter((s) => s.kind !== 'subagent' && !s.degraded);
const badVariant = variantMains.filter((s) => s.variant !== 'desktop');
check('A14', 'DSH 主会话形态恒为桌面（DSH 无 CLI 产品，不再按 ~/.dsh/profiles 路径猜 CLI）',
  variantMains.length > 0 && badVariant.length === 0,
  { mains: variantMains.length, desktop: variantMains.filter((s) => s.variant === 'desktop').length, bad: badVariant.map((s) => s.sessionId) });

// ---------------------------------------------------------------- 契约帧
const frame = toCatalogFrame(catalog);
const frameOk = frame.ctl === 'catalog' && Array.isArray(frame.projects) && frame.projects.every((p) => typeof p.projectId === 'string' && Array.isArray(p.sessions)) &&
  frame.projects.flatMap((p) => p.sessions).every((s) => s.sessionId && 'model' in s && 'reasoningEffort' in s && 'title' in s && 'state' in s && 'live' in s);
check('A10', '契约 §2.2 ctl:catalog 帧形状正确', frameOk, { projects: frame.projects.length, sessions: frame.projects.flatMap((p) => p.sessions).length });

// ---------------------------------------------------------------- flock（可选）
let locks = null;
if (WITH_LOCKS) {
  locks = [];
  for (const s of catalog.sessions) locks.push({ sessionId: s.sessionId, kind: s.kind, live: s.live, lock: await probeLock(path.join(s.dir, 'session.lock')) });
}

// ---------------------------------------------------------------- 报告
const failed = results.filter((r) => !r.pass);
if (AS_JSON) {
  console.log(JSON.stringify({ root: catalog.root, stats: catalog.stats, perf, results, locks, ok: failed.length === 0 }, null, 2));
} else {
  console.log('会话目录自检  ·  root = ' + catalog.root);
  console.log('本机实际：' + catalog.stats.projects + ' 个项目 / ' + catalog.stats.sessions + ' 个会话（主 ' + catalog.stats.mainSessions + ' · 子代理 ' + catalog.stats.subagentSessions + ' · 活跃 ' + catalog.stats.live + ' · 降级 ' + catalog.stats.degraded + '）');
  console.log('性能：' + perf.runs + ' 轮 min ' + perf.min.toFixed(1) + ' / 中位 ' + perf.median.toFixed(1) + ' / max ' + perf.max.toFixed(1) + ' ms（阈值 300 ms；实际读取 ' + (catalog.stats.readBytes / 1024).toFixed(0) + ' KB）');
  console.log('');
  for (const r of results) console.log((r.pass ? '  ✅ ' : '  ❌ ') + r.id + ' ' + r.name + (r.pass ? '' : '  → ' + JSON.stringify(r.detail)));
  console.log('');
  console.log('会话清单（会话行只显示粗粒度信息）：');
  for (const p of catalog.projects) {
    console.log('  ' + p.title + '  [' + p.cwd + ']  ' + p.sessionCount + ' 个会话');
    for (const s of p.sessions) console.log('    - ' + String(s.sessionId).slice(0, 42).padEnd(43) + String(s.kind).padEnd(9) + String(s.model ?? '—').padEnd(16) + String(s.reasoningEffort ?? '—').padEnd(5) + String(s.state).padEnd(7) + (s.live ? 'LIVE ' : '     ') + '← ' + (s.metaSources.model ?? '—'));
  }
  if (locks) { console.log(''); console.log('flock 占用探测：' + locks.map((l) => l.sessionId.slice(0, 18) + '=' + l.lock).join('  ')); }
  console.log('');
  console.log(failed.length === 0 ? '全部 ' + results.length + ' 项断言通过 ✅' : failed.length + '/' + results.length + ' 项断言失败 ❌');
}
process.exit(failed.length ? 1 : 0);
