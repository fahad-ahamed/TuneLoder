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
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

type CookieSet = { id: number; lines: number; bytes: number; updated: string };

type EngineStatus = {
  ffmpeg?: boolean;
  ytdlp?: boolean;
  cookies?: boolean;
  cookieSets?: number;
  queue?: { running?: number; waiting?: number; max?: number };
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
      toast.error((e as Error).message);
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
    <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100 selection:bg-rose-500/30">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 h-[420px] w-[680px] rounded-full bg-rose-600/15 blur-[120px]" />
        <div className="absolute bottom-0 right-0 h-[300px] w-[400px] rounded-full bg-orange-500/10 blur-[110px]" />
      </div>

      <header className="relative z-10 border-b border-zinc-800/60">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 h-16 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-rose-500 to-red-700 grid place-items-center shadow-lg shadow-rose-900/40">
              <Music4 className="h-5 w-5 text-white" />
            </div>
            <div className="leading-tight">
              <div className="font-bold tracking-tight text-[17px]">TuneLoad Admin</div>
              <div className="text-[11px] text-zinc-500 font-medium">Control room</div>
            </div>
          </a>
          {authed && (
            <Button
              variant="outline"
              size="sm"
              onClick={logout}
              className="border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800 hover:text-white gap-1.5"
            >
              <LogOut className="h-4 w-4" /> <span className="hidden sm:inline">Log out</span>
            </Button>
          )}
        </div>
      </header>

      <main className="relative z-10 flex-1 mx-auto w-full max-w-3xl px-4 sm:px-6 py-10 pb-24">
        {booting ? (
          <div className="grid place-items-center py-24 text-zinc-500">
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
            customPassword={customPassword}
          />
        )}
      </main>

      <footer className="relative z-10 mt-auto border-t border-zinc-800/60 bg-zinc-950/80 backdrop-blur">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 h-14 flex items-center justify-between text-xs text-zinc-600">
          <span className="font-medium text-zinc-500">TuneLoad Admin</span>
          <a href="/" className="hover:text-zinc-400">← back to the site</a>
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
  customPassword,
}: {
  password: string;
  setPassword: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  customPassword: boolean;
}) {
  return (
    <section className="mx-auto max-w-sm mt-10">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 backdrop-blur">
        <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-rose-600 to-red-800 grid place-items-center shadow-lg shadow-rose-900/40 mx-auto">
          <Lock className="h-6 w-6 text-white" />
        </div>
        <h1 className="mt-4 text-center text-xl font-bold tracking-tight">Admin login</h1>
        <p className="mt-1.5 text-center text-sm text-zinc-500">
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
            className="h-11 bg-zinc-900/80 border-zinc-800 focus-visible:ring-rose-500/50 focus-visible:border-rose-600/60"
          />
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
          <p className="mt-4 text-[11px] text-zinc-600 text-center leading-relaxed">
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
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));
    fetch("/api/cookies")
      .then((r) => r.json())
      .then((d) => setCookieSets(d?.sets ?? []))
      .catch(() => {});
    fetch("/api/telegram")
      .then((r) => r.json())
      .then(setTg)
      .catch(() => setTg(null));
  }, []);

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
      toast.success(`Cookie set #${data.id} added — ${data.count} active, auto-switch armed`);
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
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center gap-2">
          <ListMusic className="h-4 w-4 text-rose-400" />
          <h2 className="text-sm font-semibold">Engine status</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={refresh}
            className="ml-auto h-7 px-2 text-zinc-500 hover:text-zinc-200"
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
                  ? "border-zinc-800 bg-zinc-900/40 text-zinc-500"
                  : s.ok
                    ? "border-emerald-800/60 bg-emerald-950/40 text-emerald-400"
                    : "border-red-900/60 bg-red-950/30 text-red-400"
              }`}
            >
              <div className="text-xs font-semibold">{s.label}</div>
              <div className="text-[10px] opacity-80 mt-0.5">
                {s.ok === undefined ? "checking…" : s.extra ?? (s.ok ? "active" : "off")}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-zinc-600">
          Downloads run serialized ({q.max ?? 1} at a time) with automatic cookie-set failover and
          retry — that's what keeps long playlists stable. Finished files are auto-deleted from
          the server after serving.
        </p>
      </section>

      {/* cookie sets */}
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-rose-400" />
          <h2 className="text-sm font-semibold">YouTube cookie sets</h2>
          {cookieSets.length > 0 && (
            <Badge variant="outline" className="ml-auto border-emerald-800/60 bg-emerald-950/30 text-emerald-400 text-[10px]">
              auto-switch on
            </Badge>
          )}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-zinc-500">
          If YouTube rejects one set (expired, rate-limited), the engine automatically switches to
          the next working set. Export cookies.txt from a signed-in browser (“Get cookies.txt
          LOCALLY” extension) and paste it below — as many sets as you like.
        </p>

        {cookieSets.length > 0 && (
          <div className="mt-3 rounded-xl border border-zinc-800 divide-y divide-zinc-800/70">
            {cookieSets.map((s) => (
              <div key={s.id} className="flex items-center gap-3 px-3.5 py-2.5">
                <div className="h-2 w-2 rounded-full bg-emerald-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold">Set #{s.id}</div>
                  <div className="text-[10px] text-zinc-500" suppressHydrationWarning>
                    {s.lines} cookies{s.updated ? ` · updated ${new Date(s.updated).toLocaleString()}` : ""}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => removeSet(s.id)}
                  className="h-7 px-2.5 border-zinc-800 bg-zinc-900/60 hover:bg-red-950/40 hover:text-red-300 hover:border-red-900/60"
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
          className="mt-3 w-full rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 font-mono text-[11px] text-zinc-300 placeholder:text-zinc-700 focus:outline-none focus:ring-1 focus:ring-rose-600/60"
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
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-rose-400" />
          <h2 className="text-sm font-semibold">Telegram bot</h2>
          {tg?.connected && (
            <Badge
              variant="outline"
              className={`ml-auto text-[10px] ${
                tg.running
                  ? "border-emerald-800/60 bg-emerald-950/30 text-emerald-400"
                  : "border-amber-800/60 bg-amber-950/30 text-amber-400"
              }`}
            >
              {tg.running ? "running" : "restarting…"}
            </Badge>
          )}
        </div>

        {tg?.connected ? (
          <div className="mt-3 space-y-3">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3.5">
              <div className="text-xs font-semibold text-zinc-200">
                Connected as {tg.username ? `@${tg.username}` : "bot"}
              </div>
              <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed">
                Users send the bot any YouTube link — everything after that is buttons: quality
                (320/256/192/128), playlist track picker, live progress with % · speed · ETA,
                queue (new links while busy are queued), and Cancel anytime. Tracks over 50MB
                arrive as ≤50MB parts — unlimited total size. Server copies auto-delete after send.
              </p>
              {tg.log && (
                <details className="mt-2">
                  <summary className="text-[11px] text-zinc-600 cursor-pointer hover:text-zinc-400">
                    bot log tail
                  </summary>
                  <pre className="mt-1.5 max-h-32 overflow-auto rounded-lg bg-zinc-950/80 p-2 text-[10px] leading-relaxed text-zinc-500 whitespace-pre-wrap">
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
              className="border-zinc-800 bg-zinc-900/60 hover:bg-red-950/40 hover:text-red-300 hover:border-red-900/60"
            >
              <Trash2 className="h-4 w-4" /> Disconnect bot
            </Button>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <p className="text-xs leading-relaxed text-zinc-500">
              Download MP3s straight inside Telegram: create a bot with{" "}
              <span className="text-zinc-300">@BotFather</span> (send /newbot, copy the token),
              paste it below and hit connect.
            </p>
            <Input
              value={tgToken}
              onChange={(e) => setTgToken(e.target.value)}
              type="password"
              placeholder="123456789:AAH…"
              className="h-10 bg-zinc-900/70 border-zinc-800 font-mono text-xs focus-visible:ring-rose-500/50"
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
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-rose-400" />
            <h2 className="text-sm font-semibold">Change password</h2>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-zinc-500">
            New password is stored in <span className="font-mono text-zinc-400">data/admin.json</span>{" "}
            (and synced to .env when writable). Min 4 characters.
          </p>
          <div className="mt-3 space-y-2.5">
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New admin password"
              className="h-10 bg-zinc-900/70 border-zinc-800 focus-visible:ring-rose-500/50"
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

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-rose-400" />
            <h2 className="text-sm font-semibold">Auto-clean</h2>
            <Badge variant="outline" className="ml-auto border-emerald-800/60 bg-emerald-950/30 text-emerald-400 text-[10px]">
              always on
            </Badge>
          </div>
          <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-zinc-500">
            <li className="flex gap-1.5"><Clock3 className="h-3 w-3 mt-0.5 shrink-0 text-zinc-600" /> Website downloads: server copy deleted ~60s after serving</li>
            <li className="flex gap-1.5"><Clock3 className="h-3 w-3 mt-0.5 shrink-0 text-zinc-600" /> Bot sends: deleted right after the Telegram upload</li>
            <li className="flex gap-1.5"><Clock3 className="h-3 w-3 mt-0.5 shrink-0 text-zinc-600" /> Safety sweeper: anything older than 30 min goes</li>
          </ul>
        </div>
      </section>

      <Separator className="bg-zinc-800" />

      <div className="text-[11px] leading-relaxed text-zinc-600">
        Engine: yt-dlp (PO-token + JS-challenge solved) · serialized downloads · cookie-set
        auto-switch → direct fallback → mirror last resort, with automatic retries and
        cancellation. Keep at least one fresh cookie set here for datacenter IPs.
      </div>
    </div>
  );
}
