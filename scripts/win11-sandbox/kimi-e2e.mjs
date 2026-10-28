// kimi 第二家 CLI 最小闭环:新建 → 定向投递 → 转录验证(V01/V02 同口径,最小额度)
import { deliverViaCli } from '../adapters/cli-control.mjs';
import { resolveCliBinPath, resolveSpawnCommand, spawnCommandArgs } from '../adapters/platform.mjs';
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
  const t = spawnCommandArgs(resolveSpawnCommand(bin), args);
  return new Promise((resolve) => {
    const child = spawn(t.file, t.args, { cwd: D, env: { ...process.env }, windowsVerbatimArguments: t.windowsVerbatimArguments });
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
  for (const wd of fs.readdirSync(SESS, { withFileTypes: true })) {
    if (!wd.isDirectory()) continue;
    const wdDir = path.join(SESS, wd.name);
    let entries; try { entries = fs.readdirSync(wdDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('session_')) continue;
      const dir = path.join(wdDir, entry.name);
      try {
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
        if (state.cwd !== D) continue;
        const m = fs.statSync(dir).mtimeMs;
        if (m >= sinceMs && (!best || m > best.m)) best = { id: state.id || entry.name, dir, m };
      } catch { /* 非本测试会话 */ }
    }
  }
  return best;
}

function lastAssistantText(session) {
  let text = null;
  const file = path.join(session.dir, 'agents', 'main', 'wire.jsonl');
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const line of raw.split('\n')) {
    if (!line.includes('agent.message.appended')) continue;
    try {
      const event = JSON.parse(line);
      const message = event.message?.message ?? event.message;
      if (event.type !== 'agent.message.appended' || message?.role !== 'assistant') continue;
      const content = message.content;
      if (Array.isArray(content)) text = content.filter(b => b?.type === 'text').map(b => b.text).join(' ');
      else if (typeof content === 'string') text = content;
    } catch { /* 半行 */ }
  }
  return text;
}

async function waitAssistant(session, needle, previous = null) {
  for (let i = 0; i < 60; i++) {
    const text = lastAssistantText(session);
    if (text && text !== previous && (!needle || text.includes(needle))) return text;
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

// ---- 新建 ----
fs.mkdirSync(D, { recursive: true });
const t0 = Date.now();
const r1 = await runCapture(['-p', '这是 CodeAll Windows 验证会话。暗号是「海豚」。请只回复:已记住']);
say({ step: 'kimi-create', code: r1.code, out: r1.out.replace(/\s+/g, ' ').slice(0, 160), err: r1.err.replace(/\s+/g, ' ').slice(0, 160) });
if (r1.code !== 0) { say({ step: 'ABORT', reason: 'kimi create failed' }); process.exit(1); }
const s = newestSession(t0 - 5000);
if (!s) { say({ step: 'ABORT', reason: 'no kimi session dir appeared' }); process.exit(1); }
say({ step: 'kimi-session', id: s.id });
const firstText = await waitAssistant(s, null);
say({ step: 'kimi-create-reply', pass: !!firstText });
if (!firstText) { say({ step: 'ABORT', reason: 'no initial assistant reply' }); process.exit(1); }

// ---- 定向投递第二轮 ----
const r2 = await deliverViaCli('kimi-code', { sessionId: s.id, cwd: D }, '只回复会话的暗号,不要解释');
say({ step: 'kimi-deliver', ok: r2.ok, via: r2.via, error: r2.error, detail: (r2.detail || '').slice(0, 120) });
const secondText = await waitAssistant(s, '海豚', firstText);
const pass = r2.ok === true && !!secondText;
say({ step: 'kimi-result', pass });
say({ step: 'ALL-DONE', pass });
if (!pass) process.exitCode = 1;
