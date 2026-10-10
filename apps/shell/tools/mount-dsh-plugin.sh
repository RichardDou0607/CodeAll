#!/usr/bin/env bash
# apps/shell/tools/mount-dsh-plugin.sh — 把 plugins/dsh-pet 挂到用户的 desktop profile
#
#   mount-dsh-plugin.sh --dry-run   只打印将要追加的内容，不写任何文件
#   mount-dsh-plugin.sh --status    看当前是否已挂载 + /health 自检
#   mount-dsh-plugin.sh             备份 → 追加 3 行 → 等 HMR 生效 → /health 自检（失败自动回滚）
#   mount-dsh-plugin.sh --rollback  精确删除本脚本追加的整块
#
# 原则：只追加、不改任何现有行；追加内容带 BEGIN/END 标记，回滚按整块精确删除。
# 背景与协议见 docs/54-dsh-plugin.md；插件本体在 plugins/dsh-pet/。
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SELF_DIR/../../.." && pwd)"   # tools -> shell -> apps -> 仓库根
PATCH="${HOME}/.dsh/profiles/desktop/cordis.patch.yml"
PLUGIN="${ROOT}/plugins/dsh-pet/index.js"
TMPBASE="${TMPDIR:-/tmp}"; TMPBASE="${TMPBASE%/}"          # TMPDIR 末尾自带 /，去掉避免双斜杠
SOCK="${TMPBASE}/agent-pet/dsh-plugin.sock"
BEGIN="# >>> agent-pet dsh-pet plugin (mount-dsh-plugin.sh) >>>"
END="# <<< agent-pet dsh-pet plugin <<<"

hr() { printf '\n\033[36m== %s ==\033[0m\n' "${*}"; }
say() { printf '  %s\n' "${*}"; }
die() { printf '\033[31m错误：%s\033[0m\n' "${*}" >&2; exit 1; }

health() { curl -s --unix-socket "${SOCK}" --max-time 2 http://localhost/health 2>/dev/null; }
is_mounted() { [ -f "${PATCH}" ] && grep -qF "${BEGIN}" "${PATCH}"; }

do_status() {
  hr "profile"
  say "patch 文件：${PATCH}"
  [ -f "${PATCH}" ] && say "存在，共 $(wc -l < "${PATCH}" | tr -d ' ') 行" || say "不存在"
  hr "是否已挂载"
  if is_mounted; then say "已挂载（发现 BEGIN 标记）"; else say "未挂载"; fi
  hr "插件 socket /health"
  say "socket：${SOCK}"
  local h; h="$(health)"
  if [ -n "${h}" ]; then say "${h}"; else say "无响应（插件没在跑，或还没挂载）"; fi
}

do_dry_run() {
  hr "将要追加到 ${PATCH} 末尾的内容（其余一行不动）"
  printf '\n%s\n' "${BEGIN}"
  printf -- '- insert:\n'
  printf '    - id: dsh-pet\n'
  printf "      name: '%s'\n" "${PLUGIN}"
  printf '%s\n' "${END}"
  hr "挂载后如何生效"
  say "HMR 会热加载（docs/35 §4.3 实测 ~1s），无需重启 DSH"
  say "自检：curl -s --unix-socket '${SOCK}' http://localhost/health"
}

do_rollback() {
  hr "回滚：删除 BEGIN..END 整块"
  if ! is_mounted; then say "没找到 BEGIN 标记，无需回滚"; return 0; fi
  local tmp; tmp="$(mktemp)"
  awk -v b="${BEGIN}" -v e="${END}" '{ if ($0==b) skip=1; if (!skip) print; if ($0==e) skip=0 }' "${PATCH}" > "${tmp}"
  cp -p "${PATCH}" "${PATCH}.rollback-bak"
  mv "${tmp}" "${PATCH}"
  say "已删除整块（原文件备份在 ${PATCH}.rollback-bak）"
  say "剩下的行数：$(wc -l < "${PATCH}" | tr -d ' ')"
  rm -f "${SOCK}" "${TMPDIR:-/tmp}/agent-pet/dsh-plugin.lock" 2>/dev/null
  say "socket / 锁文件已清（若有）"
}

do_mount() {
  [ -f "${PATCH}" ] || die "找不到 ${PATCH}"
  [ -f "${PLUGIN}" ] || die "找不到插件 ${PLUGIN}"

  if is_mounted; then
    hr "已经挂载过了，跳过写入"
  else
    local bak="${PATCH}.bak-agentpet-$(date +%Y%m%d-%H%M%S)"
    cp -p "${PATCH}" "${bak}"
    hr "已备份"
    say "${bak}"
    {
      printf '\n%s\n' "${BEGIN}"
      printf -- '- insert:\n'
      printf '    - id: dsh-pet\n'
      printf "      name: '%s'\n" "${PLUGIN}"
      printf '%s\n' "${END}"
    } >> "${PATCH}"
    hr "已追加（文件末尾）"
    tail -6 "${PATCH}" | sed 's/^/    /'
  fi

  hr "等 HMR 热加载（最多 20s）"
  local i h=""
  for i in $(seq 1 40); do
    h="$(health)"
    [ -n "${h}" ] && break
    sleep 0.5
  done
  if [ -n "${h}" ]; then
    say "插件已上线："
    say "${h}"
    hr "下一步（让悬浮窗输入真的能送达）"
    say "1) 让 CodeAll 服务重新探测插件（已运行的服务 30s 内自动检测）；代码更新后需重启服务。"
    say "2) 在 CodeAll 中明确选择一个 DSH 主会话后发送；无需 PET_INPUT_CMD。"
    return 0
  fi

  hr "自检失败，自动回滚"
  local tmp; tmp="$(mktemp)"
  awk -v b="${BEGIN}" -v e="${END}" '{ if ($0==b) skip=1; if (!skip) print; if ($0==e) skip=0 }' "${PATCH}" > "${tmp}"
  mv "${tmp}" "${PATCH}"
  say "已回滚。若 DSH 侧有异常，重启一次 DSH 即可恢复。"
  say "排错：检查插件能否单独加载 —— node -e \"import('${PLUGIN}')\""
  die "HMR 后 20s 内 /health 无响应"
}

case "${1:-}" in
  --dry-run) do_dry_run ;;
  --status)  do_status ;;
  --rollback) do_rollback ;;
  ""|--mount) do_mount ;;
  *) die "未知参数 ${1}（可用：--dry-run / --status / --rollback）" ;;
esac
