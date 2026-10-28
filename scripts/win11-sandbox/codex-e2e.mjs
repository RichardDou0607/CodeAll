// codex 第二家 CLI 最小闭环 v2:stdin 显式关闭 + 按转录行数增长判定
import { deliverViaCli } from '../adapters/cli-control.mjs';
import { resolveCliBinPath, resolveSpawnCommand, spawnCommandArgs } from '../adapters/platform.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const D = String.raw`C:\Users\admin\pet-e2e-test`;
const say = (o) => console.log('@@@' + JSON.stringify(o));
function runCapture(args, timeoutMs = 240_000) {
  const bin = resolveCliBinPath('codex', []);
  const t = spawnCommandArgs(resolveSpawnCommand(bin), args);
  return new Promise((resolve) => {
    const child = spawn(t.file, t.args, { cwd: D, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: t.windowsVerbatimArguments });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ code: 'timeout', out, err }); }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 'spawn-error', out, err: String(e.message) }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}
const ROOT = path.join(os.homedir(), '.codex', 'sessions');
function rollouts() {
  const all = [];
  (function walk(dir) {
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-')) { try { const st = fs.statSync(p); all.push({ p, m: st.mtimeMs, size: st.size }); } catch {} }
    }
  })(ROOT);
  return all.sort((a, b) => b.m - a.m);
}
function lineCount(p) { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } }
function validRollout(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.includes('海星')) return false;
    return raw.split('\n').some(line => {
      try { const event = JSON.parse(line); return event.type === 'session_meta' && event.payload?.cwd === D; }
      catch { return false; }
    });
  } catch { return false; }
}
function lastAssistantText(file) {
  let text = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type !== 'response_item' || event.payload?.type !== 'message' || event.payload.role !== 'assistant') continue;
      for (const part of event.payload.content || []) if (part.type === 'output_text') text = part.text;
    } catch { /* 半行 */ }
  }
  return text;
}

fs.mkdirSync(D, { recursive: true });
const t0 = Date.now();
const before = rollouts()[0];
const r1 = await runCapture(['exec', '--skip-git-repo-check', '这是 CodeAll Windows 验证。暗号是「海星」。请只回复四个字:收到海星']);
say({ step: 'codex-create', code: r1.code, out: r1.out.replace(/\s+/g, ' ').slice(0, 160), err: r1.err.replace(/\s+/g, ' ').slice(0, 120) });
if (r1.code !== 0) { say({ step: 'ABORT', reason: 'codex create failed' }); process.exit(1); }
const after = rollouts().find((r) => (!before || r.p !== before.p) && validRollout(r.p));
if (!after || after.m < t0 - 5000) { say({ step: 'ABORT', reason: 'no new rollout' }); process.exit(1); }
const sid = (after.p.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/) || [])[1];
if (!sid) { say({ step: 'ABORT', reason: 'no rollout session id' }); process.exit(1); }
say({ step: 'codex-session', sid, file: after.p.split('\\').pop() });
const linesBefore = lineCount(after.p);

const r2 = await deliverViaCli('codex', { sessionId: sid, cwd: D }, '刚才的暗号是什么?只回复暗号三个字');
say({ step: 'codex-deliver', ok: r2.ok, via: r2.via, error: r2.error });
let reply = false, tailLine = null;
for (let i = 0; i < 60 && !reply; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const n = lineCount(after.p);
  if (n > linesBefore) {
    tailLine = lastAssistantText(after.p);
    if (tailLine?.includes('海星')) reply = true;
  }
}
const pass = r2.ok === true && reply;
say({ step: 'codex-result', pass, tail: (tailLine || '').slice(0, 220) });
say({ step: 'ALL-DONE', pass });
if (!pass) process.exitCode = 1;
