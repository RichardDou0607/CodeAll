#!/usr/bin/env bash
# scripts/win11-sandbox/service.sh — 沙箱上 CodeAll 本地服务（demo/framed.mjs）的管理
# start [端口] / status / stop / log [行数]；端口默认 7799，可用 WIN11_PORT 覆盖。
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SELF_DIR/common.sh"

HOST="${WIN11_HOST:-win11}"
DEST="${WIN11_DEST:-C:\\Users\\admin\\codeall}"
PORT="${WIN11_PORT:-7799}"
LOG="$DEST\\.win-service.log"
ERRLOG="$DEST\\.win-service.err.log"

say() { printf '\033[36m[win11-service]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[win11-service]\033[0m %s\n' "$*" >&2; exit 1; }
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535)); }
valid_lines() { [[ "$1" =~ ^[0-9]+$ ]] && ((10#$1 >= 1 && 10#$1 <= 10000)); }
listening() {
  win11_ps "$HOST" "Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"
}

valid_port "$PORT" || die "WIN11_PORT 必须是 1-65535 的数字"
case "${1:-}" in
start)
  PORT_ARG="${2:-$PORT}"
  valid_port "$PORT_ARG" || die "端口必须是 1-65535 的数字"
  PORT="$PORT_ARG"
  if [[ -n "$(listening 2>/dev/null)" ]]; then
    die "端口 $PORT_ARG 已被占用（先 ./service.sh stop）"
  fi
  say "后台启动 demo/framed.mjs --port $PORT_ARG"
  win11_ps "$HOST" "\$wd=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$(win11_text_b64 "$DEST")')); \$cl='cmd /c node demo/framed.mjs --port $PORT_ARG > .win-service.log 2> .win-service.err.log'; \$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=\$cl;CurrentDirectory=\$wd}; if(\$r.ReturnValue -eq 0){ Write-Output ('STARTED pid='+\$r.ProcessId) } else { Write-Error ('FAILED rc='+\$r.ReturnValue); exit 1 }" \
    || die "启动命令失败（node 不在系统 PATH 或工作区缺文件：先跑 ./sync.sh）"
  sleep 2
  exec env WIN11_PORT="$PORT_ARG" "$0" status
  ;;
status)
  L="$(listening 2>/dev/null | tr -d '\r')"
  if [[ -z "$L" ]]; then
    say "未监听 :$PORT（服务没在跑；./service.sh start）"
    exit 1
  fi
  say "监听中："; echo "$L" | sed 's/^/    /'
  CODE="$(win11_ps "$HOST" "try { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:$PORT/api/state).StatusCode } catch { \$_.Exception.Response.StatusCode.value__ }")"
  say "/api/state 探活：HTTP ${CODE//$'\r'/}"
  ;;
stop)
  PIDS="$(listening 2>/dev/null | tr -d '\r')"
  if [[ -z "$PIDS" ]]; then say "未监听 :$PORT，无需停止"; exit 0; fi
  for pid in $PIDS; do
    [[ "$pid" =~ ^[0-9]+$ ]] || die "无法确认监听进程 PID"
    win11_ps "$HOST" "\$p=Get-CimInstance Win32_Process -Filter 'ProcessId=$pid'; if (\$p -and \$p.CommandLine -match 'demo[/\\\\]framed\\.mjs') { Stop-Process -Id $pid -Force -ErrorAction Stop } else { Write-Error '拒绝停止非 CodeAll 进程'; exit 1 }" \
      || die "停止失败：未终止不匹配的进程"
  done
  if [[ -n "$(listening 2>/dev/null | tr -d '\r')" ]]; then die "端口 $PORT 仍在监听，请检查进程"; fi
  say "已停止 :$PORT"
  ;;
log)
  N="${2:-30}"
  valid_lines "$N" || die "日志行数必须是 1-10000 的数字"
  win11_ps "$HOST" "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Content -Tail $N -Encoding UTF8 -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$(win11_text_b64 "$LOG")')) ) -ErrorAction SilentlyContinue; Write-Output '--- err ---'; Get-Content -Tail $N -Encoding UTF8 -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$(win11_text_b64 "$ERRLOG")')) ) -ErrorAction SilentlyContinue"
  ;;
*)
  sed -n '2,5p' "$0"
  exit 1
  ;;
esac
