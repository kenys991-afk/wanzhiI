#!/usr/bin/env bash
# 啟動 萬王之王 Online 伺服器（背景執行，log 寫到 server/server.log）
# 自我修復：node_modules 不見（例如機器重置）時自動 npm install
cd "$(dirname "$0")"
if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then echo "已在執行中 (pid $(cat server.pid))：http://127.0.0.1:${PORT:-8770}/"; exit 0; fi
# 已有別的 server.js 在聽同一個埠（pid 檔遺失）→ 認領它，不重複啟動
PID_ON_PORT=$(ss -ltnp 2>/dev/null | grep ":${PORT:-8770} " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
if [ -n "$PID_ON_PORT" ]; then echo "$PID_ON_PORT" > server.pid; echo "已在執行中 (pid $PID_ON_PORT)：http://127.0.0.1:${PORT:-8770}/"; exit 0; fi
if [ ! -d node_modules/ws ] || [ ! -d node_modules/acorn ]; then echo "node_modules 缺少，執行 npm install…"; npm install --no-audit --no-fund >> server.log 2>&1 || { echo "npm install 失敗，請看 server.log"; exit 1; }; fi
nohup node server.js >> server.log 2>&1 &
echo $! > server.pid
sleep 0.8
if kill -0 "$(cat server.pid)" 2>/dev/null; then echo "已啟動 (pid $(cat server.pid))：http://127.0.0.1:${PORT:-8770}/"; else echo "啟動失敗，請看 server.log"; tail -20 server.log; exit 1; fi
