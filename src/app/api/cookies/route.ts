import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { isAdminRequest } from "@/lib/ytd/admin";
import { parseCookieInput } from "@/lib/ytd/cookieparse";
import {
  COOKIE_DIR,
  listCookieSets,
  cookieSetPath,
  cookieSetsInfo,
  cookiesEnabled,
  activeCookieSet,
  writeCookieSetMeta,
  clearCookieSetMeta,
  cookieSetVerdict,
  saveLastGoodSetIfRemoved,
} from "@/lib/ytd/providers";
import { probeCookieFile } from "@/lib/ytd/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json({ error: "Admin login required" }, { status: 401 });
}

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return unauthorized();
  const sets = cookieSetsInfo().map((s) => ({ ...s, verify: cookieSetVerdict(s.id) ?? null }));
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

  // same multi-format parser as the direct sign-in system — netscape, JSON and
  // header pastes all land as a normalized cookies.txt for yt-dlp
  const parsed = parseCookieInput(content);
  if (!parsed.ok) {
    return NextResponse.json(
      {
        error:
          "Couldn't recognize the cookies. Supported: cookies.txt (Netscape), a cookies JSON export, or the browser's `cookie:` request header.",
      },
      { status: 422 }
    );
  }

  const existing = listCookieSets();
  const id = existing.length ? Math.max(...existing) + 1 : 1;

  fs.mkdirSync(COOKIE_DIR, { recursive: true });
  fs.writeFileSync(cookieSetPath(id), parsed.netscape, { mode: 0o600 });

  // REAL verification — YouTube's own answer decides whether this set survives
  const probe = await probeCookieFile(cookieSetPath(id));
  if (!probe.ok) {
    // REJECT: YouTube refused these cookies — don't keep dead sets around
    try { fs.rmSync(cookieSetPath(id), { force: true }); } catch { /* noop */ }
    return NextResponse.json(
      {
        error:
          probe.kind === "auth"
            ? `❌ YouTube এই cookies প্রত্যাখ্যান করেছে — সেট যোগ করা হয়নি। আসল উত্তর: ${probe.message}`
            : probe.kind === "rate"
              ? `⚠️ YouTube এখন সার্ভারের IP থ্রটল করছে (cookie-র দোষ নয়) — কিছুক্ষণ পরে আবার চেষ্টা করুন। আসল উত্তর: ${probe.message}`
              : `⚠️ যাচাই চলতে পারেনি (${probe.kind}) — সেট যোগ করা হয়নি। আসল উত্তর: ${probe.message}`,
        kind: probe.kind,
        real: probe.message,
      },
      { status: 422 }
    );
  }
  const verdict = { at: new Date().toISOString(), ok: true, kind: "ok", message: probe.message };
  writeCookieSetMeta(id, { origin: "manual", createdAt: new Date().toISOString(), verify: verdict });

  return NextResponse.json({ ok: true, id, count: listCookieSets().length, cookieCount: parsed.cookies.length, verified: true, verdict });
}

export async function DELETE(req: NextRequest) {
  if (!isAdminRequest(req)) return unauthorized();
  const idParam = req.nextUrl.searchParams.get("id");
  if (idParam === null) {
    // remove ALL sets
    for (const id of listCookieSets()) {
      try { fs.rmSync(cookieSetPath(id), { force: true }); } catch { /* noop */ }
      clearCookieSetMeta(id);
    }
    saveLastGoodSetIfRemoved();
    return NextResponse.json({ enabled: false, count: 0, sets: [] });
  }
  const id = Number(idParam);
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid set id" }, { status: 400 });
  }
  try { fs.rmSync(cookieSetPath(id), { force: true }); } catch { /* noop */ }
  clearCookieSetMeta(id);
  saveLastGoodSetIfRemoved();
  return NextResponse.json({ ok: true, count: listCookieSets().length, enabled: cookiesEnabled() });
}
