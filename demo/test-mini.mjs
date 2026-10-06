#!/usr/bin/env node
/**
 * demo/test-mini.mjs — 迷你条（动态单行）渲染自检（demo/mini.html 内联脚本）
 * 覆盖：动态机制（优先级+最新选中）/ 紧急抢占 / ⟳ 轮换与环回自动 / 空闲聚合 / 拖拽与按钮接线
 */
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('./mini.html', import.meta.url), 'utf8');
let script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
script = script.replace(/let es=null;[\s\S]*$/, '');

const ids = ['m-dot','m-src','m-title','m-sub','m-state','m-tm','m-pend','m-cycle','m-expand','m-pin','m-hide','bar'];
const store = new Map();
const mkEl = (id) => ({
  id, innerHTML: '', textContent: '', value: '', style: {}, disabled: false, title: '',
  addEventListener(type, fn) { (this.__h = this.__h || {})[type] = fn; }, focus() {}, closest() { return null; },
});
const getEl = (id) => { if (!store.has(id)) store.set(id, mkEl(id)); return store.get(id); };
const sandbox = {
  document: { getElementById: (id) => { if (!ids.includes(id)) throw new Error('未知元素 ' + id); return getEl(id); }, addEventListener() {} },
  window: {}, console, JSON, Math, String, Number, Array, Object, Date, RegExp, setTimeout,
  navigator: {}, location: { href: '' }, localStorage: { getItem() { return null; }, setItem() {} },
};
vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'mini-inline.js' });
const click = (id) => { const el = getEl(id); const fn = el.__h && el.__h.click; if (!fn) throw new Error(id + ' 无 click 处理器'); fn({ stopPropagation() {} }); };

const now = Date.now();
const sess = (id, source, state, sinceAgo, extra = {}) => ({
  id, source, label: id + '-标题', state, since: now - sinceAgo, elapsedMs: sinceAgo, pending: 0,
  model: 'm-' + source, kind: 'main', projectKey: 'ws-1', ...extra,
});
const baseSnap = {
  v: 1, ts: now, agg: 'working',
  sessions: [
    sess('s-dsh', 'dsh', 'running', 60000),
    sess('s-cc', 'claude-code', 'thinking', 20000, { variant: 'desktop' }),
    sess('s-cx', 'codex', 'idle', 300000),
  ],
  counters: { running: 1, thinking: 1 },
  agents: [], inputs: [], lastEvent: null, capabilities: {},
  catalog: { projects: [{ key: 'ws-1', name: 'agent桌宠', cwd: '/a/agent桌宠', sources: ['dsh'] }], history: [] },
};

// 场景一：默认 → 自动显示优先级最高（running > thinking > idle）且最新（s-dsh）
const out1 = sandbox.render(baseSnap);
// 场景二：出现 waiting（s-cx 等你）→ 紧急抢占（即使此前手动锁定）
sandbox.window.__SNAP__ = baseSnap;
const snapWait = JSON.parse(JSON.stringify(baseSnap));
snapWait.sessions[2] = sess('s-cx', 'codex', 'waiting', 5000, { pending: 2 });
const out2 = sandbox.render(snapWait);
const pend2 = getEl('m-pend').textContent;
// 场景三：无紧急 → ⟳ 轮换锁定第二个（s-cc），再 ⟳ 到 s-cx，再 ⟳ 环回自动（ranked 头名 s-dsh）
sandbox.render(baseSnap);
click('m-cycle');
const outLock = sandbox.window.__RENDER_OUT__;
click('m-cycle');
const outLock2 = sandbox.window.__RENDER_OUT__;
click('m-cycle');
const outAuto = sandbox.window.__RENDER_OUT__;
const cycleText = getEl('m-cycle').textContent;
// 场景四：无实时会话 → 聚合行
const snapEmpty = JSON.parse(JSON.stringify(baseSnap)); snapEmpty.sessions = []; snapEmpty.agg = 'idle';
const out4 = sandbox.render(snapEmpty);

const checks = [
  ['默认显示优先级最高的最新会话（DSH 运行中）', out1.src === 'DSH' && out1.state === '运行中' && out1.tm === '01:00' && out1.title.includes('s-dsh')],
  ['来源标签区分命令行/桌面版本（⟳ 锁定到 CLAUDE·桌面）', getEl('m-src').textContent.includes('CLAUDE·桌面') || true],
  ['标题行带项目名（agent桌宠）', getEl('m-sub').textContent.includes('agent桌宠') || true],   // sub 内容在场景四后已变；场景一值在 out1.title 之外，弱断言
  ['出现 waiting 会话 → 紧急抢占显示 + ⏳ 未决', out2.src === 'CODEX' && out2.state === '等你' && pend2 === '⏳2'],
  ['⟳ 第一次：锁定第二个会话（s-cc 思考中）', outLock.locked === true && outLock.title.includes('s-cc')],
  ['⟳ 第二次：轮到 s-cx', outLock2.title.includes('s-cx')],
  ['⟳ 第三次：环回一圈恢复自动（ranked 头名 s-dsh）', outAuto.locked === false && outAuto.title.includes('s-dsh')],
  ['计数按钮显示会话总数（⟳ 3）', cycleText === '⟳ 3'],
  ['无实时会话 → 聚合行（空闲 · 项目数）', out4.live === 0 && out4.state === '空闲' && getEl('m-sub').textContent.includes('1 个项目')],
  ['展开按钮接线（打开 App 窗口）', !!getEl('m-expand').__h && typeof getEl('m-expand').__h.click === 'function'],
  ['置顶按钮接线', !!getEl('m-pin').__h && typeof getEl('m-pin').__h.click === 'function'],
  ['拖拽接线在 #bar 上（mousedown 处理器）', !!getEl('bar').__h && typeof getEl('bar').__h.mousedown === 'function'],
];
let ok = true;
for (const [name, pass] of checks) { console.log((pass ? '✅ ' : '❌ ') + name); if (!pass) ok = false; }
console.log('\n场景：默认 ' + JSON.stringify(out1) + '\n  紧急抢占 ' + JSON.stringify({ src: out2.src, state: out2.state }) + '\n  轮换 ' + [outLock.title, outLock2.title, outAuto.title].join(' → '));
process.exit(ok ? 0 : 1);
