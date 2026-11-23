/**
 * Bot supervisor — started automatically by Next.js (instrumentation register).
 *
 * The old flow spawned the bot ONLY from the admin page's /api/telegram call:
 * open the admin page once and the bot came back to life with no supervision
 * at all (crash → dead until someone re-opened the page). Now: when a token is
 * configured (data/tgbot.json), the supervisor keeps ONE bot process alive —
 * monitoring every 15s and restarting crashed instances with growing backoff
 * (30s → 60s → … → 5 min cap). Duplicate instances are impossible: the bot
 * holds a PID lock file (tgbot.lock) and exits if one is already running.
 */

import fs from "fs";
import path from "path";
import { spawn, type ChildProcess } from "child_process";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const CFG_FILE = process.env.TG_CONFIG_FILE || path.join(DATA_DIR, "tgbot.json");
const PID_FILE = process.env.TG_PID_FILE || path.join(DATA_DIR, "tgbot.pid");
const LOG_FILE = process.env.TG_LOG_FILE || path.join(DATA_DIR, "tgbot.log");
const BOT_SCRIPT = path.join(ROOT, "scripts", "tgbot.mjs");

const CHECK_INTERVAL_MS = 15_000;
const MAX_BACKOFF_MS = 5 * 60_000;

type Sup = { child: ChildProcess | null; failures: number; lastExit: number };
const g = globalThis as unknown as { __tlBotSup?: Sup; __tlBotSupStarted?: boolean };
function sup(): Sup {
  return g.__tlBotSup ?? (g.__tlBotSup = { child: null, failures: 0, lastExit: 0 });
}

function pidAlive(): boolean {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8"));
    if (!Number.isFinite(pid) || pid <= 0) return false;
    process.kill(pid, 0); // throws when dead
    return true;
  } catch {
    return false;
  }
}

function tokenConfigured(): boolean {
  try {
    return !!JSON.parse(fs.readFileSync(CFG_FILE, "utf8")).token;
  } catch {
    return false;
  }
}

function spawnBot() {
  if (!fs.existsSync(BOT_SCRIPT)) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const s = sup();
  const log = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [BOT_SCRIPT], {
    cwd: ROOT,
    detached: false, // supervised: die with us, no orphans
    stdio: ["ignore", log, log],
    env: { ...process.env },
  });
  child.unref();
  s.child = child;
  s.lastExit = Date.now();
  try { fs.writeFileSync(PID_FILE, String(child.pid)); } catch { /* noop */ }
  child.once("exit", () => {
    if (s.child === child) s.child = null;
    s.lastExit = Date.now();
  });
}

function backoffMs(): number {
  const s = sup();
  return Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.min(4, s.failures));
}

export function startBotSupervisor() {
  if (g.__tlBotSupStarted) return;
  g.__tlBotSupStarted = true;
  const s = sup();

  const tick = () => {
    try {
      if (!tokenConfigured()) return; // admin disconnected the bot → stay quiet
      if (pidAlive()) return; // a bot instance (supervisor OR admin-page spawn) is live
      if (fs.existsSync(BOT_SCRIPT) === false) return;
      const sinceExit = Date.now() - s.lastExit;
      if (s.lastExit && sinceExit < backoffMs()) return; // crashed recently → wait out the backoff
      if (s.child) return; // we spawned one and it hasn't registered its pid yet
      spawnBot();
      s.failures = Math.min(4, s.failures + 1);
      console.log(`[bot-supervisor] bot (re)spawned (failures=${s.failures}, backoff ${backoffMs() / 1000}s)`);
    } catch {
      /* never let the supervisor throw */
    }
  };

  // a bot that SURVIVES 90s proves the last crash was a one-off → reset backoff
  setInterval(() => {
    const s2 = sup();
    if (pidAlive() && Date.now() - s2.lastExit > 90_000) s2.failures = 0;
  }, 30_000).unref?.();

  setInterval(tick, CHECK_INTERVAL_MS).unref?.();
  setTimeout(tick, 5_000); // first check shortly after boot
}
