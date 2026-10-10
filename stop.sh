#!/usr/bin/env bash
# 停止伺服器（SIGTERM：會先把資料寫入 data/db.json）
cd "$(dirname "$0")"
if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then kill "$(cat server.pid)"; for i in $(seq 1 20); do kill -0 "$(cat server.pid)" 2>/dev/null || break; sleep 0.2; done; echo "已停止"; rm -f server.pid; else echo "沒有在執行"; rm -f server.pid; fi
