#!/usr/bin/env node
/**
 * scripts/platform-check.mjs — 平台层快照自检（v0.2.0 PLAT-1，docs/24 §2）
 *
 *   node scripts/platform-check.mjs
 *
 * 在每个平台上打印并断言平台层的核心能力：
 *   1. 进程快照可取（行格式 pid\tname\targs，Windows 行内无反斜杠）
 *   2. CLI 二进制解析（本机已装的 claude/kimi 等能解析出绝对路径）
 *   3. spawn 目标解包（Windows npm shim 解出 node + 入口 js；unix 直通）
 *   4. 插件 socket 地址（unix 路径 / 命名管道前缀）
 *   5. 桌面 App 注册表反查（Windows；列出 Uninstall 表内已知的 Agent 桌面端）
 *   6. appSupport 数据目录（观察源数据目录存在性一览）
 * 断言失败退出码 1；探测不到的内容（该平台没有的东西）只记录不计失败。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IS_WIN, IS_MAC, IS_LINUX, HOME,
  appSupport, localData, npmGlobalCandidates,
  listProcesses, appVersion, resolveCliBinPath, resolveSpawnCommand,
  pluginSocketPath, desktopAppDir,
} from '../adapters/platform.mjs';

let failed = 0;
const ok = (cond, label, detail = '') => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + label + (detail ? '  — ' + detail : ''));
  if (!cond) failed++;
};
const info = (label, detail = '') => console.log('  ℹ️  ' + label + (detail ? '  — ' + detail : ''));

console.log('平台快照自检 @ ' + process.platform + '/' + process.arch + '  node ' + process.version + '  host ' + os.hostname());

// 1. 进程快照
const lines = await listProcesses();
ok(lines.length > 10, '进程快照行数 ' + lines.length);
if (IS_WIN) {
  ok(lines.every((l) => !l.includes('\\')), '快照行无反斜杠（归一化生效）');
  ok(lines.every((l) => /^\d+\t/.test(l)), '快照行 pid\\t 前缀（CIM 统一格式）');
} else {
  ok(lines.filter(Boolean).every((l) => /^\s*\d+\s/.test(l)), '快照行 pid 前缀（ps 格式）');
}
info('样例', (lines.find((l) => /node|powershell/i.test(l)) || lines[0] || '').slice(0, 100));

// 2/3. CLI 解析与 spawn 目标
for (const name of ['node', 'claude', 'codex', 'kimi', 'zcode', 'opencode', 'cursor-agent', 'qoderclicn']) {
  const p = resolveCliBinPath(name, name === 'kimi' ? [path.join(HOME, '.kimi-code', 'bin', IS_WIN ? 'kimi.exe' : 'kimi')] : []);
  if (!p) { info('CLI ' + name + ' 未找到（未安装不计失败）'); continue; }
  ok(path.isAbsolute(p), 'CLI ' + name + ' → ' + p);
  const t = resolveSpawnCommand(p);
  if (IS_WIN && /\.(cmd|ps1|bat)$/i.test(p)) {
    if (t.needsCmdQuote) info('spawn 解包 ' + name + ' 降级 cmd（shim 内未提取到入口，常为损坏安装）');
    else ok(!!t && (t.prefixArgs.length > 0 || /\.exe$/i.test(t.file)), 'spawn 解包 ' + name + ' → ' + t.file + (t.prefixArgs.length ? ' + [' + t.prefixArgs.join(' ') + ']' : ''));
  } else {
    ok(!!t && t.file === p, 'spawn 直通 ' + name);
  }
}

// 4. 插件 socket
const sock = pluginSocketPath();
if (IS_WIN) ok(sock.startsWith('\\\\.\\pipe\\'), '插件通道命名管道 ' + sock);
else ok(sock.includes('agent-pet'), '插件通道 unix socket ' + sock);

// 5. 桌面 App 反查（Windows 注册表 / mac /Applications；未装只记录）
const APPS = ['dsh', 'zcode', 'kimi-code', 'codex-pp', 'cursor', 'qoder'];
for (const id of APPS) {
  const d = await desktopAppDir(id);
  if (d) ok(fs.existsSync(d), '桌面 App ' + id + ' → ' + d);
  else info('桌面 App ' + id + ' 未检出（未安装不计失败）');
}

// 6. 数据目录一览（观察源是否接得上）
const DIRS = [
  ['dsh', path.join(HOME, '.dsh')],
  ['claude', path.join(HOME, '.claude', 'projects')],
  ['codex', path.join(HOME, '.codex', 'sessions')],
  ['kimi', path.join(HOME, '.kimi-code')],
  ['zcode', path.join(HOME, '.zcode')],
  ['opencode', path.join(HOME, '.local', 'share', 'opencode')],
  ['cursor-chats', path.join(HOME, '.cursor', 'chats')],
  ['kimi-app-leveldb', appSupport('kimi-code-app', 'Local Storage', 'leveldb')],
  ['cursor-app', appSupport('Cursor')],
  ['qoder-app', appSupport('com.qodercn.app.stable')],
  ['claude-3p (桌面内置 CLI)', localData('Claude-3p')],
  ['openai-codex (桌面)', localData('OpenAI', 'Codex')],
];
for (const [name, d] of DIRS) info('数据目录 ' + name + (fs.existsSync(d) ? ' ✓ 存在' : '（不存在）') , d);

// 版本读取抽查（对存在的 exe/app）
for (const id of APPS) {
  const d = await desktopAppDir(id);
  if (!d) continue;
  const exeNames = { dsh: 'DeepSeek Harness.exe', zcode: 'ZCode.exe', 'kimi-code': 'Kimi Code.exe', 'codex-pp': 'Codex++.exe', cursor: 'Cursor.exe', qoder: 'Qoder CN.exe' };
  const exe = path.join(d, exeNames[id] || '');
  if (process.platform === 'darwin') { const v = await appVersion(d); info('版本 ' + id, v || '（读不到）'); continue; }
  if (fs.existsSync(exe)) { const v = await appVersion(exe); ok(!!v, '版本 ' + id + '（PE 元数据）', v || '空'); }
}

if (failed) { console.log('\n❌ ' + failed + ' 项断言失败'); process.exit(1); }
console.log('\n✅ 平台层自检通过（' + process.platform + '）');
