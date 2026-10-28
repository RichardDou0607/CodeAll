#!/usr/bin/env bash
# scripts/linux-sandbox/sync.sh — 把本仓库源码同步到 Linux 验证机工作区
#
#   ./sync.sh                       # 同步到 ubuntu:~/codeall
#   LINUX_DEST='~/codeall-arm' ./sync.sh
#
# 方式：tar over ssh（同 win11 母版，无需 rsync）。
# 口径：覆盖式同步——本地有啥推啥，不删除对端已不存在于本地的文件（残留靠
#       重删工作区解决：ssh ubuntu "rm -rf ~/codeall && mkdir -p ~/codeall"）。
# 排除：与 win11 版一致。COPYFILE_DISABLE=1 防 Mac bsdtar 塞 ._* AppleDouble 元数据。
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SELF_DIR/common.sh"

HOST="${LINUX_HOST:-$LINUX_HOST_DEFAULT}"
DEST="${LINUX_DEST:-$LINUX_DEST_DEFAULT}"
ROOT="$(cd "$SELF_DIR/../.." && pwd)"

say() { printf '\033[36m[linux-sync]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[linux-sync]\033[0m %s\n' "$*" >&2; exit 1; }

ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" "mkdir -p $DEST" \
  || die "验证机不可达或建目录失败（先跑 node scripts/linux-sandbox/check.mjs）"

say "同步 $ROOT → $HOST:$DEST"

COPYFILE_DISABLE=1 tar -czf - -C "$ROOT" \
  --exclude .git \
  --exclude promo \
  --exclude downloads \
  --exclude node_modules \
  --exclude apps/shell/src-tauri/target \
  --exclude apps/shell/src-tauri/resources \
  --exclude apps/shell/artifacts \
  --exclude '*.app' \
  --exclude '*.log' \
  --exclude .DS_Store \
  --exclude .agent-pet \
  --exclude .mimosa \
  --exclude .video_agent \
  --exclude .zcode \
  --exclude .agents \
  . \
  | ssh "$HOST" "tar -xzf - -C $DEST" \
  || die "同步失败（tar 管道中断）"

say "完成。对端清单（前 12 项）："
ssh -o BatchMode=yes "$HOST" "ls $DEST" | head -12
