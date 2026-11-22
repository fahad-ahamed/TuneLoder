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
  return {
    tgCall: async (method, params) => {
      const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params ?? {}),
        signal: AbortSignal.timeout(30_000),
      });
      const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
      if (!j.ok) throw new Error(`tg ${method}: ${j.description ?? r.status}`);
      return j.result;
    },

    sendAudio: async (chatId, filePath, meta) => {
      const buf = fs.readFileSync(filePath);
      const fd = new FormData();
      fd.append("chat_id", String(chatId));
      fd.append("audio", new Blob([buf], { type: "audio/mpeg" }), meta.filename);
      if (meta.title) fd.append("title", String(meta.title).slice(0, 64));
      if (meta.author) fd.append("performer", String(meta.author).slice(0, 64));
      const caption = `${meta.title}${meta.part ? ` · ${meta.part}` : ""} · ${meta.bitrate}kbps · TuneLoad`;
      fd.append("caption", caption.slice(0, 900));
      const r = await fetch(`https://api.telegram.org/bot${token}/sendAudio`, {
        method: "POST",
        body: fd,
        signal: AbortSignal.timeout(120_000),
      });
      const j = await r.json().catch(() => ({ ok: false }));
      if (!j.ok) throw new Error(`tg sendAudio: ${j.description ?? r.status}`);
      return j.result;
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
      const r = await fetch(`${API_BASE}${route}`, init);
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data };
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
  "• live progress while downloading, Cancel anytime",
  "• sending another link while busy → it's queued automatically",
  "",
  "Handy commands: /cancel (queue panel) · /status · /help",
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

export function createBot(deps) {
  /** chatId → session */
  const sessions = new Map();
  const getSession = (chatId) => {
    if (!sessions.has(chatId)) {
      sessions.set(chatId, {
        quality: 320,        // default quality (sticky, chosen via buttons)
        picker: null,        // { tracks, selected:Set, page }
        pendingVideo: null,  // { track } awaiting quality choice
        queue: [],           // [{ track, quality }]
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
    try {
      await deps.tgCall("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(markup ? { reply_markup: markup } : {}),
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

  function enqueue(sess, jobs) {
    sess.queue.push(...jobs);
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
      try {
        if (statusMsgId) {
          sess.editAt = Date.now();
          await editMsg(chatId, statusMsgId, `📤 ${posLabel} · ${title}\n📤 sending to Telegram…`);
        }
        const partsSent = await sendMaybeChunked(chatId, file, {
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
        deps.removeFile(file); // auto-clean: server copy deleted right after send
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

  async function handleLink(chatId, url) {
    const sess = getSession(chatId);
    const info = await deps.api("/api/info", { url });
    if (!info.ok) throw new Error(info.data?.error || "Could not read that link");
    const d = info.data;

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

    // playlist → interactive picker
    const tracks = d.tracks ?? [];
    if (!tracks.length) throw new Error("Playlist came back empty — try a different link");
    sess.picker = {
      tracks,
      title: d.title,
      author: d.author,
      selected: new Set(),
      page: 0,
    };
    await send(chatId, pickerText(sess), { reply_markup: kb(pickerRows(sess)) });
  }

  /* ---------------- callback routing ---------------- */

  async function handleCallback(chatId, data, messageId, cbId) {
    const sess = getSession(chatId);

    // global: kill the active download + clear the whole queue
    if (data === "cancel") {
      sess.cancelRequested = true;
      sess.cancelWasUser = true;
      if (sess.active?.track) {
        await deps
          .api("/api/cancel", { videoId: sess.active.track.videoId, bitrate: sess.active.quality })
          .catch(() => {});
      }
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

    // quality taps (work for pending video AND for the open picker)
    if (data.startsWith("q:")) {
      const q = Number(data.slice(2));
      if (!QUALITIES.includes(q)) return answerCb(cbId);
      sess.quality = q;

      if (sess.picker) {
        await answerCb(cbId);
        await editMsg(chatId, messageId, pickerText(sess), { reply_markup: kb(pickerRows(sess)) });
        return;
      }
      const pv = sess.pendingVideo;
      sess.pendingVideo = null;
      await answerCb(cbId);
      if (pv) {
        enqueue(sess, [{ track: pv.track, quality: q }]);
        pump(chatId);
      } else {
        await send(chatId, `🎚 Default quality set: ${q}kbps`);
      }
      return;
    }

    // picker actions
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
        await answerCb(cbId);
        await editMsg(chatId, messageId, `📦 ${sel.length} track${sel.length > 1 ? "s" : ""} · ${sess.quality}kbps — starting queue…`);
        enqueue(sess, jobs);
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
      return send(chatId, `👋 TuneLoad bot — buttons only, zero typing.\n\n${HELP}`);
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
      return send(
        chatId,
        `Engine: yt-dlp ${d.ytdlp ? "✅" : "❌"} · ffmpeg ${d.ffmpeg ? "✅" : "❌"} · cookie sets ${d.cookieSets ?? "—"}\nQueue: ${q.running ?? 0} running · ${q.waiting ?? 0} waiting\nDefault quality: ${sess.quality}kbps`
      );
    }

    if (/^\/quality/.test(text)) {
      return send(chatId, "Tap a quality (also available on every link):", {
        reply_markup: kb([QUALITIES.map((x) => B(`${x} kbps`, `q:${x}`))]),
      });
    }

    const link = findYouTubeLink(text);
    if (link) {
      try {
        await handleLink(chatId, link);
      } catch (e) {
        await send(chatId, `⚠️ ${String(e.message).slice(0, 300)}`);
      }
      return;
    }

    return send(chatId, "Send me a YouTube link (video or playlist) — everything else is buttons.");
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

  const me = await fetch(`https://api.telegram.org/bot${token}/getMe`)
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
        `https://api.telegram.org/bot${token}/getUpdates?timeout=25&offset=${offset}`,
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
