import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/ytd/admin";
import { getSettings, saveSettings, type EngineSettings } from "@/lib/ytd/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json({ error: "Admin login required" }, { status: 401 });
}

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return unauthorized();
  return NextResponse.json(getSettings());
}

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) return unauthorized();
  let body: Partial<EngineSettings>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const current = getSettings();
  const patch: Partial<EngineSettings> = {};
  if (body.maxConcurrency !== undefined) {
    const n = Number(body.maxConcurrency);
    if (!Number.isInteger(n) || n < 0 || n > 8) {
      return NextResponse.json({ error: "maxConcurrency must be 0-8 (0 = auto)" }, { status: 400 });
    }
    patch.maxConcurrency = n;
  }
  if (body.runGapMs !== undefined) {
    const n = Number(body.runGapMs);
    if (!Number.isFinite(n) || n < 200 || n > 10_000) {
      return NextResponse.json({ error: "runGapMs must be 200-10000" }, { status: 400 });
    }
    patch.runGapMs = Math.floor(n);
  }
  if (body.autoPrefetchPlaylist !== undefined) {
    patch.autoPrefetchPlaylist = body.autoPrefetchPlaylist === true;
  }
  if (body.delivery !== undefined) {
    if (body.delivery !== "blob" && body.delivery !== "native") {
      return NextResponse.json({ error: "delivery must be 'blob' or 'native'" }, { status: 400 });
    }
    patch.delivery = body.delivery;
  }
  if (body.playlistDelivery !== undefined) {
    if (body.playlistDelivery !== "zip" && body.playlistDelivery !== "separate") {
      return NextResponse.json({ error: "playlistDelivery must be 'zip' or 'separate'" }, { status: 400 });
    }
    patch.playlistDelivery = body.playlistDelivery;
  }
  if (body.auth !== undefined && typeof body.auth === "object") {
    // per-key merge so a partial toggle patch never flips the other system
    patch.auth = {
      manualCookies: body.auth.manualCookies === undefined ? current.auth.manualCookies : body.auth.manualCookies === true,
      signIn: body.auth.signIn === undefined ? current.auth.signIn : body.auth.signIn === true,
    };
  }

  const settings = saveSettings(patch);
  return NextResponse.json({ ok: true, settings });
}
