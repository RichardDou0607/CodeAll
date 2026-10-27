#!/usr/bin/env node
/**
 * demo/test-html.mjs — 在 Node 里用最小 DOM 桩执行 demo/frame.html 的播放器脚本，
 * 验证：脚本无语法错误、能驱动状态机、卡片 DOM 结构符合契约 §8.1、多会话折叠生效。
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { extractMainScript } from './test-ui-dom.mjs';

const frameUrl = new URL('./frame.html', import.meta.url);
if (!fs.existsSync(frameUrl)) {          // frame.html 为生成产物（不入库）：缺失时从合成样本自动构建
  const r = spawnSync(process.execPath, [new URL('./build-html.mjs', import.meta.url).pathname], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('❌ demo/frame.html 不存在且自动生成失败（node demo/build-html.mjs）'); process.exit(1); }
}
const html = fs.readFileSync(frameUrl, 'utf8');
const script = extractMainScript(html);
const ids = ['frame', 'log', 'strip', 'pos', 'stats', 'play', 'step', 'speed', 'restart'];
const store = new Map();
const doc = {
  getElementById: (id) => {
    if (!ids.includes(id)) throw new Error('渲染层引用了不存在的元素: ' + id);
    if (!store.has(id)) store.set(id, { id, innerHTML: '', textContent: '', value: '6', onclick: null });
    return store.get(id);
  },
};
let frames = 0;
const sandbox = {
  document: doc,
  performance: { now: () => 1000 + frames * 16 },
  requestAnimationFrame: (fn) => { if (frames++ < 400) fn(1000 + frames * 16); },
  console,
  JSON, Math, String, Number, Array, Object, Date, RegExp, isNaN, parseInt, parseFloat,
};
try {
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'frame-player.js' });
} catch (e) {
  console.error('❌ 播放器脚本执行失败：' + e.message);
  process.exit(1);
}
const card = store.get('frame').innerHTML;
const stats = store.get('stats').innerHTML;
const log = store.get('log').innerHTML;
const checks = [
  ['卡片包含状态灯与聚合状态', /class="head"/.test(card) && /class="agg"/.test(card)],
  ['卡片高度结构：首行 40px + 会话行 28px（CSS 定义）', /height:40px/.test(html) && /height:28px/.test(html)],
  ['会话行渲染出多后端（DSH 等）', /class="row"/.test(card)],
  ['折叠脚注存在（+N 或 N 个会话）', /个会话/.test(card)],
  ['事件日志有内容', /class="ty"/.test(log)],
  ['统计包含真实/合成标注', /真实/.test(stats)],
  ['速度控件存在', store.get('speed').value === '6'],
  ['播放按钮已绑定', typeof store.get('play').onclick === 'function'],
];
let ok = true;
for (const [name, pass] of checks) { console.log((pass ? '✅ ' : '❌ ') + name); if (!pass) ok = false; }
console.log('\n渲染出的卡片（去标签预览）：');
console.log(card.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400));
console.log('\n统计行：' + stats.replace(/<[^>]+>/g, ''));
process.exit(ok ? 0 : 1);
