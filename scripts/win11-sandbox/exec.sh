#!/usr/bin/env bash
# scripts/win11-sandbox/exec.sh — 在 Win11 沙箱工作区里执行一条命令
#   ./exec.sh "node --version"
#   ./exec.sh --ps "Get-ChildItem | Measure-Object"
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SELF_DIR/common.sh"

HOST="${WIN11_HOST:-win11}"
DEST="${WIN11_DEST:-C:\\Users\\admin\\codeall}"
MODE=cmd
if [[ "${1:-}" == "--ps" ]]; then MODE=ps; shift; fi
if [[ $# -lt 1 ]]; then sed -n '2,5p' "$0"; exit 1; fi

DEST_B64="$(win11_text_b64 "$DEST")"
COMMAND_B64="$(win11_text_b64 "$*")"
if [[ "$MODE" == ps ]]; then
  win11_ps "$HOST" "Set-Location -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$DEST_B64'))); [Console]::OutputEncoding=[Text.Encoding]::UTF8; & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$COMMAND_B64')))); if (\$null -ne \$LASTEXITCODE) { exit \$LASTEXITCODE }"
else
  win11_ps "$HOST" "Set-Location -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$DEST_B64'))); \$cmd=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$COMMAND_B64')); & cmd.exe /c \$cmd; exit \$LASTEXITCODE"
fi
