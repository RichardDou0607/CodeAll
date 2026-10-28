#!/usr/bin/env node
// scripts/linux-sandbox/check.mjs — Linux 验证机体检：连接 / 系统 / GUI 会话 / 工具链 / Agent CLI 矩阵
//
//   node scripts/linux-sandbox/check.mjs
//   LINUX_HOST=ubuntu node scripts/linux-sandbox/check.mjs
//
// 前提：~/.ssh/config 里已配 Host ubuntu（richard@ 免密）。
// 通过标准：SSH 免密可达 + node/git/tar 可用即退出码 0；Agent CLI 缺失只告警不计失败
//（那正是 docs/24 PLAT-0 可用性矩阵要记录的数据）。
// 关键点：GUI 会话类型必须经 loginctl 查 graphical 会话，不能看 ssh 自身环境变量
//（ssh 会话的 XDG_SESSION_TYPE 为空 / 是 tty，会误判）。

import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const HOST = process.env.LINUX_HOST || 'ubuntu';

const ssh = (cmd) =>
  new Promise((resolve) => {
    execFile(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', HOST, cmd],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: stdout, err: stderr })
    );
  });

const kv = (out) => {
  const m = {};
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) m[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return m;
};

function printf(fmt, ...args) {
  process.stdout.write(
    fmt.replace(/%(-?\d*)s/g, (_, w) => {
      const s = String(args.shift() ?? '');
      const n = parseInt(w, 10);
      return isNaN(n) ? s : (n < 0 ? s.padEnd(-n) : s.padStart(n));
    }) + '\n'
  );
}
const row = (k, v) => printf('  %-14s %s', k, v);

// --- 连接（顺带测延迟） ---
const t0 = performance.now();
const ping = await ssh('echo ok');
const latency = Math.round(performance.now() - t0);
if (!ping.ok) {
  console.error(`✗ SSH 免密不可达：${HOST}\n  ${ping.err.trim()}`);
  process.exit(1);
}

// --- 系统清单（sh -c 保 POSIX；bash -l 用于 PATH 敏感项） ---
const sys = kv(
  (
    await ssh(
      `echo "OS=$(. /etc/os-release && echo \$PRETTY_NAME)"; ` +
        `echo "ARCH=$(uname -m)"; echo "KERNEL=$(uname -r)"; echo "CPU_N=$(nproc)"; ` +
        `echo "RAM_GB=\$(LANG=C free -g | awk 'NR==2{print \$2}')"; ` +
        `echo "DISK_FREE_GB=\$(df -BG / | awk 'NR==2{print \$4}')"; ` +
        `echo "DESKTOP_PKG=\$(dpkg -l ubuntu-desktop 2>/dev/null | tail -1 | awk '{print \$1}')"`
    )
  ).out
);

// --- GUI 会话类型（loginctl，防 ssh env 误判；docs/24 W06 的 X11/Wayland 分界） ---
const sessOut = (
  await ssh(
    `for s in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do ` +
      `t=$(loginctl show-session $s -p Type --value 2>/dev/null); ` +
      `n=$(loginctl show-session $s -p Name --value 2>/dev/null); ` +
      `[ "$t" = x11 ] || [ "$t" = wayland ] && echo "GUI=$t"; done; true`
  )
).out;
const gui = [...new Set(sessOut.split(/\r?\n/).filter((l) => l.startsWith('GUI=')).map((l) => l.slice(4)))];

// --- 工具链（登录态 PATH；node 装在 ~/.local/bin） ---
const tools = kv(
  (
    await ssh(
      `for t in node npm pnpm git tar curl cargo rustc; do ` +
        `p=$(bash -lc "command -v $t" 2>/dev/null); ` +
        `if [ -n "$p" ]; then echo "$t=OK"; else echo "$t=MISSING"; fi; done`
    )
  ).out
);

// --- Agent CLI（六源；docs/24 PLAT-0 可用性矩阵输入） ---
const agents = kv(
  (
    await ssh(
      `for t in claude codex kimi qoderclicn opencode cursor-agent; do ` +
        `p=$(bash -lc "command -v $t" 2>/dev/null); ` +
        `if [ -n "$p" ]; then echo "$t=OK"; else echo "$t=MISSING"; fi; done`
    )
  ).out
);

// --- 桌面 App（.desktop 反查；docs/22 Linux 口径：/usr/share + ~/.local/share + flatpak/snap） ---
const desktops = kv(
  (
    await ssh(
      `for id in dsh zcode kimi-code codex-pp cursor qoder; do ` +
        `f=$(find /usr/share/applications "$HOME/.local/share/applications" /var/lib/flatpak/exports/share/applications "$HOME/.local/share/flatpak/exports/share/applications" -maxdepth 1 -iname "*$id*.desktop" 2>/dev/null | head -1); ` +
        `if [ -n "$f" ]; then echo "$id=OK ($(basename "$f"))"; else echo "$id=MISSING"; fi; done; ` +
        `command -v flatpak >/dev/null && echo "flatpak=OK" || echo "flatpak=MISSING"; ` +
        `command -v snap >/dev/null && echo "snap=OK" || echo "snap=MISSING"`
    )
  ).out
);

// --- DSH 数据目录（有无 Linux 发行版的第一手信号） ---
const dsh = kv((await ssh(`[ -d "$HOME/.dsh" ] && echo "dsh_dir=OK" || echo "dsh_dir=MISSING"; command -v dsh >/dev/null && echo "dsh_cli=OK" || echo "dsh_cli=MISSING"`)).out);

console.log(`Linux 验证机体检（${HOST}）`);
console.log('— 连接');
row('ssh 免密', `OK（往返 ${latency} ms）`);
console.log('— 系统');
for (const k of ['OS', 'ARCH', 'KERNEL', 'CPU_N', 'RAM_GB', 'DISK_FREE_GB', 'DESKTOP_PKG']) row(k, sys[k] ?? '?');
console.log('— GUI 会话（loginctl）');
row('类型', gui.length ? gui.join(' + ') : '无图形会话（W06 窗口项不可测）');
console.log('— 工具链');
for (const k of ['node', 'npm', 'pnpm', 'git', 'tar', 'curl', 'cargo', 'rustc']) row(k, tools[k] ?? '?');
console.log('— Agent CLI（可用性矩阵）');
for (const k of ['claude', 'codex', 'kimi', 'qoderclicn', 'opencode', 'cursor-agent']) row(k, agents[k] ?? '?');
console.log('— 桌面 App（.desktop 反查）');
for (const k of ['dsh', 'zcode', 'kimi-code', 'codex-pp', 'cursor', 'qoder', 'flatpak', 'snap']) row(k, desktops[k] ?? '?');
console.log('— DSH');
for (const k of ['dsh_dir', 'dsh_cli']) row(k, dsh[k] ?? '?');

// --- 结论 ---
const fatal = [];
if (tools.node !== 'OK') fatal.push('node 缺失（~/.local/bin）');
if (tools.git !== 'OK') fatal.push('git 缺失');
if (fatal.length) {
  console.error(`✗ 验证机不可用：${fatal.join('；')}`);
  process.exit(1);
}
console.log('✓ 验证机可用：连接/系统/工具链全过；缺的 Agent CLI / 桌面 App 见上表（矩阵数据，不计失败）');
