#!/usr/bin/env node
/**
 * demo/test-window.mjs — 用最小 DOM 桩验证悬浮窗渲染逻辑（demo/window.html 内联脚本）
 * 覆盖：状态行 / Agent 软件名+模型+思考程度 / 项目切换器 / 历史会话 / 输入队列 / 能力位降级
 */
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('./window.html', import.meta.url), 'utf8');
let script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
script = script.replace(/let es=null;[\s\S]*$/, ''); // 去掉自动连接

const ids = ['agg-dot','agg-text','chips','sessions','hint','queue','note','input','send','open-dsh','hide-win','win','project','new-session','toggle-history','toggle-agents','target','agents'];
const store = new Map();
const mkEl = (id) => ({
  id, innerHTML: '', textContent: '', value: '', style: {}, disabled: false, title: '',
  addEventListener() {}, focus() {}, closest() { return null; },
});
const getEl = (id) => { if (!store.has(id)) store.set(id, mkEl(id)); return store.get(id); };
const makeSandbox = () => ({
  document: { getElementById: (id) => { if (!ids.includes(id)) throw new Error('未知元素 ' + id); return getEl(id); }, addEventListener() {} },
  window: {}, console, JSON, Math, String, Number, Array, Object, Date, RegExp, setTimeout,
  navigator: { clipboard: { writeText() {} } },
  fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, item: {} }) }),
  EventSource: function () { return { onmessage: null, onerror: null, close() {} }; },
  location: { href: '' },
});
const sandbox = makeSandbox();
vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'window-inline.js' });

// token 注入回归：按服务端同样的替换规则改写脚本后必须仍可执行
// （2026-10-05 实测踩坑：曾把 window.__PET_TOKEN__ 的属性名替换成 hex，整页 SyntaxError → 「未连接」）
let injectedOk = false, injectedErr = '';
try {
  const sandbox2 = makeSandbox();
  vm.createContext(sandbox2);
  vm.runInContext(script.replace("'__PET_TOKEN_VALUE__'", '"tok-test"'), sandbox2, { filename: 'window-inline-injected.js' });
  injectedOk = typeof sandbox2.render === 'function';
} catch (e) { injectedErr = String((e && e.message) || e); }

const now = Date.now();
const snap = {
  v: 1, ts: now, agg: 'waiting',
  sessions: [
    { id: 'session-1', source: 'dsh', label: 'agent桌宠', state: 'running', activity: '运行命令', elapsedMs: 74000, pending: 0, agentName: 'DSH', model: 'deepseek-flash', reasoningEffort: 'max', agentPreset: 'ptc', kind: 'main', projectKey: 'ws-1' },
    { id: 'session-2', source: 'claude-code', label: 'api-fix', state: 'thinking', activity: '思考中', elapsedMs: 12000, pending: 0, agentName: 'Claude Code', model: 'claude-sonnet-4', reasoningEffort: 'high', kind: 'main', projectKey: 'ws-1' },
    { id: 'session-3', source: 'codex', label: 'docs', state: 'waiting', activity: '等待你批准', elapsedMs: 4000, pending: 2, agentName: 'Codex', model: 'gpt-5-codex', reasoningEffort: 'medium', kind: 'main', projectKey: 'ws-1' },
    { id: 'session-4', source: 'cursor', label: 'web-ui', state: 'error', activity: '连接错误', elapsedMs: 2000, pending: 0, agentName: 'Cursor', model: 'auto', reasoningEffort: 'auto', kind: 'main', projectKey: 'ws-2' },
    { id: 'session-5', source: 'aider', label: 'lint', state: 'done', activity: '已完成', elapsedMs: 1000, pending: 0, agentName: 'Aider', model: 'deepseek-v4-pro', reasoningEffort: 'high', kind: 'main', projectKey: 'ws-2' },
    { id: 'session-sub', source: 'dsh', label: 'T13 Tauri 悬浮窗外壳', state: 'running', activity: '运行命令', elapsedMs: 500, pending: 0, agentName: 'DSH', model: 'deepseek-flash', reasoningEffort: 'max', kind: 'subagent', projectKey: 'ws-1' },
  ],
  counters: { thinking: 1, running: 1, errors: 1, done: 1 },
  agents: [
    { id: 'dsh', name: 'DeepSeek Harness', status: 'connected', installed: true, running: true, connected: true, connectionKind: 'plugin', processes: 3, lastActivityMs: now - 2000, version: '0.2.0-rc.2', evidence: ['/Applications/DeepSeek Harness.app'] },
    { id: 'claude-code', name: 'Claude Code', status: 'connected', installed: true, running: true, connected: true, connectionKind: 'log', processes: 1, lastActivityMs: now - 9000, version: '2.1.278', evidence: ['~/.claude'] },
    { id: 'codex', name: 'Codex', status: 'open-unconnected', installed: true, running: true, connected: false, connectionKind: null, processes: 1, lastActivityMs: now - 400000, version: null, evidence: ['~/.codex'], note: '含 Codex++ 桌面壳' },
    { id: 'kimi-code', name: 'Kimi Code', status: 'closed', installed: true, running: false, connected: false, connectionKind: null, processes: 0, lastActivityMs: now - 7200000, version: '1.0.4', sessionCount: 9, evidence: ['/Applications/Kimi Code.app'] },
    { id: 'agentos', name: 'AgentOS M1', status: 'closed', installed: true, running: false, connected: false, connectionKind: null, processes: 0, lastActivityMs: null, version: null, evidence: ['~/.local/bin/agent'] },
    { id: 'opencode', name: 'OpenCode', status: 'not-installed', installed: false, running: false, connected: false, connectionKind: null, processes: 0, lastActivityMs: null, version: null, evidence: [] },
  ],
  inputs: [{ id: 'in-1', text: '把进度总结成三行', status: 'queued', at: now }],
  inputChannel: { mode: 'manual' },
  lastEvent: { type: 'tool.call', ts: now, sessionId: 'session-1' },
  capabilities: { canCatalog: true, canOpen: false, canCreate: false },
  catalog: {
    elapsedMs: 19,
    projects: [
      { projectId: 'ws-1', key: 'ws-1', name: 'agent桌宠', cwd: '/Users/demo/Desktop/agent桌宠', sessionCount: 9, mainCount: 1, liveCount: 3 },
      { projectId: 'ws-2', key: 'ws-2', name: '原生AI操作系统', cwd: '/Users/demo/Desktop/原生AI操作系统', sessionCount: 4, mainCount: 4, liveCount: 0 },
      { projectId: '__none__', key: '__none__', name: '未归入项目', cwd: null, sessionCount: 2, mainCount: 2, liveCount: 0, unregistered: true },
    ],
    history: [
      { sessionId: 'hist-1', title: '创建一个HTML，内容是SVG绘制一', state: 'done', agentName: 'DSH', model: 'deepseek-v4-pro', reasoningEffort: 'high', updatedAt: now - 86400000, kind: 'main', projectKey: 'ws-1' },
      { sessionId: 'hist-sub', title: 'T13 Tauri 悬浮窗外壳', state: 'idle', agentName: 'DSH', model: 'deepseek-flash', reasoningEffort: 'max', updatedAt: now - 3600000, kind: 'subagent', projectKey: 'ws-1' },
      { sessionId: 'hist-none', title: 'cwd-only 旧会话', state: 'idle', agentName: 'DSH', model: null, reasoningEffort: null, updatedAt: now - 7200000, kind: 'main', projectKey: '__none__' },
      { sessionId: 'hist-cc', title: '修复 session-replay fixture', state: 'done', source: 'claude-code', agentName: 'Claude Code', model: 'glm-5.3', updatedAt: now - 5400000, kind: 'main', projectKey: 'ws-1' },
      { sessionId: 'hist-cx', title: 'SVG鹈鹕骑自行车动画', state: 'done', source: 'codex', agentName: 'Codex', model: 'gpt-6-sol', updatedAt: now - 6600000, kind: 'main', projectKey: 'ws-2' },
    ],
  },
};
sandbox.window.__SHOW_HISTORY__ = true;
const out = sandbox.render(snap);
const rows = getEl('sessions').innerHTML;
// 场景二a：选中 claude-code 会话为投递目标 → 行高亮 + 目标行黄色警示（M-D 未落地，不静默）
sandbox.window.__TARGET__ = 'session-2';
sandbox.render(snap);
const rowsSel = getEl('sessions').innerHTML;
const targetSel = getEl('target').innerHTML;
const targetSelColor = getEl('target').style.color;
// 场景二b：选中 DSH 会话为投递目标 → 正常目标行（点击恢复自动）
sandbox.window.__TARGET__ = 'session-1';
sandbox.render(snap);
const targetDsh = getEl('target').innerHTML;
// 场景三：目标已不在列表（陈旧目标）→ 自动回到「自动」
sandbox.window.__TARGET__ = 'session-gone';
sandbox.render(snap);
const targetReset = getEl('target').innerHTML;
// 场景四：按 projectKey 选中项目 → 只显示该项目的实时/历史行（曾按 label===项目名 过滤致实时行全消失）
sandbox.window.__TARGET__ = '';
sandbox.window.__PROJECT__ = 'ws-1';
sandbox.render(snap);
const rowsProj = getEl('sessions').innerHTML;
const projLiveIds = (rowsProj.match(/data-session="([^"]+)"/g) || []).map(x => x.slice(14, -1));
sandbox.window.__PROJECT__ = '';
sandbox.render(snap);
// 场景五：软件状态面板折叠（__SHOW_AGENTS__=false）→ 空内容 + hidden 类
const agentsHtml = getEl('agents').innerHTML;
const agentsOpen = getEl('agents').className;
sandbox.window.__SHOW_AGENTS__ = false;
sandbox.render(snap);
const agentsHiddenHtml = getEl('agents').innerHTML;
const agentsHiddenCls = getEl('agents').className;
sandbox.window.__SHOW_AGENTS__ = true;
sandbox.render(snap);
// 场景六：旧快照无 agents 字段 → 占位文案，不报错
sandbox.render(Object.assign({}, snap, { agents: undefined }));
const agentsMissing = getEl('agents').innerHTML;
sandbox.render(snap);
const checks = [
  ['渲染 5 个实时会话行 + 4 个历史会话行（含多源/未注册组）', (rows.match(/class="srow"/g) || []).length === 5 && (rows.match(/class="srow hist"/g) || []).length === 4],
  ['子代理实时会话被过滤（不渲染 session-sub）', !rows.includes('data-session="session-sub"') && !rows.includes('T13 Tauri')],
  ['子代理历史会话被过滤（不渲染 hist-sub）', !rows.includes('data-session="hist-sub"')],
  ['显示 Agent 软件名 + 模型 + 思考程度', rows.includes('DSH · deepseek-flash · thinking:max') && rows.includes('Claude Code · claude-sonnet-4 · thinking:high')],
  ['Codex 行显示 gpt-5-codex', rows.includes('gpt-5-codex')],
  ['历史行按 source 显示来源列（CLAUDE-CODE / CODEX）', rows.includes('>CLAUDE-CODE</span>') && rows.includes('>CODEX</span>')],
  ['状态文案完整（运行中/思考中/等待你/连接错误/已完成）', ['运行中','思考中','等待你','连接错误','已完成'].every(t => rows.includes(t))],
  ['待办计数（codex 待办 2）', rows.includes('待办 2')],
  ['历史会话渲染并可点击（data-session）', rows.includes('data-session="hist-1"') && rows.includes('data-session="hist-cc"')],
  ['项目下拉显示主会话数（9 会话中 1 个主会话）', getEl('project').innerHTML.includes('agent桌宠（1 会话 · 3 进行中）') && getEl('project').innerHTML.includes('原生AI操作系统（4 会话')],
  ['聚合状态=等待你', getEl('agg-text').textContent === '等待你'],
  ['新建会话按钮在无能力位时禁用', getEl('new-session').disabled === true],
  ['输入队列显示待投递 + 复制入口', getEl('queue').innerHTML.includes('待投递') && getEl('queue').innerHTML.includes('data-copy')],
  ['队列项含删除/重发/清空入口', getEl('queue').innerHTML.includes('data-del') && getEl('queue').innerHTML.includes('data-resend') && getEl('queue').innerHTML.includes('data-clear')],
  ['esc 转义引号（属性注入修复）', sandbox.esc('a"b<c&d') === 'a&quot;b&lt;c&amp;d'],
  ['底部说明含目录扫描统计与主会话数', getEl('note').textContent.includes('3 个项目') && getEl('note').textContent.includes('15 个会话') && getEl('note').textContent.includes('主会话 7')],
  ['返回 meta 行数组（供调用方校验）', Array.isArray(out.meta) && out.meta.length === 5],
  ['隐藏按钮存在且可交互', typeof getEl('hide-win').onclick === 'function'],
  ['投递目标默认显示「自动」', targetReset.includes('投递目标：自动') || rows.includes('投递目标：自动')],
  ['选中投递目标后行高亮（srow sel）', rowsSel.includes('class="srow sel" data-session="session-2"')],
  ['非 DSH 目标行显示「暂不支持投递」警示（M-D/M-E 未落地）', targetSel.includes('api-fix') && targetSel.includes('CLAUDE-CODE 暂不支持投递') && targetSel.includes('观察通道')],
  ['非 DSH 目标行黄色警示色', targetSelColor === 'var(--wait)'],
  ['DSH 目标行显示会话名与「点击恢复自动」（无警示）', targetDsh.includes('agent桌宠') && targetDsh.includes('点击恢复自动') && !targetDsh.includes('暂不支持投递')],
  ['陈旧目标自动回退到自动选择', targetReset.includes('投递目标：自动') && !targetReset.includes('session-gone')],
  ['token 注入后脚本仍可执行（属性名不被误替换）' + (injectedOk ? '' : '：' + injectedErr), injectedOk],
  ['选中项目按 projectKey 过滤实时行（3 实时 + 2 历史，不含 ws-2/子代理）', projLiveIds.length === 5 && projLiveIds.includes('session-1') && projLiveIds.includes('session-2') && projLiveIds.includes('session-3') && projLiveIds.includes('hist-1') && projLiveIds.includes('hist-cc') && !projLiveIds.includes('session-4') && !projLiveIds.includes('hist-cx')],
  ['历史行按 projectKey 过滤（hist-none 不属于 ws-1）', !rowsProj.includes('data-session="hist-none"')],
  ['全部项目时未注册历史行可见', getEl('sessions').innerHTML.includes('data-session="hist-none"') || rows.includes('hist-none')],
  ['软件状态面板渲染 6 行', (agentsHtml.match(/class="arow"/g) || []).length === 6],
  ['软件四态文案齐全（已连接/已打开·未连接/未打开/未下载）', ['已连接','已打开 · 未连接','未打开','未下载'].every(t => agentsHtml.includes(t))],
  ['已连接显示通道（插件/日志）', agentsHtml.includes('插件通道') && agentsHtml.includes('日志通道')],
  ['已打开·未连接显示说明（note）', agentsHtml.includes('含 Codex++ 桌面壳')],
  ['未打开显示上次活动相对时间', agentsHtml.includes('上次活动') && agentsHtml.includes('小时前')],
  ['未下载显示「未检测到安装痕迹」', agentsHtml.includes('未检测到安装痕迹')],
  ['版本号进 meta（v0.2.0-rc.2 / v1.0.4）', agentsHtml.includes('v0.2.0-rc.2') && agentsHtml.includes('v1.0.4')],
  ['Kimi 显示近似会话计数（≈9 个会话，M-H 降级）', agentsHtml.includes('≈9 个会话')],
  ['折叠后软件面板隐藏（hidden 类 + 空内容）', agentsHiddenCls.includes('hidden') && agentsHiddenHtml === ''],
  ['无 agents 字段时显示探测占位且不报错', agentsMissing.includes('正在探测本机 agent 软件')],
  ['软件状态切换按钮存在且可交互', typeof getEl('toggle-agents').onclick === 'function'],
];
let ok = true;
for (const [name, pass] of checks) { console.log((pass ? '✅ ' : '❌ ') + name); if (!pass) ok = false; }
console.log('\n元信息行：\n  ' + out.meta.join('\n  '));
console.log('\n渲染预览：\n' + rows.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 420));
process.exit(ok ? 0 : 1);
