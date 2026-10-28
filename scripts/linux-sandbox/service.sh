#!/usr/bin/env bash
# scripts/linux-sandbox/service.sh — Linux 验证机上 CodeAll 本地服务（demo/framed.mjs）的管理
# start [端口] / status / stop / log [行数]；端口默认 7799，可用 LINUX_PORT 覆盖。
#
# start：setsid nohup 分离进程（断 ssh 不死，对位 win11 的 WMI Create）。
# stop：双精确匹配（监听端口 PID + 命令行含 demo/framed.mjs）才杀，拒绝误杀其它进程
#       （对位 docs/36 §9 审查后收紧的 win11 版语义）。
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SELF_DIR/common.sh"

HOST="${LINUX_HOST:-$LINUX_HOST_DEFAULT}"
DEST="${LINUX_DEST:-$LINUX_DEST_DEFAULT}"
PORT="${LINUX_PORT:-$LINUX_PORT_DEFAULT}"
LOG='.linux-service.log'

say() { printf '\033[36m[linux-service]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[linux-service]\033[0m %s\n' "$*" >&2; exit 1; }
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535)); }
valid_lines() { [[ "$1" =~ ^[0-9]+$ ]] && ((10#$1 >= 1 && 10#$1 <= 10000)); }

# 远端只跑一条命令的工具（不走 bash -l 的地方）
rsh() { ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" "$@"; }

# 监听 :PORT 的 PID（ss 输出 users:(("node",pid=1234,fd=...))）
listening_pids() {
  rsh "ss -ltnp \"sport = :$PORT\" 2>/dev/null" \
    | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
}

valid_port "$PORT" || die "LINUX_PORT 必须是 1-65535 的数字"
case "${1:-}" in
start)
  PORT_ARG="${2:-$PORT}"
  valid_port "$PORT_ARG" || die "端口必须是 1-65535 的数字"
  PORT="$PORT_ARG"
  if [[ -n "$(listening_pids)" ]]; then
    die "端口 $PORT_ARG 已被占用（先 ./service.sh stop）"
  fi
  say "后台启动 demo/framed.mjs --port $PORT_ARG（setsid 分离）"
  # 双层 bash：内层 bash 后台起 node（FD 全改道）后立即退出，外层 echo 完即返——
  # 单层写法（async list + echo）下外层 bash 可能随 node 存活滞留，ssh 管道不 EOF、本脚本被挂住（实测两次）。
  rsh "cd $DEST && bash -c 'PATH=\$HOME/.local/bin:\$PATH exec setsid nohup node demo/framed.mjs --port $PORT_ARG > $LOG 2>&1 < /dev/null &' ; echo STARTED" \
    || die "启动失败（node 不在 PATH 或工作区缺文件：先跑 ./sync.sh）"
  sleep 2
  exec env LINUX_PORT="$PORT_ARG" "$0" status
  ;;
status)
  PIDS="$(listening_pids)"
  if [[ -z "$PIDS" ]]; then
    say "未监听 :$PORT（服务没在跑；./service.sh start）"
    exit 1
  fi
  say "监听中：pid $(echo "$PIDS" | tr '\n' ' ')"
  say "进程：$(rsh "ps -o args= -p $(echo "$PIDS" | head -1)" 2>/dev/null)"
  CODE="$(rsh "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/api/state" 2>/dev/null)"
  say "/api/state 探活：HTTP ${CODE:-?}"
  [[ "$CODE" == "200" ]] || exit 1
  ;;
stop)
  PIDS="$(listening_pids)"
  if [[ -z "$PIDS" ]]; then say "未监听 :$PORT，无需停止"; exit 0; fi
  for pid in $PIDS; do
    [[ "$pid" =~ ^[0-9]+$ ]] || die "无法确认监听进程 PID"
    CMDLINE="$(rsh "tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null" || true)"
    if [[ "$CMDLINE" == *demo/framed.mjs* ]]; then
      rsh "kill $pid" || die "kill $pid 失败"
      say "已停止 pid $pid"
    else
      die "拒绝停止非 CodeAll 进程：pid $pid 的命令行为「$CMDLINE」"
    fi
  done
  sleep 1
  if [[ -n "$(listening_pids)" ]]; then die "端口 $PORT 仍在监听，请检查进程"; fi
  say "已停止 :$PORT"
  ;;
log)
  N="${2:-30}"
  valid_lines "$N" || die "日志行数必须是 1-10000 的数字"
  rsh "tail -n $N $DEST/$LOG 2>/dev/null"
  ;;
*)
  sed -n '2,8p' "$0"
  exit 1
  ;;
esac
