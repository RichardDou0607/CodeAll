#!/usr/bin/env node
/**
 * adapters/cli-control.mjs — Claude Code / Codex / Kimi Code / ZCode 的控制通道（docs/21 M-D/M-E/M-H/M-L 控制层）
 *
 * 三类动作，全部走各 CLI 的**官方能力**（不注入、不改配置、不绕过各 CLI 自身的权限系统）：
 *
 *   投递（既有会话发一条）：无头（headless）按明确会话 ID 续接，在会话 cwd 里 spawn
 *          claude --resume <id> -p "<text>"
 *          codex  exec resume <id> "<text>"
 *          kimi   -S <id> -p "<text>"
 *          zcode  --resume <id> --mode build --prompt "<text>"（CLI 随 ZCode.app 捆绑分发）
 *        detached 执行、输出落 ~/.agent-pet/cli-control/*.log（0600）；回合结束后转录/rollout/wire
 *        增长，观察跟随器（M-A/M-B/M-H）自动看到状态变化 —— 控制→观察闭环。
 *
 *   新建会话：服务端要求首条消息；CLI 无头新建，ZCode 经 app-server create+send。
 *   打开会话：终端新窗口 `cd <cwd> && <cli> resume <id>`（mac Terminal.app / Windows wt.exe・cmd，
 *             经 platform.openTerminalWindow；DSH 仍走插件，不经此文件）。
 *
 * 安全边界：
 *   - 一律 execFile/spawn 参数数组，**不经 shell 拼接**（防注入）；Terminal 的 AppleScript 用 JSON.stringify 转义。
 *     Windows npm shim（.cmd/.ps1）由平台层解包成 node + 入口 js 直接 spawn，不落 cmd。
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
import { resolveQoderCliBin } from './qoder-adapter.mjs';
import { IS_WIN, IS_LINUX, HOME as PLAT_HOME, resolveCliBinPath, resolveSpawnCommand, spawnCommandArgs, openTerminalWindow } from './platform.mjs';

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// ZCode 会话模型选择的投递副作用保护（2026-10-08 实测定位）
// 独立引擎启动 resume 时会把自己的默认 provider 写进会话的 runtime/model_selection
// （单行 UPDATE、旧值丢失——实测把 account/GLM-5.3-Flash 会话改成了 kimi-k3，随后回合才
// 失败退出）。投递前快照该行，投递后值被改写即恢复快照（无论成败）——只恢复「本次投递
// 改的」，不覆盖用户/桌面 App 的并发写入。这是对自身副作用的定向回滚，非任意写库。
// ---------------------------------------------------------------------------
const ZCODE_DB = process.env.ZCODE_DB || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
export function zcodeSelectionSnapshot(sessionId) {
  try {
    const db = new DatabaseSync(ZCODE_DB, { readOnly: true });
    try {
      const r = db.prepare('SELECT data FROM session_entry WHERE id = ?').get(String(sessionId) + ':runtime-model-selection');
      return r ? String(r.data) : null;
    } finally { db.close(); }
  } catch { return null; }
}
export function zcodeSelectionRestore(sessionId, data, expectedData = null) {
  try {
    const db = new DatabaseSync(ZCODE_DB);
    try {
      const result = expectedData === null
        ? db.prepare('UPDATE session_entry SET data = ?, time_updated = ? WHERE id = ?').run(data, Date.now(), String(sessionId) + ':runtime-model-selection')
        : db.prepare('UPDATE session_entry SET data = ?, time_updated = ? WHERE id = ? AND data = ?').run(data, Date.now(), String(sessionId) + ':runtime-model-selection', expectedData);
      return result.changes === 1;
    } finally { db.close(); }
  } catch { return false; }
}

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
    extraPaths: () => [path.join(os.homedir(), '.kimi-code', 'bin', IS_WIN ? 'kimi.exe' : 'kimi')],
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
    // Windows：CLI 经 npm 全局（%APPDATA%\npm 在 PATH），无 App 包捆绑形态；Linux 同（npm 全局 + PATH）
    extraPaths: () => (IS_WIN || IS_LINUX) ? [] : [path.join('/Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs')],
    /**
     * 桌面 App 进程会注入的 provider 配置路径（CLI 脱离 App 环境运行时缺它 →
     * "无法定位 CLI ZCode Built-in Provider Config" → Model creation failed，2026-10-07 实测）。
     * builtin 取 bin 同级的 App 包 config（../../config/provider）；personal 取 ~/.zcode/v2。
     */
    envFor: (bin) => {
      const out = {};
      const norm = bin ? String(bin).replace(/\\/g, '/') : '';
      // 捆绑 config 取 bin 同级的 App 包 config（mac Resources/../../config/provider；Windows <安装目录>\resources\config\provider）
      const bundled = norm.includes('ZCode.app/') || /\/resources\/glm\//.test(norm)
        ? path.join(path.dirname(path.dirname(bin)), 'config', 'provider', 'zcode-builtin.json')
        : null;
      if (bundled && fs.existsSync(bundled)) out.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = bundled;
      const personal = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');
      if (fs.existsSync(personal)) out.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personal;
      return out;
    },
  }),
  opencode: Object.freeze({
    name: 'OpenCode',
    bin: 'opencode',
    // `opencode run`（v2）：阻塞跑完回合后退出；--session <id> 续接既有会话（不存在才创建）。
    // 不带 --auto：无头时未授权操作按拒绝处理（与 zcode 的 build 档同口径，不越权）。
    // run 会自动接入后台服务（桌面 App 的 opencode-cli serve 或 CLI 自起），回合写入共用库。
    // 注意：-m 是 run 子命令的 flag（顶层无 -m）——新建组参在 deliverCreateViaCli 特例处理，
    // 这里不定义 modelArgs（TUI 交互新建也不支持 -m，与 zcode 同口径忽略模型参数）。
    deliverArgs: (id, text) => ['run', '--session', id, text],
    createArgs: (text) => ['run', text],
    openArgs: (id) => ['--session', id],
    interactiveArgs: () => [],
    extraPaths: () => IS_WIN
      ? [path.join(os.homedir(), '.opencode', 'bin', 'opencode.exe')]
      : [path.join(os.homedir(), '.opencode', 'bin', 'opencode'), path.join('/Applications', 'OpenCode.app', 'Contents', 'Resources', 'opencode-cli')],
  }),
  qoder: Object.freeze({
    name: 'Qoder',
    // qoderclicn（~/.qoder-cn/bin/qoderclicn/qoderclicn-<版本>，版本化命名不在 PATH）：
    // -p 无头（阻塞跑完回合）；-r <id> 续接——CLI 与桌面共用 chat_sessions 库，桌面会话也能续接
    // （--list-sessions 按项目列出同一批 UUID，2026-10-22 实测）。
    // 不用 --dangerously-skip-permissions / --permission-mode bypass_permissions：无头不越权口径。
    bin: 'qoderclicn',
    deliverArgs: (id, text) => ['-p', '-r', id, text],
    createArgs: (text) => ['-p', text],
    openArgs: (id) => ['-r', id],
    interactiveArgs: () => [],
    modelArgs: (model) => ['-m', model],
    extraPaths: () => { const p = resolveQoderCliBin(); return p ? [p] : []; },
  }),
  cursor: Object.freeze({
    name: 'Cursor',
    bin: 'cursor-agent',
    // cursor-agent（2026.10 版）：-p 无头（阻塞跑完回合）；--resume <chatId> 续接 CLI 会话
    // （chats/<hash>/<sessionId>，按 cwd 归档——spawn 的 cwd 必须与原会话一致）。
    // 不用 --force/--yolo（Run Everything）：无头时未授权操作按拒绝处理（不越权口径）。
    deliverArgs: (id, text) => ['-p', '--resume', id, text],
    createArgs: (text) => ['-p', text],
    openArgs: (id) => ['--resume', id],
    interactiveArgs: () => [],
    modelArgs: (model) => ['--model', model],
    extraPaths: () => [path.join(os.homedir(), '.local', 'bin', 'cursor-agent')],
  }),
});

/** 目标 CLI 需要的额外环境（无则空对象）；bin 供按位置推导（zcode 的 App 包内 config）。 */
export function cliEnvFor(source, bin = resolveCliBin(source)) {
  const t = CLI_TARGETS[source];
  return t?.envFor ? t.envFor(bin) : {};
}

const CONTROL_DIR = path.join(os.homedir(), '.agent-pet', 'cli-control');

/**
 * 打开控制日志流（0600，落 CONTROL_DIR）。日志设施不可用时**诊断降级**返回 stream=null，
 * 绝不让日志失败阻断投递或让错误冒泡（qa M2：`mkdirSync` 同步抛错、`createWriteStream` 的
 * 异步 open 失败此前都会变成 unhandled 错误，把整个本地服务带崩——服务无自愈，
 * 崩溃=全源中断且必须重启 App）。
 */
function openControlLog(prefix) {
  const file = path.join(CONTROL_DIR, prefix + '-' + Date.now().toString(36) + '.log');
  try {
    fs.mkdirSync(CONTROL_DIR, { recursive: true });
    const stream = fs.createWriteStream(file, { mode: 0o600 });
    stream.on('error', () => { /* 异步 open/写失败：吞掉，不冒泡 */ });
    return { stream, file };
  } catch {
    return { stream: null, file };
  }
}

/** PATH 里找 CLI 二进制（结果缓存 60s；卸载/改装后自动重查）。解析经平台层（PATHEXT / 路径分隔）。 */
const binCache = new Map();
export function resolveCliBin(source) {
  const t = CLI_TARGETS[source];
  if (!t) return null;
  const hit = binCache.get(source);
  if (hit && Date.now() - hit.at < 60_000) return hit.path;
  const found = resolveCliBinPath(t.bin, t.extraPaths ? t.extraPaths() : []);
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
// tmux 仅用于新建交互窗口；目录相同不能证明 pane 属于指定会话。
// ---------------------------------------------------------------------------

/** tmux 全部 pane 列表：[{pane, command, path}]；tmux 不可用/服务未跑返回 []（Windows 无 tmux，恒 []）。 */
function tmuxPanes() {
  if (IS_WIN) return [];
  try {
    const out = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_current_command}\t#{pane_current_path}'], { timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
    return String(out).split('\n').filter(Boolean).map((l) => { const [pane, command, cwd] = l.split('\t'); return { pane, command, cwd }; });
  } catch { return []; }
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
/**
 * 无头投递公共路径：detached spawn + 2.5s 快速失败窗口 + 0600 日志（续会话与新建共用）。
 * PERF-5（docs/25）：在途台账 + 并发上限——每次投递 spawn 独立 agent 进程（200MB+ 级、存活至回合
 * 结束），默认最多 2 个在途（PET_HEADLESS_CAP 可覆盖，测试用）；超出的返回 busy，由调用方入队自动重试。
 */
const HEADLESS_CAP = Math.max(1, Number(process.env.PET_HEADLESS_CAP || 2) || 2);
const headlessLedger = new Map();     // pid → { pid, source, startedAt, logFile }（进程退出即移除）
export function headlessInFlight() { return [...headlessLedger.values()]; }

async function headlessRun(source, cwd, args, label, envExtra = {}) {
  const t = CLI_TARGETS[source];
  const bin = resolveCliBin(source);
  if (!bin) return { ok: false, error: 'cli-not-found', detail: t.bin + ' 不在 PATH' };
  if (headlessLedger.size >= HEADLESS_CAP)
    return { ok: false, error: 'busy', detail: '无头投递并发已满（' + HEADLESS_CAP + ' 在途）' };
  try {
    fs.mkdirSync(CONTROL_DIR, { recursive: true });
    const logFile = path.join(CONTROL_DIR, source + '-' + Date.now().toString(36) + '.log');
    const out = fs.openSync(logFile, 'a', 0o600);
    // PWD 同步 cwd：opencode v2 客户端按 $PWD（非 getcwd）判定会话项目目录——不覆盖时无头子进程
    // 继承宿主的 PWD，会话全部落进服务进程目录（2026-10-22 实测：spawn cwd=/tmp 仍写 agent桌宠）。
    // Windows npm shim（.cmd/.ps1）先经平台层解包成 node + 入口 js，参数数组直达不经 shell。
    const spawnTarget = spawnCommandArgs(resolveSpawnCommand(bin), args);
    const child = spawn(spawnTarget.file, spawnTarget.args, {
      cwd,
      detached: true, stdio: ['ignore', out, out],
      env: { ...sanitizedEnv(), PWD: cwd, ...cliEnvFor(source, bin), ...envExtra },
      windowsVerbatimArguments: spawnTarget.windowsVerbatimArguments,
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
    headlessLedger.set(pid, { pid, source, startedAt: Date.now(), logFile });
    child.on('exit', () => headlessLedger.delete(pid));
    child.on('error', () => headlessLedger.delete(pid));
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
export function pickZcodePipeModels() {
  const envSel = String(process.env.PET_ZCODE_PIPE_MODEL || '').trim();
  if (envSel) {
    const parts = envSel.split('/');
    const reasoning = parts.length > 2 && ['low', 'medium', 'high', 'max'].includes(parts.at(-1)) ? parts.pop() : 'max';
    if (parts.length >= 2 && parts.every(Boolean)) {
      const sel = { providerId: parts.slice(0, -1).join('/'), modelId: parts.at(-1),
        options: { reasoningLevel: reasoning }, via: 'env:PET_ZCODE_PIPE_MODEL' };
      return [sel];
    }
    return [];
  }
  const dbFile = process.env.ZCODE_DB || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
  try {
    if (!fs.existsSync(dbFile)) return [];
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      // 候选列表（按新近排序，个人 Key 优先于 builtin）：管道逐个尝试，撞配额/限流自动降级到下一个
      const rows = db.prepare(`SELECT data FROM session_entry WHERE type = 'runtime/model_selection' ORDER BY time_created DESC LIMIT 80`).all();
      const personal = [], builtin = [];
      const seen = new Set();
      for (const r of rows) {
        let d; try { d = JSON.parse(r.data); } catch { continue; }
        const sel = d?.modelSelection ?? d;
        if (typeof sel?.providerId !== 'string' || typeof sel?.modelId !== 'string') continue;
        if (sel.providerId.startsWith('account:')) continue;                 // 登录态：正是要绕开的
        const key = sel.providerId + '/' + sel.modelId;
        if (seen.has(key)) continue;
        seen.add(key);
        const out = { providerId: sel.providerId, modelId: sel.modelId,
          options: { reasoningLevel: sel.options?.reasoningLevel || 'max' }, via: 'db:recent-non-account' };
        if (sel.providerId.startsWith('builtin:')) { if (!builtin.length) builtin.push(out); continue; }  // 兜底档
        personal.push(out);
      }
      // 追加 provider_config.json 声明的个人 api-key provider（Key 已配置但近期没用过也在列：
      // 2026-10-08 实测 moonshot 配额耗尽后无候选可降级，正是缺了这一档）
      try {
        const pc = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json'), 'utf8'));
        for (const rule of pc?.config?.providerConfigRules?.providerRules || []) {
          const pid0 = rule?.providerId, mid0 = rule?.config?.modelOrder?.[0];
          const key0 = pid0 + '/' + (mid0 || '');
          if (!pid0 || !mid0 || seen.has(key0)) continue;
          // options 必须带：session/send 的 modelSelection 是严格模式，缺 options.reasoningLevel
          // 会被拒成 "Model creation failed"（2026-10-08 实测 deepseek 无 options 必败、带 max 成功）
          let opts0 = null;
          try {
            const r0 = db.prepare("SELECT data FROM session_entry WHERE type = 'runtime/model_selection' AND data LIKE '%' || ? || '%' ORDER BY time_created DESC LIMIT 1").get('"' + pid0 + '"');
            if (r0) { const d0 = JSON.parse(r0.data)?.modelSelection; if (d0?.options?.reasoningLevel) opts0 = { reasoningLevel: d0.options.reasoningLevel }; }
          } catch { /* ignore */ }
          personal.push({ providerId: pid0, modelId: mid0, options: opts0 || { reasoningLevel: 'max' }, via: 'provider_config.json' });
          seen.add(key0);
        }
      } catch { /* 无配置文件/解析失败：维持 db 候选 */ }
      return [...personal, ...builtin].slice(0, 6);                          // 最多试 6 个：防连环撞墙
    } finally { try { db.close(); } catch { /* ignore */ } }
  } catch { return []; }
}
export function pickZcodePipeModel() {
  return pickZcodePipeModels()[0] ?? null;
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
async function zcodePipeAttempt(session, text, modelSel) {
  const bin = resolveCliBin('zcode');
  if (!bin) return { ok: false, error: 'cli-not-found', detail: 'zcode 不在 PATH' };
  const id = String(session.sessionId || session.id);
  const cwd = session?.cwd && fs.existsSync(session.cwd) ? session.cwd : os.homedir();
  const { stream: logStream, file: logFile } = openControlLog('zcode-pipe');
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
  child.stdin.on('error', (e) => log('stdin error: ' + String(e.message || e)));
  child.stderr.on('data', (d) => log('stderr: ' + String(d).slice(0, 300)));
  let childExited = false;
  child.on('exit', (code) => {
    childExited = true;
    if (!turnIdle && !terminalErr) log('app-server 子进程退出（code ' + code + '），未收到终态信号——按终态清理');
  });
  log('spawn pid=' + child.pid + ' session=' + id + ' model=' + modelSel.providerId + '/' + modelSel.modelId + '（' + modelSel.via + '）');
  const originalSel = readZcodeSessionModel(id);   // 记录覆盖前选择（覆盖会被引擎持久化——见函数注释）
  const originalSelRaw = zcodeSelectionSnapshot(id);  // raw 串：cleanup 时回滚被持久化的覆盖（防止 catalog 的 provider 识别被污染——2026-10-08 回归实测：管道投过的 account 会话此后被当成 moonshot-kimi，account 预检失效直撞无头）
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
  let sendStarted = false;
  let turnStarted = false;
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
        if (sendStarted && ty === 'turn.started') turnStarted = true;
        if (sendStarted && ty === 'turn.completed') { turnIdle = true; log('turn.completed（duration ' + Math.round((m.params?.duration || 0) / 1000) + 's, tokens ' + (m.params?.tokenCount ?? '?') + '）'); }
        else if (sendStarted && ty === 'turn.failed') { terminalErr = terminalErr || ('回合失败：' + String(m.params?.error?.message || '').slice(0, 140)); }
        continue;
      }
      if (m.method === 'computer-use/operation-event') {  // 未订阅成功时的兜底终态信号
        const k = m.params?.kind;
        if (sendStarted && k === 'turn-completed') { turnIdle = true; log('turn-completed（operation-event 兜底）'); }
        else if (sendStarted && (k === 'turn-failed' || k === 'turn-cancelled')) terminalErr = terminalErr || ('回合终态：' + k);
        continue;
      }
      if (m.method === 'state.updated' && m.params?.scope === 'session') {
        const st = m.params?.patch?.status;
        if (sendStarted && st === 'running') turnStarted = true;
        if (sendStarted && turnStarted && st === 'idle') { turnIdle = true; log('state: idle（回合完成）'); }
        else if (st) log('state: ' + st);
        if (sendStarted && st === 'error') terminalErr = terminalErr || '会话进入 error 状态';
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
    try {
      if (originalSelRaw !== null) {
        const nowRaw = zcodeSelectionSnapshot(id);
        if (nowRaw === null || nowRaw === originalSelRaw) clearPipeRollbackMarker(id);       // 无污染/已还原：标记即可清
        else if (matchesPipeSelection(nowRaw, JSON.stringify({ modelSelection: modelSel }))
          && zcodeSelectionRestore(id, originalSelRaw, nowRaw)) {
          log('已回滚管道覆盖持久化的模型选择（恢复为 ' + String(originalSelRaw).slice(0, 90) + '…）');
          clearPipeRollbackMarker(id);
        } else if (!matchesPipeSelection(nowRaw, JSON.stringify({ modelSelection: modelSel }))) {
          clearPipeRollbackMarker(id);    // 用户已改成其它模型，不覆盖用户的选择
        }                                 // 回滚失败：保留标记，下次服务启动补做
      }
    } catch { /* ignore */ }
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
    if (originalSelRaw !== null) writePipeRollbackMarker(id, originalSelRaw, JSON.stringify({ modelSelection: sel }));  // 发送前落标记：服务中途重启也能补回滚
    sendStarted = true;
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
    if (terminalErr) { log('terminal within quick window: ' + terminalErr); cleanup(); return { ok: false, error: 'zcode-pipe-turn', detail: terminalErr, accepted }; }
    if (childExited) { cleanup(); return { ok: false, error: 'zcode-pipe-exit', detail: 'app-server 在回合结束前退出', accepted }; }
    if (turnIdle) break;                                  // 秒回的回合：直接完整跑完
    await new Promise((r) => setTimeout(r, 150));
  }
  // 交付后保活到回合终态（进程活着回合才活着）；30min 硬上限防悬挂
  let settleResolve;
  const settle = new Promise((r) => { settleResolve = r; });
  (async () => {
    const deadline = Date.now() + 30 * 60_000;
    // childExited 看门狗：子进程死了就没有终态信号了，立即清理（否则回滚要等 30 分钟兜底）
    while (!turnIdle && !terminalErr && !childExited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
    if (terminalErr) log('turn terminal: ' + terminalErr);
    log(turnIdle ? 'turn done' : 'keep-alive deadline reached');
    cleanup();
    settleResolve({ idle: turnIdle, error: turnIdle ? null : terminalErr || (childExited ? 'app-server 提前退出' : '回合保活超时') });
  })();
  return { ok: true, via: 'zcode app-server 管道（' + modelSel.providerId + '/' + modelSel.modelId + '，异步，pid ' + child.pid + '）', pid: child.pid, logFile, settle };
}

// 管道回滚标记：服务在管道回合进行中被重启时，标记文件让下次启动补做回滚
// （子进程随服务死掉 → 回合断裂，但选择污染会留在会话上）。恢复仅当当前值仍等于
// 管道写入的覆盖值（pipeRaw）——用户中途自己改过就不动。
const pipeRollbackMarker = (sid) => path.join(CONTROL_DIR, 'zcode-rollback-' + encodeURIComponent(sid) + '.json');
function writePipeRollbackMarker(sid, originalRaw, pipeRaw) {
  try {
    fs.mkdirSync(CONTROL_DIR, { recursive: true });
    fs.writeFileSync(pipeRollbackMarker(sid), JSON.stringify({ sessionId: sid, originalRaw, pipeRaw, at: Date.now() }), { mode: 0o600 });
  } catch { /* ignore */ }
}
function clearPipeRollbackMarker(sid) { try { fs.rmSync(pipeRollbackMarker(sid), { force: true }); } catch { /* ignore */ } }
function matchesPipeSelection(raw, pipeRaw) {
  try {
    const now = JSON.parse(raw)?.modelSelection;
    const pipe = JSON.parse(pipeRaw)?.modelSelection;
    return now?.providerId === pipe?.providerId && now?.modelId === pipe?.modelId
      && now?.options?.reasoningLevel === pipe?.options?.reasoningLevel;
  } catch { return false; }
}
export function recoverZcodePendingRollbacks() {
  let n = 0;
  try {
    for (const f of fs.readdirSync(CONTROL_DIR).filter(n2 => n2.startsWith('zcode-rollback-'))) {
      const file = path.join(CONTROL_DIR, f);
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        let clear = false;
        if (j?.sessionId && j.originalRaw && j.pipeRaw) {
          const now = zcodeSelectionSnapshot(j.sessionId);
          if (now === j.originalRaw || now === null || !matchesPipeSelection(now, j.pipeRaw)) clear = true;
          else if (zcodeSelectionRestore(j.sessionId, j.originalRaw, now)) { n++; clear = true; }
        } else {
          clear = true;
        }
        if (clear) fs.rmSync(file, { force: true });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return n;
}

const PIPE_QUOTA_RE = /quota|insufficient balance|too many requests|429|rate.?limit|exceeded_current_quota|模型请求失败|model_request_failed/i;  // 「模型请求失败：<provider>」（遥测串）无配额文案，但模型请求失败天然是 provider 侧——同样换下一个候选
/**
 * 管道投递（带配额降级）：按候选列表逐个尝试非登录态 provider——撞配额/限流自动换下一个
 * （2026-10-08 实测：moonshot 个人 Key 耗尽后管道整条失效；自动降级到 deepseek 等其余个人 Key）。
 * env 指定 PET_ZCODE_PIPE_MODEL 时不降级（用户显式指定的就是唯一意图）。
 */
async function deliverViaZcodePipe(session, text) {
  const current = readZcodeSessionModel(String(session.sessionId || session.id));
  const candidates = current && !current.providerId.startsWith('account:')
    ? [{ ...current, options: current.options?.reasoningLevel ? current.options : { reasoningLevel: 'max' }, via: 'session:model-selection' }]
    : pickZcodePipeModels();
  if (!candidates.length) {
    return {
      ok: false, error: 'zcode-pipe-no-model',
      detail: '管道需要一个非登录态 provider：请在 ZCode 里配一个个人 API Key provider 并任意会话用过一次（管道会自动选用），或用环境变量 PET_ZCODE_PIPE_MODEL=provider/model 显式指定',
    };
  }
  const fixed = !!current && !current.providerId.startsWith('account:') || !!String(process.env.PET_ZCODE_PIPE_MODEL || '').trim();
  const tried = [];
  for (let i = 0; i < candidates.length; i++) {
    const r = await zcodePipeAttempt(session, text, candidates[i]);
    if (r.ok) return r;
    tried.push(candidates[i].providerId + '/' + candidates[i].modelId + '：' + String(r.detail || r.error).slice(0, 90));
    if (r.accepted || fixed || !PIPE_QUOTA_RE.test(String(r.detail || ''))) return r;    // 已接受的消息不可换模型自动重发
  }
  return { ok: false, error: 'zcode-pipe-turn', detail: '全部候选 provider 均失败（配额/限流）：' + tried.join('；') };
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
  // UI 自动化通道是 macOS 专用（osascript + System Events + pbcopy）；Windows 无 TCC 等价面，
  // SendKeys 类方案对「投进哪个会话」同样无法核验——如实报不支持，不静默换通道。
  // Linux 同理（无辅助功能授权模型；xdotool 对「投进哪个会话」同样无法核验）。
  if (IS_WIN || IS_LINUX) return { ok: false, error: 'ui-automation', detail: 'ZCode UI 粘贴投递通道为 macOS 专用（osascript + 辅助功能）；本平台无等价可核验面，请用 ZCode 桌面 App 内直接操作' };
  const cwd = session?.cwd && fs.existsSync(session.cwd) ? session.cwd : os.homedir();
  // 权限前置探测（2026-10-08）：无辅助功能权限时一个像素都不能动——此前先开深链再等
  // osascript 被拒，用户看到的是「只打开了文件夹、消息没进会话」。探测用只读查询，无副作用。
  try {
    await execFileP('osascript', ['-e', 'tell application "System Events" to keystroke ""'], { timeout: 4000 });  // 空按键：与真实粘贴同一 TCC 权限面（进程名查询不需要 AX 权限，探测不出按键被拒）
  } catch (e) {
    const msg = String(e.stderr || e.message || e);
    const perm = UI_PERM_RE.test(msg);
    if (perm) {
      try { execFile('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], () => {}); } catch { /* ignore */ }
      return { ok: false, error: 'accessibility-permission', detail: '需要辅助功能权限：已打开「系统设置 → 隐私与安全性 → 辅助功能」，勾选列表中的 osascript（打包态调用链末端；开发态则是你的终端程序）后重发。本次未打开任何窗口、未动剪贴板。' };
    }
    return { ok: false, error: 'ui-automation', detail: msg.slice(0, 140) };
  }
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
  // 权限预检（2026-10-08 用户反馈：未授权时深链先打开了文件夹、消息却送不进会话——
  // 先探 System Events，未授权直接如实报错，不再产生"只开了个文件夹"的困惑副作用）
  try {
    await execFileP('osascript', ['-e', 'tell application "System Events" to count application processes'], { timeout: 4000 });
  } catch (e0) {
    const msg0 = String((e0.stderr || e0.message || e0));
    if (UI_PERM_RE.test(msg0)) {
      try { execFile('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'], () => {}); } catch { /* ignore */ }
      return { ok: false, error: 'accessibility-permission', detail: '需要辅助功能权限（已自动打开系统设置）：勾选「辅助功能」列表中的 osascript 后重发。未授权前不再打开工作区窗口' };
    }
  }
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
  if (source === 'zcode') {
    if (process.env.PET_ZCODE_PIPE === '0') return { ok: false, error: 'zcode-pipe-disabled', detail: 'ZCode 精确会话投递管道已关闭；消息未发送' };
    return deliverViaZcodePipe(session, text);
  }
  // ZCode 统一使用精确 sessionId 的 app-server 管道；无头续接和 UI 粘贴
  // 都无法保证登录态/聚焦目标正确，不能作为自动投递回退。
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
  const selectionBefore = source === 'zcode' ? zcodeSelectionSnapshot(id) : null;
  const result = await headlessRun(source, cwd, args, '续会话');
  // 成败都查：成功回合虽已按引擎默认模型跑完，但「保存的选择」不该被连带改掉（2026-10-08
  // 实测成功投递同样留下改写值，只查 !ok 会漏）
  if (source === 'zcode' && selectionBefore !== null) {
    const after = zcodeSelectionSnapshot(id);
    if (after !== null && after !== selectionBefore && zcodeSelectionRestore(id, selectionBefore)) {
      result.detail += '；已回滚该会话被独立引擎改写的模型选择';
    }
  }
  return result;
}

/**
 * 经 app-server 管道新建会话（2026-10-08 实测协议）：session/create
 *   { workspace: { workspacePath, workspaceKey }, model: { providerId, modelId, options? }, thoughtLevel? }
 * 返回 { session: { sessionId, model, title, ... }, ... }。model 为用户显式指定的个人 Key 模型
 * （登录态 account:* 被管道 Provider Registry 拒绝——"Provider Registry 中不存在 Model"，
 * 实测；登录态会话须在 ZCode 桌面内新建）。text 非空时紧随 session/send 发首条消息并保活到回合 idle。
 * 空 text = 只建空会话（模型已确定，ZCode 里面即用）。
 */
export async function createViaZcodePipe(workspace, text = '', model = '') {
  if (!String(text || '').trim()) return { ok: false, error: 'empty-message', detail: '新建会话必须包含首条消息' };
  const bin = resolveCliBin('zcode');
  if (!bin) return { ok: false, error: 'cli-not-found', detail: 'zcode 不在 PATH' };
  const dir = workspace && fs.existsSync(workspace) ? workspace : os.homedir();
  // 模型解析：显式 "providerId/modelId"（providerId 可含冒号，取最后一个 / 切分）；
  // 未指定则取候选首位（personal Key 优先，同管道投递口径）。登录态明确拒绝并给指引。
  let sel = null;
  const wanted = String(model || '').trim();
  if (wanted) {
    const i = wanted.lastIndexOf('/');
    if (i > 0 && i < wanted.length - 1) {
      sel = { providerId: wanted.slice(0, i), modelId: wanted.slice(i + 1) };
    } else {
      return { ok: false, error: 'bad-model', detail: '模型格式应为 providerId/modelId（如 deepseek/deepseek-flash）' };
    }
  } else {
    sel = pickZcodePipeModels()[0] ?? null;
  }
  if (!sel) return { ok: false, error: 'zcode-pipe-no-model', detail: '未指定模型且无可用个人 Key 候选：请在对话框中选定模型（或配置一个个人 API Key provider）' };
  if (sel.providerId.startsWith('account:')) {
    return { ok: false, error: 'zcode-account-model', detail: '登录态模型（' + sel.providerId + '）不能经管道新建（Provider Registry 无登录态），请在 ZCode 桌面 App 内新建，或改选个人 Key 模型（如 deepseek/…）' };
  }
  if (!sel.options) {
    try {
      const r0 = new DatabaseSync(path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite'), { readOnly: true });
      // 用同 provider 最近一次 reasoning 档；无则 max
      let lvl = 'max';
      for (const r of r0.prepare("SELECT data FROM session_entry WHERE type = 'runtime/model_selection' ORDER BY time_created DESC LIMIT 40").all()) {
        try { const d = JSON.parse(r.data)?.modelSelection; if (d?.providerId === sel.providerId && d?.options?.reasoningLevel) { lvl = d.options.reasoningLevel; break; } } catch { /* ignore */ }
      }
      r0.close(); sel.options = { reasoningLevel: lvl };
    } catch { sel.options = { reasoningLevel: 'max' }; }
  }
  const { stream: logStream, file: logFile } = openControlLog('zcode-pipe');
  const log = (s) => { try { logStream?.write(new Date().toISOString() + ' ' + s + '\n'); } catch { /* ignore */ } };
  let child;
  try {
    child = spawn(bin, ['app-server'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...sanitizedEnv(), ...cliEnvFor('zcode', bin) } });
  } catch (e) {
    try { logStream?.end(); } catch { /* ignore */ }
    return { ok: false, error: 'spawn', detail: String(e.message || e).slice(0, 120) };
  }
  if (!child.pid) {
    try { child.on('error', () => {}); } catch { /* ignore */ }
    try { logStream?.end(); } catch { /* ignore */ }
    return { ok: false, error: 'spawn', detail: 'zcode app-server 启动失败（无 pid）' };
  }
  let buf = ''; let nextId = 0; const pending = new Map();
  let turnIdle = false, terminalErr = null, childExited = false;
  const sendRaw = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { /* ignore */ } };
  child.stdout.on('data', (d) => {
    buf += d; const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      const s = line.trim(); if (!s) continue;
      let m; try { m = JSON.parse(s); } catch { continue; }
      if (m.id !== undefined && m.method) { if (m.method === 'session/requestRuntimePreferences') sendRaw({ id: m.id, result: ZCODE_PIPE_PREFS }); else sendRaw({ id: m.id, error: { code: -32601, message: 'not supported by CodeAll pipe' } }); continue; }
      if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) { const p2 = pending.get(m.id); if (p2) { pending.delete(m.id); m.error ? p2.reject(new Error(typeof m.error.message === 'string' ? m.error.message : JSON.stringify(m.error))) : p2.resolve(m.result); } continue; }
      if (m.method === 'state.updated' && m.params?.scope === 'session') {
        const st = m.params?.patch?.status;
        if (st === 'idle') { turnIdle = true; log('state: idle（回合完成）'); }
        if (st === 'error') terminalErr = terminalErr || '会话进入 error 状态';
      } else if (m.method === 'v4/telemetry/event') {
        const st = String(m.params?.status || '');
        if (st === 'model_request_failed') terminalErr = terminalErr || ('模型请求失败：' + String(m.params?.providerId || '').slice(0, 60));
      }
    }
  });
  child.stderr.on('data', (d) => log('stderr: ' + String(d).slice(0, 200)));
  child.on('exit', (code) => { childExited = true; log('app-server 退出（code ' + code + '）'); });
  const call = (method, params, timeoutMs) => new Promise((resolve, reject) => {
    const cid = ++nextId;
    const timer = setTimeout(() => { pending.delete(cid); reject(new Error(method + ' 无响应（' + (timeoutMs / 1000) + 's 超时）')); }, timeoutMs);
    pending.set(cid, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    sendRaw({ id: cid, method, params });
  });
  log('spawn pid=' + child.pid + ' create workspace=' + dir + ' model=' + sel.providerId + '/' + sel.modelId);
  let created;
  try {
    created = await call('session/create', { workspace: { workspacePath: dir, workspaceKey: dir }, model: sel }, 25000);
  } catch (e) {
    log('create failed: ' + e.message);
    try { child.kill(); } catch { /* ignore */ } try { logStream?.end(); } catch { /* ignore */ }
    return { ok: false, error: 'zcode-pipe-create', detail: String(e.message).slice(0, 180) };
  }
  const sid = created?.session?.sessionId;
  if (!sid) {
    try { child.kill(); } catch { /* ignore */ } try { logStream?.end(); } catch { /* ignore */ }
    return { ok: false, error: 'zcode-pipe-create', detail: '会话已创建但未返回 sessionId' };
  }
  log('created session=' + sid + ' model=' + JSON.stringify(created.session.model || sel) + ' title=' + String(created.session.title || '').slice(0, 40));
  if (!String(text || '').trim()) {
    // 空会话：create 即完成（会话与模型已落库），稍候关闭进程
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } try { logStream?.end(); } catch { /* ignore */ } }, 1500).unref();
    return { ok: true, via: 'zcode app-server 管道新建（模型 ' + sel.providerId + '/' + sel.modelId + '，会话 ' + sid.slice(0, 18) + '…）', sessionId: sid, pid: child.pid, logFile };
  }
  // 首条消息：subscribe + send，保活到回合终态（进程活着回合才活着；30min 上限）
  call('session/subscribe', { sessionId: sid, deliveryKind: 'desktop-continuous' }, 8000).catch((e) => log('subscribe failed（兜底信号仍在）：' + e.message));
  try {
    const sent = await call('session/send', { sessionId: sid, content: String(text).slice(0, 2000), modelSelection: sel }, 25000);
    if (!sent?.accepted) { log('send 未接受'); try { child.kill(); } catch { /* ignore */ } try { logStream?.end(); } catch { /* ignore */ } return { ok: false, error: 'zcode-pipe-send', detail: '首条消息未被接受：' + JSON.stringify(sent).slice(0, 100) }; }
    log('send accepted=true（首条消息）');
  } catch (e) {
    log('send failed: ' + e.message);
    try { child.kill(); } catch { /* ignore */ } try { logStream?.end(); } catch { /* ignore */ }
    return { ok: false, error: 'zcode-pipe-send', detail: '会话已创建（' + sid.slice(0, 18) + '…）但首条消息发送失败：' + String(e.message).slice(0, 120) };
  }
  (async () => {
    const deadline = Date.now() + 30 * 60_000;
    while (!turnIdle && !terminalErr && !childExited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
    log(turnIdle ? 'turn done' : terminalErr ? 'turn terminal: ' + terminalErr : 'keep-alive deadline reached');
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } try { logStream?.end(); } catch { /* ignore */ } }, 400).unref();
  })();
  return { ok: true, via: 'zcode app-server 管道新建 + 首条消息（模型 ' + sel.providerId + '/' + sel.modelId + '，会话 ' + sid.slice(0, 18) + '…）', sessionId: sid, pid: child.pid, logFile };
}

/**
 * 投递即新建：无会话可续时，把首条消息直接交给 CLI 的无头新建形态——
 * claude -p / codex exec / kimi -p / zcode --prompt（各自 --help 实测），首条消息即会话的第一回合，
 * 会话文件落盘后观察跟随器自动看到。model 可选（claude --model / codex -m / kimi -m）。
 */
/** ZCode 投递即新建（管道版）：session/create 指定 workspace + model，session/send 带首条消息。
 *  用户要求新建会话必须显式选模型（2026-10-08）；无头 CLI 无 --model 参数，app-server 是
 *  唯一能带模型新建的通道。模型须为非登录态 provider；失败不自动降级到默认模型。 */
export async function deliverCreateViaZcodePipe(cwd, text, model, modelOptions) {
  const bin = resolveCliBin('zcode');
  if (!bin) return { ok: false, error: 'cli-not-found', detail: 'zcode 不在 PATH' };
  if (!String(text || '').trim()) return { ok: false, error: 'empty-message', detail: '新建会话必须包含首条消息' };
  if (cwd && !path.isAbsolute(cwd)) return { ok: false, error: 'bad-cwd', detail: '工作目录必须是绝对路径' };
  try { if (cwd) fs.mkdirSync(cwd, { recursive: true }); }
  catch (e) { return { ok: false, error: 'bad-cwd', detail: '无法创建工作目录：' + String(e.message).slice(0, 120) }; }
  const dir = cwd || os.homedir();
  const wanted = typeof model === 'object' && model ? model : null;
  const separator = typeof model === 'string' ? model.indexOf('/') : -1;
  const providerId = wanted?.providerId || (separator > 0 ? model.slice(0, separator) : '');
  const modelId = wanted?.modelId || (separator > 0 ? model.slice(separator + 1) : '');
  const reasoningLevel = String(modelOptions?.reasoningLevel || '').trim();
  const modelSel = providerId && modelId && reasoningLevel
    ? { providerId, modelId, options: { reasoningLevel } } : null;
  if (!modelSel) return { ok: false, error: 'zcode-pipe-model', detail: '新建会话需指定模型（provider/model）和思考强度' };
  if (wanted && (!wanted.canCreate || !wanted.reasoningEfforts.includes(reasoningLevel)))
    return { ok: false, error: 'reasoning-not-supported', detail: '该注册模型不能使用所选思考强度新建' };
  if (modelSel.providerId.startsWith('account:')) return { ok: false, error: 'zcode-account-model', detail: '独立引擎不支持 Z.AI 登录态模型；请选个人 Key 模型，或在 ZCode 中创建' };
  const { stream: logStream, file: logFile } = openControlLog('zcode-pipe');
  const log = (s) => { try { logStream?.write(new Date().toISOString() + ' ' + s + '\n'); } catch {} };
  let child;
  try { child = spawn(bin, ['app-server'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...sanitizedEnv(), ...cliEnvFor('zcode', bin) } }); }
  catch (e) { return { ok: false, error: 'spawn', detail: String(e.message || e).slice(0, 120) }; }
  if (!child.pid) { try { child.on('error', () => {}); } catch {} return { ok: false, error: 'spawn', detail: 'zcode app-server 启动失败（无 pid）' }; }
  log('create spawn pid=' + child.pid + ' model=' + modelSel.providerId + '/' + modelSel.modelId);
  child.on('error', (e) => log('proc error: ' + String(e.message || e)));
  child.stdin.on('error', (e) => log('stdin error: ' + String(e.message || e)));
  child.stderr?.on('data', (d) => log('stderr: ' + String(d).slice(0, 200)));
  let buf = ''; let nextId = 0; const pending = new Map();
  let terminalErr = null; let turnIdle = false; let childExited = false; let created = null; let sendStarted = false; let turnStarted = false;
  child.on('exit', () => { childExited = true; });
  const sendRaw = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch {} };
  child.stdout.on('data', (d) => {
    buf += d; const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      const s = line.trim(); if (!s) continue;
      let m; try { m = JSON.parse(s); } catch { continue; }
      if (m.id !== undefined && m.method) {
        if (m.method === 'session/requestRuntimePreferences') sendRaw({ id: m.id, result: ZCODE_PIPE_PREFS });
        else sendRaw({ id: m.id, error: { code: -32601, message: 'not supported' } });
        continue;
      }
      if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
        const p2 = pending.get(m.id); if (p2) { pending.delete(m.id); m.error ? p2.reject(new Error(String(m.error.message || JSON.stringify(m.error)).slice(0, 120))) : p2.resolve(m.result); } continue;
      }
      if (m.method === 'session/event') {
        const ty = m.params?.type;
        if (sendStarted && ty === 'turn.started') turnStarted = true;
        if (sendStarted && ty === 'turn.completed') { turnIdle = true; log('turn.completed'); }
        else if (sendStarted && ty === 'turn.failed') terminalErr = terminalErr || ('回合失败：' + String(m.params?.error?.message || '').slice(0, 120));
      }
      if (m.method === 'state.updated' && m.params?.scope === 'session') {
        const st = m.params?.patch?.status;
        if (sendStarted && st === 'running') turnStarted = true;
        if (sendStarted && turnStarted && st === 'idle') { turnIdle = true; log('state: idle'); }
        if (sendStarted && st === 'error') terminalErr = terminalErr || '会话进入 error 状态';
      }
      if (sendStarted && m.method === 'computer-use/operation-event') {
        const kind = m.params?.kind;
        if (kind === 'turn-completed') turnIdle = true;
        else if (kind === 'turn-failed' || kind === 'turn-cancelled') terminalErr = terminalErr || ('回合终态：' + kind);
      }
      if (sendStarted && m.method === 'v4/telemetry/event' && m.params?.status === 'model_request_failed') {
        terminalErr = terminalErr || '模型请求失败';
      }
    }
  });
  const call = (method, params, timeoutMs) => new Promise((resolve, reject) => {
    const cid = ++nextId;
    const timer = setTimeout(() => { pending.delete(cid); reject(new Error(method + ' 超时')); }, timeoutMs);
    pending.set(cid, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    sendRaw({ id: cid, method, params });
  });
  const cleanup = () => { try { child.kill(); } catch {} try { logStream?.end(); } catch {} };
  try {
    // workspace 是对象（Zod 强校验）：{workspacePath, workspaceKey}；返回 result.sessionId（实测探针 2026-10-08）
    created = await call('session/create', { workspace: { workspacePath: dir, workspaceKey: path.basename(dir) || 'workspace' }, model: modelSel }, 25000);
    created = { sessionId: created?.sessionId ?? created?.session?.sessionId };
    if (!created.sessionId) throw new Error('session/create 未返回 sessionId');
    log('created: ' + String(created?.sessionId || '?').slice(0, 24));
    await call('session/subscribe', { sessionId: created.sessionId, deliveryKind: 'desktop-continuous' }, 8000)
      .catch(() => log('subscribe failed; using state/operation events'));
    sendStarted = true;
    const sendRes = await call('session/send', { sessionId: created?.sessionId, content: String(text).slice(0, 2000), modelSelection: modelSel }, 25000);
    if (!sendRes?.accepted) throw new Error('session/send 未被接受');
    log('send accepted');
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !terminalErr && !turnIdle && !childExited) await new Promise((r) => setTimeout(r, 150));
    if (terminalErr || childExited) { cleanup(); return { ok: false, error: 'zcode-pipe-turn', detail: terminalErr || 'app-server 提前退出', sessionId: created.sessionId, accepted: true }; }
    const settle = (async () => { const dl = Date.now() + 30 * 60_000; while (!turnIdle && !terminalErr && !childExited && Date.now() < dl) await new Promise((r) => setTimeout(r, 1000)); cleanup(); return { idle: turnIdle, error: turnIdle ? null : terminalErr || (childExited ? 'app-server 提前退出' : '回合保活超时') }; })();
    return { ok: true, via: 'zcode app-server 管道新建（' + modelSel.providerId + '/' + modelSel.modelId + '，会话 ' + String(created.sessionId).slice(0, 18) + '…）', sessionId: created.sessionId, pid: child.pid, logFile, settle };
  } catch (e) { cleanup(); return { ok: false, error: created?.sessionId ? 'zcode-pipe-send' : 'zcode-pipe-create',
    detail: String(e.message || e).slice(0, 160), sessionId: created?.sessionId || null, accepted: sendStarted }; }
}

export async function deliverCreateViaCli(source, cwd, text, model = '', reasoningEffort = '') {
  const t = CLI_TARGETS[source];
  if (!t || !t.createArgs) return { ok: false, error: 'unknown-source' };
  if (!String(text || '').trim()) return { ok: false, error: 'empty-message', detail: '新建会话必须包含首条消息' };
  if (source === 'zcode') return { ok: false, error: 'zcode-pipe-required', detail: 'ZCode 新建必须使用可指定模型和会话的管道' };
  if (!String(reasoningEffort || '').trim()) return { ok: false, error: 'reasoning-required', detail: '新建会话必须选择思考强度' };
  if (cwd && !path.isAbsolute(cwd)) return { ok: false, error: 'bad-cwd', detail: '工作目录必须是绝对路径' };
  try { if (cwd) fs.mkdirSync(cwd, { recursive: true }); }
  catch (e) { return { ok: false, error: 'bad-cwd', detail: '无法创建工作目录：' + String(e.message).slice(0, 120) }; }
  const safe = String(text).slice(0, 2000);
  const dir = cwd || os.homedir();
  const registered = typeof model === 'object' && model ? model : null;
  if (registered && (!registered.canCreate || !registered.reasoningEfforts.includes(reasoningEffort)))
    return { ok: false, error: 'reasoning-not-supported', detail: '该注册模型不能使用所选思考强度新建' };
  const wanted = String(registered?.cliModel || model || '').trim();
  if (!wanted) return { ok: false, error: 'model-required', detail: '请选择已注册模型' };
  let args;
  if (source === 'codex') {
    args = ['exec'];
    if (!fs.existsSync(path.join(dir, '.git'))) args.push('--skip-git-repo-check');
    if (wanted) args.push('-m', wanted);
    args.push('-c', 'model_reasoning_effort=' + JSON.stringify(reasoningEffort));
    args.push(safe);
  } else if (source === 'opencode') {
    // -m 是 run 子命令的 flag（opencode 顶层无 -m，实测前置会立即报错退出）
    args = ['run'];
    if (wanted) args.push('-m', wanted);
    args.push(safe);
  } else {
    args = [...(wanted && t.modelArgs ? t.modelArgs(wanted) : []),
      ...(source === 'claude-code' ? ['--effort', reasoningEffort] : []), ...t.createArgs(safe)];
  }
  // Kimi CLI 未暴露 --effort；其 Kimi provider 从此环境变量读取思考强度。
  const envExtra = source === 'kimi-code' ? { KIMI_MODEL_THINKING_EFFORT: reasoningEffort } : {};
  return headlessRun(source, dir, args, '新建（首条消息即会话）', envExtra);
}

// ---------------------------------------------------------------------------
// Terminal.app / tmux 新建与打开
// ---------------------------------------------------------------------------

/** 深链打开（ZCode account 会话 → 桌面 App）：mac `open`，Windows `cmd start`，linux xdg-open。 */
async function openDeepLink(url) {
  if (IS_WIN) return execFileP('cmd.exe', ['/d', '/s', '/c', 'start', '', url], { timeout: 4000, windowsVerbatimArguments: false });
  if (IS_LINUX) return execFileP('xdg-open', [url], { timeout: 4000 });
  return execFileP('open', [url], { timeout: 4000 });
}

/**
 * 新建会话：可见、可交互（tmux 在跑则开 window，否则平台终端新窗口）。
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
  const envVars = Object.entries(cliEnvFor(source, bin));        // 终端/tmux 里跑 CLI 同样需要（zcode 的 provider 路径）
  try {
    if (tmuxPanes().length) {
      await execFileP('tmux', ['new-window', '-c', dir, ...envVars.flatMap(([k, v]) => [k + '=' + v]), bin, ...extra], { timeout: 2000 });
      return { ok: true, via: 'tmux new-window（' + t.bin + ' @ ' + dir + '）' };
    }
    const r = await openTerminalWindow({ cwd: dir, env: Object.fromEntries(envVars), file: bin, args: extra });
    if (!r.ok) return { ok: false, error: 'terminal', detail: r.error || r.via };
    return { ok: true, via: r.via + '（' + t.bin + ' @ ' + dir + '）' };
  } catch (e) {
    return { ok: false, error: 'terminal', detail: String(e.message || e).slice(0, 120) };
  }
}

/** 打开（续接）既有会话：终端新窗口跑 `cli resume <id>`（DSH 走插件，不经此）。
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
      await openDeepLink('zcode://workspace/open?path=' + encodeURIComponent(dir));
      return { ok: true, via: 'ZCode 桌面 App 深链（workspace ' + dir.slice(-40) + '；account 会话请在 App 内点击继续）', opened: true };
    } catch (e) {
      return { ok: false, error: 'terminal', detail: '深链打开失败：' + String(e.message || e).slice(0, 100) };
    }
  }
  const id = String(session.sessionId || session.id);
  const envVars = Object.entries(cliEnvFor(source, bin));
  try {
    const r = await openTerminalWindow({ cwd: dir, env: Object.fromEntries(envVars), file: bin, args: t.openArgs(id) });
    if (!r.ok) return { ok: false, error: 'terminal', detail: r.error || r.via };
    return { ok: true, via: r.via + '（' + t.bin + ' resume ' + id.slice(0, 12) + '…）', opened: true };
  } catch (e) {
    return { ok: false, error: 'terminal', detail: String(e.message || e).slice(0, 120) };
  }
}

// ---------------------------------------------------------------------------
// 统一分发：只按显式会话 ID 续接，避免同目录多个 pane 时误投。
// ---------------------------------------------------------------------------

export async function deliverControl(source, session, text) {
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
  console.log('tmux：' + (panes.length ? panes.length + ' 个 pane（仅用于新建交互窗口）' : '服务未跑（无头投递 + Terminal 新窗口）'));
  if (argv.includes('--selftest')) {
    // 机制自检：终端窗口通道（无害命令，窗口一闪即关/数秒自退）
    if (IS_WIN) {
      const r = await openTerminalWindow({ cwd: os.homedir(), env: {}, file: 'cmd.exe', args: ['/d', '/c', 'echo agent-pet-terminal-ok & timeout /t 2'] });
      console.log('终端窗口通道（wt/start）：' + (r.ok ? '✅（' + r.via + '，已开一个自检窗口）' : '❌ ' + (r.error || '')));
    } else if (IS_LINUX) {
      // linux 三级链自检（xdg-terminal-exec → gnome-terminal → kitty；platform 层选路）
      const r = await openTerminalWindow({ cwd: os.homedir(), env: {}, file: 'bash', args: ['-c', 'echo agent-pet-terminal-ok; sleep 2'] });
      console.log('终端窗口通道（linux 三级链）：' + (r.ok ? '✅（via ' + r.via + '，已开一个自检窗口）' : '❌ ' + (r.error || '')));
    } else {
      try {
        await execFileP('osascript', ['-e', 'tell application "Terminal" to do script "echo agent-pet-terminal-ok && exit"'], { timeout: 4000 });
        console.log('Terminal.app do script 通道：✅（已开一个自检窗口）');
      } catch (e) { console.log('Terminal.app do script 通道：❌ ' + String(e.message || e).slice(0, 80)); }
    }
  }
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) await main(process.argv.slice(2));
