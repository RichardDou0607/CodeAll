#!/usr/bin/env node
/**
 * adapters/usage-collect.mjs — Token 用量采集（五源，独立于目录扫描的慢通道）
 *
 * 与目录扫描（scanXCatalog，头/尾窗口、5s 热缓存）分离的原因：usage 需要**全文件**精确累计，
 * 本机 Claude 转录 1.1GB / 164 文件——不能进热路径。本模块自建 60s 慢缓存 + 文件级增量
 * （size+mtime 不变 → 直接复用上次结果，刷新只重读有增长的文件），流式 readline、
 * 按行 marker 预过滤（不含 '"usage"' / '"token_count"' 等标记的行不 JSON.parse）。
 *
 * 三个维度（2026-10-07 二期）：
 *   ① 模型维度   per-model（原有）
 *   ② 时间维度   按本地自然日分桶（dayKey = yyyymmdd），聚合时按 now 切 当日/7日/30日/全部。
 *               日桶是绝对口径 → 文件级缓存跨天仍然正确（相对窗口在聚合层计算）。
 *   ③ 形态维度   Claude（entrypoint）/ Codex（session_meta.originator）/ Kimi（clientMetadata
 *               composer）与会话目录同源判定 cli/desktop/ide，**文件级归属**（整文件一种形态）。
 *
 * 各源 usage 口径（全部本机实测，2026-10-07）：
 *   DSH          assistant/message 的 data.usage（每调用一组）累加；input 不含 cache；
 *                model 取行序 request/header；每目录只取最高代日志（pickLogFile 防双计）。
 *   Claude Code  assistant 行 message.usage：同一条消息（message.id 相同）在流式分块中
 *                出现多行快照 → 按 message.id 去重、**后写覆盖**（最终快照）；input_tokens
 *                不含 cache。sidechain 行与 <sid>/subagents/agent-*.jsonl 都计入（归入父会话）。
 *   Codex        event_msg.token_count：info.total_token_usage 是**会话累计值**（取最后一条，
 *                权威）；last_token_usage 是事件增量（实测比权威少 ~25%）→ 单模型会话整额归属。
 *                input 含 cache。日桶/模型桶只能用事件增量（成文近似）。
 *   Kimi Code    usage.record：每次请求一条，直接累加；inputOther→input、inputCacheRead→
 *                cacheRead、inputCacheCreation→cacheWrite；含全部 agents/<id>/ 子代理流。
 *   ZCode        message 表 data JSON 的 tokens（与 part.step-finish 双路实测一致）：
 *                {total,input,output,reasoning,cache:{read,write}}；**input 含 cacheRead**。
 *                判定证据（2026-10-07 二次复核，用户质疑 49% 命中率后用两实验裁决）：
 *                ① 官方账本 raw_usage_json（provider 原始返回）：{inputTokens, totalTokens
 *                   = inputTokens+outputTokens, cacheReadTokens} —— inputTokens 为全量
 *                   prompt（OpenAI 式含 cache），fresh = input − cacheRead；
 *                ② 同会话连续请求递推：cr[t+1] ≈ in[t]（累计误差 1.7 万）vs fresh 说的
 *                   cr[t+1] ≈ in[t]+cr[t]（误差 35 万，20 倍）——input 就是全上下文；
 *                ③ 全日 Σ(in−cr)/请求 ≈ 5k/次 = 每请求新增内容量级（fresh 说会推出
 *                   155k/次新内容，上下文无法持续，不可能）。
 *                行级 SQL（session_id × modelId × time_created）JS 折叠；subagent_child 计入。
 *
 * 缓存命中率（跨源统一折算）：fresh = 含cache语义 ? input - cacheRead : input；
 *   hitRate = cacheRead / (fresh + cacheRead)。inputIncludesCache 按源标注：
 *   DSH/Claude/Kimi = false（Anthropic 式 input_tokens 不含 cache），Codex/ZCode = true。
 *
 * 用法：
 *   node adapters/usage-collect.mjs [--json|--refresh]
 *   framed.mjs 内 refreshUsage()：60s 轮询 → snapshot().usage + /api/usage
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PROJECTS_ROOT } from './claude-code-adapter.mjs';
import { SESSIONS_ROOT as CODEX_ROOT, threadIdOf } from './codex-adapter.mjs';
import { SESSIONS_ROOT as KIMI_ROOT } from './kimi-code-adapter.mjs';
import { openZcodeDb, ZCODE_DB } from './zcode-adapter.mjs';
import { SESSIONS_ROOT as DSH_ROOT, pickLogFile } from './session-catalog.mjs';

export const DEFAULT_OPTS = Object.freeze({
  maxFiles: 800,                 // 单源文件数上限（本机 Claude 164 / Codex 34 / Kimi 12 / DSH 37）
  maxLineBytes: 512 * 1024,      // 超大行（工具输出）必不含 usage：跳过
  softBudgetMs: 15_000,          // 单源单轮软时限：到点即停（partial=true），未处理文件下轮续
  refresh: false,                // true=忽略文件级缓存强制重读（诊断用）
});

// ---------- 公共累计器 ----------
export function newUsage() { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }; }
const fin = (v) => (Number.isFinite(v) ? v : 0);
function addInto(acc, d) {
  acc.input += fin(d.input); acc.output += fin(d.output);
  acc.cacheRead += fin(d.cacheRead); acc.cacheWrite += fin(d.cacheWrite);
  acc.requests += fin(d.requests) || (fin(d.input) || fin(d.output) ? 1 : 0);
}
function bumpModel(map, model, d) {
  let m = map.get(model);
  if (!m) { m = newUsage(); map.set(model, m); }
  addInto(m, d);
}
/** 本地自然日整数键（yyyymmdd）：「当日」按用户本地时区的自然日切。 */
function dayKeyOf(tsMs) {
  const d = new Date(Number.isFinite(tsMs) ? tsMs : Date.now());
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
function dayStartMs(dayKey) {
  return new Date(Math.floor(dayKey / 10000), Math.floor(dayKey / 100) % 100 - 1, dayKey % 100).getTime();
}
/** 三层桶：model → day → usage（时间维度 × 模型维度）。 */
function bumpDay(dayMap, day, d) {
  let u = dayMap.get(day);
  if (!u) { u = newUsage(); dayMap.set(day, u); }
  addInto(u, d);
}
function bumpModelDay(mdm, model, day, d) {
  let dm = mdm.get(model);
  if (!dm) { dm = new Map(); mdm.set(model, dm); }
  bumpDay(dm, day, d);
}
/** fresh input / 命中率折算（含cache语义的源要先减掉 cacheRead）。 */
function freshInputOf(u, includesCache) { return includesCache ? Math.max(0, fin(u.input) - fin(u.cacheRead)) : fin(u.input); }
function decorate(u, includesCache) {
  const fresh = freshInputOf(u, includesCache);
  const denom = fresh + fin(u.cacheRead);
  return { ...u, freshInput: fresh, hitRate: denom > 0 ? fin(u.cacheRead) / denom : null };
}

/** 文件级增量缓存：path → {size, mtimeMs, result}；跨轮常驻（进程内）。 */
function makeFileCache() { return new Map(); }
function cachedEntry(cache, file, st) {
  const hit = cache.get(file);
  return hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs ? hit : null;
}

/** 列文件（mtime 倒序）：预算先花在新文件上，partial 时截掉的是最旧的。 */
function listFilesDesc(walk) {
  const out = [];
  try { walk(out); } catch { /* root 不存在 */ }
  out.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return out;
}

// 形态判定（与各适配器目录扫描同源逻辑，文件级）
function variantFromEntrypoint(ep) {
  return typeof ep !== 'string' || !ep ? null : /desktop/i.test(ep) ? 'desktop' : /vscode/i.test(ep) ? 'ide' : 'cli';
}
function variantFromOriginator(og) {
  return typeof og !== 'string' || !og ? null : /desktop/i.test(og) ? 'desktop' : 'cli';
}

// ---------------------------------------------------------------------------
// DSH：~/.dsh/sessions/<projectKey>/<sessionId>/session.vN.jsonl(.zstd)（多帧 zstd）
// ---------------------------------------------------------------------------

const dshFileCache = makeFileCache();
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 多帧 zstd → 文本（与 framed.mjs decodeFrames 同款逐帧解压；尾部半写坏帧跳过）；明文直读。 */
function dshReadText(buf) {
  if (!buf.subarray(0, 4).equals(ZSTD_MAGIC)) return buf.toString('utf8');
  const offs = [];
  let i = buf.indexOf(ZSTD_MAGIC, 0);
  while (i >= 0) { offs.push(i); i = buf.indexOf(ZSTD_MAGIC, i + 1); }
  let out = '';
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { out += zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8'); } catch { /* 坏帧/半写尾帧 */ }
  }
  return out;
}

async function collectDshFile(file, o) {
  let st; try { st = fs.statSync(file); } catch { return { skipped: true }; }
  const hit = o.refresh ? null : cachedEntry(dshFileCache, file, st);
  if (hit) return { ...hit.result, cached: true };
  let buf; try { buf = fs.readFileSync(file); } catch { return { skipped: true }; }
  const byModel = new Map(), modelDays = new Map(), days = new Map();
  const flat = newUsage();
  let curModel = null, sid = null, parseErrors = 0, usageLines = 0, totalTokensSum = 0;
  for (const line of dshReadText(buf).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (!t.includes('"usage"') && !t.includes('"request/header"') && !t.includes('"type":"session"')) continue;
    if (t.length > o.maxLineBytes) continue;
    let j; try { j = JSON.parse(t); } catch { parseErrors++; continue; }
    if (j?.type === 'session' && sid === null) sid = typeof j.id === 'string' ? j.id : null;
    else if (j?.type === 'request/header') {
      const m = j.data?.header?.config?.model;
      if (typeof m === 'string' && m) curModel = m;
    } else if (j?.type === 'assistant/message') {
      const u = j.data?.usage;
      if (!u || (!Number.isFinite(u.inputTokens) && !Number.isFinite(u.outputTokens))) continue;
      usageLines++;
      const d = { input: fin(u.inputTokens), output: fin(u.outputTokens), cacheRead: fin(u.cacheReadTokens), cacheWrite: fin(u.cacheWriteTokens), requests: 1 };
      const day = dayKeyOf(Number.isFinite(j.time) ? j.time : Date.now());
      addInto(flat, d);
      bumpDay(days, day, d);
      bumpModel(byModel, curModel || '(unknown)', d);
      bumpModelDay(modelDays, curModel || '(unknown)', day, d);
      totalTokensSum += fin(u.totalTokens);
    }
  }
  const result = {
    flat, days, models: byModel, modelDays, variant: null, sid,   // DSH 无形态标记（与目录口径一致）
    stats: { usageLines, parseErrors, totalTokensSum, componentsSum: flat.input + flat.output + flat.cacheRead + flat.cacheWrite },
  };
  dshFileCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, result });
  return result;
}

export async function scanDshUsage(opts = {}) {
  const o = { ...DEFAULT_OPTS, root: DSH_ROOT, ...opts };
  const t0 = process.hrtime.bigint();
  const logs = listFilesDesc((out) => {
    for (const wd of fs.readdirSync(o.root, { withFileTypes: true })) {
      if (!wd.isDirectory() || wd.name.startsWith('.')) continue;
      const wdPath = path.join(o.root, wd.name);
      let ses; try { ses = fs.readdirSync(wdPath, { withFileTypes: true }); } catch { continue; }
      for (const s of ses) {
        if (!s.isDirectory()) continue;
        // 每会话目录只取最高代日志（pickLogFile 与 catalog 同源：v3+v4 并存时不会双计）
        const pick = (() => { try { return pickLogFile(path.join(wdPath, s.name)); } catch { return null; } })();
        if (pick) out.push(pick.file);
      }
    }
  });
  const acc = newAcc();
  for (const f of logs) {
    if (acc.stats.files >= o.maxFiles) { acc.stats.partial = true; break; }
    const r = await collectDshFile(f, o);
    if (r.aborted) { acc.stats.partial = true; break; }
    if (r.skipped || !r.sid) continue;
    acc.stats.files++;
    if (r.cached) acc.stats.cachedFiles++;
    acc.stats.parseErrors += r.stats.parseErrors;
    if (r.stats.componentsSum !== r.stats.totalTokensSum) acc.stats.identityMismatched++;   // 恒等式失配=解析可疑（对账口径）
    try { acc.stats.readBytes += fs.statSync(f).size; } catch { /* 文件消失 */ }
    foldFile(acc, r, r.sid);
  }
  acc.stats.sessions = acc.bySession.size;
  return finishScan('dsh', acc, t0, { inputIncludesCache: false });
}

// ---------------------------------------------------------------------------
// Claude Code：~/.claude/projects/**（含 <sid>/subagents/agent-*.jsonl）
// ---------------------------------------------------------------------------

const claudeFileCache = makeFileCache();

async function collectClaudeFile(file, o) {
  let st; try { st = fs.statSync(file); } catch { return { skipped: true }; }
  const hit = o.refresh ? null : cachedEntry(claudeFileCache, file, st);
  if (hit) return { ...hit.result, cached: true };
  const byMsg = new Map();
  let variant = null, anonSeq = 0, parseErrors = 0, aborted = false, lineCnt = 0;
  const deadline = Date.now() + o.softBudgetMs;
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if ((++lineCnt & 511) === 0 && Date.now() > deadline) { aborted = true; break; }
        const isUsage = line.includes('"usage"');
        if (!isUsage && !line.includes('"entrypoint"')) continue;
        if (line.length > o.maxLineBytes) continue;
        let j; try { j = JSON.parse(line); } catch { parseErrors++; continue; }
        if (typeof j?.entrypoint === 'string') variant = variantFromEntrypoint(j.entrypoint);   // 后写覆盖
        if (!isUsage) continue;
        const m = j?.message;
        if (j?.type !== 'assistant' || !m?.usage) continue;
        const u = m.usage;
        const input = fin(u.input_tokens), output = fin(u.output_tokens);
        const cacheRead = fin(u.cache_read_input_tokens), cacheWrite = fin(u.cache_creation_input_tokens);
        if (!input && !output && !cacheRead && !cacheWrite) continue;
        const key = typeof m.id === 'string' && m.id ? m.id : 'anon:' + (++anonSeq);
        byMsg.set(key, {
          model: typeof m.model === 'string' && m.model ? m.model : '(unknown)',
          input, output, cacheRead, cacheWrite, requests: 1,
          day: dayKeyOf(Date.parse(j.timestamp) || Date.now()),
        });
      }
    } finally { try { rl.close(); } catch { /* 已关闭 */ } }
  } catch { return { skipped: true }; }
  if (aborted) return { aborted: true };                 // 半读文件不入缓存（下轮整读）
  const byModel = new Map(), modelDays = new Map(), days = new Map();
  const flat = newUsage();
  for (const v of byMsg.values()) {
    const { model, day, ...d } = v;
    addInto(flat, d);
    bumpDay(days, day, d);
    bumpModel(byModel, model, d);
    bumpModelDay(modelDays, model, day, d);
  }
  const result = { flat, days, models: byModel, modelDays, variant, stats: { distinctMsgs: byMsg.size, parseErrors } };
  claudeFileCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, result });
  return result;
}

export async function scanClaudeUsage(opts = {}) {
  const o = { ...DEFAULT_OPTS, root: PROJECTS_ROOT, ...opts };
  const t0 = process.hrtime.bigint();
  const files = listFilesDesc((out) => {
    (function walk(d, depth) {
      if (depth > 4) return;                           // projects/<proj>/<sid>/subagents/agent-*.jsonl 深度 3
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
      }
    })(o.root, 0);
  });
  // sessionId 解析：新版 Claude Code 把子代理链路写进 <sessionId>/subagents/agent-*.jsonl
  // （本机实测 164 个 .jsonl 里 106 个在此结构下）——子代理消耗归入父会话（行 usage = 整场对话成本）。
  const sidOf = (f) => {
    const parts = path.relative(o.root, f).split(path.sep);
    if (parts.length >= 4 && parts[2] === 'subagents') return parts[1];
    return parts[parts.length - 1].replace(/\.jsonl$/, '');
  };
  const acc = newAcc();
  for (const f of files) {
    if (acc.stats.files >= o.maxFiles) { acc.stats.partial = true; break; }
    const r = await collectClaudeFile(f, o);
    if (r.aborted) { acc.stats.partial = true; break; }
    if (r.skipped) continue;
    acc.stats.files++;
    if (r.cached) acc.stats.cachedFiles++;
    acc.stats.parseErrors += r.stats.parseErrors;
    try { acc.stats.readBytes += fs.statSync(f).size; } catch { /* 文件消失 */ }
    foldFile(acc, r, sidOf(f));
  }
  acc.stats.sessions = acc.bySession.size;
  return finishScan('claude-code', acc, t0, { inputIncludesCache: false });
}

// ---------------------------------------------------------------------------
// Codex：~/.codex/sessions/**/rollout-*.jsonl，token_count 事件
// ---------------------------------------------------------------------------

const codexFileCache = makeFileCache();

async function collectCodexFile(file, o) {
  let st; try { st = fs.statSync(file); } catch { return { skipped: true }; }
  const hit = o.refresh ? null : cachedEntry(codexFileCache, file, st);
  if (hit) return { ...hit.result, cached: true };
  let curModel = null, variant = null, requests = 0, aborted = false, lineCnt = 0, parseErrors = 0;
  const byModel = new Map(), modelDays = new Map(), days = new Map();
  let finalTotal = null;                               // 最后一条 total_token_usage（会话累计，权威）
  const deadline = Date.now() + o.softBudgetMs;
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if ((++lineCnt & 511) === 0 && Date.now() > deadline) { aborted = true; break; }
        const isTok = line.includes('"token_count"');
        if (!isTok && !line.includes('"turn_context"') && !line.includes('"thread_settings_applied"') && !line.includes('"originator"')) continue;
        if (line.length > o.maxLineBytes) continue;
        let j; try { j = JSON.parse(line); } catch { parseErrors++; continue; }
        const p = j?.payload ?? {};
        if (j?.type === 'session_meta') {
          if (typeof p.originator === 'string') variant = variantFromOriginator(p.originator);
        } else if (j?.type === 'turn_context' && typeof p.model === 'string') curModel = p.model;
        else if (j?.type === 'event_msg' && p.type === 'thread_settings_applied' && typeof p.thread_settings?.model === 'string') curModel = p.thread_settings.model;
        else if (isTok && j?.type === 'event_msg' && p.type === 'token_count') {
          const last = p.info?.last_token_usage ?? {};
          const d = {
            input: fin(last.input_tokens), output: fin(last.output_tokens),
            cacheRead: fin(last.cached_input_tokens), cacheWrite: fin(last.cache_write_input_tokens), requests: 1,
          };
          const day = dayKeyOf(Date.parse(j.timestamp) || Date.now());
          bumpDay(days, day, d);
          bumpModelDay(modelDays, curModel || '(unknown)', day, d);
          requests++;
          const tot = p.info?.total_token_usage;
          if (tot && Number.isFinite(tot.input_tokens)) finalTotal = tot;
        }
      }
    } finally { try { rl.close(); } catch { /* 已关闭 */ } }
  } catch { return { skipped: true }; }
  if (aborted) return { aborted: true };
  // 会话扁平口径取权威累计值（per-model 增量归属可能有 turn_context 之前的盲区）
  const flat = finalTotal
    ? { input: fin(finalTotal.input_tokens), output: fin(finalTotal.output_tokens), cacheRead: fin(finalTotal.cached_input_tokens), cacheWrite: fin(finalTotal.cache_write_input_tokens), requests }
    : (() => { const u = newUsage(); for (const v of days.values()) addInto(u, v); return u; })();
  // 增量桶回填 per-model 全量（供 byModel）：单模型会话整额归属（增量实测漏 ~25%）
  for (const [model, dm] of modelDays) {
    const u = newUsage();
    if ([...modelDays.keys()].length === 1) Object.assign(u, flat); else for (const v of dm.values()) addInto(u, v);
    byModel.set(model, u);
  }
  if (!byModel.size && (flat.input || flat.output)) bumpModel(byModel, '(unknown)', flat);
  const result = { flat, days, models: byModel, modelDays, variant, stats: { tokenEvents: requests, parseErrors } };
  codexFileCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, result });
  return result;
}

export async function scanCodexUsage(opts = {}) {
  const o = { ...DEFAULT_OPTS, root: CODEX_ROOT, ...opts };
  const t0 = process.hrtime.bigint();
  const files = listFilesDesc((out) => {
    (function walk(d) {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p); }
    })(o.root);
  });
  const acc = newAcc();
  for (const f of files) {
    if (acc.stats.files >= o.maxFiles) { acc.stats.partial = true; break; }
    const r = await collectCodexFile(f, o);
    if (r.aborted) { acc.stats.partial = true; break; }
    if (r.skipped) continue;
    acc.stats.files++;
    if (r.cached) acc.stats.cachedFiles++;
    acc.stats.parseErrors += r.stats.parseErrors;
    try { acc.stats.readBytes += fs.statSync(f).size; } catch { /* 文件消失 */ }
    foldFile(acc, r, threadIdOf(f));
  }
  acc.stats.sessions = acc.bySession.size;
  // Codex 日桶来自事件增量（成文近似）：Σdays 可能小于权威总量
  return finishScan('codex', acc, t0, { inputIncludesCache: true, dayApproximate: true });
}

// ---------------------------------------------------------------------------
// Kimi Code：~/.kimi-code/sessions/wd_*/session_*/agents/<id>/wire.jsonl 的 usage.record
// ---------------------------------------------------------------------------

const kimiFileCache = makeFileCache();

async function collectKimiWire(file, o) {
  let st; try { st = fs.statSync(file); } catch { return { skipped: true }; }
  const hit = o.refresh ? null : cachedEntry(kimiFileCache, file, st);
  if (hit) return { ...hit.result, cached: true };
  let variant = null, aborted = false, lineCnt = 0, parseErrors = 0;
  const byModel = new Map(), modelDays = new Map(), days = new Map();
  const flat = newUsage();
  const deadline = Date.now() + o.softBudgetMs;
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if ((++lineCnt & 511) === 0 && Date.now() > deadline) { aborted = true; break; }
        const isUsage = line.includes('"usage.record"');
        const isMeta = line.includes('"clientMetadata"');        // turn.prompt 的形态标记（与 parseKimiSession 同源）
        if (!isUsage && !isMeta) continue;
        if (line.length > o.maxLineBytes) continue;
        // 形态：clientMetadata 含 composer = 桌面版（原始行子串判定，免整行 JSON.parse）
        if (isMeta) { variant = line.includes('composer') ? 'desktop' : 'cli'; if (!isUsage) continue; }
        let j; try { j = JSON.parse(line); } catch { parseErrors++; continue; }
        if (j?.type !== 'usage.record' || !j.usage) continue;
        const d = {
          input: fin(j.usage.inputOther), output: fin(j.usage.output),
          cacheRead: fin(j.usage.inputCacheRead), cacheWrite: fin(j.usage.inputCacheCreation), requests: 1,
        };
        if (!d.input && !d.output && !d.cacheRead && !d.cacheWrite) continue;
        const model = typeof j.model === 'string' && j.model ? j.model.split('/').pop() : '(unknown)';
        const day = dayKeyOf(Number.isFinite(j.time) ? j.time : Date.now());
        addInto(flat, d);
        bumpDay(days, day, d);
        bumpModel(byModel, model, d);
        bumpModelDay(modelDays, model, day, d);
      }
    } finally { try { rl.close(); } catch { /* 已关闭 */ } }
  } catch { return { skipped: true }; }
  if (aborted) return { aborted: true };
  const result = { flat, days, models: byModel, modelDays, variant, stats: { parseErrors } };
  kimiFileCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, result });
  return result;
}

export async function scanKimiUsage(opts = {}) {
  const o = { ...DEFAULT_OPTS, root: KIMI_ROOT, ...opts };
  const t0 = process.hrtime.bigint();
  const sessions = [];                                 // {sid, wires:[...]}
  try {
    for (const wd of fs.readdirSync(o.root, { withFileTypes: true })) {
      if (!wd.isDirectory() || wd.name.startsWith('.')) continue;
      const wdPath = path.join(o.root, wd.name);
      let ses; try { ses = fs.readdirSync(wdPath, { withFileTypes: true }); } catch { continue; }
      for (const s of ses) {
        if (!s.isDirectory() || !s.name.startsWith('session_')) continue;
        const sessionDir = path.join(wdPath, s.name);
        let sid = null;
        try { const j = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8')); if (typeof j.id === 'string' && j.id) sid = j.id; } catch { /* 无 state.json */ }
        const wires = [];
        const agentsDir = path.join(sessionDir, 'agents');
        let ags; try { ags = fs.readdirSync(agentsDir, { withFileTypes: true }); } catch { ags = []; }
        for (const a of ags) if (a.isDirectory()) { const w = path.join(agentsDir, a.name, 'wire.jsonl'); try { if (fs.statSync(w).size > 0) wires.push(w); } catch { /* 无 wire */ } }
        sessions.push({ sid: sid ?? s.name, sessionDir, wires });
      }
    }
  } catch { /* root 不存在：未安装 */ }
  const acc = newAcc();
  let wireCount = 0;
  for (const s of sessions) {
    let partialSession = false;
    const tmp = { flat: newUsage(), days: new Map(), models: new Map(), modelDays: new Map(), variant: null, stats: { parseErrors: 0 } };
    for (const w of s.wires) {
      if (wireCount >= o.maxFiles) { acc.stats.partial = true; partialSession = true; break; }
      const r = await collectKimiWire(w, o);
      if (r.aborted) { acc.stats.partial = true; partialSession = true; break; }
      if (r.skipped) continue;
      wireCount++; acc.stats.files++;
      if (r.cached) acc.stats.cachedFiles++;
      acc.stats.parseErrors += r.stats.parseErrors;
      try { acc.stats.readBytes += fs.statSync(w).size; } catch { /* 文件消失 */ }
      mergeInto(tmp, r);
      if (r.variant) tmp.variant = r.variant;          // 多 wire（子代理）时以 main 的判定为准可被覆盖，取后见
    }
    if (partialSession) break;                         // 半扫会话不落账（下轮重来）
    if (!tmp.flat.requests) continue;
    foldFile(acc, tmp, s.sid);
  }
  acc.stats.sessions = acc.bySession.size;
  return finishScan('kimi-code', acc, t0, { inputIncludesCache: false });
}

// ---------------------------------------------------------------------------
// ZCode：sqlite message 表 tokens（行级拉取，JS 折叠三桶）
// ---------------------------------------------------------------------------

export function scanZcodeUsage(opts = {}) {
  const o = { ...DEFAULT_OPTS, dbPath: ZCODE_DB, ...opts };
  const t0 = process.hrtime.bigint();
  const acc = newAcc();
  acc.stats.files = 1;
  const db = openZcodeDb(o.dbPath);
  if (!db) return finishScan('zcode', acc, t0, { inputIncludesCache: true, degraded: true, error: 'db-unavailable' });
  try {
    const rows = db.prepare(`
      SELECT m.session_id AS sid,
             COALESCE(json_extract(m.data,'$.modelId'), '(unknown)') AS model,
             COALESCE(CAST(json_extract(m.data,'$.tokens.input') AS INTEGER), 0) AS input,
             COALESCE(CAST(json_extract(m.data,'$.tokens.output') AS INTEGER), 0) AS output,
             COALESCE(CAST(json_extract(m.data,'$.tokens.cache.read') AS INTEGER), 0) AS cacheRead,
             COALESCE(CAST(json_extract(m.data,'$.tokens.cache.write') AS INTEGER), 0) AS cacheWrite,
             m.time_created AS tc
      FROM message m
      WHERE json_extract(m.data,'$.role')='assistant'
        AND json_extract(m.data,'$.tokens.input') IS NOT NULL
    `).all();
    for (const r of rows) {
      const d = { input: fin(r.input), output: fin(r.output), cacheRead: fin(r.cacheRead), cacheWrite: fin(r.cacheWrite), requests: 1 };
      if (!d.input && !d.output && !d.cacheRead && !d.cacheWrite) continue;
      const day = dayKeyOf(r.tc);
      // 行级结果组装成统一「文件形状」后折叠（d 只读共享，四处引用安全）
      foldFile(acc, {
        flat: d,
        days: new Map([[day, d]]),
        models: new Map([[r.model, d]]),
        modelDays: new Map([[r.model, new Map([[day, d]])]]),
        variant: null,
      }, r.sid);
    }
    acc.stats.sessions = acc.bySession.size;
  } catch (e) {
    return finishScan('zcode', acc, t0, { inputIncludesCache: true, degraded: true, error: 'sqlite:' + String(e.message || e).slice(0, 120) });
  } finally { try { db.close(); } catch { /* ignore */ } }
  return finishScan('zcode', acc, t0, { inputIncludesCache: true });
}

// ---------------------------------------------------------------------------
// 折叠工具（scan 级累加器；单文件/单会话结果统一形状）
// ---------------------------------------------------------------------------

/** scan 级累加器：bySession（全量扁平）/ byModel / byDay / byModelDay / byVariantDay（时间窗用）+ byVariantFlat（全量，形态=文件级权威值）。 */
function newAcc() {
  return {
    bySession: new Map(), byModel: new Map(), byDay: new Map(), byModelDay: new Map(), byVariantDay: new Map(), byVariantFlat: new Map(),
    totals: newUsage(),
    stats: { files: 0, cachedFiles: 0, sessions: 0, readBytes: 0, parseErrors: 0, partial: false, identityMismatched: 0 },
  };
}
/** 把一个「文件结果」（统一形状 {flat, days, models, modelDays, variant}）折叠进 scan 累加器。 */
function foldFile(acc, r, sid) {
  const row = acc.bySession.get(sid) ?? newUsage();
  addInto(row, r.flat);
  acc.bySession.set(sid, row);
  addInto(acc.totals, r.flat);
  for (const [day, u] of r.days) bumpDay(acc.byDay, day, u);
  for (const [model, u] of r.models) bumpModel(acc.byModel, model, u);
  for (const [model, dm] of r.modelDays) {
    let tgt = acc.byModelDay.get(model);
    if (!tgt) { tgt = new Map(); acc.byModelDay.set(model, tgt); }
    for (const [day, u] of dm) bumpDay(tgt, day, u);
  }
  const v = r.variant ?? null;
  // 形态是文件级属性：全量口径直接归权威 flat（Codex 的日桶增量会低估，全量必须精确）；
  // 时间窗口径仍走 byVariantDay（Codex 近似，成文）
  bumpModel(acc.byVariantFlat, v, r.flat);
  let vm = acc.byVariantDay.get(v);
  if (!vm) { vm = new Map(); acc.byVariantDay.set(v, vm); }
  for (const [day, u] of r.days) bumpDay(vm, day, u);
}
/** Kimi 会话内多 wire 合并为一个「文件结果」（形态取最后非空判定）。 */
function mergeInto(tmp, r) {
  addInto(tmp.flat, r.flat);
  for (const [day, u] of r.days) bumpDay(tmp.days, day, u);
  for (const [model, u] of r.models) bumpModel(tmp.models, model, u);
  for (const [model, dm] of r.modelDays) {
    let tgt = tmp.modelDays.get(model);
    if (!tgt) { tgt = new Map(); tmp.modelDays.set(model, tgt); }
    for (const [day, u] of dm) bumpDay(tgt, day, u);
  }
}
function finishScan(source, acc, t0, extra = {}) {
  const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    source, generatedAt: Date.now(), elapsedMs: Number(tookMs.toFixed(2)),
    bySession: acc.bySession, byModel: acc.byModel, byDay: acc.byDay, byModelDay: acc.byModelDay, byVariantDay: acc.byVariantDay, byVariantFlat: acc.byVariantFlat,
    totals: acc.totals, stats: acc.stats, ...extra,
  };
}

// ---------------------------------------------------------------------------
// 汇总 / 序列化（快照 usage 块与 /api/usage 共用）
// ---------------------------------------------------------------------------

/** 单源在某时间窗内的视图（dayPred(dayKey)→bool）。 */
function scanRangeView(sc, dayPred) {
  const totals = newUsage();
  const byModel = new Map();
  const byVariant = new Map();
  for (const [day, u] of sc.byDay) if (dayPred(day)) addInto(totals, u);
  for (const [model, dm] of sc.byModelDay) {
    const u = newUsage();
    for (const [day, d] of dm) if (dayPred(day)) addInto(u, d);
    if (u.requests || u.input || u.output) byModel.set(model, u);
  }
  for (const [v, dm] of sc.byVariantDay) {
    const u = newUsage();
    for (const [day, d] of dm) if (dayPred(day)) addInto(u, d);
    if (u.requests || u.input || u.output) byVariant.set(v, u);
  }
  return { totals, byModel, byVariant };
}

/** 四源扫描 → 跨源总览：bySource 明细 + byModel 跨源合并 + 当日/7日/30日时间窗。 */
export function usageOverview(scansByKey, nowMs = Date.now()) {
  const todayKey = dayKeyOf(nowMs);
  const preds = {
    today: (day) => day === todayKey,
    d7: (day) => dayStartMs(day) >= nowMs - 7 * 86400_000,
    d30: (day) => dayStartMs(day) >= nowMs - 30 * 86400_000,
  };
  const decModel = (sc, map) => [...map.entries()].map(([model, u]) => ({ model, ...decorate(u, sc.inputIncludesCache) })).sort(byTotalDesc);

  function buildView(scans, dayPred) {
    const bySource = {};
    const merged = new Map();
    const totals = newUsage();
    let mergedFresh = 0;
    for (const [, sc] of Object.entries(scans)) {
      if (!sc || sc.degraded) continue;
      const view = dayPred ? scanRangeView(sc, dayPred) : { totals: sc.totals, byModel: sc.byModel, byVariant: variantTotalsOf(sc) };
      bySource[sc.source] = {
        totals: decorate(view.totals, sc.inputIncludesCache),
        partial: !!sc.stats?.partial,
        elapsedMs: sc.elapsedMs ?? null,
        inputIncludesCache: !!sc.inputIncludesCache,
        models: decModel(sc, view.byModel),
        variants: [...view.byVariant.entries()].map(([v, u]) => ({ variant: v, totals: decorate(u, sc.inputIncludesCache) })),
      };
      for (const [model, u] of view.byModel) {
        let m = merged.get(model);
        if (!m) { m = { ...newUsage(), sources: [], freshInput: 0 }; merged.set(model, m); }
        addInto(m, u);
        m.freshInput += freshInputOf(u, sc.inputIncludesCache);
        if (!m.sources.includes(sc.source)) m.sources.push(sc.source);
      }
      addInto(totals, view.totals);
      mergedFresh += freshInputOf(view.totals, sc.inputIncludesCache);
    }
    const denom = mergedFresh + totals.cacheRead;
    return {
      totals: { ...totals, freshInput: mergedFresh, hitRate: denom > 0 ? totals.cacheRead / denom : null },
      bySource,
      byModel: [...merged.entries()].map(([model, m]) => {
        const { sources, freshInput, ...u } = m;
        const d = freshInput + u.cacheRead;
        return { model, sources, ...u, hitRate: d > 0 ? u.cacheRead / d : null };
      }).sort(byTotalDesc),
    };
  }
  const all = buildView(scansByKey, null);
  return {
    ...all,
    ranges: {
      today: buildView(scansByKey, preds.today),
      d7: buildView(scansByKey, preds.d7),
      d30: buildView(scansByKey, preds.d30),
    },
  };
}

/** 全量视图用：形态总量（优先 byVariantFlat——文件级权威值；兜底 byVariantDay 求和）。 */
function variantTotalsOf(sc) {
  if (sc.byVariantFlat && sc.byVariantFlat.size) return sc.byVariantFlat;
  const out = new Map();
  for (const [v, dm] of sc.byVariantDay) {
    const u = newUsage();
    for (const d of dm.values()) addInto(u, d);
    out.set(v, u);
  }
  return out;
}

const byTotalDesc = (a, b) => (b.input + b.output + b.cacheRead) - (a.input + a.output + a.cacheRead);

/** 单源扫描 → JSON 友好结构（/api/usage 与 CLI 用；快照只取轻量 overview）。 */
export function serializeUsageScan(sc) {
  if (!sc) return null;
  const bySession = {};
  for (const [sid, r] of sc.bySession) bySession[sid] = { ...r };
  const byDay = {};
  for (const [day, u] of sc.byDay) byDay[day] = { ...u };
  return {
    source: sc.source, generatedAt: sc.generatedAt, elapsedMs: sc.elapsedMs,
    totals: { ...sc.totals }, inputIncludesCache: !!sc.inputIncludesCache, dayApproximate: !!sc.dayApproximate,
    byModel: [...sc.byModel.entries()].map(([model, u]) => ({ model, ...u })).sort(byTotalDesc),
    byVariant: [...variantTotalsOf(sc).entries()].map(([variant, u]) => ({ variant, totals: { ...u } })),
    byDay,
    bySessionCount: sc.bySession.size, bySession,
    stats: sc.stats, degraded: !!sc.degraded, error: sc.error ?? null,
  };
}

/** 供 framed 一次性跑五源（并行；单源失败降级不拖垮整体）。 */
export async function scanAllUsage(opts = {}) {
  const safe = (p) => p.catch((e) => ({ degraded: true, error: String(e?.message || e).slice(0, 120), bySession: new Map(), byModel: new Map(), byDay: new Map(), byModelDay: new Map(), byVariantDay: new Map(), byVariantFlat: new Map(), totals: newUsage(), stats: { partial: false }, source: '?' }));
  const [dsh, cc, cx, km, zc] = await Promise.all([
    safe(scanDshUsage(opts.dsh ?? {})),
    safe(scanClaudeUsage(opts.claude ?? {})),
    safe(scanCodexUsage(opts.codex ?? {})),
    safe(scanKimiUsage(opts.kimi ?? {})),
    Promise.resolve(scanZcodeUsage(opts.zcode ?? {})),
  ]);
  return { dsh, cc, cx, km, zc, overview: usageOverview({ dsh, cc, cx, km, zc }, Date.now()) };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function fmtTok(n) {
  n = Number(n) || 0;
  return n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n);
}
function fmtHit(r) { return r == null ? '—' : (r * 100).toFixed(1) + '%'; }

async function main(argv) {
  const scans = await scanAllUsage(argv.includes('--refresh') ? {
    dsh: { refresh: true }, claude: { refresh: true }, codex: { refresh: true }, kimi: { refresh: true }, zcode: {},
  } : {});
  if (argv.includes('--json')) {
    console.log(JSON.stringify({
      generatedAt: Date.now(),
      overview: scans.overview,
      detail: { dsh: serializeUsageScan(scans.dsh), cc: serializeUsageScan(scans.cc), cx: serializeUsageScan(scans.cx), km: serializeUsageScan(scans.km), zc: serializeUsageScan(scans.zc) },
    }, null, 2));
    return;
  }
  const ov = scans.overview;
  const t = ov.totals;
  console.log('Token 用量（五源全量 · ' + new Date().toLocaleString('zh-CN') + '）');
  console.log('  合计  in ' + fmtTok(t.input) + ' · out ' + fmtTok(t.output) + ' · cacheRead ' + fmtTok(t.cacheRead) + ' · 命中率 ' + fmtHit(t.hitRate) + ' · 请求 ' + t.requests);
  for (const [k, label] of Object.entries({ today: '当日', d7: '7日内', d30: '30日内' })) {
    const r = ov.ranges[k].totals;
    console.log('  ' + label.padEnd(4) + ' in ' + fmtTok(r.input) + ' · out ' + fmtTok(r.output) + ' · 命中率 ' + fmtHit(r.hitRate) + ' · 请求 ' + r.requests);
  }
  const V_LABEL = { cli: 'CLI', desktop: '桌面', ide: 'IDE' };
  for (const [key, sc] of Object.entries({ dsh: scans.dsh, cc: scans.cc, cx: scans.cx, km: scans.km, zc: scans.zc })) {
    if (!sc || sc.degraded) { console.log('  [' + key + '] 降级：' + (sc?.error ?? '?')); continue; }
    const s = sc.stats ?? {};
    const hit = (() => { const f = sc.inputIncludesCache ? Math.max(0, sc.totals.input - sc.totals.cacheRead) : sc.totals.input; const d = f + sc.totals.cacheRead; return d > 0 ? sc.totals.cacheRead / d : null; })();
    console.log('  [' + key + '] ' + sc.source + '：in ' + fmtTok(sc.totals.input) + ' · out ' + fmtTok(sc.totals.output) + ' · 命中率 ' + fmtHit(hit) + ' · 会话 ' + s.sessions + ' · 文件 ' + s.files + (s.cachedFiles ? '（缓存命中 ' + s.cachedFiles + '）' : '') + (s.partial ? ' · ⚠ 本轮部分扫描（下轮续）' : '') + ' · ' + (sc.elapsedMs ?? 0).toFixed(0) + 'ms');
    for (const v of variantTotalsOf(sc).entries()) {
      if (v[0] == null) continue;
      console.log('      形态 ' + (V_LABEL[v[0]] ?? v[0]).padEnd(4) + ' in ' + String(fmtTok(v[1].input)).padStart(8) + ' · out ' + String(fmtTok(v[1].output)).padStart(7) + ' · 请求 ' + String(v[1].requests).padStart(6));
    }
    for (const m of [...sc.byModel.entries()].sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output)).slice(0, 8)) {
      console.log('      ' + String(m[0]).padEnd(28) + ' in ' + String(fmtTok(m[1].input)).padStart(8) + ' · out ' + String(fmtTok(m[1].output)).padStart(7) + ' · req ' + String(m[1].requests).padStart(6));
    }
  }
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) await main(process.argv.slice(2));
