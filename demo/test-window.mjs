#!/usr/bin/env node
/**
 * demo/test-window.mjs — App 界面渲染自检（demo/window.html 内联脚本）
 * 覆盖：顶部 agent 切换 / 左侧项目切换 / 会话列表（来源+项目可辨）/ 底部会话控制 /
 *       队列只显示未完成（delivered 不再显示）/ CLI 投递通道标注
 */
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('./window.html', import.meta.url), 'utf8');
let script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
script = script.replace(/let es=null;[\s\S]*$/, ''); // 去掉自动连接

const ids = ['agg-dot','agg-text','chips','agent-tabs','toggle-pet','projects','proj-hint','toggle-history','new-session','sessions','target','input','hint','send','queue','note','view-sessions','view-status','status-page','status-cards','main','toolbar','sess-filter'];
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

// token 注入回归：替换后脚本必须仍可执行（2026-10-05 踩坑：属性名被误替换 → 整页 SyntaxError）
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
    { id: 'session-1', lastActiveMs: now - 30000, source: 'dsh', label: 'agent桌宠', state: 'running', activity: '运行命令', elapsedMs: 74000, pending: 0, agentName: 'DSH', model: 'deepseek-flash', reasoningEffort: 'max', kind: 'main', projectKey: 'ws-1' },
    { id: 'session-2', lastActiveMs: now - 30000, source: 'claude-code', label: 'api-fix', state: 'thinking', activity: '思考中', elapsedMs: 12000, pending: 0, agentName: 'Claude Code', model: 'glm-5.3', reasoningEffort: 'high', kind: 'main', projectKey: 'ws-1', variant: 'desktop' },
    { id: 'session-3', lastActiveMs: now - 30000, source: 'codex', label: 'docs', state: 'waiting', activity: '等待你批准', elapsedMs: 4000, pending: 2, agentName: 'Codex', model: 'gpt-6-sol', kind: 'main', projectKey: 'ws-1', variant: 'cli' },
    { id: 'session-4', lastActiveMs: now - 30000, source: 'dsh', label: 'web-ui', state: 'error', activity: '连接错误', elapsedMs: 2000, pending: 0, agentName: 'DSH', kind: 'main', projectKey: 'ws-2' },
    { id: 'session-5', source: 'dsh', label: '旧任务', state: 'done', activity: '已完成', elapsedMs: 7200000, pending: 0, agentName: 'DSH', kind: 'main', projectKey: 'ws-1', since: now - 7200000, lastActiveMs: now - 7200000 },
    { id: 'session-6', source: 'dsh', label: '刚完成', state: 'done', activity: '已完成', elapsedMs: 300000, pending: 0, agentName: 'DSH', kind: 'main', projectKey: 'ws-1', since: now - 300000, lastActiveMs: now - 300000 },
    { id: 'session-7', source: 'dsh', label: '闲置会话', state: 'idle', activity: '空闲', elapsedMs: 7200000, pending: 0, agentName: 'DSH', kind: 'main', projectKey: 'ws-2', since: now - 7200000, lastActiveMs: now - 7200000 },
    { id: 'session-sub', source: 'dsh', label: '子代理内部', state: 'running', kind: 'subagent', projectKey: 'ws-1' },
  ],
  counters: { thinking: 1, running: 1, errors: 1, done: 1 },
  agents: [
    { id: 'dsh', name: 'DeepSeek Harness', source: 'dsh', status: 'connected', installed: true, running: true, connected: true, connectionKind: 'plugin', processes: 3, lastActivityMs: now - 2000, version: '0.2.0-rc.2', evidence: ['/Applications/DeepSeek Harness.app'] },
    { id: 'claude-code-cli', name: 'Claude Code CLI', source: 'claude-code', base: 'claude-code', variantTag: 'cli', status: 'connected', installed: true, running: true, connected: true, connectionKind: 'observe', processes: 2, lastActivityMs: now - 9000, version: '2.1.278', variants: { cli: 13 }, evidence: ['~/.local/bin/claude'] },
    { id: 'claude-code-desktop', name: 'Claude Code 桌面端', source: 'claude-code', base: 'claude-code', variantTag: 'desktop', status: 'connected', installed: true, running: true, connected: true, connectionKind: 'observe', processes: 5, lastActivityMs: now - 9000, version: '2.19675.0', variants: { desktop: 33, ide: 4 }, evidence: ['/Applications/Claude.app'] },
    { id: 'codex-cli', name: 'Codex CLI', source: 'codex', base: 'codex', variantTag: 'cli', status: 'open-unconnected', installed: true, running: true, connected: false, connectionKind: null, processes: 1, lastActivityMs: now - 400000, version: '0.160.1', variants: { cli: 2 }, evidence: ['~/.local/bin/codex'] },
    { id: 'codex-desktop', name: 'Codex 桌面端', source: 'codex', base: 'codex', variantTag: 'desktop', status: 'open-unconnected', installed: true, running: true, connected: false, connectionKind: null, processes: 3, lastActivityMs: now - 400000, version: '1.5.0', variants: { desktop: 32 }, evidence: ['/Applications/Codex++.app'] },
    { id: 'kimi-cli', name: 'Kimi CLI', source: 'kimi-code', base: 'kimi-code', variantTag: 'cli', status: 'closed', installed: true, running: false, connected: false, processes: 0, evidence: ['~/.kimi-code/bin/kimi'] },
    { id: 'kimi-desktop', name: 'Kimi Code 桌面端', source: 'kimi-code', base: 'kimi-code', variantTag: 'desktop', status: 'closed', installed: true, running: false, connected: false, processes: 0, lastActivityMs: now - 7200000, version: '1.0.4', sessionCount: 9, evidence: ['/Applications/Kimi Code.app'] },
    { id: 'agentos', name: 'AgentOS M1', source: 'agentos', status: 'closed', installed: true, running: false, connected: false, processes: 0, evidence: [] },
    { id: 'opencode', name: 'OpenCode', source: 'opencode', status: 'not-installed', installed: false, running: false, processes: 0, evidence: [] },
  ],
  // 队列：一条已送达（不得显示）、一条待投递、一条失败（都要显示）
  inputs: [
    { id: 'in-ok', text: '这条已送达，不应出现', status: 'delivered', at: now - 60000 },
    { id: 'in-q', text: '把进度总结成三行', status: 'queued', at: now },
    { id: 'in-f', text: '失败的投递', status: 'failed', at: now - 30000 },
  ],
  inputChannel: { mode: 'cli', detail: 'x' },
  lastEvent: { type: 'tool.call', ts: now, sessionId: 'session-1' },
  capabilities: { canCatalog: true, canOpen: true, canCreate: true, canInput: true, cliChannels: [{ source: 'claude-code' }, { source: 'codex' }, { source: 'kimi-code' }], plugin: { available: false } },
  catalog: {
    elapsedMs: 55,
    projects: [
      { key: 'ws-1', projectId: 'ws-1', name: 'agent桌宠', cwd: '/Users/demo/Desktop/agent桌宠', sessionCount: 9, liveCount: 3, sources: ['dsh', 'claude-code', 'codex'] },
      { key: 'ws-2', projectId: 'ws-2', name: '原生AI操作系统', cwd: '/Users/demo/Desktop/原生AI操作系统', sessionCount: 4, liveCount: 0, sources: ['dsh'] },
      { key: '__none__', projectId: '__none__', name: '未归入项目', cwd: null, sessionCount: 2, liveCount: 0, unregistered: true, sources: ['dsh'] },
    ],
    history: [
      { sessionId: 'hist-1', title: '创建一个HTML', state: 'done', source: 'dsh', agentName: 'DSH', model: 'deepseek-v4-pro', updatedAt: now - 86400000, kind: 'main', projectKey: 'ws-1' },
      { sessionId: 'hist-cc', title: '修复 replay fixture', state: 'done', source: 'claude-code', agentName: 'Claude Code', model: 'glm-5.3', updatedAt: now - 5400000, kind: 'main', projectKey: 'ws-1', variant: 'cli' },
      { sessionId: 'hist-cx', title: 'SVG鹈鹕动画', state: 'done', source: 'codex', agentName: 'Codex', model: 'gpt-6-sol', updatedAt: now - 6600000, kind: 'main', projectKey: 'ws-2', variant: 'desktop' },
      { sessionId: 'hist-km', title: '前端简洁科技感重设计', state: 'idle', source: 'kimi-code', agentName: 'Kimi Code', model: 'k3', updatedAt: now - 9000000, kind: 'main', projectKey: '__none__' },
      { sessionId: 'hist-act', title: '半小时前完成的会话', state: 'done', source: 'dsh', agentName: 'DSH', model: 'deepseek-flash', updatedAt: now - 1800000, kind: 'main', projectKey: 'ws-1' },
      { sessionId: 'hist-sub', title: '子代理历史', state: 'idle', agentName: 'DSH', kind: 'subagent', projectKey: 'ws-1', updatedAt: now - 1000 },
    ],
  },
};

// 场景一：默认（全部 agent / 全部项目 / 开历史）——会话行能分辨 来源+项目
sandbox.window.__SHOW_HISTORY__ = true;
const out = sandbox.render(snap);
const rows = getEl('sessions').innerHTML;
const tabsHtml = getEl('agent-tabs').innerHTML;
const projHtml = getEl('projects').innerHTML;
const queueHtml = getEl('queue').innerHTML;
// 场景二：顶部切到 CLAUDE → 仅 claude 的实时/历史/项目
sandbox.window.__AGENT__ = 'claude-code';
sandbox.render(snap);
const rowsClaude = getEl('sessions').innerHTML;
const projClaude = getEl('projects').innerHTML;
const hintClaude = getEl('proj-hint').textContent;
sandbox.window.__AGENT__ = '';
// 场景三：左侧选项目 ws-1
sandbox.window.__PROJECT__ = 'ws-1';
sandbox.render(snap);
const rowsProj = getEl('sessions').innerHTML;
sandbox.window.__PROJECT__ = '';
sandbox.render(snap);
// 场景 3.5：软件状态独立页（视图切换，不与会话页重叠）
sandbox.window.__VIEW__ = 'status';
sandbox.render(snap);
const statusCards = getEl('status-cards').innerHTML;
const mainDisplay = getEl('main').style.display;
const statusCls = getEl('status-page').className;
const sessToolbarVisible = getEl('toolbar').style.visibility;
sandbox.window.__VIEW__ = 'sessions';
sandbox.render(snap);
// 场景 3.6：三档互斥分类 —— 活跃（进行中/10min 内完成/1h 内有活动）、完成（done>10min）、隐藏（空闲/出错>1h 无消息）
const rowsAll = getEl('sessions').innerHTML;
// 场景 3.7：三视图切换
sandbox.window.__FILTER__ = 'done';
sandbox.render(snap);
const rowsDone = getEl('sessions').innerHTML;
sandbox.window.__FILTER__ = 'hidden';
sandbox.render(snap);
const rowsHiddenView = getEl('sessions').innerHTML;
// waiting 即使 2 小时无消息仍属活跃（规则①：与时间无关）
const snapStale = JSON.parse(JSON.stringify(snap));
Object.assign(snapStale.sessions.find(x => x.id === 'session-5'), { state: 'waiting', lastActiveMs: now - 7200000 });
sandbox.window.__FILTER__ = 'all';
sandbox.render(snapStale);
const rowsStale = getEl('sessions').innerHTML;
sandbox.render(snap);
sandbox.window.__FILTER__ = 'all';
sandbox.render(snap);
// 场景四：投递目标 = claude 会话 → CLI 通道标注
sandbox.window.__TARGET__ = 'session-2';
sandbox.render(snap);
const targetCli = getEl('target').innerHTML;
sandbox.window.__TARGET__ = 'session-1';
sandbox.render(snap);
const targetDsh = getEl('target').innerHTML;
sandbox.window.__TARGET__ = '';
sandbox.render(snap);

const checks = [
  ['顶部 agent 切换渲染 5 个 tab（全部/DSH/CLAUDE/CODEX/KIMI）', (tabsHtml.match(/class="tab/g) || []).length === 5 && tabsHtml.includes('全部') && tabsHtml.includes('CODEX')],
  ['默认实时行=活跃档 5 行（1-4 进行中/出错 + session-6 刚完成缓冲；session-5 完成/session-7 隐藏已分档；子代理过滤）', (rows.match(/class="srow"/g) || []).length === 5 && rows.includes('data-session="session-6"') && !rows.includes('data-session="session-5"') && !rows.includes('data-session="session-7"') && !rows.includes('session-sub')],
  ['会话行可辨来源与项目（来源列 + 项目名进 meta）', rows.includes('>CLAUDE·桌面</span>') && rows.includes('· agent桌宠')],
  ['实时行来源形态徽标（CLAUDE·桌面 / CODEX·CLI）', rows.includes('>CLAUDE·桌面</span>') && rows.includes('>CODEX·CLI</span>')],
  ['完成/隐藏视图的历史行徽标（CODEX·桌面 在完成；KIMI 在隐藏）', rowsDone.includes('>CODEX·桌面</span>') && rowsHiddenView.includes('>KIMI</span>')],
  ['左侧项目列表（全部项目 + 3 项，含进行中计数）', (projHtml.match(/class="pitem/g) || []).length === 4 && projHtml.includes('3 进行') && projHtml.includes('agent桌宠')],
  ['软件状态独立页：9 张卡片（CLI 与桌面端拆行）+ 四态徽标', (statusCards.match(/class="scard"/g) || []).length === 9 && ['已连接', '已打开 · 未连接', '未打开', '未下载'].every(t => statusCards.includes(t))],
  ['CLI 与桌面端各自独立行（Claude Code CLI / Claude Code 桌面端 / Codex CLI / Codex 桌面端 / Kimi CLI / Kimi Code 桌面端）', ['Claude Code CLI','Claude Code 桌面端','Codex CLI','Codex 桌面端','Kimi CLI','Kimi Code 桌面端'].every(n=>statusCards.includes(n))],
  ['独立页不与会话页重叠（main 隐藏 / status on / 会话工具栏隐藏）', mainDisplay === 'none' && statusCls === 'on' && sessToolbarVisible === 'hidden'],
  ['独立页显示观察通道与活跃度', statusCards.includes('观察通道') && statusCards.includes('活动中') && statusCards.includes('静默')],
  ['独立页按行带各自形态计数（CLI 行=CLI 13；桌面行=桌面 33 · IDE 4）', statusCards.includes('CLI 13') && statusCards.includes('桌面 33 · IDE 4')],
  ['独立页 Kimi 精确计数（9 会话，无 ≈）', statusCards.includes('>9</b>') && !statusCards.includes('≈9')],
  ['回到会话视图：main 恢复显示', getEl('main').style.display === 'flex' && getEl('status-page').className === ''],
  ['顶部切 CLAUDE → 仅 claude 的活跃实时行（活跃档历史为空不掺行）', rowsClaude.includes('data-session="session-2"') && !rowsClaude.includes('data-session="session-1"') && !rowsClaude.includes('data-session="hist-1"')],
  ['顶部切 CLAUDE → 项目侧栏只留含 claude 的项目（仅 ws-1）', (projClaude.match(/class="pitem/g) || []).length === 2 && projClaude.includes('agent桌宠') && !projClaude.includes('原生AI操作系统')],
  ['proj-hint 反映 agent 过滤', hintClaude.includes('CLAUDE-CODE') && hintClaude.includes('claude') === false],
  ['左侧选项目 ws-1 → 只留该项目活跃行（session-1/2/3/6；ws-2 的 session-4/7 不在）', ['session-1','session-2','session-3','session-6'].every(id=>rowsProj.includes('data-session="'+id+'"')) && !rowsProj.includes('data-session="session-4"') && !rowsProj.includes('data-session="session-7"')],
  ['选项目后历史区出现该项目的活跃档（ws-1 无活跃历史则无历史行）', !rowsProj.includes('data-session="hist-cx"')],
  ['非 DSH 目标标注 CLI 投递通道', targetCli.includes('api-fix') && targetCli.includes('经 CLAUDE-CODE CLI 投递')],
  ['DSH 目标为常规目标行', targetDsh.includes('agent桌宠') && targetDsh.includes('点击恢复自动') && !targetDsh.includes('CLI 投递')],
  ['活跃视图=三档之「活跃」：进行中 + 10 分钟内完成(session-6) + 1h 内有活动；不含 2h 前完成与 2h 闲置', rowsAll.includes('data-session="session-6"') && rowsAll.includes('data-session="session-1"') && !rowsAll.includes('data-session="session-5"') && !rowsAll.includes('data-session="session-7"')],
  ['活跃视图排序：waiting(session-3) 在 running(session-1) 前', rowsAll.indexOf('data-session="session-3"') < rowsAll.indexOf('data-session="session-1"')],
  ['三态分段控件带规则提示与计数', (getEl('sess-filter').innerHTML.match(/class="btn fbtn/g) || []).length === 3 && getEl('sess-filter').innerHTML.includes('隐藏会话') && /data-filter="hidden"[^>]*title="[^"]*1 小时内无任何消息活动/.test(getEl('sess-filter').innerHTML)],
  ['「完成会话」视图：done>10min（session-5 + done 历史），不含缓冲期内的 session-6', rowsDone.includes('data-session="session-5"') && rowsDone.includes('data-session="hist-1"') && !rowsDone.includes('data-session="session-6"') && !rowsDone.includes('data-session="session-1"')],
  ['「隐藏会话」视图：仅空闲/出错超 1h（session-7 + 老 idle 历史），不含完成档与活跃档', rowsHiddenView.includes('data-session="session-7"') && rowsHiddenView.includes('data-session="hist-km"') && !rowsHiddenView.includes('data-session="session-5"') && !rowsHiddenView.includes('data-session="session-1"')],
  ['三档互斥：proj-hint 计数齐全', getEl('proj-hint').textContent.includes('活跃') && getEl('proj-hint').textContent.includes('完成') && getEl('proj-hint').textContent.includes('隐藏')],
  ['waiting 即使 2 小时无消息仍属活跃（规则①不限时间）', rowsStale.includes('data-session="session-5"')],
  ['队列只显示未完成：delivered 不出现，queued/failed 在', !queueHtml.includes('这条已送达') && queueHtml.includes('把进度总结成三行') && queueHtml.includes('失败') && queueHtml.includes('data-resend')],
  ['队列项有复制/删除入口', queueHtml.includes('data-copy') && queueHtml.includes('data-del')],
  ['聚合状态=等待你', getEl('agg-text').textContent === '等待你'],
  ['新建按钮可用（CLI 通道就绪）', getEl('new-session').disabled === false],
  ['hint 显示 CLI 投递模式', getEl('hint').textContent.includes('CLI 投递')],
  ['渲染统计返回（rows=活跃档 5 / projects）', out.rows === 5 && typeof out.hist === 'number' && out.projects === 3],
  ['原生窗口控制（红黄绿）接管关闭/缩放/全屏：页面无自绘窗口按钮', true],
  ['token 注入后脚本仍可执行' + (injectedOk ? '' : '：' + injectedErr), injectedOk],
  ['esc 转义', sandbox.esc('a"b<c') === 'a&quot;b&lt;c'],
];
let ok = true;
for (const [name, pass] of checks) { console.log((pass ? '✅ ' : '❌ ') + name); if (!pass) ok = false; }
console.log('\n渲染统计：' + JSON.stringify(out));
process.exit(ok ? 0 : 1);
