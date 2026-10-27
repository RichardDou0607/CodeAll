#!/usr/bin/env node
/**
 * 行为回归：只拦截 fetch，不向真实 Agent 发送输入或创建会话。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { createUiSandbox, extractMainScript } from './test-ui-dom.mjs';
import { windowFixture } from './test-ui-fixture.mjs';

const html = fs.readFileSync(new URL('./window.html', import.meta.url), 'utf8');
let script = extractMainScript(html);
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
getEl('input').value = '未选目标';
getEl('input').dispatch('input');
check('未选会话时发送按钮禁用', getEl('send').disabled && getEl('target').innerHTML.includes('请先选择会话'));
getEl('input').value = '';

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

// 新建会话由 /api/new 同时创建并发送首条消息。
await getEl('new-session').dispatch('click');
check('新建对话框可打开并展示来源选择', getEl('new-dialog').open && getEl('new-source').innerHTML.includes('CODEX'));
getEl('new-source').value = 'codex';
await getEl('new-source').dispatch('change');
check('工作目录只列该 Agent 自己的项目文件夹', getEl('new-cwd').innerHTML.includes('value="/Users/demo/Desktop/agent桌宠"') && !getEl('new-cwd').innerHTML.includes('原生AI操作系统') && !getEl('new-cwd').innerHTML.includes('/tmp/x'));
// 前置步骤选中过历史会话（当前项目=ws-1）会被预选；清掉当前项目并留空，模拟“无默认可用且尚未选择”
sandbox.window.__PROJECT__ = '';
getEl('new-cwd').value = '';
const beforeCwd = requestCount();
getEl('new-model').value = 'gpt-6-astra';   // 模型必选（2026-10-08）：不填会被提交守卫拦下
await getEl('new-model').dispatch('change');
check('模型选项来自注册表，不从历史会话推导', getEl('new-model').innerHTML.includes('codex-narrow') && !getEl('new-model').innerHTML.includes('gpt-6-sol'));
check('Codex 动态思考选项包含 xhigh 和 ultra', getEl('new-reasoning').innerHTML.includes('value="xhigh"') && getEl('new-reasoning').innerHTML.includes('value="ultra"'));
getEl('new-reasoning').value = 'high';
getEl('new-first').value = '创建后回复 ok';
await getEl('new-form').dispatch('submit');
check('未选项目文件夹不能新建会话', requestCount() === beforeCwd && getEl('new-error').textContent.includes('工作目录'));
getEl('new-cwd').value = '/Users/demo/Desktop/agent桌宠';
const beforeReasoning = requestCount();
getEl('new-reasoning').value = '';
await getEl('new-form').dispatch('submit');
check('思考强度为空不能新建会话', requestCount() === beforeReasoning && getEl('new-error').textContent.includes('思考强度'));
getEl('new-reasoning').value = 'high';
getEl('new-first').value = '';
const beforeEmpty = requestCount();
await getEl('new-form').dispatch('submit');
check('空首条消息不能新建会话', requestCount() === beforeEmpty && getEl('new-error').textContent.includes('首条消息'));
getEl('new-first').value = '创建后回复 ok';
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
check('新建 CLI 会话发送来源、目录、思考强度和首条消息', lastRequest().path === '/api/state' && requests.some(r => r.path === '/api/new' && parseBody(r).source === 'codex' && parseBody(r).cwd === '/Users/demo/Desktop/agent桌宠' && parseBody(r).reasoningEffort === 'high' && parseBody(r).text === '创建后回复 ok'));

// 模型选择：CLI 源显示模型字段，所选模型随 /api/new payload 传递；ZCode 无启动参数则隐藏并提示 TUI 内切换。
await getEl('new-session').dispatch('click');
getEl('new-source').value = 'codex';
await getEl('new-source').dispatch('change');
check('CLI 新建显示模型选择字段', !getEl('new-model-field').hidden);
getEl('new-cwd').value = '/Users/demo/Desktop/agent桌宠';
getEl('new-model').value = 'gpt-6-astra';
await getEl('new-model').dispatch('change');
getEl('new-reasoning').value = 'max';
getEl('new-first').value = '第二次创建';
await getEl('new-form').dispatch('submit');
check('新建 CLI 会话携带所选模型', requests.some(r => r.path === '/api/new' && parseBody(r).model === 'gpt-6-astra'));
await getEl('new-session').dispatch('click');
getEl('new-source').value = 'zcode';
await getEl('new-source').dispatch('change');
check('ZCode 新建显示模型字段（管道按模型创建）并给 provider 边界提示', !getEl('new-model-field').hidden && !getEl('new-model-note').hidden && getEl('new-model-note').textContent.includes('管道'));

// 所有来源均走同一个新建契约，ZCode 必须携带模型和首条消息。
await getEl('new-session').dispatch('click');
getEl('new-source').value = 'zcode';
await getEl('new-source').dispatch('change');
getEl('new-cwd').value = '/Users/demo/Desktop/agent桌宠';
getEl('new-model').value = 'deepseek/deepseek-flash';
await getEl('new-model').dispatch('change');
getEl('new-reasoning').value = 'high';
getEl('new-first').value = '只回复 ok';
response = { ok: true, json: async () => { const path = lastRequest()?.path; if (path === '/api/state') return snap; return { ok: true, item: { status: 'delivered', detail: 'via codex 无头新建' } }; } };
await getEl('new-form').dispatch('submit');
check('ZCode 新建经 /api/new 携带模型、强度、目录和首条消息', requests.some(r => r.path === '/api/new' && parseBody(r).source === 'zcode' && parseBody(r).cwd === '/Users/demo/Desktop/agent桌宠' && parseBody(r).model === 'deepseek/deepseek-flash' && parseBody(r).reasoningEffort === 'high' && parseBody(r).text === '只回复 ok'));

// 当前项目的文件夹属于该 Agent 时，打开对话框即预选（其余来源切换后需重新确认）。
sandbox.window.__PROJECT__ = 'ws-1';
await getEl('new-session').dispatch('click');
check('打开时预选当前项目文件夹', getEl('new-source').value === 'claude-code' && getEl('new-cwd').value === '/Users/demo/Desktop/agent桌宠');
sandbox.window.__PROJECT__ = '';

// Source/model changes clear stale selections, even when ids/efforts overlap.
await getEl('new-session').dispatch('click');
getEl('new-source').value = 'codex';
await getEl('new-source').dispatch('change');
getEl('new-model').value = 'gpt-6-astra';
await getEl('new-model').dispatch('change');
getEl('new-reasoning').value = 'ultra';
await getEl('new-reasoning').dispatch('change');
getEl('new-model').value = 'codex-narrow';
await getEl('new-model').dispatch('change');
check('换模型后清空旧强度，仅列新模型支持的档位', getEl('new-reasoning').value === '' && !getEl('new-reasoning').innerHTML.includes('ultra') && getEl('new-reasoning').innerHTML.includes('value="high"'));
getEl('new-model').value = 'gpt-6-astra';
await getEl('new-model').dispatch('change');
getEl('new-source').value = 'claude-code';
await getEl('new-source').dispatch('change');
check('切换 Agent 后同名模型也须重新选择', getEl('new-model').value === '' && getEl('new-reasoning').value === '');
check('不可调用的模型不进下拉（hidden 直接隐藏）', getEl('new-model').innerHTML.includes('gpt-6-astra') && !getEl('new-model').innerHTML.includes('claude-opus-4-8'));
getEl('new-source').value = 'zcode';
await getEl('new-source').dispatch('change');
check('ZCode 登录态模型展示但禁用', getEl('new-model').innerHTML.includes('value="account:plan/glm" disabled'));
getEl('new-model').value = 'account:plan/glm';
getEl('new-reasoning').value = 'high';
getEl('new-first').value = 'do not create';
const beforeAccount = requestCount();
await getEl('new-form').dispatch('submit');
check('不可创建模型被前端守卫拒绝，不发送请求', requestCount() === beforeAccount && !getEl('new-error').hidden);
getEl('new-source').value = 'dsh';
await getEl('new-source').dispatch('change');
check('通道不可用时创建按钮禁用', getEl('new-submit').disabled);

// 队列按会话分组：待投递项归「新建」组、失败项归其会话组，每组带按组清空按钮。
// （DOM 沙箱 querySelectorAll 是空桩，用 innerHTML 断言）
await new Promise(r => setTimeout(r, 30));   // 等 createSession 异步链（api → refreshCatalog → render）落地
const qhtml = String(sandbox.document.getElementById('queue').innerHTML);
check('队列按会话分组渲染（两组 + 各带按组清空按钮）', (qhtml.match(/class="qgroup"/g) || []).length === 2 && (qhtml.match(/data-clear-group/g) || []).length === 2);
check('分组标题可辨（既有会话组 api-fix + 待新建组）', qhtml.includes('api-fix') && qhtml.includes('new:dsh:-'));

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
