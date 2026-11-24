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

function botRunning(): boolean {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8"));
    if (!Number.isFinite(pid) || pid <= 0) throw new Error("bad pid");
    process.kill(pid, 0); // throws if dead
    return true;
  } catch {
    try { fs.rmSync(PID_FILE, { force: true }); } catch { /* noop */ }
    return false;
  }
}

function stopBot() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8"));
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, "SIGTERM"); } catch { /* noop */ }
    }
  } catch { /* noop */ }
  try { fs.rmSync(PID_FILE, { force: true }); } catch { /* noop */ }
}

function startBot(): number | null {
  if (!fs.existsSync(BOT_SCRIPT)) return null;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  stopBot();
  const log = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, ["scripts/tgbot.mjs"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env },
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  return child.pid ?? null;
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
    return NextResponse.json(
      { error: `Telegram rejected this token${me?.description ? ` (${me.description})` : ""}. Grab a fresh one from @BotFather.` },
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
    note: "Bot is live. Open Telegram, send your bot any YouTube link and it will reply with the MP3.",
  });
}

export async function DELETE(req: NextRequest) {
  if (!isAdminRequest(req)) return unauthorized();
  stopBot();
  try { fs.rmSync(CFG_FILE, { force: true }); } catch { /* noop */ }
  return NextResponse.json({ connected: false, running: false });
}
