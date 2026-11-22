#!/usr/bin/env node
/**
 * TG bot v2 simulation — drives createBot() with mock Telegram deps but the
 * REAL engine (localhost:3000). Verifies the zero-typing button flows:
 *   1. video link → quality keyboard → tap 128 → live progress → MP3 sent
 *   2. playlist link → picker → select 2 → go → both sent
 *   3. link while busy → queued → drained after current
 *   4. Cancel mid-download → killed + skipped list shown
 *   5. /cancel queue panel with remove buttons
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { createBot, findYouTubeLink, parseYouTubeUrl } from "./tgbot.mjs";

const BASE = process.env.TUNELOAD_API_BASE || "http://localhost:3000";
const CHAT = 4242;

/* ---------------- mock telegram ---------------- */
let msgSeq = 1000;
const sent = [];        // sendMessage records
const edits = [];       // editMessageText records
const audios = [];      // sendAudio records
const answers = [];     // answerCallbackQuery records
const removedFiles = [];

const deps = {
  tgCall: async (method, params) => {
    if (method === "sendMessage") {
      const m = { message_id: ++msgSeq };
      sent.push({ ...params, message_id: m.message_id });
      return m;
    }
    if (method === "editMessageText") {
      edits.push({ ...params });
      return { message_id: params.message_id };
    }
    if (method === "answerCallbackQuery") {
      answers.push(params);
      return {};
    }
    throw new Error(`unexpected tgCall ${method}`);
  },
  sendAudio: async (chatId, file, meta) => {
    assert(fs.existsSync(file), `sendAudio: file missing ${file}`);
    const size = fs.statSync(file).size;
    assert(size > 50_000, `sendAudio: file too small (${size}b)`);
    audios.push({ chatId, file, meta, size });
    return { message_id: ++msgSeq };
  },
  api: async (route, body) => {
    const init =
      body === undefined
        ? { method: "GET" }
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const r = await fetch(`${BASE}${route}`, init);
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  },
  removeFile: (p) => {
    removedFiles.push(p);
    try { fs.rmSync(p, { force: true }); } catch { /* noop */ }
  },
  log: (m) => console.log(`   [botlog] ${m}`),
};

const bot = createBot(deps);
const H = (t) => bot.handleText(CHAT, t);
const CB = (data, messageId = 2000) => bot.handleCallback(CHAT, data, messageId, `cb-${data}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const last = (arr) => arr[arr.length - 1];

/* progress wait helper — waits until the engine job hits a phase */
async function waitForPhase(key, phase, timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await deps.api(`/api/progress?key=${encodeURIComponent(key)}`);
    if (r?.data?.phase === phase) return r.data;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting phase=${phase} for ${key}`);
    await sleep(700);
  }
}

const sections = [];
function section(name) {
  sections.push(name);
  console.log(`\n■ ${name}`);
}
function ok(cond, label) {
  assert(cond, label);
  console.log(`  ✓ ${label}`);
}

/* ================= 0. unit: link parsing ================= */
section("unit: findYouTubeLink / parseYouTubeUrl");
ok(findYouTubeLink("hello https://youtu.be/VztFuJZ7d3s world") === "https://youtu.be/VztFuJZ7d3s", "finds link in text");
ok(parseYouTubeUrl("https://youtu.be/VztFuJZ7d3s").videoId === "VztFuJZ7d3s", "parses youtu.be id");
ok(parseYouTubeUrl("https://youtube.com/playlist?list=RDEMQ3kPV9aadZHGHqfKZoW6Uw").playlistId === "RDEMQ3kPV9aadZHGHqfKZoW6Uw", "parses playlist id");

/* ================= 1. video → quality buttons → download ================= */
section("video link → quality keyboard → tap 128 → MP3 sent");
await H("https://youtu.be/VztFuJZ7d3s");
await sleep(300);
const qMsg = last(sent);
ok(qMsg && /Tap a quality/.test(qMsg.text), "bot asks quality via buttons");
ok(qMsg?.reply_markup?.inline_keyboard?.[0]?.length === 4, "4 quality buttons shown");
ok(qMsg.reply_markup.inline_keyboard.some((r) => r.some((b) => b.callback_data === "q:128")), "128 button exists");

const beforeAudio = audios.length;
await CB("q:128");
await sleep(500);
// wait for the download to finish → audio sent
const dlStart = Date.now();
while (audios.length === beforeAudio && Date.now() - dlStart < 150_000) await sleep(1000);
ok(audios.length > beforeAudio, "MP3 sent as audio message");
const a1 = last(audios);
ok(/128/.test(String(a1.meta.bitrate)), "audio is 128kbps");
ok(removedFiles.some((f) => f === a1.file), "server copy auto-deleted after send");
// status message went to "All done"
ok(/All done/.test(edits.at(-1)?.text ?? "") || /All done/.test(last(edits)?.text ?? ""), "final status: All done");
// live progress edits happened (progress bar or starting text on the status message)
const statusEdits = edits.filter((e) => /⬇ #1\/1/.test(e.text));
ok(statusEdits.length >= 1, "live progress edits on status message");

/* ================= 2. playlist picker flow ================= */
section("playlist link → picker → select 2 → go → both sent");
await H("https://youtube.com/playlist?list=RDEMQ3kPV9aadZHGHqfKZoW6Uw");
await sleep(400);
const pickMsg = last(sent);
ok(/tracks/.test(pickMsg.text), "playlist listed with track count");
ok(pickMsg.reply_markup.inline_keyboard.some((r) => r.some((b) => b.callback_data === "t:0")), "track buttons exist");
ok(pickMsg.reply_markup.inline_keyboard.some((r) => r.some((b) => b.callback_data === "all")), "All button exists");
ok(pickMsg.reply_markup.inline_keyboard.some((r) => r.some((b) => b.callback_data === "go")), "Download button exists");

await CB("t:0");
await CB("t:1");
const nAudioBefore = audios.length;
await CB("go");
await sleep(500);
const dl2 = Date.now();
while (audios.length < nAudioBefore + 2 && Date.now() - dl2 < 200_000) await sleep(1000);
ok(audios.length === nAudioBefore + 2, "2 selected tracks sent");
const qSummary = last(edits);
ok(/All done/.test(qSummary.text ?? ""), "queue summary after playlist");
// per-track progress on the shared status message
ok(edits.some((e) => /#1\/2/.test(e.text) && /#2\/2/.test(e.text)) || edits.filter((e) => /⬇ #/.test(e.text)).length >= 2, "per-track progress edits");

/* ================= 3. queue while busy ================= */
section("link while busy → queued → drained");
// start a 2-track playlist run, then send a video link mid-run
await H("https://youtube.com/playlist?list=RDEMQ3kPV9aadZHGHqfKZoW6Uw");
await sleep(300);
await CB("t:5");
await CB("t:6");
const nBefore = audios.length;
await CB("go");
await sleep(1500);
// while that's running, send a new video link
await H("https://youtu.be/8of5w7RgcTc");
await sleep(200);
const busyMsg = last(sent);
ok(/joins the queue/.test(busyMsg.text), "bot says the new link joins the queue");
ok(busyMsg.reply_markup.inline_keyboard.some((r) => r.some((b) => b.callback_data === "q:128")), "quality buttons still offered");
await CB("q:128"); // enqueue it
const dl3 = Date.now();
while (audios.length < nBefore + 3 && Date.now() - dl3 < 240_000) await sleep(1000);
ok(audios.length === nBefore + 3, "queued video sent after the running playlist (total +3)");

/* ================= 4. cancel mid-download ================= */
section("cancel mid-download → killed + skipped list");
await H("https://youtu.be/8Ix-ekSoEdY");
await sleep(300);
const nBefore4 = audios.length;
const cancelP = CB("q:320"); // start a 320 download (slower → time to cancel)
await sleep(4000);
// cancel while downloading
await CB("cancel");
// wait for the queue to settle
await sleep(3000);
const cancelSummary = last(edits);
ok(/Cancelled/.test(cancelSummary.text ?? ""), "summary says Cancelled");
ok(/1 skipped/.test(cancelSummary.text ?? ""), "counts 1 skipped (the cancelled active track)");
ok(/Rangeen/.test(cancelSummary.text ?? ""), "skipped link title shown in summary");
ok(audios.length === nBefore4, "no audio sent for cancelled download");
// engine has no running yt-dlp now
const st = await deps.api("/api/status");
ok((st.data.queue?.running ?? 0) === 0, "engine idle after cancel");

/* ================= 5. /cancel queue panel ================= */
section("/cancel queue panel + remove button");
// build a queue without running: use picker → go, then immediately /cancel panel
await H("https://youtube.com/playlist?list=RDEMQ3kPV9aadZHGHqfKZoW6Uw");
await sleep(300);
await CB("t:2");
await CB("t:3");
await CB("go");
await sleep(600); // queue running (1 active + 1 waiting)
await H("/cancel");
await sleep(200);
const panelMsg = last(sent);
ok(/Queue \(\d+\)/.test(panelMsg.text), "queue panel lists items");
ok(panelMsg.reply_markup.inline_keyboard.some((r) => r.some((b) => /^rm:/.test(b.callback_data))), "per-item remove buttons");
ok(panelMsg.reply_markup.inline_keyboard.some((r) => r.some((b) => b.callback_data === "cancel")), "cancel-everything button");
// remove the waiting item (index 0 = queue[0] since active is shown without index)
const sess = bot.sessions.get(CHAT);
const queueLenBefore = sess.queue.length;
await CB("rm:0");
await sleep(200);
ok(sess.queue.length === Math.max(0, queueLenBefore - 1), "remove button drops one queue item");
// now cancel everything to clean up
await CB("cancel");
await sleep(2500);

/* ================= report ================= */
console.log("\n══════════════════════════════════");
console.log(`sent messages : ${sent.length}`);
console.log(`edits         : ${edits.length}`);
console.log(`audio sent    : ${audios.length}`);
console.log(`files cleaned : ${removedFiles.length}`);
console.log("ALL TG BOT FLOWS PASSED ✅");
