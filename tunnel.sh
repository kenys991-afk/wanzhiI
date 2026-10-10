#!/usr/bin/env bash
# 萬王之王 Online — public HTTPS tunnel with keepalive
# Usage: ./tunnel.sh start | stop | restart | status | url
# Order: Pinggy over TLS/443 (works here), then cloudflared http2, localhost.run, localtunnel.
# Force one: TUNNEL_PROVIDER=pinggy|cloudflared|lhr|lt ./tunnel.sh start
# The public URL changes when the tunnel restarts. Current URL is tunnel_url.txt.
cd "$(dirname "$0")"
PORT="${PORT:-8770}"
CF="$(command -v cloudflared || echo "$HOME/bin/cloudflared")"
LOG=tunnel.log; URLF=tunnel_url.txt; PIDF=tunnel.pid; KPIDF=tunnel_keepalive.pid
ASK="$(pwd)/.tunnel_askpass.sh"
ts() { date '+%F %T'; }

watch_out() {
  local re=$1 line u prefer
  while IFS= read -r line; do
    printf '%s\n' "$line" | sed 's/\x1b\[[0-9;]*m//g' | grep -v '^\s*$' >> "$LOG"
    prefer=$(printf '%s' "$line" | grep -oE 'https://[A-Za-z0-9.-]+\.free\.pinggy\.net' | head -1)
    u=$prefer
    if [ -z "$u" ]; then u=$(printf '%s' "$line" | grep -oE "$re" | head -1); fi
    if [ -n "$u" ]; then
      cur="$(cat "$URLF" 2>/dev/null || true)"
      # keep the stable pinggy.net host once we have it; don't let the alias overwrite it
      if [ -z "$cur" ] || { [ "$u" != "$cur" ] && printf '%s' "$u" | grep -q 'free\.pinggy\.net'; }; then
        echo "$u" > "$URLF"; echo "$(ts) PUBLIC URL: $u" >> "$LOG"
      fi
    fi
  done
}

run_tunnel() {
  local prov=$1 re
  case "$prov" in
    pinggy)
      re='https://[A-Za-z0-9.-]+\.(free\.pinggy\.net|run\.pinggy-free\.link)'
      printf '%s\n' '#!/bin/sh' 'echo ""' > "$ASK"; chmod 700 "$ASK"
      DISPLAY=1 SSH_ASKPASS="$ASK" SSH_ASKPASS_REQUIRE=force setsid ssh \
        -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 \
        -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
        -o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no \
        -o ProxyCommand="openssl s_client -connect a.pinggy.io:443 -servername a.pinggy.io -quiet 2>/dev/null" \
        -R "0:localhost:$PORT" a.pinggy.io > >(watch_out "$re") 2>&1 < /dev/null &
      ;;
    cloudflared)
      re='https://[a-z0-9-]+\.trycloudflare\.com'
      "$CF" tunnel --url "http://127.0.0.1:$PORT" --protocol http2 --no-autoupdate > >(watch_out "$re") 2>&1 &
      ;;
    lhr)
      re='https://[a-z0-9-]+\.lhr\.life'
      ssh -T -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
        -o ExitOnForwardFailure=yes -p 443 -R "80:localhost:$PORT" nokey@localhost.run > >(watch_out "$re") 2>&1 < /dev/null &
      ;;
    lt)
      re='https://[a-z0-9-]+\.loca\.lt'
      npx --yes localtunnel --port "$PORT" > >(watch_out "$re") 2>&1 &
      ;;
    *) echo "$(ts) unknown provider $prov" >> "$LOG"; return ;;
  esac
  echo $! > "$PIDF"
  echo "$(ts) started $prov (pid $(cat "$PIDF"))" >> "$LOG"
}

# 健康檢查：公開網址回 200（同一輪試兩次，避免偶發抖動）
url_ok() { local u; u="$(cat "$URLF" 2>/dev/null)"; [ -n "$u" ] || return 1
  for t in 1 2; do [ "$(curl -s -o /dev/null -m 12 -w '%{http_code}' "$u/healthz" 2>/dev/null)" = 200 ] && return 0; sleep 4; done; return 1; }
kill_tunnel() { local p; p="$(cat "$PIDF" 2>/dev/null)"; [ -n "$p" ] && { pkill -TERM -s "$p" 2>/dev/null; kill "$p" 2>/dev/null; sleep 1; pkill -KILL -s "$p" 2>/dev/null; kill -9 "$p" 2>/dev/null; }; rm -f "$PIDF"; }

# keepalive：每 ~60 秒檢查；連續 2 次失敗、ssh 結束、或接近 60 分鐘到期 → 重開並等新網址回 200
CHECK_S="${TUNNEL_CHECK_S:-60}"; MAX_AGE_S="${TUNNEL_MAX_AGE_S:-3360}"   # 56 分鐘主動換線（pinggy 免費版 60 分鐘到期）
keepalive() {
  trap 'kill_tunnel; rm -f "$KPIDF"; exit 0' TERM INT
  local i=0 provs=(pinggy) start fails why ok; [ "${TUNNEL_FALLBACK:-0}" = 1 ] && provs=(pinggy cloudflared lhr lt)
  while true; do
    if [ -n "${TUNNEL_PROVIDER:-}" ]; then prov="$TUNNEL_PROVIDER"; else prov="${provs[$((i % ${#provs[@]}))]}"; fi
    rm -f "$URLF"; start=$(date +%s); fails=0; why=""
    run_tunnel "$prov"
    # 等新網址出現並回 200（最多 120 秒）
    ok=0; for k in $(seq 1 60); do sleep 2; kill -0 "$(cat "$PIDF" 2>/dev/null)" 2>/dev/null || break; [ -s "$URLF" ] && url_ok && { ok=1; break; }; done
    if [ "$ok" = 1 ]; then echo "$(ts) HEALTH ok: $(cat "$URLF") returns 200 ($(( $(date +%s)-start ))s after start)" >> "$LOG"; i=0
    else why="new URL never returned 200"; fi
    while [ -z "$why" ]; do
      sleep "$CHECK_S"
      if ! kill -0 "$(cat "$PIDF" 2>/dev/null)" 2>/dev/null; then why="ssh exited"; break; fi
      if [ $(( $(date +%s)-start )) -ge "$MAX_AGE_S" ]; then why="age $(( ($(date +%s)-start)/60 ))min, renewing before 60-min expiry"; break; fi
      if url_ok; then [ "$fails" -gt 0 ] && echo "$(ts) HEALTH recovered: $(cat "$URLF")" >> "$LOG"; fails=0
      else fails=$((fails+1)); echo "$(ts) HEALTH fail $fails/2: $(cat "$URLF" 2>/dev/null) (curl $(curl -s -o /dev/null -m 12 -w '%{http_code}' "$(cat "$URLF" 2>/dev/null)/healthz" 2>/dev/null))" >> "$LOG"
        [ "$fails" -ge 2 ] && why="URL failed 2 checks in a row"; fi
    done
    echo "$(ts) RESTART tunnel: $why (public URL will change)" >> "$LOG"
    kill_tunnel
    [ "$ok" = 1 ] || i=$((i+1))
    sleep 3
  done
}

case "${1:-start}" in
  start)
    if [ -f "$KPIDF" ] && kill -0 "$(cat "$KPIDF")" 2>/dev/null; then echo "already running: $(cat "$URLF" 2>/dev/null)"; exit 0; fi
    curl -s -m3 "http://127.0.0.1:$PORT/healthz" >/dev/null || ./start.sh
    rm -f "$URLF"
    nohup setsid "$0" _keepalive > /dev/null 2>&1 &
    echo $! > "$KPIDF"
    for i in $(seq 1 45); do [ -s "$URLF" ] && break; sleep 1; done
    if [ -s "$URLF" ]; then echo "tunnel up: $(cat "$URLF")"; else echo "tunnel started but no URL yet; see $LOG"; exit 1; fi ;;
  _keepalive) keepalive ;;
  stop)
    [ -f "$KPIDF" ] && kill "$(cat "$KPIDF")" 2>/dev/null
    sleep 0.5; [ -f "$PIDF" ] && kill "$(cat "$PIDF")" 2>/dev/null
    rm -f "$KPIDF" "$PIDF"; echo stopped ;;
  restart) "$0" stop; sleep 1; "$0" start ;;
  status)
    if [ -f "$KPIDF" ] && kill -0 "$(cat "$KPIDF")" 2>/dev/null; then echo "running (keepalive pid $(cat "$KPIDF"), tunnel pid $(cat "$PIDF" 2>/dev/null)): $(cat "$URLF" 2>/dev/null)"; else echo "not running"; fi ;;
  url) cat "$URLF" 2>/dev/null ;;
  *) echo "usage: $0 start|stop|restart|status|url"; exit 2 ;;
esac
