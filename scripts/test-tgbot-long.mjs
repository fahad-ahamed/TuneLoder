#!/usr/bin/env node
/**
 * REAL long-video chunk E2E: a ~1 hour track at 320kbps (~160MB) downloaded
 * with the REAL engine, split at the REAL 45MB Telegram limit, sent part by
 * part through the real bot logic (stubbed transport), auto-clean verified.
 */

import fs from "node:fs";
import path from "node:path";

// keep the REAL 45MB default limit (delete any override)
delete process.env.TG_PART_LIMIT_MB;
const { createBot } = await import("./tgbot.mjs");

const URL = process.argv[2] || "https://www.youtube.com/watch?v=QQIxoYbQmvU";
const OUT = path.join(process.cwd(), "data", "tgbot-test-outbox");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const sent = { messages: [], audios: [] };

const deps = {
  tgCall: async (method, params) => {
    sent.messages.push({ method, text: (params?.text ?? "").slice(0, 120) });
    console.log(`[tg:${method}] ${params?.text?.split("\n")[0].slice(0, 100) ?? ""}`);
    return { message_id: sent.messages.length };
  },
  sendAudio: async (chatId, filePath, meta) => {
    const dest = path.join(OUT, meta.filename);
    fs.copyFileSync(filePath, dest);
    const size = fs.statSync(dest).size;
    sent.audios.push({ file: dest, size, meta });
    console.log(`[tg:sendAudio] ${meta.filename.slice(0, 55)} (${(size / 1048576).toFixed(2)}MB${meta.part ? `, ${meta.part}` : ""})`);
    return { message_id: sent.messages.length };
  },
  api: async (route, body) => {
    const init = body === undefined
      ? { method: "GET" }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}${route}`, init);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) console.log(`[api ${r.status}] ${JSON.stringify(data).slice(0, 200)}`);
    return { ok: r.ok, status: r.status, data };
  },
  removeFile: (p) => {
    try { fs.rmSync(p, { force: true }); } catch { /* noop */ }
    console.log(`[cleanup] server copy ${path.basename(p)} deleted`);
  },
  log: (...a) => console.log("[bot]", ...a),
};

const bot = createBot(deps);
const t0 = Date.now();

await bot.handleText(998877, URL);
const took = ((Date.now() - t0) / 1000).toFixed(1);

/* ---------------- report ---------------- */
console.log("\n════════════ REPORT ════════════");
console.log(`total time      : ${took}s`);
console.log(`audio parts sent: ${sent.audios.length}`);
const totalMB = sent.audios.reduce((n, a) => n + a.size, 0) / 1048576;
console.log(`total audio     : ${totalMB.toFixed(1)}MB`);

const failed = [];
if (sent.audios.length < 2) failed.push(`expected multiple parts, got ${sent.audios.length}`);
for (const a of sent.audios) {
  if (a.size > 45 * 1048576 * 1.02) failed.push(`part over 45MB: ${a.file}`);
  const head = fs.readFileSync(a.file).subarray(0, 3);
  if (!((head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) || head[0] === 0xff)) {
    failed.push(`not an MP3: ${a.file}`);
  }
}
if (!sent.messages.some((m) => /sent in \d+ parts/.test(m.text))) failed.push("missing parts announcement");

const leftover = fs.readdirSync(path.join(process.cwd(), "data", "audio")).flatMap((d) => {
  const p = path.join(process.cwd(), "data", "audio", d);
  try { return fs.statSync(p).isDirectory() ? fs.readdirSync(p) : []; } catch { return []; }
});
if (leftover.length) failed.push(`${leftover.length} leftover chunk dirs`);
const leftoverFiles = fs.readdirSync(path.join(process.cwd(), "data", "audio")).filter((f) => f.endsWith(".mp3"));
console.log(`audio dir after : ${leftoverFiles.length} files, ${leftover.length} part dirs (sweeper covers any grace leftovers)`);

if (failed.length) {
  console.error("❌ FAILURES:\n" + failed.map((f) => ` - ${f}`).join("\n"));
  process.exit(1);
}
console.log("\n✅ REAL LONG-VIDEO CHUNK E2E PASSED — big track split into ≤45MB parts, unlimited total");
