/**
 * Auto-clean: downloads never pile up on the server.
 *
 *  - every served file is scheduled for deletion ~60s after the response
 *    finishes (short grace so a browser retry can still hit the cache)
 *  - a background sweeper deletes anything older than 30 min as a safety net
 *    (covers aborted streams, TG bot crashes, orphaned temp files)
 */

import fs from "fs";
import path from "path";

const PROJECT_ROOT = process.cwd();
const AUDIO_DIR = path.join(PROJECT_ROOT, "data", "audio");
const TMP_DIR = path.join(PROJECT_ROOT, ".tmp-downloads");
const SWEEP_INTERVAL_MS = 10 * 60_000; // every 10 min
const MAX_AGE_MS = 30 * 60_000; // anything older than 30 min goes

const g = globalThis as unknown as { __tuneloadSweeper?: boolean };

export function startSweeper() {
  if (g.__tuneloadSweeper) return;
  g.__tuneloadSweeper = true;
  const t = setInterval(() => sweepNow(), SWEEP_INTERVAL_MS);
  t.unref?.();
  sweepNow();
}

export function sweepNow() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const dir of [AUDIO_DIR, TMP_DIR]) {
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
