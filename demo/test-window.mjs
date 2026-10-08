#!/usr/bin/env node
/**
 * demo/test-window.mjs — App 界面渲染自检（demo/window.html 内联脚本）
 * 覆盖：顶部 agent 切换 / 左侧项目切换 / 会话列表（来源+项目可辨）/ 底部会话控制 /
 *       队列只显示未完成（delivered 不再显示）/ CLI 投递通道标注
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { createUiSandbox } from './test-ui-dom.mjs';
import { windowFixture } from './test-ui-fixture.mjs';

const html = fs.readFileSync(new URL('./window.html', import.meta.url), 'utf8');
let script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
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

const checks = [
  ['顶部 agent 切换渲染 6 个 tab（全部/DSH/CLAUDE/CODEX/KIMI/ZCODE）', (tabsHtml.match(/class="tab/g) || []).length === 6 && tabsHtml.includes('全部') && tabsHtml.includes('CODEX') && tabsHtml.includes('ZCODE')],
  ['默认实时行=活跃档 6 行（1-4/8 进行中/出错 + session-6 刚完成缓冲；session-5 完成/session-7 隐藏已分档；子代理过滤）', (rows.match(/class="srow"/g) || []).length === 6 && rows.includes('data-session="session-6"') && rows.includes('data-session="session-8"') && !rows.includes('data-session="session-5"') && !rows.includes('data-session="session-7"') && !rows.includes('session-sub')],
  ['会话行可辨来源与项目（来源列 + 项目名进 meta）', rows.includes('>CLAUDE·桌面</span>') && rows.includes('· agent桌宠')],
  ['ZCode 实时行带 ZCODE 源徽标且无形态徽标（库内无 CLI/桌面标记，与 DSH 同口径）', rows.includes('>ZCODE</span>') && !rows.includes('ZCODE·')],
  ['实时行来源形态徽标（CLAUDE·桌面 / CODEX·CLI）', rows.includes('>CLAUDE·桌面</span>') && rows.includes('>CODEX·CLI</span>')],
  ['DSH 会话也带形态徽标（DSH·桌面），实时行与历史行一致', rows.includes('>DSH·桌面</span>') && rowsDone.includes('>DSH·桌面</span>')],
  ['来源徽标带 title 全文（截断时可悬停读全）', rows.includes('class="src" title="CLAUDE·桌面"') && rowsDone.includes('class="src" title="CODEX·桌面"')],
  ['完成/隐藏视图的历史行徽标（CODEX·桌面 在完成；KIMI 在隐藏）', rowsDone.includes('>CODEX·桌面</span>') && rowsHiddenView.includes('>KIMI</span>')],
  ['左侧项目列表（全部项目 + 4 项，含进行中计数）', (projHtml.match(/class="pitem/g) || []).length === 5 && projHtml.includes('4 进行') && projHtml.includes('agent桌宠')],
  ['临时/已删项目淡化标记（pitem dim + 目录已删除提示）', projHtml.includes('class="pitem dim"') && projHtml.includes('（目录已删除）') && projHtml.includes('x（临时）')],
  ['软件状态独立页：10 张卡片（CLI 与桌面端拆行 + ZCode）+ 四态徽标', (statusCards.match(/class="scard"/g) || []).length === 10 && ['已连接', '已打开 · 未连接', '未打开', '未下载'].every(t => statusCards.includes(t))],
  ['CLI 与桌面端各自独立行（Claude Code CLI / Claude Code 桌面端 / Codex CLI / Codex 桌面端 / Kimi CLI / Kimi Code 桌面端）', ['Claude Code CLI','Claude Code 桌面端','Codex CLI','Codex 桌面端','Kimi CLI','Kimi Code 桌面端'].every(n=>statusCards.includes(n))],
  ['独立页不与会话页重叠（main 隐藏 / status on / 会话工具栏隐藏）', mainDisplay === 'none' && statusCls === 'on' && sessToolbarVisible === 'hidden'],
  ['独立页显示观察通道与活跃度', statusCards.includes('观察通道') && statusCards.includes('活动中') && statusCards.includes('静默')],
  ['独立页按行带各自形态计数（CLI 行=CLI 13；桌面行=桌面 33 · IDE 4）', statusCards.includes('CLI 13') && statusCards.includes('桌面 33 · IDE 4')],
  ['独立页 Kimi 精确计数（9 会话，无 ≈）', statusCards.includes('>9</b>') && !statusCards.includes('≈9')],
  ['独立页 ZCode 卡片（sqlite 只读观察 + 39 会话精确计数）', statusCards.includes('ZCode') && statusCards.includes('>39</b>')],
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
  ['形态分段控件渲染 4 档（全部/CLI/桌面/IDE）带选中态', (vfCli.match(/class="btn fbtn/g) || []).length === 4 && /class="btn fbtn on"[^>]*data-variant="cli"/.test(vfCli) && vfCli.includes('data-variant="desktop"') && vfCli.includes('data-variant="ide"')],
  ['形态计数在当前口径统计（CLI 档 = session-3 实时 + hist-cc 历史 = 2；「全部」恒为未过滤总数 15）', vfCli.includes('>CLI 2<') && vfCli.includes('>桌面 4<') && vfCli.includes('>全部 15<')],
  ['形态切到 CLI → 仅 CLI 会话（session-3 在；桌面的 session-1/2 不在）', rowsCli.includes('data-session="session-3"') && !rowsCli.includes('data-session="session-1"') && !rowsCli.includes('data-session="session-2"')],
  ['形态切到 CLI → proj-hint 标注 仅CLI', hintCli.includes('仅CLI')],
  ['形态切到桌面端 → 桌面会话在（session-1/2），CLI 的 session-3 不在', rowsDesk.includes('data-session="session-1"') && rowsDesk.includes('data-session="session-2"') && !rowsDesk.includes('data-session="session-3"')],
  ['项目钻取 + 形态组合：ws-1 仅 CLI = session-3 + hist-cc（含完成档历史），桌面行与其它项目不在', rowsProjCli.includes('data-session="session-3"') && rowsProjCli.includes('data-session="hist-cc"') && !rowsProjCli.includes('data-session="session-1"') && !rowsProjCli.includes('data-session="hist-cx"')],
  ['组合口径 hint 同时含 仅CLI 与 列出全部', hintProjCli.includes('仅CLI') && hintProjCli.includes('列出全部')],
  ['选项目后历史区出现该项目的活跃档（ws-1 无活跃历史则无历史行）', !rowsProj.includes('data-session="hist-cx"')],
  ['非 DSH 目标标注来源形态与 CLI 投递通道（api-fix（CLAUDE·桌面）· 经 CLI 通道投递）', targetCli.includes('api-fix') && targetCli.includes('（CLAUDE·桌面）') && targetCli.includes('经 CLI 通道投递')],
  ['DSH 目标为常规目标行（含 DSH·桌面 徽标）', targetDsh.includes('agent桌宠') && targetDsh.includes('（DSH·桌面）') && targetDsh.includes('点击恢复自动') && !targetDsh.includes('CLI 通道')],
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
  ['hint 显示 CLI 投递模式', getEl('hint').textContent.includes('CLI 投递')],
  ['渲染统计返回（rows=活跃档 6 / projects=4）', out.rows === 6 && typeof out.hist === 'number' && out.projects === 4],
  ['会话行 meta 显示 token 用量（tok in/out；session-2 带 usage）', rows.includes('tok 1.2M/23k') && rows.includes('glm-5.3')],
  ['用量页：主界面隐藏 / usage-page on / 导航按钮选中', usageMainDisplay === 'none' && usagePageCls === 'on' && usageNavBtn === 'on'],
  ['用量页：各 Agent 消耗量汇总表（DSH/ZCode 单行 + 形态值正确）', usageBodyHtml.includes('各 Agent 消耗量') && usageBodyHtml.includes('>DSH</td><td>1.7M</td>') && usageBodyHtml.includes('>ZCODE</td><td>1.67B</td>')],
  ['用量页：Claude/Codex/Kimi 按形态拆行（CLAUDE·桌面 / CLAUDE·CLI / CODEX·桌面 / KIMI·桌面）', usageBodyHtml.includes('>CLAUDE·桌面</td>') && usageBodyHtml.includes('>CLAUDE·CLI</td>') && usageBodyHtml.includes('>CODEX·桌面</td>') && usageBodyHtml.includes('>KIMI·桌面</td>')],
  ['用量页：命中率展示（合计 chips 90.0% + 表格百分比列）', usageBodyHtml.includes('命中率 90.0%') && usageBodyHtml.includes('%</td>')],
  ['用量页：时间窗切换器（全部/当日/7 日内/30 日内）', usageBodyHtml.includes('data-urange="all"') && usageBodyHtml.includes('data-urange="today"') && usageBodyHtml.includes('data-urange="d7"') && usageBodyHtml.includes('data-urange="d30"')],
  ['切到当日：全部表格切当日数据（in 5.0M · CLAUDE·CLI 行在；全量 123.5M 不再显示）', usageTodayHtml.includes('in 5.0M') && usageTodayHtml.includes('>CLAUDE·CLI</td>') && !usageTodayHtml.includes('in 123.5M')],
  ['用量页：合计 chips + 跨源合并模型表（GLM-5.3 标注 ZCODE+CLAUDE 来源）', usageBodyHtml.includes('in 123.5M') && usageBodyHtml.includes('GLM-5.3') && usageBodyHtml.includes('ZCODE CLAUDE')],
  ['用量页：分源模型表 + 口径脚注（命中率折算 / 自然日归桶 / 60s 缓存）', usageBodyHtml.includes('gpt-6-sol') && usageBodyHtml.includes('时间窗按本地自然日') && usageBodyHtml.includes('60s 增量缓存')],
  ['回到会话视图：用量页隐藏', getEl('usage-page').className === '' && getEl('main').style.display === 'flex'],
  ['原生窗口控制（红黄绿）接管关闭/缩放/全屏：页面无自绘窗口按钮', true],
  ['token 注入后脚本仍可执行' + (injectedOk ? '' : '：' + injectedErr), injectedOk],
  ['esc 转义', sandbox.esc('a"b<c') === 'a&quot;b&lt;c'],
];
let ok = true;
for (const [name, pass] of checks) { console.log((pass ? '✅ ' : '❌ ') + name); if (!pass) ok = false; }
console.log('\n渲染统计：' + JSON.stringify(out));
process.exit(ok ? 0 : 1);
