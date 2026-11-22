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
  status: "queued" | "downloading" | "done" | "error";
  ms?: number;
  sizeKB?: number;
  hint?: string;
  pct?: number;
  speed?: string;
  eta?: string;
};

const BITRATES = [320, 256, 192, 128] as const;

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

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);
  const [bitrate, setBitrate] = useState<number>(320);
  const [dl, setDl] = useState<Record<string, DlState>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  const [batch, setBatch] = useState<{ done: number; total: number; failed: number } | null>(null);
  const [retryTracks, setRetryTracks] = useState<Track[]>([]);
  const [maxConc, setMaxConc] = useState(2);
  const [engine, setEngine] = useState<{ delivery: "blob" | "native"; autoPrefetch: boolean }>({
    delivery: "blob",
    autoPrefetch: false,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const prefetched = useRef<Set<string>>(new Set());
  const pfPlaylistKey = useRef<string | null>(null);

  /* client download pool: keeps the browser from hammering the server
     (server serializes the engine anyway — this prevents accidental
     long-waiting requests when clicking many rows quickly)            */
  const pool = useRef<{ queued: Array<() => void>; running: number }>({ queued: [], running: 0 });

  // server-tuned concurrency (small-RAM hosts report 1; browser caps at 2)
  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((d) => {
        if (d?.maxConcurrency) setMaxConc(Math.max(1, Math.min(2, d.maxConcurrency)));
        if (d?.settings) {
          setEngine({
            delivery: d.settings.delivery === "native" ? "native" : "blob",
            autoPrefetch: !!d.settings.autoPrefetchPlaylist,
          });
        }
      })
      .catch(() => {});
  }, []);

  const tracks: Track[] = useMemo(() => {
    if (!info) return [];
    return info.type === "video" ? [info.track] : info.tracks;
  }, [info]);

  useEffect(() => {
    setSelected(new Set(tracks.map((t) => t.videoId)));
    setRetryTracks([]);
  }, [info]);

  // SPEED: prefetch the MP3 the moment a single track appears — by the time
  // the user clicks "Download" it's already on disk → ~1s instead of ~20s
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
  // so batch clicks land on the on-disk cache → near-instant rows.
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

  const analyze = useCallback(async (raw?: string) => {
    const target = (raw ?? url).trim();
    if (!target) {
      toast.error("Paste a YouTube link first");
      inputRef.current?.focus();
      return;
    }
    setLoading(true);
    setInfo(null);
    setDl({});
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
      toast.error((e as Error).message || "Could not read this link");
    } finally {
      setLoading(false);
    }
  }, [url]);

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
        const clickLink = () => {
          const a = document.createElement("a");
          a.href = u.toString();
          document.body.appendChild(a);
          a.click();
          a.remove();
        };

        // Proxy-safe sequencing (hosting platforms often cut a response that
        // sends no bytes for ~60s): start the engine job with a short POST,
        // wait on /api/progress until the mp3 is on disk, and only then hit
        // /api/download-file — that GET is then a cached, instant stream.
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
        clickLink();

        // engine phases still stream in → mirror them into the row
        return await new Promise<boolean>((resolve) => {
          const started = performance.now();
          const iv = setInterval(() => {
            fetch(`/api/progress?key=${encodeURIComponent(key)}`)
              .then((r) => r.json())
              .then((j) => {
                if (j?.phase === "done") {
                  clearInterval(iv);
                  setDl((s) => ({
                    ...s,
                    [t.videoId]: { status: "done", ms: Math.round(performance.now() - t0) },
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

  /** pooled: never more than maxConc browser downloads in flight */
  const startDownload = useCallback(
    (t: Track, quality: number): Promise<boolean> => {
      const p = pool.current;
      const limit = Math.max(1, Math.min(2, maxConc));
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

  /* ---------------- batch download ---------------- */

  const downloadList = useCallback(
    async (list: Track[], quality: number) => {
      if (!list.length) return;
      setBatchRunning(true);
      setBatch({ done: 0, total: list.length, failed: 0 });
      let ok = 0;
      let failed: Track[] = [];

      // browser-side pool: max 2 in flight; the server serializes the engine anyway
      let cursor = 0;
      const worker = async () => {
        while (cursor < list.length) {
          const t = list[cursor++];
          const success = await startDownload(t, quality);
          if (success) {
            ok++;
            setBatch((b) => (b ? { ...b, done: b.done + 1 } : b));
          } else {
            failed.push(t);
            setBatch((b) => (b ? { ...b, failed: (b.failed ?? 0) + 1 } : b));
          }
        }
      };
      const limit = Math.max(1, Math.min(2, maxConc));
      await Promise.all(
        Array.from({ length: Math.min(limit, list.length) }, () => worker())
      );

      setBatchRunning(false);
      setBatch(null);
      if (failed.length) {
        setRetryTracks(failed);
        toast.error(`Batch finished — ${ok}/${list.length} downloaded. Retry the failed ones below.`);
      } else {
        setRetryTracks([]);
        toast.success(`Batch finished — ${ok}/${list.length} downloaded`);
      }
    },
    [startDownload, maxConc]
  );

  const downloadSelected = useCallback(() => {
    if (!selected.size) {
      toast.error("Select at least one track");
      return;
    }
    const list = tracks.filter((t) => selected.has(t.videoId));
    void downloadList(list, bitrate);
  }, [selected, tracks, bitrate, downloadList]);

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
      inputRef.current?.focus();
      toast.error("Clipboard blocked by browser — paste manually (Ctrl+V)");
    }
  };

  /* ---------------- render ---------------- */

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

          {/* quality selector */}
          <div className="mt-5 inline-flex flex-wrap justify-center gap-1 max-w-full rounded-xl border border-border bg-card/60 p-1">
            {BITRATES.map((b) => (
              <button
                key={b}
                onClick={() => setBitrate(b)}
                className={`px-3 sm:px-4 py-1.5 rounded-lg text-sm font-semibold transition-all ${
                  bitrate === b
                    ? "bg-rose-600 text-white shadow shadow-rose-900/50"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                aria-pressed={bitrate === b}
              >
                {b} kbps
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
                        ? `Downloading ${batch.done}/${batch.total}${batch.failed ? ` · ${batch.failed} failed` : ""}…`
                        : "Downloading…"
                      : `Download ${selected.size}`}
                  </span>
                </Button>
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
      {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : state?.status === "done" ? <CheckCircle2 className="h-5 w-5" /> : <Download className="h-5 w-5" />}
      <span className="ml-2">
        {busy
          ? state?.status === "queued"
            ? "Queued…"
            : state?.pct != null
              ? `Downloading ${Math.round(state.pct)}%`
              : "Downloading…"
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
  quality,
}: {
  index: number;
  track: Track;
  checked: boolean;
  onToggle: () => void;
  state?: DlState;
  onDownload: () => void;
  quality: number;
}) {
  const queued = state?.status === "queued";
  const busy = state?.status === "downloading" || queued;
  const done = state?.status === "done";
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
      {err && (
        <div className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400 shrink-0" title={state?.hint}>
          <XCircle className="h-4 w-4" />
        </div>
      )}

      <Button
        size="sm"
        variant={done || err ? "outline" : "default"}
        onClick={onDownload}
        disabled={busy}
        className={
          done
            ? "h-8 px-2.5 sm:px-3 border-border bg-secondary/40 hover:bg-secondary hover:text-white"
            : err
              ? "h-8 px-2.5 sm:px-3 border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/40 hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-700 dark:text-amber-300"
              : "h-8 px-2.5 sm:px-3 bg-rose-600 hover:bg-rose-500 text-white"
        }
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : done ? <Download className="h-3.5 w-3.5" /> : err ? <RotateCcw className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
        <span className="ml-1 text-xs font-semibold">
          {busy ? "…" : done ? <span className="hidden sm:inline">Again</span> : err ? <span>Retry</span> : <><span className="hidden sm:inline">MP3 </span>{quality}k</>}
        </span>
      </Button>
    </div>
  );
}
