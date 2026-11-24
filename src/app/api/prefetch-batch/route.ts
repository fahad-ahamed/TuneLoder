import { NextRequest } from "next/server";
import { resolveAudio, prefetchStatus } from "@/lib/ytd/providers";
import { getSettings } from "@/lib/ytd/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_BITRATES = [320, 256, 192, 128, 96, 64];
const MAX_BATCH = 150;

/**
 * Playlist cache warmer (admin opt-in: Engine settings → auto-prefetch ON).
 * After a playlist is analyzed the site posts the track list; the engine queue
 * prepares the MP3s in the background (serialized through the same gate, so it
 * never hammers YouTube). Clicking Download then lands on the on-disk cache.
 */
export async function POST(req: NextRequest) {
  if (!getSettings().autoPrefetchPlaylist) {
    return Response.json({ error: "Playlist prefetch is disabled in admin settings" }, { status: 403 });
  }
  let body: { videoIds?: string[]; bitrate?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const bitrate = ALLOWED_BITRATES.includes(Number(body.bitrate)) ? Number(body.bitrate) : 320;
  const ids = [
    ...new Set(
      (body.videoIds ?? [])
        .map((s) => String(s).trim())
        .filter((s) => /^[a-zA-Z0-9_-]{11}$/.test(s))
    ),
  ].slice(0, MAX_BATCH);

  let queued = 0;
  for (const id of ids) {
    const st = prefetchStatus(id, bitrate);
    if (st !== "idle") continue;
    queued++;
    void resolveAudio(id, bitrate).catch(() => {});
  }
  return Response.json({ ok: true, queued, total: ids.length, bitrate });
}
