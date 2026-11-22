/**
 * Download engine — "ytdown.to"-style: server-side yt-dlp with tuned speed flags,
 * PO-token provider, MULTI cookie sets with auto-switch, on-disk MP3 cache and a
 * mirror fallback. First healthy provider wins.
 *
 * v3 playlist-survival fixes ("2 downloads then everything fails" root causes):
 *   - VIDEO problems (private/members-only/age-gated/removed) no longer cool
 *     cookie sets down — only real engine rejections do (was: whole playlist
 *     died because two tracks poisoned both sets for 3 minutes).
 *   - Rejections rest the set 45s→90s→180s (growing) instead of a flat 3 min.
 *   - ALL sets cooling → the track WAITS out the nearest cooldown (≤90s)
 *     instead of instant-failing.
 *   - 3 retry rounds with growing backoff + a server-wide circuit breaker
 *     (4 consecutive failed tracks → one shared 25s pause, then resume).
 *   - Sticky-set is only cleared when the sticky set itself failed.
 *   - Live settings from the dashboard (concurrency, pacing) apply instantly.
 *
 * v2 reliability fixes (playlist "2 downloads then fail" root causes):
 *   - GLOBAL ENGINE GATE: yt-dlp runs are serialized (default 1 at a time when
 *     cookies are armed) so YouTube never sees parallel hammering from the same
 *     IP/cookie account — the #1 cause of mid-playlist failures.
 *   - Small breathing gap between consecutive engine runs.
 *   - Failure classification: auth-rejections cool a cookie set down 3 min,
 *     rate-limit errors only 90 s, transient errors (timeouts) don't poison it.
 *   - Whole-chain retry with backoff before giving up.
 *   - CANCEL support: /api/cancel kills the running yt-dlp for a video.
 *
 * Provider chain (each attempt):
 *   0. on-disk cache                     → instant (repeat downloads)
 *   1. yt-dlp + last-good cookie set      → sticky: the set that worked last time
 *   2. yt-dlp + other cookie sets         → AUTO-SWITCH when a set is rejected
 *   3. yt-dlp direct                      → fastest when the network is clean
 *   4. cobalt mirrors                     → best-effort last resort
 */

import { execFile, spawn } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import { updateJob, parseDownloadLine, jobKey } from "./jobs";
import { getSettings, effectiveMaxConcurrency } from "./settings";

export const PROJECT_ROOT = process.cwd();
export const COOKIE_DIR = path.join(PROJECT_ROOT, "data", "cookies");
const COOKIE_STATE_FILE = path.join(COOKIE_DIR, "state.json");
const COOKIE_META_FILE = path.join(COOKIE_DIR, "sets.json");

const AUDIO_CACHE_DIR = path.join(PROJECT_ROOT, "data", "audio");
const CACHE_CAP_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

const POT_PLUGIN_DIR = path.join(PROJECT_ROOT, "bgutil-ytdlp-pot-provider", "plugin");
const POT_SERVER_DIR = path.join(PROJECT_ROOT, "bgutil-ytdlp-pot-provider", "server");
const POT_SERVER_PORT = Number(process.env.POT_SERVER_PORT ?? 4416);

const YTDLP_BIN = process.env.YTDLP_BIN || "/home/z/.venv/bin/yt-dlp";
const FFMPEG_BIN = process.env.FFMPEG_BIN || "/usr/bin/ffmpeg";
/** JS challenge runtime for yt-dlp (needs node ≥22; containers may bundle one → "node:/path/to/dir") */
const JS_RUNTIME = process.env.YTDLP_JS_RUNTIME || "node";

export { POT_PLUGIN_DIR, JS_RUNTIME };

export function engineBinaries() {
  return { ytdlp: YTDLP_BIN, ffmpeg: FFMPEG_BIN };
}

/**
 * How many yt-dlp children may run at once. Default is deliberately conservative:
 * with cookies armed YouTube rate-limits parallel requests from the same account,
 * which is exactly what killed playlists mid-download. Hosts override via env,
 * admins override live from the dashboard (data/config.json → settings.ts).
 */
export function maxConcurrency(): number {
  const n = Number(process.env.MAX_CONCURRENCY ?? (listCookieSets().length > 0 ? 1 : 2));
  const auto = Number.isFinite(n) && n >= 1 && n <= 8 ? Math.floor(n) : 1;
  return effectiveMaxConcurrency(auto);
}

export function engineQueueInfo(): { running: number; waiting: number; max: number } {
  const g = gate();
  return { running: g.running, waiting: g.queue.length, max: g.max };
}

/* ------------------------------------------------------------------ */
/* cookie sets (multi, auto-switch)                                     */
/* ------------------------------------------------------------------ */

let migrated = false;
function migrateLegacyCookieFile() {
  // old single-file layout: data/cookies.txt → data/cookies/cookies-1.txt
  if (migrated) return;
  migrated = true;
  try {
    const legacy = path.join(PROJECT_ROOT, "data", "cookies.txt");
    if (fs.existsSync(legacy)) {
      fs.mkdirSync(COOKIE_DIR, { recursive: true });
      const existing = listCookieSets();
      const next = existing.length ? Math.max(...existing) + 1 : 1;
      fs.renameSync(legacy, cookieSetPath(next));
    }
  } catch { /* noop */ }
}

export function listCookieSets(): number[] {
  migrateLegacyCookieFile();
  try {
    return fs
      .readdirSync(COOKIE_DIR)
      .map((f) => f.match(/^cookies-(\d+)\.txt$/)?.[1])
      .filter((x): x is string => !!x)
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export function cookieSetPath(id: number): string {
  return path.join(COOKIE_DIR, `cookies-${id}.txt`);
}

export function cookieSetsInfo() {
  return listCookieSets().map((id) => {
    try {
      const p = cookieSetPath(id);
      const st = fs.statSync(p);
      const lines = fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).length;
      return { id, lines, bytes: st.size, updated: st.mtime.toISOString() };
    } catch {
      return { id, lines: 0, bytes: 0, updated: "" };
    }
  });
}

let lastGoodSet: number | null = null;
try {
  lastGoodSet = JSON.parse(fs.readFileSync(COOKIE_STATE_FILE, "utf8")).lastGoodSet ?? null;
} catch { /* noop */ }

function saveLastGoodSet(id: number | null) {
  lastGoodSet = id;
  try {
    fs.mkdirSync(COOKIE_DIR, { recursive: true });
    fs.writeFileSync(COOKIE_STATE_FILE, JSON.stringify({ lastGoodSet: id }));
  } catch { /* noop */ }
}

export function cookiesEnabled(): boolean {
  return orderedCookieSets().length > 0;
}

export function activeCookieSet(): number | null {
  return lastGoodSet;
}

/** Forget the sticky set when it was removed / disabled (sign-out, toggle off). */
export function saveLastGoodSetIfRemoved() {
  if (lastGoodSet == null) return;
  if (!orderedCookieSets().includes(lastGoodSet)) saveLastGoodSet(null);
}

/* per-set origin + label (direct sign-in vs manual cookies.txt) + REAL verdict */
export type CookieSetOrigin = "signin" | "manual";
export type CookieVerdict = { at: string; ok: boolean; kind: string; message: string };
type CookieSetMeta = { origin: CookieSetOrigin; label?: string; createdAt?: string; verify?: CookieVerdict };

/** engine ignores a YouTube-rejected set for this long after its verdict */
const AUTH_VERDICT_TTL_MS = 30 * 60 * 1000;

function readSetMeta(): Record<string, CookieSetMeta> {
  try {
    return JSON.parse(fs.readFileSync(COOKIE_META_FILE, "utf8")) ?? {};
  } catch {
    return {};
  }
}

export function writeCookieSetMeta(id: number, meta: Partial<CookieSetMeta> & { origin: CookieSetOrigin }) {
  try {
    fs.mkdirSync(COOKIE_DIR, { recursive: true });
    const all = readSetMeta();
    all[String(id)] = { ...(all[String(id)] ?? {}), ...meta };
    fs.writeFileSync(COOKIE_META_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  } catch { /* noop */ }
}

export function cookieSetOrigin(id: number): CookieSetOrigin {
  return readSetMeta()[String(id)]?.origin === "signin" ? "signin" : "manual";
}

export function cookieSetLabel(id: number): string | undefined {
  return readSetMeta()[String(id)]?.label;
}

export function clearCookieSetMeta(id: number) {
  try {
    const all = readSetMeta();
    delete all[String(id)];
    fs.writeFileSync(COOKIE_META_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  } catch { /* noop */ }
}

/** The last REAL YouTube verdict recorded for this set (probeCookieFile). */
export function cookieSetVerdict(id: number): CookieVerdict | undefined {
  return readSetMeta()[String(id)]?.verify;
}

/** Persist a real probe verdict for a set. */
export function saveCookieVerdict(id: number, v: CookieVerdict) {
  writeCookieSetMeta(id, { verify: v });
}

/**
 * Cookie sets the engine is allowed to use RIGHT NOW, in try-order:
 *   1. sticky last-good set (if its system is still enabled)
 *   2. direct sign-in sessions (freshest sessions first)
 *   3. manual cookies.txt sets
 * Both auth systems are admin toggles (settings.auth) — a disabled system's
 * sets are excluded even when they exist, so admins can A/B them freely.
 * With BOTH toggles off the engine falls back to the unauthenticated chain.
 */
export function orderedCookieSets(): number[] {
  const auth = getSettings().auth;
  if (!auth.manualCookies && !auth.signIn) return [];
  const eligible = listCookieSets().filter((id) => {
    if (cookieSetOrigin(id) === "signin" ? !auth.signIn : !auth.manualCookies) return false;
    // REAL rejection: a fresh probe verdict where YouTube itself refused the
    // session (auth) → the set is excluded from the engine chain until the TTL
    // passes or an admin re-verifies it. rate/video/transient never exile a set.
    const v = cookieSetVerdict(id);
    if (v && !v.ok && v.kind === "auth" && Date.now() - new Date(v.at).getTime() < AUTH_VERDICT_TTL_MS) {
      return false;
    }
    return true;
  });
  if (!eligible.length) return [];
  const sticky = lastGoodSet != null && eligible.includes(lastGoodSet) ? [lastGoodSet] : [];
  const sign = eligible.filter((id) => cookieSetOrigin(id) === "signin" && !sticky.includes(id));
  const manual = eligible.filter((id) => cookieSetOrigin(id) === "manual" && !sticky.includes(id));
  return [...sticky, ...sign, ...manual];
}

/* per-set cooldown with failure classification (v3 — playlist survival):
   - engine rejection ("sign in to confirm…") → set rests, growing with repeats
     (45s → 90s → 180s): brief pauses recover a playlist, 3-min kills didn't
   - rate-limit (429 / throttling)            → shorter rest (30s → 60s → 120s)
   - VIDEO problems (private / members-only / age-gated / removed) → the SET is
     healthy, the video is the problem → NO cooldown (this poisoned playlists!)
   - transient (timeout / network)            → no cooldown (retry freely)     */
type SetHealth = { fails: number; until: number };
const gHealth = globalThis as unknown as { __tlSetHealth?: Map<number, SetHealth> };
function healthMap(): Map<number, SetHealth> {
  return gHealth.__tlSetHealth ?? (gHealth.__tlSetHealth = new Map<number, SetHealth>());
}

const isAuthFailure = (msg: string) =>
  /sign in|not a bot|confirm|use ?\(?-?\)?cookies?|\b403\b/i.test(msg);
const isRateLimit = (msg: string) => /429|too many requests|rate.?limit|throttl/i.test(msg);
/** the video itself can't be downloaded by ANY account — never blame the cookie set */
const isVideoProblem = (msg: string) =>
  /private video|members?.?only|age.?restrict|video (is )?unavailable|content isn.?t available|removed by|premiere|does not exist|no longer available|copyright/i.test(msg);

function noteSetResult(id: number, ok: boolean, errMsg?: string) {
  const m = healthMap();
  const h = m.get(id) ?? { fails: 0, until: 0 };
  if (ok) {
    h.fails = 0;
    h.until = 0;
    m.set(id, h);
    return;
  }
  if (errMsg && isVideoProblem(errMsg)) return; // cookie set stays healthy
  h.fails += 1;
  if (errMsg && isAuthFailure(errMsg)) {
    h.until = Date.now() + Math.min(180_000, 45_000 * 2 ** (h.fails - 1));
  } else if (errMsg && isRateLimit(errMsg)) {
    h.until = Date.now() + Math.min(120_000, 30_000 * 2 ** (h.fails - 1));
  } // transient: no cooldown — the retry handles it
  m.set(id, h);
}
function setCooling(id: number): boolean {
  const h = healthMap().get(id);
  return !!h && h.until > Date.now();
}

/* server-wide circuit breaker: several consecutive failed TRACKS mean the
   IP/account is being throttled as a whole — pause briefly instead of letting
   every remaining playlist track slam the same wall at full speed. */
const gBreaker = globalThis as unknown as { __tlBreaker?: { streak: number; pausedUntil: number } };
function breaker(): { streak: number; pausedUntil: number } {
  return gBreaker.__tlBreaker ?? (gBreaker.__tlBreaker = { streak: 0, pausedUntil: 0 });
}

/* ------------------------------------------------------------------ */
/* URL parsing                                                        */
/* ------------------------------------------------------------------ */

export function parseYouTubeUrl(raw: string): { videoId: string | null; playlistId: string | null } {
  const s = raw.trim().replace(/^["'<]+|["'>]+$/g, "");
  if (!s) return { videoId: null, playlistId: null };

  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return { videoId: s, playlistId: null };

  let u: URL | null = null;
  try {
    u = new URL(s.startsWith("http://") || s.startsWith("https://") ? s : `https://${s}`);
  } catch {
    u = null;
  }
  if (!u) {
    const vid = s.match(/(?:v=|be\/|shorts\/|embed\/|live\/)([a-zA-Z0-9_-]{11})/);
    const list = s.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    return { videoId: vid?.[1] ?? null, playlistId: list?.[1] ?? null };
  }

  const host = u.hostname.replace(/^(www|m|music)\./, "");
  const parts = u.pathname.split("/").filter(Boolean);

  let videoId: string | null = null;
  let playlistId: string | null = u.searchParams.get("list");

  if (host === "youtu.be") {
    videoId = parts[0] ?? null;
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") videoId = u.searchParams.get("v");
    else if (["shorts", "embed", "live", "v"].includes(parts[0] ?? "")) videoId = parts[1] ?? null;
  }

  if (videoId && !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) videoId = null;
  if (playlistId && !/^[a-zA-Z0-9_-]{10,}$/.test(playlistId)) playlistId = null;
  return { videoId, playlistId };
}

/* ------------------------------------------------------------------ */
/* engine gate — serialize yt-dlp children (rate-limit friendliness)    */
/* ------------------------------------------------------------------ */

type Gate = { running: number; queue: Array<() => void>; max: number; lastRunEnd: number };
const gGate = globalThis as unknown as { __tlGate?: Gate };
function gate(): Gate {
  if (!gGate.__tlGate) {
    gGate.__tlGate = { running: 0, queue: [], max: maxConcurrency(), lastRunEnd: 0 };
  }
  const g = gGate.__tlGate;
  g.max = maxConcurrency(); // live: dashboard changes apply to the very next run
  return g;
}
const RUN_GAP_MS_DEFAULT = 700; // fallback breathing room (admin overrides live)

async function withGate<T>(fn: () => Promise<T>): Promise<T> {
  const g = gate();
  if (g.running >= g.max) {
    await new Promise<void>((resolve) => g.queue.push(resolve));
  }
  g.running++;
  try {
    const gap = Math.max(RUN_GAP_MS_DEFAULT, getSettings().runGapMs);
    const wait = g.lastRunEnd + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return await fn();
  } finally {
    g.running--;
    g.lastRunEnd = Date.now();
    const next = g.queue.shift();
    if (next) next();
  }
}

/* ------------------------------------------------------------------ */
/* PO-token server supervisor (bgutil-ytdlp-pot-provider)             */
/* ------------------------------------------------------------------ */

let potCheckedAt = 0;

async function isPortOpen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host, timeout: 700 });
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.once("error", () => resolve(false));
  });
}

async function ensurePotServer(): Promise<void> {
  // soft check at most once per 30 s
  if (Date.now() - potCheckedAt < 30_000) return;
  potCheckedAt = Date.now();
  if (await isPortOpen(POT_SERVER_PORT, "127.0.0.1")) return;
  if (!fs.existsSync(path.join(POT_SERVER_DIR, "build", "main.js"))) return;
  try {
    fs.mkdirSync(path.join(PROJECT_ROOT, "data"), { recursive: true });
    const log = fs.openSync(path.join(PROJECT_ROOT, "data", "pot-server.log"), "a");
    const child = spawn(process.execPath, ["build/main.js"], {
      cwd: POT_SERVER_DIR,
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    await new Promise((r) => setTimeout(r, 1500));
  } catch {
    /* best effort */
  }
}

/* ------------------------------------------------------------------ */
/* cancellation — kill the yt-dlp child for a key                      */
/* ------------------------------------------------------------------ */

import type { ChildProcess } from "child_process";
const gRunners = globalThis as unknown as { __tlRunners?: Map<string, ChildProcess> };
function runners(): Map<string, ChildProcess> {
  return gRunners.__tlRunners ?? (gRunners.__tlRunners = new Map<string, ChildProcess>());
}
const gCancelled = globalThis as unknown as { __tlCancelled?: Set<string> };
function cancelledSet(): Set<string> {
  return gCancelled.__tlCancelled ?? (gCancelled.__tlCancelled = new Set<string>());
}

export function cancelJob(videoId: string, bitrate: number): boolean {
  const key = jobKey(videoId, bitrate);
  cancelledSet().add(key);
  updateJob(key, { phase: "cancelled" });
  const child = runners().get(key);
  if (!child) return true; // nothing running → treat as cancelled
  try { child.kill("SIGKILL"); } catch { /* noop */ }
  return true;
}

function isCancelled(key: string): boolean {
  return cancelledSet().has(key);
}
function clearCancelled(key: string) {
  cancelledSet().delete(key);
}

/* ------------------------------------------------------------------ */
/* yt-dlp runner → final mp3 on disk                                   */
/* ------------------------------------------------------------------ */

function runYtDlp(
  videoId: string,
  bitrate: number,
  cookieFile: string | null,
  onLog: (line: string) => void,
  altClient = false,
  cookieAlt = false
): Promise<string> {
  const key = jobKey(videoId, bitrate);
  clearCancelled(key); // fresh attempt

  return new Promise<string>((resolve, reject) => {
    fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });

    const outTemplate = path.join(AUDIO_CACHE_DIR, `${videoId}-${bitrate}.%(ext)s`);
    const args = [
      ...(cookieFile ? ["--cookies", cookieFile] : []),
      "--js-runtimes", JS_RUNTIME, // solve YouTube n-challenges (formats disappear without it)
      // fetch the version-matched challenge-solver script when no local
      // yt-dlp-ejs distribution is installed — cached after the first run
      "--remote-components", "ejs:github",
      // alt player clients (android/ios) sit in a DIFFERENT throttle pool than
      // the web client — rescues downloads when YouTube locks web formats,
      // which is exactly what kills playlists mid-run on datacenter IPs
      ...(altClient ? ["--extractor-args", "youtube:player_client=android,ios"] : []),
      // cookie-carrying clients that YouTube does NOT force into SABR-only
      // streaming (yt-dlp #12482) — used when the web client returns empty
      // formats for a logged-in session
      ...(cookieAlt ? ["--extractor-args", "youtube:player_client=web_creator,tv_embedded,mweb"] : []),
      "--force-ipv4",
      "--no-warnings",
      "--no-playlist",
      "--newline",
      "--socket-timeout", "20",
      "--retries", "3",
      "--fragment-retries", "5",
      "--extractor-retries", "2",
      "-N", "8",
      "-f", "bestaudio[ext=m4a]/bestaudio/best",
      "-x", "--audio-format", "mp3", "--audio-quality", `${bitrate}K`,
      "--embed-thumbnail",
      "--convert-thumbnails", "jpg",
      "--add-metadata",
      "--ffmpeg-location", FFMPEG_BIN,
      "-o", outTemplate,
      `https://www.youtube.com/watch?v=${videoId}`,
    ];

    const env = {
      ...process.env,
      PYTHONPATH: `${POT_PLUGIN_DIR}${path.delimiter}${process.env.PYTHONPATH ?? ""}`,
    };

    const child = spawn(YTDLP_BIN, args, { env });
    runners().set(key, child);
    let stderrTail: string[] = [];
    let timer: ReturnType<typeof setTimeout>;

    const finish = (fn: () => void) => {
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* noop */ }
      fn();
    };

    timer = setTimeout(() => {
      finish(() => reject(new Error("yt-dlp timed out after 240s")));
    }, 240_000);

    child.stdout?.on("data", (d: Buffer) => {
      const lines = d.toString().split("\n").filter((l) => l.includes("[download]"));
      if (lines.length) onLog(lines[lines.length - 1].trim());
    });
    child.stderr?.on("data", (d: Buffer) => {
      for (const l of d.toString().split("\n")) {
        if (l.trim()) { stderrTail.push(l.trim()); if (stderrTail.length > 6) stderrTail.shift(); }
      }
    });
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (runners().get(key) === child) runners().delete(key);
      if (isCancelled(key)) {
        clearCancelled(key);
        cleanStrays(videoId, bitrate);
        return reject(new Error("Cancelled"));
      }
      const mp3 = path.join(AUDIO_CACHE_DIR, `${videoId}-${bitrate}.mp3`);
      if (code === 0 && fs.existsSync(mp3)) {
        resolve(mp3);
      } else {
        cleanStrays(videoId, bitrate);
        reject(new Error(stderrTail.join(" | ").slice(0, 400) || `yt-dlp exited with code ${code}`));
      }
    });
  });
}

/** remove partial/temp leftovers from a failed or cancelled run (thumbs, .part, source audio) */
function cleanStrays(videoId: string, bitrate: number) {
  const prefix = `${videoId}-${bitrate}.`;
  try {
    for (const f of fs.readdirSync(AUDIO_CACHE_DIR)) {
      if (f.startsWith(prefix) && !f.endsWith(".mp3")) {
        try { fs.rmSync(path.join(AUDIO_CACHE_DIR, f), { force: true }); } catch { /* noop */ }
      }
    }
  } catch { /* noop */ }
}

/* ------------------------------------------------------------------ */
/* cache maintenance                                                    */
/* ------------------------------------------------------------------ */

function evictCacheIfNeeded() {
  try {
    const files = fs
      .readdirSync(AUDIO_CACHE_DIR)
      .filter((f) => f.endsWith(".mp3"))
      .map((f) => {
        const p = path.join(AUDIO_CACHE_DIR, f);
        return { p, st: fs.statSync(p) };
      })
      .sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);

    let total = files.reduce((n, f) => n + f.st.size, 0);
    for (const f of files) {
      if (total <= CACHE_CAP_BYTES) break;
      try { fs.rmSync(f.p, { force: true }); total -= f.st.size; } catch { /* noop */ }
    }
  } catch { /* noop */ }
}

/* ------------------------------------------------------------------ */
/* cobalt mirrors (last resort)                                         */
/* ------------------------------------------------------------------ */

const COBALT_MIRRORS = [
  "https://cobalt-api.kwiatekmiki.com",
  "https://cobalt.canine.tools",
  "https://api.cobalt.best",
];

async function tryCobalt(
  videoId: string,
  bitrate: number,
  logs: string[]
): Promise<ResolvedAudio | null> {
  for (const base of COBALT_MIRRORS) {
    try {
      const res = await fetch(`${base}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          url: `https://www.youtube.com/watch?v=${videoId}`,
          downloadMode: "audio",
          audioFormat: "mp3",
          audioBitrate: String(bitrate <= 128 ? 128 : bitrate >= 256 ? 320 : 192),
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (res.status === 401) continue; // api-key gated
      const j = (await res.json()) as { status?: string; url?: string };
      if (j.status === "redirect" || j.status === "tunnel" || j.url) {
        logs.push(`cobalt ${new URL(base).host}: ok`);
        return { provider: "cobalt", streamUrl: j.url!, container: "mp3", logs };
      }
      logs.push(`cobalt ${new URL(base).host}: ${j.status ?? "?"}`);
    } catch (e) {
      logs.push(`cobalt ${new URL(base).host}: ${(e as Error).name}`);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* ffmpeg conversion (remote stream → mp3)                              */
/* ------------------------------------------------------------------ */

const execFileAsync = (bin: string, args: string[], opts: { timeout: number }) =>
  new Promise<void>((resolve, reject) =>
    execFile(bin, args, opts, (err) => (err ? reject(err) : resolve())));

export async function convertToMp3(
  src: { kind: "url"; url: string } | { kind: "file"; path: string },
  meta: { bitrate: number; title: string; author: string }
): Promise<string> {
  fs.mkdirSync(path.join(PROJECT_ROOT, ".tmp-downloads"), { recursive: true });
  const out = path.join(
    PROJECT_ROOT, ".tmp-downloads", `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`
  );
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    ...(src.kind === "url"
      ? ["-user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"]
      : []),
    "-i", src.kind === "url" ? src.url : src.path,
    "-vn",
    "-c:a", "libmp3lame",
    "-b:a", `${meta.bitrate}k`,
    "-threads", "0",
    "-metadata", `title=${meta.title}`,
    "-metadata", `artist=${meta.author}`,
    "-write_id3v2", "1",
    out,
  ];
  await execFileAsync(FFMPEG_BIN, args, { timeout: 240_000 });
  return out;
}

export function cleanupTemp(file: string) {
  try { fs.rmSync(file, { force: true }); } catch { /* noop */ }
}

/* ------------------------------------------------------------------ */
/* resolver                                                            */
/* ------------------------------------------------------------------ */

export type ResolvedAudio = {
  provider: string; // "ytdlp" | "ytdlp+ckN" | "cobalt" | "none"
  localFile?: string;
  streamUrl?: string;
  container?: string;
  cached?: boolean;
  cancelled?: boolean;
  logs: string[];
};

/* in-flight dedup: a prefetch and a real download share ONE job */
const gInFlight = globalThis as unknown as { __tlInFlight?: Map<string, Promise<ResolvedAudio>> };
function inFlightMap(): Map<string, Promise<ResolvedAudio>> {
  return gInFlight.__tlInFlight ?? (gInFlight.__tlInFlight = new Map<string, Promise<ResolvedAudio>>());
}

export function prefetchStatus(videoId: string, bitrate: number): "cached" | "running" | "idle" {
  if (fs.existsSync(path.join(AUDIO_CACHE_DIR, `${videoId}-${bitrate}.mp3`))) return "cached";
  if (inFlightMap().has(`${videoId}:${bitrate}`)) return "running";
  return "idle";
}

async function resolveAudioInner(videoId: string, bitrate: number): Promise<ResolvedAudio> {
  const logs: string[] = [];
  const key = jobKey(videoId, bitrate);
  // a fresh resolve is a fresh user intent: drop any stale cancel flag from a
  // previous run, otherwise a cancelled track could NEVER be downloaded again
  // (the flag was only cleared inside runYtDlp, which a cancelled loop skips)
  clearCancelled(key);
  updateJob(key, { phase: "starting" });

  const progress = (line: string) => {
    logs.push(line.slice(0, 26));
    const p = parseDownloadLine(line);
    if (p) updateJob(key, { phase: p.pct >= 99.5 ? "encoding" : "downloading", ...p });
  };

  // 0) instant cache hit
  const cachedFile = path.join(AUDIO_CACHE_DIR, `${videoId}-${bitrate}.mp3`);
  if (fs.existsSync(cachedFile)) {
    logs.push("cache: hit");
    updateJob(key, { phase: "done", pct: 100 });
    return { provider: "ytdlp", localFile: cachedFile, cached: true, logs };
  }

  await ensurePotServer();

  // server-wide circuit breaker: a streak of failed tracks means YouTube is
  // throttling this IP/account — one shared pause, then resume (this is what
  // kept playlists alive: never hammer a wall that just rejected you).
  const br = breaker();
  if (br.streak >= 4 && Date.now() > br.pausedUntil) {
    logs.push(`breaker: ${br.streak} consecutive failures — pausing 25s`);
    br.pausedUntil = Date.now() + 25_000;
    await new Promise((r) => setTimeout(r, 25_000));
    br.streak = 2; // repeated badness keeps some pressure on
  }

  // whole chain (cookie sets → direct → mirrors) with THREE retry rounds and
  // growing backoff: transient throttles and short cooldowns clear in seconds.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      logs.push(`retry: round ${attempt + 1}`);
      await new Promise((r) => setTimeout(r, attempt === 1 ? 6_000 : 15_000));
    }
    if (isCancelled(key)) break;

    // every cookie set cooling → WAIT OUT the nearest cooldown instead of
    // dropping the track (waiting 30-90s beats failing the rest of a playlist)
    const allSets = listCookieSets();
    const coolingNow = allSets.filter((id) => setCooling(id));
    if (allSets.length > 0 && coolingNow.length === allSets.length) {
      const waitMs = Math.min(
        90_000,
        Math.max(...coolingNow.map((id) => (healthMap().get(id)?.until ?? Date.now()) - Date.now())) + 1_000
      );
      if (waitMs > 0) {
        logs.push(`cookies: all sets cooling — waiting ${Math.round(waitMs / 1000)}s`);
        await new Promise((r) => setTimeout(r, waitMs));
        if (isCancelled(key)) break;
      }
    }

    const orderedSets = orderedCookieSets().filter((id) => !setCooling(id));

    // 1) yt-dlp with cookie sets — sticky first, AUTO-SWITCH immediately on failure
    for (const id of orderedSets) {
      if (isCancelled(key)) break;
      try {
        const f = await withGate(() =>
          runYtDlp(videoId, bitrate, cookieSetPath(id), progress)
        );
        evictCacheIfNeeded();
        noteSetResult(id, true);
        saveLastGoodSet(id);
        logs.push(`ytdlp-ck${id}: ok`);
        updateJob(key, { phase: "done", pct: 100 });
        return { provider: `ytdlp+ck${id}`, localFile: f, logs };
      } catch (e) {
        const msg = (e as Error).message;
        if (/^Cancelled$/.test(msg)) {
          return { provider: "none", cancelled: true, logs };
        }
        // web client returned empty formats for this session? the cookie can
        // still be LIVE — SABR-safe cookie-capable clients are the second rung
        try {
          const f = await withGate(() =>
            runYtDlp(videoId, bitrate, cookieSetPath(id), progress, false, true)
          );
          evictCacheIfNeeded();
          noteSetResult(id, true);
          saveLastGoodSet(id);
          logs.push(`ytdlp-ck${id}+cookiealt: ok`);
          updateJob(key, { phase: "done", pct: 100 });
          return { provider: `ytdlp+ck${id}+ca`, localFile: f, logs };
        } catch (e2) {
          const msg2 = (e2 as Error).message;
          if (/^Cancelled$/.test(msg2)) {
            return { provider: "none", cancelled: true, logs };
          }
          noteSetResult(id, false, msg2);
          if (id === lastGoodSet) saveLastGoodSet(null); // only un-stick the set that failed
          logs.push(`ytdlp-ck${id}: ${msg2.slice(0, 160)}`);
        }
      }
    }

    // 2) yt-dlp direct (no cookies) — retry rounds also try android/ios player
    //    clients, whose format pool YouTube throttles separately from the web
    if (!isCancelled(key)) {
      try {
        const f = await withGate(() => runYtDlp(videoId, bitrate, null, progress, attempt >= 1));
        evictCacheIfNeeded();
        logs.push(attempt >= 1 ? "ytdlp-direct+alt: ok" : "ytdlp-direct: ok");
        updateJob(key, { phase: "done", pct: 100 });
        return { provider: attempt >= 1 ? "ytdlp-alt" : "ytdlp", localFile: f, logs };
      } catch (e) {
        const msg = (e as Error).message;
        if (/^Cancelled$/.test(msg)) {
          return { provider: "none", cancelled: true, logs };
        }
        logs.push(`ytdlp-direct: ${msg.slice(0, 160)}`);
      }
    }

    // 3) cobalt mirrors
    const cob = await tryCobalt(videoId, bitrate, logs);
    if (cob) {
      updateJob(key, { phase: "done", pct: 100 });
      return cob;
    }
  }

  updateJob(key, { phase: "error" });
  return { provider: "none", logs };
}

export function resolveAudio(videoId: string, bitrate: number): Promise<ResolvedAudio> {
  const key = jobKey(videoId, bitrate);
  const m = inFlightMap();
  const existing = m.get(key);
  if (existing) return existing;
  const p = resolveAudioInner(videoId, bitrate)
    .then((res) => {
      // circuit-breaker accounting: success heals, failure builds pressure
      if (res.cancelled) return res; // user actions don't count
      if (res.provider !== "none") breaker().streak = 0;
      else {
        const br = breaker();
        br.streak += 1;
        br.pausedUntil = 0; // allow the next track to open a pause window
      }
      return res;
    })
    .finally(() => m.delete(key));
  m.set(key, p);
  return p;
}
