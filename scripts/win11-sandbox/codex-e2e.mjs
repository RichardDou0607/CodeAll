// codex 第二家 CLI 最小闭环 v2:stdin 显式关闭 + 按转录行数增长判定
import { deliverViaCli } from '../adapters/cli-control.mjs';
import { resolveCliBinPath, resolveSpawnCommand } from '../adapters/platform.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const D = String.raw`C:\Users\admin\pet-e2e-test`;
const say = (o) => console.log('@@@' + JSON.stringify(o));
function runCapture(args, timeoutMs = 240_000) {
  const bin = resolveCliBinPath('codex', []);
  const t = resolveSpawnCommand(bin);
  return new Promise((resolve) => {
    const child = spawn(t.file, [...t.prefixArgs, ...args], { cwd: D, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
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

const t0 = Date.now();
const before = rollouts()[0];
const r1 = await runCapture(['exec', '--skip-git-repo-check', '这是 CodeAll Windows 验证。暗号是「海星」。请只回复四个字:收到海星']);
say({ step: 'codex-create', code: r1.code, out: r1.out.replace(/\s+/g, ' ').slice(0, 160), err: r1.err.replace(/\s+/g, ' ').slice(0, 120) });
const after = rollouts().find((r) => !before || r.p !== before.p);
if (!after || after.m < t0 - 5000) { say({ step: 'ABORT', reason: 'no new rollout' }); process.exit(1); }
const sid = (after.p.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/) || [])[1];
say({ step: 'codex-session', sid, file: after.p.split('\\').pop() });
const linesBefore = lineCount(after.p);

const r2 = await deliverViaCli('codex', { sessionId: sid, cwd: D }, '刚才的暗号是什么?只回复暗号三个字');
say({ step: 'codex-deliver', ok: r2.ok, via: r2.via, error: r2.error });
let pass = false, tailLine = null;
for (let i = 0; i < 60 && !pass; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const n = lineCount(after.p);
  if (n > linesBefore) {
    const lines = fs.readFileSync(after.p, 'utf8').split('\n').filter(Boolean);
    tailLine = lines[lines.length - 1];
    if (tailLine.includes('海星')) pass = true;
  }
}
say({ step: 'codex-result', pass, tail: (tailLine || '').slice(0, 220) });
say({ step: 'ALL-DONE' });
