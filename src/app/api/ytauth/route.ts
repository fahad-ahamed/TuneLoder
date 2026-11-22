import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { isAdminRequest } from "@/lib/ytd/admin";
import { parseCookieInput } from "@/lib/ytd/cookieparse";
import { probeCookieFile } from "@/lib/ytd/verify";
import {
  COOKIE_DIR,
  cookieSetPath,
  listCookieSets,
  cookieSetsInfo,
  writeCookieSetMeta,
  clearCookieSetMeta,
  cookieSetOrigin,
  cookieSetLabel,
  cookieSetVerdict,
  orderedCookieSets,
  saveLastGoodSetIfRemoved,
} from "@/lib/ytd/providers";
import { getSettings } from "@/lib/ytd/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json({ error: "Admin login required" }, { status: 401 });
}

/**
 * Direct sign-in system — GET: state, POST: sign in (paste capture),
 * DELETE: sign out. Engine chain reads these sets FIRST (fresher sessions).
 */
export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return unauthorized();
  const signinIds = listCookieSets().filter((id) => cookieSetOrigin(id) === "signin");
  const info = new Map(cookieSetsInfo().map((s) => [s.id, s]));
  const sets = signinIds.map((id) => ({
    id,
    label: cookieSetLabel(id) ?? `Sign-in session #${id}`,
    lines: info.get(id)?.lines ?? 0,
    updated: info.get(id)?.updated ?? "",
    verify: cookieSetVerdict(id) ?? null,
  }));
  const auth = getSettings().auth;
  return NextResponse.json({
    auth,
    sets,
    signedIn: sets.length > 0,
    activeSystem: orderedCookieSets().length > 0 ? "armed" : "none",
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

  const parsed = parseCookieInput(content);
  if (!parsed.ok) {
    return NextResponse.json(
      {
        error:
          parsed.error === "empty"
            ? "Empty paste"
            : "Couldn't recognize the paste. Supported: the browser's `cookie:` request header, cookies.txt (Netscape), or a cookies JSON export.",
      },
      { status: 422 }
    );
  }

  const existing = listCookieSets();
  const id = existing.length ? Math.max(...existing) + 1 : 1;

  fs.mkdirSync(COOKIE_DIR, { recursive: true });
  fs.writeFileSync(cookieSetPath(id), parsed.netscape, { mode: 0o600 });

  // REAL verification — ask YouTube itself, with these cookies, right now.
  const probe = await probeCookieFile(cookieSetPath(id));
  if (!probe.ok) {
    // REJECT: YouTube refused this session — don't keep dead cookies around
    try { fs.rmSync(cookieSetPath(id), { force: true }); } catch { /* noop */ }
    return NextResponse.json(
      {
        error:
          probe.kind === "auth"
            ? `❌ YouTube এই session প্রত্যাখ্যান করেছে — সেশনটি বাদ দেওয়া হলো। আসল উত্তর: ${probe.message}`
            : probe.kind === "rate"
              ? `⚠️ YouTube এখন সার্ভারের IP থ্রটল করছে (cookie-র দোষ নয়) — কিছুক্ষণ পরে আবার paste করে যাচাই করুন। আসল উত্তর: ${probe.message}`
              : `⚠️ যাচাই চলতে পারেনি (${probe.kind}) — সেশন সংরক্ষণ করা হয়নি। আসল উত্তর: ${probe.message}`,
        kind: probe.kind,
        real: probe.message,
      },
      { status: 422 }
    );
  }
  const verdict = { at: new Date().toISOString(), ok: true, kind: "ok", message: probe.message };
  writeCookieSetMeta(id, {
    origin: "signin",
    label: `সাইন-ইন ${new Date().toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`,
    createdAt: new Date().toISOString(),
    verify: verdict,
  });

  return NextResponse.json({
    ok: true,
    id,
    format: parsed.format,
    cookieCount: parsed.cookies.length,
    authFound: parsed.authFound,
    guest: parsed.guest,
    notes: parsed.notes,
    verified: true,
    verdict,
    count: listCookieSets().length,
  });
}

export async function DELETE(req: NextRequest) {
  if (!isAdminRequest(req)) return unauthorized();
  const idParam = req.nextUrl.searchParams.get("id");
  const signinIds = listCookieSets().filter((id) => cookieSetOrigin(id) === "signin");
  if (idParam === null) {
    // sign out of ALL direct sign-in sessions
    for (const id of signinIds) {
      try { fs.rmSync(cookieSetPath(id), { force: true }); } catch { /* noop */ }
      clearCookieSetMeta(id);
    }
    saveLastGoodSetIfRemoved();
    return NextResponse.json({ ok: true, signedIn: false });
  }
  const id = Number(idParam);
  if (!Number.isInteger(id) || !signinIds.includes(id)) {
    return NextResponse.json({ error: "Not a sign-in session id" }, { status: 404 });
  }
  try { fs.rmSync(cookieSetPath(id), { force: true }); } catch { /* noop */ }
  clearCookieSetMeta(id);
  saveLastGoodSetIfRemoved();
  return NextResponse.json({ ok: true, remaining: listCookieSets().filter((x) => cookieSetOrigin(x) === "signin").length });
}
