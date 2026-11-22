/**
 * Admin authentication.
 *
 *  - Bootstrap password comes from .env ADMIN_PASSWORD (default "fahad").
 *  - Changing the password from the admin dashboard persists a scrypt hash in
 *    data/admin.json, which then takes precedence over .env.
 *  - Sessions are HttpOnly cookies holding an HMAC-signed token; the signing
 *    secret is generated once and stored in data/admin-secret.json.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const ADMIN_FILE = path.join(DATA_DIR, "admin.json");
const SECRET_FILE = path.join(DATA_DIR, "admin-secret.json");
export const COOKIE_NAME = "tl_admin";
const SESSION_MS = 7 * 24 * 3600 * 1000; // 7 days

export const DEFAULT_ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length >= 3
    ? process.env.ADMIN_PASSWORD
    : "fahad";

/* ---------------- password hashing (scrypt) ---------------- */

function hashPassword(password: string, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64).toString("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(test, "hex"), Buffer.from(hash, "hex"));
  } catch {
    return false;
  }
}

/* ---------------- persisted override ---------------- */

type AdminFile = { hash?: string };
function readAdminFile(): AdminFile {
  try {
    return JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8")) as AdminFile;
  } catch {
    return {};
  }
}

/** Verify a candidate password against the override (if set) or the .env bootstrap. */
export function checkAdminPassword(password: string): boolean {
  const override = readAdminFile().hash;
  if (override) return verifyPassword(password, override);
  return password === DEFAULT_ADMIN_PASSWORD;
}

/** True when the admin has set a custom password (vs the .env bootstrap). */
export function hasCustomPassword(): boolean {
  return !!readAdminFile().hash;
}

/** Set a new password (persists to data/admin.json and, best-effort, .env). */
export function setAdminPassword(password: string): { ok: boolean; error?: string } {
  if (typeof password !== "string" || password.length < 4) {
    return { ok: false, error: "Password must be at least 4 characters" };
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ADMIN_FILE, JSON.stringify({ hash: hashPassword(password) }, null, 2), { mode: 0o600 });
  // keep .env in sync when writable (non-fatal on read-only hosts)
  try {
    const envPath = path.join(ROOT, ".env");
    let env = "";
    try {
      env = fs.readFileSync(envPath, "utf8");
    } catch {
      env = "";
    }
    const line = `ADMIN_PASSWORD=${password}`;
    if (/^ADMIN_PASSWORD=.*$/m.test(env)) env = env.replace(/^ADMIN_PASSWORD=.*$/m, line);
    else env = `${env.trim()}\n${line}\n`;
    fs.writeFileSync(envPath, env);
  } catch { /* noop */ }
  return { ok: true };
}

/* ---------------- session tokens ---------------- */

function secret(): string {
  try {
    const j = JSON.parse(fs.readFileSync(SECRET_FILE, "utf8")) as { s?: string };
    if (j.s) return j.s;
  } catch { /* noop */ }
  const s = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SECRET_FILE, JSON.stringify({ s }), { mode: 0o600 });
  return s;
}

export function issueSession(): { token: string; maxAgeSeconds: number } {
  const exp = Date.now() + SESSION_MS;
  const payload = `admin.${exp}`;
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("hex").slice(0, 32);
  return { token: `${payload}.${sig}`, maxAgeSeconds: Math.floor(SESSION_MS / 1000) };
}

export function verifySession(token: string | undefined | null): boolean {
  if (!token) return false;
  const m = token.match(/^admin\.(\d+)\.([0-9a-f]{32})$/);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expect = crypto.createHmac("sha256", secret()).update(`admin.${exp}`).digest("hex").slice(0, 32);
  return expect === m[2];
}

/** Read the session cookie from a Request; used by protected routes. */
export function isAdminRequest(req: Request): boolean {
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return verifySession(m?.[1]);
}
