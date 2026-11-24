import { NextRequest, NextResponse } from "next/server";
import { parseYouTubeUrl, videoExists } from "@/lib/ytd/providers";
import { getVideoInfo, getPlaylistInfo } from "@/lib/ytd/meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const raw = (body.url ?? "").trim();
  if (!raw) return NextResponse.json({ error: "Missing 'url' field" }, { status: 400 });

  const { videoId, playlistId } = parseYouTubeUrl(raw);
  if (!videoId && !playlistId) {
    return NextResponse.json(
      { error: "Not a valid YouTube link. Paste a video, Shorts or playlist URL." },
      { status: 400 }
    );
  }

  // cheap existence probe (thumbnail 404) BEFORE the download stage — a dead
  // link fails here in ~1s with an honest message instead of 65s of retries.
  // Started now and awaited where needed so the pure-video path can run the
  // metadata fetch in PARALLEL with the probe (saves ~0.5-1s per single link)
  const existsP: Promise<boolean | null> = videoId
    ? videoExists(videoId)
    : Promise.resolve(true);

  // playlist first when present (watch links may carry &list=)
  if (playlistId) {
    const exists = await existsP;
    if (exists === false) {
      return NextResponse.json(
        { error: "This video doesn't exist — it was removed or the ID is wrong." },
        { status: 404 }
      );
    }
    try {
      const info = await getPlaylistInfo(playlistId, videoId);
      return NextResponse.json(info);
    } catch (e) {
      // fall through to single video if playlist fails but video exists
      if (!videoId) {
        return NextResponse.json(
          { error: `Playlist unavailable: ${(e as Error).message}` },
          { status: 404 }
        );
      }
    }
  }

  if (videoId) {
    const [exists, info] = await Promise.all([existsP, getVideoInfo(videoId)]);
    if (exists === false) {
      return NextResponse.json(
        { error: "This video doesn't exist — it was removed or the ID is wrong." },
        { status: 404 }
      );
    }
    return NextResponse.json(info);
  }
  return NextResponse.json({ error: "Could not resolve link" }, { status: 400 });
}
