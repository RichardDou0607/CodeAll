#!/usr/bin/env node
/**
 * demo/test-tick.mjs — PERF-1 轻量心跳（tick）UI 计时/状态回归自检
 *
 * 背景：v0.1.1 PERF-1 把 2s 全量快照降为轻量 tick（\{v:1,tick:true,ts\}）。window.html 的
 * 会话行 mmss 计时器、状态卡「活动中/静默」45s 标签、活跃/完成/隐藏三档时间边界必须由 tick
 * 本地维护，否则 UI 计时/状态会冻结（PERF-1 完成条件「UI 计时/状态无退化」）。
 *
 * 覆盖：
 *   T0  render 输出计时器 data 属性 + 记录 window.__CAT_MAP__；
 *   T1  tick+44s：会话行计时器 01:14→01:44（textContent 补写，不重建列表 DOM）；
 *   T2  tick+44s：状态卡活动标签 活动中→静默（45s 边界，本地补写）；
 *   T3  tick+2min：完成会话跨过 10min 缓冲期 → 分类跨界触发全量重渲染（完成档计数/列表变化）；
 *   T4  full snapshot render 路径不受影响（新快照按自身 elapsedMs/ts 全量渲染）；
 *   T5  mini.html tick 计时路径仍正常（01:14→01:44）。
 *
 * 复用 demo/test-ui-dom.mjs（最小 DOM）与 demo/test-ui-fixture.mjs（windowFixture）。
 * 运行：node demo/test-tick.mjs（无需网络/无需起服务）
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { createUiSandbox, extractMainScript } from './test-ui-dom.mjs';
import { windowFixture } from './test-ui-fixture.mjs';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  (ok ? pass++ : fail++);
  console.log((ok ? '✅ PASS' : '❌ FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
};
const countOf = (html, label) => { const m = new RegExp(label + ' (\\d+)').exec(html); return m ? Number(m[1]) : null; };

// ---------- window.html：真实内联脚本（去掉自动连接，保留 tickUpdate 定义） ----------
const windowHtml = fs.readFileSync(new URL('./window.html', import.meta.url), 'utf8');
let script = extractMainScript(windowHtml);
script = script.replace(/function connect\(\)\{[\s\S]*$/, '');

// 最小 DOM 不建树：为 render/tick 的 querySelectorAll + textContent 补写提供桩元素（模拟浏览器子元素）
const harness = createUiSandbox(windowHtml);
const { sandbox, getEl } = harness;
const sessionsEl = getEl('sessions');
const cardsEl = getEl('status-cards');
let elapsedStubs = [], labelStubs = [], reltimeStubs = [];
function refreshStubs() {
  const rows = sessionsEl.innerHTML;
  elapsedStubs = [...rows.matchAll(/<span class="tm"([^>]*)>([^<]*)<\/span>/g)].map((m) => {
    const attrs = m[1];
    const since = /data-since="([^"]+)"/.exec(attrs)?.[1] ?? null;
    const id = /data-session-id="([^"]+)"/.exec(attrs)?.[1] ?? null;
    return { id, since, textContent: m[2], getAttribute(n) { return n === 'data-since' ? this.since : n === 'data-session-id' ? this.id : null; } };
  });
  const cards = cardsEl.innerHTML;
  labelStubs = [...cards.matchAll(/<span class="k"[^>]*data-activity-label="([^"]+)"[^>]*>([^<]*)<\/span>/g)].map((m) => ({
    id: m[1], textContent: m[2], getAttribute(n) { return n === 'data-activity-label' ? this.id : null; },
  }));
  reltimeStubs = [...cards.matchAll(/data-reltime="([^"]+)"/g)].map((m) => ({
    id: m[1], textContent: '', getAttribute(n) { return n === 'data-reltime' ? this.id : null; },
  }));
}
sessionsEl.querySelectorAll = (sel) => (sel === '[data-since]' ? elapsedStubs : []);
cardsEl.querySelectorAll = (sel) => sel === '[data-reltime]' ? reltimeStubs : sel === '[data-activity-label]' ? labelStubs : [];
vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'window-inline.js' });
const stubOf = (arr, id) => arr.find((x) => x.id === id);

// ---------- 构造 tick 场景：会话 1 运行 74s（行内 01:14）；会话 6 完成于 9min 前（仍在 10min 缓冲内→活跃档） ----------
const now = Date.now();
function makeSnap(ts) {
  const snap = windowFixture();
  snap.ts = ts ?? now;
  snap.sessions = snap.sessions.map((s) => {
    if (s.id === 'session-1') return { ...s, state: 'running', elapsedMs: 74_000, since: now - 74_000, lastActiveMs: now - 2_000 };
    if (s.id === 'session-6') return { ...s, state: 'done', since: now - 9 * 60_000, lastActiveMs: now - 9 * 60_000, elapsedMs: 9 * 60_000 };
    return s;
  });
  return snap;
}
sandbox.render(makeSnap());
const sessionsHtml0 = sessionsEl.innerHTML;
const doneCount0 = countOf(getEl('sess-filter').innerHTML, '完成会话');
refreshStubs();

check('T0-a render：会话行 mmss 计时器带 data-since/data-session-id（tick 本地补写用）',
  sessionsHtml0.includes('01:14') && !!stubOf(elapsedStubs, 'session-1') && stubOf(elapsedStubs, 'session-1').since === String(now - 74_000),
  'session-1 stub: since=' + (stubOf(elapsedStubs, 'session-1') || {}).since + '，初始文本=' + (stubOf(elapsedStubs, 'session-1') || {}).textContent);
check('T0-b render：状态卡活动标签带 data-activity-label（初值「活动中」）',
  !!stubOf(labelStubs, 'dsh') && stubOf(labelStubs, 'dsh').textContent === '活动中',
  'dsh 标签=' + (stubOf(labelStubs, 'dsh') || {}).textContent);
const cat0 = sandbox.window.__CAT_MAP__;
check('T0-c render：记录分类快照 window.__CAT_MAP__（id→三档，跨 10min/1h 边界判断用）',
  !!cat0 && typeof cat0.get === 'function' && cat0.get('session-1') === 'all' && cat0.get('session-6') === 'all' && cat0.get('session-5') === 'done',
  'session-1=' + (cat0 && cat0.get('session-1')) + '，session-6=' + (cat0 && cat0.get('session-6')) + '，session-5=' + (cat0 && cat0.get('session-5')));

// ---------- T1/T2：轻量 tick（无分类跨界 → 只补 textContent，不重建 DOM） ----------
// 计时器口径 = ts - since：render 时 74s（01:14），tick(ts=render_ts+30s) 应本地补写为 01:44。
sandbox.tickUpdate(now + 30_000);
const tmAfter = stubOf(elapsedStubs, 'session-1');
check('T1 tick+30s：会话行计时器本地更新 01:14→01:44',
  tmAfter && tmAfter.textContent === '01:44',
  'tick 后计时器文本=' + (tmAfter || {}).textContent);
check('T1-b tick：未跨界时不重建会话列表 DOM（innerHTML 与 render 后完全一致）',
  sessionsEl.innerHTML === sessionsHtml0,
  'innerHTML 未变=' + (sessionsEl.innerHTML === sessionsHtml0));
// 状态卡 45s 边界：dsh 上次活动 = render-2s，tick(ts=render_ts+44s) 时距活动 46s →「静默」。
sandbox.tickUpdate(now + 44_000);
const dshLabel = stubOf(labelStubs, 'dsh');
check('T2 tick+44s：状态卡活动标签 活动中→静默（45s 边界，本地补写）',
  dshLabel && dshLabel.textContent === '静默',
  'tick 后 dsh 标签=' + (dshLabel || {}).textContent);

// ---------- T3：tick+2min（完成 9min→11min，跨 10min 缓冲期 → 分类跨界，必须全量重渲染） ----------
const doneBefore = countOf(getEl('sess-filter').innerHTML, '完成会话');
const sessionsHtmlBefore = sessionsEl.innerHTML;
sandbox.tickUpdate(now + 120_000);
const doneAfter = countOf(getEl('sess-filter').innerHTML, '完成会话');
const cat1 = sandbox.window.__CAT_MAP__;
check('T3 tick+2min：完成会话跨 10min 缓冲期触发全量重渲染（列表变化 + 完成档计数 +1）',
  sessionsEl.innerHTML !== sessionsHtmlBefore && doneAfter === doneBefore + 1,
  '列表 innerHTML 变化=' + (sessionsEl.innerHTML !== sessionsHtmlBefore) + '，完成档 ' + doneBefore + '→' + doneAfter);
check('T3-b tick+2min：重渲染后 __CAT_MAP__ 刷新（session-6→done）',
  !!cat1 && typeof cat1.get === 'function' && cat1.get('session-6') === 'done',
  'session-6 分类=' + (cat1 && cat1.get('session-6')));

// ---------- T4：full snapshot render 路径不受影响（服务端新快照到达 → 按快照全量渲染） ----------
const snap2 = makeSnap();
snap2.sessions = snap2.sessions.map((s) => (s.id === 'session-1' ? { ...s, elapsedMs: 134_000, since: now - 134_000 } : s));
sandbox.render(snap2);
refreshStubs();
const tm2 = stubOf(elapsedStubs, 'session-1');
check('T4 full snapshot render：按快照 elapsedMs/ts 全量渲染（计时器 02:14，标签按快照重算）',
  sessionsEl.innerHTML.includes('02:14') && !!stubOf(labelStubs, 'dsh'),
  '含 02:14=' + sessionsEl.innerHTML.includes('02:14') + '，dsh 标签=' + (stubOf(labelStubs, 'dsh') || {}).textContent);
check('T4-b full snapshot render：分类快照随 full 重建（__CAT_MAP__ 为 Map）',
  !!sandbox.window.__CAT_MAP__ && typeof sandbox.window.__CAT_MAP__.get === 'function' && sandbox.window.__CAT_MAP__.get('session-6') === 'all',
  'session-6=' + (sandbox.window.__CAT_MAP__ || new Map()).get('session-6'));

// ---------- T5：mini.html tick 计时路径（页面内按 ts 重算 elapsedMs 并重渲染） ----------
const miniHtml = fs.readFileSync(new URL('./mini.html', import.meta.url), 'utf8');
const miniScript = extractMainScript(miniHtml);
const miniHarness = createUiSandbox(miniHtml);
const miniSandbox = miniHarness.sandbox;
let esInstance = null;
miniSandbox.EventSource = function () { const o = { close() {} }; esInstance = o; return o; };   // 捕获 EventSource，供手动喂帧
vm.createContext(miniSandbox);
vm.runInContext(miniScript, miniSandbox, { filename: 'mini-inline.js' });
const mNow = Date.now();
miniSandbox.render({
  v: 1, ts: mNow, agg: 'running',
  sessions: [{ id: 's1', source: 'dsh', label: 'x', state: 'running', since: mNow - 74_000, elapsedMs: 74_000, pending: 0, kind: 'main', projectKey: 'ws-1' }],
  counters: {}, stateCounts: {}, agents: [], inputs: [], lastEvent: null, capabilities: {},
  catalog: { projects: [{ key: 'ws-1', name: 'p', cwd: '/x', sources: ['dsh'] }], history: [] },
});
const tmMini0 = miniSandbox.window.__RENDER_OUT__.tm;
esInstance.onmessage({ data: JSON.stringify({ v: 1, tick: true, ts: mNow + 30_000 }) });
const tmMini1 = miniSandbox.window.__RENDER_OUT__.tm;
check('T5 mini 条 tick 计时路径正常（本地重算并重渲染：01:14→01:44）',
  tmMini0 === '01:14' && tmMini1 === '01:44',
  'mini tm: ' + tmMini0 + ' → ' + tmMini1);

console.log('\n# 汇总：' + pass + '/' + (pass + fail) + ' 通过' + (fail ? '，' + fail + ' 失败' : ''));
if (fail) process.exit(1);
