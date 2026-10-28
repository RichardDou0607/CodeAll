#!/usr/bin/env node
// scripts/linux-sandbox/sock-probe.mjs — 插件通道 unix socket 权限红线探针（PLAT-3，对位 win11 acl-probe.mjs）
//
//   node scripts/linux-sandbox/sock-probe.mjs            # 在 Linux 验证机上跑（exec.sh 工作区内）
//   PROBE_SOCK=/tmp/x.sock node scripts/linux-sandbox/sock-probe.mjs
//   SKIP_CROSS_USER=1 …                                   # 跳过跨用户实证（无 sudo/nobody 时自动跳）
//
// 断言（对位 docs/36 §8.2 命名管道 ACL 红线的 unix 语义）：
//   1. listen 后 socket 权限恰为 0600，父目录恰为 0700（plugins/dsh-pet/pipe-acl.mjs secureNamedPipe）
//   2. 本用户 http-over-unix-socket 可达（正对照）
//   3. 跨用户（sudo -u nobody）连入必须失败（负对照——win11 侧做不了的实验，本机 VM 可做）
// 任何一条不满足 → 退出码 1（红线不成立）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { secureNamedPipe } from '../../plugins/dsh-pet/pipe-acl.mjs';

const SOCK = process.env.PROBE_SOCK || path.join(os.tmpdir(), `sock-probe-${process.pid}`, 'dsh-plugin.sock');
const say = (m) => console.log('[sock-probe] ' + m);
let failures = 0;
const assert = (cond, label, detail) => {
  say((cond ? '✅ ' : '❌ ') + label + (detail ? '（' + detail + '）' : ''));
  if (!cond) failures++;
};

fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 });
try { fs.unlinkSync(SOCK); } catch { /* 无陈旧文件 */ }

const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
await new Promise((resolve, reject) => server.listen(SOCK, resolve).once('error', reject));
try {
  await secureNamedPipe(SOCK);   // 与插件 listen() 同一调用点：失败即关监听
} catch (e) {
  server.close();
  say('❌ secureNamedPipe 失败（插件侧语义=关监听）：' + String(e.message || e));
  process.exit(1);
}

// --- 1. 权限位 ---
const sockMode = fs.statSync(SOCK).mode & 0o777;
const dirMode = fs.statSync(path.dirname(SOCK)).mode & 0o777;
assert(sockMode === 0o600, 'socket 权限 0600', '实际 ' + sockMode.toString(8));
assert(dirMode === 0o700, 'socket 父目录权限 0700', '实际 ' + dirMode.toString(8));

// --- 2. 正对照：本用户可达 ---
const localOk = await new Promise((resolve) => {
  const req = http.request({ socketPath: SOCK, path: '/', method: 'GET', timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
  req.end();
});
assert(localOk, '本用户连入可达（正对照）');

server.close();

// --- 3. 负对照：跨用户拒连 ---
if (process.env.SKIP_CROSS_USER === '1') {
  say('⏭ 跨用户实证跳过（SKIP_CROSS_USER=1）');
} else {
  let rejected = false, detail = '';
  try {
    execFileSync('sudo', ['-n', '-u', 'nobody', 'curl', '--max-time', '3', '-s', '-o', '/dev/null', '--unix-socket', SOCK, 'http://localhost/'], { stdio: 'pipe' });
    rejected = false;
  } catch (e) {
    rejected = true;
    detail = String(e.status ?? e.message).slice(0, 80);
  }
  assert(rejected, '跨用户（nobody）连入被拒（负对照）', detail);
}

try { fs.rmSync(path.dirname(SOCK), { recursive: true, force: true }); } catch { /* 清理失败不碍结论 */ }
say(failures === 0 ? '✅ socket 红线全过' : `❌ ${failures} 条红线不成立`);
process.exit(failures === 0 ? 0 : 1);
