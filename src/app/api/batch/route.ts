import { NextRequest, NextResponse } from "next/server";
import { createBatch, getBatch, batchView } from "@/lib/ytd/batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_BITRATES = [320, 256, 192, 128, 96, 64];

/**
 * POST — prepare a batch from the current selection (engine NOT started yet).
 * The page calls this whenever the selection/quality changes, so the actual
 * "Download" click can be a single guaranteed navigation (see download-zip).
 */
export async function POST(req: NextRequest) {
  let body: {
    items?: Array<{ videoId?: string; title?: string; author?: string }>;
    bitrate?: number;
    title?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const bitrate = ALLOWED_BITRATES.includes(Number(body.bitrate)) ? Number(body.bitrate) : 320;
  const items = (body.items ?? [])
    .map((t) => ({
      videoId: String(t.videoId ?? "").trim(),
      title: String(t.title ?? "").slice(0, 200),
      author: String(t.author ?? "").slice(0, 200),
    }))
    .filter((t) => /^[a-zA-Z0-9_-]{11}$/.test(t.videoId));

  if (!items.length) {
    return NextResponse.json({ error: "No valid tracks in the selection" }, { status: 400 });
  }

  const batch = createBatch({ bitrate, title: body.title ?? "Playlist", items });
  return NextResponse.json({ ok: true, id: batch.id, count: batch.items.length });
}

/** GET /api/batch?id=… — poll item progress while the zip is being built */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const batch = getBatch(id);
  if (!batch) return NextResponse.json({ error: "Unknown batch id" }, { status: 404 });
  return NextResponse.json(batchView(batch));
}
