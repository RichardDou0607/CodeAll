#!/usr/bin/env bash
# 汇总若干进程的 phys_footprint（macOS /usr/bin/footprint），单位 MB。
# 用法：./footprint-sum.sh <label> <pid> [pid...]
set -uo pipefail
LABEL="$1"; shift
TOTAL=0
for P in "$@"; do
  OUT=$(footprint -p "$P" 2>/dev/null | grep -E '^[[:space:]]+phys_footprint:' | tail -1)
  VAL=$(echo "$OUT" | sed -E 's/.*phys_footprint:[[:space:]]*//')
  NUM=$(echo "$VAL" | awk '{print $1}')
  UNIT=$(echo "$VAL" | awk '{print $2}')
  MB=$(awk -v n="$NUM" -v u="$UNIT" 'BEGIN{ if (u=="KB") printf "%.1f", n/1024; else if (u=="GB") printf "%.0f", n*1024; else printf "%.1f", n }')
  COMM=$(ps -o comm= -p "$P" 2>/dev/null | sed 's|.*/||')
  echo "  pid=$P footprint=$MB MB proc=$COMM"
  TOTAL=$(awk -v a="$TOTAL" -v b="$MB" 'BEGIN{printf "%.1f", a+b}')
done
printf '%s_FOOTPRINT_TOTAL=%sMB\n' "$LABEL" "$TOTAL"
