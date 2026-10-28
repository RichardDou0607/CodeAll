#!/usr/bin/env node
// scripts/linux-sandbox/redline.mjs — Linux 机制红线汇总门（PLAT-3 L7；对位 docs/36 §8.3 W02 红线体系）
//
//   node scripts/linux-sandbox/redline.mjs            # 对 127.0.0.1:7799 的运行中服务断言（默认）
//   REDLINE_PORT=7800 node scripts/linux-sandbox/redline.mjs
//   REDLINE_SKIP_SOCK=1 …                              # 跳过 socket 探针（另行单独跑）
//
// 断言清单（任一失败退出码 1）：
//   1. /api/state → 200（读接口免 token 是既有设计）
//   2. 错 Host → 403（DNS rebinding 防线）
//   3. 写接口无 token → 401（写鉴权是红线本体）
//   4. token 文件存在且 0600
//   5. 服务只绑 127.0.0.1（不暴露局域网）
//   6. ~/.agent-pet 下队列/计划类文件 0600（存在才查，不虚构）
//   7. 插件 socket 权限（调 sock-probe.mjs；可跳过）

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = process.env.REDLINE_PORT || '7799';
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const assert = (cond, label, detail = '') => {
  console.log(`[redline] ${cond ? '✅' : '❌'} ${label}${detail ? '（' + detail + '）' : ''}`);
  if (!cond) failures++;
};
const codeOf = (curlArgs) => execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', ...curlArgs], { encoding: 'utf8' }).trim();

// 1-3. HTTP 断言
assert(codeOf([`${BASE}/api/state`]) === '200', '/api/state → 200');
assert(codeOf(['-H', 'Host: evil.example', `${BASE}/api/state`]) === '403', '错 Host → 403');
assert(codeOf(['-X', 'POST', '-H', 'Content-Type: application/json', '-d', '{}', `${BASE}/api/input`]) === '401', '写接口无 token → 401');

// 4. token 文件
const tokenPath = path.join(os.homedir(), '.agent-pet', 'token');
try {
  const mode = (fs.statSync(tokenPath).mode & 0o777).toString(8);
  assert(mode === '600', 'token 文件 0600', `实际 ${mode}`);
} catch {
  // 没有写操作发生时 token 可能未生成——服务跑过一轮投递才落盘；此时记 skip 而非 fail
  console.log('[redline] ⏭ token 文件不存在（尚无写操作落盘；跑一次投递后复测第 4 条）');
}

// 5. 只绑回环（ss 输出第 4 列是本址；对端列 0.0.0.0:* 是监听 socket 的常态,不看）
let loopbackOnly = false, detail = '';
try {
  const out = execFileSync('ss', ['-ltn', `sport = :${PORT}`], { encoding: 'utf8' });
  const local = out.split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 4 && f[3].endsWith(':' + PORT)).map((f) => f[3]);
  loopbackOnly = local.length > 0 && local.every((a) => a.startsWith('127.0.0.1:') || a.startsWith('[::1]:'));
  detail = local.join(' ');
} catch { /* ss 缺失按失败 */ }
assert(loopbackOnly, '服务只绑 127.0.0.1', detail);

// 6. 队列/计划文件 0600（存在才查）
const petDir = path.join(os.homedir(), '.agent-pet');
try {
  const names = fs.readdirSync(petDir).filter((n) => /\.(queue|plan|jsonl)$/i.test(n));
  for (const n of names.slice(0, 10)) {
    const mode = (fs.statSync(path.join(petDir, n)).mode & 0o777).toString(8);
    assert(mode === '600', `队列/计划文件 ${n} 0600`, `实际 ${mode}`);
  }
  if (!names.length) console.log('[redline] ⏭ ~/.agent-pet 下暂无队列/计划文件（第 6 条不适用）');
} catch { /* 目录不存在同上 */ }

// 7. socket 红线
if (process.env.REDLINE_SKIP_SOCK === '1') {
  console.log('[redline] ⏭ socket 探针跳过（REDLINE_SKIP_SOCK=1；单独跑 sock-probe.mjs）');
} else {
  try {
    execFileSync('node', [new URL('./sock-probe.mjs', import.meta.url).pathname], { stdio: 'inherit' });
  } catch {
    assert(false, 'sock-probe 子断言（socket 0600/0700/跨用户拒连）');
  }
}

console.log(failures === 0 ? '[redline] ✅ 机制红线全绿' : `[redline] ❌ ${failures} 条红线不成立`);
process.exit(failures === 0 ? 0 : 1);
