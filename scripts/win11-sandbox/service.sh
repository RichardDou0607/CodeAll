#!/usr/bin/env bash
# scripts/win11-sandbox/service.sh — 沙箱上 CodeAll 本地服务（demo/framed.mjs）的管理
#
#   ./service.sh start [端口]   # 后台启动：Start-Process 独立进程，断开 ssh 不死
#   ./service.sh status         # 端口监听 + /api/state 探活（服务只绑 127.0.0.1，须在沙箱本地探）
#   ./service.sh stop           # 按端口找 PID 并 taskkill
#   ./service.sh log [行数]     # 尾部日志（默认 30 行，stdout 与 err 都打）
#
# 前提：先跑过 ./sync.sh（工作区里有 demo/framed.mjs 与全部源码）。
# 端口默认 7799，与 demo/framed.mjs 一致；WIN11_PORT 可改。
set -uo pipefail

HOST="${WIN11_HOST:-win11}"
DEST="${WIN11_DEST:-C:\\Users\\admin\\codeall}"
PORT="${WIN11_PORT:-7799}"
LOG="$DEST\\.win-service.log"
ERRLOG="$DEST\\.win-service.err.log"

say() { printf '\033[36m[win11-service]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[win11-service]\033[0m %s\n' "$*" >&2; exit 1; }

listening() {  # 输出 LISTENING 行（含 PID），空则未监听
  ssh -o BatchMode=yes "$HOST" "netstat -ano | findstr :$PORT | findstr LISTENING"
}

case "${1:-}" in
start)
  PORT_ARG="${2:-$PORT}"
  if [[ -n "$(listening 2>/dev/null)" ]]; then
    die "端口 $PORT_ARG 已被占用（先 ./service.sh stop）"
  fi
  say "后台启动 demo/framed.mjs --port $PORT_ARG"
  # WMI Win32_Process.Create 起进程：父进程是 WmiPrvSE，不挂在 ssh 会话上——断开 ssh 不死
  #（Start-Process 不行：node 路径含空格且 sshd 会话结束可能连带杀子进程）。
  ssh -o BatchMode=yes "$HOST" "powershell -NoProfile -Command \"\$wd='$DEST'; \$cl='cmd /c node demo/framed.mjs --port $PORT_ARG > .win-service.log 2> .win-service.err.log'; \$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=\$cl;CurrentDirectory=\$wd}; if(\$r.ReturnValue -eq 0){ Write-Output ('STARTED pid='+\$r.ProcessId) } else { Write-Output ('FAILED rc='+\$r.ReturnValue) }\"" \
    || die "启动命令失败（node 不在系统 PATH 或工作区缺文件：先跑 ./sync.sh）"
  sleep 2
  exec "$0" status
  ;;
status)
  L="$(listening 2>/dev/null | head -3)"
  if [[ -z "$L" ]]; then
    say "未监听 :$PORT（服务没在跑；./service.sh start）"
    exit 1
  fi
  say "监听中："; echo "$L" | sed 's/^/    /'
  CODE="$(ssh -o BatchMode=yes "$HOST" "powershell -NoProfile -Command \"try { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:$PORT/api/state).StatusCode } catch { \$_.Exception.Response.StatusCode.value__ }\"")"
  say "/api/state 探活：HTTP $CODE"
  ;;
stop)
  PIDS="$(listening 2>/dev/null | awk '{print $NF}' | sort -u)"
  if [[ -z "$PIDS" ]]; then say "未监听 :$PORT，无需停止"; exit 0; fi
  for pid in $PIDS; do
    ssh -o BatchMode=yes "$HOST" "taskkill /F /PID $pid" && say "已结束 PID $pid"
  done
  ;;
log)
  N="${2:-30}"
  ssh -o BatchMode=yes "$HOST" "powershell -NoProfile -Command \"[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Content -Tail $N -Encoding UTF8 '$LOG' -ErrorAction SilentlyContinue; Write-Output '--- err ---'; Get-Content -Tail $N -Encoding UTF8 '$ERRLOG' -ErrorAction SilentlyContinue\""
  ;;
*)
  sed -n '2,10p' "$0" | sed -e 's/^#\{1,\} \{0,1\}//'
  exit 1
  ;;
esac
