#!/bin/sh
# TuneLoad container launcher — binds 0.0.0.0:8080 (BasicDeploy public port)
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

# load app env (ADMIN_PASSWORD, MAX_CONCURRENCY …) when present
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

export PORT=8080
export HOSTNAME=0.0.0.0
export NODE_ENV=production
export MAX_CONCURRENCY="${MAX_CONCURRENCY:-1}"

mkdir -p data/cookies data/audio .tmp-downloads bin

# engine binaries: prefer PATH (pip/apt installed), else ./bin (boot script downloads)
if [ -x bin/yt-dlp ]; then export YTDLP_BIN="$APP_DIR/bin/yt-dlp"; fi
if [ -x bin/ffmpeg ]; then export FFMPEG_BIN="$APP_DIR/bin/ffmpeg"; fi
if command -v yt-dlp >/dev/null 2>&1; then export YTDLP_BIN="$(command -v yt-dlp)"; fi
if command -v ffmpeg >/dev/null 2>&1; then export FFMPEG_BIN="$(command -v ffmpeg)"; fi

# yt-dlp's JS challenge solver needs node >= 22 — if system node is older, put the
# bundled one (downloaded by bd_boot.sh into bin/node22) FIRST ON PATH. The
# "node:/dir" runtime spec is not accepted by every yt-dlp build; a PATH-resolved
# node ≥22 works everywhere and is what the challenge solver picks up.
SYS_NODE_MAJOR=$(node -v 2>/dev/null | cut -c2- | cut -d. -f1)
if [ "${SYS_NODE_MAJOR:-0}" -lt 22 ] && [ -x "$APP_DIR/bin/node22/bin/node" ]; then
  export PATH="$APP_DIR/bin/node22/bin:$PATH"
fi
export YTDLP_JS_RUNTIME="${YTDLP_JS_RUNTIME:-node}"

# bundled PO-token server (skips silently if absent; npm deps installed by .bd_boot.sh)
if [ -f bgutil-ytdlp-pot-provider/server/build/main.js ] && [ -d bgutil-ytdlp-pot-provider/server/node_modules ]; then
  ( cd bgutil-ytdlp-pot-provider/server && nohup node build/main.js > "$APP_DIR/data/pot-server.log" 2>&1 & )
  sleep 1
fi

exec node server.js
