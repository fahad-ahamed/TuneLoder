/**
 * Shared internal secret for the Telegram bot ↔ server API calls.
 *
 * /api/fetch-audio used to hand out arbitrary server file paths with NO auth;
 * now it requires the `x-internal-key` header. The key is generated once and
 * lives in data/internal-key.json (0600) — the bot reads the same file, so
 * nothing has to be configured.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

// TL_APP_DIR beats cwd — Next standalone chdir()s into .next/standalone, and
// rm -rf .next on rebuilds would wipe a cwd-bound key file (providers.ts)
const ROOT = process.env.TL_APP_DIR || process.cwd();
const KEY_FILE = path.join(ROOT, "data", "internal-key.json");

function readKey(): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(KEY_FILE, "utf8")) as { key?: string };
    return j.key || null;
  } catch {
    return null;
  }
}

/** lazily create/read the internal key (idempotent, survives restarts) */
export function getInternalKey(): string {
  const existing = readKey();
  if (existing) return existing;
  const key = crypto.randomBytes(24).toString("hex");
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, JSON.stringify({ key }), { mode: 0o600 });
  } catch { /* noop */ }
  return key;
}

/** header check for protected endpoints */
export function hasInternalKey(req: Request): boolean {
  const sent = req.headers.get("x-internal-key");
  if (!sent) return false;
  const expected = getInternalKey();
  if (sent.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
  } catch {
    return false;
  }
}
