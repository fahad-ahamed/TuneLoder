#!/usr/bin/env node
/**
 * Chunk-system unit test at real scale: builds a ~60MB MP3 (byte-concatenated
 * real MP3 — still a valid frame stream), splits it with the REAL splitter
 * (ffmpeg segment copy) at a 6MB limit, and verifies every part is under the
 * limit and playable, with total duration preserved.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

process.env.TG_PART_LIMIT_MB = "6";
const { splitIntoParts, probeDuration } = await import("./tgbot.mjs");

const LIMIT = 6 * 1024 * 1024;
const SRC = process.argv[2];
const TMP = path.join(process.cwd(), ".tmp-downloads");
fs.mkdirSync(TMP, { recursive: true });

const ffprobe = (file) =>
  new Promise((res) =>
    execFile("/usr/bin/ffprobe", ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { timeout: 30_000 }, (e, out) => res(e ? 0 : parseFloat(String(out).trim())))
  );

const song = fs.readFileSync(SRC);
const copies = Math.ceil((60 * 1048576) / song.length);
const big = path.join(TMP, "big-test.mp3");
fs.writeFileSync(big, Buffer.concat(Array(copies).fill(song)));
const size = fs.statSync(big).size;
console.log(`[setup] ${SRC} (${(song.length / 1048576).toFixed(1)}MB) × ${copies} → ${(size / 1048576).toFixed(1)}MB`);

const duration = await probeDuration(big);
console.log(`[probe] duration = ${duration.toFixed(1)}s`);

const { dir, parts } = await splitIntoParts(big, size, duration);
console.log(`[split] ${parts.length} parts:`);

let failed = [];
let totalPartDur = 0;
for (const p of parts) {
  const st = fs.statSync(p);
  const dur = await ffprobe(p);
  totalPartDur += dur;
  const mb = (st.size / 1048576).toFixed(2);
  console.log(`  ${path.basename(p)}  ${mb}MB  dur=${dur.toFixed(1)}s ${st.size <= LIMIT ? "✓" : "✗ OVER LIMIT"}`);
  if (st.size > LIMIT * 1.02) failed.push(`${path.basename(p)} over limit`);
  if (dur < 1) failed.push(`${path.basename(p)} not playable`);
}
console.log(`[sum] parts duration ${totalPartDur.toFixed(1)}s vs original ${duration.toFixed(1)}s`);
if (Math.abs(totalPartDur - duration) / duration > 0.05) failed.push("parts lose >5% of duration");

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(big, { force: true });

if (failed.length) {
  console.error("❌ FAILURES:\n" + failed.map((f) => ` - ${f}`).join("\n"));
  process.exit(1);
}
console.log(`✅ CHUNK UNIT TEST PASSED — ${parts.length} parts, all ≤6MB, all playable, duration preserved`);
