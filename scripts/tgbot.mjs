#!/usr/bin/env node
/**
 * TuneLoad Telegram bot — v2 "zero-typing" edition.
 *
 * Every interaction happens through INLINE KEYBOARD BUTTONS (live progress
 * included); nothing has to be typed:
 *
 *   video link    →  [320] [256] [192] [128]  + [Cancel]      → tap → downloads
 *   playlist link →  track picker (paged, tap to select ✓, All N, page ◀ ▶)
 *                    [Download N] [Quality ▾] [Cancel]        → tap → downloads
 *   live process  →  the status message is EDITED live: ▓▓▓░░ 45% 1.2MiB/s ETA 8s
 *   queue         →  sending another link while busy QUEUES it (position notice)
 *   cancel        →  [✖ Cancel] kills the active download + clears the queue,
 *                    then lists exactly what was cancelled (with remove buttons
 *                    for individual queue items via /cancel)
 *   retry         →  failures come with a [🔁 Retry N failed] button
 *
 * Chunk system for Telegram's 50MB bot-upload cap is unchanged: bigger tracks
 * are split into ≤45MB parts with ffmpeg stream-copy (unlimited total size).
 *
 * Runs detached (spawned by /api/telegram). Config: data/tgbot.json
 *   { "token": "123:ABC…", "username": "…" }
 *
 * Server copies of every sent file are deleted immediately after the send
 * (auto-clean), so nothing piles up.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const ROOT = process.cwd();
const CFG_FILE = path.join(ROOT, "data", "tgbot.json");
const LOG_FILE = path.join(ROOT, "data", "tgbot.log");
const PID_FILE = path.join(ROOT, "data", "tgbot.pid");
/** per-chat settings persist across bot restarts: { "chatId": { mode, quality, queue } } */
let STATE_FILE = process.env.TG_STATE_FILE || path.join(ROOT, "data", "tgbot-state.json");
/** test hook: point the state file somewhere else (isolated per test case) */
export function _test_stateFile(newPath) {
  if (newPath) STATE_FILE = newPath;
  return STATE_FILE;
}

// Telegram Bot API base (override for tests; production default unchanged)
const TG_BASE = (process.env.TG_API_BASE || "https://api.telegram.org").replace(/\/$/, "");
const API_BASE = process.env.TUNELOAD_API_BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_BIN || path.join(path.dirname(FFMPEG_BIN), "ffprobe");
export const PART_LIMIT = (Number(process.env.TG_PART_LIMIT_MB) || 45) * 1024 * 1024; // per-part cap (Telegram allows 50MB)
const MAX_PARTS = 40; // ≈1.8GB — beyond any realistic audio
const QUALITIES = [320, 256, 192, 128];
const PAGE_SIZE = 10; // tracks per picker page

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch { /* noop */ }
  console.log(line);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* per-chat settings persistence (mode + quality survive restarts)     */
/* ------------------------------------------------------------------ */

function loadChatState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveChatState(chatId, patch) {
  try {
    const st = loadChatState();
    const k = String(chatId);
    st[k] = { ...(st[k] ?? {}), ...patch };
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), { mode: 0o600 });
    log(`chat ${k} state saved: mode=${st[k].mode} quality=${st[k].quality} queue=${(st[k].queue ?? []).length}`);
  } catch { /* noop */ }
}

/**
 * MULTI-USER crash safety: every chat's pending queue is persisted next to its
 * mode/quality. If the bot (or the whole server) dies mid-queue, the queue is
 * rebuilt and RESUMED automatically on the next boot.
 */
function saveQueueState(chatId, queue) {
  saveChatState(chatId, {
    queue: (queue ?? []).slice(0, 200).map((j) => ({
      v: j.track.videoId,
      t: j.track.title,
      a: j.track.author,
      d: j.track.duration ?? null,
      q: j.quality,
    })),
  });
}

/** stored queue rows → real queue jobs (drop anything malformed) */
function reviveQueue(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (r && typeof r.v === "string" && /^[a-zA-Z0-9_-]{11}$/.test(r.v) && QUALITIES.includes(r.q)) {
      out.push({ track: { videoId: r.v, title: String(r.t ?? r.v), author: String(r.a ?? ""), duration: r.d ?? null }, quality: r.q });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* youtube url parsing (JS port of src/lib/ytd/providers.ts)           */
/* ------------------------------------------------------------------ */

export function parseYouTubeUrl(raw) {
  const s = String(raw ?? "").trim().replace(/^["'<]+|["'>]+$/g, "");
  if (!s) return { videoId: null, playlistId: null };
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return { videoId: s, playlistId: null };

  let u = null;
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
  let videoId = null;
  let playlistId = u.searchParams.get("list");

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

export function findYouTubeLink(text) {
  for (const tok of String(text ?? "").split(/\s+/)) {
    const t = tok.replace(/^<|>$/g, "");
    if (/youtu\.be|youtube\.com|youtube-nocookie\.com/i.test(t)) return t;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* chunk system (unlimited size via ≤45MB parts)                       */
/* ------------------------------------------------------------------ */

export function probeDuration(file) {
  return new Promise((resolve, reject) => {
    execFile(
      FFPROBE_BIN,
      ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { timeout: 30_000 },
      (err, stdout) => {
        const d = parseFloat(String(stdout).trim());
        if (err || !Number.isFinite(d)) return reject(new Error("ffprobe failed"));
        resolve(d);
      }
    );
  });
}

/**
 * Split an MP3 into parts of ≤PART_LIMIT bytes using ffmpeg stream-copy
 * segmenting (frame-accurate, no re-encode → fast even for 1GB files).
 * Returns { dir, parts } — caller must delete dir when done.
 */
export function splitIntoParts(file, size, duration) {
  return new Promise((resolve, reject) => {
    const partTarget = PART_LIMIT * 0.92; // safety margin for VBR wobble
    const n = Math.max(2, Math.ceil(size / partTarget));
    if (n > MAX_PARTS) {
      return reject(
        new Error(`track is ${Math.round(size / 1048576)}MB — would need ${n} parts (limit ${MAX_PARTS})`)
      );
    }
    // segment length: duration spread evenly across n parts (CBR audio → equal bytes)
    const segTime = Math.max(1, (duration / n) * 0.985).toFixed(3);
    const dir = fs.mkdtempSync(path.join(path.dirname(file), "tgparts-"));
    const outFmt = path.join(dir, "part%03d.mp3");

    execFile(
      FFMPEG_BIN,
      ["-hide_banner", "-loglevel", "error", "-y", "-i", file,
        "-f", "segment", "-segment_time", segTime,
        "-c", "copy", "-reset_timestamps", "1", outFmt],
      { timeout: 300_000 },
      (err) => {
        if (err) {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
          return reject(new Error("ffmpeg segment failed"));
        }
        const parts = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".mp3"))
          .sort()
          .map((f) => path.join(dir, f));
        if (parts.length < 2) {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
          return reject(new Error("split produced too few parts"));
        }
        resolve({ dir, parts });
      }
    );
  });
}

/* ------------------------------------------------------------------ */
/* real transport                                                      */
/* ------------------------------------------------------------------ */

export function realDeps(token) {
  const TG_DEBUG = process.env.TG_DEBUG === "1";
  // Telegram rate limits (HTTP 429 + retry_after) and transient 5xx answers get
  // automatic retries with backoff — a busy bot must never silently drop
  // messages just because it talked too fast for a moment.
  const tgFetch = async (method, params, fileBody = null, attempt = 1) => {
    const MAX_ATTEMPTS = 4;
    try {
      const init = fileBody
        ? { method: "POST", body: fileBody, signal: AbortSignal.timeout(120_000) }
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params ?? {}),
            signal: AbortSignal.timeout(30_000),
          };
      const t0 = Date.now();
      const r = await fetch(`${TG_BASE}/bot${token}/${method}`, init);
      const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
      if (TG_DEBUG) log(`tgCall ${method} → ${r.ok ? "ok" : `FAIL (${j.description ?? r.status})`} in ${Date.now() - t0}ms`);
      if (!j.ok) {
        const ra = Number(j.parameters?.retry_after) || 0;
        if ((j.error_code === 429 || ra > 0) && attempt < MAX_ATTEMPTS) {
          const wait = Math.min(20, ra || 2) * 1000 + 250;
          log(`tg ${method}: rate limited — retry ${attempt + 1}/${MAX_ATTEMPTS} in ${Math.round(wait / 100) / 10}s`);
          await sleep(wait);
          return tgFetch(method, params, fileBody, attempt + 1);
        }
        if (r.status >= 500 && attempt < MAX_ATTEMPTS) {
          await sleep(1200 * attempt);
          return tgFetch(method, params, fileBody, attempt + 1);
        }
        throw new Error(`tg ${method}: ${j.description ?? r.status}`);
      }
      return j.result;
    } catch (e) {
      if (TG_DEBUG && !/^tg /.test(String(e.message))) {
        log(`tgCall ${method} error: ${e.message}`);
      }
      throw e;
    }
  };

  return {
    tgCall: async (method, params) => tgFetch(method, params),

    sendAudio: async (chatId, filePath, meta) => {
      const buf = fs.readFileSync(filePath);
      const fd = new FormData();
      fd.append("chat_id", String(chatId));
      fd.append("audio", new Blob([buf], { type: "audio/mpeg" }), meta.filename);
      if (meta.title) fd.append("title", String(meta.title).slice(0, 64));
      if (meta.author) fd.append("performer", String(meta.author).slice(0, 64));
      const caption = `${meta.title}${meta.part ? ` · ${meta.part}` : ""} · ${meta.bitrate}kbps · TuneLoad`;
      fd.append("caption", caption.slice(0, 900));
      return tgFetch("sendAudio", { chat_id: String(chatId) }, fd);
    },

    api: async (route, body) => {
      const init =
        body === undefined
          ? { method: "GET" }
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            };
      // route-aware timeout + one retry: a hung engine request must never wedge
      // the bot (fetch-audio legitimately runs minutes; everything else is fast)
      const isLong = route.includes("fetch-audio");
      const timeoutMs = isLong ? 330_000 : 30_000;
      const DEBUG = process.env.TG_DEBUG === "1";
      const attempt = async (n) => {
        const t0 = Date.now();
        try {
          if (DEBUG) log(`api → ${route} (try ${n})`);
          const r = await fetch(`${API_BASE}${route}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
          const data = await r.json().catch(() => ({}));
          const ms = Date.now() - t0;
          if (ms > 8_000) log(`slow api ${route}: ${ms}ms`);
          else if (DEBUG) log(`api ← ${route} ${r.status} in ${ms}ms`);
          return { ok: r.ok, status: r.status, data };
        } catch (e) {
          log(`api ${route} error after ${Date.now() - t0}ms (try ${n}): ${e.message}`);
          return { ok: false, status: 0, data: { error: `engine unreachable: ${e.message}` } };
        }
      };
      let res = await attempt(1);
      if (res.status === 0 && !isLong) {
        await sleep(800);
        res = await attempt(2);
      }
      return res;
    },

    removeFile: (p) => {
      try { fs.rmSync(p, { force: true }); } catch { /* noop */ }
    },

    log,
  };
}

/* ------------------------------------------------------------------ */
/* bot logic (testable — deps injectable)                              */
/* ------------------------------------------------------------------ */

const PROGRESS_POLL_MS = 1300; // live progress edit cadence
const EDIT_MIN_MS = 1300;      // Telegram edit rate-limit safety

const HELP = [
  "Send any YouTube link — video or playlist. Everything else is buttons:",
  "• quality → tap 320 / 256 / 192 / 128",
  "• playlist tracks → tap numbers to select, then Download",
  "• download mode → 🤖 Auto (ask per link) or ✋ Manual (link = instant download)",
  "• live progress while downloading, Cancel anytime",
  "• sending another link while busy → it's queued automatically",
  "",
  "Handy commands: /mode (auto/manual) · /quality · /cancel (queue panel) · /status · /help",
  "Big tracks (>50MB) arrive as ≤50MB parts — unlimited total size.",
].join("\n");

function bar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return "▓".repeat(filled) + "░".repeat(10 - filled);
}

function kb(rows) {
  return { inline_keyboard: rows.map((r) => r.filter(Boolean)) };
}
const B = (text, data) => ({ text, callback_data: data });

const modeBtn = (sess) =>
  B(
    sess.mode === "manual"
      ? "✋ Download mode: MANUAL — tap for Auto"
      : "🤖 Download mode: AUTO — tap for Manual",
    "mode"
  );

const modeText = (sess) =>
  sess.mode === "manual"
    ? [
        "✋ MANUAL download mode is ON.",
        "",
        `Every YouTube link you send starts downloading INSTANTLY at ${sess.quality}kbps —`,
        "• video → downloads right away, no quality question",
        "• playlist → ALL tracks queue up automatically",
        "",
        "Set the quality with /quality (or tap below). No confirmations anymore.",
      ].join("\n")
    : [
        "🤖 AUTO download mode is ON (default).",
        "",
        "Every link asks you first: video → pick quality; playlist → pick tracks.",
        "Tap the button below to switch to MANUAL (link = instant download).",
      ].join("\n");

export function createBot(deps) {
  /** chatId → session */
  const sessions = new Map();
  const chatStore = loadChatState();
  const getSession = (chatId) => {
    if (!sessions.has(chatId)) {
      const stored = chatStore[String(chatId)] ?? {};
      sessions.set(chatId, {
        chatId, // sessions know their own chat (queue persistence needs it)
        quality: QUALITIES.includes(stored.quality) ? stored.quality : 320,
        mode: stored.mode === "manual" ? "manual" : "auto", // 🤖 auto | ✋ manual
        picker: null,        // { tracks, selected:Set, page }
        pendingVideo: null,  // { track } awaiting quality choice
        queue: reviveQueue(stored.queue), // restored after a crash/restart
        active: null,        // { track, quality } the job currently downloading
        lastFailed: [],      // [{ track, quality }] for the Retry button
        cancelRequested: false,
        cancelWasUser: false,
        editAt: 0,           // last live-edit timestamp
      });
    }
    return sessions.get(chatId);
  };

  const send = (chatId, text, extra) =>
    deps.tgCall("sendMessage", { chat_id: chatId, text, ...extra }).catch((e) =>
      deps.log(`sendMessage: ${e.message}`)
    );

  const editMsg = async (chatId, messageId, text, markup) => {
    // accept BOTH shapes — some call sites pass kb(...) directly, others pass
    // { reply_markup: kb(...) }; a double-wrapped keyboard makes the REAL
    // Telegram API reject the edit with "Bad Request: can't parse inline
    // keyboard", which silently killed every picker update in production.
    const rm = markup?.inline_keyboard ? markup : (markup?.reply_markup ?? null);
    try {
      await deps.tgCall("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(rm ? { reply_markup: rm } : {}),
      });
    } catch (e) {
      const m = String(e.message);
      if (!/message is not modified|MESSAGE_ID_INVALID|message to edit not found/i.test(m)) {
        deps.log(`editMessageText: ${m.slice(0, 120)}`);
      }
    }
  };

  const answerCb = (id) =>
    deps.tgCall("answerCallbackQuery", { callback_query_id: id }).catch(() => {});

  /* ---------------- keyboards ---------------- */

  const qualityRows = (sess) => [
    QUALITIES.map((q) => B(`${sess.quality === q ? "✓ " : ""}${q} kbps`, `q:${q}`)),
    [modeBtn(sess)],
    [B("✖ Cancel", "cx")],
  ];

  const pickerRows = (sess) => {
    const p = sess.picker;
    const n = p.tracks.length;
    const pages = Math.max(1, Math.ceil(n / PAGE_SIZE));
    const from = p.page * PAGE_SIZE;
    const rows = [];

    // track number buttons (selected → ✓n), 5 per row
    for (let r = 0; r < Math.ceil(Math.min(PAGE_SIZE, n - from) / 5); r++) {
      rows.push(
        Array.from({ length: 5 }, (_, c) => {
          const idx = from + r * 5 + c;
          if (idx >= n) return null;
          const sel = p.selected.has(idx);
          return B(sel ? `✓${idx + 1}` : `${idx + 1}`, `t:${idx}`);
        })
      );
    }

    rows.push([B(`All ${n}`, "all"), B("✓ This page", "pgall")]);
    if (pages > 1) {
      rows.push([
        p.page > 0 ? B("◀ Prev", `p:${p.page - 1}`) : null,
        B(`${p.page + 1}/${pages}`, "noop"),
        p.page + 1 < pages ? B("Next ▶", `p:${p.page + 1}`) : null,
      ]);
    }
    const count = p.selected.size || n;
    rows.push([B(`⬇ Download ${count}`, "go")]);
    rows.push([B(`🎚 ${sess.quality} kbps`, "qual"), B("✖ Cancel", "cx")]);
    rows.push([modeBtn(sess)]);
    return rows;
  };

  const pickerText = (sess) => {
    const p = sess.picker;
    const total = p.tracks.length;
    const showing = p.tracks.slice(p.page * PAGE_SIZE, p.page * PAGE_SIZE + PAGE_SIZE);
    const lines = showing.map((t, i) => {
      const idx = p.page * PAGE_SIZE + i;
      const mark = p.selected.has(idx) ? "✓ " : "";
      const dur = t.duration ? ` · ${t.duration}` : "";
      return `${mark}${idx + 1}. ${String(t.title).slice(0, 48)}${dur}`;
    });
    return [
      `📋 ${p.title}`,
      `👤 ${p.author} · ${total} tracks${p.selected.size ? ` · ${p.selected.size} selected` : ""}`,
      "",
      ...lines,
      "",
      "Tap numbers to pick · All for everything · then ⬇ Download",
    ].join("\n");
  };

  /* ---------------- queue panel (the /cancel view) ---------------- */

  const queuePanel = (sess) => {
    const current = sess.active ? sess.active.track : null;
    const items = sess.queue;
    const lines = [];
    if (current) lines.push(`▶ now: ${current.title.slice(0, 55)}`);
    items.forEach((it, i) => lines.push(`${i + 1}. ${it.track.title.slice(0, 55)}`));
    const text = items.length || current
      ? `Queue (${items.length + (current ? 1 : 0)}):\n\n${lines.join("\n").slice(0, 3500)}`
      : "Queue is empty — send a YouTube link.";
    const rows = items.slice(0, 30).map((it, i) => [B(`✖ #${i + 1}`, `rm:${i}`)]);
    if (current || items.length > 1) rows.push([B("🛑 Cancel everything", "cancel")]);
    return { text, markup: kb(rows) };
  };

  /* ---------------- queue + runner ---------------- */

  // MULTI-USER: the engine caches/dedupes per videoId+bitrate, so two chats
  // asking for the SAME track share one engine job. Killing that job because
  // ONE user tapped Cancel would murder the other user's download too — so
  // only send the engine cancel when nobody else is still using the key.
  function jobKeyBusyElsewhere(selfChatId, videoId, quality) {
    for (const [cid, s] of sessions) {
      if (cid === selfChatId) continue;
      if (s.active && s.active.track?.videoId === videoId && s.active.quality === quality) return true;
      if (s.queue.some((j) => j.track.videoId === videoId && j.quality === quality)) return true;
    }
    return false;
  }

  function enqueue(sess, jobs) {
    sess.queue.push(...jobs);
    saveQueueState(sess.chatId, sess.queue); // crash-safe: persisted immediately
  }

  function pump(chatId) {
    const sess = getSession(chatId);
    if (sess.active) return undefined; // already draining
    return runQueue(chatId, sess);
  }

  async function runQueue(chatId, sess) {
    // ONE status message reused for the whole queue run
    let statusMsgId = null;
    let done = 0;
    const failed = [];
    const skipped = [];

    try {
      while (sess.queue.length > 0) {
        if (sess.cancelRequested) break;
        const job = sess.queue.shift();
        saveQueueState(sess.chatId, sess.queue); // job left the queue → persist
        const total = done + 1 + sess.queue.length;
        sess.active = { track: job.track, quality: job.quality };
        sess.editAt = 0;

        const label = `#${done + 1}/${total}`;
        const text = `⬇ ${label} · ${job.track.title.slice(0, 60)}\n🎚 ${job.quality}kbps · starting…`;
        if (!statusMsgId) {
          const m = await deps
            .tgCall("sendMessage", {
              chat_id: chatId,
              text,
              reply_markup: kb([[B("🛑 Cancel all", "cancel")]]),
            })
            .catch(() => null);
          statusMsgId = m?.message_id ?? null;
        } else {
          await editMsg(chatId, statusMsgId, text, kb([[B("🛑 Cancel all", "cancel")]]));
        }

        const res = await downloadTrack(chatId, sess, job, statusMsgId, { done, total });
        if (res === "ok") done++;
        else if (res === "cancelled") {
          skipped.push({ track: job.track, quality: job.quality });
          break;
        } else failed.push({ track: job.track, quality: job.quality, error: res });
      }
    } finally {
      sess.active = null;
    }

    // summary
    const rest = sess.queue.splice(0);
    saveQueueState(sess.chatId, sess.queue); // drained/cancelled → persist empty
    const skippedAll = [...skipped, ...rest];
    sess.cancelRequested = false;

    if (sess.cancelWasUser) {
      sess.cancelWasUser = false;
      let summary = `✖ Cancelled — ${done} sent, ${failed.length + skippedAll.length} skipped.`;
      if (skippedAll.length) {
        summary += `\n\nSkipped:\n${skippedAll.map((j) => `• ${j.track.title.slice(0, 60)}`).join("\n").slice(0, 3000)}`;
      }
      if (statusMsgId) await editMsg(chatId, statusMsgId, summary);
      else await send(chatId, summary);
      return;
    }

    if (failed.length) {
      sess.lastFailed = failed;
      const errLines = failed
        .slice(0, 8)
        .map((f) => `• ${f.track.title.slice(0, 40)} — ${String(f.error).slice(0, 80)}`)
        .join("\n");
      const text = `⚠️ ${done}/${done + failed.length + skippedAll.length} sent — ${failed.length} failed:\n${errLines}${failed.length > 8 ? `\n… +${failed.length - 8} more` : ""}`;
      const markup = kb([[B(`🔁 Retry ${failed.length} failed`, "retry")]]);
      if (statusMsgId) await editMsg(chatId, statusMsgId, text, markup);
      else await send(chatId, text, { reply_markup: markup });
    } else if (statusMsgId) {
      await editMsg(chatId, statusMsgId, `✅ All done — ${done}/${done} sent · server copies auto-deleted.`);
    } else if (done > 0) {
      await send(chatId, `✅ All done — ${done} sent`);
    }
  }

  /**
   * Download one track with live progress on the shared status message.
   * Returns "ok" | "cancelled" | error-string.
   */
  async function downloadTrack(chatId, sess, job, statusMsgId, ctx) {
    const key = `${job.track.videoId}:${job.quality}`;
    const posLabel = `#${ctx.done + 1}/${ctx.total}`;
    const title = job.track.title.slice(0, 60);

    const renderStatus = (pct, speed, eta, phase) => {
      const line =
        pct != null
          ? `${bar(pct)} ${Math.round(pct)}%${speed ? ` · ${speed}` : ""}${eta ? ` · ETA ${eta}` : ""}`
          : phase === "encoding"
            ? "🎧 encoding MP3…"
            : "🔄 starting…";
      return `⬇ ${posLabel} · ${title}\n🎚 ${job.quality}kbps\n${line}`;
    };

    // live progress loop while fetch-audio is in flight
    const poller = (async () => {
      const myVideo = job.track.videoId;
      for (;;) {
        await sleep(PROGRESS_POLL_MS);
        const act = sess.active;
        if (!act || act.track.videoId !== myVideo) return;
        if (Date.now() - sess.editAt < EDIT_MIN_MS) continue;
        try {
          const r = await deps.api(`/api/progress?key=${encodeURIComponent(key)}`);
          const j = r?.data;
          if (!j || j.phase === "idle") continue;
          if (statusMsgId) {
            sess.editAt = Date.now();
            await editMsg(chatId, statusMsgId, renderStatus(j.pct, j.speed, j.eta, j.phase));
          }
        } catch { /* noop */ }
      }
    })();

    try {
      const res = await deps.api("/api/fetch-audio", {
        videoId: job.track.videoId,
        bitrate: job.quality,
        title: job.track.title,
        author: job.track.author,
      });
      if (!res.ok) {
        if (res.data?.cancelled || /cancel/i.test(String(res.data?.error))) return "cancelled";
        throw new Error(res.data?.hint || res.data?.error || `HTTP ${res.status}`);
      }
      const { path: file, filename, bitrate } = res.data;
      // MULTI-USER: the engine may hand the SAME cached file to several chats
      // (dedupe per videoId+bitrate). The first chat that finishes deletes the
      // server copy — the next chat would then send a vanished file. So every
      // job works on its OWN temp copy in its OWN directory, deleted after send.
      let tmpDir = null;
      try {
        tmpDir = fs.mkdtempSync(path.join(path.dirname(file), "job-"));
        const privateFile = path.join(tmpDir, filename.replace(/[\\/:*?"<>|]+/g, "_"));
        fs.copyFileSync(file, privateFile);
        try {
          if (statusMsgId) {
            sess.editAt = Date.now();
            await editMsg(chatId, statusMsgId, `📤 ${posLabel} · ${title}\n📤 sending to Telegram…`);
          }
          const partsSent = await sendMaybeChunked(chatId, privateFile, {
            filename,
            title: job.track.title,
            author: job.track.author,
            bitrate,
          });
          if (partsSent > 1 && statusMsgId) {
            await editMsg(chatId, statusMsgId, `✅ ${posLabel} · ${title} — sent in ${partsSent} parts`);
          }
          return "ok";
        } finally {
          deps.removeFile(file); // auto-clean: engine cache copy deleted right after send
        }
      } finally {
        if (tmpDir) {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
        }
      }
    } catch (e) {
      return String(e.message).slice(0, 160);
    } finally {
      sess.active = null; // stops the poller on its next tick
    }
  }

  async function sendMaybeChunked(chatId, file, meta) {
    const size = fs.statSync(file).size;
    if (size <= PART_LIMIT) {
      await deps.sendAudio(chatId, file, meta);
      return 1;
    }
    // big track → probe duration, split, send parts
    const duration = await probeDuration(file);
    const { dir, parts } = await splitIntoParts(file, size, duration);
    deps.log(`chunking ${(size / 1048576).toFixed(1)}MB → ${parts.length} parts (dur ${Math.round(duration)}s)`);
    try {
      for (let i = 0; i < parts.length; i++) {
        const base = meta.filename.replace(/\.mp3$/, "");
        await deps.sendAudio(chatId, parts[i], {
          ...meta,
          filename: `${base} part${i + 1}-${parts.length}.mp3`,
          part: `part ${i + 1}/${parts.length} of ${Math.round(size / 1048576)}MB`,
        });
      }
      return parts.length;
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }

  /* ---------------- link intake ---------------- */

  async function handleLink(chatId, url, placeholderId = null) {
    const sess = getSession(chatId);
    const info = await deps.api("/api/info", { url });
    if (!info.ok) throw new Error(info.data?.error || "Could not read that link");
    const d = info.data;

    /* ✋ MANUAL mode: link → download starts INSTANTLY with the saved quality.
       No quality question, no track picker — exactly like a downloader bot. */
    if (sess.mode === "manual") {
      const q = sess.quality;
      if (d.type === "video") {
        const t = d.track;
        const busy = !!(sess.active || sess.queue.length);
        enqueue(sess, [{ track: t, quality: q }]);
        await send(
          chatId,
          `✋ Manual mode · ${q}kbps — download ${busy ? "queued" : "started"}:\n🎵 ${t.title}\n👤 ${t.author}`
        );
        pump(chatId);
        return;
      }
      const tracks = d.tracks ?? [];
      if (!tracks.length) throw new Error("Playlist came back empty — try a different link");
      const cap = 100; // safety valve for mega-playlists
      const list = tracks.slice(0, cap);
      enqueue(
        sess,
        list.map((t) => ({ track: t, quality: q }))
      );
      const msg = `✋ Manual mode · ${q}kbps — queueing ALL ${list.length}${tracks.length > cap ? ` (of ${tracks.length})` : ""} tracks:\n📋 ${d.title}`;
      if (placeholderId) await editMsg(chatId, placeholderId, msg);
      else await send(chatId, msg);
      pump(chatId);
      return;
    }

    if (d.type === "video") {
      const t = d.track;
      const busy = !!(sess.active || sess.queue.length);
      sess.pendingVideo = { track: t };
      const note = busy
        ? "\n\n(downloads are running — this one joins the queue)"
        : "";
      await send(
        chatId,
        `🎵 ${t.title}\n👤 ${t.author}${t.duration ? `\n⏱ ${t.duration}` : ""}${note}\n\nTap a quality to download:`,
        { reply_markup: kb(qualityRows(sess)) }
      );
      return;
    }

    // playlist → interactive picker (turn the ⏳ placeholder into the picker)
    const tracks = d.tracks ?? [];
    if (!tracks.length) throw new Error("Playlist came back empty — try a different link");
    sess.picker = {
      tracks,
      title: d.title,
      author: d.author,
      selected: new Set(),
      page: 0,
    };
    if (placeholderId) {
      await editMsg(chatId, placeholderId, pickerText(sess), { reply_markup: kb(pickerRows(sess)) });
    } else {
      await send(chatId, pickerText(sess), { reply_markup: kb(pickerRows(sess)) });
    }
  }

  /* ---------------- callback routing ---------------- */

  async function handleCallback(chatId, data, messageId, cbId) {
    const sess = getSession(chatId);

    // global: kill the active download + clear the whole queue
    if (data === "cancel") {
      sess.cancelRequested = true;
      sess.cancelWasUser = true;
      if (sess.active?.track && !jobKeyBusyElsewhere(chatId, sess.active.track.videoId, sess.active.quality)) {
        // nobody else needs this engine job — kill it for real
        await deps
          .api("/api/cancel", { videoId: sess.active.track.videoId, bitrate: sess.active.quality })
          .catch(() => {});
      }
      // (shared job: the other user's download keeps running; this chat just
      // abandons the rest of its queue and stops showing progress)
      await answerCb(cbId);
      return;
    }

    if (data === "retry") {
      const failed = sess.lastFailed.splice(0);
      if (!failed.length) return answerCb(cbId);
      enqueue(sess, failed.map((f) => ({ track: f.track, quality: f.quality })));
      await answerCb(cbId);
      await send(chatId, `🔁 Retrying ${failed.length} track${failed.length > 1 ? "s" : ""}…`);
      pump(chatId);
      return;
    }

    // remove one queue item (from the /cancel queue panel)
    if (data.startsWith("rm:")) {
      const idx = Number(data.slice(3));
      const removed = sess.queue.splice(idx, 1)[0];
      saveQueueState(sess.chatId, sess.queue);
      await answerCb(cbId);
      const panel = queuePanel(sess);
      await editMsg(chatId, messageId, `Removed: ${removed ? removed.track.title.slice(0, 50) : "—"}\n\n${panel.text}`, panel.markup);
      return;
    }

    if (data === "cx") {
      sess.picker = null;
      sess.pendingVideo = null;
      await answerCb(cbId);
      await editMsg(chatId, messageId, "✖ Cancelled. Send a new link anytime.");
      return;
    }

    if (data === "noop") return answerCb(cbId);

    // download-mode toggle (the ONE button that flips Auto ↔ Manual)
    if (data === "mode") {
      sess.mode = sess.mode === "manual" ? "auto" : "manual";
      saveChatState(chatId, { mode: sess.mode, quality: sess.quality });
      await answerCb(cbId);
      if (sess.picker) {
        await editMsg(chatId, messageId, pickerText(sess), { reply_markup: kb(pickerRows(sess)) });
      } else if (sess.pendingVideo) {
        const t = sess.pendingVideo.track;
        const note = sess.mode === "manual" ? "\n\n✋ Manual ON — next link downloads instantly." : "";
        await editMsg(
          chatId,
          messageId,
          `🎵 ${t.title}\n👤 ${t.author}${t.duration ? `\n⏱ ${t.duration}` : ""}${note}\n\nTap a quality to download:`,
          { reply_markup: kb(qualityRows(sess)) }
        );
      } else {
        await editMsg(chatId, messageId, modeText(sess), { reply_markup: kb([[modeBtn(sess)]]) });
      }
      return;
    }

    // quality taps (work for pending video AND for the open picker)
    if (data.startsWith("q:")) {
      const q = Number(data.slice(2));
      if (!QUALITIES.includes(q)) return answerCb(cbId);
      sess.quality = q;
      saveChatState(chatId, { quality: q, mode: sess.mode });

      if (sess.picker) {
        await answerCb(cbId);
        await editMsg(chatId, messageId, pickerText(sess), { reply_markup: kb(pickerRows(sess)) });
        return;
      }
      const pv = sess.pendingVideo;
      sess.pendingVideo = null;
      if (pv) {
        enqueue(sess, [{ track: pv.track, quality: q }]); // before awaits — cancel must see it
        await answerCb(cbId);
        pump(chatId);
      } else {
        await send(
          chatId,
          `🎚 Default quality set: ${q}kbps${sess.mode === "manual" ? " — links now download instantly (Manual mode)" : ""}`
        );
      }
      return;
    }

    // picker actions (with an expired-picker guard: analysis can take seconds,
    // and a tap that lands before the picker exists must not be silently lost)
    if (!sess.picker && /^(t:|all$|pgall$|p:|go$|qual$)/.test(data)) {
      await answerCb(cbId);
      await editMsg(chatId, messageId, "⌛ This track picker has expired — send the playlist link again.");
      return;
    }
    if (sess.picker) {
      const p = sess.picker;
      if (data.startsWith("t:")) {
        const idx = Number(data.slice(2));
        if (p.selected.has(idx)) p.selected.delete(idx);
        else p.selected.add(idx);
        await answerCb(cbId);
        await editMsg(chatId, messageId, pickerText(sess), { reply_markup: kb(pickerRows(sess)) });
        return;
      }
      if (data === "all") {
        p.selected = new Set(p.tracks.map((_, i) => i));
        await answerCb(cbId);
        await editMsg(chatId, messageId, pickerText(sess), { reply_markup: kb(pickerRows(sess)) });
        return;
      }
      if (data === "pgall") {
        const from = p.page * PAGE_SIZE;
        const to = Math.min(p.tracks.length, from + PAGE_SIZE);
        for (let i = from; i < to; i++) p.selected.add(i);
        await answerCb(cbId);
        await editMsg(chatId, messageId, pickerText(sess), { reply_markup: kb(pickerRows(sess)) });
        return;
      }
      if (data.startsWith("p:")) {
        p.page = Math.max(0, Number(data.slice(2)) || 0);
        await answerCb(cbId);
        await editMsg(chatId, messageId, pickerText(sess), { reply_markup: kb(pickerRows(sess)) });
        return;
      }
      if (data === "qual") {
        await answerCb(cbId);
        await editMsg(chatId, messageId,
          `🎚 Pick quality for this playlist — current: ${sess.quality}kbps`,
          { reply_markup: kb(qualityRows(sess)) });
        return;
      }
      if (data === "go") {
        const sel = p.selected.size ? [...p.selected].sort((a, b) => a - b) : p.tracks.map((_, i) => i);
        const jobs = sel.map((i) => ({ track: p.tracks[i], quality: sess.quality }));
        sess.picker = null;
        enqueue(sess, jobs); // synchronously FIRST — a /cancel arriving mid-edit must see the queue
        await answerCb(cbId);
        await editMsg(chatId, messageId, `📦 ${sel.length} track${sel.length > 1 ? "s" : ""} · ${sess.quality}kbps — starting queue…`);
        pump(chatId);
        return;
      }
    }

    await answerCb(cbId);
  }

  /* ---------------- text / commands ---------------- */

  async function handleText(chatId, rawText) {
    const text = String(rawText ?? "").trim();
    const sess = getSession(chatId);

    if (/^\/start/.test(text)) {
      return send(chatId, `👋 TuneLoad bot — buttons only, zero typing.\n\n${HELP}`, {
        reply_markup: kb([[modeBtn(sess)]]),
      });
    }
    if (/^\/help/.test(text)) {
      return send(chatId, HELP);
    }

    if (/^\/cancel/.test(text)) {
      const panel = queuePanel(sess);
      return send(chatId, panel.text, { reply_markup: panel.markup });
    }

    if (/^\/status/.test(text)) {
      const r = await deps.api("/api/status");
      const d = r.data ?? {};
      const q = d.queue ?? {};
      // REAL cookie verdicts (stored by the engine's YouTube probe) — honest
      // per-set state, never a canned "armed" line
      let cookieLine = "";
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "cookies", "sets.json"), "utf8"));
        const rows = Object.entries(meta)
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([id, m]) => {
            const v = m?.verify;
            if (!v) return `  set #${id} — ⏳ এখনো যাচাই হয়নি`;
            const ago = Math.max(0, Math.round((Date.now() - new Date(v.at).getTime()) / 60000));
            return v.ok
              ? `  set #${id} — ✅ কাজ করছে (${ago}মিনিট আগে যাচাই)`
              : `  set #${id} — ❌ বাদ (${v.kind === "auth" ? "YouTube reject" : v.kind}) · ${String(v.message).slice(0, 70)}`;
          });
        if (rows.length) cookieLine = `\nCookie sets (real):\n${rows.join("\n")}`;
      } catch { /* no meta file — skip */ }
      return send(
        chatId,
        `Engine: yt-dlp ${d.ytdlp ? "✅" : "❌"} · ffmpeg ${d.ffmpeg ? "✅" : "❌"} · cookie sets ${d.cookieSets ?? "—"}\nQueue: ${q.running ?? 0} running · ${q.waiting ?? 0} waiting${cookieLine}\nDownload mode: ${sess.mode === "manual" ? "✋ Manual" : "🤖 Auto"} · Default quality: ${sess.quality}kbps`
      );
    }

    if (/^\/mode/.test(text)) {
      return send(chatId, modeText(sess), { reply_markup: kb([[modeBtn(sess)]]) });
    }

    if (/^\/quality/.test(text)) {
      return send(chatId, "Tap a quality (also available on every link):", {
        reply_markup: kb([QUALITIES.map((x) => B(`${x} kbps`, `q:${x}`)), [modeBtn(sess)]]),
      });
    }

    const link = findYouTubeLink(text);
    if (link) {
      try {
        // playlists can take a while to analyze (full track list) — give the
        // user instant feedback and turn the placeholder into the picker
        const isPlaylist = /[?&]list=|\/playlist\?/.test(link);
        let placeholder = null;
        if (isPlaylist) {
          placeholder = await send(chatId, "⏳ Reading the playlist — fetching the full track list…");
        }
        await handleLink(chatId, link, placeholder?.message_id ?? null);
      } catch (e) {
        await send(chatId, `⚠️ ${String(e.message).slice(0, 300)}`);
      }
      return;
    }

    return send(chatId, "Send me a YouTube link (video or playlist) — everything else is buttons.");
  }

  // CRASH RECOVERY: any chat that had a pending queue when the bot died gets
  // it back — session is materialized (reviveQueue already ran), the user is
  // told what happened, and the queue RESUMES immediately.
  for (const [cid, st] of Object.entries(chatStore)) {
    if (Array.isArray(st.queue) && st.queue.length) {
      const sess = getSession(cid);
      if (!sess.queue.length) continue; // nothing survived validation
      deps
        .log(`restoring ${sess.queue.length} queued track(s) for chat ${cid} after restart`);
      send(cid, `🔄 Bot restarted — your queue (${sess.queue.length} track${sess.queue.length > 1 ? "s" : ""}) survived and is resuming now.`);
      pump(cid);
    }
  }

  return { handleText, handleCallback, sessions };
}

/* ------------------------------------------------------------------ */
/* main loop (long polling)                                            */
/* ------------------------------------------------------------------ */

async function main() {
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
  } catch {
    log("no data/tgbot.json — nothing to do, exiting");
    process.exit(0);
  }
  const token = cfg.token;
  if (!token) {
    log("config has no token — exiting");
    process.exit(0);
  }

  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch { /* noop */ }

  const me = await fetch(`${TG_BASE}/bot${token}/getMe`)
    .then((r) => r.json())
    .catch(() => null);
  if (!me?.ok) {
    log(`getMe failed: ${JSON.stringify(me).slice(0, 200)} — exiting so Settings shows disconnected`);
    process.exit(1);
  }
  log(`connected as @${me.result.username} — engine at ${API_BASE}`);

  const deps = realDeps(token);
  const bot = createBot(deps);

  let offset = 0;
  for (;;) {
    let res = null;
    try {
      const r = await fetch(
        `${TG_BASE}/bot${token}/getUpdates?timeout=25&offset=${offset}`,
        { signal: AbortSignal.timeout(35_000) }
      );
      res = await r.json();
    } catch {
      await sleep(2000);
      continue;
    }
    if (!res || !res.ok) {
      const code = res?.error_code;
      log(`getUpdates failed: ${res?.description ?? "unknown"}`);
      if (code === 401 || code === 409) process.exit(1); // bad token or duplicate poller
      await sleep(3000);
      continue;
    }
    if (res.result?.length) log(`updates: ${res.result.length} delivered (offset ${offset})`);
    for (const u of res.result ?? []) {
      offset = u.update_id + 1;

      // button taps → callback_query
      const cbq = u.callback_query;
      if (cbq?.message?.chat?.id != null && cbq.data) {
        const chatId = cbq.message.chat.id;
        const messageId = cbq.message.message_id;
        bot
          .handleCallback(chatId, cbq.data, messageId, cbq.id)
          .catch((e) => log(`callback error: ${e.message}`));
        continue;
      }

      const msg = u.message;
      if (!msg?.text) continue;
      const chatId = msg.chat?.id;
      // fire-and-forget so new links keep arriving (and queueing) while busy
      bot.handleText(chatId, msg.text).catch((e) => {
        log(`update error: ${e.message}`);
      });
    }
  }
}

const isMain =
  process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;

if (isMain) {
  main().catch((e) => {
    log(`fatal: ${e.message}`);
    process.exit(1);
  });
}
