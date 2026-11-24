/**
 * Spotify → public metadata → best-match YouTube track.
 *
 * Spotify's own audio streams are DRM-encrypted (Widevine) — they cannot be
 * downloaded and this project will not try to circumvent that. What this
 * module does is what every honest "Spotify downloader" does: read the PUBLIC
 * metadata (title / artist / cover / duration) from Spotify's embed page (no
 * auth needed) or the web API (when the admin saved an sp_dc cookie), find the
 * best matching upload on YouTube, and hand that videoId to the EXISTING
 * download engine. From the engine's point of view it is a perfectly ordinary
 * YouTube job — the YouTube code path is untouched.
 *
 * Reality-tested against the live embed pages:
 *  - track/playlist embeds ship the entity in __NEXT_DATA__
 *    (props.pageProps.state.data.entity) — no auth required
 *  - album embeds ship NO entity → albums need the sp_dc web-API path
 *  - anonymous embed tokens are quota-killed (HTTP 429) → not relied on
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const YTDLP_BIN = process.env.YTDLP_BIN || "/home/z/.venv/bin/yt-dlp";
const DATA_DIR = path.join(process.cwd(), "data");
const COOKIE_FILE = path.join(DATA_DIR, "spotify-cookie.json");
const MAX_LIST_TRACKS = 200;

export type SpotifyKind = "track" | "album" | "playlist";

export type SpotifyMetaTrack = { title: string; author: string; durationMs?: number };

export type SpotifyEntity = {
  kind: SpotifyKind;
  id: string;
  title: string;
  author: string;
  cover: string;
  tracks: SpotifyMetaTrack[];
  source: "embed" | "web-api";
};

/* ---------------- URL parsing ---------------- */

export function parseSpotifyUrl(raw: string): { kind: SpotifyKind; id: string } | null {
  const m = raw
    .trim()
    .match(/(?:open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist)|spotify:(track|album|playlist))[:/]([a-zA-Z0-9]{22})/i);
  if (!m) return null;
  const kind = (m[1] ?? m[2]).toLowerCase() as SpotifyKind;
  if (kind !== "track" && kind !== "album" && kind !== "playlist") return null;
  return { kind, id: m[3] };
}

/* ---------------- sp_dc cookie storage ---------------- */

export function getSpotifyCookie(): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"));
    const c = String(j?.cookie ?? "").trim();
    return c ? c : null;
  } catch {
    return null;
  }
}

export function saveSpotifyCookie(cookie: string): boolean {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const clean = cookie.trim();
  fs.writeFileSync(COOKIE_FILE, JSON.stringify({ cookie: clean, updated: new Date().toISOString() }));
  return !!clean;
}

/* ---------------- helpers ---------------- */

function fmtMs(n?: number): string | undefined {
  if (typeof n !== "number" || !isFinite(n) || n <= 0) return undefined;
  const ms = n < 10_000 ? n * 1000 : n; // tolerate seconds-shaped values
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** recursive find for a dict by key (embed layout shifts between kinds) */
function findDict(obj: unknown, key: string): Record<string, unknown> | null {
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const r = findDict(v, key);
      if (r) return r;
    }
    return null;
  }
  if (obj && typeof obj === "object") {
    const d = obj as Record<string, unknown>;
    if (d[key] && typeof d[key] === "object") return d[key] as Record<string, unknown>;
    for (const v of Object.values(d)) {
      const r = findDict(v, key);
      if (r) return r;
    }
  }
  return null;
}

/* ---------------- metadata: embed page (no auth) ---------------- */

type EmbedEntity = {
  title?: string;
  name?: string;
  subtitle?: string;
  artists?: { name?: string }[];
  ownerName?: string;
  duration?: number;
  coverArt?: { sources?: { url?: string; width?: number | null }[] };
  visualIdentity?: { image?: { url?: string; maxWidth?: number | null }[] };
  trackList?: { uri?: string; title?: string; name?: string; subtitle?: string; duration?: number }[];
};

function pickCover(e: EmbedEntity): string {
  const ca = (e.coverArt?.sources ?? [])
    .slice()
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  if (ca[0]?.url) return ca[0].url;
  const vi = (e.visualIdentity?.image ?? [])
    .slice()
    .sort((a, b) => (b.maxWidth ?? 0) - (a.maxWidth ?? 0));
  return vi[0]?.url ?? "";
}

async function fetchEmbed(kind: SpotifyKind, id: string): Promise<EmbedEntity | null> {
  const res = await fetch(`https://open.spotify.com/embed/${kind}/${id}`, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`spotify embed HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]+?)<\/script>/);
  if (!m) return null;
  let json: unknown;
  try {
    json = JSON.parse(m[1]);
  } catch {
    return null;
  }
  // the entity dict identifies itself: has a type + (title|name) [+ trackList]
  const entity = findDict(json, "entity") as EmbedEntity | null;
  const looksEntity =
    entity && (entity.title || entity.name) && typeof entity === "object";
  return looksEntity ? entity : null;
}

function entityFromEmbed(kind: SpotifyKind, id: string, e: EmbedEntity): SpotifyEntity {
  const authorFromArtists = (e.artists ?? [])
    .map((a) => a?.name)
    .filter(Boolean)
    .join(", ");
  const author =
    authorFromArtists || (kind === "playlist" ? e.subtitle ?? e.ownerName : e.subtitle) || "Spotify";
  const title = e.title || e.name || "Spotify";

  const tracks: SpotifyMetaTrack[] = [];
  if (kind === "track") {
    tracks.push({ title, author, durationMs: e.duration });
  } else {
    for (const t of e.trackList ?? []) {
      const title2 = t.title ?? t.name ?? "Unknown title";
      const author2 = t.subtitle ?? author;
      const durationMs = t.duration;
      const k = `${title2}|${author2}|${durationMs ?? 0}`;
      if (tracks.some((x) => `${x.title}|${x.author}|${x.durationMs ?? 0}` === k)) continue;
      tracks.push({ title: title2, author: author2, durationMs });
      if (tracks.length >= MAX_LIST_TRACKS) break;
    }
  }
  return { kind, id, title, author, cover: pickCover(e), tracks, source: "embed" };
}

/* ---------------- metadata: web API (needs sp_dc) ---------------- */

async function getAccessToken(cookie: string): Promise<string | null> {
  try {
    const c = cookie.includes("sp_dc=") ? cookie : `sp_dc=${cookie}`;
    const res = await fetch(
      "https://open.spotify.com/get_access_token?reason=transport&productType=web_player",
      { headers: { cookie: c, "User-Agent": UA }, signal: AbortSignal.timeout(12_000) }
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { accessToken?: string };
    return typeof j?.accessToken === "string" && j.accessToken ? j.accessToken : null;
  } catch {
    return null;
  }
}

type WebApiPaged = { items?: unknown[]; next?: string | null };
type WebApiTrack = { name?: string; duration_ms?: number; artists?: { name?: string }[] };

async function apiJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`spotify web API HTTP ${res.status}`);
  return (await res.json()) as T;
}

function trackFromWebApi(t: WebApiTrack): SpotifyMetaTrack {
  return {
    title: t.name ?? "Unknown title",
    author: (t.artists ?? []).map((a) => a.name).filter(Boolean).join(", ") || "Unknown artist",
    durationMs: t.duration_ms,
  };
}

async function entityFromWebApi(kind: SpotifyKind, id: string, token: string): Promise<SpotifyEntity> {
  const coverFallback = (images?: { url?: string }[]) =>
    (images ?? []).slice().sort((a, b) => 0)[0]?.url ?? "";

  if (kind === "track") {
    const j = await apiJson<WebApiTrack & { album?: { images?: { url?: string }[] } }>(
      `https://api.spotify.com/v1/tracks/${id}?market=US`,
      token
    );
    return {
      kind, id,
      title: j.name ?? "Spotify",
      author: (j.artists ?? []).map((a) => a.name).filter(Boolean).join(", ") || "Spotify",
      cover: coverFallback(j.album?.images),
      tracks: [trackFromWebApi(j)],
      source: "web-api",
    };
  }

  if (kind === "album") {
    const first = await apiJson<{
      name?: string; images?: { url?: string }[];
      artists?: { name?: string }[]; tracks?: WebApiPaged;
    }>(`https://api.spotify.com/v1/albums/${id}?market=US`, token);
    const tracks: SpotifyMetaTrack[] = (first.tracks?.items ?? []).map((it) => trackFromWebApi(it as WebApiTrack));
    let next: string | null = first.tracks?.next ?? null;
    while (next && tracks.length < MAX_LIST_TRACKS) {
      const page = await apiJson<WebApiPaged>(next, token);
      for (const it of page.items ?? []) tracks.push(trackFromWebApi(it as WebApiTrack));
      next = page.next ?? null;
    }
    return {
      kind, id,
      title: first.name ?? "Spotify album",
      author: (first.artists ?? []).map((a) => a.name).filter(Boolean).join(", ") || "Spotify",
      cover: coverFallback(first.images),
      tracks: tracks.slice(0, MAX_LIST_TRACKS),
      source: "web-api",
    };
  }

  // playlist
  const first = await apiJson<{
    name?: string; images?: { url?: string }[];
    owner?: { display_name?: string };
    tracks?: WebApiPaged;
  }>(`https://api.spotify.com/v1/playlists/${id}?market=US`, token);
  const tracks: SpotifyMetaTrack[] = (first.tracks?.items ?? [])
    .map((it) => (it as { track?: WebApiTrack })?.track)
    .filter((t): t is WebApiTrack => !!t?.name)
    .map(trackFromWebApi);
  let next: string | null = first.tracks?.next ?? null;
  while (next && tracks.length < MAX_LIST_TRACKS) {
    const page = await apiJson<WebApiPaged>(next, token);
    for (const it of page.items ?? []) {
      const t = (it as { track?: WebApiTrack })?.track;
      if (t?.name) tracks.push(trackFromWebApi(t));
    }
    next = page.next ?? null;
  }
  return {
    kind, id,
    title: first.name ?? "Spotify playlist",
    author: first.owner?.display_name ?? "Spotify",
    cover: coverFallback(first.images),
    tracks: tracks.slice(0, MAX_LIST_TRACKS),
    source: "web-api",
  };
}

/* ---------------- entity fetch (embed first, web API fallback) ---------------- */

export async function getSpotifyEntity(kind: SpotifyKind, id: string): Promise<SpotifyEntity> {
  const cookie = getSpotifyCookie();
  const embedError = "";

  // 1) embed page — works for track + playlist without any auth
  try {
    const e = await fetchEmbed(kind, id);
    if (e) {
      const entity = entityFromEmbed(kind, id, e);
      // metadata-cap suspicion (embed lists stop on a round boundary) and an
      // sp_dc cookie exists → verify through the web API and keep the longer
      const suspicious = kind === "playlist" && (entity.tracks.length % 50 === 0 || (entity.tracks.length >= 95 && entity.tracks.length <= 105));
      if (suspicious && cookie) {
        const token = await getAccessToken(cookie);
        if (token) {
          try {
            const web = await entityFromWebApi(kind, id, token);
            if (web.tracks.length > entity.tracks.length) return web;
          } catch {
            /* web API failed — keep the embed list */
          }
        }
      }
      return entity;
    }
  } catch (e) {
    /* embed path failed — fall through */
  }

  // 2) web API — needs the admin's sp_dc cookie (albums always land here)
  if (cookie) {
    const token = await getAccessToken(cookie);
    if (token) return entityFromWebApi(kind, id, token);
  }

  throw new Error(
    kind === "album"
      ? "Album-এর তালিকা পড়তে Spotify cookie (sp_dc) দরকার — admin panel → Spotify cookie সেট করুন। (Track আর playlist cookie ছাড়াও কাজ করে।)"
      : `Spotify metadata failed: ${embedError || "embed data missing — try again"}`
  );
}

/* ---------------- YouTube matching (engine's own yt-dlp) ---------------- */

export type YtMatch = { videoId: string; title: string; duration?: string };

export function matchOnYouTube(query: string, timeoutMs = 30_000): Promise<YtMatch | null> {
  return new Promise((resolve) => {
    const args = [
      `ytsearch1:${query}`,
      "--flat-playlist",
      "--dump-single-json",
      "--no-warnings",
      "--no-playlist",
      "--socket-timeout",
      "15",
    ];
    let out = "";
    let settled = false;
    const done = (v: YtMatch | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const child = spawn(YTDLP_BIN, args, { env: process.env });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", () => done(null));
    child.on("close", () => {
      try {
        const j = JSON.parse(out) as { entries?: { id?: string; title?: string; duration?: number }[] };
        const e = j?.entries?.[0];
        if (e && typeof e.id === "string" && /^[a-zA-Z0-9_-]{11}$/.test(e.id)) {
          done({
            videoId: e.id,
            title: e.title ?? "",
            duration: typeof e.duration === "number" ? fmtMs(e.duration) : undefined,
          });
        } else done(null);
      } catch {
        done(null);
      }
    });
  });
}

/** small fixed-size worker pool */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
