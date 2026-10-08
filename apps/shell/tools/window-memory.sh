#!/usr/bin/env bash
# apps/shell/tools/window-memory.sh — 位置记忆端到端复现（移动 → 落盘 → 重启 → 恢复）
#
#   apps/shell/tools/window-memory.sh [端口]
#
# 用外壳自带的自检钩子 AGENT_PET_SELFTEST=move:<逻辑x>,<逻辑y>：
#   第一次启动：把窗口移到指定位置 → 节流落盘 → 退出
#   第二次启动：不带钩子 → 应恢复到同一位置（wininfo 独立核对）
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHELL_DIR="$(cd "$SELF_DIR/.." && pwd)"
ROOT="$(cd "$SHELL_DIR/../.." && pwd)"
TOOLS="$ROOT/spikes/tools"
ART="$SHELL_DIR/artifacts"; mkdir -p "$ART"
PORT="${1:-7802}"
X=300; Y=200

APP="$SHELL_DIR/src-tauri/target/release/bundle/macos/CodeAll.app"
BIN="$(ls "$APP/Contents/MacOS/"* 2>/dev/null | head -1)"
WINDOW_JSON="$HOME/Library/Application Support/com.agentpet.shell/window.json"

hr() { printf '\n\033[36m== %s ==\033[0m\n' "$*"; }
if [ ! -x "$BIN" ]; then echo "找不到产物 $BIN" >&2; exit 2; fi

pkill -f 'CodeAll.app/Contents/MacOS/agent-pet-shell' 2>/dev/null; sleep 0.6

hr "0. 清掉旧记录（否则本次只算“恢复到旧值”）"
rm -f "$WINDOW_JSON"
echo "  rm -f $WINDOW_JSON → $([ -f "$WINDOW_JSON" ] && echo 仍在 || echo 已删除)"

hr "1. 第一次启动：自检把窗口移到逻辑 ($X,$Y)，落盘后退出"
L1="$ART/memory-run1.log"
AGENT_PET_PORT="$PORT" AGENT_PET_SELFTEST="move:$X,$Y" "$BIN" > "$L1" 2>&1
echo "  退出码=$?"
grep -E 'WINDOW_RESTORE|SELFTEST|WINDOW_SAVED|SHUTDOWN' "$L1" | sed 's/^/    /'
echo "  window.json 现在的内容:"
[ -f "$WINDOW_JSON" ] && sed 's/^/    /' "$WINDOW_JSON" || echo "    （不存在 —— 失败）"

hr "2. 第二次启动：不带自检，应恢复到上面记录的位置"
L2="$ART/memory-run2.log"
AGENT_PET_PORT="$PORT" "$BIN" > "$L2" 2>&1 &
APP_PID=$!
for _ in $(seq 1 100); do grep -q 'WINDOW_SHOWN' "$L2" 2>/dev/null && break; sleep 0.05; done
sleep 0.8
grep -E 'WINDOW_RESTORE|WINDOW_SHOWN' "$L2" | sed 's/^/    /'
hr "3. 独立核对（wininfo / CGWindowList）"
"$TOOLS/bin/wininfo" CodeAll | sed 's/^/  /'
BOUNDS=$("$TOOLS/bin/wininfo" CodeAll | sed -n 's/.*bounds=(x:\([-0-9]*\) y:\([-0-9]*\) w:\([0-9]*\) h:\([0-9]*\)).*/\1 \2 \3 \4/p' | head -1)
echo "  实际 bounds = $BOUNDS   （期望 $X $Y 360 340）"
if [ "$BOUNDS" = "$X $Y 360 340" ]; then echo "  POSITION_MEMORY_OK"; else echo "  POSITION_MEMORY_MISMATCH"; fi

kill -TERM "$APP_PID" 2>/dev/null; sleep 1.2
echo
echo "  日志：$L1  $L2"
