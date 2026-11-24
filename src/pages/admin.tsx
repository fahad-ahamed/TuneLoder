"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Music4,
  Loader2,
  Lock,
  ShieldCheck,
  Bot,
  Trash2,
  KeyRound,
  LogOut,
  ListMusic,
  RefreshCw,
  HardDrive,
  Clock3,
  SlidersHorizontal,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import ThemeToggle from "@/components/theme-toggle";

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

type CookieVerdict = { at: string; ok: boolean; kind: string; message: string };

type CookieSet = { id: number; lines: number; bytes: number; updated: string; verify?: CookieVerdict | null };

type SignInSet = { id: number; label: string; lines: number; updated: string; verify?: CookieVerdict | null };

type SignInState = {
  auth?: { manualCookies: boolean; signIn: boolean };
  sets?: SignInSet[];
  signedIn?: boolean;
  activeSystem?: "armed" | "none";
};

type EngineStatus = {
  ffmpeg?: boolean;
  ytdlp?: boolean;
  cookies?: boolean;
  cookieSets?: number;
  maxConcurrency?: number;
  tgUsername?: string | null;
  queue?: { running?: number; waiting?: number; max?: number };
  settings?: {
    maxConcurrency?: number;
    runGapMs?: number;
    autoPrefetchPlaylist?: boolean;
    delivery?: "blob" | "native";
    playlistDelivery?: "zip" | "separate";
  };
};

type TgStatus = {
  connected?: boolean;
  username?: string | null;
  running?: boolean;
  scriptPresent?: boolean;
  log?: string;
};

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */

export default function AdminPage() {
  const [booting, setBooting] = useState(true);
  const [authed, setAuthed] = useState(false);
  const [customPassword, setCustomPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/auth")
      .then((r) => r.json())
      .then((d) => {
        setAuthed(!!d.authed);
        setCustomPassword(!!d.customPassword);
      })
      .catch(() => {})
      .finally(() => setBooting(false));
  }, []);

  const login = async () => {
    if (!password.trim()) return;
    setLoggingIn(true);
    setLoginError(null);
    try {
      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Login failed");
      setAuthed(true);
      setPassword("");
      toast.success("Welcome, admin");
    } catch (e) {
      const msg = (e as Error).message;
      setLoginError(msg); // stays visible under the input — toast alone was missed
      toast.error(msg);
    } finally {
      setLoggingIn(false);
    }
  };

  const logout = async () => {
    await fetch("/api/admin/auth", { method: "DELETE" }).catch(() => {});
    setAuthed(false);
    toast("Logged out");
  };

  return (
    <div className="min-h-screen flex flex-col bg-zinc-100 dark:bg-zinc-950 text-foreground selection:bg-rose-500/30">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 h-[420px] w-[680px] rounded-full bg-rose-600/15 blur-[120px]" />
        <div className="absolute bottom-0 right-0 h-[300px] w-[400px] rounded-full bg-orange-500/10 blur-[110px]" />
      </div>

      <header className="relative z-10 border-b border-border/60">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 h-16 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-rose-500 to-red-700 grid place-items-center shadow-lg shadow-rose-900/40">
              <Music4 className="h-5 w-5 text-white" />
            </div>
            <div className="leading-tight">
              <div className="font-bold tracking-tight text-[17px]">TuneLoad Admin</div>
              <div className="text-[11px] text-muted-foreground/80 font-medium">Control room</div>
            </div>
          </a>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            {authed && (
              <Button
                variant="outline"
                size="sm"
                onClick={logout}
                className="border-border bg-card/60 hover:bg-secondary hover:text-foreground gap-1.5"
              >
                <LogOut className="h-4 w-4" /> <span className="hidden sm:inline">Log out</span>
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="relative z-10 flex-1 mx-auto w-full max-w-3xl px-4 sm:px-6 py-10 pb-24">
        {booting ? (
          <div className="grid place-items-center py-24 text-muted-foreground/80">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : authed ? (
          <AdminDashboard onPasswordCustom={() => setCustomPassword(true)} />
        ) : (
          <LoginCard
            password={password}
            setPassword={setPassword}
            onSubmit={login}
            busy={loggingIn}
            error={loginError}
            customPassword={customPassword}
          />
        )}
      </main>

      <footer className="relative z-10 mt-auto border-t border-border/60 bg-zinc-100/80 dark:bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 h-14 flex items-center justify-between text-xs text-muted-foreground/70">
          <span className="font-medium text-muted-foreground/80">TuneLoad Admin</span>
          <a href="/" className="hover:text-muted-foreground">← back to the site</a>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* login card                                                          */
/* ------------------------------------------------------------------ */

function LoginCard({
  password,
  setPassword,
  onSubmit,
  busy,
  error,
  customPassword,
}: {
  password: string;
  setPassword: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  error: string | null;
  customPassword: boolean;
}) {
  return (
    <section className="mx-auto max-w-sm mt-10">
      <div className="rounded-2xl border border-border bg-card/50 p-6 backdrop-blur">
        <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-rose-600 to-red-800 grid place-items-center shadow-lg shadow-rose-900/40 mx-auto">
          <Lock className="h-6 w-6 text-white" />
        </div>
        <h1 className="mt-4 text-center text-xl font-bold tracking-tight">Admin login</h1>
        <p className="mt-1.5 text-center text-sm text-muted-foreground/80">
          Cookie sets, Telegram bot and engine controls live here.
        </p>
        <form
          className="mt-6 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Admin password"
            autoFocus
            className="h-11 bg-card/80 border-border focus-visible:ring-rose-500/50 focus-visible:border-rose-600/60"
          />
          {error && (
            <p className="text-sm font-medium text-red-600 dark:text-red-400 text-center">
              {error}
            </p>
          )}
          <Button
            type="submit"
            disabled={busy || !password.trim()}
            className="w-full h-11 font-semibold bg-gradient-to-r from-rose-500 to-red-600 hover:from-rose-400 hover:to-red-500 text-white shadow-lg shadow-rose-900/40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            <span className="ml-1.5">{busy ? "Checking…" : "Unlock"}</span>
          </Button>
        </form>
        {!customPassword && (
          <p className="mt-4 text-[11px] text-muted-foreground/70 text-center leading-relaxed">
            Default password comes from <span className="font-mono">.env</span> →{" "}
            <span className="font-mono">ADMIN_PASSWORD</span>. Change it after your first login.
          </p>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* dashboard                                                           */
/* ------------------------------------------------------------------ */

function AdminDashboard({ onPasswordCustom }: { onPasswordCustom: () => void }) {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [cookieSets, setCookieSets] = useState<CookieSet[]>([]);
  const [cookieText, setCookieText] = useState("");
  const [tg, setTg] = useState<TgStatus | null>(null);
  const [tgToken, setTgToken] = useState("");
  const [tgBusy, setTgBusy] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [ckBusy, setCkBusy] = useState(false);
  const [signin, setSignin] = useState<SignInState | null>(null);
  const [signinText, setSigninText] = useState("");
  const [signinBusy, setSigninBusy] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState<number | null>(null); // set id or -1 = all
  const [authBusy, setAuthBusy] = useState(false);
  const [conc, setConc] = useState<string>("");
  const [gap, setGap] = useState<string>("");
  const [prefetch, setPrefetch] = useState(false);
  const [delivery, setDelivery] = useState<"blob" | "native">("blob");
  const [plDelivery, setPlDelivery] = useState<"zip" | "separate">("zip");
  // Spotify sp_dc cookie (optional — richer metadata + web-API fallback)
  const [spCookie, setSpCookie] = useState("");
  const [spPreview, setSpPreview] = useState<string | null>(null);
  const [spBusy, setSpBusy] = useState(false);
  const [setBusy, setSetBusy] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // hydrate the settings form from whatever the server reports — but never
  // clobber edits the admin is mid-way through (the status auto-refreshes)
  const hydrateSettings = useCallback((s: EngineStatus["settings"]) => {
    if (!s) return;
    setConc((c) => (formDirty ? c : String(s.maxConcurrency ?? 0)));
    setGap((g) => (formDirty ? g : String(s.runGapMs ?? 250)));
    setPrefetch((v) => (formDirty ? v : !!s.autoPrefetchPlaylist));
    setDelivery((d) => (formDirty ? d : s.delivery === "native" ? "native" : "blob"));
    setPlDelivery((d) => (formDirty ? d : s.playlistDelivery === "separate" ? "separate" : "zip"));
  }, [formDirty]);

  const refresh = useCallback(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((d) => {
        setStatus(d);
        hydrateSettings(d?.settings);
      })
      .catch(() => setStatus(null));
    fetch("/api/cookies")
      .then((r) => r.json())
      .then((d) => setCookieSets(d?.sets ?? []))
      .catch(() => {});
    fetch("/api/ytauth")
      .then((r) => r.json())
      .then(setSignin)
      .catch(() => setSignin(null));
    fetch("/api/telegram")
      .then((r) => r.json())
      .then(setTg)
      .catch(() => setTg(null));
    fetch("/api/spotify-cookie")
      .then((r) => r.json())
      .then((d) => setSpPreview(d?.preview ?? null))
      .catch(() => {});
  }, [hydrateSettings]);

  useEffect(() => {
    refresh();
    refreshTimer.current = setInterval(refresh, 30_000);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
    };
  }, [refresh]);

  const addCookieSet = async () => {
    setCkBusy(true);
    try {
      const res = await fetch("/api/cookies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: cookieText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed");
      toast.success(
        data?.verdict?.message
          ? `Cookie set #${data.id} যোগ হয়েছে — YouTube যাচাই: ${data.verdict.message}`
          : `Cookie set #${data.id} added — ${data.count} active, auto-switch armed`
      );
      setCookieText("");
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCkBusy(false);
    }
  };

  const removeSet = async (id: number) => {
    await fetch(`/api/cookies?id=${id}`, { method: "DELETE" }).catch(() => {});
    toast(`Cookie set ${id} removed`);
    refresh();
  };

  const saveSpCookie = async (clear = false) => {
    setSpBusy(true);
    try {
      const res = await fetch("/api/spotify-cookie", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: clear ? "" : spCookie.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed");
      setSpPreview(data?.preview ?? null);
      if (clear) {
        setSpCookie("");
        toast.success("Spotify cookie মুছে ফেলা হয়েছে");
      } else {
        toast.success("Spotify cookie সেভ হয়েছে — পরের Spotify link-এ কাজ করবে");
        setSpCookie("");
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSpBusy(false);
    }
  };

  /** REAL re-verification — ask YouTube about a set (or all sets) right now. */
  const verifySets = async (id?: number) => {
    setVerifyBusy(id ?? -1);
    try {
      const res = await fetch("/api/cookies/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(id ? { id } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed");
      for (const r of data.results ?? []) {
        if (r.ok) toast.success(`Set #${r.id} — YouTube যাচাই ✓ ${r.message}`);
        else toast.error(`Set #${r.id} — YouTube প্রত্যাখ্যান ✗ ${r.message}`);
      }
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setVerifyBusy(null);
    }
  };

  /** Direct sign-in: paste the captured session → auto-normalized cookie set. */
  const saveSignIn = async () => {
    setSigninBusy(true);
    try {
      const res = await fetch("/api/ytauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: signinText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed");
      if (data.guest) {
        toast.warning(
          `সেশন সেভ হয়েছে (set #${data.id}) — কিন্তু এতে লগইন cookie পাওয়া যায়নি (guest)। YouTube যাচাই: ${data?.verdict?.message ?? "—"}`
        );
      } else {
        toast.success(
          `সাইন-ইন সেভ ও যাচাই ✓ (set #${data.id} · ${data.cookieCount} cookies · ${data.authFound?.length ?? 0}টি লগইন cookie) — ${data?.verdict?.message ?? ""}`
        );
      }
      setSigninText("");
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSigninBusy(false);
    }
  };

  const signOutSet = async (id: number) => {
    await fetch(`/api/ytauth?id=${id}`, { method: "DELETE" }).catch(() => {});
    toast(`Sign-in session ${id} removed`);
    refresh();
  };

  /** Auth system toggles — engine chain re-reads them on every run. */
  const toggleAuth = async (key: "manualCookies" | "signIn", value: boolean) => {
    setAuthBusy(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auth: { [key]: value } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed");
      toast.success(value ? "সিস্টেম চালু হয়েছে — পরের ডাউনলোড থেকেই প্রযোজ্য" : "সিস্টেম বন্ধ হয়েছে — পরের ডাউনলোড থেকেই প্রযোজ্য");
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAuthBusy(false);
    }
  };

  const saveEngineSettings = async () => {
    setSetBusy(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maxConcurrency: Number(conc) || 0,
          runGapMs: Number(gap) || 900,
          autoPrefetchPlaylist: prefetch,
          delivery,
          playlistDelivery: plDelivery,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed");
      toast.success("Engine settings saved — applied instantly, no restart needed");
      setFormDirty(false);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSetBusy(false);
    }
  };

  const connectBot = async () => {
    setTgBusy(true);
    try {
      const res = await fetch("/api/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tgToken.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed");
      toast.success(`Bot @${data.username ?? "bot"} connected — send it a YouTube link in Telegram!`);
      setTgToken("");
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTgBusy(false);
    }
  };

  const disconnectBot = async () => {
    setTgBusy(true);
    await fetch("/api/telegram", { method: "DELETE" }).catch(() => {});
    toast("Bot disconnected");
    refresh();
    setTgBusy(false);
  };

  const changePassword = async () => {
    if (!newPassword.trim()) return;
    setPwBusy(true);
    try {
      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed");
      toast.success("Password changed — it now lives in data/admin.json (and .env where writable)");
      setNewPassword("");
      onPasswordCustom();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPwBusy(false);
    }
  };

  const q = status?.queue ?? {};

  return (
    <div className="space-y-8">
      {/* engine status */}
      <section className="rounded-2xl border border-border bg-card/50 p-5">
        <div className="flex items-center gap-2">
          <ListMusic className="h-4 w-4 text-rose-600 dark:text-rose-400" />
          <h2 className="text-sm font-semibold">Engine status</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={refresh}
            className="ml-auto h-7 px-2 text-muted-foreground/80 hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { label: "yt-dlp", ok: status?.ytdlp },
            { label: "ffmpeg", ok: status?.ffmpeg },
            { label: "cookie sets", ok: status?.cookies, extra: status?.cookieSets ? `${status.cookieSets} set${status.cookieSets > 1 ? "s" : ""}` : undefined },
            { label: "downloads", ok: (q.running ?? 0) > 0, extra: `${q.running ?? 0}/${q.max ?? 1} · ${q.waiting ?? 0} waiting` },
          ].map((s) => (
            <div
              key={s.label}
              className={`rounded-xl border p-3 text-center ${
                s.ok === undefined
                  ? "border-border bg-card/40 text-muted-foreground/80"
                  : s.ok
                    ? "border-emerald-300 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400"
                    : "border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400"
              }`}
            >
              <div className="text-xs font-semibold">{s.label}</div>
              <div className="text-[10px] opacity-80 mt-0.5">
                {s.ok === undefined ? "checking…" : s.extra ?? (s.ok ? "active" : "off")}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground/70">
          Downloads run serialized ({q.max ?? 1} at a time) with automatic cookie-set failover and
          retry — that's what keeps long playlists stable. Finished files are auto-deleted from
          the server after serving.
        </p>
      </section>

      {/* Spotify sp_dc cookie */}
      <section className="rounded-2xl border border-border bg-card/50 p-5">
        <div className="flex items-center gap-2">
          <Music4 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <h2 className="text-sm font-semibold">Spotify cookie (sp_dc) · ঐচ্ছিক</h2>
          <Badge
            variant="outline"
            className={`ml-auto text-[10px] ${
              spPreview
                ? "border-emerald-300 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400"
                : "border-border text-muted-foreground"
            }`}
          >
            {spPreview ? `saved · ${spPreview}` : "not set"}
          </Badge>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground/80">
          Spotify-এর নিজের অডিও DRM-দ্বারা সুরক্ষিত — কেউ সেটা সরাসরি নামাতে পারে না। TuneLoad-এর
          Spotify মোড তাই Spotify-র <b>পাবলিক metadata</b> (গানের নাম, শিল্পী, কভার) পড়ে সেটার
          সেরা মিল ইউটিউবে খুঁজে আপনার একই ইঞ্জিন দিয়ে MP3 বানায়। এই sp_dc cookie দিলে বড়
          playlist-এর metadata ও matching আরও নিখুঁত হয় (web API fallback) — না দিলেও সব
          track/album/playlist কাজ করবে।
          <br />
          <b>কীভাবে পাবেন?</b> ব্রাউজারে spotify.com-এ লগইন করে DevTools → Application → Cookies →
          <span className="font-mono"> sp_dc</span> ভ্যালুটা কপি করে এখানে পেস্ট করুন।
        </p>
        <div className="mt-3 flex gap-2">
          <Input
            type="password"
            placeholder="sp_dc=… (paste the cookie value)"
            value={spCookie}
            onChange={(e) => setSpCookie(e.target.value)}
            className="flex-1 h-10 bg-card/70 border-border font-mono text-sm focus-visible:ring-emerald-500/50"
          />
          <Button
            disabled={spBusy || !spCookie.trim()}
            onClick={() => saveSpCookie(false)}
            className="h-10 px-4 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white"
          >
            {spBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </Button>
          <Button
            disabled={spBusy || !spPreview}
            variant="outline"
            onClick={() => saveSpCookie(true)}
            className="h-10 px-3"
          >
            Clear
          </Button>
        </div>
      </section>

      {/* engine settings (live) */}
      <section className="rounded-2xl border border-border bg-card/50 p-5">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-rose-600 dark:text-rose-400" />
          <h2 className="text-sm font-semibold">Engine settings</h2>
          <Badge variant="outline" className="ml-auto border-rose-300 dark:border-rose-800/60 bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 text-[10px]">
            live · no restart
          </Badge>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground/80">
          Change how the download engine works at any time — settings apply to the very next run.
        </p>

        <div className="mt-4 grid sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-semibold text-foreground/80">
              Max concurrent downloads · একসাথে কত ডাউনলোড{" "}
              <span className="font-normal text-muted-foreground">
                · এখন কার্যকর (effective): <b className="font-mono text-foreground/90">{status?.maxConcurrency ?? "…"}</b>
              </span>
            </label>
            <p className="text-[10px] text-muted-foreground/70 mt-0.5 leading-relaxed">
              How many yt-dlp jobs run in parallel (0 = auto: 2 with cookies, 4 without). Higher =
              faster but YouTube throttles harder. The number saved here overrides the server env
              <span className="font-mono"> MAX_CONCURRENCY</span> instantly — no restart needed.
              <br />
              <b>এটা আসলে কী?</b> এই সংখ্যাটা হলো সার্ভারের yt-dlp engine একসাথে কতটা ডাউনলোড চালাবে —
              ওয়েবসাইট আর Telegram bot মিলে একই সীমা ভাগ করে নেয়। আগে এটা ঠিকমতো কাজ করত না:
              ওয়েবসাইটের playlist সর্বোচ্চ ২-এ আটকে ছিল আর bot একবারে ঠিক ১টা নামাত। এখন ঠিক করা
              হয়েছে — এখানে <b>৩</b> দিলে ওয়েবসাইট (ZIP/folder/separate সব মোডে) এবং bot দুটোই
              একসাথে ৩টা ট্র্যাক নামাবে; বাকিগুলো স্বয়ংক্রিয়ভাবে queue-তে অপেক্ষা করবে।
              <b>সর্বোচ্চ ৮</b> = সব একসাথে। সতর্কতা: বেশি দিলে দ্রুত হবে, কিন্তু YouTube একই
              account/IP থেকে অনেক request দেখলে rate-limit করতে পারে — cookie থাকলে <b>২–৩</b> রাখাই ভালো।
            </p>
            <Input
              type="number"
              min={0}
              max={8}
              value={conc}
              onChange={(e) => { setConc(e.target.value); setFormDirty(true); }}
              className="mt-2 h-10 bg-card/70 border-border font-mono text-sm focus-visible:ring-rose-500/50"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-foreground/80">Gap between runs (ms) · প্রতি ডাউনলোডের মাঝে বিরতি</label>
            <p className="text-[10px] text-muted-foreground/70 mt-0.5 leading-relaxed">
              Anti rate-limit pacing: breathing room between engine runs (200–10000). Raise it if
              YouTube starts rejecting mid-playlist.
              <br />
              <b>এটা আসলে কী?</b> একটা ডাউনলোড শেষ হয়ে পরেরটা শুরু হওয়ার আগে ইঞ্জিন যত মিলিসেকেন্ড
              অপেক্ষা করবে — ডিফল্ট <b>২৫০</b>। এটা মিলিসেকেন্ড, সেকেন্ড না (২৫০ = চতুর্থাংশ সেকেন্ড)।
              YouTube বাধা দিতে শুরু করলে এই সংখ্যা বাড়াবেন (যেমন ৫০০–১০০০)।
            </p>
            <Input
              type="number"
              min={200}
              max={10000}
              step={100}
              value={gap}
              onChange={(e) => { setGap(e.target.value); setFormDirty(true); }}
              className="mt-2 h-10 bg-card/70 border-border font-mono text-sm focus-visible:ring-rose-500/50"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-foreground/80">Website download delivery</label>
            <p className="text-[10px] text-muted-foreground/70 mt-0.5 leading-relaxed">
              Blob = page waits and saves (classic). Native = the browser's own download-manager UI
              handles the file (feels like any other downloader).
            </p>
            <div className="mt-2 inline-flex rounded-xl border border-border bg-card/70 p-1 gap-1">
              {(["blob", "native"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => { setDelivery(m); setFormDirty(true); }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    delivery === m ? "bg-rose-600 text-white" : "text-muted-foreground hover:text-foreground"
                  }`}
                  aria-pressed={delivery === m}
                >
                  {m === "blob" ? "Blob (on-page)" : "Native (browser UI)"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold text-foreground/80">Playlist delivery · প্লেলিস্ট ডাউনলোড</label>
            <p className="text-[10px] text-muted-foreground/70 mt-0.5 leading-relaxed">
              Chrome asks “Download multiple files?” for separate files and silently drops ALL but
              the first if you don't tap Allow. One ZIP = one click = always works.
              <br />
              <b>ZIP (সুপারিশযোগ্য):</b> এক click-এ পুরো playlist একটাই .zip ফাইলে — সব ব্রাউজার/ফোনে কাজ করে।
              <b>Separate MP3s:</b> প্রতিটা ট্র্যাক আলাদা ফাইল — Chrome “Download multiple files?” জিজ্ঞেস
              করবে, Allow না চাপলে প্রথমটা ছাড়া বাকিগুলো নিঃশব্দে বাদ পড়ে।
            </p>
            <div className="mt-2 inline-flex rounded-xl border border-border bg-card/70 p-1 gap-1">
              {(["zip", "separate"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => { setPlDelivery(m); setFormDirty(true); }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    plDelivery === m ? "bg-rose-600 text-white" : "text-muted-foreground hover:text-foreground"
                  }`}
                  aria-pressed={plDelivery === m}
                >
                  {m === "zip" ? "One ZIP (recommended)" : "Separate MP3s"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold text-foreground/80">Auto-prefetch playlists</label>
            <p className="text-[10px] text-muted-foreground/70 mt-0.5 leading-relaxed">
              After a playlist is analyzed, the server quietly prepares the first 50 tracks at the
              selected quality. Clicks then finish in ~1s (costs bandwidth/requests).
            </p>
            <button
              onClick={() => { setPrefetch((v) => !v); setFormDirty(true); }}
              className={`mt-2 h-10 px-4 rounded-xl text-xs font-semibold border transition-all ${
                prefetch
                  ? "border-emerald-300 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300"
                  : "border-border bg-card/70 text-muted-foreground"
              }`}
              aria-pressed={prefetch}
            >
              {prefetch ? "ON — server pre-prepares tracks" : "OFF — prepare on click only"}
            </button>
          </div>
        </div>

        <Button
          onClick={saveEngineSettings}
          disabled={setBusy}
          size="sm"
          className="mt-4 bg-rose-600 hover:bg-rose-500 text-white font-semibold"
        >
          {setBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <SlidersHorizontal className="h-4 w-4" />}
          Save engine settings
        </Button>
      </section>

      {/* cookie sets */}
      {/* auth systems — admin's on/off switches */}
      <section className="rounded-2xl border border-border bg-card/50 p-5">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-rose-600 dark:text-rose-400" />
          <h2 className="text-sm font-semibold">Auth systems</h2>
          {signin?.activeSystem === "armed" && (
            <Badge variant="outline" className="ml-auto border-emerald-300 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 text-[10px]">
              armed
            </Badge>
          )}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground/80">
          দুইটা সিস্টেম — আপনার ইচ্ছামতো যেকোনোটা চালু/বন্ধ করুন। <b>দুটোই চালু থাকলে AUTO</b>: engine আগে সাইন-ইন সেশন, তারপর ম্যানুয়াল cookie set চেষ্টা করে — যেটা কাজ করে, পরেরবার সেটাতেই stick করে। একটা বন্ধ থাকলে বাকি সিস্টেমটাই চলে; দুটোই বন্ধ = লগইন ছাড়া (guest) মোড। বদল পরের ডাউনলোড থেকেই কাজ করে (restart লাগে না)।
        </p>
        <div className="mt-3 grid sm:grid-cols-2 gap-2">
          {[
            {
              key: "signIn" as const,
              title: "Direct সাইন-ইন সেশন",
              sub: "নিচের সাইন-ইন থেকে তৈরি",
              on: signin?.auth?.signIn !== false,
              count: signin?.sets?.length ?? 0,
            },
            {
              key: "manualCookies" as const,
              title: "ম্যানুয়াল cookie sets",
              sub: "নিচে 'YouTube cookie sets' থেকে",
              on: signin?.auth?.manualCookies !== false,
              count: cookieSets.length,
            },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              disabled={authBusy}
              onClick={() => toggleAuth(t.key, !t.on)}
              className={`rounded-xl border p-3 text-left transition-colors ${
                t.on
                  ? "border-emerald-300 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-950/40"
                  : "border-border bg-card/40 opacity-70"
              } ${authBusy ? "opacity-50" : ""}`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-3.5 w-3.5 rounded-full border ${
                    t.on ? "bg-emerald-500 border-emerald-500" : "border-muted-foreground/50"
                  }`}
                />
                <span className="text-xs font-semibold">{t.title}</span>
                <Badge variant="outline" className="ml-auto text-[10px] border-border">
                  {t.count} set
                </Badge>
              </div>
              <div className="text-[10px] text-muted-foreground/80 mt-1.5">
                {t.sub} · {t.on ? "চালু ✓" : "বন্ধ"}
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* direct sign-in (cookies-less login) */}
      <section className="rounded-2xl border border-border bg-card/50 p-5">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-rose-600 dark:text-rose-400" />
          <h2 className="text-sm font-semibold">YouTube সাইন-ইন (Direct sign-in)</h2>
          {signin?.signedIn && (
            <Badge variant="outline" className="ml-auto border-emerald-300 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 text-[10px]">
              signed in ✓
            </Badge>
          )}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground/80">
          cookies.txt ফাইল না নামিয়েও আপনার YouTube লগইন সরাসরি বসাতে পারেন — লগইন সেশনের cookie লাইনটা এখানে paste করলেই হয় (ফরম্যাট অটো-ডিটেক্ট: header · cookies.txt · JSON)।
        </p>
        <ol className="mt-3 space-y-1.5 text-[11px] leading-relaxed text-muted-foreground/90 list-none">
          <li><b className="text-foreground/90">১.</b> আপনার ব্রাউজারে <span className="font-mono text-foreground/90">youtube.com</span> খুলুন এবং যেই Google account দিয়ে ডাউনলোড করতে চান সেটায় Sign in করুন।</li>
          <li><b className="text-foreground/90">২.</b> সেই ট্যাবে <span className="font-mono text-foreground/90">F12</span> চাপুন → <b>Network</b> ট্যাব → পেজ Reload (<span className="font-mono">F5</span>) → লিস্টের যেকোনো request-এ ক্লিক → <b>Request Headers</b>-এ <span className="font-mono text-foreground/90">cookie:</span> লাইনটি <b>পুরোটা</b> কপি করুন।</li>
          <li><b className="text-foreground/90">৩.</b> নিচের বাক্সে Paste করে <b>সাইন-ইন সেভ করুন</b> চাপুন — ব্যস! এরপর engine সাইন-ইন সেশন দিয়েই ডাউনলোড করবে।</li>
        </ol>
        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground/70">
          মোবাইল হলে ডেস্কটপ ব্রাউজারে করুন (F12 নেই)। নিরাপত্তা: সেশন শুধু এই সার্ভারে <span className="font-mono">data/cookies/</span>-এ (mode 0600) থাকে, Sign out-এ মুছে যায়। সতর্কতা: YouTube-এর নিয়মে ডাউনলোডে ব্যবহৃত অ্যাকাউন্টে সাময়িক বিধিনিষেধ আসতে পারে — মূল নয়, একটি আলাদা/সেকেন্ডারি Google account ব্যবহার করাই ভালো।
        </p>

        {signin?.sets?.length ? (
          <div className="mt-3 rounded-xl border border-border divide-y divide-zinc-800/70">
            {signin.sets.map((s) => (
              <div key={s.id} className="flex items-center gap-3 px-3.5 py-2.5">
                <div className={`h-2 w-2 rounded-full shrink-0 ${s.verify ? (s.verify.ok ? "bg-emerald-400" : "bg-red-500") : "bg-emerald-400"}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold truncate">
                    {s.label}
                    {s.verify && (
                      <span className={`ml-2 text-[10px] font-medium ${s.verify.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                        {s.verify.ok ? "✓ YouTube যাচাইকৃত" : "✗ YouTube প্রত্যাখ্যান"}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground/80 truncate" suppressHydrationWarning>
                    {s.lines} cookies{s.updated ? ` · saved ${new Date(s.updated).toLocaleString()}` : ""}
                    {s.verify && !s.verify.ok ? ` · ${s.verify.message.slice(0, 90)}` : ""}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={verifyBusy !== null}
                  onClick={() => verifySets(s.id)}
                  className="h-7 px-2.5 border-border bg-card/60 hover:bg-zinc-100 dark:hover:bg-zinc-900"
                >
                  {verifyBusy === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />} যাচাই
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => signOutSet(s.id)}
                  className="h-7 px-2.5 border-border bg-card/60 hover:bg-red-100 dark:hover:bg-red-950/40 hover:text-red-700 dark:text-red-300 hover:border-red-300 dark:border-red-900/60"
                >
                  <LogOut className="h-3.5 w-3.5" /> Sign out
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-3 rounded-xl border border-dashed border-border px-3.5 py-2.5 text-[11px] text-muted-foreground/80">
            এখনো কোনো সাইন-ইন সেশন নেই — উপরের ৩ ধাপ করলেই engine লগইন অবস্থায় ডাউনলোড করবে (bot-check বাইপাস)।
          </div>
        )}

        <textarea
          value={signinText}
          onChange={(e) => setSigninText(e.target.value)}
          placeholder="cookie: SID=…; HSID=…; SSID=…; SAPISID=…; …  অথবা cookies.txt / JSON paste করুন"
          rows={5}
          className="mt-3 w-full rounded-xl border border-border bg-card/70 p-3 font-mono text-[11px] text-foreground/80 placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-rose-600/60"
        />
        <Button
          onClick={saveSignIn}
          disabled={!signinText.trim() || signinBusy}
          size="sm"
          className="bg-rose-600 hover:bg-rose-500 text-white font-semibold"
        >
          {signinBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
          সাইন-ইন সেভ করুন
        </Button>
      </section>

      <section className="rounded-2xl border border-border bg-card/50 p-5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-rose-600 dark:text-rose-400" />
          <h2 className="text-sm font-semibold">YouTube cookie sets</h2>
          {cookieSets.length > 0 && (
            <Badge variant="outline" className="ml-auto border-emerald-300 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 text-[10px]">
              auto-switch on
            </Badge>
          )}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground/80">
          If YouTube rejects one set (expired, rate-limited), the engine automatically switches to
          the next working set. Export cookies.txt from a signed-in browser (“Get cookies.txt
          LOCALLY” extension) and paste it below — as many sets as you like. (ম্যানুয়াল সিস্টেম — চালু/বন্ধ করতে উপরের "Auth systems" ব্যবহার করুন।)
        </p>

        {cookieSets.length > 0 && (
          <div className="mt-3 rounded-xl border border-border divide-y divide-zinc-800/70">
            {cookieSets.map((s) => (
              <div key={s.id} className="flex items-center gap-3 px-3.5 py-2.5">
                <div className={`h-2 w-2 rounded-full shrink-0 ${s.verify ? (s.verify.ok ? "bg-emerald-400" : "bg-red-500") : "bg-emerald-400"}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold">
                    Set #{s.id}
                    {s.verify && (
                      <span className={`ml-2 text-[10px] font-medium ${s.verify.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                        {s.verify.ok ? "✓ YouTube যাচাইকৃত" : "✗ YouTube প্রত্যাখ্যান"}
                      </span>
                    )}
                    {cookieSets.length > 1 && (
                      <button onClick={() => verifySets()} disabled={verifyBusy !== null} className="ml-2 text-[10px] text-muted-foreground hover:text-rose-600 disabled:opacity-50">
                        {verifyBusy === -1 ? "সব যাচাই চলছে…" : "· সব যাচাই"}
                      </button>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground/80 truncate" suppressHydrationWarning>
                    {s.lines} cookies{s.updated ? ` · updated ${new Date(s.updated).toLocaleString()}` : ""}
                    {s.verify && !s.verify.ok ? ` · ${s.verify.message.slice(0, 90)}` : ""}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={verifyBusy !== null}
                  onClick={() => verifySets(s.id)}
                  className="h-7 px-2.5 border-border bg-card/60 hover:bg-zinc-100 dark:hover:bg-zinc-900"
                >
                  {verifyBusy === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />} যাচাই
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => removeSet(s.id)}
                  className="h-7 px-2.5 border-border bg-card/60 hover:bg-red-100 dark:hover:bg-red-950/40 hover:text-red-700 dark:text-red-300 hover:border-red-300 dark:border-red-900/60"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <textarea
          value={cookieText}
          onChange={(e) => setCookieText(e.target.value)}
          placeholder="# Netscape HTTP Cookie File …"
          rows={5}
          className="mt-3 w-full rounded-xl border border-border bg-card/70 p-3 font-mono text-[11px] text-foreground/80 placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-rose-600/60"
        />
        <Button
          onClick={addCookieSet}
          disabled={!cookieText.trim() || ckBusy}
          size="sm"
          className="bg-rose-600 hover:bg-rose-500 text-white font-semibold"
        >
          {ckBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          Add cookie set
        </Button>
      </section>

      {/* telegram bot */}
      <section className="rounded-2xl border border-border bg-card/50 p-5">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-rose-600 dark:text-rose-400" />
          <h2 className="text-sm font-semibold">Telegram bot</h2>
          {tg?.connected && (
            <Badge
              variant="outline"
              className={`ml-auto text-[10px] ${
                tg.running
                  ? "border-emerald-300 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400"
                  : "border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400"
              }`}
            >
              {tg.running ? "running" : "restarting…"}
            </Badge>
          )}
        </div>

        {tg?.connected ? (
          <div className="mt-3 space-y-3">
            <div className="rounded-xl border border-border bg-card/40 p-3.5">
              <div className="text-xs font-semibold text-foreground">
                Connected as {tg.username ? `@${tg.username}` : "bot"}
              </div>
              <p className="text-[11px] text-muted-foreground/80 mt-1 leading-relaxed">
                Users send the bot any YouTube link — everything after that is buttons: quality
                (320/256/192/128), playlist track picker, live progress with % · speed · ETA,
                queue (new links while busy are queued), and Cancel anytime. Tracks over 50MB
                arrive as ≤50MB parts — unlimited total size. Server copies auto-delete after send.
              </p>
              {tg.log && (
                <details className="mt-2">
                  <summary className="text-[11px] text-muted-foreground/70 cursor-pointer hover:text-muted-foreground">
                    bot log tail
                  </summary>
                  <pre className="mt-1.5 max-h-32 overflow-auto rounded-lg bg-zinc-100/80 dark:bg-zinc-950/80 p-2 text-[10px] leading-relaxed text-muted-foreground/80 whitespace-pre-wrap">
                    {tg.log}
                  </pre>
                </details>
              )}
            </div>
            <Button
              onClick={disconnectBot}
              disabled={tgBusy}
              size="sm"
              variant="outline"
              className="border-border bg-card/60 hover:bg-red-100 dark:hover:bg-red-950/40 hover:text-red-700 dark:text-red-300 hover:border-red-300 dark:border-red-900/60"
            >
              <Trash2 className="h-4 w-4" /> Disconnect bot
            </Button>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <p className="text-xs leading-relaxed text-muted-foreground/80">
              Download MP3s straight inside Telegram: create a bot with{" "}
              <span className="text-foreground/80">@BotFather</span> (send /newbot, copy the token),
              paste it below and hit connect.
            </p>
            <Input
              value={tgToken}
              onChange={(e) => setTgToken(e.target.value)}
              type="password"
              placeholder="123456789:AAH…"
              className="h-10 bg-card/70 border-border font-mono text-xs focus-visible:ring-rose-500/50"
            />
            <Button
              onClick={connectBot}
              disabled={!tgToken.trim() || tgBusy}
              size="sm"
              className="bg-rose-600 hover:bg-rose-500 text-white font-semibold"
            >
              {tgBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
              Connect bot
            </Button>
          </div>
        )}
      </section>

      {/* password + auto-clean info */}
      <section className="grid sm:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-border bg-card/50 p-5">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-rose-600 dark:text-rose-400" />
            <h2 className="text-sm font-semibold">Change password</h2>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground/80">
            New password is stored in <span className="font-mono text-muted-foreground">data/admin.json</span>{" "}
            (and synced to .env when writable). Min 4 characters.
          </p>
          <div className="mt-3 space-y-2.5">
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New admin password"
              className="h-10 bg-card/70 border-border focus-visible:ring-rose-500/50"
            />
            <Button
              onClick={changePassword}
              disabled={!newPassword.trim() || pwBusy}
              size="sm"
              className="bg-rose-600 hover:bg-rose-500 text-white font-semibold"
            >
              {pwBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Save password
            </Button>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card/50 p-5">
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-rose-600 dark:text-rose-400" />
            <h2 className="text-sm font-semibold">Auto-clean</h2>
            <Badge variant="outline" className="ml-auto border-emerald-300 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 text-[10px]">
              always on
            </Badge>
          </div>
          <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-muted-foreground/80">
            <li className="flex gap-1.5"><Clock3 className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground/70" /> Website downloads: server copy deleted ~60s after serving</li>
            <li className="flex gap-1.5"><Clock3 className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground/70" /> Bot sends: deleted right after the Telegram upload</li>
            <li className="flex gap-1.5"><Clock3 className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground/70" /> Safety sweeper: anything older than 30 min goes</li>
          </ul>
        </div>
      </section>

      <Separator className="bg-secondary" />

      <div className="text-[11px] leading-relaxed text-muted-foreground/70">
        Engine: yt-dlp (JS-challenge solved, 16 parallel fragments) · parallel downloads
        (configurable) · cookie-set auto-switch → direct fallback, with fast retries and
        cancellation. Keep at least one fresh cookie set here for datacenter IPs.
      </div>
    </div>
  );
}
