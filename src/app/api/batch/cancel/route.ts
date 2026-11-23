import { NextRequest, NextResponse } from "next/server";
import { getBatch, cancelBatch } from "@/lib/ytd/batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST {id} — abort a running zip batch (kills the engine jobs and the stream) */
export async function POST(req: NextRequest) {
  let body: { id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const batch = getBatch(String(body.id ?? ""));
  if (!batch) return NextResponse.json({ error: "Unknown batch id" }, { status: 404 });
  const cancelled = cancelBatch(batch);
  return NextResponse.json({ ok: true, cancelled, status: batch.status });
}
