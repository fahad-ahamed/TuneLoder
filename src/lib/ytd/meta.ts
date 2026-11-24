/**
 * Metadata layer — works from ANY network (no YouTube bot-check on these endpoints).
 *  - Video  : oEmbed API (title / author / thumbnail)
 *  - Playlist: innertube "next" panel (FULL track list incl. Mixes) with layered
 *    fallbacks — WEB panel → yt-dlp flat-playlist (EJS+cookies) → RSS (last 15).
 *    RSS alone caps at ~15 entries, so it is NEVER the primary source for real
 *    playlists; results are cached 30 min for instant repeat opens.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const INNERTUBE_KEY = "AIzaSyAO_FJ2SlhyUg5NrbX5ERFxO4Z-vwFdxzM"; // public WEB key

export type Track = {
  videoId: string;
  title: string;
  author: string;
  thumbnail: string;
  duration?: string;
};

/* -------- playlist result cache (module scope, survives across requests) ---- */

type PlaylistResult = {
  type: "playlist";
  playlistId: string;
  source: string;
  title: string;
  author: string;
  trackCount: number;
  tracks: Track[];
};
const PL_CACHE = new Map<string, { at: number; data: PlaylistResult }>();
const PL_TTL_MS = 30 * 60_000; // 30 min — plenty for one listening session
const PL_CACHE_MAX = 40;

/* disk mirror: survives restarts/rebuilds, so a playlist the user opened
   before still opens instantly ("Reading…" 0s) after a deploy */
const PL_CACHE_FILE = path.join(
  process.env.TL_APP_DIR || process.cwd(),
  "data",
  "playlist-cache.json",
);
let plDiskLoaded = false;
function plLoadDisk(): void {
  if (plDiskLoaded) return;
  plDiskLoaded = true;
  try {
    const arr = JSON.parse(fs.readFileSync(PL_CACHE_FILE, "utf8")) as Array<
      [string, { at: number; data: PlaylistResult }]
    >;
    for (const [k, v] of arr) if (!PL_CACHE.has(k)) PL_CACHE.set(k, v);
    // drop expired entries so the file stays small
    const now = Date.now();
    for (const [k, v] of PL_CACHE) if (now - v.at >= PL_TTL_MS) PL_CACHE.delete(k);
  } catch { /* fresh start */ }
}
function plSaveDisk(): void {
  try {
    fs.mkdirSync(path.dirname(PL_CACHE_FILE), { recursive: true });
    fs.writeFileSync(PL_CACHE_FILE, JSON.stringify([...PL_CACHE.entries()]));
  } catch { /* non-fatal — memory cache still works */ }
}

function cacheGet(playlistId: string): PlaylistResult | null {
  plLoadDisk();
  const hit = PL_CACHE.get(playlistId);
  if (hit && Date.now() - hit.at < PL_TTL_MS) {
    // refresh LRU position
    PL_CACHE.delete(playlistId);
    PL_CACHE.set(playlistId, hit);
    return hit.data;
  }
  if (hit) PL_CACHE.delete(playlistId);
  return null;
}

function cachePut(playlistId: string, data: PlaylistResult) {
  plLoadDisk();
  PL_CACHE.set(playlistId, { at: Date.now(), data });
  while (PL_CACHE.size > PL_CACHE_MAX) {
    const oldest = PL_CACHE.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    PL_CACHE.delete(oldest);
  }
  plSaveDisk();
}

async function fetchText(url: string, timeoutMs = 12_000): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function firstMatch(xml: string, re: RegExp): string | null {
  const m = xml.match(re);
  return m?.[1] ? decodeEntities(m[1].trim()) : null;
}

/* ---------------- video ---------------- */

export async function getVideoInfo(videoId: string) {
  const track: Track = {
    videoId,
    title: `YouTube · ${videoId}`,
    author: "Unknown",
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
  try {
    const raw = await fetchText(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`
      )}&format=json`
    );
    const j = JSON.parse(raw) as { title?: string; author_name?: string; thumbnail_url?: string };
    return {
      type: "video" as const,
      track: {
        ...track,
        title: (j.title ?? track.title).slice(0, 150),
        author: (j.author_name ?? track.author).slice(0, 150),
        thumbnail: j.thumbnail_url ?? track.thumbnail,
      },
    };
  } catch {
    // private / age-gated video — still return a usable stub so the UI can try the download
    return { type: "video" as const, track };
  }
}

/* ---------------- innertube "next" playlist panel ---------------- */

type PanelTrack = { videoId: string; title: string; author: string; duration?: string };

async function innertubeNext(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/next?key=${INNERTUBE_KEY}&prettyPrint=false`,
    {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/json", "Accept-Language": "en-US,en" },
      body: JSON.stringify({
        context: {
          client: { clientName: "WEB", clientVersion: "2.20241126.01.00", hl: "en", gl: "US" },
        },
        ...payload,
      }),
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!res.ok) throw new Error(`innertube HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

function parsePanelItem(node: unknown): PanelTrack | null {
  const r = (node as Record<string, Record<string, unknown>>)?.playlistPanelVideoRenderer;
  if (!r || typeof r.videoId !== "string" || !/^[a-zA-Z0-9_-]{11}$/.test(r.videoId)) return null;
  const titleObj = r.title as { simpleText?: string } | undefined;
  const byline = r.shortBylineText as { runs?: { text?: string }[] } | undefined;
  const lenObj = r.lengthText as { simpleText?: string } | undefined;
  return {
    videoId: r.videoId,
    title: (titleObj?.simpleText ?? `YouTube · ${r.videoId}`).slice(0, 150),
    author: (byline?.runs?.[0]?.text ?? "YouTube").slice(0, 150),
    duration: lenObj?.simpleText,
  };
}

async function getPlaylistViaNext(
  playlistId: string,
  seedVideoId: string
): Promise<{ title: string; author: string; isInfinite: boolean; tracks: PanelTrack[] }> {
  const first = await innertubeNext({ videoId: seedVideoId, playlistId });

  const twoCol = (
    ((first.contents as Record<string, Record<string, unknown>> | undefined)?.twoColumnWatchNextResults ?? {}) as Record<string, unknown>
  ).playlist as Record<string, unknown> | undefined;
  const panel = (twoCol?.playlist ?? null) as Record<string, unknown> | null;
  if (!panel || !Array.isArray(panel.contents)) throw new Error("no playlist panel in response");

  // title/owner can be a plain string OR an {simpleText|runs} object
  const asText = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      const o = v as { simpleText?: string; runs?: { text?: string }[] };
      return o.simpleText ?? o.runs?.[0]?.text ?? "";
    }
    return "";
  };
  const panelTitle = asText(panel.title);


  const tracks: PanelTrack[] = [];
  const seen = new Set<string>();
  for (const item of panel.contents as unknown[]) {
    const t = parsePanelItem(item);
    if (t && !seen.has(t.videoId)) { seen.add(t.videoId); tracks.push(t); }
  }

  // follow panel continuations (large playlists) — up to 12 extra pages
  // (a 100-track playlist needs ~2-3 pages; 12 covers 1000+ tracks)
  // Continuation tokens live in TWO places depending on the layout: modern
  // watch-next panels end the item list with a continuationItemRenderer;
  // older grids exposed continuations[].nextContinuationData. Reading only
  // the legacy shape made every multi-page playlist stop after page 1
  // (~100 tracks) — the "১২৫ টার playlist ১০০ দেখালো" bug.
  const nextToken = (items: unknown[], container: Record<string, unknown>): string | null => {
    const last = items?.[items.length - 1] as
      | { continuationItemRenderer?: { continuationEndpoint?: { continuationCommand?: { token?: string } } } }
      | undefined;
    const modern = last?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (typeof modern === "string" && modern) return modern;
    const legacy = container.continuations as { nextContinuationData?: { continuation?: string } }[] | undefined;
    return legacy?.[0]?.nextContinuationData?.continuation ?? null;
  };
  let token = nextToken(panel.contents as unknown[], panel);
  let pages = 0;
  while (token && pages < 12 && tracks.length < 1000) {
    try {
      const more = await innertubeNext({ continuation: token });
      const endpoints = more.onResponseReceivedEndpoints as
        | { appendContinuationItemsAction?: { continuationItems?: unknown[] } }[]
        | undefined;
      const items = endpoints?.find((e) => e.appendContinuationItemsAction)?.appendContinuationItemsAction
        ?.continuationItems;
      if (!items?.length) break;
      let added = 0;
      for (const item of items) {
        const t = parsePanelItem(item);
        if (t && !seen.has(t.videoId)) { seen.add(t.videoId); tracks.push(t); added++; }
      }
      if (added === 0) break;
      token = nextToken(items, more as Record<string, unknown>);
      pages++;
    } catch {
      break;
    }
  }

  // One-page-cap guard: if YouTube shifts its layout again the loop can still
  // stop near the end of the first page (~100 items). That signature is so
  // distinctive that a slow yt-dlp verification is worth it — keep the longer
  // list. Playlists smaller than 95 never enter this branch.
  if (tracks.length >= 95 && tracks.length <= 105) {
    try {
      const flat = await getPlaylistViaYtdlp(playlistId);
      if (flat.tracks.length > tracks.length) {
        return {
          title: flat.title || (panelTitle || "Playlist"),
          author: flat.author || (asText(panel.ownerName) || "YouTube"),
          isInfinite: panel.isInfinite === true,
          tracks: flat.tracks,
        };
      }
    } catch {
      /* verification failed — keep the innertube list */
    }
  }

  return {
    title: (panelTitle || "Playlist").slice(0, 150),
    author: (asText(panel.ownerName) || "YouTube").slice(0, 150),
    isInfinite: panel.isInfinite === true,
    tracks,
  };
}

/* ---------------- yt-dlp flat-playlist fallback ---------------- */

/**
 * Full, reliable track list via the download engine's own yt-dlp (EJS challenge
 * solver + force-ipv4). Slower than innertube (~8-20 s) but survives the
 * datacenter bot-check that 403s the plain HTTP APIs. No cookies needed —
 * playlist metadata is public; `--flat-playlist` skips per-video requests.
 */
async function getPlaylistViaYtdlp(playlistId: string): Promise<{ title: string; author: string; tracks: Track[] }> {
  const bin = process.env.YTDLP_BIN || "yt-dlp";
  const base = [
    "--flat-playlist", "-J",
    "--playlist-items", "1-500",
    "--no-warnings", "--force-ipv4",
    "--socket-timeout", "15", "--retries", "2", "--extractor-retries", "1",
    "--js-runtimes", process.env.JS_RUNTIME || "node",
    "--remote-components", "ejs:github",
  ];
  // second attempt carries the user's newest cookie set — playlist metadata is
  // public, but YouTube sometimes bot-checks datacenter IPs harder; a logged-in
  // cookie flips those responses without hurting anonymous success
  const attempts: string[][] = [base, ...cookieArgs().map((c) => [...base, "--cookies", c])];

  let lastErr: Error | null = null;
  for (const args of attempts) {
    try {
      return await runYtdlpPlaylist(bin, args, playlistId);
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw lastErr ?? new Error("yt-dlp playlist extraction failed");
}

function cookieArgs(): string[] {
  const dir = process.env.TL_APP_DIR ? `${process.env.TL_APP_DIR}/data/cookies` : "data/cookies";
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith("cookies-") && f.endsWith(".txt"))
      .map((f) => `${dir}/${f}`)
      .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 1)
      .map((x) => x.p);
  } catch {
    return [];
  }
}

function runYtdlpPlaylist(bin: string, args: string[], playlistId: string): Promise<{ title: string; author: string; tracks: Track[] }> {
  const stdout: Buffer[] = [];
  const stderr: string[] = [];
  const child = spawn(bin, [...args, `https://www.youtube.com/playlist?list=${playlistId}`], { env: process.env });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* noop */ }
      reject(new Error("yt-dlp playlist extraction timed out after 90s"));
    }, 90_000);
    child.stdout?.on("data", (d: Buffer) => stdout.push(d));
    child.stderr?.on("data", (d: Buffer) => { stderr.push(d.toString()); if (stderr.length > 5) stderr.shift(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`yt-dlp playlist exit ${code}: ${stderr.join(" ").slice(0, 200)}`));
        return;
      }
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(Buffer.concat(stdout).toString("utf8")) as Record<string, unknown>;
      } catch {
        reject(new Error("yt-dlp playlist JSON unparseable"));
        return;
      }
      const entries = (j.entries ?? []) as Record<string, unknown>[];
      const fmtDuration = (s: unknown): string | undefined => {
        const n = Number(s);
        if (!Number.isFinite(n) || n <= 0) return undefined;
        const m = Math.floor(n / 60), sec = Math.round(n % 60);
        return `${m}:${String(sec).padStart(2, "0")}`;
      };
      const topAuthor = (j.channel ?? j.uploader ?? "YouTube") as string;
      const tracks: Track[] = [];
      for (const e of entries) {
        const id = typeof e.id === "string" && /^[a-zA-Z0-9_-]{11}$/.test(e.id) ? e.id : null;
        if (!id) continue;
        tracks.push({
          videoId: id,
          title: (typeof e.title === "string" && e.title ? e.title : `YouTube · ${id}`).slice(0, 150),
          author: (typeof e.uploader === "string" && e.uploader ? e.uploader : topAuthor).slice(0, 150),
          thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          duration: fmtDuration(e.duration),
        });
      }
      resolve({
        title: (typeof j.title === "string" && j.title ? j.title : "Playlist").slice(0, 150),
        author: topAuthor.slice(0, 150),
        tracks,
      });
    });
  });
}

/* ---------------- playlist ---------------- */

export async function getPlaylistInfo(playlistId: string, urlVideoId?: string | null) {
  // instant repeat opens — same playlist within 30 min returns from memory
  const cached = cacheGet(playlistId);
  if (cached) return cached;

  // seed candidates for the innertube panel (order matters)
  //  - videoId from the pasted URL (watch?v=…&list=…)
  //  - videoId embedded in the playlist ID itself (RDMM<videoId> "My Mix" format)
  const embedded = playlistId.match(/^RD(?:[A-Z]{0,2})([a-zA-Z0-9_-]{11})$/)?.[1];
  const seedHint = urlVideoId ?? embedded ?? null;

  // 1) RSS feed — fast, gives entries + a seed video, BUT YouTube caps it at the
  //    last ~15 entries — never trust it as the full list
  let rssTracks: Track[] = [];
  let rssTitle = "Playlist";
  let rssAuthor = "YouTube";
  let rssOk = false;
  try {
    const xml = await fetchText(
      `https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(playlistId)}`
    );
    const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
    for (const e of entries) {
      const id = firstMatch(e, /<yt:videoId>([^<]+)<\/yt:videoId>/);
      if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) continue;
      rssTracks.push({
        videoId: id,
        title: (firstMatch(e, /<title>([\s\S]*?)<\/title>/) ?? "Untitled").slice(0, 150),
        author: (firstMatch(e, /<author>[\s\S]*?<name>([\s\S]*?)<\/name>/) ?? "YouTube").slice(0, 150),
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      });
    }
    rssTitle = firstMatch(xml, /<feed[^>]*>[\s\S]*?<title>([\s\S]*?)<\/title>/) ?? "Playlist";
    rssAuthor = firstMatch(xml, /<author>[\s\S]*?<name>([\s\S]*?)<\/name>/) ?? "YouTube";
    rssOk = rssTracks.length > 0;
  } catch {
    /* RSS unavailable (e.g. RDMM "My Mix" has no feed) → innertube-only path */
  }

  const seed = seedHint ?? rssTracks[0]?.videoId ?? null;

  // 2) FULL list candidates — innertube panel first (fast), yt-dlp when it degrades
  let title = rssTitle;
  let author = rssAuthor;
  let tracks: Track[] = rssTracks;
  let source = rssOk ? "rss" : "none";

  if (seed) {
    try {
      const panel = await getPlaylistViaNext(playlistId, seed);
      if (panel.tracks.length > 0) {
        title = panel.title || title;
        author = panel.author || author;
        tracks = panel.tracks.map((t) => ({
          ...t,
          thumbnail: `https://i.ytimg.com/vi/${t.videoId}/hqdefault.jpg`,
        }));
        source = "innertube";
        console.log(`[playlist] innertube next: ${tracks.length} tracks (rss had ${rssTracks.length})`);
      }
    } catch (e) {
      console.warn(`[playlist] innertube next failed: ${(e as Error).message} — trying yt-dlp fallback`);
    }
  }

  // 3) yt-dlp rescue — whenever the innertube panel did NOT produce the list
  //    (403/bot-check/dead), or the best list is suspiciously thin. RSS alone
  //    caps at ~15 entries and must never be the final answer for a big playlist.
  const panelThin = tracks.length < Math.max(rssTracks.length, 15);
  if (tracks.length === 0 || panelThin || !seed || source !== "innertube") {
    try {
      const y = await getPlaylistViaYtdlp(playlistId);
      if (y.tracks.length > tracks.length) {
        title = y.title || title;
        author = y.author || author;
        tracks = y.tracks;
        source = "yt-dlp";
        console.log(`[playlist] yt-dlp fallback: ${tracks.length} tracks`);
      }
    } catch (e) {
      console.warn(`[playlist] yt-dlp fallback failed: ${(e as Error).message}`);
    }
  }

  if (tracks.length === 0) {
    throw new Error(
      rssOk
        ? "Feed returned no entries — playlist may be private, deleted or empty"
        : "Playlist unavailable — it may be private, deleted, or a My Mix that needs a seed video URL (open the mix on YouTube and copy the full URL with &list=…&v=…)"
    );
  }

  if (source === "rss" && rssTracks.length >= 15) {
    console.warn(`[playlist] serving RSS-only list (${rssTracks.length} tracks) — full sources failed`);
  }

  const isGenericAuthor = /^youtube(\s+music)?$/i.test(author);
  if (title === "Playlist" && playlistId.startsWith("RD")) title = "YouTube Mix";

  const result = {
    type: "playlist" as const,
    playlistId,
    source,
    title: title.slice(0, 150),
    author: (isGenericAuthor ? tracks[0].author : author).slice(0, 150),
    trackCount: tracks.length,
    tracks,
  };
  cachePut(playlistId, result);
  return result;
}
