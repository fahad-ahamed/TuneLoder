import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { resolveAudio, convertToMp3 } from "@/lib/ytd/providers";
import { updateJob, jobKey } from "@/lib/ytd/jobs";
import { startSweeper, scheduleRemoval } from "@/lib/ytd/cleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ALLOWED_BITRATES = [320, 256, 192, 128, 96, 64];

function safeName(s: string, fallback: string): string {
  const clean = s
    .normalize("NFKD")
    // \p{M} = vowel signs / combining marks — without it Bangla names lose their কার ("মন মাঝে" → "মন মঝ")
    .replace(/[^\p{L}\p{N}\p{M} ()\-'.,&]/gu, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean || fallback;
}

/**
 * NATIVE-delivery endpoint (admin → Engine settings → delivery = "native").
 * The browser opens this URL directly, so the file lands in the browser's own
 * download manager UI (like any other downloader) instead of a page-held blob.
 * Same engine underneath: cookie auto-switch, retries, cache, auto-clean.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const videoId = (sp.get("v") ?? "").trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return Response.json({ error: "Missing or invalid videoId" }, { status: 400 });
  }
  const bitrate = ALLOWED_BITRATES.includes(Number(sp.get("b"))) ? Number(sp.get("b")) : 320;
  const title = (sp.get("t") ?? "").slice(0, 200) || `YouTube ${videoId}`;
  const author = (sp.get("a") ?? "").slice(0, 200) || "Unknown";

  startSweeper();

  const resolved = await resolveAudio(videoId, bitrate);

  if (resolved.cancelled) {
    return Response.json({ error: "Cancelled", cancelled: true }, { status: 422 });
  }
  if (resolved.provider === "none") {
    return Response.json(
      {
        error: "All providers failed on this network.",
        logs: resolved.logs.slice(-6),
      },
      { status: 422 }
    );
  }

  let mp3File: string | null = null;
  try {
    if (resolved.localFile) {
      mp3File = resolved.localFile;
    } else if (resolved.streamUrl) {
      if (resolved.container === "mp3") {
        const res = await fetch(resolved.streamUrl, {
          headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" },
          signal: AbortSignal.timeout(180_000),
        });
        if (!res.ok) throw new Error(`provider stream HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 10_000) throw new Error("provider stream too small");
        fs.mkdirSync(path.join(process.cwd(), ".tmp-downloads"), { recursive: true });
        mp3File = path.join(process.cwd(), ".tmp-downloads", `${videoId}-${Date.now()}.mp3`);
        fs.writeFileSync(mp3File, buf);
      } else {
        mp3File = await convertToMp3(
          { kind: "url", url: resolved.streamUrl },
          { bitrate, title, author }
        );
      }
    }
    if (!mp3File || !fs.existsSync(mp3File)) throw new Error("no output produced");

    const size = fs.statSync(mp3File).size;
    const fileName = `${safeName(title, "youtube-audio")} [${bitrate}kbps].mp3`;

    const nodeStream = fs.createReadStream(mp3File);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    // honesty marker: fully streamed → delivered (UI shows "Sent ✓")
    nodeStream.on("close", () => {
      updateJob(jobKey(videoId, bitrate), { delivered: true });
    });

    // cache copies are owned by the sweeper TTL; temp/converted copies go now
    const isCacheCopy = mp3File.startsWith(path.join(process.cwd(), "data", "audio"));
    const cleanup = (ms: number) => {
      if (!isCacheCopy) scheduleRemoval(mp3File!, ms);
    };
    nodeStream.on("close", () => cleanup(60_000));
    nodeStream.on("error", () => cleanup(60_000));

    return new Response(webStream, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(size),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "Cache-Control": "no-store",
        "X-Provider": resolved.provider,
        "X-Cache": resolved.cached === true ? "hit" : "miss",
      },
    });
  } catch (e) {
    if (mp3File) scheduleRemoval(mp3File, 5_000);
    return Response.json(
      { error: `Conversion failed: ${(e as Error).message}`, logs: resolved.logs.slice(-6) },
      { status: 422 }
    );
  }
}
