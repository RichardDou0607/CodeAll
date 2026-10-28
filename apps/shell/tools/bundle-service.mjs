#!/usr/bin/env node
/**
 * apps/shell/tools/bundle-service.mjs — 把本地服务打进 .app 的 Resources（独立分发用）
 *
 * tauri build 的 beforeBuildCommand 会执行本脚本：把 framed 服务所需的代码子集与
 * Node 运行时暂存到 src-tauri/resources/app/，再由 tauri.conf.json 的 bundle.resources
 * 收进 CodeAll.app/Contents/Resources/app/。这样安装包不再依赖源码仓库与系统 Node：
 *   lib.rs resolve_repo_root()/resolve_node() 在仓库/系统路径都找不到时回退到该目录。
 *
 * 目录布局 = 仓库根的子集（framed.mjs 全部走 import.meta.url 相对寻址，可整体搬迁）：
 *   app/demo/{framed.mjs, frame.mjs, http-request.mjs, window.html, mini.html, assets/**}
 *   app/adapters/*.mjs（顶层适配器）
 *   app/apps/shell/tools/{pet-input-send.mjs, mount-dsh-plugin.sh}
 *   app/plugins/dsh-pet/**（DSH 投递插件，可选功能）
 *   app/bin/node（Node 运行时；复制自已安装的二进制，保留原签名）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOLS_DIR, '..', '..', '..');
const STAGE = path.join(TOOLS_DIR, '..', 'src-tauri', 'resources', 'app');

const copyFile = (src, rel) => {
  const dest = path.join(STAGE, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, fs.statSync(src).mode & 0o777);
};
const copyTree = (srcDir, relDir) => {
  let n = 0;
  const walk = (d, r) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.DS_Store') continue;
      const s = path.join(d, e.name);
      if (e.isDirectory()) walk(s, path.join(r, e.name));
      else { copyFile(s, path.join(r, e.name)); n++; }
    }
  };
  walk(srcDir, relDir);
  return n;
};

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

// 1) 服务代码子集
for (const f of ['framed.mjs', 'frame.mjs', 'http-request.mjs', 'window.html', 'mini.html']) {
  copyFile(path.join(ROOT, 'demo', f), path.join('demo', f));
}
const assets = copyTree(path.join(ROOT, 'demo', 'assets'), 'demo/assets');
let adapters = 0;
for (const e of fs.readdirSync(path.join(ROOT, 'adapters'))) {
  if (e.endsWith('.mjs')) { copyFile(path.join(ROOT, 'adapters', e), path.join('adapters', e)); adapters++; }
}
for (const f of ['pet-input-send.mjs', 'mount-dsh-plugin.sh']) {
  copyFile(path.join(TOOLS_DIR, f), path.join('apps', 'shell', 'tools', f));
}
const plugin = copyTree(path.join(ROOT, 'plugins', 'dsh-pet'), 'plugins/dsh-pet');

// 2) Node 运行时（当前 node 本身 → env 指定 → 常见路径 → PATH；直接复制二进制，原签名随文件保留）
const isWin = process.platform === 'win32';
const nodeCandidates = [
  process.execPath,
  process.env.AGENT_PET_NODE,
  '/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node',
  ...(process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, isWin ? 'node.exe' : 'node')),
].filter(Boolean);
const nodeSrc = nodeCandidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!nodeSrc) { console.error('[bundle-service] 未找到 node 二进制，无法独立分发'); process.exit(1); }
copyFile(nodeSrc, isWin ? path.join('bin', 'node.exe') : path.join('bin', 'node'));

// 只发 Apple Silicon：universal 二进制裁到 arm64 单架构（体积约减半；lipo -thin 保留片内签名，
// 签名校验失败则回退 fat 原件——宁可包大也不能给出跑不起来的 node）。
// lipo/codesign 是 mac 专属工具，显式 darwin gate（Linux/Windows 打包直跳，不再靠 try/catch 吞错）。
if (process.platform === 'darwin') {
  const info = execFileSync('lipo', ['-info', nodeSrc], { encoding: 'utf8' });
  if (/x86_64/.test(info) && /arm64/.test(info)) {
    const stagedNode = path.join(STAGE, 'bin', 'node');
    const tmp = stagedNode + '.arm64';
    execFileSync('lipo', ['-thin', 'arm64', stagedNode, '-output', tmp]);
    try {
      execFileSync('codesign', ['-v', tmp]);
      fs.renameSync(tmp, stagedNode);
      console.log('[bundle-service] node 已裁剪为 arm64 单架构');
    } catch {
      fs.rmSync(tmp, { force: true });
      console.log('[bundle-service] 裁剪后签名无效，保留 universal 原件');
    }
  }
}

const sizeMB = (d) => {
  let t = 0;
  const walk = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, e.name); if (e.isDirectory()) walk(p); else t += fs.statSync(p).size; } };
  walk(d); return (t / 1024 / 1024).toFixed(1);
};
console.log(`[bundle-service] 暂存完成 → ${path.relative(ROOT, STAGE)}`
  + `（adapters ${adapters} 个 / demo assets ${assets} 个 / 插件 ${plugin} 个 / node=${path.basename(nodeSrc)}）`
  + ` 合计 ${sizeMB(STAGE)} MB`);
