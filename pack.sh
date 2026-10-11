#!/usr/bin/env bash
# 在「目前這台機器（box）」執行：把遊戲＋伺服器＋資料打包成 dist/wzw-YYYYmmdd-HHMMSS.tgz
# 用法：./pack.sh            （含 data/db.json 與 AI 帳密 accounts.json）
#       NO_DATA=1 ./pack.sh  （只更新程式，不含資料；用於之後的 update）
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; GAME="$(cd "$HERE/../.." && pwd)"; OUT="$HERE/dist"; TS=$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"; chmod 700 "$OUT"; STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
D="$STAGE/wzw"; mkdir -p "$D/server/aibots" "$D/server/data"
cd "$GAME"
cp index.html manifest.webmanifest icon-*.png "$D/"
for f in bot_account.txt make_bot_account.html make_kok.html export_saves.html; do [ -f "$f" ] && cp "$f" "$D/"; done
cp server/server.js server/world.js server/gamelogic.js server/package.json server/package-lock.json server/start.sh server/stop.sh server/aibots.sh "$D/server/"
cp server/aibots/aibots.js server/aibots/package.json "$D/server/aibots/"; [ -f server/aibots/package-lock.json ] && cp server/aibots/package-lock.json "$D/server/aibots/"
if [ "${NO_DATA:-0}" != 1 ]; then
  # 一致的資料快照：先複製到暫存再驗證是合法 JSON
  cp server/data/db.json "$D/server/data/db.json"
  node -e "JSON.parse(require('fs').readFileSync('$D/server/data/db.json','utf8'))" || { echo "db.json 快照不是合法 JSON，請重試"; exit 1; }
  [ -f server/aibots/accounts.json ] && { cp server/aibots/accounts.json "$D/server/aibots/"; chmod 600 "$D/server/aibots/accounts.json"; }
else rmdir "$D/server/data"; fi
cp "$HERE/install.sh" "$D/"
tar -C "$STAGE" -czf "$OUT/wzw-$TS.tgz" wzw
ln -sf "wzw-$TS.tgz" "$OUT/latest.tgz"
echo "打包完成：$OUT/wzw-$TS.tgz（$(du -h "$OUT/wzw-$TS.tgz" | cut -f1)）"
