#!/usr/bin/env node
/**
 * adapters/platform.mjs — 平台抽象层（v0.2.0 PLAT-1，docs/24 §2）
 *
 * 目标：所有适配器只调这里拿平台差异，不得散落 process.platform 分支。
 * 收口的差异点：
 *   1. 安装/数据路径（App 包、npm 全局、应用数据目录、注册表反查 Windows 安装目录）
 *   2. 进程快照（mac/linux `ps axo` → Windows PowerShell CIM，输出统一为 `pid\tname\targs` 行，
 *      args 内反斜杠归一为 `/`，让进程正则跨平台共用书写口径）
 *   3. 版本读取（PlistBuddy → Windows PE VersionInfo → linux spawn --version）
 *   4. CLI 二进制解析与 spawn 目标（Windows npm shim .cmd/.ps1 解包成 node + 入口 js，不经 shell）
 *   5. 终端启动链（Terminal.app → wt.exe / start；linux 三级）
 *   6. 插件 socket（unix socket → Windows 命名管道 \\.\pipe\agent-pet-*）
 *   7. DSH flock addon 回退路径（mac 固定 /Applications；Windows 经注册表反查安装目录；linux .desktop 反查）
 *
 * 约定：全部只读探测；Windows 侧所有 PowerShell 调用统一 -NoProfile + UTF8 输出（docs/36 §5 坑），
 * 一律 execFile 参数数组不经 shell（防注入）。失败一律返回空值降级，绝不冒泡拖垮调用方。
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const PLATFORM_ID = process.platform;
export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';
export const HOME = os.homedir();
export const PATH_DELIM = IS_WIN ? ';' : ':';

// ---------------------------------------------------------------------------
// 数据目录（语义：每平台「该类数据的规范位置」）
// ---------------------------------------------------------------------------

/** 应用支持目录：mac ~/Library/Application Support/<segs>；win %APPDATA%\<segs>；linux ~/.config/<segs>。 */
export function appSupport(...segs) {
  const base = IS_MAC ? path.join(HOME, 'Library', 'Application Support')
    : IS_WIN ? (process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'))
    : path.join(HOME, '.config');
  return path.join(base, ...segs);
}

/** 本机（非漫游）数据目录：win %LOCALAPPDATA%\<segs>；其余平台同 appSupport。 */
export function localData(...segs) {
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), ...segs);
  return appSupport(...segs);
}

/** npm 全局 node_modules 下的包目录候选（按平台常见前缀排序；存在与否由调用方判断）。 */
export function npmGlobalCandidates(pkgDir) {
  if (IS_WIN) {
    const root = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    return [path.join(root, 'npm', 'node_modules', pkgDir)];
  }
  if (IS_MAC) return [
    path.join(HOME, '.local', 'lib', 'node_modules', pkgDir),
    '/usr/local/lib/node_modules/' + pkgDir,
    '/opt/homebrew/lib/node_modules/' + pkgDir,
  ];
  return [
    path.join(HOME, '.local', 'lib', 'node_modules', pkgDir),
    '/usr/local/lib/node_modules/' + pkgDir,
    path.join(HOME, '.npm-global', 'lib', 'node_modules', pkgDir),
  ];
}

// ---------------------------------------------------------------------------
// Windows：注册表反查桌面 App 安装目录（装在任意盘符都能找到；结果缓存 10 分钟）
// ---------------------------------------------------------------------------

const appDirCache = new Map();
const APP_DIR_TTL = 10 * 60_000;

/**
 * 按显示名反查传统 Win32 安装目录（Uninstall 注册表）。MSIX（WindowsApps）应用不在其中，返回 null。
 * @returns {Promise<string|null>} 安装目录（末尾无斜杠），查不到为 null。
 */
function winAppDirScript(displayName) {
  const name = displayName.replace(/'/g, "''");
  return "$ks='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*';" +
    "$i = Get-ItemProperty $ks -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq '" + name + "' -or $_.DisplayName -like '" + name + " *' } | Select-Object -First 1 InstallLocation, DisplayIcon;" +
    "if ($i) { $d = $i.InstallLocation; if (-not $d -and $i.DisplayIcon) { $d = ($i.DisplayIcon -split ',')[0] }; if ($d) { if (Test-Path $d -PathType Leaf) { $d = Split-Path $d } ; $d } }";
}

function winAppDirResult(displayName, stdout) {
  const out = stdout.trim();
  let dir = null;
  if (out) { try { dir = JSON.parse(out); } catch { dir = out.replace(/^"|"$/g, '') || null; } }
  if (dir && !fs.existsSync(dir)) dir = null;
  appDirCache.set(displayName, { at: Date.now(), dir });
  return dir;
}

export async function winAppDir(displayName) {
  if (!IS_WIN) return null;
  const hit = appDirCache.get(displayName);
  if (hit && Date.now() - hit.at < APP_DIR_TTL) return hit.dir;
  try {
    const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + winAppDirScript(displayName)], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    return winAppDirResult(displayName, stdout);
  } catch { return winAppDirResult(displayName, ''); }
}

export function winAppDirSync(displayName) {
  if (!IS_WIN) return null;
  const hit = appDirCache.get(displayName);
  if (hit && Date.now() - hit.at < APP_DIR_TTL) return hit.dir;
  try {
    const stdout = execFileSync('powershell.exe', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + winAppDirScript(displayName)], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    return winAppDirResult(displayName, stdout);
  } catch { return winAppDirResult(displayName, ''); }
}

// ---------------------------------------------------------------------------
// 进程快照（统一行格式 `pid\tname\targs`，args 反斜杠归一为 `/`）
// ---------------------------------------------------------------------------

const PS_ARGS = ['axo', 'pid=,ucomm=,args='];
const procCache = { at: 0, lines: null };
const PROC_CACHE_TTL = 5000;      // 仅 Windows 启用（CIM 全量 ~0.5s，3s 轮询下 5s 级快照无损面板语义；mac ps 本就毫秒级，保持每轮新鲜）

const WIN_PROC_SCRIPT =
  '$p = @(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine); ' +
  'ConvertTo-Json $p -Compress -Depth 2';

function normProcField(s) {
  return String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\\/g, '/');
}

/** 快照行列表；失败返回 []（= 全部按未运行降级，与既有 ps 失败口径一致）。 */
export async function listProcesses() {
  if (IS_WIN) {
    if (procCache.lines && Date.now() - procCache.at < PROC_CACHE_TTL) return procCache.lines;
    let lines = [];
    try {
      const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + WIN_PROC_SCRIPT], { timeout: 6000, maxBuffer: 32 * 1024 * 1024 });
      let arr = JSON.parse(stdout);
      if (!Array.isArray(arr)) arr = [arr];
      lines = arr.filter(Boolean).map((p) => normProcField(p.ProcessId) + '\t' + normProcField(p.Name) + '\t' + normProcField(p.CommandLine));
    } catch { lines = []; }
    procCache.at = Date.now();
    procCache.lines = lines;
    return lines;
  }
  try {
    const { stdout } = await execFileP('ps', PS_ARGS, { maxBuffer: 16 * 1024 * 1024, timeout: 4000 });
    return stdout.split('\n');
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// 版本读取（PlistBuddy / PE VersionInfo；每目标只读一次永久缓存）
// ---------------------------------------------------------------------------

const versionCache = new Map();

/**
 * App 包 / 可执行文件版本号。mac 传 .app 包路径；Windows 传 .exe 路径。
 * 读不到（无包/未装/超时）返回 null，不抛错。
 */
export async function appVersion(bundleOrExe) {
  if (!bundleOrExe) return null;
  if (versionCache.has(bundleOrExe)) return versionCache.get(bundleOrExe);
  let v = null;
  try {
    if (IS_MAC && bundleOrExe.endsWith('.app')) {
      const { stdout } = await execFileP('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(bundleOrExe, 'Contents/Info.plist')], { timeout: 2000 });
      v = stdout.trim() || null;
    } else if (IS_WIN && /\.(exe|dll)$/i.test(bundleOrExe)) {
      const lit = bundleOrExe.replace(/'/g, "''");
      const script = "$v=(Get-Item -LiteralPath '" + lit + "').VersionInfo; if ($v.ProductVersion) { $v.ProductVersion } else { $v.FileVersion }";
      const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + script], { timeout: 4000, maxBuffer: 1024 * 1024 });
      v = stdout.trim() || null;
    } else if (IS_LINUX) {
      // linux 无统一元数据：可执行文件（含 AppImage，参数透传）跑 --version 取首个版本样 token；
      // 目录/AppImage 之外的形态读不出就 null 如实。
      const st = fs.statSync(bundleOrExe);
      const target = st.isDirectory() ? null : bundleOrExe;
      if (target) {
        const t = resolveSpawnCommand(target);
        if (t) {
          const { stdout } = await execFileP(t.file, [...t.prefixArgs, '--version'], { timeout: 4000, maxBuffer: 1024 * 1024 });
          const m = stdout.match(/\d+\.\d+(\.\d+)*([-+.\w]*)/);
          v = m ? m[0] : (stdout.trim().split(/\r?\n/)[0] || null);
        }
      }
    }
  } catch { v = null; }
  versionCache.set(bundleOrExe, v);
  return v;
}

// ---------------------------------------------------------------------------
// CLI 二进制解析（PATH + PATHEXT + 兜底目录）与 spawn 目标解包
// ---------------------------------------------------------------------------

const WIN_PATHEXT = ['.CMD', '.EXE', '.BAT', '.PS1', ''];

/**
 * 跨平台在 PATH 与兜底目录中找 CLI。
 * @param {string} bin        不带扩展名的命令名（claude / kimi / opencode…）
 * @param {Array<string|()=>string>} extraPaths 额外候选（目录时与 bin 拼接；直接路径直接用）
 * @returns {string|null} 绝对路径；找不到 null。
 */
export function resolveCliBinPath(bin, extraPaths = []) {
  const dirs = (process.env.PATH || '').split(PATH_DELIM);
  const names = IS_WIN ? WIN_PATHEXT.map((e) => bin + e) : [bin];
  for (const d of dirs) {
    if (!d) continue;
    for (const n of names) {
      const p = path.join(d, n);
      try { if (fs.statSync(p).isFile() && (IS_WIN || fs.accessSync(p, fs.constants.X_OK) === undefined)) return p; } catch { /* 下一个 */ }
    }
  }
  const flat = [];
  for (const e of extraPaths) {
    if (typeof e === 'function') { try { flat.push(...[].concat(e())); } catch { /* ignore */ } }
    else flat.push(e);
  }
  flat.push(path.join(HOME, '.local', 'bin', bin));
  for (const p of flat) {
    if (!p) continue;
    if (IS_WIN && !/\.(cmd|exe|bat|ps1|cjs|js)$/i.test(p) && !fs.existsSync(p)) {
      for (const e of ['.cmd', '.exe', '.bat', '.ps1']) { try { if (fs.statSync(p + e).isFile()) return p + e; } catch { /* 下一个 */ } }
      continue;
    }
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 下一个 */ }
  }
  return null;
}

/**
 * 把解析到的 CLI 路径翻译成可直接 spawn 的目标（不经 shell）。
 * Windows npm shim（.cmd/.ps1）解包：从 shim 文本提取产品入口（原生 .exe 直接跑；.js/.cjs/.mjs
 * 交 node），避开「Node ≥18.20 spawn .cmd 必须 shell（EINVAL）」与 cmd 引号/注入两层问题；
 * kimi.exe / claude.exe（npm 包内置原生二进制）这类真二进制直接 { file }。
 * unix 全部 { file }（shebang 自带解释器）。
 * @returns {{file:string, prefixArgs:string[]}|null}
 */
export function resolveSpawnCommand(binPath) {
  if (!binPath) return null;
  if (!IS_WIN) return { file: binPath, prefixArgs: [] };
  const ext = path.extname(binPath).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { file: binPath, prefixArgs: [] };
  if (ext === '.cmd' || ext === '.bat' || ext === '.ps1') {
    try {
      const text = fs.readFileSync(binPath, 'utf8');
      const base = path.dirname(binPath);
      const raws = [];
      for (const m of text.matchAll(/"%~?dp0\\([^"]+)"/gi)) raws.push(m[1]);
      for (const m of text.matchAll(/"\$basedir\/([^"]+)"/gi)) raws.push(m[1].replace(/\$exe\b/g, ''));
      const files = raws.map(raw => path.join(base, raw.replace(/[\\/]/g, path.sep))).filter(file => {
        try { return fs.statSync(file).isFile(); } catch { return false; }
      });
      const productExe = files.find(file => path.extname(file).toLowerCase() === '.exe' && path.basename(file).toLowerCase() !== 'node.exe');
      if (productExe) return { file: productExe, prefixArgs: [] };
      const entryJs = files.find(file => ['.js', '.cjs', '.mjs'].includes(path.extname(file).toLowerCase()));
      if (entryJs) {
        const localNode = path.join(base, 'node.exe');
        return { file: fs.existsSync(localNode) ? localNode : 'node.exe', prefixArgs: [entryJs] };
      }
    } catch { /* 解包失败 → cmd 兜底 */ }
    return { file: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), prefixArgs: ['/d', '/s', '/c', binPath], needsCmdQuote: true };
  }
  return { file: binPath, prefixArgs: [] };
}

// ---------------------------------------------------------------------------
// 插件 socket / 命名管道
// ---------------------------------------------------------------------------

/**
 * DSH 插件通道地址。Windows 用命名管道（net.connect 原生支持 \\.\pipe\ 前缀）；
 * unix 用临时目录 unix socket。环境变量覆盖（PET_PLUGIN_SOCK / DSH_PET_SOCK）在调用方处理。
 */
export function pluginSocketPath() {
  if (IS_WIN) return '\\\\.\\pipe\\agent-pet-dsh-plugin';
  return path.join(os.tmpdir(), 'agent-pet', 'dsh-plugin.sock');
}

// ---------------------------------------------------------------------------
// 终端启动链（可见交互窗口：打开/新建会话用）
// ---------------------------------------------------------------------------

function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function cmdQuote(s) {
  return '"' + String(s).replace(/"/g, '""').replace(/%/g, '%%').replace(/!/g, '!!').replace(/\r\n?/g, ' ') + '"';
}

export function spawnCommandArgs(target, args = []) {
  if (!target.needsCmdQuote) return { file: target.file, args: [...target.prefixArgs, ...args], windowsVerbatimArguments: false };
  return {
    file: target.file,
    args: [...target.prefixArgs.slice(0, 3), ...target.prefixArgs.slice(3).concat(args).map(cmdQuote)],
    windowsVerbatimArguments: true,
  };
}

async function macTerminalDo(script) {
  await execFileP('osascript', ['-e', script], { timeout: 4000 });
}

async function hasWinWhere(name) {
  try { await execFileP('where.exe', [name], { timeout: 2000 }); return true; } catch { return false; }
}

/**
 * 打开一个可见终端窗口并执行命令（用于「打开会话 / 新建会话」交互链）。
 * mac：Terminal.app do script（既有行为原样搬入）；
 * Windows：wt.exe 优先（wt 把 `;` 当命令分隔符，转义为 `\;`），缺失退 `start`；
 * linux：xdg-terminal-exec → gnome-terminal → kitty（X11 口径；Wayland 置顶/穿透另有降级声明）。
 * @param {{cwd:string, env:Object<string,string>, file:string, args:string[]}} spec
 * @returns {Promise<{ok:boolean, via:string, error?:string}>}
 */
export async function openTerminalWindow({ cwd, env = {}, file, args = [] }) {
  const envPrefix = (fmt) => Object.entries(env).map(([k, v]) => fmt(k, v)).join('');
  const cmdEnvValue = (value) => String(value).replace(/%/g, '%%').replace(/!/g, '!!').replace(/"/g, '""');
  if (IS_MAC) {
    const script = 'tell application "Terminal" to do script ' + JSON.stringify(
      'cd ' + shQuote(cwd) + ' && ' + envPrefix((k, v) => 'export ' + k + '=' + shQuote(v) + '; ') + shQuote(file) + (args.length ? ' ' + args.map(shQuote).join(' ') : '')
    );
    try { await macTerminalDo(script); return { ok: true, via: 'Terminal 新窗口' }; }
    catch (e) { return { ok: false, via: 'Terminal', error: String(e.message || e).slice(0, 160) }; }
  }
  if (IS_WIN) {
    const line = envPrefix((k, v) => 'set "' + k + '=' + cmdEnvValue(v) + '" && ') + cmdQuote(file) + (args.length ? ' ' + args.map(cmdQuote).join(' ') : '');
    if (await hasWinWhere('wt.exe')) {
      try {
        await execFileP('wt.exe', ['-d', cwd, 'cmd', '/d', '/s', '/k', line.replace(/;/g, '\\;')], { timeout: 4000 });
        return { ok: true, via: 'Windows Terminal 新标签' };
      } catch { /* 落 start 兜底 */ }
    }
    try {
      await execFileP('cmd.exe', ['/d', '/s', '/c', 'start', 'CodeAll', '/D', cmdQuote(cwd), 'cmd', '/d', '/s', '/k', line], { timeout: 4000, windowsVerbatimArguments: true });
      return { ok: true, via: 'cmd 新窗口' };
    } catch (e) { return { ok: false, via: 'cmd', error: String(e.message || e).slice(0, 160) }; }
  }
  // linux：三级尝试（docs/24 §2 终端链）
  const tries = [
    ['xdg-terminal-exec', args.length ? [file, ...args] : [file]],
    ['gnome-terminal', ['--working-directory', cwd, '--', file, ...args]],
    ['kitty', ['--directory', cwd, file, ...args]],
  ];
  for (const [bin, a] of tries) {
    try { await execFileP(bin, a, { timeout: 4000, cwd }); return { ok: true, via: bin }; } catch { /* 下一个 */ }
  }
  return { ok: false, via: 'terminal', error: '未找到可用终端（xdg-terminal-exec/gnome-terminal/kitty）' };
}

// ---------------------------------------------------------------------------
// 已知桌面 App 的安装目录解析（Windows 注册表 → mac 固定 /Applications）
// ---------------------------------------------------------------------------

/** 桌面 App 清单：name 是 Windows Uninstall 注册表的 DisplayName（精确匹配）。 */
export const DESKTOP_APPS = Object.freeze({
  dsh: 'DeepSeek Harness',
  zcode: 'ZCode',
  'kimi-code': 'Kimi Code',
  'codex-pp': 'Codex++',
  cursor: 'Cursor',
  qoder: 'Qoder CN',
});

/** 桌面 App 安装目录（Promise；win 走注册表缓存，mac 返回 /Applications/<app>.app 或 null，linux 反查 .desktop）。 */
function desktopAppDirMac(appId) {
  const macNames = { dsh: 'DeepSeek Harness.app', zcode: 'ZCode.app', 'kimi-code': 'Kimi Code.app', cursor: 'Cursor.app', qoder: 'Qoder CN.app' };
  const n = macNames[appId];
  if (!n) return null;
  const p = path.join('/Applications', n);
  return fs.existsSync(p) ? p : null;
}

// Linux：freedesktop .desktop 反查。应用目录语义对齐 win/mac 消费方（要的是「能往下拼 resources/…」
// 的目录）：Exec 目标若为符号链（deb 惯例 /usr/bin/<name> → /usr/lib/<name>/<real>）用 realpath 解到
// 真实目录；AppImage 返回其所在目录。找不到 .desktop（CLI-only 安装）返回 null，调用方降级。
const LINUX_APP_DIR_TTL = 10 * 60_000;
const linuxAppDirCache = new Map();

function linuxDesktopDirs() {
  const dirs = [];
  const dataHome = process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share');
  dirs.push(path.join(dataHome, 'applications'));
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':');
  for (const d of dataDirs) { if (d) dirs.push(path.join(d, 'applications')); }
  dirs.push(path.join(dataHome, 'flatpak', 'exports', 'share', 'applications'));
  dirs.push('/var/lib/flatpak/exports/share/applications');
  return dirs;
}

function linuxDesktopFilename(appId) {
  const names = { dsh: 'dsh', zcode: 'zcode', 'kimi-code': 'kimi', 'codex-pp': 'codex', cursor: 'cursor', qoder: 'qoder' };
  return names[appId] || appId;
}

function linuxAppDirResult(appId) {
  const stem = linuxDesktopFilename(appId);
  let desktopFile = null;
  for (const dir of linuxDesktopDirs()) {
    try {
      const hit = fs.readdirSync(dir).find((f) => f.endsWith('.desktop') && f.toLowerCase().includes(stem));
      if (hit) { desktopFile = path.join(dir, hit); break; }
    } catch { /* 下一个目录 */ }
  }
  let dir = null;
  if (desktopFile) {
    try {
      const text = fs.readFileSync(desktopFile, 'utf8');
      const execLine = text.split(/\r?\n/).find((l) => l.startsWith('Exec='));
      if (execLine) {
        // Exec= 去字段码（%f/%u 等）；flatpak run <app-id> 的产物目录无资源可拼，保持 null
        const first = execLine.slice(5).trim().replace(/%[a-zA-Z]/g, '').trim().split(/\s+/)[0];
        if (first && first.startsWith('/')) {
          if (/\.AppImage$/i.test(first)) dir = path.dirname(first);
          else {
            let real = first;
            try { real = fs.realpathSync(first); } catch { /* 断链按原路径 */ }
            dir = path.dirname(real);
          }
        }
      }
    } catch { /* 读不了按 null */ }
  }
  if (dir && !fs.existsSync(dir)) dir = null;
  linuxAppDirCache.set(appId, { at: Date.now(), dir });
  return dir;
}

function desktopAppDirLinuxSync(appId) {
  const hit = linuxAppDirCache.get(appId);
  if (hit && Date.now() - hit.at < LINUX_APP_DIR_TTL) return hit.dir;
  return linuxAppDirResult(appId);
}

async function desktopAppDirLinux(appId) {
  const hit = linuxAppDirCache.get(appId);
  if (hit && Date.now() - hit.at < LINUX_APP_DIR_TTL) return hit.dir;
  return linuxAppDirResult(appId);
}

export async function desktopAppDir(appId) {
  if (IS_WIN) return winAppDir(DESKTOP_APPS[appId] || appId);
  if (IS_LINUX) return desktopAppDirLinux(appId);
  return desktopAppDirMac(appId);
}

export function desktopAppDirSync(appId) {
  if (IS_WIN) return winAppDirSync(DESKTOP_APPS[appId] || appId);
  if (IS_LINUX) return desktopAppDirLinuxSync(appId);
  return desktopAppDirMac(appId);
}
