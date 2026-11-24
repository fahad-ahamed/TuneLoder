#!/bin/sh
# TuneLoad universal launcher — works on ANY VPS (AWS EC2 Ubuntu, DigitalOcean,
# Hetzner, home server…). Production: node .next/standalone/server.js.
#
#   PORT              listen port            (default 3000)
#   HOSTNAME          bind address           (default 0.0.0.0)
#   MAX_CONCURRENCY   parallel yt-dlp runs   (default 4; 1-16)
#   AUDIO_CACHE_GB    MP3 cache cap in GB    (default 8)
#   AUDIO_CACHE_TTL_MIN  cache age limit     (default 180)
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
# deterministic app root for the engine/bot/cleanup — Next standalone chdir()s
# into .next/standalone, which would otherwise scatter data/ on every deploy
export TL_APP_DIR="$APP_DIR"

# load app env (ADMIN_PASSWORD, MAX_CONCURRENCY, …) when present
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

export PORT="${PORT:-3000}"
export HOSTNAME="${HOSTNAME:-0.0.0.0}"
export NODE_ENV=production
export NEXT_TELEMETRY_DISABLED=1
export MAX_CONCURRENCY="${MAX_CONCURRENCY:-4}"

mkdir -p data/cookies data/audio .tmp-downloads

# engine binaries: whatever is on PATH (setup-ubuntu.sh installs them)
if command -v yt-dlp >/dev/null 2>&1; then export YTDLP_BIN="$(command -v yt-dlp)"; fi
if command -v ffmpeg >/dev/null 2>&1; then export FFMPEG_BIN="$(command -v ffmpeg)"; fi
# fallback: ./bin (optional manual installs)
[ -x "$APP_DIR/bin/yt-dlp" ] && export YTDLP_BIN="$APP_DIR/bin/yt-dlp"
[ -x "$APP_DIR/bin/ffmpeg" ] && export FFMPEG_BIN="$APP_DIR/bin/ffmpeg"

# yt-dlp's JS challenge solver needs node ≥ 22 — system node from
# setup-ubuntu.sh is v22, but honor a bundled bin/node22 when present.
SYS_NODE_MAJOR=$(node -v 2>/dev/null | cut -c2- | cut -d. -f1)
if [ "${SYS_NODE_MAJOR:-0}" -lt 22 ] && [ -x "$APP_DIR/bin/node22/bin/node" ]; then
  export PATH="$APP_DIR/bin/node22/bin:$PATH"
fi
export YTDLP_JS_RUNTIME="${YTDLP_JS_RUNTIME:-node}"

exec node .next/standalone/server.js
