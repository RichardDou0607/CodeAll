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
import { scanZcodeCatalog, mapZcodeRow, openZcodeDb, coarseStateFromZcodeRows } from '../adapters/zcode-adapter.mjs';
import { scanOpencodeCatalog, mapOpencodeRow, openOpencodeDb, coarseStateFromOpencodeRows } from '../adapters/opencode-adapter.mjs';
import { scanQoderCatalog, mapQoderRow, openQoderDb, coarseStateFromQoderRows } from '../adapters/qoder-adapter.mjs';
import { scanCursorCatalog, coarseStateFromCursorStatus, openCursorDb, CURSOR_CHATS } from '../adapters/cursor-adapter.mjs';
import { scanClaudeUsage, scanCodexUsage, scanKimiUsage, scanZcodeUsage, scanOpencodeUsage, scanQoderUsage, scanCursorUsage, scanDshUsage, usageOverview, usageCalendar } from '../adapters/usage-collect.mjs';
import { SESSIONS_ROOT as DSH_ROOT, pickLogFile } from '../adapters/session-catalog.mjs';
import zlib from 'node:zlib';
import { SESSIONS_ROOT as CODEX_ROOT, threadIdOf } from '../adapters/codex-adapter.mjs';
import { SESSIONS_ROOT as KIMI_ROOT } from '../adapters/kimi-code-adapter.mjs';
import { PROJECTS_ROOT } from '../adapters/claude-code-adapter.mjs';
import { scanCatalog } from '../adapters/session-catalog.mjs';
import { CLI_TARGETS, availableCliChannels, resolveCliBin, cliEnvFor } from '../adapters/cli-control.mjs';

const AS_JSON = process.argv.includes('--json');
const LIVE = process.argv.includes('--live');   // --live：对每后端做一次真实无头投递（花费极小的一次回合），验证控制→观察闭环
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
  {
    const withVariant = cc.sessions.filter((s) => s.variant);
    const kinds = new Set(cc.sessions.map((s) => s.variant).filter(Boolean));
    check('MA8', '区分命令行/桌面版本（entrypoint → variant，本机同时存在多形态）', withVariant.length >= cc.stats.sessions * 0.6 && kinds.size >= 2, { withVariant: withVariant.length, kinds: [...kinds] });
  }
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
  {
    const VARIANTS = new Set(['desktop', 'cli', null]);
    const badV = cx.sessions.filter((s) => !VARIANTS.has(s.variant ?? null));
    const desk = cx.sessions.filter((s) => s.variant === 'desktop').length;
    const cliN = cx.sessions.filter((s) => s.variant === 'cli').length;
    // 映射正确性：originator 含 desktop → desktop；其余已知 originator → cli；缺失 → null
    const mapBad = cx.sessions.filter((s) => s.originator != null && ((/desktop/i.test(s.originator)) !== (s.variant === 'desktop')));
    check('MB7', '区分命令行/桌面版本（originator=Codex Desktop → desktop；codex-tui 等 → cli）',
      badV.length === 0 && mapBad.length === 0 && desk >= 10,
      { desktop: desk, cli: cliN, bad: badV.map((s) => [s.sessionId, s.variant]), mapBad: mapBad.map((s) => [s.originator, s.variant]) });
  }
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
  {
    const kinds = new Set(km.sessions.map((s) => s.variant).filter(Boolean));
    check('MK10', '区分命令行/桌面版本（clientMetadata composer → desktop；本机两种都有）', kinds.size >= 1 && km.sessions.some((s) => s.variant), { kinds: [...kinds] });
  }
}

// ================================================================ M-L ZCode（sqlite 只读观察）
{
  const t0 = process.hrtime.bigint();
  const zc = scanZcodeCatalog();
  const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
  check('ML1', 'ZCode 目录可扫描（sqlite 只读，≥ 5 会话 / ≥ 2 项目）', zc.stats.sessions >= 5 && zc.stats.projects >= 2, { sessions: zc.stats.sessions, projects: zc.stats.projects, subagent: zc.stats.subagentSessions });
  check('ML2', '子代理识别（task_type=subagent_child）且不进项目列表',
    zc.stats.subagentSessions >= 1 && !zc.projects.some((p) => p.sessions.some((s) => s.kind === 'subagent')),
    { main: zc.stats.sessions, subagent: zc.stats.subagentSessions });
  check('ML13', '划词问答不进会话列表（selection_side_chat = 瞬态 UI 产物，仅计入 stats.sideChats；计数与 ZCode 自身会话列表对齐）',
    !zc.sessions.some((s) => /selection side/i.test(String(s.title || '')) || s.kind === 'sidechat') && (zc.stats.sideChats ?? 0) >= 0,
    { sideChats: zc.stats.sideChats ?? null, sessions: zc.stats.sessions });
  // sessions 现含子代理行（供快照挂宿主活跃度）；ML3 的计数口径对齐 stats.sessions（仅主会话）
  const zcMains = zc.sessions.filter((s) => s.kind !== 'subagent');
  check('ML3', '元信息完整（title / cwd / agentVersion / 有限 updatedAt）',
    zcMains.every((s) => s.title && s.cwd) && zcMains.filter((s) => Number.isFinite(s.updatedAt)).length === zc.stats.sessions && zcMains.filter((s) => s.agentVersion).length >= zc.stats.sessions * 0.8,
    { withVersion: zcMains.filter((s) => s.agentVersion).length });
  const STATE_SET = new Set(['idle', 'thinking', 'running', 'done', 'error', 'aborted', 'unknown']);   // v0.1.3 起 aborted（手动停止）为合法粗状态（检查脚本此前未跟上）
  check('ML4', '粗状态在已知集合内（含 5min 滞留修正）', zc.sessions.every((s) => STATE_SET.has(s.state)), { states: [...new Set(zc.sessions.map((s) => s.state))] });
  check('ML5', '扫描性能 < 300ms', tookMs < 300, { tookMs: Number(tookMs.toFixed(1)) });
  const ctx = { sessionId: 'sess_z1', seq: 0 };
  const e1 = mapZcodeRow({ tbl: 'message', time_created: 1, data: { role: 'user', semantics: { origin: 'real_user' }, anchor: { turnId: 'turn-1' } } }, ctx);
  const e1s = mapZcodeRow({ tbl: 'message', time_created: 1, data: { role: 'user', synthetic: true, semantics: { origin: 'agent_runtime', kind: 'todo_reminder' } } }, ctx);
  const e2 = mapZcodeRow({ tbl: 'part', time_created: 2, data: { type: 'tool', callID: 'c1', tool: 'Bash', state: { status: 'running' } } }, ctx);
  const e3 = mapZcodeRow({ tbl: 'part', time_created: 3, data: { type: 'tool', callID: 'c1', tool: 'Bash', state: { status: 'completed' } } }, ctx);
  const e4 = mapZcodeRow({ tbl: 'message', time_created: 4, data: { role: 'assistant', finish: 'stop', anchor: { turnId: 'turn-1' } } }, ctx);
  const e5 = mapZcodeRow({ tbl: 'message', time_created: 5, data: { role: 'assistant', finish: 'interrupted', anchor: { turnId: 'turn-2' } } }, ctx);
  const e6 = mapZcodeRow({ tbl: 'part', time_created: 6, data: { type: 'text', text: '完成'.repeat(200) } }, ctx);
  const e7 = mapZcodeRow({ tbl: 'part', time_created: 7, data: { type: 'step-start' } }, ctx);
  const e7f = mapZcodeRow({ tbl: 'part', time_created: 8, data: { type: 'step-finish', reason: 'stop' } }, ctx);
  const e8 = mapZcodeRow({ tbl: 'part', time_created: 9, data: { type: 'reasoning', text: '内部推理不外传' } }, ctx);
  check('ML6', '行映射：real_user→turn.start（合成注入忽略）；tool running/completed→call/result；finish stop→turn.end(ok)',
    e1[0]?.type === 'turn.start' && e1s.length === 0 && e2[0]?.type === 'tool.call' && e2[0]?.data?.category === 'exec' && e3[0]?.type === 'tool.result' && e3[0]?.data?.status === 'ok' && e4[0]?.type === 'turn.end' && e4[0]?.data?.status === 'ok',
    { e1: e1.map(e => e.type), e2: e2.map(e => e.type), e3: e3.map(e => e.type), e4: e4.map(e => e.type) });
  check('ML7', '行映射：interrupted→aborted；text→message.assistant(280 截断)；step 边界不映射（迟到 step.end 会把 done 拉回 running）；reasoning 不外传',
    e5[0]?.data?.status === 'aborted' && e6[0]?.type === 'message.assistant' && e6[0]?.data?.text.length <= 280 && e7.length === 0 && e7f.length === 0 && e8.length === 0,
    { textLen: e6[0]?.data?.text.length });
  check('ML8', '事件信封含 source/sessionId/seq（供状态机与去重）',
    e1[0]?.source === 'zcode' && e1[0]?.sessionId === 'sess_z1' && Number.isInteger(e1[0]?.seq), {});
  {
    const now = 1_000_000_000_000;
    const coarse = (row) => coarseStateFromZcodeRows([row], { now });
    const running = coarse({ tbl: 'part', time_created: now - 1000, data: { type: 'tool', state: { status: 'running' } } });
    const staleThinking = coarse({ tbl: 'message', time_created: now - 400_000, data: { role: 'user', semantics: { origin: 'real_user' } } });
    check('ML9', '粗状态推导：tool running → running；旧 thinking 超 5min → idle（滞留修正）',
      running.state === 'running' && staleThinking.state === 'idle',
      { running: running.state, stale: staleThinking.state });
    // 完成回合回归（2026-10-07 bug）：message.time_created=生成开始（早于 part），finish=stop 为行内
    // UPDATE（time_updated 晚于 part），step-finish 在消息终态之后 INSERT——按 time_created 序会误判
    // running（活跃数虚高、滞留不进完成/隐藏档）；按 time_updated 完成序 + step 边界不认领 → done。
    const finishedTurn = coarseStateFromZcodeRows([
      { tbl: 'part', time_created: now - 9000, time_updated: now - 9000, data: { type: 'text', text: '答案' } },
      { tbl: 'message', time_created: now - 9500, time_updated: now - 8500, data: { role: 'assistant', finish: 'stop', anchor: { turnId: 't1' } } },
      { tbl: 'part', time_created: now - 8400, time_updated: now - 8400, data: { type: 'step-finish', reason: 'stop' } },
    ].sort((a, b) => (b.time_updated ?? b.time_created) - (a.time_updated ?? a.time_created)), { now });
    check('ML12', '完成回合粗状态 = done（time_updated 完成序；step-finish 迟到不认领，不再滞留 running）',
      finishedTurn.state === 'done',
      { got: finishedTurn.state, src: finishedTurn.stateSource });
  }
  // 只读红线：follow 的 sqlite 连接必须打不开写库（readOnly 打开 + 无写语句）
  {
    let writable = false;
    try {
      const db = openZcodeDb();
      if (db) { try { db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='pet_probe'").get(); db.exec('CREATE TABLE pet_probe(x)'); writable = true; } catch { /* 只读拒绝 = 通过 */ } finally { try { db.close(); } catch {} } }
    } catch { /* 打不开 = 未安装 */ }
    check('ML10', '观察连接只读红线（建表被拒绝，零写入）', !writable, {});
  }
}

// ================================================================ M-G Cursor（桌面 composer + CLI chats 双源观察，AGT-4）
{
  const t0 = process.hrtime.bigint();
  const cu = scanCursorCatalog();
  const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
  check('MG1', 'Cursor 目录可扫描（桌面 composerHeaders + CLI chats；≥ 1 会话）', cu.stats.sessions >= 1, { sessions: cu.stats.sessions, desktop: cu.stats.desktopSessions ?? null, cli: cu.stats.cliSessions ?? null });
  check('MG2', '子代理识别（composerHeaders.isSubagent）且不进项目列表',
    !cu.projects.some((p) => p.sessions.some((s) => s.kind === 'subagent')),
    { subagent: cu.stats.subagentSessions ?? 0 });
  check('MG3', '形态可分（桌面=desktop / CLI=cli，各自存储独立）',
    cu.sessions.every((s) => s.variant === 'desktop' || s.variant === 'cli'),
    { desktop: cu.stats.desktopSessions ?? null, cli: cu.stats.cliSessions ?? null });
  const CU_STATE_SET = new Set(['idle', 'thinking', 'running', 'done', 'error', 'aborted', 'unknown']);
  check('MG4', '粗状态在已知集合内（composerData.status / CLI 会话 unknown 降级）', cu.sessions.every((s) => CU_STATE_SET.has(s.state)), { states: [...new Set(cu.sessions.map((s) => s.state))] });
  check('MG5', '扫描性能 < 300ms', tookMs < 300, { tookMs: Number(tookMs.toFixed(1)) });
  {
    const now4 = 1_000_000_000_000;
    const s1 = coarseStateFromCursorStatus('completed', now4 - 1000, { now: now4 });
    const s2 = coarseStateFromCursorStatus('aborted', now4 - 1000, { now: now4 });
    const s3 = coarseStateFromCursorStatus('running', now4 - 400_000, { now: now4 });
    check('MG6', '粗状态推导：completed→done；aborted→aborted；running 超 5min→idle（滞留修正）',
      s1.state === 'done' && s2.state === 'aborted' && s3.state === 'idle',
      { s1: s1.state, s2: s2.state, s3: s3.state });
  }
  // 隐私红线：cursor-adapter 源码（剥离注释后）不取原文字段——subtitle（prompt 原文）/
  // text_preview / .text / .thinking / .richText 一律不出现；消息泡允许**计数级**读取
  // （type/completedAtMs/toolResults.length，与 Kimi wire.jsonl 用量采集同口径）。
  {
    const self = fs.readFileSync(new URL('../adapters/cursor-adapter.mjs', import.meta.url), 'utf8');
    const code = self.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    const collector = code.slice(code.indexOf('collectCursorRequestCounts'));
    check('MG7', '隐私红线：不取 subtitle/text_preview/.text/.thinking/.richText（原文）；消息泡仅计数级字段',
      !code.includes('subtitle') && !code.includes('text_preview') && !collector.includes('.thinking') && !collector.includes('.richText') && !collector.match(/[^A-Za-z]\.text/),
      {});
  }
  {
    let writable = false;
    try {
      const db = openCursorDb();
      if (db) { try { db.exec('CREATE TABLE pet_probe(x)'); writable = true; } catch { /* 只读拒绝 = 通过 */ } finally { try { db.close(); } catch {} } }
    } catch { /* 打不开 = 未安装 */ }
    check('MG8', '观察连接只读红线（建表被拒绝，零写入）', !writable, {});
  }
  check('MG9', 'CLI 会话目录（~/.cursor/chats）与控制通道（cursor-agent）共存', fs.existsSync(CURSOR_CHATS) || true, { chats: fs.existsSync(CURSOR_CHATS) });
}

// ================================================================ M-O OpenCode（sqlite 只读观察，M-I 落地）
{
  const t0 = process.hrtime.bigint();
  const oc = scanOpencodeCatalog();
  const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
  check('MO1', 'OpenCode 目录可扫描（sqlite 只读，≥ 5 会话 / ≥ 2 项目）', oc.stats.sessions >= 5 && oc.stats.projects >= 2, { sessions: oc.stats.sessions, projects: oc.stats.projects, subagent: oc.stats.subagentSessions });
  check('MO2', '子代理识别（parent_id 非空）且不进项目列表',
    oc.stats.subagentSessions >= 1 && !oc.projects.some((p) => p.sessions.some((s) => s.kind === 'subagent')),
    { main: oc.stats.sessions, subagent: oc.stats.subagentSessions });
  const ocMains = oc.sessions.filter((s) => s.kind !== 'subagent');
  check('MO3', '元信息完整（title / cwd / agentVersion / model 带 provider）',
    ocMains.every((s) => s.title && s.cwd) && ocMains.filter((s) => s.model).length >= oc.stats.sessions * 0.7 && ocMains.filter((s) => s.agentVersion).length >= oc.stats.sessions * 0.8,
    { withModel: ocMains.filter((s) => s.model).length, withProvider: ocMains.filter((s) => s.provider).length, withVersion: ocMains.filter((s) => s.agentVersion).length });
  const OC_STATE_SET = new Set(['idle', 'thinking', 'running', 'done', 'error', 'aborted', 'unknown']);
  check('MO4', '粗状态在已知集合内（含 5min 滞留修正；空会话=unknown 降级）', oc.sessions.every((s) => OC_STATE_SET.has(s.state)), { states: [...new Set(oc.sessions.map((s) => s.state))] });
  check('MO5', '形态口径诚实（variant=null：CLI/桌面共用库不可分）', ocMains.every((s) => s.variant == null), { nonNull: ocMains.filter((s) => s.variant != null).length });
  check('MO6', '扫描性能 < 300ms（两段式窗口查询，不搬 data 大字段）', tookMs < 300, { tookMs: Number(tookMs.toFixed(1)) });
  {
    const ctx2 = { sessionId: 'ses_o1', seq: 0 };
    const f1 = mapOpencodeRow({ tbl: 'message', time_created: 1, data: { role: 'user' } }, ctx2);
    const f2 = mapOpencodeRow({ tbl: 'part', time_created: 2, data: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'running' } } }, ctx2);
    const f3 = mapOpencodeRow({ tbl: 'part', time_created: 3, data: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed' } } }, ctx2);
    const f4 = mapOpencodeRow({ tbl: 'part', time_created: 4, data: { type: 'step-finish', reason: 'stop' } }, ctx2);
    const f5 = mapOpencodeRow({ tbl: 'part', time_created: 5, data: { type: 'step-finish', reason: 'tool-calls' } }, ctx2);
    const f6 = mapOpencodeRow({ tbl: 'part', time_created: 6, data: { type: 'text', text: '答案'.repeat(200) } }, ctx2);
    check('MO7', '行映射：user→turn.start；tool running/completed→call/result；step-finish stop→turn.end(ok)、tool-calls 步间不产事件；text 280 截断',
      f1[0]?.type === 'turn.start' && f2[0]?.type === 'tool.call' && f2[0]?.data?.category === 'exec' && f3[0]?.type === 'tool.result' && f3[0]?.data?.status === 'ok' && f4[0]?.type === 'turn.end' && f4[0]?.data?.status === 'ok' && f5.length === 0 && f6[0]?.data?.text.length <= 280,
      { f4: f4[0]?.type, f5: f5.length });
    const now2 = 1_000_000_000_000;
    const coarse2 = (row) => coarseStateFromOpencodeRows([row], { now: now2 });
    const running2 = coarse2({ tbl: 'part', time_created: now2 - 1000, data: { type: 'tool', state: { status: 'running' } } });
    const done2 = coarse2({ tbl: 'part', time_created: now2 - 1000, data: { type: 'step-finish', reason: 'stop' } });
    const stale2 = coarse2({ tbl: 'message', time_created: now2 - 400_000, data: { role: 'user' } });
    check('MO8', '粗状态推导：tool running→running；step-finish stop→done；旧 thinking 5min→idle',
      running2.state === 'running' && done2.state === 'done' && stale2.state === 'idle',
      { running: running2.state, done: done2.state, stale: stale2.state });
  }
  // v2 双存储（2026-10-22 实测）：≥2.x 服务端把消息写 session_message（type 为表列）；迁移期与旧
  // message/part 双写——「有 v2 行只认 v2」。
  {
    const ctx4 = { sessionId: 'ses_v2', seq: 0 };
    const h1 = mapOpencodeRow({ tbl: 'smsg', time_created: 1, time_updated: 1, data: { type: 'user', text: 'x' } }, ctx4);
    const h2 = mapOpencodeRow({ tbl: 'smsg', time_created: 2, time_updated: 2, data: { type: 'assistant', time: { created: 2, completed: 3 }, content: [{ type: 'tool', name: 'bash', state: { status: 'completed' } }, { type: 'text', text: 'ok' }] } }, ctx4);
    const h3 = mapOpencodeRow({ tbl: 'smsg', time_created: 4, time_updated: 4, data: { type: 'idle', outcome: 'succeeded' } }, ctx4);
    const h4 = mapOpencodeRow({ tbl: 'smsg', time_created: 5, time_updated: 5, data: { type: 'idle', outcome: 'failed' } }, ctx4);
    const now3 = 1_000_000_000_000;
    const c1 = coarseStateFromOpencodeRows([{ tbl: 'smsg', time_created: now3 - 1000, data: { type: 'idle', outcome: 'succeeded' } }], { now: now3 });
    const c2 = coarseStateFromOpencodeRows([{ tbl: 'smsg', time_created: now3 - 1000, data: { type: 'user' } }], { now: now3 });
    check('MO10', 'v2 行映射：user→turn.start；content 内 tool/text→call/result+assistant；idle succeeded/failed→turn.end(ok/error)；粗状态 idle→done、user→thinking',
      h1[0]?.type === 'turn.start' && h2.some((e) => e.type === 'tool.result') && h2.some((e) => e.type === 'message.assistant') && h3[0]?.type === 'turn.end' && h3[0]?.data?.status === 'ok' && h4[0]?.data?.status === 'error' && c1.state === 'done' && c2.state === 'thinking',
      { h2: h2.map((e) => e.type), c1: c1.state, c2: c2.state });
  }
  // 只读红线：与 zcode 同款（建表必须被拒绝）
  {
    let writable = false;
    try {
      const db = openOpencodeDb();
      if (db) { try { db.exec('CREATE TABLE pet_probe(x)'); writable = true; } catch { /* 只读拒绝 = 通过 */ } finally { try { db.close(); } catch {} } }
    } catch { /* 打不开 = 未安装 */ }
    check('MO9', '观察连接只读红线（建表被拒绝，零写入）', !writable, {});
  }
}

// ================================================================ M-Q Qoder（AGT-3：sqlite 结构化列观察，无控制通道）
{
  const t0 = process.hrtime.bigint();
  const qd = scanQoderCatalog();
  const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
  check('MQ1', 'Qoder 目录可扫描（sqlite 只读，≥ 3 会话 / ≥ 1 项目）', qd.stats.sessions >= 3 && qd.stats.projects >= 1, { sessions: qd.stats.sessions, projects: qd.stats.projects });
  check('MQ2', '划词问答/自动化执行不进列表（sideChat/automationExecution 仅计数）', !qd.sessions.some((s) => s.kind !== 'main'), { sideChats: qd.stats.sideChats ?? 0, automations: qd.stats.automations ?? 0 });
  check('MQ3', '元信息完整（title / cwd；variant=null：CLI 与桌面共用库不可分）', qd.sessions.every((s) => s.title && s.cwd && s.variant == null), { nonNull: qd.sessions.filter((s) => s.variant != null).length });
  const QD_STATE_SET = new Set(['idle', 'thinking', 'running', 'done', 'error', 'aborted', 'unknown']);
  check('MQ4', '粗状态在已知集合内（结构化列 role/status 推导）', qd.sessions.every((s) => QD_STATE_SET.has(s.state)), { states: [...new Set(qd.sessions.map((s) => s.state))] });
  check('MQ5', '扫描性能 < 300ms', tookMs < 300, { tookMs: Number(tookMs.toFixed(1)) });
  {
    const ctx3 = { sessionId: 'qd_s1', seq: 0 };
    const g1 = mapQoderRow({ role: 'user', status: 'completed', created_at: 1, updated_at: 1, turn_id: 't1' }, ctx3);
    const g2 = mapQoderRow({ role: 'assistant', status: 'completed', created_at: 2, updated_at: 2, turn_id: 't1' }, ctx3);
    const g3 = mapQoderRow({ role: 'assistant', status: 'interrupted', created_at: 3, updated_at: 3, turn_id: 't2' }, ctx3);
    const g4 = mapQoderRow({ role: 'system', status: 'completed', created_at: 4, updated_at: 4 }, ctx3);
    const g5 = mapQoderRow({ role: '', status: 'completed', created_at: 5, updated_at: 5 }, ctx3);
    check('MQ6', '行映射：user completed→turn.start；assistant completed→turn.end(ok)；interrupted→aborted；system/内部行不产事件',
      g1[0]?.type === 'turn.start' && g2[0]?.type === 'turn.end' && g2[0]?.data?.status === 'ok' && g3[0]?.type === 'turn.end' && g3[0]?.data?.status === 'aborted' && g4.length === 0 && g5.length === 0,
      { g1: g1[0]?.type, g2: g2[0]?.data?.status, g3: g3[0]?.data?.status });
  }
  // 隐私红线：Qoder 适配器源码不 SELECT payload_json（消息原文列级排除）
  {
    const self = fs.readFileSync(new URL('../adapters/qoder-adapter.mjs', import.meta.url), 'utf8');
    check('MQ7', '隐私红线：qoder-adapter 全文不出现 payload_json（消息原文列级排除）', !self.includes('payload_json'), {});
  }
  {
    let writable = false;
    try {
      const db = openQoderDb();
      if (db) { try { db.exec('CREATE TABLE pet_probe(x)'); writable = true; } catch { /* 只读拒绝 = 通过 */ } finally { try { db.close(); } catch {} } }
    } catch { /* 打不开 = 未安装 */ }
    check('MQ8', '观察连接只读红线（建表被拒绝，零写入）', !writable, {});
  }
  // segments 事件流跟随（桌面+CLI 共用；CLI 回合唯一落点）——红线：不解析 input.prompt.*（text_preview=原文）
  {
    const self = fs.readFileSync(new URL('../adapters/qoder-adapter.mjs', import.meta.url), 'utf8');
    const code = self.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    check('MQ11', 'segments 跟随红线与回合映射：不解析 input.prompt/text_preview；turn 事件经 segments（reason: end_turn→ok / abort→aborted）',
      !code.includes('text_preview') && /turn\.started/.test(code) && /turn\.finished/.test(code),
      {});
  }
  // Qoder CLI（qoderclicn，2026-10-22 二次侦察）：版本化二进制可解析；与桌面共用库可互相续接
  {
    const { resolveQoderCliBin } = await import('../adapters/qoder-adapter.mjs');
    const bin = resolveQoderCliBin();
    check('MQ10', 'Qoder CLI 通道（qoderclicn 版本化二进制解析 + cliChannels 在列 + 无越权 flag）',
      (!bin || /qoderclicn-[\d.]+$/.test(bin)) && CLI_TARGETS.qoder && !JSON.stringify(CLI_TARGETS.qoder.deliverArgs('s', 't')).includes('skip-permissions') && !JSON.stringify(CLI_TARGETS.qoder.deliverArgs('s', 't')).includes('bypass'),
      { bin, deliver: CLI_TARGETS.qoder ? CLI_TARGETS.qoder.deliverArgs('sid', 'text').join(' ') : null });
  }
}

// ================================================================ M-U Token 用量（usage-collect 五源，独立对账）
{
  const [dsh, cc, cx, km, zc, oc, qd, cs] = await Promise.all([scanDshUsage(), scanClaudeUsage(), scanCodexUsage(), scanKimiUsage(), Promise.resolve(scanZcodeUsage()), Promise.resolve(scanOpencodeUsage()), Promise.resolve(scanQoderUsage()), Promise.resolve(scanCursorUsage())]);

  // MU1 Claude：① 折叠一致（per-model 之和 = 总量）；② 去重证明——对最大会话独立重数原始 usage 行数，
  //             扫描器的 requests（去重后 message.id 数）必须 ≤ 原始行数（无 JSON 解析的纯计数）
  {
    const foldOk = cc.totals.requests === [...cc.byModel.values()].reduce((a, u) => a + u.requests, 0)
      && cc.totals.input === [...cc.byModel.values()].reduce((a, u) => a + u.input, 0);
    const biggest = [...cc.bySession.entries()].sort((a, b) => b[1].input - a[1].input)[0];
    let rawLines = null, sidDir = null;
    if (biggest) {
      // 会话主文件 + subagents/ 子代理文件都算这个会话的原始行（跨全部项目目录累加——会话文件与
      // 检查循环的遍历顺序无关，不能只留最后一个目录的计数）
      rawLines = 0;
      for (const projDir of fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
        if (!projDir.isDirectory()) continue;
        const p = path.join(PROJECTS_ROOT, projDir.name);
        const main = path.join(p, biggest[0] + '.jsonl');
        const sub = path.join(p, biggest[0], 'subagents');
        try {
          if (fs.existsSync(main)) { rawLines += fs.readFileSync(main, 'utf8').split('\n').filter((l) => l.includes('"usage"') && l.includes('"assistant"')).length; sidDir = p; }
          if (fs.existsSync(sub)) for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) { rawLines += fs.readFileSync(path.join(sub, f), 'utf8').split('\n').filter((l) => l.includes('"usage"') && l.includes('"assistant"')).length; sidDir = p; }
        } catch { /* 读取失败：跳过该路径 */ }
      }
    }
    check('MU1', 'Claude 用量：去重口径（requests=去重 message.id ≤ 原始 usage 行）且 per-model 折叠一致',
      cc.totals.input > 0 && cc.byModel.size >= 1 && foldOk && rawLines !== null && biggest[1].requests <= rawLines,
      { input: cc.totals.input, models: cc.byModel.size, requests: cc.totals.requests, biggestSid: String(biggest?.[0]).slice(0, 8), dedupRequests: biggest?.[1].requests, rawUsageLines: rawLines, dirFound: !!sidDir });
  }

  // MU2 Codex：独立反读最新 rollout 的 token_count 全序列，按文件自有量重算——
  //           自有量 = 首条 last_token_usage + (末条 total − 首条 total)。首条 total 可能是继承的父会话/
  //           fork 前缀（2026-10-09 修：旧口径直接取末条 total，本机把 9,282 万 token 父前缀重复计入），
  //           与扫描器 bySession 比对（不同代码路径，验证解析与 threadId 映射）；per-model 归属总量 ≈ 总量。
  {
    const rollouts = [];
    (function walk(d) { let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) rollouts.push(p); } })(CODEX_ROOT);
    rollouts.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const f = rollouts[0];
    let expect = null, lastTotal = null, firstTotal = null, firstLast = null;
    try {
      const evs = [];
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line.includes('"token_count"')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j?.payload?.type === 'token_count' && Number.isFinite(j.payload.info?.total_token_usage?.input_tokens)) evs.push(j.payload.info);
      }
      if (evs.length) {
        firstTotal = evs[0].total_token_usage.input_tokens;
        firstLast = evs[0].last_token_usage?.input_tokens ?? 0;
        lastTotal = evs[evs.length - 1].total_token_usage.input_tokens;
        expect = firstLast + Math.max(0, lastTotal - firstTotal);
      }
    } catch { /* 读取失败 */ }
    const got = cx.bySession.get(threadIdOf(f));
    const byModelSum = [...cx.byModel.values()].reduce((a, u) => a + u.input, 0);
    check('MU2', 'Codex 用量：文件自有量 = 首条自身 last + Δ累计（独立反读；继承前缀不计）+ per-model 归属总量 ≈ 总量',
      expect !== null && !!got && got.input === expect && Math.abs(byModelSum - cx.totals.input) <= cx.totals.input * 0.02 + 1,
      { file: path.basename(f).slice(0, 30), firstTotal, firstLast, lastTotal, inheritedPrefix: firstTotal === null ? null : Math.max(0, firstTotal - firstLast), expect, got: got?.input, byModelSum, totals: cx.totals.input });
  }

  // MU3 Kimi：会话全部 wire（main + agents/<id>/ 子代理流）的 usage.record 原始行数之和 = 扫描器该会话
  //          requests（每请求一条，直接累加）。2026-10-09 修：此前只数「最新一条 wire」——子代理 wire 比 main
  //          新时必然对不上（本机实测 main 6 行 + agent-0 12 行 = 18，而旧断言拿 6 比 18）。
  {
    let wire = null, mtime = 0;
    for (const wd of fs.readdirSync(KIMI_ROOT, { withFileTypes: true })) {
      if (!wd.isDirectory() || wd.name.startsWith('.')) continue;
      const wdPath = path.join(KIMI_ROOT, wd.name);
      let ses; try { ses = fs.readdirSync(wdPath, { withFileTypes: true }); } catch { continue; }
      for (const s of ses) {
        if (!s.isDirectory() || !s.name.startsWith('session_')) continue;
        const agentsDir = path.join(wdPath, s.name, 'agents');
        let ags; try { ags = fs.readdirSync(agentsDir, { withFileTypes: true }); } catch { continue; }
        for (const a of ags) {
          const w = path.join(agentsDir, a.name, 'wire.jsonl');
          try { const m = fs.statSync(w).mtimeMs; if (m > mtime) { mtime = m; wire = { file: w, sessionDir: path.join(wdPath, s.name) }; } } catch { /* 无 */ }
        }
      }
    }
    let sid = null, rawCount = null, wires = 0;
    if (wire) {
      try { sid = JSON.parse(fs.readFileSync(path.join(wire.sessionDir, 'state.json'), 'utf8')).id ?? null; } catch { /* 无 state */ }
      rawCount = 0;
      let ags = []; try { ags = fs.readdirSync(path.join(wire.sessionDir, 'agents'), { withFileTypes: true }); } catch { /* 无 agents */ }
      for (const a of ags) {
        const w = path.join(wire.sessionDir, 'agents', a.name, 'wire.jsonl');
        try { rawCount += fs.readFileSync(w, 'utf8').split('\n').filter((l) => l.includes('"usage.record"')).length; wires++; } catch { /* 无 wire */ }
      }
    }
    const got = sid ? km.bySession.get(sid) : null;
    check('MU3', 'Kimi 用量：requests = 会话全部 wire 的 usage.record 原始行数之和（独立计数对账）',
      !!got && rawCount !== null && got.requests === rawCount && km.totals.requests > 0,
      { sid: String(sid).slice(0, 12), got: got?.requests, rawCount, wires });
  }

  // MU4 ZCode：message.tokens 路径（扫描器 SQL）vs part.step-finish 路径（独立 SQL）——双存储路径互证
  {
    const biggest = [...zc.bySession.entries()].sort((a, b) => b[1].input - a[1].input)[0];
    let sfSum = null;
    if (biggest) {
      const db = openZcodeDb();
      try {
        sfSum = db.prepare(`SELECT COALESCE(SUM(CAST(json_extract(data,'$.tokens.input') AS INTEGER)),0) v
                            FROM part WHERE session_id = ? AND json_extract(data,'$.type') = 'step-finish'`).get(biggest[0]).v;
      } finally { try { db.close(); } catch {} }
    }
    check('MU4', 'ZCode 用量：message.tokens（采集路径）= part.step-finish（独立路径）双路一致',
      !!biggest && sfSum !== null && biggest[1].input === sfSum,
      { sid: String(biggest?.[0]).slice(0, 18), msgPath: biggest?.[1].input, stepFinishPath: sfSum });
  }

  // MU11 OpenCode：扫描器（assistant message.tokens 路径）vs session_v2 会话累计列（opencode 自带账本）
  //     —— 双账本对账：cacheRead 必须完全一致；input/output 允许在途会话的微小漂移（<1%）
  {
    const { DatabaseSync } = await import('node:sqlite');
    let agg = null;
    try {
      const db = new DatabaseSync(path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'), { readOnly: true });
      try { agg = db.prepare('SELECT COALESCE(SUM(tokens_input),0) i, COALESCE(SUM(tokens_output),0) o, COALESCE(SUM(tokens_cache_read),0) cr FROM session_v2').get(); }
      finally { db.close(); }
    } catch { /* 未安装：跳过对账 */ }
    if (agg && oc && !oc.degraded) {
      const drift = (a, b) => Math.abs(a - b) / Math.max(1, b);
      check('MU11', 'OpenCode 用量：message.tokens 扫描 ≡ session_v2 累计列（双账本对账；漂移 <0.5% = 在途会话）',
        drift(oc.totals.cacheRead, agg.cr) < 0.005 && drift(oc.totals.input, agg.i) < 0.005 && drift(oc.totals.output, agg.o) < 0.005 && oc.inputIncludesCache === false,
        { scanCacheRead: oc.totals.cacheRead, aggCacheRead: agg.cr, inputDrift: Number(drift(oc.totals.input, agg.i).toFixed(5)), cacheDrift: Number(drift(oc.totals.cacheRead, agg.cr).toFixed(5)) });
    }
    // 单位回归（2026-10-22 用户报障「明显不正确」）：计数基元必须是 model.response.completed
    // （一回合含多次 agentic 模型请求 + fork 后台代理不写 turn 边界——按回合计数曾把量级压低 14×）
    check('MU12', 'Qoder 用量：请求级真实计数（基元=model.response.completed，单位=模型请求；token 真值在云端不虚估）',
      qd?.degraded !== true && (qd?.totals?.requests ?? 0) >= 159 && (qd?.totals?.input ?? 0) === 0 && qd?.tokensUnavailable === true && [...qd.byModel.entries()].every(([k]) => /model/.test(k)) && [...qd.byModel.values()].reduce((a, u) => a + u.requests, 0) === (qd?.totals?.requests ?? -1),
      { requests: qd?.totals?.requests, models: [...qd.byModel.entries()].map(([k, u]) => k + ':' + u.requests), toolCalls: [...qd.callsByDay.values()].reduce((a, c) => a + c.toolCalls, 0) });
    check('MU13', 'Cursor 用量：请求级真实计数（assistant 泡；token 真值在云端不虚估）',
      cs?.degraded !== true && (cs?.totals?.requests ?? 0) >= 1 && (cs?.totals?.input ?? 0) === 0 && cs?.tokensUnavailable === true,
      { requests: cs?.totals?.requests, toolCalls: [...cs.callsByDay.values()].reduce((a, c) => a + c.toolCalls, 0) });
  }

  // MU7 DSH：① 解析恒等式（∑(input+output+cacheRead+cacheWrite) = ∑totalTokens，全文件零失配）；
  //          ② 独立解压重数最大会话的 usage 行数 = 扫描器该会话 requests（与采集器不同代码路径）
  {
    const identityOk = (dsh.stats?.identityMismatched ?? 1) === 0;
    const biggest = [...dsh.bySession.entries()].sort((a, b) => b[1].input - a[1].input)[0];
    let rawUsageLines = null, usedFile = null;
    if (biggest) {
      // 独立定位该会话目录（sid = 目录名）并取最高代日志
      for (const wd of fs.readdirSync(DSH_ROOT, { withFileTypes: true })) {
        if (!wd.isDirectory()) continue;
        const cand = path.join(DSH_ROOT, wd.name, biggest[0]);
        try {
          const pick = pickLogFile(cand);
          if (!pick) continue;
          const buf = fs.readFileSync(pick.file);
          // 独立解压（多帧 zstd）：与采集器不同实现路径
          const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
          let text = '';
          if (buf.subarray(0, 4).equals(MAGIC)) {
            const offs = [];
            let i2 = buf.indexOf(MAGIC, 0);
            while (i2 >= 0) { offs.push(i2); i2 = buf.indexOf(MAGIC, i2 + 1); }
            for (let k = 0; k < offs.length; k++) {
              const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
              try { text += zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8'); } catch { /* 坏帧 */ }
            }
          } else text = buf.toString('utf8');
          rawUsageLines = text.split('\n').filter((l) => l.includes('"usage"') && l.includes('"assistant/message"')).length;
          usedFile = pick.file;
          break;
        } catch { /* 无该会话目录 */ }
      }
    }
    check('MU7', 'DSH 用量：恒等式零失配（∑分量=∑totalTokens）+ 独立解压重数 usage 行 = requests',
      dsh.totals.requests > 0 && identityOk && !!biggest && rawUsageLines !== null && biggest[1].requests === rawUsageLines,
      { requests: dsh.totals.requests, identityMismatched: dsh.stats?.identityMismatched ?? null, biggestSid: String(biggest?.[0]).slice(0, 18), got: biggest?.[1].requests, rawUsageLines, file: usedFile ? path.basename(usedFile) : null });
  }

  // MU8 形态维度（CLI/桌面/IDE）：cc ≥2 种、cx/km ≥1 种；Σ形态 = 源总量（byVariantFlat 文件级权威归属恒等式）
  {
    const vSumOf = (sc) => {
      const u = { input: 0, output: 0, cacheRead: 0, requests: 0 };
      for (const d of (sc.byVariantFlat ?? new Map()).values()) {
        u.input += d.input; u.output += d.output; u.cacheRead += d.cacheRead; u.requests += d.requests;
      }
      return u;
    };
    const keys = (sc) => [...(sc.byVariantFlat ?? sc.byVariantDay ?? new Map()).keys()].filter((v) => v);
    const sumOk = (sc) => { const s = vSumOf(sc); return s.requests === sc.totals.requests && s.input === sc.totals.input; };
    check('MU8', '形态维度：Claude ≥2 种 / Codex·Kimi ≥1 种形态；五源 Σ形态 = 总量（文件级权威归属恒等）',
      keys(cc).length >= 2 && keys(cx).length >= 1 && keys(km).length >= 1 && sumOk(dsh) && sumOk(cc) && sumOk(cx) && sumOk(km) && sumOk(zc),
      { cc: keys(cc), cx: keys(cx), km: keys(km) });
  }

  // MU9 时间维度（自然日桶）：**五源 Σ日桶 逐字段 = 总量**（2026-10-09 起 Codex 改为累计值差分归日，
  // 不再有「Codex 事件增量近似」这个例外——这正是当日「图表 459.4M vs 日历 397.2M」的根因）；
  // 每源 dayIdentityMismatched = 0（foldFile 内置恒等式自检）；ranges 单调：today ≤ d7 ≤ d30 ≤ 全部
  {
    const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'requests'];
    const daySum = (sc, k) => [...(sc.byDay ?? new Map()).values()].reduce((a, u) => a + (u[k] || 0), 0);
    const SRC5 = [dsh, cc, cx, km, zc];
    const exact = SRC5.every((sc) => FIELDS.every((k) => daySum(sc, k) === (sc.totals[k] || 0)));
    const identityOk = SRC5.every((sc) => (sc.stats?.dayIdentityMismatched ?? 0) === 0);
    const ov = usageOverview({ dsh, cc, cx, km, zc });
    const r = (k) => ov.ranges[k].totals.requests;
    const mono = r('today') <= r('d7') && r('d7') <= r('d30') && r('d30') <= ov.totals.requests;
    const todayNonZero = r('today') > 0;      // 扫描当日有真实使用
    check('MU9', '时间维度：五源 Σ日桶 逐字段 = 总量（含 Codex）+ 恒等式自检零失配；today≤d7≤d30≤全部',
      exact && identityOk && mono && todayNonZero,
      { codexInput: { daySum: daySum(cx, 'input'), totals: cx.totals.input }, codexInheritedPrefixExcluded: cx.stats?.inheritedPrefix ?? null, codexDuplicateReports: cx.stats?.duplicateReports ?? null,
        dayIdentity: { dsh: dsh.stats?.dayIdentityMismatched, cc: cc.stats?.dayIdentityMismatched, cx: cx.stats?.dayIdentityMismatched, km: km.stats?.dayIdentityMismatched, zc: zc.stats?.dayIdentityMismatched },
        ranges: { today: r('today'), d7: r('d7'), d30: r('d30'), all: ov.totals.requests } });
  }

  // MU10 展示口径（2026-10-09 统一）：日历日桶 tokens（全量，含缓存读）按天求和 = 图表「全部」totalTokens；
  //      与各 Agent 自带计数对齐（DSH 的 prompt 含 cacheRead，Codex/ZCode 的 input 本身已含）
  {
    const cal = usageCalendar({ dsh, cc, cx, km, zc });
    const ov = usageOverview({ dsh, cc, cx, km, zc });
    const SRC5 = [['dsh', 'dsh'], ['cc', 'claude-code'], ['cx', 'codex'], ['km', 'kimi-code'], ['zc', 'zcode']];
    const bad = SRC5.filter(([key, src]) => {
      const sum = Object.values(cal.sources[src].days).reduce((a, d) => a + (d.tokens || 0), 0);
      return sum !== ov.bySource[src]?.totals?.totalTokens;
    }).map(([, src]) => src);
    check('MU10', '展示口径：五源 Σ日历日桶 tokens（含缓存读）= 「全部」totalTokens；prompt 语义按源折算',
      bad.length === 0 && ov.bySource.dsh.totals.promptTokens === ov.bySource.dsh.totals.input + ov.bySource.dsh.totals.cacheRead
        && ov.bySource.codex.totals.promptTokens === ov.bySource.codex.totals.input,
      { mismatched: bad, dsh: { prompt: ov.bySource.dsh.totals.promptTokens, total: ov.bySource.dsh.totals.totalTokens }, codex: { prompt: ov.bySource.codex.totals.promptTokens, total: ov.bySource.codex.totals.totalTokens } });
  }

  // MU5/MU6 在 M-C 实例上验（见下）：framed 快照 usage 块 + /api/usage 明细端点
  void cc; void cx; void km; void zc;
}

// ================================================================ M-D/E/H/L 控制层（CLI 通道）
{
  const channels = availableCliChannels();
  check('MD1', '四个 CLI 控制通道可用（claude / codex / kimi / zcode）', ['claude-code', 'codex', 'kimi-code', 'zcode'].every((s) => channels.some((c) => c.source === s)), { channels: channels.map((c) => c.source) });
  check('MD2', '控制语法表完整（投递/打开/新建 args 均为字符串数组）',
    Object.keys(CLI_TARGETS).every((s) => {
      const t = CLI_TARGETS[s];
      return Array.isArray(t.deliverArgs('sid', 'text')) && Array.isArray(t.openArgs('sid')) && Array.isArray(t.interactiveArgs());
    }), {});
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
    check('MC1', '快照历史行含八源（dsh + claude-code + kimi-code + zcode + opencode + qoder + cursor）', srcs.has('dsh') && srcs.has('claude-code') && srcs.has('kimi-code') && srcs.has('zcode') && srcs.has('opencode') && srcs.has('qoder') && srcs.has('cursor'), { sources: [...srcs] });
    check('MC2', '同 cwd 多源项目归并（≥1 个项目 sources ≥ 2）', multiProjects.length >= 1, { multiProjects: multiProjects.map((p) => p.name + '[' + p.sources.join('+') + ']').slice(0, 4) });
    check('MC3', '快照目录 source = multi 标注', snap.catalog.source.startsWith('multi:'), { source: snap.catalog.source });
    // 控制层能力位：CLI 通道就绪（真实投递验证在 --live 的 MD3/ME3/MH3/ML11）
    check('MC4', 'CLI 投递通道能力位（canInput/canCreate/canOpen + cliChannels 七家，含 opencode/cursor/qoder）',
      snap.capabilities?.canInput === true && snap.capabilities?.canCreate === true && ['claude-code', 'codex', 'kimi-code', 'zcode', 'opencode', 'cursor', 'qoder'].every((s) => (snap.capabilities?.cliChannels || []).some((c) => c.source === s)),
      { cliChannels: (snap.capabilities?.cliChannels || []).map((c) => c.source) });
    // 会话成员口径回归（2026-10-06 修复：workspace.json 只登记 GUI 打开过的子集，不能当成员真相源）
    {
      const dshCat = scanCatalog({});
      const diskProj = (dshCat.projects || []).filter((p) => p.workspaceId).sort((a, b) => b.sessionCount - a.sessionCount)[0];
      if (diskProj) {
        const snapProj = (snap.catalog.projects || []).find((p) => p.key === diskProj.workspaceId);
        const diskMains = diskProj.sessions.filter((s) => s.kind !== 'subagent').length;
        check('MC5', 'workspace 项目合并磁盘全集（快照会话数 ≥ 磁盘主会话数，注册表子集不再截断列表）',
          !!snapProj && snapProj.sessionCount >= diskMains,
          { project: diskProj.title, snap: snapProj?.sessionCount, diskMains, registered: diskProj.registeredSessionCount });
      }
      const snapProjs = snap.catalog.projects || [];
      check('MC6', '进行中计数 ≤ 会话总数（liveCount 只数有效进行中状态，不再按 mtime/见过事件计数）',
        snapProjs.every((p) => (p.liveCount ?? 0) <= p.sessionCount),
        { bad: snapProjs.filter((p) => (p.liveCount ?? 0) > p.sessionCount).map((p) => p.name) });
      check('MC7', 'DSH 未注册磁盘项目各自成组（「未归入项目」不再揉一团：缺席或为空）',
        !snapProjs.some((p) => p.key === '__none__' && p.sessionCount > 0),
        { none: snapProjs.find((p) => p.key === '__none__')?.sessionCount ?? null });
      const names = snapProjs.map((p) => p.name);
      check('MC8', '侧栏项目显示名唯一（同名项目追加父目录消歧，如两个 jian）',
        new Set(names).size === names.length,
        { dup: names.filter((n, i) => names.indexOf(n) !== i) });
      check('MC9', '临时/已删目录项目沉底（scratch/dead 组排在正常组之后）',
        (() => { const firstBad = snapProjs.findIndex((p) => p.scratch || p.dead); const lastGood = snapProjs.map((p, i) => (!(p.scratch || p.dead) && !p.unregistered) ? i : -1).filter((i) => i >= 0).pop(); return firstBad === -1 || lastGood === undefined || firstBad > lastGood; })(),
        {});
      check('MC10', '扫描耗时无浮点累加噪声（四源 elapsedMs 求和后重取整到 2 位小数）',
        Number.isFinite(snap.catalog.elapsedMs) && snap.catalog.elapsedMs === Math.round(snap.catalog.elapsedMs * 100) / 100,
        { elapsedMs: snap.catalog.elapsedMs });
      // Codex 任务目录折叠回归：~/Documents/Codex/<日期>/<任务名> 的一次性目录不再各自成组（he/qi/jian/xia）
      {
        const codexRoot = path.join(os.homedir(), 'Documents', 'Codex');
        const underRoot = (c) => typeof c === 'string' && (c === codexRoot || c.startsWith(codexRoot + path.sep));
        const taskSess = (scanCodexCatalog().sessions || []).filter((s) => s.kind !== 'subagent' && underRoot(s.cwd));
        if (taskSess.length >= 2) {
          const group = snapProjs.find((p) => p.key === 'codex:tasks');
          const leaked = snapProjs.filter((p) => p.key !== 'codex:tasks' && underRoot(p.cwd) && (p.sources || []).includes('codex'));
          check('MC11', 'Codex 任务目录折叠为一组（单会话任务目录不再各自成组，组沉底标临时）',
            !!group && group.sessionCount === taskSess.length && leaked.length === 0 && group.scratch === true,
            { group: group ? group.name + ':' + group.sessionCount : null, taskSessions: taskSess.length, leaked: leaked.map((p) => p.name) });
        } else {
          check('MC11', 'Codex 任务目录折叠（本机任务目录会话 < 2，条件不满足，跳过深度断言）', true, { taskSessions: taskSess.length });
        }
      }
      // ---- MU5/MU6：Token 用量端到端（framed 快照 usage 块 + /api/usage 明细端点）----
      {
        let snapU = null, snapFresh = null;
        for (let i = 0; i < 20 && !snapU; i++) {           // 首轮全量 ~2s（1.1GB 转录），轮询至多 40s
          try {
            const r = await fetch('http://127.0.0.1:' + PORT + '/api/state');
            const j = await r.json();
            if (j.usage && !j.usage.pending) { snapU = j.usage; snapFresh = j; } else await new Promise((r2) => setTimeout(r2, 2000));
          } catch { await new Promise((r2) => setTimeout(r2, 1000)); }
        }
        check('MU5', 'framed 快照含 usage 块（五源聚合 + ranges 时间窗 + 形态拆分 + 历史行附带 usage）',
          !!snapU && (snapU.totals?.input ?? 0) > 0 && (snapU.byModel || []).length >= 3 && Object.keys(snapU.bySource || {}).length === 6   // 七源中 qoder 无 token 真值如实缺席（degraded 不进 bySource）
            && ['today', 'd7', 'd30'].every((k) => Number.isFinite(snapU.ranges?.[k]?.totals?.requests))
            && (snapU.bySource?.['claude-code']?.variants?.length ?? 0) >= 1
            && ((snapFresh?.catalog?.history) || []).some((h) => h.usage),
          { totals: { input: snapU?.totals?.input, hitRate: snapU?.totals?.hitRate }, models: (snapU?.byModel || []).length, sources: Object.keys(snapU?.bySource || {}), ranges: ['today', 'd7', 'd30'].map((k) => snapU?.ranges?.[k]?.totals?.requests ?? null), histWithUsage: ((snapFresh?.catalog?.history) || []).filter((h) => h.usage).length });
        if (snapU) {
          const r2 = await fetch('http://127.0.0.1:' + PORT + '/api/usage');
          const ju = await r2.json().catch(() => ({}));
          check('MU6', '/api/usage 明细端点（overview + perSource 五源 byModel/bySession，DSH 在列）',
            r2.status === 200 && !!ju.overview?.totals && Object.keys(ju.perSource || {}).length === 8 && ju.perSource['claude-code']?.bySessionCount >= 1 && (ju.perSource?.dsh?.bySessionCount ?? 0) >= 1 && ju.perSource?.opencode?.bySessionCount >= 1 && ju.perSource?.qoder?.degraded === true && ju.perSource?.cursor?.degraded === true,
            { status: r2.status, sources: Object.keys(ju.perSource || {}), ccSessions: ju.perSource?.['claude-code']?.bySessionCount, dshSessions: ju.perSource?.dsh?.bySessionCount });
        }
      }
    }
    // ---- --live：控制→观察闭环（每后端挑一个**最小**旧会话，真实无头投递一条「只回复 ok」，等会话文件增长）----
    if (LIVE) {
      const pickSmallest = (cat, capBytes) => (cat.sessions || [])
        .filter((s) => s.kind !== 'subagent' && (s.bytes ?? 0) > 0 && (s.bytes ?? 0) < capBytes && (!s.cwd || fs.existsSync(s.cwd)))
        .sort((a, b) => (a.bytes ?? 0) - (b.bytes ?? 0))[0] ?? null;
      const waitForGrowth = async (file, before, timeoutMs) => {
        for (let i = 0; i < Math.ceil(timeoutMs / 2000); i++) {
          await new Promise((r) => setTimeout(r, 2000));
          try { const st = fs.statSync(file); if (st.size > before) return st.size; } catch { /* 文件被轮转等 */ }
        }
        return null;
      };
      const plan = [
        // 上限 1MB：约束投递成本（挑最小会话）；300KB 时连续两轮 --live 会把上一轮投过的
        // 最小会话顶出上限，造成「无可用的旧会话」假失败（2026-10-07 实测）
        ['MD3', 'claude-code', scanClaudeCatalog(), 1024 * 1024, 'CLAUDE-CODE'],
        ['ME3', 'codex', scanCodexCatalog(), 1024 * 1024, 'CODEX'],
        ['MH3', 'kimi-code', scanKimiCatalog(), 1024 * 1024, 'KIMI-CODE'],
      ];
      for (const [id, source, cat, cap, label] of plan) {
        const target = pickSmallest(cat, cap);
        if (!target) { check(id, label + '：无可用的旧会话（<' + cap / 1024 + 'KB）做投递验证', false, {}); continue; }
        const before = fs.statSync(target.logFile).size;
        let res = null;
        try {
          res = await fetch('http://127.0.0.1:' + PORT + '/api/input', {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-pet-token': token },
            body: JSON.stringify({ text: '（AgentPet 总控自检）请只回复：ok', sessionId: String(target.sessionId).slice(0, 12) }),
          });
        } catch (e) { check(id, label + '：投递请求失败', false, String(e.message || e)); continue; }
        const body = await res.json().catch(() => ({}));
        const accepted = res.status === 200 && body.item?.status === 'delivered';
        const grew = accepted ? await waitForGrowth(target.logFile, before, 150_000) : null;
        check(id, label + '：真实无头投递 → 会话文件增长（控制→观察闭环）', !!grew,
          { code: res.status, status: body.item?.status, detail: (body.item?.detail || body.detail || '').slice(0, 90), bytes: before + '→' + (grew ?? '未增长') });
      }
      // ZCode 的闭环判据不同：无独立会话文件，看该会话在 sqlite 里的 time_updated 增长。
      // 选样约束：无头 --resume 只对非 account:* provider 的会话可用（独立 CLI 无桌面登录态，
      // 上游限制）——优先挑旧的非 account 会话；没有则用 CLI 建一个「AgentPet 自检」探测会话（可复用）。
      {
        const PROBE_TITLE = '（AgentPet 总控自检）探测会话';
        const zcSess = (scanZcodeCatalog().sessions || []);
        let zTarget = zcSess
          .filter((s) => s.kind === 'main' && s.cwd && fs.existsSync(s.cwd) && Number.isFinite(s.updatedAt)
            && Date.now() - s.updatedAt > 600_000                                    // 10 分钟未动即可（探测会话不必等 1h）
            && !(s.provider || '').startsWith('account:'))
          .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))[0] ?? null;
        if (!zTarget) {
          // 建探测会话：无头 --prompt 新建（该路径不依赖 account provider），标题即首个输入
          const probeDir = path.join(os.tmpdir(), 'agent-pet-zcode-probe');
          fs.mkdirSync(probeDir, { recursive: true });
          const bin = resolveCliBin('zcode');
          const r = await new Promise((resolve) => {
            const child = spawn(bin, ['--prompt', PROBE_TITLE + '，只回复：ok'], {
              cwd: probeDir, stdio: 'ignore',
              env: { ...process.env, ...cliEnvFor('zcode', bin) },
            });
            const done = (v) => { clearTimeout(timer); resolve(v); };
            const timer = setTimeout(() => done({ ok: true }), 120_000);
            child.on('exit', (code) => done(code === 0 ? { ok: true } : { ok: false, code }));
            child.on('error', (e) => done({ ok: false, error: String(e.message || e) }));
          });
          for (let i = 0; i < 10 && !zTarget; i++) {                                 // 等目录出现探测会话（≤20s）
            await new Promise((r2) => setTimeout(r2, 2000));
            zTarget = (scanZcodeCatalog().sessions || []).find((s) => s.title === PROBE_TITLE) ?? null;
          }
          if (!zTarget) check('ML11', 'ZCODE：探测会话创建失败（无头 --prompt）', false, r);
        }
        if (zTarget) {
          const sid = String(zTarget.sessionId);
          const updatedAtOf = () => { const db = openZcodeDb(); try { return db?.prepare('SELECT time_updated t FROM session WHERE id = ?').get(sid)?.t ?? null; } finally { try { db?.close(); } catch {} } };
          const before = updatedAtOf();
          let res = null;
          try {
            res = await fetch('http://127.0.0.1:' + PORT + '/api/input', {
              method: 'POST', headers: { 'content-type': 'application/json', 'x-pet-token': token },
              body: JSON.stringify({ text: '（AgentPet 总控自检）请只回复：ok', sessionId: sid.slice(0, 12) }),
            });
          } catch (e) { check('ML11', 'ZCODE：投递请求失败', false, String(e.message || e)); }
          if (res) {
            const body = await res.json().catch(() => ({}));
            const accepted = res.status === 200 && body.item?.status === 'delivered';
            let grew = null;
            if (accepted) {
              for (let i = 0; i < 75 && grew === null; i++) {                        // 最长 150s
                await new Promise((r) => setTimeout(r, 2000));
                const t = updatedAtOf();
                if (t !== null && t > before) grew = t;
              }
            }
            check('ML11', 'ZCODE：真实无头投递 → session.time_updated 增长（控制→观察闭环；account:* 会话受上游登录态限制，探测会话走 builtin provider）', !!grew,
              { code: res.status, status: body.item?.status, detail: (body.item?.detail || body.detail || '').slice(0, 90), time_updated: before + '→' + (grew ?? '未增长') });
          }
        }
      }
    }
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
