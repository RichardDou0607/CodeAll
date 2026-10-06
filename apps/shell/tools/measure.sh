#!/usr/bin/env bash
# apps/shell/tools/measure.sh — M1 验收数据采集（可复制命令 + 真实输出）
#
#   apps/shell/tools/measure.sh                 # 默认端口 7799
#   PET_PORT=7801 apps/shell/tools/measure.sh   # 换端口（用于验证「服务未启动→自动拉起」）
#
# 采集项
#   1 .app 体积          2 端口状态（决定走自愈拉起还是复用外部服务）
#   3 启动耗时（墙钟 + 外壳内部 t_ms）
#   4 远程页是否真连上本地服务（lsof 独立核对）
#   5 空闲 phys_footprint（footprint(1)，含 WebContent 子进程）
#   6 窗口层级（spikes/tools/bin/wininfo，CGWindowList 交叉核对）
#   7 透明（窗口单独截图 → 角像素 alpha；并与整屏同区域交叉核对）
#   8 拖拽能力（macOS 原生 API 回读）
#   9 位置记忆（退出前后 window.json + wininfo 位置）
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHELL_DIR="$(cd "$SELF_DIR/.." && pwd)"
ROOT="$(cd "$SHELL_DIR/../.." && pwd)"
TOOLS="$ROOT/spikes/tools"
ART="$SHELL_DIR/artifacts"
mkdir -p "$ART"

PORT="${PET_PORT:-7799}"
APP="$SHELL_DIR/src-tauri/target/release/bundle/macos/AgentPet.app"
BIN="$(ls "$APP/Contents/MacOS/"* 2>/dev/null | head -1)"
LOG="$ART/run.log"
WINDOW_JSON="$HOME/Library/Application Support/com.agentpet.shell/window.json"

now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
hr() { printf '\n\033[36m== %s ==\033[0m\n' "$*"; }
wall() { if [ -n "${2:-}" ]; then echo "$(( $2 - $1 )) ms"; else echo "（未观测到）"; fi; }
# AgentPet 名下可能同时挂着 layer=101 的弹出菜单/提示窗，取面积最大的那个当主窗口
main_win_line() {
  "$TOOLS/bin/wininfo" AgentPet | grep '^window=' \
    | sed -n 's/.*bounds=(x:\([-0-9]*\) y:\([-0-9]*\) w:\([0-9]*\) h:\([0-9]*\)).*/\3 \4 &/p' \
    | sort -rn -k1,1 | head -1 | cut -d' ' -f3-
}
main_win_id() { main_win_line | sed -n 's/^window=\([0-9]*\).*/\1/p'; }
main_win_bounds() { main_win_line | sed -n 's/.*bounds=(x:\([-0-9]*\) y:\([-0-9]*\) w:\([0-9]*\) h:\([0-9]*\)).*/\1 \2 \3 \4/p'; }

if [ ! -x "$BIN" ]; then echo "找不到产物 ${BIN}，请先跑 apps/shell/run.sh --build" >&2; exit 2; fi

kill_pet() { pkill -f 'AgentPet.app/Contents/MacOS/agent-pet-shell' 2>/dev/null; sleep 0.6; }
wait_for() {
  local pat="$1" tmo="${2:-30}" i=0
  while [ "$i" -lt $((tmo * 20)) ]; do
    grep -qE "$pat" "$LOG" 2>/dev/null && return 0
    sleep 0.05; i=$((i + 1))
  done
  return 1
}
descendants() {
  node -e '
    const {execSync}=require("child_process");
    const root=Number(process.argv[1]);
    const rows=execSync("ps -ax -o pid=,ppid=",{encoding:"utf8"}).trim().split("\n")
      .map(l=>l.trim().split(/\s+/).map(Number));
    const by=new Map();
    for(const r of rows){ const p=r[0], pp=r[1]; if(!by.has(pp)) by.set(pp,[]); by.get(pp).push(p); }
    const out=[root], st=[root];
    while(st.length){ const c=st.pop(); for(const k of (by.get(c)||[])){ out.push(k); st.push(k);} }
    console.log(out.join(" "));
  ' "$1"
}

kill_pet

hr "0. 环境"
echo "macOS : $(sw_vers -productVersion) ($(sw_vers -buildVersion))   arch: $(uname -m)"
echo "node  : $(node -v)   pnpm: $(pnpm -v)"
echo "cargo : $(PATH="$HOME/.cargo/bin:$PATH" cargo -V)"
echo "rustc : $(PATH="$HOME/.cargo/bin:$PATH" rustc -V)"

hr "1. .app 体积"
du -sh "$APP" | sed 's/^/  /'
du -sk "$APP" | awk '{printf "  = %.2f MiB (du -sk/1024)\n", $1/1024}'
ls -l "$BIN" | awk '{printf "  主可执行文件 %.2f MiB  %s\n", $5/1048576, $9}'
echo "  最大的 3 个文件:"
find "$APP" -type f -exec stat -f '%z %N' {} + | sort -rn | head -3 | awk '{printf "    %8.2f MiB  %s\n", $1/1048576, $2}'

hr "2. 端口状态（决定走「自愈拉起」还是「复用外部服务」）"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  $PORT 已被占用 → 外壳应走 SERVER_ALREADY_UP 分支："
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | sed 's/^/    /'
  LAUNCH_PATH="external"
else
  echo "  $PORT 空闲 → 外壳应自动拉起 demo/framed.mjs"
  LAUNCH_PATH="autolaunch"
fi

hr "3. 启动耗时（墙钟：exec → 各里程碑）"
: > "$LOG"
webkit_pids() { ps -ax -o pid=,comm= | grep -i 'WebKit' | awk '{print $1}' | sort -n; }
webkit_pids > "$ART/.wk-before"
T_SPAWN=$(now_ms)
"$BIN" > "$LOG" 2>&1 &
APP_PID=$!
T_SHOWN=""; T_SERVER=""; T_NAV=""; T_REMOTE=""
wait_for 'WINDOW_SHOWN' 30 && T_SHOWN=$(now_ms)
wait_for 'SERVER_ALREADY_UP|SERVER_UP_LAUNCHED' 30 && T_SERVER=$(now_ms)
wait_for 'SHELL_NAVIGATE' 30 && T_NAV=$(now_ms)
wait_for 'REMOTE_COMMITTED' 60 && T_REMOTE=$(now_ms)
wait_for 'REMOTE_STYLED' 60 || true
sleep 0.5
echo "  pid=$APP_PID"
echo "  exec → 窗口可见 (WINDOW_SHOWN)       : $(wall "$T_SPAWN" "$T_SHOWN")"
echo "  exec → 本地服务就绪                  : $(wall "$T_SPAWN" "$T_SERVER")"
echo "  exec → 导航指令 (SHELL_NAVIGATE)     : $(wall "$T_SPAWN" "$T_NAV")"
echo "  exec → 远程页提交 (REMOTE_COMMITTED) : $(wall "$T_SPAWN" "$T_REMOTE")"
echo "  外壳内部 t_ms（进程起算，摘自日志）:"
grep -E '^\[shell' "$LOG" | sed 's/^/    /'

hr "4. 远程页是否真的连上本地服务（独立核对，非应用自述）"
sleep 1
lsof -nP -iTCP:"$PORT" | sed 's/^/  /'
echo "  ESTABLISHED 连接数 = $(lsof -nP -iTCP:"$PORT" 2>/dev/null | grep -c ESTABLISHED)"

hr "5. 空闲 phys_footprint（footprint(1)）"
sleep 6
PIDS=$(descendants "$APP_PID")
echo "  外壳进程树 pid: $PIDS"
"$TOOLS/footprint-sum.sh" SHELL $PIDS | sed 's/^/  /'
# WKWebView 的渲染/网络进程由系统 XPC 托管，不在应用进程树里：用「启动前后 WebKit 进程集合差」揪出来
webkit_pids > "$ART/.wk-after"
WEBPIDS=$(comm -13 "$ART/.wk-before" "$ART/.wk-after" | tr '\n' ' ')
if [ -n "$WEBPIDS" ]; then
  echo "  本次启动新出现的 WebKit 系统进程（不在应用进程树内）:"
  for P in $WEBPIDS; do echo "    pid=$P  $(ps -o comm= -p "$P" 2>/dev/null)"; done
  "$TOOLS/footprint-sum.sh" WEBKIT $WEBPIDS | sed 's/^/  /'
else
  echo "  WebKit 系统进程: 未识别"
fi
echo "  —— 明细（footprint(1) 前几行）——"
for P in $APP_PID $WEBPIDS; do
  echo "    pid=$P $(ps -o comm= -p "$P" 2>/dev/null | sed 's|.*/||')"
  footprint -p "$P" 2>/dev/null | grep -E 'phys_footprint|TOTAL' | tail -2 | sed 's/^/      /'
done

hr "6. 窗口层级交叉核对（独立工具 CGWindowList，非应用自述）"
"$TOOLS/bin/wininfo" AgentPet | sed 's/^/  /'
echo "  —— 对照：同一时刻全屏窗口的 layer 分布（证明本窗口被抬到浮动层）——"
"$TOOLS/bin/wininfo" "" | sed -n 's/.* owner=\(.*\) name=.* layer=\(-\{0,1\}[0-9]*\) .*/\2\t\1/p' | sort -n | uniq -c | head -12 | sed 's/^/    /'

hr "7. 透明验证（窗口单独截图 → 角像素 alpha）"
WINID=$(main_win_id)
echo "  CGWindowID=${WINID}（主窗口，按面积取；AgentPet 名下全部窗口如下）"
"$TOOLS/bin/wininfo" AgentPet | sed 's/^/    /'
if [ -n "$WINID" ]; then
  screencapture -x -o -l "$WINID" "$ART/window.png"
  ls -l "$ART/window.png" | sed 's/^/  /'
  INFO=$("$TOOLS/bin/pixelprobe" "$ART/window.png" 2 2)
  echo "$INFO" | sed 's/^/  /'
  W=$(echo "$INFO" | sed -n 's/^image=\([0-9]*\)x.*/\1/p')
  H=$(echo "$INFO" | sed -n 's/^image=[0-9]*x\([0-9]*\).*/\1/p')
  if [ -n "$W" ] && [ -n "$H" ]; then
    echo "  —— 四角 / 中心像素 ——"
    for xy in "1 1" "2 2" "$((W - 3)) 2" "2 $((H - 3))" "$((W / 2)) $((H / 2))"; do
      "$TOOLS/bin/pixelprobe" "$ART/window.png" $xy | tail -1 | sed 's/^/    /'
    done
  fi
  B=$(main_win_bounds)
  set -- $B
  if [ $# -eq 4 ]; then
    screencapture -x -R "$1,$2,$3,$4" "$ART/screen-region.png"
    echo "  —— 同一区域的整屏合成截图（角像素应＝底层桌面，说明外壳没画那里）——"
    "$TOOLS/bin/pixelprobe" "$ART/screen-region.png" 2 2 | tail -1 | sed 's/^/    /'
  fi
fi

hr "8. 拖拽能力（macOS 原生 API 回读）"
grep -E 'MOVABLE_BY_BACKGROUND' "$LOG" | sed 's/^/  /'

hr "9. 位置记忆（移动 → 落盘 → 退出 → 重启恢复；完整往返见 tools/window-memory.sh）"
echo "  window.json = $WINDOW_JSON"
echo "  当前窗口位置（wininfo，主窗口）: $(main_win_bounds)"
echo "  关掉本次实例（SIGTERM 会触发外壳的信号收尾：保存位置 + 收掉自己拉起的服务）…"
kill -TERM "$APP_PID" 2>/dev/null
sleep 1.2
echo "  优雅退出+自检移动（AGENT_PET_SELFTEST=move:420,260，退出码应为 0）："
AGENT_PET_PORT="$PORT" AGENT_PET_SELFTEST="move:420,260" "$BIN" > "$ART/memory-selftest.log" 2>&1
echo "    退出码=$?"
grep -E 'WINDOW_RESTORE|SELFTEST|WINDOW_SAVED|SHUTDOWN' "$ART/memory-selftest.log" | sed 's/^/      /'
echo "  自检退出后 window.json:"
if [ -f "$WINDOW_JSON" ]; then sed 's/^/    /' "$WINDOW_JSON"; else echo "    （不存在）"; fi
echo "  再启动一次，核对是否恢复到 420,260（wininfo 独立核对）："
AGENT_PET_PORT="$PORT" "$BIN" > "$ART/memory-restore.log" 2>&1 &
R_PID=$!
for _ in $(seq 1 100); do grep -q 'WINDOW_SHOWN' "$ART/memory-restore.log" 2>/dev/null && break; sleep 0.05; done
sleep 0.6
grep -E 'WINDOW_RESTORED' "$ART/memory-restore.log" | sed 's/^/    /'
RB=$(main_win_bounds)
echo "    实际 bounds = $RB （期望 420 260 360 340）"
if [ "$RB" = "420 260 360 340" ]; then echo "    POSITION_MEMORY_OK"; else echo "    POSITION_MEMORY_MISMATCH"; fi
kill -TERM "$R_PID" 2>/dev/null; sleep 1

hr "10. 收尾"
if [ "$LAUNCH_PATH" = "autolaunch" ]; then
  echo "  清掉本次由外壳拉起的 demo/framed.mjs（端口 ${PORT}）"
  pkill -f "demo/framed.mjs --port $PORT" 2>/dev/null
  sleep 0.6
else
  echo "  端口 $PORT 上的服务是外部进程，不动它"
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  端口 $PORT 仍被占用："; lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | sed 's/^/    /'
else
  echo "  端口 $PORT 已释放"
fi

echo
echo "  原始日志: $LOG"
echo "  窗口截图: $ART/window.png"
echo "  启动路径: $LAUNCH_PATH"
