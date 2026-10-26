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
import { openZcodeDb, ZCODE_DB } from './zcode-adapter.mjs';

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
    const b = { today: new Date(nowMs).setHours(0, 0, 0, 0), d7: nowMs - 7 * DAY_MS, d30: nowMs - 30 * DAY_MS };
    const win = (cut) => `SUM(CASE WHEN started_at >= ${cut} THEN 1 ELSE 0 END)`;
    const winTok = (cut, col) => `SUM(CASE WHEN started_at >= ${cut} THEN ${col} ELSE 0 END)`;
    const rows = db.prepare(`
      SELECT provider_id AS provider,
             COUNT(*) AS requests,
             SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
             SUM(input_tokens) AS input, SUM(output_tokens) AS output,
             SUM(cache_read_input_tokens) AS cacheRead, SUM(cache_creation_input_tokens) AS cacheWrite,
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
  const installed = ['/Applications/GitHub Copilot.app', path.join(HOME, '.copilot'), path.join(HOME, 'Library/Caches/github-copilot-sdk')].some(fileExists);
  const dbPath = path.join(HOME, 'Library/Application Support/Code/User/globalStorage/state.vscdb');
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

// ---------------------------------------------------------------------------
// 主流厂商注册表（含本机未安装者——「全部主流厂商」盘点口径）
// ---------------------------------------------------------------------------

export const PLAN_REGISTRY = Object.freeze([
  { id: 'glm-coding-plan', vendor: '智谱 Z.ai', product: 'GLM Coding Plan', agents: ['zcode', 'opencode'], category: 'subscription', probe: glmIdentity },
  { id: 'deepseek', vendor: 'DeepSeek', product: 'DeepSeek 开放平台', agents: ['dsh'], category: 'api-balance', probe: deepseekIdentity },
  { id: 'claude', vendor: 'Anthropic', product: 'Claude 订阅 / API', agents: ['claude-code'], category: 'subscription', probe: claudeIdentity },
  { id: 'chatgpt-codex', vendor: 'OpenAI', product: 'ChatGPT（Codex）/ API', agents: ['codex'], category: 'subscription', probe: codexIdentity },
  { id: 'kimi-for-coding', vendor: '月之暗面 Moonshot', product: 'Kimi For Coding', agents: ['kimi-code'], category: 'subscription', probe: kimiIdentity },
  { id: 'qoder', vendor: '阿里巴巴 Qoder', product: 'Qoder 会员', agents: ['qoder'], category: 'subscription', probe: qoderIdentity },
  { id: 'cursor', vendor: 'Cursor', product: 'Cursor 订阅', agents: ['cursor'], category: 'subscription', probe: cursorIdentity },
  { id: 'copilot', vendor: 'GitHub', product: 'GitHub Copilot', agents: [], category: 'subscription', probe: copilotIdentity },
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

  const overview = opts.usage?.overview ?? null;
  const zcodeSplit = identities['glm-coding-plan']?.status === 'not-installed'
    ? { available: false, providers: [] }
    : zcodeProviderSplit(opts.dbPath ?? ZCODE_DB, now);

  const plans = [];
  for (const p of PLAN_REGISTRY) {
    const id = identities[p.id] ?? { status: 'unknown' };
    let usage = { kind: 'none', kindLabel: USAGE_KIND_LABEL.none, windows: null };
    if (p.id === 'glm-coding-plan' && overview) {
      // GLM：ZCode 按 provider 精确（account:* 即 coding plan 计费）+ OpenCode 按 glm* 模型名（近似）
      const zc = zcodeSplit.available ? zcodeSplit.providers.filter((r) => r.isCodingPlan) : [];
      const ocWin = planUsageWindows(overview, ['opencode'], /^glm/i);
      const zcWin = {
        all: (r) => ({ requests: r.requests, tokens: r.input + r.output + r.cacheRead + r.cacheWrite }),
        today: (r) => ({ requests: r.requestsToday, tokens: r.inputToday + r.outputToday + r.cacheReadToday + r.cacheWriteToday }),
        d7: (r) => ({ requests: r.requestsD7, tokens: r.inputD7 + r.outputD7 + r.cacheReadD7 + r.cacheWriteD7 }),
        d30: (r) => ({ requests: r.requestsD30, tokens: r.inputD30 + r.outputD30 + r.cacheReadD30 + r.cacheWriteD30 }),
      };
      const mk = (winName, w) => {
        const requests = zc.reduce((s, r) => s + num(zcWin[winName](r).requests), 0) + (w.requests || 0);
        const tokens = zc.reduce((s, r) => s + num(zcWin[winName](r).tokens), 0) + (w.tokens || 0);
        return { available: !!(zc.length || w.available), requests, tokens, zcodeExact: zc.length > 0, opencodeApprox: w.available };
      };
      usage = {
        kind: 'exact', kindLabel: USAGE_KIND_LABEL.exact + '（ZCode 按 provider）' + (ocWin.windows.all.available ? ' + OpenCode glm* 模型（近似）' : ''),
        windows: { all: mk('all', ocWin.windows.all), today: mk('today', ocWin.windows.today), d7: mk('d7', ocWin.windows.d7), d30: mk('d30', ocWin.windows.d30) },
        zcodeProviders: zc.map((r) => ({ provider: r.provider, requests: r.requests, completed: r.completed, input: r.input, output: r.output, cacheRead: r.cacheRead, lastAt: r.lastAt,
          requestsToday: r.requestsToday, inputToday: r.inputToday, outputToday: r.outputToday,
          requestsD7: r.requestsD7, inputD7: r.inputD7, outputD7: r.outputD7 })),
      };
    } else if (p.agents.length && overview) {
      usage = planUsageWindows(overview, p.agents);
    }
    const plan = {
      id: p.id, vendor: p.vendor, product: p.product, category: p.category,
      status: id.status ?? 'unknown', planName: id.planName ?? null, account: id.account ?? null,
      agents: p.agents, identityAt: id.at ?? null,
      evidence: id.evidence ?? [], notes: id.notes ?? [],
      usage, quota: id.quota ?? null,
    };
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
    redline: '全部证据来自本机只读文件/数据库（不持凭证调厂商云 API——安全红线）；云端配额数值本地不落盘的厂商如实标注',
    plans,
  };
}

/** 测试钩子：清空身份缓存。 */
export function resetPlanUsageCache() { identityCache = { at: 0, data: null }; }

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
