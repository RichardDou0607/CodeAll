#!/usr/bin/env bash
# scripts/linux-sandbox/common.sh — linux-sandbox 脚本公共约定
#
# 与 scripts/win11-sandbox 同一套方法论的环境变量（Linux 版）：
#   LINUX_HOST  ssh Host 别名           （默认 ubuntu；~/.ssh/config 免密）
#   LINUX_DEST  远端工作区绝对路径       （默认 ~/codeall；允许 ~ 前缀，远端 shell 展开）
#   LINUX_PORT  服务端口                （默认 7799）
# 无 Windows GBK/编码坑：全部明文 bash，不需要 EncodedCommand。需要登录态 PATH
#（~/.local/bin 下的 node 等）的地方统一走 `bash -l`。

LINUX_HOST_DEFAULT=ubuntu
LINUX_DEST_DEFAULT='~/codeall'
LINUX_PORT_DEFAULT=7799

say() { printf '\033[36m[linux-sandbox]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[linux-sandbox]\033[0m %s\n' "$*" >&2; exit 1; }

# 远端登录 shell 跑一段 bash（stdin 传入，保 .profile 的 PATH）
linux_run() { # linux_run <host> <dest> <command>
  local B64
  B64="$(printf '%s' "$3" | base64)"
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$1" "cd $2 && printf %s $B64 | base64 -d | bash -l"
}
