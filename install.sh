#!/usr/bin/env bash
# 在 Oracle Cloud VM 上以 root 執行（push.sh 會自動呼叫）：
#   sudo bash install.sh /tmp/wzw
# 可重複執行（更新程式）；VM 上已有 data/db.json 時「不會覆蓋」，除非 FORCE_DATA=1。
# 環境變數：DOMAIN=自訂網域（預設 <IP>.sslip.io）  NO_BOTS=1 不裝 AI 玩家  PORT=8770
set -euo pipefail
SRC="${1:-/tmp/wzw}"; APP=/opt/wzw; USR=wzw; PORT="${PORT:-8770}"
log(){ echo -e "\n== $* =="; }
[ "$(id -u)" = 0 ] || { echo "請用 sudo 執行"; exit 1; }
ARCH=$(uname -m); case "$ARCH" in x86_64) CARCH=amd64;; aarch64|arm64) CARCH=arm64;; *) echo "不支援的架構 $ARCH"; exit 1;; esac
if command -v apt-get >/dev/null; then PM=apt; elif command -v dnf >/dev/null; then PM=dnf; else echo "需要 Ubuntu/Debian 或 Oracle Linux"; exit 1; fi

log "1. 系統套件"
if [ $PM = apt ]; then export DEBIAN_FRONTEND=noninteractive; apt-get update -y; apt-get install -y curl ca-certificates tar gzip iptables-persistent || apt-get install -y curl ca-certificates tar gzip
else dnf install -y curl tar gzip; fi

log "2. Node.js 20"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  if [ $PM = apt ]; then curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; apt-get install -y nodejs
  else curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -; dnf install -y nodejs; fi
fi
node -v

log "3. 小記憶體機器：建立 2G swap（若尚無）"
if [ "$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)" -lt 3000 ] && ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "4. 安裝遊戲到 $APP"
id $USR >/dev/null 2>&1 || useradd -r -m -d /home/$USR -s /usr/sbin/nologin $USR
mkdir -p $APP
HAD_DATA=0; [ -f $APP/server/data/db.json ] && HAD_DATA=1
if [ $HAD_DATA = 1 ]; then systemctl stop wzw-aibots wzw-server 2>/dev/null || true; cp -a $APP/server/data/db.json "$APP/server/data/db.json.bak-$(date +%Y%m%d-%H%M%S)"; fi
# 程式檔（不碰 data/）
tar -C "$SRC" --exclude='./server/data' -cf - . | tar -C $APP -xf -
mkdir -p $APP/server/data
if [ -f "$SRC/server/data/db.json" ] && { [ $HAD_DATA = 0 ] || [ "${FORCE_DATA:-0}" = 1 ]; }; then cp "$SRC/server/data/db.json" $APP/server/data/db.json; echo "已放入資料 db.json"; else echo "保留 VM 上原有資料"; fi
[ -f "$SRC/server/aibots/accounts.json" ] && [ ! -f $APP/server/aibots/accounts.json ] && cp "$SRC/server/aibots/accounts.json" $APP/server/aibots/accounts.json
chown -R $USR:$USR $APP; chmod 600 $APP/server/aibots/accounts.json 2>/dev/null || true
sudo -u $USR bash -c "cd $APP/server && npm ci --omit=dev --no-audit --no-fund || npm install --no-audit --no-fund"

log "5. 遊戲伺服器 systemd"
cat > /etc/systemd/system/wzw-server.service <<UNIT
[Unit]
Description=萬王之王 Online game server
After=network-online.target
Wants=network-online.target
[Service]
User=$USR
WorkingDirectory=$APP/server
Environment=PORT=$PORT HOST=127.0.0.1 NODE_ENV=production
ExecStart=/usr/bin/env node server.js
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload; systemctl enable --now wzw-server
for i in $(seq 1 30); do curl -fs -o /dev/null http://127.0.0.1:$PORT/ && break; sleep 1; done
curl -fs -o /dev/null -w "本機 HTTP %{http_code}\n" http://127.0.0.1:$PORT/

if [ "${NO_BOTS:-0}" != 1 ]; then
  log "6. AI 玩家（headless Chromium，由 playwright-core 下載；amd64/arm64 皆可）"
  export PLAYWRIGHT_BROWSERS_PATH=$APP/ms-playwright
  sudo -u $USR bash -c "cd $APP/server/aibots && npm install --no-audit --no-fund"
  ( cd $APP/server/aibots && PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH node node_modules/playwright-core/cli.js install-deps chromium ) || true
  sudo -u $USR env PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH bash -c "cd $APP/server/aibots && node node_modules/playwright-core/cli.js install chromium"
  CHROME=$(sudo -u $USR env PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH node -e "process.chdir('$APP/server/aibots'); console.log(require('$APP/server/aibots/node_modules/playwright-core').chromium.executablePath())")
  echo "Chromium：$CHROME"
  cat > /etc/systemd/system/wzw-aibots.service <<UNIT
[Unit]
Description=萬王之王 AI players (headless Chromium)
After=wzw-server.service
Requires=wzw-server.service
[Service]
User=$USR
WorkingDirectory=$APP/server
Environment=WZW_URL=http://127.0.0.1:$PORT CHROME=$CHROME PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH
ExecStart=/usr/bin/env node aibots/aibots.js
Restart=always
RestartSec=10
MemoryMax=1500M
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload; systemctl enable --now wzw-aibots
fi

log "7. Caddy（自動 HTTPS）"
IP=$(curl -fs4 -m 8 https://api.ipify.org || curl -fs4 -m 8 https://ifconfig.me || true)
DOMAIN="${DOMAIN:-${IP//./-}.sslip.io}"
if ! command -v caddy >/dev/null; then
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=$CARCH" -o /usr/local/bin/caddy; chmod +x /usr/local/bin/caddy
fi
id caddy >/dev/null 2>&1 || useradd -r -m -d /var/lib/caddy -s /usr/sbin/nologin caddy
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<CF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
# 用 IP 直接連（http，沒有憑證）也能玩
http://$IP {
	reverse_proxy 127.0.0.1:$PORT
}
CF
cat > /etc/systemd/system/caddy.service <<UNIT
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target
[Service]
User=caddy
ExecStart=$(command -v caddy) run --environ --config /etc/caddy/Caddyfile
ExecReload=$(command -v caddy) reload --config /etc/caddy/Caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload; systemctl enable caddy; systemctl restart caddy

log "8. 防火牆（VM 內）"
if command -v firewall-cmd >/dev/null && systemctl is-active -q firewalld; then
  firewall-cmd --permanent --add-service=http --add-service=https; firewall-cmd --reload
else
  for p in 443 80; do iptables -C INPUT -p tcp -m state --state NEW --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp -m state --state NEW --dport $p -j ACCEPT; done
  command -v netfilter-persistent >/dev/null && netfilter-persistent save || (mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4)
fi

log "9. 每日備份 db.json（保留 14 天）"
cat > /etc/cron.daily/wzw-backup <<CRON
#!/bin/sh
mkdir -p $APP/backups && cp $APP/server/data/db.json $APP/backups/db-\$(date +%Y%m%d).json && find $APP/backups -name 'db-*.json' -mtime +14 -delete
CRON
chmod +x /etc/cron.daily/wzw-backup

log "完成"
echo "遊戲網址： https://$DOMAIN/   （也可用 http://$IP/）"
echo "⚠ 若外部連不上：到 OCI 主控台 → VCN → Security List 新增 Ingress 0.0.0.0/0 TCP 80、443（見 README）"
systemctl --no-pager --lines=0 status wzw-server caddy ${NO_BOTS:+} | grep -E "●|Active" || true
