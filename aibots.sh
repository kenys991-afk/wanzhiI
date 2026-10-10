#!/usr/bin/env bash
# AI 玩家啟停：./aibots.sh start|stop|status|restart   （環境變數 WZW_URL 可改連線目標，預設 http://127.0.0.1:8770）
cd "$(dirname "$0")"
PIDF=aibots/aibots.pid; LOGF=aibots/aibots.log
running(){ [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }
case "$1" in
  start) if running; then echo "AI 玩家已在執行（pid $(cat $PIDF)）"; exit 0; fi
         setsid nohup node aibots/aibots.js >> "$LOGF" 2>&1 < /dev/null & echo $! > "$PIDF"; sleep 1
         if running; then echo "AI 玩家已啟動（pid $(cat $PIDF)），紀錄：server/$LOGF"; else echo "啟動失敗，請看 $LOGF"; exit 1; fi ;;
  stop)  if running; then kill "$(cat $PIDF)"; for i in $(seq 1 20); do running || break; sleep 0.5; done; running && kill -9 "$(cat $PIDF)"; echo "AI 玩家已暫停（角色進度已存在伺服器）"; else echo "AI 玩家沒有在執行"; fi; rm -f "$PIDF" ;;
  status) if running; then echo "執行中（pid $(cat $PIDF)）"; else echo "未執行"; fi; [ -f "$LOGF" ] && tail -n 15 "$LOGF" ;;
  restart) "$0" stop; "$0" start ;;
  *) echo "用法：$0 start|stop|status|restart"; exit 1 ;;
esac
