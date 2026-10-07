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
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);

/** 每个后端的 CLI 定义。args 全部走参数数组（不经 shell）。extraPaths = PATH 之外的兜底二进制位置。 */
export const CLI_TARGETS = Object.freeze({
  'claude-code': Object.freeze({
    name: 'Claude Code',
    bin: 'claude',
    deliverArgs: (id, text) => ['--resume', id, '-p', text],
    openArgs: (id) => ['--resume', id],
    interactiveArgs: () => [],
    extraPaths: () => [],
  }),
  codex: Object.freeze({
    name: 'Codex',
    bin: 'codex',
    deliverArgs: (id, text) => ['exec', 'resume', id, text],
    openArgs: (id) => ['--resume', id],
    interactiveArgs: () => [],
    extraPaths: () => [],
  }),
  'kimi-code': Object.freeze({
    name: 'Kimi Code',
    bin: 'kimi',
    deliverArgs: (id, text) => ['-S', id, '-p', text],
    openArgs: (id) => ['-S', id],
    interactiveArgs: () => [],
    extraPaths: () => [path.join(os.homedir(), '.kimi-code', 'bin', 'kimi')],
  }),
  zcode: Object.freeze({
    name: 'ZCode',
    // CLI 随桌面 App 分发（可执行 .cjs，shebang node；PATH 里叫 zcode，若独立安装）。
    // 上游限制（2026-10-07 实测）：独立 CLI 没有桌面的 Z.AI 登录态（~/.zcode/credentials.json
    // 不存在），无头 --resume 持久化为 account:* provider（coding-plan）的会话会
    // "Model creation failed"；builtin provider 会话可正常续接。快速失败检测会把该错误
    // 如实回报为 failed；用户在终端跑一次 `zcode login` 后 account 会话亦可续接。
    bin: 'zcode',
    // 无头 --prompt 的默认权限档是 yolo——显式压到 build：不越权，无头无人在场时危险操作按拒绝处理
    deliverArgs: (id, text) => ['--resume', id, '--mode', 'build', '--prompt', text],
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
export async function deliverViaCli(source, session, text) {
  const t = CLI_TARGETS[source];
  if (!t) return { ok: false, error: 'unknown-source' };
  const bin = resolveCliBin(source);
  if (!bin) return { ok: false, error: 'cli-not-found', detail: t.bin + ' 不在 PATH' };
  const cwd = session?.cwd || session?.project?.cwd || os.homedir();
  const id = String(session.sessionId || session.id);
  try {
    fs.mkdirSync(CONTROL_DIR, { recursive: true });
    const logFile = path.join(CONTROL_DIR, source + '-' + Date.now().toString(36) + '.log');
    const out = fs.openSync(logFile, 'a', 0o600);
    let args = t.deliverArgs(id, String(text).slice(0, 2000));
    // codex exec 在非 git 目录会被「Not inside a trusted directory」挡下；--skip-git-repo-check
    // 只跳过 git 仓库检查（沙箱/审批策略仍由 config.toml 掌管），对用户自己建过会话的目录是合理放行
    if (source === 'codex' && !fs.existsSync(path.join(cwd, '.git'))) args = ['exec', 'resume', '--skip-git-repo-check', id, String(text).slice(0, 2000)];
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
    return { ok: true, via: t.bin + ' 无头续会话（异步，pid ' + pid + '）', pid, logFile };
  } catch (e) {
    return { ok: false, error: 'spawn', detail: String(e.message || e).slice(0, 120) };
  }
}

// ---------------------------------------------------------------------------
// Terminal.app / tmux 新建与打开
// ---------------------------------------------------------------------------

/** AppleScript 的 do script：JSON.stringify 的双引号转义与 AppleScript 字符串字面量兼容。 */
function terminalDo(cmd) {
  return execFileP('osascript', ['-e', 'tell application "Terminal" to do script ' + JSON.stringify(cmd)], { timeout: 4000 });
}
function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

/** 新建会话：可见、可交互（tmux 在跑则开 window，否则 Terminal.app 新窗口）。 */
export async function newCliSession(source, cwd) {
  const t = CLI_TARGETS[source];
  if (!t) return { ok: false, error: 'unknown-source' };
  const bin = resolveCliBin(source);
  if (!bin) return { ok: false, error: 'cli-not-found', detail: t.bin + ' 不在 PATH' };
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const extra = t.interactiveArgs();
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

/** 打开（续接）既有会话：Terminal.app 新窗口跑 `cli resume <id>`（DSH 走插件，不经此）。 */
export async function openCliSession(source, session) {
  const t = CLI_TARGETS[source];
  if (!t) return { ok: false, error: 'unknown-source' };
  const bin = resolveCliBin(source);
  if (!bin) return { ok: false, error: 'cli-not-found', detail: t.bin + ' 不在 PATH' };
  const dir = session?.cwd && fs.existsSync(session.cwd) ? session.cwd : os.homedir();
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
