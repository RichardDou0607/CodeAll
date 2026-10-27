#!/usr/bin/env bash
# scripts/win11-sandbox/exec.sh — 在 Win11 沙箱工作区里执行一条命令
#
#   ./exec.sh "node --version"                        # 经 cmd，先 cd 到工作区
#   ./exec.sh --ps "Get-ChildItem | Measure-Object"   # 经 PowerShell（推荐：中文不乱码）
#
# 注意：--ps 模式把参数拼进 powershell -Command 的双引号里，命令里再出现双引号会破——
#       含引号的命令改用单引号或写成 .ps1 文件推过去执行。
set -uo pipefail

HOST="${WIN11_HOST:-win11}"
DEST="${WIN11_DEST:-C:\\Users\\admin\\codeall}"

MODE=cmd
if [[ "${1:-}" == "--ps" ]]; then MODE=ps; shift; fi
if [[ $# -lt 1 ]]; then sed -n '2,8p' "$0" | sed -e 's/^#\{1,\} \{0,1\}//'; exit 1; fi

if [[ "$MODE" == ps ]]; then
  exec ssh -o BatchMode=yes "$HOST" \
    "powershell -NoProfile -Command \"Set-Location $DEST; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $*\""
else
  exec ssh -o BatchMode=yes "$HOST" "cd /d $DEST && $*"
fi
