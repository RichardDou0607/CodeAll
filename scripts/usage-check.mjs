#!/usr/bin/env node
/**
 * scripts/usage-check.mjs — Token 用量采集单元测试（合成数据，不依赖本机真实会话）
 *
 * 与 multi-source-check 的 MU 组（真实数据对账）互补：本脚本用可控 fixture 精确验证
 * 各源口径、去重/防双计、自然日分桶、命中率折算、文件级增量缓存（复用/失效/refresh）。
 *
 * 断言组：
 *   UC-A Claude：message.id 去重（后写覆盖）· sidechain 计入 · 无 id 行计数 · 子代理文件归父会话
 *               · 超大行跳过 · entrypoint→desktop · 增量缓存复用/追加失效 · 自然日分桶
 *   UC-B Codex：累计值差分归日（首条只认自身 last，防 fork/子代理继承前缀双计；其后 Δ累计，
 *               重复上报的 0 增量事件不计 token）· Σ日桶≡总量 · 单模型整额归属 · originator→desktop
 *   UC-C Kimi ：每请求累加 · agents/<id>/ 子代理流并入 · model 别名 split('/').pop · composer→desktop · state.json sid
 *   UC-D DSH  ：多帧 zstd 解压 · v3+v4 并存只取最高代 · 恒等式(∑分量=∑totalTokens) · session 首行 id
 *   UC-E 汇总 ：命中率折算（input 含/不含 cache 两种语义）· ranges 当日/7日/30日/全部归属 · 序列化结构
 *
 * 用法：node scripts/usage-check.mjs [--json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { scanClaudeUsage, scanCodexUsage, scanKimiUsage, scanDshUsage, usageOverview, serializeUsageScan } from '../adapters/usage-collect.mjs';

const AS_JSON = process.argv.includes('--json');
const results = [];
function check(id, name, pass, detail) { results.push({ id, name, pass: !!pass, detail }); return !!pass; }
const eqUsage = (u, exp) => ['input', 'output', 'cacheRead', 'cacheWrite', 'requests'].every((k) => (u[k] ?? 0) === exp[k]);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pet-usage-check-'));
/** 本地自然日中午的时间戳（避开午夜边界）：offsetDays 天前。 */
const noon = (offsetDays) => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate() - offsetDays, 12, 0, 0, 0).getTime(); };
const iso = (t) => new Date(t).toISOString();

// ================================================================ fixture：Claude
const CC_ROOT = path.join(TMP, 'claude', 'projects');
const ccSid = 'cc-main-sess';
const ccDir = path.join(CC_ROOT, '-tmp-ccproj', ccSid);
fs.mkdirSync(path.join(ccDir, 'subagents'), { recursive: true });
const ccUsage = (id, u, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: iso(extra.ts ?? noon(0)), isSidechain: extra.side === true, message: { id, model: extra.model ?? 'glm-test', usage: u }, ...(extra.entrypoint ? { entrypoint: extra.entrypoint } : {}) });
const CC_LINES = [
  JSON.stringify({ type: 'user', timestamp: iso(noon(0)), entrypoint: 'claude-desktop-3p', cwd: '/tmp/cc', message: { role: 'user', content: 'hi' } }),
  ccUsage('msg_1', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 }, { ts: noon(0) }),
  ccUsage('msg_1', { input_tokens: 120, output_tokens: 15, cache_read_input_tokens: 60, cache_creation_input_tokens: 5 }, { ts: noon(0) }),   // 同 id 流式快照：后写覆盖
  ccUsage('msg_2', { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 80 }, { ts: noon(3) }),
  ccUsage(undefined, { input_tokens: 1, output_tokens: 1 }, { ts: noon(0) }),                                                                 // 无 message.id：各计一次
  ccUsage('msg_3', { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 10 }, { side: true, ts: noon(10) }),                        // sidechain：计入（真实消耗）
  JSON.stringify({ type: 'assistant', timestamp: iso(noon(0)), message: { id: 'msg_big', model: 'glm-test', usage: { input_tokens: 9, output_tokens: 9 } } }) + ' '.repeat(600 * 1024), // 超大行：跳过
];
const ccFile = path.join(ccDir, ccSid + '.jsonl');
fs.writeFileSync(ccFile, CC_LINES.join('\n') + '\n');
const ccSubFile = path.join(ccDir, 'subagents', 'agent-abc.jsonl');
// 子代理转录同样携带 entrypoint（真实文件如此）：形态随主会话
fs.writeFileSync(ccSubFile, ccUsage('msg_9', { input_tokens: 70, output_tokens: 7, cache_read_input_tokens: 30 }, { ts: noon(10), entrypoint: 'claude-desktop-3p' }) + '\n');
// 期望：in 120+200+1+50+70=441 · out 15+20+1+5+7=48 · cacheRead 60+80+0+10+30=180 · cacheWrite 5 · requests 5
const CC_EXP = { input: 441, output: 48, cacheRead: 180, cacheWrite: 5, requests: 5 };
// 日桶期望：today(0d) msg_1(120/15/60)+无id(1/1/0) = 121/16/60；3d = msg_2；10d = msg_3 + subagent = 120/12/40
const CC_DAY0 = { input: 121, output: 16, cacheRead: 60 };
const CC_DAY3 = { input: 200, output: 20, cacheRead: 80 };
const CC_DAY10 = { input: 120, output: 12, cacheRead: 40 };

// ================================================================ fixture：Codex
const CX_ROOT = path.join(TMP, 'codex', 'sessions');
const cxUuid = '1a0d4099-8bc7-4d2f-9bf8-0a1346b76f71';
const cxDir = path.join(CX_ROOT, '2026', '10', '07');
fs.mkdirSync(cxDir, { recursive: true });
const cxFile = path.join(cxDir, 'rollout-2026-10-07T00-00-00-' + cxUuid + '.jsonl');
const cxTok = (tsMs, total, last) => JSON.stringify({ timestamp: iso(tsMs), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
fs.writeFileSync(cxFile, [
  JSON.stringify({ timestamp: iso(noon(0)), type: 'session_meta', payload: { session_id: cxUuid, cwd: '/tmp/cx', cli_version: '1.0', originator: 'Codex Desktop', parent_thread_id: '' } }),
  JSON.stringify({ timestamp: iso(noon(0)), type: 'turn_context', payload: { model: 'gpt-test', effort: 'low' } }),
  cxTok(noon(0), { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 0, output_tokens: 10 }, { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 0, output_tokens: 10 }),
  cxTok(noon(3), { input_tokens: 2000, cached_input_tokens: 900, cache_write_input_tokens: 0, output_tokens: 25 }, { input_tokens: 1000, cached_input_tokens: 500, cache_write_input_tokens: 0, output_tokens: 15 }),
].join('\n') + '\n');
// 期望：flat = 首条自身 last（1000/400/10）+ 其后 Δ累计（1000/500/15）= in 2000 / out 25 / cacheRead 900
// （本 fixture 首条 total == last，故与「取最后一条 total」同值）；单模型整额归属 gpt-test；requests = 事件数 2
const CX_EXP = { input: 2000, output: 25, cacheRead: 900, cacheWrite: 0, requests: 2 };

// ---- UC-B 反例 fixture（2026-10-09 用户报障「图表 459.4M vs 日历 397.2M」的两个陷阱）----
// 陷阱① 子代理/fork rollout 的首条 total 继承父会话累计 → 逐文件求和会重复计入父前缀；
// 陷阱② 同一累计值连着多条事件（重复上报）→ Σlast_token_usage 虚高。
const CX2_ROOT = path.join(TMP, 'codex-fork', 'sessions');
const CX2_DIR = path.join(CX2_ROOT, '2026', '10', '09');
fs.mkdirSync(CX2_DIR, { recursive: true });
const CX2_PARENT = '11111111-1111-4111-8111-111111111111';
const CX2_CHILD = '22222222-2222-4222-8222-222222222222';
const cx2Tok = (tsMs, total, last) => JSON.stringify({ timestamp: iso(tsMs), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
const cx2Meta = (sid, forkedFrom) => JSON.stringify({ timestamp: iso(noon(0)), type: 'session_meta', payload: { session_id: sid, cwd: '/tmp/cx2', originator: 'Codex Desktop', ...(forkedFrom ? { forked_from_id: forkedFrom } : {}) } });
fs.writeFileSync(path.join(CX2_DIR, 'rollout-2026-10-09T00-00-00-' + CX2_PARENT + '.jsonl'), [
  cx2Meta(CX2_PARENT, null),
  cx2Tok(noon(0), { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 10 }, { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 10 }),
  cx2Tok(noon(0) + 60_000, { input_tokens: 2000, cached_input_tokens: 900, output_tokens: 25 }, { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 15 }),
].join('\n') + '\n');
fs.writeFileSync(path.join(CX2_DIR, 'rollout-2026-10-09T00-01-00-' + CX2_CHILD + '.jsonl'), [
  cx2Meta(CX2_CHILD, CX2_PARENT),
  cx2Tok(noon(0) + 90_000, { input_tokens: 2000, cached_input_tokens: 900, output_tokens: 25 }, { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }),
  cx2Tok(noon(0) + 120_000, { input_tokens: 2000, cached_input_tokens: 900, output_tokens: 25 }, { input_tokens: 500, cached_input_tokens: 400, output_tokens: 5 }),
  cx2Tok(noon(1), { input_tokens: 2600, cached_input_tokens: 1100, output_tokens: 40 }, { input_tokens: 600, cached_input_tokens: 200, output_tokens: 15 }),
].join('\n') + '\n');
// 期望：父自有 2000 + 子自有 600 = 2600（继承前缀 2000 只算一次）；重复上报不计 token 但仍计请求；
// 旧口径给 父 2000 + 子 2600 = 4600（双计前缀），日桶 Σlast = 2000+500+600 亦虚高。
const CX2_EXP = { input: 2600, output: 40, cacheRead: 1100, cacheWrite: 0, requests: 5 };

// ================================================================ fixture：Kimi
const KM_ROOT = path.join(TMP, 'kimi', 'sessions');
const kmSessDir = path.join(KM_ROOT, 'wd_test', 'session_22222222-3333-4444-5555-666666666666');
fs.mkdirSync(path.join(kmSessDir, 'agents', 'main'), { recursive: true });
fs.mkdirSync(path.join(kmSessDir, 'agents', 'sub1'), { recursive: true });
fs.writeFileSync(path.join(kmSessDir, 'state.json'), JSON.stringify({ id: 'km-sess-1', cwd: '/tmp/km', createdAt: noon(0) }));
fs.writeFileSync(path.join(kmSessDir, 'agents', 'main', 'wire.jsonl'), [
  JSON.stringify({ type: 'turn.prompt', turnId: 1, time: noon(0), origin: { clientMetadata: { app: 'kimi_code_composer' } } }),
  JSON.stringify({ type: 'usage.record', agentId: 'main', model: 'kimi-code/k3', usageScope: 'turn', time: noon(0), usage: { inputOther: 100, output: 10, inputCacheRead: 40, inputCacheCreation: 0 } }),
  JSON.stringify({ type: 'usage.record', agentId: 'main', model: 'kimi-code/flash', usageScope: 'turn', time: noon(10), usage: { inputOther: 50, output: 5, inputCacheRead: 0, inputCacheCreation: 0 } }),
].join('\n') + '\n');
fs.writeFileSync(path.join(kmSessDir, 'agents', 'sub1', 'wire.jsonl'),
  JSON.stringify({ type: 'usage.record', agentId: 'sub1', model: 'kimi-code/k3', usageScope: 'turn', time: noon(3), usage: { inputOther: 7, output: 1, inputCacheRead: 3, inputCacheCreation: 0 } }) + '\n');
// 期望：in 157 · out 16 · cacheRead 43 · requests 3；模型 k3(2 req) + flash(1 req)；形态 desktop；sid=state.json.id
const KM_EXP = { input: 157, output: 16, cacheRead: 43, cacheWrite: 0, requests: 3 };

// ================================================================ fixture：DSH（多帧 zstd + v3/v4 并存）
const DSH_ROOT = path.join(TMP, 'dsh', 'sessions');
const dshDir = path.join(DSH_ROOT, '-tmp-dshproj', 'dsh-sess-1');
fs.mkdirSync(dshDir, { recursive: true });
const dshMsg = (seq, tsMs, u) => JSON.stringify({ type: 'assistant/message', seq, time: tsMs, data: { turn: 1, step: seq, message: { role: 'assistant' }, usage: u } });
const dshLines = [
  JSON.stringify({ type: 'session', version: 4, id: 'dsh-sess-1', createdAt: noon(0), cwd: '/tmp/dsh' }),
  JSON.stringify({ type: 'request/header', seq: 1, time: noon(0), data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash', maxTokens: 8192 } } } }),
  dshMsg(2, noon(0), { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0, totalTokens: 160 }),
  dshMsg(3, noon(3), { inputTokens: 40, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 2, totalTokens: 46 }),
];
let zstdOk = true;
try {
  const frames = [Buffer.from(dshLines.slice(0, 2).join('\n') + '\n'), Buffer.from(dshLines.slice(2).join('\n') + '\n')];
  fs.writeFileSync(path.join(dshDir, 'session.v4.jsonl.zstd'), Buffer.concat(frames.map((f) => zlib.zstdCompressSync(f))));
  fs.writeFileSync(path.join(dshDir, 'session.v3.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(dshMsg(9, noon(0), { inputTokens: 99999, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 100008 }) + '\n')));
} catch { zstdOk = false; fs.writeFileSync(path.join(dshDir, 'session.v4.jsonl'), dshLines.join('\n') + '\n'); }   // 无压缩能力：退化为明文路径
// 期望：v3 不计（pickLogFile 取最高代）：in 140 · out 14 · cacheRead 50 · cacheWrite 2 · requests 2；恒等式 142+64+50+2 = 160+46
const DSH_EXP = { input: 140, output: 14, cacheRead: 50, cacheWrite: 2, requests: 2 };

// ================================================================ 跑扫描 + 断言
const [cc1, cx1, km1, dsh1, cx2] = await Promise.all([
  scanClaudeUsage({ root: CC_ROOT }), scanCodexUsage({ root: CX_ROOT }), scanKimiUsage({ root: KM_ROOT }), scanDshUsage({ root: DSH_ROOT }),
  scanCodexUsage({ root: CX2_ROOT }),
]);

check('UCA1', 'Claude：message.id 去重（后写覆盖）+ sidechain/无id行计入 + 子代理文件归父会话 + 超大行跳过',
  eqUsage(cc1.totals, CC_EXP) && eqUsage(cc1.bySession.get(ccSid), CC_EXP) && cc1.bySession.size === 1 && !cc1.bySession.has('agent-abc'),
  { got: cc1.totals, exp: CC_EXP });
check('UCA2', 'Claude：entrypoint=claude-desktop-3p → 形态 desktop（文件级）',
  cc1.byVariantFlat.get('desktop') && eqUsage(cc1.byVariantFlat.get('desktop'), CC_EXP),
  { variants: [...cc1.byVariantFlat.keys()] });
check('UCA3', 'Claude：自然日分桶精确（0d/3d/10d 各桶值 + Σ桶=总量）',
  (() => {
    const d = (k) => cc1.byDay.get(k) ?? {};
    const noonKey = (off) => { const t = new Date(noon(off)); return t.getFullYear() * 10000 + (t.getMonth() + 1) * 100 + t.getDate(); };
    const sum = [...cc1.byDay.values()].reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output, cacheRead: a.cacheRead + u.cacheRead, requests: a.requests + u.requests }), { input: 0, output: 0, cacheRead: 0, requests: 0 });
    // 0d：msg_1 终值(120/15/60/5) + 无id行(1/1/0/0) → 121/16/60/cacheWrite 5/req 2；3d：msg_2；10d：msg_3+子代理（无 cacheWrite）
    return eqUsage(d(noonKey(0)), { ...CC_DAY0, cacheWrite: 5, requests: 2 }) && eqUsage(d(noonKey(3)), { ...CC_DAY3, cacheWrite: 0, requests: 1 })
      && eqUsage(d(noonKey(10)), { ...CC_DAY10, cacheWrite: 0, requests: 2 }) && sum.requests === CC_EXP.requests;
  })(), { days: [...cc1.byDay.entries()].map(([k, u]) => [k, u.input, u.requests]) });
{
  const cc2 = await scanClaudeUsage({ root: CC_ROOT });
  const same = JSON.stringify({ t: cc2.totals, d: [...cc2.byDay.entries()], m: [...cc2.byModel.entries()] }) === JSON.stringify({ t: cc1.totals, d: [...cc1.byDay.entries()], m: [...cc1.byModel.entries()] });
  check('UCA4', 'Claude：文件级增量缓存（size+mtime 不变 → 第二轮全缓存命中且结果逐字节一致）',
    cc2.stats.cachedFiles === cc2.stats.files && cc2.stats.files === 2 && same,
    { files: cc2.stats.files, cached: cc2.stats.cachedFiles });
  // 追加一行新 usage（today, msg_4: 500/50/200）→ 缓存失效、只重读该文件，总量精确 +500/+50/+200
  fs.appendFileSync(ccFile, ccUsage('msg_4', { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 200 }, { ts: noon(0) }) + '\n');
  const cc3 = await scanClaudeUsage({ root: CC_ROOT });
  const t3 = cc3.totals;
  check('UCA5', 'Claude：文件增长 → 缓存失效并精确增量（+500/+50/+200/req+1，子代理文件仍走缓存）',
    t3.input === CC_EXP.input + 500 && t3.output === CC_EXP.output + 50 && t3.cacheRead === CC_EXP.cacheRead + 200 && t3.requests === CC_EXP.requests + 1
      && cc3.stats.cachedFiles === 1 && cc3.stats.files === 2,
    { totals: t3, cached: cc3.stats.cachedFiles });
  const cc4 = await scanClaudeUsage({ root: CC_ROOT, refresh: true });
  check('UCA6', 'Claude：refresh=true 强制重读（结果与增量路径一致）',
    cc4.stats.cachedFiles === 0 && eqUsage(cc4.totals, t3), { cached: cc4.stats.cachedFiles });
}

check('UCB1', 'Codex：扁平值=首条自身 last + 其后 Δ累计（本 fixture 与「最后一条 total」同值）+ 单模型整额归属',
  eqUsage(cx1.totals, CX_EXP) && eqUsage(cx1.bySession.get(cxUuid), CX_EXP) && eqUsage(cx1.byModel.get('gpt-test'), CX_EXP)
    && cx1.stats.inheritedPrefix === 0 && cx1.stats.dayIdentityMismatched === 0,
  { got: cx1.totals, model: cx1.byModel.get('gpt-test'), prefix: cx1.stats.inheritedPrefix });
check('UCB2', 'Codex：originator=Codex Desktop → desktop；Σ日桶 = 总量（1000/400/10 + 1000/500/15）',
  cx1.byVariantFlat.get('desktop') && eqUsage(cx1.byVariantFlat.get('desktop'), CX_EXP)
    && [...cx1.byDay.values()].reduce((a, u) => a + u.input, 0) === 2000,
  { variants: [...cx1.byVariantFlat.keys()], dayInputSum: [...cx1.byDay.values()].reduce((a, u) => a + u.input, 0) });
check('UCB3', 'Codex：fork/子代理 rollout 的继承累计前缀只算一次（父 2000 + 子自有 600 = 2600；旧口径双计为 4600）',
  eqUsage(cx2.totals, CX2_EXP) && cx2.bySession.get(CX2_PARENT).input === 2000 && cx2.bySession.get(CX2_CHILD).input === 600
    && cx2.stats.inheritedPrefix === 2000 && cx2.stats.dayIdentityMismatched === 0,
  { got: cx2.totals, parent: cx2.bySession.get(CX2_PARENT), child: cx2.bySession.get(CX2_CHILD), prefix: cx2.stats.inheritedPrefix });
check('UCB4', 'Codex：重复上报（累计值不动）不计 token 但仍计请求；Δ 按事件日归桶且 Σ日桶 ≡ 总量',
  [...cx2.byDay.values()].reduce((a, u) => a + u.input, 0) === CX2_EXP.input
    && [...cx2.byDay.values()].reduce((a, u) => a + u.requests, 0) === CX2_EXP.requests
    && cx2.stats.duplicateReports === 1,
  { days: [...cx2.byDay.entries()].map(([k, u]) => [k, u.input, u.requests]), dup: cx2.stats.duplicateReports, mism: cx2.stats.dayIdentityMismatched });

// ================================================================ UC-B2：Codex 尾读（第 4b 步）
{
  const eqScan = (a, b) => JSON.stringify(a.totals) === JSON.stringify(b.totals) && JSON.stringify([...a.byDay]) === JSON.stringify([...b.byDay]);
  // ① 追加 token 事件 → Δ累计续账
  fs.appendFileSync(cxFile, cxTok(noon(5), { input_tokens: 2600, cached_input_tokens: 1100, cache_write_input_tokens: 0, output_tokens: 40 }, { input_tokens: 600, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 15 }) + '\n');
  const cx3 = await scanCodexUsage({ root: CX_ROOT });
  const EXP3 = { input: CX_EXP.input + 600, output: CX_EXP.output + 15, cacheRead: CX_EXP.cacheRead + 200, cacheWrite: 0, requests: CX_EXP.requests + 1 };
  check('UCB2-a', 'Codex 尾读：追加 token 事件 → Δ累计续账（resumed=1、== 全量重读）',
    cx3.stats.resumedFiles === 1 && eqUsage(cx3.totals, EXP3) && eqScan(cx3, await scanCodexUsage({ root: CX_ROOT, refresh: true })),
    { totals: cx3.totals, resumed: cx3.stats.resumedFiles });
  // ② fork 子文件累计跨界：prevTotal 从 parserState 延续——last(999) ≠ Δ(600)，丢状态必多计
  const childFile = path.join(CX2_DIR, 'rollout-2026-10-09T00-01-00-' + CX2_CHILD + '.jsonl');
  fs.appendFileSync(childFile, cx2Tok(noon(2), { input_tokens: 3200, cached_input_tokens: 1300, cache_write_input_tokens: 0, output_tokens: 50 }, { input_tokens: 999, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 10 }) + '\n');
  const cx2b = await scanCodexUsage({ root: CX2_ROOT });
  const EXP2B = { input: CX2_EXP.input + 600, output: CX2_EXP.output + 10, cacheRead: CX2_EXP.cacheRead + 200, cacheWrite: 0, requests: CX2_EXP.requests + 1 };
  check('UCB2-b', 'Codex 尾读：fork 累计跨 checkpoint 边界（prevTotal 延续，按 Δ=600 而非 last=999）',
    eqUsage(cx2b.totals, EXP2B) && eqScan(cx2b, await scanCodexUsage({ root: CX2_ROOT, refresh: true })),
    { totals: cx2b.totals });
  // ③ 半行（无 \n）→ 不消费；补齐 → 吸收
  const partialLine = cxTok(noon(6), { input_tokens: 4000, cached_input_tokens: 1500, cache_write_input_tokens: 0, output_tokens: 60 }, { input_tokens: 100, cached_input_tokens: 50, cache_write_input_tokens: 0, output_tokens: 5 });
  fs.appendFileSync(cxFile, partialLine.slice(0, 40));
  const cxHalf = await scanCodexUsage({ root: CX_ROOT });
  check('UCB2-c', 'Codex 尾读：半行不消费（总量不变，下轮补齐后吸收）',
    eqUsage(cxHalf.totals, EXP3),
    { totals: cxHalf.totals });
  fs.appendFileSync(cxFile, partialLine.slice(40) + '\n');
  const cxHealed = await scanCodexUsage({ root: CX_ROOT });
  const EXP3H = { input: EXP3.input + 1400, output: EXP3.output + 20, cacheRead: EXP3.cacheRead + 400, cacheWrite: 0, requests: EXP3.requests + 1 };
  check('UCB2-d', 'Codex 尾读：半行补齐吸收（== 全量重读）',
    eqUsage(cxHealed.totals, EXP3H) && eqScan(cxHealed, await scanCodexUsage({ root: CX_ROOT, refresh: true })),
    { totals: cxHealed.totals });
  // ④ 同路径替换成更大文件（rename → inode/anchor 失配）→ 整读回退不双计
  const swapLine = cxTok(noon(7), { input_tokens: 5000, cached_input_tokens: 1800, cache_write_input_tokens: 0, output_tokens: 80 }, { input_tokens: 1, cached_input_tokens: 1, cache_write_input_tokens: 0, output_tokens: 1 }) + '\n';
  const tmp = cxFile + '.swap';
  fs.writeFileSync(tmp, Buffer.concat([fs.readFileSync(cxFile), Buffer.from(swapLine)]));
  fs.renameSync(tmp, cxFile);
  const cxRot = await scanCodexUsage({ root: CX_ROOT });
  const EXP3R = { input: EXP3H.input + 1000, output: EXP3H.output + 20, cacheRead: EXP3H.cacheRead + 300, cacheWrite: 0, requests: EXP3H.requests + 1 };
  check('UCB2-e', 'Codex 尾读：同路径替换（inode 变）→ 整读回退且账目精确',
    eqUsage(cxRot.totals, EXP3R) && eqScan(cxRot, await scanCodexUsage({ root: CX_ROOT, refresh: true })),
    { totals: cxRot.totals });
}

check('UCC1', 'Kimi：每请求累加（含子代理 wire 并入同会话）+ model 别名取尾段 + sid=state.json.id + composer→desktop',
  eqUsage(km1.totals, KM_EXP) && eqUsage(km1.bySession.get('km-sess-1'), KM_EXP) && km1.byModel.get('k3').requests === 2 && !!km1.byModel.get('flash') && km1.byVariantFlat.get('desktop') && eqUsage(km1.byVariantFlat.get('desktop'), KM_EXP),
  { got: km1.totals, models: [...km1.byModel.entries()].map(([m, u]) => [m, u.requests]) });
check('UCC2', 'Kimi：半扫会话不落账护栏不存在误触发（本 fixture 全量通过，sessions=1）', km1.stats.sessions === 1 && km1.stats.partial === false, { sessions: km1.stats.sessions });

// ================================================================ UC-C3：Kimi 尾读（第 4b 步）
{
  const wireMain = path.join(kmSessDir, 'agents', 'main', 'wire.jsonl');
  const eqScan = (a, b) => JSON.stringify(a.totals) === JSON.stringify(b.totals) && JSON.stringify([...a.callsByDay]) === JSON.stringify([...b.callsByDay]);
  const toolLine = (uuid, name) => JSON.stringify({ type: 'context.append_loop_event', time: noon(1), event: { type: 'tool.call', uuid, name } });
  // ① 追加 usage + 新 tool call → 尾读吸收
  fs.appendFileSync(wireMain, JSON.stringify({ type: 'usage.record', agentId: 'main', model: 'kimi-code/k3', usageScope: 'turn', time: noon(1), usage: { inputOther: 70, output: 7, inputCacheRead: 20, inputCacheCreation: 0 } }) + '\n');
  fs.appendFileSync(wireMain, toolLine('kx-1', 'mcp__demo__run') + '\n');
  const km2 = await scanKimiUsage({ root: KM_ROOT });
  const EXP2 = { input: KM_EXP.input + 70, output: KM_EXP.output + 7, cacheRead: KM_EXP.cacheRead + 20, cacheWrite: 0, requests: KM_EXP.requests + 1 };
  const dayKey = (() => { const d = new Date(noon(1)); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); })();
  const toolsAfter1 = (km2.callsByDay.get(dayKey) || { toolCalls: 0 }).toolCalls;
  check('UCC3-a', 'Kimi 尾读：追加 usage/tool → 吸收（resumed=1、== 全量重读）',
    km2.stats.resumedFiles >= 1 && eqUsage(km2.totals, EXP2) && eqScan(km2, await scanKimiUsage({ root: KM_ROOT, refresh: true })),
    { totals: km2.totals, tools: toolsAfter1 });
  // ② 同 uuid 重报跨尾读边界 → seen 延续，toolCalls 不多计
  fs.appendFileSync(wireMain, toolLine('kx-1', 'mcp__demo__run') + '\n');
  const km3 = await scanKimiUsage({ root: KM_ROOT });
  const toolsAfter2 = (km3.callsByDay.get(dayKey) || { toolCalls: 0 }).toolCalls;
  check('UCC3-b', 'Kimi 尾读：seenCallIds 跨边界延续（重复 uuid 不多计 toolCalls）',
    toolsAfter2 === toolsAfter1 && eqScan(km3, await scanKimiUsage({ root: KM_ROOT, refresh: true })),
    { before: toolsAfter1, after: toolsAfter2 });
}

check('UCD1', 'DSH：多帧 zstd 解压 + v3/v4 并存只取最高代（v3 的 99999 不计）+ session 首行 id + 恒等式零失配',
  eqUsage(dsh1.totals, DSH_EXP) && eqUsage(dsh1.bySession.get('dsh-sess-1'), DSH_EXP) && dsh1.stats.identityMismatched === 0 && dsh1.stats.files === 1,
  { got: dsh1.totals, files: dsh1.stats.files, identityMismatched: dsh1.stats.identityMismatched, zstd: zstdOk });

// ================================================================ UC-D2：DSH 尾读（第 4a 步）
if (zstdOk) {
  const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n'));
  const file4 = path.join(dshDir, 'session.v4.jsonl.zstd');
  const normTotals = (sc) => JSON.stringify(sc.totals) + JSON.stringify([...sc.byDay.entries()].sort((a, b) => a[0] - b[0])) + JSON.stringify(sc.stats.usageLines);
  const base = await scanDshUsage({ root: DSH_ROOT, refresh: true });
  // ① 追加完整帧（新 usage + 新 tool call）→ 尾读续账 == 全量重读
  const msg4 = dshMsg(4, noon(0), { inputTokens: 777, outputTokens: 77, cacheReadTokens: 7, cacheWriteTokens: 0, totalTokens: 861 });
  const call4 = JSON.stringify({ type: 'tool/call', time: noon(0), data: { callId: 'tc-1', toolName: 'mcp__x__y' } });
  fs.appendFileSync(file4, frame([msg4, call4]));
  const grown = await scanDshUsage({ root: DSH_ROOT });
  const grownFull = await scanDshUsage({ root: DSH_ROOT, refresh: true });
  const EXP2 = { input: DSH_EXP.input + 777, output: DSH_EXP.output + 77, cacheRead: DSH_EXP.cacheRead + 7, cacheWrite: DSH_EXP.cacheWrite, requests: DSH_EXP.requests + 1 };
  check('UCD2-a', 'DSH 尾读：追加完整帧 → 续读吸收（resumedFiles=1、readBytes<corpus、== 全量重读）',
    grown.stats.resumedFiles === 1 && grown.stats.readBytes < grown.stats.corpusBytes
      && eqUsage(grown.totals, EXP2) && normTotals(grown) === normTotals(grownFull),
    { resumed: grown.stats.resumedFiles, readBytes: grown.stats.readBytes, corpus: grown.stats.corpusBytes, totals: grown.totals });
  // ② 半写帧（截断 8B → 解压得 ""）→ 不消费不推进、总量不变；补齐剩余字节 → 吸收
  const msg5 = dshMsg(5, noon(0), { inputTokens: 555, outputTokens: 55, cacheReadTokens: 5, cacheWriteTokens: 0, totalTokens: 615 });
  const f5 = frame([msg5]);
  fs.appendFileSync(file4, f5.subarray(0, f5.length - 8));
  const half = await scanDshUsage({ root: DSH_ROOT });
  check('UCD2-b', 'DSH 尾读：半写末帧不消费（总量不变，下轮再试）',
    eqUsage(half.totals, EXP2) && half.stats.resumedFiles === 1,
    { totals: half.totals });
  fs.appendFileSync(file4, f5.subarray(f5.length - 8));
  const healed = await scanDshUsage({ root: DSH_ROOT });
  const EXP3 = { input: EXP2.input + 555, output: EXP2.output + 55, cacheRead: EXP2.cacheRead + 5, cacheWrite: EXP2.cacheWrite, requests: EXP2.requests + 1 };
  check('UCD2-c', 'DSH 尾读：半写帧补齐后吸收（== 全量重读）',
    eqUsage(healed.totals, EXP3) && normTotals(healed) === normTotals(await scanDshUsage({ root: DSH_ROOT, refresh: true })),
    { totals: healed.totals });
  // ③ 同路径替换成更大文件（rename，inode 变）→ 尾读锚点失效 → 整读回退，不多计
  const bigger = Buffer.concat([fs.readFileSync(file4), frame([dshMsg(6, noon(0), { inputTokens: 111, outputTokens: 11, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 123 })])]);
  const tmpFile = file4 + '.swap';
  fs.writeFileSync(tmpFile, bigger); fs.renameSync(tmpFile, file4);
  const rot = await scanDshUsage({ root: DSH_ROOT });
  const EXP4 = { input: EXP3.input + 111, output: EXP3.output + 11, cacheRead: EXP3.cacheRead + 1, cacheWrite: EXP3.cacheWrite, requests: EXP3.requests + 1 };
  check('UCD2-d', 'DSH 尾读：同路径替换（inode 变）→ 整读回退且账目精确（不双计）',
    eqUsage(rot.totals, EXP4) && normTotals(rot) === normTotals(await scanDshUsage({ root: DSH_ROOT, refresh: true })),
    { totals: rot.totals });
  // ⑤ 工具调用去重跨尾读边界：同 callId 再报一次不多计
  fs.appendFileSync(file4, frame([JSON.stringify({ type: 'tool/call', time: noon(0), data: { callId: 'tc-1', toolName: 'mcp__x__y' } })]));
  const dupCall = await scanDshUsage({ root: DSH_ROOT });
  const toolDayKey = (() => { const d = new Date(noon(0)); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); })();
  const before = rot.callsByDay.get(toolDayKey) || { toolCalls: 0, mcpCalls: 0 };
  const after = dupCall.callsByDay.get(toolDayKey) || { toolCalls: 0, mcpCalls: 0 };
  check('UCD2-e', 'DSH 尾读：seenCallIds 跨边界延续（重复 callId 不多计 toolCalls）',
    before.toolCalls === after.toolCalls,
    { before: before.toolCalls, after: after.toolCalls });
  // ⑥ 尾读状态跨重启：export → reset（模拟重启）→ load → 追加帧 → 仍走续读路径
  const { exportCheckpoint, loadCheckpoint, resetCaches } = await import('../adapters/usage-collect.mjs');
  const cpD = exportCheckpoint();
  resetCaches();
  const sumD = loadCheckpoint(JSON.parse(JSON.stringify(cpD)));
  fs.appendFileSync(file4, frame([dshMsg(7, noon(0), { inputTokens: 222, outputTokens: 22, cacheReadTokens: 2, cacheWriteTokens: 0, totalTokens: 246 })]));
  const afterRestart = await scanDshUsage({ root: DSH_ROOT });
  const EXP5 = { input: EXP4.input + 222, output: EXP4.output + 22, cacheRead: EXP4.cacheRead + 2, cacheWrite: EXP4.cacheWrite, requests: EXP4.requests + 1 };
  const ref = await scanDshUsage({ root: DSH_ROOT, refresh: true });
  check('UCD2-f', 'DSH 尾读状态随检查点跨重启（load 后追加帧仍续读、账目==全量重读）',
    sumD.dropped === 0 && afterRestart.stats.resumedFiles === 1 && eqUsage(afterRestart.totals, EXP5) && normTotals(afterRestart) === normTotals(ref),
    { dropped: sumD.dropped, resumed: afterRestart.stats.resumedFiles, totals: afterRestart.totals });
}

{
  // UC-E 汇总层：命中率 + ranges（合成 now = fixture 生成时刻）
  const now = noon(0) + 3600_000;                        // 当日 13:00 左右
  const ov = usageOverview({ dsh: dsh1, cc: cc1, cx: cx1, km: km1 }, now);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  // DSH（input 不含 cache）：hit = 50/(140+50)；Codex（input 含 cache）：fresh=2000-900 → hit=900/2000
  const dHit = ov.bySource.dsh.totals.hitRate, cHit = ov.bySource.codex.totals.hitRate;
  check('UCE1', '命中率折算：DSH(不含cache语义)=cacheRead/(in+cacheRead) · Codex(含cache语义)=cacheRead/in',
    near(dHit, 50 / 190) && near(cHit, 900 / 2000),
    { dsh: dHit, expectDsh: 50 / 190, codex: cHit, expectCodex: 0.45 });
  // ranges：today = cc(121+1新增? 用 cc1：121) + cx(1000) + km(100) + dsh(100)；d7 加 3d 的 cc200/cx1000/km7/dsh40；d30 加 10d；all 全部
  const r = (k, src) => ov.ranges[k].bySource[src]?.totals.input ?? 0;
  const expToday = { 'claude-code': 121, codex: 1000, 'kimi-code': 100, dsh: 100 };
  const expD7 = { 'claude-code': 121 + 200, codex: 2000, 'kimi-code': 100 + 7, dsh: 140 };
  const expD30 = { 'claude-code': 441, codex: 2000, 'kimi-code': 157, dsh: 140 };
  check('UCE2', 'ranges 归属：当日=各源当日桶 · 7日=+3d桶 · 30日=+10d桶（含全部 fixture 天）',
    Object.entries(expToday).every(([s, v]) => r('today', s) === v) && Object.entries(expD7).every(([s, v]) => r('d7', s) === v) && Object.entries(expD30).every(([s, v]) => r('d30', s) === v),
    { today: { cc: r('today', 'claude-code'), cx: r('today', 'codex') }, d7: { cc: r('d7', 'claude-code') }, d30: { cc: r('d30', 'claude-code') } });
  // 合并模型跨源 hitRate：glm-test 仅 claude（fresh=441? 用 cc1 无追加版）… 以 deepseek/k3 类跨源混合不设 fixture，验证 totals 合并口径即可
  // UCE5 展示口径（2026-10-09 统一）：totalTokens = promptTokens（含缓存读）+ cacheWrite + out；
  // promptTokens 按源语义 = input（Codex/ZCode 已含 cache）或 input + cacheRead（DSH/Claude/Kimi）
  check('UCE5', '展示口径：DSH（input 不含 cache）与 Codex（input 含 cache）两端 totalTokens 折算都对',
    (() => {
      const d = ov.bySource.dsh.totals, c = ov.bySource.codex.totals, t = ov.totals;
      return d.promptTokens === d.input + d.cacheRead && d.totalTokens === d.promptTokens + d.cacheWrite + d.output
        && c.promptTokens === c.input && c.totalTokens === c.promptTokens + c.cacheWrite + c.output
        && t.totalTokens === t.promptTokens + t.cacheWrite + t.output;
    })(),
    { dsh: ov.bySource.dsh.totals, codex: ov.bySource.codex.totals, total: ov.totals.totalTokens });
  check('UCE3', 'overview 合计 hitRate 用 freshInput 折算（跨源可加）',
    (() => {
      const fresh = 441 + (2000 - 900) + 157 + 140;      // cc + codex + kimi + dsh（各自语义）
      const cr = 180 + 900 + 43 + 50;
      return near(ov.totals.hitRate, cr / (fresh + cr));
    })(), { hitRate: ov.totals.hitRate });
  const ser = serializeUsageScan(dsh1);
  check('UCE4', 'serializeUsageScan 结构（byDay/byVariant/inputIncludesCache/identityMismatched）',
    !!ser.byDay && Object.keys(ser.byDay).length === 2 && ser.inputIncludesCache === false && ser.byVariant.length === 1 && ser.byVariant[0].variant === null,
    { byDay: Object.keys(ser.byDay), inputIncludesCache: ser.inputIncludesCache });
}

// ================================================================ UC-G：检查点（跨重启持久化，第 2 步 PERF-7）
{
  const { exportCheckpoint, loadCheckpoint, resetCaches } = await import('../adapters/usage-collect.mjs');
  // 等价性口径：排除轮次相关字段（generatedAt/elapsedMs/cachedFiles/readBytes/corpusBytes）
  const norm = (sc) => { const c = JSON.parse(JSON.stringify(serializeUsageScan(sc))); delete c.generatedAt; delete c.elapsedMs; delete c.stats.cachedFiles; delete c.stats.readBytes; delete c.stats.corpusBytes; return c; };
  const fresh = await scanClaudeUsage({ root: CC_ROOT, refresh: true });     // 全量基准
  const cp = exportCheckpoint();
  check('UCG1', '检查点导出：JSON 可序列化、含版本号与四源 section',
    (() => { const j = JSON.parse(JSON.stringify(cp)); return typeof j.version === 'number' && Object.keys(j.sources).length === 4 && Object.keys(j.sources['claude-code'] || {}).length >= 2; })(),
    { sources: Object.keys(cp.sources || {}) });
  resetCaches();
  const sum = loadCheckpoint(JSON.parse(JSON.stringify(cp)));
  const resumed = await scanClaudeUsage({ root: CC_ROOT });
  check('UCG2', '重启模拟：清缓存→载检查点→重扫，归一化结果与全量基准逐字段一致且全命中（readBytes=0）',
    sum.dropped === 0 && resumed.stats.cachedFiles === resumed.stats.files && resumed.stats.readBytes === 0
      && JSON.stringify(norm(fresh)) === JSON.stringify(norm(resumed)),
    { loaded: sum.loaded['claude-code'], cached: resumed.stats.cachedFiles + '/' + resumed.stats.files, equal: JSON.stringify(norm(fresh)) === JSON.stringify(norm(resumed)) });
  // 文件被删：条目残留在检查点里无害（扫描时 stat 失败走 skipped，不计入结果）
  const ghost = JSON.parse(JSON.stringify(cp)); const gk = Object.keys(ghost.sources['claude-code'])[0];
  ghost.sources['claude-code'][path.join(TMP, 'ghost', 'deleted.jsonl')] = ghost.sources['claude-code'][gk];
  resetCaches();
  const sumGhost = loadCheckpoint(ghost);
  const afterGhost = await scanClaudeUsage({ root: CC_ROOT });
  check('UCG3', '已删文件的检查点条目无害（加载成功、扫描 skipped 不计）',
    sumGhost.dropped === 0 && afterGhost.stats.files === fresh.stats.files && JSON.stringify(norm(fresh)) === JSON.stringify(norm(afterGhost)),
    { files: afterGhost.stats.files + '/' + fresh.stats.files });
  // 版本不符整体作废 + 坏条目只丢该条 + 8MB 护栏
  const badVer = loadCheckpoint({ ...JSON.parse(JSON.stringify(cp)), version: 99999 });
  const badEnt = JSON.parse(JSON.stringify(cp)); badEnt.sources['claude-code'][gk] = { size: 'not-a-number', mtimeMs: 1 };
  resetCaches();
  const sumBad = loadCheckpoint(badEnt);
  check('UCG4', '版本不符整体作废 + 单条目形状异常只丢该条',
    badVer.reason === 'version-mismatch' && sumBad.dropped === 1 && sumBad.loaded['claude-code'] === sum.loaded['claude-code'] - 1,
    { badVerReason: badVer.reason, dropped: sumBad.dropped });
  check('UCG5', '8MB 护栏：超限导出返回 null（调用方跳过写入）',
    exportCheckpoint({ maxBytes: 1 }) === null && exportCheckpoint({ maxBytes: 8 * 1024 * 1024 }) !== null,
    { tiny: exportCheckpoint({ maxBytes: 1 }) === null });
}

// ================================================================ 报告与清理
fs.rmSync(TMP, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
if (AS_JSON) {
  console.log(JSON.stringify({ pass: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2));
} else {
  for (const r of results) console.log((r.pass ? '✅' : '❌') + ' [' + r.id + '] ' + r.name + (r.pass ? '' : '  → ' + JSON.stringify(r.detail)));
  console.log('\n' + (failed.length ? '❌ ' + failed.length + ' 项未通过' : '全部 ' + results.length + ' 项断言通过 ✅'));
}
process.exit(failed.length ? 1 : 0);
