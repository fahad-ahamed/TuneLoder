import { NextRequest } from "next/server";
import { cancelJob } from "@/lib/ytd/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cancel an in-flight engine job (used by the Telegram bot's Cancel button and
 * the site's per-track cancel). Kills the running yt-dlp child; the download
 * route that started it will return {"error":"Cancelled"}.
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
  const bitrate = [320, 256, 192, 128, 96, 64].includes(Number(body.bitrate))
    ? Number(body.bitrate)
    : 320;
  cancelJob(videoId, bitrate);
  return Response.json({ ok: true });
}
