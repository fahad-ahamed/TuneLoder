import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";
import { resolveAudio, convertToMp3, cookiesEnabled } from "@/lib/ytd/providers";
import { hasInternalKey } from "@/lib/ytd/internalkey";
import { startSweeper, scheduleRemoval } from "@/lib/ytd/cleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ALLOWED_BITRATES = [320, 256, 192, 128, 96, 64];

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

/**
 * Internal endpoint used by the Telegram bot: same engine as /api/download
 * (cookie-set auto-switch included) but returns JSON with the on-disk path
 * instead of streaming. Protected by the shared internal key
 * (data/internal-key.json → header `x-internal-key`) — it used to expose
 * server file paths with no auth at all.
 */
export async function POST(req: NextRequest) {
  if (!hasInternalKey(req)) {
    return Response.json({ ok: false, error: "Not authorized (missing internal key)" }, { status: 401 });
  }
  let body: {
    videoId?: string;
    bitrate?: number;
    title?: string;
    author?: string;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const videoId = (body.videoId ?? "").trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return Response.json({ ok: false, error: "Missing or invalid videoId" }, { status: 400 });
  }
  const bitrate = ALLOWED_BITRATES.includes(Number(body.bitrate)) ? Number(body.bitrate) : 320;
  const title = (body.title ?? "").slice(0, 200) || `YouTube ${videoId}`;
  const author = (body.author ?? "").slice(0, 200) || "Unknown";

  startSweeper();

  const resolved = await resolveAudio(videoId, bitrate);

  if (resolved.cancelled) {
    return Response.json({ ok: false, error: "Cancelled", cancelled: true }, { status: 422 });
  }

  if (resolved.provider === "none") {
    // honest messages per failure class — never blame cookies for a dead video
    const hint =
      resolved.kind === "video"
        ? "This video can't be downloaded — it's private, removed, age-restricted or not a video."
        : cookiesEnabled()
          ? resolved.kind === "rate"
            ? "YouTube is rate-limiting the server — try again in a minute."
            : "All cookie sets were rejected — add a fresh cookies.txt via Settings."
          : "Server IP rate-limited — add cookies via Settings.";
    return Response.json(
      {
        ok: false,
        error: resolved.kind === "video" ? "This video is unavailable." : "All providers failed on this network.",
        hint,
        kind: resolved.kind ?? "unknown",
        logs: resolved.logs.slice(-6),
      },
      { status: resolved.kind === "video" ? 404 : 422 }
    );
  }

  let mp3File: string | null = null;
  try {
    if (resolved.localFile) {
      mp3File = resolved.localFile;
    } else if (resolved.streamUrl) {
      if (resolved.container === "mp3") {
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
        mp3File = await convertToMp3(
          { kind: "url", url: resolved.streamUrl },
          { bitrate, title, author }
        );
      }
    }
    if (!mp3File || !fs.existsSync(mp3File)) throw new Error("no output produced");

    const size = fs.statSync(mp3File).size;

    // safety net: if the bot dies before deleting, this still cleans up
    // (20 min — generous enough for the chunk-splitter to send many parts)
    scheduleRemoval(mp3File, 20 * 60_000);

    return Response.json({
      ok: true,
      path: mp3File,
      filename: `${safeName(title, "youtube-audio")} [${bitrate}kbps].mp3`,
      size,
      bitrate,
      provider: resolved.provider,
      cached: resolved.cached === true,
    });
  } catch (e) {
    if (mp3File) scheduleRemoval(mp3File, 5_000);
    return Response.json(
      { ok: false, error: `Conversion failed: ${(e as Error).message}`, logs: resolved.logs.slice(-6) },
      { status: 422 }
    );
  }
}
