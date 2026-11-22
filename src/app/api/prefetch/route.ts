import { NextRequest } from "next/server";
import { resolveAudio, prefetchStatus } from "@/lib/ytd/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_BITRATES = [320, 256, 192, 128, 96, 64];

/**
 * Fire-and-forget cache warmer: the moment a link is analyzed (single video),
 * the UI calls this so the MP3 is already on disk when the user clicks
 * "Download" — the click then completes in ~1s instead of ~20s.
 */
export async function POST(req: NextRequest) {
  let body: { videoId?: string; bitrate?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const videoId = (body.videoId ?? "").trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return Response.json({ error: "Missing or invalid videoId" }, { status: 400 });
  }
  const bitrate = ALLOWED_BITRATES.includes(Number(body.bitrate)) ? Number(body.bitrate) : 320;

  const st = prefetchStatus(videoId, bitrate);
  if (st === "cached") return Response.json({ status: "cached" });
  if (st === "running") return Response.json({ status: "running" });

  void resolveAudio(videoId, bitrate).catch(() => {});
  return Response.json({ status: "started" });
}
