/**
 * Metadata layer — works from ANY network (no YouTube bot-check on these endpoints).
 *  - Video  : oEmbed API (title / author / thumbnail)
 *  - Playlist: innertube "next" panel (FULL track list incl. Mixes) with RSS feed fallback
 */

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

  // follow panel continuations (large playlists) — max 3 extra pages
  const continuations = panel.continuations as { nextContinuationData?: { continuation?: string } }[] | undefined;
  let token = continuations?.[0]?.nextContinuationData?.continuation;
  let pages = 0;
  while (token && pages < 3 && tracks.length < 300) {
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
      const nextCont = (more as Record<string, unknown>).continuations as
        | { nextContinuationData?: { continuation?: string } }[]
        | undefined;
      token = nextCont?.[0]?.nextContinuationData?.continuation;
      pages++;
    } catch {
      break;
    }
  }

  return {
    title: (panelTitle || "Playlist").slice(0, 150),
    author: (asText(panel.ownerName) || "YouTube").slice(0, 150),
    isInfinite: panel.isInfinite === true,
    tracks,
  };
}

/* ---------------- playlist ---------------- */

export async function getPlaylistInfo(playlistId: string, urlVideoId?: string | null) {
  // seed candidates for the innertube panel (order matters)
  //  - videoId from the pasted URL (watch?v=…&list=…)
  //  - videoId embedded in the playlist ID itself (RDMM<videoId> "My Mix" format)
  const embedded = playlistId.match(/^RD(?:[A-Z]{0,2})([a-zA-Z0-9_-]{11})$/)?.[1];
  const seedHint = urlVideoId ?? embedded ?? null;

  // 1) RSS feed — fast, gives entries + a seed video (covers most playlists & mixes)
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

  // 2) FULL list via innertube "next" panel (Mixes: 25+; big playlists: paginated)
  let title = rssTitle;
  let author = rssAuthor;
  let tracks: Track[] = rssTracks;

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
        console.log(`[playlist] innertube next: ${tracks.length} tracks (rss had ${rssTracks.length})`);
      }
    } catch (e) {
      console.warn(`[playlist] innertube next failed, falling back to RSS:`, (e as Error).message);
    }
  }

  if (tracks.length === 0) {
    throw new Error(
      rssOk
        ? "Feed returned no entries — playlist may be private, deleted or empty"
        : "Playlist unavailable — it may be private, deleted, or a My Mix that needs a seed video URL (open the mix on YouTube and copy the full URL with &list=…&v=…)"
    );
  }

  const isGenericAuthor = /^youtube(\s+music)?$/i.test(author);
  if (title === "Playlist" && playlistId.startsWith("RD")) title = "YouTube Mix";

  return {
    type: "playlist" as const,
    playlistId,
    title: title.slice(0, 150),
    author: (isGenericAuthor ? tracks[0].author : author).slice(0, 150),
    trackCount: tracks.length,
    tracks,
  };
}
