#!/usr/bin/env node
/**
 * demo/test-plan-usage.mjs — Coding Plan 使用情况回归（2026-10-26）
 *
 * 覆盖：
 *   MU-PU1  身份层：GLM entitlement 缓存 / Claude oauthAccount / Codex auth_mode / Kimi 登录态
 *           / Qoder app-status / Cursor stripeMembershipType / Copilot SKU（fixture 假家目录）
 *   MU-PU2  隐私：输出 JSON 绝不包含 fixture 里的凭证值/完整账号（打码断言）
 *   MU-PU3  配额层：DeepSeek 余额账本（余额即配额；1 单位 = 1e-8 元换算）
 *   MU-PU4  ZCode model_usage 按 provider 拆分（account:* = coding plan）+ 时间窗分桶（今日/7日/30日）
 *   MU-PU5  用量窗口映射：usage overview → 各 plan（精确/估算/请求级三口径透传）
 *   MU-PU6  未安装厂商如实标注 + summary 计数 + 排序（active 在前）
 *   MU-PU7  UI：用量页 Coding Plan 区渲染（行数、打码、余额、红线注记）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createUiSandbox } from './test-ui-dom.mjs';
import { windowFixture } from './test-ui-fixture.mjs';

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 27, 12).getTime();   // 2026-10-27 12:00 本地

// ---------------------------------------------------------------------------
// fixture 假家目录（凭证值全部为假，专供「不泄漏」断言使用）
// ---------------------------------------------------------------------------
const FIX = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-usage-fix-'));
const SECRET_TOKEN = 'SK-SECRET-TOKEN-abcdef123456';
const FULL_EMAIL = 'someone@qq.com';
const FULL_ACCOUNT = '13712345678';
const w = (rel, data) => { const p = path.join(FIX, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data)); };

// GLM（ZCode）
w('.zcode/v2/coding-plan-cache.json', { version: 1, entryStatus: { updatedAt: NOW - 40 * DAY, items: {
  'builtin:bigmodel-coding-plan': { status: 'available' },
  'builtin:zai-start-plan': { status: 'unavailable', reason: 'coding_plan_not_entitled' },
} } });
w('.zcode/v2/credentials.json', {
  ['account-provider:coding-plan:account:bigmodel-team-coding-plan:account:' + FULL_ACCOUNT + ':api-key']: SECRET_TOKEN,
  'oauth:bigmodel:access_token': SECRET_TOKEN,
});
// DeepSeek（DSH 余额账本：1 单位 = 1e-8 元）
w('.dsh/.dshw-usage.json', {
  date: '2026-10-27', lastBalance: 100.5, todayUsage: 1.23, dayStart: 101.73,
  accounting: { version: 1, active: 'book1-CNY', books: { 'book1-CNY': { currency: 'CNY', days: {
    '2026-10-25': { day: '2026-10-25', debitUnits: 2e8 },        // ¥2.00（7 日外·30 日内）
    '2026-10-26': { day: '2026-10-26', debitUnits: 1676000000 }, // ¥16.76（7 日内）
    '2026-10-27': { day: '2026-10-27', debitUnits: 123000000 },  // ¥1.23（今日）
  } } } },
  events: [{ ts: NOW - 3600e3, day: '2026-10-27', model: 'deepseek-flash', cost: 1.23, tokens: 31663410 }],
});
// Claude（已登录）
w('.claude.json', { oauthAccount: { emailAddress: FULL_EMAIL, organizationName: 'Acme Inc' } });
// Codex（API key 模式）
w('.codex/auth.json', { auth_mode: 'apikey', OPENAI_API_KEY: SECRET_TOKEN });
// Kimi（登录态）
w('.kimi-code/credentials/kimi-code.json', { access_token: SECRET_TOKEN, refresh_token: SECRET_TOKEN, expires_at: Math.floor(NOW / 1000) + 3600, scope: 'kimi-code', token_type: 'Bearer' });
w('.kimi-code/region', 'mainland-cn');
// Qoder（登录态）
w('.qoder-cn/.qoder-app-status.json', { logged_in: true, name: 'TestUser', version: '0.4.11', product: 'qodercn' });
// OpenCode（GLM coding plan provider）
w('.local/share/opencode/auth.json', { zhipuai: { type: 'api' }, 'zhipuai-coding-plan': { type: 'api' } });

// Cursor vscdb（ItemTable）
function makeKvDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE ItemTable (key TEXT, value TEXT)');
  const ins = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  for (const [k, v] of rows) ins.run(k, v);
  db.close();
}
makeKvDb(path.join(FIX, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb'), [
  ['cursorAuth/stripeMembershipType', 'free'],
  ['cursorAuth/cachedEmail', FULL_EMAIL],
  ['cursorAuth/cachedSignUpType', 'Auth_0'],
]);
// GitHub Copilot（VS Code vscdb SKU + ~/.copilot/data.db accounts）
makeKvDb(path.join(FIX, 'Library/Application Support/Code/User/globalStorage/state.vscdb'), [
  ['extensionsAssignmentFilterProvider.copilotSku', 'free_limited_copilot'],
]);
fs.mkdirSync(path.join(FIX, '.copilot'), { recursive: true });
{
  const db = new DatabaseSync(path.join(FIX, '.copilot/data.db'));
  db.exec('CREATE TABLE accounts (login TEXT, host TEXT, kind TEXT, created_at TEXT, access_token TEXT)');
  db.prepare('INSERT INTO accounts (login, host, kind, created_at, access_token) VALUES (?, ?, ?, ?, ?)').run('TestUser607', 'github.com', 'github', '2026-10-26T00:00:00Z', SECRET_TOKEN);
  db.close();
}

// ZCode model_usage fixture 库（真实 schema 的相关列）
const ZC_DB = path.join(FIX, '.zcode/cli/db/db.sqlite');
{
  fs.mkdirSync(path.dirname(ZC_DB), { recursive: true });
  const db = new DatabaseSync(ZC_DB);
  db.exec(`CREATE TABLE model_usage (id TEXT, provider_id TEXT, model_id TEXT, status TEXT, started_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER)`);
  const ins = db.prepare('INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?)');
  const row = (provider, agoMs, input, output, cacheRead) => ins.run('u' + Math.random(), provider, 'GLM-5.3-Flash', 'completed', NOW - agoMs, input, output, cacheRead, 0);
  row('account:bigmodel-individual-coding-plan', 3600e3, 1000, 100, 50);      // 今日
  row('account:bigmodel-individual-coding-plan', 2 * DAY, 2000, 200, 60);     // 7 日内
  row('account:bigmodel-individual-coding-plan', 10 * DAY, 4000, 400, 70);    // 30 日内
  row('account:bigmodel-individual-coding-plan', 40 * DAY, 8000, 800, 80);    // 更早
  row('deepseek', 3600e3, 500, 50, 10);
  db.close();
}

// usage overview fixture（usageOverview 输出的相关形状）
const src = (requests, input, output, { estimated = false, models = [] } = {}) => ({ totals: { requests, input, output, cacheRead: 0, cacheWrite: 0 }, models, estimated, partial: false });
const overview = {
  totals: {}, bySource: {
    'claude-code': src(7, 1000, 200),
    codex: src(3, 500, 100),
    'kimi-code': src(2, 300, 60),
    qoder: src(85, 0, 0, { estimated: true }),
    cursor: src(35, 0, 0, { estimated: true }),
    opencode: src(4, 800, 120, { models: [{ model: 'glm-5.3-flash', requests: 2, input: 300, output: 40, cacheRead: 0, cacheWrite: 0 }, { model: 'other-model', requests: 2, input: 500, output: 80, cacheRead: 0, cacheWrite: 0 }] }),
    dsh: src(5, 400, 90),
    zcode: src(9, 700, 150),
  },
  ranges: {
    today: { totals: {}, bySource: { 'claude-code': src(2, 100, 20) } },
    d7: { totals: {}, bySource: {} },
    d30: { totals: {}, bySource: {} },
  },
};

// fixture 用户标注档位（plan-overrides.json）
w('.agent-pet/plan-overrides.json', { 'kimi-for-coding': { planName: 'Pro', asOf: '2026-10-26' } });
// 设置 PLAN_USAGE_HOME / 覆盖文件路径后再 import（模块在 import 时解析）
process.env.PLAN_USAGE_HOME = FIX;
process.env.PET_PLAN_OVERRIDES = path.join(FIX, '.agent-pet/plan-overrides.json');
const { scanPlanUsage, zcodeProviderSplit, maskEmail, maskName, resetPlanUsageCache } = await import('../adapters/plan-usage.mjs');
resetPlanUsageCache();

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('MU-PU4 ZCode model_usage 按 provider 拆分与时间窗分桶', () => {
  const split = zcodeProviderSplit(ZC_DB, NOW);
  assert.equal(split.available, true);
  const plan = split.providers.find((r) => r.isCodingPlan);
  const other = split.providers.find((r) => r.provider === 'deepseek');
  assert.ok(plan, 'account:* 应识别为 coding plan');
  assert.equal(plan.requests, 4);
  assert.equal(plan.requestsToday, 1);
  assert.equal(plan.requestsH5, 1, '1h 前的请求应落进 5h 滚动窗');
  assert.equal(plan.requestsD7, 2);
  assert.equal(plan.requestsD30, 3);
  assert.equal(plan.inputToday, 1000);
  assert.equal(plan.inputToday + plan.outputToday + plan.cacheReadToday + plan.cacheWriteToday, 1150);
  assert.equal(plan.inputD7, 3000);
  assert.equal(plan.inputD30, 7000);
  assert.equal(plan.input, 15000);
  assert.equal(other.requests, 1);
  assert.equal(other.isCodingPlan, false);
});

test('MU-PU1/2/3/5/6 scanPlanUsage：身份 × 配额 × 用量窗口 × 隐私（全量断言）', async () => {
  const r = await scanPlanUsage({ usage: { overview }, now: NOW, dbPath: ZC_DB });
  const byId = Object.fromEntries(r.plans.map((p) => [p.id, p]));
  const json = JSON.stringify(r);

  // —— 隐私：凭证值/完整账号绝不出现 ——
  assert.ok(!json.includes(SECRET_TOKEN), '输出不得包含凭证值');
  assert.ok(!json.includes(FULL_EMAIL), '输出不得包含完整邮箱原文');
  assert.ok(!json.includes(FULL_ACCOUNT), '输出不得包含完整账号原文');
  assert.ok(json.includes(maskEmail(FULL_EMAIL)), '邮箱应打码展示');
  assert.ok(json.includes(maskName('TestUser')), '登录名应打码展示');
  assert.ok(json.includes('"user-asserted"'), '档位来源标记应透出');

  // —— GLM：entitlement + provider 拆分 + 窗口（ZCode 精确 + OpenCode glm* 近似）——
  const glm = byId['glm-coding-plan'];
  assert.equal(glm.status, 'active');
  assert.equal(glm.planName, 'bigmodel-coding-plan');
  assert.ok(glm.evidence.some((e) => String(e.file).includes('coding-plan-cache.json')));
  assert.ok(glm.evidence.some((e) => String(e.value).includes('zhipuai-coding-plan')), 'OpenCode provider 证据应并入');
  assert.ok(glm.notes.some((n) => n.includes('自备 API key')), 'ZCode 内非 plan provider 应如实提示');
  assert.equal(glm.usage.kind, 'exact');
  assert.equal(glm.usage.windows.all.requests, 4 + 2);        // zcode plan 4 + opencode glm* 2
  assert.equal(glm.usage.windows.all.tokens, (15000 + 1500 + 260 + 0) + (300 + 40));
  assert.equal(glm.usage.windows.today.requests, 1 + 0);      // opencode ranges.today 无 opencode 源
  assert.equal(glm.usage.windows.today.tokens, 1150);
  assert.equal(glm.usage.windows.h5.requests, 1, 'GLM 5h 滚动窗（ZCode 精确）');
  assert.equal(glm.usage.windows.h5.tokens, 1150);
  assert.equal(glm.sem, '5h 滚动窗口（公开产品口径；本机有逐请求账本可精确归属）');
  const claudePlan = byId['claude'];
  assert.equal(claudePlan.usage.windows.h5.available, false, '非 ZCode 源无逐请求账本 → h5 如实不可用');
  assert.ok(r.legend && r.legend.h5 && r.legend.refresh, 'legend 窗口/刷新口径说明应随响应透出');
  assert.ok(glm.usage.zcodeProviders.length === 1);

  // —— DeepSeek：余额即配额，1e-8 元换算 ——
  const ds = byId['deepseek'];
  assert.equal(ds.status, 'api-billing');
  assert.equal(ds.quota.kind, 'balance');
  assert.equal(ds.quota.balance, 100.5);
  assert.equal(ds.quota.todayCost, 1.23);
  assert.equal(ds.quota.d7Cost, 19.99);          // 2.00 + 16.76 + 1.23（10-25 在 7 日窗内）
  assert.equal(ds.quota.d30Cost, 19.99);
  assert.equal(ds.quota.allCost, 19.99);
  assert.ok(ds.usage.windows.all.available && ds.usage.windows.all.requests === 5, 'DSH 源用量应映射到 deepseek plan');
  assert.ok(ds.notes.some((n) => n.includes('ZCode 内另有 deepseek provider 1 次请求')));

  // —— Claude / Codex / Kimi ——
  assert.equal(byId['claude'].status, 'signed-in');
  assert.equal(byId['claude'].account, maskEmail(FULL_EMAIL));
  assert.equal(byId['claude'].usage.windows.all.requests, 7);
  assert.equal(byId['claude'].usage.windows.today.requests, 2);
  assert.equal(byId['chatgpt-codex'].status, 'api-billing');
  assert.equal(byId['chatgpt-codex'].planName, 'API Key 计费');
  assert.ok(!json.includes('OPENAI_API_KEY'), 'auth.json 键名里的密钥名不应透出');
  assert.equal(byId['kimi-for-coding'].status, 'active', '用户标注档位后应升级为订阅在用');
  assert.equal(byId['kimi-for-coding'].planName, 'Pro', 'Kimi 档位应来自用户标注');
  assert.equal(byId['kimi-for-coding'].planNameSource, 'user-asserted');
  assert.ok(byId['kimi-for-coding'].evidence.some((e) => String(e.file || '').includes('plan-overrides.json')), '用户标注应留下证据行');
  assert.ok(byId['kimi-for-coding'].notes.some((n) => n.includes('档位为用户标注')));

  // —— Qoder / Cursor / Copilot ——
  assert.equal(byId['qoder'].status, 'signed-in');
  assert.equal(byId['cursor'].status, 'active');
  assert.equal(byId['cursor'].planName, 'Free');
  assert.equal(byId['copilot'].status, 'active');
  assert.equal(byId['copilot'].planName, 'Free（有限额度）');
  assert.ok(!byId['copilot'].agents.length, 'Copilot 无观察源');
  assert.equal(byId['copilot'].usage.kind, 'none');

  // —— 估算/请求级口径透传 ——
  assert.equal(byId['qoder'].usage.kind, 'estimate');
  assert.ok(byId['qoder'].usage.windows.all.approximate);
  // 估算关闭形态：tokens=0 且请求>0 → 请求级
  const r2 = await scanPlanUsage({ usage: { overview: { ...overview, bySource: { ...overview.bySource, qoder: src(85, 0, 0), cursor: src(35, 0, 0) } } }, now: NOW, dbPath: ZC_DB, refresh: true });
  const q2 = r2.plans.find((p) => p.id === 'qoder');
  assert.equal(q2.usage.kind, 'requests');
  assert.ok(q2.usage.windows.all.unavailable);

  // —— 未安装 + summary + 排序 ——
  assert.equal(byId['gemini'].status, 'not-installed');
  assert.ok(byId['gemini'].notes.some((n) => n.includes('未发现安装痕迹')));
  assert.equal(r.summary.total, 15);
  const order = { active: 0, 'api-billing': 1, 'signed-in': 2, 'not-signed-in': 3, unknown: 4, 'not-installed': 5 };
  const ranks = r.plans.map((p) => order[p.status]);
  assert.deepEqual([...ranks].sort((a, b) => a - b), ranks, 'plans 应按状态优先级排序');

  // —— 身份缓存：同参数二次扫描应命中缓存（identical 引用）——
  const r3 = await scanPlanUsage({ usage: { overview }, now: NOW, dbPath: ZC_DB });
  assert.equal(r3.plans.find((p) => p.id === 'cursor').planName, 'Free');
});

test('MU-PU7 UI：用量页 Coding Plan 区渲染（行、打码、余额、红线注记）', async () => {
  const html = fs.readFileSync(new URL('./window.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/let es=null;[\s\S]*$/, '');
  const harness = createUiSandbox(html), { sandbox, getEl, requests } = harness;
  const planPayload = {
    generatedAt: NOW, refreshing: false,
    summary: { total: 15, active: 3, apiBilling: 1, signedIn: 2, notSignedIn: 0, notInstalled: 9 },
    redline: '全部证据来自本机只读文件/数据库（不持凭证调厂商云 API——安全红线）',
    legend: { h5: '5h 滚动窗口', today: '本地自然日', refresh: '随用量扫描懒刷新（60s 缓存）' },
    plans: [
      { id: 'glm-coding-plan', vendor: '智谱 Z.ai', product: 'GLM Coding Plan', category: 'subscription', status: 'active', planName: 'bigmodel-coding-plan', account: null, agents: ['zcode'], sem: '5h 滚动窗口（公开产品口径；本机有逐请求账本可精确归属）', evidence: [{ file: '~/.zcode/v2/coding-plan-cache.json', field: 'entryStatus.items', value: 'available: bigmodel-coding-plan' }], notes: [], identityAt: NOW,
        usage: { kind: 'exact', kindLabel: '精确 token（ZCode 按 provider）', windows: { h5: { available: true, requests: 49, tokens: 11867629, approximate: false, unavailable: false }, all: { available: true, requests: 30087, tokens: 10876567823, approximate: false, unavailable: false }, today: { available: true, requests: 49, tokens: 11867629, approximate: false, unavailable: false }, d7: { available: true, requests: 3744, tokens: 1367550362, approximate: false, unavailable: false }, d30: { available: true, requests: 30087, tokens: 10876567823, approximate: false, unavailable: false } }, zcodeProviders: [{ provider: 'account:bigmodel-individual-coding-plan', requests: 28227, completed: 28000, input: 5043895878, output: 15227382, cacheRead: 0, inputToday: 205723, lastAt: NOW }] }, quota: null },
      { id: 'deepseek', vendor: 'DeepSeek', product: 'DeepSeek 开放平台', category: 'api-balance', status: 'api-billing', planName: '开放平台按量计费', account: '1***e', agents: ['dsh'], evidence: [], notes: ['按量计费（非订阅制）：余额即配额'], identityAt: null,
        usage: { kind: 'exact', kindLabel: '精确 token', windows: { h5: { available: false, requests: 0, tokens: 0, approximate: false, unavailable: false, reason: '本地账本按自然日记账' }, all: { available: true, requests: 5, tokens: 490, approximate: false, unavailable: false }, today: { available: true, requests: 1, tokens: 110, approximate: false, unavailable: false }, d7: { available: false, requests: 0, tokens: 0, approximate: false, unavailable: false }, d30: { available: false, requests: 0, tokens: 0, approximate: false, unavailable: false } } },
        quota: { kind: 'balance', currency: 'CNY', balance: 100.5, todayCost: 1.23, d7Cost: 17.99, d30Cost: 19.99, allCost: 19.99, daily: [{ day: '2026-10-27', cost: 1.23 }], events: [{ ts: NOW, day: '2026-10-27', model: 'deepseek-flash', cost: 1.23, tokens: 31663410 }] } },
      { id: 'cursor', vendor: 'Cursor', product: 'Cursor 订阅', category: 'subscription', status: 'active', planName: 'Free', account: maskEmail(FULL_EMAIL), agents: ['cursor'], evidence: [{ file: 'state.vscdb', field: 'cursorAuth/stripeMembershipType', value: 'free' }], notes: [], identityAt: null,
        usage: { kind: 'estimate', kindLabel: '含包络估算', windows: { h5: { available: false, requests: 0, tokens: 0, approximate: false, unavailable: false, reason: '本地无逐请求时间戳账本（自然日语桶），5h 滚动窗不可精确归属' }, all: { available: true, requests: 35, tokens: 811750, approximate: true, unavailable: false }, today: { available: true, requests: 0, tokens: 0, approximate: true, unavailable: false }, d7: { available: false, requests: 0, tokens: 0, approximate: false, unavailable: false }, d30: { available: false, requests: 0, tokens: 0, approximate: false, unavailable: false } } }, quota: null },
      { id: 'kimi-for-coding', vendor: '月之暗面 Moonshot', product: 'Kimi For Coding', category: 'subscription', status: 'active', planName: 'Pro', planNameSource: 'user-asserted', account: null, agents: ['kimi-code'], sem: '窗口语义未核实（本地无缓存）', evidence: [{ file: '~/.agent-pet/plan-overrides.json', field: 'kimi-for-coding.planName', value: 'Pro（用户标注，2026-10-26）' }], notes: ['档位为用户标注（plan-overrides.json）'], identityAt: null,
        usage: { kind: 'exact', kindLabel: '精确 token', windows: { h5: { available: false, requests: 0, tokens: 0, approximate: false, unavailable: false, reason: '本地无逐请求时间戳账本' }, all: { available: true, requests: 2, tokens: 360, approximate: false, unavailable: false }, today: { available: true, requests: 1, tokens: 60, approximate: false, unavailable: false }, d7: { available: false, requests: 0, tokens: 0, approximate: false, unavailable: false }, d30: { available: false, requests: 0, tokens: 0, approximate: false, unavailable: false } } }, quota: null },
      { id: 'gemini', vendor: 'Google', product: 'Gemini Code Assist / Antigravity', category: 'subscription', status: 'not-installed', planName: null, account: null, agents: [], evidence: [], notes: ['本机未发现安装痕迹'], identityAt: null, usage: { kind: 'none', kindLabel: '无观察源', windows: null }, quota: null },
    ],
  };
  sandbox.fetch = async (p) => {
    requests.push({ path: p });
    if (p === '/api/plan-usage') return { ok: true, json: async () => planPayload };
    if (p === '/api/usage/calendar') return { ok: true, json: async () => ({ generatedAt: NOW, timeZone: 'Asia/Shanghai', sources: {} }) };
    return { ok: true, json: async () => ({}) };
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  const snap = windowFixture();
  snap.ts = NOW;
  snap.usage = { pending: false, generatedAt: NOW, totals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1 }, bySource: {}, ranges: {}, refreshing: false };
  sandbox.render(snap);
  await getEl('view-usage').dispatch('click');
  await tick(); await tick(); await tick();
  const text = getEl('usage-body').innerHTML;
  assert.match(text, /Coding Plan 使用情况/);
  assert.match(text, /家厂商/);                                    // 汇总 chips 行
  assert.match(text, /<strong>3<\/strong>订阅在用/);
  assert.match(text, /assets\/agents\/zcode\.png/);                // 厂商图标（GLM→zcode 资产）
  assert.match(text, /assets\/agents\/deepseek\.png/);
  assert.match(text, /assets\/agents\/cursor\.svg/);
  assert.match(text, /pu-vendor/);
  assert.match(text, /GLM Coding Plan/);
  assert.match(text, /account:bigmodel-individual-coding-plan/);
  assert.match(text, /余额 ¥100\.5/);
  assert.match(text, /¥17\.99|¥19\.99/);
  assert.match(text, /Free/);
  assert.match(text, /Pro/);
  assert.match(text, />标注<\/span>/, '用户标注档位应显示「标注」徽标');
  assert.match(text, /未安装（1 家）/);                             // 未安装折叠为单行
  assert.match(text, /Gemini Code Assist \/ Antigravity/);
  assert.match(text, /安装并登录后自动出现在此表/);
  assert.match(text, /不持凭证调厂商云 API/);
  assert.ok(text.includes(maskEmail(FULL_EMAIL)), '打码邮箱应出现在 UI');
  assert.ok(!text.includes(SECRET_TOKEN));
  assert.ok(!text.includes(FULL_EMAIL));
});

test('MU-PU8 UI：订阅独立页渲染（卡片/5h 窗/限额/刷新时间/未安装折叠）', async () => {
  const html = fs.readFileSync(new URL('./window.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/let es=null;[\s\S]*$/, '');
  const harness = createUiSandbox(html), { sandbox, getEl, requests } = harness;
  const planPayload = {
    generatedAt: NOW, refreshing: false,
    summary: { total: 15, active: 3, apiBilling: 1, signedIn: 2, notSignedIn: 0, notInstalled: 9 },
    redline: '全部证据来自本机只读文件/数据库（不持凭证调厂商云 API——安全红线）',
    legend: { h5: '5h 滚动窗口', today: '本地自然日', refresh: '随用量扫描懒刷新（60s 缓存）' },
    plans: [
      { id: 'glm-coding-plan', vendor: '智谱 Z.ai', product: 'GLM Coding Plan', category: 'subscription', status: 'active', planName: 'bigmodel-coding-plan', account: null, agents: ['zcode'], sem: '5h 滚动窗口（公开产品口径；本机有逐请求账本可精确归属）', evidence: [], notes: [], identityAt: NOW - DAY,
        usage: { kind: 'exact', kindLabel: '精确 token（ZCode 按 provider）', windows: { h5: { available: true, requests: 49, tokens: 11867629, approximate: false, unavailable: false }, today: { available: true, requests: 49, tokens: 11867629, approximate: false, unavailable: false }, d7: { available: true, requests: 3744, tokens: 1367550362, approximate: false, unavailable: false }, d30: { available: true, requests: 30087, tokens: 10876567823, approximate: false, unavailable: false }, all: { available: true, requests: 30087, tokens: 10876567823, approximate: false, unavailable: false } }, zcodeProviders: [{ provider: 'account:bigmodel-individual-coding-plan', requests: 28227, completed: 28000, input: 5043895878, output: 15227382, cacheRead: 0, inputToday: 205723, lastAt: NOW - 60000 }] }, quota: null },
      { id: 'deepseek', vendor: 'DeepSeek', product: 'DeepSeek 开放平台', category: 'api-balance', status: 'api-billing', planName: '开放平台按量计费', account: '1***e', agents: ['dsh'], sem: '无窗口概念（余额制，余额即剩余额度）', evidence: [], notes: [], identityAt: null,
        usage: { kind: 'exact', kindLabel: '精确 token', windows: { h5: { available: false, requests: 0, tokens: 0, approximate: false, unavailable: false, reason: '本地账本按自然日记账' }, all: { available: true, requests: 5, tokens: 490, approximate: false, unavailable: false }, today: { available: true, requests: 1, tokens: 110, approximate: false, unavailable: false }, d7: { available: false, requests: 0, tokens: 0, approximate: false, unavailable: false }, d30: { available: false, requests: 0, tokens: 0, approximate: false, unavailable: false } } },
        quota: { kind: 'balance', currency: 'CNY', balance: 100.5, todayCost: 1.23, d7Cost: 19.99, d30Cost: 19.99, allCost: 19.99, daily: [{ day: '2026-10-27', cost: 1.23 }], events: [] } },
      { id: 'kimi-for-coding', vendor: '月之暗面 Moonshot', product: 'Kimi For Coding', category: 'subscription', status: 'active', planName: 'Pro', planNameSource: 'user-asserted', account: null, agents: ['kimi-code'], sem: '窗口语义未核实（本地无缓存）', evidence: [{ file: '~/.agent-pet/plan-overrides.json', field: 'kimi-for-coding.planName', value: 'Pro（用户标注，2026-10-26）' }], notes: [], identityAt: null,
        usage: { kind: 'exact', kindLabel: '精确 token', windows: { h5: { available: false, requests: 0, tokens: 0, approximate: false, unavailable: false, reason: '本地无逐请求时间戳账本' }, all: { available: true, requests: 2, tokens: 360, approximate: false, unavailable: false }, today: { available: true, requests: 1, tokens: 60, approximate: false, unavailable: false }, d7: { available: false, requests: 0, tokens: 0, approximate: false, unavailable: false }, d30: { available: false, requests: 0, tokens: 0, approximate: false, unavailable: false } } }, quota: null },
      { id: 'gemini', vendor: 'Google', product: 'Gemini Code Assist / Antigravity', category: 'subscription', status: 'not-installed', planName: null, account: null, agents: [], evidence: [], notes: ['本机未发现安装痕迹'], identityAt: null, usage: { kind: 'none', kindLabel: '无观察源', windows: null }, quota: null },
    ],
  };
  sandbox.fetch = async (p) => {
    requests.push({ path: p });
    if (p === '/api/plan-usage') return { ok: true, json: async () => planPayload };
    return { ok: true, json: async () => ({}) };
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  const snap = windowFixture();
  snap.ts = NOW;
  snap.usage = { pending: false, generatedAt: NOW, totals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1 }, bySource: {}, ranges: {}, refreshing: false };
  sandbox.render(snap);
  assert.ok(getEl('view-plans'), '导航应有「订阅」按钮');
  assert.ok(getEl('plans-body'), '应有订阅页容器');
  await getEl('view-plans').dispatch('click');
  await tick(); await tick(); await tick();
  const text = getEl('plans-body').innerHTML;
  assert.match(text, /plan-card/);
  assert.match(text, /智谱 Z\.ai/);
  assert.match(text, /bigmodel-coding-plan/);
  assert.match(text, /5 小时/);
  assert.match(text, /余额 ¥100\.5/);
  assert.match(text, /Pro/);
  assert.match(text, />标注<\/span>/);
  assert.match(text, /最后请求 /);
  assert.match(text, /数据生成 /);
  assert.match(text, /未安装（1 家）/);
  assert.match(text, /安装并登录后自动出现/);
  const legend = getEl('plans-legend').textContent;
  assert.match(legend, /5h 滚动窗/);
  assert.match(legend, /不持凭证调厂商 API/);
  assert.ok(!text.includes(SECRET_TOKEN));
});
