#!/usr/bin/env bash
# scripts/win11-sandbox/sync.sh — 把本仓库源码同步到 Win11 沙箱工作区
#
#   ./sync.sh                       # 同步到 C:\Users\admin\codeall
#   WIN11_DEST='D:\codeall' ./sync.sh
#
# 方式：tar over ssh（Mac bsdtar → 沙箱 System32\tar.exe，无需在 Windows 装 rsync）。
# 口径：覆盖式同步——本地有啥推啥，不删除对端已不存在于本地的文件（残留靠
#       重删工作区解决：ssh win11 "rmdir /s /q C:\Users\admin\codeall"）。
# 排除：.git / promo / downloads / node_modules / Tauri target·resources·artifacts /
#       *.app / *.log / .DS_Store / .agent-pet·.mimosa·.video_agent·.zcode·.agents（本地运行态）。
#       COPYFILE_DISABLE=1 防止 Mac bsdtar 塞 ._* AppleDouble 元数据（对端是垃圾）。
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SELF_DIR/../.." && pwd)"
HOST="${WIN11_HOST:-win11}"
DEST="${WIN11_DEST:-C:\\Users\\admin\\codeall}"
DEST_FWD='C:/Users/admin/codeall'

say() { printf '\033[36m[win11-sync]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[win11-sync]\033[0m %s\n' "$*" >&2; exit 1; }

ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST" "if not exist \"$DEST\" mkdir \"$DEST\"" \
  || die "沙箱不可达或建目录失败（先跑 node scripts/win11-sandbox/check.mjs）"

say "同步 $ROOT → $HOST:$DEST"

# COPYFILE_DISABLE=1：不让 Mac bsdtar 往包里塞 ._* AppleDouble 元数据条目（对端全是垃圾）
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
  | ssh "$HOST" "tar -xzf - -C $DEST_FWD" \
  || die "同步失败（tar 管道中断）"

say "完成。对端清单（前 12 项）："
ssh -o BatchMode=yes "$HOST" "dir /b \"$DEST\"" | head -12
