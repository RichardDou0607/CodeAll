#!/usr/bin/env node
// scripts/win11-sandbox/check.mjs — Win11 沙箱体检：连接 / 系统 / 工具链 / Agent CLI 矩阵
//
//   node scripts/win11-sandbox/check.mjs
//   WIN11_HOST=win11 node scripts/win11-sandbox/check.mjs   // 换 ssh Host 别名
//
// 前提：~/.ssh/config 里已配 Host win11（admin@laptop-4iuhjjdd 免密，Tailscale 组网）。
// 通过标准：SSH 免密可达 + node/tar 可用即退出码 0；Agent CLI 缺失只告警不计失败
//（那正是 docs/24 PLAT-0 可用性矩阵要记录的数据）。
// 坑：沙箱默认 shell 是 cmd，中文输出 GBK 乱码——所有探测统一走
//   powershell -NoProfile 且先设 [Console]::OutputEncoding=UTF8。

import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const HOST = process.env.WIN11_HOST || 'win11';

const ssh = (cmd) =>
  new Promise((resolve) => {
    execFile(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', HOST, cmd],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: stdout, err: stderr })
    );
  });

const ps = (expr) =>
  ssh(`powershell -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${expr}"`);

const kv = (out) => {
  const m = {};
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) m[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return m;
};

const row = (k, v) => printf('  %-14s %s', k, v);
function printf(fmt, ...args) {
  process.stdout.write(
    fmt.replace(/%(-?\d*)s/g, (_, w) => {
      const s = String(args.shift() ?? '');
      const n = parseInt(w, 10);
      return isNaN(n) ? s : (n < 0 ? s.padEnd(-n) : s.padStart(n));
    }) + '\n'
  );
}

// --- 连接（顺带测延迟） ---
const t0 = performance.now();
const ping = await ssh('echo ok');
const latency = Math.round(performance.now() - t0);
if (!ping.ok) {
  console.error(`✗ SSH 免密不可达：${HOST}\n  ${ping.err.trim()}`);
  console.error('  先确认：ssh ' + HOST + ' whoami（应输出 laptop-4iuhjjdd\\admin）');
  process.exit(1);
}

// --- 系统清单 ---
const sys = kv(
  (
    await ps(
      `$os=Get-CimInstance Win32_OperatingSystem; $cs=Get-CimInstance Win32_ComputerSystem; ` +
        `$cpu=Get-CimInstance Win32_Processor|Select-Object -First 1; ` +
        `'OS='+$os.Caption+' build '+$os.BuildNumber; ` +
        `'HOST='+$cs.Manufacturer+' '+$cs.Model; ` +
        `'CPU='+$cpu.Name.Trim(); ` +
        `'RAM_GB='+[math]::Round($cs.TotalPhysicalMemory/1GB,1); ` +
        `'C_FREE_GB='+[math]::Round((Get-PSDrive C).Free/1GB,1); ` +
        `'UPTIME_H='+[math]::Round(((Get-Date)-$os.LastBootUpTime).TotalHours,1)`
    )
  ).out
);

// --- 工具链 ---
const tools = kv(
  (
    await ps(
      `foreach($t in @('node','npm','git','tar','curl.exe','code')){ ` +
        `$c=Get-Command $t -ErrorAction SilentlyContinue; ` +
        `if($c){ Write-Output ($t + '=OK') } else { Write-Output ($t + '=MISSING') } }`
    )
  ).out
);

// --- Agent CLI（六源；docs/24 PLAT-0 可用性矩阵输入） ---
const agents = kv(
  (
    await ps(
      `foreach($t in @('claude','codex','kimi','qoderclicn','opencode','cursor-agent')){ ` +
        `$c=Get-Command $t -ErrorAction SilentlyContinue; ` +
        `if($c){ Write-Output ($t + '=OK') } else { Write-Output ($t + '=MISSING') } }`
    )
  ).out
);

console.log(`Win11 沙箱体检（${HOST}）`);
console.log('— 连接');
row('ssh 免密', `OK（往返 ${latency} ms）`);
console.log('— 系统');
for (const k of ['OS', 'HOST', 'CPU', 'RAM_GB', 'C_FREE_GB', 'UPTIME_H']) row(k, sys[k] ?? '?');
console.log('— 工具链');
for (const k of ['node', 'npm', 'git', 'tar', 'curl.exe', 'code']) row(k, tools[k] ?? '?');
console.log('— Agent CLI（可用性矩阵）');
for (const k of ['claude', 'codex', 'kimi', 'qoderclicn', 'opencode', 'cursor-agent'])
  row(k, agents[k] ?? '?');

// --- 结论 ---
const fatal = [];
if (tools.node !== 'OK') fatal.push('node 缺失');
if (tools.tar !== 'OK') fatal.push('tar 缺失（bsdtar 应随 Win10+ 预装）');
if (fatal.length) {
  console.error(`✗ 沙箱不可用：${fatal.join('；')}`);
  process.exit(1);
}
console.log('✓ 沙箱可用：连接/系统/工具链全过；缺的 Agent CLI 见上表（矩阵数据，不计失败）');
