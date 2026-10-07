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
 *   UC-B Codex：权威累计值（最后一条 total）· 单模型整额归属 · originator→desktop · 日桶=事件增量
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
// 期望：flat = 最后一条 total（in 2000 / out 25 / cacheRead 900 · requests 2，事件数）；单模型整额归属 gpt-test
const CX_EXP = { input: 2000, output: 25, cacheRead: 900, cacheWrite: 0, requests: 2 };

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
const [cc1, cx1, km1, dsh1] = await Promise.all([
  scanClaudeUsage({ root: CC_ROOT }), scanCodexUsage({ root: CX_ROOT }), scanKimiUsage({ root: KM_ROOT }), scanDshUsage({ root: DSH_ROOT }),
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

check('UCB1', 'Codex：会话扁平值=最后一条 total_token_usage（权威累计）+ 单模型整额归属（非增量求和）',
  eqUsage(cx1.totals, CX_EXP) && eqUsage(cx1.bySession.get(cxUuid), CX_EXP) && eqUsage(cx1.byModel.get('gpt-test'), CX_EXP),
  { got: cx1.totals, model: cx1.byModel.get('gpt-test') });
check('UCB2', 'Codex：originator=Codex Desktop → desktop；日桶=事件增量（1000/400/10 + 1000/500/15）',
  cx1.byVariantFlat.get('desktop') && eqUsage(cx1.byVariantFlat.get('desktop'), CX_EXP)
    && [...cx1.byDay.values()].reduce((a, u) => a + u.input, 0) === 2000,
  { variants: [...cx1.byVariantFlat.keys()], dayInputSum: [...cx1.byDay.values()].reduce((a, u) => a + u.input, 0) });

check('UCC1', 'Kimi：每请求累加（含子代理 wire 并入同会话）+ model 别名取尾段 + sid=state.json.id + composer→desktop',
  eqUsage(km1.totals, KM_EXP) && eqUsage(km1.bySession.get('km-sess-1'), KM_EXP) && km1.byModel.get('k3').requests === 2 && !!km1.byModel.get('flash') && km1.byVariantFlat.get('desktop') && eqUsage(km1.byVariantFlat.get('desktop'), KM_EXP),
  { got: km1.totals, models: [...km1.byModel.entries()].map(([m, u]) => [m, u.requests]) });
check('UCC2', 'Kimi：半扫会话不落账护栏不存在误触发（本 fixture 全量通过，sessions=1）', km1.stats.sessions === 1 && km1.stats.partial === false, { sessions: km1.stats.sessions });

check('UCD1', 'DSH：多帧 zstd 解压 + v3/v4 并存只取最高代（v3 的 99999 不计）+ session 首行 id + 恒等式零失配',
  eqUsage(dsh1.totals, DSH_EXP) && eqUsage(dsh1.bySession.get('dsh-sess-1'), DSH_EXP) && dsh1.stats.identityMismatched === 0 && dsh1.stats.files === 1,
  { got: dsh1.totals, files: dsh1.stats.files, identityMismatched: dsh1.stats.identityMismatched, zstd: zstdOk });

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
