import { NextRequest } from "next/server";
import { resolveAudio, prefetchStatus, inFlightCount } from "@/lib/ytd/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_BITRATES = [320, 256, 192, 128, 96, 64];
const MAX_INFLIGHT_ENGINE = 24; // global engine queue cap
const MAX_PER_IP = 8; // per-client in-flight prefetch cap
const WINDOW_MS = 10 * 60_000;

/* tiny per-IP in-flight registry — /api/prefetch is unauthenticated, so an
   unbounded queue would let anyone flood the engine with hundreds of jobs */
const gIp = globalThis as unknown as { __tlIpPrefetch?: Map<string, { n: number; at: number }> };
function ipMap(): Map<string, { n: number; at: number }> {
  return gIp.__tlIpPrefetch ?? (gIp.__tlIpPrefetch = new Map<string, { n: number; at: number }>());
}
function ipCount(ip: string, delta: number): number {
  const m = ipMap();
  const e = m.get(ip);
  if (!e || Date.now() - e.at > WINDOW_MS) {
    if (e) m.delete(ip);
    if (delta <= 0) return 0;
    m.set(ip, { n: delta, at: Date.now() });
    return delta;
  }
  e.n = Math.max(0, e.n + delta);
  e.at = Date.now();
  if (e.n === 0) m.delete(ip);
  return e.n;
}

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

  // queue caps: the engine gate is finite — a flood of prefetches would just
  // starve real users (and the old code had NO limit at all)
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
  if (inFlightCount() >= MAX_INFLIGHT_ENGINE) {
    return Response.json({ error: "Engine is busy — try again shortly", busy: true }, { status: 429 });
  }
  if (ipCount(ip, 0) >= MAX_PER_IP) {
    return Response.json({ error: "Too many pending downloads from this client", busy: true }, { status: 429 });
  }

  ipCount(ip, 1);
  void resolveAudio(videoId, bitrate)
    .catch(() => {})
    .finally(() => ipCount(ip, -1));
  return Response.json({ status: "started" });
}
