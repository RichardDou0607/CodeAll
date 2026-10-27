#!/usr/bin/env node
/**
 * demo/test-window.mjs — App 界面渲染自检（demo/window.html 内联脚本）
 * 覆盖：顶部 agent 切换 / 左侧项目切换 / 会话列表（来源+项目可辨）/ 底部会话控制 /
 *       队列只显示未完成（delivered 不再显示）/ CLI 投递通道标注
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { createUiSandbox, extractMainScript } from './test-ui-dom.mjs';
import { windowFixture } from './test-ui-fixture.mjs';

const html = fs.readFileSync(new URL('./window.html', import.meta.url), 'utf8');
let script = extractMainScript(html);
script = script.replace(/let es=null;[\s\S]*$/, ''); // 去掉自动连接

const harness = createUiSandbox(html);
const { sandbox, getEl, preferences, requests, element, media } = harness;
vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: 'window-inline.js' });

// token 注入回归：替换后脚本必须仍可执行（2026-10-05 踩坑：属性名被误替换 → 整页 SyntaxError）
let injectedOk = false, injectedErr = '';
try {
  const { sandbox: sandbox2 } = createUiSandbox(html);
  vm.createContext(sandbox2);
  vm.runInContext(script.replace("'__PET_TOKEN_VALUE__'", '"tok-test"'), sandbox2, { filename: 'window-inline-injected.js' });
  injectedOk = typeof sandbox2.render === 'function';
} catch (e) { injectedErr = String((e && e.message) || e); }

const snap = windowFixture();
const now = snap.ts;

// 场景一：默认（全部 agent / 全部项目）——会话行能分辨 来源+项目
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
sandbox.window.__AGENT__ = 'zcode';
sandbox.render(snap);
const rowsZcode = getEl('sessions').innerHTML;
const projZcode = getEl('projects').innerHTML;
sandbox.window.__AGENT__ = '';
// 场景三：左侧选项目 ws-1
sandbox.window.__PROJECT__ = 'ws-1';
sandbox.render(snap);
const rowsProj = getEl('sessions').innerHTML;
const hintProj = getEl('proj-hint').textContent;
sandbox.window.__PROJECT__ = '';
sandbox.render(snap);
// 场景 3.5：软件状态独立页（视图切换，不与会话页重叠）
sandbox.window.__VIEW__ = 'status';
sandbox.render(snap);
const statusCards = getEl('status-cards').innerHTML;
const softwareChart = getEl('software-chart').innerHTML;
const softwareMetrics = getEl('software-metrics').innerHTML;
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
// 场景 3.8：手动隐藏（叠加在自动三档上）——活跃会话也可手动藏，新活动自动解除
sandbox.window.__HIDDEN__ = { 'session-2': now };   // 手动隐藏一个活跃会话
sandbox.render(snap);
const rowsMh = getEl('sessions').innerHTML;
sandbox.window.__FILTER__ = 'hidden';
sandbox.render(snap);
const rowsMhView = getEl('sessions').innerHTML;
sandbox.window.__FILTER__ = 'all';
// 新活动自动解除：hiddenAt 早于 lastActiveMs（session-2 活动在 30s 前）
sandbox.window.__HIDDEN__ = { 'session-2': now - 100000 };
sandbox.render(snap);
const rowsMhStale = getEl('sessions').innerHTML;
sandbox.window.__HIDDEN__ = {};
sandbox.render(snap);
// 场景 3.9：形态切换（CLI / 桌面端 / IDE）——实时行与历史行都按 variant 过滤，计数与 hint 联动
sandbox.window.__VARIANT__ = 'cli';
sandbox.render(snap);
const rowsCli = getEl('sessions').innerHTML;
const vfCli = getEl('variant-filter').innerHTML;
const hintCli = getEl('proj-hint').textContent;
sandbox.window.__VARIANT__ = 'desktop';
sandbox.render(snap);
const rowsDesk = getEl('sessions').innerHTML;
// 组合：项目钻取 + 形态过滤（ws-1 的 CLI 会话 = session-3 + 历史 hist-cc，桌面会话 session-1/2 不出现）
sandbox.window.__VARIANT__ = 'cli';
sandbox.window.__PROJECT__ = 'ws-1';
sandbox.render(snap);
const rowsProjCli = getEl('sessions').innerHTML;
const hintProjCli = getEl('proj-hint').textContent;
sandbox.window.__PROJECT__ = '';
sandbox.window.__VARIANT__ = '';
sandbox.render(snap);
// 场景 3.9b：无 CLI 产品的软件（ZCode）——形态筛选只留 全部/桌面；停在 CLI 档切到 ZCode 自动回落「全部」
sandbox.window.__AGENT__ = 'zcode';
sandbox.window.__VARIANT__ = 'cli';
sandbox.render(snap);
const vfZcode = getEl('variant-filter').innerHTML;
const rowsZcodeReset = getEl('sessions').innerHTML;
const hintZcodeReset = getEl('proj-hint').textContent;
sandbox.window.__VARIANT__ = 'desktop';
sandbox.render(snap);
const vfZcodeDesk = getEl('variant-filter').innerHTML;
const rowsZcodeDesk = getEl('sessions').innerHTML;
sandbox.window.__AGENT__ = '';
sandbox.window.__VARIANT__ = '';
sandbox.render(snap);
// 场景 3.9b 补充：DSH 同为纯桌面软件（无 CLI 产品）——形态筛选也只留 全部/桌面
sandbox.window.__AGENT__ = 'dsh';
sandbox.render(snap);
const vfDsh = getEl('variant-filter').innerHTML;
sandbox.window.__AGENT__ = '';
sandbox.render(snap);
// 场景 3.9c：新建会话下拉 —— ZCode 标「· 桌面」而非「· CLI」（无独立 CLI 产品，会话产自桌面 App）
sandbox.showNewDialog();
const newSourceHtml = getEl('new-source').innerHTML;
// 场景四：投递目标 = claude 会话 → CLI 通道标注
sandbox.window.__TARGET__ = 'session-2';
sandbox.render(snap);
const targetCli = getEl('target').innerHTML;
sandbox.window.__TARGET__ = 'session-1';
sandbox.render(snap);
const targetDsh = getEl('target').innerHTML;
sandbox.window.__TARGET__ = '';
sandbox.render(snap);
// 场景 3.10：用量页（视图切换 + 合计 chips + 跨源合并模型表 + 分源表）
sandbox.window.__VIEW__ = 'usage';
sandbox.render(snap);
const usageBodyHtml = getEl('usage-body').innerHTML;
const usageMainDisplay = getEl('main').style.display;
const usagePageCls = getEl('usage-page').className;
const usageNavBtn = getEl('view-usage').className;
// 场景 3.11：用量页时间窗切换（当日）——chips/Agent 表/模型表全部切到当日数据
sandbox.window.__USAGE_RANGE__ = 'today';
sandbox.render(snap);
const usageTodayHtml = getEl('usage-body').innerHTML;
sandbox.window.__USAGE_RANGE__ = 'all';
sandbox.render(snap);
sandbox.window.__VIEW__ = 'sessions';
sandbox.render(snap);
// 场景 3.12：软件状态页防频闪 —— 相对时间每秒在变时只补 textContent，图表/卡片/指标不重写 innerHTML（<img> 图标不被销毁重建）
sandbox.window.__VIEW__ = 'status';
sandbox.render(snap);
const flickerEls = ['software-chart', 'status-cards', 'software-metrics'].map(getEl);
const flickerWrites = flickerEls.map(el => { let n = 0, v = el.innerHTML; Object.defineProperty(el, 'innerHTML', { get: () => v, set(x) { v = x; n++; }, configurable: true }); return () => n; });
const snapLater = JSON.parse(JSON.stringify(snap));
snapLater.ts = snap.ts + 5000;   // 5 秒后：relTime 文案必然变化，活动标签（45s 阈值）不变
sandbox.render(snapLater);
const flickerCounts = flickerWrites.map(fn => fn());
sandbox.window.__VIEW__ = 'sessions';
sandbox.render(snap);
// 场景 3.13：三档计数 = 当前口径下各档成员数（实时+历史全量），不随视图切换/折叠跳变；
// 活跃档历史行默认展示（hist-fresh：done 4 分钟前 → 活跃档；旧的「历史会话」折叠开关已废弃）
const snapFold = windowFixture();
snapFold.catalog.history.push({ sessionId: 'hist-fresh', title: '四分钟前刚完成', state: 'done', source: 'dsh', agentName: 'DSH', model: 'deepseek-flash', updatedAt: snapFold.ts - 240000, kind: 'main', projectKey: 'ws-1' });
sandbox.window.__SHOW_HISTORY__ = false;   // 旧开关置 false 也不得折叠活跃档历史行（回归守护）
sandbox.window.__FILTER__ = 'all';
sandbox.render(snapFold);
const countOf = f => Number((getEl('sess-filter').innerHTML.match(new RegExp('data-filter="' + f + '"[^>]*>[^<]*?(\\d+)')) || [])[1] || -1);
const rowShown = () => (getEl('sessions').innerHTML.match(/class="srow/g) || []).length;
const foldAllShown = rowShown(), foldAllCount = countOf('all'), foldAllDoneCount = countOf('done'), foldAllHiddenCount = countOf('hidden');
const foldRowsHtml = getEl('sessions').innerHTML;
sandbox.window.__FILTER__ = 'done';
sandbox.render(snapFold);
const foldDoneShown = rowShown(), foldDoneCount = countOf('done'), foldDoneAllCount = countOf('all');
sandbox.window.__FILTER__ = 'hidden';
sandbox.render(snapFold);
const foldHiddenShown = rowShown(), foldHiddenCount = countOf('hidden'), foldHiddenAllCount = countOf('all');
sandbox.window.__FILTER__ = 'all';
sandbox.render(snap);
// 场景 3.14：宿主暂时停止（idle 2h，本应进隐藏档）但子代理仍在跑 → 宿主保持活跃 + 状态显示「等待子代理」+ 行内徽标；
// 同口径的历史区宿主（未被实时跟随，如服务重启后）也必须在默认视图可见——曾因「历史会话」折叠而凭空消失
const snapSub = windowFixture();
snapSub.sessions.push({ id: 'session-host', lastActiveMs: snapSub.ts - 7200000, source: 'dsh', label: '宿主暂停（子代理在跑）', state: 'delegated', kind: 'main', projectKey: 'ws-1', since: snapSub.ts - 7200000, subagentRunning: 2 });
snapSub.catalog.history.push({ sessionId: 'hist-host', title: '历史区宿主（子代理在跑）', state: 'delegated', source: 'zcode', agentName: 'ZCode', model: 'GLM-5.3', updatedAt: snapSub.ts - 60000, kind: 'main', projectKey: 'ws-1', subagentRunning: 3 });
snapSub.stateCounts = { ...snapSub.stateCounts, delegated: 1 };
sandbox.window.__FILTER__ = 'all';
sandbox.render(snapSub);
const rowsSubActive = getEl('sessions').innerHTML;
const chipsSub = getEl('chips').innerHTML;
const subActiveCount = countOf('all'), subActiveRows = rowShown();
sandbox.window.__FILTER__ = 'hidden';
sandbox.render(snapSub);
const rowsSubHidden = getEl('sessions').innerHTML;
sandbox.window.__FILTER__ = 'all';
sandbox.render(snap);
// 场景 3.15：无标题会话显示「（未命名）」，不再拿项目名冒充标题（适配器层已改为 title→首条用户消息→null）
const snapTitle = windowFixture();
snapTitle.sessions.push({ id: 'session-untitled', lastActiveMs: snapTitle.ts - 30000, source: 'codex', state: 'running', kind: 'main', projectKey: 'ws-1' });
snapTitle.catalog.history.push({ sessionId: 'hist-untitled', title: null, state: 'idle', source: 'codex', agentName: 'Codex', updatedAt: snapTitle.ts - 600000, kind: 'main', projectKey: 'ws-1' });
sandbox.render(snapTitle);
const rowsUntitled = getEl('sessions').innerHTML;
sandbox.render(snap);

const checks = [
  ['顶部 agent 切换渲染 9 个 tab（全部/DSH/CLAUDE/CODEX/KIMI/ZCODE/OPENCODE/QODER/CURSOR）', (tabsHtml.match(/class="tab/g) || []).length === 9 && tabsHtml.includes('全部') && tabsHtml.includes('CODEX') && tabsHtml.includes('ZCODE') && tabsHtml.includes('OPENCODE') && tabsHtml.includes('QODER') && tabsHtml.includes('CURSOR')],
  ['默认实时行=活跃档 6 行（1-4/8 进行中/出错 + session-6 刚完成缓冲；session-5 完成/session-7 隐藏已分档；子代理过滤）', (rows.match(/class="srow"/g) || []).length === 6 && rows.includes('data-session="session-6"') && rows.includes('data-session="session-8"') && !rows.includes('data-session="session-5"') && !rows.includes('data-session="session-7"') && !rows.includes('session-sub')],
  ['会话行可辨来源与项目（来源列 + 项目名进 meta）', rows.includes('>CLAUDE·桌面</span>') && rows.includes('· agent桌宠')],
  ['ZCode 实时行带 ZCODE·桌面 形态徽标（纯桌面软件，无独立 CLI 产品）', rows.includes('>ZCODE·桌面</span>')],
  ['实时行来源形态徽标（CLAUDE·桌面 / CODEX·CLI）', rows.includes('>CLAUDE·桌面</span>') && rows.includes('>CODEX·CLI</span>')],
  ['DSH 会话也带形态徽标（DSH·桌面），实时行与历史行一致', rows.includes('>DSH·桌面</span>') && rowsDone.includes('>DSH·桌面</span>')],
  ['来源徽标带 title 全文（截断时可悬停读全）', rows.includes('class="src" title="CLAUDE·桌面"') && rowsDone.includes('class="src" title="CODEX·桌面"')],
  ['完成/隐藏视图的历史行徽标（CODEX·桌面 在完成；KIMI 在隐藏）', rowsDone.includes('>CODEX·桌面</span>') && rowsHiddenView.includes('>KIMI</span>')],
  ['左侧项目列表（全部项目 + 4 项，含进行中计数）', (projHtml.match(/class="pitem/g) || []).length === 5 && projHtml.includes('4 进行') && projHtml.includes('agent桌宠')],
  ['临时/已删项目淡化标记（pitem dim + 目录已删除提示）', projHtml.includes('class="pitem dim"') && projHtml.includes('（目录已删除）') && projHtml.includes('x（临时）')],
  ['软件状态独立页：14 张卡片（八源：六家 CLI/桌面拆行 + ZCode 单行；OpenCode/Qoder/Cursor 已接入回到注册表）', (statusCards.match(/class="scard"/g) || []).length === 14 && !statusCards.includes('AgentOS') && statusCards.includes('OpenCode CLI') && statusCards.includes('Qoder CLI') && statusCards.includes('Qoder 桌面端') && statusCards.includes('Cursor CLI') && statusCards.includes('Cursor 桌面端') && ['已连接', '已打开 · 未连接', '未打开'].every(t => statusCards.includes(t))],
  ['CodeAll 品牌与软件原始图标接线', html.includes('CodeAll') && html.includes('/assets/codeall-mark.svg') && (statusCards.match(/class="agent-logo"/g) || []).length === 14 && statusCards.includes('/assets/agents/claude.png')],
  ['资源 URL 带版本参数（同名换图可逃出 WebView 旧缓存：brand/agentLogo 均 ?v=）', html.includes('/assets/codeall-mark.svg?v=') && html.includes('const ASSET_V=') && statusCards.includes('/assets/agents/claude.png?v=') && statusCards.includes('/assets/agents/cursor.svg?v=')],
  ['软件页概览指标与八来源真实图表', softwareMetrics.includes('主会话') && softwareMetrics.includes('请求') && (softwareChart.match(/data-source-chart=/g) || []).length === 8 && softwareChart.includes('DeepSeek Harness') && softwareChart.includes('ZCode') && softwareChart.includes('OpenCode') && softwareChart.includes('Qoder') && softwareChart.includes('Cursor'),],
  ['CLI 与桌面端各自独立行（Claude / Codex / Kimi / OpenCode / Cursor 五家拆行 + ZCode/Qoder 单行）', ['Claude Code CLI','Claude Code 桌面端','Codex CLI','Codex 桌面端','Kimi CLI','Kimi Code 桌面端','OpenCode CLI','OpenCode 桌面端','Cursor CLI','Cursor 桌面端'].every(n=>statusCards.includes(n))],
  ['独立页不与会话页重叠（main 隐藏 / status on / 会话工具栏隐藏）', mainDisplay === 'none' && statusCls === 'on' && sessToolbarVisible === 'hidden'],
  ['独立页显示观察通道与活跃度', statusCards.includes('观察通道') && statusCards.includes('活动中') && statusCards.includes('静默')],
  ['独立页按行带各自形态计数（CLI 行=CLI 13；桌面行=桌面 33 · IDE 4）', statusCards.includes('CLI 13') && statusCards.includes('桌面 33 · IDE 4')],
  ['独立页 Kimi 精确计数（9 会话，无 ≈）', statusCards.includes('>9</b>') && !statusCards.includes('≈9')],
  ['独立页 ZCode 卡片（sqlite 只读观察 + 39 会话精确计数）', statusCards.includes('ZCode') && statusCards.includes('>39</b>')],
  ['独立页 ZCode 卡片带形态计数（桌面 2 会话；纯桌面软件无 CLI 行）', statusCards.includes('桌面 2 会话')],
  ['独立页 DSH 卡片带形态计数（桌面 8 会话；DSH 无 CLI 产品）', statusCards.includes('桌面 8 会话')],
  ['回到会话视图：main 恢复显示', getEl('main').style.display === 'flex' && getEl('status-page').className === ''],
  ['顶部切 CLAUDE → 仅 claude 的活跃实时行（活跃档历史为空不掺行）', rowsClaude.includes('data-session="session-2"') && !rowsClaude.includes('data-session="session-1"') && !rowsClaude.includes('data-session="hist-1"')],
  ['顶部切 ZCODE → 仅 zcode 的活跃实时行（session-8 在；其它源与历史不在）', rowsZcode.includes('data-session="session-8"') && !rowsZcode.includes('data-session="session-1"') && !rowsZcode.includes('data-session="hist-zc"') && !rowsZcode.includes('data-session="hist-1"')],
  ['顶部切 ZCODE → 项目侧栏只留含 zcode 的项目（仅 ws-1，sources 含 zcode）', (projZcode.match(/class="pitem/g) || []).length === 2 && projZcode.includes('agent桌宠') && !projZcode.includes('原生AI操作系统')],
  ['顶部切 CLAUDE → 项目侧栏只留含 claude 的项目（仅 ws-1）', (projClaude.match(/class="pitem/g) || []).length === 2 && projClaude.includes('agent桌宠') && !projClaude.includes('原生AI操作系统')],
  ['proj-hint 反映 agent 过滤', hintClaude.includes('CLAUDE-CODE') && hintClaude.includes('claude') === false],
  ['左侧选项目 ws-1 → 只留该项目活跃行（session-1/2/3/6；ws-2 的 session-4/7 不在）', ['session-1','session-2','session-3','session-6'].every(id=>rowsProj.includes('data-session="'+id+'"')) && !rowsProj.includes('data-session="session-4"') && !rowsProj.includes('data-session="session-7"')],
  ['项目钻取=该项目全部会话（ws-1 还含完成档 session-5 与历史 hist-1/hist-cc/hist-act）', ['session-5','hist-1','hist-cc','hist-act'].every(id=>rowsProj.includes('data-session="'+id+'"'))],
  ['项目钻取不含其它项目的历史行（ws-2 的 hist-cx / hist-ended 不在）', !rowsProj.includes('data-session="hist-cx"') && !rowsProj.includes('data-session="hist-ended"')],
  ['项目钻取 hint 用「列出全部 N」口径（列表数=全部会话数，三档只作参考，消除「活跃 0 却列出一堆」的不一致）', hintProj.includes('列出全部') && hintProj.includes('活跃')],
  ['三档计数=实际行数（活跃档历史行默认展示：hist-fresh 在列，活跃 7=7 行）', foldAllShown === 7 && foldAllCount === 7 && foldRowsHtml.includes('data-session="hist-fresh"')],
  ['默认视图即显示真实的 完成 10 / 隐藏 3（不再因折叠显示 0），各档行数=计数', foldAllDoneCount === 10 && foldAllHiddenCount === 3 && foldDoneShown === 10 && foldDoneCount === 10 && foldHiddenShown === 3 && foldHiddenCount === 3],
  ['计数不随视图切换跳变（活跃计数在完成/隐藏视图与默认视图一致）', foldDoneAllCount === foldAllCount && foldHiddenAllCount === foldAllCount],
  ['软件状态页防频闪：relTime 文案变化时图表/卡片/指标 0 次 innerHTML 重写（<img> 不重建）', flickerCounts.every(n => n === 0) && statusCards.includes('data-reltime=')],
  ['宿主暂停但子代理在跑 → 保持活跃（idle 2h 不进隐藏档）+ 状态「等待子代理」+ 行内徽标 + 顶部 chips；历史区宿主（未被实时跟随）同样默认可见', rowsSubActive.includes('data-session="session-host"') && rowsSubActive.includes('>等待子代理</span>') && rowsSubActive.includes('>子代理 2</span>') && rowsSubActive.includes('data-session="hist-host"') && rowsSubActive.includes('>子代理 3</span>') && !rowsSubHidden.includes('data-session="session-host"') && !rowsSubHidden.includes('data-session="hist-host"') && subActiveCount === subActiveRows && chipsSub.includes('<strong>1</strong>子代理')],
  ['无标题会话显示「（未命名）」，不拿项目名冒充（实时行与历史行）', rowsUntitled.includes('data-session="session-untitled"') && rowsUntitled.includes('data-session="hist-untitled"') && rowsUntitled.includes('（未命名）')],
  ['形态分段控件渲染 4 档（全部/CLI/桌面/IDE）带选中态', (vfCli.match(/class="btn fbtn/g) || []).length === 4 && /class="btn fbtn on"[^>]*data-variant="cli"/.test(vfCli) && vfCli.includes('data-variant="desktop"') && vfCli.includes('data-variant="ide"')],
  ['形态计数在当前口径统计（CLI 档 = session-3 实时 + hist-cc/hist-cs-cli 历史 = 3；桌面含 DSH/ZCode/Cursor = 13；「全部」恒为 19；opencode/qoder 行形态未知不计入 CLI/桌面）', vfCli.includes('>CLI 3<') && vfCli.includes('>桌面 13<') && vfCli.includes('>全部 19<')],
  ['无 CLI 产品的软件（ZCode）：形态筛选收窄为 全部/桌面 两档，不出现 CLI/IDE', (vfZcode.match(/class="btn fbtn/g) || []).length === 2 && vfZcode.includes('data-variant="desktop"') && !vfZcode.includes('data-variant="cli"') && !vfZcode.includes('data-variant="ide"')],
  ['无 CLI 产品的软件（DSH）：形态筛选同样收窄为 全部/桌面 两档', (vfDsh.match(/class="btn fbtn/g) || []).length === 2 && vfDsh.includes('data-variant="desktop"') && !vfDsh.includes('data-variant="cli"')],
  ['停在 CLI 档切到 ZCode → 已选形态自动回落「全部形态」（session-8 可见；hint 不再标 仅CLI）', rowsZcodeReset.includes('data-session="session-8"') && !hintZcodeReset.includes('仅CLI') && sandbox.window.__VARIANT__ === ''],
  ['ZCode + 桌面档：session-8 在列，桌面计数含实时+历史（桌面 2）', rowsZcodeDesk.includes('data-session="session-8"') && vfZcodeDesk.includes('>桌面 2<')],
  ['新建会话下拉：ZCode 标「· 桌面」而非「· CLI」（与 DSH 同为桌面软件）', newSourceHtml.includes('ZCODE · 桌面') && newSourceHtml.includes('CLAUDE · CLI') && !newSourceHtml.includes('ZCODE · CLI')],
  ['形态切到 CLI → 仅 CLI 会话（session-3 在；桌面的 session-1/2 不在）', rowsCli.includes('data-session="session-3"') && !rowsCli.includes('data-session="session-1"') && !rowsCli.includes('data-session="session-2"')],
  ['形态切到 CLI → proj-hint 标注 仅CLI', hintCli.includes('仅CLI')],
  ['形态切到桌面端 → 桌面会话在（session-1/2），CLI 的 session-3 不在', rowsDesk.includes('data-session="session-1"') && rowsDesk.includes('data-session="session-2"') && !rowsDesk.includes('data-session="session-3"')],
  ['项目钻取 + 形态组合：ws-1 仅 CLI = session-3 + hist-cc（含完成档历史），桌面行与其它项目不在', rowsProjCli.includes('data-session="session-3"') && rowsProjCli.includes('data-session="hist-cc"') && !rowsProjCli.includes('data-session="session-1"') && !rowsProjCli.includes('data-session="hist-cx"')],
  ['组合口径 hint 同时含 仅CLI 与 列出全部', hintProjCli.includes('仅CLI') && hintProjCli.includes('列出全部')],
  ['选项目后历史区出现该项目的活跃档（ws-1 无活跃历史则无历史行）', !rowsProj.includes('data-session="hist-cx"')],
  ['非 DSH 目标标注来源形态与 CLI 投递通道（api-fix（CLAUDE·桌面）· 经 CLI 通道投递）', targetCli.includes('api-fix') && targetCli.includes('（CLAUDE·桌面）') && targetCli.includes('经 CLI 通道投递')],
  ['DSH 目标为常规目标行（含 DSH·桌面 徽标）', targetDsh.includes('agent桌宠') && targetDsh.includes('（DSH·桌面）') && !targetDsh.includes('点击恢复自动') && !targetDsh.includes('CLI 通道')],
  ['活跃视图=三档之「活跃」：进行中 + 10 分钟内完成(session-6) + 1h 内有活动；不含 2h 前完成与 2h 闲置', rowsAll.includes('data-session="session-6"') && rowsAll.includes('data-session="session-1"') && !rowsAll.includes('data-session="session-5"') && !rowsAll.includes('data-session="session-7"')],
  ['活跃视图排序：waiting(session-3) 在 running(session-1) 前', rowsAll.indexOf('data-session="session-3"') < rowsAll.indexOf('data-session="session-1"')],
  ['三态分段控件带规则提示与计数', (getEl('sess-filter').innerHTML.match(/class="btn fbtn/g) || []).length === 3 && getEl('sess-filter').innerHTML.includes('隐藏会话') && /data-filter="hidden"[^>]*title="[^"]*1 小时内无任何消息活动/.test(getEl('sess-filter').innerHTML)],
  ['「完成会话」视图：done>10min（session-5 + done 历史），不含缓冲期内的 session-6', rowsDone.includes('data-session="session-5"') && rowsDone.includes('data-session="hist-1"') && !rowsDone.includes('data-session="session-6"') && !rowsDone.includes('data-session="session-1"')],
  ['DSH 目录 ended 状态归「完成」档且有中文标签（已结束，不裸显英文）', rowsDone.includes('data-session="hist-ended"') && rowsDone.includes('已结束') && !rowsDone.includes('>ended</span>')],
  ['顶部 chips 用当前状态计数 stateCounts（含 等待 1），不是累计事件数', getEl('chips').innerHTML.includes('<strong>1</strong>等待')],
  ['「隐藏会话」视图：仅空闲/出错超 1h（session-7 + 老 idle 历史），不含完成档与活跃档', rowsHiddenView.includes('data-session="session-7"') && rowsHiddenView.includes('data-session="hist-km"') && !rowsHiddenView.includes('data-session="session-5"') && !rowsHiddenView.includes('data-session="session-1"')],
  ['三档互斥：proj-hint 计数齐全', getEl('proj-hint').textContent.includes('活跃') && getEl('proj-hint').textContent.includes('完成') && getEl('proj-hint').textContent.includes('隐藏')],
  ['waiting 即使 2 小时无消息仍属活跃（规则①不限时间）', rowsStale.includes('data-session="session-5"')],
  ['手动隐藏：活跃会话从「活跃」视图消失', !rowsMh.includes('data-session="session-2"') && rowsMh.includes('data-session="session-1"')],
  ['手动隐藏的会话进「隐藏会话」视图，带 手动 标记与 恢复 按钮', rowsMhView.includes('data-session="session-2"') && rowsMhView.includes('>手动</span>') && rowsMhView.includes('data-unhide="session-2"')],
  ['被隐藏会话有新活动 → 自动解除隐藏（回到活跃视图）', rowsMhStale.includes('data-session="session-2"')],
  ['隐藏视图的自动未活跃行不带 手动 标记', rowsHiddenView.includes('data-session="session-7"') && !rowsHiddenView.includes('data-unhide="session-7"')],
  ['队列只显示未完成：delivered 不出现，queued/failed 在', !queueHtml.includes('这条已送达') && queueHtml.includes('把进度总结成三行') && queueHtml.includes('失败') && queueHtml.includes('data-resend')],
  ['队列项有复制/删除入口', queueHtml.includes('data-copy') && queueHtml.includes('data-del')],
  ['聚合状态=等待你', getEl('agg-text').textContent === '等待你'],
  ['新建按钮可用（CLI 通道就绪）', getEl('new-session').disabled === false],
  ['未选目标时提示先选择会话', getEl('hint').textContent.includes('选择主会话后发送')],
  ['渲染统计返回（rows=活跃档 6 / projects=4）', out.rows === 6 && typeof out.hist === 'number' && out.projects === 4],
  ['会话行 meta 显示 token 用量（全量口径 + in/out 分项；session-2 带 usage）', rows.includes('tok 全量 2.2M（in 1.2M/out 23k）') && rows.includes('glm-5.3')],
  ['用量页：主界面隐藏 / usage-page on / 导航按钮选中', usageMainDisplay === 'none' && usagePageCls === 'on' && usageNavBtn === 'on'],
  ['用量页：各 Agent 消耗量汇总表（DSH/ZCode 单行 + 含缓存读的 in 值）', usageBodyHtml.includes('各 Agent 消耗量') && usageBodyHtml.includes('>DSH</td><td>271.7M</td>') && usageBodyHtml.includes('>ZCODE</td><td>1.67B</td>')],
  ['用量页：来源对比图表与原始明细共存（Token 全量口径；opencode 进图 · qoder 无 token 如实缺席）', (usageBodyHtml.match(/data-source-chart=/g) || []).length === 12 && usageBodyHtml.includes('请求数') && usageBodyHtml.includes('Token · 全量（含缓存读）') && usageBodyHtml.includes('OPENCODE')],
  ['用量页：Claude/Codex/Kimi 按形态拆行（CLAUDE·桌面 / CLAUDE·CLI / CODEX·桌面 / KIMI·桌面）', usageBodyHtml.includes('>CLAUDE·桌面</td>') && usageBodyHtml.includes('>CLAUDE·CLI</td>') && usageBodyHtml.includes('>CODEX·桌面</td>') && usageBodyHtml.includes('>KIMI·桌面</td>')],
  ['用量页：命中率展示（合计 chips 90.0% + 表格百分比列）', usageBodyHtml.includes('命中率 90.0%') && usageBodyHtml.includes('%</td>')],
  ['用量页：时间窗切换器（全部/当日/7 日内/30 日内）', usageBodyHtml.includes('data-urange="all"') && usageBodyHtml.includes('data-urange="today"') && usageBodyHtml.includes('data-urange="d7"') && usageBodyHtml.includes('data-urange="d30"')],
  ['切到当日：全部表格切当日数据（in（含缓存读）9.0M · Token 全量 9.3M · CLAUDE·CLI 行在；全量 1.11B 不再显示）', usageTodayHtml.includes('in（含缓存读） 9.0M') && usageTodayHtml.includes('Token 全量 9.3M') && usageTodayHtml.includes('>CLAUDE·CLI</td>') && !usageTodayHtml.includes('in（含缓存读） 1.11B')],
  ['用量页：合计 chips + 跨源合并模型表（GLM-5.3 标注 ZCODE+CLAUDE 来源）', usageBodyHtml.includes('in（含缓存读） 1.11B') && usageBodyHtml.includes('Token 全量 1.11B') && usageBodyHtml.includes('GLM-5.3') && usageBodyHtml.includes('ZCODE CLAUDE')],
  ['用量页：分源模型表 + 口径脚注（命中率折算 / 自然日归桶 / 60s 缓存）', usageBodyHtml.includes('gpt-6-sol') && usageBodyHtml.includes('时间窗按本地自然日') && usageBodyHtml.includes('60s 增量缓存')],
  ['回到会话视图：用量页隐藏', getEl('usage-page').className === '' && getEl('main').style.display === 'flex'],
  ['原生窗口控制（红黄绿）接管关闭/缩放/全屏：页面无自绘窗口按钮', true],
  ['token 注入后脚本仍可执行' + (injectedOk ? '' : '：' + injectedErr), injectedOk],
  ['esc 转义', sandbox.esc('a"b<c') === 'a&quot;b&lt;c'],
  // 2026-10-27 开场动画收口：外壳启动页已播同款战术终端开场 → window.html 从外壳进入（?from=shell）时整套跳过
  ['开场动画 #boot 存在（浏览器直开/刷新仍播放）', /id="boot"/.test(html) && /\.bt-beam\{/.test(html)],
  ['外壳进入跳过规则：html[data-boot=skip] 隐藏 #boot 并取消 UI 分层入场动画', /html\[data-boot=skip\] #boot\{display:none!important\}/.test(html) && /html\[data-boot=skip\] header[\s\S]{0,200}animation:none!important/.test(html)],
  ['主脚本按 ?from=shell 标记 data-boot=skip', /from=shell\(&\|\$\)\/\.test\(location\.search\)\)document\.documentElement\.setAttribute\('data-boot','skip'\)/.test(script)],
];
let ok = true;
for (const [name, pass] of checks) { console.log((pass ? '✅ ' : '❌ ') + name); if (!pass) ok = false; }
console.log('\n渲染统计：' + JSON.stringify(out));
process.exit(ok ? 0 : 1);
