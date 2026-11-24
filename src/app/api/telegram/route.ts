import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { isAdminRequest } from "@/lib/ytd/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TL_APP_DIR beats cwd — the standalone server chdir()s into .next/standalone,
// so a cwd-based ROOT here spawned the bot with a split-brain data dir
const ROOT = process.env.TL_APP_DIR || process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const CFG_FILE = path.join(DATA_DIR, "tgbot.json");
const PID_FILE = path.join(DATA_DIR, "tgbot.pid");
const LOG_FILE = path.join(DATA_DIR, "tgbot.log");
const BOT_SCRIPT = path.join(ROOT, "scripts", "tgbot.mjs");

function readConfig(): { token?: string; username?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
  } catch {
    return null;
  }
}

/** true only when the process is ALIVE — kill(pid,0) lies for zombie children
    (the detached bot becomes an unreaped zombie when it dies, and signal-0
    succeeds against a zombie), so read /proc/<pid>/stat state instead */
function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const m = st.match(/\)\s+(\S)\s/); // state char sits after "…) comm"
    return !(m && m[1] === "Z");
  } catch {
    return false; // no /proc entry → gone
  }
}

function botRunning(): boolean {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8"));
    if (isAlive(pid)) return true;
  } catch { /* no pidfile */ }
  try { fs.rmSync(PID_FILE, { force: true }); } catch { /* noop */ }
  return false;
}

/** EVERY live tgbot.mjs process on this machine — orphans happen whenever the
    pidfile went missing/stale, and a single orphan holding the lock makes every
    future connect fail with "another instance is already running". */
function findBotPids(): number[] {
  const pids: number[] = [];
  try {
    for (const ent of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(ent)) continue;
      const pid = Number(ent);
      if (pid === process.pid) continue;
      try {
        const cmd = fs.readFileSync(`/proc/${ent}/cmdline`, "utf8");
        if (cmd.includes("tgbot.mjs")) pids.push(pid);
      } catch { /* process vanished */ }
    }
  } catch { /* no /proc (shouldn't happen on linux) */ }
  return pids;
}

/** synchronous sleep (route handlers run on the node main thread) */
const nap = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function stopBot() {
  // pidfile first (fast path), then every tgbot.mjs process — disconnect must
  // actually kill ALL of them, not just whatever the pidfile happens to name
  const targets = new Set<number>(findBotPids());
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8"));
    if (Number.isFinite(pid) && pid > 0) targets.add(pid);
  } catch { /* no pidfile */ }
  targets.delete(process.pid);
  for (const pid of targets) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
  }
  // wait for real exit (lock release + getUpdates stop) — max 4s, then SIGKILL.
  // WITHOUT this wait the next connect spawns a bot that hits the dying
  // instance's lock and exits instantly — the "disconnect → connect fails" bug.
  const t0 = Date.now();
  for (;;) {
    if (![...targets].some(isAlive) || Date.now() - t0 > 4000) break;
    nap(150);
  }
  for (const pid of targets) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
  }
  nap(300); // let even a SIGKILLed process be reaped before a respawn
  try { fs.rmSync(PID_FILE, { force: true }); } catch { /* noop */ }
  try { fs.rmSync(path.join(DATA_DIR, "tgbot.lock"), { force: true }); } catch { /* noop */ }
}

function startBot(): number | null {
  if (!fs.existsSync(BOT_SCRIPT)) return null;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  stopBot(); // sweeps orphans too — a clean slate before every spawn
  const log = fs.openSync(LOG_FILE, "a");
  const logStart = (() => {
    try { return fs.statSync(LOG_FILE).size; } catch { return 0; }
  })();
  const child = spawn(process.execPath, ["scripts/tgbot.mjs"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env },
  });
  child.unref();
  child.on("exit", () => {}); // reap promptly — an unreaped zombie fakes "alive"
  const childPid = typeof child.pid === "number" ? child.pid : -1;
  // verdict-based verify — the bot either logs "connected as @…" (real token,
  // Telegram answered) or dies (lock held / token rejected). A fixed short nap
  // lied once: the getMe round-trip outlived the check → stale pid.
  const t0 = Date.now();
  let verdict: "alive" | "dead" | null = null;
  // the bot's getMe is capped at 8s (tgbot.mjs), so 9s here always yields a verdict
  while (Date.now() - t0 < 9000 && !verdict) {
    nap(250);
    if (!isAlive(childPid)) { verdict = "dead"; break; }
    try {
      const fresh = fs.readFileSync(LOG_FILE, "utf8").slice(logStart);
      if (fresh.includes("connected as @")) verdict = "alive";
    } catch { /* log not flushed yet */ }
  }
  if (!verdict) verdict = "alive"; // belt & braces — should not happen anymore
  if (verdict === "dead") {
    try { fs.rmSync(PID_FILE, { force: true }); } catch { /* noop */ }
    return null;
  }
  fs.writeFileSync(PID_FILE, String(childPid));
  return childPid;
}

/* ------------------------------------------------------------------ */

function unauthorized() {
  return NextResponse.json({ error: "Admin login required" }, { status: 401 });
}

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return unauthorized();
  const cfg = readConfig();
  let running = botRunning();
  // auto-heal: token saved but bot died (dev restart, crash) → start it again
  if (cfg?.token && !running) {
    startBot();
    running = botRunning();
  }
  let logTail = "";
  try {
    logTail = fs.readFileSync(LOG_FILE, "utf8").slice(-1200);
  } catch { /* noop */ }
  return NextResponse.json({
    connected: !!cfg?.token,
    username: cfg?.username ?? null,
    running,
    scriptPresent: fs.existsSync(BOT_SCRIPT),
    log: logTail,
  });
}

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) return unauthorized();
  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const token = String(body.token ?? "").trim();
  if (!/^\d{5,12}:[A-Za-z0-9_-]{30,60}$/.test(token)) {
    return NextResponse.json(
      { error: "That doesn't look like a bot token. BotFather gives you something like 123456789:AAH… — copy the whole thing." },
      { status: 400 }
    );
  }

  // validate against Telegram before saving
  let me: { ok?: boolean; result?: { username?: string }; description?: string } | null = null;
  try {
    me = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    }).then((r) => r.json());
  } catch {
    me = null;
  }
  if (!me?.ok) {
    // help the admin diagnose WHY: structurally-valid-but-unknown tokens are
    // almost always a partial copy (notification previews truncate) or a
    // revoked/deleted bot — show the token's shape so they can compare
    const colon = token.indexOf(":");
    const shape = colon > 0 ? `${token.slice(0, colon)}:… · ${token.length} chars` : `${token.length} chars`;
    return NextResponse.json(
      {
        error:
          token.length < 42
            ? `Telegram rejected this token — ${shape}. Real tokens are ~45 characters, this one is shorter: you almost certainly copied only part of it (notification previews truncate). In @BotFather open the full message, or /mybots → your bot → API Token, and copy the whole token with the copy button — don't retype it.`
            : `Telegram rejected this token — ${shape}${me?.description ? ` (${me.description})` : ""}. The format looks right but Telegram doesn't recognize it. Usual causes: a partial copy, the bot was deleted (/deletebot), or the token was revoked (/revoke). @BotFather → /mybots → this bot → API Token always gives the current valid one. Then tap the eye icon in the form and compare with what you pasted.`,
      },
      { status: 422 }
    );
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify({ token, username: me.result?.username ?? null }, null, 2), {
    mode: 0o600,
  });
  const pid = startBot();

  return NextResponse.json({
    ok: true,
    username: me.result?.username ?? null,
    pid: pid ?? null,
    note: pid
      ? "Bot is live. Open Telegram, send your bot any YouTube link and it will reply with the MP3."
      : "Token saved, but the bot process exited immediately — check the log under the form (it states why: usually a token that Telegram rejects or a leftover instance, which this deploy now kills automatically).",
  });
}

export async function DELETE(req: NextRequest) {
  if (!isAdminRequest(req)) return unauthorized();
  stopBot();
  try { fs.rmSync(CFG_FILE, { force: true }); } catch { /* noop */ }
  return NextResponse.json({ connected: false, running: false });
}
