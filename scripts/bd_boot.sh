#!/bin/sh
# BasicDeploy boot/provision hook — runs on EVERY container wake, so it must be
# IDEMPOTENT: keep healthy processes, SIGKILL stale ones, then relaunch.
# (Also safe to run repeatedly by hand.)
APP_DIR=/workspace/tuneload
cd "$APP_DIR" || exit 1
mkdir -p data/cookies data/audio data/tgbot-test-outbox .tmp-downloads bin

# yt-dlp: pip first (full plugin support), else self-contained binary fallback
if ! command -v yt-dlp >/dev/null 2>&1 && [ ! -x bin/yt-dlp ]; then
  pip3 install -U yt-dlp yt-dlp-ejs >/dev/null 2>&1 || \
  { curl -fsSL -o bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      && chmod +x bin/yt-dlp; } || true
fi

# ffmpeg: static build fallback (apt can be slow/broken on tiny containers)
if ! command -v ffmpeg >/dev/null 2>&1 && [ ! -x bin/ffmpeg ]; then
  { curl -fsSL -o /tmp/ff.tar.xz https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
      && tar -xJf /tmp/ff.tar.xz -C /tmp \
      && cp /tmp/ffmpeg-*-static/ffmpeg /tmp/ffmpeg-*-static/ffprobe bin/ \
      && rm -rf /tmp/ff.tar.xz /tmp/ffmpeg-*-static; } || true
fi

# node >= 22 for yt-dlp's JS challenge solver (system node may be older)
SYS_NODE_MAJOR=$(node -v 2>/dev/null | cut -c2- | cut -d. -f1)
if [ "${SYS_NODE_MAJOR:-0}" -lt 22 ] && [ ! -x bin/node22/bin/node ]; then
  N22=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ 2>/dev/null | grep -oE 'node-v22[0-9.]*-linux-x64\.tar\.gz' | head -1)
  if [ -n "$N22" ]; then
    curl -fsSL -o /tmp/n22.tar.gz "https://nodejs.org/dist/latest-v22.x/$N22" \
      && tar -xzf /tmp/n22.tar.gz -C bin \
      && mv "bin/${N22%.tar.gz}" bin/node22 \
      && rm -f /tmp/n22.tar.gz
  fi
fi

# POT server npm deps (its build/main.js needs them at runtime)
if [ -f bgutil-ytdlp-pot-provider/server/build/main.js ] && [ ! -d bgutil-ytdlp-pot-provider/server/node_modules ]; then
  ( cd bgutil-ytdlp-pot-provider/server && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) || true
fi

# --- app: keep it when it already answers; otherwise SIGKILL stale + start ---
if curl -s -m 4 http://127.0.0.1:8080/api/status 2>/dev/null | grep -q ffmpeg; then
  echo "app already healthy — keeping it"
else
  # bracketed patterns so pkill never matches THIS script's own cmdline;
  # -9 so a hung next-server can't hold port 8080 hostage
  pkill -9 -f "node serve[r].js" 2>/dev/null
  pkill -9 -f "next-serve[r]" 2>/dev/null
  sleep 2
  nohup ./scripts/start.sh > data/app.log 2>&1 < /dev/null &
fi

# --- POT token server: keep an existing instance, start one only when none runs ---
if [ -f bgutil-ytdlp-pot-provider/server/build/main.js ] && [ -d bgutil-ytdlp-pot-provider/server/node_modules ]; then
  if ! pgrep -f "build/main[.]js" >/dev/null 2>&1; then
    ( cd bgutil-ytdlp-pot-provider/server && nohup node build/main.js > "$APP_DIR/data/pot-server.log" 2>&1 & )
  fi
fi

# --- Telegram bot: keep a live poller, start one only when none exists ---
if [ -f data/tgbot.json ]; then
  if ! pgrep -f "scripts/tgbo[t].mjs" >/dev/null 2>&1; then
    PORT=8080 nohup node scripts/tgbot.mjs >> data/tgbot.log 2>&1 < /dev/null &
  fi
fi
