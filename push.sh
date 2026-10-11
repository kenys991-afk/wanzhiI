#!/usr/bin/env bash
# 在 box 執行：打包並上傳到 Oracle VM，然後遠端執行 install.sh
# 用法：./push.sh ubuntu@<公用IP> [ssh 私鑰路徑]
#   第一次部署（含資料）：./push.sh ubuntu@1.2.3.4 ~/.ssh/oci.key
#   之後只更新程式（保留 VM 上的資料）：NO_DATA=1 ./push.sh ubuntu@1.2.3.4 ~/.ssh/oci.key
#   自訂網域（DNS 已指向 VM）：DOMAIN=game.example.com ./push.sh ...
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; HOST="${1:?用法：./push.sh ubuntu@IP [key]}"; KEY="${2:-}"
SSHO=(-o StrictHostKeyChecking=accept-new); [ -n "$KEY" ] && SSHO+=(-i "$KEY")
"$HERE/pack.sh"
scp "${SSHO[@]}" "$HERE/dist/latest.tgz" "$HOST:/tmp/wzw.tgz"
ssh "${SSHO[@]}" "$HOST" "rm -rf /tmp/wzw && tar -C /tmp -xzf /tmp/wzw.tgz && sudo DOMAIN='${DOMAIN:-}' NO_BOTS='${NO_BOTS:-0}' bash /tmp/wzw/install.sh /tmp/wzw"
