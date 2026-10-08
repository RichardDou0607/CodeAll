#!/usr/bin/env node
/**
 * 行为回归：只拦截 fetch，不向真实 Agent 发送输入或创建会话。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { createUiSandbox } from './test-ui-dom.mjs';
import { windowFixture } from './test-ui-fixture.mjs';

const html = fs.readFileSync(new URL('./window.html', import.meta.url), 'utf8');
let script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
script = script.replace(/let es=null;[\s\S]*$/, '');

const { sandbox, getEl, element, preferences, requests, themes, media } = createUiSandbox(html);
vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'window-actions-inline.js' });

const snap = windowFixture();
const waitTurn = () => new Promise(resolve => setImmediate(resolve));
let response = { ok: true, json: async () => ({ ok: true, item: {} }) };
sandbox.fetch = async (path, options) => {
  requests.push({ path, ...options });
  return response;
};

const requestCount = () => requests.length;
const lastRequest = () => requests[requests.length - 1];
const parseBody = req => req && req.body ? JSON.parse(req.body) : undefined;
const checks = [];
const check = (name, pass) => checks.push([name, !!pass]);

sandbox.window.__SHOW_HISTORY__ = true;
sandbox.render(snap);

// 选择历史会话只是改变投递目标，不会调用打开接口。
const historyRow = element('history-row', { 'data-session': 'hist-1' });
await getEl('sessions').dispatch('click', { target: historyRow });
check('点击历史会话只选择目标，不自动打开', sandbox.window.__TARGET__ === 'hist-1' && requestCount() === 0);

// 筛选隐藏目标时仍保留原目标，定位操作只调整视图。
sandbox.window.__TARGET__ = 'session-2';
sandbox.window.__FILTER__ = 'done';
sandbox.render(snap);
check('筛选隐藏目标时显示警告且目标不被重置', !getEl('target-warning').hidden && sandbox.window.__TARGET__ === 'session-2');
await getEl('locate-target').dispatch('click');
check('定位目标恢复会话视图并保留目标', sandbox.window.__TARGET__ === 'session-2' && sandbox.window.__FILTER__ === 'all');

// CLI 会话有打开能力，DSH 在没有插件时不应发起假请求。
await getEl('sessions').dispatch('click', { target: element('open-cli', { 'data-open': 'session-2' }) });
await waitTurn();
check('打开 CLI 会话使用原有 /api/open 合约', lastRequest()?.path === '/api/open' && parseBody(lastRequest()).sessionId === 'session-2');
const beforeDshOpen = requestCount();
await getEl('sessions').dispatch('click', { target: element('open-dsh', { 'data-open': 'session-1' }) });
await waitTurn();
check('DSH 未挂插件时不会误调用打开接口', requestCount() === beforeDshOpen);

// 服务拒绝发送时恢复编辑框内容，并继续携带当前目标。
getEl('input').value = '请保留这段草稿';
response = { ok: true, json: async () => ({ ok: false, detail: '模拟拒绝' }) };
await sandbox.send();
check('投递被拒绝时恢复草稿和目标', getEl('input').value === '请保留这段草稿' && parseBody(lastRequest()).sessionId === 'session-2');

// IME 组合输入按 Enter 不应发送；普通 Enter 才发送。
getEl('input').value = '组合输入';
const beforeIme = requestCount();
await getEl('input').dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: true });
check('IME 组合输入期间 Enter 不发送', requestCount() === beforeIme);
response = { ok: true, json: async () => ({ ok: true, item: {} }) };
await getEl('input').dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: false });
await waitTurn();
check('普通 Enter 发送消息', requestCount() === beforeIme + 1 && parseBody(lastRequest()).sessionId === 'session-2');

// 队列重发只使用队列项的原接口和原 id，不读取当前自动目标。
sandbox.render(snap);
const beforeResend = requestCount();
await getEl('queue').dispatch('click', { target: element('resend', { 'data-resend': 'in-q' }) });
check('队列重发沿用原队列项目标', requestCount() === beforeResend + 1 && lastRequest().path === '/api/input/in-q/resend' && parseBody(lastRequest())?.sessionId === undefined);
check('队列操作不改变当前投递目标', sandbox.window.__TARGET__ === 'session-2');

// 新建会话按能力位展示通道，并沿用后端 /api/new payload。
await getEl('new-session').dispatch('click');
check('新建对话框可打开并展示来源选择', getEl('new-dialog').open && getEl('new-source').innerHTML.includes('CODEX'));
getEl('new-source').value = 'codex';
await getEl('new-source').dispatch('change');
getEl('new-cwd').value = '/tmp/agentpet-action-test';
response = {
  ok: true,
  json: async () => {
    const path = lastRequest()?.path;
    if (path === '/api/new') return { ok: true, via: 'terminal' };
    if (path === '/api/state') return snap;
    return { ok: true };
  },
};
await getEl('new-form').dispatch('submit');
check('新建 CLI 会话发送来源和目录字段', lastRequest().path === '/api/state' && requests.some(r => r.path === '/api/new' && parseBody(r).source === 'codex' && parseBody(r).cwd === '/tmp/agentpet-action-test'));

// 主题选择持久化，并能响应系统主题变化。
await themes[1].dispatch('click');
check('亮色主题切换并持久化', preferences.get('agent-pet-theme') === 'light' && sandbox.document.documentElement.dataset.theme === 'light');
await themes[2].dispatch('click');
media.matches = true;
await media.dispatch('change');
check('跟随系统主题响应系统亮色变化', preferences.get('agent-pet-theme') === 'system' && sandbox.document.documentElement.dataset.theme === 'light');

let ok = true;
for (const [name, pass] of checks) {
  console.log((pass ? '✅ ' : '❌ ') + name);
  if (!pass) ok = false;
}
console.log(`\n行为回归：${checks.filter(([, pass]) => pass).length}/${checks.length} 通过`);
process.exit(ok ? 0 : 1);
