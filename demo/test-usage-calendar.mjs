#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { createUiSandbox } from './test-ui-dom.mjs';
import { windowFixture } from './test-ui-fixture.mjs';

const html = fs.readFileSync(new URL('./window.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/let es=null;[\s\S]*$/, '');
const now = new Date(2026, 9, 8, 14).getTime();
const sourceNames = ['dsh', 'claude-code', 'codex', 'kimi-code', 'zcode'];
const tick = () => new Promise(resolve => setImmediate(resolve));
const payload = () => ({
  generatedAt: now, timeZone: 'Asia/Shanghai',
  sources: Object.fromEntries(sourceNames.map(source => [source, {
    available: true, partial: false, dayApproximate: source === 'codex',
    days: source === 'claude-code' ? {
      20261001: { tokens: 1200, input: 1000, output: 200, toolCalls: 5, mcpCalls: 2, requests: 2 },
      20261008: { tokens: 800, input: 500, output: 300, toolCalls: 4, mcpCalls: 1, requests: 1 },
    } : source === 'codex' ? {
      20261008: { tokens: 2000, input: 1900, output: 100, toolCalls: 6, mcpCalls: 3, requests: 1 },
    } : source === 'kimi-code' ? {
      20261007: { tokens: 0, toolCalls: 3, mcpCalls: 1, requests: 0 },
    } : {},
  }])),
});
function setup(data = payload()) {
  const harness = createUiSandbox(html), { sandbox, getEl, element, requests } = harness;
  let response = data;
  sandbox.fetch = async (path, options) => {
    requests.push({ path, ...options });
    if (response instanceof Error) throw response;
    return { ok: true, json: async () => response };
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  const snap = windowFixture();
  snap.ts = now; snap.usage.generatedAt = now;
  const click = async (attr, value = '') => {
    await getEl('usage-body').dispatch('click', { target: element('', { [attr]: value }) });
    await tick();
  };
  return {
    ...harness, snap, click,
    text: () => getEl('usage-body').innerHTML,
    setResponse: value => { response = value; },
    async open() { sandbox.render(snap); await getEl('view-usage').dispatch('click'); await tick(); },
  };
}

test('Lazy load once; month totals, tools-only days, exact day details and existing summaries', async () => {
  const h = setup(), { sandbox, snap, requests, getEl } = h;
  sandbox.render(snap);
  assert.equal(requests.length, 0);
  await h.open();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/usage/calendar');
  assert.equal(requests[0].method, 'GET');
  assert.match(h.text(), /data-month-total="tokens" title="≈4,000">≈4k/);
  assert.match(h.text(), /data-month-total="toolCalls" title="18">18/);
  assert.match(h.text(), /data-month-total="mcpCalls" title="7">7/);
  assert.match(h.text(), /uc-detail-value">≈2,800/);
  assert.match(h.text(), /各 Agent 消耗量/);
  assert.equal((h.text().match(/data-calendar-day=/g) || []).length, 31);
  assert.equal((h.text().match(/class="uc-blank"/g) || []).length, 11);
  assert.match(h.text(), /data-calendar-day="20261009"[^>]+disabled/);
  assert.match(h.text(), /data-calendar-next[^>]+disabled/);
  assert.match(h.text(), /data-calendar-day="20261008"[^>]+aria-current="date"/);
  let writes = 0, value = getEl('usage-body').innerHTML;
  Object.defineProperty(getEl('usage-body'), 'innerHTML', { configurable: true, get: () => value, set: v => { value = v; writes++; } });
  sandbox.render({ ...snap, ts: now + 2000 });
  await tick();
  assert.equal(requests.length, 1);
  assert.equal(writes, 0);
  await h.click('data-calendar-metric', 'toolCalls');
  await h.click('data-calendar-day', '20261007');
  assert.match(h.text(), /uc-detail-value">3/);
  assert.match(h.text(), /Kimi Code/);
  await h.click('data-urange', 'today');
  assert.equal(sandbox.window.__USAGE_CALENDAR_DAY__, 20261007);
  assert.match(h.text(), /in 5.0M/);
});

test('Source filter does not affect sessions; selection and focus survive new snapshots', async () => {
  const h = setup(), { sandbox, getEl, element, snap, requests } = h;
  await h.open();
  const select = element('', { 'data-calendar-source': '', 'data-calendar-focus': 'source' });
  select.value = 'claude-code';
  await getEl('usage-body').dispatch('change', { target: select });
  assert.equal(sandbox.window.__AGENT__, undefined);
  assert.match(h.text(), /data-month-total="tokens" title="2,000">2k/);
  assert.doesNotMatch(h.text(), /Codex 每日 Token/);
  await h.click('data-calendar-day', '20261001');
  let focused = 0;
  const focusNode = element('', { 'data-calendar-focus': '20261001' });
  focusNode.focus = () => focused++;
  sandbox.document.activeElement = focusNode;
  getEl('usage-body').querySelectorAll = () => [focusNode];
  const updated = payload(); updated.generatedAt = now + 60000;
  h.setResponse(updated);
  sandbox.render({ ...snap, usage: { ...snap.usage, generatedAt: updated.generatedAt } });
  await tick();
  assert.equal(requests.length, 2);
  assert.equal(sandbox.window.__USAGE_CALENDAR_DAY__, 20261001);
  assert.equal(sandbox.window.__USAGE_CALENDAR_SOURCE__, 'claude-code');
  assert.ok(focused > 0);
  assert.equal(sandbox.window.__USAGE_CALENDAR_FOCUS__, '');
});

test('Month navigation, leap day, year boundary, today, and keyboard navigation', async () => {
  const h = setup(), { sandbox, getEl, element } = h;
  await h.open();
  await h.click('data-calendar-prev');
  assert.equal(sandbox.window.__USAGE_CALENDAR_MONTH__, '2026-09');
  assert.equal((h.text().match(/data-calendar-day=/g) || []).length, 30);
  await h.click('data-calendar-next');
  assert.equal(sandbox.window.__USAGE_CALENDAR_MONTH__, '2026-10');
  await h.click('data-calendar-next');
  assert.equal(sandbox.window.__USAGE_CALENDAR_MONTH__, '2026-10');
  sandbox.selectCalendarDate(new Date(2024, 1, 29));
  assert.equal((h.text().match(/data-calendar-day=/g) || []).length, 29);
  await getEl('usage-body').dispatch('keydown', { key: 'ArrowRight', target: element('', { 'data-calendar-day': '20240229' }) });
  assert.equal(sandbox.window.__USAGE_CALENDAR_DAY__, 20240301);
  await getEl('usage-body').dispatch('keydown', { key: 'PageUp', target: element('', { 'data-calendar-day': '20240331' }) });
  assert.equal(sandbox.window.__USAGE_CALENDAR_DAY__, 20240229);
  sandbox.selectCalendarDate(new Date(2026, 0, 1));
  await h.click('data-calendar-prev');
  assert.equal(sandbox.window.__USAGE_CALENDAR_MONTH__, '2025-12');
  await h.click('data-calendar-today');
  assert.equal(sandbox.window.__USAGE_CALENDAR_DAY__, 20261008);
  await getEl('usage-body').dispatch('keydown', { key: 'ArrowRight', target: element('', { 'data-calendar-day': '20261008' }) });
  assert.equal(sandbox.window.__USAGE_CALENDAR_DAY__, 20261008);
  assert.equal(sandbox.calendarParts('2026-13'), null);
});

test('Unavailable and partial sources are explicit, never silently replaced by all sources', async () => {
  const data = payload();
  data.sources.codex.available = false;
  data.sources['kimi-code'].partial = true;
  const h = setup(data), { sandbox, getEl, element } = h;
  await h.open();
  assert.match(h.text(), /来源不可用：Codex/);
  assert.match(h.text(), /部分数据：Kimi Code/);
  assert.match(h.text(), /本月 Token · 已记录/);
  const select = element('', { 'data-calendar-source': '' }); select.value = 'codex';
  await getEl('usage-body').dispatch('change', { target: select });
  assert.match(h.text(), /没有可用的日历数据/);
  assert.doesNotMatch(h.text(), /data-calendar-day=/);
  select.value = 'kimi-code';
  await getEl('usage-body').dispatch('change', { target: select });
  await h.click('data-calendar-day', '20261006');
  assert.match(h.text(), /uc-detail-value">—/);
  assert.equal(sandbox.window.__USAGE_CALENDAR_SOURCE__, 'kimi-code');
});

test('Loading, pending scan, network error, bounded retry and retained stale data', async () => {
  const h = setup({ pending: true }), { sandbox, snap, requests } = h;
  await h.open();
  assert.match(h.text(), /扫描完成后/);
  sandbox.render(snap);
  await tick();
  assert.equal(requests.length, 1);
  h.setResponse(payload());
  sandbox.window.__USAGE_CALENDAR_STATE__.retryAt = 0;
  sandbox.render(snap);
  await tick();
  assert.equal(requests.length, 2);
  assert.match(h.text(), /data-calendar-day=/);
  h.setResponse(new Error('<offline>'));
  await sandbox.loadUsageCalendar(true);
  assert.match(h.text(), /保留上次数据：&lt;offline&gt;/);
  assert.match(h.text(), /data-calendar-day=/);
  const before = requests.length;
  sandbox.render(snap); sandbox.render(snap);
  await tick();
  assert.equal(requests.length, before);
  h.setResponse(payload());
  await h.click('data-calendar-retry');
  assert.doesNotMatch(h.text(), /保留上次数据/);
  const fresh = setup(new Error('unreachable'));
  await fresh.open();
  assert.match(fresh.text(), /日历读取失败/);
  assert.match(fresh.text(), /data-calendar-retry/);
});

test('Invalid responses do not become zero-usage calendars, in-flight reads are deduplicated', async () => {
  const h = setup({ ok: true });
  await h.open();
  assert.match(h.text(), /日历数据格式不正确/);
  const { sandbox, getEl } = setup();
  let resolve;
  sandbox.fetch = () => new Promise(r => { resolve = r; });
  const snap = windowFixture(); snap.ts = now; snap.usage.generatedAt = now;
  sandbox.render(snap);
  await getEl('view-usage').dispatch('click');
  assert.match(getEl('usage-body').innerHTML, /正在读取每日用量/);
  const state = sandbox.window.__USAGE_CALENDAR_STATE__;
  sandbox.render(snap);
  assert.equal(sandbox.window.__USAGE_CALENDAR_STATE__, state);
  resolve({ ok: true, json: async () => payload() });
  await tick();
  assert.match(getEl('usage-body').innerHTML, /data-calendar-day=/);
});
