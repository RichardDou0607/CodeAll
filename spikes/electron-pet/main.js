// T1 spike · Electron 桌宠外壳最小验证
// 与 swift/tauri spike 对齐：透明无边框 + 置顶 + 点击穿透 + Unix socket JSONL -> 可见状态变化
const { app, BrowserWindow, ipcMain } = require("electron");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const t0 = Date.now();
// 路径边界（Mimosa 预提交检查 2026-10-07：env → socket/报告路径曾是无界污点）：
// 环境变量只允许覆写 os.tmpdir() 或用户主目录之下的路径，其余回退默认值。
// run-spike.sh 的覆写路径本就取自 os.tmpdir()，行为不变。
function boundedEnvPath(envVal, fallback) {
  if (typeof envVal === "string" && envVal) {
    for (const base of [os.tmpdir(), os.homedir()]) {
      if (envVal === base || envVal.startsWith(base + path.sep)) return envVal;
    }
  }
  return fallback;
}
const petDir = path.join(boundedEnvPath(process.env.PET_SPIKE_DIR, os.tmpdir()), "agent-pet");
fs.mkdirSync(petDir, { recursive: true });
const socketPath = boundedEnvPath(process.env.PET_SPIKE_SOCKET, path.join(petDir, "electron-spike.sock"));
const reportPath = boundedEnvPath(process.env.PET_SPIKE_REPORT, path.join(petDir, "electron-spike-report.jsonl"));
const runSeconds = Number(process.env.PET_SPIKE_RUN_SECONDS || 14);
fs.writeFileSync(reportPath, "");
function report(line) { process.stdout.write(line + "\n"); fs.appendFileSync(reportPath, line + "\n"); }
report("T_START epoch_ms=" + t0);

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 240, height: 240, show: false,
    transparent: true, frame: false, hasShadow: false, resizable: false,
    alwaysOnTop: true, fullscreenable: false, skipTaskbar: true,
    backgroundColor: "#00000000",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });   // 点击穿透（初始 ON）
  win.loadFile(path.join(__dirname, "index.html"));
  win.once("ready-to-show", () => {
    win.showInactive();
    report("WINDOW_SHOWN t_ms=" + (Date.now() - t0));
  });
  win.webContents.on("did-finish-load", () => report("FRONTEND_READY t_ms=" + (Date.now() - t0)));
}

function windowDiag() {
  if (!win) return { error: "no-window" };
  return {
    isVisible: win.isVisible(),
    isAlwaysOnTop: win.isAlwaysOnTop(),
    bounds: win.getBounds(),
    backgroundColor: win.getBackgroundColor(),
    windowNumber: win.getNativeWindowHandle().readUInt32LE(0),
  };
}

ipcMain.handle("report-state", (_e, payload) => {
  report("DOM_APPLIED state=" + payload.state + " type=" + payload.type + " dom=" + payload.domText + " t_ms=" + (Date.now() - t0));
});
ipcMain.handle("window-diag", () => { const d = windowDiag(); report("WINDOW_DIAG " + JSON.stringify(d)); return d; });
ipcMain.handle("set-click-through", (_e, on) => {
  win.setIgnoreMouseEvents(on, { forward: true });
  report("CLICK_THROUGH on=" + on + " t_ms=" + (Date.now() - t0));
  return windowDiag();
});

// Unix domain socket：按契约 §5 读 JSONL，转发给渲染进程
function startSocketServer() {
  try { fs.unlinkSync(socketPath); } catch {}
  const server = net.createServer((sock) => {
    report("CLIENT_CONNECTED t_ms=" + (Date.now() - t0));
    let pending = "";
    sock.on("data", (buf) => {
      pending += buf.toString("utf8");
      let i;
      while ((i = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, i).trim();
        pending = pending.slice(i + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          report("SOCKET_EVENT type=" + obj.type + " t_ms=" + (Date.now() - t0));
          if (win) win.webContents.send("pet-event", obj);
        } catch (e) { report("PARSE_ERR " + e.message); }
      }
    });
    sock.on("close", () => report("CLIENT_CLOSED t_ms=" + (Date.now() - t0)));
    sock.on("error", (e) => report("SOCK_ERR " + e.message));
  });
  server.on("error", (e) => report("BIND_FAIL " + e.message));
  server.listen(socketPath, () => report("READY socket=" + socketPath + " t_ms=" + (Date.now() - t0)));
}

app.whenReady().then(() => {
  createWindow();
  startSocketServer();
  report("WINDOW_CREATED t_ms=" + (Date.now() - t0));
  setTimeout(() => {
    report("WINDOW_DIAG " + JSON.stringify(windowDiag()));
    const off = win.isAlwaysOnTop();
    win.setIgnoreMouseEvents(!off, { forward: true });
    report("CLICK_THROUGH_TOGGLE ignoreMouseEvents=" + !off + " t_ms=" + (Date.now() - t0));
  }, 4000);
  setTimeout(() => {
    report("SUMMARY t_ms=" + (Date.now() - t0) + " diag=" + JSON.stringify(windowDiag()));
    report("T_EXIT t_ms=" + (Date.now() - t0));
    app.quit();
  }, runSeconds * 1000);
});
app.on("window-all-closed", () => app.quit());
