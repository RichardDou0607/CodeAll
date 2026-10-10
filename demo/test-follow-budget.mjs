#!/usr/bin/env node
// 跟随预算回归（qa H2）：文件数超上限（默认 80）时，按 mtime 优先 + LRU 淘汰——
// 新会话仍被实时跟随；未触顶时不淘汰；被淘汰者再活跃时从淘汰点续读（不丢增量）。
// 纯临时目录 + 合成转录，不读真实会话。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { followClaudeLogs } from '../adapters/claude-code-adapter.mjs';
import { followCodexLogs } from '../adapters/codex-adapter.mjs';
import { followKimiLogs } from '../adapters/kimi-code-adapter.mjs';

const line = (o) => JSON.stringify(o) + '\n';
const userLine = (text) => line({ type: 'user', cwd: '/tmp/x', entrypoint: 'cli', timestamp: new Date().toISOString(), isSidechain: false, message: { content: text } });
const asstLine = line({ type: 'assistant', timestamp: new Date().toISOString(), isSidechain: false, message: { model: 'm', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 建 n 个既有转录文件（mtime 递增）→ 跟随 → 追加 → 新建会话文件 → 断言覆盖与淘汰。 */
async function caseRun(n) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-follow-'));
  const proj = path.join(root, 'proj-a');
  fs.mkdirSync(proj, { recursive: true });
  const files = [];
  for (let i = 0; i < n; i++) {
    const f = path.join(proj, `sess-${String(i).padStart(3, '0')}.jsonl`);
    fs.writeFileSync(f, userLine('hello'));
    files.push(f);
    await sleep(4);                                     // 保证 mtime 单调递增，便于断言淘汰对象
  }
  const events = [];
  const follower = followClaudeLogs({ root, intervalMs: 120, onEvent: (ev) => events.push(ev) });
  await sleep(700);                                     // 首次 pump：按 mtime 倒序占预算
  const initialFollowed = follower.stats().files;
  for (const f of files) fs.appendFileSync(f, asstLine);
  await sleep(700);
  const covered = new Set(events.map((e) => e.sessionId));
  const coveredExisting = covered.size;

  const newFile = path.join(proj, 'sess-zzz-new.jsonl'); // 之后新建的会话文件
  fs.writeFileSync(newFile, userLine('brand new session'));
  await sleep(500);                                     // 先让跟随器「见到」该文件（真实会话逐行增长）
  fs.appendFileSync(newFile, asstLine);
  await sleep(800);
  const newSessionFollowed = events.some((e) => e.sessionId === 'sess-zzz-new');

  // 被淘汰者再活跃：其追加行应被补齐（从淘汰点续读）。受害者 = 跟随集合里创建序最早的会话
  //（mtime 最旧，新文件准入时必然淘汰它——本轮由「新会话文件」触发）。
  const victimSid = [...covered].sort()[0];
  const before = events.filter((e) => e.sessionId === victimSid && e.type === 'turn.end').length;
  fs.appendFileSync(files[Number(victimSid.slice(5))], asstLine);
  await sleep(800);
  const after = events.filter((e) => e.sessionId === victimSid && e.type === 'turn.end').length;
  const evictedResumed = after > before;

  const out = { files: n, initialFollowed, finalFollowed: follower.stats().files, evictions: follower.stats().evictions, coveredExisting, newSessionFollowed, victimSid, evictedResumed };
  follower.stop();
  fs.rmSync(root, { recursive: true, force: true });
  return out;
}

const underCap = await caseRun(79);
assert.equal(underCap.initialFollowed, 79);
assert.equal(underCap.finalFollowed, 80, '新会话应占一个槽位（未触顶，无需淘汰）');
assert.equal(underCap.coveredExisting, 79);
assert.equal(underCap.newSessionFollowed, true, '未触顶时新会话必须被跟随');
assert.equal(underCap.evictions, 0, '未触顶不应有淘汰');

const overCap = await caseRun(85);
assert.equal(overCap.initialFollowed, 80, '触顶时应跟随 mtime 最新的 80 个');
assert.ok(overCap.finalFollowed <= 80, '跟随数不得超过上限');
assert.equal(overCap.coveredExisting, 80);
assert.ok(overCap.evictions >= 1, '触顶且来了更新的文件时应发生淘汰');
assert.equal(overCap.newSessionFollowed, true, '触顶后新会话仍必须被跟随（qa H2 核心回归）');
assert.equal(overCap.evictedResumed, true, '被淘汰者再活跃时应从淘汰点续读');

// ---- Codex：同款预算逻辑（复制实现的独立回归） ----
async function codexCase(n) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-follow-cx-'));
  const dir = path.join(root, '2026', '10', '09');
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  const metaLine = (sid) => line({ type: 'session_meta', timestamp: new Date().toISOString(), payload: { session_id: sid, cwd: '/tmp/x', cli_version: '9.9.9' } });
  for (let i = 0; i < n; i++) {
    const f = path.join(dir, `rollout-2026-10-09T00-00-00-${String(i).padStart(8, '0')}-0000-4000-8000-000000000000.jsonl`);
    fs.writeFileSync(f, metaLine(`sess-cx-${String(i).padStart(3, '0')}`));
    files.push(f);
    await sleep(4);
  }
  const events = [];
  const follower = followCodexLogs({ root, intervalMs: 120, onEvent: (ev) => events.push(ev) });
  await sleep(700);
  const initialFollowed = follower.stats().files;
  const tick = line({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started' } });
  for (const f of files) fs.appendFileSync(f, tick);
  await sleep(700);
  const covered = new Set(events.map((e) => e.sessionId)).size;
  const newFile = path.join(dir, 'rollout-2026-10-09T00-00-01-99999999-0000-4000-8000-000000000000.jsonl');
  fs.writeFileSync(newFile, metaLine('sess-cx-new'));
  await sleep(500);
  fs.appendFileSync(newFile, tick);
  await sleep(800);
  const out = { initialFollowed, evictions: follower.stats().evictions, covered, newFollowed: events.some((e) => e.sessionId === 'sess-cx-new') };
  follower.stop();
  fs.rmSync(root, { recursive: true, force: true });
  return out;
}

// ---- Kimi：同款预算逻辑 ----
async function kimiCase(n) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-follow-km-'));
  const wd = path.join(root, 'wd_one');
  const files = [];
  for (let i = 0; i < n; i++) {
    const sessionDir = path.join(wd, `session_sess_km_${String(i).padStart(3, '0')}`);
    const mainDir = path.join(sessionDir, 'agents', 'main');
    fs.mkdirSync(mainDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ id: `sess_km_${String(i).padStart(3, '0')}`, cwd: '/tmp/x' }));
    const wire = path.join(mainDir, 'wire.jsonl');
    fs.writeFileSync(wire, '');
    files.push(wire);
    await sleep(4);
  }
  const events = [];
  const follower = followKimiLogs({ root, intervalMs: 120, onEvent: (ev) => events.push(ev) });
  await sleep(700);
  const initialFollowed = follower.stats().files;
  const tick = line({ type: 'turn.prompt', time: Date.now(), turnId: 't1' });
  for (const f of files) fs.appendFileSync(f, tick);
  await sleep(700);
  const covered = new Set(events.map((e) => e.sessionId)).size;
  const newDir = path.join(wd, 'session_sess_km_new', 'agents', 'main');
  fs.mkdirSync(newDir, { recursive: true });
  fs.writeFileSync(path.join(wd, 'session_sess_km_new', 'state.json'), JSON.stringify({ id: 'sess_km_new', cwd: '/tmp/x' }));
  const newWire = path.join(newDir, 'wire.jsonl');
  fs.writeFileSync(newWire, '');
  await sleep(500);
  fs.appendFileSync(newWire, tick);
  await sleep(800);
  const out = { initialFollowed, evictions: follower.stats().evictions, covered, newFollowed: events.some((e) => e.sessionId === 'sess_km_new') };
  follower.stop();
  fs.rmSync(root, { recursive: true, force: true });
  return out;
}

const cx = await codexCase(85);
assert.equal(cx.initialFollowed, 80, 'codex：触顶时应跟随 mtime 最新的 80 个');
assert.ok(cx.evictions >= 1, 'codex：应发生淘汰');
assert.equal(cx.newFollowed, true, 'codex：触顶后新会话仍必须被跟随');

const km = await kimiCase(85);
assert.equal(km.initialFollowed, 80, 'kimi：触顶时应跟随 mtime 最新的 80 个');
assert.ok(km.evictions >= 1, 'kimi：应发生淘汰');
assert.equal(km.newFollowed, true, 'kimi：触顶后新会话仍必须被跟随');

console.log('跟随预算：触顶按 mtime 优先 + LRU 淘汰，新会话/复活跃会话不漏事件（qa H2，claude/codex/kimi）通过');
