#!/usr/bin/env bash
# ============================================================================
# TuneLoad — one-shot installer for AWS EC2 Ubuntu / any Debian-based VPS
#
#   sudo bash scripts/setup-ubuntu.sh
#
# Installs: Node.js 22, yt-dlp (+ EJS challenge solver), ffmpeg; then builds
# TuneLoad and registers a systemd service (tuneload.service) that starts on
# boot and auto-restarts on crash. Idempotent — safe to run repeatedly.
# ============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo "==> [1/7] System packages (ffmpeg, python3-pip, curl)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends ffmpeg python3-pip curl ca-certificates gnupg

echo "==> [2/7] Node.js 22 (LTS) via NodeSource"
if command -v node >/dev/null 2>&1 && [ "$(node -v | cut -c2- | cut -d. -f1)" -ge 22 ]; then
  echo "    node $(node -v) already installed — skipping"
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> [3/7] yt-dlp + EJS challenge solver (pip)"
pip3 install --break-system-packages -U yt-dlp yt-dlp-ejs 2>/dev/null \
  || pip3 install -U yt-dlp yt-dlp-ejs
yt-dlp --version

echo "==> [4/7] App environment (.env)"
if [ ! -f .env ]; then
  cp .env.example .env
  # random admin password unless ADMIN_PASSWORD already set in the environment
  PASS="${ADMIN_PASSWORD:-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${PASS}|" .env
  echo "    .env created — ADMIN_PASSWORD: ${PASS}"
  echo "    (write it down / change it later in /admin)"
else
  echo "    .env already present — keeping it"
fi

echo "==> [5/7] Install dependencies + production build"
# zip extraction can drop the execute bit — systemd needs it on start.sh (203/EXEC)
chmod +x scripts/*.sh scripts/*.mjs 2>/dev/null || true
npm install --no-audit --no-fund
npm run build

echo "==> [6/7] systemd service (tuneload.service — starts on boot, auto-restart)"
SERVICE=/etc/systemd/system/tuneload.service
cat > "$SERVICE" <<EOF
[Unit]
Description=TuneLoad — YouTube to MP3 (web + Telegram bot)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=${APP_DIR}/scripts/start.sh
Restart=always
RestartSec=5
# no RAM/CPU limits — the box is yours (raise KillSignal grace for big zips)
KillSignal=SIGTERM
TimeoutStopSec=30
Environment=NODE_ENV=production
Environment=NEXT_TELEMETRY_DISABLED=1

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable tuneload.service
systemctl restart tuneload.service
sleep 3
systemctl --no-pager --lines=5 status tuneload.service || true

PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)
PORT=${PORT:-3000}

echo "==> [7/7] Done!"
echo "    Web UI   : http://<your-server-ip>:${PORT}   (admin panel: /admin)"
echo "    Logs     : journalctl -u tuneload -f"
echo "    Restart  : systemctl restart tuneload"
echo ""
echo "    Security group / firewall: open TCP ${PORT} (and 443 if you add HTTPS)."
echo "    Telegram bot: /admin → Telegram bot → paste @BotFather token → Connect."
