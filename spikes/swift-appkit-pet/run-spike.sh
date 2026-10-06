#!/usr/bin/env bash
# T1 spike · Swift/AppKit 桌宠端到端复现脚本
# 用法：./run-spike.sh [scenario]   scenario: demo(默认) | unknown-storm
set -uo pipefail
cd "$(dirname "$0")"
SCENARIO="demo"
if [ "$#" -ge 1 ]; then SCENARIO="$1"; fi
PET_DIR="$(node -e 'console.log(require("os").tmpdir())')/agent-pet"
SOCK="$PET_DIR/swift-spike.sock"
REPORT="$PET_DIR/swift-spike-report.jsonl"
LOG=artifacts/app-stdout.log
mkdir -p artifacts bin
rm -f "$SOCK" "$REPORT" artifacts/*.png "$LOG"

echo "== 1. 启动桌宠（透明窗口 + socket 服务端）=="
SPAWN_MS=$(node -e 'console.log(Date.now())')
./bin/swift-pet --socket "$SOCK" --report "$REPORT" --artifacts artifacts --run-seconds 14 \
  --click-through-toggle-at 4 > "$LOG" 2>&1 &
APP_PID=$!
for _ in $(seq 1 60); do grep -q "^READY " "$LOG" 2>/dev/null && break; sleep 0.2; done
T_START_EPOCH=$(grep -m1 '^T_START' "$LOG" | sed -E 's/.*t_ms=([0-9]+).*/\1/')
READY_T=$(grep -m1 '^READY ' "$LOG" | sed -E 's/.*t_ms=([0-9]+).*/\1/')
BOOT_T=$(grep -m1 'WINDOW_CHECK tag=boot' "$LOG" | sed -E 's/.*t_ms=([0-9]+).*/\1/')
echo "spawn->进程启动 ms: $((T_START_EPOCH - SPAWN_MS))"
echo "进程启动->窗口创建 ms: $BOOT_T"
echo "进程启动->socket READY ms: $READY_T"

echo "== 2. 独立工具 CGWindowList 交叉核对（置顶 level / alpha / onscreen）=="
../tools/bin/wininfo swift-pet

echo "== 3. 空闲内存（ps rss，单位 KB；采样 3 次）=="
sleep 3
for _ in 1 2 3; do ps -o rss=,vsz= -p "$APP_PID" | awk '{printf "rss=%.1fMB vsz=%.1fMB\n", $1/1024, $2/1024}'; sleep 1; done

echo "== 4. 注入规范事件（Unix socket + JSONL，契约 v1）=="
if [ "$SCENARIO" = "unknown-storm" ]; then
  node ../jsonl-feed/feed.mjs --socket "$SOCK" --scenario unknown-storm --count 1000 --gap 0 --record "$PET_DIR/fed-unknown.jsonl"
  sleep 1
else
  node ../jsonl-feed/feed.mjs --socket "$SOCK" --scenario demo --gap 700 --record "$PET_DIR/fed-demo.jsonl"
fi

echo "== 5. 等待自动退出并汇总 =="
wait "$APP_PID"; APP_EXIT=$?
echo "app_exit=$APP_EXIT"
echo "--- 状态序列 ---"; grep '^DOM_APPLIED' "$LOG" | sed -E 's/^DOM_APPLIED //'
echo "--- 窗口自检 ---"; grep -E '^(WINDOW_CHECK|CGWINDOW_CHECK|CLICK_THROUGH_TOGGLE)' "$LOG"
echo "--- 快照 ---"; grep '^SNAPSHOT' "$LOG"
echo "--- 汇总 ---"; grep -E '^(SUMMARY|UNKNOWN_EVENT)' "$LOG" | tail -5
echo "--- 快照文件 SHA-256（证明画面确实变化）---"; shasum -a 256 artifacts/*.png 2>/dev/null
