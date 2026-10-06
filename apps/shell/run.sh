#!/usr/bin/env bash
# apps/shell/run.sh — Agent 悬浮窗桌面外壳（Tauri v2）一键运行
#
#   ./run.sh                  # 需要时自动构建，然后以 7799 端口启动外壳
#   ./run.sh --port 7801      # 换端口；本地服务未监听时由外壳自动拉起 demo/framed.mjs
#   ./run.sh --build          # 强制重新构建 .app
#   ./run.sh --no-build       # 直接用已有产物（不存在则报错退出）
#   ./run.sh --dev            # tauri dev 模式（不打包 .app）
#   ./run.sh -- --port 7801   # -- 之后的参数原样传给外壳二进制
#
# 环境变量
#   AGENT_PET_ROOT  仓库根目录（默认自动推断为 apps/shell/../..）
#   AGENT_PET_PORT  本地服务端口（默认 7799，与 demo/framed.mjs 一致）
#   AGENT_PET_NODE  node 可执行文件路径（默认自动探测）
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SELF_DIR/../.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"
export AGENT_PET_ROOT="${AGENT_PET_ROOT:-$ROOT}"

MODE=auto
PORT=""
RESTART_SERVER=0
PASSTHRU=()

usage() { sed -n '2,16p' "$0" | sed -e 's/^#\{1,\} \{0,1\}//'; }
say() { printf '\033[36m[run.sh]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[run.sh]\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      PORT="${2:-}"
      [ -n "$PORT" ] || die "--port 需要一个端口号"
      shift 2 ;;
    --build)    MODE=build;   shift ;;
    --no-build) MODE=nobuild; shift ;;
    --dev)      MODE=dev;     shift ;;
    --install)  MODE=install; shift ;;   # 构建并安装到 /Applications，之后从启动台/Spotlight 一键打开
    --restart-server) RESTART_SERVER=1; shift ;;   # 先停掉端口上的旧 framed.mjs，让外壳用新环境变量重拉
    -h|--help)  usage; exit 0 ;;
    --)         shift; PASSTHRU=("$@"); break ;;
    *)          PASSTHRU+=("$1"); shift ;;
  esac
done

[ -n "$PORT" ] && export AGENT_PET_PORT="$PORT"

# ---- 输入投递通道（B 之后补上的一跳：悬浮窗 → DSH 会话）----------------------
# plugins/dsh-pet 挂载后会在 $TMPDIR/agent-pet/dsh-plugin.sock 上提供 POST /input。
# 这里探测到 socket 就自动把 demo/framed.mjs 的 PET_INPUT_CMD 指到投递脚本，
# 输入状态才会从 queued 变成 delivered。
TMPBASE="${TMPDIR:-/tmp}"; TMPBASE="${TMPBASE%/}"
PLUGIN_SOCK="${PET_DSH_SOCK:-$TMPBASE/agent-pet/dsh-plugin.sock}"
if [ -z "${PET_INPUT_CMD:-}" ] && [ -S "$PLUGIN_SOCK" ]; then
  export PET_INPUT_CMD="node $SELF_DIR/tools/pet-input-send.mjs"
  say "检测到 DSH 插件 socket → 已启用自动投递：PET_INPUT_CMD=$PET_INPUT_CMD"
elif [ -z "${PET_INPUT_CMD:-}" ]; then
  say "未检测到 DSH 插件 socket（$PLUGIN_SOCK）→ 输入仍只进本地队列；挂载见 apps/shell/tools/mount-dsh-plugin.sh"
fi

if [ "$RESTART_SERVER" = 1 ]; then
  if pkill -f "demo/framed.mjs --port ${AGENT_PET_PORT:-7799}" 2>/dev/null; then
    say "已停掉端口 ${AGENT_PET_PORT:-7799} 上的旧本地服务，将由外壳按新环境变量重新拉起"
    sleep 0.8
  else
    say "端口 ${AGENT_PET_PORT:-7799} 上没有旧服务，无需重启"
  fi
fi

command -v node >/dev/null 2>&1 || die "未找到 node —— 本地服务 demo/framed.mjs 需要 Node.js"
command -v pnpm >/dev/null 2>&1 || die "未找到 pnpm"
command -v cargo >/dev/null 2>&1 || die "未找到 cargo（已把 ~/.cargo/bin 加进 PATH；请先装 Rust 工具链）"

APP="$SELF_DIR/src-tauri/target/release/bundle/macos/AgentPet.app"
BIN="$(ls "$APP/Contents/MacOS/"* 2>/dev/null | head -1)"   # 可执行文件名 = cargo bin 名

if [ "$MODE" = dev ]; then
  say "tauri dev 模式 · 端口 ${AGENT_PET_PORT:-7799}"
  cd "$SELF_DIR" && exec pnpm tauri dev
fi

if [ ! -d "$SELF_DIR/node_modules" ]; then
  say "安装外壳依赖（pnpm install）"
  (cd "$SELF_DIR" && pnpm install) || die "pnpm install 失败"
fi

NEED_BUILD=0
if [ "$MODE" = build ] || [ "$MODE" = install ]; then NEED_BUILD=1; fi
[ -x "$BIN" ] || NEED_BUILD=1

if [ "$MODE" = nobuild ] && [ "$NEED_BUILD" = 1 ]; then
  die "--no-build 但找不到产物：$BIN"
fi

if [ "$NEED_BUILD" = 1 ]; then
  say "构建 .app（首次编译依赖约 1-5 分钟）…"
  (cd "$SELF_DIR" && pnpm tauri build) || die "pnpm tauri build 失败（详见上方输出）"
fi

[ -x "$BIN" ] || die "构建结束但产物不存在：$BIN"

if [ "$MODE" = install ]; then
  DEST_DIR="/Applications"
  say "安装到 $DEST_DIR/AgentPet.app"
  rm -rf "$DEST_DIR/AgentPet.app"
  cp -R "$APP" "$DEST_DIR/AgentPet.app" || die "复制 .app 失败"
  say "完成 —— 以后从 启动台 / Spotlight 打开「AgentPet」即可，外壳会自动拉起本地服务"
  say "注意：仓库移动或重命名后需重新运行 apps/shell/run.sh --install（外壳按编译时路径定位仓库）"
  say "现在就启动：open -a AgentPet"
  open -a AgentPet
  exit 0
fi

say "产物   $APP"
say "端口   ${AGENT_PET_PORT:-7799}（未监听时由外壳拉起 demo/framed.mjs）"
say "仓库根 $AGENT_PET_ROOT"
say "启动   $BIN"

exec "$BIN" ${PASSTHRU[@]+"${PASSTHRU[@]}"}
