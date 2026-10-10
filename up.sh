#!/usr/bin/env bash
# 一鍵啟動（可重複執行，已在跑的不會重開）：遊戲伺服器 → AI 玩家 → 公開通道（keepalive）
# 用法：./up.sh            （環境變數 NO_BOTS=1 不啟動 AI 玩家；NO_TUNNEL=1 不開公開通道）
cd "$(dirname "$0")"
set -u
echo "== 遊戲伺服器 =="; ./start.sh || exit 1
for i in $(seq 1 20); do curl -s -m2 -o /dev/null "http://127.0.0.1:${PORT:-8770}/" && break; sleep 0.5; done
if [ "${NO_BOTS:-0}" != 1 ]; then
  echo "== AI 玩家 =="
  if [ ! -d aibots/node_modules/playwright-core ]; then echo "安裝 playwright-core（aibots/node_modules）…"; (cd aibots && npm install --no-audit --no-fund >/dev/null 2>&1) || echo "⚠ playwright-core 安裝失敗"; fi
  if [ -x "${CHROME:-/usr/bin/google-chrome}" ]; then ./aibots.sh start; else echo "⚠ 找不到 Chrome（${CHROME:-/usr/bin/google-chrome}），略過 AI 玩家"; fi
fi
if [ "${NO_TUNNEL:-0}" != 1 ]; then
  echo "== 公開通道 =="
  command -v ssh >/dev/null || command -v cloudflared >/dev/null || [ -x "$HOME/bin/cloudflared" ] || echo "⚠ 沒有 ssh 也沒有 cloudflared：sudo apt-get update && sudo apt-get install -y openssh-client"
  ./tunnel.sh start
fi
echo "== 狀態 =="; ./aibots.sh status 2>/dev/null | head -1; ./tunnel.sh status
