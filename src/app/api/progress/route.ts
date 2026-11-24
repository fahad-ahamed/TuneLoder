import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/ytd/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key") ?? "";
  if (!/^[a-zA-Z0-9_-]{11}:\d{2,3}$/.test(key)) {
    return NextResponse.json({ phase: "idle" });
  }
  return NextResponse.json(getJob(key) ?? { phase: "idle" });
}
