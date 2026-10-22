#!/usr/bin/env node
/**
 * adapters/usage-collect.mjs — Token 用量采集（八源，独立于目录扫描的慢通道）
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
 *                官方投影对账：session_projcache 的 tokenUsage.totals（uncachedInput+cacheRead+
 *                output+cacheWrite）与本模块逐 token 一致（2026-10-09 全量 40 会话，39 精确；
 *                余 1 为活跃会话在途：采集领先官方投影 1 步）。
 *   Claude Code  assistant 行 message.usage：同一条消息（message.id 相同）在流式分块中
 *                出现多行快照 → 按 message.id 去重、**后写覆盖**（最终快照）；input_tokens
 *                不含 cache。sidechain 行与 <sid>/subagents/agent-*.jsonl 都计入（归入父会话）。
 *   Codex        event_msg.token_count：info.total_token_usage 是**会话累计值**（权威）→ 逐事件
 *                取差分归日（Δ累计，负值截 0）：Σ日桶 == 源总量 == Σ文件增量，由构造保证。
 *                两个反例必须按累计值处理（2026-10-09 用户报障「图表 459.4M vs 日历 397.2M」）：
 *                ① 首条事件的累计可能继承父会话前缀（子代理/fork rollout 的 C0 = 父会话当时累计，
 *                   本机 Σ 继承前缀 9,350 万 token ≈ 扁平口径虚高额）→ 首条只认自身 last_token_usage
 *                   （新会话实测 C0 == L0；forked 实测 L0 = 0）；
 *                ② last_token_usage 会被重复上报（同一累计值连出多条事件，本机 67+ 例）→ 逐条求和
 *                   比累计差分虚高 8.8%（Σlast/ΣΔC = 1.088）。
 *                input 含 cache。
 *   Kimi Code    usage.record：每次请求一条，直接累加；inputOther→input、inputCacheRead→
 *                cacheRead、inputCacheCreation→cacheWrite；含全部 agents/<id>/ 子代理流。
 *   ZCode        message 表 data JSON 的 tokens（与 part.step-finish 双路实测一致）：
 *                {total,input,output,reasoning,cache:{read,write}}；**input 含 cacheRead**。
 *                判定证据（2026-10-07 二次复核，用户质疑 49% 命中率后用两实验裁决）：
 *                ① 官方账本 raw_usage_json（provider 原始返回）：{inputTokens, totalTokens
 *                = inputTokens+outputTokens, cacheReadTokens} —— inputTokens 为全量
 *                prompt（OpenAI 式含 cache），fresh = input − cacheRead；
 *                ② 同会话连续请求递推：cr[t+1] ≈ in[t]（累计误差 1.7 万）vs fresh 说的
 *                cr[t+1] ≈ in[t]+cr[t]（误差 35 万，20 倍）——input 就是全上下文；
 *                ③ 全日 Σ(in−cr)/请求 ≈ 5k/次 = 每请求新增内容量级（fresh 说会推出
 *                155k/次新内容，上下文无法持续，不可能）。
 *                行级 SQL（session_id × modelId × time_created）JS 折叠；subagent_child 计入。
 *   OpenCode     part 表 step-finish 的 tokens（每步一行）：{input,output,reasoning,
 *                cache:{read,write}}，实测 total = in+out+reasoning+cache 递推成立——
 *                **input 不含 cacheRead**（Anthropic 式，2026-10-22 本机实测）。
 *                model 取同 message 行 data.model 的 providerID/modelID（'provider/model' 键）；
 *                行不可变 → 水位 + seen-LRU（无 zcode 的 delta 递推）；CLI/桌面共用库无形态标记。
 *   Qoder        无 token 真值（chat_session_context_usage.tokenCountsAvailable=false，
 *                客户端不落盘计数）——如实降级不虚估。
 *   Cursor       per-request token 在云端（客户端不落盘）——如实降级不虚估。
 *
 * 缓存命中率（跨源统一折算）：fresh = 含cache语义 ? input - cacheRead : input；
 *   hitRate = cacheRead / (fresh + cacheRead)。inputIncludesCache 按源标注：
 *   DSH/Claude/Kimi/OpenCode/Qoder = false（Anthropic 式 input 不含 cache），Codex/ZCode = true。
 *
 * 用法：
 *   node adapters/usage-collect.mjs [--json|--refresh]
 *   framed.mjs 内 refreshUsage()：60s 轮询 → snapshot().usage + /api/usage
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PROJECTS_ROOT } from './claude-code-adapter.mjs';
import { SESSIONS_ROOT as CODEX_ROOT, threadIdOf } from './codex-adapter.mjs';
import { SESSIONS_ROOT as KIMI_ROOT } from './kimi-code-adapter.mjs';
import { openZcodeDb, ZCODE_DB } from './zcode-adapter.mjs';
import { openOpencodeDb, OPENCODE_DB } from './opencode-adapter.mjs';
import { CURSOR_GLOBAL_DB } from './cursor-adapter.mjs';
import { SESSIONS_ROOT as DSH_ROOT, pickLogFile } from './session-catalog.mjs';

export const DEFAULT_OPTS = Object.freeze({
  maxFiles: 800,                 // 单源文件数上限（本机 Claude 164 / Codex 34 / Kimi 12 / DSH 37）
  maxLineBytes: 512 * 1024,      // 超大行跳过，并在日历标注部分数据
  softBudgetMs: 15_000,          // 单文件软时限：到点即停（partial=true），该文件不写缓存、下轮整读
  refresh: false,                // true=忽略文件级缓存强制重读（诊断用）
});

/** 强制全量重扫的五源参数（framed refreshUsage(force) 与 CLI --refresh 共用）。
 *  P0-2（2026-10-19 评审）：此前 CLI --refresh 只给四个文件源传了 refresh、zcode 是 {}——
 *  「?refresh=1 强制重扫」在服务端与 ZCode 上实际不存在；统一从这里取参，zcode 的 refresh
 *  语义 = 清水位/LRU 状态后全表重建（增量实现后生效）。 */
export const FORCE_SCAN_OPTS = Object.freeze({
  dsh: { refresh: true }, claude: { refresh: true }, codex: { refresh: true }, kimi: { refresh: true }, zcode: { refresh: true }, opencode: { refresh: true },   // cursor/qoder 无本地真值，强刷无意义
});

// ---------- 公共累计器 ----------
export function newUsage() { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }; }
const fin = (v) => (Number.isFinite(v) ? v : 0);
function addInto(acc, d) {
  acc.input += fin(d.input); acc.output += fin(d.output);
  acc.cacheRead += fin(d.cacheRead); acc.cacheWrite += fin(d.cacheWrite);
  // requests：显式字段权威（0 合法——zcode 增量 delta 行已计过 requests，不能因有 token 差量再 +1）；
  // 字段缺席才按「有 token 即 1 次」回退。
  acc.requests += Number.isFinite(d.requests) ? fin(d.requests) : ((fin(d.input) || fin(d.output)) ? 1 : 0);
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
function newCalls() { return { days: new Map(), seen: new Set(), undated: 0 }; }
/** MCP 工具名判定（recordTool 与 zcode 增量 part 计数共用）：仅显式 MCP 名/命名空间计入，结果与发现事件不计。 */
const MCP_NAME_RE = /(^|[.])mcp(?:__|[.:/-])/i;
function addCallDays(target, days) {
  for (const [day, counts] of days || []) {
    const row = target.get(day) ?? { toolCalls: 0, mcpCalls: 0 };
    row.toolCalls += counts.toolCalls;
    row.mcpCalls += counts.mcpCalls;
    target.set(day, row);
  }
}
function recordTool(calls, id, name, timestamp) {
  if (id != null && id !== '') {
    if (calls.seen.has(id)) return;
    calls.seen.add(id);
  }
  const ts = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(ts) || !Number.isFinite(new Date(ts).getTime())) { calls.undated++; return; }
  const day = dayKeyOf(ts);
  const row = calls.days.get(day) ?? { toolCalls: 0, mcpCalls: 0 };
  row.toolCalls++;
  if (MCP_NAME_RE.test(String(name ?? ''))) row.mcpCalls++;
  calls.days.set(day, row);
}
/** fresh input / 命中率折算（含cache语义的源要先减掉 cacheRead）。 */
function freshInputOf(u, includesCache) { return includesCache ? Math.max(0, fin(u.input) - fin(u.cacheRead)) : fin(u.input); }
function decorate(u, includesCache) {
  const fresh = freshInputOf(u, includesCache);
  const cacheRead = fin(u.cacheRead), cacheWrite = fin(u.cacheWrite), output = fin(u.output);
  const denom = fresh + cacheRead;
  // 展示口径（2026-10-09 用户报障「本对话十几兆 vs 面板 789,088」后统一）：
  //   promptTokens = 全量 prompt（含缓存读）= 各厂商 UI 里的 input（Anthropic 式 input 不含 cache，OpenAI 式含）；
  //   totalTokens  = promptTokens + cacheWrite + output = 该源自带计数器显示的总量。
  // 于是五源同列可比：DSH/Claude/Kimi 的 prompt = input + cacheRead，Codex/ZCode 的 prompt = input（已含 cache）。
  const promptTokens = fresh + cacheRead;
  return { ...u, freshInput: fresh, promptTokens, totalTokens: promptTokens + cacheWrite + output, hitRate: denom > 0 ? cacheRead / denom : null };
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

/** 让出事件循环（macrotask 级）：扫描分块处理时保证 SSE tick/推送不被长同步块停顿（第 1 步）。 */
const yieldNow = () => new Promise((r) => setImmediate(r));

/**
 * 字节精确的按行读取（codex/kimi 尾读共用，第 4b 步）：从 startByte 起按 0x0A 切行。
 * 返回 { aborted, lastLineEnd }：lastLineEnd = 最后一个完整行（含 \n）之后的**绝对字节偏移**——
 * 这是尾读续读点；不能用 readline 的字符偏移（多字节 UTF-8 下字符数 ≠ 字节数）。
 * deadline 到点 → aborted=true 停在中途（调用方不写缓存，下轮整读/续读重来）。
 */
async function readLinesByte(file, { startByte = 0, deadline = Infinity }, onLine) {
  const stream = fs.createReadStream(file, { start: startByte });
  let carry = Buffer.alloc(0), carryStart = startByte, lineCnt = 0, chunkCnt = 0, aborted = false;
  try {
    for await (const chunk of stream) {
      carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let idx;
      while ((idx = carry.indexOf(0x0A)) >= 0) {
        const line = carry.subarray(0, idx).toString('utf8');
        carry = carry.subarray(idx + 1);
        carryStart += idx + 1;
        onLine(line);
        if ((++lineCnt & 511) === 0 && Date.now() > deadline) { aborted = true; break; }
      }
      if (aborted) break;
      if ((++chunkCnt & 15) === 0) await yieldNow();
    }
  } catch { return { aborted: true, lastLineEnd: startByte }; }   // 读失败按中止处理（不写缓存）
  finally { try { stream.destroy(); } catch { /* ignore */ } }
  return { aborted, lastLineEnd: carryStart };
}

/** 尾读锚点（第 4b 步轮转防护）：offset 前 ≤64 字节的 sha256。同路径被替换成更大文件时
 *  （size < offset 检测不到），锚点不符 → 整读回退。offset=0 时锚为空串。 */
function anchorAt(file, offset) {
  try {
    if (offset <= 0) return '';
    const len = Math.min(64, offset);
    const buf = Buffer.alloc(len);
    const fh = fs.openSync(file, 'r');
    try { const n = fs.readSync(fh, buf, 0, len, offset - len); return crypto.createHash('sha256').update(buf.subarray(0, n)).digest('hex'); }
    finally { try { fs.closeSync(fh); } catch { /* ignore */ } }
  } catch { return null; }   // 读不了 → 让调用方整读回退
}

/** 列出 buf 中全部 zstd 帧起始偏移（帧自包含；魔数扫描与旧 dshReadText 同款口径）。 */
function zstdFrameOffsets(buf) {
  const offsets = [];
  let i = buf.indexOf(ZSTD_MAGIC, 0);
  while (i >= 0) { offsets.push(i); i = buf.indexOf(ZSTD_MAGIC, i + 1); }
  return offsets;
}

async function collectDshFile(file, o) {
  let st; try { st = fs.statSync(file); } catch { return { skipped: true }; }
  const hit = o.refresh ? null : cachedEntry(dshFileCache, file, st);
  if (hit) return { ...hit.result, cached: true, fileSize: st.size, readBytes: 0 };
  // 尾读路径（第 4a 步）：缓存失效但存在尾部状态，且文件只增长、inode 未变 → 从上个
  // 「解码成功且以 \n 结尾」的帧边界续读；锚点/帧校验失败一律整读回退（保守）。
  const prev = dshFileCache.get(file);
  if (!o.refresh && prev && prev.tail && st.size > prev.size
    && (st.ino === undefined || prev.ino === undefined || st.ino === prev.ino)) {
    const r = await dshTailResume(file, st, prev, o);
    if (r) return { ...r.result, fileSize: st.size, readBytes: r.readBytes, resumed: true };
  }
  let buf; try { buf = fs.readFileSync(file); } catch { return { skipped: true }; }
  const byModel = new Map(), modelDays = new Map(), days = new Map();
  const flat = newUsage(), calls = newCalls();
  let curModel = null, sid = null, parseErrors = 0, skippedLines = 0, usageLines = 0, totalTokensSum = 0;
  // 帧感知逐帧解析（第 1 步让出 + 第 4a 步尾读同构）：帧自包含；实测（17,852 帧）完整帧都以
  // \n 结尾、行不跨帧——末帧不以 \n 结尾 = 写到一半，丢弃；该边界即尾读续读点。
  // 明文文件保持旧行为（整文本 split，尾行即使无 \n 也解析；无尾读状态）。
  let lineCnt = 0;
  const handleLine = (raw) => {
    const t = raw.trim();
    if (!t) return;
    if (!t.includes('"usage"') && !t.includes('"request/header"') && !t.includes('"session"') && !t.includes('"tool/call"')) return;
    if (t.length > o.maxLineBytes) { skippedLines++; return; }
    let j; try { j = JSON.parse(t); } catch { parseErrors++; return; }
    if (j?.type === 'session' && sid === null) sid = typeof j.id === 'string' ? j.id : null;
    else if (j?.type === 'request/header') {
      const m = j.data?.header?.config?.model;
      if (typeof m === 'string' && m) curModel = m;
    } else if (j?.type === 'tool/call') {
      recordTool(calls, j.data?.callId ?? j.seq, j.data?.name ?? j.data?.toolName ?? j.data?.tool?.name, j.time);
    } else if (j?.type === 'assistant/message') {
      const u = j.data?.usage;
      if (!u || (!Number.isFinite(u.inputTokens) && !Number.isFinite(u.outputTokens))) return;
      usageLines++;
      const d = { input: fin(u.inputTokens), output: fin(u.outputTokens), cacheRead: fin(u.cacheReadTokens), cacheWrite: fin(u.cacheWriteTokens), requests: 1 };
      const day = dayKeyOf(Number.isFinite(j.time) ? j.time : Date.now());
      addInto(flat, d);
      bumpDay(days, day, d);
      bumpModel(byModel, curModel || '(unknown)', d);
      bumpModelDay(modelDays, curModel || '(unknown)', day, d);
      totalTokensSum += fin(u.totalTokens);
    }
  };
  let tail = null;
  if (!buf.subarray(0, 4).equals(ZSTD_MAGIC)) {
    for (const line of buf.toString('utf8').split('\n')) {
      handleLine(line);
      if ((++lineCnt & 511) === 0) await yieldNow();
    }
  } else {
    const offsets = zstdFrameOffsets(buf);
    let completeEnd = 0;                    // 最后一个「解码成功且非空且以 \n 结尾」的帧的结束偏移（绝对）
    for (let k = 0; k < offsets.length; k++) {
      const isLast = k + 1 === offsets.length;
      const end = isLast ? buf.length : offsets[k + 1];
      let text; try { text = zlib.zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8'); }
      catch { break; /* 末帧半写/坏帧：completeEnd 停在其前 */ }
      const lines = text.split('\n');
      const trailing = lines.pop() ?? '';
      // 末帧完整性口径与尾读一致（截断帧可解出 "" 或以 \n 结尾的半段，PERF-2 同款坑）：非空且以 \n 收尾才推进。
      if (isLast && (trailing !== '' || text.length === 0)) break;
      if (!isLast && trailing !== '') break;            // 中间帧不以 \n 结尾：非预期（行跨帧），停在其前
      for (const line of lines) {
        handleLine(line);
        if ((++lineCnt & 511) === 0) await yieldNow(); // 行粒度让出：512 行 ≈ 数 ms 同步块
      }
      completeEnd = end;
      if ((k & 31) === 31) await yieldNow();           // 帧粒度让出：单帧解压同步块典型 <5ms，32 帧一挡
    }
    tail = { nextFrameOffset: completeEnd, sid, curModel, seenCallIds: [...calls.seen], undatedCalls: calls.undated };
  }
  const result = {
    flat, days, callDays: calls.days, models: byModel, modelDays, variant: null, sid,
    stats: { usageLines, parseErrors, skippedLines, undatedCalls: calls.undated, totalTokensSum, componentsSum: flat.input + flat.output + flat.cacheRead + flat.cacheWrite },
  };
  dshFileCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, ...(tail ? { tail } : {}), result });
  // readBytes/fileSize 只挂在返回值上（不进缓存条目）：readBytes = 本轮实际读取字节（P0-1）
  return { ...result, fileSize: st.size, readBytes: buf.length };
}

/** DSH 尾读续解析：从 prev.tail.nextFrameOffset 读增量段，逐帧解压续账。
 *  返回 {result, readBytes} 或 null（锚点/帧校验失败 → 调用方整读回退）。 */
async function dshTailResume(file, st, prev, o) {
  const off = prev.tail.nextFrameOffset;
  let buf;
  let fh;
  try {
    const len = st.size - off;
    if (len < 4) return null;
    fh = fs.openSync(file, 'r');
    buf = Buffer.alloc(len);
    const n = fs.readSync(fh, buf, 0, len, off);
    if (n !== len) return null;                                   // 读取期间被截断：整读回退
    if (!buf.subarray(0, 4).equals(ZSTD_MAGIC)) return null;      // 偏移处必须仍是帧魔数（同路径替换/伪偏移防护）
  } catch { return null; } finally { if (fh !== undefined) { try { fs.closeSync(fh); } catch { /* ignore */ } } }
  // 克隆累积器与解析状态（中途失败不得污染缓存条目）
  const acc = cloneDshResult(prev.result);
  const calls = { days: acc.callDays, seen: new Set(prev.tail.seenCallIds || []), undated: prev.tail.undatedCalls || 0 };
  const state = { sid: prev.tail.sid ?? null, curModel: prev.tail.curModel ?? null };
  let lineCnt = 0;
  const handleLine = (raw) => { /* 与全量路径同款行处理，但写回克隆累积器 */ 
    const t = raw.trim();
    if (!t) return;
    if (!t.includes('"usage"') && !t.includes('"request/header"') && !t.includes('"session"') && !t.includes('"tool/call"')) return;
    if (t.length > o.maxLineBytes) { acc.stats.skippedLines++; return; }
    let j; try { j = JSON.parse(t); } catch { acc.stats.parseErrors++; return; }
    if (j?.type === 'session' && state.sid === null) state.sid = typeof j.id === 'string' ? j.id : null;
    else if (j?.type === 'request/header') {
      const m = j.data?.header?.config?.model;
      if (typeof m === 'string' && m) state.curModel = m;
    } else if (j?.type === 'tool/call') {
      recordTool(calls, j.data?.callId ?? j.seq, j.data?.name ?? j.data?.toolName ?? j.data?.tool?.name, j.time);
    } else if (j?.type === 'assistant/message') {
      const u = j.data?.usage;
      if (!u || (!Number.isFinite(u.inputTokens) && !Number.isFinite(u.outputTokens))) return;
      acc.stats.usageLines++;
      const d = { input: fin(u.inputTokens), output: fin(u.outputTokens), cacheRead: fin(u.cacheReadTokens), cacheWrite: fin(u.cacheWriteTokens), requests: 1 };
      const day = dayKeyOf(Number.isFinite(j.time) ? j.time : Date.now());
      addInto(acc.flat, d);
      bumpDay(acc.days, day, d);
      bumpModel(acc.models, state.curModel || '(unknown)', d);
      bumpModelDay(acc.modelDays, state.curModel || '(unknown)', day, d);
      acc.stats.totalTokensSum += fin(u.totalTokens);
    }
  };
  const offsets = zstdFrameOffsets(buf);
  let consumed = 0;                        // 增量段内已消费字节数（均落在完整帧边界上）
  for (let k = 0; k < offsets.length; k++) {
    const isLast = k + 1 === offsets.length;
    const end = isLast ? buf.length : offsets[k + 1];
    let text;
    try { text = zlib.zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8'); }
    catch { if (isLast) break; return null; }               // 末帧解压失败=半写：推迟；中间帧损坏：整读回退
    const lines = text.split('\n');
    const trailing = lines.pop() ?? '';
    if (trailing !== '') {
      // 截断帧可能「成功」解压出以 \n 结尾的半段（PERF-2 同款坑，实测 cut-4 → "a\n"）——无法从帧头
      // 判定完整性（真实流式帧不带 FCS）。口径与 framed.mjs 跟随器一致：末帧仅当「非空且以 \n 收尾」
      // 才消费，否则推迟到下轮（文件增长后由后继魔数证明边界）；中间帧异常一律整读回退。
      if (isLast) break;
      return null;
    }
    if (text.length === 0) { if (isLast) break; return null; }   // 空输出：半写（cut-8 实测 → ""）或坏帧
    for (const line of lines) {
      handleLine(line);
      if ((++lineCnt & 511) === 0) await yieldNow();
    }
    consumed = end;
    if ((k & 31) === 31) await yieldNow();
  }
  acc.stats.componentsSum = acc.flat.input + acc.flat.output + acc.flat.cacheRead + acc.flat.cacheWrite;
  acc.stats.undatedCalls = calls.undated;
  acc.sid = state.sid;
  const accounted = off + consumed;         // 已对账字节位（≠ st.size：半写末帧留待下轮，条目按对账位存）
  const tail = { nextFrameOffset: accounted, sid: state.sid, curModel: state.curModel, seenCallIds: [...calls.seen], undatedCalls: calls.undated };
  dshFileCache.set(file, { size: accounted, mtimeMs: st.mtimeMs, ino: st.ino, tail, result: acc });
  return { result: acc, readBytes: buf.length };
}

/** DSH 缓存条目 result 的深克隆（尾读在克隆上续账，失败不污染缓存）。 */
function cloneDshResult(r) {
  const cp = (m) => { const o = new Map(); for (const [k, v] of m) o.set(k, { ...v }); return o; };
  const cpNested = (m) => { const o = new Map(); for (const [k, v] of m) o.set(k, cp(v)); return o; };
  return {
    flat: { ...r.flat }, days: cp(r.days), callDays: cp(r.callDays), models: cp(r.models), modelDays: cpNested(r.modelDays),
    variant: null, sid: r.sid ?? null,
    stats: { ...r.stats },
  };
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
    await yieldNow();                                   // 文件间让出：读+解压+解析的同步块不跨文件累积
    const r = await collectDshFile(f, o);
    if (r.aborted) { acc.stats.partial = true; break; }
    if (r.skipped || !r.sid) { acc.stats.skippedFiles++; continue; }
    acc.stats.files++;
    if (r.cached) acc.stats.cachedFiles++;
    if (r.resumed) acc.stats.resumedFiles++;   // 尾读续文件数（第 4a 步）
    acc.stats.parseErrors += r.stats.parseErrors;
    acc.stats.skippedLines += r.stats.skippedLines;
    acc.stats.undatedCalls += r.stats.undatedCalls;
    if (r.stats.componentsSum !== r.stats.totalTokensSum) acc.stats.identityMismatched++;   // 恒等式失配=解析可疑（对账口径）
    acc.stats.readBytes += r.readBytes || 0;      // P0-1：实际读取字节（缓存命中=0；zcode 例外见 scanZcodeUsage）
    acc.stats.corpusBytes += r.fileSize || 0;     // 本轮纳入语料体积（含缓存命中文件，供表格/对账）
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
  if (hit) return { ...hit.result, cached: true, fileSize: st.size, readBytes: 0 };
  const byMsg = new Map(), calls = newCalls();
  let variant = null, anonSeq = 0, parseErrors = 0, skippedLines = 0, aborted = false, lineCnt = 0;
  const deadline = Date.now() + o.softBudgetMs;
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if ((++lineCnt & 511) === 0) { await yieldNow(); if (Date.now() > deadline) { aborted = true; break; } }
        const isUsage = line.includes('"usage"');
        if (!isUsage && !line.includes('"entrypoint"') && !line.includes('"tool_use"')) continue;
        if (line.length > o.maxLineBytes) { skippedLines++; continue; }
        let j; try { j = JSON.parse(line); } catch { parseErrors++; continue; }
        if (typeof j?.entrypoint === 'string') variant = variantFromEntrypoint(j.entrypoint);   // 后写覆盖
        const m = j?.message;
        if (j?.type === 'assistant' && Array.isArray(m?.content)) {
          for (const [i, block] of m.content.entries()) {
            if (block?.type === 'tool_use') recordTool(calls, block.id ?? (m.id ? m.id + ':' + i : null), block.name, j.timestamp);
          }
        }
        if (!isUsage) continue;
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
  if (aborted) return { aborted: true, fileSize: st.size, readBytes: st.size };   // 半读文件不入缓存（下轮整读）；读量按整流近似计
  const byModel = new Map(), modelDays = new Map(), days = new Map();
  const flat = newUsage();
  for (const v of byMsg.values()) {
    const { model, day, ...d } = v;
    addInto(flat, d);
    bumpDay(days, day, d);
    bumpModel(byModel, model, d);
    bumpModelDay(modelDays, model, day, d);
  }
  const result = { flat, days, callDays: calls.days, models: byModel, modelDays, variant, stats: { distinctMsgs: byMsg.size, parseErrors, skippedLines, undatedCalls: calls.undated } };
  claudeFileCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, result });
  return { ...result, fileSize: st.size, readBytes: st.size };   // 整流读取 = size（P0-1）
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
    await yieldNow();                                   // 文件间让出（第 1 步）
    const r = await collectClaudeFile(f, o);
    if (r.aborted) { acc.stats.partial = true; break; }
    if (r.skipped) { acc.stats.skippedFiles++; continue; }
    acc.stats.files++;
    if (r.cached) acc.stats.cachedFiles++;
    acc.stats.parseErrors += r.stats.parseErrors;
    acc.stats.skippedLines += r.stats.skippedLines;
    acc.stats.undatedCalls += r.stats.undatedCalls;
    acc.stats.readBytes += r.readBytes || 0;
    acc.stats.corpusBytes += r.fileSize || 0;
    foldFile(acc, r, sidOf(f));
  }
  acc.stats.sessions = acc.bySession.size;
  return finishScan('claude-code', acc, t0, { inputIncludesCache: false });
}

// ---------------------------------------------------------------------------
// Codex：~/.codex/sessions/**/rollout-*.jsonl，token_count 事件
// ---------------------------------------------------------------------------

const codexFileCache = makeFileCache();

/** Codex 行处理器（全量/尾读共用）：h 为可变状态容器（尾读时从克隆状态续写）。 */
function codexLineHandler(h, o) {
  return (line) => {
    const isTok = line.includes('"token_count"');
    if (!isTok && !line.includes('"turn_context"') && !line.includes('"thread_settings_applied"') && !line.includes('"originator"') && !line.includes('"function_call"') && !line.includes('"custom_tool_call"')) return;
    if (line.length > o.maxLineBytes) { h.skippedLines++; return; }
    let j; try { j = JSON.parse(line); } catch { h.parseErrors++; return; }
    const p = j?.payload ?? {};
    if (j?.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      recordTool(h.calls, p.call_id ?? p.id, [p.namespace, p.name].filter(Boolean).join('.'), j.timestamp);
    } else if (j?.type === 'session_meta') {
      if (typeof p.originator === 'string') h.variant = variantFromOriginator(p.originator);
    } else if (j?.type === 'turn_context' && typeof p.model === 'string') h.curModel = p.model;
    else if (j?.type === 'event_msg' && p.type === 'thread_settings_applied' && typeof p.thread_settings?.model === 'string') h.curModel = p.thread_settings.model;
    else if (isTok && j?.type === 'event_msg' && p.type === 'token_count') {
      const last = p.info?.last_token_usage ?? {};
      const tot = p.info?.total_token_usage;
      const hasTot = !!tot && Number.isFinite(tot.input_tokens);
      const own = {
        input: fin(last.input_tokens), output: fin(last.output_tokens),
        cacheRead: fin(last.cached_input_tokens), cacheWrite: fin(last.cache_write_input_tokens),
      };
      let d;
      if (!h.prevTotal) {
        // 首条事件：total 可能是继承的父会话/fork 前缀（子代理 rollout 的 C0 = 父会话当时累计），
        // 只认本条自己的 last_token_usage——新会话实测 C0 == L0；forked 实测 L0 = 0（前缀是父会话的账）。
        d = { ...own, requests: 1 };
        if (hasTot) h.inheritedPrefix = Math.max(0, fin(tot.input_tokens) - own.input);
      } else if (hasTot) {
        // 其后每条：累计值差分（权威）。last_token_usage 会被重复上报（同一累计值连出多条事件），
        // 逐条求和会虚高；差分天然把重复上报按 0 计。
        const delta = {
          input: fin(tot.input_tokens) - fin(h.prevTotal.input_tokens),
          output: fin(tot.output_tokens) - fin(h.prevTotal.output_tokens),
          cacheRead: fin(tot.cached_input_tokens) - fin(h.prevTotal.cached_input_tokens),
          cacheWrite: fin(tot.cache_write_input_tokens) - fin(h.prevTotal.cache_write_input_tokens),
        };
        d = {
          input: Math.max(0, delta.input), output: Math.max(0, delta.output),
          cacheRead: Math.max(0, delta.cacheRead), cacheWrite: Math.max(0, delta.cacheWrite), requests: 1,
        };
        if (!d.input && !d.output && !d.cacheRead && !d.cacheWrite) h.duplicateReports++;
      } else {
        // 已见过累计值却缺累计值的事件（异常/旧格式）：不按 last 计 token，避免与后续 Δ累计 双计。
        d = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 };
        h.missingTotals++;
      }
      if (hasTot) h.prevTotal = tot;
      const day = dayKeyOf(Date.parse(j.timestamp) || Date.now());
      addInto(h.flat, d);
      bumpDay(h.days, day, d);
      bumpModelDay(h.modelDays, h.curModel || '(unknown)', day, d);
      h.requests++;
    }
  };
}

/** h（累积器+解析状态）→ 统一 result 形状（byModel 从合并后 modelDays 重算：单模型整额/多模型按日桶）。 */
function codexFinish(h) {
  const byModel = new Map();
  // flat 已是「首条自有增量 + 其后 Δ累计」之和：Σdays ≡ flat ≡ 文件自有消耗（不含继承前缀）。
  for (const [model, dm] of h.modelDays) {
    const u = newUsage();
    if (h.modelDays.size === 1) Object.assign(u, h.flat); else for (const v of dm.values()) addInto(u, v);
    byModel.set(model, u);
  }
  if (!byModel.size && (h.flat.input || h.flat.output)) bumpModel(byModel, '(unknown)', h.flat);
  return {
    flat: h.flat, days: h.days, callDays: h.calls.days, models: byModel, modelDays: h.modelDays, variant: h.variant,
    stats: { tokenEvents: h.requests, parseErrors: h.parseErrors, skippedLines: h.skippedLines, undatedCalls: h.calls.undated, inheritedPrefix: h.inheritedPrefix, duplicateReports: h.duplicateReports, missingTotals: h.missingTotals },
  };
}
const newCodexState = () => ({
  curModel: null, variant: null, requests: 0, parseErrors: 0, skippedLines: 0,
  byModel: new Map(), modelDays: new Map(), days: new Map(), calls: newCalls(), flat: newUsage(),
  prevTotal: null, inheritedPrefix: 0, duplicateReports: 0, missingTotals: 0,
});
const cloneCodexState = (h) => ({
  ...h,
  modelDays: new Map([...h.modelDays].map(([k, v]) => [k, new Map([...v].map(([d, u]) => [d, { ...u }]))])),
  days: new Map([...h.days].map(([k, v]) => [k, { ...v }])),
  calls: { days: new Map([...h.calls.days].map(([k, v]) => [k, { ...v }])), seen: new Set(h.calls.seen), undated: h.calls.undated },
  flat: { ...h.flat },
  prevTotal: h.prevTotal ? { ...h.prevTotal } : null,
});

async function collectCodexFile(file, o) {
  let st; try { st = fs.statSync(file); } catch { return { skipped: true }; }
  const hit = o.refresh ? null : cachedEntry(codexFileCache, file, st);
  if (hit) return { ...hit.result, cached: true, fileSize: st.size, readBytes: 0 };
  // 尾读路径（第 4b 步）：文件只增长 + inode 未变 + 锚点（offset 前 64B 哈希）相符 → 从 offset 续读
  const prev = codexFileCache.get(file);
  if (!o.refresh && prev && Number.isFinite(prev.offset) && st.size > prev.size
    && (st.ino === undefined || prev.ino === undefined || st.ino === prev.ino)) {
    const anchor = anchorAt(file, prev.offset);
    if (anchor !== null && anchor === prev.anchor) {
      const h = cloneCodexState(newCodexStateFromEntry(prev));
      const { aborted, lastLineEnd } = await readLinesByte(file, { startByte: prev.offset, deadline: Date.now() + o.softBudgetMs }, codexLineHandler(h, o));
      if (!aborted) {
        const result = codexFinish(h);
        codexFileCache.set(file, { size: lastLineEnd, mtimeMs: st.mtimeMs, ino: st.ino, offset: lastLineEnd, anchor: anchorAt(file, lastLineEnd), parserState: codexParserState(h), result });
        return { ...result, fileSize: st.size, readBytes: st.size - prev.offset, resumed: true };
      }
      // 中止：不写缓存（下轮重试）；fall through 整读
    }
  }
  const h = newCodexState();
  const { aborted, lastLineEnd } = await readLinesByte(file, { startByte: 0, deadline: Date.now() + o.softBudgetMs }, codexLineHandler(h, o));
  if (aborted) return { aborted: true, fileSize: st.size, readBytes: st.size };
  const result = codexFinish(h);
  codexFileCache.set(file, { size: lastLineEnd, mtimeMs: st.mtimeMs, ino: st.ino, offset: lastLineEnd, anchor: anchorAt(file, lastLineEnd), parserState: codexParserState(h), result });
  return { ...result, fileSize: st.size, readBytes: st.size };
}

/** 尾读续写状态：缓存条目（result + parserState）→ 可变状态容器 h。 */
function newCodexStateFromEntry(prev) {
  const r = prev.result;
  const ps = prev.parserState ?? {};
  return {
    curModel: ps.curModel ?? null, variant: r.variant ?? null, requests: ps.requests ?? 0,
    parseErrors: r.stats?.parseErrors ?? 0, skippedLines: r.stats?.skippedLines ?? 0,
    byModel: r.models, modelDays: r.modelDays, days: r.days,
    calls: { days: r.callDays, seen: new Set(ps.seenCallIds || []), undated: r.stats?.undatedCalls ?? 0 },
    flat: r.flat,
    prevTotal: ps.prevTotal ?? null,
    inheritedPrefix: r.stats?.inheritedPrefix ?? 0, duplicateReports: r.stats?.duplicateReports ?? 0, missingTotals: r.stats?.missingTotals ?? 0,
  };
}
const codexParserState = (h) => ({ prevTotal: h.prevTotal, curModel: h.curModel, requests: h.requests, seenCallIds: [...h.calls.seen] });

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
    await yieldNow();                                   // 文件间让出（第 1 步）
    const r = await collectCodexFile(f, o);
    if (r.aborted) { acc.stats.partial = true; break; }
    if (r.skipped) { acc.stats.skippedFiles++; continue; }
    acc.stats.files++;
    if (r.cached) acc.stats.cachedFiles++;
    if (r.resumed) acc.stats.resumedFiles++;   // 尾读续文件数（第 4b 步）
    acc.stats.parseErrors += r.stats.parseErrors;
    acc.stats.skippedLines += r.stats.skippedLines;
    acc.stats.undatedCalls += r.stats.undatedCalls;
    // 口径诊断（对账用）：继承前缀 = 被排除的父会话 token；重复上报 = 累计值不动的 token_count 事件
    acc.stats.inheritedPrefix += r.stats.inheritedPrefix || 0;
    acc.stats.duplicateReports += r.stats.duplicateReports || 0;
    acc.stats.missingTotals += r.stats.missingTotals || 0;
    acc.stats.readBytes += r.readBytes || 0;
    acc.stats.corpusBytes += r.fileSize || 0;
    foldFile(acc, r, threadIdOf(f));
  }
  acc.stats.sessions = acc.bySession.size;
  // 日桶现由累计值差分归日：Σdays ≡ 总量（foldFile 恒等式自检）。dayApproximate 仍为 true——
  // 总量精确，但「一条 Δ 落在哪一天」按事件时间戳切分，跨午夜的回合会在边界上近似。
  return finishScan('codex', acc, t0, { inputIncludesCache: true, dayApproximate: true });
}

// ---------------------------------------------------------------------------
// Kimi Code：~/.kimi-code/sessions/wd_*/session_*/agents/<id>/wire.jsonl 的 usage.record
// ---------------------------------------------------------------------------

const kimiFileCache = makeFileCache();

/** Kimi 行处理器（全量/尾读共用）：每行自包含（usage.record），仅 variant 与 tool 去重是跨行状态。 */
function kimiLineHandler(h, o) {
  return (line) => {
    const isUsage = line.includes('"usage.record"');
    const isMeta = line.includes('"clientMetadata"');        // turn.prompt 的形态标记（与 parseKimiSession 同源）
    const isTool = line.includes('"tool.call"');
    if (!isUsage && !isMeta && !isTool) return;
    if (line.length > o.maxLineBytes) { h.skippedLines++; return; }
    // 形态：clientMetadata 含 composer = 桌面版（原始行子串判定，免整行 JSON.parse）
    if (isMeta) { h.variant = line.includes('composer') ? 'desktop' : 'cli'; if (!isUsage && !isTool) return; }
    let j; try { j = JSON.parse(line); } catch { h.parseErrors++; return; }
    if (j?.type === 'context.append_loop_event' && j.event?.type === 'tool.call') {
      const ev = j.event;
      recordTool(h.calls, ev.uuid ?? ev.toolCallId ?? ev.callId, ev.name ?? ev.toolName ?? ev.tool_name, j.time);
    }
    if (j?.type !== 'usage.record' || !j.usage) return;
    const d = {
      input: fin(j.usage.inputOther), output: fin(j.usage.output),
      cacheRead: fin(j.usage.inputCacheRead), cacheWrite: fin(j.usage.inputCacheCreation), requests: 1,
    };
    if (!d.input && !d.output && !d.cacheRead && !d.cacheWrite) return;
    const model = typeof j.model === 'string' && j.model ? j.model.split('/').pop() : '(unknown)';
    const day = dayKeyOf(Number.isFinite(j.time) ? j.time : Date.now());
    addInto(h.flat, d);
    bumpDay(h.days, day, d);
    bumpModel(h.models, model, d);
    bumpModelDay(h.modelDays, model, day, d);
  };
}
const newKimiState = () => ({ variant: null, parseErrors: 0, skippedLines: 0, models: new Map(), modelDays: new Map(), days: new Map(), calls: newCalls(), flat: newUsage() });
const kimiFinish = (h) => ({ flat: h.flat, days: h.days, callDays: h.calls.days, models: h.models, modelDays: h.modelDays, variant: h.variant, stats: { parseErrors: h.parseErrors, skippedLines: h.skippedLines, undatedCalls: h.calls.undated } });
function newKimiStateFromEntry(prev) {
  const r = prev.result, ps = prev.parserState ?? {};
  return {
    variant: r.variant ?? null, parseErrors: r.stats?.parseErrors ?? 0, skippedLines: r.stats?.skippedLines ?? 0,
    models: r.models, modelDays: r.modelDays, days: r.days,
    calls: { days: r.callDays, seen: new Set(ps.seenCallIds || []), undated: r.stats?.undatedCalls ?? 0 },
    flat: r.flat,
  };
}
function cloneKimiState(h) {
  return {
    ...h,
    models: new Map([...h.models].map(([k, v]) => [k, { ...v }])),
    modelDays: new Map([...h.modelDays].map(([k, v]) => [k, new Map([...v].map(([d, u]) => [d, { ...u }]))])),
    days: new Map([...h.days].map(([k, v]) => [k, { ...v }])),
    calls: { days: new Map([...h.calls.days].map(([k, v]) => [k, { ...v }])), seen: new Set(h.calls.seen), undated: h.calls.undated },
    flat: { ...h.flat },
  };
}

async function collectKimiWire(file, o) {
  let st; try { st = fs.statSync(file); } catch { return { skipped: true }; }
  const hit = o.refresh ? null : cachedEntry(kimiFileCache, file, st);
  if (hit) return { ...hit.result, cached: true, fileSize: st.size, readBytes: 0 };
  // 尾读路径（第 4b 步）：同 codex（inode + 锚点校验，字节偏移续读）
  const prev = kimiFileCache.get(file);
  if (!o.refresh && prev && Number.isFinite(prev.offset) && st.size > prev.size
    && (st.ino === undefined || prev.ino === undefined || st.ino === prev.ino)) {
    const anchor = anchorAt(file, prev.offset);
    if (anchor !== null && anchor === prev.anchor) {
      const h = cloneKimiState(newKimiStateFromEntry(prev));
      const { aborted, lastLineEnd } = await readLinesByte(file, { startByte: prev.offset, deadline: Date.now() + o.softBudgetMs }, kimiLineHandler(h, o));
      if (!aborted) {
        const result = kimiFinish(h);
        kimiFileCache.set(file, { size: lastLineEnd, mtimeMs: st.mtimeMs, ino: st.ino, offset: lastLineEnd, anchor: anchorAt(file, lastLineEnd), parserState: { seenCallIds: [...h.calls.seen] }, result });
        return { ...result, fileSize: st.size, readBytes: st.size - prev.offset, resumed: true };
      }
    }
  }
  const h = newKimiState();
  const { aborted, lastLineEnd } = await readLinesByte(file, { startByte: 0, deadline: Date.now() + o.softBudgetMs }, kimiLineHandler(h, o));
  if (aborted) return { aborted: true, fileSize: st.size, readBytes: st.size };
  const result = kimiFinish(h);
  kimiFileCache.set(file, { size: lastLineEnd, mtimeMs: st.mtimeMs, ino: st.ino, offset: lastLineEnd, anchor: anchorAt(file, lastLineEnd), parserState: { seenCallIds: [...h.calls.seen] }, result });
  return { ...result, fileSize: st.size, readBytes: st.size };
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
    const tmp = { flat: newUsage(), days: new Map(), callDays: new Map(), models: new Map(), modelDays: new Map(), variant: null };
    for (const w of s.wires) {
      if (wireCount >= o.maxFiles) { acc.stats.partial = true; partialSession = true; break; }
      await yieldNow();                                 // 文件间让出（第 1 步）
      const r = await collectKimiWire(w, o);
      if (r.aborted) { acc.stats.partial = true; partialSession = true; break; }
      if (r.skipped) { acc.stats.skippedFiles++; continue; }
      wireCount++; acc.stats.files++;
      if (r.cached) acc.stats.cachedFiles++;
      if (r.resumed) acc.stats.resumedFiles++;   // 尾读续文件数（第 4b 步）
      acc.stats.parseErrors += r.stats.parseErrors;
      acc.stats.skippedLines += r.stats.skippedLines;
      acc.stats.undatedCalls += r.stats.undatedCalls;
      acc.stats.readBytes += r.readBytes || 0;
      acc.stats.corpusBytes += r.fileSize || 0;
      mergeInto(tmp, r);
      if (r.variant) tmp.variant = r.variant;          // 多 wire（子代理）时以 main 的判定为准可被覆盖，取后见
    }
    if (partialSession) break;                         // 半扫会话不落账（下轮重来）
    if (!tmp.flat.requests && !tmp.callDays.size) continue;
    foldFile(acc, tmp, s.sid);
  }
  acc.stats.sessions = acc.bySession.size;
  return finishScan('kimi-code', acc, t0, { inputIncludesCache: false });
}

// ---------------------------------------------------------------------------
// ZCode：sqlite message 表 tokens（行级拉取，JS 折叠三桶）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ZCode：sqlite message 表 tokens（行级拉取，JS 折叠三桶）+ 水位增量（第 3 步）
// 可行性依据：spikes/zcode-usage-watermark（2026-10-19 真实库回放）——
//   · tokens 并非只在终态写入（29,781/31,457 行处于中间态 finish=tool-calls）→ 用 delta（新−旧，负截 0）追账；
//   · delta 算法崩溃收敛：水位只在整轮成功后推进，行内「acc 变更 + LRU 基线」原子成对，中断轮下轮幂等重放；
//   · LRU 不持久化则重启丢账（实测 -495 万 token）→ msgLru/partLru 随 checkpoint 持久化；
//   · staleMiss 规则：未命中 LRU 且 tc 早于 LRU 最早条目才跳过（lag p99=5min，固定窗规则会漏计首计行）。
// ---------------------------------------------------------------------------

const ZCODE_LRU_CAP = 6000, ZCODE_LRU_EVICT = 2000, ZCODE_OVERLAP_MS = 2_000;

/** ZCode 增量状态（跨轮常驻 + checkpoint 持久化）：watermark 单调；msgLru = id → 已计入值+tc
 *  （Map 序 = LRU 序，touch 时 delete+set）；partLru = 已计入 (sid,callId) 键。 */
let zcodeState = null;

/** LRU 写入（touch 语义：命中重插到尾部；超容批量淘汰最旧）。 */
function lruTouch(map, key, value, cap, evict = ZCODE_LRU_EVICT) {
  map.delete(key); map.set(key, value);
  if (map.size > cap) { let k = 0; for (const kk of map.keys()) { map.delete(kk); if (++k >= evict) break; } }
}

/** scan 累加器快照（深拷贝）：增量轮继续变动 zcodeState.acc，返回值必须与后续变更隔离
 *  （否则 usageCache.data.zc 会被下一轮增量原地改写）。 */
function snapshotAcc(acc) {
  const cp = (m) => { const o = new Map(); for (const [k, v] of m) o.set(k, { ...v }); return o; };
  const cpNested = (m) => { const o = new Map(); for (const [k, v] of m) o.set(k, cp(v)); return o; };
  return {
    bySession: cp(acc.bySession), byModel: cp(acc.byModel), byDay: cp(acc.byDay), callsByDay: cp(acc.callsByDay),
    byModelDay: cpNested(acc.byModelDay), byVariantDay: cpNested(acc.byVariantDay), byVariantFlat: cp(acc.byVariantFlat),
    totals: { ...acc.totals }, stats: { ...acc.stats },
  };
}

export async function scanZcodeUsage(opts = {}) {
  const o = { ...DEFAULT_OPTS, dbPath: ZCODE_DB, lruCap: ZCODE_LRU_CAP, ...opts };
  const t0 = process.hrtime.bigint();
  if (o.refresh) zcodeState = null;                    // 强刷（P0-2 管道）：清状态全表重建
  if (zcodeState && zcodeState.dbPath !== o.dbPath) zcodeState = null;   // 状态绑定库文件：换库（测试/改 env）即全量重建
  const incremental = !!zcodeState;
  // acc 数据映射跨轮累积；stats 是轮次级诊断 → 每轮重置（含增量标记与 zcode 特有计数）
  const acc = incremental ? zcodeState.acc : newAcc();
  acc.stats = { ...newAcc().stats, incremental, incrementalRows: 0, staleMiss: 0 };
  acc.stats.files = 1;
  const degradedAcc = () => { const e = newAcc(); e.stats = { ...acc.stats }; e.stats.files = 1; return e; };   // degraded 返回空账（旧语义）：不拿旧 acc 冒充，状态保留待下轮重试
  try { acc.stats.corpusBytes = fs.statSync(o.dbPath).size; } catch { /* 库不存在：degraded 路径 */ }
  const db = openZcodeDb(o.dbPath);
  if (!db) return finishScan('zcode', degradedAcc(), t0, { inputIncludesCache: true, degraded: true, error: 'db-unavailable' });
  try {
    // 游标式拉行 + 每 512 行 yield（第 1 步）；不加 SQL ORDER BY（无索引时 sqlite 首行前全表物化+排序 ≈228ms 同步块）。
    // message 折叠加法可交换无需排序；part 的「重复 callId 最早优先」确定性由 JS 排序保证（全量路径）。
    const st = zcodeState ?? { dbPath: o.dbPath, watermark: -Infinity, msgLru: new Map(), partLru: new Map(), acc, lruCap: o.lruCap };
    let maxTu = Number.isFinite(st.watermark) ? st.watermark : -Infinity;
    let rowCnt = 0;
    const since = incremental ? st.watermark - ZCODE_OVERLAP_MS : -Infinity;
    const msgStmt = db.prepare(`
      SELECT m.id AS rid, m.session_id AS sid, m.time_updated AS tu,
             COALESCE(json_extract(m.data,'$.modelId'), '(unknown)') AS model,
             CAST(json_extract(m.data,'$.tokens.input') AS INTEGER) AS input,
             CAST(json_extract(m.data,'$.tokens.output') AS INTEGER) AS output,
             CAST(json_extract(m.data,'$.tokens.cache.read') AS INTEGER) AS cacheRead,
             CAST(json_extract(m.data,'$.tokens.cache.write') AS INTEGER) AS cacheWrite,
             m.time_created AS tc
      FROM message m
      WHERE ${incremental ? 'm.time_updated > ? AND ' : ''}json_extract(m.data,'$.role')='assistant'
        AND json_extract(m.data,'$.tokens.input') IS NOT NULL
    `);
    const msgIter = incremental ? msgStmt.iterate(since) : msgStmt.iterate();
    for (const r of msgIter) {
      if ((++rowCnt & 511) === 0) await yieldNow();
      if (Number.isFinite(r.tu)) maxTu = Math.max(maxTu, r.tu);
      const val = { input: fin(r.input), output: fin(r.output), cacheRead: fin(r.cacheRead), cacheWrite: fin(r.cacheWrite) };
      if (!val.input && !val.output && !val.cacheRead && !val.cacheWrite) continue;
      const day = dayKeyOf(r.tc);
      const old = st.msgLru.get(r.rid);
      let d;
      if (old) {
        // 已计过：delta = 新−旧（负值截 0，文档化口径）；requests 已随首次入账计 1（全量口径=每行 1 次）
        d = {
          input: Math.max(0, val.input - old.input), output: Math.max(0, val.output - old.output),
          cacheRead: Math.max(0, val.cacheRead - old.cacheRead), cacheWrite: Math.max(0, val.cacheWrite - old.cacheWrite), requests: 0,
        };
        if (!d.input && !d.output && !d.cacheRead && !d.cacheWrite) { lruTouch(st.msgLru, r.rid, { ...val, tc: r.tc }, st.lruCap); continue; }   // 无变化：只 touch 不折账
        if (incremental) acc.stats.incrementalRows++;
      } else {
        // staleMiss 规则（spike S3）：未命中且 tc 早于 LRU 最早条目 → 冻结假设跳过并计数（可观测）
        let minTc = Infinity; for (const v of st.msgLru.values()) minTc = Math.min(minTc, v.tc);
        if (st.msgLru.size && r.tc < minTc) { acc.stats.staleMiss++; continue; }
        d = { ...val, requests: 1 };
      }
      lruTouch(st.msgLru, r.rid, { ...val, tc: r.tc }, st.lruCap);
      // 行级结果组装成统一「文件形状」后折叠（d 只读共享，四处引用安全）
      foldFile(acc, {
        flat: d,
        days: new Map([[day, d]]),
        models: new Map([[r.model, d]]),
        modelDays: new Map([[r.model, new Map([[day, d]])]]),
        variant: null,
      }, r.sid);
    }
    const partStmt = db.prepare(`
      SELECT session_id AS sid, id, time_updated AS tu,
             json_extract(data,'$.callID') AS callId,
             json_extract(data,'$.tool') AS toolName,
             time_created AS tc
      FROM part WHERE ${incremental ? 'time_updated > ? AND ' : ''}json_extract(data,'$.type')='tool'
    `);
    const partIter = incremental ? partStmt.iterate(since) : partStmt.iterate();
    const partRows = [];
    for (const r of partIter) {
      if (Number.isFinite(r.tu)) maxTu = Math.max(maxTu, r.tu);
      partRows.push(r);
      if ((++rowCnt & 511) === 0) await yieldNow();
    }
    if (!incremental) partRows.sort((a, b) => (a.tc - b.tc) || String(a.id).localeCompare(String(b.id)));   // 与原 SQL ORDER BY 同语义（最早优先去重）
    for (const r of partRows) {
      if ((++rowCnt & 511) === 0) await yieldNow();
      const key = JSON.stringify([r.sid, r.callId ?? r.id]);     // 与全量口径同键
      if (!st.partLru.has(key)) {
        if (incremental) acc.stats.incrementalRows++;
        if (!Number.isFinite(r.tc)) { acc.stats.undatedCalls++; }
        else {
          const day = dayKeyOf(r.tc);
          const row = acc.callsByDay.get(day) ?? { toolCalls: 0, mcpCalls: 0 };
          row.toolCalls++;
          if (MCP_NAME_RE.test(String(r.toolName ?? ''))) row.mcpCalls++;
          acc.callsByDay.set(day, row);
        }
      }
      lruTouch(st.partLru, key, true, st.lruCap);
      if (!acc.bySession.has(r.sid)) acc.bySession.set(r.sid, newUsage());
    }
    // 整轮成功才建/推进状态：异常路径不落水位（中断轮的已折 delta 与 LRU 基线成对，下轮幂等收敛）
    zcodeState = st;
    zcodeState.watermark = maxTu;
    acc.stats.sessions = acc.bySession.size;
  } catch (e) {
    return finishScan('zcode', snapshotAcc(acc), t0, { inputIncludesCache: true, degraded: true, error: 'sqlite:' + String(e.message || e).slice(0, 120) });
  } finally { try { db.close(); } catch { /* ignore */ } }
  return finishScan('zcode', snapshotAcc(acc), t0, { inputIncludesCache: true });
}

// ---------------------------------------------------------------------------
// OpenCode：~/.local/share/opencode/opencode.db（sqlite 只读，WAL 并发；CLI 与桌面共用库）
//   token 在 **assistant message 行**（权威，2026-10-22 实测）：data.tokens
//   {input, output, reasoning, cache:{read,write}} + 顶层 providerID/modelID——
//   total = in+out+reasoning+cache 递推成立 → **input 不含 cacheRead**（Anthropic 式）。
//   reasoning 为 output 侧细分，不单列（与 ZCode 口径一致）；model 键 'provider/model'。
//   行内 UPDATE（流式中 tokens 快照会更新）→ 水位 + seen-LRU 指纹去重 + 同行 delta 递推
//   （zcode 同款：LRU 缓存上次值，重复行只计增量）。tool 调用计数走 part 的 tool 行。
//   对账基准：Σ message.tokens ≡ session_v2.tokens_*（会话累计列，实测一致）。
// ---------------------------------------------------------------------------

const OPENCODE_LRU_CAP = 6000, OPENCODE_OVERLAP_MS = 2_000;
let opencodeState = null;

export async function scanOpencodeUsage(opts = {}) {
  const o = { ...DEFAULT_OPTS, dbPath: OPENCODE_DB, lruCap: OPENCODE_LRU_CAP, ...opts };
  const t0 = process.hrtime.bigint();
  if (o.refresh) opencodeState = null;                    // 强刷（P0-2 管道）：清状态全表重建
  if (opencodeState && opencodeState.dbPath !== o.dbPath) opencodeState = null;   // 换库（测试/改 env）即全量重建
  const incremental = !!opencodeState;
  const acc = incremental ? opencodeState.acc : newAcc();
  acc.stats = { ...newAcc().stats, incremental, incrementalRows: 0 };
  acc.stats.files = 1;
  const degradedAcc = () => { const e = newAcc(); e.stats = { ...acc.stats }; return e; };
  try { acc.stats.corpusBytes = fs.statSync(o.dbPath).size; } catch { /* 库不存在：degraded 路径 */ }
  const db = openOpencodeDb(o.dbPath);
  if (!db) return finishScan('opencode', degradedAcc(), t0, { inputIncludesCache: false, degraded: true, error: 'db-unavailable' });
  try {
    const st = opencodeState ?? { dbPath: o.dbPath, watermark: -Infinity, msgLru: new Map(), toolLru: new Map(), acc, lruCap: o.lruCap };
    let maxTu = Number.isFinite(st.watermark) ? st.watermark : -Infinity;
    let rowCnt = 0;
    const since = incremental ? st.watermark - OPENCODE_OVERLAP_MS : -Infinity;
    // v1→v2 迁移把旧会话同时留在两条存储（实测 82 会话双写）——「有 v2 行的会话只认 v2」，
    // 否则总量精确翻倍（实测 ΣcacheRead 314.9M vs 账本 157.4M；去重后差 0.0016% = 在途漂移）。
    const v2Sids = new Set(db.prepare('SELECT DISTINCT session_id AS s FROM session_message').all().map((r) => r.s));
    // ① assistant message 的 tokens（行内 UPDATE：LRU 存上次值，重复行计 delta；子代理会话一并计入）
    const stmt = db.prepare(`
      SELECT m.id AS rid, m.session_id AS sid, m.time_created AS tc, m.time_updated AS tu,
             COALESCE(json_extract(m.data,'$.providerID'), '(unknown)') || '/' ||
               COALESCE(json_extract(m.data,'$.modelID'), '(unknown)') AS model,
             CAST(json_extract(m.data,'$.tokens.input') AS INTEGER) AS input,
             CAST(json_extract(m.data,'$.tokens.output') AS INTEGER) AS output,
             CAST(json_extract(m.data,'$.tokens.cache.read') AS INTEGER) AS cacheRead,
             CAST(json_extract(m.data,'$.tokens.cache.write') AS INTEGER) AS cacheWrite
      FROM message m WHERE ${incremental ? 'm.time_updated > ? AND ' : ''}json_extract(m.data,'$.role')='assistant'
        AND json_extract(m.data,'$.tokens.input') IS NOT NULL
    `);
    const iter = incremental ? stmt.iterate(since) : stmt.iterate();
    for (const r of iter) {
      if ((++rowCnt & 511) === 0) await yieldNow();
      if (Number.isFinite(r.tu)) maxTu = Math.max(maxTu, r.tu);
      if (v2Sids.has(r.sid)) continue;                    // 旧路径行：该会话已由 v2 存储接管
      const val = { input: fin(r.input), output: fin(r.output), cacheRead: fin(r.cacheRead), cacheWrite: fin(r.cacheWrite) };
      const old = st.msgLru.get(r.rid);
      let d;
      if (old) {
        // 已计过：delta = 新−旧（负值截 0，zcode 同款口径）；requests 已随首次入账计 1
        d = { input: Math.max(0, val.input - old.input), output: Math.max(0, val.output - old.output),
              cacheRead: Math.max(0, val.cacheRead - old.cacheRead), cacheWrite: Math.max(0, val.cacheWrite - old.cacheWrite), requests: 0 };
        if (!d.input && !d.output && !d.cacheRead && !d.cacheWrite) { lruTouch(st.msgLru, r.rid, val, st.lruCap); continue; }
        if (incremental) acc.stats.incrementalRows++;
      } else {
        d = { ...val, requests: 1 };
        if (!d.input && !d.output && !d.cacheRead && !d.cacheWrite) continue;
      }
      lruTouch(st.msgLru, r.rid, val, st.lruCap);
      const day = dayKeyOf(r.tc);
      foldFile(acc, {
        flat: d,
        days: new Map([[day, d]]),
        models: new Map([[r.model, d]]),
        modelDays: new Map([[r.model, new Map([[day, d]])]]),
        variant: null,                               // CLI 与桌面共用库，库内无形态标记（诚实：不拆形态账）
      }, r.sid);
    }
    // ② v2 服务路径：session_message 的 assistant 行（≥2.x；tokens/model 内联，语义与旧路径一致）
    //    —— LRU 键加 'v:' 前缀与旧路径 id 空间隔离（同一会话只会走一种存储，防极端混写）。
    const v2Stmt = db.prepare(`
      SELECT q.id AS rid, q.session_id AS sid, q.time_created AS tc, q.time_updated AS tu,
             COALESCE(json_extract(q.data,'$.model.providerID'), '(unknown)') || '/' ||
               COALESCE(json_extract(q.data,'$.model.modelID'), '(unknown)') AS model,
             CAST(json_extract(q.data,'$.tokens.input') AS INTEGER) AS input,
             CAST(json_extract(q.data,'$.tokens.output') AS INTEGER) AS output,
             CAST(json_extract(q.data,'$.tokens.cache.read') AS INTEGER) AS cacheRead,
             CAST(json_extract(q.data,'$.tokens.cache.write') AS INTEGER) AS cacheWrite
      FROM session_message q WHERE ${incremental ? 'q.time_updated > ? AND ' : ''}q.type='assistant'
        AND json_extract(q.data,'$.tokens.input') IS NOT NULL
    `);
    const v2Iter = incremental ? v2Stmt.iterate(since) : v2Stmt.iterate();
    for (const r of v2Iter) {
      if ((++rowCnt & 511) === 0) await yieldNow();
      if (Number.isFinite(r.tu)) maxTu = Math.max(maxTu, r.tu);
      const val = { input: fin(r.input), output: fin(r.output), cacheRead: fin(r.cacheRead), cacheWrite: fin(r.cacheWrite) };
      const old = st.msgLru.get('v:' + r.rid);
      let d;
      if (old) {
        d = { input: Math.max(0, val.input - old.input), output: Math.max(0, val.output - old.output),
              cacheRead: Math.max(0, val.cacheRead - old.cacheRead), cacheWrite: Math.max(0, val.cacheWrite - old.cacheWrite), requests: 0 };
        if (!d.input && !d.output && !d.cacheRead && !d.cacheWrite) { lruTouch(st.msgLru, 'v:' + r.rid, val, st.lruCap); continue; }
        if (incremental) acc.stats.incrementalRows++;
      } else {
        d = { ...val, requests: 1 };
        if (!d.input && !d.output && !d.cacheRead && !d.cacheWrite) continue;
      }
      lruTouch(st.msgLru, 'v:' + r.rid, val, st.lruCap);
      const day = dayKeyOf(r.tc);
      foldFile(acc, {
        flat: d,
        days: new Map([[day, d]]),
        models: new Map([[r.model, d]]),
        modelDays: new Map([[r.model, new Map([[day, d]])]]),
        variant: null,
      }, r.sid);
    }
    // ③ tool 调用计数（callsByDay；MCP 命名规则与其它源共用）
    //    旧路径走 part 的 tool 行；v2 路径用 json_each 展开 assistant.content（精确、只取 name，不搬大字段）
    const toolStmt = db.prepare(`
      SELECT p.id AS rid, p.session_id AS sid, p.time_created AS tc, p.time_updated AS tu,
             json_extract(p.data,'$.tool') AS toolName
      FROM part p WHERE ${incremental ? 'p.time_updated > ? AND ' : ''}json_extract(p.data,'$.type')='tool'
    `);
    const toolIter = incremental ? toolStmt.iterate(since) : toolStmt.iterate();
    for (const r of toolIter) {
      if (Number.isFinite(r.tu)) maxTu = Math.max(maxTu, r.tu);
      if ((++rowCnt & 511) === 0) await yieldNow();
      if (v2Sids.has(r.sid)) continue;                    // 同上：v2 会话的旧路径 part 行不计
      if (st.toolLru.has(r.rid)) { lruTouch(st.toolLru, r.rid, true, st.lruCap); continue; }
      lruTouch(st.toolLru, r.rid, true, st.lruCap);
      if (!Number.isFinite(r.tc)) { acc.stats.undatedCalls++; }
      else {
        const day = dayKeyOf(r.tc);
        const row = acc.callsByDay.get(day) ?? { toolCalls: 0, mcpCalls: 0 };
        row.toolCalls++;
        if (MCP_NAME_RE.test(String(r.toolName ?? ''))) row.mcpCalls++;
        acc.callsByDay.set(day, row);
      }
      if (!acc.bySession.has(r.sid)) acc.bySession.set(r.sid, newUsage());
    }
    // v2：assistant.content 的 tool 项（json_each 展开；key=数组下标与 rid 组成稳定去重键）
    const v2ToolStmt = db.prepare(`
      SELECT q.session_id AS sid, q.id AS rid, json_each.key AS ix, q.time_created AS tc, q.time_updated AS tu,
             json_extract(json_each.value, '$.name') AS toolName
      FROM session_message q, json_each(q.data, '$.content')
      WHERE ${incremental ? 'q.time_updated > ? AND ' : ''}q.type='assistant'
        AND json_extract(json_each.value, '$.type')='tool'
    `);
    const v2ToolIter = incremental ? v2ToolStmt.iterate(since) : v2ToolStmt.iterate();
    for (const r of v2ToolIter) {
      if (Number.isFinite(r.tu)) maxTu = Math.max(maxTu, r.tu);
      if ((++rowCnt & 511) === 0) await yieldNow();
      const key = 'vt:' + r.rid + ':' + r.ix;
      if (st.toolLru.has(key)) { lruTouch(st.toolLru, key, true, st.lruCap); continue; }
      lruTouch(st.toolLru, key, true, st.lruCap);
      if (!Number.isFinite(r.tc)) { acc.stats.undatedCalls++; }
      else {
        const day = dayKeyOf(r.tc);
        const row = acc.callsByDay.get(day) ?? { toolCalls: 0, mcpCalls: 0 };
        row.toolCalls++;
        if (MCP_NAME_RE.test(String(r.toolName ?? ''))) row.mcpCalls++;
        acc.callsByDay.set(day, row);
      }
      if (!acc.bySession.has(r.sid)) acc.bySession.set(r.sid, newUsage());
    }
    opencodeState = st;
    opencodeState.watermark = maxTu;
    acc.stats.sessions = acc.bySession.size;
  } catch (e) {
    return finishScan('opencode', snapshotAcc(acc), t0, { inputIncludesCache: false, degraded: true, error: 'sqlite:' + String(e.message || e).slice(0, 120) });
  } finally { try { db.close(); } catch { /* ignore */ } }
  return finishScan('opencode', snapshotAcc(acc), t0, { inputIncludesCache: false });
}

// ---------------------------------------------------------------------------
// Qoder：main.sqlite 无 token 真值（chat_session_context_usage 的 tokenCountsAvailable=false，
// 客户端不落盘 per-request token 计数，2026-10-22 本机实测）——如实降级，不虚估。
// ---------------------------------------------------------------------------

export function scanQoderUsage() {
  const acc = newAcc();
  return finishScan('qoder', acc, process.hrtime.bigint(), {
    inputIncludesCache: false,
    degraded: true,
    error: 'qoder-tokens-unavailable（Qoder 客户端不落盘 token 计数，无法精确累计；context_usage 仅百分比）',
  });
}

// ---------------------------------------------------------------------------
// Cursor：per-request token 在云端（客户端不落盘；ai-tracking 只记代码行数与摘要）——
// 如实降级，不虚估。
// ---------------------------------------------------------------------------

export function scanCursorUsage() {
  const acc = newAcc();
  return finishScan('cursor', acc, process.hrtime.bigint(), {
    inputIncludesCache: false,
    degraded: true,
    error: 'cursor-tokens-unavailable（Cursor 用量在云端，客户端不落盘 per-request token；ai-tracking 仅代码行数）',
  });
}

// ---------------------------------------------------------------------------
// 检查点（第 2 步，PERF-7）：文件级缓存跨进程持久化——重启后 size/mtime 未变的文件零重读。
// 失效键与进程内一致（size+mtime：不匹配该文件整读回退）；解析器/result 语义变更时 bump
// SCANNER_VERSION 使旧检查点整体作废。单条目形状异常只丢该条（永不抛）；数值字段过 fin() 防脏。
// ---------------------------------------------------------------------------

export const SCANNER_VERSION = 1;

const FILE_CACHES = () => ({ dsh: dshFileCache, 'claude-code': claudeFileCache, codex: codexFileCache, 'kimi-code': kimiFileCache });

/** result 的 Map 字段 → JSON（dayKey 是数字，JSON 对象键落地为字符串，加载时还原）。 */
function serResult(r) {
  const obj = (m, inner) => { const o = {}; for (const [k, v] of m) o[k] = inner ? inner(v) : v; return o; };
  const out = {
    flat: { ...r.flat },
    days: obj(r.days), callDays: obj(r.callDays), models: obj(r.models),
    modelDays: obj(r.modelDays, (dm) => obj(dm)),
    variant: r.variant ?? null,
    stats: { ...r.stats },
  };
  if (r.sid !== undefined) out.sid = r.sid ?? null;
  return out;
}
/** JSON → result（形状/数值校验；坏形状抛错，由调用方按单条目丢弃）。 */
function deResult(e) {
  if (!e || typeof e !== 'object' || typeof e.flat !== 'object' || !e.flat) throw new Error('bad-result');
  const numMap = (o) => { const m = new Map(); for (const k of Object.keys(o || {})) m.set(Number(k), o[k]); return m; };
  const strMap = (o) => { const m = new Map(); for (const k of Object.keys(o || {})) m.set(k, o[k]); return m; };
  const flat = newUsage();
  flat.input = fin(e.flat.input); flat.output = fin(e.flat.output);
  flat.cacheRead = fin(e.flat.cacheRead); flat.cacheWrite = fin(e.flat.cacheWrite); flat.requests = fin(e.flat.requests);
  const modelDays = new Map();
  for (const k of Object.keys(e.modelDays || {})) modelDays.set(k, numMap(e.modelDays[k]));
  const r = {
    flat,
    days: numMap(e.days), callDays: numMap(e.callDays), models: strMap(e.models), modelDays,
    variant: typeof e.variant === 'string' ? e.variant : null,
    stats: (e.stats && typeof e.stats === 'object') ? { ...e.stats } : {},
  };
  if (e.sid !== undefined) r.sid = typeof e.sid === 'string' ? e.sid : null;
  return r;
}

/** 导出全部文件缓存为可 JSON 化的检查点；超 maxBytes（默认 8MB）返回 null（调用方跳过写入）。 */
export function exportCheckpoint(opts = {}) {
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const out = { version: SCANNER_VERSION, savedAt: Date.now(), sources: {}, zcode: null };
  for (const [src, cache] of Object.entries(FILE_CACHES())) {
    const files = {};
    for (const [file, ent] of cache) {
      files[file] = {
        size: ent.size, mtimeMs: ent.mtimeMs,
        ...(ent.ino !== undefined ? { ino: ent.ino } : {}),                      // 尾读轮转防护（第 4 步）
        ...(ent.tail ? { tail: ent.tail } : {}),                                 // dsh：帧边界续读状态
        ...(ent.offset !== undefined ? { offset: ent.offset, anchor: ent.anchor } : {}),   // codex/kimi：字节偏移 + 前置锚点哈希
        ...(ent.parserState ? { parserState: ent.parserState } : {}),
        result: serResult(ent.result),
      };
    }
    out.sources[src] = files;
  }
  // zcode 水位状态：delta 算法崩溃收敛（spike S3），任何轮次导出都安全——中断轮的已折 delta
  // 与 LRU 基线成对，重载后下轮幂等补齐；spike S3b 实测不持久化则重启丢账。
  if (zcodeState) out.zcode = serZcodeState(zcodeState);
  return JSON.stringify(out).length <= maxBytes ? out : null;
}

/** zcode 增量状态 ↔ JSON（msgLru 用条目数组保 LRU 序；variant 键可能为 null → 空串哨兵）。 */
function serZcodeState(st) {
  const acc = st.acc;
  const ent = (m, valSer) => [...m.entries()].map(([k, v]) => [String(k ?? ''), valSer(v)]);
  const numEnt = (m) => [...m.entries()].map(([k, v]) => [String(k), { ...v }]);
  return {
    dbPath: st.dbPath ?? null,
    watermark: Number.isFinite(st.watermark) ? st.watermark : null,
    msgLru: [...st.msgLru.entries()].map(([id, v]) => [id, { input: v.input, output: v.output, cacheRead: v.cacheRead, cacheWrite: v.cacheWrite, tc: v.tc }]),
    partLru: [...st.partLru.keys()],
    acc: {
      bySession: ent(acc.bySession, (v) => ({ ...v })), byModel: ent(acc.byModel, (v) => ({ ...v })),
      byDay: numEnt(acc.byDay), callsByDay: numEnt(acc.callsByDay),
      byModelDay: ent(acc.byModelDay, (dm) => numEnt(dm)),
      byVariantDay: ent(acc.byVariantDay, (dm) => numEnt(dm)), byVariantFlat: ent(acc.byVariantFlat, (v) => ({ ...v })),
      totals: { ...acc.totals }, stats: { ...acc.stats },
    },
  };
}
function deZcodeState(e) {
  if (!e || typeof e !== 'object' || !e.acc) throw new Error('bad-zcode');
  const key = (k) => (k === '' || k === 'null' ? null : k);
  const map = (arr, valDe) => { const m = new Map(); for (const [k, v] of arr || []) m.set(key(k), valDe(v)); return m; };
  const numMap = (arr) => { const m = new Map(); for (const [k, v] of arr || []) m.set(Number(k), { ...v }); return m; };
  const msgLru = new Map();
  for (const [id, v] of e.msgLru || []) msgLru.set(id, { input: fin(v.input), output: fin(v.output), cacheRead: fin(v.cacheRead), cacheWrite: fin(v.cacheWrite), tc: fin(v.tc) });
  const st = {
    dbPath: typeof e.dbPath === 'string' ? e.dbPath : null,
    watermark: Number.isFinite(e.watermark) ? e.watermark : -Infinity,
    msgLru, partLru: new Map((e.partLru || []).map((k) => [k, 1])),   // Map（与 lruTouch/Set.has 同构；勿用 Set——lruTouch 需要 Map.set）
    lruCap: ZCODE_LRU_CAP,
    acc: {
      bySession: map(e.acc.bySession, (v) => ({ ...v })), byModel: map(e.acc.byModel, (v) => ({ ...v })),
      byDay: numMap(e.acc.byDay), callsByDay: numMap(e.acc.callsByDay),
      byModelDay: map(e.acc.byModelDay, (dm) => numMap(dm)),
      byVariantDay: map(e.acc.byVariantDay, (dm) => numMap(dm)), byVariantFlat: map(e.acc.byVariantFlat, (v) => ({ ...v })),
      totals: { input: fin(e.acc.totals.input), output: fin(e.acc.totals.output), cacheRead: fin(e.acc.totals.cacheRead), cacheWrite: fin(e.acc.totals.cacheWrite), requests: fin(e.acc.totals.requests) },
      stats: (e.acc.stats && typeof e.acc.stats === 'object') ? { ...e.acc.stats } : {},
    },
  };
  if (!(st.acc.bySession instanceof Map)) throw new Error('bad-zcode-acc');
  return st;
}

/** 加载检查点到四源文件缓存（不抛）。返回摘要 {version, loaded:{src:n}, dropped, reason} 供日志。 */
export function loadCheckpoint(obj) {
  const summary = { version: obj?.version ?? null, loaded: {}, dropped: 0, reason: null };
  if (!obj || typeof obj !== 'object' || obj.version !== SCANNER_VERSION) {
    summary.reason = obj ? 'version-mismatch' : 'empty';
    return summary;
  }
  for (const [src, cache] of Object.entries(FILE_CACHES())) {
    const files = obj.sources?.[src];
    let n = 0;
    if (files && typeof files === 'object') {
      for (const [file, ent] of Object.entries(files)) {
        try {
          if (!Number.isFinite(ent?.size) || !Number.isFinite(ent?.mtimeMs) || typeof file !== 'string' || !file) throw new Error('bad-entry');
          const result = deResult(ent.result);
          const entry = { size: ent.size, mtimeMs: ent.mtimeMs, result };
          // 可选尾读字段（形状异常只丢该条；4a/4b 各自的续读状态）
          if (ent.tail != null) {
            if (!Number.isFinite(ent.tail.nextFrameOffset) || !Array.isArray(ent.tail.seenCallIds)) throw new Error('bad-tail');
            entry.tail = ent.tail; entry.ino = Number.isFinite(ent.ino) ? ent.ino : undefined;
          } else if (Number.isFinite(ent.offset)) {
            if (typeof ent.anchor !== 'string') throw new Error('bad-offset-entry');
            entry.offset = ent.offset; entry.anchor = ent.anchor; entry.ino = Number.isFinite(ent.ino) ? ent.ino : undefined;
            if (ent.parserState && typeof ent.parserState === 'object') entry.parserState = ent.parserState;
          }
          cache.set(file, entry);
          n++;
        } catch { summary.dropped++; }
      }
    }
    summary.loaded[src] = n;
  }
  if (obj.zcode && typeof obj.zcode === 'object') {
    try { zcodeState = deZcodeState(obj.zcode); summary.loaded.zcode = 1; }
    catch { zcodeState = null; summary.dropped++; }
  }
  return summary;
}

/** 测试用：清空全部源内缓存（模拟全新进程）。 */
export function resetCaches() {
  for (const cache of Object.values(FILE_CACHES())) cache.clear();
  zcodeState = null;
}

// ---------------------------------------------------------------------------
// 折叠工具（scan 级累加器；单文件/单会话结果统一形状）
// ---------------------------------------------------------------------------

/** scan 级累加器：bySession（全量扁平）/ byModel / byDay / byModelDay / byVariantDay（时间窗用）+ byVariantFlat（全量，形态=文件级权威值）。 */
function newAcc() {
  return {
    bySession: new Map(), byModel: new Map(), byDay: new Map(), callsByDay: new Map(), byModelDay: new Map(), byVariantDay: new Map(), byVariantFlat: new Map(),
    totals: newUsage(),
    stats: { files: 0, cachedFiles: 0, resumedFiles: 0, sessions: 0, readBytes: 0, corpusBytes: 0, parseErrors: 0, skippedLines: 0, skippedFiles: 0, undatedCalls: 0, partial: false, identityMismatched: 0, dayIdentityMismatched: 0, inheritedPrefix: 0, duplicateReports: 0, missingTotals: 0 },
  };
}
/** 把一个「文件结果」（统一形状 {flat, days, models, modelDays, variant}）折叠进 scan 累加器。 */
function foldFile(acc, r, sid) {
  // 自检恒等式：Σ日桶 ≡ 文件扁平值（五源通用）。破坏它 = 日历日桶与「全部」总量对不上
  // （2026-10-09 Codex 双口径即为此：Σdays 397.2M vs 总量 459.4M）。
  const bucketSum = (m) => { let s = 0; for (const u of m.values()) s += fin(u.input) + fin(u.output) + fin(u.cacheRead) + fin(u.cacheWrite); return s; };
  if (bucketSum(r.days) !== fin(r.flat.input) + fin(r.flat.output) + fin(r.flat.cacheRead) + fin(r.flat.cacheWrite)) acc.stats.dayIdentityMismatched++;
  const row = acc.bySession.get(sid) ?? newUsage();
  addInto(row, r.flat);
  acc.bySession.set(sid, row);
  addInto(acc.totals, r.flat);
  for (const [day, u] of r.days) bumpDay(acc.byDay, day, u);
  addCallDays(acc.callsByDay, r.callDays);
  for (const [model, u] of r.models) bumpModel(acc.byModel, model, u);
  for (const [model, dm] of r.modelDays) {
    let tgt = acc.byModelDay.get(model);
    if (!tgt) { tgt = new Map(); acc.byModelDay.set(model, tgt); }
    for (const [day, u] of dm) bumpDay(tgt, day, u);
  }
  const v = r.variant ?? null;
  // 形态是文件级属性：全量口径直接归权威 flat（= Σ日桶，2026-10-09 起五源恒等）；
  // 时间窗口径仍走 byVariantDay（两者现已等值，保留双路径是因为窗口要按日切）
  bumpModel(acc.byVariantFlat, v, r.flat);
  let vm = acc.byVariantDay.get(v);
  if (!vm) { vm = new Map(); acc.byVariantDay.set(v, vm); }
  for (const [day, u] of r.days) bumpDay(vm, day, u);
}
/** Kimi 会话内多 wire 合并为一个「文件结果」（形态取最后非空判定）。 */
function mergeInto(tmp, r) {
  addInto(tmp.flat, r.flat);
  for (const [day, u] of r.days) bumpDay(tmp.days, day, u);
  addCallDays(tmp.callDays, r.callDays);
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
    bySession: acc.bySession, byModel: acc.byModel, byDay: acc.byDay, callsByDay: acc.callsByDay, byModelDay: acc.byModelDay, byVariantDay: acc.byVariantDay, byVariantFlat: acc.byVariantFlat,
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
    let mergedFresh = 0, mergedPrompt = 0, mergedTotal = 0;
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
        if (!m) { m = { ...newUsage(), sources: [], freshInput: 0, promptTokens: 0, totalTokens: 0 }; merged.set(model, m); }
        addInto(m, u);
        const dec = decorate(u, sc.inputIncludesCache);
        m.freshInput += dec.freshInput;
        m.promptTokens += dec.promptTokens;
        m.totalTokens += dec.totalTokens;
        if (!m.sources.includes(sc.source)) m.sources.push(sc.source);
      }
      addInto(totals, view.totals);
      const dec = decorate(view.totals, sc.inputIncludesCache);
      mergedFresh += dec.freshInput;
      mergedPrompt += dec.promptTokens;
      mergedTotal += dec.totalTokens;
    }
    const denom = mergedFresh + totals.cacheRead;
    return {
      totals: { ...totals, freshInput: mergedFresh, promptTokens: mergedPrompt, totalTokens: mergedTotal, hitRate: denom > 0 ? totals.cacheRead / denom : null },
      bySource,
      byModel: [...merged.entries()].map(([model, m]) => {
        const { sources, freshInput, promptTokens, totalTokens, ...u } = m;
        const d = freshInput + u.cacheRead;
        return { model, sources, ...u, freshInput, promptTokens, totalTokens, hitRate: d > 0 ? u.cacheRead / d : null };
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
    // totals 附展示口径派生值（promptTokens/totalTokens），与日历/图表同源
    totals: { ...sc.totals, ...(() => { const d = decorate(sc.totals, sc.inputIncludesCache); return { freshInput: d.freshInput, promptTokens: d.promptTokens, totalTokens: d.totalTokens, hitRate: d.hitRate }; })() },
    inputIncludesCache: !!sc.inputIncludesCache, dayApproximate: !!sc.dayApproximate,
    byModel: [...sc.byModel.entries()].map(([model, u]) => ({ model, ...u })).sort(byTotalDesc),
    byVariant: [...variantTotalsOf(sc).entries()].map(([variant, u]) => ({ variant, totals: { ...u } })),
    byDay, callsByDay: Object.fromEntries(sc.callsByDay || []),
    bySessionCount: sc.bySession.size, bySession,
    stats: sc.stats, degraded: !!sc.degraded, error: sc.error ?? null,
  };
}

/** Calendar payload has no session identities or transcripts and stays out of SSE snapshots. */
export function usageCalendar(scans) {
  const sources = {};
  for (const [key, source] of [['dsh', 'dsh'], ['cc', 'claude-code'], ['cx', 'codex'], ['km', 'kimi-code'], ['zc', 'zcode'], ['oc', 'opencode'], ['qd', 'qoder'], ['cs', 'cursor']]) {
    const sc = scans[key], days = {}, includesCache = !!sc?.inputIncludesCache;
    // 日桶 tokens = 全量口径（prompt 含缓存读 + cacheWrite + output），与各 Agent 自带计数一致；
    // promptTokens/freshInput 一并透出，供下钻表与对账用（2026-10-09 口径统一）。
    for (const [day, u] of sc?.byDay || []) {
      const d = decorate(u, includesCache);
      days[day] = { ...u, tokens: d.totalTokens, promptTokens: d.promptTokens, freshInput: d.freshInput, toolCalls: 0, mcpCalls: 0 };
    }
    for (const [day, counts] of sc?.callsByDay || []) days[day] = { ...(days[day] ?? { ...newUsage(), tokens: 0, promptTokens: 0, freshInput: 0 }), ...counts };
    const stats = sc?.stats ?? {};
    sources[source] = {
      days, available: !!sc && !sc.degraded,
      partial: !!(stats.partial || stats.parseErrors || stats.skippedLines || stats.skippedFiles || stats.undatedCalls),
      dayApproximate: !!sc?.dayApproximate,
      undatedCalls: stats.undatedCalls || 0,
      inputIncludesCache: includesCache,
    };
  }
  return { sources, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

/** 供 framed 一次性跑七源（并行；单源失败降级不拖垮整体）。 */
export async function scanAllUsage(opts = {}) {
  const safe = (p) => p.catch((e) => ({ degraded: true, error: String(e?.message || e).slice(0, 120), bySession: new Map(), byModel: new Map(), byDay: new Map(), byModelDay: new Map(), byVariantDay: new Map(), byVariantFlat: new Map(), totals: newUsage(), stats: { partial: false }, source: '?' }));
  const [dsh, cc, cx, km, zc, oc, qd, cs] = await Promise.all([
    safe(scanDshUsage(opts.dsh ?? {})),
    safe(scanClaudeUsage(opts.claude ?? {})),
    safe(scanCodexUsage(opts.codex ?? {})),
    safe(scanKimiUsage(opts.kimi ?? {})),
    Promise.resolve(scanZcodeUsage(opts.zcode ?? {})),
    Promise.resolve(scanOpencodeUsage(opts.opencode ?? {})),
    Promise.resolve(scanQoderUsage()),
    Promise.resolve(scanCursorUsage()),
  ]);
  return { dsh, cc, cx, km, zc, oc, qd, cs, overview: usageOverview({ dsh, cc, cx, km, zc, oc, qd, cs }, Date.now()) };
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
  const scans = await scanAllUsage(argv.includes('--refresh') ? FORCE_SCAN_OPTS : {});
  if (argv.includes('--json')) {
    console.log(JSON.stringify({
      generatedAt: Date.now(),
      overview: scans.overview,
      detail: { dsh: serializeUsageScan(scans.dsh), cc: serializeUsageScan(scans.cc), cx: serializeUsageScan(scans.cx), km: serializeUsageScan(scans.km), zc: serializeUsageScan(scans.zc), oc: serializeUsageScan(scans.oc), qd: serializeUsageScan(scans.qd), cs: serializeUsageScan(scans.cs) },
    }, null, 2));
    return;
  }
  const ov = scans.overview;
  const t = ov.totals;
  console.log('Token 用量（八源全量 · ' + new Date().toLocaleString('zh-CN') + '）');
  console.log('  合计  in ' + fmtTok(t.input) + ' · out ' + fmtTok(t.output) + ' · cacheRead ' + fmtTok(t.cacheRead) + ' · 命中率 ' + fmtHit(t.hitRate) + ' · 请求 ' + t.requests);
  for (const [k, label] of Object.entries({ today: '当日', d7: '7日内', d30: '30日内' })) {
    const r = ov.ranges[k].totals;
    console.log('  ' + label.padEnd(4) + ' in ' + fmtTok(r.input) + ' · out ' + fmtTok(r.output) + ' · 命中率 ' + fmtHit(r.hitRate) + ' · 请求 ' + r.requests);
  }
  const V_LABEL = { cli: 'CLI', desktop: '桌面', ide: 'IDE' };
  for (const [key, sc] of Object.entries({ dsh: scans.dsh, cc: scans.cc, cx: scans.cx, km: scans.km, zc: scans.zc, oc: scans.oc, qd: scans.qd, cs: scans.cs })) {
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
