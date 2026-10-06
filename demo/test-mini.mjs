#!/usr/bin/env node
/**
 * demo/test-mini.mjs — 迷你悬浮条渲染自检（demo/mini.html 内联脚本）
 * 覆盖：单行进度（选中会话状态/动作/计时/未决）/ agent·项目·会话三级级联切换 / 无会话回退聚合
 */
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('./mini.html', import.meta.url), 'utf8');
let script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
script = script.replace(/let es=null;[\s\S]*$/, '');

const ids = ['m-agent', 'm-proj', 'm-sess', 'm-dot', 'm-state', 'm-act', 'm-tm', 'm-pend', 'm-expand', 'bar'];
const store = new Map();
const mkEl = (id) => ({
  id, innerHTML: '', textContent: '', value: '', style: {}, disabled: false, title: '',
  addEventListener() {}, focus() {}, closest() { return null; }, getAttribute() { return null; },
});
const getEl = (id) => { if (!store.has(id)) store.set(id, mkEl(id)); return store.get(id); };
const sandbox = {
  document: { getElementById: (id) => { if (!ids.includes(id)) throw new Error('未知元素 ' + id); return getEl(id); }, addEventListener() {} },
  window: {}, console, JSON, Math, String, Number, Array, Object, Date, RegExp, setTimeout,
  navigator: {},
  location: { href: '' },
};
vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'mini-inline.js' });

const now = Date.now();
const snap = {
  v: 1, ts: now, agg: 'working',
  sessions: [
    { id: 'session-1', source: 'dsh', label: 'agent桌宠', title: 'agent桌宠', state: 'running', activity: '运行命令', elapsedMs: 74000, pending: 0, model: 'deepseek-flash', kind: 'main', projectKey: 'ws-1' },
    { id: 'session-2', source: 'claude-code', label: 'api-fix', title: 'api-fix', state: 'thinking', activity: '思考中', elapsedMs: 12000, pending: 0, model: 'glm-5.3', kind: 'main', projectKey: 'ws-1' },
    { id: 'session-3', source: 'codex', label: 'docs', title: 'docs', state: 'waiting', activity: '等待你批准', elapsedMs: 4000, pending: 2, model: 'gpt-6-sol', kind: 'main', projectKey: 'ws-2' },
  ],
  counters: { thinking: 1, running: 1 },
  agents: [],
  inputs: [],
  lastEvent: { type: 'tool.call', ts: now },
  capabilities: {},
  catalog: {
    projects: [
      { key: 'ws-1', name: 'agent桌宠', cwd: '/a/agent桌宠', sessionCount: 9, liveCount: 2, sources: ['dsh', 'claude-code'] },
      { key: 'ws-2', name: '原生AI操作系统', cwd: '/a/原生AIOS', sessionCount: 4, liveCount: 1, sources: ['dsh', 'codex'] },
    ],
    history: [
      { sessionId: 'hist-km', title: '前端重设计', state: 'idle', source: 'kimi-code', model: 'k3', updatedAt: now - 3600000, kind: 'main', projectKey: '__none__' },
      { sessionId: 'hist-cc', title: '修复 fixture', state: 'done', source: 'claude-code', model: 'glm-5.3', updatedAt: now - 5400000, kind: 'main', projectKey: 'ws-1' },
    ],
  },
};

// 场景一：默认（全部）→ 自动选第一个实时会话（session-1, DSH）
const out1 = sandbox.render(snap);
const agOpts = getEl('m-agent').innerHTML;
const pjOpts = getEl('m-proj').innerHTML;
const ssOpts = getEl('m-sess').innerHTML;
// 场景二：切 CODEX → 只剩 session-3（waiting · ⏳2 · gpt-6-sol）
sandbox.window.__AGENT__ = 'codex';
sandbox.render(snap);
const out2 = sandbox.window.__RENDER_OUT__;
sandbox.window.__AGENT__ = '';
// 场景三：选 KIMI（无实时会话）→ 回退聚合显示
sandbox.window.__AGENT__ = 'kimi-code';
sandbox.render(snap);
const out3 = sandbox.window.__RENDER_OUT__;
const act3 = getEl('m-act').textContent;
sandbox.window.__AGENT__ = '';
// 场景四：手动选中 session-3
sandbox.window.__MINI_SESS__ = 'session-3';
sandbox.render(snap);
const out4 = sandbox.window.__RENDER_OUT__;
const pend4 = getEl('m-pend').textContent;
const tm4 = getEl('m-tm').textContent;
sandbox.window.__MINI_SESS__ = '';

const checks = [
  ['agent 下拉 5 档（全部/DSH/CLAUDE/CODEX/KIMI）', (agOpts.match(/<option/g) || []).length === 5 && agOpts.includes('CODEX')],
  ['项目下拉 = 全部 + 2 项目（带进行中标记）', (pjOpts.match(/<option/g) || []).length === 3 && pjOpts.includes('agent桌宠') && pjOpts.includes('●2')],
  ['会话下拉：实时优先带 ●，历史殿后，来源可辨', ssOpts.includes('●') && ssOpts.includes('CLAUDE') && ssOpts.includes('修复 fixture')],
  ['默认自动选中第一个实时会话（DSH 运行中）', out1.state === '运行中' && out1.act.includes('deepseek-flash') && out1.tm === '01:14' && out1.selSource === 'DSH'],
  ['切 CODEX → 仅剩 codex 会话（waiting + gpt-6-sol）', out2.selSource === 'CODEX' && out2.state === '等你' && out2.act.includes('gpt-6-sol')],
  ['切 KIMI（无实时）→ 回退聚合行 + 历史可选', out3.state === '工作中' && act3.includes('无实时会话') && out3.sessOpts >= 1],
  ['选中 waiting 会话 → ⏳ 未决计数与计时', out4.state === '等你' && pend4 === '⏳2' && tm4 === '00:04'],
  ['展开按钮存在且可交互（切 App 界面）', typeof getEl('m-expand').onclick === 'function'],
  ['状态点/文字联动颜色', getEl('m-state').style.color !== undefined],
];
let ok = true;
for (const [name, pass] of checks) { console.log((pass ? '✅ ' : '❌ ') + name); if (!pass) ok = false; }
console.log('\n场景输出：\n  默认: ' + JSON.stringify(out1) + '\n  CODEX: ' + JSON.stringify(out2) + '\n  KIMI: ' + JSON.stringify(out3) + '\n  session-3: ' + JSON.stringify(out4));
process.exit(ok ? 0 : 1);
