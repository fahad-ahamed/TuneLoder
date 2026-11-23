import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { resolveAudio, cancelJob, convertToMp3, type ResolvedAudio } from "@/lib/ytd/providers";
import { getBatch, markRunning, markDelivered, markAbandoned } from "@/lib/ytd/batch";
import { zipStream, sanitizeZipName } from "@/lib/ytd/zip";
import { startSweeper, scheduleRemoval } from "@/lib/ytd/cleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function safeName(s: string, fallback: string): string {
  const clean = s
    .normalize("NFKD")
    // \p{M} = vowel signs / combining marks — keeps Bangla কার intact
    .replace(/[^\p{L}\p{N}\p{M} ()\-'.,&]/gu, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean || fallback;
}

/**
 * GET /api/download-zip?id=… — ONE click = ONE guaranteed download.
 * Starts the engine for every batch item at once (the engine gate runs them
 * with the admin's concurrency), streams a STORE zip in playlist order and
 * skips failed tracks into _FAILED.txt.
 */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const batch = getBatch(id);
  if (!batch) {
    return NextResponse.json({ error: "Unknown or expired batch — select the tracks again" }, { status: 404 });
  }
  if (batch.status === "cancelled") {
    return NextResponse.json({ error: "This batch was cancelled" }, { status: 409 });
  }

  startSweeper();
  markRunning(batch);
  const bitrate = batch.bitrate;
  const zipFileName = `${safeName(batch.title, "Playlist")} [${bitrate}kbps].zip`;

  // engine: kick off EVERY track now — the gate serializes/parallels per admin N
  const results = batch.items.map((it) => {
    it.jobKey = `${it.videoId}:${bitrate}`;
    const p: Promise<{ res: ResolvedAudio; it: typeof it }> = resolveAudio(it.videoId, bitrate)
      .then((res) => ({ res, it }))
      .catch((e): { res: ResolvedAudio; it: typeof it } => ({
        res: { provider: "none", kind: "unknown", logs: [String(e).slice(0, 200)] },
        it,
      }));
    return p;
  });

  // cancel every engine job the moment the batch is cancelled (the abort of
  // resolveAudio promises alone would leave yt-dlp children running)
  batch.controller.signal.addEventListener("abort", () => {
    for (const it of batch.items) {
      if (it.jobKey) {
        const [vid, b] = it.jobKey.split(":");
        cancelJob(vid, Number(b));
      }
    }
  });
  // client walked away from the download → same as a cancel
  req.signal.addEventListener("abort", () => {
    markAbandoned(batch);
    for (const it of batch.items) {
      if (it.jobKey && (it.status === "running" || it.status === "queued")) {
        const [vid, b] = it.jobKey.split(":");
        cancelJob(vid, Number(b));
      }
    }
  });

  // deliver everything to a .tmp zip copy? NO — stream straight to the browser.
  const failures: string[] = [];
  const usedNames = new Set<string>();
  let sentBytes = 0;

  const body = zipStream(
    async (zip) => {
      for (const p of results) {
        const { res, it } = await p;
        const failed = res.provider === "none" || res.cancelled;
        if (failed) {
          it.status = res.cancelled ? "skipped" : "failed";
          it.error =
            res.kind === "video"
              ? "video unavailable (private/removed)"
              : res.cancelled
                ? "cancelled"
                : (res.logs?.slice(-1)[0] ?? "engine failed").slice(0, 180);
          failures.push(`${it.index + 1}. ${it.title} (youtube.com/watch?v=${it.videoId}) — ${it.error}`);
          continue;
        }
        // produce the final mp3 path (mirror results stream → convert first)
        let mp3File = res.localFile ?? null;
        if (!mp3File && res.streamUrl) {
          mp3File = await mirrorToLocal(res.streamUrl, res.container ?? "", it.videoId, bitrate, it.title, it.author);
        }
        if (!mp3File || !fs.existsSync(mp3File)) {
          it.status = "failed";
          it.error = "no output produced";
          failures.push(`${it.index + 1}. ${it.title} — no output produced`);
          continue;
        }
        it.status = "done";
        it.sizeBytes = fs.statSync(mp3File).size;
        it.fileName = `${String(it.index + 1).padStart(2, "0")} - ${sanitizeZipName(it.title)} [${bitrate}kbps].mp3`;
        // ensure uniqueness inside the zip
        let n = it.fileName;
        let k = 2;
        while (usedNames.has(n)) n = it.fileName.replace(/\.mp3$/, ` (${k++}).mp3`);
        usedNames.add(n);
        await zip.addFile(n, mp3File);
        sentBytes += it.sizeBytes;
      }
      if (failures.length) {
        await zip.addText(
          "_FAILED.txt",
          [
            `TuneLoad zip for: ${batch.title}`,
            `${failures.length} of ${batch.items.length} track(s) could not be added:`,
            "",
            ...failures,
          ].join("\n")
        );
      }
      // the full zip (headers + content + central dir) left the server →
      // honest delivery marker for the UI ("Sent to your browser ✓")
      markDelivered(batch, sentBytes, zipFileName);
    },
    () => {
      // stream errored/aborted mid-build
      markAbandoned(batch);
    },
    batch.controller // abort() lives on the controller (Node typings)
  );

  return new Response(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(zipFileName)}`,
      "Cache-Control": "no-store",
    },
  });
}

/** mirror (cobalt) results have no local file yet — pull + convert to mp3 */
async function mirrorToLocal(
  streamUrl: string,
  container: string,
  videoId: string,
  bitrate: number,
  title: string,
  author: string
): Promise<string | null> {
  try {
    const res = await fetch(streamUrl, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" },
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 10_000) return null;
    const src = path.join(process.cwd(), ".tmp-downloads", `${videoId}-${Date.now()}.${container || "bin"}`);
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, buf);
    const out = await convertToMp3({ kind: "file", path: src }, { bitrate, title, author });
    scheduleRemoval(src, 5_000);
    return out;
  } catch {
    return null;
  }
}
