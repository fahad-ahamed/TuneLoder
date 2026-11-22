import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { isAdminRequest } from "@/lib/ytd/admin";
import {
  COOKIE_DIR,
  listCookieSets,
  cookieSetPath,
  cookieSetsInfo,
  cookiesEnabled,
  activeCookieSet,
} from "@/lib/ytd/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json({ error: "Admin login required" }, { status: 401 });
}

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return unauthorized();
  const sets = cookieSetsInfo();
  return NextResponse.json({
    enabled: sets.length > 0,
    count: sets.length,
    activeSet: activeCookieSet(),
    sets,
  });
}

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) return unauthorized();
  let body: { content?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const content = (body.content ?? "").trim();
  if (!content) return NextResponse.json({ error: "Missing 'content' field" }, { status: 400 });

  // sanity check netscape cookie format
  const hasYouTubeDomain = /youtube\.com/.test(content);
  const hasCookieLines = content
    .split("\n")
    .some((l) => l.trim() && !l.startsWith("#") && l.split("\t").length >= 6);
  if (!hasYouTubeDomain || !hasCookieLines) {
    return NextResponse.json(
      { error: "This doesn't look like a cookies.txt (Netscape format) for YouTube. Export with a browser extension like 'Get cookies.txt LOCALLY'." },
      { status: 422 }
    );
  }
  // ensure header line exists (yt-dlp wants it)
  const finalContent = content.startsWith("# Netscape")
    ? content
    : `# Netscape HTTP Cookie File\n${content}`;

  const existing = listCookieSets();
  const id = existing.length ? Math.max(...existing) + 1 : 1;

  fs.mkdirSync(COOKIE_DIR, { recursive: true });
  fs.writeFileSync(
    cookieSetPath(id),
    finalContent.endsWith("\n") ? finalContent : finalContent + "\n",
    { mode: 0o600 }
  );

  return NextResponse.json({ ok: true, id, count: listCookieSets().length });
}

export async function DELETE(req: NextRequest) {
  if (!isAdminRequest(req)) return unauthorized();
  const idParam = req.nextUrl.searchParams.get("id");
  if (idParam === null) {
    // remove ALL sets
    for (const id of listCookieSets()) {
      try { fs.rmSync(cookieSetPath(id), { force: true }); } catch { /* noop */ }
    }
    return NextResponse.json({ enabled: false, count: 0, sets: [] });
  }
  const id = Number(idParam);
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid set id" }, { status: 400 });
  }
  try { fs.rmSync(cookieSetPath(id), { force: true }); } catch { /* noop */ }
  return NextResponse.json({ ok: true, count: listCookieSets().length, enabled: cookiesEnabled() });
}
