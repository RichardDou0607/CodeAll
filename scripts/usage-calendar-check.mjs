#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import {
  exportCheckpoint, loadCheckpoint, resetCaches,
  scanClaudeUsage, scanCodexUsage, scanDshUsage, scanKimiUsage, scanZcodeUsage,
  usageCalendar, serializeUsageScan,
} from '../adapters/usage-collect.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-calendar-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const beforeMidnight = new Date(2026, 0, 31, 23, 59).getTime();
const afterMidnight = new Date(2026, 1, 1, 0, 1).getTime();
const iso = t => new Date(t).toISOString();
const write = (file, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
};
const counts = (scan, day) => scan.callsByDay.get(day);

test('Claude: deduplicate streaming snapshots, count tools-only days and subagents', async () => {
  const ccRoot = path.join(root, 'claude');
  const file = path.join(ccRoot, 'project', 'main.jsonl');
  const call = { type: 'tool_use', id: 'tool-1', name: 'mcp__browser__open' };
  const assistant = (timestamp, content) => ({ type: 'assistant', timestamp, message: { id: 'msg', content } });
  write(file, [
    assistant(iso(beforeMidnight), [call]),
    assistant(iso(afterMidnight), [call, { type: 'tool_use', id: 'tool-2', name: 'Bash' }]),
    { type: 'user', timestamp: iso(afterMidnight), message: { content: [call] } },
    assistant(undefined, [{ type: 'tool_use', id: 'undated', name: 'Read' }]),
  ]);
  write(path.join(ccRoot, 'project', 'main', 'subagents', 'agent-1.jsonl'), [
    assistant(iso(afterMidnight), [{ type: 'tool_use', id: 'sub-1', name: 'mcp.server.query' }]),
  ]);
  const scan = await scanClaudeUsage({ root: ccRoot });
  assert.deepEqual(counts(scan, 20260131), { toolCalls: 1, mcpCalls: 1 });
  assert.deepEqual(counts(scan, 20260201), { toolCalls: 2, mcpCalls: 1 });
  assert.equal(scan.bySession.size, 1);
  assert.equal(scan.totals.requests, 0);
  assert.equal(scan.stats.undatedCalls, 1);
  const cached = await scanClaudeUsage({ root: ccRoot });
  assert.equal(cached.stats.cachedFiles, 2);
  assert.deepEqual([...cached.callsByDay], [...scan.callsByDay]);
  fs.appendFileSync(file, JSON.stringify(assistant(iso(afterMidnight), [{ type: 'tool_use', id: 'new', name: 'Write' }])) + '\n');
  const grown = await scanClaudeUsage({ root: ccRoot });
  assert.deepEqual(counts(grown, 20260201), { toolCalls: 3, mcpCalls: 1 });
  assert.equal(grown.stats.cachedFiles, 1);
  assert.equal(usageCalendar({ cc: scan }).sources['claude-code'].partial, true);
});

test('Codex: only call records count; explicit MCP namespace, custom tools, and call_id dedupe', async () => {
  const cxRoot = path.join(root, 'codex');
  const item = (payload, timestamp = iso(afterMidnight)) => ({ type: 'response_item', timestamp, payload });
  write(path.join(cxRoot, 'rollout-2026-02-01T00-00-00-1a0d4099-8bc7-4d2f-9bf8-0a1346b76f71.jsonl'), [
    item({ type: 'function_call', call_id: 'c1', namespace: 'mcp__browser', name: 'open' }, iso(beforeMidnight)),
    item({ type: 'function_call', call_id: 'c1', namespace: 'mcp__browser', name: 'open' }),
    item({ type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch' }),
    item({ type: 'function_call', call_id: 'c3', name: 'exec', arguments: 'mcp__fake__not_a_call' }),
    item({ type: 'function_call_output', call_id: 'c1', output: 'mcp__browser__open' }),
    item({ type: 'custom_tool_call_output', call_id: 'c2' }),
  ]);
  const scan = await scanCodexUsage({ root: cxRoot });
  assert.deepEqual(counts(scan, 20260131), { toolCalls: 1, mcpCalls: 1 });
  assert.deepEqual(counts(scan, 20260201), { toolCalls: 2, mcpCalls: 0 });
  assert.equal(scan.totals.requests, 0);
  assert.equal(scan.dayApproximate, true);
  assert.deepEqual(serializeUsageScan(scan).callsByDay['20260201'], counts(scan, 20260201));
  const cached = await scanCodexUsage({ root: cxRoot });
  assert.equal(cached.stats.cachedFiles, 1);
  assert.deepEqual([...cached.callsByDay], [...scan.callsByDay]);
});

test('DSH: highest log generation only, call/result distinction and local day boundary', async () => {
  const dshRoot = path.join(root, 'dsh'), dir = path.join(dshRoot, 'project', 'session');
  const call = (id, time, name) => ({ type: 'tool/call', time, data: { callId: id, toolName: name } });
  write(path.join(dir, 'session.v4.jsonl'), [
    { type: 'session', id: 'session' },
    call('a', beforeMidnight, 'mcp:browser:open'),
    call('a', afterMidnight, 'mcp:browser:open'),
    call('b', afterMidnight, 'bash'),
    { type: 'tool/result', time: afterMidnight, data: { callId: 'b', name: 'bash' } },
  ]);
  write(path.join(dir, 'session.v3.jsonl'), [{ type: 'session', id: 'session' }, call('old', afterMidnight, 'mcp__extra')]);
  const scan = await scanDshUsage({ root: dshRoot });
  assert.equal(scan.stats.files, 1);
  assert.deepEqual(counts(scan, 20260131), { toolCalls: 1, mcpCalls: 1 });
  assert.deepEqual(counts(scan, 20260201), { toolCalls: 1, mcpCalls: 0 });
  assert.equal((await scanDshUsage({ root: dshRoot })).stats.cachedFiles, 1);
});

test('Kimi: preserve tools-only sessions, merge subagent wires, ignore discovery/results', async () => {
  const kmRoot = path.join(root, 'kimi'), dir = path.join(kmRoot, 'wd_test', 'session_test');
  const event = (ev, time = afterMidnight) => ({ type: 'context.append_loop_event', time, event: ev });
  write(path.join(dir, 'agents', 'main', 'wire.jsonl'), [
    event({ type: 'tool.call', uuid: 'a', name: 'mcp__desktop__run' }, beforeMidnight),
    event({ type: 'tool.call', uuid: 'a', name: 'mcp__desktop__run' }),
    event({ type: 'tool.call', toolCallId: 'b', toolName: 'Read' }),
    event({ type: 'tool.result', uuid: 'b', name: 'Read' }),
    { type: 'mcp.tools_discovered', time: afterMidnight, tools: ['mcp__desktop__run'] },
  ]);
  write(path.join(dir, 'agents', 'sub', 'wire.jsonl'), [
    event({ type: 'tool.call', callId: 'c', tool_name: 'mcp/server/query' }),
  ]);
  const scan = await scanKimiUsage({ root: kmRoot });
  assert.equal(scan.bySession.size, 1);
  assert.equal(scan.totals.requests, 0);
  assert.deepEqual(counts(scan, 20260131), { toolCalls: 1, mcpCalls: 1 });
  assert.deepEqual(counts(scan, 20260201), { toolCalls: 2, mcpCalls: 1 });
  const cached = await scanKimiUsage({ root: kmRoot });
  assert.equal(cached.stats.cachedFiles, 2);
  assert.deepEqual([...cached.callsByDay], [...scan.callsByDay]);
});

test('ZCode: creation date, per-session dedupe, completed/error calls, read-only rescan', async () => {
  const dbPath = path.join(root, 'zcode.sqlite'), db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  db.exec('CREATE TABLE part(id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  const msg = (tokens, finish) => JSON.stringify({ role: 'assistant', modelId: 'test', ...(finish ? { finish } : {}), ...(tokens ? { tokens } : {}) });
  db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run('m', 's1', afterMidnight, afterMidnight, msg({ input: 100, output: 10, cache: { read: 20 } }, 'stop'));
  const insert = db.prepare('INSERT INTO part VALUES(?,?,?,?,?)');
  const tool = (callID, name, status) => JSON.stringify({ type: 'tool', callID, tool: name, state: { status } });
  insert.run('a', 's1', beforeMidnight, afterMidnight, tool('shared', 'mcp__db__query', 'completed'));
  insert.run('b', 's1', afterMidnight, afterMidnight, tool('shared', 'mcp__db__query', 'completed'));
  insert.run('c', 's2', afterMidnight, afterMidnight, tool('shared', 'mcp__db__query', 'error'));
  insert.run('d', 's2', afterMidnight, afterMidnight, tool('other', 'Bash', 'running'));
  insert.run('e', 's2', afterMidnight, afterMidnight, JSON.stringify({ type: 'text', text: 'not a tool' }));
  const scan = await scanZcodeUsage({ dbPath });
  assert.equal(scan.degraded, undefined);
  assert.deepEqual(counts(scan, 20260131), { toolCalls: 1, mcpCalls: 1 });
  assert.deepEqual(counts(scan, 20260201), { toolCalls: 2, mcpCalls: 1 });
  assert.equal(scan.totals.input, 100);
  assert.equal(scan.stats.incremental, false);
  db.prepare('UPDATE part SET data=? WHERE id=?').run(tool('other', 'Bash', 'completed'), 'd');
  assert.deepEqual([...(await scanZcodeUsage({ dbPath })).callsByDay], [...scan.callsByDay]);
  db.close();
  const payload = usageCalendar({ zc: scan });
  assert.equal(payload.sources.zcode.days[20260201].tokens, 110);
  assert.equal(payload.sources.zcode.days[20260131].tokens, 0);
  assert.equal(payload.sources.zcode.available, true);
  assert.equal(payload.sources.codex.available, false);
  assert.ok(payload.timeZone);
  assert.equal(JSON.stringify(payload).includes('bySession'), false);
});

// ---------- ZCode 水位增量（第 3b 步）：lag 场景 / part 去重 / staleMiss / refresh 重建 ----------
test('ZCode incremental: late-token lag (same process), restart lag, part dedupe, staleMiss, refresh rebuild', async () => {
  const dbPath = path.join(root, 'zcode-inc.sqlite'), db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  db.exec('CREATE TABLE part(id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  const data = (tokens, finish) => JSON.stringify({ role: 'assistant', modelId: 'glm', ...(finish ? { finish } : {}), ...(tokens ? { tokens } : {}) });
  const putMsg = db.prepare('INSERT INTO message VALUES(?,?,?,?,?)');
  const putPart = db.prepare('INSERT INTO part VALUES(?,?,?,?,?)');
  const updMsg = db.prepare('UPDATE message SET time_updated=?, data=? WHERE id=?');
  const dataEq = (a, b) => {
    const norm = (sc) => { const c = JSON.parse(JSON.stringify(serializeUsageScan(sc))); delete c.generatedAt; delete c.elapsedMs; delete c.stats; return c; };
    return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
  };

  let clock = afterMidnight;
  const tick = (d = 1) => (clock += d);
  // lag ① 同进程：创建（无 tokens，不被计入）→ 30s 后补 tokens v1（中间态 tool-calls）→ 再涨到 v2
  putMsg.run('late', 's1', clock, clock, data(null, null));
  const s0 = await scanZcodeUsage({ dbPath });
  assert.equal(s0.stats.incremental, false);
  assert.equal(s0.totals.input, 0);
  updMsg.run(tick(30_000), data({ input: 500, output: 50, cache: { read: 0 } }, 'tool-calls'), 'late');
  const s1 = await scanZcodeUsage({ dbPath });
  assert.equal(s1.stats.incremental, true);
  assert.equal(s1.totals.input, 500, '补到的 v1 应按首计全额入账');
  updMsg.run(tick(5_000), data({ input: 800, output: 90, cache: { read: 10 } }, 'stop'), 'late');
  const s2 = await scanZcodeUsage({ dbPath });
  assert.equal(s2.totals.input, 800, '中间态→终态只补差量');
  assert.equal(s2.totals.requests, 1, 'requests 只随首次入账计 1（全量口径）');

  // lag ② 重启：导出检查点 → 模拟重启（reset+load）→ 停机期间补 tokens → 不多计不少计
  const cp = exportCheckpoint();
  resetCaches();
  const sum = loadCheckpoint(JSON.parse(JSON.stringify(cp)));
  assert.equal(sum.loaded.zcode, 1);
  putMsg.run('other', 's2', clock, clock, data(null, null));           // 停机前已存在的无 tokens 行
  updMsg.run(tick(60_000), data({ input: 300, output: 30, cache: { read: 0 } }, 'stop'), 'other');
  // 注：tokens 各字段保持单调不减（真实世界流式累计如此）——差量口径对负增量截 0（文档化），
  // 人为递减字段会让「增量累计 vs 全量重建」出现已登记的合法偏差，不属缺陷。
  updMsg.run(tick(1_000), data({ input: 900, output: 99, cache: { read: 10 } }, 'stop'), 'late');   // 已计过的行停机期间再涨
  const s3 = await scanZcodeUsage({ dbPath });
  assert.equal(s3.stats.incremental, true);
  assert.equal(s3.totals.input, 1200, '重启后：other 首计 300 + late 差量 100（900−800），不双计');

  // part 跨轮去重：同 (sid,callId) 状态更新（running→completed）不再多计 toolCalls
  putPart.run('p1', 's1', clock, clock, JSON.stringify({ type: 'tool', callID: 't1', tool: 'Bash', state: { status: 'running' } }));
  const s4 = await scanZcodeUsage({ dbPath });
  assert.equal(s4.degraded, undefined, 's4 不应降级（曾因 partLru Set/Map 类型不一致静默 degraded）');
  assert.equal(counts(s4, 20260201).toolCalls, 1);
  db.prepare('UPDATE part SET time_updated=?, data=? WHERE id=?').run(tick(2_000), JSON.stringify({ type: 'tool', callID: 't1', tool: 'Bash', state: { status: 'completed' } }), 'p1');
  const s5 = await scanZcodeUsage({ dbPath });
  assert.equal(counts(s5, 20260201).toolCalls, 1, 'part 状态更新不重复计数');

  // refresh:true 清状态全表重建 == 真值；增量累计与重建逐字段一致
  const rebuilt = await scanZcodeUsage({ dbPath, refresh: true });
  assert.equal(rebuilt.stats.incremental, false);
  assert.equal(rebuilt.totals.input, 1200);
  assert.ok(dataEq(s5, rebuilt), '增量累计与全量重建数据一致');

  // staleMiss（可观测）：lruCap=2 下淘汰最旧行后更新它 → 按冻结假设跳过并计数
  resetCaches();
  await scanZcodeUsage({ dbPath, refresh: true, lruCap: 2 });
  putMsg.run('n1', 's3', clock, clock, data({ input: 10 }, 'stop'));
  putMsg.run('n2', 's3', clock, clock, data({ input: 10 }, 'stop'));
  putMsg.run('n3', 's3', clock, clock, data({ input: 10 }, 'stop'));   // 容量 2：淘汰最旧
  await scanZcodeUsage({ dbPath, lruCap: 2 });
  updMsg.run(tick(1), data({ input: 99 }, 'stop'), 'late');   // 更新被淘汰的旧行
  const sMiss = await scanZcodeUsage({ dbPath, lruCap: 2 });
  assert.ok(sMiss.stats.staleMiss >= 1, 'staleMiss 必须可观测（stats.staleMiss=' + sMiss.stats.staleMiss + '）');
  db.close();
});

test('Calendar marks limited scans as partial and failed scans as unavailable', async () => {
  const scan = await scanClaudeUsage({ root: path.join(root, 'claude'), maxFiles: 0 });
  const payload = usageCalendar({ cc: scan, zc: await scanZcodeUsage({ dbPath: path.join(root, 'missing.sqlite') }) });
  assert.equal(payload.sources['claude-code'].partial, true);
  assert.equal(payload.sources.zcode.available, false);
  assert.deepEqual(payload.sources.zcode.days, {});
});
