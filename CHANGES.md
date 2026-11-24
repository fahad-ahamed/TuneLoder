# TuneLoder — Cleanup Log

## v5 — BasicDeploy liberation + AWS EC2 / any-VPS edition (current)

BasicDeploy-এর 250 MB RAM-lock, forced reverse proxy, HTML-injection workaround —
সব platform-specific baggage তুলে দিয়ে প্রজেক্টকে plain Node.js app বানানো হয়েছে,
যেকোনো VPS (AWS EC2 Ubuntu বিশেষভাবে) এ full performance-এ চলে।

### DELETE করা হয়েছে (BasicDeploy-era legacy)
- `scripts/bd_boot.sh` — BasicDeploy-এর hardcoded `/workspace/tuneload` boot hook
  (RAM-সীমিত container provisioning, pkill hack, POT server spawn)
- `scripts/bd_ssh.py` — BasicDeploy SSH deploy helper
- `scripts/make-deploy-bundle.sh` — BasicDeploy bundle builder
- `scripts/inject-proxy-test.js` — BasicDeploy-এর proxy HTML-injection রিপ্লিকা টেস্ট
- `Caddyfile` — BasicDeploy-এর forced caddy transform config
- সব platform dev/e2e scripts — `browser-e2e.sh`, `engine-e2e.sh`, `cancel-e2e.sh`,
  `test-suite.sh`, `test-chunks.mjs`, `test-tgbot*.mjs`, `test_exotic_hosts.py`,
  `test_gapi.py`, `test_innertube_clients.py`
- `src/components/no-ssr.tsx` — শুধু hosting-proxy hydration bug এড়ানোর বাইপাস (unused)

### Limitation-free (সব ধরনের cap তুলে দেওয়া / VPS-সাইজ করা)
| জায়গা | আগে | এখন |
|---|---|---|
| `export const maxDuration = 300` (৪টা route) | serverless time-limit | **মুছে গেছে** — VPS-এ কোনো execution-time limit নেই |
| yt-dlp run timeout | 240 s | **600 s** (বড় ফাইলও নির্ভয়ে) |
| MP3 cache cap | 1 GB hard-coded | **`AUDIO_CACHE_GB` env, default 8 GB** |
| Cache TTL | 60 min | **180 min** (`AUDIO_CACHE_TTL_MIN` env) |
| Prefetch engine queue | 24 | **64** |
| Prefetch per-client cap | 8 | **24** |
| Playlist prefetch batch | 50 tracks | **150 tracks** |
| ZIP batch items | 200 | **500** (TTL 30→60 min) |
| Admin maxConcurrency slider cap | 8 | **16** |
| runGapMs ন্যূনতম | 200 ms জোর করে | **0** (admin চাইলে gap পুরো তুলতে পারে) |

### Lightweight (dependency prune — 54 → 15 runtime deps)
- ব্যবহার-বিহীন ৪০+ package বাদ: prisma+@prisma/client, next-auth, mdxeditor,
  dnd-kit(৩টা), tanstack query/table, recharts, framer-motion, sharp, zod, zustand,
  uuid, date-fns, react-hook-form, react-markdown, react-syntax-highlighter,
  react-day-picker, embla, cmdk, vaul, input-otp, z-ai-web-dev-sdk, next-intl,
  @reactuses/core এবং ১৮টা অব্যবহৃত @radix-ui package
- মুছে গেছে ৪১টা unused shadcn UI component (৪১টা রেখে মাত্র ৭টা ব্যবহৃত) +
  unused hooks (`use-toast`, `use-mobile`) + `src/lib/db.ts` (prisma stub) +
  hello-world stub route `src/app/api/route.ts`
- `npm start` এখন `bun` নয়, **`node`** দিয়ে চলে — VPS-এ bun আলাদা লাগে না
- `next.config.ts`: `ignoreBuildErrors: false` (honest build), `poweredByHeader: false`,
  telemetry disabled

### Any-VPS deployment kit (নতুন)
- `scripts/setup-ubuntu.sh` — এক কমান্ডে সম্পূর্ণ ইনস্টল: Node 22, yt-dlp+EJS,
  ffmpeg, `.env` (random admin password), build, **systemd service** (boot-এ
  auto-start, crash-এ auto-restart) — idempotent
- `scripts/start.sh` — universal launcher (PORT default 3000, 8080 hard-code বাদ)
- `DEPLOY.md` — AWS EC2 Ubuntu step-by-step গাইড (instance সাইজ, security group,
  bot সেটআপ, কমান্ড চিটশিট)
- `.gitignore` — fresh history শুরু করার জন্য (data/, .env, node_modules ইত্যাদি
  কখনো commit হবে না)

---

## v4 — Speed Cleanup (আগের ধাপ)

এই রিপো থেকে POT provider ও সব third-party proxy/mirror সম্পূর্ণ সরানো হয়েছে এবং
engine একদম fast করা হয়েছে — অনলাইনের "click করার সাথে সাথে download" কনভার্টারদের
মতো। Telegram bot ও Website — দুটোই এই একই fast engine ব্যবহার করে।

---

## কী কী DELETE করা হয়েছে (এবং কেন)

### 1. YT POT provider — সম্পূর্ণ মুছে ফেলা হয়েছে
- পুরো `bgutil-ytdlp-pot-provider/` ফোল্ডার (plugin + PO-token server + build files) মুছে গেছে।
  - **কেন slow ছিল:** প্রতিটি download শুরুর আগে engine একটা port-probe চালাতো
    (`ensurePotServer()` → 127.0.0.1:4416 check), না থাকলে server spawn + 1.5s wait —
    এটা প্রতিটি resolve-এ লাগতো। আবার POT token ছাড়া YouTube অনেক সময় throttle করতো।
- কোড থেকে সব POT reference সরানো হয়েছে:
  - `src/lib/ytd/providers.ts` — `POT_PLUGIN_DIR`, `POT_SERVER_DIR`, `POT_SERVER_PORT`,
    `ensurePotServer()`, `isPortOpen()`, আর yt-dlp-র `PYTHONPATH` plugin injection মুছে গেছে।
  - `src/lib/ytd/verify.ts` — একই PYTHONPATH injection মুছে গেছে।
  - `package.json` — build script থেকে bgutil server-এর build+node_modules কপি বাদ।
  - `scripts/start.sh`, `scripts/bd_boot.sh` — POT server boot/নজরদারির block বাদ।
  - `scripts/make-deploy-bundle.sh` — deploy bundle থেকে POT staging বাদ।
  - `eslint.config.mjs` — bgutil ignore entry বাদ।
  - `README.md` — PO-token setup ধাপ বাদ (আর দরকার নেই)।
- POT-dependent dead dev scripts মুছে গেছে: `scripts/test_innertube_advanced.py`,
  `scripts/test_innertube_headers.py` (দুটোই :4416 PO-token server ছাড়া চলতো না)।

### 2. সব proxy / mirror fallback — সম্পূর্ণ মুছে ফেলা হয়েছে
- **Cobalt mirror chain** (`COBALT_MIRRORS` + `tryCobalt()`) মুছে গেছে — এরা তৃতীয়
  পক্ষের proxy সার্ভার দিয়ে download tunnel করতো।
  - **কেন slow ছিল:** প্রতিটি fail-এ ৩টা mirror × 8s timeout = 24s নষ্ট হতো, আর
    mirror নিজেই প্রায়ই rate-limited/মরা থাকতো। এখন এই নষ্ট সময় নেই।
- সেই সাথে সব mirror-only dead code পরিষ্কার: `ResolvedAudio.streamUrl/container`
  field, `convertToMp3()` remote-stream path, `mirrorToLocal()` — আর চারটি route
  (`/api/download`, `/api/download-file`, `/api/fetch-audio`, `/api/download-zip`)
  থেকে mirror-stream handling বাদ। Engine এখন সবসময় সরাসরি on-disk MP3 দেয়।
- Mirror-scanner dev scripts মুছে গেছে: `scripts/scan_piped.py`, `scripts/scan_invidious.py`।
- নিশ্চিত করা হয়েছে: কোথাও কোনো `--proxy` flag, socks, proxy env ছিলও না — এখন নেই।

## কী কী পরিবর্তন করা হয়েছে (Speed)

| জায়গা | আগে | এখন |
|---|---|---|
| `MAX_CONCURRENCY` (auto) | 1 (সব serialized — সবচেয়ে বড় স্লোনেস) | cookie ছাড়া **4**, cookie দিয়ে **2** (`.env`-এ override করা যায়) |
| Run gap (প্রতি download-এর মাঝে dead wait) | 700ms fallback / 900ms default | **150ms** fallback / **250ms** default |
| Fragment connections (`-N`) | 8 | **16** (এক গানের raw download speed প্রায় ২x) |
| Retry backoff | 6s → 15s | **3s → 8s** |
| Circuit breaker pause | 25s | **15s** |
| Playlist auto-prefetch | OFF (প্রতিটা click স্বচ্ছন্দে নতুন download) | **ON** — link analyze হওয়া মাত্রই server পেছনে tracks রেডি করে রাখে → click = cache hit = ~1-2s |
| `socket-timeout` | 20s | 15s |
| Deploy default (`.env.example`, `start.sh`, bundle) | 1 | 4 |

**ফলাফল:** এক গান click → download শুরু সাথে সাথে (prefetch/cache থাকলে ~1s);
playlist-এ একসাথে ৪টা track parallel চলে; কোনো নকল POT-port probe বা
mirror-timeout নষ্ট হয় না।

## যা অক্ষত আছে (project-এর ক্ষতি হয়নি)

- Cookie sets + auto-switch, verify system, cancel, progress (%, speed, ETA),
  ZIP batch pipeline, auto-clean, admin dashboard, Telegram bot-এর সব feature
  (button, Manual mode, queue, chunk splitting) — সব আগের মতোই কাজ করে।
- yt-dlp এখনও JS-challenge solver (EJS) ব্যবহার করে (`--js-runtimes node` +
  `--remote-components ejs:github`) — এটা PO-token না, সাধারণ challenge solver।
- বড় playlist বাঁচানোর reliability ladder (cookie cooldown 45s→90s→180s,
  video-problem classification) অক্ষত — শুধু দ্রুত।

## চালানোর নিয়ম (এক লাইনে)

```bash
npm install
pip install -U yt-dlp yt-dlp-ejs   # + ffmpeg PATH-এ + node ≥ 22
echo "ADMIN_PASSWORD=yourpass" >> .env
npm run dev                        # অথবা: npm run build && npm start
```

কোনো PO-token server বা proxy setup আর লাগবে না।

---

# v0.3.1 — AWS EC2 লাইভ-ডিপ্লয় ফিক্স (২৩ নভেম্বর ২০২৬)

AWS (ubuntu@16.59.194.9, Ubuntu, 1 GB RAM + 2 GB swap) এ লাইভ ডিপ্লয় ও রিয়েল
টেস্টের সময় ধরা পড়া ও ঠিক করা বাগগুলো:

## ফিক্স ১ — data/ path ভুল জায়গায় যাওয়া (critical)

- Next.js standalone `server.js` নিজেই `process.chdir()` করে `.next/standalone/`
  ফোল্ডারে — ফলে `process.cwd()`-ভিত্তিক সব path (MP3 cache, cookie store,
  tgbot config) build-artifact ফোল্ডারে লিখত; প্রতি rebuild-এ মুছে যেত।
- ফিক্স: `TL_APP_DIR` env (start.sh export করে) — `providers.ts`, `cleanup.ts`,
  `tgbot.mjs` এখন `TL_APP_DIR || cwd` ব্যবহার করে। dev/bare-run fallback অক্ষত।

## ফিক্স ২ — /admin page মাঝে মাঝে ফাঁকা রেন্ডার হতো (critical)

- উপসর্গ: header/footer রেন্ডার হয়, ভেতরে শুধু spinner — কোনো console error নেই।
- কারণ: Next 16 Turbopack-এ pages-router direct-load hydration race — page-এর
  নিজের chunk মাঝে মাঝে HTML-এ inject হতো না (buildManifest-এ ছিল, script
  তালিকায় নেই), hydration নীরবে আটকে যেত। ৩ বারের মধ্যে ২ বার হচ্ছিল।
- ফিক্স: build-এ `next build --webpack` — battle-tested bundler, race শেষ।
  ৩× consecutive reload টেস্ট পাস; login, dashboard-এর সব section কাজ করে।

## ফিক্স ৩ — settings API validation settings.ts clamp-এর সাথে না মিলা

- route-এ `maxConcurrency 0-8` আর `runGapMs min 200` ছিল, clamp 0-16 / 0-10000।
  ফিক্স: route validation এখন 0-16 / 0-10000 (error message-ও sync)।

## ফিক্স ৪ — zip extract-এ script permission হারালে systemd 203/EXEC

- `setup-ubuntu.sh` এখন build-এর আগে `chmod +x scripts/*.sh scripts/*.mjs` চালায়।

## লাইভ টেস্ট ফলাফল (AWS)

- "Top 100 Songs Pakistan 2026" playlist (ঠিক ১০০টা track) — **১০০/১০০
  download complete, ~১৪ মিনিটে** (6 parallel, 320kbps, ~১.১৭ GB cache)।
- Download serve test: HTTP 200, সঠিক MP3 (audio/mpeg, ID3 tag সহ)।
- Engine YouTube-এর datacenter bot-check পেরোনোর জন্য user-এর cookie sets +
  auto-switch (android/ios alt clients) ব্যবহার করে — cookie ছাড়া AWS IP-তে
  YouTube ব্লক করে (yt-dlp সরাসরি টেস্ট করে নিশ্চিত)।

## ব্যবহার-নোট

- 1 GB RAM instance-এ maxConcurrency 6 পর্যন্ত নিরাপদ; এর পরে swap বেশি চাপা
  খাবে। transcode-ই bottleneck — CPU কম হলে parallelism না বাড়িয়ে 128/192kbps
  বেছে নিলে দ্রুত হয়।
- Deploy হয় `scripts/setup-ubuntu.sh` + systemd (`tuneload.service`) — boot-এ
  auto-start, crash-এ auto-restart।

---

# v0.3.2 — playlist ১০টা দেখানোর বাগ + speed fix (২৩ নভেম্বর ২০২৬)

## ফিক্স — playlist মাত্র ১০-১৫টা track দেখাচ্ছিল (critical)

- কারণ: AWS datacenter IP-তে YouTube-এর innertube API মাঝে মাঝে HTTP 403 দেয়;
  তখন code RSS feed fallback-এ পড়ত — আর RSS-এ playlist-এর **শেষ ~১৫টা**
  entry-ই থাকে। web UI আর Telegram bot **দুটোই** একই meta layer ব্যবহার করে
  বলে bot-এও ১০টা দেখাত।
- ফিক্স (meta.ts) — layered fallback chain:
  1. innertube "next" panel (fast path, full list)
  2. **yt-dlp flat-playlist rescue** (EJS challenge solver + প্রয়োজনে নতুন
     cookie set) — panel fail করলেই স্বয়ংক্রিয়ভাবে চলে, full list দেয়
  3. RSS এখন শুধু শেষ ভরসা (warning log সহ)
  - continuation cap 3→12 pages (1000+ track পর্যন্ত)
  - panel fail = yt-dlp rescue নিশ্চিত — RSS-only উত্তর আর কখনো বড় playlist-এ
    যাবে না
- ফলাফল: user-এর exact link (si= param সহ) → **source: yt-dlp, ১০০/১০০
  track**, প্রথম বার 8.3s

## ফিক্স — "Get tracks" দেরি → instant

- **Server-side playlist cache (30 মিনিট):** একই playlist দ্বিতীয়বার খুললে
  0.046s — fully instant
- **Auto-analyze on paste:** link paste করলেই 0.7s debounce-এ পেছনে analysis
  শুরু — "Get tracks" click করার আগেই ফলাফল তৈরি, click মানেই instant
- Chain: paste → auto-analyze → auto-prefetch (background download শুরু) —
  user click করার সময় track গুলো ready/হয়ে আসছে

## মাপা speed (AWS, সত্যিকারের fresh download)

- Single video: 21.7 MiB track → 36s (download+transcode)
- 8 fresh tracks একসাথে (6 parallel): 96s, 61 MiB — ~12s/track গড়ে
- 100-track playlist (fresh): ~১৪ মিনিট (আগের রান)
- Bottleneck: 1 vCPU ffmpeg transcode + YouTube-এর datacenter IP-তে per-IP
  byte throttle — bandwidth নয়। তাই "instant" অনুভূতি আসে background
  prefetch + cache থেকে: একবার playlist খুললে engine নিজে নিজে সব আগে থেকে
  নামাতে থাকে, user-এর click গুলো cache-hit = তৎক্ষণাৎ।

# v0.3.3 — "Not authorized (missing internal key)" ফিক্স (২৩ নভেম্বর ২০২৬)

## বাগ

Bot দিয়ে ১০০ track send করতে গেলে সব 401: `Not authorized (missing internal key)`।

## মূল কারণ (দুটো একসাথে)

1. **Key ফাইল কখনো তৈরিই হয়নি:** `/api/fetch-audio`-তে header না থাকলে
   `hasInternalKey()` প্রথমেই `return false` করত — আর key ফাইল তৈরি করে এমন
   `getInternalKey()` সেই পথে কখনো চলতই না। Bot ফাইলটা পড়তে গিয়ে পায় না →
   header ছাড়া request → 401 → ফাইল আবার তৈরি হয় না (chicken-egg লুপ)।
2. **cwd অমিল:** Next standalone server `.next/standalone`-এ chdir করে; বটও সেখানে
   spawn হয়, কিন্তু কোন মডিউল `process.cwd()`, কোনটা `TL_APP_DIR` — মিশ্রিত ছিল।
   উপরে তা সত্ত্বেও প্রতি rebuild-এর `rm -rf .next` data ফাইল মুছে দিত।

## ফিক্স

- `internalkey.ts` / `botsupervisor.ts` / `admin.ts` / `settings.ts` → সবাই এখন
  `TL_APP_DIR || cwd` ব্যবহার করে (providers/cleanup/tgbot-এর সাথে সমজাতাল)
- `fetch-audio` route প্রতি hit-এ `getInternalKey()` চালায় → key ফাইল সবসময়
  materialized, chicken-egg লুপ ভাঙা
- systemd unit-এ `Environment=TL_APP_DIR=/home/ubuntu/tuneload` → server + bot +
  child সব এক জায়গায় data দেখে; rebuild-এও data মুছে যায় না
- Server-এ key ফাইল তৈরি (0600) + standalone-এর নতুন tgbot.json/admin-secret.json
  approot data/-তে migrate

## যাচাই (server-এ মাপা)

- `fetch-audio` key ছাড়া → 401 (সুরক্ষা বহাল) ✓
- `fetch-audio` key সহ → `ok:true, path:.../K364wKMGwF0-320.mp3, 10.5 MiB, cached` ✓
- Bot reconnect ✓, bot process-এ TL_APP_DIR পৌঁছানো ✓
- Playlist ১০০/১০০ (yt-dlp source, 7.8s fresh) ✓, audio cache 101 ফাইল intact ✓
- Browser: paste → ৩ সেকেন্ডে ১০০ track + "Download ZIP · 100" ✓

# v0.3.4 — admin password + instant reading + log cleanup (২৩ নভেম্বর ২০২৬)

## Admin password সমস্যা (ব্যবহারকারীর রিপোর্ট: wrong password দিলে response নেই, engine slow)

- **মূল কারণ:** `.env`-এ `ADMIN_PASSWORD` হিসেবে একটা random string বসা ছিল
  (আগের session-এর আউটপুট) — "fahad" দিলে সবসময় 401 আসত; UI toast হালকা বলে
  ব্যবহারকারী "response নেই" মনে করেছিল। Engine slow হওয়া ছিল ওই সময়ের
  দুই-user load (আলাদা ঘটনা) — scryptSync মাত্র ~50ms block করে, ক্ষতিকর নয়।
- **ফিক্স:** `data/admin.json`-এ scrypt hash লিখে password **fahad** সেট
  (restart ছাড়াই সক্রিয়) + `.env` ঠিক করা
- **UI:** ভুল password এখন input-এর নিচে **inline red error** দেখায় (toast ছাড়াও)
  — `src/pages/admin.tsx`
- যাচাই: `fahad` → `{"ok":true}` ✓, wrong → 401 ✓ (server-এ curl দিয়ে মাপা)

## Website "Reading" slow কেন

- Cached playlist = **0.00s** (instant) — মাপা ✓
- নতুন playlist = ~৮ সেকেন্য (YouTube থেকে metadata extraction — এটা ন্যায্য
  সময়, nano second সম্ভব না)
- সমস্যা ছিল: server cache শুধু memory-তে ছিল → **প্রতি restart-এ মুছে যেত**,
  ফলে বারবার ৮ সেকেন্য লাগত
- **ফিক্স:** playlist cache এখন `data/playlist-cache.json`-এ **disk persist**
  করে (TTL অপরিবর্তিত) — restart/rebuild-এর পরেও আগে খোলা playlist instant

## অন্যান্য

- Bot log duplication বন্ধ (log() file+console দুইবার লিখত)
- cleanup.ts-এর পুরনো comment ঠিক (60 min → 180 min default)
- `MAX_CONCURRENCY=3` সেট (systemd drop-in) — বহু-user playlist load-এ গতি বাড়বে

## Bot double-instance (root cause) — একই দিনে পাওয়া

- Bot log-এ `Conflict: terminated by other getUpdates request` — দুইটা bot
  instance Telegram নিয়ন্ত্রণের জন্য লড়াই করছিল
- **মূল কারণ:** bot spawn হয় দুই পথে — (১) botsupervisor (service), (২)
  `/api/telegram` admin route (detached)। রুটটিতে `ROOT = process.cwd()` ছিল →
  standalone server-এর cwd (`.next/standalone`) ব্যবহার করত → bot-এর log/lock
  **ভিন্ন ডিরেক্টরিতে** যেত → দুই জায়গার state/lock নিয়ে conflict
- **ফিক্স:** `src/app/api/telegram/route.ts` → `TL_APP_DIR || cwd` (এক লাইন)
- যাচাই: এখন একটাই bot process, fd1 → `data/tgbot.log` (approot) ✓, pid file
  match ✓, দুই user-এর queue state approot-এ `queue: []` (সম্পূর্ণ) ✓

## Multi-session download test (engine-level, server-এ চালানো)

2 concurrent session — একটা single song + একটা playlist (gate=3, bot-এর নিজের
queue-ও সমান্তরালে চলছিল):

| Session | Request | Result |
|---|---|---|
| A | single song (fresh) | ok, 74.3s, 10.18 MB ✓ |
| B | playlist reading | **0.03s** (disk cache) ✓ |
| B | playlist track 1 | ok, 0.0s (cross-session dedupe) ✓ |
| B | playlist track 2 | ok, 73.9s, 8.08 MB ✓ |

`all_ok: true, total 74.3s` — multi-user concurrency প্রমাণিত। বাস্তব
bot-এ দুই user-এর ২০০+ track playlist-ও সম্পূর্ণ হয়েছে (queue=0)।

# v0.3.5 — admin effective-value + single-link instant + mobile paste + TG header button

## ১) Admin panel: "Max concurrent downloads 0 কেন"

- **ব্যাখ্যা:** panel-এ দেখানো ০ মানে "auto mode" (env/cookie অনুযায়ী সার্ভার নিজে ঠিক করে —
  cookie থাকলে ২, না থাকলে ৪)। env MAX_CONCURRENCY=3 তখন কার্যকর ছিল, panel সেটাই
  দেখাত না — এখন label-এর পাশে **"এখন কার্যকর (effective): N"** দেখায়
- Panel থেকে সংখ্যা দিলে সেটা settings.json-এ সেভ হয় → env override → **restart ছাড়াই
  পরের run থেকে কার্যকর** (gate প্রতি run-এ live value পড়ে)
- **মোট 4 সেট করা হয়েছে** (admin API দিয়ে, verified: effective 4) — restart-এও থাকবে
- নিচের ২৫০ = **runGapMs**: এক ডাউনলোড শেষ হয়ে পরেরটা শুরুর মাঝের মিলিসেকেন্ড-বিরতি
  (anti rate-limit pacing) — label-এ বাংলা ব্যাখ্যা যোগ করা হয়েছে

## ২) Single link "Reading" — এখন instant

- মূল পথ: videoExists probe + oEmbed metadata **পরপর** চলত → এখন **সমান্তরাল**
  (Promise.all) → মাপা: **0.05–0.09s** (আগে ~0.5-1s+)
- UI: video link paste করলেই metadata না আসা পর্যন্ত **skeleton card সাথে সাথে
  দেখা যায়** (thumbnail CDN থেকে তৎক্ষণাৎ) — "instant" অনুভূতি

## ৩) Mobile paste button fix

- **মূল কারণ:** Clipboard API শুধু HTTPS (secure context)-এ কাজ করে — সাইট HTTP-তে
  চলে বলে মোবাইল ব্রাউজার `navigator.clipboard` দেয়ই না → button কার্যত নিষ্ক্রিয়
- **ফিক্স:** fail হলে input focus + select → OS-এর long-press Paste মেনু খোলে + toast:
  "Hold the box and tap Paste — the browser blocked auto-paste" (Ctrl+V বার্তা মোবাইলে
  অর্থহীন ছিল)

## ৪) Header-এ Telegram bot button

- TuneLoad logo-র সারিতে (right side) **TG Bot** button — click → `t.me/fahadahamed_bot`
- Bot username hardcode না করে `/api/status` থেকে আসে (bot বদলালে একাই বদলাবে);
  bot না থাকলে button লুকায়
- মোবাইলে icon-only (375px-এ যাচাই: button দেখা যাচ্ছে ✓, horizontal scroll নেই ✓)

# v0.3.6 — running/max ব্যাখ্যা + pool live-sync + Native click fix + আরও দ্রুত Reading

## ১) "3 running / max 4" — পার্থক্য + আসল বাগ ধরা

- **running** = এই মুহূর্তে যতগুলো ডাউনলোড সত্যিই চলছে; **max** = একসাথে সর্বোচ্চ
  যতটা চলতে পারবে (সীমা)। 3 running দেখানোর মানে সীমা ৩ না — ওই সময় ঠিক ৩টা কাজই
  ছিল। ৬টা ট্র্যাক দিলে ৪টা চলবে, বাকি ২টা waiting-এ বসবে
- **প্রমাণ (সার্ভারে লাইভ টেস্ট):** ৬টা ট্র্যাক একসাথে ইঞ্জিনে দেওয়া হলো →
  **max running = 4** পর্যবেক্ষিত ✓ (আগের ৩-সীমা আর নেই) → admin panel-এর
  change সত্যিই কাজ করছে
- **আসল বাগ যেটা "৪ দিলেও ৩টাই চলত":** ওয়েবসাইটের ব্রাউজার-পাশের pool শুধু
  page-load-এ /api/status থেকে সীমা নিত — panel বদলালেও খোলা পেজ পুরনো মান (3)
  মনে রাখত। ফিক্স: পেজ এখন **প্রতি ২০ সেকেন্ডে** তাজা মান নেয় — reload ছাড়াই
  panel-এর change ব্রাউজারে পৌঁছায়
- systemd-এর env-ও 3→4 sync করা হয়েছে (settings.json-এর 4 এখন env-এর সাথে মিলে)

## ২) Get tracks "Reading" — আরও দ্রুত

- মেপে দেখা গেছে সার্ভার 0.05–0.09s-এ উত্তর দেয় — দেরিটা ছিল client-পাশের
  **700ms debounce** + নেটওয়ার্ক RTT। Debounce এখন **300ms**
- আরও বড় বদল: link বক্সে পড়ামাত্রই (complete link হলেই) **preview card 0ms-এ
  দেখা যায়** — thumbnail CDN থেকে তৎক্ষণাৎ, কোনো API/debounce অপেক্ষা নেই
  (browser যাচাই: 150ms-এ card দৃশ্যমান ✓, এরপর আসল card এসে বদলায় ✓)

## ৩) Native (browser UI) download ফিক্স

- **মূল কারণ:** আগের code আগে ৩০–৩০০ সেকেন্ড ইঞ্জিন-অপেক্ষা করত, তারপর
  programmatic click — ততক্ষণে browser-এর user-gesture মেয়াদ ফুরিয়ে যায় এবং
  Android Chrome ডাউনলোডটা নিঃশব্দে বাদ দেয় ("Native এ download করতে সমস্যা হয়")
- **ফিক্স:** click এখন button-চাপার সাথে সাথেই (gesture-এর ভেতরে) হয় → download
  manager তৎক্ষণাৎ entry দেখায়, ইঞ্জিন প্রস্তুত হলে একই request থেকে stream হয়
  (raw VPS — proxy-নেই, তাই দীর্ঘ অপেক্ষাও কাটে না)। `download` attribute +
  Content-Disposition দুটোই আছে — iOS Safari-তেও ফাইল নামবে

# v0.3.7 — playlist 125→100 bug + নিরাপদ deploy + zip/native টেস্ট + full audit

## ১) Playlist ১২৫টা ছিল, TG-তে ১০০ দেখালো কেন

- **মূল কারণ (code বাগ):** playlist-এর ভেতরের page-2 continuation token পড়া হতো
  YouTube-এর **পুরনো format** (`continuations[].nextContinuationData`) থেকে — আধুনিক
  response-এ token থাকে **শেষ item-এর `continuationItemRenderer`**-এর ভেতরে। তাই
  innertube পথ চললে ঠিক প্রথম পেজ (~১০০টা) থেমে যেত, আর ১০০টা "thin" ধরা হতো না বলে
  yt-dlp rescue-ও চলত না
- **ফিক্স:** দুই format-ই পড়া হয় + **~100-band guard** — যদি list ঠিক ৯৫–১০৫টার
  মধ্যে থামে, সাইলেন্টলি yt-dlp দিয়ে যাচাই করে বড়টা রাখে (ভবিষ্যতে format বদলালেও
  আটকে যাবে না)
- **Website-ও একই endpoint ব্যবহার করে** — মানে ওখানেও একই বাগ ছিল, এখন দুই জায়গাতেই
  ঠিক। ফিক্সের পরে একই playlist দিয়ে fresh analysis: **trackCount: 125 ✓**
- Bot-এর picker আগে থেকেই paged (১০/পেজ + All N) — সেখানে কোনো cap ছিল না

## ২) Bot "হঠাৎ বন্ধ" — কারণ ও সমাধান

- কারণ: 19:33-এ আমার deploy-এ build-log-এর permission error-এ ~২ মিনিট crash-loop
  (`.next` মুছে ফেলা হয়েছিল) — bot ওই সময় বন্ধ ছিল। **দুঃখিত**
- ভালো দিক: আপনার ৮০-ট্র্যাকের queue **state থেকে resume হয়ে সব সেন্ড হয়ে গেছে**
  (log: queue 80→0), কিছু হারায়নি
- **স্থায়ী সমাধান:** deploy পদ্ধতি বদলেছে — এখন **আগে build (চলমান সার্ভার চলতে থাকে),
  তারপর মাত্র ~৫ সেকেন্ডের restart**; এবার তাই করা হয়েছে (bot প্রায় বাঁধা খায়নি)

## ৩) Website ZIP test — Blob ও Native দুই মোডেই (আসল ফাইল দিয়ে)

- Blob mode zip: HTTP 200 · 6.57 MB · ৩টা mp3 entry · integrity OK ✓
- Native mode zip: HTTP 200 · 7.08 MB · ৩টা entry · integrity OK ✓
  (delivery setting zip-flow বদলায় না — দুই মোডেই একই zip endpoint, দুটোই যাচাই)
- Native single track: HTTP 200 · audio/mpeg · ID3 magic OK ✓ (আপনার সেট করা
  native mode অপরিবর্তিত রাখা হয়েছে)

## ৪) Full audit (সব সবুজ)

| আইটেম | অবস্থা |
|---|---|
| Service (tuneload) | active ✓ |
| Telegram bot | running, getUpdates live, 0 conflict, 0 error ✓ |
| Engine yt-dlp / ffmpeg | OK / OK ✓ |
| Cookie sets | 2 (auto-switch on) ✓ |
| Engine concurrency | max 4, live ✓ |
| Queue | খালি, idle ✓ |
| Disk | 477 GB খালি ✓ |
| RAM | 550 MB available ✓ |
| Audio cache | 589 MB (sweeper-own করা, স্বয়ংক্রিয় পরিষ্কার) ✓ |
| /api/status tg link | fahadahamed_bot ✓ |
