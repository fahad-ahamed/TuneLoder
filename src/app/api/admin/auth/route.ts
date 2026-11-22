import { NextRequest, NextResponse } from "next/server";
import {
  COOKIE_NAME,
  checkAdminPassword,
  hasCustomPassword,
  issueSession,
  isAdminRequest,
  setAdminPassword,
} from "@/lib/ytd/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* GET — session probe: { authed, customPassword } */
export async function GET(req: NextRequest) {
  return NextResponse.json({
    authed: isAdminRequest(req),
    customPassword: hasCustomPassword(),
  });
}

/* POST — login {password} OR change password {newPassword} (authed) */
export async function POST(req: NextRequest) {
  let body: { password?: string; newPassword?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // change password (requires an active admin session)
  if (body.newPassword !== undefined) {
    if (!isAdminRequest(req)) {
      return NextResponse.json({ error: "Not authorized" }, { status: 401 });
    }
    const r = setAdminPassword(String(body.newPassword));
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  // login
  const password = String(body.password ?? "");
  if (!checkAdminPassword(password)) {
    return NextResponse.json({ error: "Wrong password — try again." }, { status: 401 });
  }
  const { token, maxAgeSeconds } = issueSession();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}

/* DELETE — logout */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
