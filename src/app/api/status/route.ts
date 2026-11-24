import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { cookiesEnabled, engineBinaries, maxConcurrency, listCookieSets, engineQueueInfo } from "@/lib/ytd/providers";
import { getSettings } from "@/lib/ytd/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** public Telegram bot link for the site header — username from data/tgbot.json */
function botUsername(): string | null {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(process.env.TL_APP_DIR || process.cwd(), "data", "tgbot.json"), "utf8")
    ) as { username?: string };
    return typeof cfg.username === "string" && cfg.username ? cfg.username : null;
  } catch {
    return null;
  }
}

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
    settings: getSettings(),
    tgUsername: botUsername(),
  });
}
