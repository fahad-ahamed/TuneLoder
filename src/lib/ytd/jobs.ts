/**
 * Live download-job progress registry (key = `${videoId}:${bitrate}`).
 * Shared by /api/download, /api/prefetch (same deduped job) and the UI's
 * /api/progress polling so the browser can show % / speed / ETA while
 * yt-dlp runs — downloads stop *feeling* slow.
 */

export type JobPhase = "starting" | "downloading" | "encoding" | "done" | "error" | "cancelled";

export type Job = {
  key: string;
  phase: JobPhase;
  pct?: number;
  size?: string;
  speed?: string;
  eta?: string;
  updatedAt: number;
};

const g = globalThis as unknown as { __tlJobs?: Map<string, Job> };
const jobs: Map<string, Job> = g.__tlJobs ?? (g.__tlJobs = new Map<string, Job>());

export function jobKey(videoId: string, bitrate: number): string {
  return `${videoId}:${bitrate}`;
}

export function updateJob(key: string, patch: Partial<Omit<Job, "key" | "updatedAt">>) {
  const prev = jobs.get(key);
  jobs.set(key, {
    key,
    phase: prev?.phase ?? "starting",
    ...prev,
    ...patch,
    updatedAt: Date.now(),
  });
}

export function getJob(key: string): Job | null {
  const j = jobs.get(key);
  if (!j) return null;
  if (Date.now() - j.updatedAt > 10 * 60_000) {
    jobs.delete(key);
    return null;
  }
  return j;
}

/** yt-dlp --newline lines: `[download]  4.2% of ~3.20MiB at 1.50MiB/s ETA 00:06` */
const DL_LINE =
  /\[download\]\s+(\d+(?:\.\d+)?)%(?:\s+of\s+~?\s*([\d.]+\s?\w+))?(?:\s+at\s+([^\s]+\/s))?(?:\s+ETA\s+(\S+))?/;

export function parseDownloadLine(line: string): {
  pct: number;
  size?: string;
  speed?: string;
  eta?: string;
} | null {
  const m = DL_LINE.exec(line);
  if (!m) return null;
  const speed = m[3] && !/unknown/i.test(m[3]) ? m[3] : undefined;
  return {
    pct: Math.min(100, parseFloat(m[1])),
    size: m[2],
    speed,
    eta: m[4],
  };
}
