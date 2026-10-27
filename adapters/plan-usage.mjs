#!/usr/bin/env node
/**
 * adapters/plan-usage.mjs — Coding Plan 订阅使用情况（计划身份 × 本地用量 × 配额/余额）
 *
 * 回答用户问题：「各家 coding plan 现在用了多少、订阅的什么档位、还剩多少」。
 *
 * 证据分层（**全部本机只读**，零网络、零凭证使用）：
 *   身份层  各家本地留下的计划/登录元数据——ZCode coding-plan-cache.json（entitlement 缓存）、
 *           Codex auth.json 的 auth_mode、Cursor state.vscdb 的 stripeMembershipType、
 *           Copilot SKU、Qoder app-status、Claude oauthAccount 有无、Kimi 登录态。
 *           **绝不读凭证值**：JWT 只解白名单 claim（plan 类型），token/密钥列只报「存在」。
 *   用量层  复用 usage-collect 八源扫描（精确/请求级/估算口径透传）＋ ZCode model_usage
 *           按 provider 精确拆分（account:* = 登录态 coding plan 计费，2026-10-26 实测 schema：
 *           status completed/cancelled/error，started_at 为 epoch ms，token 列 input/output/
 *           cache_read_input_tokens/cache_creation_input_tokens）。
 *   配额层  仅本机有缓存者展示：DeepSeek 余额账本（~/.dsh/.dshw-usage.json，余额即配额）；
 *           其余厂商云端配额本地均无缓存——**安全红线：不持凭证调厂商 API**（docs/40 §3.14、
 *           CHANGELOG 2026-10-22「读云端需拿凭证调官方 API——触碰凭证违反安全红线，不做」）。
 *
 * 用法：
 *   node adapters/plan-usage.mjs --fast   # 身份+配额（毫秒级，不跑用量扫描）
 *   node adapters/plan-usage.mjs --json   # 全量（含八源用量时间窗）
 *   import { scanPlanUsage } from '...'   # framed.mjs 传入 usage 扫描结果
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { openZcodeDb, ZCODE_DB } from './zcode-adapter.mjs';
import { appSupport, localData } from './platform.mjs';

const HOME = process.env.PLAN_USAGE_HOME || os.homedir();
const DAY_MS = 86_400_000;

/** 身份/配额提取结果缓存（60s；与目录扫描热缓存同节奏，避免每 5s 快照都碰 sqlite）。 */
const IDENTITY_TTL_MS = 60_000;
let identityCache = { at: 0, data: null };

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
/** 安装痕迹判定：相对家目录路径；以 / 开头的条目按绝对路径处理（path.join 会吞掉绝对前缀）。 */
const installHit = (rel) => fileExists(String(rel).startsWith('/') ? rel : path.join(HOME, rel));
function fileExists(p) { try { return fs.existsSync(p); } catch { return false; } }
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 邮箱打码：a267536@qq.com → a***@qq.com（本地展示口径：不外传原文，界面只见得到账号形状）。 */
export function maskEmail(v) {
  const s = String(v ?? '');
  const at = s.indexOf('@');
  if (at <= 0) return s ? s.slice(0, 2) + '***' : null;
  return s.slice(0, 1) + '***' + s.slice(at);
}
/** 账号/登录名打码：Richard_Dou → R***u（保首尾各 1 字符，中段打码）。 */
export function maskName(v) {
  const s = String(v ?? '');
  if (!s) return null;
  if (s.length <= 2) return s.slice(0, 1) + '***';
  return s.slice(0, 1) + '***' + s.slice(-1);
}

/** 用户标注档位（~/.agent-pet/plan-overrides.json，0600）：厂商云端不落盘的档位由用户手工标注，
 *  界面明确显示「标注」徽标与来源；本地证据出现后以实测为准（不一致时标注优先并提示冲突）。 */
export const PLAN_OVERRIDES_FILE = process.env.PET_PLAN_OVERRIDES || path.join(HOME, '.agent-pet/plan-overrides.json');
function readPlanOverrides() {
  const j = readJson(PLAN_OVERRIDES_FILE);
  if (!j || typeof j !== 'object' || Array.isArray(j)) return {};
  const out = {};
  for (const [k, v] of Object.entries(j)) {
    if (typeof v === 'string') out[k] = { planName: v };
    else if (v && typeof v === 'object' && typeof v.planName === 'string') out[k] = { planName: v.planName, asOf: v.asOf ?? null, note: v.note ?? null };
  }
  return out;
}

function openSqliteReadOnly(dbPath) {
  try { return new DatabaseSync(dbPath, { readOnly: true }); } catch { return null; }
}

// ---------------------------------------------------------------------------
// 身份提取器（每家一个：返回 {status, planName, account, evidence[], notes[], detail?}）
// status ∈ active（订阅在用）| api-billing（API/余额计费）| signed-in（已登录·档位未知）
//        | not-signed-in（已安装·无登录证据）| not-installed
// ---------------------------------------------------------------------------

/** 智谱 GLM Coding Plan：entitlement 缓存 + 凭证键名（只取名字）＋ model_usage 按 provider 拆分（导出复用）。 */
function glmIdentity(o) {
  const evidence = [], notes = [];
  const cache = readJson(path.join(HOME, '.zcode/v2/coding-plan-cache.json'));
  let entitled = null, entitledAt = null;
  if (cache?.entryStatus?.items) {
    entitledAt = cache.entryStatus.updatedAt ?? null;
    const items = cache.entryStatus.items;
    const avail = Object.entries(items).filter(([, v]) => v?.status === 'available').map(([k]) => String(k).replace(/^builtin:/, ''));
    const blocked = Object.entries(items).filter(([, v]) => v?.status !== 'available').map(([k, v]) => String(k).replace(/^builtin:/, '') + '（' + (v?.reason ?? 'unavailable') + '）');
    if (avail.length) { entitled = avail.join(' + '); evidence.push({ file: '~/.zcode/v2/coding-plan-cache.json', field: 'entryStatus.items', value: 'available: ' + avail.join(', ') }); }
    if (blocked.length) evidence.push({ file: '~/.zcode/v2/coding-plan-cache.json', field: 'entryStatus.items', value: '其余: ' + blocked.join(', ') });
    if (entitledAt) notes.push('entitlement 缓存更新于 ' + new Date(entitledAt).toLocaleString('zh-CN') + '（可能滞后，实际计费以 model_usage 为准）');
  }
  // 凭证文件只读**键名**（值不进内存输出）：键里带 coding-plan 身份与账号形状
  const credKeys = (() => { const j = readJson(path.join(HOME, '.zcode/v2/credentials.json')); return j ? Object.keys(j) : []; })();
  const planKeyNames = credKeys.filter((k) => /coding-plan/i.test(k)).map((k) => {
    const m = k.match(/account:([a-z0-9-]*coding-plan[a-z0-9-]*):account:(\d{3})\d+([:.]|$)/i);
    return m ? m[1] + '（账号 ' + m[2] + '***）' : k.replace(/^(account-provider|oauth):/, '');
  });
  if (planKeyNames.length) evidence.push({ file: '~/.zcode/v2/credentials.json', field: '键名（值不读）', value: planKeyNames.join(' · ') });
  const status = (entitled || planKeyNames.length) ? 'active' : (fileExists(path.join(HOME, '.zcode')) ? 'signed-in' : 'not-installed');
  return { status, planName: entitled || null, account: null, evidence, notes, at: entitledAt };
}

/** ZCode model_usage 按 provider 拆分（account:* = 登录态 coding plan；其余 = 自备 API key）。 */
export function zcodeProviderSplit(dbPath = ZCODE_DB, nowMs = Date.now()) {
  const empty = { available: false, providers: [], error: null };
  const db = openZcodeDb(dbPath);
  if (!db) return { ...empty, error: 'db-unavailable' };
  try {
    const b = { h5: nowMs - 5 * 3_600_000, today: new Date(nowMs).setHours(0, 0, 0, 0), d7: nowMs - 7 * DAY_MS, d30: nowMs - 30 * DAY_MS };
    const win = (cut) => `SUM(CASE WHEN started_at >= ${cut} THEN 1 ELSE 0 END)`;
    const winTok = (cut, col) => `SUM(CASE WHEN started_at >= ${cut} THEN ${col} ELSE 0 END)`;
    const rows = db.prepare(`
      SELECT provider_id AS provider,
             COUNT(*) AS requests,
             SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
             SUM(input_tokens) AS input, SUM(output_tokens) AS output,
             SUM(cache_read_input_tokens) AS cacheRead, SUM(cache_creation_input_tokens) AS cacheWrite,
             ${win(b.h5)} AS requestsH5,
             ${winTok(b.h5, 'input_tokens')} AS inputH5, ${winTok(b.h5, 'output_tokens')} AS outputH5,
             ${winTok(b.h5, 'cache_read_input_tokens')} AS cacheReadH5, ${winTok(b.h5, 'cache_creation_input_tokens')} AS cacheWriteH5,
             ${win(b.today)} AS requestsToday,
             ${winTok(b.today, 'input_tokens')} AS inputToday, ${winTok(b.today, 'output_tokens')} AS outputToday,
             ${winTok(b.today, 'cache_read_input_tokens')} AS cacheReadToday, ${winTok(b.today, 'cache_creation_input_tokens')} AS cacheWriteToday,
             ${win(b.d7)} AS requestsD7,
             ${winTok(b.d7, 'input_tokens')} AS inputD7, ${winTok(b.d7, 'output_tokens')} AS outputD7,
             ${winTok(b.d7, 'cache_read_input_tokens')} AS cacheReadD7, ${winTok(b.d7, 'cache_creation_input_tokens')} AS cacheWriteD7,
             ${win(b.d30)} AS requestsD30,
             ${winTok(b.d30, 'input_tokens')} AS inputD30, ${winTok(b.d30, 'output_tokens')} AS outputD30,
             ${winTok(b.d30, 'cache_read_input_tokens')} AS cacheReadD30, ${winTok(b.d30, 'cache_creation_input_tokens')} AS cacheWriteD30,
             MAX(started_at) AS lastAt
      FROM model_usage GROUP BY provider_id ORDER BY requests DESC
    `).all();
    return {
      available: true,
      providers: rows.map((r) => ({
        provider: r.provider, isCodingPlan: String(r.provider || '').startsWith('account:'),
        requests: num(r.requests), completed: num(r.completed),
        input: num(r.input), output: num(r.output), cacheRead: num(r.cacheRead), cacheWrite: num(r.cacheWrite),
        requestsH5: num(r.requestsH5), inputH5: num(r.inputH5), outputH5: num(r.outputH5), cacheReadH5: num(r.cacheReadH5), cacheWriteH5: num(r.cacheWriteH5),
        requestsToday: num(r.requestsToday), inputToday: num(r.inputToday), outputToday: num(r.outputToday), cacheReadToday: num(r.cacheReadToday), cacheWriteToday: num(r.cacheWriteToday),
        requestsD7: num(r.requestsD7), inputD7: num(r.inputD7), outputD7: num(r.outputD7), cacheReadD7: num(r.cacheReadD7), cacheWriteD7: num(r.cacheWriteD7),
        requestsD30: num(r.requestsD30), inputD30: num(r.inputD30), outputD30: num(r.outputD30), cacheReadD30: num(r.cacheReadD30), cacheWriteD30: num(r.cacheWriteD30),
        lastAt: Number.isFinite(Number(r.lastAt)) ? Number(r.lastAt) : null,
      })),
    };
  } catch (e) {
    return { ...empty, error: String(e?.message || e).slice(0, 120) };
  } finally { try { db.close(); } catch { /* ignore */ } }
}

/** DeepSeek（DSH）：本地余额账本——余额即配额，逐日/逐事件成本精确。 */
function deepseekIdentity(o) {
  const evidence = [], notes = [];
  const ledger = readJson(path.join(HOME, '.dsh/.dshw-usage.json'));
  if (!ledger) {
    return { status: fileExists(path.join(HOME, '.dsh')) ? 'not-signed-in' : 'not-installed', planName: null, account: null, evidence, notes, quota: null };
  }
  evidence.push({ file: '~/.dsh/.dshw-usage.json', field: 'lastBalance / accounting.books', value: '余额账本（CNY）' });
  const books = ledger.accounting?.books ?? {};
  const activeBookId = ledger.accounting?.active ?? Object.keys(books)[0] ?? null;
  const book = activeBookId ? books[activeBookId] : null;
  const dayMap = book?.days ?? {};
  const days = Object.values(dayMap).sort((a, b) => String(a.day).localeCompare(String(b.day)));
  const nowMs = o.now ?? Date.now();
  const d7Cut = nowMs - 7 * DAY_MS, d30Cut = nowMs - 30 * DAY_MS;
  const sumDebit = (cut) => days.reduce((s, d) => { const t = d.day ? Date.parse(d.day + 'T00:00:00') : NaN; return Number.isFinite(t) && t >= cut ? s + num(d.debitUnits) : s; }, 0) / 1e8;   // 1 单位 = 1e-8 元（2026-10-26 实测：debitUnits 1,676,000,000 ≙ 16.76 元、creditUnits 50,000,000,000 ≙ 充值 500 元）
  const quota = {
    kind: 'balance', currency: book?.currency ?? 'CNY',
    balance: num(ledger.lastBalance), balanceAsOf: ledger.date ?? null,
    todayCost: num(ledger.todayUsage), d7Cost: Number(sumDebit(d7Cut).toFixed(2)), d30Cost: Number(sumDebit(d30Cut).toFixed(2)), allCost: Number(sumDebit(-Infinity).toFixed(2)),
    daily: days.slice(-14).map((d) => ({ day: d.day, cost: Number((num(d.debitUnits) / 1e8).toFixed(2)) })),
    events: Array.isArray(ledger.events) ? ledger.events.slice(-5).map((e) => ({ ts: e.ts, day: e.day, model: e.model, cost: e.cost, tokens: e.tokens })) : [],
  };
  notes.push('按量计费（非订阅制）：余额即配额；账本为本地汇总、精确到事件（1 单位 = 1e-8 元）');
  return { status: 'api-billing', planName: '开放平台按量计费', account: activeBookId ? maskName(activeBookId.split('-')[0]) : null, evidence, notes, quota };
}

/** Anthropic Claude Code：oauthAccount 有无 + settings env 键名（API Key 形态判定，值不读）。 */
function claudeIdentity(o) {
  const evidence = [], notes = [];
  const cfg = readJson(path.join(HOME, '.claude.json'));
  const oa = cfg?.oauthAccount ?? null;
  const envKeys = (() => { const s = readJson(path.join(HOME, '.claude/settings.json')); return s?.env ? Object.keys(s.env) : []; })();
  const apiKeyEnv = envKeys.filter((k) => /^ANTHROPIC_(API_KEY|AUTH_TOKEN)$/i.test(k));
  if (oa) {
    evidence.push({ file: '~/.claude.json', field: 'oauthAccount', value: Object.keys(oa).join(', ') });
    if (oa.emailAddress) evidence.push({ file: '~/.claude.json', field: 'oauthAccount.emailAddress', value: maskEmail(oa.emailAddress) });
    if (oa.organizationName) evidence.push({ file: '~/.claude.json', field: 'oauthAccount.organizationName', value: String(oa.organizationName) });
    return { status: 'signed-in', planName: oa.planType ? String(oa.planType) : null, account: oa.emailAddress ? maskEmail(oa.emailAddress) : null, evidence, notes,
      detail: oa.hasExtraUsageEnabled ? { hasExtraUsageEnabled: true } : undefined };
  }
  if (apiKeyEnv.length) {
    evidence.push({ file: '~/.claude/settings.json', field: 'env 键名（值不读）', value: apiKeyEnv.join(', ') });
    notes.push('API Key 计费（settings env）——订阅档无从判定；token 用量走本地转录精确累计');
    return { status: 'api-billing', planName: 'API Key 计费', account: null, evidence, notes };
  }
  notes.push('本机无登录/订阅证据（无 oauthAccount、无钥匙串凭证）——若用 Pro/Max 需先在 Claude Code 登录');
  return { status: fileExists(path.join(HOME, '.claude')) ? 'not-signed-in' : 'not-installed', planName: null, account: null, evidence, notes };
}

/** OpenAI Codex：auth_mode（apikey → API 计费；chatgpt → JWT 白名单 claim 解档位）。 */
function codexIdentity(o) {
  const evidence = [], notes = [];
  const auth = readJson(path.join(HOME, '.codex/auth.json'));
  if (!auth) return { status: fileExists(path.join(HOME, '.codex')) ? 'not-signed-in' : 'not-installed', planName: null, account: null, evidence, notes };
  const mode = String(auth.auth_mode ?? '');
  evidence.push({ file: '~/.codex/auth.json', field: 'auth_mode', value: mode || '(空)' });
  if (mode === 'apikey') {
    notes.push('API Key 计费（auth_mode=apikey）——非 ChatGPT 订阅；token 用量走 rollout 精确累计');
    return { status: 'api-billing', planName: 'API Key 计费', account: null, evidence, notes };
  }
  if (auth.tokens?.id_token) {
    // JWT payload 白名单 claim：只取计划类型与账号形状，signature/token 本体不进输出
    const claims = (() => {
      try {
        const p = String(auth.tokens.id_token).split('.')[1];
        return JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
      } catch { return null; }
    })() ?? {};
    const authNs = claims['https://api.openai.com/auth'] ?? {};
    const plan = claims['chatgpt_plan_type'] ?? authNs['chatgpt_plan_type'] ?? null;
    const email = claims.email ?? authNs['user_email'] ?? null;
    if (plan) evidence.push({ file: '~/.codex/auth.json', field: 'id_token.chatgpt_plan_type', value: String(plan) });
    if (email) evidence.push({ file: '~/.codex/auth.json', field: 'id_token.email', value: maskEmail(email) });
    return { status: 'active', planName: plan ? 'ChatGPT ' + String(plan) : 'ChatGPT 登录', account: email ? maskEmail(email) : null, evidence, notes };
  }
  notes.push('auth_mode=' + (mode || '?') + ' 但无 tokens——订阅档未知');
  return { status: 'not-signed-in', planName: null, account: null, evidence, notes };
}

/** Kimi For Coding：OAuth 登录态（scope/过期时间），订阅档本地不落盘。 */
function kimiIdentity(o) {
  const evidence = [], notes = [];
  const cred = readJson(path.join(HOME, '.kimi-code/credentials/kimi-code.json'));
  if (!cred) return { status: fileExists(path.join(HOME, '.kimi-code')) ? 'not-signed-in' : 'not-installed', planName: null, account: null, evidence, notes };
  evidence.push({ file: '~/.kimi-code/credentials/kimi-code.json', field: 'scope / token_type', value: (cred.scope ?? '?') + ' · ' + (cred.token_type ?? '?') + '（token 值不读）' });
  const region = (() => { try { return fs.readFileSync(path.join(HOME, '.kimi-code/region'), 'utf8').trim(); } catch { return null; } })();
  if (region) evidence.push({ file: '~/.kimi-code/region', field: 'region', value: region });
  if (cred.expires_at) {
    const exp = Number(cred.expires_at) * 1000;
    notes.push('登录态' + (exp < (o.now ?? Date.now()) ? '已过期（refresh_token 自动续期）' : '有效至 ' + new Date(exp).toLocaleString('zh-CN')));
  }
  notes.push('Kimi For Coding 订阅档本地不落盘（云端）');
  return { status: 'signed-in', planName: null, account: null, evidence, notes };
}

/** Qoder：登录状态 + partner_plan_snapshots（合作伙伴资格），主订阅档未缓存。 */
function qoderIdentity(o) {
  const evidence = [], notes = [];
  const st = readJson(path.join(HOME, '.qoder-cn/.qoder-app-status.json'));
  const mainDb = path.join(HOME, 'Library/Application Support/com.qodercn.app.stable/main.sqlite');
  if (!st && !fileExists(mainDb)) return { status: 'not-installed', planName: null, account: null, evidence, notes };
  if (st) {
    evidence.push({ file: '~/.qoder-cn/.qoder-app-status.json', field: 'logged_in / version', value: (st.logged_in ? '已登录' : '未登录') + ' · v' + (st.version ?? '?') });
    if (st.name) evidence.push({ file: '~/.qoder-cn/.qoder-app-status.json', field: 'name', value: maskName(st.name) });
  }
  const db = openSqliteReadOnly(mainDb);
  if (db) {
    try {
      const rows = db.prepare('SELECT partner_code, eligible, subscription_status FROM partner_plan_snapshots').all();
      for (const r of rows) evidence.push({ file: 'main.sqlite', field: 'partner_plan_snapshots', value: String(r.partner_code ?? '?') + ' eligible=' + (r.eligible ? 1 : 0) + (r.subscription_status ? ' · ' + r.subscription_status : '') });
    } catch { /* 表不存在 */ } finally { try { db.close(); } catch { /* ignore */ } }
  }
  const data = readJson(path.join(HOME, 'Library/Application Support/com.qodercn.app.stable/qoder-data.v1.json'));
  if (data && Array.isArray(data.subscriptions)) evidence.push({ file: 'qoder-data.v1.json', field: 'subscriptions', value: data.subscriptions.length ? data.subscriptions.map((s) => s?.plan ?? s?.id ?? '?').join(', ') : '[]（主订阅档未缓存）' });
  notes.push('订阅档位与配额在厂商云端，本地无缓存（token 亦不落盘，见用量页口径）');
  return { status: st?.logged_in ? 'signed-in' : 'not-signed-in', planName: null, account: st?.name ? maskName(st.name) : null, evidence, notes };
}

/** Cursor：stripeMembershipType（本地明确档位）。 */
const CURSOR_PLAN_LABEL = { free: 'Free', pro: 'Pro', 'pro_plus': 'Pro+', ultra: 'Ultra', teams: 'Teams', enterprise: 'Enterprise' };
function cursorIdentity(o) {
  const evidence = [], notes = [];
  const dbPath = path.join(HOME, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  if (!fileExists(dbPath)) return { status: fileExists(path.join(HOME, '.cursor')) ? 'not-signed-in' : 'not-installed', planName: null, account: null, evidence, notes };
  const db = openSqliteReadOnly(dbPath);
  let plan = null, email = null;
  if (db) {
    try {
      const get = (k) => db.prepare('SELECT value FROM ItemTable WHERE key=?').get(k)?.value;
      plan = get('cursorAuth/stripeMembershipType');
      email = get('cursorAuth/cachedEmail');
      const signUp = get('cursorAuth/cachedSignUpType');
      if (plan) evidence.push({ file: 'state.vscdb', field: 'cursorAuth/stripeMembershipType', value: String(plan) });
      if (email) evidence.push({ file: 'state.vscdb', field: 'cursorAuth/cachedEmail', value: maskEmail(email) });
      if (signUp) evidence.push({ file: 'state.vscdb', field: 'cursorAuth/cachedSignUpType', value: String(signUp) });
    } catch { /* ignore */ } finally { try { db.close(); } catch { /* ignore */ } }
  }
  if (plan) notes.push('档位为本地缓存（stripeMembershipType）；用量/配额在云端——token 不落盘（用量页请求级口径）');
  return { status: plan ? 'active' : 'signed-in', planName: plan ? (CURSOR_PLAN_LABEL[String(plan).toLowerCase()] ?? String(plan)) : null, account: email ? maskEmail(email) : null, evidence, notes };
}

/** GitHub Copilot：VS Code SKU 字段 + ~/.copilot 账户行。 */
const COPILOT_SKU_LABEL = {
  free_limited_copilot: 'Free（有限额度）', copilot_free: 'Free', copilot_pro: 'Pro', copilot_pro_plus: 'Pro+',
  copilot_business: 'Business', copilot_enterprise: 'Enterprise', individual: 'Individual', business: 'Business', enterprise: 'Enterprise',
};
function copilotIdentity(o) {
  const evidence = [], notes = [];
  const installed = ['/Applications/GitHub Copilot.app', path.join(HOME, '.copilot'),
    path.join(HOME, 'Library/Caches/github-copilot-sdk'), localData('GitHub Copilot')].some(fileExists);
  const dbPath = appSupport('Code', 'User', 'globalStorage', 'state.vscdb');
  let sku = null;
  const db = openSqliteReadOnly(dbPath);
  if (db) {
    try {
      sku = db.prepare('SELECT value FROM ItemTable WHERE key=?').get('extensionsAssignmentFilterProvider.copilotSku')?.value ?? null;
      if (sku) evidence.push({ file: 'VS Code state.vscdb', field: 'extensionsAssignmentFilterProvider.copilotSku', value: String(sku) });
    } catch { /* ignore */ } finally { try { db.close(); } catch { /* ignore */ } }
  }
  const cdb = openSqliteReadOnly(path.join(HOME, '.copilot/data.db'));
  if (cdb) {
    try {
      const acc = cdb.prepare('SELECT login, host, created_at FROM accounts LIMIT 3').all();
      for (const a of acc) evidence.push({ file: '~/.copilot/data.db', field: 'accounts', value: maskName(a.login) + '@' + (a.host ?? 'github.com') + (a.created_at ? ' · ' + a.created_at : '') });
    } catch { /* 表不存在 */ } finally { try { cdb.close(); } catch { /* ignore */ } }
  }
  if (!installed && !sku) return { status: 'not-installed', planName: null, account: null, evidence, notes };
  notes.push('Copilot 不在会话观察八源内——本面板只报身份；额度由客户端在线拉取（get_account_quota），本地无数值缓存');
  return { status: sku ? 'active' : 'signed-in', planName: sku ? (COPILOT_SKU_LABEL[String(sku)] ?? String(sku)) : null, account: null, evidence, notes };
}

/** OpenCode：auth.json provider 名（间接证据——GLM Coding Plan 也能以 provider 形式接入 OpenCode）。 */
function opencodeProviders(o) {
  const auth = readJson(path.join(HOME, '.local/share/opencode/auth.json'));
  return auth ? Object.keys(auth) : [];
}

/** OpenCode Zen（provider=opencode，按量网关）/ OpenCode Go（provider=opencode-go，订阅）：
 *  登录态看 auth.json provider 键名（值不读）；无登录态但 opencode 本机在用时，回看
 *  opencode.db 小表（session_v2.model / session_message.model.providerID）是否有经该网关的
 *  历史会话——有则如实标注「历史在用、当前未登录」，绝不把历史用量冒充当前订阅。 */
function opencodeGatewayIdentity(providerId, o) {
  const evidence = [], notes = [];
  const auth = readJson(path.join(HOME, '.local/share/opencode/auth.json'));
  const providers = auth ? Object.keys(auth) : [];
  const opencodeInstalled = fileExists(path.join(HOME, '.opencode/bin/opencode')) || fileExists(path.join(HOME, '.local/share/opencode'));
  if (providers.includes(providerId)) {
    evidence.push({ file: '~/.local/share/opencode/auth.json', field: 'provider 键名（值不读）', value: providerId + ' · ' + (auth[providerId]?.type ?? '已登录') });
    notes.push(providerId === 'opencode-go'
      ? 'Go/Go Plus 订阅档与限额（官方口径：5h=月限 20%、周=50%、月=100%）在云端 Console，本地不落盘——不持凭证调云 API'
      : 'Zen 为按量计费（Console 余额），本地无余额缓存');
    return { status: providerId === 'opencode-go' ? 'active' : 'api-billing', planName: providerId === 'opencode-go' ? 'OpenCode Go（登录态）' : 'OpenCode Zen（按量）', account: null, evidence, notes };
  }
  let histSessions = null, histMsgs = null;
  if (opencodeInstalled) {
    const db = openSqliteReadOnly(path.join(HOME, '.local/share/opencode/opencode.db'));
    if (db) {
      try {
        histSessions = db.prepare("SELECT COUNT(*) AS c FROM session_v2 WHERE json_extract(model,'$.providerID') = ?").get(providerId)?.c ?? 0;
        histMsgs = db.prepare("SELECT COUNT(*) AS c FROM session_message WHERE type='assistant' AND json_extract(data,'$.model.providerID') = ?").get(providerId)?.c ?? 0;
      } catch { histSessions = histMsgs = null; } finally { try { db.close(); } catch { /* ignore */ } }
    }
  }
  if (histSessions || histMsgs) {
    evidence.push({ file: '~/.local/share/opencode/opencode.db', field: 'session_v2.model.providerID / session_message.model.providerID', value: '历史会话 ' + histSessions + ' 个 · assistant 行 ' + histMsgs + ' 条经该网关' });
    notes.push('历史经该网关跑过（本地用量见下方窗口），但当前 auth.json 无登录态——状态如实标「未登录」，不冒充在订');
  } else {
    notes.push('本机未发现经该网关的登录态或历史会话（OpenCode 本体在用，' + (providerId === 'opencode-go' ? '如已订阅 Go：TUI 里 /connect 选 OpenCode Go 粘贴 Console API key' : '如需使用：/connect 选 OpenCode Zen') + '）');
  }
  return { status: opencodeInstalled ? 'not-signed-in' : 'not-installed', planName: null, account: null, evidence, notes };
}

// ---------------------------------------------------------------------------
// 在线档位/配额层（用户 2026-10-27 授权「通过 api-key 查找 coding plan 的来源」）
//
// 边界调整说明：此前「不持凭证调云 API」是产品默认红线；用户明确授权后，本层使用各厂商
// 客户端自己的本地凭证发起**只读**档位/配额查询（与厂商 CLI 自带的 /usage、/plan 命令同源端点）。
// 纪律不变：凭证只在内存过境——不写日志、不落缓存文件；缓存只存档位与配额数值（含抓取时间）；
// PET_PLAN_ONLINE=0 整体关闭（回退本地证据 + 用户标注兜底）。
//
// 三家实测端点（2026-10-27 [A]）：
//   Kimi： GET api.kimi.com/coding/v1/me（user_level_name）+ /coding/v1/usages（5h + 月度比率 + 加油包）
//   GLM ： 解密 zcode credentials（确定性回退密钥，docs/40 §3.12）→ bigmodel.cn
//          /api/monitor/usage/quota/limit（unit3=5h / unit6=周，credits）+ /api/biz/subscription/list（订阅名/有效期）
//   Qoder：dt- 令牌仅在 CLI 进程内存——经一次性本地 MITM 收获（spawn qoderclicn --list-models，
//          HTTPS_PROXY 指向本地代理、仅解密 gateway/openapi.qoder.com.cn 两域；令牌即用即弃）→
//          gateway.qoder.com.cn /api/v2/user/plan（plan_tier_name）+ /api/v2/quota/usage（加油包 credits）
// ---------------------------------------------------------------------------
const ONLINE_TTL_MS = 30 * 60_000;
const ONLINE_CACHE_FILE = path.join(HOME, '.agent-pet', 'plan-online-cache.json');
const onlineEnabled = () => process.env.PET_PLAN_ONLINE !== '0';

const jget = async (url, headers, fetchImpl, timeoutMs = 8000) => {
  const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  if (!r.ok) throw new Error('http ' + r.status + ': ' + text.slice(0, 80));
  return JSON.parse(text);
};
const num2 = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** Kimi：OAuth 刷新（与 CLI refreshAccessToken 同源：POST auth.kimi.com/api/oauth/token，form 表单）。
 * 刷新成功回写厂商自己的凭证文件（CLI 下次运行同样会刷新——与官方客户端行为一致）。 */
async function kimiRefreshToken(credPath, cred, fetchImpl) {
  const OAUTH_HOST = process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || 'https://auth.kimi.com';
  const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
  const body = new URLSearchParams({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: String(cred.refresh_token || '') });
  const r = await fetchImpl(OAUTH_HOST.replace(/\/$/, '') + '/api/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: AbortSignal.timeout(15_000),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || typeof data?.access_token !== 'string') throw new Error('refresh http ' + r.status);
  const next = { ...cred, access_token: data.access_token };
  if (typeof data.refresh_token === 'string' && data.refresh_token) next.refresh_token = data.refresh_token;
  if (Number.isFinite(Number(data.expires_in))) next.expires_at = Math.floor(Date.now() / 1000) + Number(data.expires_in);
  else if (Number.isFinite(Number(data.expires_at))) next.expires_at = Number(data.expires_at);
  try {
    const st = fs.statSync(credPath);
    fs.writeFileSync(credPath, JSON.stringify(next, null, 2), { mode: st.mode & 0o777 });
  } catch { /* 回写失败不影响本轮使用（内存中的新 token 照常查询） */ }
  return next;
}

/** Kimi：OAuth 凭证（明文 JSON）→ /me 档位 + /usages 配额；access_token 过期时先刷新（同 CLI 行为）再查询。 */
async function fetchKimiOnline(fetchImpl) {
  const credPath = path.join(HOME, '.kimi-code/credentials/kimi-code.json');
  let cred = readJson(credPath);
  if (!cred?.access_token) return { error: 'no-credential' };
  if (cred.expires_at && Number(cred.expires_at) * 1000 < Date.now() + 10_000) {
    if (!cred.refresh_token) return { error: 'token-expired' };
    try { cred = await kimiRefreshToken(credPath, cred, fetchImpl); } catch (e) { return { error: 'refresh-failed: ' + String(e?.message || e).slice(0, 60) }; }
  }
  const H = { Authorization: 'Bearer ' + cred.access_token, Accept: 'application/json', 'User-Agent': 'kimi-code-cli' };
  // auth/api 偶发慢（App 内实测 >8s 超时一次）：12s 超时 + 一次重试
  const jgetR = async (u, h) => { try { return await jget(u, h, fetchImpl, 12_000); } catch (e) { await new Promise((r) => setTimeout(r, 1200)); return await jget(u, h, fetchImpl, 12_000); } };
  const me = await jgetR('https://api.kimi.com/coding/v1/me', H);
  const usages = await jgetR('https://api.kimi.com/coding/v1/usages', H);
  const h5Limit = (usages.limits || []).find((x) => x?.window?.duration === 300)?.detail ?? null;
  const u = usages.usages || {};
  return {
    tier: me.user_level_name ? String(me.user_level_name) : null,
    account: me.nickname ? maskName(me.nickname) : null,
    quotas: {
      h5: h5Limit ? { used: num2(h5Limit.used), limit: num2(h5Limit.limit), remaining: num2(h5Limit.remaining), resetTime: h5Limit.resetTime ?? null } : null,
      monthTotal: u.limit_5h && u.limit_month_total ? { usedRatio: num2(u.limit_month_total.used_ratio), resetTime: u.limit_month_total.reset_time ?? null } : (u.limit_month_total ? { usedRatio: num2(u.limit_month_total.used_ratio), resetTime: u.limit_month_total.reset_time ?? null } : null),
      monthCode: u.limit_month_code ? { usedRatio: num2(u.limit_month_code.used_ratio), resetTime: u.limit_month_code.reset_time ?? null } : null,
    },
  };
}

/** GLM：zcode credentials 确定性回退密钥解密（docs/40 §3.12：sha256("zcode-credential-fallback:<platform>:<homedir>:<username>")，enc:v1 AES-256-GCM）。 */
function decryptZcodeValue(enc) {
  try {
    const key = crypto.createHash('sha256').update('zcode-credential-fallback:' + process.platform + ':' + HOME + ':' + os.userInfo().username).digest();
    const [iv, tag, ct] = String(enc).replace(/^enc:v1:/, '').split('.').map((x) => Buffer.from(x, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return null; }
}
/** GLM：bigmodel.cn 配额（authorization 裸 token，无 Bearer）+ 订阅清单。 */
async function fetchGlmOnline(fetchImpl, decrypt = decryptZcodeValue) {
  const creds = readJson(path.join(HOME, '.zcode/v2/credentials.json'));
  const enc = creds?.['oauth:bigmodel:access_token'];
  if (!enc) return { error: 'no-credential' };
  const token = decrypt(enc);
  if (!token) return { error: 'decrypt-failed' };
  const H = { authorization: token, Accept: 'application/json' };
  const limitBody = await jget('https://bigmodel.cn/api/monitor/usage/quota/limit', H, fetchImpl);
  let sub = null;
  try { const list = await jget('https://bigmodel.cn/api/biz/subscription/list', H, fetchImpl); sub = (list?.data || []).find((x) => x?.status === 'VALID') ?? (list?.data || [])[0] ?? null; } catch { /* 订阅清单失败不拖累配额 */ }
  const limits = (limitBody?.data?.limits || []);
  const win = (unit) => limits.find((x) => Number(x?.unit) === unit) ?? null;
  const mk = (x) => x ? { used: num2(x.currentValue), limit: num2(x.usage), remaining: num2(x.remaining), percent: num2(x.percentage), resetTime: x.nextResetTime ?? null } : null;
  return {
    tier: sub?.productName ? String(sub.productName) : null,   // 实测 "GLM Coding Max"
    level: limitBody?.data?.level ? String(limitBody.data.level) : null,
    validUntil: sub?.valid ?? null,
    quotas: { h5: mk(win(3)), weekly: mk(win(6)) },
  };
}

/** Qoder：一次性本地 MITM 收获 dt- 令牌（仅 gateway/openapi.qoder.com.cn 两域解密；令牌即用即弃）。
 * 流程：openssl 生成自签证书（复用）→ 起 CONNECT 代理 → 以 HTTPS_PROXY + NODE_TLS_REJECT_UNAUTHORIZED=0
 * 环境跑一次 `qoderclicn --list-models`（Bun 支持）→ 从首个带 Authorization 的 TLS 明文捕获令牌。
 * 令牌只在内存中存在（本函数返回后即被调用方即用即弃；不写任何文件/日志）。 */
async function harvestQoderToken({ certDir, cliBin, spawnFn = spawn, timeoutMs = 30_000 }) {
  if (!cliBin || !fileExists(cliBin)) return { error: 'cli-not-found' };
  fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });
  const keyP = path.join(certDir, 'k.pem'), crtP = path.join(certDir, 'c.pem');
  if (!fileExists(keyP) || !fileExists(crtP)) {
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyP, '-out', crtP, '-days', '30', '-nodes',
        '-subj', '/CN=qoder-harvest', '-addext', 'subjectAltName=DNS:gateway.qoder.com.cn,DNS:openapi.qoder.com.cn'],
        { timeout: 15_000, stdio: 'ignore' });
    } catch (e) { return { error: 'cert-gen-failed' }; }
  }
  const net = await import('node:net');
  const tls = await import('node:tls');
  const srvKey = fs.readFileSync(keyP), srvCrt = fs.readFileSync(crtP);
  let tokenPromiseResolve;
  const tokenP = new Promise((res) => { tokenPromiseResolve = res; });
  const server = (await import('node:http')).createServer((req, res) => { res.writeHead(404); res.end(); });
  const conns = new Set();
  server.on('connect', (req, clientSock, head) => {
    const host = String(req.url || '').split(':')[0];
    clientSock.on('error', () => {});
    const passthrough = () => {
      const ups = net.connect(443, host, () => { clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); ups.write(head); ups.pipe(clientSock); clientSock.pipe(ups); });
      ups.on('error', () => clientSock.destroy());
      conns.add(ups); ups.on('close', () => conns.delete(ups));
    };
    if (!/^(gateway|openapi)\.qoder\.com\.cn$/.test(host)) return passthrough();
    // 两域解密：自签证书接住 CLI 的 TLS，首个带 Authorization 的请求头即收获令牌，其余字节原样转发
    const tlsSrv = new tls.Server({ key: srvKey, cert: srvCrt }, (clear) => {
      let buf = '';
      const ups = net.connect(443, host, () => { clear.write('HTTP/1.1 200 Connection Established\r\n\r\n'); clear.pipe(ups); ups.pipe(clear); });
      ups.on('error', () => clear.destroy());
      clear.on('error', () => {});
      conns.add(ups); ups.on('close', () => conns.delete(ups));
      let captured = false;
      clear.on('data', (c) => {
        if (captured) { ups.write(c); return; }
        buf += c.toString('latin1');
        const m = buf.match(/authorization:\s*([^\r\n]+)/i);
        if (m) {
          const t = m[1].trim();
          // 令牌后的字节原样补发给上游（保持 CLI 请求完整）
          const rest = buf.slice(buf.indexOf(m[1]) + m[1].length).replace(/^\r\n\r\n/, '');
          captured = true; tokenPromiseResolve(t);
          if (rest) ups.write(Buffer.from(rest, 'latin1'));
          clear.removeAllListeners('data');
          clear.on('data', (c2) => ups.write(c2));
        } else ups.write(c);
      });
    });
    tlsSrv.listen(0, '127.0.0.1', () => {
      const p = tlsSrv.address().port;
      const local = net.connect(p, '127.0.0.1', () => { clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); local.write(head); local.pipe(clientSock); clientSock.pipe(local); });
      local.on('error', () => clientSock.destroy());
      conns.add(local); local.on('close', () => conns.delete(local));
    });
    tlsSrv.on('error', () => clientSock.destroy());
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const child = spawnFn(cliBin, ['--list-models'], {
    env: { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:' + port, NODE_TLS_REJECT_UNAUTHORIZED: '0', NO_COLOR: '1' },
    stdio: 'ignore',
  });
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
  const done = new Promise((res) => child.on('exit', () => res()));
  const token = await Promise.race([tokenP, done.then(() => null)]);
  clearTimeout(timer);
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  for (const c of conns) { try { c.destroy(); } catch { /* ignore */ } }
  try { server.close(); } catch { /* ignore */ }
  if (!token) return { error: 'harvest-timeout' };
  return { token };
}

/** Qoder：收获令牌 → /api/v2/user/plan + /api/v2/quota/usage（令牌即用即弃）。 */
async function fetchQoderOnline(fetchImpl, opts = {}) {
  const cliBin = opts.qoderCliBin ?? qoderCliBinDefault();
  const harvest = await harvestQoderToken({ certDir: path.join(HOME, '.agent-pet', 'plan-harvest'), cliBin, spawnFn: opts.spawnFn ?? spawn, timeoutMs: opts.timeoutMs ?? 30_000 });
  if (harvest.error || !harvest.token) return { error: harvest.error ?? 'harvest-failed' };
  const H = { Authorization: harvest.token, Accept: 'application/json' };
  const plan = await jget('https://gateway.qoder.com.cn/api/v2/user/plan', H, fetchImpl);
  let quota = null;
  try { quota = await jget('https://gateway.qoder.com.cn/api/v2/quota/usage', H, fetchImpl); } catch { /* 配额失败不拖累档位 */ }
  const addOn = quota?.addOnQuota ?? null;
  return {
    tier: plan?.plan_tier_name ? String(plan.plan_tier_name) : null,
    paid: typeof plan?.is_paid_plan === 'boolean' ? plan.is_paid_plan : null,
    userType: plan?.user_type ? String(plan.user_type) : null,
    quotas: addOn ? { credits: { used: num2(addOn.used), limit: num2(addOn.total), remaining: num2(addOn.remaining), percent: num2(addOn.percentage) } } : {},
  };
}

function qoderCliBinDefault() {
  const dir = path.join(HOME, '.qoder-cn', 'bin', 'qoderclicn');
  try {
    const cands = fs.readdirSync(dir).filter((f) => f.startsWith('qoderclicn-')).sort();
    return cands.length ? path.join(dir, cands[cands.length - 1]) : null;
  } catch { return null; }
}

/** 在线层编排：缓存（0600，零 token）+ TTL；force=true 强制重拉。单家失败不影响其余。 */
async function refreshOnlineLayer(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const now = Date.now();
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(ONLINE_CACHE_FILE, 'utf8')); } catch { /* 无缓存 */ }
  const fresh = {};
  const runners = [
    ['kimi-for-coding', () => fetchKimiOnline(fetchImpl)],
    ['glm-coding-plan', () => fetchGlmOnline(fetchImpl, opts.decryptZcode)],
    ['qoder', () => fetchQoderOnline(fetchImpl, opts)],
  ];
  for (const [key, run] of runners) {
    const prev = cache[key];
    if (!opts.force && prev?.fetchedAt && now - prev.fetchedAt < ONLINE_TTL_MS) { fresh[key] = prev; continue; }
    const keepPrev = () => (prev && !prev.error && prev.fetchedAt && now - prev.fetchedAt < 6 * 3_600_000
      ? { ...prev, stale: true }   // 6h 内沿用旧成功值（厂商端点偶发超时不至于把档位打回未知）
      : null);
    try {
      const r = await run();
      fresh[key] = r?.error ? (keepPrev() ?? { ...r, fetchedAt: prev?.fetchedAt ?? null, failedAt: now }) : { ...r, fetchedAt: now };
    } catch (e) {
      fresh[key] = keepPrev() ?? { error: String(e?.message || e).slice(0, 80), fetchedAt: prev?.fetchedAt ?? null, failedAt: now };
    }
  }
  try {
    fs.mkdirSync(path.dirname(ONLINE_CACHE_FILE), { recursive: true });
    const tmp = ONLINE_CACHE_FILE + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(fresh), { mode: 0o600 });
    fs.renameSync(tmp, ONLINE_CACHE_FILE);
  } catch (e) { console.error('[plan-usage] 在线缓存写入失败（不影响结果）：' + (e?.message || e)); }
  return fresh;
}
let onlineLayerPromise = null;

// ---------------------------------------------------------------------------
// 主流厂商注册表（含本机未安装者——「全部主流厂商」盘点口径）
// ---------------------------------------------------------------------------

export const PLAN_REGISTRY = Object.freeze([
  { id: 'glm-coding-plan', vendor: '智谱 Z.ai', product: 'GLM Coding Plan', agents: ['zcode', 'opencode'], category: 'subscription', probe: glmIdentity , sem: '5h 滚动窗口（公开产品口径；本机有逐请求账本可精确归属）' },
  { id: 'deepseek', vendor: 'DeepSeek', product: 'DeepSeek 开放平台', agents: ['dsh'], category: 'api-balance', probe: deepseekIdentity , sem: '无窗口概念（余额制，余额即剩余额度）' },
  { id: 'claude', vendor: 'Anthropic', product: 'Claude 订阅 / API', agents: ['claude-code'], category: 'subscription', probe: claudeIdentity , sem: '5h 会话窗 + 周限额（公开产品口径）' },
  { id: 'chatgpt-codex', vendor: 'OpenAI', product: 'ChatGPT（Codex）/ API', agents: ['codex'], category: 'subscription', probe: codexIdentity , sem: '5h + 周限额（公开产品口径）' },
  { id: 'kimi-for-coding', vendor: '月之暗面 Moonshot', product: 'Kimi For Coding', agents: ['kimi-code'], category: 'subscription', probe: kimiIdentity , sem: '窗口语义未核实（本地无缓存）' },
  { id: 'qoder', vendor: '阿里巴巴 Qoder', product: 'Qoder 会员', agents: ['qoder'], category: 'subscription', probe: qoderIdentity , sem: '窗口语义未核实（本地无缓存）' },
  { id: 'cursor', vendor: 'Cursor', product: 'Cursor 订阅', agents: ['cursor'], category: 'subscription', probe: cursorIdentity , sem: '窗口语义未核实（本地无缓存）' },
  { id: 'copilot', vendor: 'GitHub', product: 'GitHub Copilot', agents: [], category: 'subscription', probe: copilotIdentity , sem: '每月额度（公开产品口径）' },
  { id: 'opencode-zen', vendor: 'OpenCode', product: 'OpenCode Zen（按量网关）', agents: ['opencode'], modelFilter: /^opencode\//i, category: 'api-billing', probe: (o) => opencodeGatewayIdentity('opencode', o), sem: '按量计费（Console 余额，无窗口概念）；用量=OpenCode 会话里 providerID=opencode 的请求（provider 精确，非模型名近似）' },
  { id: 'opencode-go', vendor: 'OpenCode', product: 'OpenCode Go（订阅）', agents: ['opencode'], modelFilter: /^opencode-go\//i, category: 'subscription', probe: (o) => opencodeGatewayIdentity('opencode-go', o), sem: '官方限额口径：5h=月限 20%、周=50%、月=100%（云端，本地无账本）；用量=providerID=opencode-go 的请求（provider 精确）' },
  { id: 'gemini', vendor: 'Google', product: 'Gemini Code Assist / Antigravity', agents: [], category: 'subscription',
    installPaths: ['.gemini', '.config/gemini', 'Library/Application Support/Antigravity', '/Applications/Antigravity.app'] },
  { id: 'qwen-code', vendor: '阿里通义', product: 'Qwen Code / 百炼 Coding', agents: [], category: 'subscription', installPaths: ['.qwen'] },
  { id: 'iflow', vendor: '心流 iFlow', product: 'iFlow CLI 免费额度', agents: [], category: 'subscription', installPaths: ['.iflow'] },
  { id: 'minimax', vendor: 'MiniMax', product: 'MiniMax Coding Plan', agents: [], category: 'subscription', installPaths: ['.mini-max', '.minimax'] },
  { id: 'trae', vendor: '字节跳动 Trae', product: 'Trae / 豆包 MarsCode', agents: [], category: 'subscription', installPaths: ['.trae', '.trae-cn', 'Library/Application Support/Trae', 'Library/Application Support/Trae CN'] },
  { id: 'windsurf', vendor: 'Windsurf', product: 'Windsurf 订阅', agents: [], category: 'subscription', installPaths: ['.codeium', 'Library/Application Support/Windsurf'] },
  { id: 'codebuddy', vendor: '腾讯 CodeBuddy', product: 'CodeBuddy', agents: [], category: 'subscription', installPaths: ['.codebuddy', 'Library/Application Support/CodeBuddy'] },
]);

// ---------------------------------------------------------------------------
// 用量映射：把 usage-collect 的 overview（all + ranges）折到各 plan
// ---------------------------------------------------------------------------

const USAGE_KIND_LABEL = { exact: '精确 token', requests: '请求级（token 在云端）', estimate: '含包络估算', none: '无观察源' };

/** 一个 plan 的用量窗口：聚合其 agents 的 bySource totals；modelFilter 用于按模型名归属（近似，标记）。 */
function planUsageWindows(overview, agents, modelFilter) {
  const windows = { all: overview, today: overview?.ranges?.today, d7: overview?.ranges?.d7, d30: overview?.ranges?.d30 };
  const out = {};
  let kind = agents.length ? 'exact' : 'none';
  for (const [w, ov] of Object.entries(windows)) {
    const acc = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let approximate = false, unavailable = false, has = false;
    for (const src of agents) {
      const d = ov?.bySource?.[src];
      if (!d) continue;
      has = true;
      if (d.estimated) { approximate = true; kind = 'estimate'; }
      const t = d.totals ?? {};
      const models = modelFilter ? (d.models ?? []).filter((m) => modelFilter.test(m.model)) : null;
      if (models) {
        for (const m of models) { acc.requests += num(m.requests); acc.input += num(m.input); acc.output += num(m.output); acc.cacheRead += num(m.cacheRead); acc.cacheWrite += num(m.cacheWrite); }
      } else {
        acc.requests += num(t.requests); acc.input += num(t.input); acc.output += num(t.output); acc.cacheRead += num(t.cacheRead); acc.cacheWrite += num(t.cacheWrite);
      }
    }
    // 估算关闭（PET_USAGE_ESTIMATE=0）时 Qoder/Cursor tokens=0 且请求为真实值 → 请求级口径
    if (has && !approximate && !acc.input && !acc.output && acc.requests > 0) unavailable = true;
    acc.tokens = acc.input + acc.output + acc.cacheRead + acc.cacheWrite;
    out[w] = { available: has, requests: acc.requests, tokens: acc.tokens, input: acc.input, output: acc.output, cacheRead: acc.cacheRead, cacheWrite: acc.cacheWrite, approximate, unavailable };
  }
  if (agents.length && kind === 'exact' && out.all?.unavailable) kind = 'requests';
  out.h5 = { available: false, requests: 0, tokens: 0, input: 0, output: 0, approximate: false, unavailable: false, reason: '本地无逐请求时间戳账本（自然日语桶），5h 滚动窗不可精确归属' };
  return { kind, kindLabel: USAGE_KIND_LABEL[kind] ?? kind, windows: out };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * @param {{usage?:object, now?:number, refresh?:boolean, dbPath?:string}} opts
 *   usage：scanAllUsage() 的返回（含 overview；不传则用量窗口 available:false，--fast 路径）
 */
export async function scanPlanUsage(opts = {}) {
  const t0 = process.hrtime.bigint();
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const o = { now, ...opts };
  // 身份+配额层：60s 缓存（sqlite/文件读取都便宜，但 5s 快照节奏下没必要每轮都碰）
  if (!identityCache.data || opts.refresh || now - identityCache.at > IDENTITY_TTL_MS) {
    const identities = {};
    const ocProviders = opencodeProviders(o);
    for (const p of PLAN_REGISTRY) {
      if (p.probe) { identities[p.id] = p.probe(o); continue; }
      identities[p.id] = (p.installPaths ?? []).some(installHit)
        ? { status: 'signed-in', planName: null, account: null, evidence: [{ field: 'installPaths', value: '本机发现安装痕迹' }], notes: ['身份提取器尚未实现——只做安装检测'] }
        : { status: 'not-installed', planName: null, account: null, evidence: [], notes: ['本机未发现安装痕迹'] };
    }
    if (ocProviders.includes('zhipuai-coding-plan') && identities['glm-coding-plan'] && identities['glm-coding-plan'].status !== 'not-installed') {
      identities['glm-coding-plan'].evidence.push({ file: '~/.local/share/opencode/auth.json', field: 'provider 键名（值不读）', value: 'zhipuai-coding-plan' });
      identities['glm-coding-plan'].notes.push('GLM Coding Plan 亦通过 OpenCode provider 接入（zhipuai-coding-plan）');
    }
    identityCache = { at: now, data: identities };
  }
  const identities = identityCache.data;

  const overrides = readPlanOverrides();   // 每轮现读（用户可能随时编辑；文件极小）
  let online = null;
  if (onlineEnabled()) {
    let cachedFresh = false;
    try {
      online = JSON.parse(fs.readFileSync(ONLINE_CACHE_FILE, 'utf8'));
      cachedFresh = Object.values(online).some((x) => x?.fetchedAt && Date.now() - x.fetchedAt < ONLINE_TTL_MS);
      for (const k of Object.keys(online)) if (Date.now() - (online[k]?.fetchedAt ?? 0) > 24 * 3_600_000) delete online[k];   // >24h 视为陈旧不采用
    } catch { online = null; }
    // 在线层节奏：缓存陈旧/为空 → 后台拉取（不阻塞本轮）；force（手动刷新）→ 强制并等待结果
    if ((opts.forceOnline || !cachedFresh) && !onlineLayerPromise) {
      onlineLayerPromise = refreshOnlineLayer({ force: !!opts.forceOnline }).catch(() => { }).finally(() => { onlineLayerPromise = null; });
    }
    if (opts.awaitOnline && onlineLayerPromise) { try { await onlineLayerPromise; } catch { /* ignore */ } }
    if (opts.awaitOnline) { try { online = JSON.parse(fs.readFileSync(ONLINE_CACHE_FILE, 'utf8')); } catch { /* keep */ } }
  }

  const overview = opts.usage?.overview ?? null;
  const zcodeSplit = identities['glm-coding-plan']?.status === 'not-installed'
    ? { available: false, providers: [] }
    : zcodeProviderSplit(opts.dbPath ?? ZCODE_DB, now);

  const plans = [];
  for (const p of PLAN_REGISTRY) {
    const id = identities[p.id] ?? { status: 'unknown' };
    let usage = { kind: 'none', kindLabel: USAGE_KIND_LABEL.none, windows: null };
    if (p.id === 'glm-coding-plan') {
      // GLM 窗口来自 model_usage 逐请求账本（不依赖 usage 扫描完成；OpenCode 部分在 overview 就绪后并入）：ZCode 按 provider 精确（account:* 即 coding plan 计费）+ OpenCode 按 glm* 模型名（近似）
      const zc = zcodeSplit.available ? zcodeSplit.providers.filter((r) => r.isCodingPlan) : [];
      const ocWin = planUsageWindows(overview, ['opencode'], /^glm/i);
      const zcWin = {
        all: (r) => ({ requests: r.requests, tokens: r.input + r.output + r.cacheRead + r.cacheWrite }),
        today: (r) => ({ requests: r.requestsToday, tokens: r.inputToday + r.outputToday + r.cacheReadToday + r.cacheWriteToday }),
        d7: (r) => ({ requests: r.requestsD7, tokens: r.inputD7 + r.outputD7 + r.cacheReadD7 + r.cacheWriteD7 }),
        d30: (r) => ({ requests: r.requestsD30, tokens: r.inputD30 + r.outputD30 + r.cacheReadD30 + r.cacheWriteD30 }),
        h5: (r) => ({ requests: r.requestsH5, tokens: r.inputH5 + r.outputH5 + r.cacheReadH5 + r.cacheWriteH5 }),
      };
      const mk = (winName, w) => {
        const requests = zc.reduce((s, r) => s + num(zcWin[winName](r).requests), 0) + (w.requests || 0);
        const tokens = zc.reduce((s, r) => s + num(zcWin[winName](r).tokens), 0) + (w.tokens || 0);
        return { available: !!(zc.length || w.available), requests, tokens, zcodeExact: zc.length > 0, opencodeApprox: w.available };
      };
      usage = {
        kind: 'exact', kindLabel: USAGE_KIND_LABEL.exact + '（ZCode 按 provider）' + (ocWin.windows.all.available ? ' + OpenCode glm* 模型（近似）' : ''),
        windows: { h5: mk('h5', ocWin.windows.h5), today: mk('today', ocWin.windows.today), d7: mk('d7', ocWin.windows.d7), d30: mk('d30', ocWin.windows.d30), all: mk('all', ocWin.windows.all) },
        zcodeProviders: zc.map((r) => ({ provider: r.provider, requests: r.requests, completed: r.completed, input: r.input, output: r.output, cacheRead: r.cacheRead, lastAt: r.lastAt,
          requestsH5: r.requestsH5, inputH5: r.inputH5, outputH5: r.outputH5,
          requestsToday: r.requestsToday, inputToday: r.inputToday, outputToday: r.outputToday,
          requestsD7: r.requestsD7, inputD7: r.inputD7, outputD7: r.outputD7 })),
      };
    } else if (p.agents.length && overview) {
      usage = planUsageWindows(overview, p.agents, p.modelFilter);
    }
    const plan = {
      id: p.id, vendor: p.vendor, product: p.product, category: p.category,
      status: id.status ?? 'unknown', planName: id.planName ?? null, account: id.account ?? null,
      agents: p.agents, identityAt: id.at ?? null, sem: p.sem ?? null,
      evidence: id.evidence ?? [], notes: id.notes ?? [],
      usage, quota: id.quota ?? null,
    };
    // 档位来源优先级（2026-10-27 用户定向「通过 api-key 查找 coding plan 来源」）：
    //   在线官方端点（最权威、带配额）> 本地证据 > 用户标注（兜底；plan-overrides.json）
    const on = online ? online[p.id] : null;
    if (on && !on.error && on.fetchedAt) {
      if (on.tier) {
        plan.planName = on.tier;
        plan.planNameSource = 'online';
        plan.onlineFetchedAt = on.fetchedAt;
        if (on.validUntil) plan.onlineValidUntil = on.validUntil;
        if (on.level) plan.onlineLevel = on.level;
        if (on.account) plan.account = on.account;
        if (plan.status === 'signed-in' || plan.status === 'not-signed-in') plan.status = 'active';
        plan.evidence.push({ file: '厂商官方端点（在线只读）', field: p.id + ' 在线档位', value: on.tier + '（' + new Date(on.fetchedAt).toLocaleString('zh-CN') + '）' });
      }
      if (on.quotas && Object.values(on.quotas).some(Boolean)) plan.onlineQuotas = on.quotas;
    }
    const ov = overrides[p.id];
    if (ov?.planName && plan.planNameSource !== 'online') {
      const local = plan.planName;
      if (local && local !== ov.planName) plan.notes.push('用户标注档位「' + ov.planName + '」与本地证据「' + local + '」不一致——以用户标注为准（本地缓存可能滞后）');
      else if (!local) plan.notes.push('档位为用户标注（plan-overrides.json）；在线端点可用后自动以在线结果为准');
      plan.planName = ov.planName;
      plan.planNameSource = 'user-asserted';
      plan.planNameAsOf = ov.asOf ?? null;
      plan.evidence.push({ file: '~/.agent-pet/plan-overrides.json', field: p.id + '.planName', value: ov.planName + '（用户标注' + (ov.asOf ? '，' + ov.asOf : '') + '）' });
      if (plan.status === 'signed-in' || plan.status === 'not-signed-in') plan.status = 'active';
    } else if (plan.planName && !plan.planNameSource) plan.planNameSource = 'local-evidence';
    // ZCode 里非 coding-plan 的 provider（deepseek/moonshot-kimi 自备 key）如实提示到对应厂商行
    if (p.id === 'glm-coding-plan' && zcodeSplit.available) {
      const others = zcodeSplit.providers.filter((r) => !r.isCodingPlan);
      if (others.length) plan.notes.push('ZCode 内还有自备 API key 的 provider：' + others.map((r) => r.provider + ' ' + r.requests + ' 请求').join(' · ') + '（不计入本 plan）');
    }
    if (p.id === 'deepseek' && zcodeSplit.available) {
      const ds = zcodeSplit.providers.find((r) => r.provider === 'deepseek');
      if (ds) plan.notes.push('ZCode 内另有 deepseek provider ' + ds.requests + ' 次请求（自备 key，ZCode 会话内）');
    }
    plans.push(plan);
  }

  const order = { active: 0, 'api-billing': 1, 'signed-in': 2, 'not-signed-in': 3, unknown: 4, 'not-installed': 5 };
  plans.sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4) || a.vendor.localeCompare(b.vendor, 'zh'));
  const summary = {
    total: plans.length,
    active: plans.filter((x) => x.status === 'active').length,
    apiBilling: plans.filter((x) => x.status === 'api-billing').length,
    signedIn: plans.filter((x) => x.status === 'signed-in').length,
    notSignedIn: plans.filter((x) => x.status === 'not-signed-in').length,
    notInstalled: plans.filter((x) => x.status === 'not-installed').length,
  };
  return {
    generatedAt: Date.now(), tookMs: Number((Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2)),
    summary,
    legend: {
      h5: '5h 滚动窗口：仅 ZCode 有逐请求账本（model_usage.started_at）可精确归属；其余源为自然日语桶、h5 不可算（如实标 —）',
      today: '本地自然日（0 点起）', d7: '近 7 天（滚动）', d30: '近 30 天（滚动）', all: '全部历史',
      refresh: '随用量扫描懒刷新（60s 缓存）：打开本页或点刷新即触发；限额数值在厂商云端、本机无缓存（安全红线：不持凭证调云 API）',
    },
    redline: '全部证据来自本机只读文件/数据库（不持凭证调厂商云 API——安全红线）；云端配额数值本地不落盘的厂商如实标注',
    plans,
  };
}

/** 测试钩子：清空身份缓存。 */
export function resetPlanUsageCache() { identityCache = { at: 0, data: null }; }
export { refreshOnlineLayer, fetchKimiOnline, fetchGlmOnline, fetchQoderOnline, harvestQoderToken, decryptZcodeValue, ONLINE_CACHE_FILE, ONLINE_TTL_MS };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function fmtTok(n) {
  n = Number(n) || 0;
  return n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n);
}
const STATUS_LABEL = { active: '订阅在用', 'api-billing': 'API/余额计费', 'signed-in': '已登录·档位未知', 'not-signed-in': '已安装·未登录', unknown: '未知', 'not-installed': '未安装' };

async function main(argv) {
  const fast = argv.includes('--fast');
  let usage = null;
  if (!fast) {
    const { scanAllUsage, FORCE_SCAN_OPTS } = await import('./usage-collect.mjs');
    usage = await scanAllUsage(argv.includes('--refresh') ? FORCE_SCAN_OPTS : {});
  }
  const r = await scanPlanUsage({ usage });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log('Coding Plan 使用情况（' + r.summary.total + ' 家主流厂商 · ' + new Date(r.generatedAt).toLocaleString('zh-CN') + ' · ' + r.tookMs + 'ms）');
  console.log('  ' + r.redline + '\n');
  for (const p of r.plans) {
    const head = STATUS_LABEL[p.status] ?? p.status;
    console.log('  ' + head.padEnd(9) + ' ' + (p.vendor + ' · ' + p.product).padEnd(36) + (p.planName ? '档位=' + p.planName + '  ' : '') + (p.account ? '账号=' + p.account : ''));
    if (p.quota?.kind === 'balance') console.log('      余额 ' + p.quota.balance + ' ' + p.quota.currency + ' · 今日 ' + p.quota.todayCost + ' · 7日 ' + p.quota.d7Cost + ' · 30日 ' + p.quota.d30Cost);
    const w = p.usage?.windows;
    if (w?.all?.available) {
      console.log('      用量（' + p.usage.kindLabel + '）：今日 ' + fmtTok(w.today.tokens) + ' tok / ' + w.today.requests + ' req · 7日 ' + fmtTok(w.d7.tokens) + ' / ' + w.d7.requests + ' · 全部 ' + fmtTok(w.all.tokens) + ' / ' + w.all.requests);
      for (const z of p.usage.zcodeProviders ?? []) console.log('        · ' + z.provider + '：' + z.requests + ' 请求（完成 ' + z.completed + '）in ' + fmtTok(z.input) + ' · out ' + fmtTok(z.output) + ' · 今日 in ' + fmtTok(z.inputToday));
    }
    for (const n of p.notes) console.log('      · ' + n);
    for (const e of p.evidence) console.log('      证 ' + (e.file ? e.file + ' · ' : '') + e.field + ' = ' + e.value);
  }
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) await main(process.argv.slice(2));
