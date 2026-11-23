import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { resolveAudio, convertToMp3, cookiesEnabled, AUDIO_CACHE_DIR } from "@/lib/ytd/providers";
import { updateJob, jobKey } from "@/lib/ytd/jobs";
import { startSweeper, scheduleRemoval } from "@/lib/ytd/cleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ALLOWED_BITRATES = [320, 256, 192, 128, 96, 64];
const AUTO_CLEAN_GRACE_MS = 60_000; // server copy deleted ~60s after the download completes

function safeName(s: string, fallback: string): string {
  const clean = s
    .normalize("NFKD")
    // \p{M} = vowel signs / combining marks — without it Bangla names lose their কার ("মন মাঝে" → "মন মঝ")
    .replace(/[^\p{L}\p{N}\p{M} ()\-'.,&]/gu, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean || fallback;
}

export async function POST(req: NextRequest) {
  let body: {
    videoId?: string;
    bitrate?: number;
    title?: string;
    author?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const videoId = (body.videoId ?? "").trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return new Response(JSON.stringify({ error: "Missing or invalid videoId" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const bitrate = ALLOWED_BITRATES.includes(Number(body.bitrate)) ? Number(body.bitrate) : 320;
  const title = (body.title ?? "").slice(0, 200) || `YouTube ${videoId}`;
  const author = (body.author ?? "").slice(0, 200) || "Unknown";

  startSweeper();

  // 1) resolve an audio source via the provider chain (cookie sets auto-switch)
  const resolved = await resolveAudio(videoId, bitrate);

  if (resolved.cancelled) {
    return new Response(
      JSON.stringify({ error: "Cancelled", cancelled: true }),
      { status: 422, headers: { "Content-Type": "application/json" } }
    );
  }

  if (resolved.provider === "none") {
    // honest failure messages per failure class (the old text blamed cookie
    // sets even when the video itself was the problem)
    const messages: Record<string, { error: string; hint: string }> = {
      video: {
        error: "This video can't be downloaded — it's private, removed, age-restricted or not a video.",
        hint: "Double-check the link in YouTube. No cookie set can fix a missing video.",
      },
      auth: {
        error: "All providers failed on this network.",
        hint: cookiesEnabled()
          ? "All cookie sets were rejected by YouTube. Admin: open /admin → Cookie sets and paste a fresh cookies.txt (one fresh set is enough — the engine auto-switches)."
          : "This server's IP is rate-limited by YouTube. Admin: open /admin → Cookie sets, paste a cookies.txt (30-second fix) and retry.",
      },
      rate: {
        error: "YouTube is rate-limiting this server right now.",
        hint: "Try again in a minute — the engine already waited out the cooldowns. Cookies help: /admin → Cookie sets.",
      },
      timeout: {
        error: "The download timed out.",
        hint: "The network or YouTube was too slow — retry once; the engine keeps partial progress out of the cache.",
      },
      network: {
        error: "Network failure while contacting the providers.",
        hint: "Check the server's internet connection, then retry.",
      },
    };
    const m = messages[resolved.kind ?? ""] ?? messages.auth;
    return new Response(
      JSON.stringify({
        error: m.error,
        hint: m.hint,
        kind: resolved.kind ?? "unknown",
        logs: resolved.logs.slice(-6),
      }),
      { status: resolved.kind === "video" ? 404 : 422, headers: { "Content-Type": "application/json" } }
    );
  }

  // 2) produce final mp3
  let mp3File: string | null = null;
  let isCached = resolved.cached === true;
  try {
    if (resolved.localFile) {
      mp3File = resolved.localFile;
    } else if (resolved.streamUrl) {
      if (resolved.container === "mp3") {
        // mirror returned a ready mp3 → download bytes
        const res = await fetch(resolved.streamUrl, {
          headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" },
          signal: AbortSignal.timeout(180_000),
        });
        if (!res.ok) throw new Error(`provider stream HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 10_000) throw new Error("provider stream too small");
        fs.mkdirSync(path.join(process.cwd(), ".tmp-downloads"), { recursive: true });
        mp3File = path.join(process.cwd(), ".tmp-downloads", `${videoId}-${Date.now()}.mp3`);
        fs.writeFileSync(mp3File, buf);
      } else {
        // m4a/webm source → ffmpeg convert
        mp3File = await convertToMp3(
          { kind: "url", url: resolved.streamUrl },
          { bitrate, title, author }
        );
      }
    }
    if (!mp3File || !fs.existsSync(mp3File)) throw new Error("no output produced");

    const size = fs.statSync(mp3File).size;
    const fileName = `${safeName(`${title}`, "youtube-audio")} [${bitrate}kbps].mp3`;

    // stream from disk (memory-safe for big files)
    const nodeStream = fs.createReadStream(mp3File);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    // honesty marker: when the response body has been fully streamed the job
    // is flagged delivered → the UI shows "Sent to your browser ✓" (a served
    // stream can still be lost in the browser's download manager)
    nodeStream.on("close", () => {
      updateJob(jobKey(videoId, bitrate), { delivered: true });
    });

    // AUTO-CLEAN: temp/converted copies are deleted shortly after serving.
    // The engine cache copy (data/audio) is NOT — the sweeper's cache TTL
    // (60 min) owns it, so repeat downloads still land on the cache.
    const isCacheCopy = mp3File.startsWith(AUDIO_CACHE_DIR);
    const cleanupFile = mp3File; // narrowed const for the stream callbacks
    const cleanup = (ms: number) => {
      if (!isCacheCopy) scheduleRemoval(cleanupFile, ms);
    };
    nodeStream.on("close", () => cleanup(AUTO_CLEAN_GRACE_MS));
    nodeStream.on("error", () => cleanup(AUTO_CLEAN_GRACE_MS));

    return new Response(webStream, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(size),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "Cache-Control": "no-store",
        "X-Provider": resolved.provider,
        "X-Cache": isCached ? "hit" : "miss",
      },
    });
  } catch (e) {
    if (mp3File) scheduleRemoval(mp3File!, 5_000);
    return new Response(
      JSON.stringify({ error: `Conversion failed: ${(e as Error).message}`, logs: resolved.logs.slice(-6) }),
      { status: 422, headers: { "Content-Type": "application/json" } }
    );
  }
}
