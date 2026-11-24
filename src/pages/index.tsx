"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Music4,
  Link2,
  ClipboardPaste,
  Loader2,
  Download,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  Zap,
  ListMusic,
  Gauge,
  Clock3,
  RotateCcw,
  Settings2,
  FileArchive,
  FolderUp,
  Rows3,
  Ban,
  Send,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import ThemeToggle from "@/components/theme-toggle";

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

type Track = {
  videoId: string;
  title: string;
  author: string;
  thumbnail: string;
  duration?: string;
};

type Info =
  | { type: "video"; track: Track }
  | { type: "playlist"; playlistId: string; title: string; author: string; trackCount: number; tracks: Track[] };

type DlState = {
  status: "queued" | "downloading" | "done" | "error" | "sent";
  ms?: number;
  sizeKB?: number;
  hint?: string;
  pct?: number;
  speed?: string;
  eta?: string;
  /** server streamed the whole response → "Sent to your browser ✓" */
  delivered?: boolean;
};

type PlaylistDelivery = "zip" | "folder" | "separate";

type BatchView = {
  id: string;
  status: "prepared" | "running" | "complete" | "cancelled" | "abandoned";
  delivered: boolean;
  zipBytes?: number;
  zipFileName?: string;
  items: Array<{
    videoId: string;
    index: number;
    status: "queued" | "running" | "done" | "failed" | "skipped";
    pct?: number;
    speed?: string;
    eta?: string;
    sizeBytes?: number;
    error?: string;
  }>;
};

const BITRATES = [320, 256, 192, 128] as const;

/* Spotify quality tiers — shown in place of the YT bitrate chips when a
   Spotify link is analyzed. The download itself still runs through the same
   YT engine at the nearest available bitrate (engine: value below). */
const SPOTIFY_TIERS = [
  { kbps: 320, engine: 320, label: "Very High" },
  { kbps: 160, engine: 192, label: "High" },
  { kbps: 96, engine: 96, label: "Normal" },
  { kbps: 24, engine: 64, label: "Low" },
] as const;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function safeName(s: string) {
  const clean = s
    .normalize("NFKD")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean || "audio";
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** guaranteed navigation download — call INSIDE the user's click handler */
function navigateDownload(href: string, fileName?: string) {
  const a = document.createElement("a");
  a.href = href;
  if (fileName) a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);
  const [bitrate, setBitrate] = useState<number>(320);
  // current analysis came from a Spotify link → quality row shows Spotify tiers
  const [spotifySource, setSpotifySource] = useState(false);
  const [dl, setDl] = useState<Record<string, DlState>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  const [batch, setBatch] = useState<{ done: number; total: number; failed: number } | null>(null);
  const [retryTracks, setRetryTracks] = useState<Track[]>([]);
  const [maxConc, setMaxConc] = useState(2);
  const [engine, setEngine] = useState<{
    delivery: "blob" | "native";
    autoPrefetch: boolean;
    playlistDelivery: "zip" | "separate";
  }>({ delivery: "blob", autoPrefetch: false, playlistDelivery: "zip" });

  // playlist delivery: ZIP (default) | Save to folder (desktop Chromium) | separate MP3s
  const [plDelivery, setPlDelivery] = useState<PlaylistDelivery>("zip");
  const folderPickerAvailable = typeof window !== "undefined" && "showDirectoryPicker" in window;

  // ZIP batch state
  const [preparedId, setPreparedId] = useState<string | null>(null);
  const [zipRun, setZipRun] = useState<BatchView | null>(null);
  const zipPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // header Telegram bot link (username comes from the bot config via /api/status)
  const [tgUsername, setTgUsername] = useState<string | null>(null);
  // a complete single-video link renders its card instantly — the thumbnail
  // needs no API call, so feedback is 0ms (derived, no state race)
  const urlVideoId = useMemo(() => {
    const m = url.trim().match(/(?:v=|youtu\.be\/|shorts\/|\/live\/|\/embed\/)([\w-]{11})/);
    return m && !/[?&]list=/.test(url.trim()) ? m[1] : null;
  }, [url]);

  const inputRef = useRef<HTMLInputElement>(null);
  const prefetched = useRef<Set<string>>(new Set());
  const pfPlaylistKey = useRef<string | null>(null);

  /* client download pool: keeps the browser from hammering the server —
     capped by the ADMIN's engine concurrency (the old code hardcoded 2) */
  const pool = useRef<{ queued: Array<() => void>; running: number }>({ queued: [], running: 0 });

  // server-tuned concurrency + settings
  useEffect(() => {
    const load = () =>
      fetch("/api/status")
        .then((r) => r.json())
        .then((d) => {
          if (d?.maxConcurrency) setMaxConc(Math.max(1, Math.min(8, d.maxConcurrency)));
          if (d?.tgUsername) setTgUsername(String(d.tgUsername));
          if (d?.settings) {
            setEngine({
              delivery: d.settings.delivery === "native" ? "native" : "blob",
              autoPrefetch: !!d.settings.autoPrefetchPlaylist,
              playlistDelivery: d.settings.playlistDelivery === "separate" ? "separate" : "zip",
            });
            if (d.settings.playlistDelivery === "separate") setPlDelivery("separate");
          }
        })
        .catch(() => {});
    load();
    // the admin can raise/lower the engine concurrency any time — the page's
    // client-side pool must follow WITHOUT a reload (a stale value here was
    // why "panel-এ 4 দিলেও ব্রাউজার ৩টাই চালাত")
    const iv = setInterval(load, 20_000);
    return () => clearInterval(iv);
  }, []);

  const tracks: Track[] = useMemo(() => {
    if (!info) return [];
    return info.type === "video" ? [info.track] : info.tracks;
  }, [info]);

  useEffect(() => {
    setSelected(new Set(tracks.map((t) => t.videoId)));
    setRetryTracks([]);
  }, [info]);

  /* ---------------- ZIP batch preparation (selection changes) ---------------- */

  const selectedList: Track[] = useMemo(
    () => tracks.filter((t) => selected.has(t.videoId)),
    [tracks, selected]
  );

  // prepared batch follows the selection — debounce 600ms, engine NOT started
  useEffect(() => {
    if (info?.type !== "playlist" || plDelivery !== "zip" || selectedList.length === 0) {
      setPreparedId(null);
      return;
    }
    const t = setTimeout(() => {
      fetch("/api/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: selectedList.map((x) => ({ videoId: x.videoId, title: x.title, author: x.author })),
          bitrate,
          title: info.title,
        }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d?.id) setPreparedId(d.id);
        })
        .catch(() => {});
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, selected, bitrate, plDelivery]);

  const stopZipPoll = () => {
    if (zipPollRef.current) {
      clearInterval(zipPollRef.current);
      zipPollRef.current = null;
    }
  };

  /** poll the batch while the zip builds; mirror rows into dl[] honestly */
  const pollZip = useCallback((id: string) => {
    stopZipPoll();
    zipPollRef.current = setInterval(() => {
      fetch(`/api/batch?id=${encodeURIComponent(id)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: BatchView | null) => {
          if (!d) return;
          setZipRun(d);
          setDl((s) => {
            const next = { ...s };
            for (const it of d.items) {
              const row: DlState | undefined = next[it.videoId];
              if (it.status === "running" && (it.pct != null || row?.status !== "downloading")) {
                next[it.videoId] = {
                  status: "downloading",
                  pct: it.pct,
                  speed: it.speed,
                  eta: it.eta,
                };
              } else if (it.status === "done" && it.sizeBytes != null) {
                next[it.videoId] = {
                  status: d.delivered ? "sent" : "done",
                  sizeKB: Math.round(it.sizeBytes / 1024),
                  delivered: d.delivered,
                };
              } else if (it.status === "failed") {
                next[it.videoId] = { status: "error", hint: it.error ?? "failed" };
              } else if (it.status === "skipped") {
                next[it.videoId] = { status: "error", hint: it.error ?? "cancelled" };
              }
            }
            return next;
          });
          if (d.status === "complete" || d.status === "cancelled" || d.status === "abandoned") {
            stopZipPoll();
            setBatchRunning(false);
            if (d.status === "complete") {
              const failedCount = d.items.filter((x) => x.status === "failed").length;
              setBatch((b) => (b ? { ...b, failed: failedCount } : b));
              toast.success(
                `ZIP ready — ${d.items.filter((x) => x.status === "done").length} file(s), ${fmtBytes(d.zipBytes ?? 0)}. Check your browser's download list.`
              );
            } else if (d.status === "cancelled") {
              toast("ZIP cancelled — nothing was saved");
            }
          }
        })
        .catch(() => {});
    }, 1000);
  }, []);

  /** the ONE guaranteed download: click handler navigates synchronously */
  const startZipDownload = useCallback(() => {
    if (!selectedList.length) {
      toast.error("Select at least one track");
      return;
    }
    if (zipRun && (zipRun.status === "running")) return; // already building
    const go = (id: string) => {
      setBatchRunning(true);
      setBatch({ done: 0, total: selectedList.length, failed: 0 });
      // reset rows to queued
      setDl((s) => {
        const next = { ...s };
        for (const t of selectedList) next[t.videoId] = { status: "queued" };
        return next;
      });
      // single click → single download — always passes Chrome's limiter
      navigateDownload(`/api/download-zip?id=${encodeURIComponent(id)}`, `${safeName(info?.type === "playlist" ? info.title : "Playlist")} [${bitrate}kbps].zip`);
      pollZip(id);
    };
    if (preparedId) {
      go(preparedId);
    } else {
      // rare path: selection changed <600ms ago. The fetch is quick — Chrome's
      // transient activation (5s) covers it, so the navigation still counts.
      fetch("/api/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: selectedList.map((x) => ({ videoId: x.videoId, title: x.title, author: x.author })),
          bitrate,
          title: info?.type === "playlist" ? info.title : "Playlist",
        }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d?.id) {
            setPreparedId(d.id);
            go(d.id);
          } else toast.error(d?.error ?? "Could not prepare the ZIP");
        })
        .catch(() => toast.error("Could not prepare the ZIP"));
    }
  }, [selectedList, preparedId, bitrate, info, pollZip, zipRun]);

  const cancelZip = useCallback(() => {
    if (!zipRun) return;
    fetch("/api/batch/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: zipRun.id }),
    }).catch(() => {});
    toast("Cancelling ZIP…");
  }, [zipRun]);

  useEffect(() => stopZipPoll, []);

  /* ---------------- SPEED: prefetch single track ---------------- */

  useEffect(() => {
    if (info?.type === "video") {
      const key = `${info.track.videoId}:${bitrate}`;
      if (!prefetched.current.has(key)) {
        prefetched.current.add(key);
        fetch("/api/prefetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoId: info.track.videoId, bitrate }),
        }).catch(() => {});
      }
    }
  }, [info, bitrate]);

  // ADMIN OPT-IN: auto-prefetch whole playlists server-side (first 50 tracks)
  useEffect(() => {
    if (info?.type === "playlist" && engine.autoPrefetch && info.tracks.length > 0) {
      const k = `${info.playlistId}:${bitrate}`;
      if (pfPlaylistKey.current === k) return;
      pfPlaylistKey.current = k;
      fetch("/api/prefetch-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoIds: info.tracks.slice(0, 50).map((t) => t.videoId),
          bitrate,
        }),
      }).catch(() => {});
    }
  }, [info, bitrate, engine.autoPrefetch]);

  // keep the (free-tier) host warm while someone is actually using the site
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        fetch("/api/status").catch(() => {});
      }
    }, 240_000);
    return () => clearInterval(id);
  }, []);

  /* ---------------- analyze link ---------------- */

  const analyze = useCallback(async (raw?: string, quiet?: boolean) => {
    const target = (raw ?? url).trim();
    if (!target) {
      if (!quiet) {
        toast.error("Paste a YouTube or Spotify link first");
        inputRef.current?.focus();
      }
      return;
    }
    setLoading(true);
    setInfo(null);
    setDl({});
    setZipRun(null);
    setPreparedId(null);
    stopZipPoll();

    // SPOTIFY branch — metadata + YT matching happen in /api/spotify-info and
    // the response reuses the exact Info shapes below, so every downstream
    // flow (selection, ZIP, single download, progress) is untouched.
    if (/open\.spotify\.com|spotify:(track|album|playlist)[:/]/i.test(target)) {
      try {
        const res = await fetch("/api/spotify-info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: target }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? "Spotify link failed");
        setSpotifySource(true);
        setInfo(data as Info);
        toast.success(
          data.type === "playlist"
            ? `Spotify ready — ${data.matchedCount ?? data.trackCount}/${data.trackCount} songs matched on YouTube`
            : "Spotify track ready"
        );
      } catch (e) {
        const msg = (e as Error).message || "Could not read this Spotify link";
        if (quiet) console.warn("[analyze] spotify auto-run failed:", msg);
        else toast.error(msg);
      } finally {
        setLoading(false);
      }
      return;
    }

    setSpotifySource(false);
    try {
      const res = await fetch("/api/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: target }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to read link");
      setInfo(data as Info);
      toast.success(
        data.type === "playlist"
          ? `Playlist ready — ${data.trackCount} tracks found`
          : "Track ready"
      );
    } catch (e) {
      const msg = (e as Error).message || "Could not read this link";
      if (quiet) console.warn("[analyze] auto-run failed:", msg);
      else toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [url]);

  // auto-analyze the moment a complete YouTube link lands in the box (paste or
  // type) — by the time "Get tracks" is clicked the result is usually ready,
  // and the server's 30-min playlist cache makes the click itself instant
  const lastAutoRef = useRef<string | null>(null);
  useEffect(() => {
    const t = url.trim();
    if (!t || t === lastAutoRef.current) return;
    if (!/(?:youtube\.com|youtu\.be)\/[^\s]+/i.test(t) && !/open\.spotify\.com|spotify:(track|album|playlist)[:/]/i.test(t)) return;
    const handle = setTimeout(() => {
      lastAutoRef.current = t;
      analyze(t, true);
    }, 300);
    return () => clearTimeout(handle);
  }, [url, analyze]);

  /* ---------------- single download (pooled) ---------------- */

  const downloadOne = useCallback(async (t: Track, quality: number): Promise<boolean> => {
    setDl((s) => ({ ...s, [t.videoId]: { status: "queued" } }));
    const t0 = performance.now();
    const key = `${t.videoId}:${quality}`;

    // live progress: poll the shared engine job (prefetch + download see the same one)
    const poll = setInterval(() => {
      fetch(`/api/progress?key=${encodeURIComponent(key)}`)
        .then((r) => r.json())
        .then((j) => {
          if (j?.phase === "downloading" || j?.phase === "encoding" || j?.phase === "starting") {
            setDl((s) => ({
              ...s,
              [t.videoId]: { status: "downloading", pct: j.pct, speed: j.speed, eta: j.eta },
            }));
          }
        })
        .catch(() => {});
    }, 1000);

    try {
      if (engine.delivery === "native") {
        // NATIVE delivery: the browser's own download-manager UI handles the
        // file (like any other downloader) — the page doesn't hold a blob.
        const u = new URL("/api/download-file", window.location.origin);
        u.searchParams.set("v", t.videoId);
        u.searchParams.set("b", String(quality));
        u.searchParams.set("t", t.title);
        u.searchParams.set("a", t.author);

        // CLICK FIRST, inside the user's gesture. The old code clicked AFTER a
        // 30–300s engine wait — by then the activation had expired and Android
        // Chrome silently refused the programmatic download (the "Native এ
        // download করতে সমস্যা হয়" bug). We're on a raw VPS (no proxy that cuts
        // silent responses), so the download manager can safely wait for the
        // engine and stream the finished file from the same request.
        const a = document.createElement("a");
        a.href = u.toString();
        a.download = `${safeName(t.title)} [${quality}kbps].mp3`;
        document.body.appendChild(a);
        a.click();
        a.remove();

        // then start/mirror the engine job so the row shows live progress
        let phase = "";
        try {
          const p = await fetch("/api/prefetch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videoId: t.videoId, bitrate: quality }),
          })
            .then((r) => r.json())
            .catch(() => null);
          if (p?.status !== "cached") {
            await new Promise<void>((resolve) => {
              const started = performance.now();
              const iv = setInterval(() => {
                fetch(`/api/progress?key=${encodeURIComponent(key)}`)
                  .then((r) => r.json())
                  .then((j) => {
                    if (j?.phase === "done" || j?.phase === "error") {
                      clearInterval(iv);
                      phase = j.phase;
                      resolve();
                    } else if (performance.now() - started > 330_000) {
                      clearInterval(iv);
                      resolve();
                    }
                  })
                  .catch(() => {});
              }, 1000);
            });
          }
        } catch {
          /* engine never started — the GET below retries server-side */
        }

        if (phase === "error") {
          setDl((s) => ({
            ...s,
            [t.videoId]: { status: "error", hint: "Engine failed — try again", ms: Math.round(performance.now() - t0) },
          }));
          return false;
        }

        // engine phases still stream in → mirror them into the row
        return await new Promise<boolean>((resolve) => {
          const started = performance.now();
          const iv = setInterval(() => {
            fetch(`/api/progress?key=${encodeURIComponent(key)}`)
              .then((r) => r.json())
              .then((j) => {
                if (j?.delivered) {
                  clearInterval(iv);
                  setDl((s) => ({
                    ...s,
                    [t.videoId]: { status: "sent", delivered: true, ms: Math.round(performance.now() - t0) },
                  }));
                  resolve(true);
                } else if (j?.phase === "done") {
                  clearInterval(iv);
                  setDl((s) => ({
                    ...s,
                    [t.videoId]: { status: "sent", delivered: true, ms: Math.round(performance.now() - t0) },
                  }));
                  resolve(true);
                } else if (j?.phase === "error") {
                  clearInterval(iv);
                  setDl((s) => ({
                    ...s,
                    [t.videoId]: { status: "error", hint: "Engine failed — try again", ms: Math.round(performance.now() - t0) },
                  }));
                  resolve(false);
                } else if (performance.now() - started > 330_000) {
                  clearInterval(iv);
                  resolve(true); // native download continues in the browser UI
                }
              })
              .catch(() => {});
          }, 1200);
        });
      }

      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: t.videoId, bitrate: quality, title: t.title, author: t.author }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Download failed" }));
        const cancelled = err?.cancelled;
        const msg = cancelled ? "Cancelled" : err?.hint || err?.error || "Download failed";
        throw new Error(msg);
      }
      const blob = await res.blob();
      saveBlob(blob, `${safeName(t.title)} [${quality}kbps].mp3`);
      setDl((s) => ({
        ...s,
        [t.videoId]: { status: "done", ms: Math.round(performance.now() - t0), sizeKB: Math.round(blob.size / 1024) },
      }));
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      setDl((s) => ({
        ...s,
        [t.videoId]: { status: "error", hint: msg, ms: Math.round(performance.now() - t0) },
      }));
      toast.error(`${t.title.slice(0, 40)} — ${msg.slice(0, 120)}`);
      return false;
    } finally {
      clearInterval(poll);
    }
  }, [engine.delivery]);

  /** pooled: never more than maxConc (admin value, 1–8) browser downloads */
  const startDownload = useCallback(
    (t: Track, quality: number): Promise<boolean> => {
      const p = pool.current;
      const limit = Math.max(1, Math.min(8, maxConc));
      const run = async (): Promise<boolean> => {
        if (p.running >= limit) {
          await new Promise<void>((resolve) => p.queued.push(resolve));
        }
        p.running++;
        try {
          return await downloadOne(t, quality);
        } finally {
          p.running--;
          const next = p.queued.shift();
          if (next) next();
        }
      };
      return run();
    },
    [downloadOne, maxConc]
  );

  /* ---------------- separate-MP3s batch (with the honest warning) ---------------- */

  const downloadList = useCallback(
    async (list: Track[], quality: number) => {
      if (!list.length) return;
      setBatchRunning(true);
      setBatch({ done: 0, total: list.length, failed: 0 });
      toast.warning(
        "Chrome will ask “Download multiple files?” — tap ALLOW, or only the first file will arrive."
      );

      // track 1: direct navigation INSIDE this gesture → guaranteed; the rest:
      // fetch→blob saves with a 2.5s gap (Chrome's limiter accepts blobs more
      // reliably once automatic downloads are allowed for the site)
      let ok = 0;
      const failed: Track[] = [];
      let cursor = 0;
      const limit = Math.max(1, Math.min(8, maxConc));

      const first = list[0];
      if (engine.delivery === "native") {
        const u = new URL("/api/download-file", window.location.origin);
        u.searchParams.set("v", first.videoId);
        u.searchParams.set("b", String(quality));
        u.searchParams.set("t", first.title);
        u.searchParams.set("a", first.author);
        navigateDownload(u.toString(), `${safeName(first.title)} [${quality}kbps].mp3`);
        cursor = 1;
        ok++;
        setBatch((b) => (b ? { ...b, done: 1 } : b));
        setDl((s) => ({ ...s, [first.videoId]: { status: "sent", delivered: true } }));
      }

      const worker = async () => {
        while (cursor < list.length) {
          const t = list[cursor++];
          const success = await startDownload(t, quality);
          if (success) {
            ok++;
            setBatch((b) => (b ? { ...b, done: b.done + 1 } : b));
            await new Promise((r) => setTimeout(r, 2500)); // spacing saves blobs
          } else {
            failed.push(t);
            setBatch((b) => (b ? { ...b, failed: (b.failed ?? 0) + 1 } : b));
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, list.length) }, () => worker()));

      setBatchRunning(false);
      setBatch(null);
      if (failed.length) {
        setRetryTracks(failed);
        toast.error(
          `Batch finished — ${ok}/${list.length} arrived. Missing files? Chrome blocked them — use ZIP instead.`
        );
      } else {
        setRetryTracks([]);
        toast.success(`Batch finished — ${ok}/${list.length} sent`);
      }
    },
    [startDownload, maxConc, engine.delivery]
  );

  /* ---------------- save to folder (desktop Chromium) ---------------- */

  const saveToFolder = useCallback(async () => {
    if (!selectedList.length) {
      toast.error("Select at least one track");
      return;
    }
    if (!("showDirectoryPicker" in window)) {
      toast.error("Your browser doesn't support folder saving — use ZIP");
      return;
    }
    try {
      const dir = await (window as unknown as {
        showDirectoryPicker: (o?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker({ mode: "readwrite" });
      setBatchRunning(true);
      setBatch({ done: 0, total: selectedList.length, failed: 0 });
      const failed: Track[] = [];
      let ok = 0;
      const limit = Math.max(1, Math.min(8, maxConc));
      let cursor = 0;
      const worker = async () => {
        while (cursor < selectedList.length) {
          const t = selectedList[cursor++];
          try {
            setDl((s) => ({ ...s, [t.videoId]: { status: "downloading" } }));
            const res = await fetch("/api/download", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ videoId: t.videoId, bitrate, title: t.title, author: t.author }),
            });
            if (!res.ok) {
              const err = await res.json().catch(() => ({}));
              throw new Error(err?.hint || err?.error || `HTTP ${res.status}`);
            }
            const blob = await res.blob();
            const fh = await (dir as unknown as {
              getFileHandle: (n: string, o?: { create?: boolean }) => Promise<{
                createWritable: () => Promise<{
                  write: (d: Blob) => Promise<void>;
                  close: () => Promise<void>;
                }>;
              }>;
            }).getFileHandle(`${safeName(t.title)} [${bitrate}kbps].mp3`, { create: true });
            const w = await fh.createWritable();
            await w.write(blob);
            await w.close();
            ok++;
            setDl((s) => ({
              ...s,
              [t.videoId]: { status: "done", sizeKB: Math.round(blob.size / 1024) },
            }));
            setBatch((b) => (b ? { ...b, done: b.done + 1 } : b));
          } catch (e) {
            failed.push(t);
            setDl((s) => ({ ...s, [t.videoId]: { status: "error", hint: (e as Error).message.slice(0, 120) } }));
            setBatch((b) => (b ? { ...b, failed: (b.failed ?? 0) + 1 } : b));
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, selectedList.length) }, () => worker()));
      setBatchRunning(false);
      setBatch(null);
      if (failed.length) {
        setRetryTracks(failed);
        toast.error(`Saved ${ok}/${selectedList.length} — retry the failed ones below`);
      } else {
        toast.success(`Saved ${ok} MP3 file(s) to the folder — no ZIP needed`);
      }
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") return; // user closed the picker
      setBatchRunning(false);
      setBatch(null);
      toast.error(`Folder save failed: ${err.message.slice(0, 120)}`);
    }
  }, [selectedList, bitrate, maxConc]);

  /* ---------------- dispatch by delivery mode ---------------- */

  const downloadSelected = useCallback(() => {
    if (!selected.size) {
      toast.error("Select at least one track");
      return;
    }
    if (plDelivery === "zip") {
      startZipDownload();
    } else if (plDelivery === "folder") {
      void saveToFolder();
    } else {
      void downloadList(selectedList, bitrate);
    }
  }, [selected, selectedList, bitrate, plDelivery, startZipDownload, saveToFolder, downloadList]);

  const retryFailed = useCallback(() => {
    const list = retryTracks.slice();
    setRetryTracks([]);
    void downloadList(list, bitrate);
  }, [retryTracks, bitrate, downloadList]);

  const toggleSel = (id: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  /* ---------------- paste ---------------- */

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setUrl(text.trim());
        await analyze(text.trim());
      }
    } catch {
      // The programmatic Clipboard API only exists in secure contexts (https /
      // localhost). Plain-HTTP hosts and most mobile browsers block it — focus
      // and select the box so the OS long-press "Paste" menu takes over.
      const el = inputRef.current;
      el?.focus();
      el?.select?.();
      toast.error("Hold the box and tap Paste — the browser blocked auto-paste");
    }
  };

  /* ---------------- render ---------------- */

  const zipActive = batchRunning && plDelivery === "zip" && zipRun?.status === "running";

  return (
    <div className="min-h-screen flex flex-col bg-zinc-100 dark:bg-zinc-950 text-foreground selection:bg-rose-500/30">
      {/* ambient glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 h-[420px] w-[680px] rounded-full bg-rose-600/15 blur-[120px]" />
        <div className="absolute bottom-0 right-0 h-[300px] w-[400px] rounded-full bg-orange-500/10 blur-[110px]" />
      </div>

      {/* header */}
      <header className="relative z-10">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-rose-500 to-red-700 grid place-items-center shadow-lg shadow-rose-900/40">
              <Music4 className="h-5 w-5 text-white" />
            </div>
            <div className="leading-tight">
              <div className="font-bold tracking-tight text-[17px]">TuneLoad</div>
              <div className="text-[11px] text-muted-foreground/80 font-medium">YouTube to MP3</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="hidden sm:inline-flex border-border bg-card/60 text-muted-foreground gap-1.5">
              <Zap className="h-3 w-3 text-rose-600 dark:text-rose-400" /> 320 kbps
            </Badge>
            {tgUsername && (
              <a href={`https://t.me/${tgUsername}`} target="_blank" rel="noreferrer" aria-label="Open Telegram bot">
                <Button
                  variant="outline"
                  size="sm"
                  className="border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 hover:text-sky-600 dark:hover:text-sky-400 text-sky-600 dark:text-sky-400 gap-1.5"
                >
                  <Send className="h-4 w-4" />
                  <span className="hidden sm:inline">TG Bot</span>
                </Button>
              </a>
            )}
            <ThemeToggle />
            <a href="/admin" aria-label="Admin">
              <Button variant="outline" size="sm" className="border-border bg-card/60 hover:bg-secondary hover:text-foreground gap-1.5">
                <Settings2 className="h-4 w-4" /> <span className="hidden sm:inline">Admin</span>
              </Button>
            </a>
          </div>
        </div>
      </header>

      {/* main */}
      <main className="relative z-10 flex-1 mx-auto w-full max-w-5xl px-4 sm:px-6 pb-24">
        {/* hero + input */}
        <section className="pt-10 sm:pt-16 pb-8 sm:pb-10 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3.5 py-1.5 text-xs font-medium text-muted-foreground mb-5">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            Playlist support · All qualities · No ads
          </div>
          <h1 className="text-3xl sm:text-5xl font-bold tracking-tight text-balance">
            Download YouTube audio as{" "}
            <span className="bg-gradient-to-r from-rose-400 to-orange-400 bg-clip-text text-transparent">MP3</span>
          </h1>
          <p className="mt-3 text-muted-foreground text-sm sm:text-base max-w-xl mx-auto">
            Paste a video or playlist link. Fast, clean, high quality.
          </p>

          <div className="mt-7 mx-auto max-w-2xl">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                analyze();
              }}
              className="flex flex-col sm:flex-row gap-2.5"
            >
              <div className="relative flex-1">
                <Link2 className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
                <Input
                  ref={inputRef}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://youtube.com/watch?v=… or playlist link"
                  className="h-12 pl-10 pr-4 text-[15px] bg-card/80 border-border focus-visible:ring-rose-500/50 focus-visible:border-rose-600/60 placeholder:text-muted-foreground/70"
                />
              </div>
              <div className="flex gap-2.5">
                <Button
                  type="button"
                  variant="outline"
                  onClick={pasteFromClipboard}
                  className="h-12 px-4 border-border bg-card/80 hover:bg-secondary hover:text-white"
                >
                  <ClipboardPaste className="h-4 w-4 sm:mr-1.5" />
                  <span className="hidden sm:inline">Paste</span>
                </Button>
                <Button
                  type="submit"
                  disabled={loading}
                  className="h-12 px-6 font-semibold bg-gradient-to-r from-rose-500 to-red-600 hover:from-rose-400 hover:to-red-500 text-white shadow-lg shadow-rose-900/40"
                >
                  {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Download className="h-5 w-5" />}
                  <span className="ml-1.5">{loading ? "Reading…" : "Get tracks"}</span>
                </Button>
              </div>
            </form>
          </div>

          {/* quality selector — Spotify tiers when the source is Spotify */}
          <div className="mt-5 inline-flex flex-wrap justify-center items-center gap-1 max-w-full rounded-xl border border-border bg-card/60 p-1">
            {spotifySource && (
              <span className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-500">
                Spotify
              </span>
            )}
            {(spotifySource
              ? SPOTIFY_TIERS.map((t) => ({ key: `sp${t.kbps}`, val: t.engine, text: `${t.kbps} kbps · ${t.label}` }))
              : BITRATES.map((b) => ({ key: `yt${b}`, val: b, text: `${b} kbps` }))
            ).map((opt) => (
              <button
                key={opt.key}
                onClick={() => setBitrate(opt.val)}
                className={`px-3 sm:px-4 py-1.5 rounded-lg text-sm font-semibold transition-all ${
                  bitrate === opt.val
                    ? spotifySource
                      ? "bg-emerald-600 text-white shadow shadow-emerald-900/50"
                      : "bg-rose-600 text-white shadow shadow-rose-900/50"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                aria-pressed={bitrate === opt.val}
              >
                {opt.text}
              </button>
            ))}
          </div>
        </section>

        {/* loading skeleton */}
        {loading && (
          <section className="mx-auto max-w-3xl">
            <div className="rounded-2xl border border-border bg-card/50 p-4 animate-pulse">
              <div className="flex gap-4">
                <div className="h-20 w-36 rounded-lg bg-secondary" />
                <div className="flex-1 space-y-2.5 py-1">
                  <div className="h-4 w-3/4 rounded bg-secondary" />
                  <div className="h-3 w-1/3 rounded bg-secondary" />
                  <div className="h-3 w-1/4 rounded bg-secondary" />
                </div>
              </div>
            </div>
          </section>
        )}

        {/* instant preview/skeleton for a plain video link — appears the moment
            the link lands in the box (thumbnail = pure CDN, zero API) */}
        {urlVideoId && !info && (
          <section className="mx-auto max-w-3xl">
            <div className="rounded-2xl border border-border bg-card/60 p-3 flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`https://i.ytimg.com/vi/${urlVideoId}/hqdefault.jpg`}
                alt=""
                className="h-14 w-24 shrink-0 rounded-lg object-cover bg-secondary"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              />
              <div className={`flex-1 min-w-0 ${loading ? "animate-pulse" : ""}`}>
                <div className="h-4 w-3/4 rounded bg-secondary mb-2" />
                <div className="h-3 w-1/3 rounded bg-secondary" />
              </div>
              <Loader2 className={`h-4 w-4 shrink-0 text-muted-foreground ${loading ? "animate-spin" : "opacity-40"}`} />
            </div>
          </section>
        )}

        {/* single video result */}
        {info?.type === "video" && !loading && (
          <section className="mx-auto max-w-3xl">
            <TrackCard track={info.track} big />
            <div className="mt-5 flex items-center justify-center gap-3">
              <DownloadButton
                track={info.track}
                quality={bitrate}
                state={dl[info.track.videoId]}
                onDownload={() => void startDownload(info.track, bitrate)}
              />
            </div>
            {dl[info.track.videoId]?.hint && (
              <p className="mt-3 text-center text-xs text-muted-foreground/80 max-w-lg mx-auto">{dl[info.track.videoId]?.hint}</p>
            )}
          </section>
        )}

        {/* playlist result */}
        {info?.type === "playlist" && !loading && (
          <section className="mx-auto max-w-3xl">
            {/* playlist header */}
            <div className="rounded-2xl border border-border bg-gradient-to-b from-card/90 to-card/40 p-5">
              <div className="flex items-start gap-4">
                <div className="h-14 w-14 shrink-0 rounded-xl bg-gradient-to-br from-rose-600/80 to-red-800/60 grid place-items-center border border-border/50">
                  <ListMusic className="h-6 w-6 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="text-lg font-bold tracking-tight truncate">{info.title}</h2>
                  <p className="text-sm text-muted-foreground/80 mt-0.5 truncate">
                    {info.author} · {info.trackCount} tracks · {selected.size} selected
                  </p>
                </div>
              </div>

              {/* delivery mode selector */}
              <div className="mt-4">
                <div className="inline-flex flex-wrap gap-1 rounded-xl border border-border bg-card/70 p-1">
                  {([
                    { k: "zip" as const, icon: FileArchive, label: "One ZIP file", hint: "recommended" },
                    ...(folderPickerAvailable
                      ? [{ k: "folder" as const, icon: FolderUp, label: "Save to folder", hint: "desktop Chrome" }]
                      : []),
                    { k: "separate" as const, icon: Rows3, label: "Separate MP3s", hint: "needs Allow" },
                  ]).map((m) => (
                    <button
                      key={m.k}
                      onClick={() => setPlDelivery(m.k)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
                        plDelivery === m.k
                          ? "bg-rose-600 text-white shadow shadow-rose-900/50"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      aria-pressed={plDelivery === m.k}
                      title={m.hint}
                    >
                      <m.icon className="h-3.5 w-3.5" />
                      {m.label}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground/70">
                  {plDelivery === "zip"
                    ? "One click = one ZIP with every selected track inside — works on every browser and phone."
                    : plDelivery === "folder"
                      ? "Each MP3 is written straight into a folder you pick — no browser download prompt at all."
                      : "One file per track. Chrome will ask “Download multiple files?” — tap ALLOW or files get dropped."}
                </p>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2.5">
                <Button
                  onClick={downloadSelected}
                  disabled={batchRunning || selected.size === 0}
                  className="font-semibold bg-gradient-to-r from-rose-500 to-red-600 hover:from-rose-400 hover:to-red-500 text-white shadow-lg shadow-rose-900/40"
                >
                  {batchRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  <span className="ml-1.5">
                    {batchRunning
                      ? batch
                        ? zipActive
                          ? `ZIP ${batch.done}/${batch.total}${batch.failed ? ` · ${batch.failed} failed` : ""}…`
                          : `Sending ${batch.done}/${batch.total}${batch.failed ? ` · ${batch.failed} failed` : ""}…`
                        : "Working…"
                      : plDelivery === "zip"
                        ? `Download ZIP · ${selected.size}`
                        : plDelivery === "folder"
                          ? `Save ${selected.size} to folder`
                          : `Download ${selected.size}`}
                  </span>
                </Button>
                {zipActive && (
                  <Button
                    variant="outline"
                    onClick={cancelZip}
                    className="border-red-300 dark:border-red-800/60 bg-red-50 dark:bg-red-950/40 hover:bg-red-100 dark:hover:bg-red-900/40 text-red-700 dark:text-red-300 gap-1.5"
                  >
                    <Ban className="h-4 w-4" /> Cancel
                  </Button>
                )}
                {zipRun?.status === "complete" && (
                  <Button
                    variant="outline"
                    onClick={() => navigateDownload(`/api/download-zip?id=${encodeURIComponent(zipRun.id)}`, zipRun.zipFileName ?? "Playlist.zip")}
                    className="border-border bg-card/60 hover:bg-secondary hover:text-white gap-1.5"
                  >
                    <FileArchive className="h-4 w-4" /> Save ZIP again
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={() => setSelected(new Set(tracks.map((t) => t.videoId)))}
                  className="border-border bg-card/60 hover:bg-secondary hover:text-white"
                >
                  Select all
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setSelected(new Set())}
                  className="border-border bg-card/60 hover:bg-secondary hover:text-white"
                >
                  Clear
                </Button>
                {retryTracks.length > 0 && !batchRunning && (
                  <Button
                    onClick={retryFailed}
                    className="font-semibold bg-amber-600 hover:bg-amber-500 text-white gap-1.5"
                  >
                    <RotateCcw className="h-4 w-4" /> Retry {retryTracks.length} failed
                  </Button>
                )}
              </div>

              {zipRun?.status === "complete" && (
                <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400 font-medium">
                  ZIP sent to your browser — {zipRun.items.filter((x) => x.status === "done").length} file(s),
                  {" "}{fmtBytes(zipRun.zipBytes ?? 0)}{zipRun.items.some((x) => x.status === "failed") ? ` · ${zipRun.items.filter((x) => x.status === "failed").length} failed (see _FAILED.txt inside)` : ""}.
                  Not in your download list? Use “Save ZIP again”.
                </p>
              )}
            </div>

            {/* track list */}
            <div className="mt-4 rounded-2xl border border-border bg-card/40 divide-y divide-zinc-800/70 max-h-[520px] overflow-y-auto scroll-smooth tune-scroll">
              {info.tracks.map((t, i) => (
                <TrackRow
                  key={t.videoId}
                  index={i + 1}
                  track={t}
                  checked={selected.has(t.videoId)}
                  onToggle={() => toggleSel(t.videoId)}
                  state={dl[t.videoId]}
                  onDownload={() => void startDownload(t, bitrate)}
                  onQuickSave={
                    plDelivery === "separate"
                      ? () => {
                          const u = new URL("/api/download-file", window.location.origin);
                          u.searchParams.set("v", t.videoId);
                          u.searchParams.set("b", String(bitrate));
                          u.searchParams.set("t", t.title);
                          u.searchParams.set("a", t.author);
                          navigateDownload(u.toString(), `${safeName(t.title)} [${bitrate}kbps].mp3`);
                          setDl((s) => ({ ...s, [t.videoId]: { status: "sent", delivered: true } }));
                        }
                      : undefined
                  }
                  quality={bitrate}
                />
              ))}
            </div>
          </section>
        )}

        {/* empty-state hint */}
        {!info && !loading && (
          <section className="mx-auto max-w-3xl grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              { icon: ListMusic, t: "Playlists", d: "Full playlists & mixes — pick the tracks you want" },
              { icon: Gauge, t: "Fast engine", d: "Direct audio streams, parallel providers, no waiting rooms" },
              { icon: Music4, t: "High quality", d: "Up to 320 kbps MP3 with proper ID3 tags" },
            ].map((f) => (
              <div key={f.t} className="rounded-2xl border border-border/80 bg-card/40 p-4">
                <f.icon className="h-5 w-5 text-rose-600 dark:text-rose-400" />
                <div className="mt-2.5 font-semibold text-sm">{f.t}</div>
                <div className="mt-1 text-xs leading-relaxed text-muted-foreground/80">{f.d}</div>
              </div>
            ))}
          </section>
        )}
      </main>

      {/* footer (sticky) */}
      <footer className="relative z-10 mt-auto border-t border-border/60 bg-zinc-100/80 dark:bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 py-3 sm:py-0 sm:h-14 flex flex-col sm:flex-row items-center justify-center sm:justify-between gap-1 text-xs text-muted-foreground/70 text-center">
          <span className="font-medium text-muted-foreground/80">TuneLoad</span>
          <span className="flex items-center gap-3">
            <span>Audio falls under YouTube ToS — for personal use only</span>
            <a href="/admin" className="underline hover:text-muted-foreground">Admin</a>
          </span>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* components                                                          */
/* ------------------------------------------------------------------ */

function TrackCard({ track, big }: { track: Track; big?: boolean }) {
  return (
    <div className="rounded-2xl border border-border bg-card/50 overflow-hidden">
      <div className={`flex gap-3 sm:gap-4 ${big ? "p-3 sm:p-4" : "p-3"}`}>
        <img
          src={track.thumbnail}
          alt={track.title}
          className={`rounded-xl object-cover border border-border ${big ? "h-20 w-36 sm:h-24 sm:w-44" : "h-16 w-28"}`}
          loading="lazy"
        />
        <div className="flex-1 min-w-0 flex flex-col justify-center">
          <h3 className={`font-bold tracking-tight leading-snug ${big ? "text-sm sm:text-lg" : "text-sm"} line-clamp-2`}>
            {track.title}
          </h3>
          <p className="text-sm text-muted-foreground/80 mt-1 truncate flex items-center gap-1.5">
            <span className="truncate">{track.author}</span>
            {track.duration && (
              <span className="shrink-0 text-muted-foreground/70 font-mono tabular-nums">· {track.duration}</span>
            )}
          </p>
          <Badge variant="outline" className="mt-2 w-fit hidden sm:inline-flex border-border/60 bg-secondary/40 text-[10px] text-muted-foreground font-mono">
            {track.videoId}
          </Badge>
        </div>
      </div>
    </div>
  );
}

function DownloadButton({
  quality,
  state,
  onDownload,
}: {
  track: Track;
  quality: number;
  state?: DlState;
  onDownload: () => void;
}) {
  const busy = state?.status === "downloading" || state?.status === "queued";
  return (
    <Button
      size="lg"
      onClick={onDownload}
      disabled={busy}
      className="h-13 px-8 font-semibold bg-gradient-to-r from-rose-500 to-red-600 hover:from-rose-400 hover:to-red-500 text-white shadow-lg shadow-rose-900/40"
    >
      {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : state?.status === "done" || state?.status === "sent" ? <CheckCircle2 className="h-5 w-5" /> : <Download className="h-5 w-5" />}
      <span className="ml-2">
        {busy
          ? state?.status === "queued"
            ? "Queued…"
            : state?.pct != null
              ? `Downloading ${Math.round(state.pct)}%`
              : "Downloading…"
          : state?.status === "sent"
            ? "Sent to your browser ✓"
            : state?.status === "done"
              ? "Downloaded"
              : state?.status === "error"
                ? "Retry · " + quality + "kbps"
                : `Download MP3 · ${quality}kbps`}
      </span>
    </Button>
  );
}

function TrackRow({
  index,
  track,
  checked,
  onToggle,
  state,
  onDownload,
  onQuickSave,
  quality,
}: {
  index: number;
  track: Track;
  checked: boolean;
  onToggle: () => void;
  state?: DlState;
  onDownload: () => void;
  onQuickSave?: () => void;
  quality: number;
}) {
  const queued = state?.status === "queued";
  const busy = state?.status === "downloading" || queued;
  const done = state?.status === "done";
  const sent = state?.status === "sent";
  const err = state?.status === "error";
  return (
    <div className="flex items-center gap-2 sm:gap-3 px-2.5 sm:px-3.5 py-2.5 hover:bg-card/70 transition-colors">
      <Checkbox
        checked={checked}
        onCheckedChange={onToggle}
        className="border-border data-[state=checked]:bg-rose-600 data-[state=checked]:border-rose-600"
        aria-label={`Select ${track.title}`}
      />
      <span className="hidden sm:block w-6 text-right text-xs text-muted-foreground/70 font-mono tabular-nums">{index}</span>
      <img
        src={track.thumbnail}
        alt={track.title}
        className="h-9 w-14 sm:h-10 sm:w-[70px] rounded-md object-cover border border-border shrink-0"
        loading="lazy"
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium leading-tight truncate">{track.title}</div>
        <div className="text-xs text-muted-foreground/80 truncate mt-0.5 flex items-center gap-1.5">
          <span className="truncate">{track.author}</span>
          {track.duration && (
            <span className="shrink-0 text-muted-foreground/70 font-mono tabular-nums">· {track.duration}</span>
          )}
        </div>
        {err && state?.hint && (
          <div className="text-[10px] text-red-600/80 dark:text-red-400/80 truncate mt-0.5" title={state.hint}>
            {state.hint.slice(0, 90)}
          </div>
        )}
      </div>

      {queued && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
          <Clock3 className="h-3.5 w-3.5 animate-pulse" />
          <span className="hidden sm:inline">Queued</span>
        </div>
      )}
      {state?.status === "downloading" && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0 tabular-nums">
          {state.pct != null ? (
            <>
              <span className="text-rose-700 dark:text-rose-300 font-semibold">{Math.round(state.pct)}%</span>
              {state.speed && <span className="hidden sm:inline text-muted-foreground/80">{state.speed}</span>}
            </>
          ) : (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          )}
        </div>
      )}
      {done && (
        <div className="flex items-center gap-2 text-[11px] text-emerald-600/90 dark:text-emerald-400/90 font-medium shrink-0">
          <CheckCircle2 className="h-3.5 w-3.5" />
          <span className="hidden sm:inline tabular-nums">{state?.sizeKB}KB</span>
          {state?.ms != null && (
            <span className="hidden sm:inline-flex items-center gap-0.5 text-muted-foreground/70 font-normal">
              <Clock3 className="h-3 w-3" /> {(state.ms / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      )}
      {sent && (
        <div className="flex items-center gap-1.5 text-[11px] text-emerald-600/90 dark:text-emerald-400/90 font-medium shrink-0">
          <CheckCircle2 className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Sent ✓</span>
        </div>
      )}
      {err && (
        <div className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400 shrink-0" title={state?.hint}>
          <XCircle className="h-4 w-4" />
        </div>
      )}

      {onQuickSave && !busy && !done && !sent ? (
        <Button
          size="sm"
          onClick={onQuickSave}
          className="h-8 px-2.5 sm:px-3 bg-rose-600 hover:bg-rose-500 text-white"
        >
          <Download className="h-3.5 w-3.5" />
          <span className="ml-1 text-xs font-semibold">{quality}k</span>
        </Button>
      ) : (
        <Button
          size="sm"
          variant={done || err || sent ? "outline" : "default"}
          onClick={onDownload}
          disabled={busy}
          className={
            done || sent
              ? "h-8 px-2.5 sm:px-3 border-border bg-secondary/40 hover:bg-secondary hover:text-white"
              : err
                ? "h-8 px-2.5 sm:px-3 border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/40 hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-700 dark:text-amber-300"
                : "h-8 px-2.5 sm:px-3 bg-rose-600 hover:bg-rose-500 text-white"
          }
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : done || sent ? <Download className="h-3.5 w-3.5" /> : err ? <RotateCcw className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
          <span className="ml-1 text-xs font-semibold">
            {busy ? "…" : done || sent ? <span className="hidden sm:inline">Again</span> : err ? <span>Retry</span> : <><span className="hidden sm:inline">MP3 </span>{quality}k</>}
          </span>
        </Button>
      )}
    </div>
  );
}
