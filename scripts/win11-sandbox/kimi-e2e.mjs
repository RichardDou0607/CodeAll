// kimi 第二家 CLI 最小闭环:新建 → 定向投递 → 转录验证(V01/V02 同口径,最小额度)
import { deliverViaCli } from '../adapters/cli-control.mjs';
import { resolveCliBinPath, resolveSpawnCommand } from '../adapters/platform.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const D = String.raw`C:\Users\admin\pet-e2e-test`;
const say = (o) => console.log('@@@' + JSON.stringify(o));
const KIMI_HOME = path.join(os.homedir(), '.kimi-code');
const SESS = path.join(KIMI_HOME, 'sessions');

function runCapture(args, timeoutMs = 180_000) {
  const bin = resolveCliBinPath('kimi', [path.join(KIMI_HOME, 'bin', 'kimi.exe')]);
  const t = resolveSpawnCommand(bin);
  return new Promise((resolve) => {
    const child = spawn(t.file, [...t.prefixArgs, ...args], { cwd: D, env: { ...process.env } });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ code: 'timeout', out, err }); }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 'spawn-error', out, err: String(e.message) }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

function newestSession(sinceMs) {
  if (!fs.existsSync(SESS)) return null;
  let best = null;
  for (const e of fs.readdirSync(SESS, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const d = path.join(SESS, e.name);
    try { const m = fs.statSync(d).mtimeMs; if (m >= sinceMs && (!best || m > best.m)) best = { id: e.name, m }; } catch { /* ignore */ }
  }
  return best;
}

function textInSession(id, needle) {
  const d = path.join(SESS, id);
  try {
    for (const f of fs.readdirSync(d)) {
      const fp = path.join(d, f);
      try { if (fs.readFileSync(fp, 'utf8').includes(needle)) return true; } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return false;
}

// ---- 新建 ----
const t0 = Date.now();
const r1 = await runCapture(['-p', '这是 CodeAll Windows 验证会话。暗号是「海豚」。请只回复:已记住']);
say({ step: 'kimi-create', code: r1.code, out: r1.out.replace(/\s+/g, ' ').slice(0, 160), err: r1.err.replace(/\s+/g, ' ').slice(0, 160) });
const s = newestSession(t0 - 5000);
if (!s) { say({ step: 'ABORT', reason: 'no kimi session dir appeared' }); process.exit(1); }
say({ step: 'kimi-session', id: s.id });
if (!textInSession(s.id, '海豚')) await new Promise((r) => setTimeout(r, 5000));

// ---- 定向投递第二轮 ----
const r2 = await deliverViaCli('kimi-code', { sessionId: s.id, cwd: D }, '只回复会话的暗号,不要解释');
say({ step: 'kimi-deliver', ok: r2.ok, via: r2.via, error: r2.error, detail: (r2.detail || '').slice(0, 120) });
let pass = false;
for (let i = 0; i < 40 && !pass; i++) { await new Promise((r) => setTimeout(r, 3000)); pass = textInSession(s.id, '海豚'); }
say({ step: 'kimi-result', pass });
say({ step: 'ALL-DONE' });
