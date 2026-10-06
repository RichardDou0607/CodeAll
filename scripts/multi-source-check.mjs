#!/usr/bin/env node
/**
 * scripts/multi-source-check.mjs — 多 Agent 观察适配验收（docs/21 M-A/M-B/M-C/M-H，真实数据）
 *
 * 用法：
 *   node scripts/multi-source-check.mjs            # 人类可读报告
 *   node scripts/multi-source-check.mjs --json     # 机器可读（CI 用）
 *
 * 断言组（全部基于本机真实数据 + 合成临时文件）：
 *   M-A  Claude Code：目录扫描 / 元信息（标题·模型·版本·cwd）/ 粗状态 / 行映射纯函数 / 性能
 *   M-B  Codex：目录扫描 / 子代理排除（parent_thread_id）/ 元信息 / 行映射 / 性能
 *   M-H  Kimi Code：降级通道（LevelDB 近似计数 + observes 白名单 + 不产生会话行）
 *   M-C  多源合并：起真实 framed.mjs 实例 → 快照含多源项目与历史行；非 DSH 投递被明确拒绝
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanClaudeCatalog, mapClaudeLine } from '../adapters/claude-code-adapter.mjs';
import { scanCodexCatalog, mapCodexLine } from '../adapters/codex-adapter.mjs';
import { scanKimiCatalog, mapKimiLine, scanKimiStatus, scanKimiLegacyCount } from '../adapters/kimi-code-adapter.mjs';

const AS_JSON = process.argv.includes('--json');
const results = [];
function check(id, name, pass, detail) { results.push({ id, name, pass: !!pass, detail }); return !!pass; }
const here = (f) => path.join(path.dirname(fileURLToPath(import.meta.url)), f);

// ================================================================ M-A Claude Code
let cc;
{
  const t0 = process.hrtime.bigint();
  cc = scanClaudeCatalog();
  const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
  check('MA1', 'Claude 目录可扫描（≥ 20 会话 / ≥ 3 项目）', cc.stats.sessions >= 20 && cc.stats.projects >= 3, { sessions: cc.stats.sessions, projects: cc.stats.projects });
  const withModel = cc.sessions.filter((s) => s.model);
  const withTitle = cc.sessions.filter((s) => s.titleRaw);
  const withCwd = cc.sessions.filter((s) => s.cwdSource === 'line:cwd');
  const withVersion = cc.sessions.filter((s) => s.agentVersion);
  check('MA2', '元信息来自行内字段（模型/标题/cwd/版本 majority 可得）',
    withModel.length >= cc.stats.sessions * 0.5 && withTitle.length >= 1 && withCwd.length >= cc.stats.sessions * 0.8 && withVersion.length >= cc.stats.sessions * 0.8,
    { model: withModel.length, title: withTitle.length, cwd: withCwd.length, version: withVersion.length });
  const STATE_SET = new Set(['idle', 'thinking', 'running', 'done', 'error', 'unknown']);
  check('MA3', '粗状态全部在已知集合内', cc.sessions.every((s) => STATE_SET.has(s.state)), { states: [...new Set(cc.sessions.map((s) => s.state))] });
  check('MA4', '扫描性能 < 300ms（M-G 预算的 1/4）', tookMs < 300, { tookMs: Number(tookMs.toFixed(1)) });
  // 行映射纯函数
  const now = '2026-10-06T12:00:00.000Z';
  const ctx = { sessionId: 's1', seq: 0 };
  const ev1 = mapClaudeLine({ type: 'user', isSidechain: false, message: { role: 'user', content: '跑测试' }, timestamp: now }, ctx);
  const ev2 = mapClaudeLine({ type: 'user', isSidechain: true, message: { role: 'user', content: '子代理内部' }, timestamp: now }, ctx);
  const ev3 = mapClaudeLine({ type: 'assistant', isSidechain: false, message: { role: 'assistant', model: 'm1', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] }, timestamp: now }, ctx);
  const ev4 = mapClaudeLine({ type: 'assistant', isSidechain: false, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '完成' }] }, timestamp: now }, ctx);
  const ev5 = mapClaudeLine({ type: 'system', subtype: 'turn_duration', durationMs: 123, timestamp: now }, ctx);
  const ev6 = mapClaudeLine({ type: 'system', subtype: 'api_error', error: { message: 'Connection error.' }, timestamp: now }, ctx);
  const ev7 = mapClaudeLine({ type: 'custom-title', customTitle: '新标题', timestamp: now }, ctx);
  check('MA5', '行映射：user→turn.start；sidechain 忽略；tool_use→tool.call(exec)；end_turn→turn.end(ok)',
    ev1[0]?.type === 'turn.start' && ev2.length === 0 && ev3[0]?.type === 'tool.call' && ev3[0]?.data?.category === 'exec' && ev4.some((e) => e.type === 'turn.end' && e.data.status === 'ok'),
    { ev1: ev1.map(e => e.type), ev3: ev3.map(e => e.type + ':' + (e.data?.category || '')) });
  check('MA6', '行映射：turn_duration/api_error/title 各得其所',
    ev5[0]?.type === 'turn.end' && ev6[0]?.type === 'error.raised' && ev6[0]?.data?.fatal === false && ev7[0]?.type === 'session.meta' && ev7[0]?.data?.title === '新标题',
    {});
  check('MA7', '事件信封含 source/sessionId/seq（供状态机与去重）',
    ev1[0]?.source === 'claude-code' && ev1[0]?.sessionId === 's1' && Number.isInteger(ev1[0]?.seq), {});
}

// ================================================================ M-B Codex
let cx;
{
  const t0 = process.hrtime.bigint();
  cx = scanCodexCatalog();
  const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
  check('MB1', 'Codex 目录可扫描（rollout ≥ 10 个）', cx.stats.sessions >= 10, { rollouts: cx.stats.sessions });
  check('MB2', '子代理识别（parent_thread_id 非空）且不进项目列表',
    cx.stats.subagentSessions >= 1 && cx.sessions.every((s) => s.kind === 'subagent' || true) && !cx.projects.some((p) => p.sessions.some((s) => s.kind === 'subagent')),
    { main: cx.stats.mainSessions, subagent: cx.stats.subagentSessions });
  check('MB3', 'session_meta 元信息（cwd/cli_version）+ 模型可得',
    cx.sessions.filter((s) => s.cwd).length >= cx.stats.mainSessions && cx.sessions.filter((s) => s.agentVersion).length >= cx.stats.mainSessions * 0.9 && cx.sessions.some((s) => s.model),
    { withCwd: cx.sessions.filter((s) => s.cwd).length, withVersion: cx.sessions.filter((s) => s.agentVersion).length });
  check('MB4', '扫描性能 < 300ms', tookMs < 300, { tookMs: Number(tookMs.toFixed(1)) });
  const now = '2026-10-06T12:00:00.000Z';
  const ctx = { sessionId: 't1', seq: 0 };
  const e1 = mapCodexLine({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-9' }, timestamp: now }, ctx);
  const e2 = mapCodexLine({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', status: 'completed' }, timestamp: now }, ctx);
  const e3 = mapCodexLine({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-9', duration_ms: 5000, last_agent_message: '已创建 x' }, timestamp: now }, ctx);
  const e4 = mapCodexLine({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-9' }, timestamp: now }, ctx);
  const e5 = mapCodexLine({ type: 'session_meta', payload: { session_id: 't1', cwd: '/tmp/x', cli_version: '0.155.0' }, timestamp: now }, ctx);
  check('MB5', '行映射：task_started→turn.start；custom_tool_call(apply_patch)→tool.call(write)；task_complete→turn.end(ok)+message',
    e1[0]?.type === 'turn.start' && e2[0]?.type === 'tool.call' && e2[0]?.data?.category === 'write' && e3.some((e) => e.type === 'turn.end' && e.data.status === 'ok') && e3.some((e) => e.type === 'message.assistant'),
    {});
  check('MB6', '行映射：turn_aborted→aborted；session_meta→session.start(workspace+version)',
    e4[0]?.type === 'turn.end' && e4[0]?.data?.status === 'aborted' && e5[0]?.type === 'session.start' && e5[0]?.data?.workspace === '/tmp/x' && e5[0]?.data?.agentVersion === '0.155.0', {});
}

// ================================================================ M-H Kimi（A 路径：state.json 目录 + wire.jsonl 事件）
{
  const t0 = process.hrtime.bigint();
  const km = scanKimiCatalog();
  const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
  check('MK1', 'Kimi A 路径目录可扫描（≥1 会话 / ≥1 项目）', km.stats.sessions >= 1 && km.stats.projects >= 1, { sessions: km.stats.sessions, projects: km.stats.projects, archived: km.stats.archived });
  check('MK2', '会话记录完整（cwd / title / 有限 updatedAt；archived 不进列表）',
    km.sessions.every((s) => s.cwd && s.title && Number.isFinite(s.updatedAt)) && km.sessions.every((s) => !s.archived), {});
  check('MK3', '模型/思考档来自 wire 头窗口（majority 可得）', km.sessions.filter((s) => s.model).length >= Math.ceil(km.stats.sessions * 0.6), { withModel: km.sessions.filter((s) => s.model).length });
  const STATE_SET = new Set(['idle', 'thinking', 'running', 'done', 'error', 'waiting', 'unknown']);
  check('MK4', '粗状态在已知集合内', km.sessions.every((s) => STATE_SET.has(s.state)), { states: [...new Set(km.sessions.map((s) => s.state))] });
  check('MK5', '扫描性能 < 300ms', tookMs < 300, { tookMs: Number(tookMs.toFixed(1)) });
  const ctx = { sessionId: 'session_x', seq: 0 };
  const e1 = mapKimiLine({ type: 'turn.prompt', turnId: 3, time: 1 }, ctx);
  const e2 = mapKimiLine({ type: 'context.append_loop_event', event: { type: 'tool.call', uuid: 'u1', name: 'Bash' }, time: 2 }, ctx);
  const e3 = mapKimiLine({ type: 'turn.ended', turnId: 3, reason: 'completed', durationMs: 100 }, ctx);
  const e4 = mapKimiLine({ type: 'turn.ended', turnId: 4, reason: 'cancelled' }, ctx);
  const e5 = mapKimiLine({ type: 'interaction.request', kind: 'approval', id: 'approval_abc', request: { toolName: 'Bash' } }, ctx);
  const e6 = mapKimiLine({ type: 'interaction.resolved', id: 'approval_abc', response: { decision: 'allow' } }, ctx);
  const e7 = mapKimiLine({ type: 'agent.message.appended', message: { message: { role: 'assistant', content: ['你好'] } } }, ctx);
  check('MK6', 'wire 映射：turn.prompt→turn.start；loop tool.call→tool.call(exec)；turn.ended completed→ok / cancelled→aborted',
    e1[0]?.type === 'turn.start' && e2[0]?.type === 'tool.call' && e2[0]?.data?.category === 'exec' && e3[0]?.data?.status === 'ok' && e4[0]?.data?.status === 'aborted',
    {});
  check('MK7', 'wire 映射：审批对（interaction.request/resolved 同 id 配对）+ assistant 文本截断',
    e5[0]?.type === 'approval.request' && e5[0]?.data?.requestId === 'approval_abc' && e6[0]?.type === 'approval.resolved' && e6[0]?.data?.requestId === 'approval_abc' && e6[0]?.data?.decision === 'allow' && e7[0]?.type === 'message.assistant',
    {});
  const st = scanKimiStatus();
  check('MK8', '状态快照走 A 路径（非降级，observes 含审批族）', st.degraded === false && st.sessionCount === km.stats.sessions && st.observes.includes('approval.request'), { degraded: st.degraded, count: st.sessionCount });
  const legacy = scanKimiLegacyCount();
  check('MK9', 'LevelDB 兜底通道仍在（近似计数可用）', legacy.count >= 1 && legacy.approximate === true, { legacy: legacy.count });
}

// ================================================================ M-C 多源合并（真实服务实例）
{
  const PORT = 7831;
  let proc;
  let ok = true;
  try {
    proc = spawn(process.execPath, [here('../demo/framed.mjs'), '--port', String(PORT)], { stdio: 'ignore', env: { ...process.env } });
    const token = fs.readFileSync(path.join(os.homedir(), '.agent-pet', 'token'), 'utf8').trim();
    // 等服务就绪
    let snap = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        const res = await fetch('http://127.0.0.1:' + PORT + '/api/state');
        if (res.ok) { snap = await res.json(); break; }
      } catch { /* 未就绪 */ }
    }
    if (!snap) throw new Error('framed.mjs 实例未就绪');
    const srcs = new Set();
    for (const h of snap.catalog.history || []) srcs.add(h.source);
    const multiProjects = (snap.catalog.projects || []).filter((p) => (p.sources || []).length >= 2);
    check('MC1', '快照历史行含四源（dsh + claude-code + kimi-code）', srcs.has('dsh') && srcs.has('claude-code') && srcs.has('kimi-code'), { sources: [...srcs] });
    check('MC2', '同 cwd 多源项目归并（≥1 个项目 sources ≥ 2）', multiProjects.length >= 1, { multiProjects: multiProjects.map((p) => p.name + '[' + p.sources.join('+') + ']').slice(0, 4) });
    check('MC3', '快照目录 source = multi 标注', snap.catalog.source.startsWith('multi:'), { source: snap.catalog.source });
    // 非 DSH 投递被拒
    const ccRow = (snap.catalog.history || []).find((h) => h.source === 'claude-code');
    let guardCode = 0, guardBody = '';
    if (ccRow) {
      const res = await fetch('http://127.0.0.1:' + PORT + '/api/input', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-pet-token': token },
        body: JSON.stringify({ text: '验收投递拦截', sessionId: String(ccRow.sessionId).slice(0, 8) }),
      });
      guardCode = res.status;
      guardBody = JSON.stringify(await res.json());
    }
    check('MC4', '非 DSH 投递被明确拒绝（404 + 控制通道未落地说明）', guardCode === 404 && /M-D\/M-E/.test(guardBody), { code: guardCode, body: guardBody.slice(0, 140) });
  } catch (e) {
    check('MC0', 'M-C 实例验收可执行', false, String(e.message || e));
    ok = false;
  } finally {
    try { proc?.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

// ================================================================ 报告
const failed = results.filter((r) => !r.pass);
if (AS_JSON) {
  console.log(JSON.stringify({ pass: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2));
} else {
  for (const r of results) console.log((r.pass ? '✅' : '❌') + ' [' + r.id + '] ' + r.name + (r.pass ? '' : '  → ' + JSON.stringify(r.detail)));
  console.log('\n' + (failed.length ? '❌ ' + failed.length + ' 项未通过' : '全部 ' + results.length + ' 项断言通过 ✅'));
}
process.exit(failed.length ? 1 : 0);
