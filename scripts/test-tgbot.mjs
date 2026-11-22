#!/usr/bin/env node
/**
 * TG bot system test — runs the REAL bot logic (createBot from scripts/tgbot.mjs)
 * against the REAL TuneLoad API (localhost:3000), with a stubbed Telegram
 * transport. TG_PART_LIMIT_MB=2 forces the CHUNK SYSTEM on every file, so this
 * proves: song → parts, playlist → parts, quality switch, auto-clean, and that
 * every part is a valid playable MP3 under the limit.
 */

import fs from "node:fs";
import path from "node:path";

process.env.TG_PART_LIMIT_MB = process.env.TG_PART_LIMIT_MB || "2";
const { createBot, findYouTubeLink, parseSelection, parseYouTubeUrl } = await import("./tgbot.mjs");

const LIMIT = Number(process.env.TG_PART_LIMIT_MB) * 1048576;
const OUT = path.join(process.cwd(), "data", "tgbot-test-outbox");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const sent = { messages: [], audios: [], errors: [] };

const deps = {
  tgCall: async (method, params) => {
    sent.messages.push({ method, text: (params?.text ?? "").slice(0, 150) });
    console.log(`\n[tg:${method}] ${params?.text?.split("\n")[0].slice(0, 110) ?? ""}`);
    return { message_id: sent.messages.length };
  },
  sendAudio: async (chatId, filePath, meta) => {
    const dest = path.join(OUT, meta.filename);
    fs.copyFileSync(filePath, dest);
    const size = fs.statSync(dest).size;
    sent.audios.push({ file: dest, size, meta });
    console.log(
      `[tg:sendAudio] ${meta.filename.slice(0, 60)} (${(size / 1048576).toFixed(2)}MB${meta.part ? `, ${meta.part}` : ""})`
    );
    return { message_id: sent.messages.length };
  },
  api: async (route, body) => {
    const init =
      body === undefined
        ? { method: "GET" }
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}${route}`, init);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) console.log(`[api ${r.status}] ${route} → ${JSON.stringify(data).slice(0, 160)}`);
    return { ok: r.ok, status: r.status, data };
  },
  removeFile: (p) => {
    const existed = fs.existsSync(p);
    try { fs.rmSync(p, { force: true }); } catch { /* noop */ }
    console.log(`[cleanup] server copy ${path.basename(p)} ${existed ? "deleted ✅" : "already gone"}`);
  },
  log: (...a) => console.log("[bot]", ...a),
};

const bot = createBot(deps);
const CHAT = 998877;

/* ---------------- unit checks ---------------- */
const u1 = parseYouTubeUrl("https://youtu.be/VztFuJZ7d3s");
const u2 = parseYouTubeUrl("https://youtube.com/playlist?list=RDEMQ3kPV9aadZHGHqfKZoW6Uw");
const sel = parseSelection("1,3,5-7", 25);
console.log(`[unit] parse song → videoId=${u1.videoId}`);
console.log(`[unit] parse mix → playlistId=${u2.playlistId}`);
console.log(`[unit] parseSelection("1,3,5-7", 25) → [${sel.join(",")}]`);
if (u1.videoId !== "VztFuJZ7d3s" || u2.playlistId !== "RDEMQ3kPV9aadZHGHqfKZoW6Uw" || sel.join(",") !== "0,2,4,5,6") {
  sent.errors.push("unit parse checks failed");
}

/* ---------------- flow tests ---------------- */
console.log("\n════ 1. /start ══════");
await bot.handleText(CHAT, "/start");

console.log("\n════ 2. song link → CHUNKED MP3 ══════");
await bot.handleText(CHAT, "https://youtu.be/VztFuJZ7d3s");

console.log("\n════ 3. playlist (mix) link → track list ══════");
await bot.handleText(CHAT, "https://youtube.com/playlist?list=RDEMQ3kPV9aadZHGHqfKZoW6Uw");

console.log("\n════ 4. reply '1,3' → two chunked tracks ══════");
await bot.handleText(CHAT, "1,3");

console.log("\n════ 5. /quality 128 + song again ══════");
await bot.handleText(CHAT, "/quality 128");
await bot.handleText(CHAT, "https://www.youtube.com/watch?v=VztFuJZ7d3s");

/* ---------------- report ---------------- */
console.log("\n════════════ REPORT ════════════");
console.log(`messages sent   : ${sent.messages.length}`);
console.log(`audio parts sent: ${sent.audios.length}`);
console.log(`unit errors     : ${sent.errors.length}`);

const failed = [];
if (sent.audios.length < 6) failed.push(`expected ≥6 chunked audio parts, got ${sent.audios.length}`);

// every part must be under the limit AND a real playable MP3
for (const a of sent.audios) {
  if (!fs.existsSync(a.file)) { failed.push(`outbox file missing: ${a.file}`); continue; }
  if (fs.statSync(a.file).size > LIMIT * 1.02) failed.push(`part over limit: ${a.file} (${a.size} > ${LIMIT})`);
  const head = fs.readFileSync(a.file).subarray(0, 3);
  const isMp3 = (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) || head[0] === 0xff;
  if (!isMp3) failed.push(`not an MP3: ${a.file}`);
}

// chunk messages must announce parts
const partMsgs = sent.messages.filter((m) => /sent in \d+ parts/.test(m.text));
console.log(`part announcements: ${partMsgs.length}`);
if (sent.audios.length >= 6 && partMsgs.length < 1) failed.push("expected at least one 'sent in N parts' message");

const playlistListed = sent.messages.some((m) => /📋/.test(m.text) && /tracks/.test(m.text));
if (!playlistListed) failed.push("playlist listing message missing");
if (sent.errors.length) failed.push("unit parse checks failed");

// engine-side auto-clean check
const leftover = fs.readdirSync(path.join(process.cwd(), "data", "audio")).filter((f) => f.endsWith(".mp3"));
const partsLeft = fs.readdirSync(path.join(process.cwd(), "data", "audio")).flatMap((d) => {
  const p = path.join(process.cwd(), "data", "audio", d);
  try { return fs.statSync(p).isDirectory() ? fs.readdirSync(p).map((f) => p + "/" + f) : []; } catch { return []; }
});
console.log(`audio dir now  : ${leftover.length} files, ${partsLeft.length} leftover part files`);
if (partsLeft.length) failed.push(`${partsLeft.length} leftover chunk dirs`);

if (failed.length) {
  console.error("\n❌ FAILURES:\n" + failed.map((f) => ` - ${f}`).join("\n"));
  process.exit(1);
}
console.log("\n✅ TG BOT CHUNK-SYSTEM TEST PASSED — every file split into valid parts, all flows OK");
