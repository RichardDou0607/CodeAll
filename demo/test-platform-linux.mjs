#!/usr/bin/env node
// demo/test-platform-linux.mjs — 平台层 Linux 分支单测（PLAT-3；手法同 test-platform-windows.mjs：
// Object.defineProperty(process,'platform') 伪装 + import 查询串击穿 ESM 缓存，拿到隔离的模块实例）
//
//   node --test demo/test-platform-linux.mjs        # mac/win/linux 上都可跑（测的是 linux 伪装分支）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-platform-linux-test-'));
const platform = async (tag) => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  return import('../adapters/platform.mjs?' + tag);
};
const write = (file, text, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, mode);
  return file;
};

test('desktopAppDirLinux：deb 布局经 /usr/bin 符号链解到真实安装目录', async () => {
  const home = path.join(root, 'deb');
  const realBin = write(path.join(home, 'usr', 'lib', 'zcode', 'zcode'), '#!/bin/sh\n', 0o755);
  const wrapper = path.join(home, 'usr', 'bin', 'zcode');
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.symlinkSync(realBin, wrapper);
  write(path.join(home, 'share', 'applications', 'zcode.desktop'),
    '[Desktop Entry]\nType=Application\nName=ZCode\nExec=' + wrapper + ' %U\n');
  process.env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  process.env.XDG_DATA_DIRS = path.join(home, 'share');
  const { desktopAppDirSync } = await platform('linux-deb');
  assert.equal(desktopAppDirSync('zcode'), path.dirname(fs.realpathSync(realBin)));
});

test('desktopAppDirLinux：AppImage 返回其所在目录', async () => {
  const home = path.join(root, 'appimage');
  const img = write(path.join(home, 'apps', 'Kimi-2.3.3-arm64.AppImage'), '!', 0o755);
  write(path.join(home, '.local', 'share', 'applications', 'kimi.desktop'),
    '[Desktop Entry]\nType=Application\nName=Kimi\nExec=' + img + '\n');
  process.env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  const { desktopAppDirSync } = await platform('linux-appimage');
  assert.equal(desktopAppDirSync('kimi-code'), path.join(home, 'apps'));
});

test('desktopAppDirLinux：flatpak run 无资源目录语义 → null', async () => {
  const home = path.join(root, 'flatpak');
  write(path.join(home, '.local', 'share', 'applications', 'org.zcode.Zcode.desktop'),
    '[Desktop Entry]\nType=Application\nName=ZCode\nExec=flatpak run --branch=stable org.zcode.Zcode %U\n');
  process.env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  const { desktopAppDirSync } = await platform('linux-flatpak');
  assert.equal(desktopAppDirSync('zcode'), null);
});

test('desktopAppDirLinux：无 .desktop（CLI-only 安装）→ null', async () => {
  const home = path.join(root, 'nodesk');
  process.env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  process.env.XDG_DATA_DIRS = path.join(home, 'share');
  const { desktopAppDirSync } = await platform('linux-nodesk');
  assert.equal(desktopAppDirSync('qoder'), null);
});

test('appVersion：可执行文件 --version 输出提取版本 token', async () => {
  const home = path.join(root, 'ver');
  const bin = write(path.join(home, 'bin', 'zcode'), '#!/bin/sh\necho "zcode 3.16.3 (linux-arm64)"\n', 0o755);
  const { appVersion } = await platform('linux-ver');
  assert.equal(await appVersion(bin), '3.16.3');
});

test('appVersion：目录读不出 → null 如实', async () => {
  const dir = path.join(root, 'ver-dir', 'pkg');
  fs.mkdirSync(dir, { recursive: true });
  const { appVersion } = await platform('linux-ver-dir');
  assert.equal(await appVersion(dir), null);
});

test('pluginSocketPath：unix 走 $TMPDIR/agent-pet/dsh-plugin.sock', async () => {
  const { pluginSocketPath } = await platform('linux-sock');
  const p = pluginSocketPath();
  assert.equal(p, path.join(os.tmpdir(), 'agent-pet', 'dsh-plugin.sock'));
});

test('openTerminalWindow：xdg-terminal-exec 缺位回落 gnome-terminal（带 cwd）', async () => {
  const dir = path.join(root, 'fallback-cwd');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(root, 'fallback-args.txt');
  const bin = write(path.join(root, 'bin2', 'gnome-terminal'),
    '#!/bin/sh\nprintf %s "$@" > "$OUT"\nexit 0\n', 0o755);
  const previous = process.env.PATH;
  process.env.PATH = path.dirname(bin) + path.delimiter + '/usr/bin:/bin';
  process.env.OUT = out;
  const { openTerminalWindow } = await platform('linux-fallback');
  const result = await openTerminalWindow({ cwd: dir, env: {}, file: '/bin/echo', args: [] });
  process.env.PATH = previous;
  delete process.env.OUT;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.via, 'gnome-terminal');
  const args = fs.readFileSync(out, 'utf8').split('\x00').length ? fs.readFileSync(out, 'utf8') : fs.readFileSync(out, 'utf8');
  assert.ok(args.includes('--working-directory'), '应带 --working-directory');
  assert.ok(args.includes(dir), 'cwd 应为目标目录');
});

test('openTerminalWindow：三级全缺 → ok:false 如实报错', async () => {
  const emptyBin = path.join(root, 'empty-bin');
  fs.mkdirSync(emptyBin, { recursive: true });
  const previous = process.env.PATH;
  process.env.PATH = emptyBin;
  const { openTerminalWindow } = await platform('linux-none');
  const result = await openTerminalWindow({ cwd: root, env: {}, file: '/bin/echo', args: [] });
  process.env.PATH = previous;
  assert.equal(result.ok, false);
  assert.match(result.error, /未找到可用终端/);
});

test('resolveSpawnCommand：linux shebang 脚本直通（不经 shell 解包）', async () => {
  const bin = write(path.join(root, 'shebang', 'kimi'), '#!/usr/bin/env node\n', 0o755);
  const { resolveSpawnCommand } = await platform('linux-shebang');
  assert.deepEqual(resolveSpawnCommand(bin), { file: bin, prefixArgs: [] });
});
