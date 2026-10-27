#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(root, 'apps', 'shell', 'src-tauri', 'resources', 'app');
execFileSync(process.execPath, [path.join(root, 'apps', 'shell', 'tools', 'bundle-service.mjs')], { cwd: root, stdio: 'pipe' });

const missing = [];
const visit = dir => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { visit(file); continue; }
    if (!entry.name.endsWith('.mjs')) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.\.?\/[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      if (!fs.existsSync(target)) missing.push(path.relative(stage, file) + ' -> ' + match[1]);
    }
  }
};
visit(stage);
assert.deepEqual(missing, [], '独立安装包缺少相对导入文件');
console.log('独立安装包：全部相对导入均已暂存');
