/**
 * REAL cookie verification — no more "format looks fine → armed".
 *
 * When a cookie set or a direct sign-in paste is added (or re-verified), we run
 * an actual yt-dlp resolve against a stable probe video WITH those cookies and
 * report what YouTube REALLY said:
 *   ok        → metadata came back: the session genuinely works from this server
 *   auth      → YouTube rejected it ("Sign in to confirm you're not a bot",
 *               login missing/expired) → the paste is REJECTED, set removed
 *   rate      → YouTube is throttling the server IP right now (not the cookie)
 *   video     → probe video problem (not the cookie's fault) — retry other probe
 *   transient → network/timeout hiccup
 * The verdict is stored per set (data/cookies/sets.json → providers.ts) and
 * surfaced in the admin dashboard, /api/cookies, /api/ytauth, the verify
 * endpoint and the Telegram bot's /status — every human-visible message is the
 * real outcome, never a canned "success".
 */

import { spawn } from "child_process";
import fs from "fs";
import { engineBinaries, JS_RUNTIME } from "./providers";

/** ultra-stable probe videos (BaW_jenozKc was removed by YouTube — retired) */
const PROBE_VIDEOS = ["jNQXAC9IVRw", "dQw4w9WgXcQ"];

export type ProbeKind = "ok" | "auth" | "rate" | "video" | "transient";
export type ProbeResult = {
  ok: boolean;
  kind: ProbeKind;
  /** the REAL message — YouTube's own error text on failure, video title on success */
  message: string;
  seconds?: number;
};

const isAuthFailure = (msg: string) =>
  /sign in to confirm|not a bot|login required|please sign in|cookies (have )?expired/i.test(msg);
const isRateLimit = (msg: string) => /429|too many requests|rate.?limit|throttl/i.test(msg);
const isVideoProblem = (msg: string) =>
  /private video|members?.?only|age.?restrict|video (is )?unavailable|removed by|premiere|does not exist|no longer available/i.test(msg);
// SABR-forced pages / empty format lists are an EXTRACTION problem (yt-dlp
// issue #12482), not proof the cookies are dead. The old regexes ("confirm you",
// "use --cookies") matched these errors' own HELP TEXT and hard-rejected LIVE
// sessions — exactly the false verdict this module exists to prevent.
const isFormatProblem = (msg: string) =>
  /no video formats|missing a URL|SABR/i.test(msg);

function classify(stderr: string, code: number | null): { kind: ProbeKind; message: string } {
  const tail =
    stderr.split("\n").filter((l) => l.trim()).slice(-6).join(" | ").slice(0, 380) ||
    `yt-dlp exited ${code}`;
  if (isFormatProblem(stderr)) return { kind: "video", message: tail };
  if (isAuthFailure(stderr)) {
    const m = stderr.match(/ERROR:\s*(.{10,160}?)(?:\s*$|\.)/i)?.[1] ?? tail;
    return { kind: "auth", message: m.trim() };
  }
  if (isRateLimit(stderr)) return { kind: "rate", message: tail };
  if (isVideoProblem(stderr)) return { kind: "video", message: tail };
  return { kind: "transient", message: tail };
}

/**
 * Run one probe. Resolves ALWAYS — engine errors are verdicts, not exceptions.
 * `extraArgs` lets the caller retry with cookie-capable alternate player clients.
 */
function probeOnce(videoId: string, cookieFile: string, timeoutMs: number, extraArgs: string[] = []): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const { ytdlp } = engineBinaries();
    const args = [
      "--cookies", cookieFile,
      "--js-runtimes", JS_RUNTIME,
      // solve YouTube n-challenges (web formats disappear without the solver);
      // ejs:github downloads the version-matched script when no local
      // yt-dlp-ejs distribution is installed — cached after the first run
      "--remote-components", "ejs:github",
      "--force-ipv4",
      "--no-warnings",
      "--skip-download",
      "--no-playlist",
      "--socket-timeout", "15",
      "--retries", "1",
      "--extractor-retries", "1",
      ...extraArgs,
      "--print", "%(title)s|%(duration)s",
      `https://www.youtube.com/watch?v=${videoId}`,
    ];
    let out = "";
    let stderr = "";
    const child = spawn(ytdlp, args);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* noop */ }
      resolve({ ok: false, kind: "transient", message: "probe timeout — নেটওয়ার্ক ধীর; আবার যাচাই করুন" });
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, kind: "transient", message: `yt-dlp spawn failed: ${e.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const line = out.trim().split("\n").filter(Boolean).pop() ?? "";
      const [title, dur] = line.split("|");
      if (code === 0 && title) {
        resolve({
          ok: true,
          kind: "ok",
          message: `YouTube metadata পড়া গেছে ✓ "${title.slice(0, 70)}"`,
          seconds: Number.isFinite(Number(dur)) ? Number(dur) : undefined,
        });
      } else {
        resolve({ ok: false, ...classify(stderr, code) });
      }
    });
  });
}

/** Probe a cookies.txt file against YouTube — real verdict, honest message. */
export async function probeCookieFile(cookieFile: string): Promise<ProbeResult> {
  if (!fs.existsSync(cookieFile)) {
    return { ok: false, kind: "transient", message: "cookie file missing" };
  }
  // ladder mirrors the download engine: default web client first, then the
  // cookie-capable SABR-safe clients (yt-dlp #12482), before giving up on a video
  const CLIENT_LADDER: string[][] = [
    [],
    ["--extractor-args", "youtube:player_client=web_creator,tv_embedded,mweb"],
  ];
  let last: ProbeResult | null = null;
  for (const vid of PROBE_VIDEOS) {
    for (const extra of CLIENT_LADDER) {
      last = await probeOnce(vid, cookieFile, 75_000, extra);
      if (last.ok) return last;
      if (last.kind === "auth" || last.kind === "rate") return last; // cookie's fate is decided
      // format/transient → try the cookie-capable alt clients, then next video
    }
  }
  return last ?? { ok: false, kind: "transient", message: "probe failed" };
}
