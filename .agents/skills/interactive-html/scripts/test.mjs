#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generator = path.join(skill, 'scripts', 'generate.mjs');
const example = path.join(skill, 'examples', 'project.json');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-html-test-'));
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const run = (input, output, extra = []) => spawnSync(process.execPath, [generator, '--input', input, '--output', output, ...extra], { encoding: 'utf8' });

try {
  const output = path.join(temp, 'observatory.html');
  const generated = run(example, output);
  check(generated.status === 0, `示例生成失败：${generated.stderr}`);
  const html = fs.readFileSync(output, 'utf8');
  check(html.includes('Acme 工程观测台'), '输出应包含项目标题');
  for (const label of ['系统模块', '性能对比', '版本演进', '开发进度', '平台矩阵']) check(html.includes(label), `输出缺少视图：${label}`);
  check(html.includes('<progress'), '任务视图应使用原生 progress');
  check(html.includes('prefers-reduced-motion:reduce'), '模板应支持减少动画偏好');
  check(html.includes('.responsive-table caption{display:block;inline-size:100%}'), '窄屏表格说明应保持全宽');
  check(!html.includes('/*__PROJECT_DATA__*/'), '数据占位符必须被替换');
  check(!/<script[^>]+src=/i.test(html), '输出不得依赖外部脚本');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  check(scripts.length === 1, '输出应只有一个主脚本');
  scripts.forEach(source => new vm.Script(source));
  checks++;

  const again = run(example, output);
  check(again.status !== 0 && again.stderr.includes('输出已存在'), '默认必须拒绝覆盖');
  const forced = run(example, output, ['--force']);
  check(forced.status === 0, `显式 --force 应允许覆盖：${forced.stderr}`);

  const base = JSON.parse(fs.readFileSync(example, 'utf8'));
  const unsafe = { meta: { project: '</script><script>alert(1)</script>' }, views: [{ id: 'safe', label: '安全', title: '安全', type: 'cards', items: [{ id: 'one', title: 'one' }] }] };
  const unsafeInput = path.join(temp, 'unsafe.json');
  const unsafeOutput = path.join(temp, 'unsafe.html');
  fs.writeFileSync(unsafeInput, JSON.stringify(unsafe));
  check(run(unsafeInput, unsafeOutput).status === 0, '含脚本形状字符串的数据仍应安全生成');
  const unsafeHtml = fs.readFileSync(unsafeOutput, 'utf8');
  check(!unsafeHtml.includes('</script><script>alert(1)</script>'), '数据不得突破主脚本上下文');
  check(unsafeHtml.includes('\\u003c/script>'), '小于号应转义为 Unicode');

  const invalid = structuredClone(base);
  invalid.views.find(view => view.type === 'tasks').items[0].status = 'almost-done';
  const invalidInput = path.join(temp, 'invalid.json');
  fs.writeFileSync(invalidInput, JSON.stringify(invalid));
  check(run(invalidInput, path.join(temp, 'invalid.html')).status !== 0, '非法任务状态必须被拒绝');

  const duplicate = structuredClone(base);
  duplicate.views[1].id = duplicate.views[0].id;
  const duplicateInput = path.join(temp, 'duplicate.json');
  fs.writeFileSync(duplicateInput, JSON.stringify(duplicate));
  check(run(duplicateInput, path.join(temp, 'duplicate.html')).status !== 0, '重复视图 ID 必须被拒绝');

  const negative = structuredClone(base);
  negative.views.find(view => view.type === 'metrics').items[0].before = -1;
  const negativeInput = path.join(temp, 'negative.json');
  fs.writeFileSync(negativeInput, JSON.stringify(negative));
  check(run(negativeInput, path.join(temp, 'negative.html')).status !== 0, '负指标必须被拒绝');

  console.log(`Interactive HTML Skill：${checks} 项检查通过`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
