#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = new Set(['cards', 'metrics', 'timeline', 'tasks', 'table']);
const STATUSES = new Set(['done', 'in_progress', 'blocked', 'pending']);
const ID = /^[a-z][a-z0-9-]*$/;

function fail(message) { throw new Error(message); }
function text(value, label, required = true) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') fail(`${label} 必须是字符串`);
  if (required && !value.trim()) fail(`${label} 不能为空`);
}
function id(value, label) { text(value, label); if (!ID.test(value)) fail(`${label} 必须使用 kebab-case：${value}`); }
function list(value, label) { if (!Array.isArray(value)) fail(`${label} 必须是数组`); return value; }
function strings(value, label) { if (value === undefined) return; list(value, label).forEach((item, i) => text(item, `${label}[${i}]`)); }
function unique(items, label) {
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    if (item.id === undefined) continue;
    id(item.id, `${label}[${index}].id`);
    if (seen.has(item.id)) fail(`${label} 存在重复 item id：${item.id}`);
    seen.add(item.id);
  }
}
function validate(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('根节点必须是 JSON 对象');
  if (!data.meta || typeof data.meta !== 'object') fail('meta 必须是对象');
  text(data.meta.project, 'meta.project');
  for (const key of ['title', 'description', 'version', 'baseline', 'snapshot', 'sourceLabel', 'accent']) {
    if (data.meta[key] !== undefined) text(data.meta[key], `meta.${key}`, false);
  }
  if (data.meta.accent && !['lime', 'teal', 'blue', 'amber', 'violet'].includes(data.meta.accent)) fail('meta.accent 不受支持');
  if (data.summary !== undefined) {
    list(data.summary, 'summary').forEach((item, i) => { text(item.label, `summary[${i}].label`); text(String(item.value), `summary[${i}].value`); });
  }
  const views = list(data.views, 'views');
  if (!views.length) fail('views 至少需要一个视图');
  const viewIds = new Set();
  for (const [index, view] of views.entries()) {
    const at = `views[${index}]`;
    id(view.id, `${at}.id`);
    if (viewIds.has(view.id)) fail(`views 存在重复 id：${view.id}`);
    viewIds.add(view.id);
    text(view.label, `${at}.label`); text(view.title, `${at}.title`);
    if (view.description !== undefined) text(view.description, `${at}.description`, false);
    if (!TYPES.has(view.type)) fail(`${at}.type 不受支持：${view.type}`);
    const items = list(view.items, `${at}.items`);
    if (!items.length) fail(`${at}.items 不能为空`);
    unique(items, `${at}.items`);
    items.forEach((item, i) => {
      const itemAt = `${at}.items[${i}]`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${itemAt} 必须是对象`);
      if (view.type === 'metrics') {
        text(item.name, `${itemAt}.name`);
        for (const key of ['before', 'after']) if (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0) fail(`${itemAt}.${key} 必须是非负有限数值`);
        if (item.format && !['number', 'bytes'].includes(item.format)) fail(`${itemAt}.format 不受支持`);
      } else if (view.type !== 'table') {
        text(item.title, `${itemAt}.title`);
      }
      if (view.type === 'tasks' && !STATUSES.has(item.status)) fail(`${itemAt}.status 不受支持：${item.status}`);
      for (const key of ['tags', 'facts', 'upgrades', 'can', 'cannot']) strings(item[key], `${itemAt}.${key}`);
    });
    if (view.type === 'table') {
      if (!Array.isArray(view.columns) || !view.columns.length) fail(`${at}.columns 至少需要一列`);
      view.columns.forEach((column, i) => { text(column.key, `${at}.columns[${i}].key`); text(column.label, `${at}.columns[${i}].label`); });
    }
    for (const key of ['blockers', 'next']) {
      if (view[key] !== undefined) list(view[key], `${at}.${key}`).forEach((item, i) => text(item.title, `${at}.${key}[${i}].title`));
    }
  }
  return data;
}
function args(argv) {
  const result = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') result.force = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--input' || arg === '--output') {
      const key = arg.slice(2);
      if (!argv[i + 1]) fail(`${arg} 缺少路径`);
      result[key] = argv[++i];
    } else fail(`未知参数：${arg}`);
  }
  return result;
}
function main() {
  const options = args(process.argv.slice(2));
  if (options.help || !options.input || !options.output) {
    console.log('用法：node generate.mjs --input <data.json> --output <page.html> [--force]');
    if (options.help) return;
    fail('必须同时提供 --input 和 --output');
  }
  const input = path.resolve(process.cwd(), options.input);
  const output = path.resolve(process.cwd(), options.output);
  if (fs.existsSync(output) && !options.force) fail(`输出已存在：${output}；确认覆盖时添加 --force`);
  let data;
  try { data = JSON.parse(fs.readFileSync(input, 'utf8')); } catch (error) { fail(`无法读取 JSON：${error.message}`); }
  validate(data);
  const template = fs.readFileSync(path.join(SKILL_DIR, 'assets', 'template.html'), 'utf8');
  const marker = '/*__PROJECT_DATA__*/';
  if (template.split(marker).length !== 2) fail('模板数据占位符缺失或重复');
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const html = template.replace(marker, () => json);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (!scripts.length) fail('模板缺少主脚本');
  scripts.forEach((match, index) => new vm.Script(match[1], { filename: `observatory-${index}.js` }));
  if (/<script[^>]+src=/i.test(html)) fail('输出不得依赖外部脚本');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, html, 'utf8');
  console.log(`已生成：${output}（${data.views.length} 个视图）`);
}
try { main(); } catch (error) { console.error(`生成失败：${error.message}`); process.exitCode = 1; }
