#!/usr/bin/env bash
# scripts/linux-sandbox/exec.sh — 在 Linux 验证机工作区里执行一条命令
#   ./exec.sh "node --version"
#   ./exec.sh "systemctl --user status xdg-desktop-portal"
# 命令经 bash -l 执行（登录态 PATH，~/.local/bin 可见）。
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SELF_DIR/common.sh"

HOST="${LINUX_HOST:-$LINUX_HOST_DEFAULT}"
DEST="${LINUX_DEST:-$LINUX_DEST_DEFAULT}"

if [[ $# -lt 1 ]]; then sed -n '2,5p' "$0"; exit 1; fi

linux_run "$HOST" "$DEST" "$*"
