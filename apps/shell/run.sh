#!/usr/bin/env bash
# apps/shell/run.sh — CodeAll 桌面外壳（Tauri v2）一键运行
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
    --install)  MODE=install; shift ;;   # 构建并安装（mac：/Applications；Linux：deb 用 apt 装 / AppImage 收进 ~/.local/bin，并配 .desktop 自启）
    --restart-server) RESTART_SERVER=1; shift ;;   # 先停掉端口上的旧 framed.mjs，让外壳用新环境变量重拉
    -h|--help)  usage; exit 0 ;;
    --)         shift; PASSTHRU=("$@"); break ;;
    *)          PASSTHRU+=("$1"); shift ;;
  esac
done

[ -n "$PORT" ] && export AGENT_PET_PORT="$PORT"

# 服务自行探测 DSH 插件并向指定会话投递；插件离线时只入队。
# 不再注入 PET_INPUT_CMD：它无法携带目标 session ID。

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

OS="$(uname -s)"
if [ "$OS" = "Linux" ]; then
  # Linux 产物：deb（apt 安装）+ AppImage（免装直跑）；日常 run 走未打包的 release 二进制
  DEB="$(ls "$SELF_DIR"/src-tauri/target/release/bundle/deb/*_arm64.deb 2>/dev/null | head -1)"
  APPIMAGE="$(ls "$SELF_DIR"/src-tauri/target/release/bundle/appimage/*.AppImage 2>/dev/null | head -1)"
  BIN="$SELF_DIR/src-tauri/target/release/agent-pet-shell"   # 可执行文件名 = cargo bin 名
else
  APP="$SELF_DIR/src-tauri/target/release/bundle/macos/CodeAll.app"
  BIN="$(ls "$APP/Contents/MacOS/"* 2>/dev/null | head -1)"   # 可执行文件名 = cargo bin 名
fi

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
  if [ "$OS" = "Linux" ]; then
    say "构建 deb + AppImage（首次编译依赖约 1-5 分钟）…"
    # Linux 出包由 CLI --bundles 传参（tauri.conf.json 的 targets 保持 mac 口径不动）
    (cd "$SELF_DIR" && pnpm tauri build --bundles deb appimage) || die "pnpm tauri build 失败（详见上方输出）"
  else
    say "构建 .app（首次编译依赖约 1-5 分钟）…"
    (cd "$SELF_DIR" && pnpm tauri build) || die "pnpm tauri build 失败（详见上方输出）"
  fi
fi

[ -x "$BIN" ] || die "构建结束但产物不存在：$BIN"

if [ "$MODE" = install ]; then
  if [ "$OS" = "Linux" ]; then
    AUTOSTART_DIR="$HOME/.config/autostart"; mkdir -p "$AUTOSTART_DIR"
    if [ -n "$DEB" ]; then
      say "安装 deb 包：$DEB"
      sudo apt install -y "$DEB" || die "apt install 失败"
      # deb 布局：.desktop 由包落在 /usr/share/applications/，复制一份进自启目录
      SRC_DESKTOP=""
      for f in /usr/share/applications/CodeAll.desktop /usr/share/applications/code-all.desktop; do
        [ -f "$f" ] && SRC_DESKTOP="$f" && break
      done
      if [ -n "$SRC_DESKTOP" ]; then
        cp "$SRC_DESKTOP" "$AUTOSTART_DIR/"
        say "自启已配置：$AUTOSTART_DIR/$(basename "$SRC_DESKTOP")"
      else
        say "警告：未找到包内 .desktop（/usr/share/applications/），自启未配置"
      fi
    elif [ -n "$APPIMAGE" ]; then
      say "AppImage 收进 ~/.local/bin（免安装直跑）"
      mkdir -p "$HOME/.local/bin"
      cp "$APPIMAGE" "$HOME/.local/bin/" || die "复制 AppImage 失败"
      chmod +x "$HOME/.local/bin/$(basename "$APPIMAGE")"
      # AppImage 没有系统 .desktop，自启文件就地生成，Exec 必须写绝对路径
      cat > "$AUTOSTART_DIR/codeall.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=CodeAll
Exec=$HOME/.local/bin/$(basename "$APPIMAGE")
Terminal=false
DESKTOP
      say "自启已配置：$AUTOSTART_DIR/codeall.desktop（Exec=绝对路径）"
    else
      die "找不到 Linux 产物（先运行 $0 --build 或 --install 构建）"
    fi
    say "完成 —— 注销重登后应自动启动；也可从应用菜单 / ~/.local/bin 打开「CodeAll」"
    exit 0
  fi
  DEST_DIR="/Applications"
  say "安装到 $DEST_DIR/CodeAll.app"
  rm -rf "$DEST_DIR/CodeAll.app"
  cp -R "$APP" "$DEST_DIR/CodeAll.app" || die "复制 .app 失败"
  say "完成 —— 以后从 启动台 / Spotlight 打开「CodeAll」即可，外壳会自动拉起本地服务"
  say "注意：仓库移动或重命名后需重新运行 apps/shell/run.sh --install（外壳按编译时路径定位仓库）"
  say "现在就启动：open -a CodeAll"
  open -a CodeAll
  exit 0
fi

if [ "$OS" = "Linux" ]; then
  say "产物   deb=${DEB:-未构建} appimage=${APPIMAGE:-未构建}"
else
  say "产物   $APP"
fi
say "端口   ${AGENT_PET_PORT:-7799}（未监听时由外壳拉起 demo/framed.mjs）"
say "仓库根 $AGENT_PET_ROOT"
say "启动   $BIN"

exec "$BIN" ${PASSTHRU[@]+"${PASSTHRU[@]}"}
