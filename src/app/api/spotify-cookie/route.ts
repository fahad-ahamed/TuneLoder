import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/ytd/admin";
import { getSpotifyCookie, saveSpotifyCookie } from "@/lib/spotify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json({ error: "Admin login required" }, { status: 401 });
}

/** GET — does a Spotify sp_dc cookie exist (never returns the cookie itself) */
export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return unauthorized();
  const cookie = getSpotifyCookie();
  return NextResponse.json({
    cookieSet: !!cookie,
    preview: cookie ? `${cookie.slice(0, 14)}… (${cookie.length} chars)` : null,
  });
}

/** POST { cookie } — save/clear the sp_dc cookie string ("sp_dc=…" or just the value) */
export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) return unauthorized();
  let body: { cookie?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const cookie = String(body.cookie ?? "").trim();
  saveSpotifyCookie(cookie);
  return NextResponse.json({
    cookieSet: !!cookie,
    preview: cookie ? `${cookie.slice(0, 14)}… (${cookie.length} chars)` : null,
  });
}
