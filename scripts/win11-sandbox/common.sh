#!/usr/bin/env bash

win11_text_b64() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

win11_ps_encode() {
  iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n'
}

win11_ps() {
  local host="$1" script="$2" encoded
  encoded="$(printf '%s' "$script" | win11_ps_encode)"
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$host" "powershell -NoProfile -EncodedCommand $encoded"
}
