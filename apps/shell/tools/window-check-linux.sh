#!/usr/bin/env bash
# apps/shell/tools/window-check-linux.sh — X11 窗口行为取证（Linux 侧，对应 mac window-memory.sh 一族）
#
#   apps/shell/tools/window-check-linux.sh <窗口标题关键字>
#
# 事实来源：xprop（_NET_WM_STATE / _NET_WM_WINDOW_TYPE）、xwininfo（geometry）、
# xdotool（可选：search 定位 + 几何复核）。每项输出一行判定，供 L7 断言直接 grep：
#   OK   <项> 事实键值   取证成功（值本身是事实，present=true/false 都算 OK）
#   NG   <项> 原因       工具在但取证失败 / 窗口未找到（断言应失败）
#   SKIP <项> 原因       工具缺失，该项降级放弃（不影响退出码）
# 退出码：0 = 无 NG；1 = 存在 NG。
set -uo pipefail

TITLE="${1:-}"
[ -n "$TITLE" ] || { echo "用法: $0 <窗口标题关键字>" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }
NG_COUNT=0
ok()   { printf 'OK   %s %s\n' "$1" "$2"; }
ng()   { printf 'NG   %s %s\n' "$1" "$2"; NG_COUNT=$((NG_COUNT + 1)); }
skip() { printf 'SKIP %s %s\n' "$1" "$2"; }

# ---- 0) 定位窗口：xdotool 优先；缺了用 xprop 遍历 _NET_CLIENT_LIST 兜底
WID=""
if have xdotool; then
  WID="$(xdotool search --name "$TITLE" 2>/dev/null | head -1)"
  if [ -n "$WID" ]; then
    ok WINDOW_FOUND "source=xdotool id=$WID"
  else
    ng WINDOW_FOUND "xdotool 未找到标题含「$TITLE」的窗口"
  fi
elif have xprop; then
  for id in $(xprop -root _NET_CLIENT_LIST 2>/dev/null | grep -oE '0x[0-9a-fA-F]+'); do
    if xprop -id "$id" -notype _NET_WM_NAME WM_NAME 2>/dev/null | grep -Fq -- "$TITLE"; then
      WID="$id"
      break
    fi
  done
  if [ -n "$WID" ]; then
    ok WINDOW_FOUND "source=xprop id=$WID"
  else
    ng WINDOW_FOUND "_NET_CLIENT_LIST 中无标题含「$TITLE」的窗口"
  fi
else
  skip WINDOW_FOUND "xprop/xdotool 均不可用（装 x11-utils：sudo apt install x11-utils）"
fi

if [ -z "$WID" ]; then
  # 窗口都没找到，其余各项无从谈起，逐项 SKIP 说明后收尾
  skip NET_WM_STATE_ABOVE "未定位到窗口"
  skip NET_WM_STATE_STICKY "未定位到窗口"
  skip NET_WM_WINDOW_TYPE "未定位到窗口"
  skip GEOMETRY "未定位到窗口"
  skip XDOTOOL_GEOMETRY "未定位到窗口"
  echo "RESULT ng=$NG_COUNT（未定位到窗口）"
  exit 1
fi

# ---- 1) _NET_WM_STATE：置顶 _ABOVE / 常驻所有工作区 _STICKY
if have xprop; then
  STATE="$(xprop -id "$WID" -notype _NET_WM_STATE 2>/dev/null || true)"
  if [ -n "$STATE" ] && ! printf '%s\n' "$STATE" | grep -q 'not found'; then
    echo "  raw: $STATE"   # 原始证据行（非判定行），人读用
    if printf '%s\n' "$STATE" | grep -q '_NET_WM_STATE_ABOVE'; then
      ok NET_WM_STATE_ABOVE 'present=true'
    else
      ok NET_WM_STATE_ABOVE 'present=false'
    fi
    if printf '%s\n' "$STATE" | grep -q '_NET_WM_STATE_STICKY'; then
      ok NET_WM_STATE_STICKY 'present=true'
    else
      ok NET_WM_STATE_STICKY 'present=false'
    fi
  else
    ng NET_WM_STATE_ABOVE 'xprop 未返回 _NET_WM_STATE（WM 可能不兼容 EWMH）'
    ng NET_WM_STATE_STICKY 'xprop 未返回 _NET_WM_STATE（WM 可能不兼容 EWMH）'
  fi
else
  skip NET_WM_STATE_ABOVE 'xprop 不可用'
  skip NET_WM_STATE_STICKY 'xprop 不可用'
fi

# ---- 2) _NET_WM_WINDOW_TYPE（悬浮窗通常是 NORMAL；DOCK/UTILITY 等另计）
if have xprop; then
  TYPE="$(xprop -id "$WID" -notype _NET_WM_WINDOW_TYPE 2>/dev/null || true)"
  TYPE_VAL="$(printf '%s\n' "$TYPE" | sed -n 's/^_NET_WM_WINDOW_TYPE = *"\(.*\)"/\1/p')"
  if [ -n "$TYPE_VAL" ]; then
    ok NET_WM_WINDOW_TYPE "value=$TYPE_VAL"
  else
    ng NET_WM_WINDOW_TYPE "xprop 未返回 _NET_WM_WINDOW_TYPE（raw: ${TYPE:-空}）"
  fi
else
  skip NET_WM_WINDOW_TYPE 'xprop 不可用'
fi

# ---- 3) geometry（xwininfo；map=IsViewable 顺带证明窗口真被映射了）
if have xwininfo; then
  WI="$(xwininfo -id "$WID" 2>/dev/null || true)"
  GX="$(printf '%s\n' "$WI" | awk '/Absolute upper-left X:/{print $NF}')"
  GY="$(printf '%s\n' "$WI" | awk '/Absolute upper-left Y:/{print $NF}')"
  GW="$(printf '%s\n' "$WI" | awk '/^  Width:/{print $NF}')"
  GH="$(printf '%s\n' "$WI" | awk '/^  Height:/{print $NF}')"
  MAP="$(printf '%s\n' "$WI" | awk '/Map State:/{print $NF}')"
  if [ -n "$GX" ] && [ -n "$GY" ] && [ -n "$GW" ] && [ -n "$GH" ]; then
    ok GEOMETRY "abs=+${GX}+${GY} size=${GW}x${GH} map=${MAP:-unknown}"
  else
    ng GEOMETRY "xwininfo 输出解析失败（raw: ${WI:-空}）"
  fi
else
  skip GEOMETRY 'xwininfo 不可用（装 x11-utils：sudo apt install x11-utils）'
fi

# ---- 4) xdotool 几何复核（可选依赖；缺席即 SKIP，不拖累其余判定）
if have xdotool; then
  DG="$(xdotool getwindowgeometry --shell "$WID" 2>/dev/null | awk -F= '/^(X|Y|WIDTH|HEIGHT)=/{printf "%s=%s ", $1, $2}')"
  if [ -n "$DG" ]; then
    ok XDOTOOL_GEOMETRY "$DG"
  else
    ng XDOTOOL_GEOMETRY 'xdotool getwindowgeometry 无输出'
  fi
else
  skip XDOTOOL_GEOMETRY 'xdotool 不可用（可选依赖）'
fi

if [ "$NG_COUNT" -gt 0 ]; then
  echo "RESULT ng=$NG_COUNT（存在 NG）"
  exit 1
fi
echo "RESULT ok（无 NG）"
exit 0
