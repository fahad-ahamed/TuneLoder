/**
 * Live engine settings — persisted to data/config.json, editable from the
 * admin dashboard AT ANY TIME; every engine run reads them fresh (no restart).
 *
 *  maxConcurrency    parallel yt-dlp runs (0 = auto: env or cookie-aware default)
 *  runGapMs          breathing room between engine runs (anti rate-limit pacing)
 *  autoPrefetchPlaylist  server pre-prepares playlist tracks right after analysis
 *                        so clicks land on the cache (opt-in — costs bandwidth)
 *  delivery          single-video delivery to the browser:
 *                      "blob"   — fetch + save (classic, stays on the page)
 *                      "native" — browser's own download manager UI
 *  playlistDelivery  how a PLAYLIST is delivered (Chrome's multiple-download
 *                    prompt silently drops every automatic download after the
 *                    first — measured on Chrome 158):
 *                      "zip"      — one click = one zip (default, works everywhere)
 *                      "separate" — separate MP3s with an explicit warning
 */

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const CONFIG_FILE = path.join(ROOT, "data", "config.json");

export type AuthSettings = {
  manualCookies: boolean; // manually exported cookies.txt sets (/admin → Cookie sets)
  signIn: boolean; // direct sign-in sessions (/admin → YouTube সাইন-ইন)
};

export type EngineSettings = {
  maxConcurrency: number; // 0 = auto
  runGapMs: number;
  autoPrefetchPlaylist: boolean;
  delivery: "blob" | "native";
  playlistDelivery: "zip" | "separate";
  auth: AuthSettings;
};

const DEFAULTS: EngineSettings = {
  maxConcurrency: 0,
  runGapMs: 900,
  autoPrefetchPlaylist: false,
  delivery: "blob",
  playlistDelivery: "zip",
  auth: { manualCookies: true, signIn: true },
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

function readStore(): { settings?: Partial<EngineSettings> } {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function getSettings(): EngineSettings {
  const s = readStore().settings ?? {};
  const a = (s.auth ?? {}) as Partial<AuthSettings>;
  return {
    maxConcurrency: clampInt(s.maxConcurrency, 0, 8, DEFAULTS.maxConcurrency),
    runGapMs: clampInt(s.runGapMs, 200, 10_000, DEFAULTS.runGapMs),
    autoPrefetchPlaylist: s.autoPrefetchPlaylist === true,
    delivery: s.delivery === "native" ? "native" : "blob",
    playlistDelivery: s.playlistDelivery === "separate" ? "separate" : "zip",
    auth: {
      manualCookies: a.manualCookies !== false,
      signIn: a.signIn !== false,
    },
  };
}

export function saveSettings(patch: Partial<EngineSettings>): EngineSettings {
  const next = { ...getSettings(), ...patch };
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  const store = readStore();
  store.settings = next;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
  return next;
}

/** Resolve the real concurrency cap: config override > env > cookie-aware auto. */
export function effectiveMaxConcurrency(cookieAwareAuto: number): number {
  const s = getSettings();
  if (s.maxConcurrency >= 1) return Math.min(8, s.maxConcurrency);
  return Math.max(1, Math.min(8, cookieAwareAuto));
}
