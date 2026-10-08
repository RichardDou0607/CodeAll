#!/usr/bin/env node
/**
 * adapters/cli-control.mjs — Claude Code / Codex / Kimi Code / ZCode 的控制通道（docs/21 M-D/M-E/M-H/M-L 控制层）
 *
 * 三类动作，全部走各 CLI 的**官方能力**（不注入、不改配置、不绕过各 CLI 自身的权限系统）：
 *
 *   投递（既有会话发一条）：
 *     ① 若 tmux 服务在跑且能定位到「正在该会话目录里跑对应 CLI」的 pane → `tmux send-keys`（零进程开销，用户看得见）；
 *     ② 否则无头（headless）续会话：在会话 cwd 里 spawn
 *          claude --resume <id> -p "<text>"
 *          codex  exec resume <id> "<text>"
 *          kimi   -S <id> -p "<text>"
 *          zcode  --resume <id> --mode build --prompt "<text>"（CLI 随 ZCode.app 捆绑分发）
 *        detached 执行、输出落 ~/.agent-pet/cli-control/*.log（0600）；回合结束后转录/rollout/wire
 *        增长，观察跟随器（M-A/M-B/M-H）自动看到状态变化 —— 控制→观察闭环。
 *
 *   新建会话：Terminal.app 新窗口 `cd <cwd> && <cli>`（可见、可交互；tmux 在跑则开 tmux window）。
 *   打开会话：Terminal.app 新窗口 `cd <cwd> && <cli> resume <id>`（DSH 仍走插件，不经此文件）。
 *
 * 安全边界：
 *   - 一律 execFile/spawn 参数数组，**不经 shell 拼接**（防注入）；Terminal 的 AppleScript 用 JSON.stringify 转义。
 *   - 不使用任何越权 flag（无 --dangerously-skip-permissions / yolo / full-auto）——各 CLI 自身权限模式照常生效。
 *   - 不读不存任何凭证；无头进程继承当前用户环境。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);

/** 每个后端的 CLI 定义。args 全部走参数数组（不经 shell）。extraPaths = PATH 之外的兜底二进制位置。 */
export const CLI_TARGETS = Object.freeze({
  'claude-code': Object.freeze({
    name: 'Claude Code',
    bin: 'claude',
    deliverArgs: (id, text) => ['--resume', id, '-p', text],
    createArgs: (text) => ['-p', text],
    openArgs: (id) => ['--resume', id],
    interactiveArgs: () => [],
    modelArgs: (model) => ['--model', model],
    extraPaths: () => [],
  }),
  codex: Object.freeze({
    name: 'Codex',
    bin: 'codex',
    deliverArgs: (id, text) => ['exec', 'resume', id, text],
    createArgs: (text) => ['exec', text],
    openArgs: (id) => ['--resume', id],
    interactiveArgs: () => [],
    modelArgs: (model) => ['-m', model],
    extraPaths: () => [],
  }),
  'kimi-code': Object.freeze({
    name: 'Kimi Code',
    bin: 'kimi',
    deliverArgs: (id, text) => ['-S', id, '-p', text],
    createArgs: (text) => ['-p', text],
    openArgs: (id) => ['-S', id],
    interactiveArgs: () => [],
    modelArgs: (model) => ['-m', model],
    extraPaths: () => [path.join(os.homedir(), '.kimi-code', 'bin', 'kimi')],
  }),
  zcode: Object.freeze({
    name: 'ZCode',
    // CLI 随桌面 App 分发（可执行 .cjs，shebang node；PATH 里叫 zcode，若独立安装）。
    // account:*（Z.AI Coding Plan 登录态）provider 仅能由桌面 App 进程注册，无头 --resume 必败
    // （"Model creation failed"）——2026-10-08 起这类会话改走 app-server 管道 + 模型覆盖
    // （见 deliverViaZcodePipe），builtin / 个人 Key 会话的无头续接不受影响。
    bin: 'zcode',
    // 无头 --prompt 的默认权限档是 yolo——显式压到 build：不越权，无头无人在场时危险操作按拒绝处理
    deliverArgs: (id, text) => ['--resume', id, '--mode', 'build', '--prompt', text],
    createArgs: (text) => ['--mode', 'build', '--prompt', text],
    openArgs: (id) => ['--resume', id],
    interactiveArgs: () => [],
    extraPaths: () => [path.join('/Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs')],
    /**
     * 桌面 App 进程会注入的 provider 配置路径（CLI 脱离 App 环境运行时缺它 →
     * "无法定位 CLI ZCode Built-in Provider Config" → Model creation failed，2026-10-07 实测）。
     * builtin 取 bin 同级的 App 包 config（../../config/provider）；personal 取 ~/.zcode/v2。
     */
    envFor: (bin) => {
      const out = {};
      const bundled = bin && /ZCode\.app\//.test(bin)
        ? path.join(path.dirname(path.dirname(bin)), 'config', 'provider', 'zcode-builtin.json')
        : null;
      if (bundled && fs.existsSync(bundled)) out.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = bundled;
      const personal = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');
      if (fs.existsSync(personal)) out.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personal;
      return out;
    },
  }),
});

/** 目标 CLI 需要的额外环境（无则空对象）；bin 供按位置推导（zcode 的 App 包内 config）。 */
export function cliEnvFor(source, bin = resolveCliBin(source)) {
  const t = CLI_TARGETS[source];
  return t?.envFor ? t.envFor(bin) : {};
}

const CONTROL_DIR = path.join(os.homedir(), '.agent-pet', 'cli-control');

/** PATH 里找 CLI 二进制（结果缓存 60s；卸载/改装后自动重查）。 */
const binCache = new Map();
export function resolveCliBin(source) {
  const t = CLI_TARGETS[source];
  if (!t) return null;
  const hit = binCache.get(source);
  if (hit && Date.now() - hit.at < 60_000) return hit.path;
  const dirs = (process.env.PATH || '').split(':');
  let found = null;
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, t.bin);
    try { if (fs.statSync(p).isFile() && fs.accessSync(p, fs.constants.X_OK) === undefined) { found = p; break; } } catch { /* 下一个 */ }
  }
  // 常见兜底（不在 PATH 时）：~/.local/bin + 各后端声明的 extraPaths（如 ZCode.app 内捆绑的 CLI）
  if (!found) for (const p of [path.join(os.homedir(), '.local', 'bin', t.bin), ...(t.extraPaths ? t.extraPaths() : [])]) {
    try { if (fs.statSync(p).isFile()) { found = p; break; } } catch { /* 下一个 */ }
  }
  binCache.set(source, { at: Date.now(), path: found });
  return found;
}

/** 全部可用（在 PATH）的 CLI 通道，供能力位展示。 */
export function availableCliChannels() {
  return Object.keys(CLI_TARGETS)
    .map((source) => ({ source, name: CLI_TARGETS[source].name, bin: CLI_TARGETS[source].bin, available: !!resolveCliBin(source) }))
    .filter((c) => c.available);
}

// ---------------------------------------------------------------------------
// tmux 通道（服务在跑才启用；未跑 = 返回 null，走无头兜底）
// ---------------------------------------------------------------------------

/** tmux 全部 pane 列表：[{pane, command, path}]；tmux 不可用/服务未跑返回 []。 */
function tmuxPanes() {
  try {
    const out = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_current_command}\t#{pane_current_path}'], { timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
    return String(out).split('\n').filter(Boolean).map((l) => { const [pane, command, cwd] = l.split('\t'); return { pane, command, cwd }; });
  } catch { return []; }
}

/** 找「正在 cwd 里跑 source 对应 CLI」的 pane（启发式：进程名匹配 + pane 当前目录一致）。 */
export function tmuxPaneFor(source, cwd) {
  const t = CLI_TARGETS[source];
  if (!t || !cwd) return null;
  return tmuxPanes().find((p) => p.command === t.bin && p.cwd === cwd)?.pane ?? null;
}

async function deliverViaTmux(pane, text) {
  await execFileP('tmux', ['send-keys', '-t', pane, '-l', text], { timeout: 1500 });
  await execFileP('tmux', ['send-keys', '-t', pane, 'Enter'], { timeout: 1500 });
  return { ok: true, via: 'tmux send-keys → ' + pane };
}

// ---------------------------------------------------------------------------
// 无头投递（detached spawn；输出落盘 0600）
// ---------------------------------------------------------------------------

/**
 * 无头投递用的净化环境：剥掉宿主进程可能注入的 ANTHROPIC_* / CLAUDE* 变量，
 * 让 CLI 回落到自身配置（~/.claude/settings.json 的 env 块 = CC Switch 供应商）。
 * 实测（2026-10-06）：从 Claude 桌面 App 子进程环境直接 spawn 会 "Not logged in"
 * （桌面 App 的内部 ANTHROPIC_BASE_URL 抢了优先级）；净化后 claude/codex/kimi 均按用户配置鉴权。
 */
function sanitizedEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_|CLAUDECODE|CLAUDE_CODE_|CLAUDE_CODE$)/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 无头续会话投递。spawn 后观察 2.5s 的快速失败窗口：立即退出的 CLI 几乎必然是
 * 配置/鉴权类错误（zcode 的 "Model creation failed"——独立 CLI 无桌面登录态，建不出
 * account:* provider；claude 的 "Not logged in"），读日志尾巴如实回报 failed，
 * 不再把静默失败当「已投递」（与 ME3 抓过的 pid-undefined 假成功同类）。活过窗口的回合
 * 继续异步执行，写入各自会话文件后观察跟随器自动看到。
 */
/** 无头执行公共路径：detached spawn + 2.5s 快速失败窗口 + 0600 日志（续会话与新建共用）。 */
async function headlessRun(source, cwd, args, label) {
  const t = CLI_TARGETS[source];
  const bin = resolveCliBin(source);
  if (!bin) return { ok: false, error: 'cli-not-found', detail: t.bin + ' 不在 PATH' };
  try {
    fs.mkdirSync(CONTROL_DIR, { recursive: true });
    const logFile = path.join(CONTROL_DIR, source + '-' + Date.now().toString(36) + '.log');
    const out = fs.openSync(logFile, 'a', 0o600);
    const child = spawn(bin, args, {
      cwd,
      detached: true, stdio: ['ignore', out, out],
      env: { ...sanitizedEnv(), ...cliEnvFor(source, bin) },
    });
    const pid = child.pid;
    if (!pid) {
      // spawn 的 ENOENT（二进制消失 / cwd 已被移动或删除）是异步错误：pid 为 undefined。
      // 不能当「已投递」回报——这是把静默失败当成功的洞（烟测 ME3 抓到）。
      try { child.on('error', () => {}); } catch {}
      try { fs.closeSync(out); } catch { /* ignore */ }
      return { ok: false, error: 'spawn', detail: t.bin + ' 启动失败：二进制或会话目录（cwd）不可用' };
    }
    child.unref();
    const earlyCode = await new Promise((resolve) => {
      const done = (v) => { clearTimeout(timer); resolve(v); };
      const timer = setTimeout(() => done(null), 2500);        // 活过窗口 = 回合正常开跑
      child.on('exit', (code) => done(code));
      child.on('error', () => done(-1));
    });
    if (earlyCode !== null && earlyCode !== 0) {
      let tail = '';
      try { tail = (fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).pop() || '').slice(0, 160); } catch { /* ignore */ }
      try { fs.closeSync(out); } catch { /* ignore */ }
      return { ok: false, error: 'cli-exit', detail: tail || (t.bin + ' 启动后立即退出（code ' + earlyCode + '）') };
    }
    child.on('error', () => { /* pid 已在：真异步错误进日志文件 */ });
    setTimeout(() => { try { fs.closeSync(out); } catch { /* 已随进程退出 */ } }, 30_000).unref();
    return { ok: true, via: t.bin + ' 无头' + label + '（异步，pid ' + pid + '）', pid, logFile };
  } catch (e) {
    return { ok: false, error: 'spawn', detail: String(e.message || e).slice(0, 120) };
  }
}

// ---------------------------------------------------------------------------
// ZCode app-server 管道（2026-10-08 落地；docs/40 §3.12）
//
// `zcode app-server`（ZCode Protocol，stdio NDJSON，信封 {id, method, params}）是桌面 App
// 与引擎之间的官方进程间通道。经探测（本机 ZCode 0.16.9）确认的最小协议面：
//   客户端 → 服务器：session/resume {sessionId} · session/send {sessionId, content, modelSelection?}
//                    · session/list · session/create {workspace, model?} · session/close
//   服务器 → 客户端：session/requestRuntimePreferences（每次 resume 必问，应答
//                    {nativeSearchEnhancementsEnabled:true, memoryEnabled:false,
//                     askUserQuestionAutoResolutionEnabled:true} 即可）；其余反向请求回 -32601；
//                    事件流 state.updated（patch.status running→idle）/ v4/telemetry/event 等。
// 关键能力：session/send 的 modelSelection（{providerId, modelId, options.reasoningLevel}，
// 严格模式）是**逐条消息**的模型覆盖——account 会话也能用非登录态 provider 跑这一回合，
// 不改会话自身保存的模型选择（2026-10-08 实测：会话 session_entry 无新记录）。
// 生命周期红线：回合由 app-server 进程内引擎执行，**进程必须活到 state.updated status=idle**
// 再退出——提前断开 = model_request_cancelled（实测踩坑）。
// ---------------------------------------------------------------------------

const ZCODE_PIPE_PREFS = Object.freeze({
  nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true,
});

/**
 * 管道用的非登录态模型选择。优先级：PET_ZCODE_PIPE_MODEL（"provider/model"，可带第三段 reasoning）
 * > 会话库最近实际用过的非 account provider（session_entry 元数据，不读凭证文件；个人 Key 优先于 builtin）。
 * 都找不到返回 null——调用方如实失败并给指引。
 */
export function pickZcodePipeModel() {
  const envSel = String(process.env.PET_ZCODE_PIPE_MODEL || '').trim();
  if (envSel) {
    const parts = envSel.split('/');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      const sel = { providerId: parts.slice(0, -1).join('/'), modelId: parts[parts.length - 1], via: 'env:PET_ZCODE_PIPE_MODEL' };
      if (parts.length >= 3) sel.options = { reasoningLevel: parts[parts.length - 1] };
      return sel;
    }
    return null;
  }
  const dbFile = process.env.ZCODE_DB || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
  try {
    if (!fs.existsSync(dbFile)) return null;
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT data FROM session_entry WHERE type = 'runtime/model_selection' ORDER BY time_created DESC LIMIT 80`).all();
      let builtinPick = null;
      for (const r of rows) {
        let d; try { d = JSON.parse(r.data); } catch { continue; }
        const sel = d?.modelSelection ?? d;
        if (typeof sel?.providerId !== 'string' || typeof sel?.modelId !== 'string') continue;
        if (sel.providerId.startsWith('account:')) continue;                 // 登录态：正是要绕开的
        const out = { providerId: sel.providerId, modelId: sel.modelId, options: sel.options, via: 'db:recent-non-account' };
        if (sel.providerId.startsWith('builtin:')) { if (!builtinPick) builtinPick = out; continue; }  // 兜底档
        return out;                                                          // 个人 Key provider 优先
      }
      return builtinPick;
    } finally { try { db.close(); } catch { /* ignore */ } }
  } catch { return null; }
}

/** 读会话当前保存的模型选择（session_entry 元数据，只读；用于回合结束后恢复原状）。 */
function readZcodeSessionModel(sessionId) {
  const dbFile = process.env.ZCODE_DB || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
  try {
    if (!fs.existsSync(dbFile)) return null;
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT data FROM session_entry WHERE type = 'runtime/model_selection' AND session_id = ? ORDER BY time_created`).all(sessionId);
      let last = null;
      for (const r of rows) { try { const d = JSON.parse(r.data); last = d?.modelSelection ?? d; } catch { /* ignore */ } }
      return (last && typeof last.providerId === 'string' && typeof last.modelId === 'string') ? last : null;
    } finally { try { db.close(); } catch { /* ignore */ } }
  } catch { return null; }
}

/**
 * 经 app-server 管道向既有会话投递一条消息。
 * 语义对齐无头投递：accepted + 8s 快速失败窗口内无终态错误 → delivered（回合异步执行，
 * 管道进程保活到 turn.completed/failed/30min 上限才关）。进程日志落 CONTROL_DIR/zcode-pipe-*.log（0600）。
 * 副作用（2026-10-08 实测，如实告知）：session/send 的 modelSelection 覆盖会被引擎**原地持久化**为
 * 会话的保存选择，且外部无法恢复为 account:*（独立引擎的 Provider Registry 不含登录态 provider，
 * session/setModel 实测报「Provider Registry 中不存在 Model」）——管道投递后该会话在桌面 App 里的
 * 默认模型即为管道 provider；用户想回 Coding Plan 需在 App 内 /model 手动切回。
 */
async function deliverViaZcodePipe(session, text) {
  const bin = resolveCliBin('zcode');
  if (!bin) return { ok: false, error: 'cli-not-found', detail: 'zcode 不在 PATH' };
  const id = String(session.sessionId || session.id);
  const cwd = session?.cwd && fs.existsSync(session.cwd) ? session.cwd : os.homedir();
  const modelSel = pickZcodePipeModel();
  if (!modelSel) {
    return {
      ok: false, error: 'zcode-pipe-no-model',
      detail: '管道需要一个非登录态 provider：请在 ZCode 里配一个个人 API Key  provider 并任意会话用过一次（管道会自动选用），或用环境变量 PET_ZCODE_PIPE_MODEL=provider/model 显式指定',
    };
  }
  fs.mkdirSync(CONTROL_DIR, { recursive: true });
  const logFile = path.join(CONTROL_DIR, 'zcode-pipe-' + Date.now().toString(36) + '.log');
  let logStream;
  try { logStream = fs.createWriteStream(logFile, { mode: 0o600 }); } catch { logStream = null; }
  const log = (s) => { try { logStream?.write(new Date().toISOString() + ' ' + s + '\n'); } catch { /* ignore */ } };
  let child;
  try {
    child = spawn(bin, ['app-server'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...sanitizedEnv(), ...cliEnvFor('zcode', bin) },
    });
  } catch (e) {
    try { logStream?.end(); } catch { /* ignore */ }
    return { ok: false, error: 'spawn', detail: String(e.message || e).slice(0, 120) };
  }
  if (!child.pid) {
    try { child.on('error', () => {}); } catch { /* ignore */ }
    try { logStream?.end(); } catch { /* ignore */ }
    return { ok: false, error: 'spawn', detail: 'zcode app-server 启动失败（无 pid）' };
  }
  child.on('error', (e) => log('proc error: ' + String(e.message || e)));
  child.stderr.on('data', (d) => log('stderr: ' + String(d).slice(0, 300)));
  log('spawn pid=' + child.pid + ' session=' + id + ' model=' + modelSel.providerId + '/' + modelSel.modelId + '（' + modelSel.via + '）');
  const originalSel = readZcodeSessionModel(id);   // 记录覆盖前选择（覆盖会被引擎持久化，account 不可外部恢复——见函数注释）
  if (originalSel && (originalSel.providerId !== modelSel.providerId || originalSel.modelId !== modelSel.modelId)) {
    log('注意：会话保存的模型选择将由 ' + originalSel.providerId + '/' + originalSel.modelId + ' 切换为 ' + modelSel.providerId + '/' + modelSel.modelId);
  }

  // ---- NDJSON 客户端 ----
  let buf = '';
  let nextId = 0;
  const pending = new Map();
  let terminalErr = null;            // 回合终态错误摘要
  let turnIdle = false;              // 会话回到 idle = 回合完成
  let accepted = false;
  const sendRaw = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { /* ignore */ } };
  child.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      const t = line.trim(); if (!t) continue;
      let m; try { m = JSON.parse(t); } catch { log('non-json: ' + t.slice(0, 120)); continue; }
      if (m.id !== undefined && m.method) {              // 服务器 → 客户端的反向请求
        if (m.method === 'session/requestRuntimePreferences') sendRaw({ id: m.id, result: ZCODE_PIPE_PREFS });
        else sendRaw({ id: m.id, error: { code: -32601, message: 'not supported by CodeAll pipe' } });
        continue;
      }
      if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); m.error ? p.reject(new Error(typeof m.error.message === 'string' ? m.error.message : JSON.stringify(m.error))) : p.resolve(m.result); }
        continue;
      }
      if (m.method === 'session/event') {                 // 会话事件信封（订阅后推送）
        const ty = m.params?.type;
        if (ty === 'turn.completed') { turnIdle = true; log('turn.completed（duration ' + Math.round((m.params?.duration || 0) / 1000) + 's, tokens ' + (m.params?.tokenCount ?? '?') + '）'); }
        else if (ty === 'turn.failed') { terminalErr = terminalErr || ('回合失败：' + String(m.params?.error?.message || '').slice(0, 140)); }
        continue;
      }
      if (m.method === 'computer-use/operation-event') {  // 未订阅成功时的兜底终态信号
        const k = m.params?.kind;
        if (k === 'turn-completed') { turnIdle = true; log('turn-completed（operation-event 兜底）'); }
        else if (k === 'turn-failed' || k === 'turn-cancelled') terminalErr = terminalErr || ('回合终态：' + k);
        continue;
      }
      if (m.method === 'state.updated' && m.params?.scope === 'session') {
        const st = m.params?.patch?.status;
        if (st === 'idle') { turnIdle = true; log('state: idle（回合完成）'); }
        else if (st) log('state: ' + st);
        if (st === 'error') terminalErr = terminalErr || '会话进入 error 状态';
      } else if (m.method === 'v4/telemetry/event') {
        const st = String(m.params?.status || '');
        if (st === 'model_request_failed') terminalErr = terminalErr || ('模型请求失败：' + String(m.params?.error || m.params?.providerId || '').slice(0, 120));
      }
    }
  });
  const call = (method, params, timeoutMs) => new Promise((resolve, reject) => {
    const cid = ++nextId;
    const timer = setTimeout(() => { pending.delete(cid); reject(new Error(method + ' 无响应（' + (timeoutMs / 1000) + 's 超时）')); }, timeoutMs);
    pending.set(cid, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    sendRaw({ id: cid, method, params });
  });
  const cleanup = () => {
    try { sendRaw ? call('session/close', { sessionId: id }, 3000).catch(() => {}) : null; } catch { /* ignore */ }
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } try { logStream?.end(); } catch { /* ignore */ } }, 400).unref();
  };
  try {
    await call('session/resume', { sessionId: id }, 25000);
  } catch (e) {
    log('resume failed: ' + e.message); cleanup();
    return { ok: false, error: 'zcode-pipe-resume', detail: String(e.message).slice(0, 160) };
  }
  // 订阅会话事件流（turn.completed/turn.failed 终态信号）；失败不致命——还有 operation-event 兜底
  call('session/subscribe', { sessionId: id, deliveryKind: 'desktop-continuous' }, 8000)
    .then(() => log('subscribed'))
    .catch((e) => log('subscribe failed（兜底信号仍在）：' + e.message));
  let sendRes;
  try {
    const sel = { providerId: modelSel.providerId, modelId: modelSel.modelId, ...(modelSel.options ? { options: modelSel.options } : {}) };
    sendRes = await call('session/send', { sessionId: id, content: String(text).slice(0, 2000), modelSelection: sel }, 25000);
  } catch (e) {
    log('send failed: ' + e.message); cleanup();
    return { ok: false, error: 'zcode-pipe-send', detail: String(e.message).slice(0, 160) };
  }
  accepted = !!sendRes?.accepted;
  log('send accepted=' + accepted);
  if (!accepted) { cleanup(); return { ok: false, error: 'zcode-pipe-send', detail: 'session/send 未被接受：' + JSON.stringify(sendRes).slice(0, 120) }; }
  // 快速失败窗口：provider 配置错误这类问题会在几秒内以终态错误暴露，不把它当「已投递」
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (terminalErr) { log('terminal within quick window: ' + terminalErr); cleanup(); return { ok: false, error: 'zcode-pipe-turn', detail: terminalErr }; }
    if (turnIdle) break;                                  // 秒回的回合：直接完整跑完
    await new Promise((r) => setTimeout(r, 150));
  }
  // 交付后保活到回合终态（进程活着回合才活着）；30min 硬上限防悬挂
  let settleResolve;
  const settle = new Promise((r) => { settleResolve = r; });
  (async () => {
    const deadline = Date.now() + 30 * 60_000;
    while (!turnIdle && !terminalErr && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
    if (terminalErr) log('turn terminal: ' + terminalErr);
    log(turnIdle ? 'turn done' : 'keep-alive deadline reached');
    cleanup();
    settleResolve({ idle: turnIdle, error: terminalErr });
  })();
  return { ok: true, via: 'zcode app-server 管道（' + modelSel.providerId + '/' + modelSel.modelId + '，异步，pid ' + child.pid + '）', pid: child.pid, logFile, settle };
}

/** ZCode account 会话的 UI 自动化投递：workspace 深链 → 激活 App → 剪贴板粘贴 + 回车。
 *  背景（2026-10-08 定位）：account:* provider 仅能由桌面 App 进程注册，无头续接无解
 *  （凭证可解、active/bundled 目录齐备、login 后复测均仍 "Select a model"）；App 亦无任何
 *  外部输入面（无端口、无应用级 socket、深链仅 workspace/open）。唯一可靠通道是把消息
 *  送进用户眼前的 App 界面。注意：粘贴落在 App 当前聚焦的会话——深链已把目标项目窗口
 *  带到前台，但外部无法核验聚焦的具体会话。
 *  剪贴板保护（2026-10-08）：投递借用系统剪贴板，先 pbpaste 备份原文、粘贴完成后恢复
 *  （尽力而为，仅纯文本；非文本剪贴板内容读不出就不碰）。
 *  权限排障（2026-10-08 实测根因）：System Events 拒绝按键时报错为
 *  「“osascript”不允许发送按键 (1002)」——alpha 包是 ad-hoc 签名，TCC 把按键请求记在
 *  调用链末端程序上（打包态=osascript，开发态=所属终端）。授权条目不在列表里时
 *  第一次被拒的调用会自动登记（未勾选），因此这里检出权限错误后自动打开
 *  「系统设置 → 隐私与安全性 → 辅助功能」，用户勾选一次即可长期生效。
 *  PET_ZCODE_UI_DELIVER=0 可关闭该通道（回落为如实失败）。 */
const UI_PERM_RE = /assistive|accessibility|25211|1002|不允许发送按键|辅助功能/i;
async function deliverViaZcodeUi(session, text) {
  const cwd = session?.cwd && fs.existsSync(session.cwd) ? session.cwd : os.homedir();
  // 借用系统剪贴板前先备份原文（仅纯文本可救；读不出就不备份不恢复）
  let clipBackup = null;
  try { clipBackup = (await execFileP('pbpaste', [], { timeout: 2000 })).stdout; } catch { clipBackup = null; }
  const restoreClip = () => {
    if (clipBackup === null) return;
    try {
      const p = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
      p.on('error', () => {});
      p.stdin.end(clipBackup);
    } catch { /* 恢复失败不改变投递结论 */ }
  };
  try {
    await execFileP('open', ['zcode://workspace/open?path=' + encodeURIComponent(cwd)]);
  } catch { /* 深链失败也继续尝试直接激活 */ }
  await new Promise(r => setTimeout(r, 900));
  await new Promise((resolve, reject) => {
    const p = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', reject);
    p.on('exit', () => resolve());
    p.stdin.end(String(text).slice(0, 2000));
  });
  const script =
    'tell application "ZCode" to activate\n' +
    'delay 0.5\n' +
    'tell application "System Events"\n' +
    '  if not (exists application process "ZCode") then error "ZCode 未运行"\n' +
    '  tell application process "ZCode" to set frontmost to true\n' +
    '  delay 0.3\n' +
    '  keystroke "v" using command down\n' +
    '  delay 0.2\n' +
    '  keystroke return\n' +
    'end tell';
  try {
    // 15s：首次运行系统会弹辅助功能授权窗，等待用户点击的时间必须覆盖在内
    await execFileP('osascript', ['-e', script], { timeout: 15000 });
    // 粘贴已被 ZCode 消费（Cmd+V 同步读剪贴板）：稍等再恢复用户原文
    setTimeout(restoreClip, 700).unref();
    return { ok: true, via: 'ZCode UI 粘贴投递（深链 ' + cwd.slice(-24) + ' → 剪贴板 → 回车）', detail: '已粘贴到 ZCode 当前聚焦的会话输入框并发送（剪贴板已恢复原内容）' };
  } catch (e) {
    restoreClip();
    const msg = String(e.stderr || e.message || e);
    const perm = UI_PERM_RE.test(msg);
    if (perm) {
      // 直接把用户带到授权开关（被拒调用已在列表里登记了未勾选条目）
      try { execFile('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], () => {}); } catch { /* ignore */ }
    }
    return {
      ok: false,
      error: perm ? 'accessibility-permission' : 'ui-automation',
      detail: perm
        ? '需要辅助功能权限：已自动打开「系统设置 → 隐私与安全性 → 辅助功能」，请勾选列表中的 osascript（打包态调用链末端；开发态则是你的终端程序）后重发本条。授权一次长期有效。'
        : msg.slice(0, 140)
    };
  }
}

export async function deliverViaCli(source, session, text) {
  const t = CLI_TARGETS[source];
  if (!t) return { ok: false, error: 'unknown-source' };
  // ZCode account:*（Z.AI Coding Plan 登录态）provider 仅能由桌面 App 进程注册，无头 --resume
  // 必败（"Model creation failed"，docs/40 §3.12）。2026-10-08 起默认走 app-server 管道：
  // 官方 stdio 协议直发消息 + 逐条 modelSelection 覆盖到非登录态 provider（不经上游登录）。
  // 管道不可用/失败时回落 UI 粘贴通道；两者皆可经 env 关闭（PET_ZCODE_PIPE=0 / PET_ZCODE_UI_DELIVER=0）。
  if (source === 'zcode' && typeof session?.provider === 'string' && session.provider.startsWith('account:')) {
    const errs = [];
    if (process.env.PET_ZCODE_PIPE !== '0') {
      const r = await deliverViaZcodePipe(session, text);
      if (r.ok) return r;
      errs.push('管道：' + (r.detail || r.error));
    }
    if (process.env.PET_ZCODE_UI_DELIVER !== '0') {
      const u = await deliverViaZcodeUi(session, text);
      if (u.ok) return u;
      errs.push('UI 粘贴：' + (u.detail || u.error));
    }
    return {
      ok: false, error: 'zcode-account-deliver',
      detail: errs.length
        ? errs.join('；')
        : '该会话是 Z.AI Coding Plan 登录态（' + session.provider + '）：无头投递受上游限制，管道与 UI 粘贴通道均被 env 关闭（PET_ZCODE_PIPE=0 / PET_ZCODE_UI_DELIVER=0）',
    };
  }
  const cwd = session?.cwd || session?.project?.cwd || os.homedir();
  const id = String(session.sessionId || session.id);
  const safe = String(text).slice(0, 2000);
  let args = t.deliverArgs(id, safe);
  // codex exec 在非 git 目录会被「Not inside a trusted directory」挡下；--skip-git-repo-check
  // 只跳过 git 仓库检查（沙箱/审批策略仍由 config.toml 掌管），对用户自己建过会话的目录是合理放行
  if (source === 'codex' && !fs.existsSync(path.join(cwd, '.git'))) args = ['exec', 'resume', '--skip-git-repo-check', id, safe];
  return headlessRun(source, cwd, args, '续会话');
}

/**
 * 投递即新建：无会话可续时，把首条消息直接交给 CLI 的无头新建形态——
 * claude -p / codex exec / kimi -p / zcode --prompt（各自 --help 实测），首条消息即会话的第一回合，
 * 会话文件落盘后观察跟随器自动看到。model 可选（claude --model / codex -m / kimi -m）。
 */
export async function deliverCreateViaCli(source, cwd, text, model = '') {  const t = CLI_TARGETS[source];
  if (!t || !t.createArgs) return { ok: false, error: 'unknown-source' };
  const safe = String(text).slice(0, 2000);
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const wanted = String(model || '').trim().slice(0, 80);
  let args;
  if (source === 'codex') {
    args = ['exec'];
    if (!fs.existsSync(path.join(dir, '.git'))) args.push('--skip-git-repo-check');
    if (wanted) args.push('-m', wanted);
    args.push(safe);
  } else {
    args = [...(wanted && t.modelArgs ? t.modelArgs(wanted) : []), ...t.createArgs(safe)];
  }
  return headlessRun(source, dir, args, '新建（首条消息即会话）');
}

// ---------------------------------------------------------------------------
// Terminal.app / tmux 新建与打开
// ---------------------------------------------------------------------------

/** AppleScript 的 do script：JSON.stringify 的双引号转义与 AppleScript 字符串字面量兼容。 */
function terminalDo(cmd) {
  return execFileP('osascript', ['-e', 'tell application "Terminal" to do script ' + JSON.stringify(cmd)], { timeout: 4000 });
}
function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

/**
 * 新建会话：可见、可交互（tmux 在跑则开 window，否则 Terminal.app 新窗口）。
 * model：可选启动模型（claude --model / codex -m / kimi -m，本机 --help 实测）；
 * 不支持启动指定模型的 CLI（zcode 仅 TUI 内 /model）忽略该参数，照常以默认模型创建。
 */
export async function newCliSession(source, cwd, model = '') {
  const t = CLI_TARGETS[source];
  if (!t) return { ok: false, error: 'unknown-source' };
  const bin = resolveCliBin(source);
  if (!bin) return { ok: false, error: 'cli-not-found', detail: t.bin + ' 不在 PATH' };
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const extra = [...t.interactiveArgs()];
  const wanted = String(model || '').trim().slice(0, 80);
  if (wanted && t.modelArgs) extra.push(...t.modelArgs(wanted));
  const envVars = Object.entries(cliEnvFor(source, bin));        // Terminal/tmux 里跑 CLI 同样需要（zcode 的 provider 路径）
  try {
    if (tmuxPanes().length) {
      await execFileP('tmux', ['new-window', '-c', dir, ...envVars.flatMap(([k, v]) => [k + '=' + v]), bin, ...extra], { timeout: 2000 });
      return { ok: true, via: 'tmux new-window（' + t.bin + ' @ ' + dir + '）' };
    }
    await terminalDo('cd ' + shQuote(dir) + ' && ' + (envVars.length ? envVars.map(([k, v]) => 'export ' + k + '=' + shQuote(v) + '; ').join('') : '') + shQuote(bin) + (extra.length ? ' ' + extra.map(shQuote).join(' ') : ''));
    return { ok: true, via: 'Terminal 新窗口（' + t.bin + ' @ ' + dir + '）' };
  } catch (e) {
    return { ok: false, error: 'terminal', detail: String(e.message || e).slice(0, 120) };
  }
}

/** 打开（续接）既有会话：Terminal.app 新窗口跑 `cli resume <id>`（DSH 走插件，不经此）。
 *  ZCode account:* 会话例外：无头/交互续接都会卡 provider 注册（上游限制），改走
 *  `zcode://workspace/open?path=` 深链把桌面 App 带到该项目（App 内点该会话继续）。 */
export async function openCliSession(source, session) {
  const t = CLI_TARGETS[source];
  if (!t) return { ok: false, error: 'unknown-source' };
  const bin = resolveCliBin(source);
  if (!bin) return { ok: false, error: 'cli-not-found', detail: t.bin + ' 不在 PATH' };
  const dir = session?.cwd && fs.existsSync(session.cwd) ? session.cwd : os.homedir();
  if (source === 'zcode' && typeof session?.provider === 'string' && session.provider.startsWith('account:')) {
    try {
      await execFileP('open', ['zcode://workspace/open?path=' + encodeURIComponent(dir)]);
      return { ok: true, via: 'ZCode 桌面 App 深链（workspace ' + dir.slice(-40) + '；account 会话请在 App 内点击继续）', opened: true };
    } catch (e) {
      return { ok: false, error: 'terminal', detail: '深链打开失败：' + String(e.message || e).slice(0, 100) };
    }
  }
  const id = String(session.sessionId || session.id);
  const envVars = Object.entries(cliEnvFor(source, bin));
  try {
    await terminalDo('cd ' + shQuote(dir) + ' && ' + (envVars.length ? envVars.map(([k, v]) => 'export ' + k + '=' + shQuote(v) + '; ').join('') : '') + shQuote(bin) + ' ' + t.openArgs(id).map(shQuote).join(' '));
    return { ok: true, via: 'Terminal 新窗口（' + t.bin + ' resume ' + id.slice(0, 12) + '…）', opened: true };
  } catch (e) {
    return { ok: false, error: 'terminal', detail: String(e.message || e).slice(0, 120) };
  }
}

// ---------------------------------------------------------------------------
// 统一分发：投递（tmux 优先 → 无头兜底）
// ---------------------------------------------------------------------------

export async function deliverControl(source, session, text) {
  const pane = tmuxPaneFor(source, session?.cwd);
  if (pane) {
    try { return await deliverViaTmux(pane, text); } catch (e) { /* tmux 失败 → 无头兜底 */ }
  }
  return deliverViaCli(source, session, text);
}

// ---------------------------------------------------------------------------
// CLI 自检
// ---------------------------------------------------------------------------

async function main(argv) {
  // ZCode 登录自助通道：独立引擎裸跑 `zcode login` 会因缺 Provider Config 环境变量失败
  // （无法定位 CLI ZCode Built-in Provider Config），这里带全 env 交互式起 login（浏览器授权）。
  if (argv.includes('--login-zcode')) {
    const bin = resolveCliBin('zcode');
    if (!bin) { console.error('未找到 ZCode CLI（App 包内引擎）。请先安装 ZCode 桌面 App。'); process.exit(1); }
    console.log('启动 ZCode 登录（将打开浏览器授权）：' + bin);
    console.log('Provider Config：' + JSON.stringify(cliEnvFor('zcode', bin)));
    const child = spawn(bin, ['login'], { stdio: 'inherit', env: { ...process.env, ...cliEnvFor('zcode', bin) } });
    child.on('exit', code => process.exit(code ?? 0));
    child.on('error', (e) => { console.error('启动失败：' + e.message); process.exit(1); });
    return;
  }
  // app-server 管道自检：node adapters/cli-control.mjs --pipe-zcode <sessionId> [text]
  // 走完 resume → send → 快速失败窗口的真实链路，结果与日志位置打到 stdout。
  if (argv.includes('--pipe-zcode')) {
    const i = argv.indexOf('--pipe-zcode');
    const sessionId = argv[i + 1];
    if (!sessionId) { console.error('用法：--pipe-zcode <sessionId> [text]'); process.exit(1); }
    const text = argv[i + 2] || '（CodeAll 管道自检）请只回复：ok';
    console.log('管道模型选择：' + JSON.stringify(pickZcodePipeModel()));
    const r = await deliverViaZcodePipe({ sessionId, cwd: process.cwd() }, text);
    console.log(JSON.stringify({ ok: r.ok, via: r.via, error: r.error, detail: r.detail, logFile: r.logFile }, null, 2));
    if (!r.ok) process.exit(1);
    // 管道进程活着回合才活着：自检等回合终态再退出（上限 30min）
    console.log('等待回合完成（Ctrl-C 中止会取消回合）…');
    const s = await r.settle;
    console.log('回合终态：' + JSON.stringify(s));
    process.exit(s.idle ? 0 : 1);
  }
  const channels = availableCliChannels();
  console.log('CLI 控制通道：');
  for (const c of channels) console.log('  ✅ ' + c.name + ' → ' + c.bin + '（' + resolveCliBin(c.source) + '）');
  for (const s of Object.keys(CLI_TARGETS)) if (!channels.some((c) => c.source === s)) console.log('  ❌ ' + CLI_TARGETS[s].name + '（' + CLI_TARGETS[s].bin + ' 不在 PATH）');
  const panes = tmuxPanes();
  console.log('tmux：' + (panes.length ? panes.length + ' 个 pane（send-keys 通道激活）' : '服务未跑（无头投递 + Terminal 新窗口）'));
  if (argv.includes('--selftest')) {
    // 机制自检：Terminal do script 通道（无害命令，窗口一闪即关）
    try {
      await execFileP('osascript', ['-e', 'tell application "Terminal" to do script "echo agent-pet-terminal-ok && exit"'], { timeout: 4000 });
      console.log('Terminal.app do script 通道：✅（已开一个自检窗口）');
    } catch (e) { console.log('Terminal.app do script 通道：❌ ' + String(e.message || e).slice(0, 80)); }
  }
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) await main(process.argv.slice(2));
