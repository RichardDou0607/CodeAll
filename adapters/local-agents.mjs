#!/usr/bin/env node
/**
 * adapters/local-agents.mjs — 本地域 agent 软件状态探测（总控「软件状态」面板数据源）
 *
 * 四态模型（用户 2026-10-06 定义）：
 *   not-installed（未下载）→ closed（未打开）→ open-unconnected（已打开·未连接）→ connected（打开·已连接）
 *
 * 三级探测（全部只读，不启动/不杀进程，不读凭证）：
 *   安装：候选路径存在性检查（App 包 / CLI 二进制 / 配置与数据目录）。
 *         思路同 cc-switch（src-tauri/src/config.rs 的 ConfigStatus{exists,path}：~/.claude、~/.codex 等）。
 *   运行：ps axo pid=,ucomm=,args= 每轮只跑一次，逐 agent 用一条正则匹配整行（pid+ucomm+args）。
 *   连接：观察通道是否有「新鲜数据」——会话/状态文件 mtime 在 45s 窗口内（对齐契约 §4.4）。
 *         DSH 例外：插件 socket 是真连接（优先），日志新鲜度兜底（由调用方经 ctx.dsh 注入）。
 *
 * 用法：
 *   node adapters/local-agents.mjs            # 人类可读表格
 *   node adapters/local-agents.mjs --json     # 机器可读
 *   import { scanLocalAgents } from '...'     # framed.mjs 每 3s 调一次
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { KIMI_LEVELDB, scanKimiCatalog, scanKimiLegacyCount } from './kimi-code-adapter.mjs';

const execFileP = promisify(execFile);
const HOME = os.homedir();

/** 连接判定窗口：与契约 §4.4 的 45s 离线判定同口径。 */
export const CONNECT_WINDOW_MS = 45_000;
/** 会话/状态文件新鲜度探测的 stat 预算（条目数），防止巨型目录拖慢扫描。 */
const STAT_BUDGET = 4000;

/**
 * 本地域 agent 注册表。新增软件只需追加一行：
 *   installPaths  安装证据（任一存在即视为已安装；全部进 evidence 供 UI tooltip）
 *   processRe     运行判定（对 ps 整行匹配；务必收窄，避免误伤相近名字的进程）
 *   activity      连接判定（这些目录下 fileRe 文件的最新 mtime）
 *   appBundle     有 App 包时顺带读版本号（PlistBuddy，结果缓存）
 */
export const LOCAL_AGENTS = Object.freeze([
  {
    id: 'dsh', name: 'DeepSeek Harness', source: 'dsh',
    installPaths: ['/Applications/DeepSeek Harness.app', path.join(HOME, '.dsh')],
    appBundle: '/Applications/DeepSeek Harness.app',
    processRe: /DeepSeek Harness\.app\/|(^|\s)DeepSeek Harness(\s|$)/,
    activity: [{ dir: path.join(HOME, '.dsh', 'sessions'), depth: 3, fileRe: /\.jsonl(\.zstd)?$/ }],
    note: '连接 = DSH 插件 socket（真连接）或会话日志 45s 内有写入',
  },
  {
    id: 'claude-code', name: 'Claude Code', source: 'claude-code',
    installPaths: [
      path.join(HOME, '.claude'),
      '/usr/local/bin/claude', '/opt/homebrew/bin/claude', path.join(HOME, '.local/bin/claude'),
      ...fs.existsSync(path.join(HOME, '.vscode/extensions'))
        ? fs.readdirSync(path.join(HOME, '.vscode/extensions')).filter((d) => /^anthropic\.claude-code/.test(d)).map((d) => path.join(HOME, '.vscode/extensions', d))
        : [],
    ],
    processRe: /(^|\/)claude(\s|$)|@anthropic-ai\/claude-code|anthropic\.claude-code/,  // 大小写敏感：不匹配 Claude.app（聊天 App，E 级排除）
    activity: [{ dir: path.join(HOME, '.claude', 'projects'), depth: 2, fileRe: /\.jsonl$/ }],
    note: '连接 = 转录 JSONL 45s 内有写入',
  },
  {
    id: 'codex', name: 'Codex', source: 'codex',
    installPaths: [
      path.join(HOME, '.codex'),
      '/usr/local/bin/codex', '/opt/homebrew/bin/codex', path.join(HOME, '.local/bin/codex'),
      '/Applications/Codex++.app', '/Applications/Codex++ 2.app',
    ],
    processRe: /(^|\/)codex(\s|$)|Codex\+\+/,  // codex-disk-* 不匹配（要求 codex 后是空白/行尾）
    activity: [{ dir: path.join(HOME, '.codex', 'sessions'), depth: 4, fileRe: /^rollout-.*\.jsonl$/ }],
    note: '含 Codex++ 桌面壳；连接 = rollout 45s 内有写入',
  },
  {
    id: 'kimi-code', name: 'Kimi Code', source: 'kimi-code',
    installPaths: ['/Applications/Kimi Code.app', path.join(HOME, '.kimi-code'), path.join(HOME, '.kimi-code', 'bin', 'kimi'), path.join(HOME, 'Library/Application Support/kimi-code-app')],
    appBundle: '/Applications/Kimi Code.app',
    processRe: /Kimi Code\.app\/|(^|\/|\/bin\/)kimi(\s|$)/,   // 桌面 App 或 ~/.kimi-code/bin/kimi CLI
    // M-H A 路径：CLI 核心写 ~/.kimi-code（state.json + wire.jsonl）；LevelDB 是前端层缓存（兜底信号）
    activity: [
      { dir: path.join(HOME, '.kimi-code', 'sessions'), depth: 4, fileRe: /(wire\.jsonl|state\.json)$/ },
      { dir: KIMI_LEVELDB, depth: 1, fileRe: /\.(log|ldb)$/ },
    ],
    note: 'A 路径：state.json 目录 + wire.jsonl 事件 tail（LevelDB 仅前端层兜底）',
  },
  {
    id: 'agentos', name: 'AgentOS M1', source: 'agentos',
    installPaths: [path.join(HOME, '.local/bin/agent'), path.join(HOME, 'agentos')],
    processRe: /(^|\/)agent(\s|$)/,  // 要求 agent 是独立路径段/行首 + 空白：ssh-agent、--agent、agent桌宠 均不匹配
    activity: [{ dir: path.join(HOME, 'agentos', '.state'), depth: 3, fileRe: /.*/ }],
    note: '自研执行体（远端控制见 docs/21 §6）',
  },
  {
    id: 'opencode', name: 'OpenCode', source: 'opencode',
    installPaths: [
      path.join(HOME, '.config/opencode'), path.join(HOME, '.local/share/opencode'),
      '/usr/local/bin/opencode', '/opt/homebrew/bin/opencode',
    ],
    processRe: /(^|\/)opencode(\s|$)|ai\.opencode\.desktop|OpenCode\.app\//i,
    activity: [{ dir: path.join(HOME, '.local/share/opencode'), depth: 1, fileRe: /^opencode\.db(-wal|-shm)?$/ }],
    note: '接入首选 ACP（docs/21 M-I）',
  },
]);

// ---------------------------------------------------------------------------
// 探测原语
// ---------------------------------------------------------------------------

/** ps 快照：每轮扫描只跑一次；失败（权限/异常）返回空串 = 全部「运行未知→按未运行」。 */
async function psLines() {
  try {
    const { stdout } = await execFileP('ps', ['axo', 'pid=,ucomm=,args='], { maxBuffer: 16 * 1024 * 1024, timeout: 4000 });
    return stdout.split('\n');
  } catch { return []; }
}

/** 深度受限的最新 mtime（只 stat 预算内的条目；返回 ms 或 null）。 */
export function newestMtime(dir, depth, fileRe, budget = STAT_BUDGET) {
  let best = 0, n = 0;
  const walk = (d, dep) => {
    if (dep < 0 || n > budget) return;
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++n > budget) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, dep - 1);
      else if (fileRe.test(e.name)) { try { const m = fs.statSync(p).mtimeMs; if (m > best) best = m; } catch { /* 并发删除 */ } }
    }
  };
  walk(dir, depth);
  return best || null;
}

/** macOS App 版本号（PlistBuddy；每 bundle 只读一次，结果永久缓存）。 */
const versionCache = new Map();
async function macAppVersion(bundle) {
  if (!bundle) return null;
  if (versionCache.has(bundle)) return versionCache.get(bundle);
  let v = null;
  try {
    const { stdout } = await execFileP('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(bundle, 'Contents/Info.plist')], { timeout: 2000 });
    v = stdout.trim() || null;
  } catch { /* 无包/读失败 */ }
  versionCache.set(bundle, v);
  return v;
}

/** CLI 版本号：直接读 npm 全局 package.json（不起进程，毫秒级）。 */
function pkgVersion(candidates) {
  for (const p of candidates) {
    try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); if (j?.version) return j.version; } catch { /* 下一个 */ }
  }
  return null;
}

/** Kimi 会话计数（30s 缓存）：优先 ~/.kimi-code 目录（精确）；无则退回 LevelDB 键名去重（近似）。 */
let kimiCountCache = { at: 0, count: null, approximate: false };
function kimiSessionCount() {
  if (kimiCountCache.count === null || Date.now() - kimiCountCache.at > 30_000) {
    try {
      const cat = scanKimiCatalog();
      if (cat.sessionCount > 0 || fs.existsSync(path.join(HOME, '.kimi-code', 'sessions'))) {
        kimiCountCache = { at: Date.now(), count: cat.sessionCount, approximate: false };
      } else {
        kimiCountCache = { at: Date.now(), count: scanKimiLegacyCount().count, approximate: true };
      }
    } catch { kimiCountCache = { at: Date.now(), count: null, approximate: true }; }
  }
  return kimiCountCache;
}

// ---------------------------------------------------------------------------
// 四态计算
// ---------------------------------------------------------------------------

/**
 * 全量扫描本机 agent 软件状态。
 * @param {{now?:number, windowMs?:number, dsh?:{plugin?:boolean, lastEventAt?:number}}} ctx
 *   dsh.plugin / dsh.lastEventAt 由 framed.mjs 注入（插件 socket = 真连接；事件时间戳兜底）。
 * @returns {Promise<{agents:Array, counts:Object, scannedAt:number, tookMs:number}>}
 */
export async function scanLocalAgents(ctx = {}) {
  const t0 = process.hrtime.bigint();
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const windowMs = ctx.windowMs ?? CONNECT_WINDOW_MS;
  const lines = await psLines();
  const agents = [];
  for (const a of LOCAL_AGENTS) {
    const evidence = [];
    for (const p of a.installPaths) { try { if (fs.existsSync(p)) evidence.push(p); } catch { /* ignore */ } }
    const procs = [];
    for (const line of lines) {
      if (procs.length >= 5) break;                       // 计数封顶 5，够显示即可
      if (a.processRe.test(line)) { const pid = Number((line.trim().match(/^(\d+)/) || [])[1]); if (Number.isFinite(pid)) procs.push(pid); }
    }
    const installed = evidence.length > 0 || procs.length > 0;
    if (procs.length) evidence.push('运行中进程 pid=' + procs.join(','));
    // 连接：只对「已安装且在运行」的软件判定（未运行时保留 lastActivity 仅供展示）
    let lastActivityMs = null;
    for (const act of a.activity) { const m = newestMtime(act.dir, act.depth, act.fileRe); if (m && (!lastActivityMs || m > lastActivityMs)) lastActivityMs = m; }
    let connected = false, connectionKind = null;
    if (installed && procs.length > 0) {
      if (a.id === 'dsh' && ctx.dsh?.plugin) { connected = true; connectionKind = 'plugin'; }
      else if (lastActivityMs && now - lastActivityMs < windowMs) { connected = true; connectionKind = 'log'; }
      else if (a.id === 'dsh' && Number.isFinite(ctx.dsh?.lastEventAt) && now - ctx.dsh.lastEventAt < windowMs) { connected = true; connectionKind = 'event'; }
    }
    const status = !installed ? 'not-installed' : procs.length === 0 ? 'closed' : connected ? 'connected' : 'open-unconnected';
    agents.push({
      id: a.id, name: a.name, source: a.source || a.id, status,
      installed, running: procs.length > 0, connected, connectionKind,
      processes: procs.length, pids: procs,
      lastActivityMs, lastActivityWithinWindow: !!(lastActivityMs && now - lastActivityMs < windowMs),
      sessionCount: a.id === 'kimi-code' ? kimiSessionCount().count : undefined,
      sessionCountApproximate: a.id === 'kimi-code' ? kimiSessionCount().approximate || undefined : undefined,
      version: (await macAppVersion(a.appBundle))
        ?? (a.id === 'claude-code' ? pkgVersion(['/usr/local/lib/node_modules/@anthropic-ai/claude-code/package.json', path.join(HOME, '.local/lib/node_modules/@anthropic-ai/claude-code/package.json')]) : null)
        ?? (a.id === 'codex' ? pkgVersion([path.join(HOME, '.local/lib/node_modules/@openai/codex/package.json'), '/usr/local/lib/node_modules/@openai/codex/package.json']) : null),
      evidence, note: a.note ?? null,
    });
  }
  const counts = {
    connected: agents.filter((x) => x.status === 'connected').length,
    openUnconnected: agents.filter((x) => x.status === 'open-unconnected').length,
    closed: agents.filter((x) => x.status === 'closed').length,
    notInstalled: agents.filter((x) => x.status === 'not-installed').length,
  };
  return { agents, counts, scannedAt: now, tookMs: Number((Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2)) };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const STATUS_LABEL = { connected: '打开 · 已连接', 'open-unconnected': '已打开 · 未连接', closed: '未打开', 'not-installed': '未下载' };

async function main(argv) {
  const r = await scanLocalAgents();
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
  const rel = (ms) => (!ms ? '—' : Math.round((r.scannedAt - ms) / 1000) + 's 前');
  console.log('本机 agent 软件状态（' + r.counts.connected + ' 已连接 / ' + r.counts.openUnconnected + ' 打开未连接 / ' + r.counts.closed + ' 未打开 / ' + r.counts.notInstalled + ' 未下载）  扫描 ' + r.tookMs + ' ms\n');
  for (const a of r.agents) {
    console.log('  ' + STATUS_LABEL[a.status].padEnd(12) + ' ' + a.name.padEnd(16) + (a.version ? 'v' + a.version + '  ' : ''.padEnd(0)) + '  进程 ' + a.processes + '  上次活动 ' + rel(a.lastActivityMs) + (a.sessionCount != null ? '  ' + (a.sessionCountApproximate ? '≈' : '') + a.sessionCount + ' 会话' : '') + (a.connectionKind ? '  通道=' + a.connectionKind : '') + (a.note ? '  · ' + a.note : ''));
    for (const e of a.evidence.slice(0, 4)) console.log('      · ' + e);
  }
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) await main(process.argv.slice(2));
