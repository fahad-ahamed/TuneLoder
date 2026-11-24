import { NextRequest, NextResponse } from "next/server";
import {
  parseSpotifyUrl,
  getSpotifyEntity,
  matchOnYouTube,
  mapPool,
  type SpotifyEntity,
  type SpotifyMetaTrack,
  type YtMatch,
} from "@/lib/spotify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MATCH_POOL = 6; // parallel ytsearch jobs (flat list lookups, no download)

/**
 * POST { url } — Spotify track/album/playlist link.
 * Returns the same shape the page already consumes from /api/info
 * ({ type: "video" | "playlist", ... }) so the UI and download flows stay
 * identical; each track's videoId is the best YouTube match for the Spotify
 * song, while title/author/thumbnail keep the SPOTIFY metadata.
 */
export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const url = String(body.url ?? "").trim();
  const parsed = parseSpotifyUrl(url);
  if (!parsed) {
    return NextResponse.json(
      { error: "Not a Spotify link — paste an open.spotify.com track/album/playlist URL" },
      { status: 400 }
    );
  }

  let entity: SpotifyEntity;
  try {
    entity = await getSpotifyEntity(parsed.kind, parsed.id);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 422 });
  }

  if (!entity.tracks.length) {
    return NextResponse.json({ error: "Spotify entity has no tracks — it may be private or empty" }, { status: 422 });
  }

  // de-dup identical songs before matching (same title+author+duration)
  const seen = new Set<string>();
  const unique: SpotifyMetaTrack[] = entity.tracks.filter((t) => {
    const k = `${t.title}|${t.author}|${t.durationMs ?? 0}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // match each Spotify song to a YouTube upload (fixed pool, honest failures)
  const matched: { meta: SpotifyMetaTrack; match: YtMatch | null }[] = await mapPool(unique, MATCH_POOL, async (t) => {
    const query = `${t.author} ${t.title} audio`.replace(/\s+/g, " ").trim();
    const m = await matchOnYouTube(query);
    return { meta: t, match: m };
  });

  const tracks = matched
    .filter((r) => r.match)
    .map((r) => ({
      videoId: r.match!.videoId,
      title: r.meta.title,
      author: r.meta.author,
      thumbnail: entity.cover || `https://i.ytimg.com/vi/${r.match!.videoId}/hqdefault.jpg`,
      duration: r.meta.durationMs ? undefined : r.match?.duration,
    }));

  if (!tracks.length) {
    return NextResponse.json(
      { error: "No YouTube matches found for these Spotify songs — try again" },
      { status: 422 }
    );
  }

  const isVideo = parsed.kind === "track";
  return NextResponse.json({
    type: isVideo ? "video" : "playlist",
    kind: entity.kind,
    playlistId: `spotify:${entity.kind}:${entity.id}`,
    title: entity.title,
    author: entity.author,
    thumbnail: entity.cover,
    trackCount: unique.length,
    matchedCount: tracks.length,
    source: entity.source,
    // video shape uses `track`; playlist shape uses `tracks`
    ...(isVideo ? { track: tracks[0] } : { tracks }),
  });
}
