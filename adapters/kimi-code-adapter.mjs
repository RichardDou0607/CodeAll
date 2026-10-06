#!/usr/bin/env node
/**
 * adapters/kimi-code-adapter.mjs — Kimi Code 降级适配器（docs/21 M-H Step 2）
 *
 * Spike 结论（M-H Step 1，2026-10-06 本机实测，只读）：
 *   - Kimi Code 1.0.4（com.kimi.code.desktop，Electron）**没有** JSONL/SQLite 会话存储；
 *     会话数据只存在于 Chromium Local Storage（LevelDB）：
 *       ~/Library/Application Support/kimi-code-app/Local Storage/leveldb/{*.log,*.ldb}
 *     键名可见 session_<uuid> / draft / draft-snapshot / wd_workspace_<hash> / workspace-order
 *     （键名样本来自对 000015.log 的 strings 级扫描；未解码任何 value）。
 *   - ~/Library/Logs/kimi-code-app 不存在；家目录无 ~/.kimi*；Partitions/kimi-browser 是内嵌浏览器。
 *   - 按 docs/21 §4 风险分级：「只有 LevelDB/IndexedDB → 不做增量 tail（无稳定性承诺），
 *     降级为进程/日志兜底层」。
 *
 * 降级形态（契约红线 docs/40 §6：不得伪造 turn/tool/approval 事件）：
 *   - 不产生任何会话行/事件；只提供「状态级」信号：
 *     · processRunning  —— 进程是否在跑（由调用方 local-agents 的 ps 探测给出，本模块不重复 ps）
 *     · sessionCount(近似) —— LevelDB 键 session_<uuid> 的去重计数（正则扫 .log/.ldb 字节流，
 *       只数键名，不解码 value；LevelDB 压缩段会漏计 → 明确标 approximate）
 *     · lastActivityMs  —— LevelDB 文件最新 mtime
 *   - UI 侧据此显示「打开 · 已连接（LevelDB 通道，N 个会话(近似)」或「未打开」，
 *     会话列表永不出现 KIMI-CODE 行（宁可少显示，不撒谎）。
 *
 * 用法：
 *   node adapters/kimi-code-adapter.mjs            # 人类可读
 *   node adapters/kimi-code-adapter.mjs --json     # 机器可读
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE = 'kimi-code';
export const AGENT_NAME = 'Kimi Code';
export const KIMI_APP_SUPPORT = process.env.KIMI_APP_SUPPORT || path.join(os.homedir(), 'Library', 'Application Support', 'kimi-code-app');
export const KIMI_LEVELDB = path.join(KIMI_APP_SUPPORT, 'Local Storage', 'leveldb');

/** 观测能力声明（契约 §5.2.1 口径）：降级通道只做存活/计数，不承诺任何事件族。 */
export const OBSERVES = Object.freeze(['session.heartbeat']);

const SESSION_KEY_RE = /session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

/**
 * 近似会话计数：扫描 LevelDB 文件字节流里的 session_<uuid> 键名并去重。
 * 只读、只看键名；.ldb 是分块压缩的，漏计可能（所以叫近似），误计不会（uuid 形态收紧）。
 * 文件读取预算：每文件 ≤ 2MB（本机实测 5~26KB，远低于预算）。
 */
export function countKimiSessions(dir = KIMI_LEVELDB, { budgetBytes = 2 * 1024 * 1024 } = {}) {
  const ids = new Set();
  let files = 0, readBytes = 0, lastActivityMs = null;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { count: 0, approximate: true, files: 0, readBytes: 0, lastActivityMs: null, available: false }; }
  for (const e of ents) {
    if (!e.isFile() || !/\.(log|ldb)$/.test(e.name)) continue;
    const p = path.join(dir, e.name);
    let st; try { st = fs.statSync(p); } catch { continue; }
    lastActivityMs = Math.max(lastActivityMs ?? 0, st.mtimeMs);
    files++;
    if (readBytes >= budgetBytes) continue;
    try {
      const fd = fs.openSync(p, 'r');
      try {
        const len = Math.min(st.size, budgetBytes - readBytes);
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, 0);
        readBytes += n;
        const text = buf.subarray(0, n).toString('latin1');   // latin1：字节直读，键名是 ASCII
        SESSION_KEY_RE.lastIndex = 0;
        let m;
        while ((m = SESSION_KEY_RE.exec(text))) ids.add(m[1]);
      } finally { fs.closeSync(fd); }
    } catch { /* 并发写入/权限：跳过该文件 */ }
  }
  return { count: ids.size, approximate: true, files, readBytes, lastActivityMs, available: files > 0 };
}

/**
 * Kimi Code 降级状态快照。
 * @param {{processRunning?:boolean}} ctx 进程态由 local-agents 的 ps 轮询注入（本模块不起进程）
 */
export function scanKimiStatus(ctx = {}) {
  const s = countKimiSessions();
  const installed = (() => { try { return fs.existsSync(path.join('/Applications', 'Kimi Code.app')) || fs.existsSync(KIMI_APP_SUPPORT); } catch { return false; } })();
  return {
    source: SOURCE, agentName: AGENT_NAME,
    installed, processRunning: !!ctx.processRunning,
    degraded: true, degradeReason: 'session-data-in-leveldb',
    observes: OBSERVES,
    sessionCount: s.available ? s.count : null,
    sessionCountApproximate: true,
    lastActivityMs: s.lastActivityMs,
    dataLocation: KIMI_LEVELDB,
    note: '会话数据仅在 Chromium LevelDB（无稳定性承诺）：只做存活与近似计数，不解析会话内容',
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  const r = scanKimiStatus();
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log('Kimi Code 降级适配（M-H Step 2：LevelDB → 进程级兜底）');
  console.log('  安装：' + (r.installed ? '是' : '否'));
  console.log('  会话计数（近似）：' + (r.sessionCount ?? '—') + ' 个（LevelDB 键名去重，压缩块可能漏计）');
  console.log('  最近活动：' + (r.lastActivityMs ? new Date(r.lastActivityMs).toLocaleString('zh-CN') : '—'));
  console.log('  数据位置：' + r.dataLocation);
  console.log('  observes：' + r.observes.join(', ') + '（不产生任何会话行/事件——契约红线：不伪造）');
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) await main(process.argv.slice(2));
