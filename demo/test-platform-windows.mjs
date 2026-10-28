#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeModelFixture } from './test-model-fixture.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeall-platform-test-'));
const platform = async (name, tag) => {
  Object.defineProperty(process, 'platform', { value: name });
  return import('../adapters/platform.mjs?' + tag);
};
const write = (file, text, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, mode);
  return file;
};

test('标准 npm .cmd shim 保留 node 与 JS 入口', async () => {
  const dir = path.join(root, 'cmd');
  write(path.join(dir, 'node.exe'), '');
  write(path.join(dir, 'node_modules', 'pkg', 'cli.js'), '');
  const shim = write(path.join(dir, 'codex.cmd'), '"%~dp0\\node.exe" "%~dp0\\node_modules\\pkg\\cli.js" %*\r\n');
  const { resolveSpawnCommand } = await platform('win32', 'cmd-shim');
  const target = resolveSpawnCommand(shim);
  assert.equal(target.file, path.join(dir, 'node.exe'));
  assert.deepEqual(target.prefixArgs, [path.join(dir, 'node_modules', 'pkg', 'cli.js')]);
});

test('原生产品 exe 优先于 node 解释器', async () => {
  const dir = path.join(root, 'native');
  write(path.join(dir, 'node.exe'), '');
  write(path.join(dir, 'claude.exe'), '');
  write(path.join(dir, 'node_modules', 'pkg', 'cli.js'), '');
  const shim = write(path.join(dir, 'claude.cmd'), '"%~dp0\\node.exe" "%~dp0\\claude.exe" "%~dp0\\node_modules\\pkg\\cli.js" %*\r\n');
  const { resolveSpawnCommand } = await platform('win32', 'native-exe');
  assert.deepEqual(resolveSpawnCommand(shim), { file: path.join(dir, 'claude.exe'), prefixArgs: [] });
});

test('破损 shim 的回退参数包含完整转义', async () => {
  const shim = write(path.join(root, 'broken.cmd'), '@echo broken\r\n');
  const { resolveSpawnCommand, spawnCommandArgs } = await platform('win32', 'broken-shim');
  const target = resolveSpawnCommand(shim);
  assert.equal(target.needsCmdQuote, true);
  const spec = spawnCommandArgs(target, ['-p', 'a"b %X% & whoami']);
  assert.equal(spec.windowsVerbatimArguments, true);
  assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(spec.args[3], '"' + shim + '"');
  assert.equal(spec.args[4], '"-p"');
  assert.equal(spec.args[5], '"a""b %%X%% & whoami"');
});

test('xdg-terminal-exec 使用目标项目目录', async () => {
  const dir = path.join(root, 'linux-cwd');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(root, 'cwd.txt');
  const bin = write(path.join(root, 'bin', 'xdg-terminal-exec'), '#!/bin/sh\nprintf %s "$PWD" > "$OUT"\n', 0o755);
  const previous = process.env.PATH;
  process.env.PATH = path.dirname(bin) + path.delimiter + previous;
  process.env.OUT = out;
  const { openTerminalWindow } = await platform('linux', 'linux-cwd');
  const result = await openTerminalWindow({ cwd: dir, env: {}, file: '/bin/echo', args: [] });
  process.env.PATH = previous;
  assert.equal(result.ok, true, result.error);
  assert.equal(fs.readFileSync(out, 'utf8'), fs.realpathSync(dir));
});

test('ZCode 首次注册表同步解析安装目录', async () => {
  const home = path.join(root, 'zcode-first');
  const fixture = writeModelFixture(home);
  const appDir = path.join(home, 'ZCode');
  write(path.join(appDir, 'resources', 'config', 'provider', 'zcode-builtin.json'), JSON.stringify({
    config: { providerConfigRules: { providerRules: [
      { providerId: 'personal', config: { modelOrder: ['mock-model'], access: { apiKey: 'TEST_ONLY' } } },
    ] }, modelConfigRules: { modelRules: [] } },
  }));
  write(path.join(appDir, 'resources', 'glm', 'zcode.cjs'), '');
  const powershell = write(path.join(home, 'bin', 'powershell.exe'), '#!/bin/sh\nprintf %s "$FAKE_ZCODE_DIR"\n', 0o755);
  Object.assign(process.env, fixture, {
    HOME: home,
    PATH: path.dirname(powershell) + path.delimiter + process.env.PATH,
    FAKE_ZCODE_DIR: appDir,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(home, 'missing-user.json'),
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '',
  });
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const { loadModelRegistry } = await import('../adapters/model-registry.mjs?zcode-first');
  const registry = loadModelRegistry({ force: true });
  assert.equal(registry.zcode.available, true);
  assert.equal(registry.zcode.models[0].value, 'personal/mock-model');
});

test('Kimi E2E 从工作区会话目录读取新 assistant 回复', async () => {
  const { default: vm } = await import('node:vm');
  const home = path.join(root, 'kimi-e2e');
  const cwd = path.join(home, 'project');
  const source = fs.readFileSync(new URL('../scripts/win11-sandbox/kimi-e2e.mjs', import.meta.url), 'utf8')
    .split('// ---- 新建 ----')[0]
    .replace(/^import .*$/gm, '')
    .replace(/const D = String.raw`[^`]*`;/, 'const D = ' + JSON.stringify(cwd) + ';');
  const context = { fs, path, os: { homedir: () => home }, console, setTimeout, clearTimeout };
  vm.runInNewContext(source + '\nthis.probe = { newestSession, lastAssistantText, waitAssistant };', context);
  const dir = path.join(home, '.kimi-code', 'sessions', 'wd_test', 'session_test');
  write(path.join(dir, 'state.json'), JSON.stringify({ id: 'kimi-e2e-session', cwd }));
  write(path.join(dir, 'agents', 'main', 'wire.jsonl'), [
    { type: 'agent.message.appended', message: { message: { role: 'assistant', content: [{ type: 'text', text: '已记住' }] } } },
    { type: 'agent.message.appended', message: { role: 'assistant', content: '海豚' } },
  ].map(JSON.stringify).join('\n'));
  const session = context.probe.newestSession(0);
  assert.equal(session.id, 'kimi-e2e-session');
  assert.equal(session.dir, dir);
  assert.equal(await context.probe.waitAssistant(session, '海豚', '已记住'), '海豚');
});
