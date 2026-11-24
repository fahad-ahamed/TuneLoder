# TuneLoad — YouTube to MP3 Downloader

Fast, clean YouTube → MP3 converter with **full playlist support**, **multi-cookie
auto-switch**, **Telegram bot downloads** (button-driven, zero typing), an
**admin control room** and **server auto-clean**, built like the popular
"ytdown.to"-style server-side downloaders.

## Features

- ⚡ **Speed-first engine** (no PO-token server, no third-party mirror proxies):
  yt-dlp with **16 parallel fragment connections**, a **parallel engine gate**
  (4 runs at once without cookies / 2 with cookie sets), a tiny 150 ms pacing
  gap, fast retry rounds (3 s / 8 s backoff), and **playlist auto-prefetch ON by
  default** — the server pre-prepares tracks the moment a link is analyzed, so
  a click lands on the on-disk cache and delivers in ~1-2 s.
- 🎵 **Single video & full playlist downloads** (Mixes with 25+ tracks, big playlists via pagination — 100-track lists verified)
- 🎚 **All qualities**: 320 / 256 / 192 / 128 kbps MP3 (ID3 tags + embedded cover art)
- 🛡 **Reliability engine v4** (playlists survive to the end): cookie-set
  failures are **classified** (real engine rejections rest the set 45s→90s→180s;
  rate-limits rest 30s→60s→120s; **video problems — private / members-only /
  age-gated — never poison a cookie set**), ALL sets cooling → the track **waits
  out the nearest cooldown** (≤90s) instead of failing, **3 fast retry rounds**,
  a **server-wide circuit breaker** (4 consecutive failed tracks → one shared
  15 s pause, then resume), and any download can be **cancelled** mid-flight
  (killed cleanly, no orphans).
- 🍪 **Multi cookie sets with auto-switch**: paste as many cookies.txt sets as you
  want (Admin → Cookie sets). If YouTube rejects one, the engine automatically
  switches to the next working set and remembers the last-good one.
- ⚡ **Fast UX**: link analyzed → MP3 auto-prefetches → click = ~1-2s; live progress
  (% + speed + ETA) streams into every row; failed tracks get one-tap Retry.
- 🎛 **Live engine settings** (Admin → Engine settings — no restart): max
  concurrent downloads (0=auto, 1-8), anti-rate-limit gap between runs, playlist
  **auto-prefetch** (server pre-prepares the first 50 tracks after analysis — ON
  by default), and **download delivery**: Blob (classic on-page save) or
  **Native** (the browser's own download-manager UI handles the file — feels
  like any other downloader).
- 🤖 **Telegram bot (@ytdownloader247_bot)**: everything through BUTTONS — quality
  (320/256/192/128), **Download mode** button (🤖 Auto = asks per link · ✋ Manual
  = any link you send downloads INSTANTLY at the saved quality — no confirmations),
  playlist track picker (paged, tap-to-select ✓, All), **live progress edits**
  (▓▓▓░░ 45% · 1.2MiB/s · ETA 8s), **link queue** (send another link while busy →
  queued automatically), **Cancel anytime** (kills the active download, shows
  exactly what was skipped), failed tracks get a 🔁 Retry button. Mode + quality
  persist per chat across bot restarts (`data/tgbot-state.json`).
  Chunk system: tracks over 50MB arrive as ≤45MB parts (unlimited total size).
- 🔐 **Admin control room** (`/admin`): password login (bootstrap from `.env`
  `ADMIN_PASSWORD`, default `fahad`; changeable in the dashboard — stored hashed in
  `data/admin.json`). Cookie sets, engine settings, Telegram bot — all here,
  safely away from normal visitors. `api/cookies`, `api/settings` and
  `api/telegram` require the admin session.
- 🧹 **Auto-clean**: every finished download is deleted from the server ~60s after
  it's fully served (bot sends: deleted right after upload) plus a background
  sweeper — nothing piles up.
- 🖥 **Clean premium UI**: dark glassmorphism, no ads, fully responsive (pages
  router hydration — immune to hosting-proxy HTML injection).

## Tech Stack

- Next.js 16 (Pages Router UI + App Router API routes, standalone output)
- Tailwind CSS 4 + shadcn/ui
- yt-dlp (`--js-runtimes node`) + ffmpeg (MP3 conversion + chunk splitting)

## Setup

```bash
# 1. install deps
npm install

# 2. engine binaries
pip install -U yt-dlp yt-dlp-ejs    # + ffmpeg on PATH + node ≥ 22

# 3. admin password (.env)
echo "ADMIN_PASSWORD=fahad" >> .env

# 4. run
npm run dev                    # dev server on :3000
npm run build && npm start    # production (standalone)
```

No PO-token provider and no proxy/mirror services are needed — the engine talks
to YouTube directly through yt-dlp (with the EJS JS-challenge solver) and falls
back across your cookie sets automatically.

## Admin

Open **/admin**, log in with the `.env` password (default `fahad`), then:

- **Cookie sets** — paste a `cookies.txt` (Netscape format; export with a browser
  extension like *Get cookies.txt LOCALLY* while signed into YouTube). Add as many
  sets as you like — one fails, the next takes over automatically.
- **Engine settings (live)** — max concurrent downloads (0 = auto, 1–8), gap
  between engine runs (anti rate-limit pacing), playlist auto-prefetch, and
  download delivery (Blob vs Native browser download UI). Saved settings live in
  `data/config.json` and apply to the very next run — no restart.
- **Telegram bot** — paste a @BotFather token → Connect. The bot runs detached
  (`scripts/tgbot.mjs`, logs in `data/tgbot.log`) and auto-heals.
- **Change password** — persists a scrypt hash to `data/admin.json` (also synced
  to `.env` when writable).

## Telegram bot quickstart

1. Talk to **@BotFather** → `/newbot` → copy the token.
2. Admin → Telegram bot → paste token → **Connect bot**.
3. DM the bot any YouTube link. Video → tap a quality button. Playlist → tap
   track numbers (✓ toggles), All, or a quality button first — then ⬇ Download.
   Progress streams live; send more links anytime (they queue); ✖ Cancel
   anywhere. /cancel shows the queue with per-item remove buttons.
4. **Download mode** — tap the `🤖 Download mode` button (or send `/mode`):
   - 🤖 **Auto** (default): every link asks for quality / tracks first.
   - ✋ **Manual**: set the quality once (e.g. 320 kbps) → from then on ANY
     video or playlist link starts downloading INSTANTLY at that quality —
     no confirmations, videos and whole playlists alike.

## How it works

```
paste link → /api/info     (oEmbed + RSS + innertube "next" panel → full track list)
           → /api/download (parallel engine: cookie-chain → direct,
                            fast retries + auto-switch + cancel) → MP3 stream → auto-clean
```

| Endpoint | Purpose |
|---|---|
| `POST /api/info` | Video / playlist metadata + full track list |
| `POST /api/download` | Engine → MP3 stream, auto-cleaned after serving |
| `GET /api/download-file` | Same engine, native browser-download delivery |
| `POST /api/prefetch` | Fire-and-forget cache warmer (single videos) |
| `POST /api/prefetch-batch` | Playlist cache warmer (admin opt-in) |
| `POST /api/settings` | Live engine settings (admin) |
| `GET /api/progress` | Live job progress (% + speed + ETA) |
| `POST /api/cancel` | Kill an in-flight engine job |
| `GET /api/status` | Engine health + queue state |
| `POST/GET/DELETE /api/admin/auth` | Admin login / session / password change |
| `GET/POST/DELETE /api/cookies` | Cookie-set management (admin-gated) |
| `GET/POST/DELETE /api/telegram` | Bot lifecycle (admin-gated) |
| `POST /api/fetch-audio` | Internal: bot fetches MP3 by path |

## Deployment (AWS EC2 Ubuntu / any VPS)

Plain Node.js app — no platform lock-in, no RAM cap, no forced reverse proxy.

```bash
# on a fresh Ubuntu 22.04/24.04 server:
sudo bash scripts/setup-ubuntu.sh
```

The script installs Node 22 + yt-dlp (+ EJS solver) + ffmpeg, builds the app and
registers `tuneload.service` (systemd: starts on boot, auto-restarts on crash).
Full step-by-step guide (EC2 setup, security group, Telegram bot, port 80/443):
**[DEPLOY.md](DEPLOY.md)**.

Manual route: `npm install` → `npm run build` → `npm start` (uses
`.next/standalone/server.js`, `PORT` env, default 3000).

### Engine env knobs (`.env`)

| Var | Default | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | — | /admin login password |
| `MAX_CONCURRENCY` | 4 | parallel yt-dlp runs (1–16) |
| `AUDIO_CACHE_GB` | 8 | MP3 cache hard cap (GB) |
| `AUDIO_CACHE_TTL_MIN` | 180 | cache age limit (minutes) |
| `PORT` | 3000 | listen port |

Secrets live outside the code: `data/cookies/cookies-N.txt`, `data/tgbot.json`,
`.env` (all git-ignored).
