// E2E-驱动:claude 真实投递闭环 V01/V02/V04/V05(专用测试目录,最小额度消耗)
// Linux 移植版(PLAT-3 L8;母版 scripts/win11-sandbox/e2e-driver.mjs,判定逻辑平台无关)
//   用法:node e2e-driver.mjs   结果打 stdout(DELIM 分隔的 JSON 行)
// 前置:claude CLI 已登录(独立授权门——需用户明确授权额度后运行)
import { deliverViaCli } from '../adapters/cli-control.mjs';
import { resolveCliBinPath, resolveSpawnCommand, spawnCommandArgs } from '../adapters/platform.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const D = path.join(os.homedir(), 'pet-e2e-test');
fs.mkdirSync(D, { recursive: true });
const say = (o) => console.log('@@@' + JSON.stringify(o));

function runCapture(binPath, args, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const t = spawnCommandArgs(resolveSpawnCommand(binPath), args);
    const child = spawn(t.file, t.args, { cwd: D, env: { ...process.env } });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ code: 'timeout', out, err }); }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 'spawn-error', out, err: String(e.message) }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

// 找会话转录文件(不定编码,按 sessionId 扫)
function transcriptOf(sessionId) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let hit = null;
  (function walk(dir) {
    if (hit) return;
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith(sessionId) && e.name.endsWith('.jsonl')) hit = p;
    }
  })(root);
  return hit;
}

// 读转录最后一条 assistant 文本
function lastAssistant(fp) {
  try {
    const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(lines[i]);
        const m = j?.message?.content;
        if (j.type === 'assistant' && Array.isArray(m)) {
          const text = m.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
          if (text.trim()) return text.trim().slice(0, 120);
        }
      } catch { /* 半行 */ }
    }
  } catch { /* ignore */ }
  return null;
}

// 等转录出现指定文本(投递是异步的,跟随转录增长)
async function waitText(fp, needle, deadlineMs = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    const a = lastAssistant(fp);
    if (a && a.includes(needle)) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

// ---- V01:新建会话(会话A) ----
const claude = resolveCliBinPath('claude', []);
say({ step: 'V01-create-A', bin: claude });
const r1 = await runCapture(claude, ['-p', '这是 CodeAll Linux 验证会话A。暗号是「蓝鲸」。请只回复:已记住', '--output-format', 'json']);
let sidA = null;
try { sidA = JSON.parse(r1.out).session_id; } catch { /* 解析失败 */ }
say({ step: 'V01-create-A-done', code: r1.code, sessionId: sidA, out: r1.out.slice(0, 200), err: r1.err.slice(0, 160) });
if (r1.code !== 0 || !sidA) { say({ step: 'ABORT', reason: 'no session A' }); process.exit(1); }

// ---- V02:定向投递第二轮,验证上下文连续 ----
const r2 = await deliverViaCli('claude-code', { sessionId: sidA, cwd: D }, '只回复会话A的暗号,不要解释');
say({ step: 'V02-deliver', ok: r2.ok, via: r2.via, error: r2.error, detail: r2.detail });
const fpA = transcriptOf(sidA);
const v02 = r2.ok === true && (fpA ? await waitText(fpA, '蓝鲸') : false);
say({ step: 'V02-result', transcript: fpA, pass: v02 });

// ---- V04:同 cwd 双会话隔离 ----
const rB = await runCapture(claude, ['-p', '这是 CodeAll Linux 验证会话B。暗号是「海豚」。请只回复:已记住', '--output-format', 'json']);
let sidB = null;
try { sidB = JSON.parse(rB.out).session_id; } catch { /* ignore */ }
say({ step: 'V04-create-B-done', code: rB.code, sessionId: sidB });
if (rB.code !== 0 || !sidB) { say({ step: 'ABORT', reason: 'no session B' }); process.exit(1); }
const r3 = await deliverViaCli('claude-code', { sessionId: sidA, cwd: D }, '只回复会话A的暗号,不要解释');
const r4 = await deliverViaCli('claude-code', { sessionId: sidB, cwd: D }, '只回复会话B的暗号,不要解释');
say({ step: 'V04-deliver-A', ok: r3.ok, error: r3.error });
say({ step: 'V04-deliver-B', ok: r4.ok, error: r4.error });
const fpA2 = transcriptOf(sidA);
const fpB = transcriptOf(sidB);
const aOk = fpA2 ? await waitText(fpA2, '蓝鲸', 120_000) : false;
const bOk = fpB ? await waitText(fpB, '海豚', 120_000) : false;
const v04 = r3.ok === true && r4.ok === true && aOk && bOk;
say({ step: 'V04-result', aPass: aOk, bPass: bOk, pass: v04 });

// ---- V05:失败可辨(不存在的会话 ID) ----
const r5 = await deliverViaCli('claude-code', { sessionId: 'e2e-nonexistent-00000000', cwd: D }, '不应到达');
const v05 = r5.ok === false;
say({ step: 'V05-result', ok: r5.ok, error: r5.error, detail: (r5.detail || '').slice(0, 140), pass: v05 });
const pass = v02 && v04 && v05;
say({ step: 'ALL-DONE', pass });
if (!pass) process.exitCode = 1;
