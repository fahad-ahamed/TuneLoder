import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/ytd/admin";
import { listCookieSets, cookieSetPath, cookieSetVerdict, saveCookieVerdict, orderedCookieSets } from "@/lib/ytd/providers";
import { probeCookieFile } from "@/lib/ytd/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/cookies/verify — RE-verify existing cookie sets against YouTube
 * RIGHT NOW and store the real verdict per set. Body: { id?: number } — one
 * set or all. Response: per-set real results (YouTube's own words on failure).
 */
export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Admin login required" }, { status: 401 });
  }
  let body: { id?: number } = {};
  try {
    body = await req.json();
  } catch { /* verify all */ }

  const all = listCookieSets();
  const targets = Number.isInteger(body?.id) && all.includes(body.id!) ? [body.id!] : all;
  if (!targets.length) {
    return NextResponse.json({ error: "No cookie sets to verify" }, { status: 400 });
  }

  const results = [];
  for (const id of targets) {
    const r = await probeCookieFile(cookieSetPath(id));
    const verdict = { at: new Date().toISOString(), ok: r.ok, kind: r.kind, message: r.message };
    saveCookieVerdict(id, verdict);
    results.push({ id, ...verdict });
  }

  return NextResponse.json({
    ok: results.every((x) => x.ok),
    results,
    armedSets: orderedCookieSets(),
  });
}

/** GET /api/cookies/verify — verdicts only (no probe), cheap for polling UIs. */
export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Admin login required" }, { status: 401 });
  }
  return NextResponse.json({
    sets: listCookieSets().map((id) => ({ id, verify: cookieSetVerdict(id) ?? null })),
    armedSets: orderedCookieSets(),
  });
}
