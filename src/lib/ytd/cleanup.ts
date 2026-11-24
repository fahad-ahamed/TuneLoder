/**
 * Auto-clean: downloads never pile up on the server.
 *
 *  - served temp copies (.tmp-downloads) are deleted ~60s after the response
 *    finishes (short grace so a browser retry can still hit the cache)
 *  - the engine MP3 cache (data/audio) survives longer — default 180 min
 *    (AUDIO_CACHE_TTL_MIN env to change) — so repeat downloads stay instant
 *  - a background sweeper deletes anything past its age as a safety net
 *    (covers aborted streams, TG bot crashes, orphaned temp files)
 */

import fs from "fs";
import path from "path";

// keep in sync with providers.ts — TL_APP_DIR beats cwd (see note there)
const PROJECT_ROOT = process.env.TL_APP_DIR || process.cwd();
const AUDIO_DIR = path.join(PROJECT_ROOT, "data", "audio");
const TMP_DIR = path.join(PROJECT_ROOT, ".tmp-downloads");
const SWEEP_INTERVAL_MS = 10 * 60_000; // every 10 min
const TMP_MAX_AGE_MS = 30 * 60_000; // temp copies: 30 min and gone
const AUDIO_CACHE_TTL_MS =
  Math.max(1, Number(process.env.AUDIO_CACHE_TTL_MIN) || 180) * 60_000; // cache: 3 h default (AUDIO_CACHE_TTL_MIN env to change)

const g = globalThis as unknown as { __tuneloadSweeper?: boolean };

export function startSweeper() {
  if (g.__tuneloadSweeper) return;
  g.__tuneloadSweeper = true;
  const t = setInterval(() => sweepNow(), SWEEP_INTERVAL_MS);
  t.unref?.();
  sweepNow();
}

export function sweepNow() {
  const tmpCutoff = Date.now() - TMP_MAX_AGE_MS;
  const audioCutoff = Date.now() - AUDIO_CACHE_TTL_MS;
  const dirs: Array<[string, number]> = [
    [AUDIO_DIR, audioCutoff],
    [TMP_DIR, tmpCutoff],
  ];
  for (const [dir, cutoff] of dirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs < cutoff) fs.rmSync(p, { force: true });
      } catch { /* noop */ }
    }
  }
}

/** schedule a single file for deletion (grace period default 60s) */
export function scheduleRemoval(file: string, delayMs = 60_000) {
  try {
    const t = setTimeout(() => {
      try { fs.rmSync(file, { force: true }); } catch { /* noop */ }
    }, delayMs);
    t.unref?.();
  } catch { /* noop */ }
}
