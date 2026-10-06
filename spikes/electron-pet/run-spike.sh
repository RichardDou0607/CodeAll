#!/usr/bin/env bash
# T1 spike · Electron 桌宠端到端复现脚本
set -uo pipefail
cd "$(dirname "$0")"
PET_DIR="$(node -e 'console.log(require("os").tmpdir())')/agent-pet"
mkdir -p artifacts
LOG=artifacts/app-stdout.log
rm -f "$PET_DIR/electron-spike.sock" artifacts/*.png "$LOG" 2>/dev/null
export PET_SPIKE_SOCKET="$PET_DIR/electron-spike.sock"
export PET_SPIKE_REPORT="$PET_DIR/electron-spike-report.jsonl"
export PET_SPIKE_RUN_SECONDS=20

echo "== 1. 启动 Electron 桌宠 =="
# 注意：pnpm 下 node_modules/.bin/electron 是 JS shim，直接用真实二进制更可靠
ELECTRON_BIN="$(node -e 'const p=require("path");console.log(p.join(p.dirname(require.resolve("electron/package.json")),"dist/Electron.app/Contents/MacOS/Electron"))')"
echo "electron binary: $ELECTRON_BIN"
# 关键：本机环境若从 DSH(Electron 应用) 继承 ELECTRON_RUN_AS_NODE=1，Electron 会退化成纯 Node，
# 导致 require("electron") 返回路径字符串、ipcMain 为 undefined。必须显式清除。
if [ "${ELECTRON_RUN_AS_NODE:-}" = "1" ]; then echo "注意：检测到 ELECTRON_RUN_AS_NODE=1，已为本次运行清除"; fi
env -u ELECTRON_RUN_AS_NODE "$ELECTRON_BIN" . > "$LOG" 2>&1 &
APP_PID=$!
for _ in $(seq 1 100); do grep -q "^READY " "$LOG" 2>/dev/null && break; sleep 0.3; done
echo "主进程 pid=$APP_PID"

echo "== 2. 进程树与内存（Electron 真实占用 = 主进程 + Renderer + GPU + Utility）=="
sleep 4
node ../tools/tree-rss.mjs "$APP_PID" --label ELECTRON

echo "== 3. 独立工具 CGWindowList 交叉核对 =="
../tools/bin/wininfo Electron

echo "== 4. 注入规范事件 =="
node ../jsonl-feed/feed.mjs --socket "$PET_SPIKE_SOCKET" --scenario demo --gap 700 --record "$PET_DIR/fed-electron.jsonl"

echo "== 5. 退出并汇总 =="
wait "$APP_PID"
echo "--- 关键日志 ---"
grep -E '^(T_START|WINDOW_CREATED|WINDOW_SHOWN|FRONTEND_READY|READY |CLIENT_CONNECTED|DOM_APPLIED|WINDOW_DIAG|CLICK_THROUGH|SUMMARY|T_EXIT)' "$LOG"
echo "--- Electron 运行时体积 ---"
du -sh "$(node -e 'console.log(require("path").dirname(require.resolve("electron")))')/dist/Electron.app" 2>/dev/null
