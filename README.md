# TuneLoad — YouTube to MP3 Downloader

Fast, clean YouTube → MP3 converter with **full playlist support**, **multi-cookie
auto-switch**, **Telegram bot downloads** (button-driven, zero typing), an
**admin control room** and **server auto-clean**, built like the popular
"ytdown.to"-style server-side downloaders.

## Features

- 🎵 **Single video & full playlist downloads** (Mixes with 25+ tracks, big playlists via pagination — 100-track lists verified)
- 🎚 **All qualities**: 320 / 256 / 192 / 128 kbps MP3 (ID3 tags + embedded cover art)
- 🛡 **Reliability engine v3** (playlists survive to the end): yt-dlp runs are
  **serialized**, cookie-set failures are **classified** (real engine rejections
  rest the set 45s→90s→180s; rate-limits rest 30s→60s→120s; **video problems —
  private / members-only / age-gated — never poison a cookie set**), ALL sets
  cooling → the track **waits out the nearest cooldown** (≤90s) instead of
  failing, **3 retry rounds** with growing backoff, a **server-wide circuit
  breaker** (4 consecutive failed tracks → one shared 25 s pause, then resume),
  and any download can be **cancelled** mid-flight (killed cleanly, no orphans).
- 🍪 **Multi cookie sets with auto-switch**: paste as many cookies.txt sets as you
  want (Admin → Cookie sets). If YouTube rejects one, the engine automatically
  switches to the next working set and remembers the last-good one.
- ⚡ **Fast UX**: link analyzed → MP3 auto-prefetches → click = ~1-2s; live progress
  (% + speed + ETA) streams into every row; failed tracks get one-tap Retry.
- 🎛 **Live engine settings** (Admin → Engine settings — no restart): max
  concurrent downloads (0=auto, 1-8), anti-rate-limit gap between runs, playlist
  **auto-prefetch** (server pre-prepares the first 50 tracks after analysis), and
  **download delivery**: Blob (classic on-page save) or **Native** (the browser's
  own download-manager UI handles the file — feels like any other downloader).
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
- bgutil-ytdlp-pot-provider (PO token server)

## Setup

```bash
# 1. install deps
npm install

# 2. (recommended) PO-token provider
git clone https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git
cd bgutil-ytdlp-pot-provider/server && npm install && npm run build
node build/main.js   # PO tokens on :4416

# 3. engine binaries
pip install -U yt-dlp yt-dlp-ejs    # + ffmpeg on PATH + node ≥ 22

# 4. admin password (.env)
echo "ADMIN_PASSWORD=fahad" >> .env

# 5. run
npm run dev                    # dev server on :3000
npm run build && npm start    # production (standalone)
```

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
           → /api/download (serialized engine: cookie-chain → direct → mirrors,
                            retries + auto-switch + cancel) → MP3 stream → auto-clean
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

## Container deployment (BasicDeploy)

The app listens on `0.0.0.0:8080`. `scripts/.bd_boot.sh` (installed to
`/workspace/.bd_boot.sh`) runs on every container wake: it provisions yt-dlp /
ffmpeg / node22 / POT deps as needed, keeps already-healthy processes, SIGKILLs
stale ones, and relaunches the app + Telegram bot — idempotent by design.
`scripts/start.sh` sources `.env` (ADMIN_PASSWORD, MAX_CONCURRENCY=1) and boots
the standalone server.

Secrets live outside the code bundle: `data/cookies/cookies-N.txt`,
`data/tgbot.json`, `.env`.
