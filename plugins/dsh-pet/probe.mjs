#!/usr/bin/env node
/**
 * plugins/dsh-pet/probe.mjs —— /tmp 预演脚本（不改 ~/.dsh、不改 /Applications）
 *
 * 它做四件事：
 *   prepare  在 /tmp 建一个全新的 DSH_HOME + profile（只含 dsh-base + 本插件 + session-controller）
 *   dump     用安装包自带 CLI 跑 --dump-config，证明插件行被组合进来
 *   start    后台启动该副本 profile，等 socket 出现
 *   e2e      POST /new → POST /input → 回到会话日志里找注入的文本（决定性证据）
 *   stop     停止副本 DSH 并清理 socket/锁
 *   all      依次执行上面全部
 *
 * 用法：
 *   node plugins/dsh-pet/probe.mjs all
 *   node plugins/dsh-pet/probe.mjs start && node plugins/dsh-pet/probe.mjs e2e && node plugins/dsh-pet/probe.mjs stop
 *
 * 环境：PROBE_HOME（缺省 /tmp/pet-dsh-home）、PROBE_SOCK（缺省 $PROBE_HOME/sock/dsh-plugin.sock）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync as spawnSyncImpl } from 'node:child_process';
import zlibDefault from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { IS_MAC, desktopAppDirSync } from '../../adapters/platform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, 'index.js');
const PROFILE = 'petprobe';
const HOME = process.env.PROBE_HOME || '/tmp/pet-dsh-home';
const PROFILE_DIR = path.join(HOME, 'profiles', PROFILE);
const SOCK = process.env.PROBE_SOCK || path.join(HOME, 'sock', 'dsh-plugin.sock');
const LOG = path.join(HOME, 'probe-dsh.log');
const PIDFILE = path.join(HOME, 'probe-dsh.pid');
// 安装包自带 CLI：mac App 包固定路径；linux 经 .desktop 反查安装目录；env 显式覆盖优先。
// 都取不到留 null，start 时给出明确指引（本平台无 DSH 发行版时如实退出，不装）。
const CLI = process.env.PROBE_DSH_CLI
  || (IS_MAC ? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' : null)
  || (desktopAppDirSync('dsh') ? path.join(desktopAppDirSync('dsh'), 'runtime', 'cli', 'bin', 'dsh') : null);

function step(label, detail) { console.log('== ' + label + (detail ? ': ' + detail : '')); }

function prepare() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROFILE_DIR, 'package.json'), JSON.stringify({
    name: 'dsh-profile-' + PROFILE, private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(PROFILE_DIR, 'cordis.patch.yml'), [
    '# 预演补丁：只挂桌宠插件 + Web 层的 session controller（desktop profile 里本来就有它）',
    '- insert:',
    '    # session controller 依赖这两个服务（desktop profile 由 web-app bundle 提供）',
    '    - id: workspace',
    "      name: '@deepseek-ai/dsh-workspace'",
    '    - id: client-file-upload',
    "      name: '@deepseek-ai/dsh-client-file-upload'",
    '    - id: session-controller',
    "      name: '@deepseek-ai/dsh-api-session-controller'",
    '    - id: dsh-pet',
    "      name: '" + PLUGIN + "'",
    '      config:',
    "        socket: '" + SOCK + "'",
    '        adapterVersion: probe',
    '',
  ].join('\n'));
  step('prepare', PROFILE_DIR);
  console.log('  package.json  : ' + path.join(PROFILE_DIR, 'package.json'));
  console.log('  cordis.patch  : ' + path.join(PROFILE_DIR, 'cordis.patch.yml'));
  console.log('  socket        : ' + SOCK);
}

function dump() {
  const out = runCli(['--profile', PROFILE, '--dump-config'], { HOME: HOME, DSH_HOME: HOME });
  const lines = out.stdout.split('\n');
  const idx = lines.findIndex((l) => l.includes('dsh-pet'));
  step('dump-config', 'exit=' + out.status);
  if (idx < 0) { console.log('!! 组合结果里没有 dsh-pet 行'); console.log(out.stdout.slice(-800)); console.log(out.stderr.slice(-500)); process.exitCode = 1; return; }
  console.log(lines.slice(Math.max(0, idx - 3), idx + 6).join('\n'));
}

function runCli(args, env) {
  const result = spawnSyncImpl(CLI, args, { encoding: 'utf8', env: Object.assign({}, process.env, env), timeout: 90000 });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function start() {
  if (!CLI || !fs.existsSync(CLI)) {
    console.log('!! 找不到 DSH CLI（PROBE_DSH_CLI 未设且本平台未探得安装）：本平台无 DSH 发行版时属预期，预演跳过');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const out = fs.openSync(LOG, 'a');
  const child = spawn(CLI, ['--profile', PROFILE], {
    env: Object.assign({}, process.env, { DSH_HOME: HOME, HOME: HOME }),
    detached: true, stdio: ['ignore', out, out],
  });
  child.unref();
  fs.writeFileSync(PIDFILE, String(child.pid));
  step('start', 'pid=' + child.pid + ' log=' + LOG);
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function httpJson(method, urlPath, body, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ socketPath: SOCK, path: urlPath, method: method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, json: json, text: text });
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', (error) => resolve({ status: 0, json: null, text: String(error.message || error) }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForSocket(seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (fs.existsSync(SOCK)) {
      const health = await httpJson('GET', '/health');
      if (health.status === 200) return health;
    }
    await wait(500);
  }
  return null;
}

/** 只读扫描会话日志，找注入文本是否出现在某条持久事件里（决定性证据）。 */
async function findInjectedText(text) {
  const root = path.join(HOME, 'sessions');
  const hits = [];
  const walk = (dir) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.jsonl.zstd')) continue;
      const raw = fs.readFileSync(full);
      const lines = decodeAllFrames(raw);
      for (const line of lines) {
        if (line.includes(text)) {
          let parsed = null; try { parsed = JSON.parse(line); } catch { /* ignore */ }
          hits.push({ file: full, type: parsed && parsed.type, seq: parsed && parsed.seq, time: parsed && parsed.time });
        }
      }
    }
  };
  walk(root);
  return hits;
}

/** 多帧 zstd 结构化扫描（与 adapters/_reference/dsh-log-tail.mjs 同一算法）。 */
function decodeAllFrames(buffer) {
  const parts = [];
  let offset = 0;
  const MAGIC = 0xfd2fb528;
  while (offset + 4 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== MAGIC) break;
    const start = offset;
    offset += 4;
    if (offset >= buffer.length) { offset = start; break; }
    const descriptor = buffer.readUInt8(offset); offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictFlag = descriptor & 3;
    const dictBytes = dictFlag === 3 ? 4 : dictFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    const rest = (singleSegment ? 0 : 1) + dictBytes + contentSizeBytes;
    if (offset + rest > buffer.length) { offset = start; break; }
    offset += rest;
    let done = false;
    while (!done) {
      if (offset + 3 > buffer.length) { done = true; offset = start; break; }
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      const payload = blockType === 1 ? 1 : blockSize;
      if (offset + payload > buffer.length) { done = true; offset = start; break; }
      offset += payload;
      if (lastBlock) done = true;
    }
    if (offset === start) break;
    if (checksum) { if (offset + 4 > buffer.length) { offset = start; break; } offset += 4; }
    try {
      const zlib = zlibModule();
      parts.push(zlib.zstdDecompressSync(buffer.subarray(start, offset)).toString('utf8'));
    } catch { /* 跳过坏帧 */ }
  }
  return parts.join('').split('\n').filter(Boolean);
}
function zlibModule() { return zlibRef; }
const zlibRef = zlibDefault;

async function e2e() {
  const health = await waitForSocket(40);
  step('e2e /health');
  console.log('  ' + (health ? JSON.stringify(health.json) : '!! socket 未就绪'));
  if (!health) { process.exitCode = 1; return; }

  const created = await httpJson('POST', '/new', { cwd: '/tmp/pet-probe-ws' });
  step('e2e POST /new');
  console.log('  ' + JSON.stringify(created.json));
  const sessionId = created.json && created.json.sessionId;
  if (!sessionId) { console.log('  !! 拿不到 sessionId，后续投递无法定位会话'); process.exitCode = 1; return; }

  const marker = 'PET-PROBE-' + Date.now();
  const input = await httpJson('POST', '/input', { sessionId: sessionId, text: marker });
  step('e2e POST /input', marker);
  console.log('  ' + JSON.stringify(input.json));

  const opened = await httpJson('POST', '/open', { sessionId: sessionId });
  step('e2e POST /open');
  console.log('  ' + JSON.stringify(opened.json));

  step('e2e 等 3 s 让 DSH 把事件写进会话日志');
  await wait(3000);
  const hits = await findInjectedText(marker);
  step('e2e 会话日志里是否出现注入文本');
  if (hits.length === 0) { console.log('  !! 没找到（见 docs/54-dsh-plugin.md §失败模式）'); process.exitCode = 1; return; }
  for (const hit of hits) console.log('  ' + JSON.stringify(hit));
}

function stop() {
  let pid = null;
  try { pid = Number(fs.readFileSync(PIDFILE, 'utf8').trim()); } catch { /* 没在跑 */ }
  if (pid && Number.isInteger(pid)) {
    const cmd = spawnSyncImpl('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout || '';
    if (cmd.includes(PROFILE)) { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ } } step('stop', 'SIGTERM ' + pid); }
    else step('stop', 'pid ' + pid + ' 不是本预演进程，跳过');
  } else step('stop', '没有记录的 pid');
  try { fs.unlinkSync(SOCK); } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(path.dirname(SOCK), 'dsh-plugin.lock')); } catch { /* ignore */ }
}

const mode = process.argv[2] || 'all';
if (mode === 'prepare') prepare();
else if (mode === 'dump') dump();
else if (mode === 'start') start();
else if (mode === 'e2e') await e2e();
else if (mode === 'stop') stop();
else if (mode === 'all') { prepare(); dump(); start(); await e2e(); step('提示', '停止：node plugins/dsh-pet/probe.mjs stop'); }
else { console.error('用法: node plugins/dsh-pet/probe.mjs [prepare|dump|start|e2e|stop|all]'); process.exit(2); }
