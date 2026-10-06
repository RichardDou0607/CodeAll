#!/usr/bin/env bash
# T1 spike · Tauri v2 桌宠端到端复现脚本（release 二进制）
# 前置：cd spikes/tauri-pet && pnpm install && pnpm tauri build
set -uo pipefail
cd "$(dirname "$0")"
BIN=./src-tauri/target/release/tauri-pet
PET_DIR="$(node -e 'console.log(require("os").tmpdir())')/agent-pet"
mkdir -p artifacts
LOG=artifacts/app-stdout.log
SOCK="$PET_DIR/tauri-spike.sock"
rm -f "$SOCK" "$LOG"
export PET_SPIKE_SOCKET="$SOCK"
export PET_SPIKE_REPORT="$PET_DIR/tauri-spike-report.jsonl"

echo "== 0. 二进制体积 =="
ls -l "$BIN" | awk '{printf "binary=%.1fMB %s\n", $5/1048576, $9}'
du -sh src-tauri/target/release/bundle/macos/*.app 2>/dev/null

echo "== 1. 启动 Tauri 桌宠 =="
START_MS=$(node -e 'console.log(Date.now())')
"$BIN" > "$LOG" 2>&1 &
APP_PID=$!
READY_SEEN=""
for _ in $(seq 1 400); do
  if grep -q "^READY " "$LOG" 2>/dev/null; then READY_SEEN=$(node -e 'console.log(Date.now())'); break; fi
  sleep 0.05
done
echo "spawn->READY 墙钟 ms: $((READY_SEEN - START_MS))"
echo "应用内部 t_ms（setup 起算）: $(grep -m1 '^READY ' "$LOG" | sed -E 's/.*t_ms=([0-9]+).*/\1/')"

echo "== 2. 空闲内存（进程树 RSS，含 WKWebView 辅助进程）=="
sleep 5
node ../tools/tree-rss.mjs "$APP_PID" --label TAURI
echo "--- 系统内 WebKit/WebContent 进程（WKWebView 由系统 XPC 管理时不在进程树内）---"
ps -ax -o pid=,rss=,comm= | grep -iE 'WebContent|WebKit' | head -10

echo "== 3. 独立工具 CGWindowList 交叉核对 =="
../tools/bin/wininfo tauri-pet

echo "== 4. 注入规范事件（demo 全 6 态）=="
node ../jsonl-feed/feed.mjs --socket "$SOCK" --scenario demo --gap 700 --record "$PET_DIR/fed-tauri.jsonl"

echo "== 5. 收尾 =="
sleep 1
kill "$APP_PID" 2>/dev/null
sleep 1
echo "--- 关键日志 ---"
grep -E '^(READY |WINDOW_CONFIG|CLICK_THROUGH|FRONTEND_READY|WINDOW_DIAG|SOCKET_EVENT|DOM_APPLIED|PARSE_ERR|BIND_FAIL)' "$LOG"
