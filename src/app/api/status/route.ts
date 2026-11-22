import { NextResponse } from "next/server";
import { cookiesEnabled, engineBinaries, maxConcurrency, listCookieSets, engineQueueInfo } from "@/lib/ytd/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { ytdlp, ffmpeg } = engineBinaries();

  const check = (bin: string, args: string[]) =>
    new Promise<boolean>((resolve) => {
      import("child_process").then(({ execFile }) => {
        execFile(bin, args, { timeout: 8000 }, (err, stdout) => {
          resolve(!err && String(stdout).length > 0);
        });
      });
    });

  const [ffmpegOk, ytdlpOk] = await Promise.all([
    check(ffmpeg, ["-version"]),
    check(ytdlp, ["--version"]),
  ]);

  return NextResponse.json({
    ffmpeg: ffmpegOk,
    ytdlp: ytdlpOk,
    cookies: cookiesEnabled(),
    cookieSets: listCookieSets().length,
    maxConcurrency: maxConcurrency(),
    queue: engineQueueInfo(),
  });
}
