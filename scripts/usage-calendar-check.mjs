#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import {
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

test('ZCode: creation date, per-session dedupe, completed/error calls, read-only rescan', () => {
  const dbPath = path.join(root, 'zcode.sqlite'), db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
  db.exec('CREATE TABLE part(id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  db.prepare('INSERT INTO message VALUES(?,?,?,?)').run('m', 's1', afterMidnight, JSON.stringify({ role: 'assistant', modelId: 'test', tokens: { input: 100, output: 10, cache: { read: 20 } } }));
  const insert = db.prepare('INSERT INTO part VALUES(?,?,?,?,?)');
  const tool = (callID, name, status) => JSON.stringify({ type: 'tool', callID, tool: name, state: { status } });
  insert.run('a', 's1', beforeMidnight, afterMidnight, tool('shared', 'mcp__db__query', 'completed'));
  insert.run('b', 's1', afterMidnight, afterMidnight, tool('shared', 'mcp__db__query', 'completed'));
  insert.run('c', 's2', afterMidnight, afterMidnight, tool('shared', 'mcp__db__query', 'error'));
  insert.run('d', 's2', afterMidnight, afterMidnight, tool('other', 'Bash', 'running'));
  insert.run('e', 's2', afterMidnight, afterMidnight, JSON.stringify({ type: 'text', text: 'not a tool' }));
  const scan = scanZcodeUsage({ dbPath });
  assert.equal(scan.degraded, undefined);
  assert.deepEqual(counts(scan, 20260131), { toolCalls: 1, mcpCalls: 1 });
  assert.deepEqual(counts(scan, 20260201), { toolCalls: 2, mcpCalls: 1 });
  assert.equal(scan.totals.input, 100);
  db.prepare('UPDATE part SET data=? WHERE id=?').run(tool('other', 'Bash', 'completed'), 'd');
  assert.deepEqual([...scanZcodeUsage({ dbPath }).callsByDay], [...scan.callsByDay]);
  db.close();
  const payload = usageCalendar({ zc: scan });
  assert.equal(payload.sources.zcode.days[20260201].tokens, 110);
  assert.equal(payload.sources.zcode.days[20260131].tokens, 0);
  assert.equal(payload.sources.zcode.available, true);
  assert.equal(payload.sources.codex.available, false);
  assert.ok(payload.timeZone);
  assert.equal(JSON.stringify(payload).includes('bySession'), false);
});

test('Calendar marks limited scans as partial and failed scans as unavailable', async () => {
  const scan = await scanClaudeUsage({ root: path.join(root, 'claude'), maxFiles: 0 });
  const payload = usageCalendar({ cc: scan, zc: scanZcodeUsage({ dbPath: path.join(root, 'missing.sqlite') }) });
  assert.equal(payload.sources['claude-code'].partial, true);
  assert.equal(payload.sources.zcode.available, false);
  assert.deepEqual(payload.sources.zcode.days, {});
});
